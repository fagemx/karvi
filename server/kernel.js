/**
 * kernel.js — Self-driving kernel event loop
 *
 * Listens for step lifecycle events (step_completed, step_dead, step_failed)
 * and auto-routes to the next action without human intervention.
 *
 * Core principle: Clock = step_completed, not human's next message.
 * UI is just a dashboard.
 */
const routeEngine = require('./route-engine');
const contextCompiler = require('./context-compiler');
const planDispatcher = require('./village/plan-dispatcher');

/**
 * Create the kernel event loop.
 *
 * Depends on deps.stepWorker being set before any step dispatch occurs.
 * See server.js for initialization order and circular dependency notes.
 *
 * @param {object} deps - Shared dependency injection object (mutated after creation)
 */
function createKernel(deps) {
  const { artifactStore, stepSchema, mgmt, push, PUSH_TOKENS_PATH } = deps;

  /**
   * Called after a step transitions to a terminal state (succeeded, dead)
   * or a failure that was auto-requeued. Runs asynchronously via setImmediate.
   *
   * @param {object} signal  - The signal object from board.signals
   * @param {object} board   - Current board snapshot
   * @param {object} helpers - Route helpers (readBoard, writeBoard, appendLog, etc.)
   */
  async function onStepEvent(signal, board, helpers) {
    const { taskId, stepId } = signal.data || {};
    if (!taskId || !stepId) return;

    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task || !task.steps) return;

    const step = task.steps.find(s => s.step_id === stepId);
    if (!step) return;

    // Only act on terminal states
    if (step.state !== 'succeeded' && step.state !== 'dead') return;

    // Initialize budget tracking on first kernel interaction
    if (!task.budget) {
      task.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };
    }
    task.budget.used.steps = (task.budget.used.steps || 0) + 1;

    // Build agent output from step + artifact
    const output = artifactStore.readArtifact(step.run_id, stepId, 'output');
    const agentOutput = {
      run_id: step.run_id,
      step_id: stepId,
      status: step.state === 'succeeded' ? 'succeeded' : 'failed',
      failure: output?.failure || (step.error ? { failure_signature: step.error, retryable: true } : null),
      summary: output?.summary || null,
      error: step.error,
      tokens_used: output?.tokens_used || 0,
    };

    // Update budget with token usage
    if (agentOutput.tokens_used) {
      task.budget.used.tokens = (task.budget.used.tokens || 0) + agentOutput.tokens_used;
    }
    task.budget.used.llm_calls = (task.budget.used.llm_calls || 0) + 1;

    // Route
    const runState = { task, steps: task.steps, run_id: step.run_id, budget: task.budget };
    const decision = routeEngine.decideNext(agentOutput, runState);

    // Log decision
    helpers.appendLog({
      ts: helpers.nowIso(), event: 'route_decision',
      taskId, stepId, action: decision.action, rule: decision.rule,
    });

    // Emit route_decision signal
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (latestTask) latestTask.budget = task.budget;
    mgmt.ensureEvolutionFields(latestBoard);
    latestBoard.signals.push({
      id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'kernel',
      type: 'route_decision',
      content: `${taskId} ${stepId} → ${decision.action} (${decision.rule})`,
      refs: [taskId],
      data: { taskId, stepId, decision },
    });
    if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);

    // Execute decision
    switch (decision.action) {
      case 'next_step': {
        const envelope = contextCompiler.buildEnvelope(decision, runState, deps);
        if (!envelope) break;
        // Write input artifact
        artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'input', envelope);
        // Transition next step to running
        const nextStep = latestTask?.steps?.find(s => s.step_id === envelope.step_id);
        if (nextStep && nextStep.state === 'queued') {
          stepSchema.transitionStep(nextStep, 'running', { locked_by: 'kernel', input_ref: artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'input') });
        }
        // Guard: stepWorker must be initialized before persisting state (see server.js init order)
        if (!deps.stepWorker) {
          console.error('[kernel] deps.stepWorker not initialized — check init order in server.js');
          break;
        }
        helpers.writeBoard(latestBoard);
        // Dispatch async via StepWorker (fire-and-forget, errors logged)
        deps.stepWorker.executeStep(envelope, latestBoard, helpers).catch(err =>
          console.error(`[kernel] executeStep error for ${envelope.step_id}:`, err.message));
        return;  // writeBoard already called
      }

      case 'retry': {
        // Step-schema's transitionStep already handles retry+backoff.
        // Kernel just needs to persist budget update.
        helpers.writeBoard(latestBoard);
        return;
      }

      case 'human_review': {
        if (latestTask) {
          latestTask.blocker = { reason: decision.human_review?.reason || 'Kernel escalated to human', askedAt: helpers.nowIso() };
        }
        latestBoard.signals.push({
          id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'kernel',
          type: 'human_review_needed',
          content: `${taskId} needs human review: ${decision.human_review?.reason || ''}`,
          refs: [taskId],
          data: { taskId, stepId, reason: decision.human_review?.reason },
        });
        helpers.writeBoard(latestBoard);
        // Push notification
        if (push && PUSH_TOKENS_PATH && latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.blocked')
            .catch(err => console.error('[kernel] push error:', err.message));
        }
        return;
      }

      case 'dead_letter': {
        if (latestTask) {
          latestTask.status = 'blocked';
          latestTask.blocker = { reason: `Dead letter: ${decision.rule}`, askedAt: helpers.nowIso() };
        }
        latestBoard.signals.push({
          id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'kernel',
          type: 'task_dead_letter',
          content: `${taskId} dead-lettered: ${decision.rule}`,
          refs: [taskId],
          data: { taskId, stepId, rule: decision.rule },
        });
        helpers.writeBoard(latestBoard);
        if (push && PUSH_TOKENS_PATH && latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.blocked')
            .catch(err => console.error('[kernel] push error:', err.message));
        }
        return;
      }

      case 'done': {
        if (latestTask) {
          // Step pipeline includes review as step[3] — all steps succeeded means approved
          latestTask.status = 'approved';
          latestTask.completedAt = helpers.nowIso();
          // Preserve payload from last step's artifact for downstream access
          const lastStepOutput = artifactStore.readArtifact(step.run_id, stepId, 'output');
          latestTask.result = {
            status: 'approved',
            summary: lastStepOutput?.summary || `All ${task.steps.length} steps succeeded (including review)`,
            payload: lastStepOutput?.payload || null,
          };
        }

        // Unlock dependent tasks (autoUnlockDependents checks for 'approved')
        const unlocked = mgmt.autoUnlockDependents(latestBoard);

        // Village Plan Dispatcher: when a synthesis task completes,
        // parse the plan from its artifact and create execution tasks.
        // Runs server-side (no LLM tokens). Failures are non-blocking.
        if (latestTask && planDispatcher.isSynthesisTask(latestTask)) {
          // Check if auto_approve is enabled (default: true)
          const autoApprove = latestBoard.village?.auto_approve !== false;

          if (autoApprove) {
            // Current behavior: dispatch immediately
            // Push: village.plan_ready — chief's plan is available
            if (push && PUSH_TOKENS_PATH) {
              const cycleId = latestBoard.village?.currentCycle?.cycleId;
              push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.plan_ready', { cycleId })
                .catch(err => console.error('[kernel] village.plan_ready push error:', err.message));
            }
            try {
              const synthArtifact = artifactStore.readArtifact(
                step.run_id, stepId, 'output'
              );
              const planData = planDispatcher.extractPlanFromArtifact(synthArtifact);
              if (planData) {
                planDispatcher.parsePlanAndDispatch(
                  latestBoard, planData, helpers, deps, latestTask
                );
                // parsePlanAndDispatch calls writeBoard internally,
                // so we re-read the board for subsequent operations
              } else {
                console.warn('[kernel] synthesis task completed but no plan found in artifact');
              }
            } catch (err) {
              console.error('[kernel] plan dispatch failed:', err.message);
              // Non-blocking — pipeline continues even if dispatch fails
            }
          } else {
            // Human gate: update cycle phase and wait for manual approval
            if (latestBoard.village?.currentCycle) {
              latestBoard.village.currentCycle.phase = 'awaiting_approval';
            }
            // Push notification: plan ready, needs approval
            if (push && PUSH_TOKENS_PATH) {
              push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.plan_ready', {
                cycleId: latestBoard.village?.currentCycle?.cycleId,
                needsApproval: true,
              }).catch(err => console.error('[kernel] push error:', err.message));
            }
          }
        }

        // Check if all execution tasks for the current village cycle are complete
        if (latestBoard.village?.currentCycle?.phase === 'execution') {
          const cycleId = latestBoard.village.currentCycle.cycleId;
          const execTaskIds = latestBoard.village.currentCycle.executionTaskIds || [];
          if (execTaskIds.length > 0) {
            const allDone = execTaskIds.every(id => {
              const t = (latestBoard.taskPlan?.tasks || []).find(tt => tt.id === id);
              return t && (t.status === 'approved' || t.status === 'blocked');
            });
            if (allDone) {
              // Generate retro signals
              const retro = require('./village/retro');
              const retroSignals = retro.generateRetroSignals(latestBoard, cycleId, helpers);
              latestBoard.signals.push(...retroSignals);

              // Mark cycle as done
              latestBoard.village.currentCycle.phase = 'done';
              latestBoard.village.currentCycle.completedAt = helpers.nowIso();

              // Push notification
              const completedCount = execTaskIds.filter(id => {
                const t = (latestBoard.taskPlan?.tasks || []).find(tt => tt.id === id);
                return t?.status === 'approved';
              }).length;
              if (push && PUSH_TOKENS_PATH) {
                push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.checkin_summary', {
                  cycleId, completed: completedCount, total: execTaskIds.length,
                  blocked: execTaskIds.length - completedCount,
                }).catch(err => console.error('[kernel] retro push error:', err.message));
              }
            }
          }
        }

        if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);

        helpers.writeBoard(latestBoard);

        if (push && PUSH_TOKENS_PATH && latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.completed')
            .catch(err => console.error('[kernel] push error:', err.message));
        }

        // Push: village.proposals_ready — when synthesis task unlocks, all proposals are done
        if (push && PUSH_TOKENS_PATH && unlocked.length > 0) {
          const allTasks = latestBoard.taskPlan?.tasks || [];
          for (const uid of unlocked) {
            const unlockedTask = allTasks.find(t => t.id === uid);
            if (unlockedTask && planDispatcher.isSynthesisTask(unlockedTask)) {
              const cycleId = latestBoard.village?.currentCycle?.cycleId;
              const deptCount = latestBoard.village?.departments?.length || 0;
              push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.proposals_ready', {
                cycleId, departmentCount: deptCount,
              }).catch(err => console.error('[kernel] village.proposals_ready push error:', err.message));
            }
          }
        }

        // Auto-dispatch newly unblocked tasks (deferred to avoid deep recursion)
        if (unlocked.length > 0 && deps.tryAutoDispatch) {
          for (const id of unlocked) {
            setImmediate(() => deps.tryAutoDispatch(id));
          }
        }
        return;
      }
    }

    // Fallback — persist budget update
    helpers.writeBoard(latestBoard);
  }

  return { onStepEvent };
}

module.exports = { createKernel };
