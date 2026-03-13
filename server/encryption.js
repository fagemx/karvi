/**
 * encryption.js — AES-256-GCM encryption for board.json sensitive data
 *
 * Encrypts specific fields in board.json at rest:
 *   - task descriptions
 *   - artifact content
 *
 * Uses Node.js built-in crypto module only (zero external dependencies).
 * Key loaded from KARVI_ENCRYPTION_KEY env var or file path in board.meta.encryption_key_path.
 *
 * Usage:
 *   const enc = require('./encryption');
 *   enc.initialize({ keyPath: '/path/to/key' });
 *   const encrypted = enc.encryptField('sensitive data', 'task:T-001:description');
 *   const decrypted = enc.decryptField(encrypted, 'task:T-001:description');
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HKDF_INFO = 'karvi-board-encryption';

let masterKey = null;
let keyPath = null;
let enabled = false;

function initialize(opts = {}) {
  const keyFromEnv = process.env.KARVI_ENCRYPTION_KEY || '';
  keyPath = opts.keyPath || null;
  
  if (keyFromEnv && /^[0-9a-fA-F]{64}$/.test(keyFromEnv)) {
    masterKey = Buffer.from(keyFromEnv, 'hex');
    enabled = true;
    return { ok: true, source: 'env' };
  }
  
  if (keyPath && fs.existsSync(keyPath)) {
    try {
      const keyData = fs.readFileSync(keyPath, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(keyData)) {
        masterKey = Buffer.from(keyData, 'hex');
        enabled = true;
        return { ok: true, source: 'file', path: keyPath };
      }
    } catch (err) {
      return { ok: false, error: `Failed to read key file: ${err.message}` };
    }
  }
  
  enabled = false;
  return { ok: false, error: 'No valid encryption key configured' };
}

function isEnabled() {
  return enabled && masterKey !== null;
}

function deriveKey(context) {
  if (!masterKey) throw new Error('Encryption not initialized');
  const derived = crypto.hkdfSync('sha256', masterKey, context, HKDF_INFO, KEY_BYTES);
  return Buffer.from(derived);
}

function encrypt(plaintext, context) {
  if (!isEnabled()) {
    throw new Error('Encryption not enabled');
  }
  if (typeof plaintext !== 'string') {
    plaintext = JSON.stringify(plaintext);
  }
  
  const key = deriveKey(context);
  try {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    
    return {
      _encrypted: true,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
  } finally {
    key.fill(0);
  }
}

function decrypt(entry, context) {
  if (!isEnabled()) {
    throw new Error('Encryption not enabled');
  }
  if (!entry || !entry._encrypted) {
    return entry;
  }
  
  const key = deriveKey(context);
  try {
    const iv = Buffer.from(entry.iv, 'base64');
    const tag = Buffer.from(entry.tag, 'base64');
    const ciphertext = Buffer.from(entry.ciphertext, 'base64');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error(`Decryption failed for context "${context}": ${err.message}`);
  } finally {
    key.fill(0);
  }
}

function encryptField(value, context) {
  if (!isEnabled()) return value;
  if (value === null || value === undefined) return value;
  return encrypt(value, context);
}

function decryptField(entry, context) {
  if (!isEnabled()) return entry;
  if (!entry || !entry._encrypted) return entry;
  return decrypt(entry, context);
}

function encryptTask(task) {
  if (!isEnabled() || !task) return task;
  
  const encrypted = { ...task };
  const taskId = task.id;
  
  if (task.description) {
    encrypted.description = encryptField(task.description, `task:${taskId}:description`);
  }
  if (task.title && task.title !== task.id) {
    encrypted.title = encryptField(task.title, `task:${taskId}:title`);
  }
  
  if (task.steps && Array.isArray(task.steps)) {
    encrypted.steps = task.steps.map((step, idx) => {
      const stepEnc = { ...step };
      if (step.progress) {
        stepEnc.progress = encryptField(step.progress, `task:${taskId}:step:${idx}:progress`);
      }
      return stepEnc;
    });
  }
  
  return encrypted;
}

function decryptTask(task) {
  if (!isEnabled() || !task) return task;
  
  const decrypted = { ...task };
  const taskId = task.id;
  
  if (task.description && task.description._encrypted) {
    decrypted.description = decryptField(task.description, `task:${taskId}:description`);
  }
  if (task.title && task.title._encrypted) {
    decrypted.title = decryptField(task.title, `task:${taskId}:title`);
  }
  
  if (task.steps && Array.isArray(task.steps)) {
    decrypted.steps = task.steps.map((step, idx) => {
      const stepDec = { ...step };
      if (step.progress && step.progress._encrypted) {
        stepDec.progress = decryptField(step.progress, `task:${taskId}:step:${idx}:progress`);
      }
      return stepDec;
    });
  }
  
  return decrypted;
}

function encryptBoard(board) {
  if (!isEnabled() || !board) return board;
  
  const encrypted = { ...board };
  
  if (board.taskPlan && board.taskPlan.tasks) {
    encrypted.taskPlan = {
      ...board.taskPlan,
      tasks: board.taskPlan.tasks.map(encryptTask),
    };
  }
  
  if (board.tasks) {
    encrypted.tasks = board.tasks.map(encryptTask);
  }
  
  if (!encrypted.meta) encrypted.meta = {};
  encrypted.meta.encryption_enabled = true;
  encrypted.meta.encrypted_at = new Date().toISOString();
  
  return encrypted;
}

function decryptBoard(board) {
  if (!isEnabled() || !board) return board;
  if (!board.meta?.encryption_enabled) return board;
  
  const decrypted = { ...board };
  
  if (board.taskPlan && board.taskPlan.tasks) {
    decrypted.taskPlan = {
      ...board.taskPlan,
      tasks: board.taskPlan.tasks.map(decryptTask),
    };
  }
  
  if (board.tasks) {
    decrypted.tasks = board.tasks.map(decryptTask);
  }
  
  return decrypted;
}

function rotateKey(newKeyHex, board) {
  if (!/^[0-9a-fA-F]{64}$/.test(newKeyHex)) {
    return { ok: false, error: 'Invalid key format: must be 64-char hex string' };
  }
  
  const oldKey = masterKey;
  const oldEnabled = enabled;
  
  try {
    const decrypted = oldEnabled && board?.meta?.encryption_enabled
      ? decryptBoard(board)
      : board;
    
    if (oldKey) oldKey.fill(0);
    masterKey = Buffer.from(newKeyHex, 'hex');
    enabled = true;
    
    const reEncrypted = encryptBoard(decrypted);
    
    return { ok: true, board: reEncrypted };
  } catch (err) {
    if (oldKey && !oldKey.every(b => b === 0)) {
      masterKey = oldKey;
    }
    enabled = oldEnabled;
    return { ok: false, error: `Key rotation failed: ${err.message}` };
  }
}

function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}

function setKey(newKeyHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(newKeyHex)) {
    return { ok: false, error: 'Invalid key format: must be 64-char hex string' };
  }
  masterKey = Buffer.from(newKeyHex, 'hex');
  enabled = true;
  return { ok: true };
}

function getKeyPath() {
  return keyPath;
}

function disable() {
  enabled = false;
}

function clearKey() {
  if (masterKey) {
    masterKey.fill(0);
    masterKey = null;
  }
  enabled = false;
}

module.exports = {
  initialize,
  isEnabled,
  encrypt,
  decrypt,
  encryptField,
  decryptField,
  encryptTask,
  decryptTask,
  encryptBoard,
  decryptBoard,
  rotateKey,
  generateKey,
  setKey,
  getKeyPath,
  disable,
  clearKey,
};
