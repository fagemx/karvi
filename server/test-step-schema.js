#!/usr/bin/env node
/**
 * test-step-schema.js — Unit tests for step-schema.js and artifact-store.js
 *
 * Usage: node server/test-step-schema.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

function test(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ─────────────────────────────────────
// Step Schema Tests
// ─────────────────────────────────────

const stepSchema = require('./step-schema');

console.log('\n=== step-schema.js ===\n');

test('createStep returns correct defaults', () => {
  const step = stepSchema.createStep('T-00001', 'run-abc', 'plan');
  assert.strictEqual(step.step_id, 'T-00001:plan');
  assert.strictEqual(step.task_id, 'T-00001');
  assert.strictEqual(step.run_id, 'run-abc');
  assert.strictEqual(step.type, 'plan');
  assert.strictEqual(step.state, 'queued');
  assert.strictEqual(step.attempt, 0);
  assert.strictEqual(step.max_attempts, 3);
  assert.strictEqual(step.locked_by, null);
  assert.strictEqual(step.input_ref, null);
  assert.strictEqual(step.output_ref, null);
  assert.strictEqual(step.error, null);
  assert.ok(step.scheduled_at);
  assert.deepStrictEqual(step.retry_policy, stepSchema.DEFAULT_RETRY_POLICY);
});

test('createStep accepts custom retry_policy', () => {
  const step = stepSchema.createStep('T-00001', 'run-abc', 'test', {
    retry_policy: { max_attempts: 5, timeout_ms: 600000 },
  });
  assert.strictEqual(step.max_attempts, 5);
  assert.strictEqual(step.retry_policy.timeout_ms, 600000);
  // defaults preserved for unspecified fields
  assert.strictEqual(step.retry_policy.backoff_base_ms, 5000);
});

test('canTransitionStep validates all transitions', () => {
  // Valid
  assert.strictEqual(stepSchema.canTransitionStep('queued', 'running'), true);
  assert.strictEqual(stepSchema.canTransitionStep('queued', 'cancelled'), true);  // can cancel before start
  assert.strictEqual(stepSchema.canTransitionStep('running', 'succeeded'), true);
  assert.strictEqual(stepSchema.canTransitionStep('running', 'failed'), true);
  assert.strictEqual(stepSchema.canTransitionStep('running', 'cancelled'), true);    // can kill during execution
  assert.strictEqual(stepSchema.canTransitionStep('failed', 'queued'), true);
  assert.strictEqual(stepSchema.canTransitionStep('failed', 'dead'), true);
  assert.strictEqual(stepSchema.canTransitionStep('failed', 'cancelled'), true);     // can kill failed step
  // Invalid (terminal states and wrong sequencing)
  assert.strictEqual(stepSchema.canTransitionStep('queued', 'succeeded'), false);
  assert.strictEqual(stepSchema.canTransitionStep('running', 'queued'), false);
  assert.strictEqual(stepSchema.canTransitionStep('succeeded', 'running'), false);   // can't un-succeed
  assert.strictEqual(stepSchema.canTransitionStep('dead', 'queued'), false);         // can't un-dead
  assert.strictEqual(stepSchema.canTransitionStep('cancelled', 'queued'), false);    // terminal — no retry possible
  assert.strictEqual(stepSchema.canTransitionStep('queued', 'queued'), false);
});

test('transitionStep to running sets started_at', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  assert.strictEqual(step.started_at, null);
  stepSchema.transitionStep(step, 'running');
  assert.strictEqual(step.state, 'running');
  assert.ok(step.started_at);
});

test('transitionStep to succeeded sets completed_at', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  stepSchema.transitionStep(step, 'running');
  stepSchema.transitionStep(step, 'succeeded');
  assert.strictEqual(step.state, 'succeeded');
  assert.ok(step.completed_at);
});

test('transitionStep to failed auto-requeues with backoff', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  stepSchema.transitionStep(step, 'running');
  const beforeFail = Date.now();
  stepSchema.transitionStep(step, 'failed', { error: 'timeout' });
  // Should auto-requeue (attempt 1 < max 3)
  assert.strictEqual(step.state, 'queued');
  assert.strictEqual(step.attempt, 1);
  assert.strictEqual(step.error, 'timeout');
  assert.strictEqual(step.locked_by, null);
  // scheduled_at should be in the future (backoff)
  const scheduledAt = new Date(step.scheduled_at).getTime();
  assert.ok(scheduledAt >= beforeFail);
});

test('transitionStep auto-escalates to dead on max attempts', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan', {
    retry_policy: { max_attempts: 2 },
  });
  // Attempt 1: queued → running → failed (requeue)
  stepSchema.transitionStep(step, 'running');
  stepSchema.transitionStep(step, 'failed', { error: 'err1' });
  assert.strictEqual(step.state, 'queued');
  assert.strictEqual(step.attempt, 1);

  // Attempt 2: queued → running → failed (dead)
  stepSchema.transitionStep(step, 'running');
  stepSchema.transitionStep(step, 'failed', { error: 'err2' });
  assert.strictEqual(step.state, 'dead');
  assert.strictEqual(step.attempt, 2);
});

test('ensureStepTransition throws on invalid transition', () => {
  assert.throws(() => {
    stepSchema.ensureStepTransition('queued', 'succeeded');
  }, (err) => err.code === 'INVALID_STEP_TRANSITION');
});

test('computeIdempotencyKey is deterministic', () => {
  const key1 = stepSchema.computeIdempotencyKey('run-1', 'T-1:plan', { foo: 'bar' });
  const key2 = stepSchema.computeIdempotencyKey('run-1', 'T-1:plan', { foo: 'bar' });
  assert.strictEqual(key1, key2);
  assert.strictEqual(key1.length, 64); // sha256 hex
  // Different input → different key
  const key3 = stepSchema.computeIdempotencyKey('run-1', 'T-1:plan', { foo: 'baz' });
  assert.notStrictEqual(key1, key3);
});

test('isStepIdempotent returns true only for succeeded', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  assert.strictEqual(stepSchema.isStepIdempotent(step), false);
  stepSchema.transitionStep(step, 'running');
  assert.strictEqual(stepSchema.isStepIdempotent(step), false);
  stepSchema.transitionStep(step, 'succeeded');
  assert.strictEqual(stepSchema.isStepIdempotent(step), true);
});

// ─────────────────────────────────────
// ERROR_KINDS Tests
// ─────────────────────────────────────

console.log('\n=== ERROR_KINDS ===\n');

test('ERROR_KINDS has all required kinds', () => {
  const expectedKinds = ['TEMPORARY', 'PROVIDER', 'AGENT_ERROR', 'FINALIZE', 'CONTRACT', 'PROTECTED', 'CONFIG', 'UNKNOWN'];
  for (const kind of expectedKinds) {
    assert.ok(stepSchema.ERROR_KINDS[kind], `ERROR_KINDS should have ${kind}`);
    assert.ok('retryable' in stepSchema.ERROR_KINDS[kind], `${kind} should have retryable field`);
    assert.ok('backoff' in stepSchema.ERROR_KINDS[kind], `${kind} should have backoff field`);
  }
});

test('ERROR_KINDS non-retryable kinds have null backoff', () => {
  assert.strictEqual(stepSchema.ERROR_KINDS.PROTECTED.backoff, null);
  assert.strictEqual(stepSchema.ERROR_KINDS.CONFIG.backoff, null);
});

// ─────────────────────────────────────
// computeBackoff Tests
// ─────────────────────────────────────

console.log('\n=== computeBackoff() ===\n');

test('computeBackoff returns 0 for immediate backoff', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  const kindConfig = { backoff: 'immediate' };
  assert.strictEqual(stepSchema.computeBackoff(kindConfig, step), 0);
});

test('computeBackoff returns linear delay for linear backoff', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  step.attempt = 2;
  const kindConfig = { backoff: 'linear' };
  const expected = step.retry_policy.backoff_base_ms * step.attempt; // 5000 * 2 = 10000
  assert.strictEqual(stepSchema.computeBackoff(kindConfig, step), expected);
});

test('computeBackoff returns exponential delay for exponential backoff', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  step.attempt = 3;
  const kindConfig = { backoff: 'exponential' };
  const expected = step.retry_policy.backoff_base_ms
    * Math.pow(step.retry_policy.backoff_multiplier, step.attempt - 1); // 5000 * 2^2 = 20000
  assert.strictEqual(stepSchema.computeBackoff(kindConfig, step), expected);
});

test('computeBackoff returns 0 for null backoff', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  const kindConfig = { backoff: null };
  assert.strictEqual(stepSchema.computeBackoff(kindConfig, step), 0);
});

// ─────────────────────────────────────
// transitionStep with errorKind Tests
// ─────────────────────────────────────

console.log('\n=== transitionStep with errorKind ===\n');

test('transitionStep to failed auto-requeues with backoff', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  stepSchema.transitionStep(step, 'running');
  const beforeFail = Date.now();
  stepSchema.transitionStep(step, 'failed', { error: 'timeout', errorKind: 'TEMPORARY' });
  // Should auto-requeue (attempt 1 < max 3)
  assert.strictEqual(step.state, 'queued');
  assert.strictEqual(step.attempt, 1);
  assert.strictEqual(step.error, 'timeout');
  assert.strictEqual(step.errorKind, 'TEMPORARY');
  assert.strictEqual(step.locked_by, null);
  // scheduled_at should be in the future (backoff)
  const scheduledAt = new Date(step.scheduled_at).getTime();
  assert.ok(scheduledAt >= beforeFail);
});

test('transitionStep with FINALIZE errorKind uses immediate backoff', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  stepSchema.transitionStep(step, 'running');
  const beforeFail = Date.now();
  stepSchema.transitionStep(step, 'failed', { error: 'finalize failed', errorKind: 'FINALIZE' });
  
  assert.strictEqual(step.state, 'queued');
  assert.strictEqual(step.errorKind, 'FINALIZE');
  // Immediate retry → scheduled_at should be ~now
  const scheduledAt = new Date(step.scheduled_at).getTime();
  assert.ok(scheduledAt - beforeFail < 1000, 'should retry immediately');
});

test('transitionStep with PROTECTED errorKind goes to dead', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  stepSchema.transitionStep(step, 'running');
  stepSchema.transitionStep(step, 'failed', { error: 'protected violation', errorKind: 'PROTECTED' });
  
  // PROTECTED is not retryable → dead immediately
  assert.strictEqual(step.state, 'dead');
  assert.strictEqual(step.errorKind, 'PROTECTED');
  assert.strictEqual(step.attempt, 1);
});

test('transitionStep defaults errorKind to UNKNOWN', () => {
  const step = stepSchema.createStep('T-1', 'run-1', 'plan');
  stepSchema.transitionStep(step, 'running');
  stepSchema.transitionStep(step, 'failed', { error: 'unknown error' });
  
  assert.strictEqual(step.errorKind, 'UNKNOWN');
});

// ─────────────────────────────────────
// Artifact Store Tests
// ─────────────────────────────────────

const artifactStore = require('./artifact-store');

console.log('\n=== artifact-store.js ===\n');

// Use a temp directory to avoid polluting project
const ORIG_DIR = artifactStore.ARTIFACT_DIR;
const TEST_DIR = path.join(os.tmpdir(), `karvi-test-artifacts-${Date.now()}`);

// Monkey-patch artifact dir for testing
const artifactPathOrig = artifactStore.artifactPath;
// We need to override the module's internal path — re-require with env override won't work
// Instead, use the module's functions directly since they use ARTIFACT_DIR from __dirname
// For isolated testing, we'll test via writeArtifact/readArtifact which use the internal path

// Clean approach: test with real paths but in a subdirectory
const testRunId = `test-run-${Date.now()}`;

test('writeArtifact + readArtifact roundtrip', () => {
  const data = { objective: 'implement auth', constraints: ['no breaking changes'] };
  artifactStore.writeArtifact(testRunId, 'T-00001:plan', 'input', data);
  const read = artifactStore.readArtifact(testRunId, 'T-00001:plan', 'input');
  assert.deepStrictEqual(read, data);
});

test('readArtifact returns null for missing', () => {
  const result = artifactStore.readArtifact('nonexistent-run', 'T-99999:plan', 'input');
  assert.strictEqual(result, null);
});

test('artifactExists returns correct boolean', () => {
  assert.strictEqual(artifactStore.artifactExists(testRunId, 'T-00001:plan', 'input'), true);
  assert.strictEqual(artifactStore.artifactExists(testRunId, 'T-00001:plan', 'output'), false);
});

test('writeArtifact creates directory recursively', () => {
  const deepRunId = `${testRunId}/nested/deep`;
  artifactStore.writeArtifact(deepRunId, 'T-00002:test', 'output', { status: 'succeeded' });
  const read = artifactStore.readArtifact(deepRunId, 'T-00002:test', 'output');
  assert.deepStrictEqual(read, { status: 'succeeded' });
});

test('listArtifacts returns correct entries', () => {
  artifactStore.writeArtifact(testRunId, 'T-00001:plan', 'output', { summary: 'done' });
  const list = artifactStore.listArtifacts(testRunId);
  assert.ok(list.length >= 2); // input + output from earlier tests
  const kinds = list.map(a => `${a.stepId}:${a.kind}`);
  assert.ok(kinds.includes('T-00001:plan:input'));
  assert.ok(kinds.includes('T-00001:plan:output'));
});

// ─────────────────────────────────────
// Management.js Step Helpers
// ─────────────────────────────────────

const mgmt = require('./management');

console.log('\n=== management.js step helpers ===\n');

test('generateStepsForTask creates default pipeline', () => {
  const task = { id: 'T-00001' };
  const steps = mgmt.generateStepsForTask(task, 'run-xyz');
  assert.strictEqual(steps.length, 3);
  assert.deepStrictEqual(steps.map(s => s.type), ['plan', 'implement', 'review']);
  assert.strictEqual(steps[0].step_id, 'T-00001:plan');
  assert.strictEqual(steps[0].run_id, 'run-xyz');
});

test('generateStepsForTask accepts custom pipeline', () => {
  const task = { id: 'T-00002' };
  const steps = mgmt.generateStepsForTask(task, 'run-abc', ['plan', 'implement']);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(steps.map(s => s.type), ['plan', 'implement']);
});

test('generateStepsForTask accepts semantic pipeline objects', () => {
  const task = { id: 'T-00003' };
  const steps = mgmt.generateStepsForTask(task, 'run-sem', [
    { type: 'concept', instruction: 'Brainstorm 3 angles', skill: '/blog-concept' },
    { type: 'draft', instruction: 'Write first draft', runtime_hint: 'claude' },
  ]);

  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(steps.map(s => s.type), ['concept', 'draft']);
  assert.strictEqual(steps[0].instruction, 'Brainstorm 3 angles');
  assert.strictEqual(steps[0].skill, '/blog-concept');
  assert.strictEqual(steps[1].runtime_hint, 'claude');
});

test('default pipeline review step has revision_target=implement', () => {
  const task = { id: 'T-REV0' };
  const steps = mgmt.generateStepsForTask(task, 'run-rev0');
  assert.strictEqual(steps.length, 3);
  // review step should carry revision_target from DEFAULT_STEP_PIPELINE
  assert.strictEqual(steps[2].type, 'review');
  assert.strictEqual(steps[2].revision_target, 'implement');
  // plan and implement should NOT have revision_target
  assert.strictEqual(steps[0].revision_target, null);
  assert.strictEqual(steps[1].revision_target, null);
});

test('generateStepsForTask passes revision_target and max_revision_cycles from pipeline', () => {
  const task = { id: 'T-REV1' };
  const steps = mgmt.generateStepsForTask(task, 'run-rev1', [
    'plan',
    'implement',
    { type: 'review', revision_target: 'implement', max_revision_cycles: 5 },
  ]);
  assert.strictEqual(steps.length, 3);
  assert.strictEqual(steps[2].revision_target, 'implement');
  assert.strictEqual(steps[2].max_revision_cycles, 5);
  assert.strictEqual(steps[0].revision_target, null);
  assert.strictEqual(steps[1].revision_target, null);
});

// --- Pipeline Templates ---

test('generateStepsForTask resolves string pipeline from board templates', () => {
  const board = { pipelineTemplates: {
    'video-ad': [
      { type: 'shotgen', skill: '/shotgen' },
      { type: 'shotcheck', revision_target: 'shotgen' },
    ]
  }};
  const task = { id: 'T-TPL1', pipeline: 'video-ad' };
  const steps = mgmt.generateStepsForTask(task, 'run-tpl', null, board);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(steps.map(s => s.type), ['shotgen', 'shotcheck']);
  assert.strictEqual(steps[1].revision_target, 'shotgen');
});

test('generateStepsForTask falls back to default for unknown template', () => {
  const board = { pipelineTemplates: {} };
  const task = { id: 'T-TPL2', pipeline: 'nonexistent' };
  const steps = mgmt.generateStepsForTask(task, 'run-tpl2', null, board);
  assert.strictEqual(steps.length, 3);
  assert.deepStrictEqual(steps.map(s => s.type), ['plan', 'implement', 'review']);
});

test('generateStepsForTask inline array still works with board param', () => {
  const board = { pipelineTemplates: { 'video-ad': [{ type: 'shotgen' }] } };
  const task = { id: 'T-TPL3', pipeline: ['plan', 'implement'] };
  const steps = mgmt.generateStepsForTask(task, 'run-tpl3', null, board);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(steps.map(s => s.type), ['plan', 'implement']);
});

test('generateStepsForTask caller pipeline arg overrides task.pipeline', () => {
  const board = { pipelineTemplates: {} };
  const task = { id: 'T-TPL4', pipeline: ['plan'] };
  const steps = mgmt.generateStepsForTask(task, 'run-tpl4', ['implement'], board);
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].type, 'implement');
});

test('resolvePipeline returns null for invalid inputs', () => {
  assert.strictEqual(mgmt.resolvePipeline(undefined, {}), null);
  assert.strictEqual(mgmt.resolvePipeline(42, {}), null);
  assert.strictEqual(mgmt.resolvePipeline(null, {}), null);
});

test('resolvePipeline returns array for valid template name', () => {
  const board = { pipelineTemplates: { 'x': [{ type: 'a' }] } };
  const result = mgmt.resolvePipeline('x', board);
  assert.deepStrictEqual(result, [{ type: 'a' }]);
});

test('buildDispatchPlan includes steps field', () => {
  // Minimal board and task for buildDispatchPlan
  const board = {
    taskPlan: { tasks: [{ id: 'T-00001', assignee: 'engineer_lite', status: 'dispatched' }] },
    controls: {},
    lessons: [],
    participants: [{ id: 'owner', type: 'human' }],
  };
  const task = board.taskPlan.tasks[0];
  const plan = mgmt.buildDispatchPlan(board, task, { steps: ['mock-step'] });
  assert.deepStrictEqual(plan.steps, ['mock-step']);

  const planNoSteps = mgmt.buildDispatchPlan(board, task);
  assert.strictEqual(planNoSteps.steps, null);
});

test('buildDispatchPlan includes workingDir when provided', () => {
  const board = {
    taskPlan: { tasks: [{ id: 'T-00001', assignee: 'engineer_lite', status: 'dispatched' }] },
    controls: {},
    lessons: [],
    participants: [{ id: 'owner', type: 'human' }],
  };
  const task = board.taskPlan.tasks[0];
  const plan = mgmt.buildDispatchPlan(board, task, { workingDir: '/path/to/worktree' });
  assert.strictEqual(plan.workingDir, '/path/to/worktree');
});

test('buildDispatchPlan workingDir defaults to null', () => {
  const board = {
    taskPlan: { tasks: [{ id: 'T-00001', assignee: 'engineer_lite', status: 'dispatched' }] },
    controls: {},
    lessons: [],
    participants: [{ id: 'owner', type: 'human' }],
  };
  const task = board.taskPlan.tasks[0];
  const plan = mgmt.buildDispatchPlan(board, task);
  assert.strictEqual(plan.workingDir, null);
});

// ─────────────────────────────────────
// Cleanup & Summary
// ─────────────────────────────────────

// Clean up test artifacts
try {
  fs.rmSync(path.join(artifactStore.ARTIFACT_DIR, testRunId), { recursive: true, force: true });
} catch (err) {
  console.warn('[test-step-schema] cleanup skipped:', err.message);
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
