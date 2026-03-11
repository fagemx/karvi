/**
 * routes/artifacts.js — Artifact Query API
 *
 * GET /api/artifacts              — query artifact metadata (board-indexed)
 * GET /api/artifacts/:run/:step/:kind — download specific artifact content
 * GET /api/artifacts/:run/:step/log/stream — tail -f style streaming log
 *
 * Query params for GET /api/artifacts:
 *   task    — filter by task ID (e.g., GH-123)
 *   step    — filter by step type (e.g., plan, implement, review)
 *   type    — filter by artifact kind (input, output, log)
 *   run_id  — filter by specific run ID
 */
const bb = require('../blackboard-server');
const { json } = bb;

function queryArtifacts(board, filters, artifactStore) {
  const tasks = board.taskPlan?.tasks || [];
  const kinds = ['input', 'output'];
  const results = [];

  for (const task of tasks) {
    if (filters.task && task.id !== filters.task) continue;

    for (const step of (task.steps || [])) {
      if (!step.run_id) continue;
      if (filters.step && step.type !== filters.step) continue;
      if (filters.run_id && step.run_id !== filters.run_id) continue;

      const targetKinds = filters.type ? [filters.type] : kinds;

      for (const kind of targetKinds) {
        const exists = artifactStore.artifactExists(step.run_id, step.step_id, kind);
        if (!exists) continue;

        const safeStepId = step.step_id.replace(/:/g, '_');
        results.push({
          task_id: task.id,
          step_id: step.step_id,
          step_type: step.type,
          run_id: step.run_id,
          kind,
          download_url: `/api/artifacts/${step.run_id}/${safeStepId}/${kind}`,
        });
      }
    }
  }

  return results;
}

function handleLogStream(req, res, runId, safeStepId, deps) {
  const stepId = safeStepId.replace(/_/g, ':');
  const url = new URL(req.url, 'http://localhost');
  const follow = url.searchParams.get('follow') !== 'false';
  const taskId = url.searchParams.get('taskId') || null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': bb.getCorsOrigin(deps.ctx, req),
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { }
  };

  sendEvent('connected', { ts: bb.nowIso(), runId, stepId });

  const existingLines = deps.artifactStore.readLogLines(runId, stepId);
  for (const line of existingLines) {
    if (taskId && line.taskId !== taskId) continue;
    sendEvent('log', line);
  }

  if (!follow) {
    sendEvent('end', { reason: 'no_follow' });
    res.end();
    return;
  }

  const stopWatch = deps.artifactStore.watchLog(runId, stepId, (entry) => {
    if (taskId && entry.taskId !== taskId) return;
    sendEvent('log', entry);
  });

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); stopWatch(); }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    stopWatch();
  });
}

module.exports = function artifactsRoutes(req, res, helpers, deps) {
  if (req.method !== 'GET') return false;

  const streamMatch = req.url.match(/^\/api\/artifacts\/([^/]+)\/([^/]+)\/log\/stream(\?|$)/);
  if (streamMatch) {
    const [, runId, safeStepId] = streamMatch;
    return handleLogStream(req, res, runId, safeStepId, deps);
  }

  const downloadMatch = req.url.match(/^\/api\/artifacts\/([^/]+)\/([^/]+)\/([^/?]+)/);
  if (downloadMatch) {
    const [, runId, safeStepId, kind] = downloadMatch;
    const stepId = safeStepId.replace(/_/g, ':');

    if (!['input', 'output', 'log'].includes(kind)) {
      return json(res, 400, { error: `invalid artifact kind: ${kind}` });
    }

    const data = deps.artifactStore.readArtifact(runId, stepId, kind);
    if (data === null) {
      return json(res, 404, { error: 'artifact not found' });
    }
    return json(res, 200, data);
  }

  const listMatch = req.url.match(/^\/api\/artifacts(\?|$)/);
  if (!listMatch) return false;

  const url = new URL(req.url, 'http://localhost');
  const filters = {
    task: url.searchParams.get('task') || null,
    step: url.searchParams.get('step') || null,
    type: url.searchParams.get('type') || null,
    run_id: url.searchParams.get('run_id') || null,
  };

  const board = helpers.readBoard();
  const artifacts = queryArtifacts(board, filters, deps.artifactStore);
  return json(res, 200, { artifacts });
};
