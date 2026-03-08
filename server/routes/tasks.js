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
 *
 * Also contains: redispatchTask, tryAutoDispatch, logDispatchPreflight, tryEddaSync
 */
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const { json } = bb;
const { participantById, pushMessage, getUserIdForTask } = require('./_shared');
const routeEngine = require('../route-engine');

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
  const { mgmt } = deps;
  const assignee = participantById(board, task.assignee);
  if (!assignee || assignee.type !== 'agent') {
    console.log(`[redispatch:${task.id}] skip: assignee ${task.assignee} is not an agent`);
    return;
  }

  try { mgmt.ensureTaskTransition(task.status, 'in_progress'); }
  catch { console.log(`[redispatch:${task.id}] skip: cannot transition ${task.status} → in_progress`); return; }

  // Pre-dispatch notification (before dispatchTask builds the plan)
  const conv = board.conversations?.[0];
  if (conv) {
    pushMessage(conv, {
      id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'system', from: 'system', to: task.assignee,
      text: `[Auto Re-dispatch ${task.id}] 第 ${task.reviewAttempts} 次修正指令已發送 → ${assignee.displayName}`,
    });
  }
  helpers.appendLog({ ts: helpers.nowIso(), event: 'auto_redispatch', taskId: task.id, assignee: task.assignee, attempt: task.reviewAttempts });

  dispatchTask(task, board, deps, helpers, { source: 'auto-redispatch', mode: 'redispatch' });
}

// ---------------------------------------------------------------------------
// dispatchTask() — unified dispatch entry point
//
// Every dispatch path (autoStart, per-task, dispatch-next, auto-dispatch,
// auto-redispatch) calls this. Handles worktree + step pipeline + legacy
// single-shot dispatch so callers never bypass the full pipeline.
//
// opts.source  — label: 'auto-dispatch'|'dispatch'|'dispatch-next'|'project-autostart'|'auto-redispatch'
// opts.mode    — 'dispatch' (default) or 'redispatch'
// opts.runtimeOverride — force specific runtime
// opts.onActivity — heartbeat callback (lock renewal)
// ---------------------------------------------------------------------------
const _dispatchLocks = new Map(); // taskId → ISO timestamp (prevents concurrent dispatch for same task)

function dispatchTask(task, board, deps, helpers, opts = {}) {
  const { mgmt, usage, push, PUSH_TOKENS_PATH } = deps;
  const ctrl = mgmt.getControls(board);
  const taskId = task.id;
  const source = opts.source || 'dispatch';
  const mode = opts.mode || 'dispatch';

  // Guard: reject concurrent dispatch for same task
  if (_dispatchLocks.has(taskId)) {
    console.log(`[dispatchTask:${taskId}] skip: dispatch already in progress (locked since ${_dispatchLocks.get(taskId)})`);
    return { dispatched: false, reason: 'dispatch already in progress' };
  }
  _dispatchLocks.set(taskId, helpers.nowIso());

  const assignee = participantById(board, task.assignee);
  if (!assignee || assignee.type !== 'agent') {
    _dispatchLocks.delete(taskId);
    console.log(`[dispatchTask:${taskId}] skip: assignee ${task.assignee} is not an agent`);
    return { dispatched: false, reason: 'assignee not agent' };
  }

  // --- Phase 1: Worktree (ensure exists on disk) ---
  if (ctrl.use_worktrees) {
    // Validate worktree exists on disk (may have been manually deleted)
    if (task.worktreeDir && !fs.existsSync(task.worktreeDir)) {
      console.log(`[dispatchTask:${taskId}] worktree missing on disk, re-creating`);
      task.worktreeDir = null;
      task.worktreeBranch = null;
    }

    if (!task.worktreeDir) {
      const worktree = require('../worktree');
      const { resolveRepoRoot, validateRepoRoot } = require('../repo-resolver');
      const repoRoot = resolveRepoRoot(task, board) || path.resolve(__dirname, '..', '..');

      const validation = validateRepoRoot(repoRoot, task.source?.repo);
      if (!validation.valid) {
        _dispatchLocks.delete(taskId);
        console.error(`[dispatchTask:${taskId}] repo validation failed: ${validation.error}`);
        task.status = 'blocked';
        task.blocker = { reason: `Repo validation failed: ${validation.error}`, askedAt: helpers.nowIso() };
        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_blocked', taskId, source, error: validation.error });
        helpers.broadcastSSE('board', board);
        return { dispatched: false, reason: validation.error };
      }

      try {
        const wt = worktree.createWorktree(repoRoot, taskId);
        task.worktreeDir = wt.worktreePath;
        task.worktreeBranch = wt.branch;
        console.log(`[dispatchTask:${taskId}] worktree: ${wt.worktreePath}`);
      } catch (err) {
        _dispatchLocks.delete(taskId);
        console.error(`[dispatchTask:${taskId}] worktree failed: ${err.message}`);
        task.status = 'blocked';
        task.blocker = { reason: `Worktree creation failed: ${err.message}`, askedAt: helpers.nowIso() };
        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_blocked', taskId, source, error: err.message });
        helpers.broadcastSSE('board', board);
        return { dispatched: false, reason: err.message };
      }
    }
  }

  // --- Phase 2: Step pipeline (if enabled) ---
  if (ctrl.use_step_pipeline && deps.stepWorker) {
    console.log(`[dispatchTask:${taskId}] step-pipeline via ${source}`);
    const runId = helpers.uid('run');
    task.steps = mgmt.generateStepsForTask(task, runId, task.pipeline || null, board);
    task._revisionCounts = {};  // Clear stale revision counts from previous runs
    task.status = 'in_progress';
    task.startedAt = task.startedAt || helpers.nowIso();
    task.history = task.history || [];
    task.history.push({ ts: helpers.nowIso(), status: 'in_progress', by: source, runtime: 'step-pipeline' });
    if (board.taskPlan) board.taskPlan.phase = 'executing';

    // Always reset budget on (re-)dispatch — previous run's usage must not carry over
    task.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS, ...task.budget?.limits }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };


    mgmt.ensureEvolutionFields(board);
    board.signals.push({
      id: helpers.uid('sig'), ts: helpers.nowIso(), by: source,
      type: 'steps_created', content: `${taskId} steps created (${task.steps.length})`,
      refs: [taskId], data: { taskId, runId, count: task.steps.length },
    });
    if (board.signals.length > 500) board.signals = board.signals.slice(-500);

    const firstStep = task.steps[0];
    const runState = { task, steps: task.steps, run_id: runId, budget: task.budget, controls: ctrl };
    const decision = { action: 'next_step', next_step: { step_id: firstStep.step_id, step_type: firstStep.type } };
    const envelope = deps.contextCompiler.buildEnvelope(decision, runState, deps);

    if (envelope) {
      deps.artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'input', envelope);
      deps.stepSchema.transitionStep(firstStep, 'running', {
        locked_by: source,
        input_ref: deps.artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'input'),
      });
      helpers.writeBoard(board);
      helpers.appendLog({ ts: helpers.nowIso(), event: 'step_pipeline_started', taskId, runId, firstStep: firstStep.step_id, source });
      deps.stepWorker.executeStep(envelope, helpers.readBoard(), helpers).catch(err =>
        console.error(`[dispatchTask:${taskId}] step execution error:`, err.message));
    } else {
      // Envelope build failed — mark first step as failed to avoid orphaned pipeline
      if (firstStep.state === 'queued') {
        deps.stepSchema.transitionStep(firstStep, 'running', { locked_by: source });
        deps.stepSchema.transitionStep(firstStep, 'failed', { error: 'Failed to build dispatch envelope' });
      }
      helpers.writeBoard(board);
      helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_envelope_failed', taskId, source });
      console.error(`[dispatchTask:${taskId}] failed to build envelope for first step`);
    }
    _dispatchLocks.delete(taskId);
    return { dispatched: true, mode: 'step-pipeline', runId };
  }

  // --- Phase 3: Legacy single-shot dispatch ---
  console.log(`[dispatchTask:${taskId}] legacy dispatch via ${source}`);

  const sessionId = task.childSessionKey || board.conversations?.[0]?.sessionIds?.[task.assignee] || null;
  const dispatchOpts = { mode, workingDir: task.worktreeDir || null };
  if (opts.runtimeOverride) dispatchOpts.runtimeHint = opts.runtimeOverride;
  const plan = mgmt.buildDispatchPlan(board, task, dispatchOpts);
  plan.sessionId = plan.sessionId || sessionId;
  if (opts.onActivity) plan.onActivity = opts.onActivity;
  logDispatchPreflight(plan, task, deps, helpers);

  // Update status
  task.status = 'in_progress';
  task.startedAt = task.startedAt || helpers.nowIso();
  task.history = task.history || [];
  task.history.push({
    ts: helpers.nowIso(), status: 'in_progress', by: source,
    model: plan.modelHint || undefined,
    runtime: plan.runtimeHint,
    runtimeRationale: plan.runtimeSelection?.rationale,
    injectedLessons: plan.injectedLessonCount || 0,
    ...(task.reviewAttempts ? { attempt: task.reviewAttempts } : {}),
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
    timeoutSec: plan.timeoutSec || 300,
    preparedAt: plan.createdAt,
    startedAt: helpers.nowIso(),
    finishedAt: null,
    sessionId: plan.sessionId || null,
    lastError: null,
  };

  helpers.writeBoard(board);
  helpers.appendLog({
    ts: helpers.nowIso(), event: 'task_dispatched', taskId,
    assignee: task.assignee, source, planId: plan.planId,
  });

  // Async runtime execution
  const rt = deps.getRuntime(plan.runtimeHint);
  rt.dispatch(plan).then(result => {
    const replyText = rt.extractReplyText(result.parsed, result.stdout);
    const newSessionId = rt.extractSessionId(result.parsed);
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
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
    if (latestConv) {
      const prefix = mode === 'redispatch' ? `${taskId} Fix Reply` : `${taskId} Reply`;
      pushMessage(latestConv, {
        id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'message',
        from: task.assignee, to: 'human',
        text: `[${prefix}]\n${replyText}`,
        sessionId: newSessionId || sessionId,
      });
    }

    helpers.writeBoard(latestBoard);
    helpers.broadcastSSE('board', latestBoard);
    helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_reply', taskId, source, agent: task.assignee, reply: replyText.slice(0, 500) });
    if (result.usage) helpers.appendLog({ ts: helpers.nowIso(), event: 'token_usage', taskId, usage: result.usage });

    // Usage tracking
    const userId = getUserIdForTask();
    const duration = latestTask?.dispatch?.startedAt
      ? Math.round((Date.now() - new Date(latestTask.dispatch.startedAt).getTime()) / 1000)
      : 0;
    usage.record(userId, 'dispatch', { taskId, runtime: plan.runtimeHint, assignee: task.assignee });
    usage.record(userId, 'agent.runtime', { taskId, durationSec: duration, runtime: plan.runtimeHint });
    const tokenUsage = rt.extractUsage?.(result.parsed, result.stdout);
    if (tokenUsage) {
      usage.record(userId, 'api.tokens', {
        taskId, input: tokenUsage.inputTokens, output: tokenUsage.outputTokens, cost: tokenUsage.totalCost,
      });
    }
  }).catch(err => {
    console.error(`[dispatchTask:${taskId}:${source}] error:`, err.message);
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
    const latestConv = latestBoard.conversations?.[0];

    if (latestTask) {
      latestTask.dispatch = latestTask.dispatch || {};
      latestTask.dispatch.state = 'failed';
      latestTask.dispatch.finishedAt = helpers.nowIso();
      latestTask.dispatch.lastError = err.message || String(err);

      if (source === 'dispatch' || source === 'auto-redispatch') {
        latestTask.status = 'blocked';
        latestTask.blocker = { reason: `Dispatch failed: ${err.message}`, askedAt: helpers.nowIso() };
        latestTask.history = latestTask.history || [];
        latestTask.history.push({ ts: helpers.nowIso(), status: 'blocked', reason: err.message, by: `${source}-error` });
      }
    }

    if (latestConv) {
      pushMessage(latestConv, {
        id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'error',
        from: 'system', to: 'human',
        text: `[${taskId}] Dispatch failed: ${err.message}`,
      });
    }

    if (source === 'dispatch' || source === 'auto-redispatch') {
      mgmt.ensureEvolutionFields(latestBoard);
      latestBoard.signals.push({
        id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'dispatchTask',
        type: 'error', content: `${taskId} dispatch failed: ${err.message}`,
        refs: [taskId], data: { taskId, error: err.message, source },
      });
      if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
    }

    helpers.writeBoard(latestBoard);
    helpers.broadcastSSE('board', latestBoard);

    if (latestTask && (source === 'dispatch' || source === 'auto-redispatch')) {
      push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'dispatch.failed')
        .catch(err2 => console.error('[push] dispatch-failed notify:', err2.message));
    }
  }).finally(() => {
    _dispatchLocks.delete(taskId);
  });

  return { dispatched: true, planId: plan.planId, mode: 'legacy' };
}

// --- Auto-dispatch: automatically dispatch tasks when auto_dispatch control is enabled ---
function tryAutoDispatch(taskId, deps, helpers) {
  const { mgmt } = deps;
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

  // Concurrency gate: limit parallel in-progress tasks
  const inProgressCount = (board.taskPlan?.tasks || [])
    .filter(t => t.status === 'in_progress').length;
  if (inProgressCount >= (ctrl.max_concurrent_tasks || 2)) {
    console.log(`[auto-dispatch:${taskId}] skip: ${inProgressCount} tasks in progress (max: ${ctrl.max_concurrent_tasks || 2})`);
    return;
  }

  // Project concurrency gate
  if (task.projectId) {
    const project = (board.projects || []).find(p => p.id === task.projectId);
    if (project) {
      if (project.status === 'paused') {
        console.log(`[auto-dispatch:${taskId}] skip: project ${project.id} is paused`);
        return;
      }
      const projectInProgress = (board.taskPlan?.tasks || [])
        .filter(t => t.projectId === project.id && t.status === 'in_progress').length;
      if (projectInProgress >= (project.concurrency || 3)) {
        console.log(`[auto-dispatch:${taskId}] skip: project concurrency ${projectInProgress}/${project.concurrency}`);
        return;
      }
    }
  }

  // Delegate to unified dispatchTask (handles worktree + step pipeline + legacy)
  dispatchTask(task, board, deps, helpers, { source: 'auto-dispatch' });
}

// Brief helpers moved to routes/projects.js (GH-251)

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
  const { mgmt, runtime, push, usage, ctx, jiraIntegration, digestTask, timelineTask, confidenceEngine, PUSH_TOKENS_PATH, DIR, DATA_DIR } = deps;

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

  // GET /api/tasks/:id/progress — one-shot progress snapshot
  const progressMatch = req.method === 'GET' && req.url.match(/^\/api\/tasks\/([^/]+)\/progress/);
  if (progressMatch) {
    const taskId = decodeURIComponent(progressMatch[1]);
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

    const currentStep = task.steps?.find(s => s.state === 'running');
    const pipeline = (task.steps || []).map(s => ({
      step: s.step_id,
      type: s.type,
      state: s.state,
      progress: s.progress || null,
      duration_ms: s.duration_ms || null,
    }));

    return json(res, 200, {
      taskId: task.id,
      status: task.status,
      currentStep: currentStep ? {
        step_id: currentStep.step_id,
        type: currentStep.type,
        state: currentStep.state,
        progress: currentStep.progress || null,
      } : null,
      pipeline,
      budget: task.budget || null,
    });
  }

  if (req.method === 'GET' && req.url.startsWith('/api/tasks') &&
      !req.url.includes('/steps') &&
      !req.url.includes('/digest') &&
      !req.url.includes('/timeline') &&
      !req.url.includes('/report') &&
      !req.url.includes('/confidence') &&
      !req.url.includes('/progress')) {
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

        // Merge into existing taskPlan (never overwrite running tasks)
        board.taskPlan = board.taskPlan || { tasks: [] };
        board.taskPlan.tasks = board.taskPlan.tasks || [];

        if (payload.goal) board.taskPlan.goal = String(payload.goal);
        if (payload.phase) board.taskPlan.phase = String(payload.phase);
        if (!board.taskPlan.createdAt) board.taskPlan.createdAt = payload.createdAt || helpers.nowIso();

        const ACTIVE_STATUSES = ['in_progress', 'dispatched'];
        const SAFE_FIELDS = ['title', 'description', 'assignee', 'depends', 'spec', 'skill', 'estimate', 'target_repo'];
        const incomingTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        const existingIds = new Set(board.taskPlan.tasks.map(t => t.id));
        for (const t of incomingTasks) {
          if (existingIds.has(t.id)) {
            const existing = board.taskPlan.tasks.find(e => e.id === t.id);
            if (existing && !ACTIVE_STATUSES.includes(existing.status)) {
              for (const k of SAFE_FIELDS) { if (t[k] !== undefined) existing[k] = t[k]; }
              existing.history = existing.history || [];
              existing.history.push({ ts: helpers.nowIso(), status: 'updated', by: 'api' });
            }
            continue;
          }
          board.taskPlan.tasks.push(t);
        }

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'taskPlan_updated', goal: board.taskPlan.goal });

        // Auto-dispatch any dispatched tasks in the updated plan
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
          const validStatuses = ['pending', 'dispatched', 'in_progress', 'blocked', 'completed', 'reviewing', 'approved', 'needs_revision', 'cancelled'];
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

        // Auto-dispatch when task transitions to dispatched
        if (payload.status === 'dispatched') {
          setImmediate(() => tryAutoDispatch(task.id, deps, helpers));
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
                // L1 Confidence: compute before digest so confidence feeds into L2
                if (confidenceEngine) {
                  try {
                    confidenceEngine.triggerConfidence(taskId, 'review_completed', {
                      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
                      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
                    });
                  } catch (err) { console.error(`[confidence:${taskId}] error:`, err.message); }
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

        // L1 Confidence: trigger after task approved
        if (payload.status === 'approved' && confidenceEngine) {
          try {
            confidenceEngine.triggerConfidence(taskId, 'approved', {
              readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
              broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
            });
          } catch (err) { console.error(`[confidence:${taskId}] error:`, err.message); }
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
        const validStatuses = ['pending', 'dispatched', 'in_progress', 'blocked', 'completed', 'reviewing', 'approved', 'needs_revision', 'cancelled'];
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

        // Cancel: kill running steps, transition queued/running steps to cancelled
        if (newStatus === 'cancelled') {
          task.completedAt = helpers.nowIso();
          for (const step of (task.steps || [])) {
            if (step.state === 'running') {
              try { deps.stepWorker.killStep(step.step_id); } catch {}
              deps.stepSchema.transitionStep(step, 'cancelled', { error: 'Task cancelled' });
            } else if (step.state === 'queued' || step.state === 'failed') {
              deps.stepSchema.transitionStep(step, 'cancelled', { error: 'Task cancelled' });
            }
          }
        }

        // Strict gate: only approved can unlock dependents
        if (newStatus === 'approved') {
          const unlocked = mgmt.autoUnlockDependents(board);
          // Auto-dispatch newly unlocked tasks
          for (const id of unlocked) {
            setImmediate(() => tryAutoDispatch(id, deps, helpers));
          }
        }

        // Auto-dispatch when task transitions to dispatched
        if (newStatus === 'dispatched') {
          setImmediate(() => tryAutoDispatch(task.id, deps, helpers));
        }

        // Update phase if all tasks approved (cancelled tasks don't block)
        const allApproved = board.taskPlan.tasks.every(t => t.status === 'approved' || t.status === 'cancelled');
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
        if (['completed', 'blocked', 'needs_revision', 'approved', 'cancelled'].includes(newStatus)) {
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
                // L1 Confidence: compute before digest so confidence feeds into L2
                if (confidenceEngine) {
                  try {
                    confidenceEngine.triggerConfidence(taskId, 'review_completed', {
                      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
                      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
                    });
                  } catch (err) { console.error(`[confidence:${taskId}] error:`, err.message); }
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

  // --- Step-level endpoints ---

  const stepsCreateMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/steps$/);

  // POST /api/tasks/:id/steps — create step pipeline for a task
  if (req.method === 'POST' && stepsCreateMatch) {
    const taskId = decodeURIComponent(stepsCreateMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const runId = payload.run_id || helpers.uid('run');
        const pipeline = payload.pipeline || null;
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        task.steps = mgmt.generateStepsForTask(task, runId, pipeline, board);
        mgmt.ensureEvolutionFields(board);
        board.signals.push({
          id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'kernel',
          type: 'steps_created', content: `${taskId} steps created (${task.steps.length})`,
          refs: [taskId], data: { taskId, runId, count: task.steps.length },
        });
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);
        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'steps_created', taskId, runId, count: task.steps.length });
        json(res, 200, { ok: true, taskId, runId, steps: task.steps });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // GET /api/tasks/:id/steps — list steps for a task
  if (req.method === 'GET' && stepsCreateMatch) {
    const taskId = decodeURIComponent(stepsCreateMatch[1]);
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
    json(res, 200, { ok: true, taskId, steps: task.steps || [] });
    return;
  }

  // PATCH /api/tasks/:id/steps/:stepId — update step state
  const stepUpdateMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/steps\/([^/]+)$/);
  if (req.method === 'PATCH' && stepUpdateMatch) {
    const taskId = decodeURIComponent(stepUpdateMatch[1]);
    const stepId = decodeURIComponent(stepUpdateMatch[2]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const newState = String(payload.state || '').trim();
        if (!newState) return json(res, 400, { error: 'state is required' });

        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const step = (task.steps || []).find(s => s.step_id === stepId);
        if (!step) return json(res, 404, { error: `Step ${stepId} not found` });

        const oldState = step.state;
        deps.stepSchema.transitionStep(step, newState, {
          error: payload.error,
          output_ref: payload.output_ref,
          input_ref: payload.input_ref,
          locked_by: payload.locked_by,
          lock_expires_at: payload.lock_expires_at,
        });

        // Emit signal
        const signalType = (step.state === 'succeeded') ? 'step_completed'
          : (step.state === 'dead') ? 'step_dead'
          : (step.state === 'queued' && oldState === 'running') ? 'step_failed'
          : `step_${step.state}`;
        mgmt.ensureEvolutionFields(board);
        board.signals.push({
          id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'kernel',
          type: signalType,
          content: `${taskId} step ${stepId} ${oldState} → ${step.state}`,
          refs: [taskId],
          data: { taskId, stepId, from: oldState, to: step.state, attempt: step.attempt },
        });
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: signalType, taskId, stepId, from: oldState, to: step.state });

        // Trigger kernel for terminal step states (async, after response)
        // deps.kernel — initialized in server.js; see circular dependency notes there
        const signal = { type: signalType, data: { taskId, stepId, from: oldState, to: step.state, attempt: step.attempt } };
        if (deps.kernel && (step.state === 'succeeded' || step.state === 'dead')) {
          setImmediate(() => {
            deps.kernel.onStepEvent(signal, helpers.readBoard(), helpers)
              .catch(err => console.error('[kernel] onStepEvent error:', err.message));
          });
        }

        json(res, 200, { ok: true, taskId, step });
      } catch (error) {
        const status = error.code === 'INVALID_STEP_TRANSITION' ? 400 : 500;
        json(res, status, { error: error.message });
      }
    });
    return;
  }

  // POST /api/tasks/:id/steps/:stepId/kill — kill a running step
  const stepKillMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/steps\/([^/]+)\/kill$/);
  if (req.method === 'POST' && stepKillMatch) {
    const taskId = decodeURIComponent(stepKillMatch[1]);
    const stepId = decodeURIComponent(stepKillMatch[2]);

    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

    const step = (task.steps || []).find(s => s.step_id === stepId);
    if (!step) return json(res, 404, { error: `Step ${stepId} not found` });
    if (step.state !== 'running') return json(res, 409, { error: `Step is ${step.state}, not running` });

    // Kill the agent process
    const killResult = deps.stepWorker.killStep(stepId);
    if (!killResult.ok) return json(res, 409, { error: killResult.reason });

    // Transition to cancelled
    deps.stepSchema.transitionStep(step, 'cancelled', { error: 'Killed by user' });

    // Emit signal
    mgmt.ensureEvolutionFields(board);
    board.signals.push({
      id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'user',
      type: 'step_cancelled',
      content: `${taskId} step ${stepId} running → cancelled (killed)`,
      refs: [taskId],
      data: { taskId, stepId, from: 'running', to: 'cancelled' },
    });
    if (board.signals.length > 500) board.signals = board.signals.slice(-500);

    helpers.writeBoard(board);
    helpers.appendLog({ ts: helpers.nowIso(), event: 'step_killed', taskId, stepId });

    return json(res, 200, { ok: true, step_id: stepId, new_state: 'cancelled' });
  }

  // POST /api/tasks/:id/steps/:stepId/reset — reset a dead/failed/cancelled step to queued
  const stepResetMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/steps\/([^/]+)\/reset$/);
  if (req.method === 'POST' && stepResetMatch) {
    const taskId = decodeURIComponent(stepResetMatch[1]);
    const stepId = decodeURIComponent(stepResetMatch[2]);

    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

    const step = (task.steps || []).find(s => s.step_id === stepId);
    if (!step) return json(res, 404, { error: `Step ${stepId} not found` });

    // Only allow reset from terminal states (not succeeded — that's intentionally final)
    const RESETTABLE = ['dead', 'failed', 'cancelled'];
    if (!RESETTABLE.includes(step.state)) {
      return json(res, 409, { error: `Step is ${step.state}, can only reset dead/failed/cancelled steps` });
    }

    const fromState = step.state;

    // Reset step fields
    step.state = 'queued';
    step.attempt = 0;
    step.error = null;
    step.completed_at = null;
    step.started_at = null;
    step.locked_by = null;
    step.lock_expires_at = null;
    step.output_ref = null;
    step.scheduled_at = helpers.nowIso();

    // Unblock task if it was blocked due to dead step
    let taskUnblocked = false;
    if (task.status === 'blocked') {
      task.status = 'in_progress';
      task.blocker = null;
      taskUnblocked = true;
      task.history = task.history || [];
      task.history.push({ ts: helpers.nowIso(), status: 'in_progress', from: 'blocked', by: 'step_reset' });
    }

    // Emit signal
    mgmt.ensureEvolutionFields(board);
    board.signals.push({
      id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'user',
      type: 'step_reset',
      content: `${taskId} step ${stepId} ${fromState} → queued (reset)`,
      refs: [taskId],
      data: { taskId, stepId, from: fromState, to: 'queued', taskUnblocked },
    });
    if (board.signals.length > 500) board.signals = board.signals.slice(-500);

    helpers.writeBoard(board);
    helpers.appendLog({ ts: helpers.nowIso(), event: 'step_reset', taskId, stepId, from: fromState });

    // Trigger auto-dispatch if task was unblocked
    if (taskUnblocked) {
      setImmediate(() => tryAutoDispatch(taskId, deps, helpers));
    }

    return json(res, 200, { ok: true, step_id: stepId, from: fromState, new_state: 'queued', task_unblocked: taskUnblocked });
  }

  // POST /api/tasks/:id/steps/dispatch-batch — dispatch multiple steps in parallel
  const batchDispatchMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/steps\/dispatch-batch$/);
  if (req.method === 'POST' && batchDispatchMatch) {
    const taskId = decodeURIComponent(batchDispatchMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        if (!task.steps?.length) return json(res, 400, { error: 'Task has no steps' });

        // Filter steps: by step_ids (must be queued) or all queued
        let targets;
        if (Array.isArray(payload.step_ids) && payload.step_ids.length > 0) {
          targets = task.steps.filter(s => payload.step_ids.includes(s.step_id) && s.state === 'queued');
        } else {
          targets = task.steps.filter(s => s.state === 'queued');
        }
        if (targets.length === 0) return json(res, 400, { error: 'No dispatchable steps found (only queued steps can be dispatched)' });

        // Build envelopes and dispatch sequentially (board is single-file, parallel writes race)
        const results = [];
        for (const step of targets) {
          try {
            const currentBoard = helpers.readBoard();
            const currentTask = (currentBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
            const runState = { task: currentTask, steps: currentTask.steps, run_id: step.run_id, budget: currentTask.budget, controls: mgmt.getControls(currentBoard) };
            const decision = { action: 'next_step', next_step: { step_id: step.step_id, step_type: step.type } };
            const envelope = deps.contextCompiler.buildEnvelope(decision, runState, deps);
            if (!envelope) throw new Error(`Cannot build envelope for ${step.step_id}`);

            // Write input artifact and transition to running
            const currentStep = currentTask.steps.find(s => s.step_id === step.step_id);
            deps.artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'input', envelope);
            if (!currentStep || currentStep.state !== 'queued') {
              // Step already picked up by kernel or retry-poller — skip to avoid double execution
              results.push({ step_id: step.step_id, status: 'skipped', reason: `state is ${currentStep?.state}` });
              continue;
            }
            deps.stepSchema.transitionStep(currentStep, 'running', {
              locked_by: 'batch-dispatch',
              input_ref: deps.artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'input'),
            });
            helpers.writeBoard(currentBoard);

            // deps.stepWorker — initialized in server.js; see circular dependency notes there
            const output = await deps.stepWorker.executeStep(envelope, helpers.readBoard(), helpers);
            results.push({ step_id: step.step_id, status: output.status });
          } catch (err) {
            results.push({ step_id: step.step_id, status: 'error', error: err.message });
          }
        }
        json(res, 200, { ok: true, taskId, dispatched: targets.length, results });
      } catch (error) {
        json(res, 500, { error: error.message });
      }
    });
    return;
  }

  // --- Per-task dispatch: send task directly to assigned agent ---
  const taskDispatchMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/dispatch(\?|$)/);
  if (req.method === 'POST' && taskDispatchMatch) {
    const taskId = decodeURIComponent(taskDispatchMatch[1]);
    const dispatchUrl = new URL(req.url, 'http://localhost');
    const runtimeOverride = dispatchUrl.searchParams.get('runtime') || null;
    try {
      const board = helpers.readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
      if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

      const assignee = participantById(board, task.assignee);
      if (!assignee || assignee.type !== 'agent') {
        return json(res, 400, { error: `Assignee ${task.assignee} is not an agent` });
      }

      const unmetDeps = (task.depends || []).filter(depId => {
        const dep = (board.taskPlan?.tasks || []).find(t => t.id === depId);
        return !dep || dep.status !== 'approved';
      });
      if (unmetDeps.length > 0) {
        return json(res, 400, { error: `Unmet dependencies: ${unmetDeps.join(', ')}` });
      }

      // Pre-dispatch notification
      const conv = board.conversations?.[0];
      if (conv) {
        pushMessage(conv, {
          id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'system',
          from: 'human', to: task.assignee,
          text: `[Dispatch ${task.id}] ${task.title} → ${assignee.displayName}`,
        });
      }

      const result = dispatchTask(task, board, deps, helpers, { source: 'dispatch', runtimeOverride });
      json(res, 200, { ok: true, taskId, dispatched: result.dispatched, planId: result.planId });
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

  // --- L1 Confidence API ---

  const confidenceMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/confidence$/);
  if (req.method === 'GET' && confidenceMatch) {
    const taskId = decodeURIComponent(confidenceMatch[1]);
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    if (!task.confidence) return json(res, 404, { error: 'No confidence data available' });
    return json(res, 200, task.confidence);
  }

  if (req.method === 'POST' && confidenceMatch) {
    const taskId = decodeURIComponent(confidenceMatch[1]);
    if (!confidenceEngine) return json(res, 503, { error: 'Confidence engine not available' });
    try {
      confidenceEngine.triggerConfidence(taskId, 'manual', {
        readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
        broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
      });
      const board = helpers.readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
      return json(res, 200, { ok: true, taskId, confidence: task?.confidence || null });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // --- L3 Timeline API ---

  const timelineMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/timeline$/);
  if (req.method === 'GET' && timelineMatch) {
    const taskId = decodeURIComponent(timelineMatch[1]);
    if (!timelineTask) return json(res, 503, { error: 'Timeline module not available' });
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    const timeline = timelineTask.assembleTimeline(board, task);
    return json(res, 200, { taskId, count: timeline.length, timeline });
  }

  const reportMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/report$/);
  if (req.method === 'GET' && reportMatch) {
    const taskId = decodeURIComponent(reportMatch[1]);
    if (!timelineTask) return json(res, 503, { error: 'Timeline module not available' });
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    const timeline = timelineTask.assembleTimeline(board, task);
    const report = timelineTask.buildDeliveryReport(board, task, timeline);
    const html = timelineTask.renderReportHTML(report);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
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

      const result = dispatchTask(task, board, deps, helpers, { source: 'dispatch-next' });
      return json(res, 202, { ok: true, dispatched: result.dispatched, taskId: task.id, planId: result.planId });
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

  // POST /api/project — DEPRECATED: handled by routes/projects.js

  // --- Pipeline Templates ---

  const templatesMatch = req.url.match(/^\/api\/pipeline-templates(?:\/([^/?]+))?$/);

  // GET /api/pipeline-templates — list all templates
  if (req.method === 'GET' && templatesMatch && !templatesMatch[1]) {
    const board = helpers.readBoard();
    json(res, 200, board.pipelineTemplates || {});
    return;
  }

  // PUT /api/pipeline-templates/:name — create or update a template
  if (req.method === 'PUT' && templatesMatch && templatesMatch[1]) {
    const name = decodeURIComponent(templatesMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const pipeline = payload.pipeline;
        if (!Array.isArray(pipeline) || pipeline.length === 0) {
          return json(res, 400, { error: 'pipeline must be a non-empty array' });
        }
        const normalized = pipeline.map(mgmt.normalizePipelineEntry).filter(Boolean);
        if (normalized.length === 0) {
          return json(res, 400, { error: 'no valid pipeline entries after normalization' });
        }
        const board = helpers.readBoard();
        if (!board.pipelineTemplates) board.pipelineTemplates = {};
        board.pipelineTemplates[name] = normalized;
        mgmt.ensureEvolutionFields(board);
        board.signals.push({
          id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'api',
          type: 'pipeline_template_updated', content: `Template "${name}" updated (${normalized.length} steps)`,
          refs: [], data: { name, count: normalized.length },
        });
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);
        helpers.writeBoard(board);
        json(res, 200, { ok: true, name, pipeline: normalized });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // DELETE /api/pipeline-templates/:name — delete a template
  if (req.method === 'DELETE' && templatesMatch && templatesMatch[1]) {
    const name = decodeURIComponent(templatesMatch[1]);
    const board = helpers.readBoard();
    if (!board.pipelineTemplates || !board.pipelineTemplates[name]) {
      return json(res, 404, { error: `Template "${name}" not found` });
    }
    delete board.pipelineTemplates[name];
    mgmt.ensureEvolutionFields(board);
    board.signals.push({
      id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'api',
      type: 'pipeline_template_deleted', content: `Template "${name}" deleted`,
      refs: [], data: { name },
    });
    if (board.signals.length > 500) board.signals = board.signals.slice(-500);
    helpers.writeBoard(board);
    json(res, 200, { ok: true, name, deleted: true });
    return;
  }

  return false;
};

// Expose init to attach cross-module functions to deps
module.exports.init = function(deps, helpers) {
  deps.tryAutoDispatch = (taskId) => tryAutoDispatch(taskId, deps, helpers);
  deps.redispatchTask = (board, task) => redispatchTask(board, task, deps, helpers);
  deps.dispatchTask = (task, board2, opts) => dispatchTask(task, board2, deps, helpers, opts);
};
