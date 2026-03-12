/**
 * routes/tasks-confidence.js — Confidence, timeline, report, digest routes
 *
 * GET/POST /api/tasks/:id/digest — L2 digest
 * GET/POST /api/tasks/:id/confidence — L1 confidence
 * GET  /api/tasks/:id/timeline — L3 timeline
 * GET  /api/tasks/:id/report — delivery report HTML
 */
const { json } = require('../blackboard-server');

function tasksConfidenceRoutes(req, res, helpers, deps) {
  const { digestTask, confidenceEngine, timelineTask } = deps;

  // --- L2 Digest API ---
  const digestMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/digest$/);
  if (req.method === 'GET' && digestMatch) {
    const taskId = decodeURIComponent(digestMatch[1]);
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    if (!task.digest) return json(res, 404, { error: 'No digest available' });
    return json(res, 200, task.digest);
  }

  if (req.method === 'POST' && digestMatch) {
    const taskId = decodeURIComponent(digestMatch[1]);
    if (!digestTask?.isDigestEnabled()) {
      return json(res, 503, { error: 'Digest not enabled (ANTHROPIC_API_KEY not set)' });
    }
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    digestTask.triggerDigest(taskId, 'manual', {
      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
    }).then(() => json(res, 200, { ok: true, taskId }))
      .catch(err => json(res, 500, { error: err.message }));
    return;
  }

  // --- L1 Confidence API ---
  const confidenceMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/confidence$/);
  if (req.method === 'GET' && confidenceMatch) {
    const taskId = decodeURIComponent(confidenceMatch[1]);
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    if (!task.confidence) return json(res, 404, { error: 'No confidence data available' });
    return json(res, 200, task.confidence);
  }

  if (req.method === 'POST' && confidenceMatch) {
    const taskId = decodeURIComponent(confidenceMatch[1]);
    if (!confidenceEngine) return json(res, 503, { error: 'Confidence engine not available' });
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    try {
      confidenceEngine.triggerConfidence(taskId, 'manual', {
        readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
        broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
      });
      const updated = helpers.readBoard();
      const updatedTask = (updated.taskPlan?.tasks || []).find(t => t.id === taskId);
      return json(res, 200, { ok: true, taskId, confidence: updatedTask?.confidence || null });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // --- L3 Timeline API ---
  const timelineMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/timeline$/);
  if (req.method === 'GET' && timelineMatch) {
    const taskId = decodeURIComponent(timelineMatch[1]);
    if (!timelineTask) return json(res, 503, { error: 'Timeline module not available' });
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    const timeline = timelineTask.assembleTimeline(board, task);
    return json(res, 200, { taskId, count: timeline.length, timeline });
  }

  const reportMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/report$/);
  if (req.method === 'GET' && reportMatch) {
    const taskId = decodeURIComponent(reportMatch[1]);
    if (!timelineTask) return json(res, 503, { error: 'Timeline module not available' });
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Task not found' });
    const timeline = timelineTask.assembleTimeline(board, task);
    const report = timelineTask.buildDeliveryReport(board, task, timeline);
    const html = timelineTask.renderReportHTML(report);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  return false; // not handled
}

module.exports = tasksConfidenceRoutes;
