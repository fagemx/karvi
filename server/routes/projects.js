/**
 * routes/projects.js — Project Orchestrator API
 *
 * POST   /api/projects          — create/add tasks (unified endpoint)
 * GET    /api/projects          — list all projects with progress
 * GET    /api/projects/:id      — single project with progress
 * POST   /api/projects/:id/pause  — pause project
 * POST   /api/projects/:id/resume — resume project
 */
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const { json } = bb;

/**
 * Detect circular dependencies using string task IDs.
 * @param {Array<{id: string, depends: string[]}>} normalizedTasks
 * @returns {boolean}
 */
function hasCycle(normalizedTasks) {
  const adj = new Map();
  for (const t of normalizedTasks) {
    adj.set(t.id, t.depends || []);
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

  for (const t of normalizedTasks) {
    if (dfs(t.id)) return true;
  }
  return false;
}

/**
 * Normalize task entry — supports both legacy (issue-based) and unified (id-based) formats.
 */
function normalizeTask(entry, repo) {
  if (entry.issue && typeof entry.issue === 'number') {
    return {
      id: `GH-${entry.issue}`,
      title: entry.title || `Issue #${entry.issue}`,
      assignee: entry.assignee || null,
      depends: (entry.depends || []).map(d => typeof d === 'number' ? `GH-${d}` : d),
      type: 'gh',
      source: repo || null,
      githubIssue: entry.issue,
      description: entry.description || '',
      spec: entry.spec || null,
      skill: entry.skill || null,
      estimate: entry.estimate || null,
      target_repo: entry.target_repo || null,
    };
  }
  if (entry.id && typeof entry.id === 'string') {
    return {
      id: entry.id,
      title: entry.title || entry.id,
      assignee: entry.assignee || null,
      depends: entry.depends || [],
      description: entry.description || '',
      spec: entry.spec || null,
      skill: entry.skill || null,
      estimate: entry.estimate || null,
      target_repo: entry.target_repo || null,
    };
  }
  throw new Error(`task must have either 'issue' (number) or 'id' (string): ${JSON.stringify(entry)}`);
}

const SKILLS_NEEDING_BRIEF = new Set(['conversapix-storyboard']);

function ensureBriefsDir(dataDir) {
  const d = path.join(dataDir, 'briefs');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
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
  const DATA_DIR = path.resolve(__dirname, '..');

  // POST /api/projects (canonical) + POST /api/project (deprecated alias)
  if (req.method === 'POST' && (req.url === '/api/projects' || req.url === '/api/project')) {
    if (req.url === '/api/project') {
      helpers.appendLog({ ts: helpers.nowIso(), event: 'deprecated_api', endpoint: '/api/project', message: 'Use POST /api/projects instead' });
    }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        const { title, repo, concurrency, completionTrigger, autoStart } = input;
        const rawTasks = input.tasks;

        if (!title || typeof title !== 'string') return json(res, 400, { error: 'title is required' });
        if (!Array.isArray(rawTasks) || rawTasks.length === 0) return json(res, 400, { error: 'tasks array is required and must not be empty' });

        // Normalize tasks — supports both { issue } and { id } formats
        const normalized = rawTasks.map(t => normalizeTask(t, repo));

        // Validate: no duplicate IDs
        const ids = new Set();
        for (const t of normalized) {
          if (ids.has(t.id)) return json(res, 400, { error: `duplicate task id: ${t.id}` });
          ids.add(t.id);
        }

        // Validate completion trigger (only when creating a project entity)
        const trigger = completionTrigger || 'pr_merged';
        if (repo && trigger !== 'pr_merged' && trigger !== 'approved') {
          return json(res, 400, { error: 'completionTrigger must be pr_merged or approved' });
        }

        // Cycle detection
        if (hasCycle(normalized)) {
          return json(res, 400, { error: 'circular dependency detected in tasks' });
        }

        const board = helpers.readBoard();
        board.projects = board.projects || [];
        board.taskPlan = board.taskPlan || { tasks: [] };
        board.taskPlan.tasks = board.taskPlan.tasks || [];

        if (input.goal || title) board.taskPlan.goal = input.goal || title;
        if (title) board.taskPlan.title = title;
        if (!board.taskPlan.phase) board.taskPlan.phase = 'planning';
        if (!board.taskPlan.createdAt) board.taskPlan.createdAt = helpers.nowIso();
        if (input.spec) board.taskPlan.spec = input.spec;

        // Create project entity only when repo is provided
        let projectId = null;
        if (repo) {
          projectId = helpers.uid('PROJ');
        }

        const ACTIVE_STATUSES = ['in_progress', 'dispatched'];
        const SAFE_FIELDS = ['title', 'description', 'assignee', 'depends', 'spec', 'skill', 'estimate', 'target_repo'];
        const existingIds = new Set(board.taskPlan.tasks.map(t => t.id));
        const newTasks = [];
        const taskIds = [];

        for (const t of normalized) {
          taskIds.push(t.id);
          const existing = existingIds.has(t.id) ? board.taskPlan.tasks.find(e => e.id === t.id) : null;

          if (existing) {
            if (projectId) {
              existing.projectId = projectId;
              existing.completionTrigger = trigger;
            }
            if (!ACTIVE_STATUSES.includes(existing.status)) {
              for (const k of SAFE_FIELDS) { if (t[k] !== undefined) existing[k] = t[k]; }
              if (t.depends?.length === 0 && existing.status === 'pending') {
                existing.status = 'dispatched';
              }
              existing.history = existing.history || [];
              existing.history.push({ ts: helpers.nowIso(), status: 'updated', by: 'api' });
            }
          } else {
            const newTask = {
              id: t.id,
              title: t.title,
              assignee: t.assignee || null,
              status: (t.depends?.length > 0) ? 'pending' : 'dispatched',
              depends: t.depends || [],
              description: t.description || '',
              spec: t.spec || null,
              skill: t.skill || null,
              estimate: t.estimate || null,
              target_repo: t.target_repo || null,
              history: [{ ts: helpers.nowIso(), status: (t.depends?.length > 0) ? 'pending' : 'dispatched', reason: 'project_created' }],
            };
            if (t.type) newTask.type = t.type;
            if (t.source) newTask.source = t.source;
            if (t.githubIssue) newTask.githubIssue = t.githubIssue;
            if (projectId) {
              newTask.projectId = projectId;
              newTask.completionTrigger = trigger;
            }
            newTasks.push(newTask);
            board.taskPlan.tasks.push(newTask);
          }
        }

        // S8: Auto-create scoped boards (briefs) for new tasks with matching skills
        for (const t of newTasks) {
          if (t.skill && SKILLS_NEEDING_BRIEF.has(t.skill)) {
            ensureBriefsDir(DATA_DIR);
            const briefPath = `briefs/${t.id}.json`;
            t.briefPath = briefPath;
            const emptyBrief = {
              meta: { boardType: 'brief', version: 1, taskId: t.id },
              project: { name: title },
              shotspec: { status: 'pending', shots: [] },
              refpack: { status: 'empty', assets: {} },
              controls: { auto_retry: true, max_retries: 3, quality_threshold: 85, paused: false },
              log: [{ time: helpers.nowIso(), agent: 'system', action: 'brief_created', detail: `auto-created for ${t.id}` }],
            };
            fs.writeFileSync(path.resolve(DATA_DIR, briefPath), JSON.stringify(emptyBrief, null, 2));
          }
        }

        // Create project entity if repo was provided
        let project = null;
        if (projectId) {
          project = {
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

          mgmt.ensureEvolutionFields(board);
          board.signals.push({
            id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'project-orchestrator',
            type: 'project_created',
            content: `Project "${title}" created with ${taskIds.length} tasks`,
            refs: taskIds,
            data: { projectId, taskIds },
          });
          if (board.signals.length > 500) board.signals = board.signals.slice(-500);
        }

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'project_created', title, projectId, taskCount: taskIds.length });
        helpers.broadcastSSE('board', board);

        const result = { ok: true, title, taskCount: taskIds.length };
        if (project) {
          result.project = project;
          result.progress = computeProgress(board, project);
        }

        // Auto-dispatch
        if (deps.tryAutoDispatch) {
          const dispatchable = taskIds.filter(tid => {
            const t = board.taskPlan.tasks.find(tt => tt.id === tid);
            return t && t.status === 'dispatched';
          });
          for (const tid of dispatchable) {
            setImmediate(() => deps.tryAutoDispatch(tid));
          }
        }

        // autoStart: dispatch first ready task via dispatchTask
        if (autoStart && deps.dispatchTask) {
          const nextTask = mgmt.pickNextTask(board);
          if (nextTask) {
            const dr = deps.dispatchTask(nextTask, board, { source: 'project-autostart' });
            result.autoStarted = nextTask.id;
            if (dr) result.planId = dr.planId;
          }
        }

        json(res, 201, result);
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
