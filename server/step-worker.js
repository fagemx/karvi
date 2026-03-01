/**
 * step-worker.js — Step execution layer
 *
 * Wraps runtime adapters with step-level concerns:
 * lease management, duration tracking, structured output parsing,
 * per-step runtime selection, and artifact I/O.
 *
 * Extracted from kernel.js:dispatchStep() (issue #92).
 * Kernel = routing decisions, StepWorker = execution.
 */
const LOCK_GRACE_MS = 30_000; // 30s grace on top of step timeout

/**
 * Create the step execution worker.
 *
 * Depends on deps.kernel being set before any terminal-state callback fires.
 * The callback is deferred via setImmediate, so deps.kernel is guaranteed to
 * be set by that time. See server.js for initialization order notes.
 *
 * @param {object} deps - Shared dependency injection object (mutated after creation)
 */
function createStepWorker(deps) {
  const { artifactStore, stepSchema, mgmt } = deps;

  /**
   * Execute a single step: build plan, acquire lock, dispatch to runtime,
   * parse output, write artifact, transition state, emit signal.
   *
   * @param {object} envelope - TaskEnvelope from context-compiler
   * @param {object} board    - Board snapshot
   * @param {object} helpers  - { readBoard, writeBoard, appendLog, nowIso, uid }
   */
  async function executeStep(envelope, board, helpers) {
    const task = (board.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    if (!task) throw new Error(`Task ${envelope.task_id} not found`);

    // 1. Build dispatch plan
    const stepMessage = buildStepMessage(envelope);
    const plan = mgmt.buildDispatchPlan(board, task, {
      mode: 'dispatch',
      timeoutSec: Math.ceil(envelope.timeout_ms / 1000),
      steps: task.steps,
    });
    plan.message = stepMessage;
    plan.stepId = envelope.step_id;
    plan.stepType = envelope.step_type;

    // Clear AGENT_MODEL_MAP hints for Claude Code runtime — those model IDs
    // are for API/OpenClaw runtimes and not recognized by `claude -p`.
    if (plan.runtimeHint === 'claude' && plan.modelHint) {
      plan.modelHint = null;
    }

    // Inject STEP_RESULT instruction as system prompt — more reliable than
    // putting it in the user message, because system prompts persist across
    // the entire conversation and won't be forgotten by long-running skills.
    if (plan.runtimeHint === 'claude') {
      const resultPrompt = [
        'CRITICAL: When you have completely finished your task, you MUST output the following on a single line (no code fences):',
        'STEP_RESULT:{"status":"succeeded","summary":"one line summary"}',
        'Or on failure:',
        'STEP_RESULT:{"status":"failed","error":"what went wrong","failure_mode":"TEST_FAILURE","retryable":true}',
        'This line MUST appear in your final message. Without it, the pipeline cannot advance.',
      ].join('\n');
      plan.systemPrompt = plan.systemPrompt
        ? plan.systemPrompt + '\n\n' + resultPrompt
        : resultPrompt;
    }

    // 2. Set lock with expiry before dispatch
    const lockBoard = helpers.readBoard();
    const lockTask = (lockBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    const lockStep = lockTask?.steps?.find(s => s.step_id === envelope.step_id);
    if (lockStep && lockStep.state === 'running') {
      lockStep.lock_expires_at = new Date(Date.now() + envelope.timeout_ms + LOCK_GRACE_MS).toISOString();
      lockStep.locked_by = 'step-worker';
      helpers.writeBoard(lockBoard);
    }

    // 3. Per-step runtime selection
    const step = task.steps?.find(s => s.step_id === envelope.step_id);
    const runtimeHint = envelope.runtime_hint || step?.runtime_hint || plan.runtimeHint;
    const rt = deps.getRuntime(runtimeHint);

    // 4. Dispatch with duration tracking (catch failures to transition step properly)
    const startMs = Date.now();
    let result;
    try {
      result = await rt.dispatch(plan);
    } catch (dispatchErr) {
      const durationMs = Date.now() - startMs;
      // Transition step to failed instead of leaving it stuck in 'running'
      const failBoard = helpers.readBoard();
      const failTask = (failBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
      const failStep = failTask?.steps?.find(s => s.step_id === envelope.step_id);
      if (failStep && failStep.state === 'running') {
        stepSchema.transitionStep(failStep, 'failed', {
          error: (dispatchErr.message || 'dispatch error').slice(0, 500),
        });
        helpers.writeBoard(failBoard);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'step_dispatch_error', taskId: envelope.task_id, stepId: envelope.step_id, error: dispatchErr.message, duration_ms: durationMs });
      }
      throw dispatchErr;
    }
    const durationMs = Date.now() - startMs;

    // 5. Parse output — try STEP_RESULT from extracted reply first (critical for
    //    JSON-wrapping runtimes like claude --output-format json where STEP_RESULT
    //    is inside parsed.result, not in raw stdout)
    const replyText = rt.extractReplyText(result.parsed, result.stdout);
    const usage = rt.extractUsage?.(result.parsed, result.stdout) || null;
    const stepResult = parseStepResult(replyText) || parseStepResult(result.stdout);

    let status, failure, summary;
    if (stepResult) {
      // Structured output from agent
      status = stepResult.status === 'succeeded' ? 'succeeded' : 'failed';
      summary = stepResult.summary || replyText?.slice(0, 500) || null;
      failure = status === 'failed' ? {
        failure_signature: stepResult.error || replyText?.slice(0, 200),
        failure_mode: stepResult.failure_mode || null,
        retryable: stepResult.retryable !== false,
      } : null;
    } else {
      // Fall back to exit-code classification
      status = result.code === 0 ? 'succeeded' : 'failed';
      summary = replyText?.slice(0, 500) || null;
      failure = result.code !== 0 ? {
        failure_signature: replyText?.slice(0, 200),
        retryable: true,
      } : null;
    }

    const agentOutput = {
      run_id: envelope.run_id,
      step_id: envelope.step_id,
      status,
      failure,
      summary,
      tokens_used: (usage?.inputTokens || 0) + (usage?.outputTokens || 0),
      duration_ms: durationMs,
      model_used: plan.modelHint,
    };
    artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'output', agentOutput);

    // 6. Transition step to final state
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    const latestStep = latestTask?.steps?.find(s => s.step_id === envelope.step_id);
    if (latestStep && latestStep.state === 'running') {
      const newState = agentOutput.status === 'succeeded' ? 'succeeded' : 'failed';
      stepSchema.transitionStep(latestStep, newState, {
        output_ref: artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'output'),
        error: agentOutput.failure?.failure_signature || null,
      });

      // 7. Emit signal
      const signalType = latestStep.state === 'succeeded' ? 'step_completed'
        : latestStep.state === 'dead' ? 'step_dead'
        : latestStep.state === 'queued' ? 'step_failed'
        : `step_${latestStep.state}`;
      mgmt.ensureEvolutionFields(latestBoard);
      latestBoard.signals.push({
        id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'step-worker',
        type: signalType,
        content: `${envelope.task_id} step ${envelope.step_id} running → ${latestStep.state}`,
        refs: [envelope.task_id],
        data: { taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state, attempt: latestStep.attempt },
      });
      if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
      helpers.writeBoard(latestBoard);
      helpers.appendLog({ ts: helpers.nowIso(), event: signalType, taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state });

      // 8. Trigger kernel for terminal states (via setImmediate to avoid deep recursion)
      const newSignal = {
        type: signalType,
        data: { taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state },
      };
      if (deps.kernel) {
        setImmediate(() => {
          deps.kernel.onStepEvent(newSignal, helpers.readBoard(), helpers)
            .catch(err => console.error(`[step-worker] kernel callback error for ${envelope.step_id}:`, err.message));
        });
      }
      // Note: deps.kernel is null during unit tests — this is expected (see server.js init order)
    }

    return agentOutput;
  }

  return { executeStep };
}

// --- Helpers (module-level, testable) ---

/**
 * Parse structured STEP_RESULT from agent stdout.
 * Format: STEP_RESULT:{"status":"succeeded","summary":"..."}
 * Scans from last line backward (agent may produce other output before).
 */
function parseStepResult(stdout) {
  if (!stdout) return null;
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^STEP_RESULT:\s*(\{.*\})$/);
    if (match) {
      try { return JSON.parse(match[1]); } catch { continue; }
    }
  }
  return null;
}

/**
 * Build step-specific prompt message from envelope.
 *
 * Core insight: Claude Code skills already contain the full workflow logic
 * for each step. Instead of rewriting objectives, we invoke the corresponding
 * skill directly. The headless agent (`claude -p`) runs in the repo directory
 * and has access to `.claude/skills/`.
 */
function buildStepMessage(envelope) {
  // Extract issue number from task source or task ID (GH-123 → 123)
  const source = envelope.input_refs?.task_source;
  const issueNumber = source?.number
    || (envelope.task_id.match(/^GH-(\d+)$/) || [])[1]
    || envelope.task_id;

  // Map step types to skill invocations
  const STEP_SKILL_MAP = {
    plan:      `Execute /issue-plan ${issueNumber}`,
    implement: `Execute /issue-action for issue #${issueNumber}. The plan has already been posted as a comment on the issue — read it from there.`,
    test:      `Check CI status for the PR. Run: gh pr checks. If lint/format failures, auto-fix and push. Report test results.`,
    review:    `Execute /pr-review`,
  };

  const skillMsg = STEP_SKILL_MAP[envelope.step_type]
    || `Complete the ${envelope.step_type} step for task ${envelope.task_id}.`;

  const lines = [
    skillMsg,
    '',
    `Task: ${envelope.task_id}`,
    `Step: ${envelope.step_id} (${envelope.step_type})`,
  ];

  if (envelope.input_refs.task_description) {
    lines.push('', `Task description: ${envelope.input_refs.task_description}`);
  }

  if (envelope.retry_context) {
    lines.push('', '\u26a0 RETRY — this step previously failed:');
    lines.push(`  Attempt: ${envelope.retry_context.attempt}`);
    if (envelope.retry_context.previous_error) lines.push(`  Previous error: ${envelope.retry_context.previous_error}`);
    if (envelope.retry_context.failure_mode) lines.push(`  Failure mode: ${envelope.retry_context.failure_mode}`);
    if (envelope.retry_context.remediation_hint) lines.push(`  Hint: ${envelope.retry_context.remediation_hint}`);
  }

  // Instruct agent to output structured result when done
  lines.push('', 'IMPORTANT: When you are completely done, output your result on the LAST line as:');
  lines.push('STEP_RESULT:{"status":"succeeded","summary":"one line summary of what you did"}');
  lines.push('Or on failure:');
  lines.push('STEP_RESULT:{"status":"failed","error":"what went wrong","failure_mode":"TEST_FAILURE","retryable":true}');

  return lines.join('\n');
}

/**
 * Recover expired locks at server startup.
 * Steps stuck in 'running' with expired lock_expires_at get reset to 'queued'.
 */
function recoverExpiredLocks(board) {
  const now = new Date().toISOString();
  let recovered = 0;
  for (const task of board.taskPlan?.tasks || []) {
    for (const step of task.steps || []) {
      if (step.state === 'running' && step.lock_expires_at && step.lock_expires_at < now) {
        step.state = 'queued';
        step.locked_by = null;
        step.lock_expires_at = null;
        step.error = 'Lock expired (server restart recovery)';
        recovered++;
      }
    }
  }
  return recovered;
}

module.exports = { createStepWorker, parseStepResult, buildStepMessage, recoverExpiredLocks };
