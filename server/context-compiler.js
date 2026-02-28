/**
 * context-compiler.js — Build TaskEnvelope for step dispatch
 *
 * Reads previous step's output artifact, assembles the next step's
 * input envelope with objective, constraints, retry context, and budget.
 * No dependency on conversation history — purely artifact-driven.
 */

const STEP_OBJECTIVES = {
  plan:      'Analyze the task and create a detailed implementation plan with specific files and changes.',
  implement: 'Implement the changes according to the plan. Write production-ready code.',
  test:      'Write and run tests to verify the implementation. Report any failures.',
  review:    'Review the implementation for correctness, quality, and adherence to requirements.',
};

function buildEnvelope(decision, runState, deps) {
  const { task, steps } = runState;
  const { artifactStore, stepSchema } = deps;

  const targetStepId = decision.next_step?.step_id;
  const targetStep = steps.find(s => s.step_id === targetStepId);
  if (!targetStep) return null;

  const runId = targetStep.run_id;
  const stepType = targetStep.type;

  // Find the preceding step's output
  const stepTypes = steps.map(s => s.type);
  const targetIdx = stepTypes.indexOf(stepType);
  let previousOutput = null;
  let previousOutputRef = null;
  if (targetIdx > 0) {
    const prevStep = steps[targetIdx - 1];
    previousOutput = artifactStore.readArtifact(runId, prevStep.step_id, 'output');
    previousOutputRef = prevStep.output_ref || null;
  }

  // Compute idempotency key from inputs
  const inputContent = {
    task_id: task.id,
    step_type: stepType,
    previous_output: previousOutput,
    attempt: targetStep.attempt,
  };
  const idempotencyKey = stepSchema.computeIdempotencyKey(runId, targetStepId, inputContent);

  // Compute remaining budget
  const budgetRemaining = computeRemainingBudget(task.budget);

  // Build retry context if this is a retry/remediation
  let retryContext = null;
  if (decision.action === 'retry' && decision.from_step_id === targetStepId) {
    const failedOutput = artifactStore.readArtifact(runId, targetStepId, 'output');
    retryContext = {
      attempt: targetStep.attempt,
      previous_error: targetStep.error || failedOutput?.failure?.failure_signature || null,
      failure_mode: failedOutput?.failure?.failure_mode || null,
      remediation_hint: decision.retry?.reason || null,
    };
  }

  const envelope = {
    run_id: runId,
    step_id: targetStepId,
    task_id: task.id,
    step_type: stepType,
    objective: STEP_OBJECTIVES[stepType] || `Execute step: ${stepType}`,
    constraints: buildConstraints(task),
    input_refs: {
      previous_output: previousOutputRef,
      task_description: task.description || task.title || '',
      codebase_context: null,
      lessons: [],
    },
    retry_context: retryContext,
    budget_remaining: budgetRemaining,
    retry_policy: targetStep.retry_policy,
    idempotency_key: idempotencyKey,
    timeout_ms: targetStep.retry_policy?.timeout_ms || 300_000,
    model_hint: null,
  };

  return envelope;
}

function buildConstraints(task) {
  const constraints = [];
  if (task.spec) constraints.push(`Follow spec: ${task.spec}`);
  if (task.depends?.length) constraints.push(`Depends on: ${task.depends.join(', ')}`);
  return constraints;
}

function computeRemainingBudget(budget) {
  if (!budget) return null;
  const { BUDGET_DEFAULTS } = require('./route-engine');
  const limits = { ...BUDGET_DEFAULTS, ...budget.limits };
  const used = budget.used || {};
  return {
    llm_calls: limits.max_llm_calls - (used.llm_calls || 0),
    tokens: limits.max_tokens - (used.tokens || 0),
    wall_clock_ms: limits.max_wall_clock_ms - (used.wall_clock_ms || 0),
    steps: limits.max_steps - (used.steps || 0),
  };
}

module.exports = {
  STEP_OBJECTIVES,
  buildEnvelope,
  buildConstraints,
  computeRemainingBudget,
};
