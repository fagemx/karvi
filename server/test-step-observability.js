#!/usr/bin/env node
/**
 * test-step-observability.js — Integration tests for runtime observability (issue #290)
 * 
 * Tests Phase 1-4 fixes from PR #293:
 * 1. Worktree auto-rebuild on dispatch
 * 2. ENOENT classified as non-retryable (CONFIG)
 * 3. Initial progress written before spawn
 * 4. Activity-aware lock renewal
 * 5. Dead letter diagnostics
 * 
 * Usage: node server/test-step-observability.js
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

function startServer() {
  return new Promise((resolve, reject) => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-observability-'));
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testWorktreeAutoRebuild() {
  console.log('\n📋 Test 1: Worktree Auto-Rebuild on Redispatch');
  try {
    // Create participant first
    const board0 = await get('/api/tasks');
    const participants = board0.participants || [];
    if (!participants.find(p => p.id === 'engineer_lite')) {
      participants.push({
        id: 'engineer_lite',
        type: 'agent',
        displayName: 'Engineer Lite',
        role: 'engineer'
      });
      await patch('/api/tasks', { participants });
    }
    
    // Create task and dispatch to create initial worktree
    await post('/api/tasks', {
      tasks: [{
        id: 'T-WORKTREE-REBUILD',
        title: 'Worktree rebuild test',
        assignee: 'engineer_lite',
        status: 'pending'
      }]
    });
    
    await post('/api/tasks/T-WORKTREE-REBUILD/steps', { run_id: 'test-worktree' });
    
    // First dispatch - creates worktree
    let res = await post('/api/tasks/T-WORKTREE-REBUILD/dispatch', { step: 'plan' });
    if (!res.ok && !res.dispatched) {
      fail('First dispatch', JSON.stringify(res));
      return;
    }
    
    // Wait for worktree creation
    let task = null;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const board = await get('/api/tasks');
      const tasks = board.tasks || board.taskPlan?.tasks || [];
      task = tasks.find(t => t.id === 'T-WORKTREE-REBUILD');
      if (task && task.worktreeDir) break;
    }
    
    if (!task || !task.worktreeDir) {
      fail('Initial worktree created', 'task.worktreeDir is null after first dispatch');
      return;
    }
    
    const originalWorktree = task.worktreeDir;
    
    // Verify worktree exists
    if (!fs.existsSync(originalWorktree)) {
      fail('Initial worktree exists on disk', `worktree not found: ${originalWorktree}`);
      return;
    }
    
    const gitDir = path.join(originalWorktree, '.git');
    if (!fs.existsSync(gitDir)) {
      fail('Initial worktree has .git', `.git missing in ${originalWorktree}`);
      return;
    }
    
    // Delete worktree to simulate manual cleanup
    fs.rmSync(originalWorktree, { recursive: true, force: true });
    if (fs.existsSync(originalWorktree)) {
      fail('Worktree deleted', 'failed to delete worktree for test');
      return;
    }
    
    // Reset step to allow redispatch
    const step = task.steps.find(s => s.step_id === 'T-WORKTREE-REBUILD:plan');
    if (step && (step.state === 'running' || step.state === 'queued')) {
      step.state = 'pending';
      step.locked_by = null;
      step.lock_expires_at = null;
      step.error = null;
      await patch('/api/tasks/T-WORKTREE-REBUILD', { steps: task.steps });
    }
    
    // Redispatch - should rebuild worktree
    res = await post('/api/tasks/T-WORKTREE-REBUILD/dispatch', { step: 'plan' });
    
    // Wait for worktree rebuild
    let rebuiltTask = null;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const board = await get('/api/tasks');
      const tasks = board.tasks || board.taskPlan?.tasks || [];
      rebuiltTask = tasks.find(t => t.id === 'T-WORKTREE-REBUILD');
      if (rebuiltTask && rebuiltTask.worktreeDir && fs.existsSync(rebuiltTask.worktreeDir)) break;
    }
    
    if (!rebuiltTask || !rebuiltTask.worktreeDir) {
      fail('Worktree rebuilt after deletion', 'task.worktreeDir is null after redispatch');
      return;
    }
    
    if (!fs.existsSync(rebuiltTask.worktreeDir)) {
      fail('Rebuilt worktree exists', `rebuilt worktree not found: ${rebuiltTask.worktreeDir}`);
      return;
    }
    
    const rebuiltGitDir = path.join(rebuiltTask.worktreeDir, '.git');
    if (!fs.existsSync(rebuiltGitDir)) {
      fail('Rebuilt worktree has .git', `.git missing in ${rebuiltTask.worktreeDir}`);
      return;
    }
    
    ok('Worktree auto-rebuild on redispatch');
  } catch (err) {
    fail('Worktree auto-rebuild', err.message);
  }
}

async function testENOENTClassification() {
  console.log('\n📋 Test 2: ENOENT Classification (code verification)');
  // Verify ENOENT is in ERROR_PATTERNS as CONFIG
  const stepWorker = fs.readFileSync(path.join(__dirname, 'step-worker.js'), 'utf8');
  const hasEnoentPattern = stepWorker.includes('{ pattern: /ENOENT/i, kind: \'CONFIG\' }');
  if (!hasEnoentPattern) {
    fail('ENOENT in ERROR_PATTERNS', 'ENOENT pattern not found in step-worker.js');
    return;
  }
  ok('ENOENT classified as CONFIG in step-worker.js:18-21');
}

async function testInitialProgress() {
  console.log('\n📋 Test 3: Initial Progress (code verification)');
  // Verify initial progress is written in step-worker.js
  const stepWorker = fs.readFileSync(path.join(__dirname, 'step-worker.js'), 'utf8');
  const hasInitialProgress = stepWorker.includes('initStep.progress = {') && 
                              stepWorker.includes('dispatched_at:') &&
                              stepWorker.includes('last_activity:');
  if (!hasInitialProgress) {
    fail('Initial progress code', 'Initial progress assignment not found in step-worker.js');
    return;
  }
  ok('Initial progress written in step-worker.js:193-211');
}

async function testActivityAwareLockRenewal() {
  console.log('\n📋 Test 4: Activity-Aware Lock Renewal (code verification)');
  // Verify activity-aware logic in server.js retry-poller
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const normalized = server.replace(/\r\n/g, '\n');
  const hasLockRenewal = normalized.includes('lastActivity && totalElapsed < maxTotalMs') &&
                         normalized.includes('silentMs < graceMs') &&
                         normalized.includes('step.lock_expires_at = new Date(Date.now() + timeout + 30_000)');
  const renewalUsesContinue = /step\.lock_expires_at = new Date\(Date\.now\(\) \+ timeout \+ 30_000\)\.toISOString\(\);\n\s*writeBoard\(board\);\n\s*continue;/.test(normalized);
  const renewalUsesReturn = /step\.lock_expires_at = new Date\(Date\.now\(\) \+ timeout \+ 30_000\)\.toISOString\(\);\n\s*writeBoard\(board\);\n\s*return;/.test(normalized);
  if (!hasLockRenewal || !renewalUsesContinue || renewalUsesReturn) {
    fail('Lock renewal code', 'Activity-aware lock renewal control flow (continue vs return) not correct in server.js');
    return;
  }
  ok('Activity-aware lock renewal control flow in server.js:269-285');
}

async function testDeadLetterDiagnostic() {
  console.log('\n📋 Test 5: Dead Letter Diagnostic (code verification)');
  // Verify dead letter diagnostic in step-worker.js
  const stepWorker = fs.readFileSync(path.join(__dirname, 'step-worker.js'), 'utf8');
  const hasDeadLetter = stepWorker.includes('DEAD LETTER:') && 
                        stepWorker.includes('event: \'step_dead_diagnostic\'');
  if (!hasDeadLetter) {
    fail('Dead letter code', 'Dead letter diagnostic not found in step-worker.js');
    return;
  }
  ok('Dead letter diagnostic in step-worker.js:245-262');
}

async function cleanup() {
  try {
    const board = await get('/api/tasks');
    const testTasks = (board.tasks || board.taskPlan?.tasks || []).filter(t => 
      t.id.startsWith('T-WORKTREE-') || 
      t.id.startsWith('T-ENOENT-') || 
      t.id.startsWith('T-INIT-') ||
      t.id.startsWith('T-LOCK-') ||
      t.id.startsWith('T-DEAD-')
    );
    
    for (const task of testTasks) {
      if (task.worktreeDir && fs.existsSync(task.worktreeDir)) {
        try {
          fs.rmSync(task.worktreeDir, { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
}

async function main() {
  console.log('🧪 Runtime Observability Integration Tests (Issue #290)');
  console.log('='.repeat(60));
  
  await startServer();
  try {
    await testWorktreeAutoRebuild();
    await testENOENTClassification();
    await testInitialProgress();
    await testActivityAwareLockRenewal();
    await testDeadLetterDiagnostic();
    
    await cleanup();
    
    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed}/${passed + failed} tests passed`);
    
    if (failed > 0) {
      console.log('\n⚠️  Some tests failed. Check output above for details.');
      process.exitCode = 1;
    }
  } finally {
    stopServer();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
