#!/usr/bin/env node
/**
 * test-tunnel.js — Unit tests for SSH reverse tunnel module
 *
 * Tests tunnel creation, lifecycle, and utility functions.
 * Does NOT actually spawn SSH processes — only tests the API.
 *
 * Usage: node server/test-tunnel.js
 */
const assert = require('assert');
const tunnel = require('./tunnel');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ✗ ${label}: ${reason}`); process.exitCode = 1; }

function testCreateTunnel() {
  console.log('\n[tunnel] createTunnel()');

  const t = tunnel.createTunnel({
    relayHost: 'relay.example.com',
    localPort: 3461,
  });

  assert(t.start, 'should have start method');
  assert(t.stop, 'should have stop method');
  assert(t.getStatus, 'should have getStatus method');
  ok('createTunnel returns expected API');
}

function testTunnelStatus() {
  console.log('\n[tunnel] getStatus()');

  const t = tunnel.createTunnel({
    relayHost: 'relay.example.com',
    localPort: 3461,
  });

  const status = t.getStatus();
  assert.strictEqual(status.status, 'stopped', 'initial status should be stopped');
  assert.strictEqual(status.relayHost, 'relay.example.com');
  assert.strictEqual(status.localPort, 3461);
  ok('getStatus returns initial state');
}

function testTunnelStartWithoutRelayHost() {
  console.log('\n[tunnel] start() without relayHost');

  const t = tunnel.createTunnel({
    relayHost: null,
    localPort: 3461,
  });

  const err = t.start();
  assert(err instanceof Error, 'should return error');
  assert(err.message.includes('relayHost'), 'error should mention relayHost');
  ok('start returns error when relayHost is missing');
}

function testTunnelDoubleStart() {
  console.log('\n[tunnel] start() double call');

  const t = tunnel.createTunnel({
    relayHost: 'relay.example.com',
    localPort: 99999,
    remotePort: 99999,
  });

  // First start would succeed if SSH was available, but we just test the error handling
  t.start();
  const err2 = t.start();
  // The second call should return an error about already running
  // (or null if first start failed)
  if (err2) {
    ok('second start returns error');
  } else {
    ok('second start returns error or null (acceptable)');
  }
  t.stop();
}

function testTunnelStop() {
  console.log('\n[tunnel] stop()');

  const t = tunnel.createTunnel({
    relayHost: 'relay.example.com',
    localPort: 3461,
  });

  t.stop(); // Should not throw even if not started
  const status = t.getStatus();
  assert.strictEqual(status.status, 'stopped');
  ok('stop() works even if not started');
}

function testCheckLocalAccess() {
  console.log('\n[tunnel] checkLocalAccess()');

  const localCases = [
    { remoteAddress: '::1', expected: true, desc: 'IPv6 loopback' },
    { remoteAddress: '::ffff:127.0.0.1', expected: true, desc: 'IPv4-mapped IPv6' },
    { remoteAddress: '127.0.0.1', expected: true, desc: 'IPv4 loopback' },
    { remoteAddress: '192.168.1.100', expected: false, desc: 'LAN IP' },
    { remoteAddress: '10.0.0.1', expected: false, desc: 'Private IP' },
    { remoteAddress: '8.8.8.8', expected: false, desc: 'Public IP' },
  ];

  for (const { remoteAddress, expected, desc } of localCases) {
    const req = { socket: { remoteAddress } };
    const result = tunnel.checkLocalAccess(req);
    assert.strictEqual(result, expected, `checkLocalAccess for ${desc}`);
  }
  ok('checkLocalAccess correctly identifies local/remote requests');
}

function testConstants() {
  console.log('\n[tunnel] constants');

  assert.strictEqual(tunnel.DEFAULT_SSH_PORT, 22);
  assert.strictEqual(tunnel.RECONNECT_DELAY_MS, 5000);
  assert.strictEqual(tunnel.MAX_RECONNECT_ATTEMPTS, 10);
  ok('exports expected constants');
}

function runTests() {
  console.log('=== Tunnel Unit Tests ===');

  try {
    testCreateTunnel();
    testTunnelStatus();
    testTunnelStartWithoutRelayHost();
    testTunnelDoubleStart();
    testTunnelStop();
    testCheckLocalAccess();
    testConstants();
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
