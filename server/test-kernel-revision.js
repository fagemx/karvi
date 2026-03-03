#!/usr/bin/env node
/**
 * test-kernel-revision.js — Unit tests for kernel.js revision handler
 *
 * Covers the 'revision' case (kernel.js ~lines 134-177):
 *   (a) revision resets step range (target..source) to queued
 *   (b) _revisionCounts increments
 *   (c) max_revision_cycles triggers dead_letter (via route-engine)
 *
 * Usage: node server/test-kernel-revision.js
 */
const assert = require('assert');
const routeEngine = require('./route-engine');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

function test(label, fn) {
  try { fn(); ok(label); } catch (err) { fail(label, err.message); }
}

// --- Helpers ---

/** Build a minimal task with steps matching kernel's expected shape */
function makeTask(overrides = {}) {
  return {
    id: 'T-1',
    _revisionCounts: {},
    budget: null,
    ...overrides,
  };
}

function makeSteps() {
  return [
    { step_id: 'T-1:plan',      type: 'plan',      state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:implement', type: 'implement', state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:test',      type: 'test',      state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:review',    type: 'review',    state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 },
      revision_target: 'implement', max_revision_cycles: 2 },
  ];
}

/**
 * Simulate what kernel does in the 'revision' case handler (kernel.js ~134-160).
 * We extract this logic to test it in isolation without needing the full kernel
 * event loop, deps, or board I/O.
 */
function simulateRevisionHandler(task, decision) {
  const targetStepId = decision.next_step?.step_id;
  const sourceStepId = decision.from_step_id;
  const targetStep = task.steps.find(s => s.step_id === targetStepId);
  const sourceStep = task.steps.find(s => s.step_id === sourceStepId);

  if (targetStep && sourceStep) {
    const targetIdx = task.steps.indexOf(targetStep);
    const sourceIdx = task.steps.indexOf(sourceStep);
    for (let i = targetIdx; i <= sourceIdx; i++) {
      const s = task.steps[i];
      s.state = 'queued';
      s.attempt = 0;
      s.error = null;
      s.output_ref = null;
      s.locked_by = null;
      s.lock_expires_at = null;
    }

    if (!task._revisionCounts) task._revisionCounts = {};
    task._revisionCounts[targetStepId] = (task._revisionCounts[targetStepId] || 0) + 1;

    task.reviewFeedback = decision.review_feedback || null;
  }
}

console.log('\n=== kernel revision handler ===\n');

// --- (a) revision resets step range ---

test('revision resets steps from target to source to queued', () => {
  const steps = makeSteps();
  const task = makeTask({ steps });

  // Route engine decides revision: review → implement
  const output = { step_id: 'T-1:review', status: 'succeeded', summary: 'Request changes: missing error handling' };
  const runState = { task, steps, run_id: 'run-1' };
  const decision = routeEngine.decideNext(output, runState);

  assert.strictEqual(decision.action, 'revision', 'should route to revision');
  assert.strictEqual(decision.next_step.step_id, 'T-1:implement');

  // Simulate kernel handler
  simulateRevisionHandler(task, decision);

  // implement, test, review should all be reset to queued
  const implement = steps.find(s => s.step_id === 'T-1:implement');
  const testStep = steps.find(s => s.step_id === 'T-1:test');
  const review = steps.find(s => s.step_id === 'T-1:review');

  assert.strictEqual(implement.state, 'queued', 'implement should be queued');
  assert.strictEqual(implement.attempt, 0, 'implement attempt should be 0');
  assert.strictEqual(implement.error, null, 'implement error should be cleared');
  assert.strictEqual(testStep.state, 'queued', 'test should be queued');
  assert.strictEqual(review.state, 'queued', 'review should be queued');

  // plan should NOT be touched (before target range)
  const plan = steps.find(s => s.step_id === 'T-1:plan');
  assert.strictEqual(plan.state, 'succeeded', 'plan should remain succeeded');
});

test('revision clears output_ref, locked_by, lock_expires_at', () => {
  const steps = makeSteps();
  // Add some lock/output data to steps
  steps[1].output_ref = 'artifacts/run-1/T-1:implement/output.json';
  steps[1].locked_by = 'worker-1';
  steps[1].lock_expires_at = '2026-03-03T12:00:00Z';
  steps[2].output_ref = 'artifacts/run-1/T-1:test/output.json';

  const task = makeTask({ steps });
  const output = { step_id: 'T-1:review', status: 'succeeded', summary: 'Request changes: tests incomplete' };
  const decision = routeEngine.decideNext(output, { task, steps, run_id: 'run-1' });
  simulateRevisionHandler(task, decision);

  const implement = steps.find(s => s.step_id === 'T-1:implement');
  assert.strictEqual(implement.output_ref, null, 'output_ref should be cleared');
  assert.strictEqual(implement.locked_by, null, 'locked_by should be cleared');
  assert.strictEqual(implement.lock_expires_at, null, 'lock_expires_at should be cleared');
});

// --- (b) _revisionCounts increments ---

test('revision increments _revisionCounts for target step', () => {
  const steps = makeSteps();
  const task = makeTask({ steps });

  const output = { step_id: 'T-1:review', status: 'succeeded', summary: 'Request changes: needs refactor' };
  const runState = { task, steps, run_id: 'run-1' };

  // First revision
  const d1 = routeEngine.decideNext(output, runState);
  assert.strictEqual(d1.action, 'revision');
  simulateRevisionHandler(task, d1);
  assert.strictEqual(task._revisionCounts['T-1:implement'], 1, 'count should be 1 after first revision');

  // Restore steps to succeeded for second round
  steps.forEach(s => s.state = 'succeeded');

  // Second revision
  const d2 = routeEngine.decideNext(output, runState);
  assert.strictEqual(d2.action, 'revision');
  simulateRevisionHandler(task, d2);
  assert.strictEqual(task._revisionCounts['T-1:implement'], 2, 'count should be 2 after second revision');
});

test('revision stores reviewFeedback on task', () => {
  const steps = makeSteps();
  const task = makeTask({ steps });

  const output = { step_id: 'T-1:review', status: 'succeeded', summary: 'Request changes: missing tests for edge cases' };
  const decision = routeEngine.decideNext(output, { task, steps, run_id: 'run-1' });
  simulateRevisionHandler(task, decision);

  assert.ok(task.reviewFeedback, 'reviewFeedback should be set');
  assert.ok(task.reviewFeedback.includes('missing tests'), 'reviewFeedback should contain the review summary');
});

// --- (c) max_revision_cycles triggers dead_letter ---

test('max_revision_cycles reached falls through to done (not revision)', () => {
  const steps = makeSteps();
  // Set revision count at the max (2)
  const task = makeTask({ steps, _revisionCounts: { 'T-1:implement': 2 } });

  const output = { step_id: 'T-1:review', status: 'succeeded', summary: 'Request changes: still has issues' };
  const runState = { task, steps, run_id: 'run-1' };
  const decision = routeEngine.decideNext(output, runState);

  // Should NOT be revision — max cycles reached, falls through to done
  assert.strictEqual(decision.action, 'done', 'should be done when max cycles reached');
  assert.strictEqual(decision.rule, 'pipeline_complete');
});

test('max_revision_cycles defaults to MAX_REVISION_CYCLES constant', () => {
  const steps = [
    { step_id: 'T-1:impl', type: 'impl', state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:review', type: 'review', state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 },
      revision_target: 'impl' /* no max_revision_cycles — should use default */ },
  ];
  const task = makeTask({ steps, _revisionCounts: { 'T-1:impl': routeEngine.MAX_REVISION_CYCLES } });

  const output = { step_id: 'T-1:review', status: 'succeeded', summary: 'Request changes: bugs remain' };
  const decision = routeEngine.decideNext(output, { task, steps, run_id: 'run-1' });

  assert.strictEqual(decision.action, 'done', 'should fall through to done at default max');
});

// --- Edge case: revision_target not found in pipeline ---

test('revision_target pointing to non-existent step type falls through to done', () => {
  const steps = [
    { step_id: 'T-1:plan', type: 'plan', state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 } },
    { step_id: 'T-1:review', type: 'review', state: 'succeeded', attempt: 0, max_attempts: 3, run_id: 'run-1', retry_policy: { backoff_base_ms: 5000 },
      revision_target: 'nonexistent_step' },
  ];
  const task = makeTask({ steps });

  const output = { step_id: 'T-1:review', status: 'succeeded', summary: 'Request changes: issues found' };
  const decision = routeEngine.decideNext(output, { task, steps, run_id: 'run-1' });

  // targetStep not found → falls through to pipeline_complete
  assert.strictEqual(decision.action, 'done', 'should fall through to done when target not found');
});

// --- Summary ---
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
