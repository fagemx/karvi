#!/usr/bin/env node
/**
 * test-kernel-integration.js — Integration tests for kernel.js
 *
 * Tests kernel.onStepEvent() with mock board helpers (no server spawn).
 * Verifies routing logic end-to-end: step event → route decision → board update.
 *
 * Usage: node server/test-kernel-integration.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stepSchema = require('./step-schema');
const artifactStore = require('./artifact-store');
const mgmt = require('./management');
const routeEngine = require('./route-engine');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274c ${label}: ${reason}`); process.exitCode = 1; }

async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { fail(label, err.message); }
}

const testRunId = `test-kernel-${Date.now()}`;

// --- Mock helpers ---
function createMockBoard(taskOverrides = {}) {
  const task = {
    id: 'T-K1',
    title: 'Kernel test task',
    description: 'Integration test',
    assignee: 'engineer_lite',
    status: 'in_progress',
    steps: [
      stepSchema.createStep('T-K1', testRunId, 'plan'),
      stepSchema.createStep('T-K1', testRunId, 'implement'),
      stepSchema.createStep('T-K1', testRunId, 'test'),
      stepSchema.createStep('T-K1', testRunId, 'review'),
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
  currentBoard = JSON.parse(JSON.stringify(board));  // deep clone
  logEntries.length = 0;
  return {
    readBoard: () => currentBoard,
    writeBoard: (b) => { currentBoard = b; },
    appendLog: (e) => { logEntries.push(e); },
    nowIso: () => new Date().toISOString(),
    uid: (prefix) => `${prefix}-${Date.now()}-mock`,
  };
}

// --- Create kernel + stepWorker (mock runtime — always succeeds) ---
const deps = {
  artifactStore,
  stepSchema,
  mgmt,
  push: null,           // No push in tests
  PUSH_TOKENS_PATH: null,
  getRuntime: () => ({
    dispatch: async () => ({ code: 0, stdout: '{"result":"ok"}', stderr: '', parsed: { result: 'ok' } }),
    extractReplyText: () => 'Step completed successfully',
    extractSessionId: () => null,
    extractUsage: () => ({ inputTokens: 100, outputTokens: 200, totalCost: 0.01 }),
  }),
  stepWorker: null,
  kernel: null,
};
deps.stepWorker = require('./step-worker').createStepWorker(deps);
deps.kernel = require('./kernel').createKernel(deps);
const kernel = deps.kernel;

(async () => {
  console.log('\n=== kernel.js integration ===\n');

  // Test 1: Step succeeded → kernel auto-advances to next step
  await test('step_completed → kernel advances to next step', async () => {
    const board = createMockBoard();
    const helpers = createMockHelpers(board);

    // Simulate: plan step succeeded
    const planStep = currentBoard.taskPlan.tasks[0].steps[0];
    stepSchema.transitionStep(planStep, 'running');
    stepSchema.transitionStep(planStep, 'succeeded');

    // Write plan output artifact
    artifactStore.writeArtifact(testRunId, 'T-K1:plan', 'output', {
      status: 'succeeded',
      summary: 'Plan created successfully',
    });

    const signal = { type: 'step_completed', data: { taskId: 'T-K1', stepId: 'T-K1:plan' } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // Verify: route_decision signal was emitted
    const routeSignals = currentBoard.signals.filter(s => s.type === 'route_decision');
    assert.ok(routeSignals.length >= 1, 'route_decision signal should be emitted');
    assert.strictEqual(routeSignals[0].data.decision.action, 'next_step');

    // Verify: implement step was transitioned to running (or further)
    const implStep = currentBoard.taskPlan.tasks[0].steps[1];
    assert.ok(['running', 'succeeded'].includes(implStep.state), `implement step should be running or succeeded, got ${implStep.state}`);

    // Verify: route_decision was logged
    const routeLogs = logEntries.filter(e => e.event === 'route_decision');
    assert.ok(routeLogs.length >= 1, 'route_decision should be logged');
  });

  // Test 2: All steps done → task marked completed
  await test('all steps succeeded → task marked completed', async () => {
    const board = createMockBoard();
    const helpers = createMockHelpers(board);
    const task = currentBoard.taskPlan.tasks[0];

    // Simulate: all steps succeeded
    for (const step of task.steps) {
      stepSchema.transitionStep(step, 'running');
      stepSchema.transitionStep(step, 'succeeded');
      artifactStore.writeArtifact(testRunId, step.step_id, 'output', { status: 'succeeded', summary: 'done' });
    }

    // Trigger kernel for last step
    const signal = { type: 'step_completed', data: { taskId: 'T-K1', stepId: 'T-K1:review' } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // Verify: route_decision = done
    const routeSignals = currentBoard.signals.filter(s => s.type === 'route_decision');
    assert.ok(routeSignals.length >= 1);
    assert.strictEqual(routeSignals[0].data.decision.action, 'done');

    // Verify: task is approved (step pipeline includes review → done = approved)
    assert.strictEqual(task.status, 'approved');
    assert.ok(task.completedAt);
    assert.ok(task.result);
    assert.strictEqual(task.result.status, 'approved');
  });

  // Test 3: Permission failure → human_review signal
  await test('PERMISSION failure → human_review signal emitted', async () => {
    const board = createMockBoard();
    const helpers = createMockHelpers(board);
    const task = currentBoard.taskPlan.tasks[0];
    const planStep = task.steps[0];

    // Simulate: plan step failed with permission error → dead
    stepSchema.transitionStep(planStep, 'running');
    planStep.state = 'dead';
    planStep.error = 'access denied to private repo';

    artifactStore.writeArtifact(testRunId, 'T-K1:plan', 'output', {
      status: 'failed',
      failure: { failure_mode: 'PERMISSION', failure_signature: 'access denied', retryable: false },
      summary: 'Cannot access private repo',
    });

    const signal = { type: 'step_dead', data: { taskId: 'T-K1', stepId: 'T-K1:plan' } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // Verify: human_review_needed signal
    const hrSignals = currentBoard.signals.filter(s => s.type === 'human_review_needed');
    assert.ok(hrSignals.length >= 1, 'human_review_needed signal should be emitted');

    // Verify: task has blocker
    assert.ok(task.blocker);
    assert.ok(task.blocker.reason.includes('Permission'));
  });

  // Test 4: Budget exceeded → dead_letter
  await test('budget exceeded → dead_letter signal emitted', async () => {
    const board = createMockBoard({
      budget: {
        limits: { max_llm_calls: 1, max_tokens: 40000, max_wall_clock_ms: 1200000, max_steps: 20 },
        used: { llm_calls: 1, tokens: 0, wall_clock_ms: 0, steps: 0 },
      },
    });
    const helpers = createMockHelpers(board);
    const task = currentBoard.taskPlan.tasks[0];
    const planStep = task.steps[0];

    stepSchema.transitionStep(planStep, 'running');
    stepSchema.transitionStep(planStep, 'succeeded');
    artifactStore.writeArtifact(testRunId, 'T-K1:plan', 'output', { status: 'succeeded', summary: 'done' });

    const signal = { type: 'step_completed', data: { taskId: 'T-K1', stepId: 'T-K1:plan' } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // Verify: dead_letter
    const dlSignals = currentBoard.signals.filter(s => s.type === 'task_dead_letter');
    assert.ok(dlSignals.length >= 1, 'task_dead_letter signal should be emitted');
    assert.strictEqual(task.status, 'blocked');
    assert.ok(task.blocker.reason.includes('Dead letter'));
  });

  // Test 5: Tasks without steps bypass kernel
  await test('tasks without steps bypass kernel silently', async () => {
    const board = {
      taskPlan: { tasks: [{ id: 'T-LEGACY', title: 'Legacy task', status: 'in_progress' }] },
      signals: [], insights: [], lessons: [],
      participants: [{ id: 'owner', type: 'human' }],
      controls: {},
    };
    const helpers = createMockHelpers(board);

    const signal = { type: 'step_completed', data: { taskId: 'T-LEGACY', stepId: 'T-LEGACY:plan' } };
    await kernel.onStepEvent(signal, currentBoard, helpers);

    // No signals emitted (kernel skipped)
    assert.strictEqual(currentBoard.signals.length, 0, 'No signals should be emitted for legacy tasks');
  });

  // Cleanup
  try {
    fs.rmSync(path.join(artifactStore.ARTIFACT_DIR, testRunId), { recursive: true, force: true });
  } catch {}

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
