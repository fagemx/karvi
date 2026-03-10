/**
 * test-protected-diff-guard.js — Unit + integration tests for protected-diff-guard.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  parseProtectedAnnotations,
  parseProtectedAnnotationsFromContent,
  parseModifiedOriginalLines,
  extractDiffSnippet,
  validateProtectedDiff,
} = require('./protected-diff-guard');

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

// --- parseProtectedAnnotationsFromContent ---

console.log('\n--- parseProtectedAnnotationsFromContent ---');

test('single-line annotation protects next substantive line', () => {
  const content = [
    '// some comment',
    '// @protected decision:foo.bar — reason here',
    'const x = 1;',
    'const y = 2;',
  ].join('\n');
  const anns = parseProtectedAnnotationsFromContent(content);
  assert.strictEqual(anns.length, 1);
  assert.strictEqual(anns[0].key, 'foo.bar');
  assert.strictEqual(anns[0].reason, 'reason here');
  assert.strictEqual(anns[0].startLine, 2); // annotation line
  assert.strictEqual(anns[0].endLine, 3);   // the protected code line
});

test('multi-line block with @end-protected', () => {
  const content = [
    '// @protected decision:block.test — multi-line block',
    'const a = 1;',
    'const b = 2;',
    '// @end-protected',
    'const c = 3;',
  ].join('\n');
  const anns = parseProtectedAnnotationsFromContent(content);
  assert.strictEqual(anns.length, 1);
  assert.strictEqual(anns[0].startLine, 1);
  assert.strictEqual(anns[0].endLine, 4); // includes @end-protected
});

test('supports dash separator (not just em-dash)', () => {
  const content = '// @protected decision:test.dash - reason with dash\ncode();';
  const anns = parseProtectedAnnotationsFromContent(content);
  assert.strictEqual(anns.length, 1);
  assert.strictEqual(anns[0].key, 'test.dash');
});

test('supports hash comment style', () => {
  const content = '# @protected decision:py.thing \u2014 python style\nimport os';
  const anns = parseProtectedAnnotationsFromContent(content);
  assert.strictEqual(anns.length, 1);
  assert.strictEqual(anns[0].key, 'py.thing');
});

test('no annotations returns empty array', () => {
  const content = '// normal comment\nconst x = 1;\n';
  assert.strictEqual(parseProtectedAnnotationsFromContent(content).length, 0);
});

test('empty content returns empty array', () => {
  assert.strictEqual(parseProtectedAnnotationsFromContent('').length, 0);
  assert.strictEqual(parseProtectedAnnotationsFromContent(null).length, 0);
});

test('multiple annotations in same file', () => {
  const content = [
    '// @protected decision:a.b \u2014 reason A',
    'lineA();',
    '',
    '// @protected decision:c.d \u2014 reason B',
    'lineB();',
  ].join('\n');
  const anns = parseProtectedAnnotationsFromContent(content);
  assert.strictEqual(anns.length, 2);
  assert.strictEqual(anns[0].key, 'a.b');
  assert.strictEqual(anns[1].key, 'c.d');
});

test('annotation skips blank lines and comments to find protected code', () => {
  const content = [
    '// @protected decision:skip.blank \u2014 reason',
    '',
    '// another comment',
    'actual_code();',
  ].join('\n');
  const anns = parseProtectedAnnotationsFromContent(content);
  assert.strictEqual(anns.length, 1);
  assert.strictEqual(anns[0].endLine, 4); // actual_code line
});

// --- parseProtectedAnnotations (file-based) ---

console.log('\n--- parseProtectedAnnotations (file-based) ---');

test('reads from file on disk', () => {
  const tmpFile = path.join(os.tmpdir(), `karvi-test-protected-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, '// @protected decision:file.test \u2014 file test\ncode();\n');
  try {
    const anns = parseProtectedAnnotations(tmpFile);
    assert.strictEqual(anns.length, 1);
    assert.strictEqual(anns[0].key, 'file.test');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('nonexistent file returns empty array', () => {
  assert.strictEqual(parseProtectedAnnotations('/nonexistent/file.js').length, 0);
});

// --- parseModifiedOriginalLines ---

console.log('\n--- parseModifiedOriginalLines ---');

test('basic removal detection', () => {
  const diff = [
    'diff --git a/test.js b/test.js',
    '--- a/test.js',
    '+++ b/test.js',
    '@@ -3,4 +3,4 @@',
    ' context',
    '-removed line',
    '+added line',
    ' context',
  ].join('\n');
  const modified = parseModifiedOriginalLines(diff);
  assert.ok(modified.has(4)); // line 4 was removed (3 + 1 context)
  assert.ok(!modified.has(3)); // line 3 is context
  assert.ok(!modified.has(5)); // line 5 is context
});

test('multiple hunks', () => {
  const diff = [
    '@@ -1,3 +1,3 @@',
    '-old line 1',
    '+new line 1',
    ' same',
    ' same',
    '@@ -10,3 +10,3 @@',
    ' context',
    '-old line 11',
    '+new line 11',
    ' context',
  ].join('\n');
  const modified = parseModifiedOriginalLines(diff);
  assert.ok(modified.has(1));
  assert.ok(modified.has(11));
  assert.ok(!modified.has(2));
  assert.ok(!modified.has(10));
});

test('empty diff returns empty set', () => {
  assert.strictEqual(parseModifiedOriginalLines('').size, 0);
});

// --- extractDiffSnippet ---

console.log('\n--- extractDiffSnippet ---');

test('extracts context around target line', () => {
  const diff = [
    '@@ -1,5 +1,5 @@',
    ' line 1',
    ' line 2',
    '-line 3 old',
    '+line 3 new',
    ' line 4',
    ' line 5',
  ].join('\n');
  const snippet = extractDiffSnippet(diff, 3);
  assert.ok(snippet.includes('line 3 old') || snippet.includes('line 2'));
});

// --- validateProtectedDiff (integration) ---

console.log('\n--- validateProtectedDiff ---');

test('returns ok:true for null workDir', () => {
  const result = validateProtectedDiff(null);
  assert.strictEqual(result.ok, true);
});

test('returns ok:true for non-git directory', () => {
  const result = validateProtectedDiff(os.tmpdir());
  assert.strictEqual(result.ok, true);
});

// Full integration test with a temp git repo
test('detects violation when protected line is modified', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-guard-test-'));
  const opts = { cwd: tmpDir, encoding: 'utf8' };

  try {
    // Set up git repo
    execSync('git init', opts);
    execSync('git config user.email "test@test.com"', opts);
    execSync('git config user.name "Test"', opts);

    // Create file with protected annotation
    const testFile = path.join(tmpDir, 'code.js');
    fs.writeFileSync(testFile, [
      '// @protected decision:test.guard \u2014 this line must not change',
      'const critical = true;',
      'const normal = false;',
    ].join('\n'));

    execSync('git add -A', opts);
    execSync('git commit -m "initial"', opts);

    // Modify the protected line
    fs.writeFileSync(testFile, [
      '// @protected decision:test.guard \u2014 this line must not change',
      'const critical = false; // CHANGED!',
      'const normal = false;',
    ].join('\n'));

    execSync('git add -A', opts);
    execSync('git commit -m "bad change"', opts);

    const result = validateProtectedDiff(tmpDir);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].key, 'test.guard');
    assert.strictEqual(result.violations[0].file, 'code.js');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('passes when only non-protected lines are modified', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-guard-test-'));
  const opts = { cwd: tmpDir, encoding: 'utf8' };

  try {
    execSync('git init', opts);
    execSync('git config user.email "test@test.com"', opts);
    execSync('git config user.name "Test"', opts);

    const testFile = path.join(tmpDir, 'code.js');
    fs.writeFileSync(testFile, [
      '// @protected decision:test.safe \u2014 this line must not change',
      'const critical = true;',
      'const normal = false;',
    ].join('\n'));

    execSync('git add -A', opts);
    execSync('git commit -m "initial"', opts);

    // Only modify the non-protected line
    fs.writeFileSync(testFile, [
      '// @protected decision:test.safe \u2014 this line must not change',
      'const critical = true;',
      'const normal = true; // safe change',
    ].join('\n'));

    execSync('git add -A', opts);
    execSync('git commit -m "safe change"', opts);

    const result = validateProtectedDiff(tmpDir);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.violations.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- scanProtectedAnnotations ---
console.log('\n--- scanProtectedAnnotations ---');

const { scanProtectedAnnotations } = require('./protected-diff-guard');

test('scans directory for @protected annotations', () => {
  const tmpDir = path.join(os.tmpdir(), `scan-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(tmpDir, 'a.js'), '// @protected decision:a.key \u2014 reason A\ncode();\n');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'no annotations here\n');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'c.js'), '// @protected decision:c.key \u2014 reason C\ndeep();\n');
    // .hidden dir should be skipped
    fs.mkdirSync(path.join(tmpDir, '.hidden'));
    fs.writeFileSync(path.join(tmpDir, '.hidden', 'd.js'), '// @protected decision:d.key \u2014 skip\nx();\n');

    const results = scanProtectedAnnotations(tmpDir);
    assert.ok(results.length >= 2, `expected >= 2 annotations, got ${results.length}`);
    assert.ok(results.some(r => r.file === 'a.js' && r.key === 'a.key'));
    assert.ok(results.some(r => r.file === 'sub/c.js' && r.key === 'c.key'));
    assert.ok(!results.some(r => r.key === 'd.key'), 'should skip .hidden dir');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('returns empty for nonexistent directory', () => {
  const results = scanProtectedAnnotations('/nonexistent/path');
  assert.deepStrictEqual(results, []);
});

test('returns empty for null input', () => {
  const results = scanProtectedAnnotations(null);
  assert.deepStrictEqual(results, []);
});

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
