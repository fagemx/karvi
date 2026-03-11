#!/usr/bin/env node
/**
 * test-rbac.js — RBAC permission matrix integration test
 *
 * 用法：node server/test-rbac.js
 * 自動啟動 server（帶 RBAC tokens），驗證權限矩陣，結束後關閉 server。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT) || 13472;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-rbac-test-'));

const ADMIN_TOKEN = 'test-admin-token-343';
const OPERATOR_TOKEN = 'test-operator-token-343';
const VIEWER_TOKEN = 'test-viewer-token-343';

let serverProc = null;

function postAs(urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method: 'POST', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(d); } catch { return d; } })() })); });
    req.on('error', reject);
    req.end(data);
  });
}

function getAs(urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    http.get({ hostname: 'localhost', port: PORT, path: urlPath, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(d); } catch { return d; } })() })); })
      .on('error', reject);
  });
}

function deleteAs(urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method: 'DELETE', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(d); } catch { return d; } })() })); });
    req.on('error', reject);
    req.end();
  });
}

function ok(label) { console.log(`  OK ${label}`); }
function fail(label, reason) { console.log(`  FAIL ${label}: ${reason}`); process.exitCode = 1; }

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: TEST_DATA_DIR,
        KARVI_API_TOKEN: '',
        KARVI_API_TOKEN_ADMIN: ADMIN_TOKEN,
        KARVI_API_TOKEN_OPERATOR: OPERATOR_TOKEN,
        KARVI_API_TOKEN_VIEWER: VIEWER_TOKEN,
      },
    });

    let started = false;
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      if (!started && text.includes('running at')) { started = true; resolve(proc); }
    });
    proc.stderr.on('data', (data) => {
      if (!started) process.stderr.write('[server] ' + data.toString());
    });
    const timer = setTimeout(() => { if (!started) { proc.kill(); reject(new Error('Server start timeout')); } }, 10000);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => { if (!started) { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); } });
  });
}

function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
}

async function main() {
  console.log('Starting RBAC test server...');
  serverProc = await startServer();
  console.log(`Server started on port ${PORT}\n`);

  console.log('=== RBAC Permission Matrix ===\n');

  // --- Auth ---
  console.log('Auth:');
  const noToken = await getAs('/api/board', null);
  noToken.status === 401 ? ok('No token → 401') : fail('No token → 401', `got ${noToken.status}`);

  const badToken = await getAs('/api/board', 'wrong-token');
  badToken.status === 401 ? ok('Bad token → 401') : fail('Bad token → 401', `got ${badToken.status}`);

  // --- Viewer ---
  console.log('\nViewer:');
  const vBoard = await getAs('/api/board', VIEWER_TOKEN);
  vBoard.status === 200 ? ok('GET /api/board → 200') : fail('GET /api/board', `got ${vBoard.status}`);

  const vCtrlGet = await getAs('/api/controls', VIEWER_TOKEN);
  vCtrlGet.status === 200 ? ok('GET /api/controls → 200') : fail('GET /api/controls', `got ${vCtrlGet.status}`);

  const vCtrlPost = await postAs('/api/controls', { auto_dispatch: false }, VIEWER_TOKEN);
  vCtrlPost.status === 403 ? ok('POST /api/controls → 403') : fail('POST /api/controls', `got ${vCtrlPost.status}`);

  const vCancel = await postAs('/api/tasks/fake/cancel', {}, VIEWER_TOKEN);
  vCancel.status === 403 ? ok('POST /api/tasks/:id/cancel → 403') : fail('cancel', `got ${vCancel.status}`);

  const vStatus = await postAs('/api/tasks/fake/status', { status: 'completed' }, VIEWER_TOKEN);
  vStatus.status === 403 ? ok('POST /api/tasks/:id/status → 403') : fail('status', `got ${vStatus.status}`);

  const vDispatch = await postAs('/api/dispatch-next', {}, VIEWER_TOKEN);
  vDispatch.status === 403 ? ok('POST /api/dispatch-next → 403') : fail('dispatch-next', `got ${vDispatch.status}`);

  const vDelete = await deleteAs('/api/tasks/fake', VIEWER_TOKEN);
  vDelete.status === 403 ? ok('DELETE /api/tasks/:id → 403') : fail('delete', `got ${vDelete.status}`);

  const vCleanup = await postAs('/api/tasks/cleanup', {}, VIEWER_TOKEN);
  vCleanup.status === 403 ? ok('POST /api/tasks/cleanup → 403') : fail('cleanup', `got ${vCleanup.status}`);

  const vShutdown = await postAs('/api/shutdown', {}, VIEWER_TOKEN);
  vShutdown.status === 403 ? ok('POST /api/shutdown → 403') : fail('shutdown', `got ${vShutdown.status}`);

  // Vault: 503 when vault is not configured (KARVI_VAULT_KEY unset), 403 when vault is enabled but role insufficient
  const vVault = await postAs('/api/vault/store', { userId: 'u', keyName: 'k', value: 'v' }, VIEWER_TOKEN);
  (vVault.status === 403 || vVault.status === 503) ? ok(`POST /api/vault/store → ${vVault.status}`) : fail('vault store', `got ${vVault.status}`);

  // --- Operator ---
  console.log('\nOperator:');
  const oBoard = await getAs('/api/board', OPERATOR_TOKEN);
  oBoard.status === 200 ? ok('GET /api/board → 200') : fail('GET /api/board', `got ${oBoard.status}`);

  const oCtrlPost = await postAs('/api/controls', { auto_dispatch: false }, OPERATOR_TOKEN);
  oCtrlPost.status === 403 ? ok('POST /api/controls → 403') : fail('POST /api/controls', `got ${oCtrlPost.status}`);

  // Operator can cancel (404 = role check passed, task not found)
  const oCancel = await postAs('/api/tasks/fake/cancel', {}, OPERATOR_TOKEN);
  oCancel.status === 404 ? ok('POST /api/tasks/:id/cancel → 404 (role passed)') : fail('cancel', `got ${oCancel.status}`);

  const oStatus = await postAs('/api/tasks/fake/status', { status: 'completed' }, OPERATOR_TOKEN);
  oStatus.status === 404 ? ok('POST /api/tasks/:id/status → 404 (role passed)') : fail('status', `got ${oStatus.status}`);

  // Operator cannot delete (admin only)
  const oDelete = await deleteAs('/api/tasks/fake', OPERATOR_TOKEN);
  oDelete.status === 403 ? ok('DELETE /api/tasks/:id → 403') : fail('delete', `got ${oDelete.status}`);

  const oCleanup = await postAs('/api/tasks/cleanup', {}, OPERATOR_TOKEN);
  oCleanup.status === 403 ? ok('POST /api/tasks/cleanup → 403') : fail('cleanup', `got ${oCleanup.status}`);

  const oShutdown = await postAs('/api/shutdown', {}, OPERATOR_TOKEN);
  oShutdown.status === 403 ? ok('POST /api/shutdown → 403') : fail('shutdown', `got ${oShutdown.status}`);

  const oVault = await postAs('/api/vault/store', { userId: 'u', keyName: 'k', value: 'v' }, OPERATOR_TOKEN);
  (oVault.status === 403 || oVault.status === 503) ? ok(`POST /api/vault/store → ${oVault.status}`) : fail('vault store', `got ${oVault.status}`);

  // --- Admin ---
  console.log('\nAdmin:');
  const aBoard = await getAs('/api/board', ADMIN_TOKEN);
  aBoard.status === 200 ? ok('GET /api/board → 200') : fail('GET /api/board', `got ${aBoard.status}`);

  const aCtrlPost = await postAs('/api/controls', { auto_dispatch: false }, ADMIN_TOKEN);
  aCtrlPost.status === 200 ? ok('POST /api/controls → 200') : fail('POST /api/controls', `got ${aCtrlPost.status}`);

  // Admin can delete (404 = role check passed, task not found)
  const aDelete = await deleteAs('/api/tasks/fake', ADMIN_TOKEN);
  aDelete.status === 404 ? ok('DELETE /api/tasks/:id → 404 (role passed)') : fail('delete', `got ${aDelete.status}`);

  const aCancel = await postAs('/api/tasks/fake/cancel', {}, ADMIN_TOKEN);
  aCancel.status === 404 ? ok('POST /api/tasks/:id/cancel → 404 (role passed)') : fail('cancel', `got ${aCancel.status}`);

  console.log('\n=== Done ===');
  stopServer();
}

main().catch(err => { console.error('Fatal:', err.message); stopServer(); process.exit(1); });
