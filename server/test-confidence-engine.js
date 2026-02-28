#!/usr/bin/env node
/**
 * test-confidence-engine.js — Unit tests for confidence-engine.js (#52)
 *
 * Tests all 6 signal dimensions, warning generation, overall computation,
 * trigger flow, and graceful fallbacks.
 * No external dependencies, no real API calls.
 *
 * Usage:
 *   node server/test-confidence-engine.js
 */

const engine = require('./confidence-engine');
const {
  computeTestsSignal,
  computeQualitySignal,
  computeScopeSignal,
  computeRequirementsSignal,
  computePreflightSignal,
  computeAgentSignal,
  generateWarnings,
  QUALITY_GREEN,
  QUALITY_YELLOW,
  SCOPE_GREEN_FILES,
  SCOPE_YELLOW_FILES,
  AGENT_GREEN_RATE,
  AGENT_YELLOW_RATE,
  AGENT_MIN_REVIEWS,
  MAX_WARNINGS,
} = engine._internal;

let passed = 0;
let failed = 0;

function ok(name) { passed++; console.log(`  OK  ${name}`); }
function fail(name, err) { failed++; console.log(`  FAIL  ${name}: ${err || '(unknown)'}`); }

function assert(condition, name, detail) {
  if (condition) ok(name);
  else fail(name, detail || 'assertion failed');
}

// --- Test data ---

function makeBoard(overrides = {}) {
  return {
    taskPlan: { tasks: [] },
    lessons: [],
    insights: [],
    signals: [],
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'T1',
    title: 'Test task',
    description: '',
    status: 'completed',
    assignee: 'eng_1',
    review: null,
    lastReply: '',
    ...overrides,
  };
}

// --- Tests ---

console.log('\n=== confidence-engine.js tests ===\n');

// --- computeTestsSignal ---
console.log('-- computeTestsSignal --');

assert(
  computeTestsSignal(makeTask()) === null,
  'no review → null'
);

assert(
  computeTestsSignal(makeTask({ review: { score: 85, issues: ['Missing error boundary'] } })).state === 'green',
  'review with no test issues → green'
);

assert(
  computeTestsSignal(makeTask({ review: { score: 85, issues: ['test failed in auth module'] } })).state === 'red',
  'review with test failure → red'
);

assert(
  computeTestsSignal(makeTask({ review: { score: 85, issues: ['Tests fail on CI'] } })).state === 'red',
  'review with "Tests fail" → red'
);

assert(
  computeTestsSignal(makeTask({ review: { score: 85, issues: ['flaky timeout in integration'] } })).state === 'yellow',
  'review with flaky → yellow'
);

assert(
  computeTestsSignal(makeTask({ review: { score: 95, source: 'deterministic-only', issues: [] } })).state === 'green',
  'deterministic review 95 → green'
);

assert(
  computeTestsSignal(makeTask({ review: { score: 95, source: 'deterministic-only', issues: [] } })).label === 'Checks pass',
  'deterministic review label = "Checks pass"'
);

// --- computeQualitySignal ---
console.log('\n-- computeQualitySignal --');

assert(
  computeQualitySignal(makeTask()) === null,
  'no review → null'
);

assert(
  computeQualitySignal(makeTask({ review: { score: null } })) === null,
  'score null → null'
);

const q90 = computeQualitySignal(makeTask({ review: { score: 90 } }));
assert(q90.state === 'green', 'score 90 → green');
assert(q90.label === '90/100', 'score 90 label = "90/100"');

const q60 = computeQualitySignal(makeTask({ review: { score: 60 } }));
assert(q60.state === 'yellow', 'score 60 → yellow');

const q30 = computeQualitySignal(makeTask({ review: { score: 30 } }));
assert(q30.state === 'red', 'score 30 → red');

const q70 = computeQualitySignal(makeTask({ review: { score: 70 } }));
assert(q70.state === 'green', 'score 70 (boundary) → green');

const q50 = computeQualitySignal(makeTask({ review: { score: 50 } }));
assert(q50.state === 'yellow', 'score 50 (boundary) → yellow');

const q49 = computeQualitySignal(makeTask({ review: { score: 49 } }));
assert(q49.state === 'red', 'score 49 → red');

// --- computeScopeSignal ---
console.log('\n-- computeScopeSignal --');

assert(
  computeScopeSignal(makeTask()) === null,
  'no reply → null'
);

const s3 = computeScopeSignal(makeTask({ lastReply: 'Changed 3 files, +80 lines' }));
assert(s3 !== null, '3 files found');
assert(s3.state === 'green', '3 files → green');
assert(s3.label.includes('3 files'), 'label includes "3 files"');
assert(s3.label.includes('+80'), 'label includes "+80"');

const s10 = computeScopeSignal(makeTask({ lastReply: 'Modified 10 files' }));
assert(s10.state === 'yellow', '10 files → yellow');

const s20 = computeScopeSignal(makeTask({ lastReply: '20 files changed' }));
assert(s20.state === 'red', '20 files → red');

const s5 = computeScopeSignal(makeTask({ lastReply: '5 files modified' }));
assert(s5.state === 'green', '5 files (boundary) → green');

const s15 = computeScopeSignal(makeTask({ lastReply: '15 files changed' }));
assert(s15.state === 'yellow', '15 files (boundary) → yellow');

const s16 = computeScopeSignal(makeTask({ lastReply: '16 files changed' }));
assert(s16.state === 'red', '16 files → red');

// Fallback to review report
const sReport = computeScopeSignal(makeTask({
  lastReply: '',
  review: { score: 80, report: 'Reviewed 4 files' },
}));
assert(sReport !== null && sReport.state === 'green', 'fallback to review report → green');

// Chinese file count
const sChinese = computeScopeSignal(makeTask({ lastReply: '修改了 3 檔案' }));
assert(sChinese !== null && sChinese.state === 'green', 'Chinese 檔案 → green');

// --- computeRequirementsSignal ---
console.log('\n-- computeRequirementsSignal --');

assert(
  computeRequirementsSignal(makeTask()) === null,
  'no description → null'
);

assert(
  computeRequirementsSignal(makeTask({ description: 'Just a plain description' })) === null,
  'no checkboxes → null'
);

const rAll = computeRequirementsSignal(makeTask({ description: '- [x] Item 1\n- [x] Item 2\n- [x] Item 3' }));
assert(rAll.state === 'green', 'all checked → green');
assert(rAll.label === 'AC 3/3', 'label = "AC 3/3"');

const rPartial = computeRequirementsSignal(makeTask({ description: '- [x] Item 1\n- [ ] Item 2\n- [x] Item 3' }));
assert(rPartial.state === 'yellow', '2/3 checked → yellow');
assert(rPartial.label === 'AC 2/3', 'label = "AC 2/3"');

const rNone = computeRequirementsSignal(makeTask({ description: '- [ ] Item 1\n- [ ] Item 2\n- [ ] Item 3' }));
assert(rNone.state === 'red', '0/3 checked → red');

const rHalf = computeRequirementsSignal(makeTask({ description: '- [x] A\n- [ ] B' }));
assert(rHalf.state === 'yellow', '1/2 checked (50%) → yellow');

const rBelow = computeRequirementsSignal(makeTask({ description: '- [x] A\n- [ ] B\n- [ ] C\n- [ ] D' }));
assert(rBelow.state === 'red', '1/4 checked (25%) → red');

// --- computePreflightSignal ---
console.log('\n-- computePreflightSignal --');

const pfNone = computePreflightSignal(makeBoard(), makeTask());
assert(pfNone.state === 'green', 'no lessons → green');
assert(pfNone.label === 'No hits', 'label = "No hits"');

const pfBoard = makeBoard({
  lessons: [
    { id: 'l1', status: 'active', rule: 'Always validate input', fromInsight: 'i1' },
  ],
  insights: [
    { id: 'i1', data: { agent: 'eng_1' } },
  ],
});
const pfAgent = computePreflightSignal(pfBoard, makeTask({ assignee: 'eng_1' }));
assert(pfAgent.state === 'yellow', 'agent-specific lesson → yellow');

const pfMany = makeBoard({
  lessons: [
    { id: 'l1', status: 'validated', rule: 'Rule 1' },
    { id: 'l2', status: 'validated', rule: 'Rule 2' },
    { id: 'l3', status: 'validated', rule: 'Rule 3' },
  ],
});
const pfRed = computePreflightSignal(pfMany, makeTask());
assert(pfRed.state === 'red', '3+ validated lessons → red');

// --- computeAgentSignal ---
console.log('\n-- computeAgentSignal --');

assert(
  computeAgentSignal(makeBoard(), makeTask()) === null,
  'no signals → null'
);

assert(
  computeAgentSignal(makeBoard(), makeTask({ assignee: null })) === null,
  'no assignee → null'
);

// < 3 reviews → null
const agFew = makeBoard({
  signals: [
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
  ],
});
assert(computeAgentSignal(agFew, makeTask()) === null, '<3 reviews → null');

// 4/5 approved = 80% → green
const agGreen = makeBoard({
  signals: [
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'rejected' } },
  ],
});
const agGreenSig = computeAgentSignal(agGreen, makeTask());
assert(agGreenSig.state === 'green', '80% → green');
assert(agGreenSig.label === 'Rate 80%', 'label = "Rate 80%"');

// 3/5 = 60% → yellow
const agYellow = makeBoard({
  signals: [
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'rejected' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'rejected' } },
  ],
});
assert(computeAgentSignal(agYellow, makeTask()).state === 'yellow', '60% → yellow');

// 1/4 = 25% → red
const agRed = makeBoard({
  signals: [
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'rejected' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'rejected' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'rejected' } },
  ],
});
assert(computeAgentSignal(agRed, makeTask()).state === 'red', '25% → red');

// Agent isolation: different agent signals not counted
const agIso = makeBoard({
  signals: [
    { type: 'review_result', data: { assignee: 'eng_2', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_2', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_2', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'rejected' } },
  ],
});
assert(computeAgentSignal(agIso, makeTask({ assignee: 'eng_1' })) === null, 'different agent → only 1 review → null');

// --- generateWarnings ---
console.log('\n-- generateWarnings --');

const warnSignals = [
  { key: 'tests', state: 'red', label: 'Tests fail' },
  { key: 'quality', state: 'yellow', label: '55/100' },
  { key: 'scope', state: 'red', label: '20 files' },
  { key: 'agent', state: 'yellow', label: 'Rate 60%' },
];
const warns = generateWarnings(warnSignals, makeBoard(), makeTask());
assert(warns.length <= MAX_WARNINGS, `max ${MAX_WARNINGS} warnings`);
assert(warns.length === 3, `got ${warns.length} warnings (cap at 3)`);
// Red signals prioritized
assert(warns[0].includes('tests'), 'first warning is red (tests)');
assert(warns[1].includes('scope'), 'second warning is red (scope)');

// No warnings when all green
const greenSignals = [
  { key: 'tests', state: 'green', label: 'All pass' },
  { key: 'quality', state: 'green', label: '90/100' },
];
const noWarns = generateWarnings(greenSignals, makeBoard(), makeTask());
assert(noWarns.length === 0, 'all green → 0 warnings');

// --- computeConfidence (integration) ---
console.log('\n-- computeConfidence (integration) --');

const fullTask = makeTask({
  review: { score: 85, issues: ['Minor style issues'] },
  lastReply: 'Modified 3 files, +120 lines',
  description: '- [x] Login form\n- [x] JWT tokens\n- [x] Error handling',
});
const fullBoard = makeBoard({
  signals: [
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
    { type: 'review_result', data: { assignee: 'eng_1', result: 'approved' } },
  ],
});

const conf = engine.computeConfidence(fullBoard, fullTask);
assert(conf.signals.length > 0, 'signals not empty');
assert(typeof conf.overall === 'number', 'overall is number');
assert(typeof conf.computedAt === 'string', 'computedAt is string');
assert(Array.isArray(conf.warnings), 'warnings is array');

// All signals should be green in this scenario
const allGreen = conf.signals.every(s => s.state === 'green');
assert(allGreen, 'full task → all green');
assert(conf.overall === conf.signals.length, 'overall = signal count when all green');

// --- computeConfidence with mixed signals ---
console.log('\n-- computeConfidence (mixed signals) --');

const mixedTask = makeTask({
  review: { score: 45, issues: ['test failed in auth'] },
  lastReply: 'Modified 20 files',
  description: '- [x] Login\n- [ ] Logout',
});
const mixedConf = engine.computeConfidence(makeBoard(), mixedTask);
assert(mixedConf.signals.length > 0, 'mixed signals not empty');

const redCount = mixedConf.signals.filter(s => s.state === 'red').length;
assert(redCount >= 2, `at least 2 red signals (got ${redCount})`);
assert(mixedConf.warnings.length > 0, 'mixed signals produce warnings');
assert(mixedConf.overall < mixedConf.signals.length, 'overall < total when not all green');

// --- computeConfidence with all null signals ---
console.log('\n-- computeConfidence (all null) --');

const emptyTask = makeTask({
  review: null,
  lastReply: '',
  description: '',
  assignee: null,
});
const emptyConf = engine.computeConfidence(makeBoard(), emptyTask);
assert(emptyConf.signals.length === 0 || emptyConf.signals.every(s => s !== null), 'no null signals in output');
assert(emptyConf.overall === 0 || emptyConf.signals.filter(s => s.state === 'green').length === emptyConf.overall, 'overall correct for empty');
assert(emptyConf.warnings.length === 0, 'no warnings for empty task');

// --- triggerConfidence ---
console.log('\n-- triggerConfidence --');

function testTrigger() {
  let boardState = JSON.parse(JSON.stringify({
    taskPlan: {
      tasks: [
        makeTask({
          review: { score: 85, issues: [] },
          lastReply: 'Modified 2 files',
        }),
      ],
    },
    lessons: [],
    insights: [],
    signals: [],
  }));

  let sseBroadcasts = [];
  let logEntries = [];

  const mockDeps = {
    readBoard: () => JSON.parse(JSON.stringify(boardState)),
    writeBoard: (b) => { boardState = b; },
    broadcastSSE: (ev, data) => { sseBroadcasts.push({ ev, data }); },
    appendLog: (entry) => { logEntries.push(entry); },
  };

  engine.triggerConfidence('T1', 'review_completed', mockDeps);

  const updatedTask = (boardState.taskPlan?.tasks || []).find(t => t.id === 'T1');
  assert(updatedTask?.confidence !== undefined, 'confidence written to task');
  assert(updatedTask?.confidence.signals.length > 0, 'signals populated');
  assert(typeof updatedTask?.confidence.overall === 'number', 'overall is number');
  assert(sseBroadcasts.length === 1, 'SSE broadcast sent');
  assert(sseBroadcasts[0].ev === 'task.confidence_updated', 'SSE event name correct');
  assert(sseBroadcasts[0].data.taskId === 'T1', 'SSE data has taskId');
  assert(logEntries.length === 1, 'log entry appended');
  assert(logEntries[0].event === 'confidence_computed', 'log event name correct');
  assert(logEntries[0].trigger === 'review_completed', 'log trigger correct');
}

function testTriggerMissingTask() {
  let boardState = { taskPlan: { tasks: [] } };
  const mockDeps = {
    readBoard: () => JSON.parse(JSON.stringify(boardState)),
    writeBoard: () => {},
    broadcastSSE: () => {},
    appendLog: () => {},
  };

  // Should not throw, just skip silently
  engine.triggerConfidence('NONEXISTENT', 'manual', mockDeps);
  ok('triggerConfidence skips missing task');
}

try {
  testTrigger();
} catch (e) {
  fail('triggerConfidence', e.message);
}

try {
  testTriggerMissingTask();
} catch (e) {
  fail('triggerConfidence missing task', e.message);
}

// --- Overall score denominator ---
console.log('\n-- overall denominator --');

// When some signals are null, overall should only count non-null green signals
const partialTask = makeTask({
  review: { score: 85, issues: [] },
  lastReply: '',        // no scope data → null signal
  description: '',      // no checkboxes → null signal
  assignee: null,       // no assignee → null agent signal
});
const partialConf = engine.computeConfidence(makeBoard(), partialTask);
const nonNullCount = partialConf.signals.length;
assert(nonNullCount < 6, `some signals skipped (got ${nonNullCount})`);
assert(partialConf.overall <= nonNullCount, 'overall <= non-null count');

// --- Constants exported ---
console.log('\n-- constants --');

assert(QUALITY_GREEN === 70, 'QUALITY_GREEN = 70');
assert(QUALITY_YELLOW === 50, 'QUALITY_YELLOW = 50');
assert(SCOPE_GREEN_FILES === 5, 'SCOPE_GREEN_FILES = 5');
assert(SCOPE_YELLOW_FILES === 15, 'SCOPE_YELLOW_FILES = 15');
assert(AGENT_GREEN_RATE === 80, 'AGENT_GREEN_RATE = 80');
assert(AGENT_YELLOW_RATE === 50, 'AGENT_YELLOW_RATE = 50');
assert(AGENT_MIN_REVIEWS === 3, 'AGENT_MIN_REVIEWS = 3');
assert(MAX_WARNINGS === 3, 'MAX_WARNINGS = 3');

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
