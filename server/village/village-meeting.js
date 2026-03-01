/**
 * village-meeting.js — Meeting Task Graph Generator
 *
 * Generates a set of Karvi tasks that form a "village meeting":
 *   1. Proposal tasks (parallel, one per department)
 *   2. Synthesis task (depends on all proposals, village chief decides)
 *
 * All tasks run on the existing Karvi pipeline — no new system needed.
 */
const fs = require('fs');
const path = require('path');

const ROLES_DIR = path.join(__dirname, 'roles');

/**
 * Read a role markdown file from the roles/ directory.
 * @param {string} promptFile - relative path like "village/roles/engineering.md"
 * @returns {string} file contents or fallback message
 */
function readRoleFile(promptFile) {
  if (!promptFile) return '(no role prompt configured)';
  try {
    // promptFile is relative to server/, e.g. "village/roles/engineering.md"
    const fullPath = path.resolve(__dirname, '..', promptFile);
    return fs.readFileSync(fullPath, 'utf8');
  } catch {
    // fallback: try as relative to roles dir
    try {
      const altPath = path.join(ROLES_DIR, path.basename(promptFile));
      return fs.readFileSync(altPath, 'utf8');
    } catch {
      return `(role file not found: ${promptFile})`;
    }
  }
}

/**
 * Get ISO week identifier, e.g. "2026-W09"
 * @param {Date} [date]
 * @returns {string}
 */
function getWeekId(date) {
  const d = date || new Date();
  // ISO week calculation
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
  const weekNum = Math.ceil((dayOfYear + jan4.getDay() - 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Gather recent signals summary for a department's proposal context.
 * @param {object} board
 * @param {string[]} goalIds - goals relevant to this department
 * @param {number} [limit=10]
 * @returns {string} human-readable summary
 */
function gatherRecentSignals(board, goalIds, limit) {
  const max = limit || 10;
  const signals = (board.signals || []).slice(-max * 3);
  if (signals.length === 0) return '(no recent signals)';

  // Prefer signals related to the department's goals or recent reviews
  const relevant = signals
    .filter(s => s.type === 'review_result' || s.type === 'status_change' || s.type === 'lesson_validated')
    .slice(-max);

  if (relevant.length === 0) return '(no relevant signals)';

  return relevant.map(s => `- [${s.type}] ${s.content || s.id}`).join('\n');
}

/**
 * Build the instruction string for a department's proposal task.
 */
function buildProposalInstruction(rolePrompt, goals, recentSignals) {
  const lines = [];
  lines.push('# Department Proposal Task');
  lines.push('');
  lines.push('## Your Role');
  lines.push(rolePrompt);
  lines.push('');
  lines.push('## Active Goals Assigned to You');
  if (goals.length === 0) {
    lines.push('(no active goals assigned to this department)');
  } else {
    for (const g of goals) {
      lines.push(`- **${g.id}**: ${g.text} [cadence: ${g.cadence || 'unset'}]`);
      if (g.metrics && g.metrics.length > 0) {
        lines.push(`  Metrics: ${g.metrics.join(', ')}`);
      }
    }
  }
  lines.push('');
  lines.push('## Recent Signals (what happened last cycle)');
  lines.push(recentSignals);
  lines.push('');
  lines.push('## Instructions');
  lines.push('Based on the goals and signals above, produce your weekly proposal.');
  lines.push('Follow the Proposal Format defined in your role document.');
  lines.push('Output your result as: STEP_RESULT:{"status":"completed","proposal":{...}}');
  return lines.join('\n');
}

/**
 * Build the instruction string for the village chief's synthesis task.
 */
function buildSynthesisInstruction(chiefPrompt, goals) {
  const lines = [];
  lines.push('# Village Chief: Weekly Plan Synthesis');
  lines.push('');
  lines.push(chiefPrompt);
  lines.push('');
  lines.push('## Village Goals (active)');
  if (goals.length === 0) {
    lines.push('(no active goals)');
  } else {
    for (const g of goals) {
      lines.push(`- **${g.id}**: ${g.text} [cadence: ${g.cadence || 'unset'}]`);
    }
  }
  lines.push('');
  lines.push('## Upstream Artifacts');
  lines.push('Department proposals will be injected automatically as upstream artifacts.');
  lines.push('Read each proposal, resolve conflicts, and produce the weekly plan.');
  lines.push('');
  lines.push('## Instructions');
  lines.push('Synthesize all department proposals into a unified weekly execution plan.');
  lines.push('Follow the Output Format defined in your role document.');
  lines.push('Output your result as: STEP_RESULT:{"status":"completed","plan":{...}}');
  return lines.join('\n');
}

/**
 * Generate meeting tasks for a village meeting cycle.
 *
 * @param {object} board - the full board object
 * @param {string} meetingType - "weekly_planning" | "midweek_checkin" | "emergency"
 * @returns {object[]} array of task objects ready to be added to board.taskPlan.tasks
 */
function generateMeetingTasks(board, meetingType) {
  const cycleId = `cycle-${getWeekId()}`;
  const departments = board.village?.departments || [];
  const goals = (board.village?.goals || []).filter(g => g.active);

  const chiefPrompt = readRoleFile('village/roles/chief.md');

  const proposalTasks = [];
  const proposalIds = [];

  // Build proposal task for each department
  for (const dept of departments) {
    const deptGoals = goals.filter(g => (dept.goalIds || []).includes(g.id));
    const rolePrompt = readRoleFile(dept.promptFile);
    const recentSignals = gatherRecentSignals(board, dept.goalIds || []);

    const taskId = `MTG-${cycleId}-proposal-${dept.id}`;
    proposalIds.push(taskId);

    proposalTasks.push({
      id: taskId,
      title: `${dept.name} Weekly Proposal`,
      assignee: dept.assignee || 'engineer_lite',
      status: 'dispatched',
      depends: [],
      pipeline: [{
        type: 'propose',
        instruction: buildProposalInstruction(rolePrompt, deptGoals, recentSignals),
        runtime_hint: 'claude',
      }],
      history: [{ ts: new Date().toISOString(), status: 'dispatched', reason: `meeting:${meetingType}` }],
    });
  }

  // Synthesis task — depends on all proposals
  const synthesisTask = {
    id: `MTG-${cycleId}-synthesis`,
    title: 'Village Chief: Weekly Plan Synthesis',
    assignee: 'engineer_pro',
    status: 'pending',
    depends: proposalIds,
    pipeline: [{
      type: 'synthesize',
      instruction: buildSynthesisInstruction(chiefPrompt, goals),
      runtime_hint: 'claude',
    }],
    history: [{ ts: new Date().toISOString(), status: 'pending', reason: `meeting:${meetingType}` }],
  };

  return [...proposalTasks, synthesisTask];
}

module.exports = {
  generateMeetingTasks,
  buildProposalInstruction,
  buildSynthesisInstruction,
  readRoleFile,
  getWeekId,
  gatherRecentSignals,
};
