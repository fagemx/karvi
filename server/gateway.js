#!/usr/bin/env node
/**
 * gateway.js — Gateway HTTP server for Karvi SaaS
 *
 * Entry point for the paid multi-tenant tier. Handles:
 *  - User registration / login / session management
 *  - Subdomain-based routing (alice.karvi.io → localhost:4001)
 *  - Path-based routing for dev (localhost:3460/u/alice/*)
 *  - Reverse proxy to per-user Karvi instance processes
 *  - Admin API for instance management
 *
 * Imports instance-manager.js as an embedded module (no separate server).
 *
 * Zero external dependencies — only Node.js built-in modules.
 *
 * Usage:
 *   GATEWAY_SECRET=my-secret GATEWAY_ADMIN_TOKEN=admin-token node server/gateway.js
 *
 * Environment variables:
 *   GATEWAY_PORT            — Listen port (default: 3460)
 *   GATEWAY_DATA_ROOT       — Root data directory (default: ./data)
 *   GATEWAY_SECRET          — Session token signing secret (required)
 *   GATEWAY_ADMIN_TOKEN     — Admin API auth token (required)
 *   GATEWAY_SESSION_TTL_HOURS — Session TTL in hours (default: 168 = 7 days)
 *   KARVI_CORS_ORIGINS      — Comma-separated allowed origins (default: * in dev)
 *   KARVI_PORT_MIN          — Instance port range start (default: 4000)
 *   KARVI_PORT_MAX          — Instance port range end (default: 4999)
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const store = require('./gateway-store');
const proxy = require('./gateway-proxy');
const mgr = require('./instance-manager');
const { createLimiter } = require('./rate-limiter');

// --- Configuration ---
const PORT = Number(process.env.GATEWAY_PORT || 3460);
const DATA_ROOT = path.resolve(process.env.GATEWAY_DATA_ROOT || './data');
const SECRET = process.env.GATEWAY_SECRET || '';
const ADMIN_TOKEN = process.env.GATEWAY_ADMIN_TOKEN || '';
const SESSION_TTL_HOURS = Number(process.env.GATEWAY_SESSION_TTL_HOURS || 168);
const SESSION_CLEANUP_INTERVAL_MS = 3600000; // 1 hour

// CORS origin 白名單 — comma-separated，未設定時開發模式 fallback 到 *
const ALLOWED_ORIGINS = (process.env.KARVI_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// --- Auth Rate Limiters ---
// 10 attempts per minute per IP to prevent brute force attacks
const loginLimiter = createLimiter({ capacity: 10, refillRate: 10 / 60 });
const registerLimiter = createLimiter({ capacity: 10, refillRate: 10 / 60 });

function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  const cfIP = req.headers['cf-connecting-ip'];
  if (cfIP) return cfIP.trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

// --- Helpers ---

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', c => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      }
      body += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function tokenMatch(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function extractSessionToken(req) {
  // Try Authorization header first, then cookie
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;
  // Fallback: session cookie
  const cookies = (req.headers['cookie'] || '').split(';');
  for (const c of cookies) {
    const [name, ...rest] = c.trim().split('=');
    if (name === 'karvi_session') return rest.join('=');
  }
  return null;
}

/**
 * Parse subdomain from Host header.
 * e.g., "alice.karvi.io" → "alice"
 *       "karvi.io" → null
 *       "localhost:3460" → null
 */
function parseSubdomain(host) {
  if (!host) return null;
  // Remove port
  const hostname = host.split(':')[0];
  // Localhost or IP — no subdomain
  if (hostname === 'localhost' || /^[\d.]+$/.test(hostname)) return null;
  const parts = hostname.split('.');
  // Must have at least 3 parts: sub.domain.tld
  if (parts.length < 3) return null;
  return parts[0];
}

/**
 * Parse path-based routing for dev mode.
 * e.g., "/u/alice/api/board" → { username: "alice", remaining: "/api/board" }
 *       "/auth/login" → null (not a user path)
 */
function parseUserPath(pathname) {
  const match = pathname.match(/^\/u\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (!match) return null;
  return { username: match[1], remaining: match[2] || '/' };
}

// --- Auth Middleware ---

function requireSession(req) {
  const token = extractSessionToken(req);
  if (!token) return null;
  return store.verifySession(token);
}

function requireAdmin(req) {
  const token = extractBearerToken(req);
  if (!token) return false;
  return tokenMatch(ADMIN_TOKEN, token);
}

// --- Instance Token Management ---
// Per-instance API tokens stored alongside the instance registry.
// Generated on instance creation, injected on every proxy request.
//
// IMPORTANT: instanceTokens is in-memory only. On gateway restart, tokens are
// regenerated but running instances still hold old tokens. To fix this,
// recoverRunningInstances() restarts any instances that were marked 'running'
// in the registry so they receive fresh tokens via envExtra.
const instanceTokens = new Map(); // instanceId → token

function generateInstanceToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getOrCreateInstanceToken(instanceId) {
  if (instanceTokens.has(instanceId)) return instanceTokens.get(instanceId);
  const token = generateInstanceToken();
  instanceTokens.set(instanceId, token);
  return token;
}

/**
 * On gateway restart, any instances previously marked as 'running' in the
 * registry still hold stale KARVI_API_TOKEN values (since instanceTokens is
 * in-memory only). We restart them so they receive a fresh token via envExtra.
 */
async function recoverRunningInstances() {
  const instances = mgr.listInstances();
  const stale = instances.filter(i => i.status === 'running' || i.status === 'starting');
  if (stale.length === 0) return;

  console.log(`[gateway] Recovering ${stale.length} stale instance(s) with fresh tokens...`);
  for (const inst of stale) {
    try {
      const token = generateInstanceToken();
      instanceTokens.set(inst.instanceId, token);
      // Update envExtra with the fresh token before restarting
      inst.envExtra = { ...(inst.envExtra || {}), KARVI_API_TOKEN: token };
      await mgr.restartInstance(inst.instanceId);
      console.log(`[gateway] Recovered instance ${inst.instanceId}`);
    } catch (err) {
      console.error(`[gateway] Failed to recover instance ${inst.instanceId}: ${err.message}`);
    }
  }
}

// --- Route Handlers ---

async function handleRegister(req, res) {
  // Rate limit: 10 attempts per minute per IP
  const clientIP = getClientIP(req);
  const rateResult = registerLimiter.consume(clientIP);
  res.setHeader('X-RegisterRateLimit-Limit', rateResult.limit);
  res.setHeader('X-RegisterRateLimit-Remaining', rateResult.remaining);
  if (!rateResult.allowed) {
    res.setHeader('Retry-After', rateResult.retryAfter);
    return json(res, 429, { error: 'Too many registration attempts', retryAfter: rateResult.retryAfter });
  }

  let body;
  try { body = await parseBody(req); } catch (e) { return json(res, e.statusCode || 400, { error: e.statusCode === 413 ? 'Request body too large' : 'Invalid JSON' }); }

  const { username, email, password } = body;
  const result = await store.createUser({ username, email, password });

  if (!result.ok) {
    return json(res, result.code || 400, { error: result.error });
  }

  // Create instance for the new user
  try {
    const token = generateInstanceToken();
    instanceTokens.set(`inst-${username}`, token);
    const instance = await mgr.createInstance({
      userId: username,
      envExtra: { KARVI_API_TOKEN: token },
    });
    console.log(`[gateway] Instance ${instance.instanceId} started on port ${instance.port} for user ${username}`);
  } catch (err) {
    console.error(`[gateway] Failed to create instance for ${username}: ${err.message}`);
    // User created but instance failed — don't block registration
  }

  // Auto-login: create session
  const session = store.createSession(result.user.userId, username);

  res.setHeader('Set-Cookie', `karvi_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_HOURS * 3600}`);
  json(res, 201, {
    ok: true,
    user: result.user,
    token: session.token,
    expiresAt: session.expiresAt,
  });
}

async function handleLogin(req, res) {
  // Rate limit: 10 attempts per minute per IP
  const clientIP = getClientIP(req);
  const rateResult = loginLimiter.consume(clientIP);
  res.setHeader('X-LoginRateLimit-Limit', rateResult.limit);
  res.setHeader('X-LoginRateLimit-Remaining', rateResult.remaining);
  if (!rateResult.allowed) {
    res.setHeader('Retry-After', rateResult.retryAfter);
    return json(res, 429, { error: 'Too many login attempts', retryAfter: rateResult.retryAfter });
  }

  let body;
  try { body = await parseBody(req); } catch (e) { return json(res, e.statusCode || 400, { error: e.statusCode === 413 ? 'Request body too large' : 'Invalid JSON' }); }

  const { username, password } = body;
  if (!username || !password) {
    return json(res, 400, { error: 'Username and password required' });
  }

  const user = await store.authenticateUser(username, password);
  if (!user) {
    return json(res, 401, { error: 'Invalid username or password' });
  }

  // Reset rate limiter on successful login
  loginLimiter.reset(clientIP);

  const session = store.createSession(user.userId, user.username);

  // Ensure instance is running
  const instance = mgr.getInstanceByUserId(username);
  if (!instance) {
    try {
      const token = getOrCreateInstanceToken(`inst-${username}`);
      await mgr.createInstance({
        userId: username,
        envExtra: { KARVI_API_TOKEN: token },
      });
      console.log(`[gateway] Instance auto-started for user ${username} on login`);
    } catch (err) {
      console.error(`[gateway] Failed to auto-start instance for ${username}: ${err.message}`);
    }
  }

  res.setHeader('Set-Cookie', `karvi_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_HOURS * 3600}`);
  json(res, 200, {
    ok: true,
    user,
    token: session.token,
    expiresAt: session.expiresAt,
  });
}

function handleLogout(req, res) {
  const token = extractSessionToken(req);
  if (token) store.destroySession(token);
  res.setHeader('Set-Cookie', 'karvi_session=; Path=/; HttpOnly; Max-Age=0');
  json(res, 200, { ok: true });
}

function handleMe(req, res) {
  const session = requireSession(req);
  if (!session) return json(res, 401, { error: 'Not authenticated' });

  const user = store.getUser(session.username);
  if (!user) return json(res, 401, { error: 'User not found' });

  const instance = mgr.getInstanceByUserId(session.username);
  json(res, 200, {
    ok: true,
    user,
    instance: instance ? {
      instanceId: instance.instanceId,
      port: instance.port,
      status: instance.status,
    } : null,
  });
}

// --- Admin Route Handlers ---

function handleAdminInstances(_req, res) {
  const instances = mgr.listInstances();
  json(res, 200, { ok: true, instances });
}

function handleAdminUsers(_req, res) {
  const users = store.listUsers();
  json(res, 200, { ok: true, users });
}

async function handleAdminRestartInstance(req, res, instanceId) {
  try {
    const instance = await mgr.restartInstance(instanceId);
    // Re-inject API token for restarted instance
    const token = getOrCreateInstanceToken(instanceId);
    json(res, 200, { ok: true, instance });
  } catch (err) {
    json(res, 404, { error: err.message });
  }
}

async function handleAdminDeleteUser(req, res, username) {
  const instanceId = `inst-${username}`;
  const instance = mgr.getInstance(instanceId);

  // Destroy instance if running
  if (instance && instance.status !== 'stopped') {
    try {
      await mgr.destroyInstance(instanceId);
    } catch (err) {
      console.error(`[gateway] Failed to destroy instance ${instanceId}: ${err.message}`);
    }
  }
  instanceTokens.delete(instanceId);

  // Delete user from store
  const deleted = store.deleteUser(username);
  if (!deleted) return json(res, 404, { error: 'User not found' });

  json(res, 200, { ok: true, deleted: username });
}

// --- Proxy Handler ---

async function handleProxy(req, res, username) {
  const session = requireSession(req);
  if (!session) return json(res, 401, { error: 'Not authenticated' });

  // Isolation check: user can only access their own instance
  if (session.username !== username) {
    return json(res, 403, { error: 'Access denied — not your instance' });
  }

  let instance = mgr.getInstanceByUserId(username);

  // Auto-start if stopped
  if (!instance) {
    try {
      const token = getOrCreateInstanceToken(`inst-${username}`);
      instance = await mgr.createInstance({
        userId: username,
        envExtra: { KARVI_API_TOKEN: token },
      });
      console.log(`[gateway] Instance auto-started for ${username} on proxy request`);
    } catch (err) {
      return json(res, 503, { error: 'Instance unavailable', detail: err.message });
    }
  }

  if (instance.status !== 'running') {
    return json(res, 503, { error: `Instance status: ${instance.status}` });
  }

  const instanceToken = instanceTokens.get(instance.instanceId) || '';
  const stripPrefix = parseUserPath(req.url) ? `/u/${username}` : undefined;

  proxy.proxyRequest(req, res, instance.port, {
    injectToken: instanceToken,
    stripPrefix,
    injectUser: session.username,  // Per-user attribution
  });
}

// --- Health Check ---

function handleHealth(_req, res) {
  const mem = process.memoryUsage();
  const instances = mgr.listInstances();
  const running = instances.filter(i => i.status === 'running').length;
  json(res, 200, {
    status: 'ok',
    service: 'karvi-gateway',
    uptime: Math.floor(process.uptime()),
    pid: process.pid,
    port: PORT,
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    instances: { total: instances.length, running },
  });
}

// --- Main Router ---

function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  // CORS — 白名單模式（設定 KARVI_CORS_ORIGINS 時），否則 fallback 到 *
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length > 0) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    // origin 不在白名單 → 不設 Access-Control-Allow-Origin，瀏覽器會擋
  } else {
    // 未設定白名單 → 開發模式，允許全部
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- Health ---
  if (method === 'GET' && pathname === '/health') {
    return handleHealth(req, res);
  }

  // --- Auth Routes ---
  if (method === 'POST' && pathname === '/auth/register') {
    return handleRegister(req, res);
  }
  if (method === 'POST' && pathname === '/auth/login') {
    return handleLogin(req, res);
  }
  if (method === 'POST' && pathname === '/auth/logout') {
    return handleLogout(req, res);
  }
  if (method === 'GET' && pathname === '/auth/me') {
    return handleMe(req, res);
  }

  // --- Admin Routes (Bearer token auth) ---
  if (pathname.startsWith('/admin/')) {
    if (!requireAdmin(req)) {
      return json(res, 401, { error: 'Admin authentication required' });
    }

    if (method === 'GET' && pathname === '/admin/instances') {
      return handleAdminInstances(req, res);
    }
    if (method === 'GET' && pathname === '/admin/users') {
      return handleAdminUsers(req, res);
    }

    // POST /admin/instances/:id/restart
    const restartMatch = pathname.match(/^\/admin\/instances\/([a-zA-Z0-9_-]+)\/restart$/);
    if (method === 'POST' && restartMatch) {
      return handleAdminRestartInstance(req, res, restartMatch[1]);
    }

    // DELETE /admin/users/:username
    const deleteMatch = pathname.match(/^\/admin\/users\/([a-zA-Z0-9_-]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      return handleAdminDeleteUser(req, res, deleteMatch[1]);
    }

    return json(res, 404, { error: 'Admin route not found' });
  }

  // --- Subdomain Routing ---
  const subdomain = parseSubdomain(req.headers['host']);
  if (subdomain) {
    return handleProxy(req, res, subdomain);
  }

  // --- Path-based Routing (dev mode) ---
  const userPath = parseUserPath(pathname);
  if (userPath) {
    return handleProxy(req, res, userPath.username);
  }

  // --- Fallback ---
  json(res, 404, { error: 'Not found. Use /auth/register, /auth/login, or /u/:username/* paths.' });
}

// --- Server Lifecycle ---

let server = null;
let sessionCleanupTimer = null;

function start() {
  if (!SECRET) {
    console.error('[gateway] GATEWAY_SECRET is required. Set it as environment variable.');
    process.exit(1);
  }
  if (!ADMIN_TOKEN) {
    console.error('[gateway] GATEWAY_ADMIN_TOKEN is required. Set it as environment variable.');
    process.exit(1);
  }

  // Initialize store
  store.init({
    dataDir: path.join(DATA_ROOT, 'gateway'),
    secret: SECRET,
    sessionTTLHours: SESSION_TTL_HOURS,
  });

  // Initialize instance manager
  mgr.init({ dataRoot: DATA_ROOT });

  // Restart stale instances so they get fresh API tokens (see S3 comment above)
  recoverRunningInstances().catch(err => {
    console.error('[gateway] Instance recovery failed:', err.message);
  });

  // Periodic session cleanup
  sessionCleanupTimer = setInterval(() => {
    const cleaned = store.cleanExpiredSessions();
    if (cleaned > 0) console.log(`[gateway] Cleaned ${cleaned} expired sessions`);
  }, SESSION_CLEANUP_INTERVAL_MS);

  // Start health checker for instances
  mgr.startHealthChecker();

  // Create HTTP server
  server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      console.error('[gateway] Unhandled error:', err);
      if (!res.headersSent) {
        json(res, 500, { error: 'Internal server error' });
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`Karvi Gateway running at http://localhost:${PORT}`);
    console.log(`  Data root: ${DATA_ROOT}`);
    console.log(`  Instance ports: ${process.env.KARVI_PORT_MIN || 4000}-${process.env.KARVI_PORT_MAX || 4999}`);
  });
}

async function stop() {
  console.log('[gateway] Shutting down...');
  if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
  mgr.stopHealthChecker();
  await mgr.destroyAll();
  if (server) {
    server.close();
  }
  console.log('[gateway] Shutdown complete');
}

// Graceful shutdown
process.on('SIGTERM', async () => { await stop(); process.exit(0); });
process.on('SIGINT', async () => { await stop(); process.exit(0); });

// --- Entry Point ---
if (require.main === module) {
  start();
}

module.exports = { start, stop, _route: route, _getServer: () => server };
