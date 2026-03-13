/**
 * routes/gate.js — Human Gate API (mobile approval workflow)
 *
 * GET /api/gate/pending — list tasks awaiting human approval
 * POST /api/gate/:taskId/approve — approve a task and continue pipeline
 * POST /api/gate/:taskId/reject — reject a task (mark needs_revision)
 *
 * Human gate is triggered when a task reaches a state requiring human review:
 *   - task.completed with human_review blocker
 *   - step completed with human_gate action from route engine
 *
 * Local requests bypass auth; remote requests require remote_auth_token.
 */
const bb = require('../blackboard-server');
const { json } = bb;
const { requireRole, createSignal } = require('./_shared');
const tunnel = require('../tunnel');

function isRemoteAuthRequired(deps) {
  const board = deps.ctx ? bb.readBoard(deps.ctx) : null;
  const controls = board?.controls || {};
  return !!controls.remote_auth_token;
}

function checkRemoteAuth(req, res, deps) {
  if (!tunnel.checkLocalAccess(req)) {
    const board = deps.ctx ? bb.readBoard(deps.ctx) : null;
    const controls = board?.controls || {};
    const expectedToken = controls.remote_auth_token;

    if (expectedToken) {
      const authHeader = req.headers['authorization'] || '';
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      const provided = match ? match[1] : '';

      if (!provided || !bb.tokenMatch(expectedToken, provided)) {
        json(res, 401, { error: 'unauthorized', message: 'Remote access requires valid Bearer token' });
        return false;
      }
    }
  }
  return true;
}

function gateRoutes(req, res, helpers, deps) {
  const { mgmt, push, PUSH_TOKENS_PATH } = deps;

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/gate/pending') {
    if (!checkRemoteAuth(req, res, deps)) return;
    if (requireRole(req, res, 'viewer')) return;

    try {
      const board = helpers.readBoard();
      const tasks = board.taskPlan?.tasks || [];

      const pending = tasks.filter(t => {
        if (t.status === 'completed' && t.blocker?.type === 'human_review') return true;
        if (t.status === 'completed' && t.blocker?.reason?.toLowerCase().includes('human')) return true;
        for (const step of (t.steps || [])) {
          if (step.state === 'succeeded' && step.human_gate_pending) return true;
        }
        return false;
      }).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        blocker: t.blocker,
        completedAt: t.completedAt,
        assignee: t.assignee,
        githubIssue: t.githubIssue || null,
        pr: t.pr || null,
        pendingStep: (t.steps || []).find(s => s.human_gate_pending)?.step_id || null,
      }));

      return json(res, 200, { tasks: pending, count: pending.length });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  const approveMatch = pathname.match(/^\/api\/gate\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    if (!checkRemoteAuth(req, res, deps)) return;
    if (requireRole(req, res, 'operator')) return;

    const taskId = decodeURIComponent(approveMatch[1]);
    helpers.parseBody(req).then(payload => {
      const comment = String(payload.comment || '').trim();

      const board = helpers.readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);

      if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

      const hadHumanGate = task.blocker?.type === 'human_review' ||
                           task.blocker?.reason?.toLowerCase().includes('human') ||
                           (task.steps || []).some(s => s.human_gate_pending);

      if (!hadHumanGate && task.status !== 'completed') {
        return json(res, 400, { error: `Task ${taskId} is not awaiting human approval` });
      }

      task.blocker = null;
      task.history = task.history || [];
      task.history.push({
        ts: helpers.nowIso(),
        event: 'gate_approved',
        by: req.karviUser || 'human',
        comment: comment || undefined,
      });

      const pendingStep = (task.steps || []).find(s => s.human_gate_pending);
      if (pendingStep) {
        pendingStep.human_gate_pending = false;
        pendingStep.human_gate_approved_at = helpers.nowIso();
        pendingStep.human_gate_approved_by = req.karviUser || 'human';
        if (comment) pendingStep.human_gate_comment = comment;
      }

      board.signals = board.signals || [];
      board.signals.push(createSignal({
        by: req.karviUser || 'human',
        type: 'gate_approved',
        content: `${taskId} approved via human gate${comment ? `: ${comment}` : ''}`,
        refs: [taskId],
        data: { taskId, comment, stepId: pendingStep?.step_id },
      }, helpers));

      helpers.writeBoard(board);
      helpers.appendLog({
        ts: helpers.nowIso(),
        event: 'gate_approved',
        taskId,
        by: req.karviUser || 'human',
        comment,
      });

      if (deps.tryAutoDispatch) {
        setImmediate(() => {
          try {
            deps.tryAutoDispatch(helpers.readBoard(), deps, helpers);
          } catch (err) {
            console.error(`[gate] tryAutoDispatch error for ${taskId}:`, err.message);
          }
        });
      }

      if (push && PUSH_TOKENS_PATH) {
        push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'task.approved', {
          gateAction: 'approve',
          comment,
        }).catch(() => {});
      }

      return json(res, 200, { ok: true, task: { id: task.id, status: task.status, blocker: null } });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  const rejectMatch = pathname.match(/^\/api\/gate\/([^/]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    if (!checkRemoteAuth(req, res, deps)) return;
    if (requireRole(req, res, 'operator')) return;

    const taskId = decodeURIComponent(rejectMatch[1]);
    helpers.parseBody(req).then(payload => {
      const comment = String(payload.comment || '').trim();
      if (!comment) {
        return json(res, 400, { error: 'comment is required when rejecting' });
      }

      const board = helpers.readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);

      if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

      const hadHumanGate = task.blocker?.type === 'human_review' ||
                           task.blocker?.reason?.toLowerCase().includes('human') ||
                           (task.steps || []).some(s => s.human_gate_pending);

      if (!hadHumanGate && task.status !== 'completed') {
        return json(res, 400, { error: `Task ${taskId} is not awaiting human approval` });
      }

      task.status = 'needs_revision';
      task.blocker = {
        type: 'human_rejected',
        reason: `Human gate rejected: ${comment}`,
        rejectedAt: helpers.nowIso(),
        rejectedBy: req.karviUser || 'human',
      };
      task.history = task.history || [];
      task.history.push({
        ts: helpers.nowIso(),
        event: 'gate_rejected',
        status: 'needs_revision',
        by: req.karviUser || 'human',
        comment,
      });

      const pendingStep = (task.steps || []).find(s => s.human_gate_pending);
      if (pendingStep) {
        pendingStep.human_gate_pending = false;
        pendingStep.human_gate_rejected_at = helpers.nowIso();
        pendingStep.human_gate_rejected_by = req.karviUser || 'human';
        pendingStep.human_gate_comment = comment;
      }

      board.signals = board.signals || [];
      board.signals.push(createSignal({
        by: req.karviUser || 'human',
        type: 'gate_rejected',
        content: `${taskId} rejected via human gate: ${comment}`,
        refs: [taskId],
        data: { taskId, comment, stepId: pendingStep?.step_id },
      }, helpers));

      helpers.writeBoard(board);
      helpers.appendLog({
        ts: helpers.nowIso(),
        event: 'gate_rejected',
        taskId,
        by: req.karviUser || 'human',
        comment,
      });

      if (push && PUSH_TOKENS_PATH) {
        push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'task.needs_revision', {
          gateAction: 'reject',
          comment,
        }).catch(() => {});
      }

      return json(res, 200, { ok: true, task: { id: task.id, status: task.status, blocker: task.blocker } });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  return false;
}

module.exports = gateRoutes;
