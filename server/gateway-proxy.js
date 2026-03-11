/**
 * gateway-proxy.js — HTTP reverse proxy using built-in http module
 *
 * Proxies requests to per-user Karvi instance processes.
 * Handles regular HTTP requests and SSE streams via pipe().
 *
 * Zero external dependencies — only Node.js built-in http module.
 *
 * Usage:
 *   const proxy = require('./gateway-proxy');
 *   proxy.proxyRequest(req, res, 4001, { injectToken: 'abc123' });
 */
const http = require('http');

// Headers that should NOT be forwarded to the backend
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

// Timeout for connecting to backend (ms)
const CONNECT_TIMEOUT_MS = 10000;

/**
 * Proxy an HTTP request to a target instance port.
 *
 * @param {http.IncomingMessage} req  - Incoming client request
 * @param {http.ServerResponse}  res  - Outgoing client response
 * @param {number}               port - Target instance port on localhost
 * @param {object}               opts - Options
 * @param {string}  opts.injectToken  - Bearer token to inject for instance auth
 * @param {string}  opts.stripPrefix  - URL prefix to strip (e.g., '/u/alice')
 * @param {string}  opts.injectUser   - User identity to inject (X-Karvi-User header)
 */
function proxyRequest(req, res, port, opts = {}) {
  const targetPath = opts.stripPrefix
    ? req.url.replace(opts.stripPrefix, '') || '/'
    : req.url;

  // Build forwarded headers — strip hop-by-hop, inject auth
  const headers = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers[key] = val;
    }
  }

  // Override host to target
  headers['host'] = `localhost:${port}`;

  // Inject instance Bearer token (gateway → instance auth)
  if (opts.injectToken) {
    headers['authorization'] = `Bearer ${opts.injectToken}`;
  }

  // Inject user identity for per-user attribution (gateway → instance)
  if (opts.injectUser) {
    headers['x-karvi-user'] = opts.injectUser;
  }

  // Forward client IP
  const clientIp = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${clientIp}`
    : clientIp;
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http';

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port,
    path: targetPath,
    method: req.method,
    headers,
    timeout: CONNECT_TIMEOUT_MS,
  }, (proxyRes) => {
    // Build response headers — strip hop-by-hop
    const resHeaders = {};
    for (const [key, val] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        resHeaders[key] = val;
      }
    }

    // SSE detection: if content-type is event-stream, disable buffering
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      resHeaders['cache-control'] = 'no-cache';
      resHeaders['connection'] = 'keep-alive';
    }

    res.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(res);
  });

  // Handle backend errors
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      const code = err.code === 'ECONNREFUSED' ? 502 : 504;
      const msg = code === 502 ? 'Instance unavailable' : 'Instance timeout';
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: msg, detail: err.message }));
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Instance timeout' }));
    }
  });

  // Handle client disconnect — abort proxy request
  req.on('close', () => {
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  // Pipe request body to backend
  req.pipe(proxyReq);
}

module.exports = { proxyRequest };
