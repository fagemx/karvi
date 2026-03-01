/**
 * retro.js — Cycle Retrospective Signal Generator
 *
 * When all execution tasks in a cycle complete, generate retro signals
 * that feed into Karvi's evolution loop (insights → lessons).
 */

/**
 * Generate retrospective signals for a completed cycle.
 *
 * @param {object} board - The board object
 * @param {string} cycleId - The cycle identifier
 * @param {object} helpers - { nowIso, uid }
 * @returns {object[]} Array of signals to add to board.signals
 */
function generateRetroSignals(board, cycleId, helpers) {
  const allTasks = board.taskPlan?.tasks || [];

  // Find execution tasks for this cycle
  const execTasks = allTasks.filter(t =>
    t.source?.type === 'village_plan' && t.source?.cycleId === cycleId
  );

  if (execTasks.length === 0) return [];

  const signals = [];
  const now = helpers.nowIso();

  // 1. Per-task performance signal
  for (const task of execTasks) {
    signals.push({
      id: helpers.uid('sig'),
      ts: now,
      by: 'village-retro',
      type: 'cycle_task_result',
      content: `${task.id} (${task.department || 'unknown'}): ${task.status} — ${task.title}`,
      refs: [task.id],
      data: {
        cycleId,
        taskId: task.id,
        department: task.department || null,
        status: task.status,
        title: task.title,
        // Include cost/time if available
        completedAt: task.completedAt || null,
      },
    });
  }

  // 2. Cycle summary signal
  const completed = execTasks.filter(t => t.status === 'approved').length;
  const blocked = execTasks.filter(t => t.status === 'blocked').length;
  const total = execTasks.length;

  signals.push({
    id: helpers.uid('sig'),
    ts: now,
    by: 'village-retro',
    type: 'cycle_completed',
    content: `Cycle ${cycleId} complete: ${completed}/${total} succeeded, ${blocked} blocked`,
    refs: execTasks.map(t => t.id),
    data: {
      cycleId,
      total,
      completed,
      blocked,
      successRate: total > 0 ? (completed / total) : 0,
    },
  });

  return signals;
}

module.exports = { generateRetroSignals };
