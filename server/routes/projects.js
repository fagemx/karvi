/**
 * routes/projects.js — Project Orchestrator API
 *
 * POST   /api/projects          — create project (batch of GH tasks with deps)
 * GET    /api/projects          — list all projects with progress
 * GET    /api/projects/:id      — single project with progress
 * POST   /api/projects/:id/pause  — pause project
 * POST   /api/projects/:id/resume — resume project
 */
const bb = require('../blackboard-server');
const { json } = bb;

/**
 * Detect circular dependencies in a task graph.
 * @param {Array<{issue: number, depends: number[]}>} tasks
 * @returns {boolean} true if a cycle exists
 */
function hasCycle(tasks) {
  const adj = new Map();
  for (const t of tasks) {
    adj.set(t.issue, t.depends || []);
  }
  const visited = new Set();
  const inStack = new Set();

  function dfs(node) {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of (adj.get(node) || [])) {
      if (dfs(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const t of tasks) {
    if (dfs(t.issue)) return true;
  }
  return false;
}

/**
 * Compute real-time progress for a project.
 */
function computeProgress(board, project) {
  const allTasks = board.taskPlan?.tasks || [];
  const projectTasks = allTasks.filter(t => t.projectId === project.id);
  const total = projectTasks.length;
  if (total === 0) return { total: 0, done: 0, in_progress: 0, pending: 0, blocked: 0, pct: 0 };

  let done = 0, in_progress = 0, pending = 0, blocked = 0;
  for (const t of projectTasks) {
    if (project.completionTrigger === 'pr_merged') {
      if (t.pr?.outcome === 'merged') { done++; continue; }
    } else {
      if (t.status === 'approved') { done++; continue; }
    }
    if (t.status === 'blocked') { blocked++; }
    else if (t.status === 'pending') { pending++; }
    else { in_progress++; }
  }
  return { total, done, in_progress, pending, blocked, pct: Math.round((done / total) * 100) };
}

module.exports = function projectsRoutes(req, res, helpers, deps) {
  const { mgmt } = deps;

  // POST /api/projects — create project
  if (req.method === 'POST' && req.url === '/api/projects') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        const { title, repo, concurrency, completionTrigger, tasks } = input;

        // Validation
        if (!title || typeof title !== 'string') return json(res, 400, { error: 'title is required' });
        if (!repo || typeof repo !== 'string') return json(res, 400, { error: 'repo is required' });
        if (!Array.isArray(tasks) || tasks.length === 0) return json(res, 400, { error: 'tasks array is required and must not be empty' });

        // Validate completion trigger
        const trigger = completionTrigger || 'pr_merged';
        if (trigger !== 'pr_merged' && trigger !== 'approved') {
          return json(res, 400, { error: 'completionTrigger must be pr_merged or approved' });
        }

        // Validate task entries
        for (const entry of tasks) {
          if (!entry.issue || typeof entry.issue !== 'number') {
            return json(res, 400, { error: 'each task must have a numeric issue field' });
          }
        }

        // Cycle detection
        if (hasCycle(tasks)) {
          return json(res, 400, { error: 'circular dependency detected in tasks' });
        }

        const board = helpers.readBoard();
        board.projects = board.projects || [];
        board.taskPlan = board.taskPlan || { tasks: [] };

        const projectId = helpers.uid('PROJ');
        const taskIds = [];

        for (const entry of tasks) {
          const taskId = `GH-${entry.issue}`;
          const depIds = (entry.depends || []).map(d => `GH-${d}`);
          const existing = board.taskPlan.tasks.find(t => t.id === taskId);

          if (existing) {
            // Update existing task
            existing.depends = depIds;
            existing.projectId = projectId;
            existing.completionTrigger = trigger;
            if (depIds.length === 0 && existing.status === 'pending') {
              existing.status = 'dispatched';
              existing.history = existing.history || [];
              existing.history.push({ ts: helpers.nowIso(), status: 'dispatched', reason: 'project_no_deps' });
            }
          } else {
            // Create new GH task
            const newTask = {
              id: taskId,
              title: entry.title || `Issue #${entry.issue}`,
              status: depIds.length > 0 ? 'pending' : 'dispatched',
              assignee: entry.assignee || null,
              depends: depIds,
              type: 'gh',
              source: repo,
              githubIssue: entry.issue,
              projectId,
              completionTrigger: trigger,
              history: [{ ts: helpers.nowIso(), status: depIds.length > 0 ? 'pending' : 'dispatched', reason: 'project_created' }],
            };
            board.taskPlan.tasks.push(newTask);
          }
          taskIds.push(taskId);
        }

        const project = {
          id: projectId,
          title,
          repo,
          status: 'executing',
          concurrency: concurrency || 3,
          completionTrigger: trigger,
          taskIds,
          createdAt: helpers.nowIso(),
        };
        board.projects.push(project);

        // Signal
        mgmt.ensureEvolutionFields(board);
        board.signals.push({
          id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'project-orchestrator',
          type: 'project_created',
          content: `Project "${title}" created with ${taskIds.length} tasks`,
          refs: taskIds,
          data: { projectId, taskIds },
        });
        if (board.signals.length > 500) board.signals = board.signals.slice(-500);

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'project_created', projectId, taskIds });
        helpers.broadcastSSE('board', board);

        // Auto-dispatch no-dep tasks
        if (deps.tryAutoDispatch) {
          const dispatchable = taskIds.filter(tid => {
            const t = board.taskPlan.tasks.find(tt => tt.id === tid);
            return t && t.status === 'dispatched';
          });
          for (const tid of dispatchable) {
            setImmediate(() => deps.tryAutoDispatch(tid));
          }
        }

        json(res, 201, { ok: true, project, progress: computeProgress(board, project) });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return;
  }

  // GET /api/projects — list all
  if (req.method === 'GET' && req.url === '/api/projects') {
    try {
      const board = helpers.readBoard();
      const projects = (board.projects || []).map(p => ({
        ...p,
        progress: computeProgress(board, p),
      }));
      return json(res, 200, projects);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // GET /api/projects/:id
  const getMatch = req.method === 'GET' && req.url.match(/^\/api\/projects\/([^/]+)$/);
  if (getMatch) {
    try {
      const board = helpers.readBoard();
      const project = (board.projects || []).find(p => p.id === getMatch[1]);
      if (!project) return json(res, 404, { error: 'project not found' });
      const allTasks = board.taskPlan?.tasks || [];
      const projectTasks = allTasks.filter(t => t.projectId === project.id);
      return json(res, 200, {
        ...project,
        progress: computeProgress(board, project),
        tasks: projectTasks.map(t => ({ id: t.id, title: t.title, status: t.status, depends: t.depends, pr: t.pr })),
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // POST /api/projects/:id/pause
  if (req.method === 'POST' && req.url.match(/^\/api\/projects\/([^/]+)\/pause$/)) {
    const id = req.url.match(/^\/api\/projects\/([^/]+)\/pause$/)[1];
    try {
      const board = helpers.readBoard();
      const project = (board.projects || []).find(p => p.id === id);
      if (!project) return json(res, 404, { error: 'project not found' });
      if (project.status === 'done') return json(res, 400, { error: 'cannot pause a completed project' });
      project.status = 'paused';
      helpers.writeBoard(board);
      helpers.broadcastSSE('board', board);
      return json(res, 200, { ok: true, project });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // POST /api/projects/:id/resume
  if (req.method === 'POST' && req.url.match(/^\/api\/projects\/([^/]+)\/resume$/)) {
    const id = req.url.match(/^\/api\/projects\/([^/]+)\/resume$/)[1];
    try {
      const board = helpers.readBoard();
      const project = (board.projects || []).find(p => p.id === id);
      if (!project) return json(res, 404, { error: 'project not found' });
      if (project.status === 'done') return json(res, 400, { error: 'cannot resume a completed project' });
      project.status = 'executing';
      helpers.writeBoard(board);
      helpers.broadcastSSE('board', board);

      // Re-trigger dispatch for dispatched tasks
      if (deps.tryAutoDispatch) {
        const allTasks = board.taskPlan?.tasks || [];
        for (const tid of project.taskIds) {
          const t = allTasks.find(tt => tt.id === tid);
          if (t && t.status === 'dispatched') {
            setImmediate(() => deps.tryAutoDispatch(tid));
          }
        }
      }

      return json(res, 200, { ok: true, project });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  return false;
};

// Export for testing
module.exports.hasCycle = hasCycle;
module.exports.computeProgress = computeProgress;
