/**
 * routes/village.js — Village Chief System APIs
 *
 * POST /api/village/goals       — add/update a goal
 * GET  /api/village/goals       — list active goals
 * POST /api/village/departments  — add/update a department
 * GET  /api/village/status       — current cycle status
 * POST /api/village/trigger      — trigger a meeting (Phase 1)
 */
const bb = require('../blackboard-server');
const { json } = bb;

// --- Default village block for board.json ---
const DEFAULT_VILLAGE = {
  goals: [],
  departments: [],
  currentCycle: null,
};

/**
 * Ensure board.village exists with default structure.
 * Called on every request that touches village data.
 */
function ensureVillage(board) {
  if (!board.village) {
    board.village = { ...DEFAULT_VILLAGE };
  }
  if (!Array.isArray(board.village.goals)) board.village.goals = [];
  if (!Array.isArray(board.village.departments)) board.village.departments = [];
  return board.village;
}

/**
 * Generate a goal ID like "G-001", "G-002", etc.
 */
function nextGoalId(goals) {
  const nums = goals
    .map(g => {
      const m = String(g.id || '').match(/^G-(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => n > 0);
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `G-${String(max + 1).padStart(3, '0')}`;
}

module.exports = function villageRoutes(req, res, helpers, deps) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // ── POST /api/village/goals — add or update a goal ──
  if (req.method === 'POST' && pathname === '/api/village/goals') {
    helpers.parseBody(req).then(body => {
      try {
        const board = helpers.readBoard();
        const village = ensureVillage(board);

        const now = helpers.nowIso();

        // If id is provided, update existing goal
        if (body.id) {
          const existing = village.goals.find(g => g.id === body.id);
          if (!existing) {
            return json(res, 404, { error: `Goal ${body.id} not found` });
          }
          if (body.text !== undefined) existing.text = body.text;
          if (body.domain !== undefined) existing.domain = body.domain;
          if (body.cadence !== undefined) existing.cadence = body.cadence;
          if (body.metrics !== undefined) existing.metrics = body.metrics;
          if (body.active !== undefined) existing.active = body.active;
          existing.updatedAt = now;
          helpers.writeBoard(board);
          helpers.appendLog({ ts: now, event: 'village_goal_updated', goalId: existing.id });
          return json(res, 200, { ok: true, goal: existing });
        }

        // Create new goal
        if (!body.text) {
          return json(res, 400, { error: 'text is required for new goal' });
        }
        const goal = {
          id: nextGoalId(village.goals),
          text: body.text,
          domain: body.domain || 'general',
          cadence: body.cadence || 'weekly',
          metrics: Array.isArray(body.metrics) ? body.metrics : [],
          active: body.active !== undefined ? body.active : true,
          createdAt: now,
          updatedAt: now,
        };
        village.goals.push(goal);
        helpers.writeBoard(board);
        helpers.appendLog({ ts: now, event: 'village_goal_created', goalId: goal.id });
        return json(res, 201, { ok: true, goal });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── GET /api/village/goals — list active goals ──
  if (req.method === 'GET' && pathname === '/api/village/goals') {
    try {
      const board = helpers.readBoard();
      const village = ensureVillage(board);
      const activeOnly = url.searchParams.get('active') !== 'false';
      const goals = activeOnly
        ? village.goals.filter(g => g.active)
        : village.goals;
      return json(res, 200, { goals });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // ── POST /api/village/departments — add or update a department ──
  if (req.method === 'POST' && pathname === '/api/village/departments') {
    helpers.parseBody(req).then(body => {
      try {
        const board = helpers.readBoard();
        const village = ensureVillage(board);
        const now = helpers.nowIso();

        if (!body.id) {
          return json(res, 400, { error: 'id is required' });
        }

        const existing = village.departments.find(d => d.id === body.id);
        if (existing) {
          // Update
          if (body.name !== undefined) existing.name = body.name;
          if (body.assignee !== undefined) existing.assignee = body.assignee;
          if (body.skills !== undefined) existing.skills = body.skills;
          if (body.promptFile !== undefined) existing.promptFile = body.promptFile;
          if (body.goalIds !== undefined) existing.goalIds = body.goalIds;
          helpers.writeBoard(board);
          helpers.appendLog({ ts: now, event: 'village_department_updated', deptId: existing.id });
          return json(res, 200, { ok: true, department: existing });
        }

        // Create new department
        if (!body.name) {
          return json(res, 400, { error: 'name is required for new department' });
        }
        const dept = {
          id: body.id,
          name: body.name,
          assignee: body.assignee || 'engineer_lite',
          skills: Array.isArray(body.skills) ? body.skills : [],
          promptFile: body.promptFile || `village/roles/${body.id}.md`,
          goalIds: Array.isArray(body.goalIds) ? body.goalIds : [],
        };
        village.departments.push(dept);
        helpers.writeBoard(board);
        helpers.appendLog({ ts: now, event: 'village_department_created', deptId: dept.id });
        return json(res, 201, { ok: true, department: dept });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── GET /api/village/status — current cycle status ──
  if (req.method === 'GET' && pathname === '/api/village/status') {
    try {
      const board = helpers.readBoard();
      const village = ensureVillage(board);
      return json(res, 200, {
        currentCycle: village.currentCycle || null,
        goalCount: village.goals.filter(g => g.active).length,
        departmentCount: village.departments.length,
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // ── POST /api/village/trigger — trigger a village meeting ──
  if (req.method === 'POST' && pathname === '/api/village/trigger') {
    helpers.parseBody(req).then(body => {
      try {
        const board = helpers.readBoard();
        const village = ensureVillage(board);
        const now = helpers.nowIso();

        const meetingType = body.type || 'weekly_planning';

        // Idempotency check: don't start a new meeting if one is active
        if (village.currentCycle && village.currentCycle.phase === 'proposal') {
          return json(res, 409, {
            error: 'meeting_active',
            message: `Cycle ${village.currentCycle.cycleId} is already in phase: ${village.currentCycle.phase}`,
            currentCycle: village.currentCycle,
          });
        }

        // Validate: need at least one department
        if (village.departments.length === 0) {
          return json(res, 400, {
            error: 'no_departments',
            message: 'Cannot trigger meeting without departments. Add departments first via POST /api/village/departments',
          });
        }

        // Generate meeting tasks
        const { generateMeetingTasks } = require('../village/village-meeting');
        const meetingTasks = generateMeetingTasks(board, meetingType);

        // Add tasks to board
        if (!board.taskPlan) board.taskPlan = { goal: '', phase: 'idle', tasks: [] };
        if (!Array.isArray(board.taskPlan.tasks)) board.taskPlan.tasks = [];
        board.taskPlan.tasks.push(...meetingTasks);

        // Set cycle state
        const cycleId = meetingTasks[0]?.id?.replace(/^MTG-/, '').replace(/-proposal-.*$/, '') || `cycle-${Date.now()}`;
        village.currentCycle = {
          cycleId,
          phase: 'proposal',
          meetingType,
          startedAt: now,
          taskIds: meetingTasks.map(t => t.id),
        };

        helpers.writeBoard(board);
        helpers.appendLog({
          ts: now,
          event: 'village_meeting_triggered',
          cycleId,
          meetingType,
          taskCount: meetingTasks.length,
        });
        helpers.broadcastSSE('village_meeting', { cycleId, meetingType, phase: 'proposal' });

        // Auto-dispatch dispatched tasks
        if (deps.tryAutoDispatch) {
          for (const t of meetingTasks) {
            if (t.status === 'dispatched') {
              setImmediate(() => deps.tryAutoDispatch(t.id));
            }
          }
        }

        return json(res, 200, {
          ok: true,
          cycleId,
          meetingType,
          phase: 'proposal',
          tasksCreated: meetingTasks.length,
          taskIds: meetingTasks.map(t => t.id),
        });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  return false;
};

// Export for use in server.js startup (ensure village defaults on board)
module.exports.ensureVillage = ensureVillage;
module.exports.DEFAULT_VILLAGE = DEFAULT_VILLAGE;
