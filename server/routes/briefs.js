/**
 * routes/briefs.js — Scoped Board (Brief) API + Brief UI
 *
 * GET    /api/brief/:id — read brief
 * PATCH  /api/brief/:id — merge-patch brief
 * PUT    /api/brief/:id — replace brief
 * GET    /brief/:id — serve brief-panel UI
 */
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const { json } = bb;
const { deepMerge } = require('./_shared');

module.exports = function briefsRoutes(req, res, helpers, deps) {
  const { DIR, DATA_DIR } = deps;
  const BRIEFS_DIR = path.join(DATA_DIR, 'briefs');

  function readBrief(taskId) {
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task?.briefPath) return null;
    const p = path.resolve(DIR, task.briefPath);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  function writeBrief(taskId, data) {
    const board = helpers.readBoard();
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task?.briefPath) return false;

    data.meta = data.meta || {};
    data.meta.updatedAt = helpers.nowIso();
    data.meta.boardType = data.meta.boardType || 'brief';
    data.meta.version = data.meta.version || 1;
    data.meta.taskId = taskId;

    const p = path.resolve(DIR, task.briefPath);
    if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    helpers.broadcastSSE('brief', { taskId, data });
    return true;
  }

  const briefGetMatch = req.url.match(/^\/api\/brief\/([\w-]+)$/);
  if (req.method === 'GET' && briefGetMatch) {
    const taskId = decodeURIComponent(briefGetMatch[1]);
    const data = readBrief(taskId);
    if (!data) return json(res, 404, { error: 'no brief for this task' });
    return json(res, 200, data);
  }

  if (req.method === 'PATCH' && briefGetMatch) {
    const taskId = decodeURIComponent(briefGetMatch[1]);
    helpers.parseBody(req).then(patch => {
      const existing = readBrief(taskId);
      if (!existing) return json(res, 404, { error: 'no brief for this task' });
      const merged = deepMerge(existing, patch);
      writeBrief(taskId, merged);
      return json(res, 200, { ok: true, taskId });
    }).catch(err => json(res, err.statusCode === 413 ? 413 : 400, { error: err.message }));
    return;
  }

  if (req.method === 'PUT' && briefGetMatch) {
    const taskId = decodeURIComponent(briefGetMatch[1]);
    helpers.parseBody(req).then(data => {
      if (!writeBrief(taskId, data)) return json(res, 404, { error: 'no brief for this task' });
      return json(res, 200, { ok: true, taskId });
    }).catch(err => json(res, err.statusCode === 413 ? 413 : 400, { error: err.message }));
    return;
  }

  // /brief/:taskId -> serve brief-panel UI
  const briefUiMatch = req.url.match(/^\/brief\/([\w-]+)$/);
  if (req.method === 'GET' && briefUiMatch) {
    const briefPanelHtml = path.resolve(DIR, '..', '..', '..', 'skills',
      'conversapix-storyboard', 'tools', 'brief-panel', 'index.html');
    if (fs.existsSync(briefPanelHtml)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(briefPanelHtml, 'utf8'));
    }
    return json(res, 404, { error: 'brief-panel not installed' });
  }

  return false;
};
