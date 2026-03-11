#!/usr/bin/env node
/**
 * test-rollback.js — 驗證 POST /api/tasks/:id/rollback endpoint
 *
 * 自包含測試：自動啟動 server、建立任務、測試 rollback、結束後關閉 server。
 * 用法：node server/test-rollback.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT) || 13462;
const API_TOKEN = process.env.KARVI_API_TOKEN || null;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-rollback-'));
let serverProc = null;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    const req = http.request({
      hostname: 'localhost', port: PORT, path: urlPath, method, headers,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function post(urlPath, body) { return request('POST', urlPath, body); }
function get(urlPath) { return request('GET', urlPath); }

let passed = 0;
let failed = 0;
function ok(label) { console.log(`  OK: ${label}`); passed++; }
function fail(label, reason) { console.log(`  FAIL: ${label}: ${reason}`); failed++; process.exitCode = 1; }

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), DATA_DIR: TEST_DATA_DIR },
    });
    let started = false;
    proc.stdout.on('data', (data) => {
      if (!started && data.toString().includes('running at')) {
        started = true;
        resolve(proc);
      }
    });
    proc.stderr.on('data', (data) => {
      if (!started) process.stderr.write('[server] ' + data.toString());
    });
    const timer = setTimeout(() => {
      if (!started) { proc.kill(); reject(new Error('Server failed to start within 10s')); }
    }, 10000);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      if (!started) { clearTimeout(timer); reject(new Error(`Fatal: Server exited with code ${code} before ready`)); }
    });
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
}

async function main() {
  console.log('Starting server...');
  serverProc = await startServer();
  console.log(`Server started on port ${PORT}`);
  process.on('exit', stopServer);

  // Create all test tasks up-front in one project
  await post('/api/project', {
    title: 'Rollback Test',
    goal: 'Test rollback endpoint',
    tasks: [
      { id: 'T-RB1', title: 'completed task', assignee: 'engineer_lite', description: 'test' },
      { id: 'T-RB2', title: 'approved task', assignee: 'engineer_lite', description: 'test' },
      { id: 'T-RB3', title: 'in_progress task', assignee: 'engineer_lite', description: 'test' },
      { id: 'T-RB4', title: 'needs_revision task', assignee: 'engineer_lite', description: 'test' },
      { id: 'T-RB5', title: 'pending task', assignee: 'engineer_lite', description: 'test' },
      { id: 'T-RB7', title: 'history task', assignee: 'engineer_lite', description: 'test' },
      { id: 'T-RB9', title: 'blocked task', assignee: 'engineer_lite', description: 'test' },
    ],
  });

  // Walk tasks to their target states
  // T-RB1: pending → dispatched → in_progress → completed
  await post('/api/tasks/T-RB1/status', { status: 'dispatched' });
  await post('/api/tasks/T-RB1/status', { status: 'in_progress' });
  await post('/api/tasks/T-RB1/status', { status: 'completed' });

  // T-RB2: pending → dispatched → in_progress → completed → reviewing → approved
  await post('/api/tasks/T-RB2/status', { status: 'dispatched' });
  await post('/api/tasks/T-RB2/status', { status: 'in_progress' });
  await post('/api/tasks/T-RB2/status', { status: 'completed' });
  await post('/api/tasks/T-RB2/status', { status: 'reviewing' });
  await post('/api/tasks/T-RB2/status', { status: 'approved' });

  // T-RB3: pending → dispatched → in_progress
  await post('/api/tasks/T-RB3/status', { status: 'dispatched' });
  await post('/api/tasks/T-RB3/status', { status: 'in_progress' });

  // T-RB4: pending → dispatched → in_progress → completed → reviewing → needs_revision
  await post('/api/tasks/T-RB4/status', { status: 'dispatched' });
  await post('/api/tasks/T-RB4/status', { status: 'in_progress' });
  await post('/api/tasks/T-RB4/status', { status: 'completed' });
  await post('/api/tasks/T-RB4/status', { status: 'reviewing' });
  await post('/api/tasks/T-RB4/status', { status: 'needs_revision' });

  // T-RB5: stays pending (default)

  // T-RB7: pending → dispatched → in_progress → completed
  await post('/api/tasks/T-RB7/status', { status: 'dispatched' });
  await post('/api/tasks/T-RB7/status', { status: 'in_progress' });
  await post('/api/tasks/T-RB7/status', { status: 'completed' });

  // T-RB9: pending → dispatched → in_progress → blocked
  await post('/api/tasks/T-RB9/status', { status: 'dispatched' });
  await post('/api/tasks/T-RB9/status', { status: 'in_progress' });
  await post('/api/tasks/T-RB9/status', { status: 'blocked', reason: 'test blocker' });

  console.log('\n=== Rollback Endpoint Tests ===\n');

  // --- Test 1: Rollback from completed → pending ---
  console.log('Test 1: Rollback from completed → pending');
  const r1 = await post('/api/tasks/T-RB1/rollback', { reason: 'testing rollback' });
  if (r1.status === 200 && r1.body.ok) ok('rollback returned 200');
  else fail('rollback returned 200', `got ${r1.status}: ${JSON.stringify(r1.body)}`);
  if (r1.body.rollback?.from === 'completed') ok('from=completed');
  else fail('from=completed', JSON.stringify(r1.body.rollback));
  if (r1.body.rollback?.to === 'pending') ok('to=pending');
  else fail('to=pending', JSON.stringify(r1.body.rollback));
  if (r1.body.task?.status === 'pending') ok('task.status=pending');
  else fail('task.status=pending', r1.body.task?.status);

  // --- Test 2: Rollback from approved → pending ---
  console.log('\nTest 2: Rollback from approved → pending');
  const r2 = await post('/api/tasks/T-RB2/rollback', {});
  if (r2.status === 200 && r2.body.task?.status === 'pending') ok('approved → pending');
  else fail('approved → pending', `got ${r2.status}: ${JSON.stringify(r2.body)}`);

  // --- Test 3: Rollback from in_progress → pending ---
  console.log('\nTest 3: Rollback from in_progress → pending');
  const r3 = await post('/api/tasks/T-RB3/rollback', {});
  if (r3.status === 200 && r3.body.task?.status === 'pending') ok('in_progress → pending');
  else fail('in_progress → pending', `got ${r3.status}: ${JSON.stringify(r3.body)}`);

  // --- Test 4: Rollback from needs_revision → pending ---
  console.log('\nTest 4: Rollback from needs_revision → pending');
  const r4 = await post('/api/tasks/T-RB4/rollback', {});
  if (r4.status === 200 && r4.body.task?.status === 'pending') ok('needs_revision → pending');
  else fail('needs_revision → pending', `got ${r4.status}: ${JSON.stringify(r4.body)}`);

  // --- Test 5: Rollback from pending → 400 error ---
  // First verify T-RB5 is still pending (auto-dispatch may have changed it)
  console.log('\nTest 5: Rollback from pending → 400');
  const board5 = await get('/api/board');
  const task5check = (board5.body.taskPlan?.tasks || []).find(t => t.id === 'T-RB5');
  if (task5check?.status !== 'pending') {
    // Task was auto-dispatched — roll it back first, then test pending guard
    await post('/api/tasks/T-RB5/rollback', {});
  }
  const r5 = await post('/api/tasks/T-RB5/rollback', {});
  if (r5.status === 400) ok('pending rollback returns 400');
  else fail('pending rollback returns 400', `got ${r5.status}: from=${r5.body.rollback?.from}`);
  if (r5.body.error && r5.body.error.includes('pending')) ok('error message mentions pending');
  else fail('error message mentions pending', r5.body.error);

  // --- Test 6: Rollback non-existent task → 404 ---
  console.log('\nTest 6: Rollback non-existent task → 404');
  const r6 = await post('/api/tasks/T-NONEXIST/rollback', {});
  if (r6.status === 404) ok('non-existent task returns 404');
  else fail('non-existent task returns 404', `got ${r6.status}`);

  // --- Test 7: Verify history entry ---
  console.log('\nTest 7: Verify history and state reset');
  const r7 = await post('/api/tasks/T-RB7/rollback', { reason: 'history check' });
  if (r7.status !== 200) { fail('rollback T-RB7', `got ${r7.status}`); }
  else {
    const task7 = r7.body.task;
    const rollbackEntry = (task7?.history || []).find(h => h.action === 'rollback');
    if (rollbackEntry && rollbackEntry.from === 'completed' && rollbackEntry.status === 'pending') {
      ok('history has rollback entry');
    } else {
      fail('history has rollback entry', JSON.stringify(task7?.history?.slice(-2)));
    }
    if (rollbackEntry?.reason === 'history check') ok('history reason preserved');
    else fail('history reason preserved', rollbackEntry?.reason);

    // Verify state reset
    if (task7?.completedAt === null) ok('completedAt cleared');
    else fail('completedAt cleared', task7?.completedAt);
    if (task7?.startedAt === null) ok('startedAt cleared');
    else fail('startedAt cleared', task7?.startedAt);
    if (Array.isArray(task7?.steps) && task7.steps.length === 0) ok('steps cleared');
    else fail('steps cleared', JSON.stringify(task7?.steps));
    if (task7?.reviewAttempts === 0) ok('reviewAttempts reset');
    else fail('reviewAttempts reset', task7?.reviewAttempts);
  }

  // --- Test 8: Rollback from blocked → pending ---
  console.log('\nTest 8: Rollback from blocked → pending');
  const r9 = await post('/api/tasks/T-RB9/rollback', {});
  if (r9.status === 200 && r9.body.task?.status === 'pending') ok('blocked → pending');
  else fail('blocked → pending', `got ${r9.status}: ${JSON.stringify(r9.body)}`);
  if (r9.body.task?.blocker === null) ok('blocker cleared');
  else fail('blocker cleared', JSON.stringify(r9.body.task?.blocker));

  // --- Test 9: Double rollback — after rollback, task is pending, second rollback returns 400 ---
  console.log('\nTest 9: Double rollback returns 400');
  const r9b = await post('/api/tasks/T-RB1/rollback', {});
  if (r9b.status === 400) ok('double rollback returns 400');
  else fail('double rollback returns 400', `got ${r9b.status}`);

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  stopServer();
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch(err => {
  console.error('Test fatal error:', err);
  stopServer();
  process.exitCode = 1;
});
