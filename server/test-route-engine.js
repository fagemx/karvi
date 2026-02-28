#!/usr/bin/env node
/**
 * test-route-engine.js — Unit tests for route-engine.js
 *
 * Usage: node server/test-route-engine.js
 */
const assert = require('assert');
const routeEngine = require('./route-engine');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274c ${label}: ${reason}`); process.exitCode = 1; }

function test(label, fn) {
  try { fn(); ok(label); } catch (err) { fail(label, err.message); }
}

// --- Helper: build minimal runState ---
function makeRunState(overrides = {}) {
  const steps = overrides.steps || [
    { step_id: 'T-1:plan', type: 'plan', state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:implement', type: 'implement', state: 'queued', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:test', type: 'test', state: 'queued', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:review', type: 'review', state: 'queued', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
  ];
  return {
    task: { id: 'T-1', budget: overrides.budget || null, ...overrides.task },
    steps,
    run_id: 'run-1',
  };
}

console.log('\n=== route-engine.js ===\n');

// --- decideNext ---

test('decideNext returns next_step when step succeeded and more steps remain', () => {
  const runState = makeRunState();
  const output = { step_id: 'T-1:plan', status: 'succeeded' };
  const d = routeEngine.decideNext(output, runState);
  assert.strictEqual(d.action, 'next_step');
  assert.strictEqual(d.next_step.step_id, 'T-1:implement');
  assert.strictEqual(d.next_step.step_type, 'implement');
  assert.strictEqual(d.rule, 'pipeline_advance');
  assert.strictEqual(d.confidence, 1.0);
});

test('decideNext returns done when all steps succeeded (last step)', () => {
  const runState = makeRunState();
  const output = { step_id: 'T-1:review', status: 'succeeded' };
  const d = routeEngine.decideNext(output, runState);
  assert.strictEqual(d.action, 'done');
  assert.strictEqual(d.rule, 'pipeline_complete');
});

test('decideNext returns human_review for PERMISSION failure', () => {
  const runState = makeRunState();
  const output = { step_id: 'T-1:implement', status: 'failed', error: 'access denied to repo', failure: { retryable: false } };
  const d = routeEngine.decideNext(output, runState);
  assert.strictEqual(d.action, 'human_review');
  assert.ok(d.rule.includes('PERMISSION'));
  assert.ok(d.human_review.reason.includes('access denied'));
});

test('decideNext returns retry for MISSING_CONTEXT with retryable=true', () => {
  const steps = [
    { step_id: 'T-1:plan', type: 'plan', state: 'running', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
  ];
  const runState = makeRunState({ steps });
  const output = { step_id: 'T-1:plan', status: 'failed', error: 'missing file context for module X', failure: { retryable: true } };
  const d = routeEngine.decideNext(output, runState);
  assert.strictEqual(d.action, 'retry');
  assert.ok(d.rule.includes('MISSING_CONTEXT'));
});

test('decideNext returns dead_letter when budget exceeded', () => {
  const budget = {
    limits: { max_llm_calls: 5, max_tokens: 40000, max_wall_clock_ms: 1200000, max_steps: 20 },
    used: { llm_calls: 5, tokens: 100, wall_clock_ms: 0, steps: 2 },
  };
  const runState = makeRunState({ budget });
  const output = { step_id: 'T-1:plan', status: 'succeeded' };
  const d = routeEngine.decideNext(output, runState);
  assert.strictEqual(d.action, 'dead_letter');
  assert.strictEqual(d.rule, 'budget_exceeded');
});

test('decideNext returns human_review for needs_input', () => {
  const runState = makeRunState();
  const output = { step_id: 'T-1:implement', status: 'needs_input', summary: 'Need clarification on API design' };
  const d = routeEngine.decideNext(output, runState);
  assert.strictEqual(d.action, 'human_review');
  assert.strictEqual(d.rule, 'agent_needs_input');
});

test('decideNext returns dead_letter for exhausted retries (TOOL_ERROR, non-retryable)', () => {
  const steps = [
    { step_id: 'T-1:plan', type: 'plan', state: 'running', attempt: 3, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
  ];
  const runState = makeRunState({ steps });
  const output = { step_id: 'T-1:plan', status: 'failed', error: 'timeout exceeded', failure: { retryable: false } };
  const d = routeEngine.decideNext(output, runState);
  assert.strictEqual(d.action, 'dead_letter');
  assert.ok(d.rule.includes('exhausted'));
});

// --- classifyFailure ---

test('classifyFailure correctly maps error patterns', () => {
  const FM = routeEngine.FAILURE_MODES;
  assert.strictEqual(routeEngine.classifyFailure({ error: 'permission denied' }), FM.PERMISSION);
  assert.strictEqual(routeEngine.classifyFailure({ error: '403 Forbidden' }), FM.PERMISSION);
  assert.strictEqual(routeEngine.classifyFailure({ error: 'missing file context' }), FM.MISSING_CONTEXT);
  assert.strictEqual(routeEngine.classifyFailure({ error: 'ENOENT: no such file' }), FM.ENVIRONMENT);
  assert.strictEqual(routeEngine.classifyFailure({ error: 'merge conflict in main.rs' }), FM.CONFLICT);
  assert.strictEqual(routeEngine.classifyFailure({ error: 'test failed: expected 3 got 4' }), FM.TEST_FAILURE);
  assert.strictEqual(routeEngine.classifyFailure({ error: 'ETIMEDOUT connecting to API' }), FM.TOOL_ERROR);
  assert.strictEqual(routeEngine.classifyFailure({ error: 'wrong direction, need to rethink' }), FM.STRATEGY_MISMATCH);
  // Explicit failure_mode from agent takes precedence
  assert.strictEqual(routeEngine.classifyFailure({ failure: { failure_mode: 'CONFLICT' }, error: 'something else' }), FM.CONFLICT);
  // Unknown → TOOL_ERROR default
  assert.strictEqual(routeEngine.classifyFailure({ error: 'something completely unknown' }), FM.TOOL_ERROR);
});

// --- isBudgetExceeded ---

test('isBudgetExceeded returns false when no budget', () => {
  assert.strictEqual(routeEngine.isBudgetExceeded(null), false);
  assert.strictEqual(routeEngine.isBudgetExceeded(undefined), false);
});

test('isBudgetExceeded returns true when any limit hit', () => {
  assert.strictEqual(routeEngine.isBudgetExceeded({
    limits: { max_llm_calls: 3 }, used: { llm_calls: 3 },
  }), true);
  assert.strictEqual(routeEngine.isBudgetExceeded({
    limits: { max_tokens: 100 }, used: { tokens: 200 },
  }), true);
  assert.strictEqual(routeEngine.isBudgetExceeded({
    limits: {}, used: { llm_calls: 1 },
  }), false);
});

// --- Summary ---
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
