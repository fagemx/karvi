#!/usr/bin/env node
/**
 * test-runtime-contract.js — Unit tests for runtime-contract.js
 *
 * Tests validateRuntime() and validateAllRuntimes() to ensure the
 * runtime adapter interface contract is enforced correctly.
 *
 * Usage: node server/test-runtime-contract.js
 */
const { validateRuntime, validateAllRuntimes, REQUIRED_METHODS } = require('./runtime-contract');

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log('  pass ' + testName);
  } else {
    failed++;
    errors.push(testName);
    console.log('  FAIL ' + testName);
  }
}

function assertThrows(fn, testName, expectedMsg) {
  try {
    fn();
    failed++;
    errors.push(testName + ' (did not throw)');
    console.log('  FAIL ' + testName + ' — expected throw but did not');
  } catch (err) {
    if (expectedMsg && !err.message.includes(expectedMsg)) {
      failed++;
      errors.push(testName + ' (wrong message: ' + err.message + ')');
      console.log('  FAIL ' + testName + ' — wrong error: ' + err.message);
    } else {
      passed++;
      console.log('  pass ' + testName);
    }
  }
}

function validRuntime() {
  return {
    dispatch: async () => ({ code: 0, stdout: '', stderr: '', parsed: null }),
    extractReplyText: () => '',
    extractSessionId: () => null,
    extractUsage: () => null,
    capabilities: () => ({ runtime: 'test' }),
  };
}

console.log('\n=== runtime-contract tests ===\n');

console.log('-- REQUIRED_METHODS --');
assert(REQUIRED_METHODS.length === 5, 'REQUIRED_METHODS has 5 entries');
assert(REQUIRED_METHODS.includes('dispatch'), 'includes dispatch');
assert(REQUIRED_METHODS.includes('extractReplyText'), 'includes extractReplyText');
assert(REQUIRED_METHODS.includes('extractSessionId'), 'includes extractSessionId');
assert(REQUIRED_METHODS.includes('extractUsage'), 'includes extractUsage');
assert(REQUIRED_METHODS.includes('capabilities'), 'includes capabilities');

console.log('\n-- validateRuntime: valid --');
(() => {
  let threw = false;
  try { validateRuntime('test', validRuntime()); } catch { threw = true; }
  assert(!threw, 'valid runtime passes without error');
})();

(() => {
  const rt = { ...validRuntime(), spawnReview: () => {}, runOpenclawTurn: () => {} };
  let threw = false;
  try { validateRuntime('openclaw-extras', rt); } catch { threw = true; }
  assert(!threw, 'extra methods beyond contract are allowed');
})();

console.log('\n-- validateRuntime: null/undefined --');
assertThrows(() => validateRuntime('bad', null), 'null runtime throws', 'is null');
assertThrows(() => validateRuntime('bad', undefined), 'undefined runtime throws', 'is undefined');
assertThrows(() => validateRuntime('bad', 'a string'), 'string runtime throws', 'is string');
assertThrows(() => validateRuntime('bad', 42), 'number runtime throws', 'is number');

console.log('\n-- validateRuntime: missing methods --');
assertThrows(() => { const rt = validRuntime(); delete rt.dispatch; validateRuntime('no-dispatch', rt); }, 'missing dispatch throws', 'missing: dispatch');
assertThrows(() => { const rt = validRuntime(); delete rt.extractReplyText; validateRuntime('no-extractReplyText', rt); }, 'missing extractReplyText throws', 'missing: extractReplyText');
assertThrows(() => { const rt = validRuntime(); delete rt.extractSessionId; validateRuntime('no-extractSessionId', rt); }, 'missing extractSessionId throws', 'missing: extractSessionId');
assertThrows(() => { const rt = validRuntime(); delete rt.extractUsage; validateRuntime('no-extractUsage', rt); }, 'missing extractUsage throws', 'missing: extractUsage');
assertThrows(() => { const rt = validRuntime(); delete rt.capabilities; validateRuntime('no-capabilities', rt); }, 'missing capabilities throws', 'missing: capabilities');

console.log('\n-- validateRuntime: non-function methods --');
assertThrows(() => { const rt = validRuntime(); rt.dispatch = 'not a function'; validateRuntime('string-dispatch', rt); }, 'non-function dispatch throws', 'not a function: dispatch');
assertThrows(() => { const rt = validRuntime(); rt.capabilities = { runtime: 'bad' }; validateRuntime('object-capabilities', rt); }, 'object capabilities throws', 'not a function: capabilities');

console.log('\n-- validateRuntime: partial runtime --');
assertThrows(() => { validateRuntime('partial', { dispatch: () => {} }); }, 'partial runtime (only dispatch) throws with multiple missing', 'missing:');

console.log('\n-- validateAllRuntimes --');
(() => {
  let threw = false;
  try { validateAllRuntimes({ openclaw: validRuntime(), codex: validRuntime() }); } catch { threw = true; }
  assert(!threw, 'validateAllRuntimes passes with all valid runtimes');
})();
assertThrows(() => { validateAllRuntimes({ openclaw: validRuntime(), broken: { dispatch: () => {} } }); }, 'validateAllRuntimes throws on first invalid runtime', '"broken"');

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
if (errors.length > 0) {
  console.log('\nFailed:');
  errors.forEach(e => console.log('  - ' + e));
}
process.exitCode = failed > 0 ? 1 : 0;
