/**
 * step-schema.js — Step-level state machine, creation, and idempotency
 *
 * Steps break a task into discrete phases (plan → implement → test → review).
 * Each step tracks its own state, retry count, lease, and artifact refs.
 */
const crypto = require('crypto');

// --- Constants ---

const STEP_TYPES = ['plan', 'implement', 'test', 'review'];

const STEP_STATES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];

// Step state transitions:
// - queued → running (normal execution start)
// - queued → cancelled (user cancels before step starts)
// - running → succeeded (task completed successfully)
// - running → failed (error occurred, retry scheduled)
// - running → cancelled (user killed step during execution)
// - failed → queued (retry after backoff)
// - failed → dead (max retries exhausted)
// - failed → cancelled (user kills failed step)
// - succeeded/dead/cancelled → no transitions (terminal states)
const ALLOWED_STEP_TRANSITIONS = {
  queued:    ['running', 'cancelled'],
  running:   ['succeeded', 'failed', 'cancelled'],
  failed:    ['queued', 'dead', 'cancelled'],
  succeeded: [],
  dead:      [],
  cancelled: [],
};

const DEFAULT_RETRY_POLICY = {
  max_attempts: 3,
  backoff_base_ms: 5000,
  backoff_multiplier: 2,
  timeout_ms: 300_000,
};

const ERROR_KINDS = {
  TEMPORARY:         { retryable: true,  backoff: 'exponential' },
  PROVIDER:          { retryable: true,  backoff: 'exponential' },
  AGENT_ERROR:       { retryable: true,  backoff: 'linear' },
  FINALIZE:          { retryable: true,  backoff: 'immediate' },
  CONTRACT:          { retryable: true,  backoff: 'linear' },
  PROTECTED:         { retryable: false, backoff: null },
  CONFIG:            { retryable: false, backoff: null },
  SCOPE_VIOLATION:   { retryable: true,  backoff: 'linear' },
  UNKNOWN:           { retryable: true,  backoff: 'exponential' },
};

// --- Functions ---

function computeBackoff(kindConfig, step) {
  if (!kindConfig.backoff) return 0;
  
  switch (kindConfig.backoff) {
    case 'immediate':
      return 0;
    case 'linear':
      return step.retry_policy.backoff_base_ms * step.attempt;
    case 'exponential':
    default:
      return step.retry_policy.backoff_base_ms
        * Math.pow(step.retry_policy.backoff_multiplier, step.attempt - 1);
  }
}



function createStep(taskId, runId, type, opts = {}) {
  const stepId = `${taskId}:${type}`;
  const retry = { ...DEFAULT_RETRY_POLICY, ...(opts.retry_policy || {}) };
  return {
    step_id: stepId,
    task_id: taskId,
    run_id: runId,
    type,
    state: 'queued',
    attempt: 0,
    max_attempts: retry.max_attempts,
    scheduled_at: new Date().toISOString(),
    locked_by: null,
    lock_expires_at: null,
    idempotency_key: null,
    input_ref: null,
    output_ref: null,
    // Semantic step metadata (task-specific behavior lives in data, not hard-coded maps)
    instruction: opts.instruction || null,
    skill: opts.skill || null,
    runtime_hint: opts.runtime_hint || null,
    revision_target: opts.revision_target || null,
    max_revision_cycles: opts.max_revision_cycles || null,
    retry_policy: retry,
    error: null,
    started_at: null,
    completed_at: null,
  };
}

function canTransitionStep(from, to) {
  return (ALLOWED_STEP_TRANSITIONS[from] || []).includes(to);
}

function ensureStepTransition(from, to) {
  if (!canTransitionStep(from, to)) {
    const err = new Error(`Invalid step transition: ${from} -> ${to}`);
    err.code = 'INVALID_STEP_TRANSITION';
    throw err;
  }
}

function transitionStep(step, newState, extra = {}) {
  ensureStepTransition(step.state, newState);
  step.state = newState;

  if (newState === 'running') {
    step.started_at = step.started_at || new Date().toISOString();
  }

  if (newState === 'succeeded') {
    step.completed_at = new Date().toISOString();
  }

  if (newState === 'failed') {
    step.attempt++;
    step.error = extra.error || step.error;
    step.errorKind = extra.errorKind || 'UNKNOWN';
    
    const kindConfig = ERROR_KINDS[step.errorKind];
    if (!kindConfig.retryable || step.attempt >= step.max_attempts) {
      step.state = 'dead';
    } else {
      const delay = computeBackoff(kindConfig, step);
      step.scheduled_at = new Date(Date.now() + delay).toISOString();
      step.state = 'queued';
    }
    step.locked_by = null;
    step.lock_expires_at = null;
  }

  if (newState === 'cancelled') {
    step.completed_at = new Date().toISOString();
    step.error = extra.error || 'step cancelled';
    step.locked_by = null;
    step.lock_expires_at = null;
  }

  // merge extra fields
  if (extra.output_ref !== undefined) step.output_ref = extra.output_ref;
  if (extra.input_ref !== undefined) step.input_ref = extra.input_ref;
  if (extra.locked_by !== undefined) step.locked_by = extra.locked_by;
  if (extra.lock_expires_at !== undefined) step.lock_expires_at = extra.lock_expires_at;
  if (extra.idempotency_key !== undefined) step.idempotency_key = extra.idempotency_key;

  return step;
}

function computeIdempotencyKey(runId, stepId, inputContent) {
  const inputHash = crypto.createHash('sha256')
    .update(JSON.stringify(inputContent || ''))
    .digest('hex');
  return crypto.createHash('sha256')
    .update(`${runId}:${stepId}:${inputHash}`)
    .digest('hex');
}

function isStepIdempotent(step) {
  return step.state === 'succeeded';
}

module.exports = {
  STEP_TYPES,
  STEP_STATES,
  ALLOWED_STEP_TRANSITIONS,
  DEFAULT_RETRY_POLICY,
  ERROR_KINDS,
  createStep,
  canTransitionStep,
  ensureStepTransition,
  transitionStep,
  computeBackoff,
  computeIdempotencyKey,
  isStepIdempotent,
};
