/**
 * routes/tasks.js — Task Engine APIs
 *
 * POST /api/tasks/:id/review — manual review trigger
 * GET  /api/tasks — task list
 * GET  /api/spec/:file — serve spec files
 * POST /api/tasks — create task plan
 * POST /api/tasks/:id/update — update task fields
 * POST /api/tasks/:id/unblock — unblock task
 * POST /api/tasks/:id/status — manual status control
 * POST /api/tasks/:id/dispatch — per-task dispatch
 * POST /api/tasks/dispatch — bulk dispatch
 * GET/POST /api/tasks/:id/digest — L2 digest
 * POST /api/dispatch-next — S6 atomic dispatch-next
 * POST /api/retro — trigger retro
 * POST /api/project — create project
 *
 * Also contains: redispatchTask, tryAutoDispatch, logDispatchPreflight, tryEddaSync
 */
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const { json } = bb;
const { participantById, pushMessage, getUserIdForTask } = require('./_shared');

// --- Preflight logging: lessons injection + runtime selection ---
function logDispatchPreflight(plan, task, deps, helpers) {
  if (plan.injectedLessons?.length > 0) {
    helpers.appendLog({
      ts: helpers.nowIso(),
      event: 'lessons_injected',
      taskId: task.id,
      assignee: task.assignee,
      lessonIds: plan.injectedLessons,
      count: plan.injectedLessonCount,
    });
  }
  helpers.appendLog({
    ts: helpers.nowIso(),
    event: 'runtime_selected',
    taskId: task.id,
    runtime: plan.runtimeHint,
    rationale: plan.runtimeSelection?.rationale || 'default',
    available: Object.keys(deps.RUNTIMES),
  });
  tryEddaSync(plan);
}

function tryEddaSync(plan) {
  const eddaCmd = process.env.EDDA_CMD;
  if (!eddaCmd) return;

  const { spawn } = require('child_process');
  const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : eddaCmd;

  try {
    const decideArgs = ['decide',
      'dispatch.' + plan.taskId + '.runtime=' + plan.runtimeHint,
      '--reason', plan.runtimeSelection?.rationale || 'default'];
    const spawnDecideArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', eddaCmd, ...decideArgs]
      : decideArgs;
    const p1 = spawn(spawnCmd, spawnDecideArgs, {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    p1.unref();

    if (plan.injectedLessons?.length > 0) {
      const noteArgs = ['note',
        'dispatch ' + plan.taskId + ' with lessons: ' + plan.injectedLessons.join(', '),
        '--tag', 'dispatch'];
      const spawnNoteArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', eddaCmd, ...noteArgs]
        : noteArgs;
      const p2 = spawn(spawnCmd, spawnNoteArgs, {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      p2.unref();
    }
  } catch (err) {
    console.error('[edda-sync] fire-and-forget error:', err.message);
  }
}

// --- Auto Re-dispatch: send fix instructions back to engineer ---
function redispatchTask(board, task, deps, helpers) {
  const { mgmt, push, usage, PUSH_TOKENS_PATH } = deps;
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
  logDispatchPreflight(plan, task, deps, helpers);

  const preferredModel = plan.modelHint;

  task.status = 'in_progress';
  task.history = task.history || [];
  task.history.push({ ts: helpers.nowIso(), status: 'in_progress', by: 'auto-redispatch', attempt: task.reviewAttempts, model: preferredModel || undefined, runtime: plan.runtimeHint, runtimeRationale: plan.runtimeSelection?.rationale, injectedLessons: plan.injectedLessonCount || 0 });
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
      id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'system', from: 'system', to: task.assignee,
      text: `[Auto Re-dispatch ${task.id}] 第 ${task.reviewAttempts} 次修正指令已發送 → ${assignee.displayName}${preferredModel ? `\nmodel: ${preferredModel}` : ''}`,
    });
  }
  helpers.writeBoard(board);

  helpers.appendLog({ ts: helpers.nowIso(), event: 'auto_redispatch', taskId: task.id, assignee: task.assignee, attempt: task.reviewAttempts, model: preferredModel || null });

  // S5: Mark dispatching
  task.dispatch.state = 'dispatching';
  task.dispatch.startedAt = helpers.nowIso();
  helpers.writeBoard(board);

  // Dispatch via plan (runtime-neutral)
  const rt = deps.getRuntime(plan.runtimeHint);
  rt.dispatch(plan).then(result => {
    const replyText = rt.extractReplyText(result.parsed, result.stdout);
    const newSessionId = rt.extractSessionId(result.parsed);
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
    const latestConv = latestBoard.conversations?.[0];

    if (latestConv) {
      if (newSessionId) latestConv.sessionIds[task.assignee] = newSessionId;
      pushMessage(latestConv, {
        id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'message', from: task.assignee, to: 'human',
        text: `[${task.id} Fix Reply]\n${replyText}`,
        sessionId: newSessionId || sessionId,
      });
    }

    if (latestTask && latestTask.status === 'in_progress') {
      latestTask.lastReply = replyText;
      latestTask.lastReplyAt = helpers.nowIso();
    }

    // S5: Mark dispatch completed
    if (latestTask) {
      latestTask.dispatch = latestTask.dispatch || {};
      latestTask.dispatch.state = 'completed';
      latestTask.dispatch.finishedAt = helpers.nowIso();
      latestTask.dispatch.sessionId = newSessionId || latestTask.dispatch.sessionId || null;
      latestTask.dispatch.lastError = null;
      if (result.usage) latestTask.dispatch.usage = result.usage;
    }

    helpers.writeBoard(latestBoard);
    helpers.appendLog({ ts: helpers.nowIso(), event: 'auto_redispatch_reply', taskId: task.id, reply: replyText.slice(0, 500) });
    if (result.usage) helpers.appendLog({ ts: helpers.nowIso(), event: 'token_usage', taskId: task.id, usage: result.usage });

    // --- Usage tracking: auto re-dispatch (Path C) ---
    const redispatchUserId = getUserIdForTask();
    const redispatchDuration = latestTask?.dispatch?.startedAt
      ? Math.round((Date.now() - new Date(latestTask.dispatch.startedAt).getTime()) / 1000)
      : 0;
    usage.record(redispatchUserId, 'dispatch', {
      taskId: task.id,
      runtime: plan.runtimeHint,
      assignee: task.assignee,
    });
    usage.record(redispatchUserId, 'agent.runtime', {
      taskId: task.id,
      durationSec: redispatchDuration,
      runtime: plan.runtimeHint,
    });
    const redispatchTokenUsage = rt.extractUsage?.(result.parsed, result.stdout);
    if (redispatchTokenUsage) {
      usage.record(redispatchUserId, 'api.tokens', {
        taskId: task.id,
        input: redispatchTokenUsage.inputTokens,
        output: redispatchTokenUsage.outputTokens,
        cost: redispatchTokenUsage.totalCost,
      });
    }
  }).catch(err => {
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
    const latestConv = latestBoard.conversations?.[0];
    if (latestTask) {
      latestTask.status = 'blocked';
      latestTask.blocker = { reason: `Re-dispatch failed: ${err.message}`, askedAt: helpers.nowIso() };
      latestTask.history = latestTask.history || [];
      latestTask.history.push({ ts: helpers.nowIso(), status: 'blocked', reason: err.message, by: 'auto-redispatch-error' });

      // S5: Mark dispatch failed
      latestTask.dispatch = latestTask.dispatch || {};
      latestTask.dispatch.state = 'failed';
      latestTask.dispatch.finishedAt = helpers.nowIso();
      latestTask.dispatch.lastError = err.message || String(err);
    }
    if (latestConv) {
      pushMessage(latestConv, {
        id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'error', from: 'system', to: 'human',
        text: `[${task.id}] Auto re-dispatch failed: ${err.message}`,
      });
    }
    // Evolution Layer: emit error signal for redispatch failure
    mgmt.ensureEvolutionFields(latestBoard);
    latestBoard.signals.push({
      id: helpers.uid('sig'),
      ts: helpers.nowIso(),
      by: 'server.js',
      type: 'error',
      content: `${task.id} redispatch failed: ${err.message}`,
      refs: [task.id],
      data: { taskId: task.id, error: err.message },
    });
    if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
    helpers.writeBoard(latestBoard);
    // Push notification: redispatch failed (fire-and-forget)
    if (latestTask) {
      push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'dispatch.failed')
        .catch(err2 => console.error('[push] redispatch-failed notify failed:', err2.message));
    }
    console.error(`[redispatch:${task.id}] error: ${err.message}`);
  });
}

// --- Auto-dispatch: automatically dispatch tasks when auto_dispatch control is enabled ---
function tryAutoDispatch(taskId, deps, helpers) {
  const { mgmt, usage } = deps;
  const board = helpers.readBoard();
  const ctrl = mgmt.getControls(board);
  if (!ctrl.auto_dispatch) return;

  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task) return;
  if (task.status !== 'dispatched') return;
  if (task.dispatch?.state === 'dispatching') return;

  const assignee = participantById(board, task.assignee);
  if (!assignee || assignee.type !== 'agent') {
    console.log(`[auto-dispatch:${taskId}] skip: assignee ${task.assignee} is not an agent`);
    return;
  }

  // Check dependencies
  const unmetDeps = (task.depends || []).filter(depId => {
    const dep = (board.taskPlan?.tasks || []).find(t => t.id === depId);
    return !dep || dep.status !== 'approved';
  });
  if (unmetDeps.length > 0) {
    console.log(`[auto-dispatch:${taskId}] skip: unmet deps ${unmetDeps.join(', ')}`);
    return;
  }

  console.log(`[auto-dispatch] dispatching ${taskId} to ${task.assignee}`);

  const sessionId = board.conversations?.[0]?.sessionIds?.[task.assignee] || null;
  const plan = mgmt.buildDispatchPlan(board, task, { mode: 'dispatch' });
  plan.sessionId = plan.sessionId || sessionId;
  logDispatchPreflight(plan, task, deps, helpers);

  // Transition dispatched -> in_progress
  task.status = 'in_progress';
  task.startedAt = task.startedAt || helpers.nowIso();
  task.history = task.history || [];
  task.history.push({
    ts: helpers.nowIso(),
    status: 'in_progress',
    by: 'auto-dispatch',
    model: plan.modelHint || undefined,
    runtime: plan.runtimeHint,
    runtimeRationale: plan.runtimeSelection?.rationale,
    injectedLessons: plan.injectedLessonCount || 0,
  });
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
    startedAt: helpers.nowIso(),
    finishedAt: null,
    sessionId: plan.sessionId || null,
    lastError: null,
  };

  helpers.writeBoard(board);
  helpers.appendLog({
    ts: helpers.nowIso(),
    event: 'task_auto_dispatched',
    taskId,
    assignee: task.assignee,
    source: 'auto',
    planId: plan.planId,
  });

  // Async runtime execution
  const rt = deps.getRuntime(plan.runtimeHint);
  rt.dispatch(plan).then(result => {
    const replyText = rt.extractReplyText(result.parsed, result.stdout);
    const newSessionId = rt.extractSessionId(result.parsed);
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);

    if (latestTask) {
      latestTask.dispatch = latestTask.dispatch || {};
      latestTask.dispatch.state = 'completed';
      latestTask.dispatch.finishedAt = helpers.nowIso();
      latestTask.dispatch.sessionId = newSessionId || latestTask.dispatch.sessionId || null;
      latestTask.dispatch.lastError = null;
      latestTask.lastReply = replyText;
      latestTask.lastReplyAt = helpers.nowIso();
      if (result.usage) latestTask.dispatch.usage = result.usage;
    }

    const latestConv = latestBoard.conversations?.[0];
    if (latestConv) {
      if (newSessionId) {
        latestConv.sessionIds = latestConv.sessionIds || {};
        latestConv.sessionIds[task.assignee] = newSessionId;
      }
      pushMessage(latestConv, {
        id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'message',
        from: task.assignee, to: 'human',
        text: `[Auto-dispatch ${taskId} Reply]\n${replyText}`,
        sessionId: newSessionId || sessionId,
      });
    }

    helpers.writeBoard(latestBoard);
    helpers.broadcastSSE('board', latestBoard);
    helpers.appendLog({
      ts: helpers.nowIso(),
      event: 'auto_dispatch_reply',
      taskId,
      agent: task.assignee,
      source: 'auto',
      reply: replyText.slice(0, 500),
    });
    if (result.usage) helpers.appendLog({ ts: helpers.nowIso(), event: 'token_usage', taskId, usage: result.usage });
  }).catch(err => {
    console.error(`[auto-dispatch:${taskId}] error: ${err.message}`);
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (latestTask) {
      latestTask.dispatch = latestTask.dispatch || {};
      latestTask.dispatch.state = 'failed';
      latestTask.dispatch.finishedAt = helpers.nowIso();
      latestTask.dispatch.lastError = err.message;
      // Don't block -- keep as in_progress so human can retry
    }
    helpers.writeBoard(latestBoard);
    helpers.broadcastSSE('board', latestBoard);
  });
}

// Brief helper functions (used by project creation)
const SKILLS_NEEDING_BRIEF = new Set(['conversapix-storyboard']);

function ensureBriefsDir(DATA_DIR) {
  const BRIEFS_DIR = path.join(DATA_DIR, 'briefs');
  if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });
}

function summarizeBriefAsSignal(taskId, helpers, DIR) {
  const board = helpers.readBoard();
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task?.briefPath) return null;
  const p = path.resolve(DIR, task.briefPath);
  if (!fs.existsSync(p)) return null;
  const brief = JSON.parse(fs.readFileSync(p, 'utf8'));
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

module.exports = function tasksRoutes(req, res, helpers, deps) {
  const { mgmt, runtime, push, usage, ctx, jiraIntegration, digestTask, PUSH_TOKENS_PATH, DIR, DATA_DIR } = deps;

  // --- Manual review trigger ---

  const manualReviewMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/review$/);
  if (req.method === 'POST' && manualReviewMatch) {
    const taskId = decodeURIComponent(manualReviewMatch[1]);
    try {
      const board = helpers.readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
      if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
      if (task.status !== 'completed' && task.status !== 'needs_revision') {
        return json(res, 400, { error: `Task must be completed or needs_revision to review (current: ${task.status})` });
      }
      if (task.status === 'needs_revision') {
        task.status = 'completed';
        task.history = task.history || [];
        task.history.push({ ts: helpers.nowIso(), status: 'completed', by: 'manual-re-review' });
        helpers.writeBoard(board);
      }
      runtime.spawnReview(taskId, {
        boardPath: ctx.boardPath,
        onComplete: (code) => {
          try {
            const updatedBoard = helpers.readBoard();
            helpers.broadcastSSE('board', updatedBoard);
            const ctrl = mgmt.getControls(updatedBoard);
            const t = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
            if (
              ctrl.auto_redispatch &&
              t &&
              t.status === 'needs_revision' &&
              (t.reviewAttempts || 0) < ctrl.max_review_attempts
            ) {
              console.log(`[review:${taskId}] auto-redispatch triggered`);
              setImmediate(() => redispatchTask(updatedBoard, t, deps, helpers));
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
      const board = helpers.readBoard();
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
        const board = helpers.readBoard();

        board.taskPlan = {
          goal: String(payload.goal || ''),
          phase: String(payload.phase || 'idle'),
          createdAt: payload.createdAt || helpers.nowIso(),
          tasks: Array.isArray(payload.tasks) ? payload.tasks : []
        };

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'taskPlan_updated', goal: board.taskPlan.goal });

        // Auto-dispatch any dispatched tasks in the new plan
        const ctrl = mgmt.getControls(board);
        if (ctrl.auto_dispatch) {
          for (const t of (board.taskPlan?.tasks || [])) {
            if (t.status === 'dispatched') {
              setImmediate(() => tryAutoDispatch(t.id, deps, helpers));
            }
          }
        }

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
        const board = helpers.readBoard();
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
          ts: helpers.nowIso(),
          status: task.status,
          update: payload
        });

        const conv = board.conversations?.[0];
        if (conv && payload.status) {
          const prev = String(task.history?.[task.history.length - 2]?.status || 'unknown');
          const next = String(payload.status);
          const note = payload.blocker?.reason || payload.result?.summary || '';
          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] ${prev} → ${next}${note ? `\n${String(note).slice(0, 200)}` : ''}`,
          });
        }

        if (task.status === 'in_progress' && !task.startedAt) task.startedAt = helpers.nowIso();
        if (task.status === 'in_progress') {
          task.reviewAttempts = 0;
        }
        if (task.status === 'completed') {
          task.completedAt = helpers.nowIso();
          delete task.review;
        }

        if (payload.status === 'blocked' && !payload.blocker) {
          task.blocker = { reason: 'Unknown block', askedAt: helpers.nowIso() };
        }

        // Strict gate: only approved can unlock dependents
        if (payload.status === 'approved') {
          const unlocked = mgmt.autoUnlockDependents(board);
          // Auto-dispatch newly unlocked tasks
          for (const id of unlocked) {
            setImmediate(() => tryAutoDispatch(id, deps, helpers));
          }
        }

        // Evolution Layer: emit status_change signal
        if (payload.status) {
          mgmt.ensureEvolutionFields(board);
          board.signals.push({
            id: helpers.uid('sig'),
            ts: helpers.nowIso(),
            by: 'server.js',
            type: 'status_change',
            content: `${task.id} ${oldStatus} → ${task.status}`,
            refs: [task.id],
            data: { taskId: task.id, from: oldStatus, to: task.status, assignee: task.assignee },
          });
          if (board.signals.length > 500) board.signals = board.signals.slice(-500);
        }

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'task_updated', taskId, status: task.status });

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
                const updatedBoard = helpers.readBoard();
                helpers.broadcastSSE('board', updatedBoard);
                const ctrl2 = mgmt.getControls(updatedBoard);
                const t = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
                if (
                  ctrl2.auto_redispatch &&
                  t &&
                  t.status === 'needs_revision' &&
                  (t.reviewAttempts || 0) < ctrl2.max_review_attempts
                ) {
                  console.log(`[review:${taskId}] auto-redispatch triggered`);
                  setImmediate(() => redispatchTask(updatedBoard, t, deps, helpers));
                }
                // L2 Digest: trigger after review completion
                if (digestTask?.isDigestEnabled()) {
                  setImmediate(() => {
                    digestTask.triggerDigest(taskId, 'review_completed', {
                      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
                      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
                    }).catch(err => console.error(`[digest:${taskId}] error:`, err.message));
                  });
                }
              } catch (err) {
                console.error(`[review:${taskId}] post-review error: ${err.message}`);
              }
            },
          }));
        }

        // L2 Digest: trigger after task approved
        if (payload.status === 'approved' && digestTask?.isDigestEnabled()) {
          setImmediate(() => {
            digestTask.triggerDigest(taskId, 'approved', {
              readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
              broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
            }).catch(err => console.error(`[digest:${taskId}] error:`, err.message));
          });
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

        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);

        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        if (task.status !== 'blocked') return json(res, 400, { error: `Task ${taskId} is not blocked` });

        // Prefer childSessionKey if agent created one, otherwise fallback to main room session
        const sessionId = task.childSessionKey || board.conversations?.[0]?.sessionIds?.[task.assignee] || null;

        task.status = 'in_progress';
        task.blocker = null;
        task.history.push({ ts: helpers.nowIso(), status: 'in_progress', unblockedBy: 'human', message });
        helpers.writeBoard(board);

        // Async dispatch unblock instruction to the agent
        if (sessionId) {
          runtime.runOpenclawTurn({
            agentId: task.assignee,
            sessionId,
            message: `【Human 回覆你的 Blocked 問題】：\n${message}\n\n請根據此回覆繼續執行任務。`,
            timeoutSec: 180
          }).then(result => {
            const replyText = runtime.extractReplyText(result.parsed, result.stdout);
            const latestBoard = helpers.readBoard();
            const latestConv = latestBoard.conversations?.[0];
            if (latestConv) {
              pushMessage(latestConv, {
                id: helpers.uid('msg'),
                ts: helpers.nowIso(),
                type: 'message',
                from: task.assignee,
                to: 'human',
                text: `(Unblock Response for ${task.id})\n${replyText}`,
                sessionId
              });
              helpers.writeBoard(latestBoard);
            }
            helpers.appendLog({ ts: helpers.nowIso(), event: 'unblock_reply', taskId, reply: replyText });
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

        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        mgmt.ensureTaskTransition(oldStatus, newStatus);
        task.status = newStatus;
        task.history = task.history || [];
        task.history.push({ ts: helpers.nowIso(), status: newStatus, from: oldStatus, by: 'human' });

        const conv = board.conversations?.[0];
        if (conv) {
          const detail = payload.reason ? `\nreason: ${String(payload.reason).slice(0, 240)}` : '';
          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] ${oldStatus} → ${newStatus}${detail}`,
          });
        }

        if (newStatus === 'in_progress' && !task.startedAt) task.startedAt = helpers.nowIso();
        if (newStatus === 'in_progress') {
          task.reviewAttempts = 0;
        }
        if (newStatus === 'completed') {
          task.completedAt = helpers.nowIso();
          delete task.review;
        }
        if (newStatus === 'blocked' && payload.reason) {
          task.blocker = { reason: payload.reason, askedAt: helpers.nowIso() };
        }
        if (newStatus !== 'blocked') task.blocker = null;

        // Strict gate: only approved can unlock dependents
        if (newStatus === 'approved') {
          const unlocked = mgmt.autoUnlockDependents(board);
          // Auto-dispatch newly unlocked tasks
          for (const id of unlocked) {
            setImmediate(() => tryAutoDispatch(id, deps, helpers));
          }
        }

        // Update phase if all tasks approved
        const allApproved = board.taskPlan.tasks.every(t => t.status === 'approved');
        if (allApproved) board.taskPlan.phase = 'done';

        // Evolution Layer: emit status_change signal
        mgmt.ensureEvolutionFields(board);
        board.signals.push({
          id: helpers.uid('sig'),
          ts: helpers.nowIso(),
          by: 'server.js',
          type: 'status_change',
          content: `${task.id} ${oldStatus} → ${newStatus}`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: newStatus, assignee: task.assignee },
        });
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'task_status_manual', taskId, from: oldStatus, to: newStatus });

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
                const updatedBoard = helpers.readBoard();
                helpers.broadcastSSE('board', updatedBoard);
                const ctrl2 = mgmt.getControls(updatedBoard);
                const t = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
                if (
                  ctrl2.auto_redispatch &&
                  t &&
                  t.status === 'needs_revision' &&
                  (t.reviewAttempts || 0) < ctrl2.max_review_attempts
                ) {
                  console.log(`[review:${taskId}] auto-redispatch triggered`);
                  setImmediate(() => redispatchTask(updatedBoard, t, deps, helpers));
                }
                // L2 Digest: trigger after review completion
                if (digestTask?.isDigestEnabled()) {
                  setImmediate(() => {
                    digestTask.triggerDigest(taskId, 'review_completed', {
                      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
                      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
                    }).catch(err => console.error(`[digest:${taskId}] error:`, err.message));
                  });
                }
              } catch (err) {
                console.error(`[review:${taskId}] post-review error: ${err.message}`);
              }
            },
          }));
        }

        // L2 Digest: trigger after task approved
        if (newStatus === 'approved' && digestTask?.isDigestEnabled()) {
          setImmediate(() => {
            digestTask.triggerDigest(taskId, 'approved', {
              readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
              broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
            }).catch(err => console.error(`[digest:${taskId}] error:`, err.message));
          });
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
      const board = helpers.readBoard();
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
      logDispatchPreflight(plan, task, deps, helpers);

      const preferredModel = plan.modelHint;

      // Update status
      task.status = 'in_progress';
      task.startedAt = task.startedAt || helpers.nowIso();
      task.history = task.history || [];
      task.history.push({ ts: helpers.nowIso(), status: 'in_progress', by: 'dispatch', model: preferredModel || undefined, runtime: plan.runtimeHint, runtimeRationale: plan.runtimeSelection?.rationale, injectedLessons: plan.injectedLessonCount || 0 });
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
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'system',
          from: 'human',
          to: task.assignee,
          text: `[Dispatch ${task.id}] ${task.title} → ${assignee.displayName}${preferredModel ? `\nmodel: ${preferredModel}` : ''}`,
        });
      }
      helpers.writeBoard(board);

      // S5: Mark dispatching
      task.dispatch.state = 'dispatching';
      task.dispatch.startedAt = helpers.nowIso();
      helpers.writeBoard(board);

      // Fire and forget — agent runs async via dispatch plan (runtime-neutral)
      const rt2 = deps.getRuntime(plan.runtimeHint);
      rt2.dispatch(plan).then(result => {
        const replyText = rt2.extractReplyText(result.parsed, result.stdout);
        const newSessionId = rt2.extractSessionId(result.parsed);
        const latestBoard = helpers.readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
        const latestConv = latestBoard.conversations?.[0];

        if (latestConv) {
          if (newSessionId) latestConv.sessionIds[task.assignee] = newSessionId;
          pushMessage(latestConv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
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
          latestTask.lastReplyAt = helpers.nowIso();
        }

        // S5: Mark dispatch completed
        if (latestTask) {
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'completed';
          latestTask.dispatch.finishedAt = helpers.nowIso();
          latestTask.dispatch.sessionId = newSessionId || latestTask.dispatch.sessionId || null;
          latestTask.dispatch.lastError = null;
          if (result.usage) latestTask.dispatch.usage = result.usage;
        }

        helpers.writeBoard(latestBoard);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'task_dispatch_reply', taskId, agent: task.assignee, model: preferredModel || null, reply: replyText.slice(0, 500) });
        if (result.usage) helpers.appendLog({ ts: helpers.nowIso(), event: 'token_usage', taskId, usage: result.usage });

        // --- Usage tracking: per-task dispatch (Path A) ---
        const dispatchUserId = getUserIdForTask();
        const dispatchDuration = latestTask?.dispatch?.startedAt
          ? Math.round((Date.now() - new Date(latestTask.dispatch.startedAt).getTime()) / 1000)
          : 0;
        usage.record(dispatchUserId, 'dispatch', {
          taskId,
          runtime: plan.runtimeHint,
          assignee: task.assignee,
        });
        usage.record(dispatchUserId, 'agent.runtime', {
          taskId,
          durationSec: dispatchDuration,
          runtime: plan.runtimeHint,
        });
        const tokenUsage = rt2.extractUsage?.(result.parsed, result.stdout);
        if (tokenUsage) {
          usage.record(dispatchUserId, 'api.tokens', {
            taskId,
            input: tokenUsage.inputTokens,
            output: tokenUsage.outputTokens,
            cost: tokenUsage.totalCost,
          });
        }
      }).catch(err => {
        const latestBoard = helpers.readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
        const latestConv = latestBoard.conversations?.[0];
        if (latestTask) {
          latestTask.status = 'blocked';
          latestTask.blocker = { reason: `Dispatch failed: ${err.message}`, askedAt: helpers.nowIso() };
          latestTask.history = latestTask.history || [];
          latestTask.history.push({ ts: helpers.nowIso(), status: 'blocked', reason: err.message });

          // S5: Mark dispatch failed
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'failed';
          latestTask.dispatch.finishedAt = helpers.nowIso();
          latestTask.dispatch.lastError = err.message || String(err);
        }
        if (latestConv) {
          pushMessage(latestConv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'error',
            from: 'system',
            to: 'human',
            text: `[${taskId}] Dispatch failed: ${err.message}`,
          });
        }
        // Evolution Layer: emit error signal for dispatch failure
        mgmt.ensureEvolutionFields(latestBoard);
        latestBoard.signals.push({
          id: helpers.uid('sig'),
          ts: helpers.nowIso(),
          by: 'server.js',
          type: 'error',
          content: `${taskId} dispatch failed: ${err.message}`,
          refs: [taskId],
          data: { taskId, error: err.message },
        });
        if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
        helpers.writeBoard(latestBoard);
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
      const board = helpers.readBoard();

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
          t.history.push({ ts: helpers.nowIso(), status: 'dispatched', by: 'bulk_dispatch' });
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
          id: helpers.uid('msg'),
          ts: helpers.nowIso(),
          type: 'system',
          from: 'human',
          to: 'main',
          text: msg,
        });
      }
      helpers.writeBoard(board);

      // Send to Nox
      runtime.runOpenclawTurn({
        agentId: 'main',
        sessionId,
        message: msg,
        timeoutSec: 600,
      }).then(result => {
        const replyText = runtime.extractReplyText(result.parsed, result.stdout);
        const newSessionId = runtime.extractSessionId(result.parsed);
        const latestBoard = helpers.readBoard();
        const latestConv = latestBoard.conversations?.[0];

        if (latestConv) {
          if (newSessionId) latestConv.sessionIds['main'] = newSessionId;
          pushMessage(latestConv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'message',
            from: 'main',
            to: 'human',
            text: replyText,
            sessionId: newSessionId || sessionId,
          });
          helpers.writeBoard(latestBoard);
        }

        helpers.appendLog({ ts: helpers.nowIso(), event: 'bulk_dispatch_nox_reply', reply: replyText.slice(0, 500) });
      }).catch(err => {
        const latestBoard = helpers.readBoard();
        const latestConv = latestBoard.conversations?.[0];
        if (latestConv) {
          pushMessage(latestConv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'error',
            from: 'system',
            to: 'human',
            text: `Dispatch 失敗: ${err.message}`,
          });
          helpers.writeBoard(latestBoard);
        }
        console.error(`[dispatch error] ${err.message}`);
      });

      json(res, 200, { ok: true, dispatched: readyTasks.length, taskIds: readyTasks.map(t => t.id) });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- L2 Digest API ---

  const digestMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/digest$/);
  if (req.method === 'GET' && digestMatch) {
    const taskId = decodeURIComponent(digestMatch[1]);
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    if (!task.digest) return json(res, 404, { error: 'No digest available' });
    return json(res, 200, task.digest);
  }

  if (req.method === 'POST' && digestMatch) {
    const taskId = decodeURIComponent(digestMatch[1]);
    if (!digestTask?.isDigestEnabled()) {
      return json(res, 503, { error: 'Digest not enabled (ANTHROPIC_API_KEY not set)' });
    }
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    digestTask.triggerDigest(taskId, 'manual', {
      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
    }).then(() => json(res, 200, { ok: true, taskId }))
      .catch(err => json(res, 500, { error: err.message }));
    return;
  }

  // --- S6: High-Level Atomic APIs ---

  if (req.method === 'POST' && req.url === '/api/dispatch-next') {
    try {
      const board = helpers.readBoard();
      const task = mgmt.pickNextTask(board);

      if (!task) {
        helpers.writeBoard(board); // autoUnlockDependents may have changed board
        helpers.broadcastSSE('board', board);
        return json(res, 200, { ok: true, dispatched: false, reason: 'no ready tasks' });
      }

      const assignee = participantById(board, task.assignee);
      const sessionId = board.conversations?.[0]?.sessionIds?.[task.assignee] || null;
      const plan = mgmt.buildDispatchPlan(board, task, { mode: 'dispatch' });
      plan.sessionId = plan.sessionId || sessionId;
      logDispatchPreflight(plan, task, deps, helpers);

      // Update task status
      task.status = 'in_progress';
      task.startedAt = task.startedAt || helpers.nowIso();
      task.history = task.history || [];
      task.history.push({ ts: helpers.nowIso(), status: 'in_progress', by: 'dispatch-next', model: plan.modelHint || undefined, runtime: plan.runtimeHint, runtimeRationale: plan.runtimeSelection?.rationale, injectedLessons: plan.injectedLessonCount || 0 });
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
        startedAt: helpers.nowIso(),
        finishedAt: null,
        sessionId: plan.sessionId || null,
        lastError: null,
      };

      helpers.writeBoard(board);
      helpers.broadcastSSE('board', board);

      // Async execution (runtime-neutral)
      const rt3 = deps.getRuntime(plan.runtimeHint);
      rt3.dispatch(plan).then(result => {
        const replyText = rt3.extractReplyText(result.parsed, result.stdout);
        const newSessionId = rt3.extractSessionId(result.parsed);
        const latestBoard = helpers.readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
        const latestConv = latestBoard.conversations?.[0];

        if (latestTask) {
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'completed';
          latestTask.dispatch.finishedAt = helpers.nowIso();
          latestTask.dispatch.sessionId = newSessionId || latestTask.dispatch.sessionId || null;
          latestTask.dispatch.lastError = null;
          latestTask.lastReply = replyText;
          latestTask.lastReplyAt = helpers.nowIso();
          if (result.usage) latestTask.dispatch.usage = result.usage;
        }
        if (latestConv && newSessionId) {
          latestConv.sessionIds = latestConv.sessionIds || {};
          latestConv.sessionIds[task.assignee] = newSessionId;
        }
        helpers.writeBoard(latestBoard);
        helpers.broadcastSSE('board', latestBoard);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_next_reply', taskId: task.id, agent: task.assignee, reply: replyText.slice(0, 500) });
        if (result.usage) helpers.appendLog({ ts: helpers.nowIso(), event: 'token_usage', taskId: task.id, usage: result.usage });

        // --- Usage tracking: dispatch-next ---
        const dnUserId = getUserIdForTask();
        const dnDuration = latestTask?.dispatch?.startedAt
          ? Math.round((Date.now() - new Date(latestTask.dispatch.startedAt).getTime()) / 1000)
          : 0;
        usage.record(dnUserId, 'dispatch', {
          taskId: task.id,
          runtime: plan.runtimeHint,
          assignee: task.assignee,
        });
        usage.record(dnUserId, 'agent.runtime', {
          taskId: task.id,
          durationSec: dnDuration,
          runtime: plan.runtimeHint,
        });
        const dnTokenUsage = rt3.extractUsage?.(result.parsed, result.stdout);
        if (dnTokenUsage) {
          usage.record(dnUserId, 'api.tokens', {
            taskId: task.id,
            input: dnTokenUsage.inputTokens,
            output: dnTokenUsage.outputTokens,
            cost: dnTokenUsage.totalCost,
          });
        }
      }).catch(err => {
        const latestBoard = helpers.readBoard();
        const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
        if (latestTask) {
          latestTask.dispatch = latestTask.dispatch || {};
          latestTask.dispatch.state = 'failed';
          latestTask.dispatch.finishedAt = helpers.nowIso();
          latestTask.dispatch.lastError = err.message;
        }
        helpers.writeBoard(latestBoard);
        helpers.broadcastSSE('board', latestBoard);
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

      const board = helpers.readBoard();
      helpers.broadcastSSE('board', board);

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
        const board = helpers.readBoard();
        board.taskPlan = {
          title,
          createdAt: helpers.nowIso(),
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
            history: [{ ts: helpers.nowIso(), status: 'created', by: 'api' }],
          })),
        };

        // S8: Auto-create scoped boards (briefs) for tasks with matching skills
        for (const t of board.taskPlan.tasks) {
          if (t.skill && SKILLS_NEEDING_BRIEF.has(t.skill)) {
            ensureBriefsDir(DATA_DIR);
            const briefPath = `briefs/${t.id}.json`;
            t.briefPath = briefPath;
            const emptyBrief = {
              meta: { boardType: 'brief', version: 1, taskId: t.id },
              project: { name: title },
              shotspec: { status: 'pending', shots: [] },
              refpack: { status: 'empty', assets: {} },
              controls: { auto_retry: true, max_retries: 3, quality_threshold: 85, paused: false },
              log: [{ time: helpers.nowIso(), agent: 'system', action: 'brief_created', detail: `auto-created for ${t.id}` }],
            };
            fs.writeFileSync(path.resolve(DIR, briefPath), JSON.stringify(emptyBrief, null, 2));
          }
        }

        // Clear old evolution data (new project)
        board.signals = [];
        board.insights = [];
        board.lessons = [];

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'project_created', title, taskCount: tasks.length });
        helpers.broadcastSSE('board', board);

        const result = { ok: true, title, taskCount: tasks.length };

        // Auto-dispatch: check all dispatched tasks when auto_dispatch is enabled
        const projCtrl = mgmt.getControls(board);
        if (projCtrl.auto_dispatch) {
          for (const t of board.taskPlan.tasks) {
            if (t.status === 'dispatched') {
              setImmediate(() => tryAutoDispatch(t.id, deps, helpers));
            }
          }
        }

        // autoStart: dispatch first ready task
        if (payload.autoStart) {
          const nextTask = mgmt.pickNextTask(board);
          if (nextTask) {
            const plan = mgmt.buildDispatchPlan(board, nextTask, { mode: 'dispatch' });
            const sid = board.conversations?.[0]?.sessionIds?.[nextTask.assignee] || null;
            plan.sessionId = plan.sessionId || sid;
            logDispatchPreflight(plan, nextTask, deps, helpers);

            nextTask.status = 'in_progress';
            nextTask.startedAt = helpers.nowIso();
            nextTask.history = nextTask.history || [];
            nextTask.history.push({ ts: helpers.nowIso(), status: 'in_progress', by: 'project-autostart', runtime: plan.runtimeHint, runtimeRationale: plan.runtimeSelection?.rationale, injectedLessons: plan.injectedLessonCount || 0 });

            nextTask.dispatch = {
              version: mgmt.DISPATCH_PLAN_VERSION,
              state: 'dispatching',
              planId: plan.planId,
              runtime: plan.runtimeHint,
              agentId: plan.agentId,
              model: plan.modelHint || null,
              timeoutSec: plan.timeoutSec,
              preparedAt: plan.createdAt,
              startedAt: helpers.nowIso(),
              finishedAt: null, sessionId: null, lastError: null,
            };
            helpers.writeBoard(board);

            const rt4 = deps.getRuntime(plan.runtimeHint);
            rt4.dispatch(plan).then(r => {
              const lb = helpers.readBoard();
              const lt = (lb.taskPlan?.tasks || []).find(t => t.id === nextTask.id);
              if (lt) {
                lt.dispatch = lt.dispatch || {};
                lt.dispatch.state = 'completed';
                lt.dispatch.finishedAt = helpers.nowIso();
                lt.dispatch.sessionId = rt4.extractSessionId(r.parsed) || null;
                lt.lastReply = rt4.extractReplyText(r.parsed, r.stdout);
                lt.lastReplyAt = helpers.nowIso();
                if (r.usage) lt.dispatch.usage = r.usage;
              }
              helpers.writeBoard(lb);
              if (r.usage) helpers.appendLog({ ts: helpers.nowIso(), event: 'token_usage', taskId: nextTask.id, usage: r.usage });
              helpers.broadcastSSE('board', lb);

              // --- Usage tracking: project autoStart ---
              const asUserId = getUserIdForTask();
              const asDuration = lt?.dispatch?.startedAt
                ? Math.round((Date.now() - new Date(lt.dispatch.startedAt).getTime()) / 1000)
                : 0;
              usage.record(asUserId, 'dispatch', {
                taskId: nextTask.id,
                runtime: plan.runtimeHint,
                assignee: nextTask.assignee,
              });
              usage.record(asUserId, 'agent.runtime', {
                taskId: nextTask.id,
                durationSec: asDuration,
                runtime: plan.runtimeHint,
              });
              const asTokenUsage = rt4.extractUsage?.(r.parsed, r.stdout);
              if (asTokenUsage) {
                usage.record(asUserId, 'api.tokens', {
                  taskId: nextTask.id,
                  input: asTokenUsage.inputTokens,
                  output: asTokenUsage.outputTokens,
                  cost: asTokenUsage.totalCost,
                });
              }
            }).catch(err => {
              const lb = helpers.readBoard();
              const lt = (lb.taskPlan?.tasks || []).find(t => t.id === nextTask.id);
              if (lt) {
                lt.dispatch = lt.dispatch || {};
                lt.dispatch.state = 'failed';
                lt.dispatch.finishedAt = helpers.nowIso();
                lt.dispatch.lastError = err.message;
              }
              helpers.writeBoard(lb);
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

  return false;
};

// Expose init to attach cross-module functions to deps
module.exports.init = function(deps, helpers) {
  deps.tryAutoDispatch = (taskId) => tryAutoDispatch(taskId, deps, helpers);
  deps.redispatchTask = (board, task) => redispatchTask(board, task, deps, helpers);
};
