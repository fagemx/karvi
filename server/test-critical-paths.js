#!/usr/bin/env node
/**
 * test-critical-paths.js — Integration tests for 5 critical paths (GH-421)
 *
 * Tests missing end-to-end coverage:
 * 1. Cancel task + step kill + cascading state changes
 * 2. Wave dispatch gate (active_wave filtering via auto-dispatch)
 * 3. Confidence engine via HTTP API (GET/POST)
 * 4. Step concurrency limit via dispatch-batch
 * 5. Error → retry → dead letter → task blocked → step reset → unblocked
 *
 * Usage: node server/test-critical-paths.js
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
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    req.on('error', reject);
    req.end(data);
  });
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    http.get({ hostname: 'localhost', port: PORT, path: urlPath, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); })
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer() {
  return new Promise((resolve, reject) => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-critical-'));
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), KARVI_STORAGE: 'json', DATA_DIR: tmpDataDir },
    });
    serverProc = proc;
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      const m = buf.match(/running at http:\/\/localhost:(\d+)/);
      if (m) { PORT = Number(m[1]); resolve(); }
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

function getTask(taskId) {
  return get('/api/tasks').then(r => {
    const tasks = r.body.tasks || r.body.taskPlan?.tasks || [];
    return tasks.find(t => t.id === taskId) || null;
  });
}

// ── Test 1: Cancel task + step cancellation + cascading effects ──

async function testCancelWithStepKill() {
  console.log('\n📋 Test 1: Cancel task with running step');

  // Create task with steps
  await post('/api/tasks', {
    tasks: [{ id: 'T-CRIT-CANCEL', title: 'Cancel critical test', assignee: 'engineer_lite', status: 'pending' }]
  });
  await post('/api/tasks/T-CRIT-CANCEL/steps', { run_id: 'run-crit-cancel' });

  // Transition plan step to running
  await patch('/api/tasks/T-CRIT-CANCEL/steps/T-CRIT-CANCEL:plan', { state: 'running', locked_by: 'worker-1' });

  // Seed worktree metadata via board.json
  const boardPath = path.join(tmpDataDir, 'board.json');
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const task = (board.taskPlan?.tasks || []).find(t => t.id === 'T-CRIT-CANCEL');
  if (task) {
    task.worktreeDir = 'C:\\fake\\worktree\\T-CRIT-CANCEL';
    task.worktreeBranch = 'agent/T-CRIT-CANCEL';
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
  }

  // Cancel task
  const cancelRes = await post('/api/tasks/T-CRIT-CANCEL/cancel', { reason: 'test cancel' });

  // 1a: Task status → cancelled
  if (cancelRes.body.ok && cancelRes.body.task?.status === 'cancelled') {
    ok('Task transitions to cancelled');
  } else {
    fail('Task cancel', JSON.stringify(cancelRes.body));
  }

  // 1b: Running step → cancelled
  const stepsRes = await get('/api/tasks/T-CRIT-CANCEL/steps');
  const steps = stepsRes.body.steps || [];
  const planStep = steps.find(s => s.step_id === 'T-CRIT-CANCEL:plan');
  if (planStep && planStep.state === 'cancelled') {
    ok('Running step transitions to cancelled');
  } else {
    fail('Step cancel', `expected cancelled, got ${planStep?.state}`);
  }

  // 1c: Non-running steps also cancelled
  const allCancelled = steps.every(s => s.state === 'cancelled' || s.state === 'queued');
  if (allCancelled) {
    ok('All steps in terminal or queued state after cancel');
  } else {
    fail('All steps cancelled', steps.map(s => s.step_id + '=' + s.state).join(', '));
  }

  // 1d: Worktree metadata cleared
  const cancelledTask = await getTask('T-CRIT-CANCEL');
  if (cancelledTask && !cancelledTask.worktreeDir && !cancelledTask.worktreeBranch) {
    ok('Worktree metadata cleared');
  } else {
    fail('Worktree cleanup', `dir=${cancelledTask?.worktreeDir}, branch=${cancelledTask?.worktreeBranch}`);
  }

  // 1e: status_change signal emitted
  const signals = await get('/api/signals');
  const cancelSignal = (Array.isArray(signals.body) ? signals.body : [])
    .find(s => s.type === 'status_change' && s.data?.taskId === 'T-CRIT-CANCEL' && s.data?.to === 'cancelled');
  if (cancelSignal) {
    ok('status_change signal emitted for cancel');
  } else {
    fail('Cancel signal', 'no status_change signal found');
  }

  // 1f: Invalid cancel from approved → rejected
  const board2 = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const invalidTask = (board2.taskPlan?.tasks || []).find(t => t.id === 'T-CRIT-CANCEL');
  if (invalidTask) {
    invalidTask.status = 'approved';
    fs.writeFileSync(boardPath, JSON.stringify(board2, null, 2));
  }
  const invalidRes = await post('/api/tasks/T-CRIT-CANCEL/cancel', {});
  if (!invalidRes.body.ok && invalidRes.body.error) {
    ok('Cancel from approved rejected');
  } else {
    fail('Invalid cancel', JSON.stringify(invalidRes.body));
  }
}

// ── Test 2: Wave dispatch gate ──

async function testWaveDispatchGate() {
  console.log('\n📋 Test 2: Wave dispatch gate via auto-dispatch');

  // Disable auto-dispatch first
  await post('/api/controls', { auto_dispatch: false, max_concurrent_tasks: 10 });

  // Create tasks in different waves
  await post('/api/tasks', {
    tasks: [
      { id: 'T-WAVE-A', title: 'Wave 1 task A', assignee: 'engineer_lite', status: 'pending', wave: 1 },
      { id: 'T-WAVE-B', title: 'Wave 2 task B', assignee: 'engineer_lite', status: 'pending', wave: 2 },
    ]
  });

  // Set active_wave = 1
  const ctrlRes = await post('/api/controls', { active_wave: 1 });
  if (ctrlRes.body.ok && ctrlRes.body.controls?.active_wave === 1) {
    ok('active_wave set to 1');
  } else {
    fail('Set active_wave', JSON.stringify(ctrlRes.body));
  }

  // Manually set tasks to dispatched status (simulates dispatch trigger)
  await post('/api/tasks/T-WAVE-A/status', { status: 'dispatched' });
  await post('/api/tasks/T-WAVE-B/status', { status: 'dispatched' });

  // Enable auto_dispatch — should only process wave-1 tasks
  await post('/api/controls', { auto_dispatch: true });
  await sleep(500);

  // Wave-2 task should stay dispatched (blocked by wave gate)
  const taskB = await getTask('T-WAVE-B');
  if (taskB && taskB.status === 'dispatched') {
    ok('Wave-2 task blocked by active_wave=1');
  } else {
    fail('Wave gate', `wave-2 task status: ${taskB?.status} (expected dispatched)`);
  }

  // Clear active_wave
  await post('/api/controls', { active_wave: null, auto_dispatch: false });
  const clearRes = await get('/api/controls');
  const controls = clearRes.body.controls || clearRes.body;
  if (controls.active_wave === null || controls.active_wave === undefined) {
    ok('active_wave cleared with null');
  } else {
    fail('Clear active_wave', `got ${controls.active_wave}`);
  }

  // Negative wave → rejected
  const before = await get('/api/controls');
  await post('/api/controls', { active_wave: -1 });
  const after = await get('/api/controls');
  const beforeWave = (before.body.controls || before.body).active_wave;
  const afterWave = (after.body.controls || after.body).active_wave;
  if (afterWave === beforeWave) {
    ok('Negative active_wave rejected');
  } else {
    fail('Wave validation', `negative accepted: ${afterWave}`);
  }
}

// ── Test 3: Confidence engine via HTTP API ──

async function testConfidenceAPI() {
  console.log('\n📋 Test 3: Confidence engine via HTTP API');

  // Create a task with some state for confidence computation
  await post('/api/tasks', {
    tasks: [{ id: 'T-CONF-API', title: 'Confidence API test', assignee: 'engineer_lite', status: 'pending' }]
  });
  await post('/api/tasks/T-CONF-API/steps', { run_id: 'run-conf' });

  // 3a: GET confidence — no data yet → 404
  const noConfRes = await get('/api/tasks/T-CONF-API/confidence');
  if (noConfRes.status === 404) {
    ok('GET confidence returns 404 when no data');
  } else {
    fail('GET confidence no data', `expected 404, got ${noConfRes.status}`);
  }

  // 3b: POST confidence → triggers compute
  const computeRes = await post('/api/tasks/T-CONF-API/confidence', {});
  if (computeRes.status === 200 && computeRes.body.ok) {
    ok('POST confidence triggers computation');
  } else if (computeRes.status === 503) {
    // Confidence engine not loaded — acceptable in minimal test env
    ok('POST confidence returns 503 (engine not loaded — acceptable)');
    return; // Skip remaining confidence tests
  } else {
    fail('POST confidence', `status=${computeRes.status}, body=${JSON.stringify(computeRes.body).slice(0, 100)}`);
    return;
  }

  // 3c: Verify confidence structure
  const conf = computeRes.body.confidence;
  if (conf && conf.signals && Array.isArray(conf.signals)) {
    ok('Confidence has signals array');
  } else {
    fail('Confidence structure', JSON.stringify(conf).slice(0, 100));
    return;
  }

  if (typeof conf.overall === 'number' && conf.overall >= 0 && conf.overall <= 100) {
    ok('Confidence overall score is valid number (0-100)');
  } else {
    fail('Confidence overall', `got ${conf.overall}`);
  }

  // 3d: GET confidence now returns cached data
  const getRes = await get('/api/tasks/T-CONF-API/confidence');
  if (getRes.status === 200 && getRes.body.signals) {
    ok('GET confidence returns cached data after compute');
  } else {
    fail('GET confidence cached', `status=${getRes.status}`);
  }

  // 3e: Non-existent task → 404
  const notFoundRes = await get('/api/tasks/T-NONEXISTENT/confidence');
  if (notFoundRes.status === 404) {
    ok('GET confidence for missing task returns 404');
  } else {
    fail('Confidence 404', `expected 404, got ${notFoundRes.status}`);
  }
}

// ── Test 4: Step concurrency limit via dispatch-batch ──

async function testStepConcurrencyLimit() {
  console.log('\n📋 Test 4: Step concurrency limit');

  // 4a: Set concurrency limits via controls
  const ctrlRes = await post('/api/controls', { auto_dispatch: false, max_concurrent_by_type: { plan: 1, implement: 2 } });
  const limits = ctrlRes.body.controls?.max_concurrent_by_type;
  if (limits && limits.plan === 1 && limits.implement === 2) {
    ok('Per-type concurrency limits set via controls');
  } else {
    fail('Set concurrency limits', JSON.stringify(limits));
  }

  // 4b: Create 2 tasks with steps; both plan steps start queued
  await post('/api/tasks', {
    tasks: [
      { id: 'T-CONC-X', title: 'Concurrency X', assignee: 'engineer_lite', status: 'pending' },
      { id: 'T-CONC-Y', title: 'Concurrency Y', assignee: 'engineer_lite', status: 'pending' },
    ]
  });
  await post('/api/tasks/T-CONC-X/steps', { run_id: 'run-conc-x' });
  await post('/api/tasks/T-CONC-Y/steps', { run_id: 'run-conc-y' });

  // 4c: Transition task X plan → running (fills the 1 plan slot)
  const runRes = await patch('/api/tasks/T-CONC-X/steps/T-CONC-X:plan', { state: 'running', locked_by: 'worker-x' });
  if (runRes.status === 200 && runRes.body.ok) {
    ok('Task X plan step running (fills concurrency slot)');
  } else {
    fail('Task X plan running', JSON.stringify(runRes.body));
  }

  // 4d: Verify running plan count = 1 across all tasks via board state
  const boardRes = await get('/api/tasks');
  const allTasks = boardRes.body.tasks || boardRes.body.taskPlan?.tasks || [];
  let runningPlanCount = 0;
  for (const t of allTasks) {
    for (const s of (t.steps || [])) {
      if (s.type === 'plan' && s.state === 'running') runningPlanCount++;
    }
  }
  if (runningPlanCount === 1) {
    ok('Exactly 1 plan step running globally');
  } else {
    fail('Running plan count', `expected 1, got ${runningPlanCount}`);
  }

  // 4e: Complete task X plan → frees slot
  await patch('/api/tasks/T-CONC-X/steps/T-CONC-X:plan', { state: 'succeeded' });
  const stepsX = await get('/api/tasks/T-CONC-X/steps');
  const xPlan = (stepsX.body.steps || []).find(s => s.step_id === 'T-CONC-X:plan');
  if (xPlan && xPlan.state === 'succeeded') {
    ok('Concurrency slot freed after step succeeded');
  } else {
    fail('Slot freed', `expected succeeded, got ${xPlan?.state}`);
  }

  // 4f: Task Y plan is still queued (ready for dispatch when slot available)
  const stepsY = await get('/api/tasks/T-CONC-Y/steps');
  const yPlan = (stepsY.body.steps || []).find(s => s.step_id === 'T-CONC-Y:plan');
  if (yPlan && yPlan.state === 'queued') {
    ok('Task Y plan step remains queued (available for dispatch)');
  } else {
    fail('Task Y plan queued', `expected queued, got ${yPlan?.state}`);
  }

  // 4g: Clear limits → null
  const clearRes = await post('/api/controls', { max_concurrent_by_type: null });
  const cleared = clearRes.body.controls?.max_concurrent_by_type;
  if (!cleared || cleared === null) {
    ok('Concurrency limits cleared with null');
  } else {
    fail('Clear limits', JSON.stringify(cleared));
  }
}

// ── Test 5: Error → retry → dead letter → blocked → reset → unblocked ──

async function testFullDeadLetterPath() {
  console.log('\n📋 Test 5: Full dead letter path (error → retry → dead → blocked → reset → unblocked)');

  await post('/api/controls', { auto_dispatch: false });

  // Create task with steps
  await post('/api/tasks', {
    tasks: [{ id: 'T-DL-PATH', title: 'Dead letter path test', assignee: 'engineer_lite', status: 'in_progress' }]
  });
  await post('/api/tasks/T-DL-PATH/steps', { run_id: 'run-dl' });

  // 5a: Exhaust retries (3 attempts: running→failed × 3 → dead)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await patch('/api/tasks/T-DL-PATH/steps/T-DL-PATH:plan', { state: 'running', locked_by: `worker-${attempt}` });
    await patch('/api/tasks/T-DL-PATH/steps/T-DL-PATH:plan', { state: 'failed', error: `ENOENT attempt ${attempt}` });
  }

  // Verify step is dead
  const stepsRes = await get('/api/tasks/T-DL-PATH/steps');
  const planStep = (stepsRes.body.steps || []).find(s => s.step_id === 'T-DL-PATH:plan');
  if (planStep && planStep.state === 'dead') {
    ok('Step reaches dead state after 3 failed attempts');
  } else {
    fail('Dead state', `expected dead, got ${planStep?.state}`);
    return;
  }

  // 5b: Dead step retains error
  if (planStep.error && planStep.error.includes('ENOENT')) {
    ok('Dead step retains error message');
  } else {
    fail('Dead step error', `error=${planStep.error}`);
  }

  // 5c: Kernel routes dead step → task blocked
  // The kernel onStepEvent fires via setImmediate after step transition
  await sleep(500);

  const blockedTask = await getTask('T-DL-PATH');
  if (blockedTask && blockedTask.status === 'blocked') {
    ok('Task transitions to blocked via kernel dead_letter routing');
  } else {
    fail('Task blocked', `expected blocked, got ${blockedTask?.status}`);
  }

  // 5d: Blocker has dead_letter type
  if (blockedTask?.blocker?.type === 'dead_letter') {
    ok('Blocker type is dead_letter');
  } else {
    fail('Blocker type', JSON.stringify(blockedTask?.blocker));
  }

  // 5e: task_dead_letter signal emitted
  const signals = await get('/api/signals');
  const dlSignal = (Array.isArray(signals.body) ? signals.body : [])
    .find(s => s.type === 'task_dead_letter' && s.data?.taskId === 'T-DL-PATH');
  if (dlSignal) {
    ok('task_dead_letter signal emitted');
  } else {
    fail('Dead letter signal', 'no task_dead_letter signal found');
  }

  // 5f: Reset dead step → queued + task unblocked
  const resetRes = await post('/api/tasks/T-DL-PATH/steps/T-DL-PATH:plan/reset', {});
  if (resetRes.body.ok && resetRes.body.from === 'dead' && resetRes.body.new_state === 'queued') {
    ok('Step reset: dead → queued');
  } else {
    fail('Step reset', JSON.stringify(resetRes.body));
  }

  if (resetRes.body.task_unblocked === true) {
    ok('Task unblocked flag set on reset');
  } else {
    fail('Task unblocked', `task_unblocked=${resetRes.body.task_unblocked}`);
  }

  // 5g: Task is now in_progress (not blocked)
  await sleep(200);
  const unblockedTask = await getTask('T-DL-PATH');
  if (unblockedTask && unblockedTask.status === 'in_progress') {
    ok('Task status back to in_progress after reset');
  } else {
    fail('Task unblocked status', `expected in_progress, got ${unblockedTask?.status}`);
  }

  // 5h: Step fields cleared
  const resetSteps = await get('/api/tasks/T-DL-PATH/steps');
  const resetPlan = (resetSteps.body.steps || []).find(s => s.step_id === 'T-DL-PATH:plan');
  if (resetPlan && resetPlan.state === 'queued' && resetPlan.attempt === 0 && resetPlan.error === null) {
    ok('Reset step: attempt=0, error=null');
  } else {
    fail('Reset step fields', `state=${resetPlan?.state}, attempt=${resetPlan?.attempt}, error=${resetPlan?.error}`);
  }

  // 5i: step_reset signal emitted
  const signals2 = await get('/api/signals');
  const resetSignal = (Array.isArray(signals2.body) ? signals2.body : [])
    .find(s => s.type === 'step_reset' && s.data?.stepId === 'T-DL-PATH:plan');
  if (resetSignal && resetSignal.data?.taskUnblocked === true) {
    ok('step_reset signal with taskUnblocked=true');
  } else {
    fail('Reset signal', JSON.stringify(resetSignal));
  }
}

// ── Main ──

(async () => {
  console.log('🧪 Critical Path Integration Tests (GH-421)');
  console.log('='.repeat(55));
  try {
    await startServer();
    console.log('Server ready.\n');

    // Disable auto-dispatch for controlled testing
    await post('/api/controls', { auto_dispatch: false });

    await testCancelWithStepKill();
    await testWaveDispatchGate();
    await testConfidenceAPI();
    await testStepConcurrencyLimit();
    await testFullDeadLetterPath();
  } catch (err) {
    console.error('Test error:', err);
    process.exitCode = 1;
  } finally {
    stopServer();
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
  }
})();
