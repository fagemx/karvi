/**
 * test-postmortem.js — Tests for postmortem analysis module
 */
const assert = require('assert');
const path = require('path');
const postmortem = require('./postmortem');
const { analyzeErrorPatterns, buildTimeline, determineRootCause, generateSuggestions } = postmortem;

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');

function mockArtifactStore() {
  return {
    readLogLines: () => [],
    readArtifact: () => null,
  };
}

console.log('Testing postmortem.js...\n');

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`  ✓ ${name}`);
  passed++;
}

function fail(name, err) {
  console.log(`  ✗ ${name}: ${err.message}`);
  failed++;
}

// Test 1: analyzeErrorPatterns - network error
console.log('1. analyzeErrorPatterns - network error');
try {
  const result = analyzeErrorPatterns('ECONNREFUSED connection failed');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].category, 'network');
  assert.strictEqual(result[0].severity, 'high');
  ok('detects network error');
} catch (e) { fail('network error detection', e); }

// Test 2: analyzeErrorPatterns - file not found
console.log('2. analyzeErrorPatterns - file not found');
try {
  const result = analyzeErrorPatterns('ENOENT: no such file or directory');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].category, 'file_not_found');
  ok('detects file not found');
} catch (e) { fail('file not found detection', e); }

// Test 3: analyzeErrorPatterns - multiple errors
console.log('3. analyzeErrorPatterns - multiple errors');
try {
  const result = analyzeErrorPatterns('ECONNREFUSED and ENOENT both failed');
  assert(result.length >= 2, 'Should detect at least 2 error patterns');
  const categories = result.map(r => r.category);
  assert(categories.includes('network'), 'Should include network');
  assert(categories.includes('file_not_found'), 'Should include file_not_found');
  ok('detects multiple errors');
} catch (e) { fail('multiple error detection', e); }

// Test 4: analyzeErrorPatterns - unknown error
console.log('4. analyzeErrorPatterns - unknown error');
try {
  const result = analyzeErrorPatterns('Some random error message');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].category, 'unknown');
  ok('returns unknown for unrecognized errors');
} catch (e) { fail('unknown error handling', e); }

// Test 5: analyzeErrorPatterns - empty input
console.log('5. analyzeErrorPatterns - empty input');
try {
  const result = analyzeErrorPatterns('');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].category, 'unknown');
  ok('handles empty input');
} catch (e) { fail('empty input handling', e); }

// Test 6: buildTimeline - basic step
console.log('6. buildTimeline - basic step');
try {
  const steps = [{ step_id: 'T-001:plan', type: 'plan', state: 'succeeded', attempt: 1 }];
  const result = buildTimeline(steps, mockArtifactStore());
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].step_id, 'T-001:plan');
  assert.strictEqual(result[0].type, 'plan');
  assert.strictEqual(result[0].state, 'succeeded');
  ok('builds timeline from steps');
} catch (e) { fail('timeline building', e); }

// Test 7: buildTimeline - step with error
console.log('7. buildTimeline - step with error');
try {
  const steps = [{ step_id: 'T-001:plan', type: 'plan', state: 'dead', error: 'Max attempts exceeded' }];
  const result = buildTimeline(steps, mockArtifactStore());
  assert.strictEqual(result[0].error, 'Max attempts exceeded');
  ok('includes error in timeline');
} catch (e) { fail('timeline with error', e); }

// Test 8: determineRootCause - single error
console.log('8. determineRootCause - single error');
try {
  const timeline = [{ step_id: 'T-001:plan', state: 'dead', error: 'ECONNREFUSED' }];
  const patterns = analyzeErrorPatterns('ECONNREFUSED');
  const result = determineRootCause(timeline, patterns);
  assert.strictEqual(result.primary, 'network');
  assert.strictEqual(result.severity, 'high');
  assert.strictEqual(result.confidence, 'high');
  ok('determines root cause correctly');
} catch (e) { fail('root cause determination', e); }

// Test 9: determineRootCause - no patterns
console.log('9. determineRootCause - no patterns');
try {
  const timeline = [];
  const patterns = [];
  const result = determineRootCause(timeline, patterns);
  assert.strictEqual(result.primary, 'unknown');
  assert.strictEqual(result.confidence, 'low');
  ok('handles no patterns gracefully');
} catch (e) { fail('no patterns handling', e); }

// Test 10: generateSuggestions - network error
console.log('10. generateSuggestions - network error');
try {
  const rootCause = { primary: 'network', severity: 'high', confidence: 'high' };
  const timeline = [];
  const result = generateSuggestions(rootCause, timeline);
  assert(result.length > 0, 'Should have suggestions');
  assert(result.some(s => s.includes('network') || s.includes('retry')), 'Should mention network');
  ok('generates network suggestions');
} catch (e) { fail('suggestion generation', e); }

// Test 11: generateSuggestions - high retry count
console.log('11. generateSuggestions - high retry count');
try {
  const rootCause = { primary: 'unknown', severity: 'medium', confidence: 'low' };
  const timeline = [
    { step_id: 's1', attempt: 2 },
    { step_id: 's2', attempt: 2 },
  ];
  const result = generateSuggestions(rootCause, timeline);
  assert(result.some(s => s.includes('retry')), 'Should mention retry');
  ok('detects high retry count');
} catch (e) { fail('high retry detection', e); }

// Test 12: generatePostmortem - full task
console.log('12. generatePostmortem - full task');
try {
  const task = {
    id: 'T-001',
    status: 'blocked',
    blocker: { reason: 'Dead letter' },
    steps: [
      { step_id: 'T-001:plan', type: 'plan', state: 'succeeded', attempt: 0 },
      { step_id: 'T-001:implement', type: 'implement', state: 'dead', error: 'ECONNREFUSED', attempt: 3 },
    ],
  };
  const result = postmortem.generatePostmortem(task, mockArtifactStore());
  assert.strictEqual(result.task_id, 'T-001');
  assert.strictEqual(result.task_status, 'blocked');
  assert.strictEqual(result.root_cause.primary, 'network');
  assert.strictEqual(result.timeline.length, 2);
  assert(result.suggestions.length > 0, 'Should have suggestions');
  assert(result.summary.length > 0, 'Should have summary');
  ok('generates complete postmortem');
} catch (e) { fail('full postmortem generation', e); }

// Test 13: generatePostmortem - empty task
console.log('13. generatePostmortem - empty task');
try {
  const task = { id: 'T-002', status: 'blocked', steps: [] };
  const result = postmortem.generatePostmortem(task, mockArtifactStore());
  assert.strictEqual(result.task_id, 'T-002');
  assert.strictEqual(result.root_cause.primary, 'unknown');
  ok('handles task with no steps');
} catch (e) { fail('empty task handling', e); }

// Test 14: ERROR_PATTERNS - comprehensive coverage
console.log('14. ERROR_PATTERNS - comprehensive coverage');
try {
  const testCases = [
    { error: 'ENOTFOUND dns error', expected: 'network' },
    { error: 'Permission denied', expected: 'permission' },
    { error: 'heap out of memory', expected: 'memory' },
    { error: 'Request timeout', expected: 'timeout' },
    { error: 'Syntax error in JSON', expected: 'syntax' },
    { error: 'Rate limit exceeded 429', expected: 'rate_limit' },
    { error: 'Unauthorized 401', expected: 'auth' },
    { error: 'Validation failed', expected: 'validation' },
    { error: 'Dead letter max attempts', expected: 'exhausted' },
    { error: 'Git merge conflict', expected: 'git_conflict' },
    { error: 'EADDRINUSE port in use', expected: 'port_conflict' },
  ];
  for (const tc of testCases) {
    const result = analyzeErrorPatterns(tc.error);
    assert(result.some(r => r.category === tc.expected), `Should detect ${tc.expected} for "${tc.error}"`);
  }
  ok('all error patterns covered');
} catch (e) { fail('comprehensive pattern coverage', e); }

// Summary
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
