/**
 * management/lessons.js — Lesson 匹配 + Preflight section
 *
 * matchLessonsForTask, buildPreflightSection
 */

const VALID_LESSON_STATUSES = ['active', 'validated', 'invalidated', 'superseded'];

/**
 * Match relevant lessons for a given task.
 * Returns lessons in three relevance tiers:
 *   1. agent-specific (insight data.agent matches task.assignee)
 *   2. skill/type-specific (insight data matches task skill/type)
 *   3. universal (all validated lessons)
 */
function matchLessonsForTask(board, task) {
  const allLessons = (board.lessons || [])
    .filter(l => l.status === 'active' || l.status === 'validated');

  if (allLessons.length === 0) return { matched: [], ids: [] };

  const insights = board.insights || [];
  const matched = [];
  const seen = new Set();

  const getInsight = (l) => l.fromInsight ? insights.find(i => i.id === l.fromInsight) : null;

  // Tier 1: Agent-specific lessons
  for (const l of allLessons) {
    if (seen.has(l.id)) continue;
    const ins = getInsight(l);
    if (ins?.data?.agent === task.assignee) {
      matched.push({ id: l.id, rule: l.rule, relevance: 'agent', status: l.status });
      seen.add(l.id);
    }
  }

  // Tier 2: Skill/type-specific lessons
  const taskSkill = task.skill || task.type || task.track || null;
  if (taskSkill) {
    for (const l of allLessons) {
      if (seen.has(l.id)) continue;
      const ins = getInsight(l);
      if (ins?.data?.taskType === taskSkill) {
        matched.push({ id: l.id, rule: l.rule, relevance: 'skill', status: l.status });
        seen.add(l.id);
      }
    }
  }

  // Tier 2.5: Department-scoped lessons (village-retro)
  const taskDept = task.department || null;
  if (taskDept) {
    for (const l of allLessons) {
      if (seen.has(l.id)) continue;
      if (l.scope?.department === taskDept) {
        matched.push({ id: l.id, rule: l.rule, relevance: 'department', status: l.status });
        seen.add(l.id);
      }
    }
  }

  // Tier 3: Universal (validated only)
  for (const l of allLessons) {
    if (seen.has(l.id)) continue;
    if (l.status === 'validated') {
      matched.push({ id: l.id, rule: l.rule, relevance: 'universal', status: l.status });
      seen.add(l.id);
    }
  }

  // Tier 4: Cycle-scoped lessons without department (village-retro, active)
  for (const l of allLessons) {
    if (seen.has(l.id)) continue;
    if (l.scope?.cycleId && !l.scope?.department && !l.fromInsight) {
      matched.push({ id: l.id, rule: l.rule, relevance: 'cycle', status: l.status });
      seen.add(l.id);
    }
  }

  return { matched, ids: matched.map(l => l.id) };
}

/**
 * Build the Preflight Checklist section for agent briefs.
 * Shared by buildTaskDispatchMessage() and buildRedispatchMessage().
 */
function buildPreflightSection(board, task, options = {}) {
  const lessonResult = options.lessonResult || matchLessonsForTask(board, task);
  if (lessonResult.matched.length === 0) return { lines: [], lessonResult };

  const lines = [];
  lines.push('');
  lines.push('## Preflight Checklist');
  lines.push('執行前先確認以下 lessons 是否適用：');
  lines.push('');

  let charCount = 0;
  const MAX_CHARS = 1500;

  const byRelevance = { agent: [], skill: [], universal: [] };
  for (const l of lessonResult.matched) {
    (byRelevance[l.relevance] || []).push(l);
  }

  let budgetExhausted = false;
  for (const [tier, lessons] of Object.entries(byRelevance)) {
    if (budgetExhausted) break;
    if (lessons.length === 0) continue;
    const tierLabel = tier === 'agent' ? task.assignee + ' 專屬'
                    : tier === 'skill' ? (task.skill || task.type || 'task') + ' 相關'
                    : '通用規則';
    lines.push('[' + tierLabel + ']');
    for (const l of lessons) {
      const line = '- ' + l.rule;
      if (charCount + line.length > MAX_CHARS) {
        lines.push('  ... (更多規則省略)');
        budgetExhausted = true;
        break;
      }
      lines.push(line);
      charCount += line.length;
    }
  }

  lines.push('');
  lines.push('執行前先逐條確認，不適用的可跳過。');

  return { lines, lessonResult };
}

module.exports = {
  VALID_LESSON_STATUSES,
  matchLessonsForTask,
  buildPreflightSection,
};
