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
            if ((key === 'auto_dispatch' || key === 'auto_review' || key === 'auto_redispatch' || key === 'auto_apply_insights' || key === 'telemetry_enabled' || key === 'use_step_pipeline' || key === 'use_worktrees' || key === 'auto_merge_on_approve') && typeof val === 'boolean') board.controls[key] = val;
            else if (key === 'max_review_attempts' && Number.isFinite(val)) board.controls[key] = Math.max(1, Math.min(10, val));
            else if (key === 'quality_threshold' && Number.isFinite(val)) board.controls[key] = Math.max(0, Math.min(100, val));
            else if (key === 'review_timeout_sec' && Number.isFinite(val)) board.controls[key] = Math.max(30, Math.min(600, val));
            else if (key === 'review_agent' && typeof val === 'string') board.controls[key] = val.trim();
            else if (key === 'usage_limits' && (val === null || typeof val === 'object')) board.controls[key] = val;
            else if (key === 'usage_alert_threshold' && Number.isFinite(val)) board.controls[key] = Math.max(0, Math.min(1, val));
            else if (key === 'max_concurrent_tasks' && Number.isFinite(val)) board.controls[key] = Math.max(1, Math.min(10, val));
            else if (key === 'target_repo' && (val === null || typeof val === 'string')) board.controls[key] = val ? val.trim() : null;
            else if (key === 'repo_map' && (val === null || typeof val === 'object')) {
              board.controls[key] = val || {};
              for (const [slug, localPath] of Object.entries(board.controls[key])) {
                if (typeof localPath !== 'string') delete board.controls[key][slug];
              }
            }
            else if (key === 'step_timeout_sec' && typeof val === 'object' && val !== null) {
              board.controls[key] = { ...mgmt.DEFAULT_CONTROLS.step_timeout_sec, ...board.controls[key], ...val };
              for (const k of Object.keys(board.controls[key])) {
                if (typeof board.controls[key][k] === 'number') {
                  board.controls[key][k] = Math.max(30, Math.min(3600, board.controls[key][k]));
                }
              }
            }
            else if (key === 'model_map' && (val === null || typeof val === 'object')) {
              if (!val) {
                board.controls[key] = {};
              } else {
                const clean = {};
                for (const [rt, mapping] of Object.entries(val)) {
                  if (mapping && typeof mapping === 'object') {
                    const rtClean = {};
                    for (const [k, v] of Object.entries(mapping)) {
                      if (typeof v === 'string' && v.trim()) rtClean[k] = v.trim();
                    }
                    if (Object.keys(rtClean).length > 0) clean[rt] = rtClean;
                  }
                }
                board.controls[key] = { ...(board.controls[key] || {}), ...clean };
              }
            }
            else if (key === 'max_concurrent_by_type') {
              if (val === null || typeof val !== 'object') {
                board.controls[key] = null;
              } else {
                const valid = {};
                for (const [stepType, limit] of Object.entries(val)) {
                  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
                    valid[stepType] = Math.max(1, Math.min(10, Math.floor(limit)));
                  }
                }
                board.controls[key] = Object.keys(valid).length > 0 ? valid : null;
              }
            }
            else if (key === 'active_wave') {
              if (val === null) {
                board.controls[key] = null;
              } else if (typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val) && val >= 0) {
                board.controls[key] = val;
              }
            }
          }
        }
        // Deprecation warning: use_step_pipeline=false is no longer supported (GH-218)
        if (patch.use_step_pipeline === false) {
          console.warn('[controls] use_step_pipeline=false is deprecated — all dispatch uses step pipeline');
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
