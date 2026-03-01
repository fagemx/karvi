/**
 * routes/evolution.js — Evolution Layer API (Signals, Insights, Lessons)
 *
 * GET/POST /api/signals
 * GET/POST /api/insights
 * POST /api/insights/:id/apply
 * GET/POST /api/lessons
 * POST /api/lessons/:id/status
 */
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function evolutionRoutes(req, res, helpers, deps) {
  const { mgmt } = deps;

  // --- Signals ---

  if (req.method === 'GET' && (req.url === '/api/signals' || req.url.startsWith('/api/signals?'))) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const typeFilter = parsedUrl.searchParams.get('type');
      const limit = Math.min(500, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
      const board = helpers.readBoard();
      mgmt.ensureEvolutionFields(board);
      let signals = [...board.signals].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      if (typeFilter) signals = signals.filter(s => s.type === typeFilter);
      signals = signals.slice(0, limit);
      return json(res, 200, signals);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/signals') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const by = String(payload.by || '').trim();
        const type = String(payload.type || '').trim();
        const content = String(payload.content || '').trim();
        if (!by || !type || !content) {
          return json(res, 400, { error: 'by, type, content are required' });
        }
        const board = helpers.readBoard();
        mgmt.ensureEvolutionFields(board);
        const signal = {
          id: helpers.uid('sig'),
          ts: helpers.nowIso(),
          by,
          type,
          content,
        };
        if (payload.refs) signal.refs = payload.refs;
        if (payload.data) signal.data = payload.data;
        board.signals.push(signal);
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);

        // Evolution Layer: trigger verification and auto-apply on review signals
        if (type === 'review_result') {
          mgmt.verifyAppliedInsights(board);
        }
        mgmt.autoApplyInsights(board);

        helpers.writeBoard(board);
        json(res, 201, { ok: true, signal });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // --- Insights ---

  if (req.method === 'GET' && (req.url === '/api/insights' || req.url.startsWith('/api/insights?'))) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const statusFilter = parsedUrl.searchParams.get('status');
      const limit = Math.min(500, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
      const board = helpers.readBoard();
      mgmt.ensureEvolutionFields(board);
      let insights = [...board.insights].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      if (statusFilter) insights = insights.filter(i => i.status === statusFilter);
      insights = insights.slice(0, limit);
      return json(res, 200, insights);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/insights') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const by = String(payload.by || '').trim();
        const judgement = String(payload.judgement || '').trim();
        const risk = String(payload.risk || '').trim();
        if (!by || !judgement) {
          return json(res, 400, { error: 'by, judgement are required' });
        }
        if (!mgmt.VALID_RISK_LEVELS.includes(risk)) {
          return json(res, 400, { error: 'risk must be low, medium, or high' });
        }
        const sa = payload.suggestedAction;
        if (!sa || !mgmt.VALID_ACTION_TYPES.includes(sa.type)) {
          return json(res, 400, { error: 'suggestedAction.type must be controls_patch, dispatch_hint, lesson_write, set_pipeline, or noop' });
        }
        const board = helpers.readBoard();
        mgmt.ensureEvolutionFields(board);
        const insight = {
          id: helpers.uid('ins'),
          ts: helpers.nowIso(),
          by,
          about: payload.about || null,
          judgement,
          reasoning: payload.reasoning || null,
          suggestedAction: sa,
          risk,
          status: 'pending',
          snapshot: null,
          appliedAt: null,
          verifyAfter: payload.verifyAfter || 3,
        };
        if (payload.data && typeof payload.data === 'object') insight.data = payload.data;
        board.insights.push(insight);
        mgmt.autoApplyInsights(board);
        helpers.writeBoard(board);
        json(res, 201, { ok: true, insight });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const insightApplyMatch = req.url.match(/^\/api\/insights\/([^/]+)\/apply$/);
  if (req.method === 'POST' && insightApplyMatch) {
    const insightId = decodeURIComponent(insightApplyMatch[1]);
    try {
      const board = helpers.readBoard();
      mgmt.ensureEvolutionFields(board);
      const insight = board.insights.find(i => i.id === insightId);
      if (!insight) return json(res, 404, { error: `Insight ${insightId} not found` });
      if (insight.status !== 'pending') {
        return json(res, 400, { error: `Insight status must be pending (current: ${insight.status})` });
      }

      const sa = insight.suggestedAction || {};

      // Snapshot controls before apply (for potential rollback)
      if (sa.type === 'controls_patch' && sa.payload) {
        insight.snapshot = mgmt.snapshotControls(mgmt.getControls(board), sa.payload);
      }

      mgmt.applyInsightAction(board, insight);
      insight.status = 'applied';
      insight.appliedAt = helpers.nowIso();

      // Write signal for the apply
      board.signals.push({
        id: helpers.uid('sig'),
        ts: helpers.nowIso(),
        by: 'gate',
        type: 'insight_applied',
        content: `Applied insight ${insight.id}: ${insight.judgement}`,
        refs: [insight.id],
        data: { insightId: insight.id, actionType: sa.type, snapshot: insight.snapshot || null },
      });
      if (board.signals.length > 500) board.signals = board.signals.slice(-500);

      helpers.writeBoard(board);
      json(res, 200, { ok: true, applied: sa });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  // --- Lessons ---

  if (req.method === 'GET' && (req.url === '/api/lessons' || req.url.startsWith('/api/lessons?'))) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const statusFilter = parsedUrl.searchParams.get('status');
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
      const board = helpers.readBoard();
      mgmt.ensureEvolutionFields(board);
      let lessons = [...board.lessons].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      if (statusFilter) lessons = lessons.filter(l => l.status === statusFilter);
      lessons = lessons.slice(0, limit);
      return json(res, 200, lessons);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/lessons') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const by = String(payload.by || '').trim();
        const rule = String(payload.rule || '').trim();
        if (!by || !rule) {
          return json(res, 400, { error: 'by, rule are required' });
        }
        const board = helpers.readBoard();
        mgmt.ensureEvolutionFields(board);
        const lesson = {
          id: helpers.uid('les'),
          ts: helpers.nowIso(),
          by,
          fromInsight: payload.fromInsight || null,
          rule,
          effect: payload.effect || null,
          status: payload.status || 'active',
          validatedAt: null,
          supersededBy: null,
        };
        board.lessons.push(lesson);
        // Archive overflow: if > 100, move invalidated/superseded to archive
        if (board.lessons.length > 100) {
          const archived = board.lessons.filter(l => l.status === 'invalidated' || l.status === 'superseded');
          if (archived.length > 0) {
            board.lessons_archive = board.lessons_archive || [];
            board.lessons_archive.push(...archived);
            board.lessons = board.lessons.filter(l => l.status !== 'invalidated' && l.status !== 'superseded');
          }
        }
        helpers.writeBoard(board);
        json(res, 201, { ok: true, lesson });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  const lessonStatusMatch = req.url.match(/^\/api\/lessons\/([^/]+)\/status$/);
  if (req.method === 'POST' && lessonStatusMatch) {
    const lessonId = decodeURIComponent(lessonStatusMatch[1]);
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const newStatus = String(payload.status || '').trim();
        if (!mgmt.VALID_LESSON_STATUSES.includes(newStatus)) {
          return json(res, 400, { error: 'status must be active, validated, invalidated, or superseded' });
        }
        const board = helpers.readBoard();
        mgmt.ensureEvolutionFields(board);
        const lesson = board.lessons.find(l => l.id === lessonId);
        if (!lesson) return json(res, 404, { error: `Lesson ${lessonId} not found` });
        lesson.status = newStatus;
        if (newStatus === 'validated') lesson.validatedAt = helpers.nowIso();
        if (newStatus === 'superseded' && payload.supersededBy) {
          lesson.supersededBy = payload.supersededBy;
        }
        helpers.writeBoard(board);
        json(res, 200, { ok: true, lesson });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  return false;
};
