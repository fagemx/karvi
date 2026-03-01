#!/usr/bin/env node
/**
 * test-cycle-watchdog.js -- Unit tests for village/cycle-watchdog.js
 *
 * Usage: node server/test-cycle-watchdog.js
 */
const assert = require('assert');
const watchdog = require('./village/cycle-watchdog');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log('  OK ' + label); }
function fail(label, reason) { failed++; console.log('  FAIL ' + label + ': ' + reason); process.exitCode = 1; }

function test(label, fn) {
  try { fn(); ok(label); } catch (err) { fail(label, err.message); }
}

// --- Helpers ---
function makeBoard(overrides) {
  return {
    village: overrides.village || { currentCycle: null },
    taskPlan: overrides.taskPlan || { tasks: [] },
    signals: overrides.signals || [],
    controls: overrides.controls || {},
  };
}

function makeHelpers() {
  const calls = { writeBoard: 0, appendLog: 0, broadcastSSE: 0 };
  let idCounter = 0;
  return {
    calls,
    nowIso: () => '2026-03-02T12:00:00Z',
    uid: (prefix) => prefix + '-' + (++idCounter),
    writeBoard: () => { calls.writeBoard++; },
    appendLog: () => { calls.appendLog++; },
    broadcastSSE: () => { calls.broadcastSSE++; },
  };
}

console.log('\n=== cycle-watchdog.js ===\n');

// --- isMeetingTask ---

test('isMeetingTask returns true for MTG- prefix', () => {
  assert.strictEqual(watchdog.isMeetingTask('MTG-cycle-2026-W09-proposal-eng'), true);
  assert.strictEqual(watchdog.isMeetingTask('MTG-cycle-2026-W09-synthesis'), true);
});

test('isMeetingTask returns false for non-MTG tasks', () => {
  assert.strictEqual(watchdog.isMeetingTask('VT-123'), false);
  assert.strictEqual(watchdog.isMeetingTask('GH-157'), false);
  assert.strictEqual(watchdog.isMeetingTask(null), false);
});

// --- checkCycleHealth: no cycle / done / execution ---

test('checkCycleHealth returns not-stalled when no cycle', () => {
  const board = makeBoard({ village: { currentCycle: null } });
  const result = watchdog.checkCycleHealth(board);
  assert.strictEqual(result.stalled, false);
});

test('checkCycleHealth returns not-stalled when cycle phase is done', () => {
  const board = makeBoard({
    village: { currentCycle: { cycleId: 'c1', phase: 'done' } },
  });
  assert.strictEqual(watchdog.checkCycleHealth(board).stalled, false);
});

test('checkCycleHealth returns not-stalled when cycle phase is execution', () => {
  const board = makeBoard({
    village: { currentCycle: { cycleId: 'c1', phase: 'execution' } },
  });
  assert.strictEqual(watchdog.checkCycleHealth(board).stalled, false);
});

// --- checkCycleHealth: task-exhaustion ---

test('detects stall when all proposals are blocked', () => {
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'proposal',
        startedAt: new Date().toISOString(),
        taskIds: ['MTG-c1-proposal-eng', 'MTG-c1-proposal-content', 'MTG-c1-synthesis'],
      },
    },
    taskPlan: {
      tasks: [
        { id: 'MTG-c1-proposal-eng', status: 'blocked', depends: [] },
        { id: 'MTG-c1-proposal-content', status: 'blocked', depends: [] },
        { id: 'MTG-c1-synthesis', status: 'pending', depends: ['MTG-c1-proposal-eng', 'MTG-c1-proposal-content'] },
      ],
    },
  });
  const result = watchdog.checkCycleHealth(board);
  assert.strictEqual(result.stalled, true);
  assert.strictEqual(result.reason, 'all_tasks_exhausted');
  assert.strictEqual(result.stalledPhase, 'proposal');
});

test('does NOT detect stall when some proposals are still alive', () => {
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'proposal',
        startedAt: new Date().toISOString(),
        taskIds: ['MTG-c1-proposal-eng', 'MTG-c1-proposal-content', 'MTG-c1-synthesis'],
      },
    },
    taskPlan: {
      tasks: [
        { id: 'MTG-c1-proposal-eng', status: 'blocked', depends: [] },
        { id: 'MTG-c1-proposal-content', status: 'dispatched', depends: [] },
        { id: 'MTG-c1-synthesis', status: 'pending', depends: ['MTG-c1-proposal-eng', 'MTG-c1-proposal-content'] },
      ],
    },
  });
  const result = watchdog.checkCycleHealth(board);
  assert.strictEqual(result.stalled, false);
});

test('detects stall when orphaned task IDs (missing from board)', () => {
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'proposal',
        startedAt: new Date().toISOString(),
        taskIds: ['MTG-c1-proposal-eng', 'MTG-c1-synthesis'],
      },
    },
    taskPlan: { tasks: [] },
  });
  const result = watchdog.checkCycleHealth(board);
  assert.strictEqual(result.stalled, true);
  assert.strictEqual(result.reason, 'all_tasks_exhausted');
});

test('detects partial failure: 1 blocked proposal blocks synthesis via unresolvable deps', () => {
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'proposal',
        startedAt: new Date().toISOString(),
        taskIds: ['MTG-c1-proposal-eng', 'MTG-c1-synthesis'],
      },
    },
    taskPlan: {
      tasks: [
        { id: 'MTG-c1-proposal-eng', status: 'blocked', depends: [] },
        { id: 'MTG-c1-synthesis', status: 'pending', depends: ['MTG-c1-proposal-eng'] },
      ],
    },
  });
  const result = watchdog.checkCycleHealth(board);
  assert.strictEqual(result.stalled, true);
  assert.strictEqual(result.reason, 'all_tasks_exhausted');
});

// --- checkCycleHealth: time-based ---

test('detects time-based stall when phase stuck > threshold', () => {
  const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'awaiting_approval',
        startedAt: fiveHoursAgo,
        taskIds: [],
      },
    },
  });
  const result = watchdog.checkCycleHealth(board, 4 * 3_600_000);
  assert.strictEqual(result.stalled, true);
  assert.strictEqual(result.reason, 'phase_timeout');
  assert.strictEqual(result.stalledPhase, 'awaiting_approval');
  assert.ok(result.stuckDurationMs > 4 * 3_600_000);
});

test('does NOT detect time-based stall within threshold', () => {
  const oneHourAgo = new Date(Date.now() - 1 * 3_600_000).toISOString();
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'proposal',
        startedAt: oneHourAgo,
        taskIds: ['MTG-c1-proposal-eng'],
      },
    },
    taskPlan: {
      tasks: [
        { id: 'MTG-c1-proposal-eng', status: 'dispatched', depends: [] },
      ],
    },
  });
  const result = watchdog.checkCycleHealth(board, 4 * 3_600_000);
  assert.strictEqual(result.stalled, false);
});

// --- closeStalledCycle ---

test('closeStalledCycle sets failure metadata on cycle', () => {
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'proposal',
        startedAt: '2026-03-02T08:00:00Z',
        taskIds: [],
      },
    },
  });
  const helpers = makeHelpers();
  watchdog.closeStalledCycle(board, helpers, 'all_tasks_exhausted', { taskStatuses: {}, stuckDurationMs: 1000 });

  const cycle = board.village.currentCycle;
  assert.strictEqual(cycle.phase, 'done');
  assert.strictEqual(cycle.failedPhase, 'proposal');
  assert.strictEqual(cycle.failureReason, 'all_tasks_exhausted');
  assert.ok(cycle.failedAt);
  assert.ok(cycle.completedAt);
});

test('closeStalledCycle emits cycle_stalled signal', () => {
  const board = makeBoard({
    village: {
      currentCycle: {
        cycleId: 'c1',
        phase: 'synthesis',
        startedAt: '2026-03-02T08:00:00Z',
        taskIds: [],
      },
    },
  });
  const helpers = makeHelpers();
  watchdog.closeStalledCycle(board, helpers, 'phase_timeout', { taskStatuses: { t1: 'blocked' }, stuckDurationMs: 5000 });

  assert.strictEqual(board.signals.length, 1);
  const sig = board.signals[0];
  assert.strictEqual(sig.type, 'cycle_stalled');
  assert.strictEqual(sig.by, 'cycle-watchdog');
  assert.strictEqual(sig.data.cycleId, 'c1');
  assert.strictEqual(sig.data.stalledPhase, 'synthesis');
  assert.strictEqual(sig.data.reason, 'phase_timeout');
});

test('closeStalledCycle calls writeBoard, appendLog, broadcastSSE', () => {
  const board = makeBoard({
    village: {
      currentCycle: { cycleId: 'c1', phase: 'proposal', startedAt: '2026-03-02T08:00:00Z', taskIds: [] },
    },
  });
  const helpers = makeHelpers();
  watchdog.closeStalledCycle(board, helpers, 'all_tasks_exhausted');

  assert.strictEqual(helpers.calls.writeBoard, 1);
  assert.strictEqual(helpers.calls.appendLog, 1);
  assert.strictEqual(helpers.calls.broadcastSSE, 1);
});

test('closeStalledCycle is no-op if cycle already done', () => {
  const board = makeBoard({
    village: {
      currentCycle: { cycleId: 'c1', phase: 'done', startedAt: '2026-03-02T08:00:00Z', taskIds: [] },
    },
  });
  const helpers = makeHelpers();
  watchdog.closeStalledCycle(board, helpers, 'all_tasks_exhausted');

  assert.strictEqual(helpers.calls.writeBoard, 0);
  assert.strictEqual(board.signals.length, 0);
});

// --- isTaskTerminal / hasUnresolvableDependency ---

test('isTaskTerminal returns true for blocked task', () => {
  const tasks = [{ id: 't1', status: 'blocked' }];
  assert.strictEqual(watchdog.isTaskTerminal(tasks, 't1'), true);
});

test('isTaskTerminal returns true for missing task', () => {
  assert.strictEqual(watchdog.isTaskTerminal([], 't1'), true);
});

test('isTaskTerminal returns false for active task', () => {
  const tasks = [{ id: 't1', status: 'dispatched' }];
  assert.strictEqual(watchdog.isTaskTerminal(tasks, 't1'), false);
});

test('hasUnresolvableDependency returns true when dep is blocked', () => {
  const tasks = [
    { id: 't1', status: 'blocked', depends: [] },
    { id: 't2', status: 'pending', depends: ['t1'] },
  ];
  assert.strictEqual(watchdog.hasUnresolvableDependency(tasks, tasks[1]), true);
});

test('hasUnresolvableDependency returns false when dep is alive', () => {
  const tasks = [
    { id: 't1', status: 'approved', depends: [] },
    { id: 't2', status: 'pending', depends: ['t1'] },
  ];
  assert.strictEqual(watchdog.hasUnresolvableDependency(tasks, tasks[1]), false);
});

// --- Summary ---
console.log('\n' + passed + ' passed, ' + failed + ' failed\n');