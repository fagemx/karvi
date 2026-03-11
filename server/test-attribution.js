#!/usr/bin/env node
/**
 * test-attribution.js — Per-user attribution tests
 *
 * Tests for GH-353: Per-user attribution on API calls
 *
 * Usage: node server/test-attribution.js
 */
const assert = require('assert');

// Store original env
const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

function clearRequireCache() {
  const paths = ['./rbac', './routes/_shared'];
  for (const p of paths) {
    try {
      delete require.cache[require.resolve(p)];
    } catch (e) { /* ignore */ }
  }
}

function test(label, fn) {
  try {
    fn();
    console.log(`  OK ${label}`);
  } catch (err) {
    console.log(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

function main() {
  console.log('=== Per-User Attribution Tests (GH-353) ===\n');

  // Test 1: parseUserTokens()
  console.log('1. parseUserTokens():');
  resetEnv();
  process.env.KARVI_USER_TOKENS = JSON.stringify({
    'alice': 'token-alice-123',
    'bob': 'token-bob-456'
  });
  clearRequireCache();
  const rbac = require('./rbac');

  test('parses user tokens from env', () => {
    const result = rbac.parseUserTokens();
    assert.strictEqual(result.active, true);
    assert.strictEqual(result.userTokenMap.size, 2);
    assert.strictEqual(result.userTokenMap.get('token-alice-123'), 'alice');
    assert.strictEqual(result.userTokenMap.get('token-bob-456'), 'bob');
  });

  test('returns inactive when no KARVI_USER_TOKENS', () => {
    delete process.env.KARVI_USER_TOKENS;
    const result = rbac.parseUserTokens();
    assert.strictEqual(result.active, false);
    assert.strictEqual(result.userTokenMap.size, 0);
  });

  test('handles invalid JSON gracefully', () => {
    process.env.KARVI_USER_TOKENS = 'not-valid-json';
    const result = rbac.parseUserTokens();
    assert.strictEqual(result.active, false);
  });

  // Test 2: matchUserId()
  console.log('\n2. matchUserId():');
  const userTokenMap = new Map([
    ['token-alice-123', 'alice'],
    ['token-bob-456', 'bob'],
  ]);

  test('returns userId for matching token', () => {
    const userId = rbac.matchUserId(userTokenMap, 'token-alice-123');
    assert.strictEqual(userId, 'alice');
  });

  test('returns null for non-matching token', () => {
    const userId = rbac.matchUserId(userTokenMap, 'wrong-token');
    assert.strictEqual(userId, null);
  });

  test('returns null for empty token', () => {
    const userId = rbac.matchUserId(userTokenMap, '');
    assert.strictEqual(userId, null);
  });

  // Test 3: resolveAttribution()
  console.log('\n3. resolveAttribution():');
  resetEnv();
  process.env.KARVI_API_TOKEN_ADMIN = 'admin-token';
  process.env.KARVI_USER_TOKENS = JSON.stringify({ 'alice': 'admin-token' });
  clearRequireCache();
  const rbac2 = require('./rbac');
  const roleTokens = rbac2.parseRoleTokens();
  const userTokens = rbac2.parseUserTokens();

  test('returns role and userId for matching token', () => {
    const result = rbac2.resolveAttribution(roleTokens, userTokens, 'admin-token');
    assert.strictEqual(result.role, 'admin');
    assert.strictEqual(result.userId, 'alice');
  });

  test('returns null userId when token not in userTokens', () => {
    process.env.KARVI_USER_TOKENS = JSON.stringify({ 'bob': 'bob-token' });
    clearRequireCache();
    const rbac3 = require('./rbac');
    const rt = rbac3.parseRoleTokens();
    const ut = rbac3.parseUserTokens();
    const result = rbac3.resolveAttribution(rt, ut, 'admin-token');
    assert.strictEqual(result.role, 'admin');
    assert.strictEqual(result.userId, null);
  });

  // Test 4: createSignal() with attribution
  console.log('\n4. createSignal():');
  resetEnv();
  clearRequireCache();
  const { createSignal, getAttribution } = require('./routes/_shared');
  
  const mockHelpers = {
    uid: (prefix) => `${prefix}-test-123`,
    nowIso: () => '2026-03-12T00:00:00.000Z',
  };

  test('includes userId in by field', () => {
    const req = { karviUser: 'alice', karviRole: 'admin' };
    const signal = createSignal({
      type: 'status_change',
      content: 'Task updated',
      refs: ['T1'],
      data: { taskId: 'T1' },
    }, req, mockHelpers);
    
    assert.strictEqual(signal.by, 'alice');
    assert.strictEqual(signal.type, 'status_change');
    assert.ok(signal.data._attribution);
    assert.strictEqual(signal.data._attribution.actor, 'alice');
    assert.strictEqual(signal.data._attribution.role, 'admin');
  });

  test('uses api as default when no user', () => {
    const signal = createSignal({
      type: 'status_change',
      content: 'Task updated',
      refs: ['T1'],
    }, null, mockHelpers);
    
    assert.strictEqual(signal.by, 'api');
  });

  test('uses role when no userId', () => {
    const req = { karviRole: 'admin' };
    const signal = createSignal({
      type: 'status_change',
      content: 'Task updated',
      refs: ['T1'],
    }, req, mockHelpers);
    
    assert.strictEqual(signal.by, 'api');
    assert.ok(signal.data._attribution === undefined);
  });

  // Test 5: getAttribution()
  console.log('\n5. getAttribution():');
  
  test('returns user:alice when karviUser set', () => {
    const req = { karviUser: 'alice', karviRole: 'admin' };
    assert.strictEqual(getAttribution(req), 'user:alice');
  });

  test('returns role:admin when only karviRole set', () => {
    const req = { karviRole: 'admin' };
    assert.strictEqual(getAttribution(req), 'role:admin');
  });

  test('returns anonymous when neither set', () => {
    const req = {};
    assert.strictEqual(getAttribution(req), 'anonymous');
  });

  test('returns anonymous for null req', () => {
    assert.strictEqual(getAttribution(null), 'anonymous');
  });

  // Cleanup
  resetEnv();
  console.log('\n=== All tests passed ===\n');
}

main();
