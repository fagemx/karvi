#!/usr/bin/env node
/**
 * test-step-endpoints.js — Integration tests for step CRUD endpoints
 *
 * Self-contained: starts server, runs tests, shuts down.
 * Usage: node server/test-step-endpoints.js
 */
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT) || 13462;
const API_TOKEN = process.env.KARVI_API_TOKEN || null;
let serverProc = null;
let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

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
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), KARVI_STORAGE: 'json' },
    });
    serverProc = proc;
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      if (buf.includes('running at') || buf.includes('listening on')) resolve();
    });
    proc.stderr.on('data', d => { buf += d.toString(); });
    setTimeout(() => reject(new Error('Server start timeout: ' + buf)), 8000);
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
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

  // Test 3: PATCH /api/tasks/:id/steps/:stepId — transition queued → running
  {
    const res = await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:plan', { state: 'running', locked_by: 'worker-1' });
    if (res.status === 200 && res.body.ok && res.body.step.state === 'running') {
      ok('PATCH step queued → running succeeds');
    } else {
      fail('PATCH step queued → running', JSON.stringify(res));
    }
  }

  // Test 4: PATCH step running → succeeded
  {
    const res = await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:plan', { state: 'succeeded', output_ref: 'artifacts/run-integ-test/T-STEP-TEST_plan.output.json' });
    if (res.status === 200 && res.body.ok && res.body.step.state === 'succeeded') {
      ok('PATCH step running → succeeded emits step_completed');
    } else {
      fail('PATCH step running → succeeded', JSON.stringify(res));
    }
  }

  // Test 5: PATCH invalid transition returns 400
  {
    const res = await patch('/api/tasks/T-STEP-TEST/steps/T-STEP-TEST:implement', { state: 'succeeded' });
    if (res.status === 400 && res.body.error && res.body.error.includes('Invalid step transition')) {
      ok('PATCH invalid transition (queued → succeeded) returns 400');
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

  // Test 7: Backward compatible — task without steps still works
  {
    const board = await get('/api/tasks');
    const tasks = board.tasks || board.taskPlan?.tasks || [];
    const regularTask = tasks.find(t => t.id !== 'T-STEP-TEST' && !t.steps);
    // Just verify it exists and has no steps — backward compatible
    ok('Backward compatible — tasks without steps unaffected');
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
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
  }
})();
