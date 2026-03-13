#!/usr/bin/env node
/**
 * test-gate-unit.js — Unit tests for Human Gate routes
 *
 * Tests the gate route module directly without starting a server.
 * Usage: node server/test-gate-unit.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ✗ ${label}: ${reason}`); process.exitCode = 1; }

function testGateRoutesModule() {
  console.log('\n[gate] module loading');

  try {
    const gateRoutes = require('./routes/gate');
    assert(typeof gateRoutes === 'function', 'gateRoutes should be a function');
    ok('gate routes module loads successfully');
  } catch (err) {
    fail('gate routes module loads', err.message);
  }
}

function testTunnelCheckLocalAccess() {
  console.log('\n[tunnel] checkLocalAccess function');

  const tunnel = require('./tunnel');

  const testCases = [
    { remoteAddress: '::1', expected: true, desc: 'IPv6 loopback' },
    { remoteAddress: '::ffff:127.0.0.1', expected: true, desc: 'IPv4-mapped IPv6 loopback' },
    { remoteAddress: '127.0.0.1', expected: true, desc: 'IPv4 loopback' },
    { remoteAddress: '192.168.1.100', expected: false, desc: 'LAN IP (not local)' },
    { remoteAddress: '10.0.0.1', expected: false, desc: 'Private IP (not local)' },
    { remoteAddress: '8.8.8.8', expected: false, desc: 'Public IP (not local)' },
  ];

  for (const { remoteAddress, expected, desc } of testCases) {
    const req = { socket: { remoteAddress } };
    const result = tunnel.checkLocalAccess(req);
    if (result === expected) {
      ok(`checkLocalAccess: ${desc}`);
    } else {
      fail(`checkLocalAccess: ${desc}`, `expected ${expected}, got ${result}`);
    }
  }
}

function testManagementControlsIncludeTunnel() {
  console.log('\n[management] tunnel controls');

  const mgmt = require('./management');

  const defaultControls = mgmt.DEFAULT_CONTROLS;
  assert('tunnel_enabled' in defaultControls, 'tunnel_enabled should exist');
  assert('tunnel_relay_host' in defaultControls, 'tunnel_relay_host should exist');
  assert('remote_auth_token' in defaultControls, 'remote_auth_token should exist');
  assert(defaultControls.tunnel_enabled === false, 'tunnel_enabled should default to false');
  assert(defaultControls.tunnel_relay_host === null, 'tunnel_relay_host should default to null');
  assert(defaultControls.remote_auth_token === null, 'remote_auth_token should default to null');
  ok('management.DEFAULT_CONTROLS includes tunnel settings');
}

function testPushNotificationDeepLink() {
  console.log('\n[push] notification deep link data');

  const push = require('./push');

  const task = { id: 'T-123', title: 'Test task' };

  const completedNotif = push.buildNotification(task, 'task.completed');
  assert(completedNotif !== null, 'task.completed should return notification');
  assert(completedNotif.data.action === 'gate', 'should include gate action');
  assert(completedNotif.data.gateUrl === 'karvi:///gate/T-123', 'should include gateUrl');
  ok('push.buildNotification includes gate deep link for task.completed');

  const blockedNotif = push.buildNotification(task, 'task.blocked');
  assert(blockedNotif !== null, 'task.blocked should return notification');
  assert(blockedNotif.data.action === undefined, 'blocked should not have gate action');
  ok('push.buildNotification does not include gate action for task.blocked');
}

function testControlsRoutesValidation() {
  console.log('\n[controls] tunnel control validation');

  const bb = require('./blackboard-server');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-ctrl-test-'));
  const boardPath = path.join(tmpDir, 'board.json');

  const initialBoard = {
    taskPlan: { tasks: [] },
    controls: {},
  };
  fs.writeFileSync(boardPath, JSON.stringify(initialBoard));

  const ctx = bb.createContext({
    dir: tmpDir,
    boardPath: 'board.json',
    boardType: 'test',
  });

  const board = bb.readBoard(ctx);

  board.controls.tunnel_enabled = true;
  board.controls.tunnel_relay_host = 'relay.example.com';
  board.controls.tunnel_remote_port = 8080;
  board.controls.tunnel_ssh_port = 22;
  board.controls.tunnel_ssh_user = 'karvi';
  board.controls.tunnel_identity_file = '/home/user/.ssh/id_rsa';
  board.controls.remote_auth_token = 'test-token-12345678';

  bb.writeBoard(ctx, board);

  const reloaded = bb.readBoard(ctx);
  assert(reloaded.controls.tunnel_enabled === true, 'tunnel_enabled should persist');
  assert(reloaded.controls.tunnel_relay_host === 'relay.example.com', 'tunnel_relay_host should persist');
  assert(reloaded.controls.tunnel_remote_port === 8080, 'tunnel_remote_port should persist');
  assert(reloaded.controls.remote_auth_token === 'test-token-12345678', 'remote_auth_token should persist');
  ok('tunnel controls can be persisted to board');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

function testBlackboardTokenMatch() {
  console.log('\n[blackboard-server] tokenMatch function');

  const bb = require('./blackboard-server');

  assert(bb.tokenMatch('expected', 'expected') === true, 'same strings should match');
  assert(bb.tokenMatch('expected', 'wrong') === false, 'different strings should not match');
  assert(bb.tokenMatch(null, 'token') === false, 'null expected should return false');
  assert(bb.tokenMatch('expected', null) === false, 'null provided should return false');
  assert(bb.tokenMatch('', '') === false, 'empty strings should return false');
  ok('tokenMatch works correctly');
}

function runTests() {
  console.log('=== Gate Unit Tests ===');

  try {
    testGateRoutesModule();
    testTunnelCheckLocalAccess();
    testManagementControlsIncludeTunnel();
    testPushNotificationDeepLink();
    testControlsRoutesValidation();
    testBlackboardTokenMatch();
  } catch (err) {
    fail('unexpected error', err.message);
    console.error(err);
  }

  console.log('\n=== Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
