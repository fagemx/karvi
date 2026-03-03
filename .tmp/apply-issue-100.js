#!/usr/bin/env node
/**
 * One-shot script to apply all changes for issue #100:
 * 1. Creates server/runtime-contract.js
 * 2. Creates server/test-runtime-contract.js
 * 3. Edits server/server.js to import and call validateAllRuntimes
 */
const fs = require('fs');
const path = require('path');

const serverDir = path.join(__dirname, '..', 'server');

// --- 1. Create runtime-contract.js ---
const contractContent = `/**
 * runtime-contract.js — Runtime Adapter Interface Contract
 *
 * Defines the required interface for all Karvi runtime adapters and provides
 * a validation function to check compliance at startup.
 *
 * Every runtime adapter (openclaw, codex, claude, claude-api) must export
 * objects implementing all 5 required methods.
 *
 * @typedef {Object} RuntimeAdapter
 * @property {function} dispatch          - Execute a task via the runtime
 * @property {function} extractReplyText  - Extract reply text from runtime output
 * @property {function} extractSessionId  - Extract session ID from runtime output
 * @property {function} extractUsage      - Extract token usage from runtime output
 * @property {function} capabilities      - Return runtime capability descriptor
 */

/**
 * Required method names for a valid runtime adapter.
 * @type {string[]}
 */
const REQUIRED_METHODS = [
  'dispatch',
  'extractReplyText',
  'extractSessionId',
  'extractUsage',
  'capabilities',
];

/**
 * Validate that a runtime adapter object implements the full interface contract.
 *
 * Checks that all 5 required methods exist and are functions.
 * Throws with a clear, actionable error message on failure.
 *
 * @param {string} name - Runtime name (for error messages)
 * @param {*} rt - The runtime adapter object to validate
 * @throws {Error} If rt is null/undefined or missing required methods
 */
function validateRuntime(name, rt) {
  if (rt == null || typeof rt !== 'object') {
    throw new Error(
      \`[runtime-contract] Runtime "\${name}" is \${rt === null ? 'null' : typeof rt}\` +
      \` \\u2014 expected an object with methods: \${REQUIRED_METHODS.join(', ')}\`
    );
  }

  const missing = [];
  const nonFunction = [];

  for (const method of REQUIRED_METHODS) {
    if (!(method in rt)) {
      missing.push(method);
    } else if (typeof rt[method] !== 'function') {
      nonFunction.push(\`\${method} (got \${typeof rt[method]})\`);
    }
  }

  if (missing.length > 0 || nonFunction.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(\`missing: \${missing.join(', ')}\`);
    }
    if (nonFunction.length > 0) {
      parts.push(\`not a function: \${nonFunction.join(', ')}\`);
    }
    throw new Error(
      \`[runtime-contract] Runtime "\${name}" does not satisfy the adapter interface \\u2014 \${parts.join('; ')}\`
    );
  }
}

/**
 * Validate all runtimes in a RUNTIMES map.
 *
 * @param {Object<string, RuntimeAdapter>} runtimes - Map of name -> runtime adapter
 * @throws {Error} On first invalid runtime found
 */
function validateAllRuntimes(runtimes) {
  for (const [name, rt] of Object.entries(runtimes)) {
    validateRuntime(name, rt);
  }
}

module.exports = { REQUIRED_METHODS, validateRuntime, validateAllRuntimes };
`;

fs.writeFileSync(path.join(serverDir, 'runtime-contract.js'), contractContent);
console.log('Created server/runtime-contract.js');

// --- 2. Create test-runtime-contract.js ---
const testContent = `#!/usr/bin/env node
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

console.log('\\n=== runtime-contract tests ===\\n');

console.log('-- REQUIRED_METHODS --');
assert(REQUIRED_METHODS.length === 5, 'REQUIRED_METHODS has 5 entries');
assert(REQUIRED_METHODS.includes('dispatch'), 'includes dispatch');
assert(REQUIRED_METHODS.includes('extractReplyText'), 'includes extractReplyText');
assert(REQUIRED_METHODS.includes('extractSessionId'), 'includes extractSessionId');
assert(REQUIRED_METHODS.includes('extractUsage'), 'includes extractUsage');
assert(REQUIRED_METHODS.includes('capabilities'), 'includes capabilities');

console.log('\\n-- validateRuntime: valid --');
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

console.log('\\n-- validateRuntime: null/undefined --');
assertThrows(() => validateRuntime('bad', null), 'null runtime throws', 'is null');
assertThrows(() => validateRuntime('bad', undefined), 'undefined runtime throws', 'is undefined');
assertThrows(() => validateRuntime('bad', 'a string'), 'string runtime throws', 'is string');
assertThrows(() => validateRuntime('bad', 42), 'number runtime throws', 'is number');

console.log('\\n-- validateRuntime: missing methods --');
assertThrows(() => { const rt = validRuntime(); delete rt.dispatch; validateRuntime('no-dispatch', rt); }, 'missing dispatch throws', 'missing: dispatch');
assertThrows(() => { const rt = validRuntime(); delete rt.extractReplyText; validateRuntime('no-extractReplyText', rt); }, 'missing extractReplyText throws', 'missing: extractReplyText');
assertThrows(() => { const rt = validRuntime(); delete rt.extractSessionId; validateRuntime('no-extractSessionId', rt); }, 'missing extractSessionId throws', 'missing: extractSessionId');
assertThrows(() => { const rt = validRuntime(); delete rt.extractUsage; validateRuntime('no-extractUsage', rt); }, 'missing extractUsage throws', 'missing: extractUsage');
assertThrows(() => { const rt = validRuntime(); delete rt.capabilities; validateRuntime('no-capabilities', rt); }, 'missing capabilities throws', 'missing: capabilities');

console.log('\\n-- validateRuntime: non-function methods --');
assertThrows(() => { const rt = validRuntime(); rt.dispatch = 'not a function'; validateRuntime('string-dispatch', rt); }, 'non-function dispatch throws', 'not a function: dispatch');
assertThrows(() => { const rt = validRuntime(); rt.capabilities = { runtime: 'bad' }; validateRuntime('object-capabilities', rt); }, 'object capabilities throws', 'not a function: capabilities');

console.log('\\n-- validateRuntime: partial runtime --');
assertThrows(() => { validateRuntime('partial', { dispatch: () => {} }); }, 'partial runtime (only dispatch) throws with multiple missing', 'missing:');

console.log('\\n-- validateAllRuntimes --');
(() => {
  let threw = false;
  try { validateAllRuntimes({ openclaw: validRuntime(), codex: validRuntime() }); } catch { threw = true; }
  assert(!threw, 'validateAllRuntimes passes with all valid runtimes');
})();
assertThrows(() => { validateAllRuntimes({ openclaw: validRuntime(), broken: { dispatch: () => {} } }); }, 'validateAllRuntimes throws on first invalid runtime', '"broken"');

console.log('\\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
if (errors.length > 0) {
  console.log('\\nFailed:');
  errors.forEach(e => console.log('  - ' + e));
}
process.exitCode = failed > 0 ? 1 : 0;
`;

fs.writeFileSync(path.join(serverDir, 'test-runtime-contract.js'), testContent);
console.log('Created server/test-runtime-contract.js');

// --- 3. Edit server.js ---
let serverContent = fs.readFileSync(path.join(serverDir, 'server.js'), 'utf8');
const eol = serverContent.includes('\r\n') ? '\r\n' : '\n';

// Add import before RUNTIMES
serverContent = serverContent.replace(
  'const RUNTIMES = {',
  "const { validateAllRuntimes } = require('./runtime-contract');" + eol + eol + 'const RUNTIMES = {'
);

// Add validation call after RUNTIMES closing brace
serverContent = serverContent.replace(
  '};' + eol + eol + 'function getRuntime(hint) {',
  '};' + eol + eol + '// Validate all registered runtimes satisfy the adapter interface contract at startup' + eol + 'validateAllRuntimes(RUNTIMES);' + eol + eol + 'function getRuntime(hint) {'
);

fs.writeFileSync(path.join(serverDir, 'server.js'), serverContent);
console.log('Edited server/server.js');
console.log('All changes applied successfully.');
