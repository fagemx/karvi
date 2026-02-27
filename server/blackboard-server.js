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

function createContext(opts = {}) {
  const dir = opts.dir || __dirname;
  const boardPath = path.resolve(dir, opts.boardPath || 'board.json');
  const logPath = path.resolve(dir, opts.logPath || 'log.jsonl');
  const port = Number(opts.port) || 3400;
  const boardType = opts.boardType || null;

  return {
    dir,
    boardPath,
    logPath,
    port,
    boardType,
    sseClients: new Set(),
  };
}

function readBoard(ctx) {
  return JSON.parse(fs.readFileSync(ctx.boardPath, 'utf8'));
}

function writeBoard(ctx, board) {
  board.meta = board.meta || {};
  board.meta.updatedAt = nowIso();
  if (ctx.boardType) board.meta.boardType = ctx.boardType;
  if (board.meta.version === undefined) board.meta.version = 1;
  fs.writeFileSync(ctx.boardPath, JSON.stringify(board, null, 2), 'utf8');
  broadcastSSE(ctx, 'board', board);
}

function appendLog(ctx, entry) {
  try { fs.appendFileSync(ctx.logPath, JSON.stringify(entry) + '\n', 'utf8'); } catch {}
}

function broadcastSSE(ctx, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of ctx.sseClients) {
    try { client.write(payload); } catch { ctx.sseClients.delete(client); }
  }
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => (body += c));
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
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: nowIso() })}\n\n`);
  ctx.sseClients.add(res);
  req.on('close', () => ctx.sseClients.delete(res));
}

function handleBoardGet(ctx, _req, res) {
  try { json(res, 200, readBoard(ctx)); }
  catch (e) { json(res, 500, { error: e.message }); }
}

function handleBoardPost(ctx, req, res) {
  parseBody(req)
    .then(payload => {
      const board = readBoard(ctx);
      Object.assign(board, payload);
      writeBoard(ctx, board);
      json(res, 200, { ok: true });
    })
    .catch(e => json(res, 400, { error: e.message }));
}

function createServer(ctx, routeHandler) {
  const helpers = {
    json,
    parseBody,
    readBoard: () => readBoard(ctx),
    writeBoard: (b) => writeBoard(ctx, b),
    appendLog: (e) => appendLog(ctx, e),
    broadcastSSE: (ev, d) => broadcastSSE(ctx, ev, d),
    nowIso,
    uid,
  };

  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Built-in routes
    if (req.method === 'GET' && req.url === '/api/events') {
      return handleSSE(ctx, req, res);
    }

    if (req.method === 'GET' && req.url === '/api/board') {
      return handleBoardGet(ctx, req, res);
    }

    if (req.method === 'POST' && req.url === '/api/board') {
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

function listen(server, ctx) {
  if (!fs.existsSync(ctx.logPath)) {
    try { fs.writeFileSync(ctx.logPath, '', 'utf8'); } catch {}
  }
  server.listen(ctx.port, () => {
    console.log(`Blackboard server running at http://localhost:${ctx.port}`);
  });
}

module.exports = {
  MIME,
  nowIso,
  uid,
  createContext,
  readBoard,
  writeBoard,
  appendLog,
  broadcastSSE,
  json,
  parseBody,
  serveStatic,
  handleSSE,
  createServer,
  listen,
};
