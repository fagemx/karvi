'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveRepoRoot, validateRepoRoot, looksLikeSlug, resolveValue } = require('./repo-resolver');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

console.log('test-repo-resolver.js');
console.log('');

// --- looksLikeSlug ---
console.log('looksLikeSlug:');

test('detects owner/repo as slug', () => {
  assert.strictEqual(looksLikeSlug('fagemx/edda'), true);
  assert.strictEqual(looksLikeSlug('my-org/my-repo.js'), true);
});

test('rejects absolute paths', () => {
  assert.strictEqual(looksLikeSlug('C:/ai_agent/edda'), false);
  assert.strictEqual(looksLikeSlug('/home/user/repo'), false);
});

test('rejects bare names without slash', () => {
  assert.strictEqual(looksLikeSlug('edda'), false);
  assert.strictEqual(looksLikeSlug(''), false);
});

test('rejects paths with multiple segments', () => {
  assert.strictEqual(looksLikeSlug('a/b/c'), false);
});

// --- resolveValue ---
console.log('');
console.log('resolveValue:');

test('returns null for falsy input', () => {
  assert.strictEqual(resolveValue(null, {}), null);
  assert.strictEqual(resolveValue(undefined, {}), null);
  assert.strictEqual(resolveValue('', {}), null);
});

test('returns absolute path as-is', () => {
  const abs = process.platform === 'win32' ? 'C:\\ai_agent\\edda' : '/home/user/edda';
  assert.strictEqual(resolveValue(abs, {}), abs);
});

test('resolves slug via repo_map', () => {
  const map = { 'fagemx/edda': 'C:/ai_agent/edda' };
  const result = resolveValue('fagemx/edda', map);
  assert.strictEqual(result, path.resolve('C:/ai_agent/edda'));
});

test('returns null for unmapped slug', () => {
  assert.strictEqual(resolveValue('fagemx/edda', {}), null);
});

test('rejects ambiguous relative non-slug path', () => {
  const result = resolveValue('some-dir', {});
  assert.strictEqual(result, null);
});

// --- resolveRepoRoot ---
console.log('');
console.log('resolveRepoRoot:');

test('task absolute path wins', () => {
  const abs = process.platform === 'win32' ? 'C:\\ai_agent\\edda' : '/home/user/edda';
  const result = resolveRepoRoot({ target_repo: abs }, { controls: {} });
  assert.strictEqual(result, abs);
});

test('task slug resolved via repo_map', () => {
  const board = { controls: { repo_map: { 'fagemx/edda': 'C:/ai_agent/edda' } } };
  const result = resolveRepoRoot({ target_repo: 'fagemx/edda' }, board);
  assert.strictEqual(result, path.resolve('C:/ai_agent/edda'));
});

test('unmapped task slug falls through to board.controls.target_repo', () => {
  const abs = process.platform === 'win32' ? 'C:\\fallback' : '/fallback';
  const board = { controls: { target_repo: abs, repo_map: {} } };
  const result = resolveRepoRoot({ target_repo: 'unknown/repo' }, board);
  assert.strictEqual(result, abs);
});

test('board-level target_repo used when task has none', () => {
  const abs = process.platform === 'win32' ? 'C:\\board\\repo' : '/board/repo';
  const result = resolveRepoRoot({}, { controls: { target_repo: abs } });
  assert.strictEqual(result, abs);
});

test('board-level target_repo slug resolved via repo_map', () => {
  const board = { controls: { target_repo: 'fagemx/karvi', repo_map: { 'fagemx/karvi': 'C:/ai_agent/karvi' } } };
  const result = resolveRepoRoot({}, board);
  assert.strictEqual(result, path.resolve('C:/ai_agent/karvi'));
});

test('returns null when nothing configured', () => {
  assert.strictEqual(resolveRepoRoot({}, {}), null);
  assert.strictEqual(resolveRepoRoot(null, null), null);
});

// --- validateRepoRoot ---
console.log('');
console.log('validateRepoRoot:');

test('rejects null path', () => {
  const r = validateRepoRoot(null);
  assert.strictEqual(r.valid, false);
  assert.ok(r.error.includes('No target_repo'));
});

test('rejects non-existent path', () => {
  const r = validateRepoRoot('/definitely/does/not/exist/xyz');
  assert.strictEqual(r.valid, false);
  assert.ok(r.error.includes('Path not found'));
});

test('rejects non-git directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-resolver-test-'));
  try {
    const r = validateRepoRoot(tmpDir);
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.includes('Not a git repo'));
  } finally {
    fs.rmdirSync(tmpDir);
  }
});

test('validates actual git repo (cwd)', () => {
  const r = validateRepoRoot(process.cwd());
  assert.strictEqual(r.valid, true);
});

test('accepts valid git repo with matching remote', () => {
  const karviRoot = path.resolve(__dirname, '..');
  const r = validateRepoRoot(karviRoot, 'fagemx/karvi');
  assert.strictEqual(r.valid, true);
});

test('rejects valid git repo with mismatched remote', () => {
  const karviRoot = path.resolve(__dirname, '..');
  const r = validateRepoRoot(karviRoot, 'someone/other-repo');
  assert.strictEqual(r.valid, false);
  assert.ok(r.error.includes('Remote mismatch'));
});

// --- Summary ---
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
