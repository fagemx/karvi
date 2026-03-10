/**
 * routes/version.js — Version endpoint
 *
 * GET /api/version — return server version from package.json
 */
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function versionRoutes(req, res, helpers, deps) {
  if (req.method === 'GET' && req.url === '/api/version') {
    const { version } = require('../../package.json');
    return json(res, 200, { version });
  }
  return false;
};
