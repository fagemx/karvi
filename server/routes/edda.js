/**
 * routes/edda.js — Edda Integration API
 *
 * POST /api/edda/propose-controls — Edda proposes a controls patch
 *
 * This endpoint allows Edda (the governance agent) to propose adjustments to
 * Karvi's automation controls. Proposals are stored as insights and can be
 * auto-applied (low risk) or require manual approval (medium/high risk).
 */
const bb = require('../blackboard-server');
const { json } = bb;

const HIGH_RISK_KEYS = ['auto_dispatch', 'auto_review', 'auto_redispatch', 'auto_apply_insights'];
const THRESHOLD_KEYS = ['quality_threshold', 'review_timeout_sec', 'max_review_attempts', 'max_concurrent_tasks'];

function classifyRisk(patch, currentControls) {
  for (const key of HIGH_RISK_KEYS) {
    if (key in patch) return 'high';
  }
  for (const key of THRESHOLD_KEYS) {
    if (key in patch) {
      const current = currentControls[key];
      const proposed = patch[key];
      if (typeof current === 'number' && typeof proposed === 'number' && current !== 0) {
        const changeRatio = Math.abs(proposed - current) / Math.abs(current);
        if (changeRatio > 0.5) return 'high';
        if (changeRatio > 0.2) return 'medium';
      }
    }
  }
  if ('usage_limits' in patch || 'cost_routing' in patch) return 'medium';
  return 'low';
}

function validatePatch(patch, mgmt) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, error: 'patch must be a non-null object' };
  }
  const allowed = Object.keys(mgmt.DEFAULT_CONTROLS);
  const unknown = Object.keys(patch).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    return { valid: false, error: `unknown control keys: ${unknown.join(', ')}` };
  }
  if (patch.quality_threshold !== undefined) {
    if (typeof patch.quality_threshold !== 'number' || patch.quality_threshold < 0 || patch.quality_threshold > 100) {
      return { valid: false, error: 'quality_threshold must be 0-100' };
    }
  }
  if (patch.auto_dispatch !== undefined && typeof patch.auto_dispatch !== 'boolean') {
    return { valid: false, error: 'auto_dispatch must be boolean' };
  }
  if (patch.auto_review !== undefined && typeof patch.auto_review !== 'boolean') {
    return { valid: false, error: 'auto_review must be boolean' };
  }
  return { valid: true };
}

module.exports = function eddaRoutes(req, res, helpers, deps) {
  const { mgmt } = deps;

  if (req.method === 'POST' && req.url === '/api/edda/propose-controls') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { return json(res, 400, { error: 'Invalid JSON' }); }

      const patch = payload.patch;
      const reasoning = String(payload.reasoning || '').trim();
      const by = String(payload.by || 'edda').trim();
      const forceRisk = payload.risk;

      const validation = validatePatch(patch, mgmt);
      if (!validation.valid) {
        return json(res, 400, { error: validation.error });
      }

      const board = helpers.readBoard();
      mgmt.ensureEvolutionFields(board);
      const currentControls = mgmt.getControls(board);
      const risk = forceRisk || classifyRisk(patch, currentControls);

      if (!['low', 'medium', 'high'].includes(risk)) {
        return json(res, 400, { error: 'risk must be low, medium, or high' });
      }

      const judgement = Object.entries(patch)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');

      const insight = {
        id: helpers.uid('ins'),
        ts: helpers.nowIso(),
        by,
        about: 'controls_adjustment',
        judgement: `Adjust controls: ${judgement}`,
        reasoning: reasoning || null,
        suggestedAction: {
          type: 'controls_patch',
          payload: patch,
        },
        risk,
        status: 'pending',
        snapshot: null,
        appliedAt: null,
        verifyAfter: payload.verifyAfter ?? 3,
      };
      if (payload.data && typeof payload.data === 'object') {
        insight.data = payload.data;
      }

      board.insights.push(insight);
      mgmt.autoApplyInsights(board);
      helpers.writeBoard(board);

      json(res, 201, {
        ok: true,
        insight,
        autoApplied: insight.status === 'applied',
      });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/edda/status') {
    const board = helpers.readBoard();
    mgmt.ensureEvolutionFields(board);
    const controls = mgmt.getControls(board);
    const pendingControlsPatches = board.insights.filter(
      i => i.status === 'pending' && i.suggestedAction?.type === 'controls_patch'
    );
    json(res, 200, {
      controls,
      pendingProposals: pendingControlsPatches.length,
      autoApplyEnabled: controls.auto_apply_insights,
    });
    return;
  }

  return false;
};
