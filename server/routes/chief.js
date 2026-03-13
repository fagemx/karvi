/**
 * routes/chief.js — Chief-level governance actions
 *
 * POST /api/chief/create-issue — Create GitHub issue via gh CLI and add as task
 * POST /api/chief/reorder       — Reorder tasks in DAG (priority, dependencies)
 * POST /api/chief/split-task    — Split a task into subtasks
 *
 * All endpoints require operator role.
 */
const { spawn } = require('child_process');
const bb = require('../blackboard-server');
const { json } = bb;
const { requireRole, createSignal } = require('./_shared');

/**
 * Execute gh CLI command with proper Windows handling.
 * @param {string[]} args - gh CLI arguments
 * @param {object} opts - spawn options
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function execGh(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : 'gh';
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'gh', ...args]
      : args;

    const child = spawn(spawnCmd, spawnArgs, {
      ...opts,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);

    child.on('error', err => reject(err));
    child.on('close', code => resolve({ stdout, stderr, code }));
  });
}

/**
 * Parse gh issue create output to extract issue number and URL.
 * @param {string} stdout
 * @returns {{ number: number, url: string } | null}
 */
function parseGhIssueCreate(stdout) {
  const urlMatch = stdout.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (urlMatch) {
    return {
      number: parseInt(urlMatch[2], 10),
      url: urlMatch[0],
      repo: urlMatch[1],
    };
  }
  return null;
}

/**
 * Generate next subtask ID.
 * Pattern: ParentTaskId-1, ParentTaskId-2, etc.
 */
function nextSubtaskId(parentId, existingSubtasks) {
  const prefix = parentId + '-';
  const nums = existingSubtasks
    .map(t => {
      if (t.id && t.id.startsWith(prefix)) {
        const m = t.id.match(/-(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      }
      return 0;
    })
    .filter(n => n > 0);
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `${prefix}${max + 1}`;
}

module.exports = function chiefRoutes(req, res, helpers, deps) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // POST /api/chief/create-issue — Create GitHub issue and add as task
  if (req.method === 'POST' && pathname === '/api/chief/create-issue') {
    if (requireRole(req, res, 'operator')) return;

    helpers.parseBody(req).then(async body => {
      try {
        if (!body.title) {
          return json(res, 400, { error: 'title is required' });
        }

        const board = helpers.readBoard();

        // Build gh issue create command
        const ghArgs = ['issue', 'create', '--title', body.title];

        if (body.body) {
          ghArgs.push('--body', body.body);
        }

        if (Array.isArray(body.labels) && body.labels.length > 0) {
          ghArgs.push('--label', body.labels.join(','));
        }

        if (body.milestone) {
          ghArgs.push('--milestone', body.milestone);
        }

        if (body.assignee) {
          ghArgs.push('--assignee', body.assignee);
        }

        // Optional: --repo flag for different repo
        if (body.repo) {
          ghArgs.push('--repo', body.repo);
        }

        // Execute gh CLI
        const result = await execGh(ghArgs);

        if (result.code !== 0) {
          console.error(`[chief/create-issue] gh CLI failed: ${result.stderr}`);
          return json(res, 500, {
            error: 'gh_cli_failed',
            message: result.stderr.trim() || 'gh issue create returned non-zero exit code',
          });
        }

        const parsed = parseGhIssueCreate(result.stdout);
        if (!parsed) {
          console.error(`[chief/create-issue] failed to parse gh output: ${result.stdout}`);
          return json(res, 500, {
            error: 'parse_failed',
            message: 'Could not parse gh issue create output',
            stdout: result.stdout,
          });
        }

        // Add task to board
        const { number, url: issueUrl, repo } = parsed;
        const taskId = `GH-${number}`;

        if (!board.taskPlan) board.taskPlan = { goal: '', phase: 'idle', tasks: [] };
        if (!Array.isArray(board.taskPlan.tasks)) board.taskPlan.tasks = [];

        const existing = board.taskPlan.tasks.find(t => t.id === taskId);
        if (existing) {
          return json(res, 409, {
            error: 'task_exists',
            message: `Task ${taskId} already exists`,
            task: existing,
            issue: { number, url: issueUrl },
          });
        }

        const task = {
          id: taskId,
          title: body.title,
          description: body.body || '',
          status: 'dispatched',
          source: {
            type: 'github_issue',
            number,
            repo,
            url: issueUrl,
            createdBy: 'chief_action',
          },
          githubIssue: { number, repo },
          priority: body.priority || 'P2',
          assignee: body.taskAssignee || 'engineer_lite',
          depends: Array.isArray(body.depends) ? body.depends : [],
          history: [{ ts: helpers.nowIso(), status: 'created', by: 'chief/create-issue' }],
        };

        board.taskPlan.tasks.push(task);

        // Create signal
        board.signals = board.signals || [];
        board.signals.push(createSignal({
          type: 'chief_issue_created',
          content: `Chief created issue #${number}: ${body.title}`,
          refs: [taskId],
          data: { taskId, issueNumber: number, issueUrl, repo },
        }, req, helpers));

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'chief_issue_created',
          taskId,
          issueNumber: number,
          issueUrl,
          title: body.title,
        });
        helpers.broadcastSSE('board', board);

        // Auto-dispatch if enabled
        if (deps.tryAutoDispatch) {
          setImmediate(() => deps.tryAutoDispatch(taskId));
        }

        return json(res, 201, {
          ok: true,
          taskId,
          issue: { number, url: issueUrl, repo },
          task,
        });
      } catch (error) {
        console.error('[chief/create-issue] error:', error);
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // POST /api/chief/reorder — Reorder tasks in DAG
  if (req.method === 'POST' && pathname === '/api/chief/reorder') {
    if (requireRole(req, res, 'operator')) return;

    helpers.parseBody(req).then(body => {
      try {
        const board = helpers.readBoard();
        const tasks = board.taskPlan?.tasks || [];

        if (!body.taskId) {
          return json(res, 400, { error: 'taskId is required' });
        }

        const task = tasks.find(t => t.id === body.taskId);
        if (!task) {
          return json(res, 404, { error: `Task ${body.taskId} not found` });
        }

        const changes = {};

        // Update priority
        if (body.priority !== undefined) {
          const validPriorities = ['P0', 'P1', 'P2', 'P3'];
          if (!validPriorities.includes(body.priority)) {
            return json(res, 400, {
              error: `Invalid priority. Must be one of: ${validPriorities.join(', ')}`,
            });
          }
          task.priority = body.priority;
          changes.priority = body.priority;
        }

        // Update wave
        if (body.wave !== undefined) {
          if (body.wave !== null && (typeof body.wave !== 'number' || !Number.isInteger(body.wave) || body.wave < 0)) {
            return json(res, 400, { error: 'wave must be null or a non-negative integer' });
          }
          task.wave = body.wave;
          changes.wave = body.wave;
        }

        // Add dependencies
        if (Array.isArray(body.addDepends)) {
          for (const depId of body.addDepends) {
            if (!task.depends.includes(depId)) {
              const depTask = tasks.find(t => t.id === depId);
              if (!depTask) {
                return json(res, 400, { error: `Dependency task ${depId} not found` });
              }
              task.depends.push(depId);
            }
          }
          changes.addDepends = body.addDepends;
        }

        // Remove dependencies
        if (Array.isArray(body.removeDepends)) {
          task.depends = task.depends.filter(d => !body.removeDepends.includes(d));
          changes.removeDepends = body.removeDepends;
        }

        // Validate DAG after changes (no cycles)
        if (task.depends.length > 0) {
          const visited = new Set();
          const hasCycle = (taskId, path = new Set()) => {
            if (path.has(taskId)) return true;
            if (visited.has(taskId)) return false;
            visited.add(taskId);
            path.add(taskId);
            const t = tasks.find(x => x.id === taskId);
            if (t && t.depends) {
              for (const dep of t.depends) {
                if (hasCycle(dep, new Set(path))) return true;
              }
            }
            return false;
          };
          // Check for cycles starting from this task
          const cycleCheck = (startId, visitedPath = new Set()) => {
            if (visitedPath.has(startId)) return true;
            visitedPath.add(startId);
            const t = tasks.find(x => x.id === startId);
            if (t && t.depends) {
              for (const dep of t.depends) {
                if (cycleCheck(dep, visitedPath)) return true;
              }
            }
            return false;
          };
          if (cycleCheck(task.id)) {
            return json(res, 400, { error: 'Dependency change would create a cycle' });
          }
        }

        // Update task status if it was pending and now has no deps
        if (task.status === 'pending' && task.depends.length === 0) {
          task.status = 'dispatched';
          changes.statusChanged = { from: 'pending', to: 'dispatched' };
        }

        task.history = task.history || [];
        task.history.push({
          ts: helpers.nowIso(),
          event: 'reordered',
          by: 'chief/reorder',
          changes,
        });

        // Create signal
        board.signals = board.signals || [];
        board.signals.push(createSignal({
          type: 'chief_task_reordered',
          content: `Task ${task.id} reordered`,
          refs: [task.id],
          data: { taskId: task.id, changes },
        }, req, helpers));

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'chief_task_reordered',
          taskId: task.id,
          changes,
        });
        helpers.broadcastSSE('board', board);

        // Try auto-dispatch if status changed to dispatched
        if (changes.statusChanged && deps.tryAutoDispatch) {
          setImmediate(() => deps.tryAutoDispatch(task.id));
        }

        return json(res, 200, { ok: true, taskId: task.id, changes, task });
      } catch (error) {
        console.error('[chief/reorder] error:', error);
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // POST /api/chief/split-task — Split task into subtasks
  if (req.method === 'POST' && pathname === '/api/chief/split-task') {
    if (requireRole(req, res, 'operator')) return;

    helpers.parseBody(req).then(body => {
      try {
        const board = helpers.readBoard();
        const tasks = board.taskPlan?.tasks || [];

        if (!body.taskId) {
          return json(res, 400, { error: 'taskId is required' });
        }

        const parentTask = tasks.find(t => t.id === body.taskId);
        if (!parentTask) {
          return json(res, 404, { error: `Task ${body.taskId} not found` });
        }

        if (!Array.isArray(body.subtasks) || body.subtasks.length === 0) {
          return json(res, 400, { error: 'subtasks must be a non-empty array' });
        }

        const createdSubtasks = [];
        const now = helpers.nowIso();

        // Parent task deps will become subtask deps
        const parentDeps = parentTask.depends || [];

        // Create subtasks
        for (const subtaskSpec of body.subtasks) {
          if (!subtaskSpec.title) {
            return json(res, 400, { error: 'Each subtask must have a title' });
          }

          const subtaskId = subtaskSpec.id || nextSubtaskId(parentTask.id, tasks);

          // Check for duplicate ID
          if (tasks.find(t => t.id === subtaskId)) {
            return json(res, 400, { error: `Task ID ${subtaskId} already exists` });
          }

          const subtask = {
            id: subtaskId,
            title: subtaskSpec.title,
            description: subtaskSpec.description || '',
            status: 'pending',
            parentTaskId: parentTask.id,
            source: {
              type: 'chief_split',
              parentTaskId: parentTask.id,
              createdBy: 'chief/split-task',
            },
            priority: subtaskSpec.priority || parentTask.priority || 'P2',
            assignee: subtaskSpec.assignee || parentTask.assignee || 'engineer_lite',
            depends: subtaskSpec.depends || [],
            history: [{ ts: now, status: 'created', by: 'chief/split-task', parentTaskId: parentTask.id }],
          };

          tasks.push(subtask);
          createdSubtasks.push(subtask);
        }

        // Chain subtasks: each depends on previous (if chain=true or unspecified)
        if (body.chain !== false && createdSubtasks.length > 1) {
          for (let i = 1; i < createdSubtasks.length; i++) {
            createdSubtasks[i].depends.push(createdSubtasks[i - 1].id);
          }
        }

        // First subtask inherits parent's dependencies
        if (createdSubtasks.length > 0) {
          createdSubtasks[0].depends = [...parentDeps, ...createdSubtasks[0].depends];
          // Set first subtask status based on deps
          if (createdSubtasks[0].depends.length === 0) {
            createdSubtasks[0].status = 'dispatched';
          }
        }

        // Update parent task to reference subtasks
        parentTask.subtaskIds = createdSubtasks.map(s => s.id);
        parentTask.history = parentTask.history || [];
        parentTask.history.push({
          ts: now,
          event: 'split',
          by: 'chief/split-task',
          subtaskCount: createdSubtasks.length,
          subtaskIds: parentTask.subtaskIds,
        });

        // Create signal
        board.signals = board.signals || [];
        board.signals.push(createSignal({
          type: 'chief_task_split',
          content: `Task ${parentTask.id} split into ${createdSubtasks.length} subtasks`,
          refs: [parentTask.id, ...createdSubtasks.map(s => s.id)],
          data: {
            parentTaskId: parentTask.id,
            subtaskIds: createdSubtasks.map(s => s.id),
          },
        }, req, helpers));

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: now,
          event: 'chief_task_split',
          parentTaskId: parentTask.id,
          subtaskIds: createdSubtasks.map(s => s.id),
        });
        helpers.broadcastSSE('board', board);

        // Auto-dispatch first subtask if ready
        if (deps.tryAutoDispatch && createdSubtasks[0]?.status === 'dispatched') {
          setImmediate(() => deps.tryAutoDispatch(createdSubtasks[0].id));
        }

        return json(res, 201, {
          ok: true,
          parentTaskId: parentTask.id,
          subtasks: createdSubtasks.map(s => ({
            id: s.id,
            title: s.title,
            status: s.status,
            depends: s.depends,
          })),
        });
      } catch (error) {
        console.error('[chief/split-task] error:', error);
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  return false;
};

module.exports.execGh = execGh;
module.exports.parseGhIssueCreate = parseGhIssueCreate;
module.exports.nextSubtaskId = nextSubtaskId;
