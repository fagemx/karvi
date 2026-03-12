/**
 * step-schema.js — Step-level state machine, creation, and idempotency
 *
 * Steps break a task into discrete phases (plan → implement → test → review).
 * Each step tracks its own state, retry count, lease, and artifact refs.
 */
const crypto = require('crypto');

// --- Constants ---

const STEP_TYPES = ['plan', 'implement', 'test', 'review'];

const STEP_STATES = ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'dead', 'cancelled'];

// Step state transitions:
// - queued → running (normal execution start)
// - queued → cancelled (user cancels before step starts)
// - running → cancelling (kill requested, process terminating)
// - running → succeeded (task completed successfully)
// - running → failed (error occurred, retry scheduled)
// - running → cancelled (task-level cancel — immediate, no grace period)
// - cancelling → cancelled (process terminated after kill)
// - cancelling → failed (process failed during graceful shutdown)
// - failed → queued (retry after backoff)
// - failed → dead (max retries exhausted)
// - failed → cancelled (user kills failed step)
// - succeeded/dead/cancelled → no transitions (terminal states)
const ALLOWED_STEP_TRANSITIONS = {
  queued:      ['running', 'cancelled'],
  running:     ['cancelling', 'succeeded', 'failed', 'cancelled'],
  cancelling:  ['cancelled', 'failed'],
  failed:      ['queued', 'dead', 'cancelled'],
  succeeded:   [],
  dead:        [],
  cancelled:   [],
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

// --- Step Input/Output Contracts (GH-346) ---

const STEP_OUTPUT_SCHEMAS = {
  plan: {
    required: ['status', 'summary'],
    optional: ['payload'],
    payloadSchema: {
      optional: ['scope', 'proposal', 'plan'],
      scopeSchema: {
        optional: ['allow', 'deny'],
      },
    },
  },
  implement: {
    required: ['status', 'summary'],
    optional: ['payload', 'tokens_used', 'duration_ms'],
    payloadSchema: {
      optional: ['pr_url', 'commit_hash', 'files_changed'],
    },
  },
  test: {
    required: ['status', 'summary'],
    optional: ['payload', 'tokens_used', 'duration_ms'],
    payloadSchema: {
      optional: ['passed', 'failed', 'skipped', 'coverage'],
    },
  },
  review: {
    required: ['status', 'summary'],
    optional: ['payload', 'tokens_used', 'duration_ms'],
    payloadSchema: {
      optional: ['verdict', 'score', 'issues', 'suggestions'],
    },
  },
  execute: {
    required: ['status', 'summary'],
    optional: ['payload', 'tokens_used', 'duration_ms'],
    payloadSchema: {
      optional: ['pr_url', 'commit_hash', 'files_changed'],
    },
  },
};

const STEP_INPUT_EXPECTATIONS = {
  plan: {
    required: [],
    optional: ['task_description', 'issue_context'],
    description: 'First step — no upstream requirements',
  },
  implement: {
    required: [],
    optional: ['scope', 'plan'],
    description: 'Consumes scope from plan step',
  },
  test: {
    required: [],
    optional: ['files_changed', 'commit_hash'],
    description: 'Consumes implementation artifacts',
  },
  review: {
    required: [],
    optional: ['pr_url', 'commit_hash'],
    description: 'Consumes PR/commit from implement step',
  },
  execute: {
    required: [],
    optional: ['task_description', 'issue_context'],
    description: 'Standalone execution — no upstream requirements',
  },
};

const STEP_PIPELINE_ORDER = ['plan', 'implement', 'test', 'review'];

function validateStepOutputSchema(stepType, output) {
  const errors = [];
  const schema = STEP_OUTPUT_SCHEMAS[stepType];
  
  if (!schema) {
    return { valid: true, warnings: [`No schema defined for step type "${stepType}"`] };
  }
  
  if (!output || typeof output !== 'object') {
    return { valid: false, errors: ['Output must be a non-null object'] };
  }
  
  for (const field of schema.required) {
    if (!(field in output) || output[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  if (output.status && !['succeeded', 'failed', 'needs_revision'].includes(output.status)) {
    errors.push(`Invalid status "${output.status}" — must be succeeded, failed, or needs_revision`);
  }
  
  if (schema.payloadSchema && output.payload && typeof output.payload === 'object') {
    const payloadErrors = validatePayloadFields(stepType, output.payload, schema.payloadSchema);
    errors.push(...payloadErrors);
  }
  
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function validatePayloadFields(stepType, payload, payloadSchema) {
  const errors = [];
  
  if (payloadSchema.scopeSchema && payload.scope) {
    if (typeof payload.scope !== 'object') {
      errors.push('payload.scope must be an object');
    } else {
      if (payload.scope.allow && !Array.isArray(payload.scope.allow)) {
        errors.push('payload.scope.allow must be an array');
      }
      if (payload.scope.deny && !Array.isArray(payload.scope.deny)) {
        errors.push('payload.scope.deny must be an array');
      }
    }
  }
  
  if (payload.pr_url && typeof payload.pr_url !== 'string') {
    errors.push('payload.pr_url must be a string');
  }
  
  if (payload.verdict && !['lgtm', 'needs_revision', 'blocked'].includes(payload.verdict)) {
    errors.push(`Invalid payload.verdict "${payload.verdict}"`);
  }
  
  if (payload.score !== undefined && typeof payload.score !== 'number') {
    errors.push('payload.score must be a number');
  }
  
  if (payload.issues && !Array.isArray(payload.issues)) {
    errors.push('payload.issues must be an array');
  }
  
  return errors;
}

function validateStepContract(currentStepType, output, nextStepType) {
  const errors = [];
  const warnings = [];
  
  const outputResult = validateStepOutputSchema(currentStepType, output);
  if (!outputResult.valid) {
    return { valid: false, errors: outputResult.errors, warnings: [] };
  }
  if (outputResult.warnings) {
    warnings.push(...outputResult.warnings);
  }
  
  if (output.status !== 'succeeded') {
    return { valid: true, warnings: ['Step did not succeed — skipping contract validation'] };
  }
  
  const expectations = STEP_INPUT_EXPECTATIONS[nextStepType];
  if (!expectations) {
    return { valid: true, warnings: [`No input expectations defined for step type "${nextStepType}"`] };
  }
  
  const payload = output.payload || {};
  
  for (const field of expectations.required) {
    if (!(field in payload) || payload[field] === undefined || payload[field] === null) {
      errors.push(`Next step "${nextStepType}" requires "${field}" but current step output does not provide it`);
    }
  }
  
  if (nextStepType === 'implement' && currentStepType === 'plan') {
    if (!payload.scope || typeof payload.scope !== 'object') {
      warnings.push('Plan step should provide payload.scope for implement step (file allow/deny patterns)');
    }
  }
  
  if (nextStepType === 'review' && currentStepType === 'implement') {
    if (!payload.pr_url && !output.summary?.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i)) {
      warnings.push('Implement step should provide payload.pr_url or include PR URL in summary for review step');
    }
  }
  
  return errors.length === 0 ? { valid: true, warnings } : { valid: false, errors, warnings };
}

function getStepOutputSchema(stepType) {
  return STEP_OUTPUT_SCHEMAS[stepType] || null;
}

function getStepInputExpectations(stepType) {
  return STEP_INPUT_EXPECTATIONS[stepType] || null;
}

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
  const stepId = opts.stepIdSuffix != null ? `${taskId}:${type}:${opts.stepIdSuffix}` : `${taskId}:${type}`;
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
    // Parallel group index — steps with the same group run concurrently.
    // null = auto-assigned sequential group (backward compat).
    group: opts.group ?? null,
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

  if (newState === 'cancelling') {
    step.error = extra.error || 'kill requested';
    // Don't clear lock - process still running during grace period
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
  STEP_OUTPUT_SCHEMAS,
  STEP_INPUT_EXPECTATIONS,
  STEP_PIPELINE_ORDER,
  createStep,
  canTransitionStep,
  ensureStepTransition,
  transitionStep,
  computeBackoff,
  computeIdempotencyKey,
  isStepIdempotent,
  validateStepOutputSchema,
  validateStepContract,
  getStepOutputSchema,
  getStepInputExpectations,
};
