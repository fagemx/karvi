/**
 * village-scheduler.js — Cadence Engine
 *
 * Periodically checks if a meeting should be triggered based on
 * the schedule defined in board.village.schedule.
 *
 * Uses setInterval (1 hour) to check; no external dependencies.
 */
const { generateMeetingTasks } = require('./village-meeting');
const cycleWatchdog = require('./cycle-watchdog');

const HOUR = 3_600_000;

function createScheduler(deps) {
  function checkSchedule() {
    try {
      let board = deps.helpers.readBoard();

      // Periodic stall detection: close cycles stuck in the same phase too long
      const cycle = board.village?.currentCycle;
      if (cycle && cycle.phase !== 'done' && cycle.phase !== 'execution') {
        const stallHours = board.controls?.cycle_stall_timeout_hours || 4;
        const health = cycleWatchdog.checkCycleHealth(board, stallHours * 3_600_000);
        if (health.stalled) {
          cycleWatchdog.closeStalledCycle(board, deps.helpers, health.reason, health);
          board = deps.helpers.readBoard(); // re-read after mutation
        }
      }

      const schedule = board.village?.schedule;
      if (!schedule) return;

      const now = new Date();
      const day = now.getDay(); // 0=Sun, 1=Mon, ...
      const hour = now.getHours();

      // Timestamp dedup: skip if already triggered this clock-hour
      const lastTriggered = schedule.lastTriggeredAt ? new Date(schedule.lastTriggeredAt) : null;
      if (lastTriggered
          && lastTriggered.getFullYear() === now.getFullYear()
          && lastTriggered.getMonth() === now.getMonth()
          && lastTriggered.getDate() === now.getDate()
          && lastTriggered.getHours() === hour) {
        return;
      }

      // Weekly planning: default Monday 9:00
      if (schedule.weeklyPlanning) {
        const wp = schedule.weeklyPlanning;
        if (day === (wp.day !== undefined ? wp.day : 1) && hour === (wp.hour !== undefined ? wp.hour : 9)) {
          const cycle = board.village?.currentCycle;
          if (!cycle || cycle.phase === 'done') {
            triggerMeeting('weekly_planning');
          }
        }
      }

      // Mid-week check-in: default Wednesday 14:00
      if (schedule.midweekCheckin) {
        const mc = schedule.midweekCheckin;
        if (day === (mc.day !== undefined ? mc.day : 3) && hour === (mc.hour !== undefined ? mc.hour : 14)) {
          const cycle = board.village?.currentCycle;
          if (cycle && cycle.phase === 'execution') {
            triggerMeeting('midweek_checkin');
          }
        }
      }
    } catch (err) {
      console.error('[village-scheduler] checkSchedule error:', err.message);
    }
  }

  function triggerMeeting(meetingType) {
    try {
      const board = deps.helpers.readBoard();
      const village = board.village;
      if (!village) return;

      const now = new Date().toISOString();

      // Idempotency: don't start a new meeting if a cycle is active (any non-terminal phase)
      const activePhase = village.currentCycle?.phase;
      if (activePhase && activePhase !== 'done') {
        console.log(`[village-scheduler] skipping ${meetingType} — cycle ${village.currentCycle.cycleId} in phase: ${activePhase}`);
        return;
      }

      // Need at least one department
      if (!Array.isArray(village.departments) || village.departments.length === 0) {
        console.log(`[village-scheduler] skipping ${meetingType} — no departments configured`);
        return;
      }

      const meetingTasks = generateMeetingTasks(board, meetingType);

      if (!board.taskPlan) board.taskPlan = { goal: '', phase: 'idle', tasks: [] };
      if (!Array.isArray(board.taskPlan.tasks)) board.taskPlan.tasks = [];
      board.taskPlan.tasks.push(...meetingTasks);

      const cycleId = meetingTasks[0]?.id?.replace(/^MTG-/, '').replace(/-proposal-.*$/, '') || `cycle-${Date.now()}`;
      village.currentCycle = {
        cycleId,
        phase: 'proposal',
        meetingType,
        startedAt: now,
        taskIds: meetingTasks.map(t => t.id),
      };

      // Stamp lastTriggeredAt for dedup
      if (village.schedule) village.schedule.lastTriggeredAt = now;

      deps.helpers.writeBoard(board);
      deps.helpers.appendLog({
        ts: now,
        event: 'village_meeting_triggered',
        cycleId,
        meetingType,
        taskCount: meetingTasks.length,
        source: 'scheduler',
      });
      deps.helpers.broadcastSSE('village_meeting', { cycleId, meetingType, phase: 'proposal', source: 'scheduler' });

      console.log(`[village-scheduler] triggered ${meetingType} — cycleId=${cycleId}, tasks=${meetingTasks.length}`);

      // Auto-dispatch dispatched tasks (fire-and-forget)
      if (deps.tryAutoDispatch) {
        for (const t of meetingTasks) {
          if (t.status === 'dispatched') {
            setImmediate(() => deps.tryAutoDispatch(t.id));
          }
        }
      }
    } catch (err) {
      console.error(`[village-scheduler] triggerMeeting(${meetingType}) error:`, err.message);
    }
  }

  let intervalId = null;

  function start() {
    if (intervalId) return;
    intervalId = setInterval(checkSchedule, HOUR);
    console.log('[village-scheduler] started (1h interval)');
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { start, stop, checkSchedule };
}

module.exports = { createScheduler };
