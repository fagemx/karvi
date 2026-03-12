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
  STRATEGY_MISMATCH:    'STRATEGY_MISMATCH',
  FINALIZE_ERROR:       'FINALIZE_ERROR',
  CONTRACT_VIOLATION:   'CONTRACT_VIOLATION',
  PROTECTED_CODE_VIOLATION: 'PROTECTED_CODE_VIOLATION',
};

const BUDGET_DEFAULTS = {
  max_llm_calls: 50,       // was 12 — too low for 3-step pipeline with retries
  max_tokens: 2_000_000,   // large-context models (Gemini) use 130K+ per tool call; 500K too tight for 3-step pipeline
  max_wall_clock_ms: 1_800_000,  // 30 min (was 20 min)
  max_steps: 20,
};

// Max remediation attempts per failure mode before escalating
const REMEDIATION_LIMITS = {
  MISSING_CONTEXT:   2,
  ENVIRONMENT:       2,
  CONFLICT:          1,
  TEST_FAILURE:      2,
  STRATEGY_MISMATCH:   2,
  FINALIZE_ERROR:      1,
  CONTRACT_VIOLATION:  2,
  PROTECTED_CODE_VIOLATION: 2,
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
  { mode: FAILURE_MODES.FINALIZE_ERROR,     pattern: /uncommitted.changes|auto.finalize|finalize.error/i },
  { mode: FAILURE_MODES.CONTRACT_VIOLATION, pattern: /contract.violation|deliverable.*missing|deliverable.*not.found/i },
  { mode: FAILURE_MODES.PROTECTED_CODE_VIOLATION, pattern: /protected.code.violation|@protected.*modified|protected.decision.*reverted/i },
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

function isCostBudgetExceeded(budget, controls) {
  if (!controls?.budget_per_task) return false;
  const usedCost = budget?.used?.cost || 0;
  return usedCost >= controls.budget_per_task;
}

// --- Review verdict classification ---

// Max review→fix cycles before accepting as-is
const MAX_REVISION_CYCLES = 2;

function needsRevision(agentOutput) {
  // Structured status takes priority — agent explicitly said "needs_revision"
  if (agentOutput.status === 'needs_revision') return true;
  const text = [agentOutput.summary, agentOutput.failure?.failure_signature].filter(Boolean).join(' ').toLowerCase();
  // "Approve with nits" is not actionable — skip revision
  if (/approve/i.test(text) && !/request.changes/i.test(text)) return false;
  // Explicit "request changes" or "changes requested" verdict
  if (/request.changes|changes\s+requested/i.test(text)) return true;
  // High/critical severity findings (medium alone is not worth a revision cycle)
  if (/\bhigh\b.*\bfind/i.test(text) || /\bcritical\b.*\bfind/i.test(text)) return true;
  return false;
}

// --- Core routing ---

function decideNext(agentOutput, runState) {
  const { task, steps, controls } = runState;
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

  // 1b. Cost budget exceeded → dead_letter (skip retry to save costs)
  if (isCostBudgetExceeded(task.budget, controls)) {
    return { ...base, action: 'dead_letter', rule: 'cost_budget_exceeded', confidence: 1.0,
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

  // 4. Succeeded (or needs_revision — review completed but wants changes) → find next step
  if (agentOutput.status === 'succeeded' || agentOutput.status === 'needs_revision') {
    // Revision cycle: if a step with revision_target found actionable findings,
    // loop back to the target step for a fix pass.
    // Guard: limit revision cycles to avoid infinite loops.
    if (fromStep?.revision_target && needsRevision(agentOutput)) {
      const targetStep = steps.find(s => s.type === fromStep.revision_target);
      if (!targetStep) {
        console.warn("[route-engine] revision_target '%s' not found in pipeline", fromStep.revision_target);
      } else {
        const maxCycles = fromStep.max_revision_cycles || MAX_REVISION_CYCLES;
        const revisionCount = task._revisionCounts?.[targetStep.step_id] || 0;
        if (revisionCount < maxCycles) {
          return { ...base, action: 'revision', rule: 'review_needs_fix', confidence: 0.9,
            retry: null, human_review: null,
            next_step: { step_id: targetStep.step_id, step_type: targetStep.type, priority: 0 },
            review_feedback: agentOutput.revision_notes || agentOutput.summary || null };
        }
        // Max cycles reached — accept as-is
      }
    }

    // Group-aware progression: find the current step's group, check if all
    // siblings in the group are terminal, then advance to the next group.
    const currentGroup = resolveStepGroup(fromStep, steps);
    const siblings = steps.filter(s => resolveStepGroup(s, steps) === currentGroup);
    const siblingsPending = siblings.some(s =>
      s.state !== 'succeeded' && s.state !== 'dead' && s.state !== 'cancelled'
    );

    if (siblingsPending) {
      // Group not yet complete — wait (no action, kernel will be called again when next sibling finishes)
      return { ...base, action: 'wait_group', rule: 'parallel_group_pending', confidence: 1.0,
        next_step: null, retry: null, human_review: null };
    }

    // All siblings done — check if any failed fatally (dead) in this group
    const deadSiblings = siblings.filter(s => s.state === 'dead');
    if (deadSiblings.length > 0) {
      return { ...base, action: 'dead_letter', rule: 'parallel_group_has_dead', confidence: 0.9,
        next_step: null, retry: null, human_review: null };
    }

    // Find next group's first queued step
    const nextGroupSteps = findNextGroupSteps(currentGroup, steps);
    if (nextGroupSteps.length > 0) {
      const nextStep = nextGroupSteps[0];
      return { ...base, action: 'next_step', rule: 'pipeline_advance', confidence: 1.0,
        retry: null, human_review: null,
        next_step: { step_id: nextStep.step_id, step_type: nextStep.type, priority: 0 },
        // Signal parallel siblings so kernel can dispatch them too
        parallel_siblings: nextGroupSteps.slice(1).map(s => ({ step_id: s.step_id, step_type: s.type })) };
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

// --- Parallel group helpers ---

/**
 * Resolve a step's group index. If the step has no explicit group,
 * fall back to its array position (backward compat: each step = own group).
 */
function resolveStepGroup(step, steps) {
  if (step.group != null) return step.group;
  return steps.indexOf(step);
}

/**
 * Find all queued steps in the next group after the given group index.
 */
function findNextGroupSteps(currentGroup, steps) {
  // Collect all distinct group indices > currentGroup, sorted
  const groups = new Set();
  for (const s of steps) {
    const g = resolveStepGroup(s, steps);
    if (g > currentGroup) groups.add(g);
  }
  if (groups.size === 0) return [];
  const nextGroup = Math.min(...groups);
  return steps.filter(s => resolveStepGroup(s, steps) === nextGroup && s.state === 'queued');
}

module.exports = {
  FAILURE_MODES,
  BUDGET_DEFAULTS,
  REMEDIATION_LIMITS,
  MAX_REVISION_CYCLES,
  classifyFailure,
  isBudgetExceeded,
  isCostBudgetExceeded,
  needsRevision,
  decideNext,
  resolveStepGroup,
  findNextGroupSteps,
};
