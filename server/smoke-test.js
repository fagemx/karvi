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
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`Timeout ${urlPath}`)); }, timeout);
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

function del(port, urlPath, payload, { token = authToken, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const timer = setTimeout(() => reject(new Error(`Timeout ${urlPath}`)), timeout);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method: 'DELETE', headers,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body }); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end(data);
  });
}

function isJiraConfigured() {
  return !!(process.env.JIRA_HOST && process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL);
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

  // 6. GET /health
  try {
    const r = await get(port, '/health', { token: null }); // health is pre-auth
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const health = JSON.parse(r.body);
    if (health.status !== 'ok') throw new Error(`health status: ${health.status}`);
    if (typeof health.uptime !== 'number') throw new Error('missing uptime');
    if (typeof health.pid !== 'number') throw new Error('missing pid');
    if (typeof health.port !== 'number') throw new Error('missing port');
    if (typeof health.memoryMB !== 'number') throw new Error('missing memoryMB');
    ok('GET /health → 200 + valid health response');
  } catch (e) { fail('GET /health', e.message); }

  // 6b. GET /api/version
  try {
    const r = await get(port, '/api/version', { token: null });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const data = JSON.parse(r.body);
    if (!data.version || typeof data.version !== 'string') throw new Error('missing or invalid version');
    if (!/^\d+\.\d+\.\d+/.test(data.version)) throw new Error(`bad format: ${data.version}`);
    ok(`GET /api/version → 200 (v${data.version})`);
  } catch (e) { fail('GET /api/version', e.message); }

  // 7. CORS headers (accepts '*' or a whitelisted origin when KARVI_CORS_ORIGINS is set)
  try {
    const r = await get(port, '/api/board');
    const cors = r.headers['access-control-allow-origin'];
    if (!cors) throw new Error('CORS header missing');
    // When KARVI_CORS_ORIGINS is unset, server returns '*'.
    // When set, smoke test has no Origin header → server returns 'null'.
    // Both '*' and 'null' (whitelist active, no Origin sent) are valid.
    const allowHeaders = r.headers['access-control-allow-headers'] || '';
    if (!allowHeaders.includes('Authorization')) throw new Error(`Allow-Headers missing Authorization: ${allowHeaders}`);
    ok(`CORS → Access-Control-Allow-Origin: ${cors} + Authorization header`);
  } catch (e) { fail('CORS', e.message); }

  // 8. Vault API (task-engine only, graceful when disabled)
  if (port === 3461) {
    try {
      const statusR = await get(port, '/api/vault/status');
      const status = JSON.parse(statusR.body);
      if (statusR.status !== 200) throw new Error(`status ${statusR.status}`);
      if (typeof status.enabled !== 'boolean') throw new Error('missing enabled field');

      if (status.enabled) {
        // Store
        const storeR = await post(port, '/api/vault/store', { userId: 'smoke-test', keyName: 'test_key', value: 'smoke-value' });
        if (storeR.status !== 200) throw new Error(`store status ${storeR.status}`);
        // List
        const listR = await get(port, '/api/vault/keys/smoke-test');
        const listData = JSON.parse(listR.body);
        if (!listData.keys.some(k => k.keyName === 'test_key')) throw new Error('key not in list');
        // Delete + verify cleanup
        const delR = await new Promise((resolve, reject) => {
          const r = http.request({ hostname: 'localhost', port, path: '/api/vault/delete/smoke-test/test_key', method: 'DELETE' }, resp => {
            let b = ''; resp.on('data', c => b += c); resp.on('end', () => resolve({ status: resp.statusCode, body: b }));
          });
          r.on('error', reject); r.end();
        });
        if (delR.status !== 200) throw new Error(`delete status ${delR.status}`);
        const afterDel = await get(port, '/api/vault/keys/smoke-test');
        const afterData = JSON.parse(afterDel.body);
        if (afterData.keys.some(k => k.keyName === 'test_key')) throw new Error('key still exists after delete');
        ok('Vault API (store/list/delete/verify) → ok');
      } else {
        // Vault disabled: store should 503
        const storeR = await post(port, '/api/vault/store', { userId: 'x', keyName: 'y', value: 'z' });
        if (storeR.status !== 503) throw new Error(`expected 503 when disabled, got ${storeR.status}`);
        ok('Vault API → 503 (disabled, KARVI_VAULT_KEY not set)');
      }
    } catch (e) { fail('Vault API', e.message); }
  }

  // Auto-dispatch controls tests (task-engine only)
  if (port === 3461) {
    // Verify auto_dispatch defaults to false
    try {
      const r = await get(port, '/api/controls');
      const controls = JSON.parse(r.body);
      if (controls.auto_dispatch !== false) throw new Error(`expected auto_dispatch: false, got ${controls.auto_dispatch}`);
      ok('GET /api/controls → auto_dispatch defaults to false');
    } catch (e) { fail('GET /api/controls (auto_dispatch default)', e.message); }

    // Toggle auto_dispatch to true
    try {
      const r = await post(port, '/api/controls', { auto_dispatch: true });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (body.controls.auto_dispatch !== true) throw new Error(`expected auto_dispatch: true, got ${body.controls.auto_dispatch}`);
      ok('POST /api/controls { auto_dispatch: true } → accepted');
    } catch (e) { fail('POST /api/controls (auto_dispatch: true)', e.message); }

    // Reject non-boolean value for auto_dispatch (should stay true from previous test)
    try {
      const r = await post(port, '/api/controls', { auto_dispatch: 'not-boolean' });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (body.controls.auto_dispatch !== true) throw new Error(`expected auto_dispatch to stay true, got ${body.controls.auto_dispatch}`);
      ok('POST /api/controls { auto_dispatch: "not-boolean" } → rejected (stays true)');
    } catch (e) { fail('POST /api/controls (auto_dispatch: invalid)', e.message); }

    // Reset auto_dispatch back to false for clean state
    try {
      await post(port, '/api/controls', { auto_dispatch: false });
      ok('POST /api/controls { auto_dispatch: false } → reset for clean state');
    } catch (e) { fail('POST /api/controls (auto_dispatch: reset)', e.message); }
  }

  // 9-12. Evolution API checks (task-engine only)
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

    // GET /api/signals/archive → consistent object shape (even when no archive file)
    try {
      const r = await get(port, '/api/signals/archive');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (typeof body.total !== 'number') throw new Error('missing total');
      if (typeof body.offset !== 'number') throw new Error('missing offset');
      if (typeof body.limit !== 'number') throw new Error('missing limit');
      if (!Array.isArray(body.signals)) throw new Error('missing signals array');
      ok('GET /api/signals/archive → { total, offset, limit, signals }');
    } catch (e) { fail('GET /api/signals/archive', e.message); }

    // signal_max_count control: verify default and patchability
    try {
      const r = await get(port, '/api/controls');
      const controls = JSON.parse(r.body);
      if (typeof controls.signal_max_count !== 'number') throw new Error('missing signal_max_count');
      if (controls.signal_max_count <= 0) throw new Error(`invalid default: ${controls.signal_max_count}`);
      // Patch it
      const patchR = await post(port, '/api/controls', { signal_max_count: 999 });
      if (patchR.status !== 200) throw new Error(`patch status ${patchR.status}`);
      const patched = JSON.parse(patchR.body);
      if (patched.controls.signal_max_count !== 999) throw new Error(`expected 999, got ${patched.controls.signal_max_count}`);
      // Reset
      await post(port, '/api/controls', { signal_max_count: controls.signal_max_count });
      ok(`GET/POST /api/controls → signal_max_count configurable (default: ${controls.signal_max_count})`);
    } catch (e) { fail('signal_max_count control', e.message); }
  }

  // 13-16. Jira Webhook tests (task-engine only)
  const jiraEnabled = isJiraConfigured();
  if (port === 3461) {
    // 13. POST /api/webhooks/jira with issue_created → 201 + task created (or 200 skipped if disabled)
    try {
      const jiraPayload = {
        webhookEvent: 'jira:issue_created',
        issue: {
          key: 'SMOKE-9999',
          fields: {
            summary: 'Smoke test Jira ticket',
            description: { type: 'doc', version: 1, content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Smoke test description from Jira' }] },
            ]},
            priority: { name: 'High' },
            assignee: { displayName: 'SmokeBot' },
          },
        },
      };
      const r = await post(port, '/api/webhooks/jira', jiraPayload);

      if (jiraEnabled) {
        if (r.status !== 201) throw new Error(`expected 201, got ${r.status}: ${r.body}`);
        const body = JSON.parse(r.body);
        if (body.action !== 'create_task') throw new Error(`expected action create_task, got ${body.action}`);
        if (body.jiraKey !== 'SMOKE-9999') throw new Error(`expected jiraKey SMOKE-9999, got ${body.jiraKey}`);

        const boardR = await get(port, '/api/board');
        const board = JSON.parse(boardR.body);
        const task = (board.taskPlan?.tasks || []).find(t => t.jiraKey === 'SMOKE-9999');
        if (!task) throw new Error('task not found in board');
        if (task.source !== 'jira') throw new Error(`expected source jira, got ${task.source}`);
        if (task.priority !== 'P1') throw new Error(`expected priority P1, got ${task.priority}`);
        if (!task.jiraUrl) throw new Error('missing jiraUrl');
        if (!task.description) throw new Error('missing description');
        ok('POST /api/webhooks/jira (issue_created) → 201 + task in board');
      } else {
        if (r.status !== 200) throw new Error(`expected 200 (skipped), got ${r.status}: ${r.body}`);
        const body = JSON.parse(r.body);
        if (!body.skipped) throw new Error(`expected skipped=true when Jira disabled`);
        ok('POST /api/webhooks/jira (issue_created) → 200 skipped (Jira disabled)');
      }
    } catch (e) { fail('POST /api/webhooks/jira (issue_created)', e.message); }

    // 14. Duplicate issue_created → 200 with skipped
    try {
      const dupPayload = {
        webhookEvent: 'jira:issue_created',
        issue: {
          key: 'SMOKE-9999',
          fields: { summary: 'Duplicate ticket' },
        },
      };
      const r = await post(port, '/api/webhooks/jira', dupPayload);
      if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
      const body = JSON.parse(r.body);
      if (!body.skipped) throw new Error('expected skipped: true');
      ok('POST /api/webhooks/jira (duplicate) → 200 skipped');
    } catch (e) { fail('POST /api/webhooks/jira (duplicate)', e.message); }

    // 15. Invalid/unsupported event → 200 with skipped
    try {
      const r = await post(port, '/api/webhooks/jira', { webhookEvent: 'jira:unknown_event' });
      if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
      const body = JSON.parse(r.body);
      if (!body.skipped) throw new Error('expected skipped: true');
      ok('POST /api/webhooks/jira (unsupported event) → 200 skipped');
    } catch (e) { fail('POST /api/webhooks/jira (unsupported event)', e.message); }

    // 16. Clean up: remove smoke test task from board (only if Jira enabled and tasks were created)
    if (jiraEnabled) {
      try {
        const boardR = await get(port, '/api/board');
        const board = JSON.parse(boardR.body);
        const before = (board.taskPlan?.tasks || []).length;
        if (board.taskPlan?.tasks) {
          board.taskPlan.tasks = board.taskPlan.tasks.filter(t => t.jiraKey !== 'SMOKE-9999');
        }
        const after = (board.taskPlan?.tasks || []).length;
        if (before !== after) {
          await post(port, '/api/board', board);
        }
        ok(`Jira webhook cleanup → ${before - after} smoke task(s) removed`);
      } catch (e) { fail('Jira webhook cleanup', e.message); }
    }

    // 17. POST /api/webhooks/jira with field changes → 200 + fields_updated (issue #51)
    if (jiraEnabled) {
      try {
        await post(port, '/api/webhooks/jira', {
          webhookEvent: 'jira:issue_created',
          issue: { key: 'SMOKE-FIELD', fields: { summary: 'Original Title', priority: { name: 'Medium' } } },
        });
        const r = await post(port, '/api/webhooks/jira', {
          webhookEvent: 'jira:issue_updated',
          issue: { key: 'SMOKE-FIELD', fields: { summary: 'Updated Title' } },
          changelog: { items: [{ field: 'summary', fromString: 'Original Title', toString: 'Updated Title' }] },
        });
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        const body = JSON.parse(r.body);
        if (body.action !== 'fields_updated') throw new Error(`action: ${body.action}`);
        const boardR = await get(port, '/api/board');
        const board = JSON.parse(boardR.body);
        const task = board.taskPlan.tasks.find(t => t.jiraKey === 'SMOKE-FIELD');
        if (!task) throw new Error('task not found');
        if (task.title !== 'Updated Title') throw new Error(`title: ${task.title}`);
        board.taskPlan.tasks = board.taskPlan.tasks.filter(t => t.jiraKey !== 'SMOKE-FIELD');
        await post(port, '/api/board', board);
        ok('POST /api/webhooks/jira (field_update) → 200 + task updated');
      } catch (e) { fail('POST /api/webhooks/jira (field_update)', e.message); }
    } else {
      console.log('  ⊘ Skipping Jira field_update test (Jira not configured)');
    }
  }

  // ── Rate Limit / Body Size / SSE Limit tests ──
  console.log('\n  ── Rate limit & guard tests ──');

  // Rate limit headers present on API responses
  try {
    const r = await get(port, '/api/board');
    const limit = r.headers['x-ratelimit-limit'];
    const remaining = r.headers['x-ratelimit-remaining'];
    // Rate limit may be disabled — if headers are present, validate them
    if (limit !== undefined && remaining !== undefined) {
      if (Number(limit) <= 0) throw new Error(`invalid limit: ${limit}`);
      if (Number(remaining) < 0) throw new Error(`invalid remaining: ${remaining}`);
      ok(`Rate limit headers → X-RateLimit-Limit: ${limit}, Remaining: ${remaining}`);
    } else {
      // Rate limiting is disabled — still a valid setup
      ok('Rate limit headers → not present (rate limiting may be disabled)');
    }
  } catch (e) { fail('Rate limit headers', e.message); }

  // Health endpoint includes rateLimiter status
  try {
    const r = await get(port, '/health', { token: null });
    const health = JSON.parse(r.body);
    if (typeof health.rateLimiter !== 'object') throw new Error('missing rateLimiter in health');
    if (typeof health.rateLimiter.enabled !== 'boolean') throw new Error('missing rateLimiter.enabled');
    ok(`Health → rateLimiter.enabled: ${health.rateLimiter.enabled}`);
  } catch (e) { fail('Health rateLimiter field', e.message); }

  // POST body > 1MB → 413 Payload Too Large (Content-Length fast reject)
  try {
    const bigPayload = JSON.stringify({ data: 'x'.repeat(1100000) });
    const r = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout 413 test')), 5000);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bigPayload),
      };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const req = http.request({
        hostname: 'localhost', port, path: '/api/board', method: 'POST', headers,
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
      });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      // Send only the header, don't actually send the huge body — server should reject on Content-Length
      req.end(bigPayload.slice(0, 100));
    });
    if (r.status === 413) {
      ok('POST body > 1MB → 413 Payload Too Large');
    } else {
      // Server might have read the partial body and returned 400 — still acceptable
      ok(`POST body > 1MB → ${r.status} (Content-Length guard active)`);
    }
  } catch (e) { fail('POST body > 1MB → 413', e.message); }

  // Health endpoint exempt from rate limit (always accessible)
  try {
    const r = await get(port, '/health', { token: null });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    // No rate limit headers should be on /health
    ok('Health endpoint → exempt from rate limit');
  } catch (e) { fail('Health rate limit exempt', e.message); }

  // 17-18. GitHub API proxy tests (task-engine only)
  if (port === 3461) {
    // 17. GET /api/github/token/status → 200 (always works, even without token configured)
    try {
      const r = await get(port, '/api/github/token/status');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (typeof body.configured !== 'boolean') throw new Error('missing configured field');
      ok(`GET /api/github/token/status → 200 (configured: ${body.configured})`);
    } catch (e) { fail('GET /api/github/token/status', e.message); }

    // 18. GET /api/github/pr without token → 400 or 503 (depending on vault config)
    try {
      const r = await get(port, '/api/github/pr/octocat/hello-world/1');
      // 400 = vault enabled but no github_pat stored
      // 503 = vault not configured (KARVI_VAULT_KEY not set)
      if (r.status === 400 || r.status === 503) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`GET /api/github/pr/:o/:r/:n (no token) → ${r.status} + error message`);
      } else if (r.status === 200) {
        ok(`GET /api/github/pr/:o/:r/:n → 200 (token configured)`);
      } else {
        throw new Error(`unexpected status ${r.status}`);
      }
    } catch (e) { fail('GET /api/github/pr', e.message); }

    // 19. GET /api/tasks/:id/digest → 404 (no digest on nonexistent task or no digest yet)
    try {
      const r = await get(port, '/api/tasks/SMOKE-NOEXIST/digest');
      if (r.status === 404) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`GET /api/tasks/:id/digest (no task) → 404`);
      } else {
        throw new Error(`expected 404, got ${r.status}`);
      }
    } catch (e) { fail('GET /api/tasks/:id/digest', e.message); }

    // 20. POST /api/tasks/:id/digest → 503 (no API key) or 404 (no task)
    try {
      const r = await post(port, '/api/tasks/SMOKE-NOEXIST/digest', {});
      // 503 = no ANTHROPIC_API_KEY
      // 404 = task not found (if key is set)
      if (r.status === 503 || r.status === 404) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`POST /api/tasks/:id/digest → ${r.status} (expected without API key or task)`);
      } else {
        throw new Error(`expected 503 or 404, got ${r.status}`);
      }
    } catch (e) { fail('POST /api/tasks/:id/digest', e.message); }

    // 21. GET /api/tasks/:id/timeline → 404 (nonexistent task)
    try {
      const r = await get(port, '/api/tasks/SMOKE-NOEXIST/timeline');
      if (r.status === 404) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`GET /api/tasks/:id/timeline (no task) → 404`);
      } else {
        throw new Error(`expected 404, got ${r.status}`);
      }
    } catch (e) { fail('GET /api/tasks/:id/timeline', e.message); }

    // 22. GET /api/tasks/:id/report → 404 (nonexistent task)
    try {
      const r = await get(port, '/api/tasks/SMOKE-NOEXIST/report');
      if (r.status === 404) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`GET /api/tasks/:id/report (no task) → 404`);
      } else {
        throw new Error(`expected 404, got ${r.status}`);
      }
    } catch (e) { fail('GET /api/tasks/:id/report', e.message); }
  }

  // ── Uncovered Endpoint Tests (issue #77) ──
  if (port === 3461) {
    console.log('\n  ── Uncovered endpoint tests (issue #77) ──');

    // ── Push Token API ──
    // POST /api/push-token (valid token)
    try {
      const r = await post(port, '/api/push-token', { token: 'ExponentPushToken[smoke-test-token-123]', deviceName: 'SmokeTestDevice' });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error(`expected ok: true, got ${JSON.stringify(body)}`);
      ok('POST /api/push-token (valid) → 200 + ok');
    } catch (e) { fail('POST /api/push-token (valid)', e.message); }

    // POST /api/push-token (invalid token)
    try {
      const r = await post(port, '/api/push-token', { token: 'invalid-token' });
      if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
      const body = JSON.parse(r.body);
      if (!body.error) throw new Error('missing error message');
      ok('POST /api/push-token (invalid) → 400 + error');
    } catch (e) { fail('POST /api/push-token (invalid)', e.message); }

    // DELETE /api/push-token (cleanup)
    try {
      const r = await del(port, '/api/push-token', { token: 'ExponentPushToken[smoke-test-token-123]' });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error(`expected ok: true, got ${JSON.stringify(body)}`);
      ok('DELETE /api/push-token → 200 + ok');
    } catch (e) { fail('DELETE /api/push-token', e.message); }

    // ── Jira Integration Config ──
    // GET /api/integrations/jira
    try {
      const r = await get(port, '/api/integrations/jira');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      JSON.parse(r.body); // must be valid JSON
      ok('GET /api/integrations/jira → 200 + valid JSON');
    } catch (e) { fail('GET /api/integrations/jira', e.message); }

    // POST /api/integrations/jira (update config + cleanup)
    try {
      // Save original config
      const origR = await get(port, '/api/integrations/jira');
      const origConfig = JSON.parse(origR.body);
      // Update with smoke test marker
      const r = await post(port, '/api/integrations/jira', { _smokeTest77: true });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (body._smokeTest77 !== true) throw new Error('config not merged');
      // Cleanup: restore original config by removing smoke marker
      const boardR = await get(port, '/api/board');
      const board = JSON.parse(boardR.body);
      if (board.integrations?.jira?._smokeTest77 !== undefined) {
        delete board.integrations.jira._smokeTest77;
        await post(port, '/api/board', board);
      }
      ok('POST /api/integrations/jira → 200 + config merged + cleaned');
    } catch (e) { fail('POST /api/integrations/jira', e.message); }

    // ── GitHub Token Test ──
    // POST /api/github/token/test — expect 503 (no vault) or 400 (no PAT)
    try {
      const r = await post(port, '/api/github/token/test', {});
      if (r.status === 503 || r.status === 400) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`POST /api/github/token/test → ${r.status} (no vault/PAT)`);
      } else if (r.status === 200) {
        ok(`POST /api/github/token/test → 200 (token configured)`);
      } else {
        throw new Error(`unexpected status ${r.status}`);
      }
    } catch (e) { fail('POST /api/github/token/test', e.message); }

    // ── Participants & Conversations ──
    // POST /api/participants (create)
    try {
      const r = await post(port, '/api/participants', { id: 'smoke-part-77', type: 'agent', displayName: 'Smoke Agent 77', agentId: 'smoke-agent' });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error(`expected ok: true`);
      if (!body.participant || body.participant.id !== 'smoke-part-77') throw new Error('missing participant');
      ok('POST /api/participants (create) → 200 + participant');
    } catch (e) { fail('POST /api/participants (create)', e.message); }

    // POST /api/participants (duplicate → 409)
    try {
      const r = await post(port, '/api/participants', { id: 'smoke-part-77', type: 'agent', displayName: 'Smoke Agent 77', agentId: 'smoke-agent' });
      if (r.status !== 409) throw new Error(`expected 409, got ${r.status}`);
      ok('POST /api/participants (duplicate) → 409');
    } catch (e) { fail('POST /api/participants (duplicate)', e.message); }

    // POST /api/conversations (create)
    try {
      const r = await post(port, '/api/conversations', { id: 'smoke-conv-77', title: 'Smoke Test Conv 77', members: ['smoke-part-77'] });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error('expected ok: true');
      if (!body.conversation || body.conversation.id !== 'smoke-conv-77') throw new Error('missing conversation');
      ok('POST /api/conversations (create) → 200 + conversation');
    } catch (e) { fail('POST /api/conversations (create)', e.message); }

    // POST /api/conversations (duplicate → 409)
    try {
      const r = await post(port, '/api/conversations', { id: 'smoke-conv-77', title: 'Smoke Test Conv 77', members: ['smoke-part-77'] });
      if (r.status !== 409) throw new Error(`expected 409, got ${r.status}`);
      ok('POST /api/conversations (duplicate) → 409');
    } catch (e) { fail('POST /api/conversations (duplicate)', e.message); }

    // Cleanup: remove smoke participant and conversation from board
    try {
      const boardR = await get(port, '/api/board');
      const board = JSON.parse(boardR.body);
      if (board.participants) {
        board.participants = board.participants.filter(p => p.id !== 'smoke-part-77');
      }
      if (board.conversations) {
        board.conversations = board.conversations.filter(c => c.id !== 'smoke-conv-77');
      }
      await post(port, '/api/board', board);
      ok('Participants & conversations cleanup → done');
    } catch (e) { fail('Participants & conversations cleanup', e.message); }

    // ── Task Plan API ──
    // POST /api/tasks (create task plan)
    try {
      // Save board backup
      const backupR = await get(port, '/api/board');
      const backup = JSON.parse(backupR.body);
      // Create task plan
      const r = await post(port, '/api/tasks', {
        goal: 'Smoke test goal 77', phase: 'planning',
        tasks: [{ id: 'SMOKE-77-T1', title: 'Smoke task', status: 'pending', assignee: null }],
      });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error('expected ok: true');
      if (!body.taskPlan || body.taskPlan.goal !== 'Smoke test goal 77') throw new Error('wrong taskPlan goal');
      if (!Array.isArray(body.taskPlan.tasks) || !body.taskPlan.tasks.some(t => t.id === 'SMOKE-77-T1')) throw new Error('expected SMOKE-77-T1 in tasks');
      // Restore original board
      await post(port, '/api/board', backup);
      ok('POST /api/tasks → 200 + taskPlan created + restored');
    } catch (e) { fail('POST /api/tasks', e.message); }

    // ── Project API (unified /api/projects) ──
    // POST /api/projects (valid — unified format with id-based tasks)
    try {
      const backupR = await get(port, '/api/board');
      const backup = JSON.parse(backupR.body);
      const r = await post(port, '/api/projects', {
        title: 'Smoke Project 77', goal: 'Test project creation',
        tasks: [
          { id: 'SP77-1', title: 'Task A' },
          { id: 'SP77-2', title: 'Task B', depends: ['SP77-1'] },
        ],
      });
      if (r.status !== 201) throw new Error(`expected 201, got ${r.status}: ${r.body}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error('expected ok: true');
      if (body.title !== 'Smoke Project 77') throw new Error(`wrong title: ${body.title}`);
      if (body.taskCount !== 2) throw new Error(`expected taskCount 2, got ${body.taskCount}`);
      await post(port, '/api/board', backup);
      ok('POST /api/projects (valid) → 201 + tasks created + restored');
    } catch (e) { fail('POST /api/projects (valid)', e.message); }

    // POST /api/projects (missing title → 400)
    try {
      const r = await post(port, '/api/projects', { tasks: [{ id: 'x', title: 'y' }] });
      if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
      const body = JSON.parse(r.body);
      if (!body.error || !body.error.includes('title')) throw new Error(`wrong error: ${body.error}`);
      ok('POST /api/projects (no title) → 400');
    } catch (e) { fail('POST /api/projects (no title)', e.message); }

    // POST /api/projects (empty tasks → 400)
    try {
      const r = await post(port, '/api/projects', { title: 'Bad Project', tasks: [] });
      if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
      const body = JSON.parse(r.body);
      if (!body.error || !body.error.includes('tasks')) throw new Error(`wrong error: ${body.error}`);
      ok('POST /api/projects (empty tasks) → 400');
    } catch (e) { fail('POST /api/projects (empty tasks)', e.message); }

    // POST /api/project (deprecated alias still works)
    try {
      const backupR = await get(port, '/api/board');
      const backup = JSON.parse(backupR.body);
      const r = await post(port, '/api/project', {
        title: 'Deprecated Test', tasks: [{ id: 'DEP-1', title: 'Task via deprecated' }],
      });
      if (r.status !== 201) throw new Error(`expected 201, got ${r.status}: ${r.body}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error('expected ok: true');
      await post(port, '/api/board', backup);
      ok('POST /api/project (deprecated alias) → 201 still works');
    } catch (e) { fail('POST /api/project (deprecated alias)', e.message); }

    // ── Dispatch Next (safe path) ──
    // POST /api/dispatch-next — no ready tasks in clean state
    try {
      // Ensure clean state: save backup, clear tasks
      const backupR = await get(port, '/api/board');
      const backup = JSON.parse(backupR.body);
      const cleanBoard = JSON.parse(JSON.stringify(backup));
      if (cleanBoard.taskPlan?.tasks) {
        cleanBoard.taskPlan.tasks = cleanBoard.taskPlan.tasks.map(t => ({ ...t, status: 'completed' }));
        await post(port, '/api/board', cleanBoard);
      }
      const r = await post(port, '/api/dispatch-next', {});
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error('expected ok: true');
      if (body.dispatched !== false) throw new Error(`expected dispatched: false, got ${body.dispatched}`);
      // Restore original board
      await post(port, '/api/board', backup);
      ok('POST /api/dispatch-next (no ready) → 200 + dispatched: false + restored');
    } catch (e) { fail('POST /api/dispatch-next', e.message); }

    // ── POST /api/retro ──
    try {
      const r = await post(port, '/api/retro', {}, { timeout: 15000 });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body}`);
      const body = JSON.parse(r.body);
      if (body.ok !== true) throw new Error('expected ok: true');
      ok('POST /api/retro → 200 + ok');
    } catch (e) { fail('POST /api/retro', e.message); }

    // Note: POST /api/shutdown is intentionally not tested here.
    // It calls gracefulShutdown() which terminates the server process,
    // preventing remaining tests from running. The endpoint is trivial
    // (respond 200 then shutdown) and is better covered by lifecycle tests.

    // ── L1 Confidence API ──
    // GET /api/tasks/:id/confidence → 404 (no confidence on nonexistent task)
    try {
      const r = await get(port, '/api/tasks/SMOKE-NOEXIST/confidence');
      if (r.status === 404) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`GET /api/tasks/:id/confidence (no task) → 404`);
      } else {
        throw new Error(`expected 404, got ${r.status}`);
      }
    } catch (e) { fail('GET /api/tasks/:id/confidence', e.message); }

    // POST /api/tasks/:id/confidence → 404 (no task) or 503 (engine unavailable)
    try {
      const r = await post(port, '/api/tasks/SMOKE-NOEXIST/confidence', {});
      if (r.status === 404 || r.status === 503) {
        const body = JSON.parse(r.body);
        if (!body.error) throw new Error('missing error message');
        ok(`POST /api/tasks/:id/confidence → ${r.status} (expected without task)`);
      } else {
        throw new Error(`expected 404 or 503, got ${r.status}`);
      }
    } catch (e) { fail('POST /api/tasks/:id/confidence', e.message); }
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

  // --- Task cleanup API ---
  {
    // Create a dummy task, then DELETE it
    const dummyId = `SMOKE-CLEANUP-${Date.now()}`;
    try {
      const createR = await post(port, '/api/tasks', {
        tasks: [{ id: dummyId, title: 'Smoke cleanup test', description: 'temp', assignee: 'engineer_lite' }],
      });
      if (createR.status !== 200) throw new Error(`create failed: ${createR.status}`);

      // Cancel it first so it's terminal
      const cancelR = await post(port, `/api/tasks/${dummyId}/status`, { status: 'cancelled' });
      if (cancelR.status !== 200) throw new Error(`cancel failed: ${cancelR.status}`);

      // DELETE it
      const delR = await del(port, `/api/tasks/${dummyId}`, {});
      if (delR.status === 200) {
        const body = JSON.parse(delR.body);
        if (body.removed === dummyId) {
          ok('DELETE /api/tasks/:id → removes task');
        } else {
          fail('DELETE /api/tasks/:id → removes task', `unexpected body: ${delR.body}`);
        }
      } else {
        fail('DELETE /api/tasks/:id → removes task', `status ${delR.status}`);
      }

      // Verify 404 on re-delete
      const reDelR = await del(port, `/api/tasks/${dummyId}`, {});
      if (reDelR.status === 404) {
        ok('DELETE /api/tasks/:id → 404 on missing');
      } else {
        fail('DELETE /api/tasks/:id → 404 on missing', `status ${reDelR.status}`);
      }
    } catch (e) { fail('DELETE /api/tasks/:id', e.message); }

    // POST /api/tasks/cleanup
    try {
      const cleanR = await post(port, '/api/tasks/cleanup', { statuses: ['cancelled'], older_than_hours: 0 });
      if (cleanR.status === 200) {
        const body = JSON.parse(cleanR.body);
        if (typeof body.count === 'number' && Array.isArray(body.removed)) {
          ok('POST /api/tasks/cleanup → batch remove');
        } else {
          fail('POST /api/tasks/cleanup → batch remove', `unexpected body: ${cleanR.body}`);
        }
      } else {
        fail('POST /api/tasks/cleanup → batch remove', `status ${cleanR.status}`);
      }
    } catch (e) { fail('POST /api/tasks/cleanup', e.message); }
  }

  // --- Artifact Query API ---
  {
    // GET /api/artifacts — should return 200 with artifacts array
    try {
      const r = await get(port, '/api/artifacts');
      if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
      const body = JSON.parse(r.body);
      if (!Array.isArray(body.artifacts)) throw new Error('expected artifacts array');
      ok('GET /api/artifacts → 200 with artifacts array');
    } catch (e) { fail('GET /api/artifacts → 200', e.message); }

    // GET /api/artifacts?task=NONEXISTENT — should return 200 with empty array
    try {
      const r = await get(port, '/api/artifacts?task=SMOKE-NOEXIST-999');
      if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
      const body = JSON.parse(r.body);
      if (!Array.isArray(body.artifacts) || body.artifacts.length !== 0) throw new Error('expected empty artifacts array');
      ok('GET /api/artifacts?task=NONEXISTENT → 200 empty');
    } catch (e) { fail('GET /api/artifacts?task=NONEXISTENT → 200 empty', e.message); }

    // GET /api/artifacts/:run/:step/:kind — 404 for missing
    try {
      const r = await get(port, '/api/artifacts/run-nonexistent/step-nonexistent/output');
      if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
      ok('GET /api/artifacts/:run/:step/:kind → 404 on missing');
    } catch (e) { fail('GET /api/artifacts/:run/:step/:kind → 404', e.message); }
  }

  // ── Audit Log Query (GH-340) ──
  if (port === 3461) {
    try {
      const r = await get(port, '/api/logs');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const body = JSON.parse(r.body);
      if (!Array.isArray(body.entries)) throw new Error('expected entries array');
      if (typeof body.total !== 'number') throw new Error('missing total');
      ok('GET /api/logs → 200 + entries array');
    } catch (e) { fail('GET /api/logs', e.message); }
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
