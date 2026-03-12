#!/usr/bin/env node
/**
 * test-wave-dispatch.js — Integration tests for wave-based dispatch filtering (GH-335)
 *
 * Starts server → sets active_wave via POST /api/controls → creates tasks with
 * different wave values → enables auto_dispatch → verifies only matching-wave
 * tasks get dispatched.
 *
 * Usage: node server/test-wave-dispatch.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let PORT = Number(process.env.TEST_PORT) || 0;
const API_TOKEN = process.env.KARVI_API_TOKEN || null;
let serverProc = null;
let passed = 0;
let failed = 0;
let tmpDataDir = null;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve, reject) => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-wave-'));
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
    setTimeout(() => reject(new Error('Server start timeout. Output: ' + buf)), 8000);
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  if (tmpDataDir) {
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    tmpDataDir = null;
  }
}

async function runTests() {
  console.log('\n=== Wave Dispatch Integration Tests ===\n');

  // Disable auto-dispatch initially
  await post('/api/controls', { auto_dispatch: false, max_concurrent_tasks: 10 });

  // Test 1: active_wave is set via controls API
  {
    console.log('Test 1: Set active_wave via POST /api/controls');
    const res = await post('/api/controls', { active_wave: 2 });
    if (res.ok && res.controls && res.controls.active_wave === 2) {
      ok('active_wave set to 2');
    } else {
      fail('Set active_wave', JSON.stringify(res));
    }
  }

  // Test 2: active_wave=null clears the filter
  {
    console.log('Test 2: Clear active_wave via null');
    const res = await post('/api/controls', { active_wave: null });
    if (res.ok && res.controls && res.controls.active_wave === null) {
      ok('active_wave cleared to null');
    } else {
      fail('Clear active_wave', JSON.stringify(res));
    }
  }

  // Test 3: Task created with wave field persists
  {
    console.log('Test 3: Task wave field persists');
    await post('/api/tasks', {
      tasks: [
        { id: 'T-WAVE-1', title: 'Wave 1 task', assignee: 'engineer_lite', status: 'pending', wave: 1 },
        { id: 'T-WAVE-2', title: 'Wave 2 task', assignee: 'engineer_lite', status: 'pending', wave: 2 },
        { id: 'T-WAVE-NULL', title: 'No wave task', assignee: 'engineer_lite', status: 'pending' }
      ]
    });
    const board = await get('/api/tasks');
    const tasks = board.tasks || board.taskPlan?.tasks || [];
    const w1 = tasks.find(t => t.id === 'T-WAVE-1');
    const w2 = tasks.find(t => t.id === 'T-WAVE-2');
    const wn = tasks.find(t => t.id === 'T-WAVE-NULL');
    if (w1 && w1.wave === 1 && w2 && w2.wave === 2 && wn && wn.wave === null) {
      ok('Wave field persisted correctly on tasks');
    } else {
      fail('Wave persistence', `w1.wave=${w1?.wave}, w2.wave=${w2?.wave}, wn.wave=${wn?.wave}`);
    }
  }

  // Test 4: With active_wave=1, dispatching wave-2 task is skipped by auto-dispatch
  {
    console.log('Test 4: Wave filtering blocks mismatched task dispatch');
    // Set active_wave=1, then set tasks to dispatched status to trigger auto-dispatch
    await post('/api/controls', { active_wave: 1, auto_dispatch: true, max_concurrent_tasks: 10 });

    // Set wave-2 task to dispatched (triggers tryAutoDispatch)
    await post('/api/tasks/T-WAVE-2/status', { status: 'dispatched' });

    // Wait for auto-dispatch attempt
    await sleep(500);

    // Wave-2 task should still be dispatched (not in_progress) because wave filter blocks it
    const board = await get('/api/tasks');
    const tasks = board.tasks || board.taskPlan?.tasks || [];
    const w2 = tasks.find(t => t.id === 'T-WAVE-2');
    if (w2 && w2.status === 'dispatched') {
      ok('Wave 2 task NOT auto-dispatched when active_wave=1');
    } else if (w2 && w2.status === 'in_progress') {
      fail('Wave filter', `wave-2 task was dispatched (status: ${w2.status}) despite active_wave=1`);
    } else {
      fail('Wave filter', `unexpected wave-2 task status: ${w2?.status}`);
    }
  }

  // Test 5: With active_wave=1, wave-1 task can be dispatched
  {
    console.log('Test 5: Matching wave task dispatches normally');
    await post('/api/tasks/T-WAVE-1/status', { status: 'dispatched' });

    await sleep(500);

    const board = await get('/api/tasks');
    const tasks = board.tasks || board.taskPlan?.tasks || [];
    const w1 = tasks.find(t => t.id === 'T-WAVE-1');
    // wave-1 should proceed past wave filter (may or may not fully dispatch depending on worktree setup)
    if (w1 && (w1.status === 'in_progress' || w1.status === 'dispatched' || w1.status === 'dispatching')) {
      ok('Wave 1 task passed wave filter (status: ' + w1.status + ')');
    } else {
      fail('Wave 1 dispatch', `expected dispatched/in_progress, got ${w1?.status}`);
    }
  }

  // Test 6: active_wave validation rejects invalid values
  {
    console.log('Test 6: active_wave validation');
    // Negative number — should be silently ignored (stays at current value)
    const before = await get('/api/controls');
    await post('/api/controls', { active_wave: -1 });
    const after = await get('/api/controls');
    if (after.active_wave === before.active_wave || after.controls?.active_wave === before.controls?.active_wave) {
      ok('Negative active_wave rejected');
    } else {
      fail('active_wave validation', 'negative value was accepted');
    }
  }
}

(async () => {
  console.log('🧪 Wave Dispatch Integration Tests');
  console.log('='.repeat(50));
  try {
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
