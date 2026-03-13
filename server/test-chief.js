#!/usr/bin/env node
/**
 * test-chief.js — Unit tests for chief-level governance actions
 *
 * Tests: execGh, parseGhIssueCreate, nextSubtaskId, RBAC enforcement
 *
 * Usage: node server/test-chief.js
 */
const assert = require('assert');
const { parseGhIssueCreate, nextSubtaskId } = require('./routes/chief');
const { requireRole } = require('./routes/_shared');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  OK ${label}`); }
function fail(label, reason) { failed++; console.log(`  FAIL ${label}: ${reason}`); process.exitCode = 1; }

async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { fail(label, err.message); }
}

function nowIso() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function createMockRes() {
  const res = { statusCode: null, body: null, ended: false, headers: null };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; };
  res.end = (data) => { res.ended = true; try { res.body = data ? JSON.parse(data) : null; } catch { res.body = data; } };
  return res;
}

function createMockReq(role) {
  return { method: 'POST', url: '/api/chief/test', karviRole: role, headers: {} };
}

// ---------------------------------------------------------------------------
// Test 1: parseGhIssueCreate — valid URL
// ---------------------------------------------------------------------------
test('1. parseGhIssueCreate — extracts issue number and URL', async () => {
  const stdout = 'https://github.com/fagemx/karvi/issues/164\n';
  const result = parseGhIssueCreate(stdout);
  assert.deepStrictEqual(result, {
    number: 164,
    url: 'https://github.com/fagemx/karvi/issues/164',
    repo: 'fagemx/karvi',
  });
});

// ---------------------------------------------------------------------------
// Test 2: parseGhIssueCreate — no match
// ---------------------------------------------------------------------------
test('2. parseGhIssueCreate — returns null for invalid output', async () => {
  const result = parseGhIssueCreate('some random output');
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// Test 3: parseGhIssueCreate — different repo
// ---------------------------------------------------------------------------
test('3. parseGhIssueCreate — extracts from different repo', async () => {
  const stdout = 'https://github.com/owner/repo-name/issues/42\n';
  const result = parseGhIssueCreate(stdout);
  assert.deepStrictEqual(result, {
    number: 42,
    url: 'https://github.com/owner/repo-name/issues/42',
    repo: 'owner/repo-name',
  });
});

// ---------------------------------------------------------------------------
// Test 4: nextSubtaskId — first subtask
// ---------------------------------------------------------------------------
test('4. nextSubtaskId — generates first subtask ID', async () => {
  const existing = [];
  const result = nextSubtaskId('GH-100', existing);
  assert.strictEqual(result, 'GH-100-1');
});

// ---------------------------------------------------------------------------
// Test 5: nextSubtaskId — next in sequence
// ---------------------------------------------------------------------------
test('5. nextSubtaskId — generates next subtask ID in sequence', async () => {
  const existing = [
    { id: 'GH-100-1' },
    { id: 'GH-100-2' },
  ];
  const result = nextSubtaskId('GH-100', existing);
  assert.strictEqual(result, 'GH-100-3');
});

// ---------------------------------------------------------------------------
// Test 6: nextSubtaskId — ignores unrelated tasks
// ---------------------------------------------------------------------------
test('6. nextSubtaskId — ignores tasks with different prefix', async () => {
  const existing = [
    { id: 'GH-100-1' },
    { id: 'GH-101-1' },
    { id: 'VT-100-1' },
  ];
  const result = nextSubtaskId('GH-100', existing);
  assert.strictEqual(result, 'GH-100-2');
});

// ---------------------------------------------------------------------------
// Test 7: nextSubtaskId — handles gaps in sequence
// ---------------------------------------------------------------------------
test('7. nextSubtaskId — handles gaps in sequence', async () => {
  const existing = [
    { id: 'GH-100-1' },
    { id: 'GH-100-5' },
  ];
  const result = nextSubtaskId('GH-100', existing);
  assert.strictEqual(result, 'GH-100-6');
});

// ---------------------------------------------------------------------------
// Test 8: nextSubtaskId — works with VT prefix
// ---------------------------------------------------------------------------
test('8. nextSubtaskId — works with VT prefix', async () => {
  const existing = [
    { id: 'VT-50-1' },
    { id: 'VT-50-2' },
  ];
  const result = nextSubtaskId('VT-50', existing);
  assert.strictEqual(result, 'VT-50-3');
});

// ---------------------------------------------------------------------------
// Test 9: RBAC requireRole — null role (RBAC disabled) allows access
// ---------------------------------------------------------------------------
test('9. RBAC requireRole — null role allows access', async () => {
  const req = createMockReq(null);
  const res = createMockRes();
  const blocked = requireRole(req, res, 'operator');
  assert.strictEqual(blocked, false);
  assert.strictEqual(res.statusCode, null);
});

// ---------------------------------------------------------------------------
// Test 10: RBAC requireRole — undefined role allows access
// ---------------------------------------------------------------------------
test('10. RBAC requireRole — undefined role allows access', async () => {
  const req = createMockReq(undefined);
  const res = createMockRes();
  const blocked = requireRole(req, res, 'operator');
  assert.strictEqual(blocked, false);
  assert.strictEqual(res.statusCode, null);
});

// ---------------------------------------------------------------------------
// Test 11: RBAC requireRole — viewer blocked from operator
// ---------------------------------------------------------------------------
test('11. RBAC requireRole — viewer blocked from operator', async () => {
  const req = createMockReq('viewer');
  const res = createMockRes();
  const blocked = requireRole(req, res, 'operator');
  assert.strictEqual(blocked, true);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'forbidden');
});

// ---------------------------------------------------------------------------
// Test 12: RBAC requireRole — viewer blocked from admin
// ---------------------------------------------------------------------------
test('12. RBAC requireRole — viewer blocked from admin', async () => {
  const req = createMockReq('viewer');
  const res = createMockRes();
  const blocked = requireRole(req, res, 'admin');
  assert.strictEqual(blocked, true);
  assert.strictEqual(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Test 13: RBAC requireRole — operator allowed for operator
// ---------------------------------------------------------------------------
test('13. RBAC requireRole — operator allowed for operator', async () => {
  const req = createMockReq('operator');
  const res = createMockRes();
  const blocked = requireRole(req, res, 'operator');
  assert.strictEqual(blocked, false);
  assert.strictEqual(res.statusCode, null);
});

// ---------------------------------------------------------------------------
// Test 14: RBAC requireRole — operator blocked from admin
// ---------------------------------------------------------------------------
test('14. RBAC requireRole — operator blocked from admin', async () => {
  const req = createMockReq('operator');
  const res = createMockRes();
  const blocked = requireRole(req, res, 'admin');
  assert.strictEqual(blocked, true);
  assert.strictEqual(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Test 15: RBAC requireRole — admin allowed for operator
// ---------------------------------------------------------------------------
test('15. RBAC requireRole — admin allowed for operator', async () => {
  const req = createMockReq('admin');
  const res = createMockRes();
  const blocked = requireRole(req, res, 'operator');
  assert.strictEqual(blocked, false);
  assert.strictEqual(res.statusCode, null);
});

// ---------------------------------------------------------------------------
// Test 16: RBAC requireRole — admin allowed for admin
// ---------------------------------------------------------------------------
test('16. RBAC requireRole — admin allowed for admin', async () => {
  const req = createMockReq('admin');
  const res = createMockRes();
  const blocked = requireRole(req, res, 'admin');
  assert.strictEqual(blocked, false);
  assert.strictEqual(res.statusCode, null);
});

// ---------------------------------------------------------------------------
// Test 17: RBAC requireRole — viewer allowed for viewer
// ---------------------------------------------------------------------------
test('17. RBAC requireRole — viewer allowed for viewer', async () => {
  const req = createMockReq('viewer');
  const res = createMockRes();
  const blocked = requireRole(req, res, 'viewer');
  assert.strictEqual(blocked, false);
  assert.strictEqual(res.statusCode, null);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
