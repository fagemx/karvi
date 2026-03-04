#!/usr/bin/env node
/**
 * test-discovery.js — Unit tests for routes/discovery.js
 *
 * Usage: node server/test-discovery.js
 */
const assert = require('assert');
const { listRuntimes, listSkills, runPreflight, parseFrontmatter, _resetCaches } = require('./routes/discovery');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274c ${label}: ${reason}`); process.exitCode = 1; }

function test(label, fn) {
  try { fn(); ok(label); } catch (err) { fail(label, err.message); }
}

console.log('\n\uD83E\uDDEA test-discovery.js — Discovery API\n');

// --- parseFrontmatter ---

console.log('=== parseFrontmatter ===\n');

test('parses LF frontmatter', () => {
  const result = parseFrontmatter('---\nname: test\ndescription: hello world\n---\nbody');
  assert.strictEqual(result.name, 'test');
  assert.strictEqual(result.description, 'hello world');
});

test('parses CRLF frontmatter', () => {
  const result = parseFrontmatter('---\r\nname: test\r\ndescription: hello world\r\n---\r\nbody');
  assert.strictEqual(result.name, 'test');
  assert.strictEqual(result.description, 'hello world');
});

test('handles quoted values', () => {
  const result = parseFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\n');
  assert.strictEqual(result.name, 'quoted');
  assert.strictEqual(result.description, 'single');
});

test('returns empty object for missing frontmatter', () => {
  const result = parseFrontmatter('no frontmatter here');
  assert.deepStrictEqual(result, {});
});

test('returns empty object for empty content', () => {
  const result = parseFrontmatter('');
  assert.deepStrictEqual(result, {});
});

// --- listRuntimes ---

console.log('\n=== listRuntimes ===\n');

test('lists runtimes from deps.RUNTIMES', () => {
  const deps = {
    RUNTIMES: {
      openclaw: { capabilities: () => ({ runtime: 'openclaw', supportsSessionResume: false, supportsModelSelection: false }) },
      claude: { capabilities: () => ({ runtime: 'claude', supportsSessionResume: true, supportsModelSelection: true }) },
    },
  };
  const result = listRuntimes(deps);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].id, 'openclaw');
  assert.strictEqual(result[0].supportsSessionResume, false);
  assert.strictEqual(result[1].id, 'claude');
  assert.strictEqual(result[1].supportsSessionResume, true);
});

test('handles runtime without capabilities function', () => {
  const deps = { RUNTIMES: { bare: {} } };
  const result = listRuntimes(deps);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'bare');
  assert.strictEqual(result[0].supportsSessionResume, false);
});

test('empty RUNTIMES returns empty array', () => {
  const deps = { RUNTIMES: {} };
  const result = listRuntimes(deps);
  assert.strictEqual(result.length, 0);
});

// --- listSkills ---

console.log('\n=== listSkills ===\n');

_resetCaches();

test('lists skills from .claude/skills directory', () => {
  const path = require('path');
  const projectRoot = path.resolve(__dirname, '..');
  const result = listSkills(projectRoot);
  assert.ok(Array.isArray(result));
  assert.ok(result.length > 0, 'should find at least one skill');
  const commitSkill = result.find(s => s.id === 'commit');
  assert.ok(commitSkill, 'should find commit skill');
  assert.strictEqual(commitSkill.name, 'commit');
  assert.ok(commitSkill.description.length > 0, 'description should not be empty');
});

test('returns empty array for non-existent directory', () => {
  _resetCaches();
  const result = listSkills('/non/existent/path');
  assert.deepStrictEqual(result, []);
});

// --- runPreflight ---

console.log('\n=== runPreflight ===\n');

_resetCaches();

test('returns preflight with expected structure', () => {
  const deps = {
    RUNTIMES: { openclaw: { capabilities: () => ({}) } },
  };
  const result = runPreflight(deps);
  assert.ok(result.version);
  assert.ok(result.checks);
  assert.ok(result.checks.node);
  assert.ok(result.checks.git);
  assert.ok(result.checks.runtimes);
  assert.ok(result.checks.env);
  assert.strictEqual(typeof result.ready, 'boolean');
  assert.ok(Array.isArray(result.warnings));
});

_resetCaches();

test('ready=false when no runtimes', () => {
  const deps = { RUNTIMES: {} };
  const result = runPreflight(deps);
  assert.strictEqual(result.ready, false);
  assert.ok(result.warnings.some(w => w.includes('No agent runtimes')));
});

// --- summary ---
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed\n`);
