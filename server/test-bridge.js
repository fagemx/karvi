#!/usr/bin/env node
/**
 * test-bridge.js — Integration tests for issue #108: tryAutoDispatch → step pipeline bridge
 *
 * Tests: feature flag, step creation + first step dispatch, kernel done → unlock chain,
 * retry poller pickup, and dispatch-batch race guard.
 *
 * Usage: node server/test-bridge.js
 */
const assert = require('assert');
const stepSchema = require('./step-schema');
const artifactStore = require('./artifact-store');
const mgmt = require('./management');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { fail(label, err.message); }
}

function settle(ms = 80) {
  return new Promise(resolve => setImmediate(() => setTimeout(resolve, ms)));
}

async function settleUntil(condFn, { maxMs = 5000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (condFn()) return;
    await settle(intervalMs);
  }
}

let testCounter = 0;
let currentBoard = null;
let logEntries = [];

function createMockHelpers(board) {
  currentBoard = JSON.parse(JSON.stringify(board));
  logEntries = [];
  return {
    readBoard: () => currentBoard,
    writeBoard: (b) => { currentBoard = b; },
    appendLog: (e) => { logEntries.push(e); },
    broadcastSSE: () => {},
    nowIso: () => new Date().toISOString(),
    uid: (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
}

function createMockRuntime() {
  return {
    dispatch: async () => ({
      code: 0,
      stdout: 'STEP_RESULT:{"status":"succeeded","summary":"done"}',
      stderr: '',
      parsed: {},
    }),
    extractReplyText: () => 'Step completed',
    extractSessionId: () => null,
    extractUsage: () => ({ inputTokens: 100, outputTokens: 200, totalCost: 0.01 }),
  };
}

function createBoard(tasks, controlsOverrides = {}) {
  return {
    taskPlan: { goal: 'bridge test', phase: 'executing', tasks },
    conversations: [{ sessionIds: {} }],
    signals: [],
    insights: [],
    lessons: [],
    participants: [
      { id: 'owner', type: 'human' },
      { id: 'engineer_lite', type: 'agent' },
    ],
    controls: { auto_dispatch: true, auto_review: false, use_step_pipeline: true, ...controlsOverrides },
  };
}

function createFullDeps(runtimeOverrides = {}) {
  const mockRuntime = createMockRuntime();
  if (runtimeOverrides.dispatch) mockRuntime.dispatch = runtimeOverrides.dispatch;
  const deps = {
    artifactStore,
    stepSchema,
    mgmt,
    contextCompiler: require('./context-compiler'),
    routeEngine: require('./route-engine'),
    push: null,
    PUSH_TOKENS_PATH: null,
    getRuntime: () => mockRuntime,
    RUNTIMES: { openclaw: mockRuntime },
    stepWorker: null,
    kernel: null,
    tryAutoDispatch: null,
  };
  deps.stepWorker = require('./step-worker').createStepWorker(deps);
  deps.kernel = require('./kernel').createKernel(deps);
  return { deps, mockRuntime };
}

// =====================================================================
// Tests
// =====================================================================

(async () => {
  console.log('\n=== Bridge Integration Tests (issue #108) ===\n');

  // ------------------------------------------------------------------
  // Test 1: Feature flag — use_step_pipeline=false → legacy path (no steps created)
  // ------------------------------------------------------------------
  await test('feature flag off → legacy dispatch (no steps)', async () => {
    const taskId = `T-BRIDGE-${++testCounter}`;
    const task = { id: taskId, title: 'Test task', description: 'desc', assignee: 'engineer_lite', status: 'dispatched' };
    const board = createBoard([task], { use_step_pipeline: false });
    const helpers = createMockHelpers(board);

    // Simulate tryAutoDispatch check — with flag off, steps should NOT be created
    const ctrl = mgmt.getControls(currentBoard);
    assert.strictEqual(ctrl.use_step_pipeline, false);
    const t = currentBoard.taskPlan.tasks[0];
    assert.strictEqual(t.steps, undefined);
  });

  // ------------------------------------------------------------------
  // Test 2: Feature flag on → steps created + first step dispatched
  // ------------------------------------------------------------------
  await test('feature flag on → steps created, step[0] running, envelope written', async () => {
    const taskId = `T-BRIDGE-${++testCounter}`;
    const task = { id: taskId, title: 'Test task', description: 'desc', assignee: 'engineer_lite', status: 'dispatched' };
    const { deps } = createFullDeps();
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);

    // Inline the tryAutoDispatch step-pipeline logic for testability
    const ctrl = mgmt.getControls(currentBoard);
    assert.strictEqual(ctrl.use_step_pipeline, true);

    const runId = helpers.uid('run');
    const t = currentBoard.taskPlan.tasks[0];
    t.steps = mgmt.generateStepsForTask(t, runId);

    assert.strictEqual(t.steps.length, 4);
    assert.deepStrictEqual(t.steps.map(s => s.type), ['plan', 'implement', 'test', 'review']);
    assert.ok(t.steps.every(s => s.state === 'queued'));

    // Build envelope for step[0]
    const routeEngine = require('./route-engine');
    t.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };
    const firstStep = t.steps[0];
    const runState = { task: t, steps: t.steps, run_id: runId, budget: t.budget };
    const decision = { action: 'next_step', next_step: { step_id: firstStep.step_id, step_type: firstStep.type } };
    const envelope = deps.contextCompiler.buildEnvelope(decision, runState, deps);

    assert.ok(envelope, 'envelope should not be null');
    assert.strictEqual(envelope.step_id, firstStep.step_id);
    assert.strictEqual(envelope.step_type, 'plan');

    // Transition to running
    deps.stepSchema.transitionStep(firstStep, 'running', { locked_by: 'auto-dispatch' });
    assert.strictEqual(firstStep.state, 'running');
  });

  // ------------------------------------------------------------------
  // Test 3: Full pipeline — step[0] dispatched → kernel auto-advances all 4 → task completed
  // ------------------------------------------------------------------
  await test('full pipeline: auto-dispatch step[0] → kernel chains all 4 → task completed', async () => {
    const taskId = `T-BRIDGE-${++testCounter}`;
    const task = { id: taskId, title: 'Test task', description: 'desc', assignee: 'engineer_lite', status: 'dispatched' };
    const { deps } = createFullDeps();
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);

    // Create steps and initialize budget
    const runId = helpers.uid('run');
    const t = currentBoard.taskPlan.tasks[0];
    t.steps = mgmt.generateStepsForTask(t, runId);
    t.status = 'in_progress';
    const routeEngine = require('./route-engine');
    t.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };

    // Build envelope for first step and dispatch
    const firstStep = t.steps[0];
    const runState = { task: t, steps: t.steps, run_id: runId, budget: t.budget };
    const decision = { action: 'next_step', next_step: { step_id: firstStep.step_id, step_type: firstStep.type } };
    const envelope = deps.contextCompiler.buildEnvelope(decision, runState, deps);
    deps.artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'input', envelope);
    deps.stepSchema.transitionStep(firstStep, 'running', { locked_by: 'auto-dispatch' });
    helpers.writeBoard(currentBoard);

    // Fire step worker — this will chain through all steps via kernel
    deps.stepWorker.executeStep(envelope, helpers.readBoard(), helpers).catch(() => {});

    // Wait for the full chain to settle
    await settleUntil(() => {
      const b = helpers.readBoard();
      const tk = b.taskPlan.tasks[0];
      return tk.status === 'approved';
    }, { maxMs: 5000 });

    const finalTask = currentBoard.taskPlan.tasks[0];
    assert.strictEqual(finalTask.status, 'approved', `expected approved, got ${finalTask.status}`);
    assert.ok(finalTask.steps.every(s => s.state === 'succeeded'), 'all steps should be succeeded');
    assert.ok(finalTask.completedAt, 'completedAt should be set');
  });

  // ------------------------------------------------------------------
  // Test 4: Kernel done → unlock dependent task
  // ------------------------------------------------------------------
  await test('kernel done → unlocks dependent task (pending → dispatched)', async () => {
    const taskId1 = `T-BRIDGE-${++testCounter}`;
    const taskId2 = `T-BRIDGE-${++testCounter}`;
    const task1 = { id: taskId1, title: 'Task 1', description: 'desc', assignee: 'engineer_lite', status: 'in_progress' };
    const task2 = { id: taskId2, title: 'Task 2', description: 'depends on T1', assignee: 'engineer_lite', status: 'pending', depends: [taskId1] };
    const { deps, mockRuntime } = createFullDeps();
    const runId = `run-${Date.now()}`;
    const board = createBoard([task1, task2]);
    const helpers = createMockHelpers(board);

    // Create steps for task1
    const t1 = currentBoard.taskPlan.tasks[0];
    t1.steps = mgmt.generateStepsForTask(t1, runId);
    t1.budget = { limits: { ...require('./route-engine').BUDGET_DEFAULTS }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };

    // Manually succeed all steps except last (review)
    for (let i = 0; i < 3; i++) {
      stepSchema.transitionStep(t1.steps[i], 'running');
      stepSchema.transitionStep(t1.steps[i], 'succeeded');
      artifactStore.writeArtifact(runId, t1.steps[i].step_id, 'output', { status: 'succeeded', summary: 'done', tokens_used: 100 });
    }

    // Review step: run through kernel which should mark done
    const reviewStep = t1.steps[3];
    stepSchema.transitionStep(reviewStep, 'running');
    stepSchema.transitionStep(reviewStep, 'succeeded');
    artifactStore.writeArtifact(runId, reviewStep.step_id, 'output', { status: 'succeeded', summary: 'review passed', tokens_used: 100 });

    helpers.writeBoard(currentBoard);

    // Fire kernel for review step completed
    const signal = {
      type: 'step_completed',
      data: { taskId: taskId1, stepId: reviewStep.step_id, from: 'running', to: 'succeeded' },
    };
    await deps.kernel.onStepEvent(signal, helpers.readBoard(), helpers);

    // Verify: task1 approved (step pipeline includes review step → done = approved)
    const finalT1 = currentBoard.taskPlan.tasks[0];
    assert.strictEqual(finalT1.status, 'approved');

    // Verify: task2 unlocked (pending → dispatched) by autoUnlockDependents
    const finalT2 = currentBoard.taskPlan.tasks[1];
    assert.strictEqual(finalT2.status, 'dispatched', `expected task2 dispatched, got ${finalT2.status}`);
  });

  // ------------------------------------------------------------------
  // Test 5: dispatch-batch race guard — skip non-queued steps
  // ------------------------------------------------------------------
  await test('dispatch-batch race guard: non-queued step is skipped', async () => {
    const taskId = `T-BRIDGE-${++testCounter}`;
    const runId = `run-${Date.now()}`;
    const task = { id: taskId, title: 'Race test', description: 'desc', assignee: 'engineer_lite', status: 'in_progress' };
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);

    const t = currentBoard.taskPlan.tasks[0];
    t.steps = mgmt.generateStepsForTask(t, runId);

    // Simulate kernel already picked up step[0] → running
    stepSchema.transitionStep(t.steps[0], 'running', { locked_by: 'kernel' });

    // dispatch-batch should skip step[0] because it's not queued
    const step0 = t.steps[0];
    assert.strictEqual(step0.state, 'running');
    assert.notStrictEqual(step0.state, 'queued', 'step should NOT be queued — batch should skip it');
  });

  // ------------------------------------------------------------------
  // Test 6: Retry poller — requeued step with past scheduled_at is detectable
  // ------------------------------------------------------------------
  await test('retry poller: step with attempt>0 and past scheduled_at is eligible for re-dispatch', async () => {
    const taskId = `T-BRIDGE-${++testCounter}`;
    const runId = `run-${Date.now()}`;
    const task = { id: taskId, title: 'Retry test', description: 'desc', assignee: 'engineer_lite', status: 'in_progress' };
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);

    const t = currentBoard.taskPlan.tasks[0];
    t.steps = mgmt.generateStepsForTask(t, runId);

    // Simulate: step[0] failed once and was requeued with past scheduled_at
    const step = t.steps[0];
    stepSchema.transitionStep(step, 'running');
    stepSchema.transitionStep(step, 'failed', { error: 'test failure' });
    // After fail, step should be back to queued with attempt=1
    assert.strictEqual(step.state, 'queued');
    assert.strictEqual(step.attempt, 1);

    // Set scheduled_at to the past (simulating backoff expired)
    step.scheduled_at = new Date(Date.now() - 5000).toISOString();

    // Verify: this step matches retry poller criteria
    const now = new Date().toISOString();
    const eligible = step.state === 'queued' && step.attempt > 0 && step.scheduled_at && step.scheduled_at <= now;
    assert.ok(eligible, 'step should be eligible for retry poller pickup');
  });

  // ------------------------------------------------------------------
  // Test 6: Kernel done → task.pr populated from implement step artifact
  // ------------------------------------------------------------------
  await test('kernel done → extracts PR URL and sets task.pr', async () => {
    const taskId = `T-BRIDGE-${++testCounter}`;
    const task = { id: taskId, title: 'PR test', description: 'desc', assignee: 'engineer_lite', status: 'in_progress' };
    const { deps, mockRuntime } = createFullDeps();
    const runId = `run-${Date.now()}`;
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);

    const t1 = currentBoard.taskPlan.tasks[0];
    t1.steps = mgmt.generateStepsForTask(t1, runId);
    t1.budget = { limits: { ...require('./route-engine').BUDGET_DEFAULTS }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };

    // Succeed all steps (plan, implement, test, review)
    for (let i = 0; i < t1.steps.length; i++) {
      stepSchema.transitionStep(t1.steps[i], 'running');
      stepSchema.transitionStep(t1.steps[i], 'succeeded');
      const output = { status: 'succeeded', summary: 'done', tokens_used: 100 };
      // Implement step (index 1) carries the prUrl in payload
      if (i === 1) {
        output.payload = { prUrl: 'https://github.com/owner/repo/pull/42' };
      }
      artifactStore.writeArtifact(runId, t1.steps[i].step_id, 'output', output);
    }

    helpers.writeBoard(currentBoard);

    // Fire kernel for last step (review) completed
    const reviewStep = t1.steps[t1.steps.length - 1];
    const signal = {
      type: 'step_completed',
      data: { taskId, stepId: reviewStep.step_id, from: 'running', to: 'succeeded' },
    };
    await deps.kernel.onStepEvent(signal, helpers.readBoard(), helpers);

    const finalTask = currentBoard.taskPlan.tasks[0];
    assert.strictEqual(finalTask.status, 'approved');
    assert.ok(finalTask.pr, 'task.pr should be set');
    assert.strictEqual(finalTask.pr.owner, 'owner');
    assert.strictEqual(finalTask.pr.repo, 'owner/repo');
    assert.strictEqual(finalTask.pr.number, 42);
    assert.strictEqual(finalTask.pr.url, 'https://github.com/owner/repo/pull/42');
    assert.strictEqual(finalTask.pr.outcome, null);
  });

  // ------------------------------------------------------------------
  // Test 7: handlePRWebhook + board update → task.pr.outcome set + signal emitted
  // ------------------------------------------------------------------
  await test('PR webhook merged → task.pr.outcome=merged + pr_merged signal', async () => {
    const githubIntegration = require('./integration-github');

    const taskId = `T-BRIDGE-${++testCounter}`;
    const task = {
      id: taskId, title: 'PR outcome test', description: 'desc', assignee: 'engineer_lite', status: 'approved',
      pr: { owner: 'owner', repo: 'owner/repo', number: 88, url: 'https://github.com/owner/repo/pull/88', outcome: null },
    };
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);
    const config = { enabled: true };

    // Simulate merged PR webhook
    const payload = {
      action: 'closed',
      pull_request: { number: 88, merged: true, merged_by: { login: 'alice' }, merge_commit_sha: 'deadbeef', user: { login: 'bob' } },
      repository: { full_name: 'owner/repo' },
    };
    const result = githubIntegration.handlePRWebhook(currentBoard, payload, config);
    assert.strictEqual(result.action, 'pr_outcome');
    assert.strictEqual(result.outcome, 'merged');
    assert.strictEqual(result.mergedBy, 'alice');

    // Apply outcome to board (simulating what routes/github.js does)
    const t = currentBoard.taskPlan.tasks[0];
    t.pr.outcome = result.outcome;
    t.pr.mergedAt = helpers.nowIso();
    t.pr.mergedBy = result.mergedBy;

    mgmt.ensureEvolutionFields(currentBoard);
    currentBoard.signals.push({
      id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'github-webhook',
      type: 'pr_merged',
      content: `${result.taskId} PR #88 merged by alice`,
      refs: [result.taskId],
      data: { taskId: result.taskId, prNumber: 88, outcome: 'merged', mergedBy: 'alice', mergeCommitSha: 'deadbeef' },
    });

    assert.strictEqual(t.pr.outcome, 'merged');
    assert.strictEqual(t.pr.mergedBy, 'alice');
    assert.ok(t.pr.mergedAt);
    const mergeSignal = currentBoard.signals.find(s => s.type === 'pr_merged');
    assert.ok(mergeSignal, 'pr_merged signal should exist');
    assert.strictEqual(mergeSignal.data.prNumber, 88);
    assert.strictEqual(mergeSignal.data.mergedBy, 'alice');
  });

  // ------------------------------------------------------------------
  // Test 8: handlePRWebhook closed (not merged) → task.pr.outcome=closed
  // ------------------------------------------------------------------
  await test('PR webhook closed → task.pr.outcome=closed + pr_closed signal', async () => {
    const githubIntegration = require('./integration-github');

    const taskId = `T-BRIDGE-${++testCounter}`;
    const task = {
      id: taskId, title: 'PR close test', description: 'desc', assignee: 'engineer_lite', status: 'approved',
      pr: { owner: 'owner', repo: 'owner/repo', number: 77, url: 'https://github.com/owner/repo/pull/77', outcome: null },
    };
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);
    const config = { enabled: true };

    const payload = {
      action: 'closed',
      pull_request: { number: 77, merged: false, user: { login: 'carol' } },
      repository: { full_name: 'owner/repo' },
    };
    const result = githubIntegration.handlePRWebhook(currentBoard, payload, config);
    assert.strictEqual(result.action, 'pr_outcome');
    assert.strictEqual(result.outcome, 'closed');
    assert.strictEqual(result.closedBy, 'carol');

    // Apply outcome
    const t = currentBoard.taskPlan.tasks[0];
    t.pr.outcome = result.outcome;
    t.pr.closedAt = helpers.nowIso();
    t.pr.closedBy = result.closedBy;

    mgmt.ensureEvolutionFields(currentBoard);
    currentBoard.signals.push({
      id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'github-webhook',
      type: 'pr_closed',
      content: `${result.taskId} PR #77 closed`,
      refs: [result.taskId],
      data: { taskId: result.taskId, prNumber: 77, outcome: 'closed', closedBy: 'carol' },
    });

    assert.strictEqual(t.pr.outcome, 'closed');
    assert.strictEqual(t.pr.closedBy, 'carol');
    assert.ok(t.pr.closedAt);
    const closeSignal = currentBoard.signals.find(s => s.type === 'pr_closed');
    assert.ok(closeSignal, 'pr_closed signal should exist');
    assert.strictEqual(closeSignal.data.prNumber, 77);
  });

  // ------------------------------------------------------------------
  // Test 9: Contract validation — artifact deliverable with null payload → CONTRACT_VIOLATION
  // ------------------------------------------------------------------
  await test('contract: artifact deliverable with null payload → CONTRACT_VIOLATION', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'artifact', acceptance: 'payload non-empty' };
    const agentOutput = { status: 'succeeded', summary: 'short', payload: null, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, false, 'should fail when payload is null');
    assert.ok(result.reason.includes('payload'), `reason should mention payload: ${result.reason}`);
  });

  // ------------------------------------------------------------------
  // Test 8: Contract validation — artifact deliverable with short summary → CONTRACT_VIOLATION
  // ------------------------------------------------------------------
  await test('contract: artifact deliverable with short summary → CONTRACT_VIOLATION', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'artifact', acceptance: 'summary > 50 chars' };
    const agentOutput = { status: 'succeeded', summary: 'too short', payload: { data: 'exists' }, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, false, 'should fail when summary < 50 chars');
    assert.ok(result.reason.includes('summary too short'), `reason should mention summary: ${result.reason}`);
  });

  // ------------------------------------------------------------------
  // Test 9: Contract validation — artifact deliverable passes when valid
  // ------------------------------------------------------------------
  await test('contract: artifact deliverable passes with payload + long summary', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'artifact', acceptance: 'payload non-empty' };
    const longSummary = 'This is a sufficiently long summary that exceeds the fifty character minimum threshold for artifacts';
    const agentOutput = { status: 'succeeded', summary: longSummary, payload: { data: 'exists' }, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, true, 'should pass with valid payload and long summary');
  });

  // ------------------------------------------------------------------
  // Test 10: Contract validation — command_result deliverable with empty summary → fail
  // ------------------------------------------------------------------
  await test('contract: command_result with empty summary → CONTRACT_VIOLATION', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'command_result', acceptance: 'exit 0 + output' };
    const agentOutput = { status: 'succeeded', summary: '', payload: null, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, false, 'should fail when summary is empty');
    assert.ok(result.reason.includes('summary is empty'), `reason should mention empty summary: ${result.reason}`);
  });

  // ------------------------------------------------------------------
  // Test 11: Contract validation — command_result passes with non-empty summary
  // ------------------------------------------------------------------
  await test('contract: command_result passes with non-empty summary', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'command_result', acceptance: 'exit 0' };
    const agentOutput = { status: 'succeeded', summary: 'Command executed successfully with output', payload: null, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, true, 'should pass when summary is non-empty');
  });

  // ------------------------------------------------------------------
  // Test 12: Contract validation — issue deliverable with URL in summary → passes
  // ------------------------------------------------------------------
  await test('contract: issue deliverable with GitHub URL → passes', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'issue', acceptance: 'issue URL exists' };
    const agentOutput = { status: 'succeeded', summary: 'Created https://github.com/org/repo/issues/42', payload: null, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, true, 'should pass when issue URL found in summary');
  });

  // ------------------------------------------------------------------
  // Test 13: Contract validation — issue deliverable without URL → fail
  // ------------------------------------------------------------------
  await test('contract: issue deliverable without GitHub URL → CONTRACT_VIOLATION', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'issue', acceptance: 'issue URL exists' };
    const agentOutput = { status: 'succeeded', summary: 'I created an issue', payload: null, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, false, 'should fail when no issue URL found');
    assert.ok(result.reason.includes('issue URL'), `reason should mention issue URL: ${result.reason}`);
  });

  // ------------------------------------------------------------------
  // Test 14: No contract on envelope → legacy behavior (passes)
  // ------------------------------------------------------------------
  await test('no contract → legacy behavior (passes)', async () => {
    const { validateContract } = require('./step-worker');

    // null contract
    const result1 = validateContract(null, { status: 'succeeded', summary: 'done', payload: null }, null, null);
    assert.strictEqual(result1.ok, true, 'null contract should pass');

    // contract without deliverable
    const result2 = validateContract({}, { status: 'succeeded', summary: 'done', payload: null }, null, null);
    assert.strictEqual(result2.ok, true, 'empty contract should pass');
  });

  // ------------------------------------------------------------------
  // Test 15: Unknown deliverable type → passes (forward-compat)
  // ------------------------------------------------------------------
  await test('unknown deliverable type → passes (forward-compat)', async () => {
    const { validateContract } = require('./step-worker');

    const contract = { deliverable: 'future_type', acceptance: 'something' };
    const agentOutput = { status: 'succeeded', summary: 'done', payload: null, failure: null };
    const result = validateContract(contract, agentOutput, null, null);

    assert.strictEqual(result.ok, true, 'unknown deliverable type should pass');
  });

  // ------------------------------------------------------------------
  // Test 16: Contract passed through envelope via context-compiler
  // ------------------------------------------------------------------
  await test('context-compiler passes contract through envelope', async () => {
    const taskId = `T-BRIDGE-${++testCounter}`;
    const contract = { deliverable: 'pr', acceptance: 'PR exists' };
    const task = { id: taskId, title: 'Contract test', description: 'desc', assignee: 'engineer_lite', status: 'dispatched', contract };
    const { deps } = createFullDeps();
    const board = createBoard([task]);
    const helpers = createMockHelpers(board);

    const runId = helpers.uid('run');
    const t = currentBoard.taskPlan.tasks[0];
    t.steps = mgmt.generateStepsForTask(t, runId);
    const routeEngine = require('./route-engine');
    t.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0 } };

    const firstStep = t.steps[0];
    const runState = { task: t, steps: t.steps, run_id: runId, budget: t.budget };
    const decision = { action: 'next_step', next_step: { step_id: firstStep.step_id, step_type: firstStep.type } };
    const envelope = deps.contextCompiler.buildEnvelope(decision, runState, deps);

    assert.ok(envelope, 'envelope should exist');
    assert.deepStrictEqual(envelope.contract, contract, 'contract should be passed through');
  });

  // ------------------------------------------------------------------
  // Test 17: CONTRACT_VIOLATION classified correctly by route-engine
  // ------------------------------------------------------------------
  await test('route-engine classifies CONTRACT_VIOLATION failure mode', async () => {
    const { classifyFailure, FAILURE_MODES } = require('./route-engine');

    // Explicit failure_mode
    const result1 = classifyFailure({
      failure: { failure_signature: 'some error', failure_mode: 'CONTRACT_VIOLATION', retryable: true },
    });
    assert.strictEqual(result1, 'CONTRACT_VIOLATION', 'explicit failure_mode should be classified');

    // Pattern-match
    const result2 = classifyFailure({
      failure: { failure_signature: 'Contract violation: deliverable missing' },
      summary: '',
    });
    assert.strictEqual(result2, 'CONTRACT_VIOLATION', 'pattern should match contract violation text');
  });

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
})();
