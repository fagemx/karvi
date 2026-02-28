#!/usr/bin/env node
/**
 * test-vault.js — Unit tests for vault.js
 *
 * Run:
 *   KARVI_VAULT_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") node server/test-vault.js
 *
 * On Windows (PowerShell):
 *   $env:KARVI_VAULT_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   node server/test-vault.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createVault } = require('./vault');

const TMP_DIR = path.join(__dirname, '.test-vaults-' + Date.now());
const TEST_KEY = crypto.randomBytes(32).toString('hex');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

function cleanup() {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

function makeVault(masterKey) {
  return createVault({ vaultDir: TMP_DIR, masterKey: masterKey ?? TEST_KEY });
}

console.log('vault.js unit tests\n');

// --- Test 1: Round-trip ---
test('1. Encrypt/decrypt round-trip', () => {
  const v = makeVault();
  const res = v.store('alice', 'api_key', 'sk-secret-123');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.keyName, 'api_key');

  const buf = v.retrieve('alice', 'api_key');
  assert.ok(Buffer.isBuffer(buf), 'retrieve should return Buffer');
  assert.strictEqual(buf.toString('utf8'), 'sk-secret-123');
  buf.fill(0);
});

// --- Test 2: Per-user isolation ---
test('2. Different users isolated', () => {
  const v = makeVault();
  v.store('alice', 'token', 'alice-secret');
  const buf = v.retrieve('bob', 'token');
  assert.strictEqual(buf, null, 'bob should not see alice\'s key');
});

// --- Test 3: List keys ---
test('3. List keys returns names, not values', () => {
  const v = makeVault();
  v.store('carol', 'key_a', 'val-a');
  v.store('carol', 'key_b', 'val-b');
  const res = v.list('carol');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.keys.length, 2);
  const names = res.keys.map(k => k.keyName).sort();
  assert.deepStrictEqual(names, ['key_a', 'key_b']);
  // Verify no value/ciphertext fields leaked
  for (const k of res.keys) {
    assert.strictEqual(k.value, undefined);
    assert.strictEqual(k.ciphertext, undefined);
    assert.ok(k.createdAt);
    assert.ok(k.updatedAt);
  }
});

// --- Test 4: Has key ---
test('4. Has key true/false', () => {
  const v = makeVault();
  v.store('dave', 'exists', 'yes');
  assert.strictEqual(v.has('dave', 'exists'), true);
  assert.strictEqual(v.has('dave', 'nope'), false);
  assert.strictEqual(v.has('nobody', 'exists'), false);
});

// --- Test 5: Delete key ---
test('5. Delete key', () => {
  const v = makeVault();
  v.store('eve', 'temp', 'temporary');
  assert.strictEqual(v.has('eve', 'temp'), true);

  const res = v.delete('eve', 'temp');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.deleted, true);

  assert.strictEqual(v.has('eve', 'temp'), false);
  assert.strictEqual(v.retrieve('eve', 'temp'), null);

  // Delete non-existent key
  const res2 = v.delete('eve', 'temp');
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.deleted, false);
});

// --- Test 6: Update (overwrite) key ---
test('6. Update key with new value', () => {
  const v = makeVault();
  v.store('frank', 'token', 'old-value');
  v.store('frank', 'token', 'new-value');
  const buf = v.retrieve('frank', 'token');
  assert.strictEqual(buf.toString('utf8'), 'new-value');
  buf.fill(0);
});

// --- Test 7: No master key ---
test('7. No master key → isEnabled = false', () => {
  const v = createVault({ vaultDir: TMP_DIR, masterKey: '' });
  assert.strictEqual(v.isEnabled(), false);
  const res = v.store('user', 'key', 'val');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('not configured'));
  assert.strictEqual(v.retrieve('user', 'key'), null);
  assert.strictEqual(v.has('user', 'key'), false);
});

// --- Test 8: Invalid master key format ---
test('8. Invalid master key format', () => {
  const v = createVault({ vaultDir: TMP_DIR, masterKey: 'not-a-hex-key' });
  assert.strictEqual(v.isEnabled(), false);

  const v2 = createVault({ vaultDir: TMP_DIR, masterKey: 'abcd' }); // too short
  assert.strictEqual(v2.isEnabled(), false);
});

// --- Test 9: AAD tampering detection ---
test('9. AAD tampering — swapped ciphertext detected', () => {
  const v = makeVault();
  v.store('grace', 'key_x', 'value-x');
  v.store('grace', 'key_y', 'value-y');

  // Manually swap ciphertext between entries
  const fp = path.join(TMP_DIR, 'grace.vault.json');
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const tmp = data.keys.key_x.ciphertext;
  data.keys.key_x.ciphertext = data.keys.key_y.ciphertext;
  data.keys.key_y.ciphertext = tmp;
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));

  // Decrypt should fail (AAD mismatch)
  assert.strictEqual(v.retrieve('grace', 'key_x'), null);
  assert.strictEqual(v.retrieve('grace', 'key_y'), null);
});

// --- Test 10: Memory zeroing ---
test('10. Retrieved buffer can be zeroed', () => {
  const v = makeVault();
  v.store('hank', 'secret', 'super-secret-value');
  const buf = v.retrieve('hank', 'secret');
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString('utf8'), 'super-secret-value');
  buf.fill(0);
  assert.strictEqual(buf.toString('utf8'), '\0'.repeat(buf.length));
});

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
cleanup();
process.exit(failed > 0 ? 1 : 0);
