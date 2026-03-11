#!/usr/bin/env node
/**
 * test-edda-api.js — 測試 Edda integration API
 *
 * Tests:
 * 1. POST /api/edda/propose-controls — basic proposal
 * 2. Risk classification (low/medium/high)
 * 3. Auto-apply for low-risk patches
 * 4. GET /api/edda/status
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT) || 13461;
const API_TOKEN = process.env.KARVI_API_TOKEN || null;
const GLOBAL_TIMEOUT_MS = 60_000;

setTimeout(() => {
  console.error(`\n❌ Global timeout (${GLOBAL_TIMEOUT_MS / 1000}s) — forcing exit`);
  if (serverProc) { serverProc.kill(); serverProc = null; }
  process.exit(2);
}, GLOBAL_TIMEOUT_MS).unref();

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-edda-test-'));
let serverProc = null;

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    const req = http.request({
      hostname: 'localhost', port: PORT, path: urlPath, method: 'POST', headers
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

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    http.get({ hostname: 'localhost', port: PORT, path: urlPath, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on('error', reject);
  });
}

function ok(label) { console.log(`  ✅ ${label}`); }
function fail(label, reason) { console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

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
      if (!started) { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); }
    });
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
}

function cleanState() {
  for (const f of ['board.json', 'board.json.bak', 'task-log.jsonl']) {
    try { fs.unlinkSync(path.join(TEST_DATA_DIR, f)); }
    catch (err) { }
  }
}

async function main() {
  cleanState();
  console.log('Starting server...');
  serverProc = await startServer();
  console.log(`Server started on port ${PORT}`);
  process.on('exit', stopServer);

  console.log('\n=== Edda API Tests ===\n');

  // Test 1: Low-risk patch (small threshold adjustment)
  console.log('Test 1: Propose low-risk patch (quality_threshold 70→75)...');
  const r1 = await post('/api/edda/propose-controls', {
    patch: { quality_threshold: 75 },
    reasoning: 'Success rate improved, increase threshold',
    by: 'edda-test',
  });
  if (r1.status === 201 && r1.body.ok && r1.body.insight.risk === 'low') {
    ok('Low-risk patch proposed');
    if (r1.body.autoApplied) ok('Auto-applied (auto_apply_insights enabled)');
    else fail('Auto-apply', 'expected auto-apply for low risk');
  } else {
    fail('Low-risk patch', JSON.stringify(r1.body));
  }

  // Test 2: High-risk patch (disable auto_dispatch)
  console.log('\nTest 2: Propose high-risk patch (auto_dispatch=false)...');
  const r2 = await post('/api/edda/propose-controls', {
    patch: { auto_dispatch: false },
    reasoning: 'Critical failure detected, pause dispatch',
    by: 'edda-test',
  });
  if (r2.status === 201 && r2.body.ok && r2.body.insight.risk === 'high') {
    ok('High-risk patch proposed');
    if (!r2.body.autoApplied) ok('Not auto-applied (requires manual approval)');
    else fail('High-risk auto-apply', 'should NOT auto-apply high risk');
  } else {
    fail('High-risk patch', JSON.stringify(r2.body));
  }

  // Test 3: Medium-risk patch (medium threshold change ~36%)
  console.log('\nTest 3: Propose medium-risk patch (quality_threshold 70→45)...');
  const r3 = await post('/api/edda/propose-controls', {
    patch: { quality_threshold: 45 },
    reasoning: 'Tasks struggling, lower threshold moderately',
    by: 'edda-test',
  });
  if (r3.status === 201 && r3.body.ok && r3.body.insight.risk === 'medium') {
    ok('Medium-risk patch proposed');
    if (!r3.body.autoApplied) ok('Not auto-applied (requires manual approval)');
    else fail('Medium-risk auto-apply', 'should NOT auto-apply medium risk');
  } else {
    fail('Medium-risk patch', JSON.stringify(r3.body));
  }

  // Test 4: Invalid patch (unknown key)
  console.log('\nTest 4: Reject invalid patch (unknown key)...');
  const r4 = await post('/api/edda/propose-controls', {
    patch: { unknown_key: 123 },
    by: 'edda-test',
  });
  if (r4.status === 400 && r4.body.error.includes('unknown control keys')) {
    ok('Invalid patch rejected');
  } else {
    fail('Invalid patch rejection', JSON.stringify(r4.body));
  }

  // Test 5: Force risk level
  console.log('\nTest 5: Force risk level override...');
  const r5 = await post('/api/edda/propose-controls', {
    patch: { model_map: { opencode: { default: 'test/model' } } },
    reasoning: 'Model switch',
    by: 'edda-test',
    risk: 'high',
  });
  if (r5.status === 201 && r5.body.insight.risk === 'high') {
    ok('Risk level forced to high');
  } else {
    fail('Force risk level', JSON.stringify(r5.body));
  }

  // Test 6: GET /api/edda/status
  console.log('\nTest 6: GET /api/edda/status...');
  const r6 = await get('/api/edda/status');
  if (r6.status === 200 && typeof r6.body.controls === 'object') {
    ok('Status endpoint works');
    console.log(`    pendingProposals: ${r6.body.pendingProposals}`);
    console.log(`    autoApplyEnabled: ${r6.body.autoApplyEnabled}`);
  } else {
    fail('Status endpoint', JSON.stringify(r6.body));
  }

  // Test 7: Verify pending proposals count
  console.log('\nTest 7: Verify pending proposals count...');
  const r7 = await get('/api/edda/status');
  // We have 2 pending proposals (high risk from test 2, medium risk from test 3)
  if (r7.body.pendingProposals >= 2) {
    ok(`At least 2 pending proposals (found ${r7.body.pendingProposals})`);
  } else {
    fail('Pending proposals count', `expected >= 2, got ${r7.body.pendingProposals}`);
  }

  console.log('\n=== Tests Complete ===\n');
  stopServer();

  try { fs.rmSync(TEST_DATA_DIR, { recursive: true }); } catch (e) { }

  if (!process.exitCode) {
    console.log('All tests passed!');
  } else {
    console.log('Some tests failed.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  stopServer();
  process.exit(1);
});
