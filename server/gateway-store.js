/**
 * gateway-store.js — User & Session JSON storage with atomic writes
 *
 * Handles user registration, password hashing (crypto.scrypt), session
 * management (HMAC-signed tokens), and atomic JSON persistence.
 *
 * Zero external dependencies — only Node.js built-in modules.
 *
 * Usage:
 *   const store = require('./gateway-store');
 *   store.init({ dataDir: '/data/gateway', secret: 'my-secret' });
 *   const user = await store.createUser({ username: 'alice', email: 'a@b.com', password: 'pw' });
 *   const session = store.createSession(user.userId);
 *   const verified = store.verifySession(session.token);
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_COST = 16384;    // N
const SCRYPT_BLOCK = 8;       // r
const SCRYPT_PARALLEL = 1;    // p
const TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_HOURS = 168; // 7 days

// --- State ---
let dataDir = null;
let secret = null;
let sessionTTLHours = DEFAULT_SESSION_TTL_HOURS;
let users = {};    // { username: { userId, username, email, passwordHash, salt, plan, ... } }
let sessions = {}; // { tokenHash: { userId, username, createdAt, expiresAt } }

// --- Helpers ---

function usersPath() { return path.join(dataDir, 'users.json'); }
function sessionsPath() { return path.join(dataDir, 'sessions.json'); }

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// --- Password Hashing (crypto.scrypt) ---

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL,
    }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve({
        hash: derivedKey.toString('hex'),
        salt: salt.toString('hex'),
      });
    });
  });
}

function verifyPassword(password, hash, saltHex) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(saltHex, 'hex');
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL,
    }, (err, derivedKey) => {
      if (err) return reject(err);
      const expected = Buffer.from(hash, 'hex');
      resolve(crypto.timingSafeEqual(derivedKey, expected));
    });
  });
}

// --- HMAC-Signed Session Tokens ---

function createToken() {
  const payload = {
    nonce: crypto.randomBytes(TOKEN_BYTES).toString('hex'),
    iat: Date.now(),
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret)
    .update(payloadStr)
    .digest('base64url');
  return `${payloadStr}.${sig}`;
}

function verifyTokenSignature(token) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret)
    .update(payloadStr)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    return JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Hash token for storage (never store raw tokens)
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// --- Persistence ---

function loadUsers() {
  const data = loadJSON(usersPath(), { users: {} });
  users = data.users || {};
}

function saveUsers() {
  atomicWrite(usersPath(), { updatedAt: new Date().toISOString(), users });
}

function loadSessions() {
  const data = loadJSON(sessionsPath(), { sessions: {} });
  sessions = data.sessions || {};
  // Clean expired sessions on load
  const now = Date.now();
  let cleaned = false;
  for (const [hash, sess] of Object.entries(sessions)) {
    if (new Date(sess.expiresAt).getTime() < now) {
      delete sessions[hash];
      cleaned = true;
    }
  }
  if (cleaned) saveSessions();
}

function saveSessions() {
  atomicWrite(sessionsPath(), { updatedAt: new Date().toISOString(), sessions });
}

// --- Public API ---

function init(opts = {}) {
  dataDir = opts.dataDir;
  secret = opts.secret;
  sessionTTLHours = opts.sessionTTLHours || DEFAULT_SESSION_TTL_HOURS;
  if (!dataDir) throw new Error('gateway-store: dataDir is required');
  if (!secret) throw new Error('gateway-store: secret is required');
  fs.mkdirSync(dataDir, { recursive: true });
  loadUsers();
  loadSessions();
}

async function createUser({ username, email, password, plan = 'free' }) {
  // Validation
  if (!username || !/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
    return { ok: false, error: 'Username must be 3-30 alphanumeric/dash/underscore characters', code: 400 };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Invalid email address', code: 400 };
  }
  if (!password || password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters', code: 400 };
  }
  if (users[username]) {
    return { ok: false, error: 'Username already taken', code: 409 };
  }
  // Check email uniqueness
  const emailLower = email.toLowerCase();
  for (const u of Object.values(users)) {
    if (u.email.toLowerCase() === emailLower) {
      return { ok: false, error: 'Email already registered', code: 409 };
    }
  }

  const { hash, salt } = await hashPassword(password);
  const userId = username; // userId = username for simplicity
  const now = new Date().toISOString();

  users[username] = {
    userId,
    username,
    email: emailLower,
    passwordHash: hash,
    salt,
    plan,
    createdAt: now,
    updatedAt: now,
  };

  saveUsers();
  return {
    ok: true,
    user: { userId, username, email: emailLower, plan, createdAt: now },
  };
}

async function authenticateUser(username, password) {
  const user = users[username];
  if (!user) return null;

  const valid = await verifyPassword(password, user.passwordHash, user.salt);
  if (!valid) return null;

  return {
    userId: user.userId,
    username: user.username,
    email: user.email,
    plan: user.plan,
  };
}

function createSession(userId, username) {
  const token = createToken();
  const tokenH = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTTLHours * 3600000);

  sessions[tokenH] = {
    userId,
    username,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  saveSessions();
  return { token, expiresAt: expiresAt.toISOString() };
}

function verifySession(token) {
  // First verify HMAC signature
  const payload = verifyTokenSignature(token);
  if (!payload) return null;

  // Then check session store
  const tokenH = hashToken(token);
  const session = sessions[tokenH];
  if (!session) return null;

  // Check expiry
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    delete sessions[tokenH];
    saveSessions();
    return null;
  }

  return {
    userId: session.userId,
    username: session.username,
    expiresAt: session.expiresAt,
  };
}

function destroySession(token) {
  const tokenH = hashToken(token);
  if (sessions[tokenH]) {
    delete sessions[tokenH];
    saveSessions();
    return true;
  }
  return false;
}

function getUser(username) {
  const user = users[username];
  if (!user) return null;
  return {
    userId: user.userId,
    username: user.username,
    email: user.email,
    plan: user.plan,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function listUsers() {
  return Object.values(users).map(u => ({
    userId: u.userId,
    username: u.username,
    email: u.email,
    plan: u.plan,
    createdAt: u.createdAt,
  }));
}

function deleteUser(username) {
  if (!users[username]) return false;
  delete users[username];
  saveUsers();
  // Also destroy all sessions for this user
  let changed = false;
  for (const [hash, sess] of Object.entries(sessions)) {
    if (sess.username === username) {
      delete sessions[hash];
      changed = true;
    }
  }
  if (changed) saveSessions();
  return true;
}

function updateUser(username, updates) {
  const user = users[username];
  if (!user) return null;
  if (updates.plan !== undefined) user.plan = updates.plan;
  if (updates.email !== undefined) user.email = updates.email.toLowerCase();
  user.updatedAt = new Date().toISOString();
  saveUsers();
  return getUser(username);
}

function cleanExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [hash, sess] of Object.entries(sessions)) {
    if (new Date(sess.expiresAt).getTime() < now) {
      delete sessions[hash];
      cleaned++;
    }
  }
  if (cleaned > 0) saveSessions();
  return cleaned;
}

module.exports = {
  init,
  createUser,
  authenticateUser,
  createSession,
  verifySession,
  destroySession,
  getUser,
  listUsers,
  deleteUser,
  updateUser,
  cleanExpiredSessions,
};
