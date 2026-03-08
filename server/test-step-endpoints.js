#!/usr/bin/env node
/**
 * test-step-endpoints.js — Integration tests for step CRUD endpoints
 *
 * Self-contained: starts server, runs tests, shuts down.
 * Usage: node server/test-step-endpoints.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

let PORT = Number(process.env.TEST_PORT) || 0;  // 0 = OS assigns free port
const API_TOKEN = process.env.KARVI_API_TOKEN || null;
let serverProc = null;
let passed = 0;
let failed = 0;
let tmpDataDir = null;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274C ${label}: ${reason}`); process.exitCode = 1; }

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    const req = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method: 'POST', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    req.end(data);
  });
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    http.get({ hostname: 'localhost', port: PORT, path: urlPath, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); })
      .on('error', reject);
  });
}

function patch(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    const req = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method: 'PATCH', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    req.on('error', reject);
    req.end(data);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    // Create isolated temp DATA_DIR so parallel runs don't share board.json
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-step-'));
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), KARVI_STORAGE: 'json', DATA_DIR: tmpDataDir },
    });
    serverProc = proc;
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      // Parse actual bound port from "running at http://localhost:<port>"
      const m = buf.match(/running at http:\/\/localhost:(\d+)/);
      if (m) {
        PORT = Number(m[1]);
        resolve();
      }
    });
    proc.stderr.on('data', d => { buf += d.toString(); });
    setTimeout(() => reject(new Error('Server start timeout (port regex did not match). Output: ' + buf)), 8000);
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  if (tmpDataDir) {
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    tmpDataDir = null;
  }
}

// Ensure a test task exists
async function setupTestTask() {
  const board = await get('/api/tasks');
  const tasks = board.tasks || board.taskPlan?.tasks || [];
  let task = tasks.find(t => t.id === 'T-STEP-TEST');
  if (!task) {
    await post('/api/tasks', {
      tasks: [{ id: 'T-STEP-TEST', title: 'Step test task', description: 'For integration testing', assignee: 'engineer_lite', status: 'pending' }],
    });
  }
}

async function runTests() {
  console.log('\n=== Step Endpoint Integration Tests ===\n');

  await setupTestTask();

  // Test 1: POST /api/tasks/:id/steps — create steps
  {
    const res = await post('/api/tasks/T-STEP-TEST/steps', { run_id: 'run-integ-test' });
    if (res.ok && res.steps && res.steps.length === 4) {
      ok('POST /api/tasks/:id/steps creates 4 default steps');
    } else {
      fail('POST /api/tasks/:id/steps', JSON.stringify(res));
    }
  }

  // Test 2: GET /api/tasks/:id/steps — list steps
  {
    const res = await get('/api/tasks/T-STEP-TEST/steps');
    const steps = res.steps || [];
    if (res.ok && steps.length === 4) {
      const types = steps.map(s => s.type);
      if (JSON.stringify(types) === JSON.stringify(['plan', 'implement', 'test', 'review'])) {
        ok('GET /api/tasks/:id/steps returns correct pipeline');
      } else {
        fail('GET /api/tasks/:id/steps', 'wrong types: ' + JSON.stringify(types));
      }
    } else {
      fail('GET /api/tasks/:id/steps', `ok=${res.ok}, steps.length=${steps.length}`);
    }
  }

  // Test 3: PATCH /api/tasks/:id/steps/:stepId — transition queued \u2192 running
  {
    const res = await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:plan', { state: 'running', locked_by: 'worker-1' });
    if (res.status === 200 && res.body.ok && res.body.step.state === 'running') {
      ok('PATCH step queued \u2192 running succeeds');
    } else {
      fail('PATCH step queued \u2192 running', JSON.stringify(res));
    }
  }

  // Test 4: PATCH step running \u2192 succeeded
  {
    const res = await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:plan', { state: 'succeeded', output_ref: 'artifacts/run-integ-test/T-STEP-TEST_plan.output.json' });
    if (res.status === 200 && res.body.ok && res.body.step.state === 'succeeded') {
      ok('PATCH step running \u2192 succeeded emits step_completed');
    } else {
      fail('PATCH step running \u2192 succeeded', JSON.stringify(res));
    }
  }

  // Test 5: PATCH invalid transition returns 400
  {
    const res = await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:implement', { state: 'succeeded' });
    if (res.status === 400 && res.body.error && res.body.error.includes('Invalid step transition')) {
      ok('PATCH invalid transition (queued \u2192 succeeded) returns 400');
    } else {
      fail('PATCH invalid transition', JSON.stringify(res));
    }
  }

  // Test 6: Verify signals were emitted
  {
    const signals = await get('/api/signals');
    const stepSignals = (Array.isArray(signals) ? signals : [])
      .filter(s => s.type === 'step_completed' || s.type === 'steps_created');
    if (stepSignals.length >= 2) {
      ok('Step signals emitted to board.signals');
    } else {
      fail('Step signals', `expected >= 2 step signals, got ${stepSignals.length}: ${JSON.stringify(signals).slice(0, 200)}`);
    }
  }

  // Test 7: Backward compatible \u2014 task without steps still works
  {
    const board = await get('/api/tasks');
    const tasks = board.tasks || board.taskPlan?.tasks || [];
    const testTask = tasks.find(t => t.id === 'T-STEP-TEST');
    const otherTasks = tasks.filter(t => t.id !== 'T-STEP-TEST');
    if (testTask && Array.isArray(testTask.steps) && otherTasks.every(t => !t.steps)) {
      ok('Backward compatible \u2014 only step-enabled task has steps array');
    } else {
      fail('Backward compatible', `testTask.steps=${JSON.stringify(testTask?.steps)}, others with steps=${otherTasks.filter(t => t.steps).length}`);
    }
  }
  // ─── Step Reset Tests (#285) ───────────────────────────────

  // Setup: get review step into dead state by exhausting retries
  // transitionStep auto-increments attempt on each failed; at max_attempts(3) → dead
  {
    // Attempt 1: queued → running → failed (attempt becomes 1, auto-retries to queued)
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'running' });
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'failed', error: 'attempt 1' });
    // Attempt 2: queued → running → failed (attempt becomes 2, auto-retries to queued)
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'running' });
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'failed', error: 'attempt 2' });
    // Attempt 3: queued → running → failed (attempt becomes 3 >= max_attempts → dead)
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'running' });
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'failed', error: 'attempt 3' });
  }

  // Test 8: Reset dead step → queued succeeds
  {
    const res = await post('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review/reset', {});
    if (res.ok && res.new_state === 'queued' && res.from === 'dead') {
      ok('POST reset dead → queued succeeds');
    } else {
      fail('POST reset dead → queued', JSON.stringify(res));
    }
  }

  // Test 9: Verify reset step is now queued with cleared fields
  {
    const res = await get('/api/tasks/T-STEP-TEST/steps');
    const step = (res.steps || []).find(s => s.step_id === 'T-STEP-TEST:review');
    if (step && step.state === 'queued' && step.attempt === 0 && step.error === null) {
      ok('Reset step has state=queued, attempt=0, error=null');
    } else {
      fail('Reset step fields', JSON.stringify(step));
    }
  }

  // Test 10: Reset succeeded step → rejected (409)
  {
    const res = await post('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:plan/reset', {});
    if (res.error && res.error.includes('can only reset')) {
      ok('POST reset succeeded step returns 409');
    } else {
      fail('POST reset succeeded step', JSON.stringify(res));
    }
  }

  // Test 11: Reset cancelled step → queued succeeds
  {
    // Cancel review, then reset it
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'running' });
    await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review', { state: 'cancelled', error: 'test cancel' });
    const res = await post('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:review/reset', {});
    if (res.ok && res.new_state === 'queued' && res.from === 'cancelled') {
      ok('POST reset cancelled → queued succeeds');
    } else {
      fail('POST reset cancelled → queued', JSON.stringify(res));
    }
  }

  // Test 12: Reset nonexistent step → 404
  {
    const res = await post('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:nonexistent/reset', {});
    if (res.error && res.error.includes('not found')) {
      ok('POST reset nonexistent step returns 404');
    } else {
      fail('POST reset nonexistent step', JSON.stringify(res));
    }
  }

  // Test 13: Reset step on nonexistent task → 404
  {
    const res = await post('/api/tasks/FAKE-TASK/steps/FAKE:plan/reset', {});
    if (res.error && res.error.includes('not found')) {
      ok('POST reset on nonexistent task returns 404');
    } else {
      fail('POST reset nonexistent task', JSON.stringify(res));
    }
  }

  // Test 14: Reset signal emitted
  {
    const signals = await get('/api/signals');
    const resetSignals = (Array.isArray(signals) ? signals : [])
      .filter(s => s.type === 'step_reset');
    if (resetSignals.length >= 1) {
      ok('step_reset signal emitted');
    } else {
      fail('step_reset signal', `expected >= 1, got ${resetSignals.length}`);
    }
  }
}

(async () => {
  try {
    console.log('Starting test server on port', PORT);
    await startServer();
    console.log('Server ready.\n');
    await runTests();
  } catch (err) {
    console.error('Test error:', err);
    process.exitCode = 1;
  } finally {
    stopServer();
    console.log(`\n${'\u2500'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
  }
})();
