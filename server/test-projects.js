#!/usr/bin/env node
/**
 * test-projects.js — Unit tests for Project Orchestrator (#194)
 *
 * Tests: CRUD, autoUnlockDependents with completionTrigger,
 * tryAutoDispatch project concurrency gate, pr_merged → project advance.
 *
 * Usage: node server/test-projects.js
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const mgmt = require('./management');
const { hasCycle, computeProgress } = require('./routes/projects');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { fail(label, err.message); }
}

function nowIso() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function createBoard(tasks, projects) {
  return {
    taskPlan: { goal: 'project test', phase: 'executing', tasks },
    projects: projects || [],
    signals: [],
    insights: [],
    lessons: [],
    participants: [
      { id: 'owner', type: 'human' },
      { id: 'engineer_lite', type: 'agent' },
    ],
    controls: { auto_dispatch: true, auto_review: false },
  };
}

function createMockHelpers(board) {
  const state = { board: JSON.parse(JSON.stringify(board)), log: [] };
  return {
    readBoard: () => state.board,
    writeBoard: (b) => { state.board = b; },
    appendLog: (e) => { state.log.push(e); },
    broadcastSSE: () => {},
    nowIso,
    uid,
    _state: state,
  };
}

// ---------------------------------------------------------------------------
// Test 1: hasCycle — no cycle
// ---------------------------------------------------------------------------
test('1. hasCycle — no cycle returns false', async () => {
  const tasks = [
    { issue: 1, depends: [] },
    { issue: 2, depends: [1] },
    { issue: 3, depends: [1, 2] },
  ];
  assert.strictEqual(hasCycle(tasks), false);
});

// ---------------------------------------------------------------------------
// Test 2: hasCycle — cycle detected
// ---------------------------------------------------------------------------
test('2. hasCycle — cycle returns true', async () => {
  const tasks = [
    { issue: 1, depends: [3] },
    { issue: 2, depends: [1] },
    { issue: 3, depends: [2] },
  ];
  assert.strictEqual(hasCycle(tasks), true);
});

// ---------------------------------------------------------------------------
// Test 3: computeProgress — basic calculation
// ---------------------------------------------------------------------------
test('3. computeProgress — counts tasks correctly', async () => {
  const project = { id: 'PROJ-1', completionTrigger: 'approved', taskIds: ['GH-1', 'GH-2', 'GH-3'] };
  const board = createBoard([
    { id: 'GH-1', status: 'approved', projectId: 'PROJ-1' },
    { id: 'GH-2', status: 'in_progress', projectId: 'PROJ-1' },
    { id: 'GH-3', status: 'pending', projectId: 'PROJ-1' },
  ], [project]);

  const p = computeProgress(board, project);
  assert.strictEqual(p.total, 3);
  assert.strictEqual(p.done, 1);
  assert.strictEqual(p.in_progress, 1);
  assert.strictEqual(p.pending, 1);
  assert.strictEqual(p.pct, 33);
});

// ---------------------------------------------------------------------------
// Test 4: computeProgress — pr_merged trigger counts merged PRs
// ---------------------------------------------------------------------------
test('4. computeProgress — pr_merged trigger counts merged PRs as done', async () => {
  const project = { id: 'PROJ-1', completionTrigger: 'pr_merged', taskIds: ['GH-1', 'GH-2'] };
  const board = createBoard([
    { id: 'GH-1', status: 'approved', projectId: 'PROJ-1', pr: { outcome: 'merged' } },
    { id: 'GH-2', status: 'approved', projectId: 'PROJ-1', pr: { outcome: null } },
  ], [project]);

  const p = computeProgress(board, project);
  assert.strictEqual(p.done, 1);
  assert.strictEqual(p.in_progress, 1); // approved but not merged = in_progress
});

// ---------------------------------------------------------------------------
// Test 5: autoUnlockDependents — default trigger (approved) — existing behavior
// ---------------------------------------------------------------------------
test('5. autoUnlockDependents — default trigger (approved) unlocks normally', async () => {
  const board = createBoard([
    { id: 'GH-1', status: 'approved' },
    { id: 'GH-2', status: 'pending', depends: ['GH-1'] },
  ]);

  const unlocked = mgmt.autoUnlockDependents(board);
  assert.deepStrictEqual(unlocked, ['GH-2']);
  assert.strictEqual(board.taskPlan.tasks[1].status, 'dispatched');
});

// ---------------------------------------------------------------------------
// Test 6: autoUnlockDependents — pr_merged trigger, dep approved but NOT merged
// ---------------------------------------------------------------------------
test('6. autoUnlockDependents — pr_merged trigger, dep approved but not merged → no unlock', async () => {
  const board = createBoard([
    { id: 'GH-1', status: 'approved', completionTrigger: 'pr_merged', pr: { outcome: null } },
    { id: 'GH-2', status: 'pending', depends: ['GH-1'] },
  ]);

  const unlocked = mgmt.autoUnlockDependents(board);
  assert.deepStrictEqual(unlocked, []);
  assert.strictEqual(board.taskPlan.tasks[1].status, 'pending');
});

// ---------------------------------------------------------------------------
// Test 7: autoUnlockDependents — pr_merged trigger, dep approved AND merged
// ---------------------------------------------------------------------------
test('7. autoUnlockDependents — pr_merged trigger, dep approved + merged → unlocks', async () => {
  const board = createBoard([
    { id: 'GH-1', status: 'approved', completionTrigger: 'pr_merged', pr: { outcome: 'merged' } },
    { id: 'GH-2', status: 'pending', depends: ['GH-1'] },
  ]);

  const unlocked = mgmt.autoUnlockDependents(board);
  assert.deepStrictEqual(unlocked, ['GH-2']);
  assert.strictEqual(board.taskPlan.tasks[1].status, 'dispatched');
});

// ---------------------------------------------------------------------------
// Test 8: autoUnlockDependents — mixed triggers in deps
// ---------------------------------------------------------------------------
test('8. autoUnlockDependents — mixed triggers: one pr_merged (merged) + one approved', async () => {
  const board = createBoard([
    { id: 'GH-1', status: 'approved', completionTrigger: 'pr_merged', pr: { outcome: 'merged' } },
    { id: 'GH-2', status: 'approved' }, // default trigger = approved
    { id: 'GH-3', status: 'pending', depends: ['GH-1', 'GH-2'] },
  ]);

  const unlocked = mgmt.autoUnlockDependents(board);
  assert.deepStrictEqual(unlocked, ['GH-3']);
});

// ---------------------------------------------------------------------------
// Test 9: autoUnlockDependents — mixed triggers, one not met
// ---------------------------------------------------------------------------
test('9. autoUnlockDependents — mixed triggers: pr_merged dep not merged → no unlock', async () => {
  const board = createBoard([
    { id: 'GH-1', status: 'approved', completionTrigger: 'pr_merged', pr: { outcome: null } },
    { id: 'GH-2', status: 'approved' },
    { id: 'GH-3', status: 'pending', depends: ['GH-1', 'GH-2'] },
  ]);

  const unlocked = mgmt.autoUnlockDependents(board);
  assert.deepStrictEqual(unlocked, []);
});

// ---------------------------------------------------------------------------
// Test 10: Project CRUD — POST creates project + tasks
// ---------------------------------------------------------------------------
test('10. POST /api/projects — creates project and tasks on board', async () => {
  const projectsRoutes = require('./routes/projects');
  const board = createBoard([]);
  const helpers = createMockHelpers(board);
  const deps = { mgmt, tryAutoDispatch: null };

  const input = {
    title: 'Test Project',
    repo: 'owner/repo',
    concurrency: 2,
    completionTrigger: 'pr_merged',
    tasks: [
      { issue: 10, depends: [], title: 'Task 10' },
      { issue: 11, depends: [10], title: 'Task 11' },
    ],
  };

  // Simulate request
  const req = createMockReq('POST', '/api/projects', JSON.stringify(input));
  const res = createMockRes();

  projectsRoutes(req, res, helpers, deps);
  req.emit('data', JSON.stringify(input));
  req.emit('end');

  await tick();

  assert.strictEqual(res._statusCode, 201);
  const result = JSON.parse(res._body);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.project.title, 'Test Project');
  assert.strictEqual(result.project.taskIds.length, 2);

  // Verify board state
  const b = helpers._state.board;
  assert.strictEqual(b.projects.length, 1);
  assert.strictEqual(b.taskPlan.tasks.length, 2);

  const t10 = b.taskPlan.tasks.find(t => t.id === 'GH-10');
  assert.strictEqual(t10.status, 'dispatched'); // no deps
  assert.strictEqual(t10.projectId, result.project.id);

  const t11 = b.taskPlan.tasks.find(t => t.id === 'GH-11');
  assert.strictEqual(t11.status, 'pending'); // has deps
  assert.deepStrictEqual(t11.depends, ['GH-10']);
});

// ---------------------------------------------------------------------------
// Test 11: POST /api/projects — empty tasks → 400
// ---------------------------------------------------------------------------
test('11. POST /api/projects — empty tasks → 400', async () => {
  const projectsRoutes = require('./routes/projects');
  const board = createBoard([]);
  const helpers = createMockHelpers(board);
  const deps = { mgmt, tryAutoDispatch: null };

  const input = { title: 'Bad', repo: 'owner/repo', tasks: [] };
  const req = createMockReq('POST', '/api/projects', JSON.stringify(input));
  const res = createMockRes();

  projectsRoutes(req, res, helpers, deps);
  req.emit('data', JSON.stringify(input));
  req.emit('end');

  await tick();
  assert.strictEqual(res._statusCode, 400);
});

// ---------------------------------------------------------------------------
// Test 12: POST /api/projects — circular deps → 400
// ---------------------------------------------------------------------------
test('12. POST /api/projects — circular deps → 400', async () => {
  const projectsRoutes = require('./routes/projects');
  const board = createBoard([]);
  const helpers = createMockHelpers(board);
  const deps = { mgmt, tryAutoDispatch: null };

  const input = {
    title: 'Cyclic',
    repo: 'owner/repo',
    tasks: [
      { issue: 1, depends: [2] },
      { issue: 2, depends: [1] },
    ],
  };
  const req = createMockReq('POST', '/api/projects', JSON.stringify(input));
  const res = createMockRes();

  projectsRoutes(req, res, helpers, deps);
  req.emit('data', JSON.stringify(input));
  req.emit('end');

  await tick();
  assert.strictEqual(res._statusCode, 400);
  assert.ok(JSON.parse(res._body).error.includes('circular'));
});

// ---------------------------------------------------------------------------
// Test 13: POST /api/projects/:id/pause
// ---------------------------------------------------------------------------
test('13. POST /api/projects/:id/pause → status = paused', async () => {
  const projectsRoutes = require('./routes/projects');
  const project = { id: 'PROJ-1', title: 'P1', status: 'executing', taskIds: [] };
  const board = createBoard([], [project]);
  const helpers = createMockHelpers(board);
  const deps = { mgmt, tryAutoDispatch: null };

  const req = createMockReq('POST', '/api/projects/PROJ-1/pause');
  const res = createMockRes();

  projectsRoutes(req, res, helpers, deps);

  assert.strictEqual(res._statusCode, 200);
  assert.strictEqual(helpers._state.board.projects[0].status, 'paused');
});

// ---------------------------------------------------------------------------
// Test 14: POST /api/projects/:id/resume
// ---------------------------------------------------------------------------
test('14. POST /api/projects/:id/resume → status = executing', async () => {
  const projectsRoutes = require('./routes/projects');
  const project = { id: 'PROJ-1', title: 'P1', status: 'paused', taskIds: ['GH-1'] };
  const board = createBoard([
    { id: 'GH-1', status: 'dispatched', projectId: 'PROJ-1' },
  ], [project]);
  const helpers = createMockHelpers(board);
  let dispatched = [];
  const deps = { mgmt, tryAutoDispatch: (id) => dispatched.push(id) };

  const req = createMockReq('POST', '/api/projects/PROJ-1/resume');
  const res = createMockRes();

  projectsRoutes(req, res, helpers, deps);

  assert.strictEqual(res._statusCode, 200);
  assert.strictEqual(helpers._state.board.projects[0].status, 'executing');
  // tryAutoDispatch called via setImmediate — verify after tick
  await tick();
  assert.deepStrictEqual(dispatched, ['GH-1']);
});

// ---------------------------------------------------------------------------
// Test 15: POST /api/projects — existing GH task → updates depends
// ---------------------------------------------------------------------------
test('15. POST /api/projects — existing GH task gets updated with deps + projectId', async () => {
  const projectsRoutes = require('./routes/projects');
  const existingTask = { id: 'GH-5', title: 'Existing', status: 'pending', depends: [] };
  const board = createBoard([existingTask]);
  const helpers = createMockHelpers(board);
  const deps = { mgmt, tryAutoDispatch: null };

  const input = {
    title: 'Update Project',
    repo: 'owner/repo',
    tasks: [
      { issue: 5, depends: [6] },
      { issue: 6, depends: [], title: 'New' },
    ],
  };
  const req = createMockReq('POST', '/api/projects', JSON.stringify(input));
  const res = createMockRes();

  projectsRoutes(req, res, helpers, deps);
  req.emit('data', JSON.stringify(input));
  req.emit('end');

  await tick();
  assert.strictEqual(res._statusCode, 201);

  const b = helpers._state.board;
  const t5 = b.taskPlan.tasks.find(t => t.id === 'GH-5');
  assert.deepStrictEqual(t5.depends, ['GH-6']);
  assert.ok(t5.projectId);
  assert.strictEqual(t5.completionTrigger, 'pr_merged');
});

// ---------------------------------------------------------------------------
// Helpers for simulating HTTP requests
// ---------------------------------------------------------------------------

function createMockReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function createMockRes() {
  const res = {
    _statusCode: null,
    _body: null,
    _headers: {},
    writeHead(code, headers) { res._statusCode = code; Object.assign(res._headers, headers || {}); },
    end(body) { res._body = body || ''; },
    setHeader(k, v) { res._headers[k] = v; },
  };
  // Patch json helper — projectsRoutes uses bb.json which calls writeHead+end
  return res;
}

function tick(ms = 10) {
  return new Promise(resolve => setImmediate(() => setTimeout(resolve, ms)));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  console.log('\n🧪 test-projects.js — Project Orchestrator (#194)\n');
  // Give async tests time to settle
  await tick(50);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
