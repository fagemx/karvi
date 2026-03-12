/**
 * routes/tasks-lifecycle.js — Task lifecycle routes
 *
 * POST /api/tasks/:id/reopen — reopen completed task
 * POST /api/tasks/:id/cancel — cancel task
 * POST /api/tasks/:id/unblock — unblock task
 * POST /api/tasks/:id/status — manual status control
 * POST /api/tasks/:id/rollback — git revert + state reset
 * DELETE /api/tasks/:id — remove task
 * POST /api/tasks/cleanup — batch remove
 */
const fs = require('fs');
const path = require('path');
const { json } = require('../blackboard-server');
const { participantById, pushMessage, requireRole, createSignal } = require('./_shared');
const routeEngine = require('../route-engine');
const worktreeHelper = require('../worktree');
const { resolveRepoRoot } = require('../repo-resolver');
const { BLOCKER_TYPES, shouldUnblockOnReset } = require('../blocker-types');

/**
 * Kill running steps and cancel non-completed steps for a task.
 */
function killAndCancelSteps(task, deps, reason, logPrefix = 'tasks') {
  let killedSteps = 0;
  let cancelledSteps = 0;
  for (const step of (task.steps || [])) {
    if (step.state === 'running') {
      try {
        const killResult = deps.stepWorker?.killStep?.(step.step_id);
        if (killResult?.ok) killedSteps++;
      } catch (err) {
        console.error(`[${logPrefix}] killStep failed for ${task.id}/${step.step_id}:`, err.message);
      }
      deps.stepSchema.transitionStep(step, 'cancelled', { error: reason });
      cancelledSteps++;
    } else if (step.state === 'cancelling' || step.state === 'queued' || step.state === 'failed') {
      deps.stepSchema.transitionStep(step, 'cancelled', { error: reason });
      cancelledSteps++;
    }
  }
  return { killedSteps, cancelledSteps };
}

/**
 * Schedule worktree cleanup with delay + retry for Windows file-handle races.
 */
function scheduleWorktreeCleanup(task, board, logPrefix = 'tasks') {
  if (!task.worktreeDir) return { attempted: false, scheduled: false };
  const repoRoot = resolveRepoRoot(task, board) || path.resolve(__dirname, '..', '..');
  const cleanTaskId = task.id;
  task.worktreeDir = null;
  task.worktreeBranch = null;
  setTimeout(() => {
    try {
      worktreeHelper.removeWorktree(repoRoot, cleanTaskId);
      console.log(`[${logPrefix}] worktree cleaned up for ${cleanTaskId}`);
    } catch (err) {
      console.error(`[${logPrefix}] worktree cleanup failed for ${cleanTaskId}:`, err.message);
      setTimeout(() => {
        try {
          worktreeHelper.removeWorktree(repoRoot, cleanTaskId);
        } catch (err2) {
          console.error(`[${logPrefix}] worktree cleanup retry failed for ${cleanTaskId}:`, err2.message);
        }
      }, 15000);
    }
  }, 3000);
  return { attempted: true, scheduled: true };
}

/**
 * Shared task cancellation flow.
 */
function cancelTaskFlow(task, board, deps, helpers, opts = {}) {
  const oldStatus = opts.oldStatus || task.status;
  const reason = String(opts.reason || 'Task cancelled').trim() || 'Task cancelled';
  const by = opts.by || 'human';

  task.status = 'cancelled';
  task.completedAt = helpers.nowIso();
  task.blocker = null;
  task.history = task.history || [];
  task.history.push({
    ts: helpers.nowIso(),
    status: 'cancelled',
    from: oldStatus,
    by,
    ...(opts.reason ? { reason: String(opts.reason).slice(0, 240) } : {}),
  });

  const { killedSteps, cancelledSteps } = killAndCancelSteps(task, deps, reason, 'cancel');
  const worktreeCleanup = scheduleWorktreeCleanup(task, board, 'cancel');

  return { killedSteps, cancelledSteps, worktreeCleanup };
}

/**
 * Remove a task from board entirely.
 */
function removeTask(board, taskId, deps, helpers) {
  const tasks = board.taskPlan?.tasks || [];
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;
  const task = tasks[idx];

  if (task.status !== 'cancelled' && task.status !== 'approved') {
    cancelTaskFlow(task, board, deps, helpers, { reason: 'Task removed' });
  }

  if (task.worktreeDir) {
    const repoRoot = resolveRepoRoot(task, board) || path.resolve(__dirname, '..', '..');
    task.worktreeDir = null;
    task.worktreeBranch = null;
    setTimeout(() => {
      try { worktreeHelper.removeWorktree(repoRoot, taskId); }
      catch (e) { console.error(`[tasks] removeTask worktree cleanup failed: ${e.message}`); }
    }, 3000);
  }

  helpers.appendLog({
    ts: helpers.nowIso(),
    event: 'task_removed',
    taskId: task.id,
    finalStatus: task.status,
    title: task.title,
  });

  tasks.splice(idx, 1);
  return task;
}

function tasksLifecycleRoutes(req, res, helpers, deps, internals) {
  const { mgmt, runtime, push, usage, ctx, jiraIntegration, digestTask, confidenceEngine, PUSH_TOKENS_PATH } = deps;
  const { tryAutoDispatch, dispatchTask, redispatchTask } = internals;

  // --- Unblock ---
  const unblockMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/unblock$/);
  if (req.method === 'POST' && unblockMatch) {
    if (requireRole(req, res, 'operator')) return;
    const taskId = decodeURIComponent(unblockMatch[1]);
    helpers.parseBody(req).then(payload => {
        const message = String(payload.message || '').trim();
        if (!message) return json(res, 400, { error: 'message is required to unblock' });

        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);

        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        if (task.status !== 'blocked') return json(res, 400, { error: `Task ${taskId} is not blocked` });

        const sessionId = task.childSessionKey || board.conversations?.[0]?.sessionIds?.[task.assignee] || null;

        task.status = 'in_progress';
        task.blocker = null;
        task.history.push({ ts: helpers.nowIso(), status: 'in_progress', unblockedBy: 'human', message });
        helpers.writeBoard(board);

        if (sessionId) {
          runtime.runOpenclawTurn({
            agentId: task.assignee,
            sessionId,
            message: `【Human 回覆你的 Blocked 問題】：\n${message}\n\n請根據此回覆繼續執行任務。`,
            timeoutSec: 180
          }).then(result => {
            const replyText = runtime.extractReplyText(result.parsed, result.stdout);
            const latestBoard = helpers.readBoard();
            const latestConv = latestBoard.conversations?.[0];
            if (latestConv) {
              pushMessage(latestConv, {
                id: helpers.uid('msg'),
                ts: helpers.nowIso(),
                type: 'message',
                from: task.assignee,
                to: 'human',
                text: `(Unblock Response for ${task.id})\n${replyText}`,
                sessionId
              });
              helpers.writeBoard(latestBoard);
            }
            helpers.appendLog({ ts: helpers.nowIso(), event: 'unblock_reply', taskId, reply: replyText });
          }).catch(err => {
            console.error(`[unblock dispatch err] ${err.message}`);
          });
        }

        json(res, 200, { ok: true, task });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  // --- Reopen ---
  const reopenMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/reopen$/);
  if (req.method === 'POST' && reopenMatch) {
    if (requireRole(req, res, 'operator')) return;
    const taskId = decodeURIComponent(reopenMatch[1]);
    helpers.parseBody(req).then(payload => {
        const message = String(payload.message || '').trim();
        const customSteps = payload.steps;

        const REOPENABLE_STATUSES = ['approved', 'needs_revision', 'blocked', 'completed'];
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);

        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        if (!REOPENABLE_STATUSES.includes(task.status)) {
          return json(res, 400, { error: `Cannot reopen task in ${task.status} status. Allowed: ${REOPENABLE_STATUSES.join(', ')}` });
        }
        if (!task.childSessionKey) {
          return json(res, 400, { error: 'No session to resume (childSessionKey missing)' });
        }

        const oldStatus = task.status;
        task.status = 'in_progress';
        delete task.result;
        delete task.completedAt;
        delete task.blocker;

        const runId = helpers.uid('run');
        const stepTypes = customSteps || ['implement', 'review'];
        const newSteps = mgmt.generateStepsForTask(task, runId, stepTypes, board);
        task.steps = task.steps || [];
        task.steps.push(...newSteps);
        task._revisionCounts = {};

        task.history = task.history || [];
        task.history.push({
          ts: helpers.nowIso(),
          status: 'in_progress',
          reopened_from: oldStatus,
          by: 'human',
          message: message || '(no message)'
        });

        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'task_reopened',
          content: `${taskId} reopened from ${oldStatus}`,
          refs: [taskId],
          data: { taskId, from: oldStatus, runId, steps: newSteps.map(s => s.step_id) },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'task_reopened',
          taskId,
          from: oldStatus,
          runId,
          stepCount: newSteps.length
        });

        const result = dispatchTask(task, board, deps, helpers, { source: 'reopen' });

        json(res, 200, {
          ok: true,
          task,
          reopened: {
            runId,
            steps: newSteps.map(s => s.step_id),
            sessionId: task.childSessionKey,
            dispatched: result.dispatched
          }
        });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  // --- Cancel ---
  const taskCancelMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && taskCancelMatch) {
    if (requireRole(req, res, 'operator')) return;
    const taskId = decodeURIComponent(taskCancelMatch[1]);
    helpers.parseBody(req).then(payload => {
        const reason = String(payload.reason || '').trim();
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        mgmt.ensureTaskTransition(oldStatus, 'cancelled');
        const cancelMeta = cancelTaskFlow(task, board, deps, helpers, {
          oldStatus,
          reason: reason || 'Task cancelled',
          by: 'human',
        });

        const conv = board.conversations?.[0];
        if (conv) {
          const detail = reason ? `\nreason: ${reason.slice(0, 240)}` : '';
          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] ${oldStatus} → cancelled${detail}`,
          });
        }

        const allApproved = board.taskPlan.tasks.every(t => t.status === 'approved' || t.status === 'cancelled');
        if (allApproved) board.taskPlan.phase = 'done';

        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'status_change',
          content: `${task.id} ${oldStatus} → cancelled`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: 'cancelled', assignee: task.assignee },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'task_cancelled',
          taskId,
          from: oldStatus,
          to: 'cancelled',
          killedSteps: cancelMeta.killedSteps,
          cancelledSteps: cancelMeta.cancelledSteps,
          reason: reason || null,
          worktreeCleanup: cancelMeta.worktreeCleanup,
        });

        if (jiraIntegration?.isEnabled(board)) {
          jiraIntegration.notifyJira(board, task, { type: 'status_change', newStatus: 'cancelled' })
            .catch(err => console.error('[jira] notify failed:', err.message));
        }

        if (push && PUSH_TOKENS_PATH) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'task.cancelled')
            .catch(err => console.error('[push] notify failed:', err.message));
          if (allApproved) {
            push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'all.approved')
              .catch(err => console.error('[push] all-approved notify failed:', err.message));
          }
        }

        json(res, 200, {
          ok: true,
          taskId,
          task,
          cancelled: {
            from: oldStatus,
            reason: reason || null,
            killedSteps: cancelMeta.killedSteps,
            cancelledSteps: cancelMeta.cancelledSteps,
            worktreeCleanup: cancelMeta.worktreeCleanup,
          },
        });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  // --- Manual status control ---
  const taskStatusMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === 'POST' && taskStatusMatch) {
    if (requireRole(req, res, 'operator')) return;
    const taskId = decodeURIComponent(taskStatusMatch[1]);
    helpers.parseBody(req).then(payload => {
        const newStatus = String(payload.status || '').trim();
        const validStatuses = ['pending', 'dispatched', 'in_progress', 'blocked', 'completed', 'reviewing', 'approved', 'needs_revision', 'cancelled'];
        if (!validStatuses.includes(newStatus)) {
          return json(res, 400, { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        mgmt.ensureTaskTransition(oldStatus, newStatus);
        let cancelMeta = null;
        if (newStatus === 'cancelled') {
          cancelMeta = cancelTaskFlow(task, board, deps, helpers, {
            oldStatus,
            reason: payload.reason || 'Task cancelled',
            by: 'human',
          });
        } else {
          task.status = newStatus;
          task.history = task.history || [];
          task.history.push({ ts: helpers.nowIso(), status: newStatus, from: oldStatus, by: 'human' });
        }

        const conv = board.conversations?.[0];
        if (conv) {
          const detail = payload.reason ? `\nreason: ${String(payload.reason).slice(0, 240)}` : '';
          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] ${oldStatus} → ${newStatus}${detail}`,
          });
        }

        if (newStatus === 'in_progress' && !task.startedAt) task.startedAt = helpers.nowIso();
        if (newStatus === 'in_progress') {
          task.reviewAttempts = 0;
        }
        if (newStatus === 'completed') {
          task.completedAt = helpers.nowIso();
          delete task.review;
        }
        if (newStatus === 'blocked' && payload.reason) {
          task.blocker = {
            type: payload.blocker?.type || BLOCKER_TYPES.MANUAL,
            reason: payload.reason,
            askedAt: helpers.nowIso()
          };
        }
        if (newStatus !== 'blocked') task.blocker = null;

        if (newStatus === 'approved') {
          const unlocked = mgmt.autoUnlockDependents(board);
          for (const id of unlocked) {
            setImmediate(() => tryAutoDispatch(id, deps, helpers));
          }
        }

        if (newStatus === 'dispatched') {
          setImmediate(() => tryAutoDispatch(task.id, deps, helpers));
        }

        const allApproved = board.taskPlan.tasks.every(t => t.status === 'approved' || t.status === 'cancelled');
        if (allApproved) board.taskPlan.phase = 'done';

        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'status_change',
          content: `${task.id} ${oldStatus} → ${newStatus}`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: newStatus, assignee: task.assignee },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'task_status_manual', taskId, from: oldStatus, to: newStatus });
        if (cancelMeta) {
          helpers.appendLog({
            ts: helpers.nowIso(),
            event: 'task_cancelled',
            taskId,
            from: oldStatus,
            to: 'cancelled',
            killedSteps: cancelMeta.killedSteps,
            cancelledSteps: cancelMeta.cancelledSteps,
            reason: payload.reason || null,
            worktreeCleanup: cancelMeta.worktreeCleanup,
          });
        }

        if (jiraIntegration?.isEnabled(board)) {
          jiraIntegration.notifyJira(board, task, { type: 'status_change', newStatus })
            .catch(err => console.error('[jira] notify failed:', err.message));
        }

        if (['completed', 'blocked', 'needs_revision', 'approved', 'cancelled'].includes(newStatus)) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, `task.${newStatus}`)
            .catch(err => console.error('[push] notify failed:', err.message));
        }
        if (allApproved) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'all.approved')
            .catch(err => console.error('[push] all-approved notify failed:', err.message));
        }

        if (newStatus === 'completed') {
          const ctrl = mgmt.getControls(board);
          if (ctrl.auto_review) setImmediate(() => runtime.spawnReview(taskId, {
            boardPath: ctx.boardPath,
            onComplete: (code) => {
              try {
                const updatedBoard = helpers.readBoard();
                helpers.broadcastSSE('board', updatedBoard);
                const ctrl2 = mgmt.getControls(updatedBoard);
                const t = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
                if (
                  ctrl2.auto_redispatch &&
                  t &&
                  t.status === 'needs_revision' &&
                  (t.reviewAttempts || 0) < ctrl2.max_review_attempts
                ) {
                  console.log(`[review:${taskId}] auto-redispatch triggered`);
                  setImmediate(() => redispatchTask(updatedBoard, t, deps, helpers));
                }
                if (confidenceEngine) {
                  try {
                    confidenceEngine.triggerConfidence(taskId, 'review_completed', {
                      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
                      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
                    });
                  } catch (err) { console.error(`[confidence:${taskId}] error:`, err.message); }
                }
                if (digestTask?.isDigestEnabled()) {
                  setImmediate(() => {
                    digestTask.triggerDigest(taskId, 'review_completed', {
                      readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
                      broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
                    }).catch(err => console.error(`[digest:${taskId}] error:`, err.message));
                  });
                }
              } catch (err) {
                console.error(`[review:${taskId}] post-review error: ${err.message}`);
              }
            },
          }));
        }

        if (newStatus === 'approved' && digestTask?.isDigestEnabled()) {
          setImmediate(() => {
            digestTask.triggerDigest(taskId, 'approved', {
              readBoard: helpers.readBoard, writeBoard: helpers.writeBoard,
              broadcastSSE: helpers.broadcastSSE, appendLog: helpers.appendLog,
            }).catch(err => console.error(`[digest:${taskId}] error:`, err.message));
          });
        }

        json(res, 200, { ok: true, task });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  // --- Rollback ---
  const taskRollbackMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/rollback$/);
  if (req.method === 'POST' && taskRollbackMatch) {
    const taskId = decodeURIComponent(taskRollbackMatch[1]);
    helpers.parseBody(req).then(payload => {
        const reason = String(payload.reason || '').trim();
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });

        const oldStatus = task.status;
        if (oldStatus === 'pending' || oldStatus === 'cancelled') {
          return json(res, 400, { error: `Cannot rollback task in ${oldStatus} state` });
        }

        // Phase 1: Kill running steps
        const { killedSteps, cancelledSteps } = killAndCancelSteps(task, deps, reason || 'Task rolled back', `rollback:${taskId}`);

        // Phase 2: Git revert (best-effort)
        let gitResult = { reverted: false, commits_reverted: 0, branch: null, error: null };
        if (task.worktreeDir && fs.existsSync(task.worktreeDir)) {
          const { execFileSync } = require('child_process');
          gitResult.branch = task.worktreeBranch || null;
          try {
            const logOutput = execFileSync('git', ['log', 'main..HEAD', '--format=%H'], {
              cwd: task.worktreeDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
            }).trim();
            const commits = logOutput ? logOutput.split('\n').filter(Boolean) : [];
            if (commits.length > 0) {
              execFileSync('git', ['revert', '--no-edit', 'main..HEAD'], {
                cwd: task.worktreeDir, timeout: 30000, stdio: 'pipe',
              });
              gitResult.reverted = true;
              gitResult.commits_reverted = commits.length;
              console.log(`[rollback:${taskId}] reverted ${commits.length} commit(s) on ${gitResult.branch}`);
            }
          } catch (err) {
            gitResult.error = err.message;
            console.error(`[rollback:${taskId}] git revert failed:`, err.message);
            try {
              execFileSync('git', ['revert', '--abort'], {
                cwd: task.worktreeDir, timeout: 5000, stdio: 'pipe',
              });
            } catch { /* revert wasn't in progress, ignore */ }
          }
        }

        // Phase 3: Worktree cleanup
        const worktreeCleanup = scheduleWorktreeCleanup(task, board, `rollback:${taskId}`);

        // Phase 4: Reset board state
        task.status = 'pending';
        task.steps = [];
        task.completedAt = null;
        task.startedAt = null;
        task.reviewAttempts = 0;
        task.blocker = null;
        delete task.review;
        task.history = task.history || [];
        task.history.push({
          ts: helpers.nowIso(),
          status: 'pending',
          from: oldStatus,
          by: 'human',
          action: 'rollback',
          ...(reason ? { reason: reason.slice(0, 240) } : {}),
        });

        // Phase 5: Signal + persist
        const conv = board.conversations?.[0];
        if (conv) {
          const detail = reason ? `\nreason: ${reason.slice(0, 240)}` : '';
          pushMessage(conv, {
            id: helpers.uid('msg'),
            ts: helpers.nowIso(),
            type: 'system',
            from: 'system',
            to: 'human',
            text: `[Task ${taskId}] rolled back: ${oldStatus} → pending${detail}`,
          });
        }

        mgmt.ensureEvolutionFields(board);
        board.signals.push(createSignal({
          type: 'task_rolled_back',
          content: `${task.id} ${oldStatus} → pending (rollback)`,
          refs: [task.id],
          data: { taskId: task.id, from: oldStatus, to: 'pending', reason: reason || null },
        }, req, helpers));
        mgmt.trimSignals(board, helpers.signalArchivePath);

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'task_rolled_back',
          taskId,
          from: oldStatus,
          to: 'pending',
          killedSteps,
          cancelledSteps,
          git: gitResult,
          worktreeCleanup,
          reason: reason || null,
        });
        helpers.broadcastSSE('board', board);

        if (push && PUSH_TOKENS_PATH) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'task.rolled_back')
            .catch(err => console.error('[push] rollback notify failed:', err.message));
        }

        json(res, 200, {
          ok: true,
          taskId,
          task,
          rollback: {
            from: oldStatus,
            to: 'pending',
            git: gitResult,
            killedSteps,
            cancelledSteps,
            worktreeCleanup,
            reason: reason || null,
          },
        });
    }).catch(error => json(res, error.statusCode === 413 ? 413 : 400, { error: error.message }));
    return;
  }

  // --- DELETE /api/tasks/:id ---
  const deleteTaskMatch = req.url.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteTaskMatch) {
    if (requireRole(req, res, 'admin')) return;
    const taskId = decodeURIComponent(deleteTaskMatch[1]);
    const board = helpers.readBoard();
    const removed = removeTask(board, taskId, deps, helpers);
    if (!removed) return json(res, 404, { error: `Task ${taskId} not found` });
    helpers.writeBoard(board);
    helpers.broadcastSSE('board', board);
    return json(res, 200, { removed: taskId, finalStatus: removed.status });
  }

  // --- POST /api/tasks/cleanup ---
  if (req.method === 'POST' && req.url === '/api/tasks/cleanup') {
    if (requireRole(req, res, 'admin')) return;
    helpers.parseBody(req).then(payload => {
        const statuses = payload.statuses || ['cancelled', 'blocked'];
        const olderThanHours = payload.older_than_hours || 0;
        const board = helpers.readBoard();
        const now = Date.now();
        const cutoff = olderThanHours > 0 ? now - (olderThanHours * 3600_000) : now;

        const toRemove = (board.taskPlan?.tasks || []).filter(t => {
          if (!statuses.includes(t.status)) return false;
          if (t.status === 'blocked') {
            const hasRunning = (t.steps || []).some(s => s.state === 'running');
            if (hasRunning) return false;
          }
          if (olderThanHours <= 0) return true;
          const ts = t.completedAt || t.startedAt || t.createdAt;
          if (!ts) return true;
          return new Date(ts).getTime() <= cutoff;
        });

        const removedIds = [];
        for (const t of toRemove) {
          removeTask(board, t.id, deps, helpers);
          removedIds.push(t.id);
        }

        if (removedIds.length > 0) {
          helpers.writeBoard(board);
          helpers.broadcastSSE('board', board);
        }
        json(res, 200, { removed: removedIds, count: removedIds.length });
    }).catch(err => json(res, err.statusCode === 413 ? 413 : 500, { error: err.message }));
    return;
  }

  return false; // not handled
}

// Export helpers for use by the parent tasks.js module
tasksLifecycleRoutes.killAndCancelSteps = killAndCancelSteps;
tasksLifecycleRoutes.scheduleWorktreeCleanup = scheduleWorktreeCleanup;
tasksLifecycleRoutes.cancelTaskFlow = cancelTaskFlow;
tasksLifecycleRoutes.removeTask = removeTask;

module.exports = tasksLifecycleRoutes;
