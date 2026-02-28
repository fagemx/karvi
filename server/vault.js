/**
 * vault.js — Encrypted credential storage (AES-256-GCM)
 *
 * Per-user encrypted files in server/vaults/.
 * Master key from KARVI_VAULT_KEY env var (64-char hex = 32 bytes).
 * HKDF derives per-user subkeys for isolation.
 *
 * Usage:
 *   const vault = require('./vault').createVault({ vaultDir: 'server/vaults' });
 *   vault.store('user1', 'claude_api_key', 'sk-ant-...');
 *   const buf = vault.retrieve('user1', 'claude_api_key');  // Buffer
 *   // use buf.toString('utf8') then buf.fill(0);
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const HKDF_INFO = 'karvi-vault';
const VALID_ID = /^[a-zA-Z0-9_-]+$/;

function createVault(opts = {}) {
  const vaultDir = opts.vaultDir || path.join(__dirname, 'vaults');
  const masterKeyHex = opts.masterKey !== undefined ? opts.masterKey : (process.env.KARVI_VAULT_KEY || '');

  function isEnabled() {
    return /^[0-9a-fA-F]{64}$/.test(masterKeyHex);
  }

  function ensureDir() {
    if (!fs.existsSync(vaultDir)) fs.mkdirSync(vaultDir, { recursive: true });
  }

  function vaultPath(userId) {
    return path.join(vaultDir, `${userId}.vault.json`);
  }

  function deriveKey(userId) {
    const master = Buffer.from(masterKeyHex, 'hex');
    const derived = crypto.hkdfSync('sha256', master, userId, HKDF_INFO, 32);
    return Buffer.from(derived);
  }

  function encrypt(derivedKey, plaintext, aad) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
  }

  function decrypt(derivedKey, entry, aad) {
    const iv = Buffer.from(entry.iv, 'base64');
    const tag = Buffer.from(entry.tag, 'base64');
    const ciphertext = Buffer.from(entry.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(aad));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  function readVaultFile(filePath) {
    if (!fs.existsSync(filePath)) return { version: 1, keys: {} };
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  function writeVaultFile(filePath, data) {
    ensureDir();
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function validateId(value, label) {
    if (!value || !VALID_ID.test(value)) {
      return { ok: false, error: `Invalid ${label}: must match [a-zA-Z0-9_-]+` };
    }
    return null;
  }

  // --- Public API ---

  function store(userId, keyName, value) {
    if (!isEnabled()) return { ok: false, error: 'Vault not configured' };
    const err = validateId(userId, 'userId') || validateId(keyName, 'keyName');
    if (err) return err;
    if (!value) return { ok: false, error: 'value is required' };

    const key = deriveKey(userId);
    try {
      const aad = `${userId}:${keyName}`;
      const encrypted = encrypt(key, value, aad);
      const fp = vaultPath(userId);
      const vault = readVaultFile(fp);
      const now = new Date().toISOString();
      vault.keys[keyName] = {
        ...encrypted,
        createdAt: vault.keys[keyName]?.createdAt || now,
        updatedAt: now,
      };
      writeVaultFile(fp, vault);
      return { ok: true, keyName, updatedAt: now };
    } finally {
      key.fill(0);
    }
  }

  function retrieve(userId, keyName) {
    if (!isEnabled()) return null;
    const err = validateId(userId, 'userId') || validateId(keyName, 'keyName');
    if (err) return null;

    const fp = vaultPath(userId);
    const vault = readVaultFile(fp);
    const entry = vault.keys[keyName];
    if (!entry) return null;

    const key = deriveKey(userId);
    try {
      const aad = `${userId}:${keyName}`;
      return decrypt(key, entry, aad);
    } catch {
      return null;
    } finally {
      key.fill(0);
    }
  }

  function deleteKey(userId, keyName) {
    if (!isEnabled()) return { ok: false, error: 'Vault not configured' };
    const err = validateId(userId, 'userId') || validateId(keyName, 'keyName');
    if (err) return err;

    const fp = vaultPath(userId);
    const vault = readVaultFile(fp);
    if (!vault.keys[keyName]) return { ok: true, deleted: false };
    delete vault.keys[keyName];
    writeVaultFile(fp, vault);
    return { ok: true, deleted: true };
  }

  function list(userId) {
    if (!isEnabled()) return { ok: false, error: 'Vault not configured' };
    const err = validateId(userId, 'userId');
    if (err) return err;

    const fp = vaultPath(userId);
    const vault = readVaultFile(fp);
    const keys = Object.entries(vault.keys).map(([name, entry]) => ({
      keyName: name,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
    return { ok: true, keys };
  }

  function has(userId, keyName) {
    if (!isEnabled()) return false;
    const fp = vaultPath(userId);
    const vault = readVaultFile(fp);
    return !!vault.keys[keyName];
  }

  return { store, retrieve, delete: deleteKey, list, has, isEnabled };
}

module.exports = { createVault };
