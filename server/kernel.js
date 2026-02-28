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
        helpers.writeBoard(latestBoard);
        // Dispatch async (fire-and-forget, errors logged)
        dispatchStep(envelope, latestBoard, helpers).catch(err =>
          console.error(`[kernel] dispatchStep error for ${envelope.step_id}:`, err.message));
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
          latestTask.status = 'completed';
          latestTask.completedAt = helpers.nowIso();
          latestTask.result = { status: 'completed', summary: `All ${task.steps.length} steps succeeded` };
        }
        helpers.writeBoard(latestBoard);
        if (push && PUSH_TOKENS_PATH && latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.completed')
            .catch(err => console.error('[kernel] push error:', err.message));
        }
        return;
      }
    }

    // Fallback — persist budget update
    helpers.writeBoard(latestBoard);
  }

  /**
   * Dispatch a step to the appropriate runtime adapter.
   * Reuses existing buildDispatchPlan + runtime dispatch.
   */
  async function dispatchStep(envelope, board, helpers) {
    const task = (board.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    if (!task) throw new Error(`Task ${envelope.task_id} not found`);

    const stepMessage = buildStepMessage(envelope);
    const plan = mgmt.buildDispatchPlan(board, task, {
      mode: 'dispatch',
      timeoutSec: Math.ceil(envelope.timeout_ms / 1000),
      steps: task.steps,
    });
    // Override message with step-specific content
    plan.message = stepMessage;
    plan.stepId = envelope.step_id;
    plan.stepType = envelope.step_type;

    const rt = deps.getRuntime(plan.runtimeHint);
    const result = await rt.dispatch(plan);

    // Parse result and write output artifact
    const replyText = rt.extractReplyText(result.parsed, result.stdout);
    const usage = rt.extractUsage?.(result.parsed, result.stdout) || null;

    const agentOutput = {
      run_id: envelope.run_id,
      step_id: envelope.step_id,
      status: result.code === 0 ? 'succeeded' : 'failed',
      failure: result.code !== 0 ? { failure_signature: replyText?.slice(0, 200), retryable: true } : null,
      summary: replyText?.slice(0, 500) || null,
      tokens_used: (usage?.inputTokens || 0) + (usage?.outputTokens || 0),
      duration_ms: null,
      model_used: plan.modelHint,
    };
    artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'output', agentOutput);

    // Transition step to final state via PATCH-like logic
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    const latestStep = latestTask?.steps?.find(s => s.step_id === envelope.step_id);
    if (latestStep && latestStep.state === 'running') {
      const newState = agentOutput.status === 'succeeded' ? 'succeeded' : 'failed';
      stepSchema.transitionStep(latestStep, newState, {
        output_ref: artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'output'),
        error: agentOutput.failure?.failure_signature || null,
      });

      // Emit signal (mirrors PATCH handler)
      const signalType = latestStep.state === 'succeeded' ? 'step_completed'
        : latestStep.state === 'dead' ? 'step_dead'
        : latestStep.state === 'queued' ? 'step_failed'
        : `step_${latestStep.state}`;
      mgmt.ensureEvolutionFields(latestBoard);
      latestBoard.signals.push({
        id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'kernel',
        type: signalType,
        content: `${envelope.task_id} step ${envelope.step_id} running → ${latestStep.state}`,
        refs: [envelope.task_id],
        data: { taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state, attempt: latestStep.attempt },
      });
      if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
      helpers.writeBoard(latestBoard);
      helpers.appendLog({ ts: helpers.nowIso(), event: signalType, taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state });

      // Trigger kernel again for the new terminal state (via setImmediate to avoid deep recursion)
      const newSignal = {
        type: signalType,
        data: { taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state },
      };
      setImmediate(() => {
        onStepEvent(newSignal, helpers.readBoard(), helpers)
          .catch(err => console.error(`[kernel] recursive onStepEvent error for ${envelope.step_id}:`, err.message));
      });
    }
  }

  return { onStepEvent, dispatchStep };
}

// --- Helpers ---

function buildStepMessage(envelope) {
  const lines = [
    `【Step Dispatch: ${envelope.step_type.toUpperCase()}】`,
    '',
    `Task: ${envelope.task_id}`,
    `Step: ${envelope.step_id} (${envelope.step_type})`,
    `Objective: ${envelope.objective}`,
  ];

  if (envelope.constraints.length > 0) {
    lines.push('', 'Constraints:');
    envelope.constraints.forEach(c => lines.push(`  - ${c}`));
  }

  if (envelope.input_refs.task_description) {
    lines.push('', `Task description: ${envelope.input_refs.task_description}`);
  }

  if (envelope.retry_context) {
    lines.push('', '⚠ RETRY CONTEXT:');
    lines.push(`  Attempt: ${envelope.retry_context.attempt}`);
    if (envelope.retry_context.previous_error) lines.push(`  Previous error: ${envelope.retry_context.previous_error}`);
    if (envelope.retry_context.failure_mode) lines.push(`  Failure mode: ${envelope.retry_context.failure_mode}`);
    if (envelope.retry_context.remediation_hint) lines.push(`  Hint: ${envelope.retry_context.remediation_hint}`);
  }

  if (envelope.budget_remaining) {
    lines.push('', `Budget remaining: ${envelope.budget_remaining.llm_calls} LLM calls, ${envelope.budget_remaining.tokens} tokens, ${Math.round(envelope.budget_remaining.wall_clock_ms / 1000)}s`);
  }

  return lines.join('\n');
}

module.exports = { createKernel };
