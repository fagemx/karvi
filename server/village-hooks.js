/**
 * village-hooks.js — Village lifecycle hooks called by kernel.js
 *
 * Extracts village-specific logic (cycle watchdog, plan dispatch, retro)
 * out of the kernel so kernel.js only handles core step pipeline routing.
 *
 * Hook points:
 *   onTaskBlocked  — dead_letter / human_review with meeting task stall detection
 *   onTaskDone     — synthesis plan dispatch + cycle completion check
 *   onTaskUnlocked — proposals_ready push for synthesis tasks
 */
const planDispatcher = require('./village/plan-dispatcher');
const cycleWatchdog = require('./village/cycle-watchdog');

/**
 * Check if a blocked/reviewed meeting task has stalled the cycle.
 * If stalled, closes the cycle and sends push notification.
 *
 * @param {object} board - Current board (mutated)
 * @param {string} taskId - The task that was blocked/reviewed
 * @param {object} task - The task object (may be null)
 * @param {object} helpers - { readBoard, writeBoard, appendLog, nowIso, uid, signalArchivePath }
 * @param {object} deps - { push, PUSH_TOKENS_PATH, mgmt }
 * @returns {boolean} true if cycle was stalled and closed (caller should return early)
 */
function onTaskBlocked(board, taskId, task, helpers, deps) {
  if (!cycleWatchdog.isMeetingTask(taskId)) return false;

  const health = cycleWatchdog.checkCycleHealth(board);
  if (!health.stalled) return false;

  cycleWatchdog.closeStalledCycle(board, helpers, health.reason, health);
  _pushTaskEvent(board, task, taskId, 'task.blocked', helpers, deps);
  return true;
}

/**
 * Handle village-specific logic when a task completes (action=done).
 *
 * 1. If synthesis task: dispatch plan or set human gate
 * 2. If execution phase: check if all cycle tasks are done, generate retro
 *
 * @param {object} board - Current board (mutated)
 * @param {object} task - The completed task
 * @param {object} step - The final step
 * @param {object} helpers - Route helpers
 * @param {object} deps - { artifactStore, push, PUSH_TOKENS_PATH, mgmt }
 */
async function onTaskDone(board, task, step, helpers, deps) {
  const { artifactStore, push, PUSH_TOKENS_PATH, mgmt } = deps;

  // --- Synthesis plan dispatch ---
  if (task && planDispatcher.isSynthesisTask(task)) {
    const autoApprove = board.village?.auto_approve !== false;

    if (autoApprove) {
      // Push: village.plan_ready
      if (push && PUSH_TOKENS_PATH) {
        const cycleId = board.village?.currentCycle?.cycleId;
        push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.plan_ready', { cycleId })
          .catch(err => {
            console.error(`[kernel] village.plan_ready push error:`, err.message);
            _pushFailedSignal(board, null, 'village.plan_ready', err, helpers, deps);
          });
      }
      const synthArtifact = artifactStore.readArtifact(step.run_id, step.step_id, 'output');
      const planData = planDispatcher.extractPlanFromArtifact(synthArtifact);
      if (planData) {
        await planDispatcher.parsePlanAndDispatch(board, planData, helpers, deps, task);
      } else {
        console.warn('[kernel] synthesis task completed but no plan found in artifact');
      }
    } else {
      // Human gate: update cycle phase and wait for manual approval
      if (board.village?.currentCycle) {
        board.village.currentCycle.phase = 'awaiting_approval';
      }
      if (push && PUSH_TOKENS_PATH) {
        push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.plan_ready', {
          cycleId: board.village?.currentCycle?.cycleId,
          needsApproval: true,
        }).catch(err => {
          console.error(`[kernel] push error for village.plan_ready (needsApproval):`, err.message);
          _pushFailedSignal(board, null, 'village.plan_ready', err, helpers, deps);
        });
      }
    }
  }

  // --- Cycle completion check ---
  if (board.village?.currentCycle?.phase === 'execution') {
    const cycleId = board.village.currentCycle.cycleId;
    const execTaskIds = board.village.currentCycle.executionTaskIds || [];
    if (execTaskIds.length > 0) {
      const allDone = execTaskIds.every(id => {
        const t = (board.taskPlan?.tasks || []).find(tt => tt.id === id);
        return t && (t.status === 'approved' || t.status === 'blocked');
      });
      if (allDone) {
        const retro = require('./village/retro');
        const retroSignals = retro.generateRetroSignals(board, cycleId, helpers);
        board.signals.push(...retroSignals);

        const retroLessons = retro.generateRetroLessons(board, cycleId, helpers);
        if (retroLessons.length > 0) {
          console.log(`[kernel] retro generated ${retroLessons.length} lessons for cycle ${cycleId}`);
        }

        board.village.currentCycle.phase = 'done';
        board.village.currentCycle.completedAt = helpers.nowIso();

        const completedCount = execTaskIds.filter(id => {
          const t = (board.taskPlan?.tasks || []).find(tt => tt.id === id);
          return t?.status === 'approved';
        }).length;
        if (push && PUSH_TOKENS_PATH) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.checkin_summary', {
            cycleId, completed: completedCount, total: execTaskIds.length,
            blocked: execTaskIds.length - completedCount,
          }).catch(err => {
            console.error(`[kernel] retro push error for village.checkin_summary:`, err.message);
            _pushFailedSignal(board, null, 'village.checkin_summary', err, helpers, deps);
          });
        }
      }
    }
  }
}

/**
 * Send village.proposals_ready push when a synthesis task is unlocked.
 *
 * @param {object} board - Current board
 * @param {string[]} unlocked - Array of unlocked task IDs
 * @param {object} helpers - Route helpers
 * @param {object} deps - { push, PUSH_TOKENS_PATH, mgmt }
 */
function onTaskUnlocked(board, unlocked, helpers, deps) {
  const { push, PUSH_TOKENS_PATH, mgmt } = deps;
  if (!push || !PUSH_TOKENS_PATH || unlocked.length === 0) return;

  const allTasks = board.taskPlan?.tasks || [];
  for (const uid of unlocked) {
    const unlockedTask = allTasks.find(t => t.id === uid);
    if (unlockedTask && planDispatcher.isSynthesisTask(unlockedTask)) {
      const cycleId = board.village?.currentCycle?.cycleId;
      const deptCount = board.village?.departments?.length || 0;
      push.notifyTaskEvent(PUSH_TOKENS_PATH, null, 'village.proposals_ready', {
        cycleId, departmentCount: deptCount,
      }).catch(err => {
        console.error(`[kernel] village.proposals_ready push error:`, err.message);
        _pushFailedSignal(board, null, 'village.proposals_ready', err, helpers, deps);
      });
    }
  }
}

// --- Internal helpers ---

function _pushTaskEvent(board, task, taskId, eventType, helpers, deps) {
  const { push, PUSH_TOKENS_PATH, mgmt } = deps;
  if (!push || !PUSH_TOKENS_PATH || !task) return;
  push.notifyTaskEvent(PUSH_TOKENS_PATH, task, eventType)
    .catch(err => {
      console.error(`[kernel] push error for task ${taskId}, event ${eventType}:`, err.message);
      _pushFailedSignal(board, taskId, eventType, err, helpers, deps);
    });
}

function _pushFailedSignal(board, taskId, eventType, err, helpers, deps) {
  board.signals.push({
    id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'kernel',
    type: 'push_failed',
    content: `Push notification failed for ${taskId || eventType}: ${err.message}`,
    refs: taskId ? [taskId] : [],
    data: { taskId: taskId || null, eventType, error: err.message },
  });
  deps.mgmt.trimSignals(board, helpers.signalArchivePath);
}

module.exports = { onTaskBlocked, onTaskDone, onTaskUnlocked };
