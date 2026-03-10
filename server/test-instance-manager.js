#!/usr/bin/env node
/**
 * test-instance-manager.js — Integration test for instance manager
 *
 * Tests: create, health check, data isolation, port allocation,
 *        destroy, port reuse, registry persistence, list instances.
 *
 * Usage:
 *   node server/test-instance-manager.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const mgr = require('./instance-manager');

const TEST_DATA_ROOT = path.join(os.tmpdir(), `karvi-test-im-${Date.now()}`);
let passed = 0;
let failed = 0;

function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, err) { failed++; console.log(`  ❌ ${name}: ${err}`); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanTestData() {
  try {
    fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-instance-manager] cleanup skipped:', err.message);
  }
}

async function main() {
  console.log('\n━━━ Instance Manager Integration Test ━━━\n');
  console.log(`  Data root: ${TEST_DATA_ROOT}`);

  cleanTestData();
  mgr.init({ dataRoot: TEST_DATA_ROOT });

  // Test 1: Create instance
  let inst1;
  try {
    inst1 = await mgr.createInstance({ userId: 'test-user-1' });
    assert(inst1.port >= 4000 && inst1.port <= 4999, `port ${inst1.port} out of range`);
    assert(inst1.status === 'running', `status should be running, got ${inst1.status}`);
    assert(inst1.instanceId === 'inst-test-user-1', `bad instanceId: ${inst1.instanceId}`);
    assert(inst1.pid > 0, 'pid should be positive');
    ok('Create instance (port in range, status running, has pid)');
  } catch (e) { fail('Create instance', e.message); }

  // Test 2: Health check responds
  try {
    const health = await httpGet(`http://localhost:${inst1.port}/health`);
    assert(health.status === 'ok', `health status: ${health.status}`);
    assert(health.pid === inst1.pid, `health pid mismatch: ${health.pid} vs ${inst1.pid}`);
    assert(health.instanceId === inst1.instanceId, `instanceId mismatch`);
    ok('Health check responds with correct PID and instanceId');
  } catch (e) { fail('Health check', e.message); }

  // Test 3: User data isolation
  try {
    const boardPath = path.join(TEST_DATA_ROOT, 'users', 'test-user-1', 'board.json');
    assert(fs.existsSync(boardPath), 'board.json not created in user dir');
    const briefsDir = path.join(TEST_DATA_ROOT, 'users', 'test-user-1', 'briefs');
    assert(fs.existsSync(briefsDir), 'briefs/ not created in user dir');
    ok('User data directory created and isolated');
  } catch (e) { fail('User data isolation', e.message); }

  // Test 4: Second instance gets different port
  let inst2;
  try {
    inst2 = await mgr.createInstance({ userId: 'test-user-2' });
    assert(inst2.port !== inst1.port, `ports should differ: ${inst2.port} === ${inst1.port}`);
    assert(inst2.status === 'running', `status should be running, got ${inst2.status}`);
    ok(`Second instance gets different port (${inst1.port} vs ${inst2.port})`);
  } catch (e) { fail('Second instance port', e.message); }

  // Test 5: Duplicate user rejected
  try {
    await mgr.createInstance({ userId: 'test-user-1' });
    fail('Duplicate user rejected', 'should have thrown');
  } catch (e) {
    assert(e.message.includes('already exists'), `wrong error: ${e.message}`);
    ok('Duplicate user creation rejected');
  }

  // Test 6: List instances
  try {
    const all = mgr.listInstances();
    assert(all.length === 2, `expected 2 instances, got ${all.length}`);
    ok('List instances returns correct count');
  } catch (e) { fail('List instances', e.message); }

  // Test 7: getInstance and getInstanceByUserId
  try {
    const byId = mgr.getInstance('inst-test-user-1');
    assert(byId !== null, 'getInstance returned null');
    assert(byId.userId === 'test-user-1', 'wrong userId');

    const byUser = mgr.getInstanceByUserId('test-user-2');
    assert(byUser !== null, 'getInstanceByUserId returned null');
    assert(byUser.instanceId === 'inst-test-user-2', 'wrong instanceId');

    const notFound = mgr.getInstance('nonexistent');
    assert(notFound === null, 'should return null for nonexistent');

    ok('getInstance and getInstanceByUserId work correctly');
  } catch (e) { fail('getInstance / getInstanceByUserId', e.message); }

  // Test 8: Destroy instance
  try {
    const result = await mgr.destroyInstance('inst-test-user-1');
    assert(result.ok === true, 'destroy should return ok');
    await sleep(500); // Wait for process to exit
    const inst = mgr.getInstance('inst-test-user-1');
    assert(inst.status === 'stopped', `status should be stopped, got ${inst.status}`);
    assert(inst.pid === null, 'pid should be null after destroy');
    ok('Destroy instance (status stopped, pid null)');
  } catch (e) { fail('Destroy instance', e.message); }

  // Test 9: Port reuse after destroy
  try {
    const inst3 = await mgr.createInstance({ userId: 'test-user-3' });
    assert(inst3.port === inst1.port, `should reuse freed port ${inst1.port}, got ${inst3.port}`);
    ok(`Port reused after destroy (port ${inst3.port})`);
    await mgr.destroyInstance(inst3.instanceId);
  } catch (e) { fail('Port reuse', e.message); }

  // Test 10: Registry persistence
  try {
    const regPath = path.join(TEST_DATA_ROOT, 'instance-registry.json');
    assert(fs.existsSync(regPath), 'registry file should exist');
    const loaded = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    assert(loaded.meta && loaded.meta.updatedAt, 'registry should have meta.updatedAt');
    assert(Object.keys(loaded.instances).length >= 2, 'registry should have instances');
    ok('Registry persisted to disk');
  } catch (e) { fail('Registry persistence', e.message); }

  // Cleanup
  console.log('\n  Cleaning up...');
  await mgr.destroyAll();
  await sleep(1000); // Give processes time to exit
  cleanTestData();

  console.log(`\n  ── ${passed} passed, ${failed} failed ──\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  mgr.destroyAll().then(() => {
    cleanTestData();
    process.exit(1);
  });
});
