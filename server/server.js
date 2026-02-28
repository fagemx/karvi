#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const bb = require('./blackboard-server');
const mgmt = require('./management');
const runtime = require('./runtime-openclaw');

let runtimeCodex = null;
try { runtimeCodex = require('./runtime-codex'); } catch { /* codex not installed, skip */ }

let runtimeClaude = null;
try { runtimeClaude = require('./runtime-claude'); } catch { /* claude not installed, skip */ }

const RUNTIMES = {
  openclaw: runtime,
  ...(runtimeCodex ? { codex: runtimeCodex } : {}),
  ...(runtimeClaude ? { claude: runtimeClaude } : {}),
};

let jiraIntegration = null;
try { jiraIntegration = require('./integration-jira'); } catch { /* jira integration not available, skip */ }

const telemetry = require('./telemetry');
const push = require('./push');

const vault = require('./vault').createVault({ vaultDir: path.join(__dirname, 'vaults') });

function getRuntime(hint) {
  return RUNTIMES[hint] || runtime;
}

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..');
const DATA_DIR = process.env.DATA_DIR || DIR;
const PUSH_TOKENS_PATH = path.join(DATA_DIR, 'push-tokens.json');

const ctx = bb.createContext({
  dir: ROOT,
  boardPath: path.join(DATA_DIR, 'board.json'),
  logPath: path.join(DATA_DIR, 'task-log.jsonl'),
  port: Number(process.env.PORT || 3461),
  boardType: 'task-engine',
});

const { nowIso, uid, json } = bb;
const readBoard = () => bb.readBoard(ctx);
const writeBoard = (b) => bb.writeBoard(ctx, b);
const appendLog = (e) => bb.appendLog(ctx, e);
const broadcastSSE = (ev, d) => bb.broadcastSSE(ctx, ev, d);

const processing = new Map();

// --- S8: Scoped Boards (briefs) ---
const BRIEFS_DIR = path.join(DATA_DIR, 'briefs');
const SKILLS_NEEDING_BRIEF = new Set(['conversapix-storyboard']);

function ensureBriefsDir() {
  if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });
}

function readBrief(taskId) {
  const board = readBoard();
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task?.briefPath) return null;
  const p = path.resolve(DIR, task.briefPath);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeBrief(taskId, data) {
  const board = readBoard();
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task?.briefPath) return false;

  data.meta = data.meta || {};
  data.meta.updatedAt = nowIso();
  data.meta.boardType = data.meta.boardType || 'brief';
  data.meta.version = data.meta.version || 1;
  data.meta.taskId = taskId;

  const p = path.resolve(DIR, task.briefPath);
  ensureBriefsDir();
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  broadcastSSE('brief', { taskId, data });
  return true;
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

function summarizeBriefAsSignal(taskId) {
  const brief = readBrief(taskId);
  if (!brief?.shotspec?.shots?.length) return null;
  const shots = brief.shotspec.shots;
  const totalRetries = shots.reduce((sum, s) => sum + (s.retries || 0), 0);
  const avgScore = shots.reduce((sum, s) => sum + (s.score || 0), 0) / shots.length;
  return {
    type: 'task_brief_summary',
    taskId,
    shotCount: shots.length,
    totalRetries,
    avgScore: Math.round(avgScore),
    passRate: shots.filter(s => s.status === 'pass').length / shots.length,
  };
}

function normalizeText(input) {
  return String(input || '').replace(/\r\n/g, '\n').trim();
}

function conversationById(board, id) {
  return (board.conversations || []).find(c => c.id === id);
}

function participantById(board, id) {
  return (board.participants || []).find(p => p.id === id);
}

function createConversation({ id, title, members, defaultAutoTurns = 6 }) {
  return {
    id,
    title,
    members,
    status: 'active',
    settings: {
      autoRunQueue: true,
      defaultAutoTurns,
    },
    runtime: {
      running: false,
      stopRequested: false,
      lastRunAt: null,
    },
    sessionIds: members.reduce((acc, m) => {
      acc[m] = null;
      return acc;
    }, {}),
    queue: [],
    messages: [
      {
        id: uid('msg'),
        ts: nowIso(),
        type: 'system',
        from: 'human',
        to: 'human',
        text: `房間 ${title} 已建立。`,
      },
    ],
  };
}

function pushMessage(conv, msg) {
  conv.messages = conv.messages || [];
  conv.messages.push(msg);
  if (conv.messages.length > 1000) conv.messages = conv.messages.slice(-1000);
}

function enqueueTurn(conv, turn) {
  conv.queue = conv.queue || [];
  conv.queue.push(turn);
}

function requeueRunningTurns(conv, reason = 'manual_resume') {
  conv.queue = conv.queue || [];
  let count = 0;
  for (const t of conv.queue) {
    if (t.status === 'running') {
      t.status = 'queued';
      t.requeuedAt = nowIso();
      t.requeueReason = reason;
      t.history = t.history || [];
      t.history.push({ ts: nowIso(), event: 'requeued', reason });
      count += 1;
    }
  }
  return count;
}

// --- Auto Re-dispatch: send fix instructions back to engineer ---
function redispatchTask(board, task) {
  const assignee = participantById(board, task.assignee);
  if (!assignee || assignee.type !== 'agent') {
    console.log(`[redispatch:${task.id}] skip: assignee ${task.assignee} is not an agent`);
    return;
  }

  try { mgmt.ensureTaskTransition(task.status, 'in_progress'); }
  catch { console.log(`[redispatch:${task.id}] skip: cannot transition ${task.status} → in_progress`); return; }

  // S5: Build dispatch plan via management layer
  const sessionId = task.childSessionKey || board.conversations?.[0]?.sessionIds?.[task.assignee] || null;
  const plan = mgmt.buildDispatchPlan(board, task, { mode: 'redispatch' });
  plan.sessionId = plan.sessionId || sessionId;

  const preferredModel = plan.modelHint;

  task.status = 'in_progress';
  task.history = task.history || [];
  task.history.push({ ts: nowIso(), status: 'in_progress', by: 'auto-redispatch', attempt: task.reviewAttempts, model: preferredModel || undefined });
  task.lastDispatchModel = preferredModel || null;

  // S5: Write dispatch state — prepared
  task.dispatch = {
    version: mgmt.DISPATCH_PLAN_VERSION,
    state: 'prepared',
    planId: plan.planId,
    runtime: plan.runtimeHint,
    agentId: plan.agentId,
    model: plan.modelHint || null,
    timeoutSec: plan.timeoutSec || 300,
    preparedAt: plan.createdAt,
    startedAt: null,
    finishedAt: null,
    sessionId: plan.sessionId || null,
    lastError: null,
  };

  const conv = board.conversations?.[0];
  if (conv) {
    pushMessage(conv, {
      id: uid('msg'), ts: nowIso(), type: 'system', from: 'system', to: task.assignee,
      text: `[Auto Re-dispatch ${task.id}] 第 ${task.reviewAttempts} 次修正指令已發送 → ${assignee.displayName}${preferredModel ? `\nmodel: ${preferredModel}` : ''}`,
    });
  }
  writeBoard(board);

  appendLog({ ts: nowIso(), event: 'auto_redispatch', taskId: task.id, assignee: task.assignee, attempt: task.reviewAttempts, model: preferredModel || null });

  // S5: Mark dispatching
  task.dispatch.state = 'dispatching';
  task.dispatch.startedAt = nowIso();
  writeBoard(board);

  // Dispatch via plan (runtime-neutral)
  const rt = getRuntime(plan.runtimeHint);
  rt.dispatch(plan).then(result => {
    const replyText = rt.extractReplyText(result.parsed, result.stdout);
    const newSessionId = rt.extractSessionId(result.parsed);
    const latestBoard = readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
    const latestConv = latestBoard.conversations?.[0];

    if (latestConv) {
      if (newSessionId) latestConv.sessionIds[task.assignee] = newSessionId;
      pushMessage(latestConv, {
        id: uid('msg'), ts: nowIso(), type: 'message', from: task.assignee, to: 'human',
        text: `[${task.id} Fix Reply]\n${replyText}`,
        sessionId: newSessionId || sessionId,
      });
    }

    if (latestTask && latestTask.status === 'in_progress') {
      latestTask.lastReply = replyText;
      latestTask.lastReplyAt = nowIso();
    }

    // S5: Mark dispatch completed
    if (latestTask) {
      latestTask.dispatch = latestTask.dispatch || {};
      latestTask.dispatch.state = 'completed';
      latestTask.dispatch.finishedAt = nowIso();
      latestTask.dispatch.sessionId = newSessionId || latestTask.dispatch.sessionId || null;
      latestTask.dispatch.lastError = null;
    }

    writeBoard(latestBoard);
    appendLog({ ts: nowIso(), event: 'auto_redispatch_reply', taskId: task.id, reply: replyText.slice(0, 500) });
  }).catch(err => {
    const latestBoard = readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
    const latestConv = latestBoard.conversations?.[0];
    if (latestTask) {
      latestTask.status = 'blocked';
      latestTask.blocker = { reason: `Re-dispatch failed: ${err.message}`, askedAt: nowIso() };
      latestTask.history = latestTask.history || [];
      latestTask.history.push({ ts: nowIso(), status: 'blocked', reason: err.message, by: 'auto-redispatch-error' });

      // S5: Mark dispatch failed
      latestTask.dispatch = latestTask.dispatch || {};
      latestTask.dispatch.state = 'failed';
      latestTask.dispatch.finishedAt = nowIso();
      latestTask.dispatch.lastError = err.message || String(err);
    }
    if (latestConv) {
      pushMessage(latestConv, {
        id: uid('msg'), ts: nowIso(), type: 'error', from: 'system', to: 'human',
        text: `[${task.id}] Auto re-dispatch failed: ${err.message}`,
      });
    }
    // Evolution Layer: emit error signal for redispatch failure
    mgmt.ensureEvolutionFields(latestBoard);
    latestBoard.signals.push({
      id: uid('sig'),
      ts: nowIso(),
      by: 'server.js',
      type: 'error',
      content: `${task.id} redispatch failed: ${err.message}`,
      refs: [task.id],
      data: { taskId: task.id, error: err.message },
    });
    if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
    writeBoard(latestBoard);
    // Push notification: redispatch failed (fire-and-forget)
    if (latestTask) {
      push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'dispatch.failed')
        .catch(err2 => console.error('[push] redispatch-failed notify failed:', err2.message));
    }
    console.error(`[redispatch:${task.id}] error: ${err.message}`);
  });
}

async function processQueue(conversationId) {
  if (processing.get(conversationId)) return;
  processing.set(conversationId, true);

  try {
    while (true) {
      const board = readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) break;

      conv.runtime = conv.runtime || { running: false, stopRequested: false, lastRunAt: null };

      if (conv.runtime.stopRequested) {
        conv.runtime.running = false;
        writeBoard(board);
        break;
      }

      const turn = (conv.queue || []).find(t => t.status === 'queued');
      if (!turn) {
        conv.runtime.running = false;
        conv.runtime.lastRunAt = nowIso();
        writeBoard(board);
        break;
      }

      const target = participantById(board, turn.to);
      if (!target || target.type !== 'agent') {
        turn.status = 'error';
        turn.error = `Target ${turn.to} is not an agent`;
        turn.finishedAt = nowIso();
        pushMessage(conv, {
          id: uid('msg'),
          ts: nowIso(),
          type: 'error',
          from: 'system',
          to: turn.from,
          text: turn.error,
          turnId: turn.id,
        });
        writeBoard(board);
        continue;
      }

      conv.runtime.running = true;
      turn.status = 'running';
      turn.startedAt = nowIso();
      writeBoard(board);

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

        const latestBoard = readBoard();
        const latestConv = conversationById(latestBoard, conversationId);
        const latestTurn = (latestConv.queue || []).find(t => t.id === turn.id);
        if (!latestConv || !latestTurn) break;

        latestConv.sessionIds = latestConv.sessionIds || {};
        if (newSessionId) latestConv.sessionIds[target.id] = newSessionId;

        latestTurn.status = 'done';
        latestTurn.finishedAt = nowIso();
        latestTurn.result = {
          reply: replyText,
          sessionId: newSessionId || sessionId || null,
        };

        const agentMsg = {
          id: uid('msg'),
          ts: nowIso(),
          type: 'message',
          from: target.id,
          to: turn.from,
          text: replyText,
          turnId: latestTurn.id,
          sessionId: newSessionId || sessionId || null,
        };

        pushMessage(latestConv, agentMsg);

        appendLog({
          ts: nowIso(),
          conversationId,
          event: 'agent_reply',
          turnId: latestTurn.id,
          from: target.id,
          to: turn.from,
          sessionId: newSessionId || sessionId || null,
          text: replyText,
        });

        if (latestTurn.loop?.enabled && latestTurn.loop.remaining > 0) {
          const pair = Array.isArray(latestTurn.loop.pair) ? latestTurn.loop.pair : [];
          const [a, b] = pair;
          const nextTo = target.id === a ? b : target.id === b ? a : null;
          const nextTarget = nextTo ? participantById(latestBoard, nextTo) : null;

          if (nextTarget && nextTarget.type === 'agent') {
            const nextTurn = {
              id: uid('turn'),
              createdAt: nowIso(),
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
              id: uid('msg'),
              ts: nowIso(),
              type: 'system',
              from: 'system',
              to: 'human',
              text: `自動接力：${target.displayName} → ${nextTarget.displayName}（剩餘 ${nextTurn.loop.remaining} 輪）`,
              turnId: nextTurn.id,
            });

            appendLog({
              ts: nowIso(),
              conversationId,
              event: 'loop_enqueue',
              turnId: nextTurn.id,
              from: target.id,
              to: nextTarget.id,
              remaining: nextTurn.loop.remaining,
            });
          }
        }

        writeBoard(latestBoard);
      } catch (error) {
        const latestBoard = readBoard();
        const latestConv = conversationById(latestBoard, conversationId);
        const latestTurn = (latestConv?.queue || []).find(t => t.id === turn.id);
        if (!latestConv || !latestTurn) break;

        latestTurn.status = 'error';
        latestTurn.finishedAt = nowIso();
        latestTurn.error = error.message;

        pushMessage(latestConv, {
          id: uid('msg'),
          ts: nowIso(),
          type: 'error',
          from: 'system',
          to: turn.from,
          text: `Agent call failed (${target.displayName}): ${error.message}`,
          turnId: latestTurn.id,
        });

        appendLog({
          ts: nowIso(),
          conversationId,
          event: 'agent_error',
          turnId: latestTurn.id,
          from: turn.from,
          to: turn.to,
          error: error.message,
        });

        writeBoard(latestBoard);
      }
    }
  } finally {
    processing.set(conversationId, false);
  }
}

// --- HTTP Server (built on blackboard-server core) ---
const VALID_VAULT_ID = /^[a-zA-Z0-9_-]+$/;

const server = bb.createServer(ctx, (req, res, helpers) => {

  // --- Push Token API ---

  if (req.method === 'POST' && req.url === '/api/push-token') {
    bb.parseBody(req).then(payload => {
      const token = String(payload.token || '').trim();
      if (!token || !token.startsWith('ExponentPushToken[')) {
        return json(res, 400, { error: 'Invalid Expo push token' });
      }
      const deviceName = String(payload.deviceName || 'Unknown').trim();
      push.registerToken(PUSH_TOKENS_PATH, token, deviceName);
      json(res, 200, { ok: true });
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  if (req.method === 'DELETE' && req.url === '/api/push-token') {
    bb.parseBody(req).then(payload => {
      const token = String(payload.token || '').trim();
      if (!token) return json(res, 400, { error: 'token required' });
      push.removeToken(PUSH_TOKENS_PATH, token);
      json(res, 200, { ok: true });
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // --- Vault API ---

  if (req.method === 'GET' && req.url === '/api/vault/status') {
    return json(res, 200, { enabled: vault.isEnabled() });
  }

  if (req.url.startsWith('/api/vault/') && !vault.isEnabled()) {
    return json(res, 503, { error: 'Vault not configured (KARVI_VAULT_KEY not set)' });
  }

  if (req.method === 'POST' && req.url === '/api/vault/store') {
    bb.parseBody(req).then(payload => {
      const { userId, keyName, value } = payload;
      if (!userId || !VALID_VAULT_ID.test(userId)) return json(res, 400, { error: 'Invalid userId' });
      if (!keyName || !VALID_VAULT_ID.test(keyName)) return json(res, 400, { error: 'Invalid keyName' });
      if (!value) return json(res, 400, { error: 'value is required' });
      const result = vault.store(userId, keyName, value);
      json(res, result.ok ? 200 : 400, result);
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  const vaultKeysMatch = req.url.match(/^\/api\/vault\/keys\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && vaultKeysMatch) {
    const userId = vaultKeysMatch[1];
    const result = vault.list(userId);
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  const vaultDeleteMatch = req.url.match(/^\/api\/vault\/delete\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'DELETE' && vaultDeleteMatch) {
    const [, userId, keyName] = vaultDeleteMatch;
    const result = vault.delete(userId, keyName);
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // --- Conversations & Chat ---

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

        const board = readBoard();
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

        writeBoard(board);
        appendLog({ ts: nowIso(), event: 'conversation_created', conversationId: id, title, members });
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

        const board = readBoard();
        if (participantById(board, id)) return json(res, 409, { error: `Participant ${id} already exists` });

        const participant = { id, type, displayName };
        if (type === 'agent') participant.agentId = agentId;
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

        writeBoard(board);
        appendLog({ ts: nowIso(), event: 'participant_added', participant, conversationId: conv?.id || null });
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

        const board = readBoard();
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
          id: uid('msg'),
          ts: nowIso(),
          type: 'message',
          from,
          to,
          text,
        };
        pushMessage(conv, msg);

        appendLog({
          ts: nowIso(),
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
            id: uid('turn'),
            createdAt: nowIso(),
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
            id: uid('msg'),
            ts: nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `已排入佇列：${from} → ${to}。`,
            turnId: queuedTurn.id,
          });
        }

        writeBoard(board);

        if (queuedTurn && conv.settings?.autoRunQueue !== false) {
          processQueue(conversationId).catch(err => {
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
      const board = readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) return json(res, 404, { error: `Conversation ${conversationId} not found` });
      const requeued = requeueRunningTurns(conv, 'manual_run_recover_running');
      if (requeued > 0) {
        pushMessage(conv, {
          id: uid('msg'),
          ts: nowIso(),
          type: 'system',
          from: 'system',
          to: 'human',
          text: `手動執行前已回收 ${requeued} 個 running 任務。`,
        });
      }
      writeBoard(board);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }

    processQueue(conversationId).catch(err => {
      console.error(`[manual run error] ${err.message}`);
    });
    return json(res, 200, { ok: true, started: true });
  }

  const stopMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const conversationId = decodeURIComponent(stopMatch[1]);
    try {
      const board = readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) return json(res, 404, { error: `Conversation ${conversationId} not found` });

      conv.runtime = conv.runtime || {};
      conv.runtime.stopRequested = true;
      conv.runtime.running = false;

      pushMessage(conv, {
        id: uid('msg'),
        ts: nowIso(),
        type: 'system',
        from: 'system',
        to: 'human',
        text: '已要求停止佇列處理。',
      });

      writeBoard(board);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  const clearStopMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/resume$/);
  if (req.method === 'POST' && clearStopMatch) {
    const conversationId = decodeURIComponent(clearStopMatch[1]);
    try {
      const board = readBoard();
      const conv = conversationById(board, conversationId);
      if (!conv) return json(res, 404, { error: `Conversation ${conversationId} not found` });

      conv.runtime = conv.runtime || {};
      conv.runtime.stopRequested = false;

      // Recovery: if server restart/stop left turns in "running", requeue them
      const requeued = requeueRunningTurns(conv, 'resume_recover_running');
      if (requeued > 0) {
        pushMessage(conv, {
          id: uid('msg'),
          ts: nowIso(),
          type: 'system',
          from: 'system',
          to: 'human',
          text: `已恢復佇列：重新排入 ${requeued} 個卡在 running 的任務。`,
        });
      }

      writeBoard(board);

      processQueue(conversationId).catch(err => console.error(err.message));
      return json(res, 200, { ok: true, requeued });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // --- Controls API ---

  if (req.method === 'GET' && req.url === '/api/controls') {
    try {
      const board = readBoard();
      return json(res, 200, mgmt.getControls(board));
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/controls') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const board = readBoard();
        board.controls = board.controls || {};
        const allowed = Object.keys(mgmt.DEFAULT_CONTROLS);
        for (const key of allowed) {
          if (key in patch) {
            const val = patch[key];
            if ((key === 'auto_review' || key === 'auto_redispatch' || key === 'auto_apply_insights' || key === 'telemetry_enabled') && typeof val === 'boolean') board.controls[key] = val;
            else if (key === 'max_review_attempts' && Number.isFinite(val)) board.controls[key] = Math.max(1, Math.min(10, val));
            else if (key === 'quality_threshold' && Number.isFinite(val)) board.controls[key] = Math.max(0, Math.min(100, val));
            else if (key === 'review_timeout_sec' && Number.isFinite(val)) board.controls[key] = Math.max(30, Math.min(600, val));
            else if (key === 'review_agent' && typeof val === 'string') board.controls[key] = val.trim();
          }
        }
        writeBoard(board);
        appendLog({ ts: nowIso(), event: 'controls_updated', controls: board.controls });
        json(res, 200, { ok: true, controls: mgmt.getControls(board) });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Manual review trigger ---

  const manualReviewMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/review$/);
  if (req.method === 'POST' && manualReviewMatch) {
    const taskId = decodeURIComponent(manualReviewMatch[1]);
    try {
      const board = readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
      if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
      if (task.status !== 'completed' && task.status !== 'needs_revision') {
        return json(res, 400, { error: `Task must be completed or needs_revision to review (current: ${task.status})` });
      }
      if (task.status === 'needs_revision') {
        task.status = 'completed';
        task.history = task.history || [];
        task.history.push({ ts: nowIso(), status: 'completed', by: 'manual-re-review' });
        writeBoard(board);
      }
      runtime.spawnReview(taskId, {
        boardPath: ctx.boardPath,
        onComplete: (code) => {
          try {
            const updatedBoard = readBoard();
            broadcastSSE('board', updatedBoard);
            const ctrl = mgmt.getControls(updatedBoard);
            const t = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
            if (
              ctrl.auto_redispatch &&
              t &&
              t.status === 'needs_revision' &&
              (t.reviewAttempts || 0) < ctrl.max_review_attempts
            ) {
              console.log(`[review:${taskId}] auto-redispatch triggered`);
              setImmediate(() => redispatchTask(updatedBoard, t));
            }
          } catch (err) {
            console.error(`[review:${taskId}] post-review error: ${err.message}`);
          }
        },
      });
      json(res, 200, { ok: true, taskId, reviewing: true });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- Task Engine APIs ---

  if (req.method === 'GET' && req.url.startsWith('/api/tasks')) {
    try {
      const board = readBoard();
      return json(res, 200, board.taskPlan || {});
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // Serve spec files as raw text
  if (req.method === 'GET' && req.url.startsWith('/api/spec/')) {
    const specFile = decodeURIComponent(req.url.replace('/api/spec/', ''));
    const specPath = path.normalize(path.join(DIR, 'specs', specFile));
    if (!specPath.startsWith(path.join(DIR, 'specs'))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(specPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Spec not found');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/tasks') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const board = readBoard();

        board.taskPlan = {
          goal: String(payload.goal || ''),
          phase: String(payload.phase || 'idle'),
          createdAt: payload.createdAt || nowIso(),
          tasks: Array.isArray(payload.tasks) ? payload.tasks : []
        };

        writeBoard(board);
        appendLog({ ts: nowIso(), event: 'taskPlan_updated', goal: board.taskPlan.goal });
        json(res, 200, { ok: true, taskPlan: board.taskPlan });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const taskUpdateMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/update$/);
  if (req.method === 'POST' && taskUpdateMatch) {
    const taskId = decodeURIComponent(taskUpdateMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const board = readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);

        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        if (payload.status) {
          const nextStatus = String(payload.status).trim();
          const validStatuses = ['pending', 'dispatched', 'in_progress', 'blocked', 'completed', 'reviewing', 'approved', 'needs_revision'];
          if (!validStatuses.includes(nextStatus)) {
            return json(res, 400, { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
          }
          mgmt.ensureTaskTransition(oldStatus, nextStatus);
          task.status = nextStatus;
        }
        if (payload.result) task.result = payload.result;
        if (payload.childSessionKey) task.childSessionKey = payload.childSessionKey;
        if (payload.blocker) task.blocker = payload.blocker;

        task.history = task.history || [];
        task.history.push({
          ts: nowIso(),
          status: task.status,
          update: payload
        });

        const conv = board.conversations?.[0];
        if (conv && payload.status) {
          const prev = String(task.history?.[task.history.length - 2]?.status || 'unknown');
          const next = String(payload.status);
          const note = payload.blocker?.reason || payload.result?.summary || '';
          pushMessage(conv, {
            id: uid('msg'),
            ts: nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] ${prev} → ${next}${note ? `\n${String(note).slice(0, 200)}` : ''}`,
          });
        }

        if (task.status === 'in_progress' && !task.startedAt) task.startedAt = nowIso();
        if (task.status === 'in_progress') {
          task.reviewAttempts = 0;
        }
        if (task.status === 'completed') {
          task.completedAt = nowIso();
          delete task.review;
        }

        if (payload.status === 'blocked' && !payload.blocker) {
          task.blocker = { reason: 'Unknown block', askedAt: nowIso() };
        }

        // Strict gate: only approved can unlock dependents
        if (payload.status === 'approved') {
          mgmt.autoUnlockDependents(board);
        }

        // Evolution Layer: emit status_change signal
        if (payload.status) {
          mgmt.ensureEvolutionFields(board);
          board.signals.push({
            id: uid('sig'),
            ts: nowIso(),
            by: 'server.js',
            type: 'status_change',
            content: `${task.id} ${oldStatus} → ${task.status}`,
            refs: [task.id],
            data: { taskId: task.id, from: oldStatus, to: task.status, assignee: task.assignee },
          });
          if (board.signals.length > 500) board.signals = board.signals.slice(-500);
        }

        writeBoard(board);
        appendLog({ ts: nowIso(), event: 'task_updated', taskId, status: task.status });

        // Jira integration: fire-and-forget notification
        if (jiraIntegration?.isEnabled(board)) {
          jiraIntegration.notifyJira(board, task, { type: 'status_change', newStatus: task.status })
            .catch(err => console.error('[jira] notify failed:', err.message));
        }

        // Push notification: fire-and-forget
        if (payload.status && ['completed', 'blocked', 'needs_revision', 'approved'].includes(task.status)) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, `task.${task.status}`)
            .catch(err => console.error('[push] notify failed:', err.message));
        }

        if (payload.status === 'completed') {
          const ctrl = mgmt.getControls(board);
          if (ctrl.auto_review) setImmediate(() => runtime.spawnReview(taskId, {
            boardPath: ctx.boardPath,
            onComplete: (code) => {
              try {
                const updatedBoard = readBoard();
                broadcastSSE('board', updatedBoard);
                const ctrl2 = mgmt.getControls(updatedBoard);
                const t = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
                if (
                  ctrl2.auto_redispatch &&
                  t &&
                  t.status === 'needs_revision' &&
                  (t.reviewAttempts || 0) < ctrl2.max_review_attempts
                ) {
                  console.log(`[review:${taskId}] auto-redispatch triggered`);
                  setImmediate(() => redispatchTask(updatedBoard, t));
                }
              } catch (err) {
                console.error(`[review:${taskId}] post-review error: ${err.message}`);
              }
            },
          }));
        }

        json(res, 200, { ok: true, task });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const unblockMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/unblock$/);
  if (req.method === 'POST' && unblockMatch) {
    const taskId = decodeURIComponent(unblockMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const message = String(payload.message || '').trim();
        if (!message) return json(res, 400, { error: 'message is required to unblock' });

        const board = readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);

        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        if (task.status !== 'blocked') return json(res, 400, { error: `Task ${taskId} is not blocked` });

        // Prefer childSessionKey if agent created one, otherwise fallback to main room session
        const sessionId = task.childSessionKey || board.conversations?.[0]?.sessionIds?.[task.assignee] || null;

        task.status = 'in_progress';
        task.blocker = null;
        task.history.push({ ts: nowIso(), status: 'in_progress', unblockedBy: 'human', message });
        writeBoard(board);

        // Async dispatch unblock instruction to the agent
        if (sessionId) {
          runtime.runOpenclawTurn({
            agentId: task.assignee,
            sessionId,
            message: `【Human 回覆你的 Blocked 問題】：\n${message}\n\n請根據此回覆繼續執行任務。`,
            timeoutSec: 180
          }).then(result => {
            const replyText = runtime.extractReplyText(result.parsed, result.stdout);
            const latestBoard = readBoard();
            const latestConv = latestBoard.conversations?.[0];
            if (latestConv) {
              pushMessage(latestConv, {
                id: uid('msg'),
                ts: nowIso(),
                type: 'message',
                from: task.assignee,
                to: 'human',
                text: `(Unblock Response for ${task.id})\n${replyText}`,
                sessionId
              });
              writeBoard(latestBoard);
            }
            appendLog({ ts: nowIso(), event: 'unblock_reply', taskId, reply: replyText });
          }).catch(err => {
            console.error(`[unblock dispatch err] ${err.message}`);
          });
        }

        json(res, 200, { ok: true, task });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Per-task manual status control ---
  const taskStatusMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === 'POST' && taskStatusMatch) {
    const taskId = decodeURIComponent(taskStatusMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const newStatus = String(payload.status || '').trim();
        const validStatuses = ['pending', 'dispatched', 'in_progress', 'blocked', 'completed', 'reviewing', 'approved', 'needs_revision'];
        if (!validStatuses.includes(newStatus)) {
          return json(res, 400, { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        const board = readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        mgmt.ensureTaskTransition(oldStatus, newStatus);
        task.status = newStatus;
        task.history = task.history || [];
        task.history.push({ ts: nowIso(), status: newStatus, from: oldStatus, by: 'human' });

        const conv = board.conversations?.[0];
        if (conv) {
          const detail = payload.reason ? `\nreason: ${String(payload.reason).slice(0, 240)}` : '';
          pushMessage(conv, {
            id: uid('msg'),
            ts: nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] ${oldStatus} → ${newStatus}${detail}`,
          });
        }

        if (newStatus === 'in_progress' && !task.startedAt) task.startedAt = nowIso();
        if (newStatus === 'in_progress') {
          task.reviewAttempts = 0;
        }
        if (newStatus === 'completed') {
          task.completedAt = nowIso();
          delete task.review;
        }
        if (newStatus === 'blocked' && payload.reason) {
          task.blocker = { reason: payload.reason, askedAt: nowIso() };
        }
        if (newStatus !== 'blocked') task.blocker = null;

        // Strict gate: only approved can unlock dependents
        if (newStatus === 'approved') {
          mgmt.autoUnlockDependents(board);
        }

        // Update phase if all tasks approved
        const allApproved = board.taskPlan.tasks.every(t => t.status === 'approved');
        if (allApproved) board.taskPlan.phase = 'done';

        // Evolution Layer: emit status_change signal
        mgmt.ensureEvolutionFields(board);
        board.signals.push({
          id: uid('sig'),
          ts: nowIso(),
          by: 'server.js',
          type: 'status_change',
          content: `${task.id} ${oldStatus} → ${newStatus}`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: newStatus, assignee: task.assignee },
        });
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);

        writeBoard(board);
        appendLog({ ts: nowIso(), event: 'task_status_manual', taskId, from: oldStatus, to: newStatus });

        // Jira integration: fire-and-forget notification
        if (jiraIntegration?.isEnabled(board)) {
          jiraIntegration.notifyJira(board, task, { type: 'status_change', newStatus })
            .catch(err => console.error('[jira] notify failed:', err.message));
        }

        // Push notification: fire-and-forget
        if (['completed', 'blocked', 'needs_revision', 'approved'].includes(newStatus)) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, `task.${newStatus}`)
            .catch(err => console.error('[push] notify failed:', err.message));
        }
        // Push: all tasks approved
        if (allApproved) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'all.approved')
            .catch(err => console.error('[push] all-approved notify failed:', err.message));
        }

        if (newStatus === 'completed') {
          const ctrl = mgmt.getControls(board);
          if (ctrl.auto_review) setImmediate(() => runtime.spawnReview(taskId, {
            boardPath: ctx.boardPath,
            onComplete: (code) => {
              try {
                const updatedBoard = readBoard();
                broadcastSSE('board', updatedBoard);
                const ctrl2 = mgmt.getControls(updatedBoard);
                const t = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
                if (
                  ctrl2.auto_redispatch &&
                  t &&
                  t.status === 'needs_revision' &&
                  (t.reviewAttempts || 0) < ctrl2.max_review_attempts
                ) {
                  console.log(`[review:${taskId}] auto-redispatch triggered`);
                  setImmediate(() => redispatchTask(updatedBoard, t));
                }
              } catch (err) {
                console.error(`[review:${taskId}] post-review error: ${err.message}`);
              }
            },
          }));
        }

        json(res, 200, { ok: true, task });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Per-task dispatch: send task directly to assigned agent ---
  const taskDispatchMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/dispatch$/);
  if (req.method === 'POST' && taskDispatchMatch) {
    const taskId = decodeURIComponent(taskDispatchMatch[1]);
    try {
      const board = readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
      if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

      const assignee = participantById(board, task.assignee);
      if (!assignee || assignee.type !== 'agent') {
        return json(res, 400, { error: `Assignee ${task.assignee} is not an agent` });
      }

      // Check dependencies
      const unmetDeps = (task.depends || []).filter(depId => {
        const dep = (board.taskPlan?.tasks || []).find(t => t.id === depId);
        return !dep || dep.status !== 'approved';
      });
      if (unmetDeps.length > 0) {
        return json(res, 400, { error: `Unmet dependencies: ${unmetDeps.join(', ')}` });
      }

      const sessionId = board.conversations?.[0]?.sessionIds?.[task.assignee] || null;

      // S5: Build dispatch plan via management layer
      const plan = mgmt.buildDispatchPlan(board, task, { mode: 'dispatch', requireTaskResult: false });
      plan.sessionId = plan.sessionId || sessionId;

      const preferredModel = plan.modelHint;

      // Update status
      task.status = 'in_progress';
      task.startedAt = task.startedAt || nowIso();
      task.history = task.history || [];
      task.history.push({ ts: nowIso(), status: 'in_progress', by: 'dispatch', model: preferredModel || undefined });
      task.lastDispatchModel = preferredModel || null;
      board.taskPlan.phase = 'executing';

      // S5: Write dispatch state — prepared
      task.dispatch = {
        version: mgmt.DISPATCH_PLAN_VERSION,
        state: 'prepared',
        planId: plan.planId,
        runtime: plan.runtimeHint,
        agentId: plan.agentId,
        model: plan.modelHint || null,
        timeoutSec: plan.timeoutSec || 300,
        preparedAt: plan.createdAt,
        startedAt: null,
        finishedAt: null,
        sessionId: plan.sessionId || null,
        lastError: null,
      };

      const conv = board.conversations?.[0];
      if (conv) {
        pushMessage(conv, {
          id: uid('msg'),
          ts: nowIso(),
          type: 'system',
          from: 'human',
          to: task.assignee,
          text: `[Dispatch ${task.id}] ${task.title} → ${assignee.displayName}${preferredModel ? `\nmodel: ${preferredModel}` : ''}`,
        });
      }
      writeBoard(board);

      // S5: Mark dispatching
      task.dispatch.state = 'dispatching';
      task.dispatch.startedAt = nowIso();
      writeBoard(board);

      // Fire and forget — agent runs async via dispatch plan (runtime-neutral)
      const rt2 = getRuntime(plan.runtimeHint);
      rt2.dispatch(plan).then(result => {
        const replyText = rt2.extractReplyText(result.parsed, result.stdout);
        const newSessionId = rt2.extractSessionId(result.parsed);
        const latestBoard = readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
        const latestConv = latestBoard.conversations?.[0];

        if (latestConv) {
          if (newSessionId) latestConv.sessionIds[task.assignee] = newSessionId;
          pushMessage(latestConv, {
            id: uid('msg'),
            ts: nowIso(),
            type: 'message',
            from: task.assignee,
            to: 'human',
            text: `[${task.id} Reply]\n${replyText}`,
            sessionId: newSessionId || sessionId,
          });
        }

        // Don't auto-parse BLOCKED/COMPLETED from text — let Human decide via UI buttons
        if (latestTask && latestTask.status === 'in_progress') {
          latestTask.lastReply = replyText;
          latestTask.lastReplyAt = nowIso();
        }

        // S5: Mark dispatch completed
        if (latestTask) {
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'completed';
          latestTask.dispatch.finishedAt = nowIso();
          latestTask.dispatch.sessionId = newSessionId || latestTask.dispatch.sessionId || null;
          latestTask.dispatch.lastError = null;
        }

        writeBoard(latestBoard);
        appendLog({ ts: nowIso(), event: 'task_dispatch_reply', taskId, agent: task.assignee, model: preferredModel || null, reply: replyText.slice(0, 500) });
      }).catch(err => {
        const latestBoard = readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
        const latestConv = latestBoard.conversations?.[0];
        if (latestTask) {
          latestTask.status = 'blocked';
          latestTask.blocker = { reason: `Dispatch failed: ${err.message}`, askedAt: nowIso() };
          latestTask.history = latestTask.history || [];
          latestTask.history.push({ ts: nowIso(), status: 'blocked', reason: err.message });

          // S5: Mark dispatch failed
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'failed';
          latestTask.dispatch.finishedAt = nowIso();
          latestTask.dispatch.lastError = err.message || String(err);
        }
        if (latestConv) {
          pushMessage(latestConv, {
            id: uid('msg'),
            ts: nowIso(),
            type: 'error',
            from: 'system',
            to: 'human',
            text: `[${taskId}] Dispatch failed: ${err.message}`,
          });
        }
        // Evolution Layer: emit error signal for dispatch failure
        mgmt.ensureEvolutionFields(latestBoard);
        latestBoard.signals.push({
          id: uid('sig'),
          ts: nowIso(),
          by: 'server.js',
          type: 'error',
          content: `${taskId} dispatch failed: ${err.message}`,
          refs: [taskId],
          data: { taskId, error: err.message },
        });
        if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
        writeBoard(latestBoard);
        // Push notification: dispatch failed (fire-and-forget)
        if (latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'dispatch.failed')
            .catch(err2 => console.error('[push] dispatch-failed notify failed:', err2.message));
        }
        console.error(`[task dispatch error] ${taskId}: ${err.message}`);
      });

      json(res, 200, { ok: true, taskId, dispatched: true });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- Bulk dispatch: notify Nox (Lead) to dispatch tasks via sessions_spawn ---
  const dispatchMatch = req.url.match(/^\/api\/tasks\/dispatch$/);
  if (req.method === 'POST' && dispatchMatch) {
    try {
      const board = readBoard();

      // Find tasks that are ready (pending/dispatched, deps approved)
      const readyTasks = (board.taskPlan?.tasks || []).filter(t => {
        if (t.status !== 'pending' && t.status !== 'dispatched') return false;
        const unmet = (t.depends || []).filter(depId => {
          const dep = (board.taskPlan?.tasks || []).find(d => d.id === depId);
          return !dep || dep.status !== 'approved';
        });
        return unmet.length === 0;
      });

      if (readyTasks.length === 0) {
        return json(res, 200, { ok: true, dispatched: 0, message: 'No tasks ready to dispatch' });
      }

      board.taskPlan.phase = 'executing';
      readyTasks.forEach(t => {
        if (t.status === 'pending') {
          t.status = 'dispatched';
          t.history = t.history || [];
          t.history.push({ ts: nowIso(), status: 'dispatched', by: 'bulk_dispatch' });
        }
      });

      const conv = board.conversations?.[0];
      const sessionId = conv?.sessionIds?.['main'] || null;

      // Build dispatch instruction for Nox
      let msg = `【任務派發指令】\n`;
      msg += `目標：${board.taskPlan?.goal}\n\n`;
      msg += `以下任務已 ready，請使用 sessions_spawn 派發給對應的 Engineer：\n\n`;
      readyTasks.forEach(t => {
        const preferredModel = mgmt.preferredModelFor(t.assignee);
        msg += `- **${t.id}**: ${t.title}\n  Assignee: ${t.assignee}\n`;
        if (preferredModel) msg += `  sessions_spawn model: ${preferredModel}（必填）\n`;
        if (t.description) msg += `  說明: ${t.description}\n`;
        if (t.depends?.length) msg += `  依賴: ${t.depends.join(', ')}（已 approved）\n`;
        msg += `\n`;
      });
      msg += `\n【重要：模型】\n`;
      msg += `sessions_spawn 請務必帶 --model（不可省略）。\n`;
      msg += `\n【重要：狀態回寫】\n`;
      msg += `派發完每個任務後，請用 HTTP API 更新黑板狀態：\n`;
      msg += `- 開始執行：POST http://localhost:${ctx.port}/api/tasks/{taskId}/status  body: {"status":"in_progress"}\n`;
      msg += `- 完成：POST http://localhost:${ctx.port}/api/tasks/{taskId}/status  body: {"status":"completed"}\n`;
      msg += `- 卡住：POST http://localhost:${ctx.port}/api/tasks/{taskId}/status  body: {"status":"blocked","reason":"原因"}\n`;
      msg += `\n用 exec 工具執行 curl 或 Invoke-WebRequest 來打這些 API。黑板 UI 會即時更新。`;
      if (process.env.KARVI_API_TOKEN) {
        msg += `\n\n【重要：認證】\n`;
        msg += `所有 /api/* 請求都需要帶 header：Authorization: Bearer $KARVI_API_TOKEN\n`;
        msg += `（token 從環境變數 KARVI_API_TOKEN 取得，已注入到你的執行環境中）\n`;
      }

      if (conv) {
        pushMessage(conv, {
          id: uid('msg'),
          ts: nowIso(),
          type: 'system',
          from: 'human',
          to: 'main',
          text: msg,
        });
      }
      writeBoard(board);

      // Send to Nox
      runtime.runOpenclawTurn({
        agentId: 'main',
        sessionId,
        message: msg,
        timeoutSec: 600,
      }).then(result => {
        const replyText = runtime.extractReplyText(result.parsed, result.stdout);
        const newSessionId = runtime.extractSessionId(result.parsed);
        const latestBoard = readBoard();
        const latestConv = latestBoard.conversations?.[0];

        if (latestConv) {
          if (newSessionId) latestConv.sessionIds['main'] = newSessionId;
          pushMessage(latestConv, {
            id: uid('msg'),
            ts: nowIso(),
            type: 'message',
            from: 'main',
            to: 'human',
            text: replyText,
            sessionId: newSessionId || sessionId,
          });
          writeBoard(latestBoard);
        }

        appendLog({ ts: nowIso(), event: 'bulk_dispatch_nox_reply', reply: replyText.slice(0, 500) });
      }).catch(err => {
        const latestBoard = readBoard();
        const latestConv = latestBoard.conversations?.[0];
        if (latestConv) {
          pushMessage(latestConv, {
            id: uid('msg'),
            ts: nowIso(),
            type: 'error',
            from: 'system',
            to: 'human',
            text: `Dispatch 失敗: ${err.message}`,
          });
          writeBoard(latestBoard);
        }
        console.error(`[dispatch error] ${err.message}`);
      });

      json(res, 200, { ok: true, dispatched: readyTasks.length, taskIds: readyTasks.map(t => t.id) });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- S8: Scoped Board (Brief) API ---

  const briefGetMatch = req.url.match(/^\/api\/brief\/([\w-]+)$/);
  if (req.method === 'GET' && briefGetMatch) {
    const taskId = decodeURIComponent(briefGetMatch[1]);
    const data = readBrief(taskId);
    if (!data) return json(res, 404, { error: 'no brief for this task' });
    return json(res, 200, data);
  }

  if (req.method === 'PATCH' && briefGetMatch) {
    const taskId = decodeURIComponent(briefGetMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const existing = readBrief(taskId);
        if (!existing) return json(res, 404, { error: 'no brief for this task' });
        const merged = deepMerge(existing, patch);
        writeBrief(taskId, merged);
        return json(res, 200, { ok: true, taskId });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'PUT' && briefGetMatch) {
    const taskId = decodeURIComponent(briefGetMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (!writeBrief(taskId, data)) return json(res, 404, { error: 'no brief for this task' });
        return json(res, 200, { ok: true, taskId });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    });
    return;
  }

  // /brief/:taskId → serve brief-panel UI
  const briefUiMatch = req.url.match(/^\/brief\/([\w-]+)$/);
  if (req.method === 'GET' && briefUiMatch) {
    const briefPanelHtml = path.resolve(DIR, '..', '..', '..', 'skills',
      'conversapix-storyboard', 'tools', 'brief-panel', 'index.html');
    if (fs.existsSync(briefPanelHtml)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(briefPanelHtml, 'utf8'));
    }
    return json(res, 404, { error: 'brief-panel not installed' });
  }

  // --- S6: High-Level Atomic APIs ---

  if (req.method === 'POST' && req.url === '/api/dispatch-next') {
    try {
      const board = readBoard();
      const task = mgmt.pickNextTask(board);

      if (!task) {
        writeBoard(board); // autoUnlockDependents may have changed board
        broadcastSSE('board', board);
        return json(res, 200, { ok: true, dispatched: false, reason: 'no ready tasks' });
      }

      const assignee = participantById(board, task.assignee);
      const sessionId = board.conversations?.[0]?.sessionIds?.[task.assignee] || null;
      const plan = mgmt.buildDispatchPlan(board, task, { mode: 'dispatch' });
      plan.sessionId = plan.sessionId || sessionId;

      // Update task status
      task.status = 'in_progress';
      task.startedAt = task.startedAt || nowIso();
      task.history = task.history || [];
      task.history.push({ ts: nowIso(), status: 'in_progress', by: 'dispatch-next', model: plan.modelHint || undefined });
      task.lastDispatchModel = plan.modelHint || null;
      if (board.taskPlan) board.taskPlan.phase = 'executing';

      // Write dispatch state
      task.dispatch = {
        version: mgmt.DISPATCH_PLAN_VERSION,
        state: 'dispatching',
        planId: plan.planId,
        runtime: plan.runtimeHint,
        agentId: plan.agentId,
        model: plan.modelHint || null,
        timeoutSec: plan.timeoutSec,
        preparedAt: plan.createdAt,
        startedAt: nowIso(),
        finishedAt: null,
        sessionId: plan.sessionId || null,
        lastError: null,
      };

      writeBoard(board);
      broadcastSSE('board', board);

      // Async execution (runtime-neutral)
      const rt3 = getRuntime(plan.runtimeHint);
      rt3.dispatch(plan).then(result => {
        const replyText = rt3.extractReplyText(result.parsed, result.stdout);
        const newSessionId = rt3.extractSessionId(result.parsed);
        const latestBoard = readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
        const latestConv = latestBoard.conversations?.[0];

        if (latestTask) {
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'completed';
          latestTask.dispatch.finishedAt = nowIso();
          latestTask.dispatch.sessionId = newSessionId || latestTask.dispatch.sessionId || null;
          latestTask.dispatch.lastError = null;
          latestTask.lastReply = replyText;
          latestTask.lastReplyAt = nowIso();
        }
        if (latestConv && newSessionId) {
          latestConv.sessionIds = latestConv.sessionIds || {};
          latestConv.sessionIds[task.assignee] = newSessionId;
        }
        writeBoard(latestBoard);
        broadcastSSE('board', latestBoard);
        appendLog({ ts: nowIso(), event: 'dispatch_next_reply', taskId: task.id, agent: task.assignee, reply: replyText.slice(0, 500) });
      }).catch(err => {
        const latestBoard = readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
        if (latestTask) {
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'failed';
          latestTask.dispatch.finishedAt = nowIso();
          latestTask.dispatch.lastError = err.message;
        }
        writeBoard(latestBoard);
        broadcastSSE('board', latestBoard);
        console.error(`[dispatch-next error] ${task.id}: ${err.message}`);
      });

      return json(res, 202, { ok: true, dispatched: true, taskId: task.id, planId: plan.planId });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/retro') {
    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync('node', [path.join(DIR, 'retro.js')], {
        cwd: DIR, encoding: 'utf8', timeout: 30000,
      });

      const board = readBoard();
      broadcastSSE('board', board);

      if (result.status === 0) {
        json(res, 200, { ok: true, output: (result.stdout || '').trim().slice(-500) });
      } else {
        json(res, 500, { ok: false, error: (result.stderr || '').slice(0, 500) || 'retro.js failed' });
      }
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/project') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const title = String(payload.title || '').trim();
        if (!title) return json(res, 400, { error: 'title is required' });

        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        if (tasks.length === 0) return json(res, 400, { error: 'tasks array is required and must not be empty' });

        // Validate task structure
        const ids = new Set();
        for (const t of tasks) {
          if (!t.id || !t.title) return json(res, 400, { error: `task missing id or title: ${JSON.stringify(t)}` });
          if (ids.has(t.id)) return json(res, 400, { error: `duplicate task id: ${t.id}` });
          ids.add(t.id);
        }

        // Validate dependencies
        for (const t of tasks) {
          for (const dep of (t.depends || [])) {
            if (!ids.has(dep)) return json(res, 400, { error: `task ${t.id} depends on unknown task ${dep}` });
          }
        }

        // Write to board
        const board = readBoard();
        board.taskPlan = {
          title,
          createdAt: nowIso(),
          phase: 'planning',
          spec: payload.spec || null,
          goal: payload.goal || title,
          tasks: tasks.map(t => ({
            id: t.id,
            title: t.title,
            assignee: t.assignee || null,
            status: (t.depends?.length > 0) ? 'pending' : 'dispatched',
            depends: t.depends || [],
            description: t.description || '',
            spec: t.spec || null,
            skill: t.skill || null,
            estimate: t.estimate || null,
            history: [{ ts: nowIso(), status: 'created', by: 'api' }],
          })),
        };

        // S8: Auto-create scoped boards (briefs) for tasks with matching skills
        for (const t of board.taskPlan.tasks) {
          if (t.skill && SKILLS_NEEDING_BRIEF.has(t.skill)) {
            ensureBriefsDir();
            const briefPath = `briefs/${t.id}.json`;
            t.briefPath = briefPath;
            const emptyBrief = {
              meta: { boardType: 'brief', version: 1, taskId: t.id },
              project: { name: title },
              shotspec: { status: 'pending', shots: [] },
              refpack: { status: 'empty', assets: {} },
              controls: { auto_retry: true, max_retries: 3, quality_threshold: 85, paused: false },
              log: [{ time: nowIso(), agent: 'system', action: 'brief_created', detail: `auto-created for ${t.id}` }],
            };
            fs.writeFileSync(path.resolve(DIR, briefPath), JSON.stringify(emptyBrief, null, 2));
          }
        }

        // Clear old evolution data (new project)
        board.signals = [];
        board.insights = [];
        board.lessons = [];

        writeBoard(board);
        appendLog({ ts: nowIso(), event: 'project_created', title, taskCount: tasks.length });
        broadcastSSE('board', board);

        const result = { ok: true, title, taskCount: tasks.length };

        // autoStart: dispatch first ready task
        if (payload.autoStart) {
          const nextTask = mgmt.pickNextTask(board);
          if (nextTask) {
            const plan = mgmt.buildDispatchPlan(board, nextTask, { mode: 'dispatch' });
            const sid = board.conversations?.[0]?.sessionIds?.[nextTask.assignee] || null;
            plan.sessionId = plan.sessionId || sid;

            nextTask.status = 'in_progress';
            nextTask.startedAt = nowIso();
            nextTask.history = nextTask.history || [];
            nextTask.history.push({ ts: nowIso(), status: 'in_progress', by: 'project-autostart' });

            nextTask.dispatch = {
              version: mgmt.DISPATCH_PLAN_VERSION,
              state: 'dispatching',
              planId: plan.planId,
              runtime: plan.runtimeHint,
              agentId: plan.agentId,
              model: plan.modelHint || null,
              timeoutSec: plan.timeoutSec,
              preparedAt: plan.createdAt,
              startedAt: nowIso(),
              finishedAt: null, sessionId: null, lastError: null,
            };
            writeBoard(board);

            const rt4 = getRuntime(plan.runtimeHint);
            rt4.dispatch(plan).then(r => {
              const lb = readBoard();
              const lt = (lb.taskPlan?.tasks || []).find(t => t.id === nextTask.id);
              if (lt) {
                lt.dispatch = lt.dispatch || {};
                lt.dispatch.state = 'completed';
                lt.dispatch.finishedAt = nowIso();
                lt.dispatch.sessionId = rt4.extractSessionId(r.parsed) || null;
                lt.lastReply = rt4.extractReplyText(r.parsed, r.stdout);
                lt.lastReplyAt = nowIso();
              }
              writeBoard(lb);
              broadcastSSE('board', lb);
            }).catch(err => {
              const lb = readBoard();
              const lt = (lb.taskPlan?.tasks || []).find(t => t.id === nextTask.id);
              if (lt) {
                lt.dispatch = lt.dispatch || {};
                lt.dispatch.state = 'failed';
                lt.dispatch.finishedAt = nowIso();
                lt.dispatch.lastError = err.message;
              }
              writeBoard(lb);
            });

            result.autoStarted = nextTask.id;
            result.planId = plan.planId;
          }
        }

        json(res, 201, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Evolution Layer API: Signals ---

  if (req.method === 'GET' && (req.url === '/api/signals' || req.url.startsWith('/api/signals?'))) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const typeFilter = parsedUrl.searchParams.get('type');
      const limit = Math.min(500, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
      const board = readBoard();
      mgmt.ensureEvolutionFields(board);
      let signals = [...board.signals].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      if (typeFilter) signals = signals.filter(s => s.type === typeFilter);
      signals = signals.slice(0, limit);
      return json(res, 200, signals);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/signals') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const by = String(payload.by || '').trim();
        const type = String(payload.type || '').trim();
        const content = String(payload.content || '').trim();
        if (!by || !type || !content) {
          return json(res, 400, { error: 'by, type, content are required' });
        }
        const board = readBoard();
        mgmt.ensureEvolutionFields(board);
        const signal = {
          id: uid('sig'),
          ts: nowIso(),
          by,
          type,
          content,
        };
        if (payload.refs) signal.refs = payload.refs;
        if (payload.data) signal.data = payload.data;
        board.signals.push(signal);
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);

        // Evolution Layer: trigger verification and auto-apply on review signals
        if (type === 'review_result') {
          mgmt.verifyAppliedInsights(board);
        }
        mgmt.autoApplyInsights(board);

        writeBoard(board);
        json(res, 201, { ok: true, signal });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Evolution Layer API: Insights ---

  if (req.method === 'GET' && (req.url === '/api/insights' || req.url.startsWith('/api/insights?'))) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const statusFilter = parsedUrl.searchParams.get('status');
      const limit = Math.min(500, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
      const board = readBoard();
      mgmt.ensureEvolutionFields(board);
      let insights = [...board.insights].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      if (statusFilter) insights = insights.filter(i => i.status === statusFilter);
      insights = insights.slice(0, limit);
      return json(res, 200, insights);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/insights') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const by = String(payload.by || '').trim();
        const judgement = String(payload.judgement || '').trim();
        const risk = String(payload.risk || '').trim();
        if (!by || !judgement) {
          return json(res, 400, { error: 'by, judgement are required' });
        }
        if (!mgmt.VALID_RISK_LEVELS.includes(risk)) {
          return json(res, 400, { error: 'risk must be low, medium, or high' });
        }
        const sa = payload.suggestedAction;
        if (!sa || !mgmt.VALID_ACTION_TYPES.includes(sa.type)) {
          return json(res, 400, { error: 'suggestedAction.type must be controls_patch, dispatch_hint, lesson_write, or noop' });
        }
        const board = readBoard();
        mgmt.ensureEvolutionFields(board);
        const insight = {
          id: uid('ins'),
          ts: nowIso(),
          by,
          about: payload.about || null,
          judgement,
          reasoning: payload.reasoning || null,
          suggestedAction: sa,
          risk,
          status: 'pending',
          snapshot: null,
          appliedAt: null,
          verifyAfter: payload.verifyAfter || 3,
        };
        if (payload.data && typeof payload.data === 'object') insight.data = payload.data;
        board.insights.push(insight);
        mgmt.autoApplyInsights(board);
        writeBoard(board);
        json(res, 201, { ok: true, insight });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const insightApplyMatch = req.url.match(/^\/api\/insights\/([^/]+)\/apply$/);
  if (req.method === 'POST' && insightApplyMatch) {
    const insightId = decodeURIComponent(insightApplyMatch[1]);
    try {
      const board = readBoard();
      mgmt.ensureEvolutionFields(board);
      const insight = board.insights.find(i => i.id === insightId);
      if (!insight) return json(res, 404, { error: `Insight ${insightId} not found` });
      if (insight.status !== 'pending') {
        return json(res, 400, { error: `Insight status must be pending (current: ${insight.status})` });
      }

      const sa = insight.suggestedAction || {};

      // Snapshot controls before apply (for potential rollback)
      if (sa.type === 'controls_patch' && sa.payload) {
        insight.snapshot = mgmt.snapshotControls(mgmt.getControls(board), sa.payload);
      }

      mgmt.applyInsightAction(board, insight);
      insight.status = 'applied';
      insight.appliedAt = nowIso();

      // Write signal for the apply
      board.signals.push({
        id: uid('sig'),
        ts: nowIso(),
        by: 'gate',
        type: 'insight_applied',
        content: `Applied insight ${insight.id}: ${insight.judgement}`,
        refs: [insight.id],
        data: { insightId: insight.id, actionType: sa.type, snapshot: insight.snapshot || null },
      });
      if (board.signals.length > 500) board.signals = board.signals.slice(-500);

      writeBoard(board);
      json(res, 200, { ok: true, applied: sa });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- Evolution Layer API: Lessons ---

  if (req.method === 'GET' && (req.url === '/api/lessons' || req.url.startsWith('/api/lessons?'))) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const statusFilter = parsedUrl.searchParams.get('status');
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
      const board = readBoard();
      mgmt.ensureEvolutionFields(board);
      let lessons = [...board.lessons].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      if (statusFilter) lessons = lessons.filter(l => l.status === statusFilter);
      lessons = lessons.slice(0, limit);
      return json(res, 200, lessons);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/lessons') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const by = String(payload.by || '').trim();
        const rule = String(payload.rule || '').trim();
        if (!by || !rule) {
          return json(res, 400, { error: 'by, rule are required' });
        }
        const board = readBoard();
        mgmt.ensureEvolutionFields(board);
        const lesson = {
          id: uid('les'),
          ts: nowIso(),
          by,
          fromInsight: payload.fromInsight || null,
          rule,
          effect: payload.effect || null,
          status: payload.status || 'active',
          validatedAt: null,
          supersededBy: null,
        };
        board.lessons.push(lesson);
        // Archive overflow: if > 100, move invalidated/superseded to archive
        if (board.lessons.length > 100) {
          const archived = board.lessons.filter(l => l.status === 'invalidated' || l.status === 'superseded');
          if (archived.length > 0) {
            board.lessons_archive = board.lessons_archive || [];
            board.lessons_archive.push(...archived);
            board.lessons = board.lessons.filter(l => l.status !== 'invalidated' && l.status !== 'superseded');
          }
        }
        writeBoard(board);
        json(res, 201, { ok: true, lesson });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const lessonStatusMatch = req.url.match(/^\/api\/lessons\/([^/]+)\/status$/);
  if (req.method === 'POST' && lessonStatusMatch) {
    const lessonId = decodeURIComponent(lessonStatusMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const newStatus = String(payload.status || '').trim();
        if (!mgmt.VALID_LESSON_STATUSES.includes(newStatus)) {
          return json(res, 400, { error: 'status must be active, validated, invalidated, or superseded' });
        }
        const board = readBoard();
        mgmt.ensureEvolutionFields(board);
        const lesson = board.lessons.find(l => l.id === lessonId);
        if (!lesson) return json(res, 404, { error: `Lesson ${lessonId} not found` });
        lesson.status = newStatus;
        if (newStatus === 'validated') lesson.validatedAt = nowIso();
        if (newStatus === 'superseded' && payload.supersededBy) {
          lesson.supersededBy = payload.supersededBy;
        }
        writeBoard(board);
        json(res, 200, { ok: true, lesson });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Jira Integration Routes ---

  // POST /api/webhooks/jira — receive Jira webhook
  if (req.method === 'POST' && req.url.startsWith('/api/webhooks/jira')) {
    if (!jiraIntegration) { json(res, 404, { error: 'Jira integration not available' }); return; }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const board = readBoard();
        const result = jiraIntegration.handleWebhook(board, payload, req.url);

        if (result.action === 'rejected') {
          json(res, 401, { error: result.error });
          return;
        }
        if (result.action === 'skipped') {
          json(res, 200, { ok: true, skipped: true, reason: result.error });
          return;
        }

        // --- Handle create_task: append new task from Jira issue_created ---
        if (result.action === 'create_task' && result.task) {
          board.taskPlan = board.taskPlan || { tasks: [] };
          board.taskPlan.tasks = board.taskPlan.tasks || [];
          board.taskPlan.tasks.push(result.task);
          writeBoard(board);
          appendLog({ ts: nowIso(), event: 'jira_task_created', taskId: result.task.id, jiraKey: result.issueKey, source: 'jira-webhook' });

          // Optional auto-dispatch via internal HTTP loopback (when config flag is set)
          const jiraConfig = board.integrations?.jira || {};
          if (jiraConfig.autoDispatchOnCreate) {
            const taskId = result.task.id;
            setImmediate(() => {
              const http = require('http');
              const authToken = process.env.KARVI_API_TOKEN;
              const headers = {};
              if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
              const dreq = http.request({
                hostname: 'localhost',
                port: ctx.port,
                path: `/api/tasks/${encodeURIComponent(taskId)}/dispatch`,
                method: 'POST',
                headers,
              });
              dreq.on('error', err => console.error(`[jira-webhook] auto-dispatch failed for ${taskId}:`, err.message));
              dreq.end();
            });
          }

          json(res, 201, { ok: true, action: 'create_task', taskId: result.task.id, jiraKey: result.issueKey });
          return;
        }

        if (result.action === 'dispatch' && result.task) {
          result.task.status = 'dispatched';
          result.task.history = result.task.history || [];
          result.task.history.push({ ts: nowIso(), status: 'dispatched', by: 'jira-webhook' });
          writeBoard(board);

          // Auto-trigger dispatch via internal HTTP call to reuse existing dispatch logic
          const taskId = result.task.id;
          setImmediate(() => {
            const http = require('http');
            const authToken = process.env.KARVI_API_TOKEN;
            const headers = {};
            if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
            const dreq = http.request({
              hostname: 'localhost',
              port: ctx.port,
              path: `/api/tasks/${encodeURIComponent(taskId)}/dispatch`,
              method: 'POST',
              headers,
            });
            dreq.on('error', err => console.error(`[jira-webhook] auto-dispatch failed for ${taskId}:`, err.message));
            dreq.end();
          });

          json(res, 200, { ok: true, action: 'dispatch', taskId: result.task.id });
          return;
        }
        if (result.action === 'status_change' && result.task && result.karviStatus) {
          const oldStatus = result.task.status;
          try {
            mgmt.ensureTaskTransition(oldStatus, result.karviStatus);
          } catch (err) {
            json(res, 409, { error: err.message });
            return;
          }
          result.task.status = result.karviStatus;
          result.task.history = result.task.history || [];
          result.task.history.push({ ts: nowIso(), status: result.karviStatus, by: 'jira-webhook', from: oldStatus });
          writeBoard(board);
          json(res, 200, { ok: true, action: 'status_change', taskId: result.task.id, newStatus: result.karviStatus });
          return;
        }
        json(res, 200, { ok: true, action: result.action });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/integrations/jira — read Jira config
  if (req.method === 'GET' && req.url === '/api/integrations/jira') {
    const board = readBoard();
    const config = board.integrations?.jira || { enabled: false };
    json(res, 200, config);
    return;
  }

  // POST /api/integrations/jira — update Jira config
  if (req.method === 'POST' && req.url === '/api/integrations/jira') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const board = readBoard();
        board.integrations = board.integrations || {};
        board.integrations.jira = { ...(board.integrations.jira || {}), ...payload };
        writeBoard(board);
        json(res, 200, board.integrations.jira);
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  // POST /api/integrations/jira/test — test Jira connection
  if (req.method === 'POST' && req.url === '/api/integrations/jira/test') {
    if (!jiraIntegration) { json(res, 404, { error: 'Jira integration not available' }); return; }
    jiraIntegration.testConnection().then(result => {
      json(res, result.ok ? 200 : 502, result);
    }).catch(err => {
      json(res, 500, { ok: false, error: err.message });
    });
    return;
  }

  // POST /api/shutdown — graceful shutdown (critical for Windows where SIGTERM kills immediately)
  if (req.method === 'POST' && req.url === '/api/shutdown') {
    json(res, 200, { ok: true, message: 'shutting down' });
    setImmediate(gracefulShutdown);
    return;
  }

  return false; // fall through to bb static file serving
});

// --- Ensure board.json exists (support fresh clone) ---
bb.ensureBoardExists(ctx, {
  taskPlan: { goal: '', phase: 'idle', tasks: [] },
  conversations: [],
  participants: [],
  signals: [],
  insights: [],
  lessons: [],
  controls: {
    auto_review: true,
    auto_redispatch: false,
    max_review_attempts: 3,
    quality_threshold: 70,
    review_timeout_sec: 180,
    review_agent: 'engineer_lite',
    auto_apply_insights: true,
  },
});

// --- Evolution Layer: Ensure board has evolution fields on startup ---
const initBoard = readBoard();
let dirty = false;
if (!Array.isArray(initBoard.signals)) { initBoard.signals = []; dirty = true; }
if (!Array.isArray(initBoard.insights)) { initBoard.insights = []; dirty = true; }
if (!Array.isArray(initBoard.lessons)) { initBoard.lessons = []; dirty = true; }
if (dirty) writeBoard(initBoard);

// --- Telemetry init ---
let telemetryHandle;
try {
  telemetryHandle = telemetry.init({
    dataDir: DATA_DIR,
    readBoard,
  });
} catch (err) {
  console.warn(`[telemetry] init failed, continuing without telemetry: ${err.message}`);
}

// --- Graceful Shutdown ---
function gracefulShutdown() {
  console.log('[server] shutting down...');
  telemetryHandle?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

bb.listen(server, ctx);
