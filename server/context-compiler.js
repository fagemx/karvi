/**
 * context-compiler.js — Build TaskEnvelope for step dispatch
 *
 * Reads previous step's output artifact, assembles the next step's
 * input envelope with objective, constraints, retry context, and budget.
 * No dependency on conversation history — purely artifact-driven.
 */
const path = require('path');
const { BUDGET_DEFAULTS } = require('./route-engine');

const STEP_OBJECTIVES = {
  plan:      'Research the codebase, understand the issue requirements, and produce a concrete implementation plan. Post the plan as a comment on the GitHub issue.',
  implement: 'Implement all changes described in the plan. Commit, push the branch, and create a pull request via `gh pr create`. The PR must exist when you are done.',
  test:      'Verify CI passes and auto-fix lint/format failures.',
  review:    'Review the PR diff for correctness, scope, and test coverage. Post a review comment on the PR.',
};

// Default contracts per step type — enforce deliverable verification in post-check
const STEP_DEFAULT_CONTRACTS = {
  implement: { deliverable: 'pr' },
};

function resolveEnvelopeModel(runtimeHint, stepType, controls) {
  const map = controls?.model_map;
  if (!map || typeof map !== 'object') return null;
  const runtimeMap = map[runtimeHint];
  if (!runtimeMap || typeof runtimeMap !== 'object') return null;
  return (stepType && runtimeMap[stepType]) || runtimeMap.default || null;
}

function buildEnvelope(decision, runState, deps) {
  const { task, steps } = runState;
  if (!task || !steps) return null;
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

  // Extract scope from plan step output (for implement step and retry context)
  let planScope = null;
  if (previousOutput?.payload?.scope) {
    planScope = previousOutput.payload.scope;
  }

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
    // For PROTECTED violations, inject all protected annotations so agent knows every line to avoid
    if (retryContext.failure_mode === 'PROTECTED_CODE_VIOLATION') {
      const { scanProtectedAnnotations } = require('./protected-diff-guard');
      const annotations = scanProtectedAnnotations(path.resolve(__dirname));
      if (annotations.length > 0) {
        retryContext.remediation_hint =
          `Do NOT modify these @protected lines: ${annotations.map(a => a.file + ':' + a.line).join(', ')}. ` +
          `Work around them — extract/refactor other code while leaving protected lines untouched.`;
      }
    }
    // For SCOPE_VIOLATION, provide clear guidance on allowed/denied patterns
    if (retryContext.failure_mode === 'SCOPE_VIOLATION') {
      const scopeConfig = task.scope || planScope;
      if (scopeConfig) {
        const allowList = scopeConfig.allow?.length
          ? scopeConfig.allow.join(', ')
          : '(no allow list — all files allowed except deny patterns)';
        const denyList = scopeConfig.deny?.length
          ? scopeConfig.deny.join(', ')
          : '(none)';
        retryContext.remediation_hint =
          `Your previous attempt modified files outside the allowed scope. ` +
          `Allowed patterns: ${allowList}. ` +
          `Denied patterns: ${denyList}. ` +
          `Only modify files matching the allowed patterns and avoid denied patterns. ` +
          `The .claude/** directory is always denied.`;
      }
    }
  }

  const envelope = {
    run_id: runId,
    step_id: targetStepId,
    task_id: task.id,
    step_type: stepType,
    objective: STEP_OBJECTIVES[stepType] || `Execute step: ${stepType}`,
    instruction: targetStep.instruction || null,
    skill: targetStep.skill || null,
    runtime_hint: targetStep.runtime_hint || null,
    constraints: buildConstraints(task),
    input_refs: {
      previous_output: previousOutputRef,
      task_description: task.description || task.title || '',
      task_source: task.source || task.githubIssue || null,
      codebase_context: task.worktreeDir || task.target_repo || null,
      lessons: [],
    },
    retry_context: retryContext,
    review_feedback: decision.review_feedback || task.reviewFeedback || null,
    budget_remaining: budgetRemaining,
    retry_policy: targetStep.retry_policy,
    idempotency_key: idempotencyKey,
    timeout_ms: targetStep.retry_policy?.timeout_ms || (function() {
      const stepTimeouts = runState.controls?.step_timeout_sec || {};
      const timeoutSec = stepTimeouts[stepType] || stepTimeouts.default || 300;
      return timeoutSec * 1000;
    })(),
    model_hint: resolveEnvelopeModel(targetStep.runtime_hint, stepType, runState.controls),
    contract: task.contract || STEP_DEFAULT_CONTRACTS[stepType] || null,
    scope_config: task.scope || planScope || null,
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
  STEP_DEFAULT_CONTRACTS,
  buildEnvelope,
  buildConstraints,
  computeRemainingBudget,
};
