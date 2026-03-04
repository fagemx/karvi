#!/usr/bin/env node
/**
 * test-status-endpoint.js — Unit tests for GET /api/status
 * 
 * Usage: node server/test-status-endpoint.js
 */
const assert = require('assert');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

function test(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ─────────────────────────────────────
// Mock Helpers
// ─────────────────────────────────────

function createMockHelpers(boardData) {
  return {
    readBoard: () => boardData,
    nowIso: () => '2025-01-15T10:30:00.000Z',
  };
}

function createMockResponse() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    writeHead: function(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    end: function(data) {
      this.body = data;
    },
    setHeader: function() {},
  };
  
  return res;
}

// ─────────────────────────────────────
// Test Data
// ─────────────────────────────────────

const EMPTY_BOARD = {};

const BOARD_WITH_TASK = {
  taskPlan: {
    tasks: [{
      id: 'T-00001',
      title: 'Test Task',
      status: 'in_progress',
      startedAt: '2025-01-15T09:00:00.000Z',
      steps: [
        { step_id: 'T-00001:plan', type: 'plan', state: 'succeeded', attempt: 1, duration_ms: 5000 },
        { step_id: 'T-00001:implement', type: 'implement', state: 'running', attempt: 1 },
      ],
      budget: {
        used: { tokens: 1000, wall_clock_ms: 60000, llm_calls: 2, steps: 2 }
      }
    }]
  },
  signals: [
    { ts: '2025-01-15T10:00:00.000Z', type: 'info', content: 'Task started' },
    { ts: '2025-01-15T10:15:00.000Z', type: 'error', content: 'Something failed', data: { taskId: 'T-00001' } },
  ]
};

// ─────────────────────────────────────
// Tests
// ─────────────────────────────────────

console.log('\n=== GET /api/status Endpoint Tests ===\n');

const statusRoutes = require('./routes/status');

test('Default response (no fields param) returns core fields', () => {
  const req = { method: 'GET', url: '/api/status' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  const handled = statusRoutes(req, res, helpers, {});
  
  assert.notStrictEqual(handled, false);
  const body = JSON.parse(res.body);
  assert.ok(body.instance_id);
  assert.ok(body.ts);
  assert.ok(body.core);
  assert.ok(body.core.summary);
  assert.ok(body.core.tasks);
  assert.strictEqual(body.core.summary.active, 1);
  assert.strictEqual(body.steps, undefined);
  assert.strictEqual(body.errors, undefined);
  assert.strictEqual(body.metrics, undefined);
});

test('?fields=core,steps includes step details', () => {
  const req = { method: 'GET', url: '/api/status?fields=core,steps' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  statusRoutes(req, res, helpers, {});
  
  const body = JSON.parse(res.body);
  assert.ok(body.core);
  assert.ok(body.steps);
  assert.ok(Array.isArray(body.steps));
  assert.strictEqual(body.steps.length, 2);
  assert.strictEqual(body.steps[0].task_id, 'T-00001');
  assert.strictEqual(body.steps[0].type, 'plan');
  assert.strictEqual(body.errors, undefined);
});

test('?fields=core,errors includes error entries', () => {
  const req = { method: 'GET', url: '/api/status?fields=core,errors' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  statusRoutes(req, res, helpers, {});
  
  const body = JSON.parse(res.body);
  assert.ok(body.core);
  assert.ok(body.errors);
  assert.ok(Array.isArray(body.errors));
  assert.ok(body.errors.length > 0);
  assert.ok(body.errors[0].ts);
  assert.ok(body.errors[0].message);
  assert.strictEqual(body.steps, undefined);
});

test('?fields=core,metrics includes budget/token stats', () => {
  const req = { method: 'GET', url: '/api/status?fields=core,metrics' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  statusRoutes(req, res, helpers, {});
  
  const body = JSON.parse(res.body);
  assert.ok(body.core);
  assert.ok(body.metrics);
  assert.strictEqual(body.metrics.total_tokens, 1000);
  assert.strictEqual(body.metrics.total_wall_clock_ms, 60000);
  assert.strictEqual(body.metrics.total_llm_calls, 2);
  assert.strictEqual(body.metrics.total_steps, 2);
  assert.strictEqual(body.steps, undefined);
});

test('?fields=all includes everything', () => {
  const req = { method: 'GET', url: '/api/status?fields=all' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  statusRoutes(req, res, helpers, {});
  
  const body = JSON.parse(res.body);
  assert.ok(body.core);
  assert.ok(body.steps);
  assert.ok(body.errors);
  assert.ok(body.metrics);
  assert.ok(body.events);
});

test('Response has instance_id field', () => {
  const req = { method: 'GET', url: '/api/status' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  statusRoutes(req, res, helpers, {});
  
  const body = JSON.parse(res.body);
  assert.ok(body.instance_id);
  assert.strictEqual(typeof body.instance_id, 'string');
});

test('Empty board returns valid structure', () => {
  const req = { method: 'GET', url: '/api/status' };
  const res = createMockResponse();
  const helpers = createMockHelpers(EMPTY_BOARD);
  
  statusRoutes(req, res, helpers, {});
  
  const body = JSON.parse(res.body);
  assert.ok(body.instance_id);
  assert.ok(body.ts);
  assert.ok(body.core);
  assert.ok(body.core.summary);
  assert.strictEqual(body.core.summary.active, 0);
  assert.strictEqual(body.core.summary.succeeded, 0);
  assert.strictEqual(body.core.summary.failed, 0);
  assert.deepStrictEqual(body.core.tasks, []);
});

test('Non-GET requests return false (not handled)', () => {
  const req = { method: 'POST', url: '/api/status' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  const handled = statusRoutes(req, res, helpers, {});
  
  assert.strictEqual(handled, false);
});

test('Non-matching URLs return false (not handled)', () => {
  const req = { method: 'GET', url: '/api/other' };
  const res = createMockResponse();
  const helpers = createMockHelpers(BOARD_WITH_TASK);
  
  const handled = statusRoutes(req, res, helpers, {});
  
  assert.strictEqual(handled, false);
});

// ─────────────────────────────────────
// Summary
// ─────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
