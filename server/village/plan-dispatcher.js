/**
 * plan-dispatcher.js — Village Plan → Execution Tasks
 *
 * After the synthesis step completes, this module parses the village chief's
 * weekly plan and creates executable Karvi tasks on the board.
 *
 * Called from kernel.js as a server-side hook — no LLM tokens consumed.
 *
 * Plan format (embedded in STEP_RESULT):
 *   { cycle, tasks: [{ title, department, assignee, pipeline, depends, priority }],
 *     conflicts_resolved, deferred }
 */
const bb = require('../blackboard-server');
const { uid, nowIso } = bb;
const mgmt = require('../management');

/**
 * Extract plan data from a synthesis step's output artifact.
 *
 * The synthesis agent outputs STEP_RESULT:{"status":"succeeded","plan":{...}}.
 * The step-worker parses the STEP_RESULT and writes the parsed object to the
 * output artifact. However, the plan payload may be in the artifact's summary
 * (raw text) or in a top-level plan field. We try multiple extraction paths.
 *
 * @param {object} artifact - The output artifact from artifactStore.readArtifact()
 * @returns {object|null} The plan object, or null if not found
 */
function extractPlanFromArtifact(artifact) {
  if (!artifact) return null;

  // Path 1: plan-dispatcher was given the pre-parsed plan object directly
  if (artifact.plan && Array.isArray(artifact.plan.tasks)) {
    return artifact.plan;
  }

  // Path 2: step-worker preserved STEP_RESULT payload containing plan
  if (artifact.payload?.plan) {
    // Handle both formats: plan as { tasks: [...] } or plan as [...]
    if (Array.isArray(artifact.payload.plan.tasks)) {
      return artifact.payload.plan;
    }
    if (Array.isArray(artifact.payload.plan)) {
      return { tasks: artifact.payload.plan };
    }
  }

  // Path 3: STEP_RESULT was parsed by step-worker, plan is in summary text
  const summaryText = artifact.summary || '';
  const planFromText = extractPlanFromText(summaryText);
  if (planFromText) return planFromText;

  return null;
}

/**
 * Parse plan JSON from raw text containing STEP_RESULT.
 *
 * @param {string} text - Raw text that may contain STEP_RESULT:{...}
 * @returns {object|null} The plan object, or null
 */
function extractPlanFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // Try to find STEP_RESULT JSON in the text
  const match = text.match(/STEP_RESULT:\s*(\{[\s\S]*\})\s*$/m);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.plan && Array.isArray(parsed.plan.tasks)) {
      return parsed.plan;
    }
  } catch {
    // JSON parse failed, ignore
  }
  return null;
}

/**
 * Parse a synthesis artifact and dispatch execution tasks onto the board.
 *
 * @param {object} board           - The board object (mutated in place)
 * @param {object} planData        - The parsed plan: { cycle, tasks, conflicts_resolved, deferred }
 * @param {object} helpers         - { readBoard, writeBoard, appendLog, broadcastSSE, nowIso, uid }
 * @param {object} deps            - Dependency injection { tryAutoDispatch, ... }
 * @param {object} [synthesisTask] - The original synthesis task (for context)
 */
function parsePlanAndDispatch(board, planData, helpers, deps, synthesisTask) {
  const planTasks = planData.tasks;
  if (!Array.isArray(planTasks) || planTasks.length === 0) {
    console.warn('[village:plan-dispatcher] plan has no tasks, skipping dispatch');
    return { dispatched: 0, taskIds: [] };
  }

  // Ensure board.taskPlan exists
  if (!board.taskPlan) board.taskPlan = { goal: '', phase: 'idle', tasks: [] };
  if (!Array.isArray(board.taskPlan.tasks)) board.taskPlan.tasks = [];

  const cycleId = planData.cycle || `cycle-${Date.now()}`;
  const now = helpers.nowIso();
  const createdTaskIds = [];

  // Map plan-internal depends (by title/index) to real task IDs
  const titleToId = new Map();

  for (let i = 0; i < planTasks.length; i++) {
    const pt = planTasks[i];
    const taskId = uid('VT');

    titleToId.set(pt.title, taskId);
    titleToId.set(String(i), taskId);  // allow index-based depends

    // Resolve template name or normalize inline pipeline
    const pipeline = mgmt.resolvePipeline(pt.pipeline, board) || normalizePipeline(pt.pipeline);

    // Resolve depends: plan-internal refs + explicit cross-task deps
    const resolvedDepends = resolveDependencies(pt.depends, titleToId);

    const task = {
      id: taskId,
      title: pt.title || `Task ${i + 1}`,
      assignee: pt.assignee || 'engineer_lite',
      status: resolvedDepends.length > 0 ? 'pending' : 'dispatched',
      depends: resolvedDepends,
      priority: pt.priority || 'P2',
      department: pt.department || null,
      pipeline,
      source: {
        type: 'village_plan',
        cycleId,
        synthesisTaskId: synthesisTask?.id || null,
      },
      history: [{
        ts: now,
        status: resolvedDepends.length > 0 ? 'pending' : 'dispatched',
        reason: `village_plan:${cycleId}`,
      }],
    };

    board.taskPlan.tasks.push(task);
    createdTaskIds.push(taskId);
  }

  // Update village cycle phase to execution
  if (board.village?.currentCycle) {
    board.village.currentCycle.phase = 'execution';
    board.village.currentCycle.executionStartedAt = now;
    board.village.currentCycle.executionTaskIds = createdTaskIds;
  }

  // Emit signal
  const mgmt = deps.mgmt;
  if (mgmt) mgmt.ensureEvolutionFields(board);
  if (!Array.isArray(board.signals)) board.signals = [];
  board.signals.push({
    id: helpers.uid('sig'),
    ts: now,
    by: 'plan-dispatcher',
    type: 'village_plan_dispatched',
    content: `Plan dispatched: ${createdTaskIds.length} tasks from ${cycleId}`,
    refs: createdTaskIds,
    data: {
      cycleId,
      taskCount: createdTaskIds.length,
      taskIds: createdTaskIds,
      conflictsResolved: planData.conflicts_resolved || [],
      deferred: planData.deferred || [],
    },
  });
  if (board.signals.length > 500) board.signals = board.signals.slice(-500);

  // Write board + broadcast
  helpers.writeBoard(board);
  helpers.broadcastSSE('village_plan_dispatched', {
    cycleId,
    phase: 'execution',
    taskCount: createdTaskIds.length,
    taskIds: createdTaskIds,
  });

  helpers.appendLog({
    ts: now,
    event: 'village_plan_dispatched',
    cycleId,
    taskCount: createdTaskIds.length,
    taskIds: createdTaskIds,
  });

  // Push notification: village.plan_executing
  if (deps.push && deps.PUSH_TOKENS_PATH) {
    deps.push.notifyTaskEvent(deps.PUSH_TOKENS_PATH, null, 'village.plan_executing', {
      cycleId, taskCount: createdTaskIds.length,
    }).catch(err => console.error('[plan-dispatcher] village.plan_executing push error:', err.message));
  }

  // Ensure all VT assignees are registered as agent participants.
  // Without this, tryAutoDispatch silently skips tasks whose assignee
  // isn't in board.participants (the participantById guard).
  ensureAssigneesRegistered(board, createdTaskIds);

  // Auto-dispatch tasks that are ready (status === 'dispatched')
  if (deps.tryAutoDispatch) {
    for (const taskId of createdTaskIds) {
      const task = board.taskPlan.tasks.find(t => t.id === taskId);
      if (task && task.status === 'dispatched') {
        setImmediate(() => deps.tryAutoDispatch(taskId));
      }
    }
  }

  console.log(`[village:plan-dispatcher] dispatched ${createdTaskIds.length} tasks for ${cycleId}`);
  return { dispatched: createdTaskIds.length, taskIds: createdTaskIds };
}

/**
 * Check if a task is a village synthesis task.
 * Convention: synthesis tasks have ID matching MTG-*-synthesis.
 *
 * @param {object} task
 * @returns {boolean}
 */
function isSynthesisTask(task) {
  if (!task || !task.id) return false;
  return /^MTG-.*-synthesis$/.test(task.id);
}

// --- Helpers ---

/**
 * Normalize pipeline entries from the plan.
 * Accepts both string[] and object[] formats.
 */
function normalizePipeline(pipeline) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return [{ type: 'implement', instruction: null, runtime_hint: 'claude' }];
  }
  return pipeline.map(entry => {
    if (typeof entry === 'string') {
      return { type: entry, runtime_hint: 'claude' };
    }
    if (entry && typeof entry === 'object' && typeof entry.type === 'string') {
      return {
        type: entry.type,
        instruction: entry.instruction || null,
        skill: entry.skill || null,
        runtime_hint: entry.runtime_hint || 'claude',
      };
    }
    return { type: 'implement', instruction: null, runtime_hint: 'claude' };
  });
}

/**
 * Resolve plan-internal dependencies.
 * Plan tasks can reference depends by title or index.
 *
 * @param {Array} depends - Array of dependency references (title strings or indices)
 * @param {Map} titleToId - Map from title/index to created task ID
 * @returns {string[]} Array of resolved task IDs
 */
function resolveDependencies(depends, titleToId) {
  if (!Array.isArray(depends) || depends.length === 0) return [];
  const resolved = [];
  for (const dep of depends) {
    const depStr = String(dep);
    const resolvedId = titleToId.get(depStr);
    if (resolvedId) {
      resolved.push(resolvedId);
    }
    // If dep looks like an existing task ID (not plan-internal), keep as-is
    else if (depStr.startsWith('VT-') || depStr.startsWith('MTG-') || depStr.startsWith('GH-')) {
      resolved.push(depStr);
    }
    // else: unresolvable dependency — skip with warning
    else {
      console.warn(`[village:plan-dispatcher] unresolvable dependency: "${depStr}"`);
    }
  }
  return resolved;
}

/**
 * Ensure all VT task assignees are registered as agent participants.
 * tryAutoDispatch checks participantById(board, task.assignee) and silently
 * skips tasks whose assignee isn't registered. This closes that gap.
 */
function ensureAssigneesRegistered(board, taskIds) {
  if (!Array.isArray(board.participants)) board.participants = [];
  const existing = new Set(board.participants.map(p => p.id));

  for (const taskId of taskIds) {
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task?.assignee || existing.has(task.assignee)) continue;

    board.participants.push({
      id: task.assignee,
      type: 'agent',
      displayName: task.assignee,
      agentId: task.assignee,
    });
    existing.add(task.assignee);
    console.log(`[village:plan-dispatcher] auto-registered participant: ${task.assignee}`);
  }
}

module.exports = {
  extractPlanFromArtifact,
  extractPlanFromText,
  parsePlanAndDispatch,
  isSynthesisTask,
  normalizePipeline,
  resolveDependencies,
  ensureAssigneesRegistered,
};
