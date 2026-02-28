#!/usr/bin/env node
/**
 * test-timeline-task.js — Unit tests for timeline-task.js (L3 Deep Timeline)
 *
 * 測試 timeline assembly、source mappers、deduplication、report generation、HTML rendering。
 * 無外部依賴，無需真實 server。
 *
 * Usage:
 *   node server/test-timeline-task.js
 */

const timeline = require('./timeline-task');
const {
  fromHistory,
  fromSignals,
  fromDispatch,
  fromReview,
  fromInsights,
  fromLessons,
  deduplicateNodes,
  computeDuration,
  mapHistoryType,
  mapSignalType,
  escHtml,
  NODE_COLORS,
} = timeline._internal;

let passed = 0;
let failed = 0;

function ok(name) { passed++; console.log(`  OK  ${name}`); }
function fail(name, err) { failed++; console.log(`  FAIL  ${name}: ${err || '(unknown)'}`); }

function assert(condition, name, detail) {
  if (condition) ok(name);
  else fail(name, detail || 'assertion failed');
}

// --- Test data ---

const now = '2026-02-28T10:00:00.000Z';
const t1 = '2026-02-28T10:01:00.000Z';
const t2 = '2026-02-28T10:02:00.000Z';
const t3 = '2026-02-28T10:03:00.000Z';
const t4 = '2026-02-28T10:04:00.000Z';
const t5 = '2026-02-28T10:05:00.000Z';

const emptyTask = {
  id: 'T0',
  title: 'Empty task',
  status: 'pending',
};

const emptyBoard = {
  taskPlan: { tasks: [emptyTask] },
  signals: [],
  insights: [],
  lessons: [],
};

const richTask = {
  id: 'T1',
  title: 'Implement user auth',
  description: 'JWT-based authentication',
  status: 'completed',
  assignee: 'eng_1',
  history: [
    { ts: now, status: 'pending', by: 'human' },
    { ts: t1, status: 'dispatched', by: 'auto-dispatch' },
    { ts: t2, status: 'in_progress', by: 'auto-dispatch', model: 'claude-sonnet' },
    { ts: t4, status: 'completed', by: 'agent', score: 85 },
  ],
  dispatch: {
    runtime: 'openclaw',
    agentId: 'eng_1',
    model: 'claude-sonnet',
    timeoutSec: 600,
    preparedAt: now,
    startedAt: t1,
    finishedAt: t4,
    state: 'completed',
    planId: 'plan-001',
    sessionId: 'sess-abc',
  },
  review: {
    score: 85,
    issues: ['Missing error boundary'],
    summary: 'Code is clean overall',
    threshold: 70,
    verdict: 'pass',
    reviewedAt: t5,
    attempt: 1,
  },
  digest: {
    version: 'task_digest.v1',
    task_id: 'T1',
    one_liner: 'Auth flow implemented',
    risk: { level: 'low', reasons: ['Well-tested'] },
    bullets: {
      what: ['JWT auth flow'],
      why: ['Security requirement'],
      risk: ['Low risk'],
      notes: [],
    },
    warnings: [],
  },
};

const richBoard = {
  taskPlan: { tasks: [richTask] },
  signals: [
    { id: 'sig-1', ts: t1, by: 'system', type: 'status_change', content: 'pending -> dispatched', refs: ['T1'], data: { from: 'pending', to: 'dispatched' } },
    { id: 'sig-2', ts: t2, by: 'system', type: 'status_change', content: 'dispatched -> in_progress', refs: ['T1'], data: { from: 'dispatched', to: 'in_progress' } },
    { id: 'sig-3', ts: t3, by: 'retro', type: 'insight_applied', content: 'Applied: prefer claude for multi-file', refs: ['T1'], data: { taskId: 'T1' } },
    { id: 'sig-4', ts: t5, by: 'system', type: 'review_result', content: 'Review: 85/100', refs: ['T1'], data: { score: 85 } },
    // Signal not related to T1
    { id: 'sig-5', ts: t3, by: 'system', type: 'error', content: 'Timeout', refs: ['T2'] },
  ],
  insights: [
    { id: 'ins-1', ts: t3, by: 'retro', judgement: 'Prefer claude for multi-file edits', reasoning: 'Better context window', suggestedAction: { type: 'dispatch_hint' }, risk: 'low', status: 'applied', appliedAt: t3, data: { taskId: 'T1', signalId: 'sig-3' } },
    // Rolled-back insight for T1
    { id: 'ins-2', ts: t4, by: 'retro', judgement: 'Increase timeout to 900s', reasoning: 'Long task', suggestedAction: { type: 'controls_patch' }, risk: 'medium', status: 'rolled_back', appliedAt: t4, data: { taskId: 'T1' } },
    // Insight not related to T1
    { id: 'ins-3', ts: t2, by: 'retro', judgement: 'Unrelated insight', suggestedAction: { type: 'noop' }, risk: 'low', status: 'pending', data: { taskId: 'T2' } },
  ],
  lessons: [
    { id: 'les-1', ts: t4, by: 'retro', fromInsight: 'ins-1', rule: 'Use claude for multi-file tasks', status: 'validated', validatedAt: t4 },
    { id: 'les-2', ts: t5, by: 'retro', fromInsight: 'ins-1', rule: 'Old lesson (replaced)', status: 'superseded', validatedAt: t4, supersededBy: 'les-1' },
    // Lesson not from T1 insights
    { id: 'les-3', ts: t3, by: 'retro', fromInsight: 'ins-3', rule: 'Unrelated lesson', status: 'active' },
  ],
};

// =======================================================================
//  Tests: fromHistory
// =======================================================================

console.log('\n--- fromHistory ---');

{
  const nodes = fromHistory(emptyTask);
  assert(Array.isArray(nodes), 'fromHistory: empty task returns array');
  assert(nodes.length === 0, 'fromHistory: empty task returns []');
}

{
  const nodes = fromHistory(richTask);
  assert(nodes.length === 4, 'fromHistory: rich task returns 4 nodes', `got ${nodes.length}`);

  const pending = nodes[0];
  assert(pending.type === 'status', 'fromHistory: pending maps to status', `got ${pending.type}`);

  const dispatched = nodes[1];
  assert(dispatched.type === 'dispatch', 'fromHistory: dispatched by auto-dispatch maps to dispatch', `got ${dispatched.type}`);

  const inProgress = nodes[2];
  assert(inProgress.type === 'dispatch', 'fromHistory: in_progress by auto-dispatch maps to dispatch', `got ${inProgress.type}`);
  assert(inProgress.title.includes('claude-sonnet'), 'fromHistory: in_progress includes model', `title: ${inProgress.title}`);

  const completed = nodes[3];
  assert(completed.type === 'status', 'fromHistory: completed maps to status', `got ${completed.type}`);
  assert(completed.title.includes('85'), 'fromHistory: completed includes score', `title: ${completed.title}`);
}

{
  const blockedTask = { id: 'TB', history: [{ ts: now, status: 'blocked', by: 'agent', reason: 'Missing API key' }] };
  const nodes = fromHistory(blockedTask);
  assert(nodes[0].type === 'error', 'fromHistory: blocked maps to error');
  assert(nodes[0].title.includes('Missing API key'), 'fromHistory: blocked includes reason');
}

// =======================================================================
//  Tests: mapHistoryType
// =======================================================================

console.log('\n--- mapHistoryType ---');

assert(mapHistoryType({ status: 'in_progress', by: 'auto-dispatch' }) === 'dispatch', 'mapHistoryType: in_progress + auto-dispatch = dispatch');
assert(mapHistoryType({ status: 'dispatched', by: 'auto-dispatch' }) === 'dispatch', 'mapHistoryType: dispatched + auto-dispatch = dispatch');
assert(mapHistoryType({ status: 'blocked', by: 'agent' }) === 'error', 'mapHistoryType: blocked = error');
assert(mapHistoryType({ status: 'completed', by: 'agent' }) === 'status', 'mapHistoryType: completed = status');
assert(mapHistoryType({ status: 'approved', by: 'human' }) === 'status', 'mapHistoryType: approved = status');
assert(mapHistoryType({ status: 'reviewing', by: 'system' }) === 'status', 'mapHistoryType: reviewing = status');
assert(mapHistoryType({ status: 'needs_revision', by: 'system' }) === 'status', 'mapHistoryType: needs_revision = status');
assert(mapHistoryType({ status: 'pending', by: 'human' }) === 'status', 'mapHistoryType: pending = status');
assert(mapHistoryType({ status: 'custom', by: 'x' }) === 'note', 'mapHistoryType: unknown = note');

// =======================================================================
//  Tests: fromSignals
// =======================================================================

console.log('\n--- fromSignals ---');

{
  const nodes = fromSignals(emptyBoard, 'T0');
  assert(nodes.length === 0, 'fromSignals: empty board returns []');
}

{
  const nodes = fromSignals(richBoard, 'T1');
  assert(nodes.length === 4, 'fromSignals: T1 has 4 matching signals', `got ${nodes.length}`);

  const statusNodes = nodes.filter(n => n.type === 'status');
  assert(statusNodes.length === 2, 'fromSignals: 2 status_change signals', `got ${statusNodes.length}`);

  const decisionNodes = nodes.filter(n => n.type === 'decision');
  assert(decisionNodes.length === 1, 'fromSignals: 1 insight_applied signal', `got ${decisionNodes.length}`);

  const reviewNodes = nodes.filter(n => n.type === 'review');
  assert(reviewNodes.length === 1, 'fromSignals: 1 review_result signal', `got ${reviewNodes.length}`);
}

{
  const nodes = fromSignals(richBoard, 'T2');
  assert(nodes.length === 1, 'fromSignals: T2 has 1 matching signal', `got ${nodes.length}`);
  assert(nodes[0].type === 'error', 'fromSignals: T2 error signal type correct');
}

{
  const nodes = fromSignals(richBoard, 'NONEXIST');
  assert(nodes.length === 0, 'fromSignals: nonexistent task returns []');
}

// =======================================================================
//  Tests: mapSignalType
// =======================================================================

console.log('\n--- mapSignalType ---');

assert(mapSignalType('status_change') === 'status', 'mapSignalType: status_change = status');
assert(mapSignalType('review_result') === 'review', 'mapSignalType: review_result = review');
assert(mapSignalType('insight_applied') === 'decision', 'mapSignalType: insight_applied = decision');
assert(mapSignalType('insight_rolled_back') === 'supersede', 'mapSignalType: insight_rolled_back = supersede');
assert(mapSignalType('lesson_validated') === 'policy', 'mapSignalType: lesson_validated = policy');
assert(mapSignalType('error') === 'error', 'mapSignalType: error = error');
assert(mapSignalType('unknown_type') === 'note', 'mapSignalType: unknown = note');

// =======================================================================
//  Tests: fromDispatch
// =======================================================================

console.log('\n--- fromDispatch ---');

{
  const nodes = fromDispatch(emptyTask);
  assert(nodes.length === 0, 'fromDispatch: no dispatch returns []');
}

{
  const nodes = fromDispatch(richTask);
  assert(nodes.length === 3, 'fromDispatch: rich task returns 3 nodes (prepared, started, finished)', `got ${nodes.length}`);

  assert(nodes[0].type === 'dispatch', 'fromDispatch: prepared node is dispatch type');
  assert(nodes[0].title.includes('openclaw'), 'fromDispatch: prepared includes runtime');
  assert(nodes[0].detail.includes('claude-sonnet'), 'fromDispatch: prepared detail includes model');

  assert(nodes[1].type === 'dispatch', 'fromDispatch: started node is dispatch type');
  assert(nodes[1].detail.includes('sess-abc'), 'fromDispatch: started includes session');

  assert(nodes[2].type === 'status', 'fromDispatch: finished node is status type (completed)');
}

{
  const failedTask = {
    id: 'TF',
    dispatch: {
      runtime: 'codex', agentId: 'eng_2',
      preparedAt: now, startedAt: t1, finishedAt: t2,
      state: 'failed', lastError: 'Timeout exceeded',
    },
  };
  const nodes = fromDispatch(failedTask);
  const finishNode = nodes.find(n => n.ts === t2);
  assert(finishNode.type === 'error', 'fromDispatch: failed dispatch is error type');
  assert(finishNode.detail === 'Timeout exceeded', 'fromDispatch: failed includes lastError');
}

// =======================================================================
//  Tests: fromReview
// =======================================================================

console.log('\n--- fromReview ---');

{
  const nodes = fromReview(emptyTask);
  assert(nodes.length === 0, 'fromReview: no review returns []');
}

{
  const nodes = fromReview(richTask);
  assert(nodes.length === 1, 'fromReview: rich task returns 1 node');
  assert(nodes[0].type === 'review', 'fromReview: type is review');
  assert(nodes[0].title.includes('85'), 'fromReview: title includes score');
  assert(nodes[0].title.includes('pass'), 'fromReview: title includes verdict');
  assert(nodes[0].title.includes('1 issue'), 'fromReview: title includes issue count');
  assert(nodes[0].detail.includes('Missing error boundary'), 'fromReview: detail includes issues');
  assert(nodes[0].meta.score === 85, 'fromReview: meta includes score');
}

// =======================================================================
//  Tests: fromInsights
// =======================================================================

console.log('\n--- fromInsights ---');

{
  const nodes = fromInsights(emptyBoard, 'T0');
  assert(nodes.length === 0, 'fromInsights: empty board returns []');
}

{
  const nodes = fromInsights(richBoard, 'T1');
  assert(nodes.length === 2, 'fromInsights: T1 has 2 related insights', `got ${nodes.length}`);

  const applied = nodes.find(n => n.type === 'decision');
  assert(applied !== undefined, 'fromInsights: has decision node');
  assert(applied.title.includes('Prefer claude'), 'fromInsights: decision title correct');

  const rolledBack = nodes.find(n => n.type === 'supersede');
  assert(rolledBack !== undefined, 'fromInsights: has supersede node');
  assert(rolledBack.title.includes('Rolled back'), 'fromInsights: supersede title correct');
}

{
  const nodes = fromInsights(richBoard, 'T2');
  assert(nodes.length === 1, 'fromInsights: T2 has 1 unrelated insight', `got ${nodes.length}`);
}

{
  const nodes = fromInsights(richBoard, 'NONEXIST');
  assert(nodes.length === 0, 'fromInsights: nonexistent task returns []');
}

// =======================================================================
//  Tests: fromLessons
// =======================================================================

console.log('\n--- fromLessons ---');

{
  const nodes = fromLessons(emptyBoard, 'T0');
  assert(nodes.length === 0, 'fromLessons: empty board returns []');
}

{
  const nodes = fromLessons(richBoard, 'T1');
  assert(nodes.length === 2, 'fromLessons: T1 has 2 related lessons', `got ${nodes.length}`);

  const validated = nodes.find(n => n.type === 'policy');
  assert(validated !== undefined, 'fromLessons: has policy node');
  assert(validated.title.includes('Use claude'), 'fromLessons: policy title correct');

  const superseded = nodes.find(n => n.type === 'supersede');
  assert(superseded !== undefined, 'fromLessons: has supersede node');
  assert(superseded.refs.supersededBy === 'les-1', 'fromLessons: supersede refs correct');
}

{
  const nodes = fromLessons(richBoard, 'NONEXIST');
  assert(nodes.length === 0, 'fromLessons: nonexistent task returns []');
}

// =======================================================================
//  Tests: deduplicateNodes
// =======================================================================

console.log('\n--- deduplicateNodes ---');

{
  const nodes = deduplicateNodes([]);
  assert(nodes.length === 0, 'dedup: empty array returns []');
}

{
  // Two nodes with same ts (to the second) and type — signal should win
  const historyNode = { id: 'h-1', ts: '2026-02-28T10:01:00.000Z', type: 'status', title: 'From history', source: 'history', refs: {} };
  const signalNode = { id: 's-1', ts: '2026-02-28T10:01:00.500Z', type: 'status', title: 'From signal', source: 'signal', refs: {} };
  const result = deduplicateNodes([historyNode, signalNode]);
  assert(result.length === 1, 'dedup: two same-second same-type nodes dedup to 1', `got ${result.length}`);
  assert(result[0].source === 'signal', 'dedup: signal wins over history', `got ${result[0].source}`);
}

{
  // Different types at same timestamp should NOT be deduped
  const node1 = { id: 'h-1', ts: '2026-02-28T10:01:00.000Z', type: 'status', title: 'Status', source: 'history', refs: {} };
  const node2 = { id: 's-1', ts: '2026-02-28T10:01:00.000Z', type: 'dispatch', title: 'Dispatch', source: 'signal', refs: {} };
  const result = deduplicateNodes([node1, node2]);
  assert(result.length === 2, 'dedup: different types at same ts not deduped', `got ${result.length}`);
}

{
  // Different timestamps should NOT be deduped
  const node1 = { id: 'h-1', ts: '2026-02-28T10:01:00.000Z', type: 'status', title: 'A', source: 'history', refs: {} };
  const node2 = { id: 's-1', ts: '2026-02-28T10:02:00.000Z', type: 'status', title: 'B', source: 'history', refs: {} };
  const result = deduplicateNodes([node1, node2]);
  assert(result.length === 2, 'dedup: different timestamps not deduped', `got ${result.length}`);
}

// =======================================================================
//  Tests: computeDuration
// =======================================================================

console.log('\n--- computeDuration ---');

{
  const dur = computeDuration(emptyTask);
  assert(dur === null, 'computeDuration: empty task returns null');
}

{
  const dur = computeDuration(richTask);
  assert(dur === 3, 'computeDuration: rich task duration is 3 min (t1 to t4)', `got ${dur}`);
}

{
  const taskHistOnly = {
    id: 'TH',
    history: [
      { ts: '2026-02-28T10:00:00.000Z', status: 'pending', by: 'human' },
      { ts: '2026-02-28T10:30:00.000Z', status: 'completed', by: 'agent' },
    ],
  };
  const dur = computeDuration(taskHistOnly);
  assert(dur === 30, 'computeDuration: history-only task = 30 min', `got ${dur}`);
}

// =======================================================================
//  Tests: assembleTimeline
// =======================================================================

console.log('\n--- assembleTimeline ---');

{
  const tl = timeline.assembleTimeline(emptyBoard, emptyTask);
  assert(Array.isArray(tl), 'assembleTimeline: returns array');
  assert(tl.length === 0, 'assembleTimeline: empty task+board returns []');
}

{
  const tl = timeline.assembleTimeline(richBoard, richTask);
  assert(tl.length > 0, 'assembleTimeline: rich data returns non-empty', `got ${tl.length}`);

  // Check chronological order
  let sorted = true;
  for (let i = 1; i < tl.length; i++) {
    if (new Date(tl[i].ts) < new Date(tl[i - 1].ts)) {
      sorted = false;
      break;
    }
  }
  assert(sorted, 'assembleTimeline: chronologically sorted');

  // Check all required fields present
  const firstNode = tl[0];
  assert(firstNode.id && firstNode.id.startsWith('tln-'), 'assembleTimeline: nodes have tln- prefixed ids');
  assert(firstNode.ts, 'assembleTimeline: nodes have ts');
  assert(firstNode.type, 'assembleTimeline: nodes have type');
  assert(firstNode.title, 'assembleTimeline: nodes have title');
  assert(firstNode.source, 'assembleTimeline: nodes have source');
  assert(typeof firstNode.refs === 'object', 'assembleTimeline: nodes have refs object');

  // Check type diversity
  const types = new Set(tl.map(n => n.type));
  assert(types.has('dispatch'), 'assembleTimeline: has dispatch type');
  assert(types.has('status'), 'assembleTimeline: has status type');
  assert(types.has('review'), 'assembleTimeline: has review type');
}

{
  // Task with only history
  const histOnly = { id: 'TH', title: 'Test', status: 'completed', history: [{ ts: now, status: 'completed', by: 'agent' }] };
  const boardMin = { taskPlan: { tasks: [histOnly] }, signals: [], insights: [], lessons: [] };
  const tl = timeline.assembleTimeline(boardMin, histOnly);
  assert(tl.length === 1, 'assembleTimeline: history-only task has 1 node', `got ${tl.length}`);
  assert(tl[0].source === 'history', 'assembleTimeline: history-only source is history');
}

// =======================================================================
//  Tests: buildDeliveryReport
// =======================================================================

console.log('\n--- buildDeliveryReport ---');

{
  const report = timeline.buildDeliveryReport(richBoard, richTask);
  assert(report.version === 'delivery_report.v1', 'buildDeliveryReport: version correct');
  assert(report.taskId === 'T1', 'buildDeliveryReport: taskId correct');
  assert(report.generatedAt, 'buildDeliveryReport: has generatedAt');
  assert(report.summary.title === 'Implement user auth', 'buildDeliveryReport: summary title correct');
  assert(report.summary.status === 'completed', 'buildDeliveryReport: summary status correct');
  assert(report.summary.score === 85, 'buildDeliveryReport: summary score correct');
  assert(report.summary.durationMin === 3, 'buildDeliveryReport: summary duration correct', `got ${report.summary.durationMin}`);
  assert(Array.isArray(report.timeline), 'buildDeliveryReport: has timeline array');
  assert(report.timeline.length > 0, 'buildDeliveryReport: timeline non-empty');
  assert(report.digest !== null, 'buildDeliveryReport: includes L2 digest');
  assert(report.digest.one_liner === 'Auth flow implemented', 'buildDeliveryReport: digest one_liner correct');
}

{
  const report = timeline.buildDeliveryReport(emptyBoard, emptyTask);
  assert(report.summary.score === null, 'buildDeliveryReport: empty task score is null');
  assert(report.summary.durationMin === null, 'buildDeliveryReport: empty task duration is null');
  assert(report.digest === null, 'buildDeliveryReport: empty task digest is null');
  assert(report.timeline.length === 0, 'buildDeliveryReport: empty task timeline is []');
}

// =======================================================================
//  Tests: renderReportHTML
// =======================================================================

console.log('\n--- renderReportHTML ---');

{
  const report = timeline.buildDeliveryReport(richBoard, richTask);
  const html = timeline.renderReportHTML(report);

  assert(typeof html === 'string', 'renderReportHTML: returns string');
  assert(html.includes('<!DOCTYPE html>'), 'renderReportHTML: starts with DOCTYPE');
  assert(html.includes('</html>'), 'renderReportHTML: ends with html close');
  assert(html.includes('Implement user auth'), 'renderReportHTML: includes task title');
  assert(html.includes('T1'), 'renderReportHTML: includes task ID');
  assert(html.includes('85'), 'renderReportHTML: includes score');
  assert(html.includes('window.print()'), 'renderReportHTML: includes print button');
  assert(html.includes('@media print'), 'renderReportHTML: includes print styles');
  assert(html.includes('print=1'), 'renderReportHTML: includes auto-print trigger');
  assert(html.includes('Auth flow implemented'), 'renderReportHTML: includes L2 digest');

  // Check timeline node colors present
  assert(html.includes(NODE_COLORS.dispatch), 'renderReportHTML: includes dispatch color');
  assert(html.includes(NODE_COLORS.review), 'renderReportHTML: includes review color');
}

{
  // Empty timeline report
  const report = timeline.buildDeliveryReport(emptyBoard, emptyTask);
  const html = timeline.renderReportHTML(report);
  assert(html.includes('No timeline events'), 'renderReportHTML: empty timeline shows message');
  assert(html.includes('Empty task'), 'renderReportHTML: empty task title shown');
}

// =======================================================================
//  Tests: escHtml
// =======================================================================

console.log('\n--- escHtml ---');

assert(escHtml('') === '', 'escHtml: empty string');
assert(escHtml(null) === '', 'escHtml: null');
assert(escHtml(undefined) === '', 'escHtml: undefined');
assert(escHtml('<script>alert("xss")</script>') === '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;', 'escHtml: XSS escape');
assert(escHtml('a & b') === 'a &amp; b', 'escHtml: ampersand');
assert(escHtml("it's") === "it&#39;s", 'escHtml: single quote');

// =======================================================================
//  Results
// =======================================================================

console.log(`\n${'='.repeat(40)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
