#!/usr/bin/env node
/**
 * test-rbac-legacy.js — Verify backward compatibility with single KARVI_API_TOKEN
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT) || 13473;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-rbac-legacy-'));
const LEGACY_TOKEN = 'test-legacy-token-343';

let serverProc = null;

function getAs(urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    http.get({ hostname: 'localhost', port: PORT, path: urlPath, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode })); })
      .on('error', reject);
  });
}

function postAs(urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method: 'POST', headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject);
    req.end(data);
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
        KARVI_API_TOKEN: LEGACY_TOKEN,
        KARVI_API_TOKEN_ADMIN: '',
        KARVI_API_TOKEN_OPERATOR: '',
        KARVI_API_TOKEN_VIEWER: '',
      },
    });
    let started = false;
    proc.stdout.on('data', (data) => {
      if (!started && data.toString().includes('running at')) { started = true; resolve(proc); }
    });
    proc.stderr.on('data', (data) => {
      if (!started) process.stderr.write('[server] ' + data.toString());
    });
    const timer = setTimeout(() => { if (!started) { proc.kill(); reject(new Error('timeout')); } }, 10000);
    proc.on('exit', (code) => { if (!started) { clearTimeout(timer); reject(new Error(`exit ${code}`)); } });
  });
}

async function main() {
  console.log('Starting legacy-token server...');
  serverProc = await startServer();
  console.log(`Server started on port ${PORT}\n`);

  console.log('=== Legacy Token Backward Compatibility ===\n');

  const noToken = await getAs('/api/board', null);
  noToken.status === 401 ? ok('No token → 401') : fail('No token', `got ${noToken.status}`);

  const withToken = await getAs('/api/board', LEGACY_TOKEN);
  withToken.status === 200 ? ok('Legacy token → 200 (admin)') : fail('Legacy token read', `got ${withToken.status}`);

  // Legacy token should have admin privileges
  const ctrlWrite = await postAs('/api/controls', { auto_dispatch: false }, LEGACY_TOKEN);
  ctrlWrite.status === 200 ? ok('Legacy token can POST /api/controls (admin)') : fail('controls write', `got ${ctrlWrite.status}`);

  console.log('\n=== Done ===');
  serverProc.kill();
}

main().catch(err => { console.error('Fatal:', err.message); if (serverProc) serverProc.kill(); process.exit(1); });
