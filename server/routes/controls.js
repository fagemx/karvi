/**
 * routes/controls.js — Controls API
 *
 * GET /api/controls — read controls
 * POST /api/controls — update controls
 */
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function controlsRoutes(req, res, helpers, deps) {
  const { mgmt } = deps;

  if (req.method === 'GET' && req.url === '/api/controls') {
    try {
      const board = helpers.readBoard();
      return json(res, 200, mgmt.getControls(board));
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/controls') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const board = helpers.readBoard();
        board.controls = board.controls || {};
        const allowed = Object.keys(mgmt.DEFAULT_CONTROLS);
        for (const key of allowed) {
          if (key in patch) {
            const val = patch[key];
            if ((key === 'auto_dispatch' || key === 'auto_review' || key === 'auto_redispatch' || key === 'auto_apply_insights' || key === 'telemetry_enabled' || key === 'use_step_pipeline' || key === 'use_worktrees') && typeof val === 'boolean') board.controls[key] = val;
            else if (key === 'max_review_attempts' && Number.isFinite(val)) board.controls[key] = Math.max(1, Math.min(10, val));
            else if (key === 'quality_threshold' && Number.isFinite(val)) board.controls[key] = Math.max(0, Math.min(100, val));
            else if (key === 'review_timeout_sec' && Number.isFinite(val)) board.controls[key] = Math.max(30, Math.min(600, val));
            else if (key === 'review_agent' && typeof val === 'string') board.controls[key] = val.trim();
            else if (key === 'usage_limits' && (val === null || typeof val === 'object')) board.controls[key] = val;
            else if (key === 'usage_alert_threshold' && Number.isFinite(val)) board.controls[key] = Math.max(0, Math.min(1, val));
            else if (key === 'max_concurrent_tasks' && Number.isFinite(val)) board.controls[key] = Math.max(1, Math.min(10, val));
            else if (key === 'target_repo' && (val === null || typeof val === 'string')) board.controls[key] = val ? val.trim() : null;
            else if (key === 'default_step_timeout_sec' && typeof val === 'object' && val !== null) {
              const cleaned = {};
              for (const [type, sec] of Object.entries(val)) {
                if (Number.isFinite(sec)) {
                  cleaned[type] = Math.max(30, Math.min(3600, sec));
                }
              }
              board.controls[key] = cleaned;
            }
          }

        }
        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'controls_updated', controls: board.controls });
        json(res, 200, { ok: true, controls: mgmt.getControls(board) });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  return false;
};
