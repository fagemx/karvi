/**
 * routes/health.js — Health check endpoint for CD pipeline
 *
 * GET /api/health — returns { ok: true, uptime }
 * Version is omitted to avoid information leakage on unauthenticated endpoint.
 */
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function healthRoutes(req, res, helpers, deps) {
  if (req.method === 'GET' && req.url === '/api/health') {
    const uptime = Math.floor(process.uptime());
    return json(res, 200, { ok: true, uptime });
  }
  return false;
};
