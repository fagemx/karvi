/**
 * routes/usage.js — Usage tracking API
 *
 * GET /api/usage/summary — aggregated usage summary
 * GET /api/usage — per-user usage query
 */
const bb = require('../blackboard-server');
const { json } = bb;
const { getUserId } = require('./_shared');

module.exports = function usageRoutes(req, res, helpers, deps) {
  const { usage } = deps;

  if (req.method === 'GET' && (req.url === '/api/usage/summary' || req.url.startsWith('/api/usage/summary?'))) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const month = url.searchParams.get('month') || usage.currentMonth();
      const result = usage.summary(month);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'GET' && (req.url === '/api/usage' || req.url.startsWith('/api/usage?'))) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const userId = getUserId(req);
      const month = url.searchParams.get('month') || usage.currentMonth();
      const result = usage.query(userId, month);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  return false;
};
