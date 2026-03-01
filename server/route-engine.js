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
  FINALIZE_ERROR:     'FINALIZE_ERROR',
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
  FINALIZE_ERROR:    1,
};

// --- Failure classification ---

const FAILURE_PATTERNS = [
  { mode: FAILURE_MODES.PERMISSION,       pattern: /permission|access.denied|forbidden|401|403/i },
  { mode: FAILURE_MODES.ENVIRONMENT,      pattern: /ENOENT|EACCES|spawn.*failed|env.*not.set|command.not.found/i },
  { mode: FAILURE_MODES.MISSING_CONTEXT,  pattern: /not.found|missing.*file|missing.*context|no.such|undefined.reference/i },
  { mode: FAILURE_MODES.CONFLICT,         pattern: /conflict|merge.*conflict|rebase.*conflict|already.exists/i },
  { mode: FAILURE_MODES.TEST_FAILURE,     pattern: /test.*fail|assert.*fail|expect.*received|spec.*fail/i },
  { mode: FAILURE_MODES.STRATEGY_MISMATCH, pattern: /wrong.direction|rethink|strategy.*(?:fail|wrong|bad)|approach.*(?:fail|wrong|bad)|(?:fail|wrong|bad).*(?:strategy|approach)/i },
  { mode: FAILURE_MODES.TOOL_ERROR,       pattern: /timeout|ETIMEDOUT|rate.limit|ECONNREFUSED|socket.hang/i },
  { mode: FAILURE_MODES.FINALIZE_ERROR,   pattern: /uncommitted.changes|auto.finalize|finalize.error/i },
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

// --- Review verdict classification ---

// Max review→fix cycles before accepting as-is
const MAX_REVISION_CYCLES = 2;

function needsRevision(agentOutput) {
  const text = [agentOutput.summary, agentOutput.failure?.failure_signature].filter(Boolean).join(' ').toLowerCase();
  // "Approve with nits" is not actionable — skip revision
  if (/approve/i.test(text) && !/request.changes/i.test(text)) return false;
  // Explicit "request changes" verdict
  if (/request.changes/i.test(text)) return true;
  // High/critical severity findings (medium alone is not worth a revision cycle)
  if (/\bhigh\b.*\bfind/i.test(text) || /\bcritical\b.*\bfind/i.test(text)) return true;
  return false;
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

    // Review→Fix cycle: if review step found actionable findings, loop back
    // to implement for a fix pass instead of completing the pipeline.
    // Guard: limit revision cycles to avoid infinite loops.
    if (fromStep?.type === 'review' && needsRevision(agentOutput)) {
      const revisionCount = steps.filter(s => s.type === 'implement' && s.state === 'succeeded').length;
      if (revisionCount < MAX_REVISION_CYCLES) {
        const implStep = steps.find(s => s.type === 'implement');
        if (implStep) {
          return { ...base, action: 'revision', rule: 'review_needs_fix', confidence: 0.9,
            retry: null, human_review: null,
            next_step: { step_id: implStep.step_id, step_type: 'implement', priority: 0 },
            review_feedback: agentOutput.summary || null };
        }
      }
      // Max cycles reached — accept as-is
    }

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
