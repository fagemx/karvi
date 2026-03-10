#!/usr/bin/env node
/**
 * test-load-env.js — Regression tests for load-env precedence behavior.
 *
 * Usage:
 *   node server/test-load-env.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

const loadEnvPath = path.join(__dirname, 'load-env.js');

function runLoadEnvFresh() {
  delete require.cache[require.resolve(loadEnvPath)];
  require(loadEnvPath);
}

function withTempEnvFile(content, fn) {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-load-env-'));
  try {
    fs.writeFileSync(path.join(tmpDir, '.env'), content, 'utf8');
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withEnvVar(key, value, fn) {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, key);
  const oldValue = process.env[key];
  try {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    fn();
  } finally {
    if (hadKey) process.env[key] = oldValue;
    else delete process.env[key];
  }
}

console.log('load-env.js regression tests\n');

test('1. keeps explicit empty-string env var (regression #306)', () => {
  const key = 'KARVI_TEST_EMPTY_306';
  withTempEnvFile(`${key}=from_file\n`, () => {
    withEnvVar(key, '', () => {
      runLoadEnvFresh();
      assert.strictEqual(process.env[key], '');
    });
  });
});

test('2. applies .env value when env key is absent', () => {
  const key = 'KARVI_TEST_MISSING_306';
  withTempEnvFile(`${key}=from_file\n`, () => {
    withEnvVar(key, undefined, () => {
      runLoadEnvFresh();
      assert.strictEqual(process.env[key], 'from_file');
    });
  });
});

test('3. keeps existing non-empty env var', () => {
  const key = 'KARVI_TEST_EXISTING_306';
  withTempEnvFile(`${key}=from_file\n`, () => {
    withEnvVar(key, 'from_process', () => {
      runLoadEnvFresh();
      assert.strictEqual(process.env[key], 'from_process');
    });
  });
});

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
