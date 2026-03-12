/**
 * routes/tasks.js — Task Engine APIs
 *
 * POST /api/tasks/:id/review — manual review trigger
 * POST /api/tasks/:id/reopen — reopen completed task with session continuation
 * POST /api/tasks/:id/cancel — cancel task, stop running step, cleanup worktree
 * POST /api/tasks/:id/rollback — rollback task: git revert + state reset to pending
 * GET  /api/tasks — task list
 * GET  /api/spec/:file — serve spec files
 * POST /api/tasks — create task plan
 * POST /api/tasks/:id/update — update task fields
 * POST /api/tasks/:id/unblock — unblock task
 * POST /api/tasks/:id/status — manual status control
 * POST /api/tasks/:id/dispatch — per-task dispatch
 * POST /api/tasks/dispatch — bulk dispatch
 * DELETE /api/tasks/:id — remove task from board
 * POST /api/tasks/cleanup — batch remove tasks by status/age
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
const { participantById, pushMessage, getUserIdForTask, requireRole, createSignal } = require('./_shared');
const routeEngine = require('../route-engine');
const worktreeHelper = require('../worktree');
const { resolveRepoRoot, validateRepoRoot } = require('../repo-resolver');
const { BLOCKER_TYPES, shouldUnblockOnReset } = require('../blocker-types');

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

/**
 * Kill running steps and cancel non-completed steps for a task.
 * Returns { killedSteps, cancelledSteps }.
 */
function killAndCancelSteps(task, deps, reason, logPrefix = 'tasks') {
  let killedSteps = 0;
  let cancelledSteps = 0;
  for (const step of (task.steps || [])) {
    if (step.state === 'running') {
      try {
        const killResult = deps.stepWorker?.killStep?.(step.step_id);
        if (killResult?.ok) killedSteps++;
      } catch (err) {
        console.error(`[${logPrefix}] killStep failed for ${task.id}/${step.step_id}:`, err.message);
      }
      deps.stepSchema.transitionStep(step, 'cancelled', { error: reason });
      cancelledSteps++;
    } else if (step.state === 'cancelling' || step.state === 'queued' || step.state === 'failed') {
      deps.stepSchema.transitionStep(step, 'cancelled', { error: reason });
      cancelledSteps++;
    }
  }
  return { killedSteps, cancelledSteps };
}

/**
 * Schedule worktree cleanup with delay + retry for Windows file-handle races.
 * Clears task.worktreeDir/worktreeBranch immediately.
 * Returns { attempted, scheduled }.
 */
function scheduleWorktreeCleanup(task, board, logPrefix = 'tasks') {
  if (!task.worktreeDir) return { attempted: false, scheduled: false };
  const repoRoot = resolveRepoRoot(task, board) || path.resolve(__dirname, '..', '..');
  const cleanTaskId = task.id;
  task.worktreeDir = null;
  task.worktreeBranch = null;
  setTimeout(() => {
    try {
      worktreeHelper.removeWorktree(repoRoot, cleanTaskId);
      console.log(`[${logPrefix}] worktree cleaned up for ${cleanTaskId}`);
    } catch (err) {
      console.error(`[${logPrefix}] worktree cleanup failed for ${cleanTaskId}:`, err.message);
      setTimeout(() => {
        try {
          worktreeHelper.removeWorktree(repoRoot, cleanTaskId);
        } catch (err2) {
          console.error(`[${logPrefix}] worktree cleanup retry failed for ${cleanTaskId}:`, err2.message);
        }
      }, 15000);
    }
  }, 3000);
  return { attempted: true, scheduled: true };
}

/**
 * Shared task cancellation flow for both:
 * - POST /api/tasks/:id/status { status: "cancelled" }
 * - POST /api/tasks/:id/cancel
 */
function cancelTaskFlow(task, board, deps, helpers, opts = {}) {
  const oldStatus = opts.oldStatus || task.status;
  const reason = String(opts.reason || 'Task cancelled').trim() || 'Task cancelled';
  const by = opts.by || 'human';

  task.status = 'cancelled';
  task.completedAt = helpers.nowIso();
  task.blocker = null;
  task.history = task.history || [];
  task.history.push({
    ts: helpers.nowIso(),
    status: 'cancelled',
    from: oldStatus,
    by,
    ...(opts.reason ? { reason: String(opts.reason).slice(0, 240) } : {}),
  });

  const { killedSteps, cancelledSteps } = killAndCancelSteps(task, deps, reason, 'cancel');
  const worktreeCleanup = scheduleWorktreeCleanup(task, board, 'cancel');

  return { killedSteps, cancelledSteps, worktreeCleanup };
}

/**
 * Remove a task from board entirely.
 * Cancels running steps, cleans worktree, archives to task-log, splices from array.
 */
function removeTask(board, taskId, deps, helpers) {
  const tasks = board.taskPlan?.tasks || [];
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;
  const task = tasks[idx];

  // Cancel running steps first (if not already terminal)
  if (task.status !== 'cancelled' && task.status !== 'approved') {
    cancelTaskFlow(task, board, deps, helpers, { reason: 'Task removed' });
  }

  // Worktree cleanup (if cancelTaskFlow didn't already handle it)
  if (task.worktreeDir) {
    const repoRoot = resolveRepoRoot(task, board) || path.resolve(__dirname, '..', '..');
    task.worktreeDir = null;
    task.worktreeBranch = null;
    setTimeout(() => {
      try { worktreeHelper.removeWorktree(repoRoot, taskId); }
      catch (e) { console.error(`[tasks] removeTask worktree cleanup failed: ${e.message}`); }
    }, 3000);
  }

  // Archive to task-log before removal
  helpers.appendLog({
    ts: helpers.nowIso(),
    event: 'task_removed',
    taskId: task.id,
    finalStatus: task.status,
    title: task.title,
  });

  tasks.splice(idx, 1);
  return task;
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

  // --- Budget gate: reject if task budget already exhausted ---
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

  // --- Phase 1: Worktree (ensure exists on disk) ---
  if (ctrl.use_worktrees) {
    // Validate worktree exists on disk (may have been manually deleted)
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

  // --- Phase 2: Step pipeline (always — legacy path removed in GH-218) ---
  if (!deps.stepWorker) {
    _dispatchLocks.delete(taskId);
    console.error(`[dispatchTask:${taskId}] stepWorker not available`);
    return { dispatched: false, reason: 'stepWorker not initialized' };
  }

  // Per-step-type concurrency check
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
    task._revisionCounts = {};  // Clear stale revision counts from previous runs
    task.status = 'in_progress';
    task.startedAt = task.startedAt || helpers.nowIso();
    task.history = task.history || [];
    task.history.push({ ts: helpers.nowIso(), status: 'in_progress', by: source, runtime: 'step-pipeline' });
    if (board.taskPlan) board.taskPlan.phase = 'executing';

    // Always reset budget on (re-)dispatch — previous run's usage must not carry over
    task.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS, ...task.budget?.limits }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };


    mgmt.ensureEvolutionFields(board);
    board.signals.push(createSignal({
      by: source, type: 'steps_created', content: `${taskId} steps created (${task.steps.length})`,
      refs: [taskId], data: { taskId, runId, count: task.steps.length },
    }, req, helpers));
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

  // Wave filter: only dispatch if task wave matches active_wave
  const taskWave = task.wave ?? null;
  const activeWave = ctrl.active_wave ?? null;
  if (activeWave !== null && taskWave !== null && taskWave !== activeWave) {
    console.log(`[auto-dispatch:${taskId}] skip: wave ${taskWave} !== active ${activeWave}`);
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

  // Per-step-type concurrency gate
  const firstStepType = (typeof (task.pipeline?.[0]) === 'string' ? task.pipeline[0] : task.pipeline?.[0]?.type) || 'execute';
  if (!canDispatchStepType(firstStepType, board, mgmt)) {
    const running = countRunningStepsByType(firstStepType, board);
    console.log(`[auto-dispatch:${taskId}] skip: ${firstStepType} concurrency ${running}/${ctrl.max_concurrent_by_type?.[firstStepType]}`);
    return;
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
          task.blocker = {
            type: BLOCKER_TYPES.UNKNOWN,
            reason: 'Unknown block',
            askedAt: helpers.nowIso()
          };
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

        // Evolution Layer: emit status_change signal with attribution
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

  const reopenMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/reopen$/);
  if (req.method === 'POST' && reopenMatch) {
    const taskId = decodeURIComponent(reopenMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const message = String(payload.message || '').trim();
        const customSteps = payload.steps;
        
        const REOPENABLE_STATUSES = ['approved', 'needs_revision', 'blocked', 'completed'];
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        if (!REOPENABLE_STATUSES.includes(task.status)) {
          return json(res, 400, { error: `Cannot reopen task in ${task.status} status. Allowed: ${REOPENABLE_STATUSES.join(', ')}` });
        }
        if (!task.childSessionKey) {
          return json(res, 400, { error: 'No session to resume (childSessionKey missing)' });
        }
        
        const oldStatus = task.status;
        task.status = 'in_progress';
        delete task.result;
        delete task.completedAt;
        delete task.blocker;
        
        const runId = helpers.uid('run');
        const stepTypes = customSteps || ['implement', 'review'];
        const newSteps = mgmt.generateStepsForTask(task, runId, stepTypes, board);
        task.steps = task.steps || [];
        task.steps.push(...newSteps);
        task._revisionCounts = {};
        
        task.history = task.history || [];
        task.history.push({
          ts: helpers.nowIso(),
          status: 'in_progress',
          reopened_from: oldStatus,
          by: 'human',
          message: message || '(no message)'
        });
        
        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'task_reopened',
          content: `${taskId} reopened from ${oldStatus}`,
          refs: [taskId],
          data: { taskId, from: oldStatus, runId, steps: newSteps.map(s => s.step_id) },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);
        
        helpers.writeBoard(board);
        helpers.appendLog({ 
          ts: helpers.nowIso(), 
          event: 'task_reopened', 
          taskId, 
          from: oldStatus, 
          runId,
          stepCount: newSteps.length 
        });
        
        const result = dispatchTask(task, board, deps, helpers, { source: 'reopen' });
        
        json(res, 200, { 
          ok: true, 
          task,
          reopened: {
            runId,
            steps: newSteps.map(s => s.step_id),
            sessionId: task.childSessionKey,
            dispatched: result.dispatched
          }
        });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Task cancel endpoint ---
  const taskCancelMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && taskCancelMatch) {
    if (requireRole(req, res, 'operator')) return;
    const taskId = decodeURIComponent(taskCancelMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const reason = String(payload.reason || '').trim();
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        mgmt.ensureTaskTransition(oldStatus, 'cancelled');
        const cancelMeta = cancelTaskFlow(task, board, deps, helpers, {
          oldStatus,
          reason: reason || 'Task cancelled',
          by: 'human',
        });

        const conv = board.conversations?.[0];
        if (conv) {
          const detail = reason ? `\nreason: ${reason.slice(0, 240)}` : '';
          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] ${oldStatus} → cancelled${detail}`,
          });
        }

        const allApproved = board.taskPlan.tasks.every(t => t.status === 'approved' || t.status === 'cancelled');
        if (allApproved) board.taskPlan.phase = 'done';

        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'status_change',
          content: `${task.id} ${oldStatus} → cancelled`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: 'cancelled', assignee: task.assignee },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'task_cancelled',
          taskId,
          from: oldStatus,
          to: 'cancelled',
          killedSteps: cancelMeta.killedSteps,
          cancelledSteps: cancelMeta.cancelledSteps,
          reason: reason || null,
          worktreeCleanup: cancelMeta.worktreeCleanup,
        });

        if (jiraIntegration?.isEnabled(board)) {
          jiraIntegration.notifyJira(board, task, { type: 'status_change', newStatus: 'cancelled' })
            .catch(err => console.error('[jira] notify failed:', err.message));
        }

        if (push && PUSH_TOKENS_PATH) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'task.cancelled')
            .catch(err => console.error('[push] notify failed:', err.message));
          if (allApproved) {
            push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'all.approved')
              .catch(err => console.error('[push] all-approved notify failed:', err.message));
          }
        }

        json(res, 200, {
          ok: true,
          taskId,
          task,
          cancelled: {
            from: oldStatus,
            reason: reason || null,
            killedSteps: cancelMeta.killedSteps,
            cancelledSteps: cancelMeta.cancelledSteps,
            worktreeCleanup: cancelMeta.worktreeCleanup,
          },
        });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Per-task manual status control ---
  const taskStatusMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === 'POST' && taskStatusMatch) {
    if (requireRole(req, res, 'operator')) return;
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
        let cancelMeta = null;
        if (newStatus === 'cancelled') {
          cancelMeta = cancelTaskFlow(task, board, deps, helpers, {
            oldStatus,
            reason: payload.reason || 'Task cancelled',
            by: 'human',
          });
        } else {
          task.status = newStatus;
          task.history = task.history || [];
          task.history.push({ ts: helpers.nowIso(), status: newStatus, from: oldStatus, by: 'human' });
        }

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
          task.blocker = {
            type: payload.blocker?.type || BLOCKER_TYPES.MANUAL,
            reason: payload.reason,
            askedAt: helpers.nowIso()
          };
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

        // Auto-dispatch when task transitions to dispatched
        if (newStatus === 'dispatched') {
          setImmediate(() => tryAutoDispatch(task.id, deps, helpers));
        }

        // Update phase if all tasks approved (cancelled tasks don't block)
        const allApproved = board.taskPlan.tasks.every(t => t.status === 'approved' || t.status === 'cancelled');
        if (allApproved) board.taskPlan.phase = 'done';

        // Evolution Layer: emit status_change signal
        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'status_change',
          content: `${task.id} ${oldStatus} → ${newStatus}`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: newStatus, assignee: task.assignee },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'task_status_manual', taskId, from: oldStatus, to: newStatus });
        if (cancelMeta) {
          helpers.appendLog({
            ts: helpers.nowIso(),
            event: 'task_cancelled',
            taskId,
            from: oldStatus,
            to: 'cancelled',
            killedSteps: cancelMeta.killedSteps,
            cancelledSteps: cancelMeta.cancelledSteps,
            reason: payload.reason || null,
            worktreeCleanup: cancelMeta.worktreeCleanup,
          });
        }

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
        board.signals.push(createSignal({
          by: 'kernel', type: 'steps_created', content: `${taskId} steps created (${task.steps.length})`,
          refs: [taskId], data: { taskId, runId, count: task.steps.length },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);
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
        board.signals.push(createSignal({
          by: 'kernel', type: signalType,
          content: `${taskId} step ${stepId} ${oldState} → ${step.state}`,
          refs: [taskId],
          data: { taskId, stepId, from: oldState, to: step.state, attempt: step.attempt },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

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
    if (requireRole(req, res, 'operator')) return;
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

    // Phase 1: transition to cancelling
    deps.stepSchema.transitionStep(step, 'cancelling', { error: 'Killed by user' });

    // Emit signal
    mgmt.ensureEvolutionFields(board);
    board.signals.push(createSignal({
      by: 'user', type: 'step_cancelling',
      content: `${taskId} step ${stepId} running → cancelling (kill requested)`,
      refs: [taskId],
      data: { taskId, stepId, from: 'running', to: 'cancelling' },
    }, req, helpers));
    mgmt.trimSignals(board, helpers.signalArchivePath);

    helpers.writeBoard(board);
    helpers.appendLog({ ts: helpers.nowIso(), event: 'step_kill_requested', taskId, stepId });

    // Guard timer removed — step-worker catch block handles cancelling -> cancelled
    // (step-worker is closer to the action and has the KILL_GUARD_MS safety net)

    return json(res, 200, { ok: true, step_id: stepId, new_state: 'cancelling' });
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

    // Unblock task only if it was blocked due to dead_letter (not dependency blocks)
    let taskUnblocked = false;
    if (task.status === 'blocked' && shouldUnblockOnReset(task.blocker)) {
      task.status = 'in_progress';
      task.blocker = null;
      taskUnblocked = true;
      task.history = task.history || [];
      task.history.push({ ts: helpers.nowIso(), status: 'in_progress', from: 'blocked', by: 'step_reset' });
    }

    // Emit signal
    mgmt.ensureEvolutionFields(board);
    board.signals.push(createSignal({
      by: 'user', type: 'step_reset',
      content: `${taskId} step ${stepId} ${fromState} → queued (reset)`,
      refs: [taskId],
      data: { taskId, stepId, from: fromState, to: 'queued', taskUnblocked },
    }, req, helpers));
    mgmt.trimSignals(board, helpers.signalArchivePath);

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
    if (requireRole(req, res, 'operator')) return;
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

        // Budget gate: reject if task budget already exhausted
        if (task.budget && routeEngine.isBudgetExceeded(task.budget)) {
          const remaining = deps.contextCompiler.computeRemainingBudget(task.budget);
          return json(res, 409, { error: 'Budget exceeded', code: 'BUDGET_EXCEEDED', remaining });
        }

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
            
            // Per-step-type concurrency check
            const ctrl = mgmt.getControls(currentBoard);
            if (ctrl.max_concurrent_by_type?.[step.type]) {
              const running = countRunningStepsByType(step.type, currentBoard);
              if (running >= ctrl.max_concurrent_by_type[step.type]) {
                results.push({ step_id: step.step_id, status: 'skipped', reason: `${step.type} concurrency limit (${running}/${ctrl.max_concurrent_by_type[step.type]})` });
                continue;
              }
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
      if (result.code === 'BUDGET_EXCEEDED') {
        return json(res, 409, { error: 'Budget exceeded', code: result.code, remaining: result.remaining });
      }
      json(res, 200, { ok: true, taskId, dispatched: result.dispatched, planId: result.planId });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- Bulk dispatch: notify Nox (Lead) to dispatch tasks via sessions_spawn ---
  const dispatchMatch = req.url.match(/^\/api\/tasks\/dispatch$/);
  if (req.method === 'POST' && dispatchMatch) {
    if (requireRole(req, res, 'operator')) return;
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
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    try {
      confidenceEngine.triggerConfidence(taskId, 'manual', {
        readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
        broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
      });
      const updated = helpers.readBoard();
      const updatedTask = (updated.taskPlan?.tasks || []).find(t => t.id === taskId);
      return json(res, 200, { ok: true, taskId, confidence: updatedTask?.confidence || null });
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
    if (requireRole(req, res, 'operator')) return;
    try {
      const board = helpers.readBoard();
      const task = mgmt.pickNextTask(board);

      if (!task) {
        helpers.writeBoard(board); // autoUnlockDependents may have changed board
        helpers.broadcastSSE('board', board);
        return json(res, 200, { ok: true, dispatched: false, reason: 'no ready tasks' });
      }

      const result = dispatchTask(task, board, deps, helpers, { source: 'dispatch-next' });
      if (result.code === 'BUDGET_EXCEEDED') {
        return json(res, 409, { error: 'Budget exceeded', code: result.code, taskId: task.id, remaining: result.remaining });
      }
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

  // GET /api/pipeline-templates/built-in — 列出所有內建範本
  if (req.method === 'GET' && req.url === '/api/pipeline-templates/built-in') {
    json(res, 200, mgmt.BUILT_IN_TEMPLATES);
    return;
  }

  const templatesMatch = req.url.match(/^\/api\/pipeline-templates(?:\/([^/?]+))?$/);

  // GET /api/pipeline-templates — list all templates (user + built-in merged)
  if (req.method === 'GET' && templatesMatch && !templatesMatch[1]) {
    const board = helpers.readBoard();
    const merged = Object.assign({}, mgmt.BUILT_IN_TEMPLATES, board.pipelineTemplates || {});
    json(res, 200, merged);
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
        board.signals.push(createSignal({
          type: 'pipeline_template_updated', content: `Template "${name}" updated (${normalized.length} steps)`,
          refs: [], data: { name, count: normalized.length },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);
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
    board.signals.push(createSignal({
      type: 'pipeline_template_deleted', content: `Template "${name}" deleted`,
      refs: [], data: { name },
    }, req, helpers));
    mgmt.trimSignals(board, helpers.signalArchivePath);
    helpers.writeBoard(board);
    json(res, 200, { ok: true, name, deleted: true });
    return;
  }

  // --- POST /api/tasks/:id/rollback — git revert + state reset to pending ---
  const taskRollbackMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/rollback$/);
  if (req.method === 'POST' && taskRollbackMatch) {
    const taskId = decodeURIComponent(taskRollbackMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const reason = String(payload.reason || '').trim();
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        if (oldStatus === 'pending' || oldStatus === 'cancelled') {
          return json(res, 400, { error: `Cannot rollback task in ${oldStatus} state` });
        }

        // --- Phase 1: Kill running steps ---
        const { killedSteps, cancelledSteps } = killAndCancelSteps(task, deps, reason || 'Task rolled back', `rollback:${taskId}`);

        // --- Phase 2: Git revert (best-effort) ---
        let gitResult = { reverted: false, commits_reverted: 0, branch: null, error: null };
        if (task.worktreeDir && fs.existsSync(task.worktreeDir)) {
          const { execFileSync } = require('child_process'); // inline — only used by rollback
          gitResult.branch = task.worktreeBranch || null;
          try {
            // Count commits on branch since diverging from main
            const logOutput = execFileSync('git', ['log', 'main..HEAD', '--format=%H'], {
              cwd: task.worktreeDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
            }).trim();
            const commits = logOutput ? logOutput.split('\n').filter(Boolean) : [];
            if (commits.length > 0) {
              // Revert all commits in one go (newest first — git revert handles ordering)
              execFileSync('git', ['revert', '--no-edit', 'main..HEAD'], {
                cwd: task.worktreeDir, timeout: 30000, stdio: 'pipe',
              });
              gitResult.reverted = true;
              gitResult.commits_reverted = commits.length;
              console.log(`[rollback:${taskId}] reverted ${commits.length} commit(s) on ${gitResult.branch}`);
            }
          } catch (err) {
            gitResult.error = err.message;
            console.error(`[rollback:${taskId}] git revert failed:`, err.message);
            // Abort any in-progress revert to leave worktree clean
            try {
              execFileSync('git', ['revert', '--abort'], {
                cwd: task.worktreeDir, timeout: 5000, stdio: 'pipe',
              });
            } catch { /* revert wasn't in progress, ignore */ }
          }
        }

        // --- Phase 3: Worktree cleanup (delayed for Windows file handles) ---
        const worktreeCleanup = scheduleWorktreeCleanup(task, board, `rollback:${taskId}`);

        // --- Phase 4: Reset board state ---
        task.status = 'pending';
        task.steps = [];
        task.completedAt = null;
        task.startedAt = null;
        task.reviewAttempts = 0;
        task.blocker = null;
        delete task.review;
        task.history = task.history || [];
        task.history.push({
          ts: helpers.nowIso(),
          status: 'pending',
          from: oldStatus,
          by: 'human',
          action: 'rollback',
          ...(reason ? { reason: reason.slice(0, 240) } : {}),
        });

        // --- Phase 5: Signal + persist ---
        const conv = board.conversations?.[0];
        if (conv) {
          const detail = reason ? `\nreason: ${reason.slice(0, 240)}` : '';
          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] rolled back: ${oldStatus} → pending${detail}`,
          });
        }

        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'task_rolled_back',
          content: `${task.id} ${oldStatus} → pending (rollback)`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: 'pending', reason: reason || null },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'task_rolled_back',
          taskId,
          from: oldStatus,
          to: 'pending',
          killedSteps,
          cancelledSteps,
          git: gitResult,
          worktreeCleanup,
          reason: reason || null,
        });
        helpers.broadcastSSE('board', board);

        if (push && PUSH_TOKENS_PATH) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'task.rolled_back')
            .catch(err => console.error('[push] rollback notify failed:', err.message));
        }

        json(res, 200, {
          ok: true,
          taskId,
          task,
          rollback: {
            from: oldStatus,
            to: 'pending',
            git: gitResult,
            killedSteps,
            cancelledSteps,
            worktreeCleanup,
            reason: reason || null,
          },
        });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- DELETE /api/tasks/:id — remove task from board ---
  const deleteTaskMatch = req.url.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteTaskMatch) {
    if (requireRole(req, res, 'admin')) return;
    const taskId = decodeURIComponent(deleteTaskMatch[1]);
    const board = helpers.readBoard();
    const removed = removeTask(board, taskId, deps, helpers);
    if (!removed) return json(res, 404, { error: `Task ${taskId} not found` });
    helpers.writeBoard(board);
    helpers.broadcastSSE('board', board);
    return json(res, 200, { removed: taskId, finalStatus: removed.status });
  }

  // --- POST /api/tasks/cleanup — batch remove tasks by status/age ---
  if (req.method === 'POST' && req.url === '/api/tasks/cleanup') {
    if (requireRole(req, res, 'admin')) return;
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const statuses = payload.statuses || ['cancelled', 'blocked'];
        const olderThanHours = payload.older_than_hours || 0;
        const board = helpers.readBoard();
        const now = Date.now();
        const cutoff = olderThanHours > 0 ? now - (olderThanHours * 3600_000) : now;

        const toRemove = (board.taskPlan?.tasks || []).filter(t => {
          if (!statuses.includes(t.status)) return false;
          // For blocked: only remove if ALL steps are dead/cancelled (no active steps)
          if (t.status === 'blocked') {
            const hasRunning = (t.steps || []).some(s => s.state === 'running');
            if (hasRunning) return false;
          }
          if (olderThanHours <= 0) return true;
          const ts = t.completedAt || t.startedAt || t.createdAt;
          if (!ts) return true;
          return new Date(ts).getTime() <= cutoff;
        });

        const removedIds = [];
        for (const t of toRemove) {
          removeTask(board, t.id, deps, helpers);
          removedIds.push(t.id);
        }

        if (removedIds.length > 0) {
          helpers.writeBoard(board);
          helpers.broadcastSSE('board', board);
        }
        json(res, 200, { removed: removedIds, count: removedIds.length });
      } catch (err) {
        json(res, 500, { error: err.message });
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
  deps.dispatchTask = (task, board2, opts) => dispatchTask(task, board2, deps, helpers, opts);
};

module.exports.countRunningStepsByType = countRunningStepsByType;
module.exports.canDispatchStepType = canDispatchStepType;
