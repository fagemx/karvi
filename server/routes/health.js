/**
 * routes/health.js — Health check endpoint for CD pipeline
 *
 * GET /api/health — returns { ok: true, version, uptime }
 */
const bb = require('../blackboard-server');
const { json } = bb;

const startTime = Date.now();

module.exports = function healthRoutes(req, res, helpers, deps) {
  if (req.method === 'GET' && req.url === '/api/health') {
    const { version } = require('../../package.json');
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    return json(res, 200, { ok: true, version, uptime });
  }
  return false;
};
