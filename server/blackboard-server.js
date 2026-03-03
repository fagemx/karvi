#!/usr/bin/env node
/**
 * blackboard-server.js — Shared Blackboard Server Core
 *
 * Provides reusable HTTP server primitives for any Blackboard application:
 *  - CORS headers
 *  - MIME types
 *  - Static file serving
 *  - JSON body parsing
 *  - JSON read/write with atomic backup
 *  - SSE broadcasting
 *  - Timestamped log appending
 *
 * Usage:
 *   const bb = require('./blackboard-server');
 *
 *   const ctx = bb.createContext({
 *     dir: __dirname,
 *     boardPath: 'board.json',   // relative to dir
 *     logPath: 'task-log.jsonl', // relative to dir
 *     port: 3461,
 *     boardType: 'my-app',      // enforced in meta on every writeBoard()
 *   });
 *
 *   const server = bb.createServer(ctx, (req, res, helpers) => {
 *     // your custom routes here
 *     // return true if handled, false to fall through to static
 *   });
 *
 *   bb.listen(server, ctx);
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const { createLimiter } = require('./rate-limiter');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function nowIso() { return new Date().toISOString(); }

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Rate Limit + Body Size defaults ──
const DEFAULT_RATE_LIMIT  = 120;   // requests per minute per IP
const DEFAULT_MAX_BODY    = 1048576; // 1 MB in bytes
const DEFAULT_SSE_LIMIT   = 50;    // max concurrent SSE connections

/**
 * Parse KARVI_RATE_LIMIT env var.
 *   "0" or "off" => disabled
 *   "240"        => 240 req/min (capacity=240, refillRate=4)
 *   unset        => DEFAULT_RATE_LIMIT
 */
function parseRateLimitEnv(val) {
  if (!val) return DEFAULT_RATE_LIMIT;
  const lower = val.trim().toLowerCase();
  if (lower === 'off' || lower === '0' || lower === 'false') return 0;
  const n = Number(val);
  return (Number.isFinite(n) && n > 0) ? n : DEFAULT_RATE_LIMIT;
}

function createContext(opts = {}) {
  const dir = opts.dir || __dirname;
  const boardPath = path.resolve(dir, opts.boardPath || 'board.json');
  const logPath = path.resolve(dir, opts.logPath || 'log.jsonl');
  const port = Number(opts.port) || 3400;
  const boardType = opts.boardType || null;
  const apiToken = opts.apiToken || process.env.KARVI_API_TOKEN || null;
  const corsOrigins = opts.corsOrigins || process.env.KARVI_CORS_ORIGINS || null;

  // Rate limiting config
  const rateLimitPerMin = opts.rateLimit != null
    ? (opts.rateLimit === false ? 0 : Number(opts.rateLimit) || DEFAULT_RATE_LIMIT)
    : parseRateLimitEnv(process.env.KARVI_RATE_LIMIT);

  const maxBodyBytes = opts.maxBodyBytes || Number(process.env.KARVI_MAX_BODY) || DEFAULT_MAX_BODY;
  const sseLimit = opts.sseLimit || Number(process.env.KARVI_SSE_LIMIT) || DEFAULT_SSE_LIMIT;
  const trustProxy = opts.trustProxy || (process.env.KARVI_TRUST_PROXY || '').toLowerCase() === 'true';

  // Create limiter (null if disabled)
  const rateLimiter = rateLimitPerMin > 0
    ? createLimiter({ capacity: rateLimitPerMin, refillRate: rateLimitPerMin / 60 })
    : null;

  if (apiToken) {
    console.log('[bb] API token auth enabled');
  }
  if (corsOrigins) {
    console.log(`[bb] CORS whitelist: ${corsOrigins}`);
  }
  if (rateLimiter) {
    console.log(`[bb] Rate limit: ${rateLimitPerMin} req/min per IP (token bucket)`);
  } else {
    console.log('[bb] Rate limiting disabled');
  }
  console.log(`[bb] Max body size: ${Math.round(maxBodyBytes / 1024)}KB`);
  console.log(`[bb] SSE connection limit: ${sseLimit}`);
  if (trustProxy) {
    console.log('[bb] Trust proxy headers enabled (X-Forwarded-For / CF-Connecting-IP)');
  }

  return {
    dir,
    boardPath,
    logPath,
    port,
    host: opts.host || undefined,
    boardType,
    apiToken,
    corsOrigins,
    sseClients: new Set(),
    taskSseClients: new Map(),  // taskId → Set<res>
    rateLimiter,
    rateLimitPerMin,
    maxBodyBytes,
    sseLimit,
    trustProxy,
  };
}

function tokenMatch(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkAuth(ctx, req) {
  if (!ctx.apiToken) return true;
  if (req.method === 'OPTIONS') return true;

  const url = new URL(req.url, 'http://localhost');

  if (!url.pathname.startsWith('/api/')) return true;
  if (url.pathname.startsWith('/api/webhooks/')) return true;

  if (url.pathname === '/api/events' || url.pathname.match(/^\/api\/tasks\/[^/]+\/stream$/)) {
    const qtoken = url.searchParams.get('token') || '';
    return tokenMatch(ctx.apiToken, qtoken);
  }

  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const provided = match ? match[1] : '';
  return tokenMatch(ctx.apiToken, provided);
}

/**
 * Extract client IP from request.
 * When trustProxy is enabled, checks X-Forwarded-For and CF-Connecting-IP
 * headers (set by reverse proxies / Cloudflare). Otherwise uses socket IP.
 */
function getClientIP(ctx, req) {
  if (ctx.trustProxy) {
    // Cloudflare specific header (most reliable when behind CF)
    const cfIP = req.headers['cf-connecting-ip'];
    if (cfIP) return cfIP.trim();

    // Standard proxy header — leftmost entry is the original client
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

/**
 * Resolve the CORS origin for a given request.
 * When ctx.corsOrigins is set (comma-separated whitelist), only matching
 * origins are reflected back. When unset, returns '*' for backward compat.
 */
function getCorsOrigin(ctx, req) {
  if (!ctx.corsOrigins) return '*';
  const origin = req.headers['origin'] || '';
  const allowed = ctx.corsOrigins.split(',').map(s => s.trim());
  return allowed.includes(origin) ? origin : 'null';
}

function readBoard(ctx) {
  return storage.readBoard(ctx.boardPath);
}

function writeBoard(ctx, board) {
  board.meta = board.meta || {};
  board.meta.updatedAt = nowIso();
  if (ctx.boardType) board.meta.boardType = ctx.boardType;
  if (board.meta.version === undefined) board.meta.version = 1;
  storage.writeBoard(ctx.boardPath, board);
  broadcastSSE(ctx, 'board', board);
}

function appendLog(ctx, entry) {
  storage.appendLog(ctx.logPath, entry);
}

function broadcastSSE(ctx, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of ctx.sseClients) {
    try { client.write(payload); } catch { ctx.sseClients.delete(client); }
  }

  // Per-task SSE: broadcast step progress to task-specific subscribers
  if (event === 'board' && data?.taskPlan?.tasks && ctx.taskSseClients.size > 0) {
    for (const task of data.taskPlan.tasks) {
      if (!ctx.taskSseClients.has(task.id)) continue;
      const runningStep = task.steps?.find(s => s.state === 'running');
      if (runningStep?.progress) {
        broadcastTaskSSE(ctx, task.id, 'step_progress', {
          taskId: task.id,
          step: runningStep.step_id,
          state: runningStep.state,
          progress: runningStep.progress,
        });
      }
      // Also broadcast terminal step events
      const latestSignal = data.signals?.findLast?.(s => s.refs?.includes(task.id) && s.type?.startsWith('step_'));
      if (latestSignal) {
        broadcastTaskSSE(ctx, task.id, latestSignal.type, {
          taskId: task.id,
          step: latestSignal.data?.stepId,
          content: latestSignal.content,
        });
      }
    }
  }
}

function broadcastTaskSSE(ctx, taskId, event, data) {
  const clients = ctx.taskSseClients.get(taskId);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(payload); } catch { clients.delete(client); }
  }
}

function handleTaskSSE(ctx, req, res, taskId) {
  if (ctx.sseClients.size + totalTaskSseClients(ctx) >= ctx.sseLimit) {
    return json(res, 429, { error: 'too_many_sse_connections' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': getCorsOrigin(ctx, req),
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: nowIso(), taskId })}\n\n`);

  if (!ctx.taskSseClients.has(taskId)) ctx.taskSseClients.set(taskId, new Set());
  ctx.taskSseClients.get(taskId).add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); ctx.taskSseClients.get(taskId)?.delete(res); }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = ctx.taskSseClients.get(taskId);
    if (set) { set.delete(res); if (set.size === 0) ctx.taskSseClients.delete(taskId); }
  });
}

function totalTaskSseClients(ctx) {
  let n = 0;
  for (const set of ctx.taskSseClients.values()) n += set.size;
  return n;
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req, maxBytes) {
  const limit = maxBytes || DEFAULT_MAX_BODY;
  return new Promise((resolve, reject) => {
    let body = '';
    let received = 0;
    req.on('data', c => {
      received += c.length;
      if (received > limit) {
        req.destroy();
        return reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
      }
      body += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(ctx, req, res) {
  const reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  let filePath = path.normalize(path.join(ctx.dir, decodeURIComponent(reqPath)));
  if (!filePath.startsWith(ctx.dir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleSSE(ctx, req, res) {
  // SSE connection limit guard
  if (ctx.sseClients.size >= ctx.sseLimit) {
    return json(res, 429, {
      error: 'too_many_sse_connections',
      message: `SSE connection limit reached (${ctx.sseLimit})`,
    });
  }

  const connectTime = Date.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': getCorsOrigin(ctx, req),
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: nowIso() })}\n\n`);
  ctx.sseClients.add(res);

  // 30s heartbeat to prevent reverse proxy timeout on idle connections
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); ctx.sseClients.delete(res); }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    ctx.sseClients.delete(res);
    // Usage tracking callback
    if (ctx.onSSEDisconnect) {
      const minutes = Math.round((Date.now() - connectTime) / 60000 * 100) / 100;
      ctx.onSSEDisconnect({ minutes, req });
    }
  });
}

function handleBoardGet(ctx, _req, res) {
  try { json(res, 200, readBoard(ctx)); }
  catch (e) { json(res, 500, { error: e.message }); }
}

function handleBoardPost(ctx, req, res) {
  parseBody(req, ctx.maxBodyBytes)
    .then(payload => {
      const board = readBoard(ctx);
      Object.assign(board, payload);
      writeBoard(ctx, board);
      json(res, 200, { ok: true });
    })
    .catch(e => json(res, 400, { error: e.message }));
}

function createServer(ctx, routeHandler) {
  // Wrap parseBody to inject ctx.maxBodyBytes as default limit
  const boundParseBody = (req, maxBytes) => parseBody(req, maxBytes || ctx.maxBodyBytes);

  const helpers = {
    json,
    parseBody: boundParseBody,
    readBoard: () => readBoard(ctx),
    writeBoard: (b) => writeBoard(ctx, b),
    appendLog: (e) => appendLog(ctx, e),
    broadcastSSE: (ev, d) => broadcastSSE(ctx, ev, d),
    nowIso,
    uid,
  };

  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(ctx, req));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // ── Body size fast-reject (Content-Length header check) ──
    // Catches obviously-too-large requests before reading any data.
    // The stream-level guard in parseBody() handles cases where
    // Content-Length is missing or spoofed.
    if (req.method === 'POST' || req.method === 'PUT') {
      const contentLength = parseInt(req.headers['content-length'], 10);
      if (contentLength > ctx.maxBodyBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: 'payload_too_large',
          message: `Body exceeds ${Math.round(ctx.maxBodyBytes / 1024)}KB limit`,
          maxBytes: ctx.maxBodyBytes,
        }));
      }
    }

    // ── Rate limit guard ──
    // Applied before auth to prevent brute-force attacks on the token.
    // Health endpoint is exempt (monitoring systems need reliable access).
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (ctx.rateLimiter && pathname !== '/health') {
      const clientIP = getClientIP(ctx, req);
      const result = ctx.rateLimiter.consume(clientIP);

      // Always set rate limit headers for API transparency
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter);
        res.setHeader('X-RateLimit-Reset', result.retryAfter);
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: 'rate_limit_exceeded',
          retryAfter: result.retryAfter,
          message: `Rate limit exceeded. Try again in ${result.retryAfter}s`,
        }));
      }
    }

    // Health check (before auth — instance manager needs unauthenticated access)
    if (req.method === 'GET' && pathname === '/health') {
      const mem = process.memoryUsage();
      return json(res, 200, {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        pid: process.pid,
        port: ctx.port,
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        boardType: ctx.boardType,
        instanceId: process.env.INSTANCE_ID || null,
        rateLimiter: ctx.rateLimiter ? {
          enabled: true,
          limitPerMin: ctx.rateLimitPerMin,
          trackedIPs: ctx.rateLimiter.size(),
        } : { enabled: false },
      });
    }

    // Auth gate
    if (!checkAuth(ctx, req)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    // Built-in routes
    if (req.method === 'GET' && pathname === '/api/events') {
      return handleSSE(ctx, req, res);
    }

    // Per-task SSE stream: GET /api/tasks/:id/stream
    const taskStreamMatch = req.method === 'GET' && pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
    if (taskStreamMatch) {
      return handleTaskSSE(ctx, req, res, decodeURIComponent(taskStreamMatch[1]));
    }

    if (req.method === 'GET' && pathname === '/api/board') {
      return handleBoardGet(ctx, req, res);
    }

    if (req.method === 'POST' && pathname === '/api/board') {
      return handleBoardPost(ctx, req, res);
    }

    // Custom routes
    if (routeHandler) {
      const handled = routeHandler(req, res, helpers);
      if (handled === true || handled === undefined) return;
    }

    // Fallback to static
    serveStatic(ctx, req, res);
  });
}

function ensureBoardExists(ctx, defaultBoard) {
  if (!storage.boardExists(ctx.boardPath)) {
    console.log(`[bb] board not found at ${ctx.boardPath}, creating default...`);
    writeBoard(ctx, defaultBoard);
  }
}

function listen(server, ctx) {
  storage.ensureLogFile(ctx.logPath);
  const host = ctx.host || undefined; // undefined = all interfaces (Node default)
  server.listen(ctx.port, host, () => {
    const addr = server.address();
    const displayHost = addr.address === '::' ? 'localhost' : addr.address;
    console.log(`Blackboard server running at http://${displayHost}:${addr.port}`);
  });
}

module.exports = {
  MIME,
  nowIso,
  uid,
  createContext,
  getClientIP,
  getCorsOrigin,
  readBoard,
  writeBoard,
  appendLog,
  broadcastSSE,
  broadcastTaskSSE,
  json,
  parseBody,
  serveStatic,
  handleSSE,
  createServer,
  ensureBoardExists,
  listen,
  checkAuth,
  tokenMatch,
  storage,
  DEFAULT_RATE_LIMIT,
  DEFAULT_MAX_BODY,
  DEFAULT_SSE_LIMIT,
};
