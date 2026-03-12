/**
 * routes/tasks.js — Task Engine APIs (router facade)
 *
 * 拆分後的子模組：
 *   tasks-steps.js      — step CRUD, transition, reset, kill, dispatch-batch
 *   tasks-lifecycle.js  — cancel, reopen, unblock, rollback, status, delete, cleanup
 *   tasks-confidence.js — confidence, timeline, report, digest
 *
 * 本檔保留：
 *   - review trigger
 *   - progress / batch-status / task list / spec serve
 *   - POST /api/tasks (create/update task plan)
 *   - POST /api/tasks/:id/update
 *   - per-task dispatch / bulk dispatch
 *   - dispatch-next / retro
 *   - pipeline templates
 *   - dispatchTask / tryAutoDispatch / redispatchTask (internal functions)
 *   - module.exports.init + countRunningStepsByType / canDispatchStepType
 */
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const { json } = bb;
const { participantById, pushMessage, getUserIdForTask, requireRole, createSignal } = require('./_shared');
const routeEngine = require('../route-engine');
const worktreeHelper = require('../worktree');
const { runHook } = require('../hook-runner');
const { resolveRepoRoot, validateRepoRoot } = require('../repo-resolver');
const { BLOCKER_TYPES, shouldUnblockOnReset } = require('../blocker-types');

// Sub-route modules
const tasksStepsRoutes = require('./tasks-steps');
const tasksLifecycleRoutes = require('./tasks-lifecycle');
const tasksConfidenceRoutes = require('./tasks-confidence');

// Re-export lifecycle helpers used by dispatchTask
const { killAndCancelSteps, scheduleWorktreeCleanup, cancelTaskFlow, removeTask } = tasksLifecycleRoutes;

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

// --- Auto Re-dispatch ---
function redispatchTask(board, task, deps, helpers) {
  const { mgmt } = deps;
  const assignee = participantById(board, task.assignee);
  if (!assignee || assignee.type !== 'agent') {
    console.log(`[redispatch:${task.id}] skip: assignee ${task.assignee} is not an agent`);
    return;
  }

  try { mgmt.ensureTaskTransition(task.status, 'in_progress'); }
  catch { console.log(`[redispatch:${task.id}] skip: cannot transition ${task.status} → in_progress`); return; }

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

// --- Per-step-type concurrency helpers ---
function countRunningStepsByType(stepType, board) {
  let count = 0;
  const tasks = board?.taskPlan?.tasks || [];
  for (let i = 0; i < tasks.length; i++) {
    const steps = tasks[i].steps;
    if (!steps) continue;
    for (let j = 0; j < steps.length; j++) {
      if (steps[j].type === stepType && steps[j].state === 'running') {
        count++;
      }
    }
  }
  return count;
}

function canDispatchStepType(stepType, board, mgmt) {
  const ctrl = mgmt.getControls(board);
  const limit = ctrl.max_concurrent_by_type?.[stepType];
  if (!limit) return true;
  const running = countRunningStepsByType(stepType, board);
  return running < limit;
}

// ---------------------------------------------------------------------------
// dispatchTask() — unified dispatch entry point
// ---------------------------------------------------------------------------
const _dispatchLocks = new Map();

function dispatchTask(task, board, deps, helpers, opts = {}) {
  const { mgmt, usage, push, PUSH_TOKENS_PATH } = deps;
  const ctrl = mgmt.getControls(board);
  const taskId = task.id;
  const source = opts.source || 'dispatch';
  const mode = opts.mode || 'dispatch';

  if (_dispatchLocks.has(taskId)) {
    console.log(`[dispatchTask:${taskId}] skip: dispatch already in progress (locked since ${_dispatchLocks.get(taskId)})`);
    return { dispatched: false, reason: 'dispatch already in progress' };
  }
  _dispatchLocks.set(taskId, helpers.nowIso());

  // Hook system: emit dispatch_started
  if (deps.hookSystem) {
    deps.hookSystem.emit('dispatch_started', { taskId, source, mode });
  }

  const assignee = participantById(board, task.assignee);
  if (!assignee || assignee.type !== 'agent') {
    _dispatchLocks.delete(taskId);
    console.log(`[dispatchTask:${taskId}] skip: assignee ${task.assignee} is not an agent`);
    return { dispatched: false, reason: 'assignee not agent' };
  }

  // Usage limits gate
  const ownerId = usage ? mgmt.resolveOwnerId(board) : null;
  if (usage) {
    const usageCheck = usage.enforceUsageLimits(ownerId, board);
    if (!usageCheck.allowed) {
      _dispatchLocks.delete(taskId);
      console.log(`[dispatchTask:${taskId}] skip: usage limit exceeded (${usageCheck.metric}: ${usageCheck.used}/${usageCheck.limit})`);
      helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_blocked', taskId, source, code: 'USAGE_LIMIT_EXCEEDED', metric: usageCheck.metric, used: usageCheck.used, limit: usageCheck.limit });
      return { dispatched: false, code: 'USAGE_LIMIT_EXCEEDED', reason: `usage limit exceeded: ${usageCheck.metric}`, metric: usageCheck.metric, used: usageCheck.used, limit: usageCheck.limit };
    }
  }

  // Budget gate
  if (task.budget && routeEngine.isBudgetExceeded(task.budget)) {
    _dispatchLocks.delete(taskId);
    const remaining = deps.contextCompiler.computeRemainingBudget(task.budget);
    console.log(`[dispatchTask:${taskId}] skip: budget exceeded`);
    task.status = 'blocked';
    task.blocker = {
      type: BLOCKER_TYPES.BUDGET_EXCEEDED,
      reason: 'Budget exceeded before dispatch',
      askedAt: helpers.nowIso(),
      remaining,
    };
    helpers.writeBoard(board);
    helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_blocked', taskId, source, code: 'BUDGET_EXCEEDED', remaining });
    helpers.broadcastSSE('board', board);
    return { dispatched: false, code: 'BUDGET_EXCEEDED', reason: 'budget exceeded', remaining };
  }

  // Phase 1: Worktree
  if (ctrl.use_worktrees) {
    if (task.worktreeDir && !fs.existsSync(task.worktreeDir)) {
      console.log(`[dispatchTask:${taskId}] worktree missing on disk, re-creating`);
      task.worktreeDir = null;
      task.worktreeBranch = null;
    }

    if (!task.worktreeDir) {
      const repoRoot = resolveRepoRoot(task, board) || path.resolve(__dirname, '..', '..');

      const validation = validateRepoRoot(repoRoot, task.source?.repo);
      if (!validation.valid) {
        _dispatchLocks.delete(taskId);
        console.error(`[dispatchTask:${taskId}] repo validation failed: ${validation.error}`);
        task.status = 'blocked';
        task.blocker = {
          type: BLOCKER_TYPES.REPO_ERROR,
          reason: `Repo validation failed: ${validation.error}`,
          askedAt: helpers.nowIso()
        };
        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_blocked', taskId, source, error: validation.error });
        helpers.broadcastSSE('board', board);
        return { dispatched: false, reason: validation.error };
      }

      try {
        const wt = worktreeHelper.createWorktree(repoRoot, taskId);
        task.worktreeDir = wt.worktreePath;
        task.worktreeBranch = wt.branch;
        console.log(`[dispatchTask:${taskId}] worktree: ${wt.worktreePath}`);
        if (ctrl.hooks_after_worktree_create) {
          runHook('hooks_after_worktree_create', ctrl.hooks_after_worktree_create, wt.worktreePath, {
            KARVI_TASK_ID: taskId,
            KARVI_WORKTREE_DIR: wt.worktreePath,
          }).catch(() => {});
        }
      } catch (err) {
        _dispatchLocks.delete(taskId);
        console.error(`[dispatchTask:${taskId}] worktree failed: ${err.message}`);
        task.status = 'blocked';
        task.blocker = {
          type: BLOCKER_TYPES.WORKTREE_ERROR,
          reason: `Worktree creation failed: ${err.message}`,
          askedAt: helpers.nowIso()
        };
        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_blocked', taskId, source, error: err.message });
        helpers.broadcastSSE('board', board);
        return { dispatched: false, reason: err.message };
      }
    }
  }

  // Phase 2: Step pipeline
  if (!deps.stepWorker) {
    _dispatchLocks.delete(taskId);
    console.error(`[dispatchTask:${taskId}] stepWorker not available`);
    return { dispatched: false, reason: 'stepWorker not initialized' };
  }

  const pipeline = task.pipeline || ['execute'];
  const firstStepType = (typeof pipeline[0] === 'string' ? pipeline[0] : pipeline[0]?.type) || 'execute';
  if (!canDispatchStepType(firstStepType, board, mgmt)) {
    _dispatchLocks.delete(taskId);
    const running = countRunningStepsByType(firstStepType, board);
    console.log(`[dispatchTask:${taskId}] skip: ${firstStepType} concurrency ${running}/${ctrl.max_concurrent_by_type?.[firstStepType]}`);
    return { dispatched: false, reason: `${firstStepType} concurrency limit reached` };
  }

  console.log(`[dispatchTask:${taskId}] step-pipeline via ${source}`);
    const runId = helpers.uid('run');
    task.steps = mgmt.generateStepsForTask(task, runId, pipeline, board);
    task._revisionCounts = {};
    task.status = 'in_progress';
    task.startedAt = task.startedAt || helpers.nowIso();
    task.history = task.history || [];
    task.history.push({ ts: helpers.nowIso(), status: 'in_progress', by: source, runtime: 'step-pipeline' });
    if (board.taskPlan) board.taskPlan.phase = 'executing';

    task.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS, ...task.budget?.limits }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };

    mgmt.ensureEvolutionFields(board);
    board.signals.push(createSignal({
      by: source, type: 'steps_created', content: `${taskId} steps created (${task.steps.length})`,
      refs: [taskId], data: { taskId, runId, count: task.steps.length },
    }, null, helpers));
    mgmt.trimSignals(board, helpers.signalArchivePath);

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
      // Record dispatch usage event only on successful envelope build
      if (usage) {
        usage.record(ownerId, 'dispatch', { taskId, source, runtime: ctrl.preferred_runtime || 'openclaw' });
      }
    } else {
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

// --- Auto-dispatch ---
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

  // Usage limits gate
  if (usage) {
    const userId = mgmt.resolveOwnerId(board);
    const usageCheck = usage.enforceUsageLimits(userId, board);
    if (!usageCheck.allowed) {
      console.log(`[auto-dispatch:${taskId}] skip: usage limit exceeded (${usageCheck.metric}: ${usageCheck.used}/${usageCheck.limit})`);
      helpers.appendLog({ ts: helpers.nowIso(), event: 'dispatch_blocked', taskId, source: 'auto-dispatch', code: 'USAGE_LIMIT_EXCEEDED', metric: usageCheck.metric, used: usageCheck.used, limit: usageCheck.limit });
      return;
    }
  }

  const unmetDeps = (task.depends || []).filter(depId => {
    const dep = (board.taskPlan?.tasks || []).find(t => t.id === depId);
    return !dep || dep.status !== 'approved';
  });
  if (unmetDeps.length > 0) {
    console.log(`[auto-dispatch:${taskId}] skip: unmet deps ${unmetDeps.join(', ')}`);
    return;
  }

  const taskWave = task.wave ?? null;
  const activeWave = ctrl.active_wave ?? null;
  if (activeWave !== null && taskWave !== null && taskWave !== activeWave) {
    console.log(`[auto-dispatch:${taskId}] skip: wave ${taskWave} !== active ${activeWave}`);
    return;
  }

  const inProgressCount = (board.taskPlan?.tasks || [])
    .filter(t => t.status === 'in_progress').length;
  if (inProgressCount >= (ctrl.max_concurrent_tasks || 2)) {
    console.log(`[auto-dispatch:${taskId}] skip: ${inProgressCount} tasks in progress (max: ${ctrl.max_concurrent_tasks || 2})`);
    return;
  }

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

  const firstStepType = (typeof (task.pipeline?.[0]) === 'string' ? task.pipeline[0] : task.pipeline?.[0]?.type) || 'execute';
  if (!canDispatchStepType(firstStepType, board, mgmt)) {
    const running = countRunningStepsByType(firstStepType, board);
    console.log(`[auto-dispatch:${taskId}] skip: ${firstStepType} concurrency ${running}/${ctrl.max_concurrent_by_type?.[firstStepType]}`);
    return;
  }

  dispatchTask(task, board, deps, helpers, { source: 'auto-dispatch' });
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
  const { mgmt, runtime, push, usage, ctx, jiraIntegration, digestTask, timelineTask, confidenceEngine, PUSH_TOKENS_PATH, DIR, DATA_DIR } = deps;

  // Internal functions passed to sub-route modules
  const internals = {
    tryAutoDispatch,
    dispatchTask,
    redispatchTask,
    countRunningStepsByType,
  };

  // --- Delegate to sub-route modules (order matters: more specific paths first) ---

  // Confidence / digest / timeline / report
  if (req.url.includes('/digest') || req.url.includes('/confidence') ||
      req.url.includes('/timeline') || req.url.includes('/report')) {
    const handled = tasksConfidenceRoutes(req, res, helpers, deps);
    if (handled !== false) return;
  }

  // Step-level endpoints + sessions
  if (req.url.includes('/steps') || req.url.includes('/sessions')) {
    const handled = tasksStepsRoutes(req, res, helpers, deps, internals);
    if (handled !== false) return;
  }

  // Lifecycle endpoints (cancel, reopen, unblock, status, rollback, delete, cleanup)
  if (req.url.includes('/cancel') || req.url.includes('/reopen') ||
      req.url.includes('/unblock') || req.url.includes('/rollback') ||
      req.url.includes('/cleanup') ||
      (req.url.match(/^\/api\/tasks\/([^/]+)\/status$/) && req.method === 'POST') ||
      (req.url.match(/^\/api\/tasks\/([^/]+)$/) && req.method === 'DELETE')) {
    const handled = tasksLifecycleRoutes(req, res, helpers, deps, internals);
    if (handled !== false) return;
  }

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

  // GET /api/tasks/:id/progress
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

  // GET /api/tasks/batch-status?ids=GH-1,GH-2
  const batchStatusMatch = req.method === 'GET' && req.url.match(/^\/api\/tasks\/batch-status(\?|$)/);
  if (batchStatusMatch) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const idsParam = url.searchParams.get('ids') || '';
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);

      if (ids.length === 0) {
        return json(res, 400, { error: 'ids query parameter required (comma-separated task IDs)' });
      }

      const board = helpers.readBoard();
      const tasks = board.taskPlan?.tasks || [];
      const results = [];

      for (const id of ids) {
        const task = tasks.find(t => t.id === id);
        if (!task) {
          results.push({ id, status: null, stepStates: null, pct: null, error: 'not_found' });
          continue;
        }

        const steps = task.steps || [];
        const stepStates = steps.map(s => ({ step_id: s.step_id, type: s.type, state: s.state }));
        const totalSteps = steps.length;
        const completedSteps = steps.filter(s => s.state === 'succeeded' || s.state === 'dead').length;
        const pct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

        results.push({
          id: task.id,
          status: task.status,
          stepStates,
          pct,
        });
      }

      return json(res, 200, { tasks: results });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // GET /api/tasks
  if (req.method === 'GET' && req.url.startsWith('/api/tasks') &&
      !req.url.includes('/steps') &&
      !req.url.includes('/digest') &&
      !req.url.includes('/timeline') &&
      !req.url.includes('/report') &&
      !req.url.includes('/confidence') &&
      !req.url.includes('/batch-status') &&
      !req.url.includes('/progress')) {
    try {
      const board = helpers.readBoard();
      return json(res, 200, board.taskPlan || {});
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // Serve spec files
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

  // POST /api/tasks — create task plan
  if (req.method === 'POST' && req.url === '/api/tasks') {
    helpers.parseBody(req).then(payload => {
        const board = helpers.readBoard();

        board.taskPlan = board.taskPlan || { tasks: [] };
        board.taskPlan.tasks = board.taskPlan.tasks || [];

        if (payload.goal) board.taskPlan.goal = String(payload.goal);
        if (payload.phase) board.taskPlan.phase = String(payload.phase);
        if (!board.taskPlan.createdAt) board.taskPlan.createdAt = payload.createdAt || helpers.nowIso();

        const ACTIVE_STATUSES = ['in_progress', 'dispatched'];
        const SAFE_FIELDS = ['title', 'description', 'assignee', 'depends', 'spec', 'skill', 'estimate', 'target_repo', 'scope', 'wave'];
        const incomingTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        const existingIds = new Set(board.taskPlan.tasks.map(t => t.id));
        for (const t of incomingTasks) {
          if (existingIds.has(t.id)) {
            const existing = board.taskPlan.tasks.find(e => e.id === t.id);
            if (existing && !ACTIVE_STATUSES.includes(existing.status)) {
              for (const k of SAFE_FIELDS) {
                if (t[k] !== undefined) {
                  if (k === 'wave') {
                    if (t.wave !== null && (typeof t.wave !== 'number' || !Number.isInteger(t.wave) || t.wave < 0)) {
                      continue;
                    }
                  }
                  existing[k] = t[k];
                }
              }
              existing.history = existing.history || [];
              existing.history.push({ ts: helpers.nowIso(), status: 'updated', by: 'api' });
            }
            continue;
          }
          const newTask = {
            id: t.id,
            title: t.title,
            description: t.description || '',
            assignee: t.assignee || null,
            depends: t.depends || [],
            status: (t.depends?.length > 0) ? 'pending' : 'dispatched',
            spec: t.spec || null,
            skill: t.skill || null,
            estimate: t.estimate || null,
            target_repo: t.target_repo || null,
            wave: (t.wave !== undefined && t.wave !== null && typeof t.wave === 'number' && Number.isInteger(t.wave) && t.wave >= 0) ? t.wave : null,
            history: [{ ts: helpers.nowIso(), status: (t.depends?.length > 0) ? 'pending' : 'dispatched', reason: 'api_created' }],
          };
          if (t.scope) newTask.scope = t.scope;
          board.taskPlan.tasks.push(newTask);

          // Hook system: emit task_created
          if (deps.hookSystem) {
            deps.hookSystem.emit('task_created', { taskId: newTask.id, task: newTask });
          }
        }

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'taskPlan_updated', goal: board.taskPlan.goal });

        const ctrl = mgmt.getControls(board);
        if (ctrl.auto_dispatch) {
          for (const t of (board.taskPlan?.tasks || [])) {
            if (t.status === 'dispatched') {
              setImmediate(() => tryAutoDispatch(t.id, deps, helpers));
            }
          }
        }

        json(res, 200, { ok: true, taskPlan: board.taskPlan });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  // POST /api/tasks/:id/update
  const taskUpdateMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/update$/);
  if (req.method === 'POST' && taskUpdateMatch) {
    if (requireRole(req, res, 'operator')) return;
    const taskId = decodeURIComponent(taskUpdateMatch[1]);
    helpers.parseBody(req).then(payload => {
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
          task.blocker = {
            type: BLOCKER_TYPES.UNKNOWN,
            reason: 'Unknown block',
            askedAt: helpers.nowIso()
          };
        }

        if (payload.status === 'approved') {
          const unlocked = mgmt.autoUnlockDependents(board);
          for (const id of unlocked) {
            setImmediate(() => tryAutoDispatch(id, deps, helpers));
          }
        }

        if (payload.status === 'dispatched') {
          setImmediate(() => tryAutoDispatch(task.id, deps, helpers));
        }

        if (payload.status) {
          mgmt.ensureEvolutionFields(board);
          board.signals.push(createSignal({
            type: 'status_change',
            content: `${task.id} ${oldStatus} → ${task.status}`,
            refs: [task.id],
            data: { taskId: task.id, from: oldStatus, to: task.status, assignee: task.assignee },
          }, req, helpers));
          mgmt.trimSignals(board, helpers.signalArchivePath);
        }

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'task_updated', taskId, status: task.status });

        if (jiraIntegration?.isEnabled(board)) {
          jiraIntegration.notifyJira(board, task, { type: 'status_change', newStatus: task.status })
            .catch(err => console.error('[jira] notify failed:', err.message));
        }

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
                if (confidenceEngine) {
                  try {
                    confidenceEngine.triggerConfidence(taskId, 'review_completed', {
                      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
                      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
                    });
                  } catch (err) { console.error(`[confidence:${taskId}] error:`, err.message); }
                }
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

        if (payload.status === 'approved' && confidenceEngine) {
          try {
            confidenceEngine.triggerConfidence(taskId, 'approved', {
              readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
              broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
            });
          } catch (err) { console.error(`[confidence:${taskId}] error:`, err.message); }
        }
        if (payload.status === 'approved' && digestTask?.isDigestEnabled()) {
          setImmediate(() => {
            digestTask.triggerDigest(taskId, 'approved', {
              readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
              broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
            }).catch(err => console.error(`[digest:${taskId}] error:`, err.message));
          });
        }

        json(res, 200, { ok: true, task });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  // --- Per-task dispatch ---
  const taskDispatchMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/dispatch(\?|$)/);
  if (req.method === 'POST' && taskDispatchMatch) {
    if (requireRole(req, res, 'operator')) return;
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

      const conv = board.conversations?.[0];
      if (conv) {
        pushMessage(conv, {
          id: helpers.uid('msg'), ts: helpers.nowIso(), type: 'system',
          from: 'human', to: task.assignee,
          text: `[Dispatch ${task.id}] ${task.title} → ${assignee.displayName}`,
        });
      }

      const result = dispatchTask(task, board, deps, helpers, { source: 'dispatch', runtimeOverride });
      if (result.code === 'BUDGET_EXCEEDED') {
        return json(res, 409, { error: 'Budget exceeded', code: result.code, remaining: result.remaining });
      }
      if (result.code === 'USAGE_LIMIT_EXCEEDED') {
        return json(res, 409, { error: 'Usage limit exceeded', code: result.code, metric: result.metric, used: result.used, limit: result.limit });
      }
      json(res, 200, { ok: true, taskId, dispatched: result.dispatched, planId: result.planId });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- Bulk dispatch ---
  const dispatchMatch = req.url.match(/^\/api\/tasks\/dispatch$/);
  if (req.method === 'POST' && dispatchMatch) {
    if (requireRole(req, res, 'operator')) return;
    try {
      const board = helpers.readBoard();

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

  // --- S6: dispatch-next ---
  if (req.method === 'POST' && req.url === '/api/dispatch-next') {
    if (requireRole(req, res, 'operator')) return;
    try {
      const board = helpers.readBoard();
      const task = mgmt.pickNextTask(board);

      if (!task) {
        helpers.writeBoard(board);
        helpers.broadcastSSE('board', board);
        return json(res, 200, { ok: true, dispatched: false, reason: 'no ready tasks' });
      }

      const result = dispatchTask(task, board, deps, helpers, { source: 'dispatch-next' });
      if (result.code === 'BUDGET_EXCEEDED') {
        return json(res, 409, { error: 'Budget exceeded', code: result.code, taskId: task.id, remaining: result.remaining });
      }
      if (result.code === 'USAGE_LIMIT_EXCEEDED') {
        return json(res, 409, { error: 'Usage limit exceeded', code: result.code, taskId: task.id, metric: result.metric, used: result.used, limit: result.limit });
      }
      return json(res, 202, { ok: true, dispatched: result.dispatched, taskId: task.id, planId: result.planId });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // --- Retro ---
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

  // --- Pipeline Templates ---

  if (req.method === 'GET' && req.url === '/api/pipeline-templates/built-in') {
    json(res, 200, mgmt.BUILT_IN_TEMPLATES);
    return;
  }

  const templatesMatch = req.url.match(/^\/api\/pipeline-templates(?:\/([^/?]+))?$/);

  if (req.method === 'GET' && templatesMatch && !templatesMatch[1]) {
    const board = helpers.readBoard();
    const merged = Object.assign({}, mgmt.BUILT_IN_TEMPLATES, board.pipelineTemplates || {});
    json(res, 200, merged);
    return;
  }

  if (req.method === 'PUT' && templatesMatch && templatesMatch[1]) {
    const name = decodeURIComponent(templatesMatch[1]);
    helpers.parseBody(req).then(payload => {
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
        board.signals.push(createSignal({
          type: 'pipeline_template_updated', content: `Template "${name}" updated (${normalized.length} steps)`,
          refs: [], data: { name, count: normalized.length },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);
        helpers.writeBoard(board);
        json(res, 200, { ok: true, name, pipeline: normalized });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  if (req.method === 'DELETE' && templatesMatch && templatesMatch[1]) {
    const name = decodeURIComponent(templatesMatch[1]);
    const board = helpers.readBoard();
    if (!board.pipelineTemplates || !board.pipelineTemplates[name]) {
      return json(res, 404, { error: `Template "${name}" not found` });
    }
    delete board.pipelineTemplates[name];
    mgmt.ensureEvolutionFields(board);
    board.signals.push(createSignal({
      type: 'pipeline_template_deleted', content: `Template "${name}" deleted`,
      refs: [], data: { name },
    }, req, helpers));
    mgmt.trimSignals(board, helpers.signalArchivePath);
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

module.exports.countRunningStepsByType = countRunningStepsByType;
module.exports.canDispatchStepType = canDispatchStepType;
