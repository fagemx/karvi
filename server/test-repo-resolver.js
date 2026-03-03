/**
 * test-repo-resolver.js — Unit tests for repo-resolver.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveRepoRoot, validateRepoRoot } = require('./repo-resolver');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\n=== repo-resolver tests ===\n');

// --- resolveRepoRoot ---

console.log('resolveRepoRoot:');

test('returns task.target_repo when set', () => {
  const result = resolveRepoRoot({ target_repo: '/some/path' }, { controls: { target_repo: '/other' } });
  assert.strictEqual(result, path.resolve('/some/path'));
});

test('returns board.controls.target_repo when task has none', () => {
  const result = resolveRepoRoot({}, { controls: { target_repo: '/board/path' } });
  assert.strictEqual(result, path.resolve('/board/path'));
});

test('task.target_repo takes priority over board.controls.target_repo', () => {
  const result = resolveRepoRoot(
    { target_repo: '/task/path' },
    { controls: { target_repo: '/board/path' } },
  );
  assert.strictEqual(result, path.resolve('/task/path'));
});

test('returns null when neither set', () => {
  const result = resolveRepoRoot({}, {});
  assert.strictEqual(result, null);
});

test('returns null when task is null', () => {
  const result = resolveRepoRoot(null, null);
  assert.strictEqual(result, null);
});

test('returns board-level when task has no target_repo field', () => {
  const result = resolveRepoRoot({ id: 'GH-1' }, { controls: { target_repo: '/p' } });
  assert.strictEqual(result, path.resolve('/p'));
});

test('returns null when controls exist but target_repo is missing', () => {
  const result = resolveRepoRoot({}, { controls: { auto_dispatch: true } });
  assert.strictEqual(result, null);
});

// --- validateRepoRoot ---

console.log('\nvalidateRepoRoot:');

test('rejects null path', () => {
  const result = validateRepoRoot(null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('No target_repo'));
});

test('rejects non-existent path', () => {
  const result = validateRepoRoot('/nonexistent/path/xyz123');
  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('Path not found'));
});

test('rejects non-git directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-resolver-test-'));
  try {
    const result = validateRepoRoot(tmpDir);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Not a git repo'));
  } finally {
    fs.rmdirSync(tmpDir);
  }
});

test('accepts valid git repo (karvi itself)', () => {
  const karviRoot = path.resolve(__dirname, '..');
  const result = validateRepoRoot(karviRoot);
  assert.strictEqual(result.valid, true);
});

test('accepts valid git repo with matching remote', () => {
  const karviRoot = path.resolve(__dirname, '..');
  const result = validateRepoRoot(karviRoot, 'fagemx/karvi');
  assert.strictEqual(result.valid, true);
});

test('rejects valid git repo with mismatched remote', () => {
  const karviRoot = path.resolve(__dirname, '..');
  const result = validateRepoRoot(karviRoot, 'someone/other-repo');
  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('Remote mismatch'));
});

// --- Summary ---

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
