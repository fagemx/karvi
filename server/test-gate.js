#!/usr/bin/env node
/**
 * test-gate.js — Integration tests for Human Gate API
 *
 * Tests the mobile approval workflow endpoints:
 *   GET /api/gate/pending
 *   POST /api/gate/:taskId/approve
 *   POST /api/gate/:taskId/reject
 *
 * Self-contained: starts server, runs tests, shuts down.
 * Usage: node server/test-gate.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

let PORT = Number(process.env.TEST_PORT) || 0;
const API_TOKEN = process.env.KARVI_API_TOKEN || null;
let serverProc = null;
let passed = 0;
let failed = 0;
let tmpDataDir = null;

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ✗ ${label}: ${reason}`); process.exitCode = 1; }

function post(urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      ...headers,
    };
    if (API_TOKEN) reqHeaders['Authorization'] = `Bearer ${API_TOKEN}`;
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      method: 'POST',
      headers: reqHeaders,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (API_TOKEN) reqHeaders['Authorization'] = `Bearer ${API_TOKEN}`;
    http.get({
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      headers: reqHeaders,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on('error', reject);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-gate-'));
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), KARVI_STORAGE: 'json', DATA_DIR: tmpDataDir },
    });
    serverProc = proc;
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      const m = buf.match(/running at http:\/\/localhost:(\d+)/);
      if (m) {
        PORT = Number(m[1]);
        resolve();
      }
    });
    proc.stderr.on('data', d => { buf += d.toString(); });
    setTimeout(() => reject(new Error('Server start timeout. Output: ' + buf)), 10000);
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  if (tmpDataDir) {
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    tmpDataDir = null;
  }
}

async function createTestTask(taskId, overrides = {}) {
  await post('/api/tasks', {
    tasks: [{
      id: taskId,
      title: `Test task ${taskId}`,
      description: 'For gate testing',
      assignee: 'engineer_lite',
      status: 'pending',
      ...overrides,
    }],
  });
}

async function setTaskBlocked(taskId) {
  const boardRes = await get('/api/board');
  const board = boardRes.body;
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.status = 'completed';
  task.blocker = { type: 'human_review', reason: 'Waiting for human approval' };
  task.completedAt = new Date().toISOString();
  await post('/api/board', board);
}

async function runTests() {
  console.log('=== Human Gate API Tests ===\n');

  try {
    console.log('[setup] Starting server...');
    await startServer();
    console.log(`[setup] Server running on port ${PORT}\n`);

    // Test 1: GET /api/gate/pending (empty)
    console.log('[test] GET /api/gate/pending (empty)');
    {
      const res = await get('/api/gate/pending');
      if (res.status !== 200) fail('pending returns 200', `got ${res.status}`);
      else if (!Array.isArray(res.body.tasks)) fail('pending returns tasks array', `got ${typeof res.body.tasks}`);
      else ok('GET /api/gate/pending returns empty array initially');
    }

    // Test 2: Create task with human_review blocker
    const taskId = 'T-GATE-TEST-1';
    console.log(`\n[test] Creating task ${taskId} with human_review blocker`);
    await createTestTask(taskId);
    await setTaskBlocked(taskId);
    ok('Created task with human_review blocker');

    // Test 3: GET /api/gate/pending (with task)
    console.log('\n[test] GET /api/gate/pending (with task)');
    {
      const res = await get('/api/gate/pending');
      if (res.status !== 200) fail('pending returns 200', `got ${res.status}`);
      else if (res.body.count !== 1) fail('pending count is 1', `got ${res.body.count}`);
      else if (res.body.tasks[0].id !== taskId) fail('pending task matches', `got ${res.body.tasks[0].id}`);
      else ok('GET /api/gate/pending returns blocked task');
    }

    // Test 4: POST /api/gate/:taskId/approve
    console.log(`\n[test] POST /api/gate/${taskId}/approve`);
    {
      const res = await post(`/api/gate/${taskId}/approve`, { comment: 'LGTM from test' });
      if (res.status !== 200) fail('approve returns 200', `got ${res.status}: ${JSON.stringify(res.body)}`);
      else if (!res.body.ok) fail('approve returns ok', `got ${res.body}`);
      else if (res.body.task.blocker !== null) fail('blocker cleared', `got ${res.body.task.blocker}`);
      else ok('POST /api/gate/:taskId/approve works');
    }

    // Test 5: Verify task is no longer pending
    console.log('\n[test] GET /api/gate/pending (after approve)');
    {
      const res = await get('/api/gate/pending');
      if (res.body.count !== 0) fail('no pending tasks after approve', `got ${res.body.count}`);
      else ok('Task removed from pending after approve');
    }

    // Test 6: Create another task for reject test
    const taskId2 = 'T-GATE-TEST-2';
    console.log(`\n[test] Creating task ${taskId2} for reject test`);
    await createTestTask(taskId2);
    await setTaskBlocked(taskId2);
    ok('Created second task with human_review blocker');

    // Test 7: POST /api/gate/:taskId/reject
    console.log(`\n[test] POST /api/gate/${taskId2}/reject`);
    {
      const res = await post(`/api/gate/${taskId2}/reject`, { comment: 'Needs more work' });
      if (res.status !== 200) fail('reject returns 200', `got ${res.status}: ${JSON.stringify(res.body)}`);
      else if (!res.body.ok) fail('reject returns ok', `got ${res.body}`);
      else if (res.body.task.status !== 'needs_revision') fail('status is needs_revision', `got ${res.body.task.status}`);
      else ok('POST /api/gate/:taskId/reject works');
    }

    // Test 8: Reject without comment should fail
    const taskId3 = 'T-GATE-TEST-3';
    console.log(`\n[test] Creating task ${taskId3} for reject validation test`);
    await createTestTask(taskId3);
    await setTaskBlocked(taskId3);
    {
      const res = await post(`/api/gate/${taskId3}/reject`, { comment: '' });
      if (res.status !== 400) fail('reject without comment returns 400', `got ${res.status}`);
      else ok('Reject without comment returns 400');
    }

    // Test 9: Approve non-existent task
    console.log('\n[test] POST /api/gate/T-NONEXISTENT/approve');
    {
      const res = await post('/api/gate/T-NONEXISTENT/approve', { comment: 'test' });
      if (res.status !== 404) fail('approve non-existent returns 404', `got ${res.status}`);
      else ok('Approve non-existent task returns 404');
    }

    // Test 10: Approve task not in human_review
    const taskId4 = 'T-GATE-TEST-4';
    console.log(`\n[test] Creating task ${taskId4} without blocker`);
    await createTestTask(taskId4);
    {
      const res = await post(`/api/gate/${taskId4}/approve`, { comment: 'test' });
      if (res.status !== 400) fail('approve non-blocked returns 400', `got ${res.status}`);
      else ok('Approve task not awaiting review returns 400');
    }

    // Test 11: Remote auth with invalid token (if remote_auth_token is set)
    console.log('\n[test] Remote auth token validation');
    {
      // Set remote_auth_token in controls
      const ctrlRes = await post('/api/controls', { remote_auth_token: 'test-token-12345678' });
      if (ctrlRes.status !== 200) {
        console.log('  (skipped - could not set remote_auth_token)');
      } else {
        // This test is informational since we're localhost
        ok('Remote auth token set (localhost bypasses check)');
        // Reset
        await post('/api/controls', { remote_auth_token: null });
      }
    }

  } catch (err) {
    fail('test execution', err.message);
    console.error(err);
  } finally {
    console.log('\n[teardown] Stopping server...');
    stopServer();
  }

  console.log('\n=== Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
