#!/usr/bin/env node
/**
 * test-kernel-e2e.js — End-to-end kernel cycle smoke test
 *
 * Wires all 5 real kernel modules (kernel, stepWorker, routeEngine,
 * contextCompiler, stepSchema) with a mock runtime, sends an initial
 * signal, and verifies auto-advancement through all 4 steps to task
 * completion.
 *
 * Key architecture notes:
 * - Signal chain: step_completed → kernel.onStepEvent → routeEngine.decideNext
 *   → contextCompiler.buildEnvelope → stepWorker.executeStep → runtime.dispatch
 *   → setImmediate(kernel.onStepEvent)
 * - Circular dep: kernel ↔ stepWorker via shared deps object (late binding)
 * - Fire-and-forget: kernel.js uses .catch() not await for stepWorker
 * - stepWorker uses setImmediate for kernel callback
 * - Need settle loop: flush setImmediate + short setTimeout to let promises resolve
 *
 * Usage: node server/test-kernel-e2e.js
 *
 * @see https://github.com/fagemx/karvi/issues/97
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

/**
 * Settle helper — flush setImmediate + short setTimeout to let the
 * fire-and-forget async chain (kernel → stepWorker → setImmediate → kernel)
 * fully resolve through multiple iterations.
 *
 * Each "hop" in the chain involves:
 *   1. stepWorker.executeStep() (async, awaits dispatch)
 *   2. setImmediate() wrapping kernel.onStepEvent()
 *   3. kernel.onStepEvent() (async, fire-and-forget from stepWorker)
 *
 * For a 4-step pipeline (plan already done, need implement→test→review),
 * we need 3 hops. Each hop needs at least one setImmediate tick + promise
 * resolution. We flush multiple times to be safe.
 */
function settle(ms = 80) {
  return new Promise(resolve => {
    setImmediate(() => setTimeout(resolve, ms));
  });
}

/**
 * Wait for the full kernel pipeline to settle by polling for
 * a condition with a timeout.
 */
async function settleUntil(condFn, { maxMs = 3000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (condFn()) return;
    await settle(intervalMs);
  }
}

const testRunId = `test-e2e-${Date.now()}`;
let testCounter = 0;

// --- Mock helpers ---
function createMockBoard(taskId, taskOverrides = {}) {
  const task = {
    id: taskId,
    title: 'E2E kernel test task',
    description: 'End-to-end kernel cycle test',
    assignee: 'engineer_lite',
    status: 'in_progress',
    steps: [
      stepSchema.createStep(taskId, testRunId, 'plan'),
      stepSchema.createStep(taskId, testRunId, 'implement'),
      stepSchema.createStep(taskId, testRunId, 'test'),
      stepSchema.createStep(taskId, testRunId, 'review'),
    ],
    ...taskOverrides,
  };
  return {
    taskPlan: { goal: 'e2e test', tasks: [task] },
    signals: [],
    insights: [],
    lessons: [],
    participants: [{ id: 'owner', type: 'human' }],
    controls: { auto_review: false },
  };
}

let currentBoard = null;
let logEntries = [];

function createMockHelpers(board) {
  currentBoard = JSON.parse(JSON.stringify(board));  // deep clone
  logEntries = [];
  return {
    readBoard: () => currentBoard,
    writeBoard: (b) => { currentBoard = b; },
    appendLog: (e) => { logEntries.push(e); },
    nowIso: () => new Date().toISOString(),
    uid: (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
}

// --- Mock runtime factory ---
function createMockRuntime(overrides = {}) {
  return {
    dispatch: overrides.dispatch || (async () => ({
      code: 0,
      stdout: 'STEP_RESULT:{"status":"succeeded","summary":"done"}',
      stderr: '',
      parsed: {},
    })),
    extractReplyText: overrides.extractReplyText || (() => 'Step completed'),
    extractSessionId: overrides.extractSessionId || (() => null),
    extractUsage: overrides.extractUsage || (() => ({ inputTokens: 100, outputTokens: 200, totalCost: 0.01 })),
  };
}

// --- Wire up real modules with mock runtime ---
function createKernelStack(runtimeOverrides = {}) {
  const mockRuntime = createMockRuntime(runtimeOverrides);
  const deps = {
    artifactStore,
    stepSchema,
    mgmt,
    push: null,
    PUSH_TOKENS_PATH: null,
    getRuntime: () => mockRuntime,
    stepWorker: null,
    kernel: null,
  };
  deps.stepWorker = require('./step-worker').createStepWorker(deps);
  deps.kernel = require('./kernel').createKernel(deps);
  return { deps, kernel: deps.kernel, stepWorker: deps.stepWorker, mockRuntime };
}

// =====================================================================
// Tests
// =====================================================================

(async () => {
  console.log('\n=== kernel E2E cycle smoke tests ===\n');

  // ------------------------------------------------------------------
  // Test 1: Happy path — auto-advance through implement → test → review
  // ------------------------------------------------------------------
  await test('happy path: plan succeeded → kernel auto-advances through implement→test→review → task completed', async () => {
    const taskId = `T-E2E-${++testCounter}`;
    const { kernel } = createKernelStack();
    const board = createMockBoard(taskId);
    const helpers = createMockHelpers(board);

    const task = currentBoard.taskPlan.tasks[0];

    // Bootstrap: plan step already succeeded (externally dispatched)
    const planStep = task.steps[0];
    stepSchema.transitionStep(planStep, 'running');
    stepSchema.transitionStep(planStep, 'succeeded');

    // Write plan output artifact (implement step reads this as previous_output)
    artifactStore.writeArtifact(testRunId, `${taskId}:plan`, 'output', {
      status: 'succeeded',
      summary: 'Plan created: implement feature X',
      tokens_used: 300,
    });

    // Trigger the kernel with plan's step_completed signal
    const signal = { type: 'step_completed', data: { taskId, stepId: `${taskId}:plan` } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // Wait for the full pipeline to settle (implement → test → review, 3 hops)
    await settleUntil(() => {
      const t = currentBoard.taskPlan.tasks[0];
      return t.status === 'approved';
    }, { maxMs: 5000, intervalMs: 40 });

    // Verify: task is approved (step pipeline includes review → done = approved)
    const finalTask = currentBoard.taskPlan.tasks[0];
    assert.strictEqual(finalTask.status, 'approved', `task status should be approved, got ${finalTask.status}`);
    assert.ok(finalTask.completedAt, 'completedAt should be set');
    assert.ok(finalTask.result, 'result should be set');
    assert.strictEqual(finalTask.result.status, 'approved');

    // Verify: all 4 steps are succeeded
    for (const step of finalTask.steps) {
      assert.strictEqual(step.state, 'succeeded', `step ${step.step_id} should be succeeded, got ${step.state}`);
    }

    // Verify: route_decision signals were emitted (at least 3: implement, test, review + done)
    const routeSignals = currentBoard.signals.filter(s => s.type === 'route_decision');
    assert.ok(routeSignals.length >= 3, `expected >= 3 route_decision signals, got ${routeSignals.length}`);

    // Verify: the final route_decision is 'done'
    const doneSignals = routeSignals.filter(s => s.data?.decision?.action === 'done');
    assert.ok(doneSignals.length >= 1, 'should have at least one done decision');

    // Verify: step_completed signals were emitted by step-worker
    const stepCompletedSignals = currentBoard.signals.filter(s => s.type === 'step_completed');
    assert.ok(stepCompletedSignals.length >= 3, `expected >= 3 step_completed signals, got ${stepCompletedSignals.length}`);

    // Verify: log entries
    const routeLogs = logEntries.filter(e => e.event === 'route_decision');
    assert.ok(routeLogs.length >= 3, `expected >= 3 route_decision logs, got ${routeLogs.length}`);
  });

  // ------------------------------------------------------------------
  // Test 2: Step failure with max_attempts=1 → dead_letter
  // ------------------------------------------------------------------
  await test('step failure with max_attempts=1 → step dead → task dead_letter', async () => {
    const taskId = `T-E2E-${++testCounter}`;
    // Runtime always fails
    const { kernel } = createKernelStack({
      dispatch: async () => ({
        code: 1,
        stdout: 'STEP_RESULT:{"status":"failed","error":"build failed","failure_mode":"TOOL_ERROR","retryable":false}',
        stderr: 'compilation error',
        parsed: {},
      }),
    });

    // Create board with max_attempts=1 so failure → dead immediately
    const board = createMockBoard(taskId, {
      steps: [
        stepSchema.createStep(taskId, testRunId, 'plan'),
        stepSchema.createStep(taskId, testRunId, 'implement', { retry_policy: { max_attempts: 1, backoff_base_ms: 0, backoff_multiplier: 1, timeout_ms: 300000 } }),
        stepSchema.createStep(taskId, testRunId, 'test'),
        stepSchema.createStep(taskId, testRunId, 'review'),
      ],
    });
    const helpers = createMockHelpers(board);
    const task = currentBoard.taskPlan.tasks[0];

    // Bootstrap: plan step succeeded
    const planStep = task.steps[0];
    stepSchema.transitionStep(planStep, 'running');
    stepSchema.transitionStep(planStep, 'succeeded');
    artifactStore.writeArtifact(testRunId, `${taskId}:plan`, 'output', {
      status: 'succeeded',
      summary: 'Plan ready',
      tokens_used: 300,
    });

    // Trigger kernel — plan succeeded, should advance to implement, which fails → dead
    const signal = { type: 'step_completed', data: { taskId, stepId: `${taskId}:plan` } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // Wait for settle
    await settleUntil(() => {
      const t = currentBoard.taskPlan.tasks[0];
      return t.status === 'blocked';
    }, { maxMs: 3000, intervalMs: 40 });

    // Verify: implement step is dead
    const implStep = currentBoard.taskPlan.tasks[0].steps[1];
    assert.strictEqual(implStep.state, 'dead', `implement step should be dead, got ${implStep.state}`);

    // Verify: task_dead_letter signal emitted
    const dlSignals = currentBoard.signals.filter(s => s.type === 'task_dead_letter');
    assert.ok(dlSignals.length >= 1, `expected task_dead_letter signal, got ${dlSignals.length}`);

    // Verify: task is blocked
    const finalTask = currentBoard.taskPlan.tasks[0];
    assert.strictEqual(finalTask.status, 'blocked', `task should be blocked, got ${finalTask.status}`);
    assert.ok(finalTask.blocker, 'task should have a blocker');
    assert.ok(finalTask.blocker.reason.includes('Dead letter'), `blocker reason should mention dead letter, got: ${finalTask.blocker.reason}`);
  });

  // ------------------------------------------------------------------
  // Test 3: PERMISSION failure → human_review
  // ------------------------------------------------------------------
  await test('PERMISSION failure on dead step → human_review_needed signal', async () => {
    const taskId = `T-E2E-${++testCounter}`;
    const { kernel } = createKernelStack();
    const board = createMockBoard(taskId);
    const helpers = createMockHelpers(board);
    const task = currentBoard.taskPlan.tasks[0];

    // Simulate: plan step died with permission error (externally)
    const planStep = task.steps[0];
    stepSchema.transitionStep(planStep, 'running');
    planStep.state = 'dead';  // force dead state directly
    planStep.error = 'access denied to private repo';

    artifactStore.writeArtifact(testRunId, `${taskId}:plan`, 'output', {
      status: 'failed',
      failure: { failure_mode: 'PERMISSION', failure_signature: 'access denied', retryable: false },
      summary: 'Cannot access private repo',
    });

    // Trigger kernel with step_dead signal
    const signal = { type: 'step_dead', data: { taskId, stepId: `${taskId}:plan` } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // No async chain needed here — kernel handles synchronously for dead/human_review
    await settle(50);

    // Verify: human_review_needed signal emitted
    const hrSignals = currentBoard.signals.filter(s => s.type === 'human_review_needed');
    assert.ok(hrSignals.length >= 1, `expected human_review_needed signal, got ${hrSignals.length}`);

    // Verify: task has blocker
    const finalTask = currentBoard.taskPlan.tasks[0];
    assert.ok(finalTask.blocker, 'task should have a blocker');
    assert.ok(finalTask.blocker.reason.includes('Permission'), `blocker reason should mention Permission, got: ${finalTask.blocker.reason}`);
  });

  // ------------------------------------------------------------------
  // Test 4: Budget exhaustion → dead_letter
  // ------------------------------------------------------------------
  await test('budget exhausted (0 remaining LLM calls) → dead_letter', async () => {
    const taskId = `T-E2E-${++testCounter}`;
    const { kernel } = createKernelStack();
    const board = createMockBoard(taskId, {
      budget: {
        limits: { max_llm_calls: 1, max_tokens: 40000, max_wall_clock_ms: 1200000, max_steps: 20 },
        used: { llm_calls: 1, tokens: 0, wall_clock_ms: 0, steps: 0 },
      },
    });
    const helpers = createMockHelpers(board);
    const task = currentBoard.taskPlan.tasks[0];

    // Bootstrap: plan step succeeded
    const planStep = task.steps[0];
    stepSchema.transitionStep(planStep, 'running');
    stepSchema.transitionStep(planStep, 'succeeded');
    artifactStore.writeArtifact(testRunId, `${taskId}:plan`, 'output', {
      status: 'succeeded',
      summary: 'Plan created',
      tokens_used: 300,
    });

    // Trigger kernel — plan succeeded, but budget exhausted
    const signal = { type: 'step_completed', data: { taskId, stepId: `${taskId}:plan` } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // No async chain — budget check happens synchronously in kernel
    await settle(50);

    // Verify: task_dead_letter signal
    const dlSignals = currentBoard.signals.filter(s => s.type === 'task_dead_letter');
    assert.ok(dlSignals.length >= 1, `expected task_dead_letter signal, got ${dlSignals.length}`);

    // Verify: task is blocked
    const finalTask = currentBoard.taskPlan.tasks[0];
    assert.strictEqual(finalTask.status, 'blocked', `task should be blocked, got ${finalTask.status}`);
    assert.ok(finalTask.blocker, 'task should have a blocker');
  });

  // ------------------------------------------------------------------
  // Test 5: Artifact chain — each step's output readable by next step
  // ------------------------------------------------------------------
  await test('artifact chain: each step output artifact is readable by the next step', async () => {
    const taskId = `T-E2E-${++testCounter}`;

    // Runtime that includes step type in its output, so we can verify per-step
    const { kernel } = createKernelStack({
      dispatch: async (plan) => {
        const stepType = plan.stepType || 'unknown';
        const result = { status: 'succeeded', summary: `${stepType} completed successfully` };
        return {
          code: 0,
          stdout: `STEP_RESULT:${JSON.stringify(result)}`,
          stderr: '',
          parsed: {},
        };
      },
    });

    const board = createMockBoard(taskId);
    const helpers = createMockHelpers(board);
    const task = currentBoard.taskPlan.tasks[0];

    // Bootstrap: plan step already succeeded
    const planStep = task.steps[0];
    stepSchema.transitionStep(planStep, 'running');
    stepSchema.transitionStep(planStep, 'succeeded');
    artifactStore.writeArtifact(testRunId, `${taskId}:plan`, 'output', {
      status: 'succeeded',
      summary: 'plan completed successfully',
      tokens_used: 300,
    });

    // Trigger kernel
    const signal = { type: 'step_completed', data: { taskId, stepId: `${taskId}:plan` } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // Wait for pipeline to complete
    await settleUntil(() => {
      const t = currentBoard.taskPlan.tasks[0];
      return t.status === 'approved';
    }, { maxMs: 5000, intervalMs: 40 });

    // Verify: output artifact exists and is readable for each step
    const stepTypes = ['plan', 'implement', 'test', 'review'];
    for (const st of stepTypes) {
      const output = artifactStore.readArtifact(testRunId, `${taskId}:${st}`, 'output');
      assert.ok(output, `output artifact for ${st} should exist`);
      assert.strictEqual(output.status, 'succeeded', `${st} output should be succeeded`);
      assert.ok(output.summary, `${st} output should have a summary`);
    }

    // Verify: input artifacts exist for implement, test, review (they read from previous)
    for (const st of ['implement', 'test', 'review']) {
      const input = artifactStore.readArtifact(testRunId, `${taskId}:${st}`, 'input');
      assert.ok(input, `input artifact for ${st} should exist`);
      assert.ok(input.input_refs, `${st} input should have input_refs`);
    }

    // Verify: each non-plan step's output summary references its step type
    const implOutput = artifactStore.readArtifact(testRunId, `${taskId}:implement`, 'output');
    assert.ok(implOutput.summary.includes('implement'), `implement output summary should reference implement`);

    const testOutput = artifactStore.readArtifact(testRunId, `${taskId}:test`, 'output');
    assert.ok(testOutput.summary.includes('test'), `test output summary should reference test`);

    const reviewOutput = artifactStore.readArtifact(testRunId, `${taskId}:review`, 'output');
    assert.ok(reviewOutput.summary.includes('review'), `review output summary should reference review`);
  });

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------
  try {
    fs.rmSync(path.join(artifactStore.ARTIFACT_DIR, testRunId), { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-kernel-e2e] cleanup skipped:', err.message);
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
