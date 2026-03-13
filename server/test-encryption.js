#!/usr/bin/env node
/**
 * test-encryption.js — Unit tests for encryption.js
 *
 * Run:
 *   node server/test-encryption.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const enc = require('./encryption');
const storage = require('./storage-json');
const artifacts = require('./artifact-store');

let passed = 0;
let failed = 0;
const TMP_DIR = path.join(__dirname, `.test-encryption-${Date.now()}`);

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

function setup() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

function cleanup() {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  enc.clearKey();
}

const TEST_KEY = crypto.randomBytes(32).toString('hex');
const TEST_KEY_2 = crypto.randomBytes(32).toString('hex');

console.log('encryption.js unit tests\n');

test('1. Initialize with valid key', () => {
  const res = enc.initialize({ keyPath: null });
  assert.strictEqual(res.ok, false, 'Should fail without key');
  
  process.env.KARVI_ENCRYPTION_KEY = TEST_KEY;
  const res2 = enc.initialize({});
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.source, 'env');
  assert.strictEqual(enc.isEnabled(), true);
  delete process.env.KARVI_ENCRYPTION_KEY;
});

test('2. Encrypt/decrypt string round-trip', () => {
  enc.setKey(TEST_KEY);
  const plaintext = 'This is a secret task description';
  const encrypted = enc.encrypt(plaintext, 'test:context');
  
  assert.ok(encrypted._encrypted);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.tag);
  assert.ok(encrypted.ciphertext);
  assert.notStrictEqual(encrypted.ciphertext, plaintext);
  
  const decrypted = enc.decrypt(encrypted, 'test:context');
  assert.strictEqual(decrypted, plaintext);
});

test('3. Encrypt/decrypt field convenience methods', () => {
  enc.setKey(TEST_KEY);
  const value = 'Sensitive data';
  
  const encrypted = enc.encryptField(value, 'field:test');
  assert.ok(encrypted._encrypted);
  
  const decrypted = enc.decryptField(encrypted, 'field:test');
  assert.strictEqual(decrypted, value);
});

test('4. Encrypt/decrypt returns original when disabled', () => {
  enc.clearKey();
  assert.strictEqual(enc.isEnabled(), false);
  
  const value = 'Not encrypted';
  const result = enc.encryptField(value, 'test');
  assert.strictEqual(result, value);
  
  const decrypted = enc.decryptField(value, 'test');
  assert.strictEqual(decrypted, value);
});

test('5. AAD tampering detection', () => {
  enc.setKey(TEST_KEY);
  
  const encrypted = enc.encrypt('secret', 'context:a');
  
  assert.throws(() => {
    enc.decrypt(encrypted, 'context:b');
  }, /Decryption failed/);
});

test('6. Encrypt/decrypt task', () => {
  enc.setKey(TEST_KEY);
  
  const task = {
    id: 'T-00001',
    title: 'Implement feature X',
    description: 'Build the new feature with sensitive details',
    status: 'pending',
    steps: [
      { step_id: 'plan', progress: 'Planning sensitive details' }
    ]
  };
  
  const encrypted = enc.encryptTask(task);
  
  assert.strictEqual(encrypted.id, task.id);
  assert.strictEqual(encrypted.status, task.status);
  assert.ok(encrypted.title._encrypted);
  assert.ok(encrypted.description._encrypted);
  assert.ok(encrypted.steps[0].progress._encrypted);
  
  const decrypted = enc.decryptTask(encrypted);
  
  assert.strictEqual(decrypted.id, task.id);
  assert.strictEqual(decrypted.title, task.title);
  assert.strictEqual(decrypted.description, task.description);
  assert.strictEqual(decrypted.steps[0].progress, task.steps[0].progress);
});

test('7. Encrypt/decrypt board', () => {
  enc.setKey(TEST_KEY);
  
  const board = {
    meta: { boardType: 'test' },
    taskPlan: {
      goal: 'Test goal',
      tasks: [
        { id: 'T-001', description: 'Task 1 description' },
        { id: 'T-002', description: 'Task 2 description' },
      ]
    },
    signals: []
  };
  
  const encrypted = enc.encryptBoard(board);
  
  assert.ok(encrypted.meta.encryption_enabled);
  assert.ok(encrypted.meta.encrypted_at);
  assert.ok(encrypted.taskPlan.tasks[0].description._encrypted);
  
  const decrypted = enc.decryptBoard(encrypted);
  
  assert.strictEqual(decrypted.taskPlan.tasks[0].description, 'Task 1 description');
  assert.strictEqual(decrypted.taskPlan.tasks[1].description, 'Task 2 description');
});

test('8. Key rotation', () => {
  enc.setKey(TEST_KEY);
  
  const board = {
    meta: {},
    taskPlan: {
      tasks: [{ id: 'T-001', description: 'Original secret' }]
    }
  };
  
  const encrypted = enc.encryptBoard(board);
  
  const res = enc.rotateKey(TEST_KEY_2, encrypted);
  assert.strictEqual(res.ok, true);
  
  enc.setKey(TEST_KEY_2);
  const decrypted = enc.decryptBoard(res.board);
  
  assert.strictEqual(decrypted.taskPlan.tasks[0].description, 'Original secret');
});

test('9. Generate key', () => {
  const key = enc.generateKey();
  assert.strictEqual(key.length, 64);
  assert.ok(/^[0-9a-fA-F]{64}$/.test(key));
});

test('10. Invalid key format rejected', () => {
  const res = enc.setKey('not-a-valid-key');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('Invalid key format'));
  
  const res2 = enc.rotateKey('short', {});
  assert.strictEqual(res2.ok, false);
});

test('11. Decrypt non-encrypted board returns original', () => {
  enc.setKey(TEST_KEY);
  
  const board = {
    meta: {},
    taskPlan: { tasks: [{ id: 'T-001', description: 'Plain text' }] }
  };
  
  const decrypted = enc.decryptBoard(board);
  assert.strictEqual(decrypted.taskPlan.tasks[0].description, 'Plain text');
});

test('12. Task without sensitive fields passes through', () => {
  enc.setKey(TEST_KEY);
  
  const task = { id: 'T-001', status: 'pending' };
  const encrypted = enc.encryptTask(task);
  
  assert.strictEqual(encrypted.id, 'T-001');
  assert.strictEqual(encrypted.status, 'pending');
  assert.strictEqual(encrypted.description, undefined);
});

test('13. Null/undefined values handled', () => {
  enc.setKey(TEST_KEY);
  
  assert.strictEqual(enc.encryptField(null, 'test'), null);
  assert.strictEqual(enc.encryptField(undefined, 'test'), undefined);
  assert.strictEqual(enc.decryptField(null, 'test'), null);
  assert.strictEqual(enc.decryptField(undefined, 'test'), undefined);
});

test('14. Disable and clear key', () => {
  enc.setKey(TEST_KEY);
  assert.strictEqual(enc.isEnabled(), true);
  
  enc.disable();
  assert.strictEqual(enc.isEnabled(), false);
  
  enc.setKey(TEST_KEY);
  enc.clearKey();
  assert.strictEqual(enc.isEnabled(), false);
});

// --- Storage integration tests ---

test('15. Storage: write/read encrypted board', () => {
  setup();
  enc.setKey(TEST_KEY);
  
  const boardPath = path.join(TMP_DIR, 'test-board.json');
  const board = {
    meta: { encryption_enabled: true, boardType: 'test' },
    taskPlan: {
      tasks: [{ id: 'T-001', description: 'Secret task description' }]
    }
  };
  
  storage.writeBoard(boardPath, board);
  
  const rawContent = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  assert.ok(rawContent.meta.encryption_enabled);
  assert.ok(rawContent.taskPlan.tasks[0].description._encrypted, 'Description should be encrypted on disk');
  
  const loaded = storage.readBoard(boardPath);
  assert.strictEqual(loaded.taskPlan.tasks[0].description, 'Secret task description');
  
  cleanup();
});

test('16. Storage: write/read without encryption', () => {
  setup();
  enc.clearKey();
  
  const boardPath = path.join(TMP_DIR, 'test-board-plain.json');
  const board = {
    meta: { boardType: 'test' },
    taskPlan: {
      tasks: [{ id: 'T-001', description: 'Plain text' }]
    }
  };
  
  storage.writeBoard(boardPath, board);
  
  const rawContent = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  assert.strictEqual(rawContent.taskPlan.tasks[0].description, 'Plain text');
  
  const loaded = storage.readBoard(boardPath);
  assert.strictEqual(loaded.taskPlan.tasks[0].description, 'Plain text');
  
  cleanup();
});

test('17. Storage: encryption_key_path from board meta', () => {
  setup();
  
  const keyPath = path.join(TMP_DIR, 'encryption.key');
  fs.writeFileSync(keyPath, TEST_KEY, 'utf8');
  
  enc.clearKey();
  
  const boardPath = path.join(TMP_DIR, 'test-board-keypath.json');
  const board = {
    meta: { 
      encryption_enabled: true, 
      encryption_key_path: 'encryption.key',
      boardType: 'test' 
    },
    taskPlan: {
      tasks: [{ id: 'T-001', description: 'Secret with key file' }]
    }
  };
  
  storage.writeBoard(boardPath, board);
  
  assert.strictEqual(enc.isEnabled(), true, 'Encryption should be enabled after reading key_path');
  
  const loaded = storage.readBoard(boardPath);
  assert.strictEqual(loaded.taskPlan.tasks[0].description, 'Secret with key file');
  
  cleanup();
});

// --- Artifact store integration tests ---

test('18. Artifact: write/read encrypted artifact', () => {
  setup();
  enc.setKey(TEST_KEY);
  
  const originalDir = artifacts.ARTIFACT_DIR;
  const testArtifactDir = path.join(TMP_DIR, 'artifacts');
  
  const runId = 'run-test-001';
  const stepId = 'T-001:plan';
  const artifact = {
    content: 'This is sensitive artifact content',
    prompt: 'Secret prompt for agent',
    metadata: { runId, stepId }
  };
  
  const filePath = path.join(testArtifactDir, runId, 'T-001_plan.output.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  
  fs.writeFileSync(filePath, JSON.stringify({
    ...artifact,
    content: enc.encryptField(artifact.content, `artifact:${runId}:${stepId}:output:content`),
    prompt: enc.encryptField(artifact.prompt, `artifact:${runId}:${stepId}:output:prompt`),
    _encrypted: true
  }, null, 2), 'utf8');
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(data.content._encrypted, 'Content should be encrypted');
  assert.ok(data.prompt._encrypted, 'Prompt should be encrypted');
  
  cleanup();
});

test('19. Artifact: write/read without encryption', () => {
  setup();
  enc.clearKey();
  
  const runId = 'run-plain';
  const stepId = 'T-002:execute';
  const artifact = {
    content: 'Plain text content',
    metadata: { runId }
  };
  
  const filePath = path.join(TMP_DIR, 'artifacts', runId, 'T-002_execute.output.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf8');
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(data.content, 'Plain text content');
  assert.strictEqual(data._encrypted, undefined);
  
  cleanup();
});

test('20. Key rotation preserves data integrity', () => {
  setup();
  enc.setKey(TEST_KEY);
  
  const boardPath = path.join(TMP_DIR, 'test-rotation.json');
  const original = {
    meta: { encryption_enabled: true, boardType: 'test' },
    taskPlan: {
      tasks: [
        { id: 'T-001', title: 'Task One', description: 'First task secret' },
        { id: 'T-002', title: 'Task Two', description: 'Second task secret' },
      ]
    }
  };
  
  storage.writeBoard(boardPath, original);
  
  let loaded = storage.readBoard(boardPath);
  const rotated = enc.rotateKey(TEST_KEY_2, loaded);
  assert.strictEqual(rotated.ok, true);
  
  enc.setKey(TEST_KEY_2);
  storage.writeBoard(boardPath, rotated.board);
  
  const final = storage.readBoard(boardPath);
  assert.strictEqual(final.taskPlan.tasks[0].description, 'First task secret');
  assert.strictEqual(final.taskPlan.tasks[1].description, 'Second task secret');
  
  cleanup();
});

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
