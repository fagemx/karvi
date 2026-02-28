#!/usr/bin/env node
/**
 * smoke-test.js — Shared smoke test for Blackboard apps
 *
 * Tests any app built on blackboard-server.js:
 *   1. GET  /api/board      → 200 + valid JSON
 *   2. POST /api/board      → 200 (patch)
 *   3. GET  /api/events     → SSE stream opens
 *   4. GET  /               → 200 (static index.html)
 *   5. Domain route (custom) → 200
 *
 * Usage:
 *   node smoke-test.js 3461                         # task-engine
 *   node smoke-test.js 3456                         # brief-panel
 *   node smoke-test.js 3461 /api/controls           # custom domain route
 *   node smoke-test.js 3461 --token my-secret       # with auth token
 *   node smoke-test.js 3461 /api/controls 3456 /api/brief   # both at once
 */
const http = require('http');

const args = process.argv.slice(2);
const targets = [];
let authToken = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--token' && args[i + 1]) {
    authToken = args[++i];
    continue;
  }
  const port = Number(args[i]);
  if (port > 0) {
    const domainRoute = args[i + 1] && !Number(args[i + 1]) && args[i + 1] !== '--token' ? args[++i] : null;
    targets.push({ port, domainRoute });
  }
}

if (targets.length === 0) {
  targets.push({ port: 3461, domainRoute: '/api/controls' });
  targets.push({ port: 3456, domainRoute: '/api/brief' });
}

function get(port, urlPath, { token = authToken, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout ${urlPath}`)), timeout);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.get({ hostname: 'localhost', port, path: urlPath, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function post(port, urlPath, payload, { token = authToken, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const timer = setTimeout(() => reject(new Error(`Timeout ${urlPath}`)), timeout);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method: 'POST', headers,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end(data);
  });
}

function sseProbe(port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const sseUrl = authToken
      ? `/api/events?token=${encodeURIComponent(authToken)}`
      : '/api/events';
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('SSE timeout — no connected event'));
    }, timeout);
    const req = http.get(`http://localhost:${port}${sseUrl}`, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        if (buf.includes('event: connected')) {
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode, received: buf.trim() });
        }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function runSuite(target) {
  const { port, domainRoute } = target;
  const label = `localhost:${port}`;
  let passed = 0;
  let failed = 0;

  function ok(name) { passed++; console.log(`  ✅ ${name}`); }
  function fail(name, err) { failed++; console.log(`  ❌ ${name}: ${err || '(unknown error)'}`); }

  console.log(`\n━━━ ${label} ━━━`);
  if (authToken) console.log(`  (auth token: ${authToken.slice(0, 4)}...)`);

  // 1. GET /api/board
  try {
    const r = await get(port, '/api/board');
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    JSON.parse(r.body);
    ok('GET /api/board → 200 + valid JSON');
  } catch (e) { fail('GET /api/board', e.message); }

  // 2. POST /api/board (patch — adds _smokeTest key, then verifies it merged)
  try {
    const before = JSON.parse((await get(port, '/api/board')).body);
    const r = await post(port, '/api/board', { _smokeTest: Date.now() });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const after = JSON.parse((await get(port, '/api/board')).body);
    if (!after._smokeTest) throw new Error('patch did not merge _smokeTest');
    ok('POST /api/board → 200 (patch merged)');
  } catch (e) { fail('POST /api/board', e.message); }

  // 3. SSE /api/events
  try {
    const r = await sseProbe(port);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (!r.received.includes('connected')) throw new Error('no connected event');
    ok('GET /api/events → SSE connected');
  } catch (e) { fail('GET /api/events (SSE)', e.message); }

  // 4. GET / (static index.html)
  try {
    const r = await get(port, '/', { token: null }); // static files never need token
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (!r.body.includes('<html') && !r.body.includes('<!doctype') && !r.body.includes('<!DOCTYPE')) {
      throw new Error('response does not look like HTML');
    }
    ok('GET / → 200 (index.html)');
  } catch (e) { fail('GET / (static)', e.message); }

  // 5. Domain route (if specified)
  if (domainRoute) {
    try {
      const r = await get(port, domainRoute);
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      ok(`GET ${domainRoute} → 200 (domain route)`);
    } catch (e) { fail(`GET ${domainRoute} (domain)`, e.message); }
  }

  // 6. CORS headers
  try {
    const r = await get(port, '/api/board');
    const cors = r.headers['access-control-allow-origin'];
    if (cors !== '*') throw new Error(`CORS header: ${cors}`);
    const allowHeaders = r.headers['access-control-allow-headers'] || '';
    if (!allowHeaders.includes('Authorization')) throw new Error(`Allow-Headers missing Authorization: ${allowHeaders}`);
    ok('CORS → Access-Control-Allow-Origin: * + Authorization header');
  } catch (e) { fail('CORS', e.message); }

  // 7-10. Evolution API checks (task-engine only)
  if (port === 3461) {
    try {
      const r = await get(port, '/api/signals');
      const arr = JSON.parse(r.body);
      if (!Array.isArray(arr)) throw new Error('signals should be array');
      ok('GET /api/signals → array');
    } catch (e) { fail('GET /api/signals', e.message); }

    try {
      const r = await post(port, '/api/signals', { by: 'smoke-test', type: 'test', content: 'smoke test signal' });
      const res = JSON.parse(r.body);
      if (res.ok !== true) throw new Error('should return ok');
      if (!res.signal || !res.signal.id) throw new Error('should return signal with id');
      ok('POST /api/signals → 201 + signal.id');
    } catch (e) { fail('POST /api/signals', e.message); }

    try {
      const r = await post(port, '/api/insights', {
        by: 'smoke-test', judgement: 'smoke test insight',
        suggestedAction: { type: 'noop', payload: {} }, risk: 'low',
      });
      const res = JSON.parse(r.body);
      if (res.ok !== true) throw new Error('should return ok');
      const allR = await get(port, '/api/insights');
      const all = JSON.parse(allR.body);
      if (!all.some(i => i.by === 'smoke-test')) throw new Error('should contain smoke test insight');
      ok('POST + GET /api/insights → ok');
    } catch (e) { fail('POST + GET /api/insights', e.message); }

    try {
      const r = await post(port, '/api/lessons', { by: 'smoke-test', rule: 'smoke test lesson' });
      const res = JSON.parse(r.body);
      if (res.ok !== true) throw new Error('should return ok');
      const allR = await get(port, '/api/lessons');
      const all = JSON.parse(allR.body);
      if (!all.some(l => l.by === 'smoke-test')) throw new Error('should contain smoke test lesson');
      ok('POST + GET /api/lessons → ok');
    } catch (e) { fail('POST + GET /api/lessons', e.message); }
  }

  // Auth-specific tests (only when --token is provided)
  if (authToken) {
    console.log('\n  ── Auth tests ──');

    // 11. No token → 401
    try {
      const r = await get(port, '/api/board', { token: null });
      if (r.status === 401) {
        ok('No token → 401');
      } else {
        fail('No token → 401', `got status ${r.status} (auth may not be enabled on server)`);
      }
    } catch (e) { fail('No token → 401', e.message); }

    // 12. Wrong token → 401
    try {
      const r = await get(port, '/api/board', { token: 'wrong-token-xxx' });
      if (r.status === 401) {
        ok('Wrong token → 401');
      } else {
        fail('Wrong token → 401', `got status ${r.status}`);
      }
    } catch (e) { fail('Wrong token → 401', e.message); }

    // 13. Static files without token → 200
    try {
      const r = await get(port, '/', { token: null });
      if (r.status === 200) {
        ok('Static file without token → 200');
      } else {
        fail('Static file without token → 200', `got status ${r.status}`);
      }
    } catch (e) { fail('Static file without token → 200', e.message); }
  }

  console.log(`  ── ${passed} passed, ${failed} failed ──`);
  return { passed, failed };
}

async function main() {
  console.log('Blackboard Smoke Test');
  console.log(`Testing ${targets.length} target(s)...`);

  let totalPassed = 0;
  let totalFailed = 0;

  for (const t of targets) {
    try {
      const { passed, failed } = await runSuite(t);
      totalPassed += passed;
      totalFailed += failed;
    } catch (e) {
      console.log(`\n━━━ localhost:${t.port} ━━━`);
      console.log(`  ❌ UNREACHABLE: ${e.message}`);
      console.log('  (Is the server running?)');
      totalFailed++;
    }
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
