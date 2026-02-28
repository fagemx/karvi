/**
 * route-engine.js — RouteDecision engine for step-level orchestration
 *
 * Given an agent's output and current run state, decides what happens next:
 * advance to the next step, retry, escalate to human, or dead-letter.
 */

// --- Constants ---

const FAILURE_MODES = {
  MISSING_CONTEXT:    'MISSING_CONTEXT',
  ENVIRONMENT:        'ENVIRONMENT',
  PERMISSION:         'PERMISSION',
  CONFLICT:           'CONFLICT',
  TEST_FAILURE:       'TEST_FAILURE',
  TOOL_ERROR:         'TOOL_ERROR',
  STRATEGY_MISMATCH:  'STRATEGY_MISMATCH',
};

const BUDGET_DEFAULTS = {
  max_llm_calls: 12,
  max_tokens: 40000,
  max_wall_clock_ms: 1_200_000,  // 20 min
  max_steps: 20,
};

// Max remediation attempts per failure mode before escalating
const REMEDIATION_LIMITS = {
  MISSING_CONTEXT:   2,
  ENVIRONMENT:       2,
  CONFLICT:          1,
  TEST_FAILURE:      2,
  STRATEGY_MISMATCH: 2,
};

// --- Failure classification ---

const FAILURE_PATTERNS = [
  { mode: FAILURE_MODES.PERMISSION,       pattern: /permission|access.denied|forbidden|401|403/i },
  { mode: FAILURE_MODES.ENVIRONMENT,      pattern: /ENOENT|EACCES|spawn.*failed|env.*not.set|command.not.found/i },
  { mode: FAILURE_MODES.MISSING_CONTEXT,  pattern: /not.found|missing.*file|missing.*context|no.such|undefined.reference/i },
  { mode: FAILURE_MODES.CONFLICT,         pattern: /conflict|merge.*conflict|rebase.*conflict|already.exists/i },
  { mode: FAILURE_MODES.TEST_FAILURE,     pattern: /test.*fail|assert.*fail|expect.*received|spec.*fail/i },
  { mode: FAILURE_MODES.STRATEGY_MISMATCH, pattern: /approach|strategy|alternative|wrong.direction|rethink/i },
  { mode: FAILURE_MODES.TOOL_ERROR,       pattern: /timeout|ETIMEDOUT|rate.limit|ECONNREFUSED|socket.hang/i },
];

function classifyFailure(agentOutput) {
  // Use explicit failure_mode if the agent provided one
  if (agentOutput.failure?.failure_mode && FAILURE_MODES[agentOutput.failure.failure_mode]) {
    return agentOutput.failure.failure_mode;
  }

  // Pattern-match on error text
  const text = [
    agentOutput.failure?.failure_signature,
    agentOutput.error,
    typeof agentOutput.summary === 'string' ? agentOutput.summary : '',
  ].filter(Boolean).join(' ');

  for (const { mode, pattern } of FAILURE_PATTERNS) {
    if (pattern.test(text)) return mode;
  }

  return FAILURE_MODES.TOOL_ERROR;  // default fallback
}

// --- Budget check ---

function isBudgetExceeded(budget) {
  if (!budget) return false;
  const limits = { ...BUDGET_DEFAULTS, ...budget.limits };
  const used = budget.used || {};
  return (
    (used.llm_calls || 0) >= limits.max_llm_calls ||
    (used.tokens || 0) >= limits.max_tokens ||
    (used.wall_clock_ms || 0) >= limits.max_wall_clock_ms ||
    (used.steps || 0) >= limits.max_steps
  );
}

// --- Core routing ---

function decideNext(agentOutput, runState) {
  const { task, steps } = runState;
  const fromStep = steps.find(s => s.step_id === agentOutput.step_id);
  const base = {
    from_step_id: agentOutput.step_id,
    from_status: agentOutput.status,
  };

  // 1. Budget exceeded → dead_letter
  if (isBudgetExceeded(task.budget)) {
    return { ...base, action: 'dead_letter', rule: 'budget_exceeded', confidence: 1.0,
      next_step: null, retry: null, human_review: null };
  }

  // 2. Needs human input → human_review
  if (agentOutput.status === 'needs_input') {
    return { ...base, action: 'human_review', rule: 'agent_needs_input', confidence: 1.0,
      next_step: null, retry: null,
      human_review: { reason: agentOutput.summary || 'Agent requested human input' } };
  }

  // 3. Failed → classify and route
  if (agentOutput.status === 'failed') {
    const mode = classifyFailure(agentOutput);
    const retryable = agentOutput.failure?.retryable !== false;

    // Permission → always human
    if (mode === FAILURE_MODES.PERMISSION) {
      return { ...base, action: 'human_review', rule: `failure:${mode}`, confidence: 0.9,
        next_step: null, retry: null,
        human_review: { reason: `Permission issue: ${agentOutput.error || agentOutput.summary || 'access denied'}` } };
    }

    // Remediable modes → retry with enriched context (up to limit)
    const limit = REMEDIATION_LIMITS[mode];
    if (limit && fromStep && fromStep.attempt < limit && retryable) {
      return { ...base, action: 'retry', rule: `remediate:${mode}`, confidence: 0.8,
        next_step: null, human_review: null,
        retry: { delay_ms: 0, reason: `${mode}: will retry with enriched context (attempt ${fromStep.attempt + 1}/${limit})` } };
    }

    // Retryable tool errors
    if (mode === FAILURE_MODES.TOOL_ERROR && retryable && fromStep && fromStep.attempt < fromStep.max_attempts) {
      return { ...base, action: 'retry', rule: `retry:${mode}`, confidence: 0.7,
        next_step: null, human_review: null,
        retry: { delay_ms: fromStep.retry_policy?.backoff_base_ms || 5000, reason: `Tool error, retrying` } };
    }

    // Exhausted → dead_letter
    return { ...base, action: 'dead_letter', rule: `exhausted:${mode}`, confidence: 0.9,
      next_step: null, retry: null, human_review: null };
  }

  // 4. Succeeded → find next step
  if (agentOutput.status === 'succeeded') {
    const stepTypes = steps.map(s => s.type);
    const currentIdx = stepTypes.indexOf(fromStep?.type);
    const nextIdx = currentIdx + 1;

    // More steps in pipeline?
    if (nextIdx < steps.length) {
      const nextStep = steps[nextIdx];
      return { ...base, action: 'next_step', rule: 'pipeline_advance', confidence: 1.0,
        retry: null, human_review: null,
        next_step: { step_id: nextStep.step_id, step_type: nextStep.type, priority: 0 } };
    }

    // All done
    return { ...base, action: 'done', rule: 'pipeline_complete', confidence: 1.0,
      next_step: null, retry: null, human_review: null };
  }

  // Fallback — unknown status
  return { ...base, action: 'human_review', rule: 'unknown_status', confidence: 0.5,
    next_step: null, retry: null,
    human_review: { reason: `Unknown output status: ${agentOutput.status}` } };
}

module.exports = {
  FAILURE_MODES,
  BUDGET_DEFAULTS,
  REMEDIATION_LIMITS,
  classifyFailure,
  isBudgetExceeded,
  decideNext,
};
