/**
 * cycle-watchdog.js -- Cycle-Level Stall Detection
 *
 * Pure logic module -- no timers, no I/O of its own.
 * Called by:
 *   1. kernel.js (reactive): when a meeting task dies -> immediate check
 *   2. village-scheduler.js (periodic): hourly time-based stall detection
 *
 * Two detection modes:
 *   A) Task-exhaustion: all meeting tasks are terminal (blocked/dead)
 *   B) Time-based: phase stuck longer than stallTimeoutMs
 */

const mgmt = require('../management');
const { createSignal } = require('../signal');

const DEFAULT_STALL_TIMEOUT_MS = 4 * 3_600_000; // 4 hours

const TERMINAL_STATUSES = new Set(["blocked"]);

function isTaskTerminal(allTasks, taskId) {
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return true; // orphaned reference = terminal
  return TERMINAL_STATUSES.has(task.status);
}

function hasUnresolvableDependency(allTasks, task) {
  if (!task || !Array.isArray(task.depends) || task.depends.length === 0) return false;
  return task.depends.some(depId => {
    const dep = allTasks.find(t => t.id === depId);
    if (!dep) return true;
    return TERMINAL_STATUSES.has(dep.status);
  });
}

function checkCycleHealth(board, stallTimeoutMs) {
  const timeout = stallTimeoutMs || DEFAULT_STALL_TIMEOUT_MS;
  const cycle = board.village?.currentCycle;

  if (!cycle) return { stalled: false };
  if (cycle.phase === "done") return { stalled: false };
  if (cycle.phase === "execution") return { stalled: false };

  const allTasks = board.taskPlan?.tasks || [];
  const meetingTaskIds = cycle.taskIds || [];

  // Mode A: Task-exhaustion detection (proposal/synthesis phases)
  if (cycle.phase === "proposal" || cycle.phase === "synthesis") {
    if (meetingTaskIds.length > 0) {
      const taskStatuses = {};
      let allTerminalOrUnresolvable = true;

      for (const taskId of meetingTaskIds) {
        const task = allTasks.find(t => t.id === taskId);
        const status = task ? task.status : "missing";
        taskStatuses[taskId] = status;

        if (isTaskTerminal(allTasks, taskId)) {
          continue;
        }

        if (hasUnresolvableDependency(allTasks, task)) {
          taskStatuses[taskId] = status + " (unresolvable deps)";
          continue;
        }

        allTerminalOrUnresolvable = false;
      }

      if (allTerminalOrUnresolvable) {
        const stuckDurationMs = cycle.startedAt
          ? Date.now() - new Date(cycle.startedAt).getTime()
          : 0;
        return {
          stalled: true,
          reason: "all_tasks_exhausted",
          stalledPhase: cycle.phase,
          taskStatuses,
          stuckDurationMs,
        };
      }
    }
  }

  // Mode B: Time-based detection (all non-done/execution phases)
  if (cycle.startedAt) {
    const elapsed = Date.now() - new Date(cycle.startedAt).getTime();
    if (elapsed > timeout) {
      const taskStatuses = {};
      for (const taskId of meetingTaskIds) {
        const task = allTasks.find(t => t.id === taskId);
        taskStatuses[taskId] = task ? task.status : "missing";
      }
      return {
        stalled: true,
        reason: "phase_timeout",
        stalledPhase: cycle.phase,
        taskStatuses,
        stuckDurationMs: elapsed,
      };
    }
  }

  return { stalled: false };
}

function closeStalledCycle(board, helpers, reason, healthResult) {
  const cycle = board.village?.currentCycle;
  if (!cycle || cycle.phase === "done") return;

  const now = helpers.nowIso();
  const failedPhase = cycle.phase;
  const cycleId = cycle.cycleId;

  cycle.phase = "done";
  cycle.completedAt = now;
  cycle.failedAt = now;
  cycle.failedPhase = failedPhase;
  cycle.failureReason = reason;

  if (!Array.isArray(board.signals)) board.signals = [];
  board.signals.push(createSignal({
    by: "cycle-watchdog", type: "cycle_stalled",
    content: "Cycle " + cycleId + " stalled in phase " + failedPhase + ": " + reason,
    refs: [cycleId],
    data: {
      cycleId, stalledPhase: failedPhase, reason,
      taskStatuses: healthResult?.taskStatuses || {},
      stuckDurationMs: healthResult?.stuckDurationMs || 0,
    },
  }, helpers));
  mgmt.trimSignals(board, helpers.signalArchivePath);

  helpers.writeBoard(board);
  helpers.appendLog({
    ts: now,
    event: "cycle_stalled",
    cycleId,
    failedPhase,
    reason,
  });
  helpers.broadcastSSE("cycle_stalled", { cycleId, failedPhase, reason });

  console.log("[cycle-watchdog] closed stalled cycle " + cycleId + " (phase=" + failedPhase + ", reason=" + reason + ")");
}

function isMeetingTask(taskId) {
  return typeof taskId === "string" && taskId.startsWith("MTG-");
}

module.exports = {
  checkCycleHealth,
  closeStalledCycle,
  isMeetingTask,
  isTaskTerminal,
  hasUnresolvableDependency,
  DEFAULT_STALL_TIMEOUT_MS,
};
