#!/usr/bin/env node
/**
 * test-gateway.js — Integration tests for gateway service
 *
 * Tests user registration, login, session management, proxy routing,
 * cross-user isolation, and admin API.
 *
 * Usage:
 *   node server/test-gateway.js
 *
 * Starts a gateway on an ephemeral port, runs tests, then shuts down.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- Test Configuration ---
const TEST_PORT = 13460;
const TEST_SECRET = crypto.randomBytes(32).toString('hex');
const TEST_ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
const TEST_DATA_ROOT = path.join(__dirname, '..', '.test-gateway-data-' + Date.now());

// Set env vars BEFORE requiring modules
process.env.GATEWAY_PORT = String(TEST_PORT);
process.env.GATEWAY_DATA_ROOT = TEST_DATA_ROOT;
process.env.GATEWAY_SECRET = TEST_SECRET;
process.env.GATEWAY_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.GATEWAY_SESSION_TTL_HOURS = '1';
process.env.KARVI_PORT_MIN = '14000';
process.env.KARVI_PORT_MAX = '14099';

const store = require('./gateway-store');

// --- Test State ---
let passed = 0;
let failed = 0;
const results = [];

// --- HTTP Client Helper ---
function request(method, urlPath, { body, headers = {}, token, adminToken } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: 15000,
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (adminToken) opts.headers['Authorization'] = `Bearer ${adminToken}`;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, message) {
  if (condition) {
    passed++;
    results.push({ pass: true, message });
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    results.push({ pass: false, message });
    console.log(`  FAIL: ${message}`);
  }
}

// --- Test Suites ---

async function testHealth() {
  console.log('\n--- Health Check ---');
  const res = await request('GET', '/health');
  assert(res.status === 200, 'GET /health returns 200');
  assert(res.body.status === 'ok', 'Health status is ok');
  assert(res.body.service === 'karvi-gateway', 'Service name is karvi-gateway');
}

async function testRegistration() {
  console.log('\n--- Registration ---');

  // Missing fields
  const r1 = await request('POST', '/auth/register', { body: {} });
  assert(r1.status === 400, 'Register with no fields returns 400');

  // Short username
  const r2 = await request('POST', '/auth/register', {
    body: { username: 'ab', email: 'a@b.com', password: 'password123' },
  });
  assert(r2.status === 400, 'Register with short username returns 400');

  // Short password
  const r3 = await request('POST', '/auth/register', {
    body: { username: 'testuser1', email: 'test@example.com', password: 'short' },
  });
  assert(r3.status === 400, 'Register with short password returns 400');

  // Invalid email
  const r4 = await request('POST', '/auth/register', {
    body: { username: 'testuser1', email: 'not-an-email', password: 'password123' },
  });
  assert(r4.status === 400, 'Register with invalid email returns 400');

  // Valid registration
  const r5 = await request('POST', '/auth/register', {
    body: { username: 'testuser1', email: 'test1@example.com', password: 'password123' },
  });
  assert(r5.status === 201, 'Valid registration returns 201');
  assert(r5.body.ok === true, 'Registration result ok');
  assert(r5.body.user.username === 'testuser1', 'Username matches');
  assert(r5.body.token && r5.body.token.length > 0, 'Session token returned');

  // Duplicate username
  const r6 = await request('POST', '/auth/register', {
    body: { username: 'testuser1', email: 'test2@example.com', password: 'password123' },
  });
  assert(r6.status === 409, 'Duplicate username returns 409');

  // Duplicate email
  const r7 = await request('POST', '/auth/register', {
    body: { username: 'testuser2', email: 'test1@example.com', password: 'password123' },
  });
  assert(r7.status === 409, 'Duplicate email returns 409');

  return r5.body.token;
}

async function testLogin(validToken) {
  console.log('\n--- Login ---');

  // Wrong password
  const r1 = await request('POST', '/auth/login', {
    body: { username: 'testuser1', password: 'wrongpassword' },
  });
  assert(r1.status === 401, 'Wrong password returns 401');

  // Non-existent user
  const r2 = await request('POST', '/auth/login', {
    body: { username: 'nouser', password: 'password123' },
  });
  assert(r2.status === 401, 'Non-existent user returns 401');

  // Missing fields
  const r3 = await request('POST', '/auth/login', {
    body: { username: 'testuser1' },
  });
  assert(r3.status === 400, 'Missing password returns 400');

  // Correct login
  const r4 = await request('POST', '/auth/login', {
    body: { username: 'testuser1', password: 'password123' },
  });
  assert(r4.status === 200, 'Correct login returns 200');
  assert(r4.body.ok === true, 'Login result ok');
  assert(r4.body.token && r4.body.token.length > 0, 'New session token returned');
  assert(r4.body.user.username === 'testuser1', 'Login returns correct username');

  return r4.body.token;
}

async function testMe(token) {
  console.log('\n--- Auth Me ---');

  // Without token
  const r1 = await request('GET', '/auth/me');
  assert(r1.status === 401, 'GET /auth/me without token returns 401');

  // With valid token
  const r2 = await request('GET', '/auth/me', { token });
  assert(r2.status === 200, 'GET /auth/me with valid token returns 200');
  assert(r2.body.user.username === 'testuser1', '/auth/me returns correct username');
}

async function testLogout(token) {
  console.log('\n--- Logout ---');

  const r1 = await request('POST', '/auth/logout', { token });
  assert(r1.status === 200, 'Logout returns 200');

  // Token should be invalidated
  const r2 = await request('GET', '/auth/me', { token });
  assert(r2.status === 401, 'Token invalidated after logout');
}

async function testCrossUserIsolation() {
  console.log('\n--- Cross-User Isolation ---');

  // Register second user
  const r1 = await request('POST', '/auth/register', {
    body: { username: 'testuser3', email: 'test3@example.com', password: 'password123' },
  });
  assert(r1.status === 201, 'Second user registered');
  const token3 = r1.body.token;

  // User3 trying to access user1's path
  const r2 = await request('GET', '/u/testuser1/health', { token: token3 });
  assert(r2.status === 403, 'User3 cannot access User1 instance (403)');

  // User3 accessing own path should work (or 502/503/504 if instance not ready)
  const r3 = await request('GET', '/u/testuser3/health', { token: token3 });
  // Instance may not be running in test env, so 200 or 502/503/504 are all acceptable
  assert(
    r3.status === 200 || r3.status === 502 || r3.status === 503 || r3.status === 504,
    `User3 accessing own instance returns ${r3.status} (200/502/503/504 acceptable)`
  );
}

async function testAdminAPI() {
  console.log('\n--- Admin API ---');

  // Without admin token
  const r1 = await request('GET', '/admin/instances');
  assert(r1.status === 401, 'Admin API without token returns 401');

  // With wrong token
  const r2 = await request('GET', '/admin/instances', { adminToken: 'wrong-token' });
  assert(r2.status === 401, 'Admin API with wrong token returns 401');

  // List instances
  const r3 = await request('GET', '/admin/instances', { adminToken: TEST_ADMIN_TOKEN });
  assert(r3.status === 200, 'Admin list instances returns 200');
  assert(Array.isArray(r3.body.instances), 'Instances is an array');

  // List users
  const r4 = await request('GET', '/admin/users', { adminToken: TEST_ADMIN_TOKEN });
  assert(r4.status === 200, 'Admin list users returns 200');
  assert(Array.isArray(r4.body.users), 'Users is an array');
  assert(r4.body.users.length >= 1, 'At least 1 user exists');

  // Delete user
  const r5 = await request('DELETE', '/admin/users/testuser3', { adminToken: TEST_ADMIN_TOKEN });
  assert(r5.status === 200, 'Admin delete user returns 200');

  // Verify deletion
  const r6 = await request('GET', '/admin/users', { adminToken: TEST_ADMIN_TOKEN });
  const usernames = r6.body.users.map(u => u.username);
  assert(!usernames.includes('testuser3'), 'Deleted user no longer in list');

  // Delete non-existent
  const r7 = await request('DELETE', '/admin/users/nouser', { adminToken: TEST_ADMIN_TOKEN });
  assert(r7.status === 404, 'Delete non-existent user returns 404');
}

async function testSessionExpiry() {
  console.log('\n--- Session Expiry ---');

  // Create a user and session directly with a short TTL
  await store.createUser({ username: 'expuser', email: 'exp@test.com', password: 'password123' });
  const session = store.createSession('expuser', 'expuser');

  // Verify it works
  const verified = store.verifySession(session.token);
  assert(verified !== null, 'Fresh session is valid');
  assert(verified.username === 'expuser', 'Session has correct username');

  // Destroy session and verify
  store.destroySession(session.token);
  const destroyed = store.verifySession(session.token);
  assert(destroyed === null, 'Destroyed session returns null');
}

async function testPathRouting() {
  console.log('\n--- Path-Based Routing ---');

  // Unauthenticated path access
  const r1 = await request('GET', '/u/testuser1/api/board');
  assert(r1.status === 401, 'Unauthenticated path access returns 401');

  // Non-existent user path
  const loginRes = await request('POST', '/auth/login', {
    body: { username: 'testuser1', password: 'password123' },
  });
  const token = loginRes.body.token;

  const r2 = await request('GET', '/u/nouser/api/board', { token });
  assert(r2.status === 403, 'Path to non-owned user returns 403');

  // Fallback route
  const r3 = await request('GET', '/nonexistent');
  assert(r3.status === 404, 'Unknown path returns 404');
}

async function testCORS() {
  console.log('\n--- CORS ---');

  const r1 = await request('OPTIONS', '/auth/login');
  assert(r1.status === 204, 'OPTIONS returns 204');
}

async function testXffValidation() {
  console.log('\n--- X-Forwarded-For Validation ---');

  // Valid XFF should be preserved (we test via proxy behavior — the header reaches backend)
  // We test the validation functions directly since proxy target may not be running
  const proxy = require('./gateway-proxy');

  // Unit-level: test isValidXff and isValidHost via proxyRequest header construction
  // Since we can't easily intercept proxy headers, test the module's exported internal
  // by constructing a mock scenario and checking what gateway-proxy produces.

  // Instead, test via the gateway: requests with spoofed XFF should still work
  // (gateway doesn't block, but proxy validates before forwarding)

  // Test 1: Login with valid XFF header — should work normally
  const r1 = await request('POST', '/auth/login', {
    body: { username: 'testuser1', password: 'password123' },
    headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' },
  });
  assert(r1.status === 200, 'Request with valid XFF succeeds');

  // Test 2: Login with spoofed/invalid XFF — should still work (validation is in proxy, not auth)
  const r2 = await request('POST', '/auth/login', {
    body: { username: 'testuser1', password: 'password123' },
    headers: { 'x-forwarded-for': '../../injection, admin-ip' },
  });
  assert(r2.status === 200, 'Request with invalid XFF still reaches gateway auth');

  // Test 3: Verify validation functions directly
  const { isValidXff, isValidHost } = proxy;

  // Valid XFF values
  assert(isValidXff('10.0.0.1') === true, 'isValidXff: single IPv4');
  assert(isValidXff('10.0.0.1, 192.168.1.1') === true, 'isValidXff: multiple IPv4');
  assert(isValidXff('::1') === true, 'isValidXff: IPv6 loopback');
  assert(isValidXff('2001:db8::1, 10.0.0.1') === true, 'isValidXff: mixed IPv4+IPv6');

  // Invalid XFF values (path traversal, injection, garbage)
  assert(isValidXff('../../injection') === false, 'isValidXff: path traversal rejected');
  assert(isValidXff('admin-ip') === false, 'isValidXff: non-IP string rejected');
  assert(isValidXff('10.0.0.1, ../../etc/passwd') === false, 'isValidXff: mixed valid+invalid rejected');
  assert(isValidXff('123.456.789.999, admin-ip') === false, 'isValidXff: example from issue rejected');

  // Valid hosts
  assert(isValidHost('example.com') === true, 'isValidHost: domain');
  assert(isValidHost('example.com:8080') === true, 'isValidHost: domain with port');
  assert(isValidHost('localhost') === true, 'isValidHost: localhost');

  // Invalid hosts
  assert(isValidHost('example.com/../../etc') === false, 'isValidHost: path traversal rejected');
  assert(isValidHost('example.com:8080/admin') === false, 'isValidHost: path injection rejected');
  assert(isValidHost('') === false, 'isValidHost: empty rejected');
}

// --- Test Runner ---

async function runTests() {
  console.log('=== Gateway Integration Tests ===');
  console.log(`  Port: ${TEST_PORT}`);
  console.log(`  Data: ${TEST_DATA_ROOT}`);

  try {
    await testHealth();
    const regToken = await testRegistration();
    const loginToken = await testLogin(regToken);
    await testMe(loginToken);
    await testCrossUserIsolation();
    await testAdminAPI();
    await testSessionExpiry();
    await testPathRouting();
    await testCORS();
    await testXffValidation();
    await testLogout(loginToken);
  } catch (err) {
    console.error('\n  ERROR:', err.message);
    console.error(err.stack);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  return failed === 0;
}

// --- Main ---

async function main() {
  // Start gateway
  const gateway = require('./gateway');
  gateway.start();

  // Wait for server to be ready
  await new Promise((resolve) => {
    const check = () => {
      http.get(`http://127.0.0.1:${TEST_PORT}/health`, (res) => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => resolve());
      }).on('error', () => setTimeout(check, 200));
    };
    setTimeout(check, 500);
  });

  let success = false;
  try {
    success = await runTests();
  } finally {
    // Shutdown
    await gateway.stop();

    // Cleanup test data
    try {
      fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    } catch (err) {
      console.warn('  Warning: could not clean test data:', err.message);
    }
  }

  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
