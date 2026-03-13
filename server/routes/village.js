/**
 * routes/village.js — Village Chief System APIs
 *
 * POST /api/village/goals       — add/update a goal
 * GET  /api/village/goals       — list active goals
 * POST /api/village/departments  — add/update a department
 * GET  /api/village/status       — current cycle status
 * POST /api/village/trigger      — trigger a meeting (Phase 1)
 * POST /api/village/config       — update village config (e.g. auto_approve)
 * POST /api/village/approve      — approve pending plan and dispatch execution tasks
 * GET  /api/village/profile      — get active chief profile + list available profiles
 * PUT  /api/village/profile      — switch active chief profile
 */
const bb = require('../blackboard-server');
const { json } = bb;
const { requireRole } = require('./_shared');
const { retryOnConflict } = require('../helpers/retry');
const chiefProfile = require('../village/chief-profile');

// --- Default village block for board.json ---
const DEFAULT_VILLAGE = {
  goals: [],
  departments: [],
  currentCycle: null,
};

/**
 * Ensure an agent is registered as a participant on the board.
 * tryAutoDispatch silently skips tasks whose assignee isn't in
 * board.participants, so we auto-register department assignees.
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
    if (requireRole(req, res, 'operator')) return;
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
    if (requireRole(req, res, 'operator')) return;
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
          if (existing.assignee) ensureAgentParticipant(board, existing.assignee);
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
        ensureAgentParticipant(board, dept.assignee);
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
      const activeGoals = village.goals.filter(g => g.active);
      const departments = village.departments;

      // Build department summary with goal counts
      const departmentSummary = departments.map(dept => ({
        id: dept.id,
        name: dept.name,
        goalCount: activeGoals.filter(g => (dept.goalIds || []).includes(g.id)).length,
      }));

      // If no current cycle, return basic info
      const cycle = village.currentCycle;
      if (!cycle) {
        return json(res, 200, {
          currentCycle: null,
          goalCount: activeGoals.length,
          departmentCount: departments.length,
          departments: departmentSummary,
        });
      }

      const allTasks = board.taskPlan?.tasks || [];
      const { cycleId } = cycle;

      // --- Proposal tasks: MTG-{cycleId}-proposal-{deptId} ---
      const proposalPrefix = `MTG-${cycleId}-proposal-`;
      const proposalTasks = allTasks.filter(t => t.id && t.id.startsWith(proposalPrefix));
      const proposals = proposalTasks.map(t => {
        const department = t.id.slice(proposalPrefix.length);
        const summary = (t.result && t.result.summary)
          ? t.result.summary
          : (t.lastReply ? t.lastReply.slice(0, 300) : null);
        return {
          taskId: t.id,
          department,
          status: t.status,
          summary,
        };
      });

      // --- Synthesis task: MTG-{cycleId}-synthesis ---
      const synthesisId = `MTG-${cycleId}-synthesis`;
      const synthesisTask = allTasks.find(t => t.id === synthesisId);
      let synthesis = null;
      if (synthesisTask) {
        // Count plan tasks produced by this synthesis (VT tasks referencing this synthesisTaskId)
        const planTaskCount = allTasks.filter(
          t => t.source && t.source.synthesisTaskId === synthesisId
        ).length;
        synthesis = {
          taskId: synthesisTask.id,
          status: synthesisTask.status,
          planTaskCount,
        };
      }

      // --- Execution tasks: VT-* with source.cycleId === cycleId ---
      const execTasks = allTasks.filter(
        t => t.source && t.source.type === 'village_plan' && t.source.cycleId === cycleId
      );
      const execStatusCount = { completed: 0, inProgress: 0, blocked: 0, pending: 0 };
      for (const t of execTasks) {
        if (t.status === 'approved') execStatusCount.completed++;
        else if (t.status === 'in_progress' || t.status === 'running' || t.status === 'dispatched') execStatusCount.inProgress++;
        else if (t.status === 'blocked') execStatusCount.blocked++;
        else execStatusCount.pending++;
      }
      const execution = {
        total: execTasks.length,
        completed: execStatusCount.completed,
        inProgress: execStatusCount.inProgress,
        blocked: execStatusCount.blocked,
        pending: execStatusCount.pending,
        tasks: execTasks.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          department: t.department || null,
        })),
      };

      return json(res, 200, {
        currentCycle: {
          cycleId: cycle.cycleId,
          phase: cycle.phase,
          startedAt: cycle.startedAt,
          proposals,
          synthesis,
          execution,
        },
        goalCount: activeGoals.length,
        departmentCount: departments.length,
        departments: departmentSummary,
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // ── POST /api/village/trigger — trigger a village meeting ──
  if (req.method === 'POST' && pathname === '/api/village/trigger') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(async body => {
      try {
        const result = await retryOnConflict(async () => {
          const board = helpers.readBoard();
          const village = ensureVillage(board);
          const now = helpers.nowIso();

          const meetingType = body.type || 'weekly_planning';

          // Idempotency check: don't start a new meeting if one is already active
          // - proposal phase: always block (weekly_planning already in progress)
          // - checkin phase: block only if another midweek_checkin is requested
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

          // Validate: need at least one department (not required for midweek check-ins)
          if (meetingType !== 'midweek_checkin' && village.departments.length === 0) {
            const error = new Error('Cannot trigger meeting without departments. Add departments first via POST /api/village/departments');
            error.code = 'NO_DEPARTMENTS';
            throw error;
          }

          // Ensure all department assignees are registered as participants
          for (const dept of village.departments) {
            ensureAgentParticipant(board, dept.assignee);
          }

          // Generate meeting tasks
          const { generateMeetingTasks } = require('../village/village-meeting');
          const meetingTasks = generateMeetingTasks(board, meetingType);

          // Ensure ALL meeting task assignees are registered as participants
          // (covers synthesis/chief assignee in addition to department assignees)
          for (const task of meetingTasks) {
            ensureAgentParticipant(board, task.assignee);
          }

          // Add tasks to board
          if (!board.taskPlan) board.taskPlan = { goal: '', phase: 'idle', tasks: [] };
          if (!Array.isArray(board.taskPlan.tasks)) board.taskPlan.tasks = [];
          board.taskPlan.tasks.push(...meetingTasks);

          // Set cycle state
          // Extract cycleId from the first task id: MTG-{cycleId}-{suffix}
          // suffix may be "proposal-{deptId}", "synthesis", or "checkin"
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

          helpers.writeBoard(board);
          helpers.appendLog({
            ts: now,
            event: 'village_meeting_triggered',
            cycleId,
            meetingType,
            taskCount: meetingTasks.length,
          });
          helpers.broadcastSSE('village_meeting', { cycleId, meetingType, phase: cyclePhase });

          // Auto-dispatch dispatched tasks
          if (deps.tryAutoDispatch) {
            for (const t of meetingTasks) {
              if (t.status === 'dispatched') {
                setImmediate(() => deps.tryAutoDispatch(t.id));
              }
            }
          }

          return {
            ok: true,
            cycleId,
            meetingType,
            phase: cyclePhase,
            tasksCreated: meetingTasks.length,
            taskIds: meetingTasks.map(t => t.id),
          };
        }, 3);

        return json(res, 200, result);
      } catch (error) {
        if (error.code === 'VERSION_CONFLICT') {
          console.error('[village] max retries exhausted for trigger');
          return json(res, 503, {
            error: 'Service temporarily unavailable',
            code: 'VERSION_CONFLICT',
            message: 'Board is under high contention, please retry later'
          });
        }
        if (error.code === 'MEETING_ACTIVE') {
          return json(res, 409, {
            error: 'meeting_active',
            message: error.message,
            currentCycle: error.currentCycle,
          });
        }
        if (error.code === 'NO_DEPARTMENTS') {
          return json(res, 400, {
            error: 'no_departments',
            message: error.message,
          });
        }
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── POST /api/village/config — update village-level config ──
  if (req.method === 'POST' && pathname === '/api/village/config') {
    if (requireRole(req, res, 'admin')) return;
    helpers.parseBody(req).then(body => {
      try {
        const board = helpers.readBoard();
        const village = ensureVillage(board);
        const now = helpers.nowIso();

        if (body.auto_approve !== undefined) {
          village.auto_approve = Boolean(body.auto_approve);
        }

        // Tool tier policy: merge provided fields into existing policy
        if (body.tool_tier_policy && typeof body.tool_tier_policy === 'object') {
          const validTiers = new Set(['T0', 'T1', 'T2', 'T3', 'T4']);
          const policy = body.tool_tier_policy;
          const merged = village.tool_tier_policy || {};
          for (const key of ['chief_max_tier', 'proposal_max_tier', 'default_worker_tier']) {
            if (policy[key] !== undefined) {
              if (!validTiers.has(policy[key])) {
                return json(res, 400, { error: `invalid tier "${policy[key]}" for ${key}` });
              }
              merged[key] = policy[key];
            }
          }
          if (policy.tier_upgrade_requires !== undefined) {
            if (typeof policy.tier_upgrade_requires !== 'string') {
              return json(res, 400, { error: 'tier_upgrade_requires must be a string' });
            }
            merged.tier_upgrade_requires = policy.tier_upgrade_requires;
          }
          village.tool_tier_policy = merged;
        }

        helpers.writeBoard(board);
        helpers.appendLog({ ts: now, event: 'village_config_updated', config: { auto_approve: village.auto_approve, tool_tier_policy: village.tool_tier_policy || null } });
        return json(res, 200, { ok: true, auto_approve: village.auto_approve, tool_tier_policy: village.tool_tier_policy || null });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── POST /api/village/approve — approve pending plan and dispatch tasks ──
  if (req.method === 'POST' && pathname === '/api/village/approve') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(async body => {
      try {
        const board = helpers.readBoard();
        const village = ensureVillage(board);

        // Validate: must be in awaiting_approval phase
        if (!village.currentCycle || village.currentCycle.phase !== 'awaiting_approval') {
          return json(res, 409, {
            error: 'not_awaiting_approval',
            message: `Current cycle phase is "${village.currentCycle?.phase || 'none'}", expected "awaiting_approval"`,
            currentCycle: village.currentCycle || null,
          });
        }

        // Find the synthesis task for this cycle
        const cycleId = village.currentCycle.cycleId;
        const allTasks = board.taskPlan?.tasks || [];
        const planDispatcher = require('../village/plan-dispatcher');
        const synthTask = allTasks.find(t =>
          planDispatcher.isSynthesisTask(t) &&
          (t.source?.cycleId === cycleId || t.id === `MTG-${cycleId}-synthesis`)
        );

        if (!synthTask) {
          return json(res, 404, {
            error: 'synthesis_task_not_found',
            message: `Cannot find synthesis task for cycle ${cycleId}`,
          });
        }

        // Determine the last succeeded step and its run_id
        const steps = synthTask.steps || [];
        const lastSucceeded = steps.slice().reverse().find(s => s.state === 'succeeded');
        if (!lastSucceeded) {
          return json(res, 422, {
            error: 'no_succeeded_step',
            message: 'Synthesis task has no succeeded steps — cannot read artifact',
          });
        }

        // Read the synthesis artifact
        const { artifactStore } = deps;
        const synthArtifact = artifactStore.readArtifact(
          lastSucceeded.run_id, lastSucceeded.step_id, 'output'
        );
        const planData = planDispatcher.extractPlanFromArtifact(synthArtifact);

        if (!planData) {
          return json(res, 422, {
            error: 'no_plan_in_artifact',
            message: 'Synthesis artifact does not contain a parseable plan',
          });
        }

        // Dispatch execution tasks
        const result = planDispatcher.parsePlanAndDispatch(
          board, planData, helpers, deps, synthTask
        );

        const now = helpers.nowIso();
        helpers.appendLog({
          ts: now,
          event: 'village_plan_approved',
          cycleId,
          approvedBy: body.approvedBy || 'human',
          taskCount: result.taskIds.length,
          taskIds: result.taskIds,
        });

        return json(res, 200, {
          ok: true,
          cycleId,
          phase: 'execution',
          dispatched: result.dispatched,
          taskIds: result.taskIds,
        });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  // ── GET /api/village/profile — get active profile + list available ──
  if (req.method === 'GET' && pathname === '/api/village/profile') {
    try {
      const board = helpers.readBoard();
      const activeName = chiefProfile.getActiveProfileName(board);
      const available = chiefProfile.listProfiles();
      const active = activeName ? chiefProfile.loadProfile(activeName) : null;

      return json(res, 200, {
        active: activeName,
        governance: active ? active.governance : null,
        available,
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // ── PUT /api/village/profile — switch active chief profile ──
  if (req.method === 'PUT' && pathname === '/api/village/profile') {
    if (requireRole(req, res, 'operator')) return;
    helpers.parseBody(req).then(body => {
      try {
        const { profile } = body;

        // profile=null clears the active profile (revert to legacy behavior)
        if (profile === null) {
          const board = helpers.readBoard();
          const village = ensureVillage(board);
          const previous = village.chief_profile || null;
          delete village.chief_profile;
          helpers.writeBoard(board);
          helpers.appendLog({ ts: helpers.nowIso(), event: 'village_profile_cleared', previous });
          helpers.broadcastSSE('village_profile_changed', { profile: null, previous });
          return json(res, 200, { ok: true, profile: null, previous });
        }

        if (!chiefProfile.isValidProfileName(profile)) {
          return json(res, 400, { error: 'invalid profile name' });
        }

        const loaded = chiefProfile.loadProfile(profile);
        if (!loaded) {
          return json(res, 404, { error: `profile "${profile}" not found`, available: chiefProfile.listProfiles() });
        }

        const board = helpers.readBoard();
        const village = ensureVillage(board);
        const previous = village.chief_profile || null;
        village.chief_profile = profile;
        helpers.writeBoard(board);
        helpers.appendLog({ ts: helpers.nowIso(), event: 'village_profile_changed', profile, previous });
        helpers.broadcastSSE('village_profile_changed', { profile, previous });
        return json(res, 200, { ok: true, profile, governance: loaded.governance, previous });
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
