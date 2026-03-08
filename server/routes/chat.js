/**
 * routes/chat.js — Conversations & Chat
 *
 * POST /api/conversations — create conversation
 * POST /api/participants — add participant
 * POST /api/conversations/:id/send — send message (+ auto-enqueue)
 * POST /api/conversations/:id/run — manual run queue
 * POST /api/conversations/:id/stop — stop queue
 * POST /api/conversations/:id/resume — resume queue
 *
 * Also contains processQueue and the processing Map.
 */
const bb = require('../blackboard-server');
const { json } = bb;
const {
  conversationById,
  participantById,
  createConversation,
  pushMessage,
  enqueueTurn,
  requeueRunningTurns,
  normalizeText,
} = require('./_shared');

// Local processing state — tracks which conversations are currently processing
const processing = new Map();

async function processQueue(conversationId, deps, helpers) {
  if (processing.get(conversationId)) return;
  processing.set(conversationId, true);

  const { runtime, usage } = deps;

  try {
    while (true) {
      const board = helpers.readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) break;

      conv.runtime = conv.runtime || { running: false, stopRequested: false, lastRunAt: null };

      if (conv.runtime.stopRequested) {
        conv.runtime.running = false;
        helpers.writeBoard(board);
        break;
      }

      const turn = (conv.queue || []).find(t => t.status === 'queued');
      if (!turn) {
        conv.runtime.running = false;
        conv.runtime.lastRunAt = helpers.nowIso();
        helpers.writeBoard(board);
        break;
      }

      const target = participantById(board, turn.to);
      if (!target || target.type !== 'agent') {
        turn.status = 'error';
        turn.error = `Target ${turn.to} is not an agent`;
        turn.finishedAt = helpers.nowIso();
        pushMessage(conv, {
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'error',
          from: 'system',
          to: turn.from,
          text: turn.error,
          turnId: turn.id,
        });
        helpers.writeBoard(board);
        continue;
      }

      conv.runtime.running = true;
      turn.status = 'running';
      turn.startedAt = helpers.nowIso();
      helpers.writeBoard(board);

      try {
        const sessionId = conv.sessionIds?.[target.id] || null;
        const result = await runtime.runOpenclawTurn({
          agentId: target.agentId,
          sessionId,
          message: turn.text,
          timeoutSec: turn.timeoutSec || 180,
        });

        const parsed = result.parsed;
        const replyText = runtime.extractReplyText(parsed, result.stdout);
        const newSessionId = runtime.extractSessionId(parsed);

        const latestBoard = helpers.readBoard();
        const latestConv = conversationById(latestBoard, conversationId);
        const latestTurn = (latestConv.queue || []).find(t => t.id === turn.id);
        if (!latestConv || !latestTurn) break;

        latestConv.sessionIds = latestConv.sessionIds || {};
        if (newSessionId) latestConv.sessionIds[target.id] = newSessionId;

        latestTurn.status = 'done';
        latestTurn.finishedAt = helpers.nowIso();
        latestTurn.result = {
          reply: replyText,
          sessionId: newSessionId || sessionId || null,
        };

        const agentMsg = {
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'message',
          from: target.id,
          to: turn.from,
          text: replyText,
          turnId: latestTurn.id,
          sessionId: newSessionId || sessionId || null,
        };

        pushMessage(latestConv, agentMsg);

        helpers.appendLog({
          ts: helpers.nowIso(),
          conversationId,
          event: 'agent_reply',
          turnId: latestTurn.id,
          from: target.id,
          to: turn.from,
          sessionId: newSessionId || sessionId || null,
          text: replyText,
        });

        // --- Usage tracking: conversation queue (Path D) ---
        const turnDuration = turn.startedAt
          ? Math.round((Date.now() - new Date(turn.startedAt).getTime()) / 1000)
          : 0;
        usage.record('default', 'dispatch', {
          conversationId,
          turnId: turn.id,
          runtime: 'openclaw',
          assignee: target.id,
        });
        usage.record('default', 'agent.runtime', {
          conversationId,
          turnId: turn.id,
          durationSec: turnDuration,
        });

        if (latestTurn.loop?.enabled && latestTurn.loop.remaining > 0) {
          const pair = Array.isArray(latestTurn.loop.pair) ? latestTurn.loop.pair : [];
          const [a, b] = pair;
          const nextTo = target.id === a ? b : target.id === b ? a : null;
          const nextTarget = nextTo ? participantById(latestBoard, nextTo) : null;

          if (nextTarget && nextTarget.type === 'agent') {
            const nextTurn = {
              id: helpers.uid('turn'),
              createdAt: helpers.nowIso(),
              status: 'queued',
              from: target.id,
              to: nextTarget.id,
              text: replyText,
              timeoutSec: latestTurn.timeoutSec || 180,
              loop: {
                enabled: true,
                pair: [a, b],
                remaining: latestTurn.loop.remaining - 1,
              },
            };

            enqueueTurn(latestConv, nextTurn);

            pushMessage(latestConv, {
              id: helpers.uid('msg'),
              ts: helpers.nowIso(),
              type: 'system',
              from: 'system',
              to: 'human',
              text: `自動接力：${target.displayName} → ${nextTarget.displayName}（剩餘 ${nextTurn.loop.remaining} 輪）`,
              turnId: nextTurn.id,
            });

            helpers.appendLog({
              ts: helpers.nowIso(),
              conversationId,
              event: 'loop_enqueue',
              turnId: nextTurn.id,
              from: target.id,
              to: nextTarget.id,
              remaining: nextTurn.loop.remaining,
            });
          }
        }

        helpers.writeBoard(latestBoard);
      } catch (error) {
        const latestBoard = helpers.readBoard();
        const latestConv = conversationById(latestBoard, conversationId);
        const latestTurn = (latestConv?.queue || []).find(t => t.id === turn.id);
        if (!latestConv || !latestTurn) break;

        latestTurn.status = 'error';
        latestTurn.finishedAt = helpers.nowIso();
        latestTurn.error = error.message;

        pushMessage(latestConv, {
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'error',
          from: 'system',
          to: turn.from,
          text: `Agent call failed (${target.displayName}): ${error.message}`,
          turnId: latestTurn.id,
        });

        helpers.appendLog({
          ts: helpers.nowIso(),
          conversationId,
          event: 'agent_error',
          turnId: latestTurn.id,
          from: turn.from,
          to: turn.to,
          error: error.message,
        });

        helpers.writeBoard(latestBoard);
      }
    }
  } finally {
    processing.set(conversationId, false);
  }
}

module.exports = function chatRoutes(req, res, helpers, deps) {

  if (req.method === 'POST' && req.url === '/api/conversations') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = String(payload.id || '').trim();
        const title = String(payload.title || '').trim();
        const members = Array.isArray(payload.members) && payload.members.length > 0
          ? [...new Set(payload.members.map(m => String(m).trim()).filter(Boolean))]
          : ['human', 'main', 'nier'];
        const defaultAutoTurns = Number.isFinite(Number(payload.defaultAutoTurns))
          ? Math.max(1, Math.min(50, Number(payload.defaultAutoTurns)))
          : 6;

        if (!id || !/^[a-z0-9_-]+$/i.test(id)) {
          return json(res, 400, { error: 'Invalid conversation id (a-z0-9_-)' });
        }
        if (!title) return json(res, 400, { error: 'title is required' });

        const board = helpers.readBoard();
        if (conversationById(board, id)) {
          return json(res, 409, { error: `Conversation ${id} already exists` });
        }

        for (const m of members) {
          if (!participantById(board, m)) {
            return json(res, 400, { error: `Unknown member: ${m}` });
          }
        }

        const conv = createConversation({ id, title, members, defaultAutoTurns });
        board.conversations = board.conversations || [];
        board.conversations.push(conv);

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'conversation_created', conversationId: id, title, members });
        json(res, 200, { ok: true, conversation: conv });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/participants') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = String(payload.id || '').trim();
        const type = payload.type === 'human' ? 'human' : 'agent';
        const displayName = String(payload.displayName || '').trim();
        const agentId = String(payload.agentId || '').trim();

        if (!id || !/^[a-z0-9_-]+$/i.test(id)) {
          return json(res, 400, { error: 'Invalid participant id (a-z0-9_-)' });
        }
        if (!displayName) return json(res, 400, { error: 'displayName is required' });
        if (type === 'agent' && !agentId) return json(res, 400, { error: 'agentId is required for agent participant' });

        const board = helpers.readBoard();
        if (participantById(board, id)) return json(res, 409, { error: `Participant ${id} already exists` });

        const participant = { id, type, displayName };
        if (type === 'agent') participant.agentId = agentId;
        board.participants = board.participants || [];
        board.participants.push(participant);

        const conversationId = String(payload.conversationId || '').trim();
        const conv = conversationId
          ? conversationById(board, conversationId)
          : board.conversations?.[0];
        if (conversationId && !conv) {
          return json(res, 404, { error: `Conversation ${conversationId} not found` });
        }

        if (conv) {
          conv.members = Array.from(new Set([...(conv.members || []), id]));
          conv.sessionIds = conv.sessionIds || {};
          if (!(id in conv.sessionIds)) conv.sessionIds[id] = null;
        }

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'participant_added', participant, conversationId: conv?.id || null });
        json(res, 200, { ok: true, participant, conversationId: conv?.id || null });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const sendMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/send$/);
  if (req.method === 'POST' && sendMatch) {
    const conversationId = decodeURIComponent(sendMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const from = String(payload.from || '').trim();
        const to = String(payload.to || '').trim();
        const text = normalizeText(payload.text);

        if (!from || !to || !text) return json(res, 400, { error: 'from, to, text are required' });

        const board = helpers.readBoard();
        const conv = conversationById(board, conversationId);
        if (!conv) return json(res, 404, { error: `Conversation ${conversationId} not found` });

        if (!participantById(board, from)) return json(res, 400, { error: `Unknown participant: ${from}` });
        const toParticipant = participantById(board, to);
        if (!toParticipant) return json(res, 400, { error: `Unknown participant: ${to}` });

        const members = new Set(conv.members || []);
        if (!members.has(from) || !members.has(to)) {
          return json(res, 400, { error: `from/to must be members of conversation ${conversationId}` });
        }

        const msg = {
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'message',
          from,
          to,
          text,
        };
        pushMessage(conv, msg);

        helpers.appendLog({
          ts: helpers.nowIso(),
          conversationId,
          event: 'message_sent',
          from,
          to,
          text,
        });

        let queuedTurn = null;
        if (toParticipant.type === 'agent') {
          const autoLoop = !!payload.autoLoop;
          const loopPair = Array.isArray(payload.loopPair) ? payload.loopPair.slice(0, 2) : ['main', 'nier'];
          const maxTurns = Number.isFinite(Number(payload.maxAutoTurns))
            ? Math.max(0, Math.min(50, Number(payload.maxAutoTurns)))
            : Number(conv.settings?.defaultAutoTurns || 6);

          queuedTurn = {
            id: helpers.uid('turn'),
            createdAt: helpers.nowIso(),
            status: 'queued',
            from,
            to,
            text,
            timeoutSec: 180,
            loop: {
              enabled: autoLoop,
              pair: loopPair,
              remaining: autoLoop ? maxTurns : 0,
            },
          };

          enqueueTurn(conv, queuedTurn);

          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `已排入佇列：${from} → ${to}。`,
            turnId: queuedTurn.id,
          });
        }

        helpers.writeBoard(board);

        if (queuedTurn && conv.settings?.autoRunQueue !== false) {
          processQueue(conversationId, deps, helpers).catch(err => {
            console.error(`[processQueue error] ${err.message}`);
          });
        }

        json(res, 200, { ok: true, queuedTurnId: queuedTurn?.id || null });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const runMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/run$/);
  if (req.method === 'POST' && runMatch) {
    const conversationId = decodeURIComponent(runMatch[1]);
    try {
      const board = helpers.readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) return json(res, 404, { error: `Conversation ${conversationId} not found` });
      const requeued = requeueRunningTurns(conv, 'manual_run_recover_running');
      if (requeued > 0) {
        pushMessage(conv, {
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'system',
          from: 'system',
          to: 'human',
          text: `手動執行前已回收 ${requeued} 個 running 任務。`,
        });
      }
      helpers.writeBoard(board);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }

    processQueue(conversationId, deps, helpers).catch(err => {
      console.error(`[manual run error] ${err.message}`);
    });
    return json(res, 200, { ok: true, started: true });
  }

  const stopMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const conversationId = decodeURIComponent(stopMatch[1]);
    try {
      const board = helpers.readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) return json(res, 404, { error: `Conversation ${conversationId} not found` });

      conv.runtime = conv.runtime || {};
      conv.runtime.stopRequested = true;
      conv.runtime.running = false;

      pushMessage(conv, {
        id: helpers.uid('msg'),
        ts: helpers.nowIso(),
        type: 'system',
        from: 'system',
        to: 'human',
        text: '已要求停止佇列處理。',
      });

      helpers.writeBoard(board);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  const clearStopMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/resume$/);
  if (req.method === 'POST' && clearStopMatch) {
    const conversationId = decodeURIComponent(clearStopMatch[1]);
    try {
      const board = helpers.readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) return json(res, 404, { error: `Conversation ${conversationId} not found` });

      conv.runtime = conv.runtime || {};
      conv.runtime.stopRequested = false;

      // Recovery: if server restart/stop left turns in "running", requeue them
      const requeued = requeueRunningTurns(conv, 'resume_recover_running');
      if (requeued > 0) {
        pushMessage(conv, {
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'system',
          from: 'system',
          to: 'human',
          text: `已恢復佇列：重新排入 ${requeued} 個卡在 running 的任務。`,
        });
      }

      helpers.writeBoard(board);

      processQueue(conversationId, deps, helpers).catch(err => console.error(err.message));
      return json(res, 200, { ok: true, requeued });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  return false;
};
