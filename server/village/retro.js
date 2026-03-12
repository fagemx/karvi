/**
 * retro.js — Cycle Retrospective Signal & Lesson Generator
 *
 * When all execution tasks in a cycle complete:
 * 1. Generate retro signals for Karvi's evolution loop
 * 2. Generate lessons for next cycle's department prompts
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

  const execTasks = allTasks.filter(t =>
    t.source?.type === 'village_plan' && t.source?.cycleId === cycleId
  );

  if (execTasks.length === 0) return [];

  const signals = [];
  const now = helpers.nowIso();

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
        completedAt: task.completedAt || null,
      },
    });
  }

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

/**
 * Generate lessons from cycle completion results.
 * Lessons are injected into next meeting's department prompts via matchLessonsForTask.
 *
 * @param {object} board - The board object (mutated: board.lessons updated)
 * @param {string} cycleId - The cycle identifier
 * @param {object} helpers - { nowIso, uid }
 * @returns {object[]} Array of lessons added to board.lessons
 */
function generateRetroLessons(board, cycleId, helpers) {
  const allTasks = board.taskPlan?.tasks || [];

  const execTasks = allTasks.filter(t =>
    t.source?.type === 'village_plan' && t.source?.cycleId === cycleId
  );

  if (execTasks.length === 0) return [];

  const lessons = [];
  const now = helpers.nowIso();
  const existingLessons = board.lessons || [];

  const completed = execTasks.filter(t => t.status === 'approved');
  const blocked = execTasks.filter(t => t.status === 'blocked');
  const total = execTasks.length;
  const successRate = total > 0 ? completed.length / total : 0;

  const byDept = {};
  for (const t of execTasks) {
    const dept = t.department || 'unknown';
    if (!byDept[dept]) byDept[dept] = { total: 0, completed: 0, blocked: 0 };
    byDept[dept].total++;
    if (t.status === 'approved') byDept[dept].completed++;
    if (t.status === 'blocked') byDept[dept].blocked++;
  }

  if (successRate < 0.5 && total >= 3) {
    const rule = `Cycle ${cycleId} success rate ${Math.round(successRate * 100)}% — review planning quality or reduce scope`;
    const exists = existingLessons.some(l => l.rule === rule && l.status !== 'invalidated');
    if (!exists) {
      lessons.push({
        id: helpers.uid('lesson'),
        ts: now,
        by: 'village-retro',
        fromInsight: null,
        rule,
        effect: `success rate ${Math.round(successRate * 100)}% (${completed.length}/${total})`,
        scope: { cycleId },
        status: 'active',
        validatedAt: null,
        supersededBy: null,
      });
    }
  }

  for (const [dept, stats] of Object.entries(byDept)) {
    if (stats.total >= 2 && stats.blocked >= stats.total * 0.5) {
      const rule = `Department ${dept} had ${stats.blocked}/${stats.total} blocked tasks in ${cycleId} — check dependencies or reduce workload`;
      const exists = existingLessons.some(l => l.rule === rule && l.status !== 'invalidated');
      if (!exists) {
        lessons.push({
          id: helpers.uid('lesson'),
          ts: now,
          by: 'village-retro',
          fromInsight: null,
          rule,
          effect: `${stats.blocked}/${stats.total} blocked in ${dept}`,
          scope: { cycleId, department: dept },
          status: 'active',
          validatedAt: null,
          supersededBy: null,
        });
      }
    }
  }

  if (blocked.length >= 2 && blocked.length / total >= 0.3) {
    const blockedReasons = blocked.map(t => t.blocker?.reason || 'unknown').slice(0, 3);
    const rule = `High block rate (${blocked.length}/${total}) in ${cycleId} — common issues: ${blockedReasons.join(', ')}`;
    const exists = existingLessons.some(l => l.rule === rule && l.status !== 'invalidated');
    if (!exists) {
      lessons.push({
        id: helpers.uid('lesson'),
        ts: now,
        by: 'village-retro',
        fromInsight: null,
        rule,
        effect: `${blocked.length}/${total} blocked`,
        scope: { cycleId },
        status: 'active',
        validatedAt: null,
        supersededBy: null,
      });
    }
  }

  if (lessons.length > 0) {
    board.lessons = board.lessons || [];
    board.lessons.push(...lessons);
  }

  return lessons;
}

module.exports = { generateRetroSignals, generateRetroLessons };
