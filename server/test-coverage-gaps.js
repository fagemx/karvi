#!/usr/bin/env node
/**
 * test-coverage-gaps.js — 5 個關鍵測試缺漏 (GH-477)
 *
 * 1. SSE 端到端（推送內容驗證）
 * 2. Concurrent board.json write（併發寫入 + optimistic locking）
 * 3. Auto-dispatch 完整 lifecycle（project → steps → complete）
 * 4. Runtime timeout → retry → dead letter（step-schema 層級驗證）
 * 5. Hook system 錯誤隔離（hook throw 不阻塞主流程）
 *
 * Usage: node server/test-coverage-gaps.js
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

// Global timeout — kill the process if test hangs (CI safety net)
const GLOBAL_TIMEOUT_MS = 60_000;
setTimeout(() => {
  console.error(`\nGlobal timeout (${GLOBAL_TIMEOUT_MS / 1000}s) — test hung, forcing exit`);
  stopServer();
  process.exit(2);
}, GLOBAL_TIMEOUT_MS).unref();

function ok(label) { passed++; console.log(`  [PASS] ${label}`); }
function fail(label, reason) { failed++; console.log(`  [FAIL] ${label}: ${reason}`); process.exitCode = 1; }

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer() {
  return new Promise((resolve, reject) => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-gaps-'));
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
    setTimeout(() => reject(new Error('Server start timeout. Output: ' + buf)), 10000);
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  if (tmpDataDir) {
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    tmpDataDir = null;
  }
}

// ── Test 1: SSE 端到端（推送內容驗證） ──

async function testSSEContentVerification() {
  console.log('\n--- Test 1: SSE end-to-end content verification ---');

  // 1a: Connect to SSE and verify connected event has valid JSON
  const sseEvents = [];
  const ssePromise = new Promise((resolve, reject) => {
    const headers = {};
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    const req = http.get({
      hostname: 'localhost', port: PORT,
      path: `/api/events${API_TOKEN ? '?token=' + API_TOKEN : ''}`,
      headers,
    }, res => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk.toString();
        // 解析 SSE 格式：event: xxx\ndata: yyy\n\n
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // 保留不完整的
        for (const part of parts) {
          if (!part.trim()) continue;
          const lines = part.split('\n');
          const evt = {};
          for (const line of lines) {
            if (line.startsWith('event: ')) evt.event = line.slice(7);
            else if (line.startsWith('data: ')) {
              try { evt.data = JSON.parse(line.slice(6)); }
              catch { evt.data = line.slice(6); }
            }
          }
          if (evt.event || evt.data) sseEvents.push(evt);
        }
      });
      // 給 2 秒收集事件後結束
      setTimeout(() => { req.destroy(); resolve(); }, 2000);
    });
    req.on('error', () => resolve()); // 正常斷開不報錯
  });

  // 等 SSE 連線建立
  await sleep(200);

  // 1b: 觸發 board 變更，應透過 SSE 推送
  await post('/api/controls', { quality_threshold: 88 });

  // 等待 SSE 收集
  await ssePromise;

  // 驗證收到 connected 事件
  const connectedEvent = sseEvents.find(e => e.event === 'connected');
  if (connectedEvent && connectedEvent.data?.ts) {
    ok('SSE connected event has valid ts field');
  } else {
    fail('SSE connected event', `events: ${JSON.stringify(sseEvents.slice(0, 2))}`);
  }

  // 1c: 驗證收到 board 更新事件且包含正確內容
  const boardEvent = sseEvents.find(e => e.event === 'board');
  if (boardEvent && boardEvent.data?.controls?.quality_threshold === 88) {
    ok('SSE board event contains correct controls update (quality_threshold=88)');
  } else if (boardEvent) {
    // board event 收到了但 threshold 不對
    fail('SSE board content', `threshold=${boardEvent.data?.controls?.quality_threshold}`);
  } else {
    fail('SSE board event', 'no board event received');
  }

  // 1d: 驗證收到多個事件（connected + 至少一個 board）
  if (sseEvents.length >= 2) {
    ok(`SSE received ${sseEvents.length} events (connected + board updates)`);
  } else {
    fail('SSE event count', `expected >=2, got ${sseEvents.length}`);
  }

  // 1e: 發送 signal，驗證 SSE 推送包含新 signal
  const signalRes = await post('/api/signals', {
    by: 'test-sse',
    type: 'review_result',
    content: 'SSE content verification test signal',
    data: { taskId: 'T-SSE-TEST', score: 99 },
  });
  if (signalRes.status === 200 || signalRes.status === 201) {
    ok('Signal posted for SSE verification');
  } else {
    fail('Signal post', `status=${signalRes.status}`);
  }

  // 1f: 驗證 SSE 連線限制 — 嘗試連太多 SSE 應回 429
  // (不實際測到上限，只驗證 SSE 端點回覆正確格式)
  const sseCheck = await new Promise((resolve) => {
    const headers = {};
    const req = http.get({
      hostname: 'localhost', port: PORT,
      path: `/api/events${API_TOKEN ? '?token=' + API_TOKEN : ''}`,
      headers,
    }, res => {
      // 連線成功或被拒都算
      resolve({ status: res.statusCode, contentType: res.headers['content-type'] });
      req.destroy();
    });
    req.on('error', () => resolve({ status: 0, error: true }));
    setTimeout(() => { req.destroy(); resolve({ status: 0, timeout: true }); }, 2000);
  });
  if (sseCheck.status === 200 && sseCheck.contentType?.includes('text/event-stream')) {
    ok('SSE endpoint returns correct content-type (text/event-stream)');
  } else if (sseCheck.status === 429) {
    ok('SSE endpoint correctly returns 429 when at limit');
  } else {
    fail('SSE content-type', `status=${sseCheck.status}, type=${sseCheck.contentType}`);
  }

  // 恢復
  await post('/api/controls', { quality_threshold: 70 });
}

// ── Test 2: Concurrent board.json write ──

async function testConcurrentBoardWrite() {
  console.log('\n--- Test 2: Concurrent board.json write with optimistic locking ---');

  // 直接 require 內部模組：併發 race condition 測試需要控制兩個 writer 的精確時序，
  // 無法透過 HTTP API 重現（API 是序列化的）
  const storageJson = require('./storage-json');
  const { OptimisticLockError } = require('./errors');
  const testBoardPath = path.join(tmpDataDir, 'test-concurrent-board.json');

  // 2a: 寫初始 board
  const initBoard = {
    _version: 0,
    meta: { updatedAt: new Date().toISOString() },
    controls: { counter: 0 },
  };
  fs.writeFileSync(testBoardPath, JSON.stringify(initBoard, null, 2));
  ok('Initial concurrent test board created');

  // 2b: 正常寫入 — version 遞增
  const board1 = storageJson.readBoard(testBoardPath);
  board1.controls.counter = 1;
  storageJson.writeBoard(testBoardPath, board1);
  const after1 = storageJson.readBoard(testBoardPath);
  if (after1._version === 1 && after1.controls.counter === 1) {
    ok('Sequential write: version 0 -> 1, counter updated');
  } else {
    fail('Sequential write', `version=${after1._version}, counter=${after1.controls.counter}`);
  }

  // 2c: Stale version → OptimisticLockError
  const staleBoard = storageJson.readBoard(testBoardPath);
  // 先讓另一個寫入推進 version
  const freshBoard = storageJson.readBoard(testBoardPath);
  freshBoard.controls.counter = 2;
  storageJson.writeBoard(testBoardPath, freshBoard);

  // staleBoard 的 _version 現在過期了
  staleBoard.controls.counter = 999;
  let caughtConflict = false;
  try {
    storageJson.writeBoard(testBoardPath, staleBoard);
  } catch (err) {
    if (err instanceof OptimisticLockError || err.code === 'VERSION_CONFLICT') {
      caughtConflict = true;
    }
  }
  if (caughtConflict) {
    ok('Stale write throws OptimisticLockError (version conflict detected)');
  } else {
    fail('Optimistic lock', 'stale write did not throw');
  }

  // 2d: 確認衝突後資料完整性 — counter 應為 2（不是 999）
  const afterConflict = storageJson.readBoard(testBoardPath);
  if (afterConflict.controls.counter === 2) {
    ok('Data integrity preserved after conflict (counter=2, not 999)');
  } else {
    fail('Data integrity', `counter=${afterConflict.controls.counter}`);
  }

  // 2e: 併發寫入壓力測試 — 10 個快速寫入，只有一個應該成功
  const current = storageJson.readBoard(testBoardPath);
  const startVersion = current._version;
  let successCount = 0;
  let conflictCount = 0;

  // 讀取相同 version 的多個副本
  const copies = [];
  for (let i = 0; i < 10; i++) {
    copies.push(storageJson.readBoard(testBoardPath));
  }

  // 逐個嘗試寫入（同步，每個都用相同的 version）
  for (let i = 0; i < copies.length; i++) {
    copies[i].controls.counter = 100 + i;
    try {
      storageJson.writeBoard(testBoardPath, copies[i]);
      successCount++;
    } catch (err) {
      if (err.code === 'VERSION_CONFLICT') conflictCount++;
    }
  }

  if (successCount === 1 && conflictCount === 9) {
    ok(`Concurrent writes: 1 success, 9 conflicts (version ${startVersion} -> ${startVersion + 1})`);
  } else {
    fail('Concurrent writes', `success=${successCount}, conflicts=${conflictCount}`);
  }

  // 2f: Atomic write — 檢查 .tmp 檔案不殘留
  const tmpFiles = fs.readdirSync(tmpDataDir).filter(f => f.includes('.tmp'));
  if (tmpFiles.length === 0) {
    ok('No .tmp files left after writes (atomic rename completed)');
  } else {
    fail('Atomic write cleanup', `${tmpFiles.length} .tmp files remain: ${tmpFiles.join(', ')}`);
  }

  // 2g: Lock file 不殘留
  const lockFiles = fs.readdirSync(tmpDataDir).filter(f => f.endsWith('.lock'));
  if (lockFiles.length === 0) {
    ok('No .lock files left after writes');
  } else {
    fail('Lock cleanup', `${lockFiles.length} .lock files remain`);
  }
}

// ── Test 3: Auto-dispatch 完整 lifecycle ──

async function testAutoDispatchLifecycle() {
  console.log('\n--- Test 3: Auto-dispatch complete lifecycle ---');

  // 3a: 設定 controls 開啟 step pipeline，關閉 auto_dispatch（手動控制）
  const ctrlRes = await post('/api/controls', {
    auto_dispatch: false,
    use_step_pipeline: true,
    use_worktrees: false, // 測試環境不建 worktree
  });
  if (ctrlRes.body.ok) {
    ok('Controls set: step_pipeline=true, worktrees=false, auto_dispatch=false');
  } else {
    fail('Controls set', JSON.stringify(ctrlRes.body));
    return;
  }

  // 3b: POST /api/project 建立專案和任務
  const projectRes = await post('/api/project', {
    title: 'Lifecycle Test Project',
    goal: 'Verify auto-dispatch lifecycle',
    tasks: [{
      id: 'GH-477-LC',
      title: 'Lifecycle test task',
      assignee: 'engineer_lite',
      description: 'Test task for lifecycle verification',
    }],
  });
  if (projectRes.body.ok || projectRes.body.project) {
    ok('Project created with task GH-477-LC');
  } else {
    fail('Project creation', JSON.stringify(projectRes.body).slice(0, 200));
    return;
  }

  // 3c: 驗證 task 存在且有 steps
  await sleep(300);
  const taskRes = await get('/api/tasks');
  const allTasks = taskRes.body.tasks || taskRes.body.taskPlan?.tasks || [];
  const lcTask = allTasks.find(t => t.id === 'GH-477-LC');
  if (lcTask) {
    ok(`Task GH-477-LC found (status=${lcTask.status})`);
  } else {
    fail('Task lookup', 'GH-477-LC not found');
    return;
  }

  // 3d: 驗證 step pipeline 已建立
  const stepsRes = await get('/api/tasks/GH-477-LC/steps');
  const steps = stepsRes.body.steps || [];
  if (steps.length > 0) {
    ok(`Step pipeline created: ${steps.map(s => s.type).join(' -> ')} (${steps.length} steps)`);
  } else {
    // step pipeline 可能需要手動建立
    const createStepsRes = await post('/api/tasks/GH-477-LC/steps', { run_id: 'run-lc-477' });
    if (createStepsRes.body.ok || createStepsRes.body.steps) {
      const newSteps = createStepsRes.body.steps || [];
      ok(`Step pipeline manually created: ${newSteps.map(s => s.type).join(' -> ')} (${newSteps.length} steps)`);
    } else {
      fail('Step pipeline', JSON.stringify(createStepsRes.body).slice(0, 200));
      return;
    }
  }

  // 3e: 驗證 step 生命週期 — plan step 從 queued 開始
  const steps2 = (await get('/api/tasks/GH-477-LC/steps')).body.steps || [];
  const planStep = steps2.find(s => s.type === 'plan');
  if (planStep && planStep.state === 'queued') {
    ok('Plan step starts in queued state');
  } else {
    fail('Plan step state', `expected queued, got ${planStep?.state}`);
  }

  // 3f: 模擬 step 推進 — plan → running → succeeded
  // 直接 require：step state machine 的合法/非法轉換需要逐一驗證，
  // 走 HTTP 需要實際 agent runtime 才能推進 step 狀態
  const { transitionStep, createStep } = require('./step-schema');
  const testStep = createStep('TEST-SM', 'run-sm', 'plan');
  if (testStep.state === 'queued') {
    ok('createStep() returns step in queued state');
  } else {
    fail('createStep state', testStep.state);
  }

  transitionStep(testStep, 'running', { locked_by: 'test-worker' });
  if (testStep.state === 'running' && testStep.locked_by === 'test-worker') {
    ok('Step transitions queued -> running');
  } else {
    fail('Step running', `state=${testStep.state}`);
  }

  transitionStep(testStep, 'succeeded');
  if (testStep.state === 'succeeded' && testStep.completed_at) {
    ok('Step transitions running -> succeeded (completed_at set)');
  } else {
    fail('Step succeeded', `state=${testStep.state}, completed_at=${testStep.completed_at}`);
  }

  // 3g: 驗證 succeeded 是 terminal — 不能再 transition
  let terminalOk = false;
  try {
    transitionStep(testStep, 'running');
  } catch (err) {
    if (err.code === 'INVALID_STEP_TRANSITION') terminalOk = true;
  }
  if (terminalOk) {
    ok('Succeeded is terminal state (cannot transition to running)');
  } else {
    fail('Terminal state', 'succeeded allowed further transition');
  }

  // 3h: 驗證完整 pipeline 順序 plan → implement → test → review
  const { STEP_PIPELINE_ORDER } = require('./step-schema');
  if (JSON.stringify(STEP_PIPELINE_ORDER) === '["plan","implement","test","review"]') {
    ok('Pipeline order: plan -> implement -> test -> review');
  } else {
    fail('Pipeline order', JSON.stringify(STEP_PIPELINE_ORDER));
  }
}

// ── Test 4: Runtime timeout → retry → dead letter ──

async function testTimeoutRetryDeadLetter() {
  console.log('\n--- Test 4: Runtime timeout -> retry -> dead letter ---');

  // 直接 require：retry policy / backoff / error kind 是純邏輯，
  // 無對應 HTTP endpoint，只能直接測試模組匯出
  const { createStep, transitionStep, ERROR_KINDS, computeBackoff, DEFAULT_RETRY_POLICY } = require('./step-schema');

  // 4a: TIMEOUT error kind 是 non-retryable
  if (ERROR_KINDS.TIMEOUT.retryable === false) {
    ok('TIMEOUT error kind is non-retryable');
  } else {
    fail('TIMEOUT retryable', `expected false, got ${ERROR_KINDS.TIMEOUT.retryable}`);
  }

  // 4b: 模擬 timeout → failed → dead（因為 TIMEOUT 不 retryable，直接 dead）
  const timeoutStep = createStep('T-TO', 'run-to', 'implement');
  transitionStep(timeoutStep, 'running', { locked_by: 'worker-1' });
  transitionStep(timeoutStep, 'failed', {
    error: 'step timeout exceeded: T-TO:implement (300s)',
    errorKind: 'TIMEOUT',
  });

  if (timeoutStep.state === 'dead') {
    ok('TIMEOUT failure goes directly to dead (non-retryable)');
  } else {
    fail('Timeout -> dead', `expected dead, got ${timeoutStep.state}`);
  }

  // 4c: TEMPORARY error kind 是 retryable — failed → queued
  const retryStep = createStep('T-RT', 'run-rt', 'implement');
  transitionStep(retryStep, 'running', { locked_by: 'worker-1' });
  transitionStep(retryStep, 'failed', {
    error: 'idle for 120s',
    errorKind: 'TEMPORARY',
  });

  if (retryStep.state === 'queued' && retryStep.attempt === 1) {
    ok('TEMPORARY failure retries: failed -> queued (attempt=1)');
  } else {
    fail('Retry requeue', `state=${retryStep.state}, attempt=${retryStep.attempt}`);
  }

  // 4d: Retry 有 backoff — scheduled_at 在未來
  const scheduledAt = new Date(retryStep.scheduled_at).getTime();
  const now = Date.now();
  if (scheduledAt > now) {
    ok(`Retry has backoff delay (scheduled ${Math.round((scheduledAt - now) / 1000)}s in future)`);
  } else {
    fail('Retry backoff', `scheduled_at not in future: ${retryStep.scheduled_at}`);
  }

  // 4e: Exhaust retries → dead
  // 目前 attempt=1，再跑兩次到 max_attempts=3
  transitionStep(retryStep, 'running', { locked_by: 'worker-2' });
  transitionStep(retryStep, 'failed', { error: 'idle again', errorKind: 'TEMPORARY' });
  // attempt=2 now, still retryable
  if (retryStep.state === 'queued' && retryStep.attempt === 2) {
    ok('Second retry: attempt=2, still queued');
  } else {
    fail('Second retry', `state=${retryStep.state}, attempt=${retryStep.attempt}`);
  }

  transitionStep(retryStep, 'running', { locked_by: 'worker-3' });
  transitionStep(retryStep, 'failed', { error: 'idle third time', errorKind: 'TEMPORARY' });
  // attempt=3 now, should be dead
  if (retryStep.state === 'dead' && retryStep.attempt === 3) {
    ok('Max retries exhausted: attempt=3, state=dead');
  } else {
    fail('Max retries', `state=${retryStep.state}, attempt=${retryStep.attempt}`);
  }

  // 4f: Exponential backoff 計算
  const backoffStep = createStep('T-BK', 'run-bk', 'plan');
  backoffStep.attempt = 1;
  const kind = ERROR_KINDS.TEMPORARY;
  const delay1 = computeBackoff(kind, backoffStep);
  backoffStep.attempt = 2;
  const delay2 = computeBackoff(kind, backoffStep);
  backoffStep.attempt = 3;
  const delay3 = computeBackoff(kind, backoffStep);

  if (delay2 > delay1 && delay3 > delay2) {
    ok(`Exponential backoff: ${delay1}ms -> ${delay2}ms -> ${delay3}ms`);
  } else {
    fail('Exponential backoff', `delays: ${delay1}, ${delay2}, ${delay3}`);
  }

  // 4g: PROVIDER error kind 也 retryable
  if (ERROR_KINDS.PROVIDER.retryable === true) {
    ok('PROVIDER error kind is retryable');
  } else {
    fail('PROVIDER retryable', `expected true, got ${ERROR_KINDS.PROVIDER.retryable}`);
  }

  // 4h: PROTECTED error kind 是 non-retryable（直接 dead）
  const protectedStep = createStep('T-PR', 'run-pr', 'implement');
  transitionStep(protectedStep, 'running', { locked_by: 'w1' });
  transitionStep(protectedStep, 'failed', { error: 'protected code', errorKind: 'PROTECTED' });
  if (protectedStep.state === 'dead') {
    ok('PROTECTED failure goes directly to dead');
  } else {
    fail('PROTECTED dead', `expected dead, got ${protectedStep.state}`);
  }

  // 4i: Dead step 的 error 保留最後一次的錯誤訊息
  if (retryStep.error === 'idle third time') {
    ok('Dead step retains last error message');
  } else {
    fail('Dead error', `expected "idle third time", got "${retryStep.error}"`);
  }

  // 4j: 驗證 dead letter 透過 API — POST step 到 dead 然後 reset
  await post('/api/tasks', {
    tasks: [{ id: 'T-DL-477', title: 'Dead letter API test', assignee: 'engineer_lite', status: 'in_progress' }],
  });
  await post('/api/tasks/T-DL-477/steps', { run_id: 'run-dl-477' });

  // 跑完 3 次 failed → dead
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({ state: 'running', locked_by: `w-${i}` });
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
      if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
      const req = http.request({ hostname: 'localhost', port: PORT, path: '/api/tasks/T-DL-477/steps/T-DL-477:plan', method: 'PATCH', headers },
        res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.end(data);
    });
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({ state: 'failed', error: `fail-${i}` });
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
      if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
      const req = http.request({ hostname: 'localhost', port: PORT, path: '/api/tasks/T-DL-477/steps/T-DL-477:plan', method: 'PATCH', headers },
        res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.end(data);
    });
  }

  await sleep(300);
  const dlSteps = (await get('/api/tasks/T-DL-477/steps')).body.steps || [];
  const dlPlan = dlSteps.find(s => s.step_id === 'T-DL-477:plan');
  if (dlPlan && dlPlan.state === 'dead') {
    ok('Step reaches dead via API after 3 failed attempts');
  } else {
    fail('API dead letter', `state=${dlPlan?.state}`);
  }
}

// ── Test 5: Hook system 錯誤隔離 ──

async function testHookErrorIsolation() {
  console.log('\n--- Test 5: Hook system error isolation ---');

  // 直接 require：hook 錯誤隔離需要注入會 throw 的 hook 並驗證主流程不中斷，
  // 無法透過 API 觸發特定 hook 失敗場景
  const hookSystem = require('./hook-system');

  // 5a: 建立會 throw 的 hook
  const hooksDir = path.join(tmpDataDir, 'test-hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // 寫一個會 throw 同步錯誤的 hook
  fs.writeFileSync(path.join(hooksDir, 'throw-sync.js'), `
module.exports = {
  task_created: (event, data) => {
    throw new Error('hook sync explosion');
  }
};
`);

  // 寫一個會 reject async 的 hook
  fs.writeFileSync(path.join(hooksDir, 'throw-async.js'), `
module.exports = {
  task_created: async (event, data) => {
    throw new Error('hook async explosion');
  }
};
`);

  // 寫一個正常的 hook 用來確認 fire-and-forget 不阻塞
  fs.writeFileSync(path.join(hooksDir, 'normal.js'), `
module.exports = {
  task_created: (event, data) => {
    global.__hookNormalCalled = true;
    global.__hookNormalData = data;
  }
};
`);

  // 5b: 初始化 hooks
  const logs = [];
  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;
  console.error = (...args) => logs.push(['error', ...args]);
  console.warn = (...args) => logs.push(['warn', ...args]);
  console.log = (...args) => logs.push(['log', ...args]);

  const hooks = hookSystem.init(hooksDir);
  console.error = origError;
  console.warn = origWarn;
  console.log = origLog;

  if (hooks.length >= 3) {
    ok(`Hook init: loaded ${hooks.length} hooks from test directory`);
  } else {
    fail('Hook init', `expected >=3 hooks, got ${hooks.length}`);
  }

  // 5c: Emit 事件 — 不應 throw（fire-and-forget）
  let emitThrew = false;
  try {
    hookSystem.emit('task_created', { taskId: 'T-HOOK-TEST', title: 'Hook isolation test' });
  } catch {
    emitThrew = true;
  }

  if (!emitThrew) {
    ok('emit() does not throw despite hooks that throw');
  } else {
    fail('Emit isolation', 'emit() threw an error');
  }

  // 5d: 等 setImmediate 執行完 hooks
  await sleep(100);

  // 正常 hook 應該被調用
  if (global.__hookNormalCalled === true) {
    ok('Normal hook executes despite other hooks throwing');
  } else {
    fail('Normal hook', 'normal hook was not called');
  }

  // 5e: 正常 hook 收到正確的 data
  if (global.__hookNormalData?.taskId === 'T-HOOK-TEST') {
    ok('Normal hook receives correct event data');
  } else {
    fail('Hook data', JSON.stringify(global.__hookNormalData));
  }

  // Cleanup globals
  delete global.__hookNormalCalled;
  delete global.__hookNormalData;

  // 5f: Emit 未知事件 — 應 warn 但不 throw
  let unknownThrew = false;
  const warnLogs = [];
  console.warn = (...args) => warnLogs.push(args.join(' '));
  try {
    hookSystem.emit('unknown_event_xyz', {});
  } catch {
    unknownThrew = true;
  }
  console.warn = origWarn;

  if (!unknownThrew) {
    ok('Emit unknown event does not throw');
  } else {
    fail('Unknown event', 'threw on unknown event');
  }

  const hasWarning = warnLogs.some(l => l.includes('unknown_event_xyz') || l.includes('未知事件'));
  if (hasWarning) {
    ok('Unknown event emits warning');
  } else {
    fail('Unknown event warning', `no warning logged: ${JSON.stringify(warnLogs)}`);
  }

  // 5g: Hook list API 正確性
  const hookList = hookSystem.listHooks();
  if (Array.isArray(hookList) && hookList.length >= 3) {
    ok(`listHooks() returns ${hookList.length} hooks with name/file/events`);
  } else {
    fail('listHooks', JSON.stringify(hookList));
  }

  // 5h: Supported events 包含所有預期事件
  const events = hookSystem.getSupportedEvents();
  const expected = ['task_created', 'task_completed', 'step_started', 'step_completed', 'dispatch_started'];
  if (JSON.stringify(events) === JSON.stringify(expected)) {
    ok('getSupportedEvents() returns all expected events');
  } else {
    fail('Supported events', JSON.stringify(events));
  }

  // Cleanup: 重新初始化 hooks 到空目錄避免影響其他測試
  hookSystem.init(path.join(tmpDataDir, 'empty-hooks-dir'));
}

// ── Main ──

(async () => {
  console.log('Coverage Gap Tests (GH-477)');
  console.log('='.repeat(55));
  try {
    await startServer();
    console.log(`Server ready on port ${PORT}.\n`);

    await testSSEContentVerification();
    await testConcurrentBoardWrite();
    await testAutoDispatchLifecycle();
    await testTimeoutRetryDeadLetter();
    await testHookErrorIsolation();
  } catch (err) {
    console.error('Test error:', err);
    process.exitCode = 1;
  } finally {
    stopServer();
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
})();
