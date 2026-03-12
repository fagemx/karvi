/**
 * management/dispatch.js — Dispatch plan building, model resolution,
 * message building, task transitions, step pipeline, pick/unlock
 */
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const { nowIso, uid } = bb;
const stepSchema = require('../step-schema');
const { resolveRepoRoot } = require('../repo-resolver');
const { BUDGET_DEFAULTS } = require('../route-engine');
const { matchLessonsForTask, buildPreflightSection } = require('./lessons');
const { buildProtectedDecisionsSection, buildSkillContextSection, buildCompletionCriteriaSection } = require('./evolution');

const DIR = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(DIR, 'skills');
const WORKSPACE = path.resolve(DIR, '..', '..', '..');
const PORT = Number(process.env.PORT || 3461);

// --- Dispatch Plan ---
const DISPATCH_PLAN_VERSION = 1;
const VALID_DISPATCH_STATES = new Set(['prepared', 'dispatching', 'completed', 'failed']);

// --- Skill ↔ Role mapping (for Codex runtime) ---
const SKILL_ROLE_MAP = {
  'conversapix-storyboard': { codexRole: 'designer', skills: ['conversapix-storyboard'] },
  'coding-agent':           { codexRole: 'worker',   skills: ['coding-agent', 'gctx-workflow'] },
  'gctx-workflow':          { codexRole: 'worker',   skills: ['gctx-workflow'] },
};
const DEFAULT_CODEX_ROLE = 'worker';

// Preferred model routing map
const AGENT_MODEL_MAP = {
  engineer_pro: 'custom-ai-t8star-cn/gemini-3.1-pro-preview',
  engineer_lite: 'custom-ai-t8star-cn/gpt-5.3-codex-high',
  nier: 'openai-codex/gpt-5.3-codex',
  dialectic: 'custom-ai-t8star-cn/claude-opus-4-6-thinking',
  main: 'openai-codex/gpt-5.3-codex',
};

function preferredModelFor(agentId) {
  return AGENT_MODEL_MAP[String(agentId || '').trim()] || null;
}

/**
 * Validate modelHint format: must be "provider/model" with non-empty parts.
 */
function validateModelHint(hint) {
  if (hint === null || hint === undefined) return { valid: true, normalized: null };
  if (typeof hint !== 'string') return { valid: false, reason: 'modelHint must be a string' };
  const trimmed = hint.trim();
  if (!trimmed) return { valid: false, reason: 'modelHint must not be empty' };
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx < 0) return { valid: false, reason: 'modelHint must be in "provider/model" format (e.g. "anthropic/claude-sonnet-4")' };
  const provider = trimmed.slice(0, slashIdx);
  const model = trimmed.slice(slashIdx + 1);
  if (!provider || !model) return { valid: false, reason: 'modelHint must have both provider and model parts' };
  const known = new Set(Object.values(AGENT_MODEL_MAP));
  const warning = !known.has(trimmed) ? `model "${trimmed}" is not in the known models registry` : null;
  return { valid: true, normalized: trimmed, warning };
}

/**
 * 計算 task 預算剩餘百分比（以 token 為主，最能反映成本）。
 * 無預算時回傳 100（不觸發降級）。
 */
function budgetPctRemaining(budget) {
  if (!budget) return 100;
  const limits = { ...BUDGET_DEFAULTS, ...budget.limits };
  const used = budget.used || {};
  const tokenPct = limits.max_tokens > 0
    ? ((limits.max_tokens - (used.tokens || 0)) / limits.max_tokens) * 100
    : 100;
  return Math.max(0, Math.min(100, tokenPct));
}

/**
 * 從 cost_routing tiers 中找到匹配的 model（預算低時自動降級）。
 */
function resolveCostRoutingModel(runtimeHint, stepType, controls, budget) {
  const costRouting = controls?.cost_routing;
  if (!costRouting?.tiers?.length || !budget) return null;
  const pctRemaining = budgetPctRemaining(budget);
  const sortedTiers = [...costRouting.tiers].sort((a, b) => a.budget_pct_remaining - b.budget_pct_remaining);
  for (const tier of sortedTiers) {
    if (pctRemaining <= tier.budget_pct_remaining && tier.model_map) {
      const tierMap = tier.model_map[runtimeHint];
      if (tierMap && typeof tierMap === 'object') {
        const model = (stepType && tierMap[stepType]) || tierMap.default || null;
        if (model) {
          console.log(`[cost-routing] budget ${Math.round(pctRemaining)}% remaining, using tier model: ${model}`);
          return model;
        }
      }
    }
  }
  return null;
}

function resolveModelHint(runtimeHint, stepType, controls, task) {
  if (task.modelHint) {
    const v = validateModelHint(task.modelHint);
    if (!v.valid) {
      console.warn(`[resolveModelHint] invalid modelHint for ${task.id}: ${v.reason} — falling through to model_map`);
    } else {
      return v.normalized;
    }
  }
  const costModel = resolveCostRoutingModel(runtimeHint, stepType, controls, task.budget);
  if (costModel) return costModel;

  const map = controls.model_map;
  if (map && typeof map === 'object') {
    const runtimeMap = map[runtimeHint];
    if (runtimeMap && typeof runtimeMap === 'object') {
      const model = (stepType && runtimeMap[stepType]) || runtimeMap.default || null;
      if (model) return model;
    }
  }
  if (runtimeHint === 'claude' || runtimeHint === 'opencode' || runtimeHint === 'codex') return null;
  return preferredModelFor(task.assignee);
}

// --- Task status transitions ---

const ALLOWED_TASK_TRANSITIONS = {
  pending: ['dispatched', 'cancelled'],
  dispatched: ['in_progress', 'pending', 'cancelled'],
  in_progress: ['blocked', 'completed', 'dispatched', 'cancelled'],
  blocked: ['in_progress', 'dispatched', 'cancelled'],
  completed: ['reviewing', 'approved', 'needs_revision'],
  reviewing: ['approved', 'needs_revision'],
  needs_revision: ['in_progress', 'approved'],
  approved: [],
  cancelled: [],
};

function canTransitionTaskStatus(fromStatus, toStatus) {
  const from = String(fromStatus || 'pending');
  const to = String(toStatus || '').trim();
  if (!to) return false;
  if (from === to) return false;
  return (ALLOWED_TASK_TRANSITIONS[from] || []).includes(to);
}

function ensureTaskTransition(fromStatus, toStatus) {
  if (!canTransitionTaskStatus(fromStatus, toStatus)) {
    const from = String(fromStatus || 'pending');
    const err = new Error(`Invalid task status transition: ${from} -> ${toStatus}`);
    err.code = 'INVALID_TASK_TRANSITION';
    throw err;
  }
}

// --- Task result parsing ---

function parseTaskResultFromLastLine(replyText) {
  const lines = String(replyText || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { result: null, rawLine: null, error: null };
  }

  const lastLine = lines[lines.length - 1];
  const match = lastLine.match(/^TASK_RESULT:\s*(\{.*\})$/);
  if (!match) {
    return { result: null, rawLine: lastLine, error: null };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    return {
      result: null,
      rawLine: lastLine,
      error: `TASK_RESULT JSON parse failed: ${error.message}`,
    };
  }

  const status = String(parsed.status || '').trim();
  if (status === 'completed') {
    return {
      result: {
        status: 'completed',
        summary: String(parsed.summary || '').trim(),
      },
      rawLine: lastLine,
      error: null,
    };
  }

  if (status === 'blocked') {
    const reason = String(parsed.reason || '').trim();
    if (!reason) {
      return {
        result: null,
        rawLine: lastLine,
        error: 'TASK_RESULT blocked requires non-empty reason',
      };
    }

    return {
      result: {
        status: 'blocked',
        reason,
      },
      rawLine: lastLine,
      error: null,
    };
  }

  return {
    result: null,
    rawLine: lastLine,
    error: `TASK_RESULT unsupported status: ${status || '(empty)'}`,
  };
}

// --- Spec / upstream helpers ---

function readSpecContent(specRelPath) {
  if (!specRelPath) return null;
  try {
    const fullPath = path.join(DIR, specRelPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const MAX_SPEC = 4000;
    if (content.length > MAX_SPEC) {
      return content.slice(0, MAX_SPEC) + '\n... (spec 超過 4000 字元，已截斷) ...';
    }
    return content;
  } catch { return null; }
}

function gatherUpstreamArtifacts(board, task) {
  if (!task.depends?.length) return [];
  const allTasks = board.taskPlan?.tasks || [];
  const results = [];
  for (const depId of task.depends) {
    const dep = allTasks.find(t => t.id === depId);
    if (!dep) continue;
    const entry = { id: dep.id, title: dep.title, status: dep.status };
    if (dep.lastReply) {
      entry.summary = dep.lastReply.slice(0, 600);
    } else if (dep.result?.summary) {
      entry.summary = dep.result.summary.slice(0, 600);
    }
    if (dep.result?.payload) {
      entry.payload = dep.result.payload;
    }
    const lastStep = dep.steps?.filter(s => s.state === 'succeeded').pop();
    if (lastStep?.output_ref) {
      entry.output_ref = lastStep.output_ref;
    }
    results.push(entry);
  }
  return results;
}

// --- Dispatch message builders ---

function buildTaskDispatchMessage(board, task, options = {}) {
  const lines = [];

  lines.push('【任務派發】');
  lines.push('');

  lines.push('必讀（按順序讀完再動手）：');
  lines.push(`1. ${path.join(WORKSPACE, 'project', 'task-engine', 'skills', 'blackboard-basics', 'SKILL.md')}`);
  lines.push(`2. ${path.join(WORKSPACE, 'project', 'task-engine', 'skills', 'engineer-playbook', 'SKILL.md')}`);
  if (board.taskPlan?.spec) {
    lines.push(`3. ${path.join(DIR, board.taskPlan.spec)}`);
  }
  lines.push('');

  lines.push(`目標：${board.taskPlan?.goal || '(未設定)'}`);
  lines.push(`任務 ID：${task.id}`);
  lines.push(`任務名稱：${task.title}`);
  const preferredModel = preferredModelFor(task.assignee);
  lines.push(`Assignee：${task.assignee}${preferredModel ? `（preferred model: ${preferredModel}）` : ''}`);
  if (task.description) lines.push(`說明：${task.description}`);
  if (task.depends?.length) lines.push(`依賴：${task.depends.join(', ')}（已 approved）`);
  lines.push('');

  const specContent = readSpecContent(board.taskPlan?.spec);
  if (specContent) {
    lines.push('=== SPEC 內容（完整規格，照此實作）===');
    lines.push(specContent);
    lines.push('=== SPEC 結束 ===');
    lines.push('');
  }

  const upstream = gatherUpstreamArtifacts(board, task);
  if (upstream.length > 0) {
    lines.push('前置任務產出（你的任務建立在這些成果之上）：');
    for (const u of upstream) {
      lines.push(`  ${u.id} (${u.title}) [${u.status}]`);
      if (u.summary) lines.push(`    交付摘要：${u.summary}`);
    }
    lines.push('');
  }

  lines.push(`Task Engine: http://localhost:${PORT}`);
  lines.push('回報狀態 API：');
  lines.push(`  開始：POST http://localhost:${PORT}/api/tasks/${task.id}/status`);
  lines.push(`         body: {"status":"in_progress"}`);
  lines.push(`  完成：POST http://localhost:${PORT}/api/tasks/${task.id}/status`);
  lines.push(`         body: {"status":"completed"}`);
  lines.push(`  卡住：POST http://localhost:${PORT}/api/tasks/${task.id}/status`);
  lines.push(`         body: {"status":"blocked","reason":"具體原因"}`);
  lines.push('');
  lines.push('用 PowerShell: Invoke-RestMethod -Uri "..." -Method POST -ContentType "application/json" -Body \'...\'');
  lines.push('');

  lines.push('完成時，回覆必須包含：');
  lines.push('1. 建立/修改的檔案清單（完整路徑 + 一句話說明）');
  lines.push('2. 自檢結果（node -c, JSON parse, smoke test 等）');
  lines.push('3. 注意事項（後續任務需要知道的）');

  if (options.requireTaskResult) {
    lines.push('');
    lines.push('最後一行必須輸出 TASK_RESULT JSON：');
    lines.push('TASK_RESULT:{"status":"completed","summary":"..."}');
    lines.push('TASK_RESULT:{"status":"blocked","reason":"..."}');
  }

  const hints = (board.controls?.dispatch_hints || [])
    .filter(h => {
      if (h.taskType && task.type !== h.taskType && task.track !== h.taskType) return false;
      return true;
    });
  if (hints.length > 0) {
    lines.push('');
    lines.push('建議：');
    for (const h of hints) {
      if (h.preferAgent) lines.push(`- 建議 agent: ${h.preferAgent}（${h.reason || ''}）`);
    }
  }

  const preflight = buildPreflightSection(board, task, options);
  if (preflight.lines.length > 0) {
    lines.push(...preflight.lines);
  }

  const protectedDecisions = buildProtectedDecisionsSection();
  if (protectedDecisions.length > 0) {
    lines.push(...protectedDecisions);
  }

  return lines.join('\n');
}

function buildRedispatchMessage(board, task, options = {}) {
  const review = task.review || {};
  const lines = [];

  lines.push(`【任務修正指令 — ${task.id}】`);
  lines.push(`任務：${task.title}`);
  const preferredModel = preferredModelFor(task.assignee);
  lines.push(`Assignee：${task.assignee}${preferredModel ? `（preferred model: ${preferredModel}）` : ''}`);
  lines.push('');

  if (review.score !== undefined) {
    lines.push(`審查分數：${review.score}/${review.threshold || 70}（未達標）`);
  }

  if (review.issues?.length) {
    lines.push('');
    lines.push('發現的問題：');
    review.issues.forEach(i => lines.push(`  - ${i}`));
  }

  if (review.report) {
    lines.push('');
    lines.push('審查報告：');
    lines.push(review.report.slice(0, 1500));
  }

  lines.push('');
  lines.push('請根據以上審查結果修正你的程式碼。修正完畢後回報 completed。');
  lines.push(`回報 API: POST http://localhost:${PORT}/api/tasks/${task.id}/status`);
  lines.push('body: {"status":"completed"}');

  const specContent = readSpecContent(board.taskPlan?.spec);
  if (specContent) {
    lines.push('');
    lines.push('=== 原始 SPEC（供參考）===');
    lines.push(specContent);
    lines.push('=== SPEC 結束 ===');
  }

  const preflight = buildPreflightSection(board, task, options);
  if (preflight.lines.length > 0) {
    lines.push(...preflight.lines);
  }

  const protectedDecisions = buildProtectedDecisionsSection();
  if (protectedDecisions.length > 0) {
    lines.push(...protectedDecisions);
  }

  return lines.join('\n');
}

function buildGenericDispatchMessage(board, task, options = {}) {
  const lines = [];
  lines.push(`You are a coding agent. Implement the following task in this repository.`);
  lines.push('');
  lines.push(`Task ID: ${task.id}`);
  lines.push(`Title: ${task.title}`);
  if (task.description) {
    lines.push('');
    lines.push('Description:');
    lines.push(task.description);
  }
  lines.push('');

  const upstream = gatherUpstreamArtifacts(board, task);
  if (upstream.length > 0) {
    lines.push('Upstream task outputs (your task builds on these):');
    for (const u of upstream) {
      lines.push(`  ${u.id} (${u.title}) [${u.status}]`);
      if (u.summary) lines.push(`    Summary: ${u.summary}`);
    }
    lines.push('');
  }

  lines.push('Instructions:');
  lines.push('1. Read the relevant source files before making changes');
  lines.push('2. Implement the changes described above');
  lines.push('3. Run "node -c <file>" on every modified file to verify syntax');
  lines.push('4. Summarize what you changed and any verification results');

  lines.push(...buildSkillContextSection(resolveRepoRoot(task, board)));
  lines.push(...buildCompletionCriteriaSection());

  const preflight = buildPreflightSection(board, task, options);
  if (preflight.lines.length > 0) {
    lines.push('');
    lines.push(...preflight.lines);
  }

  const protectedDecisions = buildProtectedDecisionsSection();
  if (protectedDecisions.length > 0) {
    lines.push(...protectedDecisions);
  }

  return lines.join('\n');
}

/**
 * Resolve the owner (human) participant's ID from the board.
 */
function resolveOwnerId(board) {
  const humans = (board.participants || []).filter(p => p.type === 'human');
  return humans[0]?.id || 'default';
}

function buildDispatchPlan(board, task, options = {}) {
  const { getControls } = require('../management');
  const mode = options.mode === 'redispatch' ? 'redispatch' : 'dispatch';

  const controls = getControls(board);

  const runtimeHint = options.runtimeHint
    || board.controls?.preferred_runtime
    || 'openclaw';

  const lessonResult = matchLessonsForTask(board, task);

  const usesGenericMessage = runtimeHint === 'opencode' || runtimeHint === 'claude' || runtimeHint === 'codex';

  const message = mode === 'redispatch'
    ? buildRedispatchMessage(board, task, { lessonResult })
    : usesGenericMessage
      ? buildGenericDispatchMessage(board, task, { lessonResult })
      : buildTaskDispatchMessage(board, task, {
          requireTaskResult: options.requireTaskResult || false,
          lessonResult,
        });

  const runtimeRationale = options.runtimeHint
    ? 'caller_specified: ' + options.runtimeHint
    : board.controls?.preferred_runtime
      ? 'board_preferred: ' + board.controls.preferred_runtime
      : 'default: openclaw';

  const taskSkill = task.skill || null;
  const profile = (taskSkill && SKILL_ROLE_MAP[taskSkill]) || null;

  const userId = resolveOwnerId(board);

  return {
    kind: 'task_dispatch',
    version: DISPATCH_PLAN_VERSION,
    planId: uid('disp'),
    taskId: task.id,
    mode,
    runtimeHint,
    userId,
    agentId: task.assignee,
    modelHint: resolveModelHint(runtimeHint, options.stepType || null, controls, task),
    timeoutSec: options.timeoutSec || 300,
    sessionId: task.childSessionKey || null,
    message,
    createdAt: nowIso(),
    upstreamTaskIds: task.depends || [],
    artifacts: gatherUpstreamArtifacts(board, task),
    requiredSkills: profile?.skills || (taskSkill ? [taskSkill] : []),
    codexRole: profile?.codexRole || DEFAULT_CODEX_ROLE,
    controlsSnapshot: {
      quality_threshold: controls.quality_threshold,
      auto_dispatch: controls.auto_dispatch,
      auto_review: controls.auto_review,
      auto_redispatch: controls.auto_redispatch,
      max_review_attempts: controls.max_review_attempts,
    },
    injectedLessons: lessonResult.ids,
    injectedLessonCount: lessonResult.ids.length,
    runtimeSelection: {
      chosen: runtimeHint,
      rationale: runtimeRationale,
    },
    steps: options.steps || null,
    workingDir: options.workingDir || null,
  };
}

// --- Step-level helpers ---

const DEFAULT_STEP_PIPELINE = [
  'plan',
  'implement',
  { type: 'review', revision_target: 'implement' },
];

const BUILT_IN_TEMPLATES = {
  'default': [
    { type: 'plan' },
    { type: 'implement' },
    { type: 'review', revision_target: 'implement' },
  ],
  'security-review': [
    { type: 'plan', instruction: 'Focus on security implications and threat modeling' },
    { type: 'implement' },
    { type: 'review', instruction: 'Security-focused review: check for vulnerabilities, injection, auth bypass', revision_target: 'implement' },
    { type: 'review', instruction: 'Final security audit before merge', revision_target: 'implement' },
  ],
  'docs-only': [
    { type: 'implement', instruction: 'Documentation changes only — no code modifications' },
    { type: 'review', revision_target: 'implement' },
  ],
  'test-heavy': [
    { type: 'plan', instruction: 'Plan test strategy and identify edge cases' },
    { type: 'implement', instruction: 'Write tests first, then implement to pass them' },
    { type: 'review', instruction: 'Verify test coverage and edge cases', revision_target: 'implement' },
    { type: 'implement', instruction: 'Fix any issues found in review', revision_target: 'implement' },
    { type: 'review', revision_target: 'implement' },
  ],
  'quick-fix': [
    { type: 'implement' },
    { type: 'review', revision_target: 'implement' },
  ],
  'parallel-review': [
    { type: 'plan' },
    { type: 'implement' },
    { parallel: [
      { type: 'review', instruction: 'Code quality and correctness review', revision_target: 'implement' },
      { type: 'review', instruction: 'Security and performance review', revision_target: 'implement' },
    ]},
  ],
  'research': [
    { type: 'plan', instruction: 'Research and analyze the problem space thoroughly' },
    { type: 'plan', instruction: 'Propose solution options with trade-offs' },
    { type: 'implement' },
    { type: 'review', revision_target: 'implement' },
  ],
};

function normalizePipelineEntry(entry) {
  if (typeof entry === 'string') {
    const type = entry.trim();
    return type ? { type } : null;
  }
  // Parallel group: { parallel: [stepDef, stepDef, ...] }
  if (entry && typeof entry === 'object' && Array.isArray(entry.parallel)) {
    const children = entry.parallel.map(normalizePipelineEntry).filter(Boolean);
    if (children.length === 0) return null;
    return { _parallel: children };
  }
  if (entry && typeof entry === 'object' && typeof entry.type === 'string') {
    const type = entry.type.trim();
    if (!type) return null;
    return {
      type,
      instruction: typeof entry.instruction === 'string' ? entry.instruction : null,
      skill: typeof entry.skill === 'string' ? entry.skill : null,
      runtime_hint: typeof entry.runtime_hint === 'string' ? entry.runtime_hint : null,
      retry_policy: entry.retry_policy && typeof entry.retry_policy === 'object' ? entry.retry_policy : null,
      revision_target: typeof entry.revision_target === 'string' ? entry.revision_target : null,
      max_revision_cycles: typeof entry.max_revision_cycles === 'number' ? entry.max_revision_cycles : null,
    };
  }
  return null;
}

function resolvePipeline(pipelineValue, board) {
  if (Array.isArray(pipelineValue)) return pipelineValue;
  if (typeof pipelineValue === 'string') {
    const userTemplates = board?.pipelineTemplates || {};
    const resolved = userTemplates[pipelineValue] || BUILT_IN_TEMPLATES[pipelineValue];
    if (Array.isArray(resolved)) return resolved;
    console.warn(`[pipeline] template "${pipelineValue}" not found, using default`);
    return null;
  }
  return null;
}

function generateStepsForTask(task, runId, pipeline, board) {
  const source = resolvePipeline(pipeline, board)
    || resolvePipeline(task?.pipeline, board)
    || DEFAULT_STEP_PIPELINE;

  const normalized = source.map(normalizePipelineEntry).filter(Boolean);
  if (normalized.length === 0) {
    return DEFAULT_STEP_PIPELINE.map((type, i) => stepSchema.createStep(task.id, runId, type, { group: i }));
  }

  // Flatten parallel groups and assign group indices.
  // Each top-level entry = one group. { _parallel: [...] } entries share the same group.
  const steps = [];
  let groupIdx = 0;
  // Track how many steps of each type have been generated (for unique step_id suffixes)
  const typeCounts = {};

  for (const entry of normalized) {
    if (entry._parallel) {
      for (const child of entry._parallel) {
        const step = buildStepFromDef(task, runId, child, groupIdx, typeCounts);
        steps.push(step);
      }
    } else {
      const step = buildStepFromDef(task, runId, entry, groupIdx, typeCounts);
      steps.push(step);
    }
    groupIdx++;
  }

  return steps;
}

function buildStepFromDef(task, runId, stepDef, group, typeCounts) {
  const opts = { group };
  if (stepDef.instruction) opts.instruction = stepDef.instruction;
  if (stepDef.skill) opts.skill = stepDef.skill;
  if (stepDef.runtime_hint) opts.runtime_hint = stepDef.runtime_hint;
  else if (task.runtimeHint) opts.runtime_hint = task.runtimeHint;
  if (stepDef.retry_policy) opts.retry_policy = stepDef.retry_policy;
  if (stepDef.revision_target) opts.revision_target = stepDef.revision_target;
  if (stepDef.max_revision_cycles != null) opts.max_revision_cycles = stepDef.max_revision_cycles;

  // Generate unique step_id: for duplicate types, append suffix (e.g. T1:review:1)
  typeCounts[stepDef.type] = (typeCounts[stepDef.type] || 0) + 1;
  if (typeCounts[stepDef.type] > 1) {
    opts.stepIdSuffix = typeCounts[stepDef.type] - 1;
  }

  return stepSchema.createStep(task.id, runId, stepDef.type, opts);
}

// --- Task scheduling helpers ---

function getDependencyDepth(task, allTasks, visited) {
  if (visited.has(task.id)) return 0;
  visited.add(task.id);
  const depends = task.depends || [];
  if (depends.length === 0) return 0;
  let maxDepth = 0;
  for (const depId of depends) {
    const depTask = allTasks.find(t => t.id === depId);
    if (depTask) {
      const depDepth = getDependencyDepth(depTask, allTasks, visited);
      maxDepth = Math.max(maxDepth, depDepth + 1);
    }
  }
  return maxDepth;
}

function pickNextTask(board) {
  const tasks = board.taskPlan?.tasks || [];

  autoUnlockDependents(board);

  const ready = tasks.filter(t => {
    if (t.status !== 'dispatched') return false;
    if (t.dispatch?.state === 'dispatching') return false;
    const isAgent = t.assignee && t.assignee !== 'human' && t.assignee !== 'main';
    return isAgent;
  });

  if (ready.length === 0) return null;

  const depthMap = new Map();
  for (const t of ready) depthMap.set(t.id, getDependencyDepth(t, tasks, new Set()));
  ready.sort((a, b) => depthMap.get(a.id) - depthMap.get(b.id));

  const hints = board.controls?.dispatch_hints || [];
  let picked = ready[0];
  for (const task of ready) {
    const hint = hints.find(h => h.preferAgent && task.assignee === h.preferAgent);
    if (hint) { picked = task; break; }
  }

  return picked;
}

function autoUnlockDependents(board) {
  const { nowIso } = require('../blackboard-server');
  const allTasks = board.taskPlan?.tasks || [];
  const unlocked = [];
  allTasks.forEach(t => {
    if (t.status === 'pending' && t.depends?.length > 0) {
      const allDepsMet = t.depends.every(depId => {
        const dep = allTasks.find(d => d.id === depId);
        if (!dep) return false;
        if (dep.completionTrigger === 'pr_merged') {
          return dep.status === 'approved' && dep.pr?.outcome === 'merged';
        }
        return dep.status === 'approved';
      });
      if (allDepsMet) {
        t.status = 'dispatched';
        t.history = t.history || [];
        t.history.push({ ts: nowIso(), status: 'dispatched', reason: 'dependencies_met' });
        unlocked.push(t.id);
      }
    }
  });
  return unlocked;
}

module.exports = {
  DISPATCH_PLAN_VERSION,
  VALID_DISPATCH_STATES,
  SKILL_ROLE_MAP,
  DEFAULT_CODEX_ROLE,
  AGENT_MODEL_MAP,
  ALLOWED_TASK_TRANSITIONS,
  preferredModelFor,
  validateModelHint,
  budgetPctRemaining,
  resolveCostRoutingModel,
  resolveModelHint,
  canTransitionTaskStatus,
  ensureTaskTransition,
  parseTaskResultFromLastLine,
  readSpecContent,
  gatherUpstreamArtifacts,
  buildTaskDispatchMessage,
  buildRedispatchMessage,
  buildGenericDispatchMessage,
  resolveOwnerId,
  buildDispatchPlan,
  DEFAULT_STEP_PIPELINE,
  BUILT_IN_TEMPLATES,
  normalizePipelineEntry,
  resolvePipeline,
  generateStepsForTask,
  getDependencyDepth,
  pickNextTask,
  autoUnlockDependents,
};
