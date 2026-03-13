/**
 * routes/villages.js — Multi-Village API Routes
 *
 * New per-village namespace:
 *   GET  /api/villages                        — list all villages
 *   POST /api/villages                        — create a new village
 *   GET  /api/villages/:id/status             — village cycle status
 *   GET  /api/villages/:id/board              — village board (full)
 *   POST /api/villages/:id/goals              — add/update goal
 *   GET  /api/villages/:id/goals              — list goals
 *   POST /api/villages/:id/departments        — add/update department
 *   POST /api/villages/:id/trigger            — trigger village meeting
 *   POST /api/villages/:id/approve            — approve pending plan
 *
 * Legacy /api/village/* routes remain unchanged (handled by routes/village.js).
 * These routes delegate to the registry for context/helpers resolution.
 */
const bb = require('../blackboard-server');
const { json } = bb;
const { requireRole } = require('./_shared');
const { retryOnConflict } = require('../helpers/retry');

/**
 * Ensure board.village exists with default structure.
 */
function ensureVillage(board, villageId) {
  if (!board.village) {
    board.village = {
      villageId: villageId || null,
      goals: [],
      departments: [],
      currentCycle: null,
      sharedArtifacts: [],
      territoryGoals: [],
    };
  }
  if (!Array.isArray(board.village.goals)) board.village.goals = [];
  if (!Array.isArray(board.village.departments)) board.village.departments = [];
  return board.village;
}

/**
 * Ensure an agent is registered as a participant on the board.
 */
function ensureAgentParticipant(board, agentId) {
  if (!agentId) return;
  if (!Array.isArray(board.participants)) board.participants = [];
  if (board.participants.find(p => p.id === agentId)) return;
  board.participants.push({
    id: agentId,
    type: 'agent',
    displayName: agentId,
    agentId: agentId,
  });
}

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

/**
 * Match /api/villages/:id/... patterns.
 * Returns { villageId, subPath } or null if no match.
 */
function matchVillagePath(pathname) {
  const m = pathname.match(/^\/api\/villages\/([a-z0-9][a-z0-9_-]*)(?:\/(.*))?$/);
  if (!m) return null;
  return { villageId: m[1], subPath: m[2] || '' };
}

module.exports = function villagesRoutes(req, res, helpers, deps) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // Only handle /api/villages paths
  if (!pathname.startsWith('/api/villages')) return false;

  const registry = deps.boardRegistry;
  if (!registry) {
    return json(res, 501, { error: 'board registry not initialized' });
  }

  // ── GET /api/villages — list all villages ──
  if (req.method === 'GET' && pathname === '/api/villages') {
    return json(res, 200, { villages: registry.listVillages() });
  }

  // ── POST /api/villages — create a new village ──
  if (req.method === 'POST' && pathname === '/api/villages') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(body => {
      if (!body.id) {
        return json(res, 400, { error: 'id is required (lowercase, no spaces, e.g. "v-strategy")' });
      }
      if (!body.name) {
        return json(res, 400, { error: 'name is required' });
      }

      try {
        const info = registry.registerVillage(body.id, {
          name: body.name,
          territoryId: body.territoryId || null,
        });

        // Also register in the nation-level board if it has board.nation
        const nationHelpers = registry.getHelpers('default');
        if (nationHelpers) {
          const nationBoard = nationHelpers.readBoard();
          if (!nationBoard.nation) {
            nationBoard.nation = {
              coordinator: null,
              villages: [],
              territories: [],
              strategicGoals: [],
            };
          }
          // Add village reference if not already present
          if (!nationBoard.nation.villages.find(v => v.id === body.id)) {
            nationBoard.nation.villages.push({
              id: body.id,
              name: body.name,
              boardPath: info.boardPath,
              territoryId: body.territoryId || null,
              status: 'active',
            });
            nationHelpers.writeBoard(nationBoard);
          }
        }

        helpers.appendLog({
          ts: bb.nowIso(),
          event: 'village_created',
          villageId: body.id,
          name: body.name,
        });

        return json(res, 201, { ok: true, village: info });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── Per-village routes: /api/villages/:id/... ──
  const match = matchVillagePath(pathname);
  if (!match) return false;

  const { villageId, subPath } = match;

  if (!registry.hasVillage(villageId)) {
    return json(res, 404, { error: `Village "${villageId}" not found` });
  }

  const vHelpers = registry.getHelpers(villageId);
  if (!vHelpers) {
    return json(res, 500, { error: `Failed to get helpers for village "${villageId}"` });
  }

  // ── GET /api/villages/:id/board — full board ──
  if (req.method === 'GET' && subPath === 'board') {
    try {
      return json(res, 200, vHelpers.readBoard());
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/villages/:id/status — cycle status ──
  if (req.method === 'GET' && subPath === 'status') {
    try {
      const board = vHelpers.readBoard();
      const village = ensureVillage(board, villageId);
      const activeGoals = village.goals.filter(g => g.active);
      const departments = village.departments;

      const departmentSummary = departments.map(dept => ({
        id: dept.id,
        name: dept.name,
        goalCount: activeGoals.filter(g => (dept.goalIds || []).includes(g.id)).length,
      }));

      const cycle = village.currentCycle;
      if (!cycle) {
        return json(res, 200, {
          villageId,
          currentCycle: null,
          goalCount: activeGoals.length,
          departmentCount: departments.length,
          departments: departmentSummary,
        });
      }

      const allTasks = board.taskPlan?.tasks || [];
      const { cycleId } = cycle;

      const proposalPrefix = `MTG-${cycleId}-proposal-`;
      const proposalTasks = allTasks.filter(t => t.id && t.id.startsWith(proposalPrefix));
      const proposals = proposalTasks.map(t => ({
        taskId: t.id,
        department: t.id.slice(proposalPrefix.length),
        status: t.status,
        summary: t.result?.summary || (t.lastReply ? t.lastReply.slice(0, 300) : null),
      }));

      const synthesisId = `MTG-${cycleId}-synthesis`;
      const synthesisTask = allTasks.find(t => t.id === synthesisId);
      let synthesis = null;
      if (synthesisTask) {
        const planTaskCount = allTasks.filter(
          t => t.source?.synthesisTaskId === synthesisId
        ).length;
        synthesis = { taskId: synthesisTask.id, status: synthesisTask.status, planTaskCount };
      }

      const execTasks = allTasks.filter(
        t => t.source?.type === 'village_plan' && t.source?.cycleId === cycleId
      );
      const execStatusCount = { completed: 0, inProgress: 0, blocked: 0, pending: 0 };
      for (const t of execTasks) {
        if (t.status === 'approved') execStatusCount.completed++;
        else if (t.status === 'in_progress' || t.status === 'running' || t.status === 'dispatched') execStatusCount.inProgress++;
        else if (t.status === 'blocked') execStatusCount.blocked++;
        else execStatusCount.pending++;
      }

      return json(res, 200, {
        villageId,
        currentCycle: {
          cycleId: cycle.cycleId,
          phase: cycle.phase,
          startedAt: cycle.startedAt,
          proposals,
          synthesis,
          execution: {
            total: execTasks.length,
            ...execStatusCount,
            tasks: execTasks.map(t => ({
              id: t.id, title: t.title, status: t.status, department: t.department || null,
            })),
          },
        },
        goalCount: activeGoals.length,
        departmentCount: departments.length,
        departments: departmentSummary,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/villages/:id/goals — add or update a goal ──
  if (req.method === 'POST' && subPath === 'goals') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(body => {
      try {
        const board = vHelpers.readBoard();
        const village = ensureVillage(board, villageId);
        const now = vHelpers.nowIso();

        if (body.id) {
          const existing = village.goals.find(g => g.id === body.id);
          if (!existing) return json(res, 404, { error: `Goal ${body.id} not found` });
          if (body.text !== undefined) existing.text = body.text;
          if (body.domain !== undefined) existing.domain = body.domain;
          if (body.cadence !== undefined) existing.cadence = body.cadence;
          if (body.metrics !== undefined) existing.metrics = body.metrics;
          if (body.active !== undefined) existing.active = body.active;
          existing.updatedAt = now;
          vHelpers.writeBoard(board);
          vHelpers.appendLog({ ts: now, event: 'village_goal_updated', villageId, goalId: existing.id });
          return json(res, 200, { ok: true, goal: existing });
        }

        if (!body.text) return json(res, 400, { error: 'text is required for new goal' });
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
        vHelpers.writeBoard(board);
        vHelpers.appendLog({ ts: now, event: 'village_goal_created', villageId, goalId: goal.id });
        return json(res, 201, { ok: true, goal });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── GET /api/villages/:id/goals — list goals ──
  if (req.method === 'GET' && subPath === 'goals') {
    try {
      const board = vHelpers.readBoard();
      const village = ensureVillage(board, villageId);
      const activeOnly = url.searchParams.get('active') !== 'false';
      const goals = activeOnly ? village.goals.filter(g => g.active) : village.goals;
      return json(res, 200, { villageId, goals });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/villages/:id/departments — add or update a department ──
  if (req.method === 'POST' && subPath === 'departments') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(body => {
      try {
        const board = vHelpers.readBoard();
        const village = ensureVillage(board, villageId);
        const now = vHelpers.nowIso();

        if (!body.id) return json(res, 400, { error: 'id is required' });

        const existing = village.departments.find(d => d.id === body.id);
        if (existing) {
          if (body.name !== undefined) existing.name = body.name;
          if (body.assignee !== undefined) existing.assignee = body.assignee;
          if (body.skills !== undefined) existing.skills = body.skills;
          if (body.promptFile !== undefined) existing.promptFile = body.promptFile;
          if (body.goalIds !== undefined) existing.goalIds = body.goalIds;
          if (existing.assignee) ensureAgentParticipant(board, existing.assignee);
          vHelpers.writeBoard(board);
          vHelpers.appendLog({ ts: now, event: 'village_department_updated', villageId, deptId: existing.id });
          return json(res, 200, { ok: true, department: existing });
        }

        if (!body.name) return json(res, 400, { error: 'name is required for new department' });
        const dept = {
          id: body.id,
          name: body.name,
          assignee: body.assignee || 'engineer_lite',
          skills: Array.isArray(body.skills) ? body.skills : [],
          promptFile: body.promptFile || `village/roles/${body.id}.md`,
          goalIds: Array.isArray(body.goalIds) ? body.goalIds : [],
        };
        village.departments.push(dept);
        ensureAgentParticipant(board, dept.assignee);
        vHelpers.writeBoard(board);
        vHelpers.appendLog({ ts: now, event: 'village_department_created', villageId, deptId: dept.id });
        return json(res, 201, { ok: true, department: dept });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── POST /api/villages/:id/trigger — trigger a village meeting ──
  if (req.method === 'POST' && subPath === 'trigger') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(async body => {
      try {
        const result = await retryOnConflict(async () => {
          const board = vHelpers.readBoard();
          const village = ensureVillage(board, villageId);
          const now = vHelpers.nowIso();

          const meetingType = body.type || 'weekly_planning';

          const activePhase = village.currentCycle?.phase;
          const blockDuplicate =
            activePhase === 'proposal' ||
            (activePhase === 'checkin' && meetingType === 'midweek_checkin');
          if (blockDuplicate) {
            const error = new Error(`Cycle ${village.currentCycle.cycleId} is already in phase: ${activePhase}`);
            error.code = 'MEETING_ACTIVE';
            error.currentCycle = village.currentCycle;
            throw error;
          }

          if (meetingType !== 'midweek_checkin' && village.departments.length === 0) {
            const error = new Error('Cannot trigger meeting without departments');
            error.code = 'NO_DEPARTMENTS';
            throw error;
          }

          for (const dept of village.departments) {
            ensureAgentParticipant(board, dept.assignee);
          }

          const { generateMeetingTasks } = require('../village/village-meeting');
          const meetingTasks = generateMeetingTasks(board, meetingType, { villageId });

          for (const task of meetingTasks) {
            ensureAgentParticipant(board, task.assignee);
          }

          if (!board.taskPlan) board.taskPlan = { goal: '', phase: 'idle', tasks: [] };
          if (!Array.isArray(board.taskPlan.tasks)) board.taskPlan.tasks = [];
          board.taskPlan.tasks.push(...meetingTasks);

          const rawId = meetingTasks[0]?.id || '';
          const cycleId = rawId
            .replace(/^MTG-/, '')
            .replace(/-(proposal-.+|synthesis|checkin)$/, '') || `cycle-${Date.now()}`;

          const cyclePhase = meetingType === 'midweek_checkin' ? 'checkin' : 'proposal';
          village.currentCycle = {
            cycleId,
            phase: cyclePhase,
            meetingType,
            startedAt: now,
            taskIds: meetingTasks.map(t => t.id),
          };

          vHelpers.writeBoard(board);
          vHelpers.appendLog({
            ts: now, event: 'village_meeting_triggered',
            villageId, cycleId, meetingType, taskCount: meetingTasks.length,
          });
          vHelpers.broadcastSSE('village_meeting', { villageId, cycleId, meetingType, phase: cyclePhase });

          return {
            ok: true, villageId, cycleId, meetingType,
            phase: cyclePhase,
            tasksCreated: meetingTasks.length,
            taskIds: meetingTasks.map(t => t.id),
          };
        }, 3);

        return json(res, 200, result);
      } catch (error) {
        if (error.code === 'VERSION_CONFLICT') {
          return json(res, 503, { error: 'Service temporarily unavailable', code: 'VERSION_CONFLICT' });
        }
        if (error.code === 'MEETING_ACTIVE') {
          return json(res, 409, { error: 'meeting_active', message: error.message, currentCycle: error.currentCycle });
        }
        if (error.code === 'NO_DEPARTMENTS') {
          return json(res, 400, { error: 'no_departments', message: error.message });
        }
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── POST /api/villages/:id/approve — approve pending plan ──
  if (req.method === 'POST' && subPath === 'approve') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(async body => {
      try {
        const board = vHelpers.readBoard();
        const village = ensureVillage(board, villageId);

        if (!village.currentCycle || village.currentCycle.phase !== 'awaiting_approval') {
          return json(res, 409, {
            error: 'not_awaiting_approval',
            message: `Current cycle phase is "${village.currentCycle?.phase || 'none'}", expected "awaiting_approval"`,
          });
        }

        const cycleId = village.currentCycle.cycleId;
        const allTasks = board.taskPlan?.tasks || [];
        const planDispatcher = require('../village/plan-dispatcher');
        const synthTask = allTasks.find(t =>
          planDispatcher.isSynthesisTask(t) &&
          (t.source?.cycleId === cycleId || t.id === `MTG-${cycleId}-synthesis`)
        );

        if (!synthTask) {
          return json(res, 404, { error: 'synthesis_task_not_found' });
        }

        const steps = synthTask.steps || [];
        const lastSucceeded = steps.slice().reverse().find(s => s.state === 'succeeded');
        if (!lastSucceeded) {
          return json(res, 422, { error: 'no_succeeded_step' });
        }

        const { artifactStore } = deps;
        const synthArtifact = artifactStore.readArtifact(
          lastSucceeded.run_id, lastSucceeded.step_id, 'output'
        );
        const planData = planDispatcher.extractPlanFromArtifact(synthArtifact);
        if (!planData) {
          return json(res, 422, { error: 'no_plan_in_artifact' });
        }

        const result = await planDispatcher.parsePlanAndDispatch(
          board, planData, vHelpers, deps, synthTask
        );

        vHelpers.appendLog({
          ts: vHelpers.nowIso(),
          event: 'village_plan_approved',
          villageId, cycleId,
          approvedBy: body.approvedBy || 'human',
          taskCount: result.taskIds.length,
        });

        return json(res, 200, {
          ok: true, villageId, cycleId, phase: 'execution',
          dispatched: result.dispatched, taskIds: result.taskIds,
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // No matching sub-route
  return false;
};
