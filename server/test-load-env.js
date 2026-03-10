'use strict';
/**
 * test-load-env.js — Regression tests for server/load-env.js load-order semantics
 *
 * Verifies that existing env vars (including empty-string) are never overridden
 * by values from a .env file (fix for GH-306).
 *
 * Usage: node server/test-load-env.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274c ${label}: ${reason}`); process.exitCode = 1; }

function test(label, fn) {
  try { fn(); ok(label); } catch (err) { fail(label, err.message); }
}

// Absolute path to load-env module (required for reliable cache-busting)
const LOAD_ENV_PATH = require.resolve('./load-env');

/**
 * Load load-env.js in a controlled temp environment and return the resulting
 * env var values for the requested keys.
 *
 * Steps:
 *  1. Create a temp dir with the given .env content
 *  2. Optionally preset env vars (undefined = delete the key)
 *  3. chdir to temp dir so load-env reads our fixture .env
 *  4. Cache-bust and re-require load-env (uses absolute path so chdir doesn't matter)
 *  5. Capture requested env var values BEFORE cleanup
 *  6. Restore cwd, env vars, clean up temp dir and module cache
 *
 * @param {string}   envFileContent  Content to write to the temp .env file
 * @param {Object}   presetEnv       Keys to preset (value=undefined → delete the key)
 * @param {string[]} captureKeys     Env var names whose post-load values to return
 * @returns {Object}                 Map of captureKeys → values after load-env ran
 */
function runLoadEnvInSandbox(envFileContent, presetEnv = {}, captureKeys = []) {
  const origCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-load-env-test-'));
  const savedEnv = {};
  let captured = {};

  try {
    // Write temp .env fixture
    fs.writeFileSync(path.join(tmpDir, '.env'), envFileContent, 'utf8');

    // Save original env state and apply presets
    for (const [k, v] of Object.entries(presetEnv)) {
      savedEnv[k] = k in process.env ? process.env[k] : undefined;
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    // chdir so load-env resolves cwd-based .env to our fixture
    process.chdir(tmpDir);

    // Cache-bust and reload using the absolute resolved path
    delete require.cache[LOAD_ENV_PATH];
    require(LOAD_ENV_PATH);

    // Capture BEFORE restoring env (while effects are still live)
    for (const k of captureKeys) {
      captured[k] = k in process.env ? process.env[k] : undefined;
    }

  } finally {
    // Restore cwd
    process.chdir(origCwd);

    // Restore env vars to original state
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    // Remove any keys that were absent before but may have been set by load-env
    for (const k of captureKeys) {
      if (!(k in savedEnv)) {
        delete process.env[k];
      }
    }

    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // Remove load-env from module cache so later tests start fresh
    delete require.cache[LOAD_ENV_PATH];
  }

  return captured;
}

console.log('\ntest-load-env.js \u2014 load-env GH-306 regression\n');

// --- Case A: Empty-string existing env var must NOT be overridden (GH-306 regression) ---
test('Case A: empty-string env var is preserved against .env override', () => {
  const KEY = 'KARVI_LOAD_ENV_TEST_A';
  const result = runLoadEnvInSandbox(
    `${KEY}=from_file\n`,
    { [KEY]: '' },   // preset: empty string
    [KEY]
  );
  assert.strictEqual(result[KEY], '',
    `Expected "" (empty string preserved) but got ${JSON.stringify(result[KEY])}`);
});

// --- Case B: Missing key should be populated from .env ---
test('Case B: absent key is populated from .env file', () => {
  const KEY = 'KARVI_LOAD_ENV_TEST_B';
  const result = runLoadEnvInSandbox(
    `${KEY}=from_file_b\n`,
    { [KEY]: undefined },   // preset: key absent
    [KEY]
  );
  assert.strictEqual(result[KEY], 'from_file_b',
    `Expected "from_file_b" but got ${JSON.stringify(result[KEY])}`);
});

// --- Case C: Non-empty existing env var must NOT be overridden ---
test('Case C: non-empty env var is not overridden by .env file', () => {
  const KEY = 'KARVI_LOAD_ENV_TEST_C';
  const result = runLoadEnvInSandbox(
    `${KEY}=from_file_c\n`,
    { [KEY]: 'runtime_value' },
    [KEY]
  );
  assert.strictEqual(result[KEY], 'runtime_value',
    `Expected "runtime_value" but got ${JSON.stringify(result[KEY])}`);
});

// --- Case D: .env with comment lines and blank lines is parsed correctly ---
test('Case D: comments and blank lines in .env are ignored', () => {
  const KEY = 'KARVI_LOAD_ENV_TEST_D';
  const result = runLoadEnvInSandbox(
    `# This is a comment\n\n${KEY}=value_d\n# another comment\n`,
    { [KEY]: undefined },
    [KEY]
  );
  assert.strictEqual(result[KEY], 'value_d',
    `Expected "value_d" but got ${JSON.stringify(result[KEY])}`);
});

// --- Case E: Quoted values in .env are stripped ---
test('Case E: quoted values in .env are unquoted', () => {
  const KEY_DQ = 'KARVI_LOAD_ENV_TEST_E1';
  const KEY_SQ = 'KARVI_LOAD_ENV_TEST_E2';
  const result = runLoadEnvInSandbox(
    `${KEY_DQ}="double_quoted"\n${KEY_SQ}='single_quoted'\n`,
    { [KEY_DQ]: undefined, [KEY_SQ]: undefined },
    [KEY_DQ, KEY_SQ]
  );
  assert.strictEqual(result[KEY_DQ], 'double_quoted',
    `Expected "double_quoted" but got ${JSON.stringify(result[KEY_DQ])}`);
  assert.strictEqual(result[KEY_SQ], 'single_quoted',
    `Expected "single_quoted" but got ${JSON.stringify(result[KEY_SQ])}`);
});

// --- Summary ---
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
