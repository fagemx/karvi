/**
 * routes/tasks-steps.js — Step-level endpoints
 *
 * POST   /api/tasks/:id/steps — create step pipeline
 * GET    /api/tasks/:id/steps — list steps
 * PATCH  /api/tasks/:id/steps/:stepId — update step state
 * POST   /api/tasks/:id/steps/:stepId/kill — kill running step
 * POST   /api/tasks/:id/steps/:stepId/reset — reset dead/failed step to queued
 * POST   /api/tasks/:id/steps/dispatch-batch — dispatch multiple steps
 */
const { json } = require('../blackboard-server');
const { requireRole, createSignal } = require('./_shared');
const routeEngine = require('../route-engine');
const { shouldUnblockOnReset } = require('../blocker-types');

function tasksStepsRoutes(req, res, helpers, deps, internals) {
  const { mgmt, confidenceEngine, digestTask } = deps;
  const { tryAutoDispatch, countRunningStepsByType } = internals;

  // --- Step-level endpoints ---

  const stepsCreateMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/steps$/);

  // POST /api/tasks/:id/steps — create step pipeline for a task
  if (req.method === 'POST' && stepsCreateMatch) {
    const taskId = decodeURIComponent(stepsCreateMatch[1]);
    helpers.parseBody(req).then(payload => {
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
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
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
    helpers.parseBody(req).then(payload => {
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
        const signal = { type: signalType, data: { taskId, stepId, from: oldState, to: step.state, attempt: step.attempt } };
        if (deps.kernel && (step.state === 'succeeded' || step.state === 'dead')) {
          setImmediate(() => {
            deps.kernel.onStepEvent(signal, helpers.readBoard(), helpers)
              .catch(err => console.error('[kernel] onStepEvent error:', err.message));
          });
        }

        json(res, 200, { ok: true, taskId, step });
    }).catch(error => {
        const status = error.statusCode === 413 ? 413 : (error.code === 'INVALID_STEP_TRANSITION' ? 400 : 500);
        json(res, status, { error: error.message });
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
    helpers.parseBody(req).then(async payload => {
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

            const output = await deps.stepWorker.executeStep(envelope, helpers.readBoard(), helpers);
            results.push({ step_id: step.step_id, status: output.status });
          } catch (err) {
            results.push({ step_id: step.step_id, status: 'error', error: err.message });
          }
        }
        json(res, 200, { ok: true, taskId, dispatched: targets.length, results });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 500, { error: error.message }));
    return;
  }

  return false; // not handled
}

module.exports = tasksStepsRoutes;
