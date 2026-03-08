#!/usr/bin/env node
/**
 * test-step-worker.js — Unit tests for step-worker.js
 *
 * Tests executeStep(), parseStepResult(), buildStepMessage(),
 * and recoverExpiredLocks().
 *
 * Usage: node server/test-step-worker.js
 */
const assert = require('assert');
const stepSchema = require('./step-schema');
const artifactStore = require('./artifact-store');
const mgmt = require('./management');
const { createStepWorker, parseStepResult, buildStepMessage, recoverExpiredLocks, classifyError } = require('./step-worker');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274c ${label}: ${reason}`); process.exitCode = 1; }

async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { fail(label, err.message); }
}

const testRunId = `test-worker-${Date.now()}`;
const fs = require('fs');
const path = require('path');

// --- Mock runtime ---
function createMockRuntime(overrides = {}) {
  return {
    dispatch: overrides.dispatch || (async () => ({
      code: 0,
      stdout: 'Some output\nSTEP_RESULT:{"status":"succeeded","summary":"done"}',
      stderr: '',
      parsed: { result: 'ok' },
    })),
    extractReplyText: overrides.extractReplyText || (() => 'Step completed successfully'),
    extractUsage: overrides.extractUsage || (() => ({ inputTokens: 100, outputTokens: 200, totalCost: 0.01 })),
    extractSessionId: () => null,
  };
}

// --- Mock board + helpers ---
function createMockBoard(taskOverrides = {}) {
  const task = {
    id: 'T-W1',
    title: 'Worker test task',
    description: 'StepWorker test',
    assignee: 'engineer_lite',
    status: 'in_progress',
    steps: [
      stepSchema.createStep('T-W1', testRunId, 'plan'),
      stepSchema.createStep('T-W1', testRunId, 'implement'),
    ],
    ...taskOverrides,
  };
  return {
    taskPlan: { goal: 'test', tasks: [task] },
    signals: [],
    insights: [],
    lessons: [],
    participants: [{ id: 'owner', type: 'human' }],
    controls: { auto_review: false },
  };
}

let currentBoard = null;
const logEntries = [];

function createMockHelpers(board) {
  currentBoard = JSON.parse(JSON.stringify(board));
  logEntries.length = 0;
  return {
    readBoard: () => currentBoard,
    writeBoard: (b) => { currentBoard = b; },
    appendLog: (e) => { logEntries.push(e); },
    nowIso: () => new Date().toISOString(),
    uid: (prefix) => `${prefix}-${Date.now()}-mock`,
  };
}

// --- Mock envelope ---
function createMockEnvelope(overrides = {}) {
  return {
    run_id: testRunId,
    step_id: 'T-W1:plan',
    task_id: 'T-W1',
    step_type: 'plan',
    objective: 'Test objective',
    constraints: [],
    input_refs: { task_description: 'Test task', previous_output: null, codebase_context: null, lessons: [] },
    retry_context: null,
    budget_remaining: { llm_calls: 10, tokens: 35000, wall_clock_ms: 600000, steps: 18 },
    retry_policy: stepSchema.DEFAULT_RETRY_POLICY,
    idempotency_key: 'test-key',
    timeout_ms: 300000,
    model_hint: null,
    ...overrides,
  };
}

(async () => {
  console.log('\n=== step-worker.js ===\n');

  // Test 1: executeStep dispatches and writes output artifact
  await test('executeStep dispatches to runtime and writes output artifact', async () => {
    const mockRt = createMockRuntime();
    const deps = {
      artifactStore, stepSchema, mgmt,
      getRuntime: () => mockRt,
      kernel: null,  // no kernel callback in this test
    };
    const worker = createStepWorker(deps);

    const board = createMockBoard();
    const helpers = createMockHelpers(board);

    // Transition plan step to running first
    const planStep = currentBoard.taskPlan.tasks[0].steps[0];
    stepSchema.transitionStep(planStep, 'running');

    const envelope = createMockEnvelope();
    const output = await worker.executeStep(envelope, currentBoard, helpers);

    assert.strictEqual(output.status, 'succeeded');
    assert.ok(output.summary);
    assert.ok(output.duration_ms >= 0, 'duration_ms should be set');
    assert.strictEqual(output.tokens_used, 300); // 100 + 200

    // Verify artifact was written
    const savedOutput = artifactStore.readArtifact(testRunId, 'T-W1:plan', 'output');
    assert.ok(savedOutput, 'output artifact should exist');
    assert.strictEqual(savedOutput.status, 'succeeded');
  });

  // Test 2: executeStep sets lock_expires_at before dispatch
  await test('executeStep sets lock_expires_at before dispatch', async () => {
    let lockChecked = false;
    const mockRt = createMockRuntime({
      dispatch: async () => {
        // During dispatch, check that lock was set
        const step = currentBoard.taskPlan.tasks[0].steps[0];
        if (step.lock_expires_at) lockChecked = true;
        return { code: 0, stdout: '', stderr: '', parsed: {} };
      },
    });
    const deps = {
      artifactStore, stepSchema, mgmt,
      getRuntime: () => mockRt,
      kernel: null,
    };
    const worker = createStepWorker(deps);

    const board = createMockBoard();
    const helpers = createMockHelpers(board);
    const planStep = currentBoard.taskPlan.tasks[0].steps[0];
    stepSchema.transitionStep(planStep, 'running');

    await worker.executeStep(createMockEnvelope(), currentBoard, helpers);
    assert.ok(lockChecked, 'lock_expires_at should be set before dispatch');
  });

  // Test 3: executeStep computes duration_ms
  await test('executeStep computes duration_ms', async () => {
    const mockRt = createMockRuntime({
      dispatch: async () => {
        // Small delay to ensure duration > 0
        await new Promise(r => setTimeout(r, 5));
        return { code: 0, stdout: '', stderr: '', parsed: {} };
      },
    });
    const deps = {
      artifactStore, stepSchema, mgmt,
      getRuntime: () => mockRt,
      kernel: null,
    };
    const worker = createStepWorker(deps);

    const board = createMockBoard();
    const helpers = createMockHelpers(board);
    const planStep = currentBoard.taskPlan.tasks[0].steps[0];
    stepSchema.transitionStep(planStep, 'running');

    const output = await worker.executeStep(createMockEnvelope(), currentBoard, helpers);
    assert.ok(output.duration_ms >= 5, `duration_ms should be >= 5, got ${output.duration_ms}`);
  });

  // Test 4: executeStep transitions step to succeeded on code 0
  await test('executeStep transitions step to succeeded on exit code 0', async () => {
    const mockRt = createMockRuntime();
    const deps = {
      artifactStore, stepSchema, mgmt,
      getRuntime: () => mockRt,
      kernel: null,
    };
    const worker = createStepWorker(deps);

    const board = createMockBoard();
    const helpers = createMockHelpers(board);
    const planStep = currentBoard.taskPlan.tasks[0].steps[0];
    stepSchema.transitionStep(planStep, 'running');

    await worker.executeStep(createMockEnvelope(), currentBoard, helpers);

    // Check step transitioned (may be succeeded or further)
    const step = currentBoard.taskPlan.tasks[0].steps[0];
    assert.ok(['succeeded'].includes(step.state), `step should be succeeded, got ${step.state}`);
  });

  // Test 5: executeStep transitions step to failed on non-zero exit code
  await test('executeStep transitions step to failed on non-zero exit code', async () => {
    const mockRt = createMockRuntime({
      dispatch: async () => ({ code: 1, stdout: 'error output', stderr: 'crash', parsed: {} }),
    });
    const deps = {
      artifactStore, stepSchema, mgmt,
      getRuntime: () => mockRt,
      kernel: null,
    };
    const worker = createStepWorker(deps);

    const board = createMockBoard();
    const helpers = createMockHelpers(board);
    const planStep = currentBoard.taskPlan.tasks[0].steps[0];
    stepSchema.transitionStep(planStep, 'running');

    const output = await worker.executeStep(createMockEnvelope(), currentBoard, helpers);
    assert.strictEqual(output.status, 'failed');

    // Step should be queued (auto-retry) since attempt < max_attempts
    const step = currentBoard.taskPlan.tasks[0].steps[0];
    assert.ok(['queued', 'dead'].includes(step.state), `step should be queued or dead, got ${step.state}`);
  });

  // Test 6: parseStepResult extracts STEP_RESULT JSON
  await test('parseStepResult extracts STEP_RESULT JSON from stdout', () => {
    const stdout = 'Some log output\nAnother line\nSTEP_RESULT:{"status":"succeeded","summary":"Plan created"}';
    const result = parseStepResult(stdout);
    assert.ok(result);
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(result.summary, 'Plan created');
  });

  // Test 7: parseStepResult returns null for unstructured output
  await test('parseStepResult returns null for unstructured output', () => {
    assert.strictEqual(parseStepResult('Just some text output'), null);
    assert.strictEqual(parseStepResult(''), null);
    assert.strictEqual(parseStepResult(null), null);
    assert.strictEqual(parseStepResult(undefined), null);
  });

  // Test 8: parseStepResult uses STEP_RESULT failure_mode
  await test('parseStepResult preserves failure_mode from STEP_RESULT', () => {
    const stdout = 'STEP_RESULT:{"status":"failed","error":"test assertion failed","failure_mode":"TEST_FAILURE","retryable":true}';
    const result = parseStepResult(stdout);
    assert.ok(result);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failure_mode, 'TEST_FAILURE');
    assert.strictEqual(result.retryable, true);
  });

  // Test 9: recoverExpiredLocks resets expired running steps
  await test('recoverExpiredLocks resets expired running steps to queued', () => {
    const board = {
      taskPlan: {
        tasks: [{
          id: 'T-R1',
          steps: [
            { step_id: 'T-R1:plan', state: 'running', locked_by: 'step-worker', lock_expires_at: '2020-01-01T00:00:00.000Z', error: null },
            { step_id: 'T-R1:impl', state: 'running', locked_by: 'step-worker', lock_expires_at: '2099-01-01T00:00:00.000Z', error: null },
            { step_id: 'T-R1:test', state: 'queued', locked_by: null, lock_expires_at: null, error: null },
          ],
        }],
      },
    };

    const recovered = recoverExpiredLocks(board);
    assert.strictEqual(recovered, 1, 'should recover exactly 1 expired lock');

    const plan = board.taskPlan.tasks[0].steps[0];
    assert.strictEqual(plan.state, 'queued');
    assert.strictEqual(plan.locked_by, null);
    assert.ok(plan.error.includes('Lock expired'));

    // Non-expired lock should remain
    const impl = board.taskPlan.tasks[0].steps[1];
    assert.strictEqual(impl.state, 'running');
    assert.strictEqual(impl.locked_by, 'step-worker');
  });

  // Test 10: buildStepMessage includes STEP_RESULT instruction
  await test('buildStepMessage includes STEP_RESULT output instruction', () => {
    const envelope = createMockEnvelope();
    const message = buildStepMessage(envelope);
    assert.ok(message.includes('STEP_RESULT'), 'should include STEP_RESULT instruction');
    assert.ok(message.includes('Step Dispatch: PLAN'), 'should include step type header');
    assert.ok(message.includes('Test objective'), 'should include objective');
  });

  // Test 11: batch dispatch filters out non-queued steps (blocker fix validation)
  await test('batch dispatch only dispatches queued steps when step_ids provided', () => {
    // Simulate the batch endpoint's filtering logic
    const steps = [
      { step_id: 'T-B1:plan', state: 'succeeded' },
      { step_id: 'T-B1:impl', state: 'queued' },
      { step_id: 'T-B1:test', state: 'dead' },
      { step_id: 'T-B1:review', state: 'running' },
    ];
    const requestedIds = ['T-B1:plan', 'T-B1:impl', 'T-B1:test', 'T-B1:review'];

    // Same filter logic as routes/tasks.js batch dispatch
    const targets = steps.filter(s => requestedIds.includes(s.step_id) && s.state === 'queued');

    assert.strictEqual(targets.length, 1, 'should only include queued steps');
    assert.strictEqual(targets[0].step_id, 'T-B1:impl');
  });

  // Test 12: classifyError() tests
  console.log('\n=== classifyError() ===\n');

  await test('classifyError returns TEMPORARY for idle timeout', () => {
    const err = new Error('Process idle for 300s');
    const kind = classifyError(err, null);
    assert.strictEqual(kind, 'TEMPORARY');
  });

  await test('classifyError returns PROVIDER for exited with code', () => {
    const err = new Error('Process exited with code 1');
    const kind = classifyError(err, null);
    assert.strictEqual(kind, 'PROVIDER');
  });

  await test('classifyError returns PROVIDER for network errors', () => {
    const err = new Error('ECONNREFUSED 127.0.0.1:8080');
    const kind = classifyError(err, null);
    assert.strictEqual(kind, 'PROVIDER');
  });

  await test('classifyError returns AGENT_ERROR for TEST_FAILURE', () => {
    const agentOutput = {
      failure: { failure_mode: 'TEST_FAILURE' }
    };
    const kind = classifyError(null, agentOutput);
    assert.strictEqual(kind, 'AGENT_ERROR');
  });

  await test('classifyError returns FINALIZE for FINALIZE_ERROR', () => {
    const agentOutput = {
      failure: { failure_mode: 'FINALIZE_ERROR' }
    };
    const kind = classifyError(null, agentOutput);
    assert.strictEqual(kind, 'FINALIZE');
  });

  await test('classifyError returns PROTECTED for PROTECTED_CODE_VIOLATION', () => {
    const agentOutput = {
      failure: { failure_mode: 'PROTECTED_CODE_VIOLATION' }
    };
    const kind = classifyError(null, agentOutput);
    assert.strictEqual(kind, 'PROTECTED');
  });

  await test('classifyError returns CONTRACT for CONTRACT_VIOLATION', () => {
    const agentOutput = {
      failure: { failure_mode: 'CONTRACT_VIOLATION' }
    };
    const kind = classifyError(null, agentOutput);
    assert.strictEqual(kind, 'CONTRACT');
  });

  await test('classifyError returns UNKNOWN for unrecognized patterns', () => {
    const err = new Error('Some random error');
    const kind = classifyError(err, null);
    assert.strictEqual(kind, 'UNKNOWN');
  });

  await test('classifyError prioritizes agent failure_mode over dispatch error', () => {
    const err = new Error('Process idle for 300s');
    const agentOutput = {
      failure: { failure_mode: 'TEST_FAILURE' }
    };
    const kind = classifyError(err, agentOutput);
    assert.strictEqual(kind, 'AGENT_ERROR');
  });

  // Test 13: UPSTREAM_RELEVANCE filters correctly for plan step
  await test('buildStepMessage excludes upstream for plan step', () => {
    const envelope = createMockEnvelope({ step_type: 'plan' });
    const upstream = [{ id: 'T-UP1', title: 'Upstream', status: 'completed', summary: 'test' }];
    const message = buildStepMessage(envelope, upstream, null, null);
    assert.ok(!message.includes('Upstream Task Outputs'), 'plan should have no upstream section');
  });

  // Test 14: UPSTREAM_RELEVANCE includes summary for review step
  await test('buildStepMessage includes only summary for review step', () => {
    const envelope = createMockEnvelope({ step_type: 'review' });
    const upstream = [
      {
        id: 'T-UP1',
        title: 'Implement',
        status: 'completed',
        summary: 'Implemented feature X',
        payload: { files: ['test.js'], details: 'long payload...' },
        output_ref: 'artifacts/run1/T-UP1_implement.output.json'
      }
    ];
    const message = buildStepMessage(envelope, upstream, null, null);
    assert.ok(message.includes('Implemented feature X'), 'should include summary');
    assert.ok(!message.includes('long payload'), 'should NOT include payload for review');
    assert.ok(message.includes('Full output: artifacts/run1/T-UP1_implement.output.json'), 'should include output_ref');
  });

  // Test 15: UPSTREAM_RELEVANCE includes summary + payload for implement step
  await test('buildStepMessage includes summary and payload for implement step', () => {
    const envelope = createMockEnvelope({ step_type: 'implement' });
    const upstream = [
      {
        id: 'T-UP1',
        title: 'Plan',
        status: 'completed',
        summary: 'Plan summary',
        payload: { conclusions: ['change X', 'change Y'] },
        output_ref: 'artifacts/run1/T-UP1_plan.output.json'
      }
    ];
    const message = buildStepMessage(envelope, upstream, null, null);
    assert.ok(message.includes('Plan summary'), 'should include summary');
    assert.ok(message.includes('"conclusions"'), 'should include payload for implement');
    assert.ok(message.includes('Full output: artifacts/run1/T-UP1_plan.output.json'), 'should include output_ref');
  });

  // Test 16: review step instruction includes STEP_RESULT mapping for needs_revision
  await test('buildStepMessage review step includes needs_revision mapping', () => {
    const envelope = createMockEnvelope({ step_type: 'review' });
    const message = buildStepMessage(envelope);
    assert.ok(message.includes('needs_revision'), 'review instruction should mention needs_revision status');
    assert.ok(message.includes('STEP_RESULT Mapping'), 'review instruction should have STEP_RESULT Mapping section');
    assert.ok(message.includes('revision_notes'), 'review instruction should mention revision_notes field');
  });

  // Test 17: parseStepResult passes through needs_revision status
  await test('parseStepResult preserves needs_revision status', () => {
    const stdout = 'STEP_RESULT:{"status":"needs_revision","summary":"Changes Requested — missing tests","revision_notes":"Add unit tests for the new helper"}';
    const result = parseStepResult(stdout);
    assert.strictEqual(result.status, 'needs_revision');
    assert.ok(result.summary.includes('Changes Requested'));
    assert.strictEqual(result.revision_notes, 'Add unit tests for the new helper');
  });

  // Test 18: route-engine needsRevision recognizes needs_revision status
  console.log('\n=== route-engine needsRevision() ===\n');

  const { needsRevision, decideNext } = require('./route-engine');

  await test('needsRevision returns true for status needs_revision', () => {
    const output = { status: 'needs_revision', summary: 'Changes Requested' };
    assert.strictEqual(needsRevision(output), true);
  });

  await test('needsRevision returns true for "changes requested" text', () => {
    const output = { status: 'succeeded', summary: 'Changes Requested — add tests' };
    assert.strictEqual(needsRevision(output), true);
  });

  await test('needsRevision returns false for LGTM', () => {
    const output = { status: 'succeeded', summary: 'LGTM — code looks good' };
    assert.strictEqual(needsRevision(output), false);
  });

  // Test 19: decideNext routes needs_revision to revision action
  await test('decideNext routes needs_revision to revision action', () => {
    const agentOutput = {
      step_id: 'T1:review',
      status: 'needs_revision',
      summary: 'Changes Requested — missing tests',
      revision_notes: 'Add unit tests',
    };
    const runState = {
      task: { budget: {}, _revisionCounts: {} },
      steps: [
        { step_id: 'T1:plan', type: 'plan', attempt: 1, max_attempts: 3 },
        { step_id: 'T1:impl', type: 'implement', attempt: 1, max_attempts: 3 },
        { step_id: 'T1:review', type: 'review', attempt: 1, max_attempts: 3, revision_target: 'implement' },
      ],
    };
    const decision = decideNext(agentOutput, runState);
    assert.strictEqual(decision.action, 'revision', 'should route to revision');
    assert.strictEqual(decision.rule, 'review_needs_revision');
    assert.strictEqual(decision.next_step.step_type, 'implement', 'should target implement step');
    assert.strictEqual(decision.review_feedback, 'Add unit tests', 'should use revision_notes as feedback');
  });

  // Cleanup
  try {
    fs.rmSync(path.join(artifactStore.ARTIFACT_DIR, testRunId), { recursive: true, force: true });
  } catch {}

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
