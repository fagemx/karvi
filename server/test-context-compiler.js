#!/usr/bin/env node
/**
 * test-context-compiler.js — Unit tests for context-compiler.js
 *
 * Usage: node server/test-context-compiler.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const contextCompiler = require('./context-compiler');
const stepSchema = require('./step-schema');
const artifactStore = require('./artifact-store');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274c ${label}: ${reason}`); process.exitCode = 1; }

function test(label, fn) {
  try { fn(); ok(label); } catch (err) { fail(label, err.message); }
}

const testRunId = `test-ctx-${Date.now()}`;

// Setup: write a plan output artifact
artifactStore.writeArtifact(testRunId, 'T-1:plan', 'output', {
  summary: 'Plan: refactor auth module',
  artifacts: ['plan.md'],
});

console.log('\n=== context-compiler.js ===\n');

test('buildEnvelope assembles correct fields', () => {
  const decision = {
    action: 'next_step',
    from_step_id: 'T-1:plan',
    from_status: 'succeeded',
    next_step: { step_id: 'T-1:implement', step_type: 'implement' },
  };
  const steps = [
    { step_id: 'T-1:plan', type: 'plan', state: 'succeeded', run_id: testRunId, attempt: 0, output_ref: 'artifacts/test/plan.output.json', retry_policy: stepSchema.DEFAULT_RETRY_POLICY },
    { step_id: 'T-1:implement', type: 'implement', state: 'queued', run_id: testRunId, attempt: 0, retry_policy: stepSchema.DEFAULT_RETRY_POLICY },
  ];
  const runState = { task: { id: 'T-1', description: 'Refactor auth' }, steps, run_id: testRunId };
  const deps = { artifactStore, stepSchema };

  const env = contextCompiler.buildEnvelope(decision, runState, deps);
  assert.strictEqual(env.run_id, testRunId);
  assert.strictEqual(env.step_id, 'T-1:implement');
  assert.strictEqual(env.task_id, 'T-1');
  assert.strictEqual(env.step_type, 'implement');
  assert.ok(env.objective.includes('Implement'));
  assert.strictEqual(env.input_refs.task_description, 'Refactor auth');
  assert.ok(env.idempotency_key);
  assert.strictEqual(env.idempotency_key.length, 64);  // sha256 hex
  assert.strictEqual(env.retry_context, null);
});

test('buildEnvelope includes retry_context on retry decisions', () => {
  // Write a failed output
  artifactStore.writeArtifact(testRunId, 'T-1:implement', 'output', {
    failure: { failure_mode: 'TEST_FAILURE', failure_signature: 'assert failed' },
    summary: 'Tests failed',
  });
  const decision = {
    action: 'retry',
    from_step_id: 'T-1:implement',
    from_status: 'failed',
    next_step: { step_id: 'T-1:implement', step_type: 'implement' },
    retry: { reason: 'TEST_FAILURE: will retry with enriched context' },
  };
  const steps = [
    { step_id: 'T-1:plan', type: 'plan', state: 'succeeded', run_id: testRunId, attempt: 0, retry_policy: stepSchema.DEFAULT_RETRY_POLICY },
    { step_id: 'T-1:implement', type: 'implement', state: 'queued', run_id: testRunId, attempt: 1, error: 'assert failed', retry_policy: stepSchema.DEFAULT_RETRY_POLICY },
  ];
  const runState = { task: { id: 'T-1', description: 'Refactor auth' }, steps, run_id: testRunId };
  const deps = { artifactStore, stepSchema };

  const env = contextCompiler.buildEnvelope(decision, runState, deps);
  assert.ok(env.retry_context);
  assert.strictEqual(env.retry_context.attempt, 1);
  assert.strictEqual(env.retry_context.previous_error, 'assert failed');
  assert.strictEqual(env.retry_context.failure_mode, 'TEST_FAILURE');
});

test('buildEnvelope computes idempotency key deterministically', () => {
  const decision = {
    action: 'next_step',
    from_step_id: 'T-1:plan',
    next_step: { step_id: 'T-1:implement', step_type: 'implement' },
  };
  const steps = [
    { step_id: 'T-1:plan', type: 'plan', state: 'succeeded', run_id: testRunId, attempt: 0, retry_policy: stepSchema.DEFAULT_RETRY_POLICY },
    { step_id: 'T-1:implement', type: 'implement', state: 'queued', run_id: testRunId, attempt: 0, retry_policy: stepSchema.DEFAULT_RETRY_POLICY },
  ];
  const runState = { task: { id: 'T-1' }, steps, run_id: testRunId };
  const deps = { artifactStore, stepSchema };

  const env1 = contextCompiler.buildEnvelope(decision, runState, deps);
  const env2 = contextCompiler.buildEnvelope(decision, runState, deps);
  assert.strictEqual(env1.idempotency_key, env2.idempotency_key);
});

test('computeRemainingBudget returns correct values', () => {
  const budget = {
    limits: { max_llm_calls: 12, max_tokens: 40000, max_wall_clock_ms: 1200000, max_steps: 20 },
    used: { llm_calls: 3, tokens: 10000, wall_clock_ms: 300000, steps: 5 },
  };
  const remaining = contextCompiler.computeRemainingBudget(budget);
  assert.strictEqual(remaining.llm_calls, 9);
  assert.strictEqual(remaining.tokens, 30000);
  assert.strictEqual(remaining.wall_clock_ms, 900000);
  assert.strictEqual(remaining.steps, 15);
});

test('computeRemainingBudget returns null when no budget', () => {
  assert.strictEqual(contextCompiler.computeRemainingBudget(null), null);
});

test('buildEnvelope returns null for missing target step', () => {
  const decision = { action: 'next_step', next_step: { step_id: 'T-1:nonexistent' } };
  const runState = { task: { id: 'T-1' }, steps: [], run_id: testRunId };
  const deps = { artifactStore, stepSchema };
  const env = contextCompiler.buildEnvelope(decision, runState, deps);
  assert.strictEqual(env, null);
});

// Cleanup
try {
  fs.rmSync(path.join(artifactStore.ARTIFACT_DIR, testRunId), { recursive: true, force: true });
} catch {}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
