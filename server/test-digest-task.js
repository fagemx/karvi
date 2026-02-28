#!/usr/bin/env node
/**
 * test-digest-task.js — Unit + integration tests for digest-task.js
 *
 * Tests prompt building, response parsing, fallback, and trigger flow.
 * No external dependencies, no real API calls.
 *
 * Usage:
 *   node server/test-digest-task.js
 */

const digest = require('./digest-task');
const {
  buildPrompt,
  parseDigestResponse,
  validateDigest,
  enforceOneLinerLength,
  gatherDigestContext,
  gatherUpstreamSummaries,
} = digest._internal;

let passed = 0;
let failed = 0;

function ok(name) { passed++; console.log(`  OK  ${name}`); }
function fail(name, err) { failed++; console.log(`  FAIL  ${name}: ${err || '(unknown)'}`); }

function assert(condition, name, detail) {
  if (condition) ok(name);
  else fail(name, detail || 'assertion failed');
}

// --- Test data ---

const sampleTask = {
  id: 'T1',
  title: 'Implement user login',
  description: 'Build authentication flow with JWT tokens',
  status: 'completed',
  assignee: 'eng_1',
  depends: ['T0'],
  dispatch: { runtime: 'openclaw', model: 'claude-sonnet-4-20250514' },
  review: {
    score: 85,
    summary: 'Code is clean, tests present, minor style issues',
    issues: ['Missing error boundary in login form'],
  },
  lastReply: 'Implemented the login flow with JWT...',
  confidence: null,
};

const sampleBoard = {
  taskPlan: {
    tasks: [
      { id: 'T0', title: 'Setup project', status: 'approved', digest: { one_liner: 'Project setup done' } },
      sampleTask,
    ],
  },
  lessons: [
    { status: 'active', rule: 'Always validate input on server side' },
    { status: 'validated', rule: 'Use parameterized queries' },
    { status: 'retired', rule: 'Old rule' },
  ],
  signals: [
    { id: 's1', refs: ['T1'], type: 'status_change', content: 'T1 pending -> in_progress' },
    { id: 's2', refs: ['T1'], type: 'status_change', content: 'T1 in_progress -> completed' },
    { id: 's3', refs: ['T0'], type: 'status_change', content: 'T0 completed -> approved' },
  ],
};

// --- Tests ---

console.log('\n=== digest-task.js tests ===\n');

// --- isDigestEnabled ---
console.log('-- isDigestEnabled --');

const origKey = process.env.ANTHROPIC_API_KEY;

process.env.ANTHROPIC_API_KEY = '';
assert(!digest.isDigestEnabled(), 'disabled when no key');

process.env.ANTHROPIC_API_KEY = 'sk-test-key-123';
assert(digest.isDigestEnabled(), 'enabled when key set');

// Restore
if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
else delete process.env.ANTHROPIC_API_KEY;

// --- buildPrompt ---
console.log('\n-- buildPrompt --');

const context = gatherDigestContext(sampleBoard, sampleTask);
const prompt = buildPrompt(sampleTask, context);

assert(typeof prompt === 'string', 'prompt is string');
assert(prompt.includes('T1'), 'prompt includes task id');
assert(prompt.includes('Implement user login'), 'prompt includes title');
assert(prompt.includes('85'), 'prompt includes review score');
assert(prompt.includes('Missing error boundary'), 'prompt includes review issues');
assert(prompt.includes('Always validate input'), 'prompt includes active lessons');
assert(prompt.includes('40 characters'), 'prompt includes one_liner constraint');
assert(prompt.includes('TaskDigest'), 'prompt includes schema reference');

// --- buildPrompt with minimal task ---
console.log('\n-- buildPrompt (minimal) --');

const minimalTask = { id: 'T99', title: 'Minimal task', status: 'pending' };
const minimalContext = gatherDigestContext({ taskPlan: { tasks: [minimalTask] } }, minimalTask);
const minimalPrompt = buildPrompt(minimalTask, minimalContext);

assert(typeof minimalPrompt === 'string', 'minimal prompt is string');
assert(minimalPrompt.includes('T99'), 'minimal prompt includes task id');
assert(!minimalPrompt.includes('Review Result'), 'minimal prompt has no review section');

// --- parseDigestResponse ---
console.log('\n-- parseDigestResponse --');

// Strategy 1: Direct JSON
const validJson = JSON.stringify({
  version: 'task_digest.v1',
  task_id: 'T1',
  one_liner: 'Login flow implemented',
  risk: { level: 'low', reasons: ['Well tested'] },
  bullets: { what: ['Built login'], why: ['User auth needed'], risk: ['Low'], notes: ['JWT tokens'] },
  warnings: [],
  provenance: { decisions: { count: 0 }, edda_refs: [] },
});

const r1 = parseDigestResponse(validJson);
assert(r1.digest !== null, 'direct JSON parsed');
assert(r1.source === 'direct', 'source is direct');
assert(r1.digest.task_id === 'T1', 'task_id correct');
assert(r1.digest.one_liner === 'Login flow implemented', 'one_liner correct');

// Strategy 2: Code block JSON
const codeBlockText = 'Here is the digest:\n```json\n' + validJson + '\n```\nDone.';
const r2 = parseDigestResponse(codeBlockText);
assert(r2.digest !== null, 'code block JSON parsed');
assert(r2.source === 'code_block', 'source is code_block');

// Strategy 3: Bare JSON in text
const bareText = 'The result is: ' + validJson + ' and that is all.';
const r3 = parseDigestResponse(bareText);
assert(r3.digest !== null, 'bare JSON parsed');
assert(r3.source === 'brace_extract', 'source is brace_extract');

// Failure case: no JSON
const r4 = parseDigestResponse('This is just text with no JSON');
assert(r4.digest === null, 'no JSON returns null');
assert(r4.error !== null, 'error message present');

// Failure case: empty
const r5 = parseDigestResponse('');
assert(r5.digest === null, 'empty response returns null');

// Failure case: null
const r6 = parseDigestResponse(null);
assert(r6.digest === null, 'null response returns null');

// --- one_liner truncation ---
console.log('\n-- one_liner truncation --');

const longLinerJson = JSON.stringify({
  version: 'task_digest.v1',
  task_id: 'T1',
  one_liner: 'This is a very long one liner that exceeds forty characters limit',
  risk: { level: 'low', reasons: [] },
  bullets: { what: ['x'], why: ['y'], risk: ['z'], notes: ['n'] },
});

const r7 = parseDigestResponse(longLinerJson);
assert(r7.digest !== null, 'long one_liner parsed');
assert(r7.digest.one_liner.length <= 40, `one_liner truncated to ${r7.digest.one_liner.length} chars`);
assert(r7.digest.one_liner.endsWith('...'), 'truncated one_liner ends with ...');

// --- validateDigest ---
console.log('\n-- validateDigest --');

assert(validateDigest({
  version: 'task_digest.v1',
  task_id: 'T1',
  one_liner: 'test',
  risk: { level: 'low' },
  bullets: { what: [] },
}), 'valid digest passes validation');

assert(!validateDigest(null), 'null fails validation');
assert(!validateDigest({}), 'empty object fails validation');
assert(!validateDigest({ version: 'v1' }), 'missing one_liner fails validation');
assert(!validateDigest({ one_liner: 'test', risk: 'low', bullets: {} }), 'risk as string fails');

// --- fallbackDigest ---
console.log('\n-- fallbackDigest --');

const fb = digest.fallbackDigest(sampleTask);
assert(fb.version === 'task_digest.v1', 'fallback version correct');
assert(fb.task_id === 'T1', 'fallback task_id correct');
assert(fb._fallback === true, 'fallback flag set');
assert(fb.risk.level === 'unknown', 'fallback risk is unknown');
assert(fb.one_liner.length <= 40, 'fallback one_liner within limit');
assert(fb.bullets.what.length > 0, 'fallback has what bullets');
assert(fb.warnings.length > 0, 'fallback has warnings');
assert(fb.warnings[0].code === 'LLM_UNAVAILABLE', 'fallback warning code correct');

// --- fallbackDigest with long title ---
const longTitleTask = { id: 'T2', title: 'A very long task title that definitely exceeds forty characters and should be truncated properly' };
const fb2 = digest.fallbackDigest(longTitleTask);
assert(fb2.one_liner.length <= 40, 'fallback truncates long title');

// --- fallbackDigest with no title ---
const noTitleTask = { id: 'T3' };
const fb3 = digest.fallbackDigest(noTitleTask);
assert(fb3.one_liner === '(no title)', 'fallback handles missing title');
assert(fb3.bullets.what[0] === '(no title)', 'fallback what says no title');

// --- gatherDigestContext ---
console.log('\n-- gatherDigestContext --');

const ctx = gatherDigestContext(sampleBoard, sampleTask);
assert(ctx.review !== null, 'context has review');
assert(ctx.review.score === 85, 'context review score correct');
assert(ctx.lessons.length === 2, 'context has 2 active lessons');
assert(!ctx.lessons.includes('Old rule'), 'retired lessons excluded');
assert(ctx.signals.length === 2, 'context has 2 signals for T1');
assert(ctx.lastReply.includes('Implemented'), 'context has lastReply');
assert(ctx.dispatch.runtime === 'openclaw', 'context dispatch runtime');
assert(ctx.description === sampleTask.description, 'context has description');

// --- gatherUpstreamSummaries ---
console.log('\n-- gatherUpstreamSummaries --');

const upstream = gatherUpstreamSummaries(sampleBoard, sampleTask);
assert(upstream.length === 1, 'one upstream task');
assert(upstream[0].id === 'T0', 'upstream task is T0');
assert(upstream[0].status === 'approved', 'upstream task is approved');
assert(upstream[0].one_liner === 'Project setup done', 'upstream has digest one_liner');

const noDepTask = { id: 'T5', depends: [] };
const noDeps = gatherUpstreamSummaries(sampleBoard, noDepTask);
assert(noDeps.length === 0, 'no deps returns empty');

// --- enforceOneLinerLength ---
console.log('\n-- enforceOneLinerLength --');

const d1 = { one_liner: 'short' };
enforceOneLinerLength(d1);
assert(d1.one_liner === 'short', 'short one_liner unchanged');

const d2 = { one_liner: 'This is exactly forty characters long!!' };
enforceOneLinerLength(d2);
assert(d2.one_liner.length <= 40, 'exactly 40 chars stays within limit');

const d3 = { one_liner: 'This string is definitely longer than forty characters and must be cut' };
enforceOneLinerLength(d3);
assert(d3.one_liner.length === 40, `truncated to 40, got ${d3.one_liner.length}`);
assert(d3.one_liner.endsWith('...'), 'ends with ...');

// --- triggerDigest integration (mock) ---
console.log('\n-- triggerDigest integration (mock) --');

async function testTriggerFallback() {
  // Without API key, triggerDigest should fallback
  const origKey2 = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  let sseBroadcasts = [];
  let logEntries = [];
  let boardState = JSON.parse(JSON.stringify(sampleBoard));

  const mockDeps = {
    readBoard: () => JSON.parse(JSON.stringify(boardState)),
    writeBoard: (b) => { boardState = b; },
    broadcastSSE: (ev, data) => { sseBroadcasts.push({ ev, data }); },
    appendLog: (entry) => { logEntries.push(entry); },
  };

  await digest.triggerDigest('T1', 'review_completed', mockDeps);

  const updatedTask = (boardState.taskPlan?.tasks || []).find(t => t.id === 'T1');
  assert(updatedTask?.digest !== undefined, 'digest written to task');
  assert(updatedTask?.digest._fallback === true, 'digest is fallback (no API key)');
  assert(updatedTask?.digest.trigger_event === 'review_completed', 'trigger_event set');
  assert(sseBroadcasts.length === 1, 'SSE broadcast sent');
  assert(sseBroadcasts[0].ev === 'task.digest_updated', 'SSE event name correct');
  assert(logEntries.length === 1, 'log entry appended');
  assert(logEntries[0].event === 'digest_generated', 'log event name correct');
  assert(logEntries[0].fallback === true, 'log records fallback');

  // Restore
  if (origKey2) process.env.ANTHROPIC_API_KEY = origKey2;
  else delete process.env.ANTHROPIC_API_KEY;
}

async function testTriggerMissingTask() {
  let boardState = { taskPlan: { tasks: [] } };
  const mockDeps = {
    readBoard: () => JSON.parse(JSON.stringify(boardState)),
    writeBoard: () => {},
    broadcastSSE: () => {},
    appendLog: () => {},
  };

  // Should not throw, just skip silently
  await digest.triggerDigest('NONEXISTENT', 'manual', mockDeps);
  ok('triggerDigest skips missing task');
}

async function runAsyncTests() {
  try {
    await testTriggerFallback();
  } catch (e) {
    fail('triggerDigest fallback', e.message);
  }
  try {
    await testTriggerMissingTask();
  } catch (e) {
    fail('triggerDigest missing task', e.message);
  }

  // --- Summary ---
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Total: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runAsyncTests();
