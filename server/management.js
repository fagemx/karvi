const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const bb = require('./blackboard-server');
const { nowIso, uid } = bb;
const stepSchema = require('./step-schema');
const { resolveRepoRoot } = require('./repo-resolver');
const storage = require('./storage');
const { BUDGET_DEFAULTS } = require('./route-engine');

const DIR = __dirname;
const SKILLS_DIR = path.join(DIR, 'skills');
const WORKSPACE = path.resolve(DIR, '..', '..', '..');
const PORT = Number(process.env.PORT || 3461);

const DEFAULT_CONTROLS = {
  auto_dispatch: false,
  auto_review: true,
  auto_redispatch: false,
  max_review_attempts: 3,
  quality_threshold: 70,
  review_timeout_sec: 180,
  review_agent: 'engineer_lite',
  auto_apply_insights: true,
  use_step_pipeline: true,        // DEPRECATED: all dispatch now uses step pipeline (kept for backward compat)
  telemetry_enabled: true,
  usage_limits: null,            // { dispatches_per_month, runtime_sec_per_month, tokens_per_month }
  usage_alert_threshold: 0.8,    // Alert when usage > 80% of limit
  max_concurrent_tasks: 2,       // max in-progress tasks at once (worktree or not)
  max_concurrent_by_type: null,  // { plan: 3, implement: 2, review: 2, test: 1 } or null
  active_wave: null,             // null = all waves, integer = only that wave
  use_worktrees: true,           // create git worktree per task for parallel execution
  target_repo: null,             // absolute path to target repo (null = karvi itself / dogfood mode)
  repo_map: {},                  // GitHub slug → local absolute path, e.g. { "owner/repo": "C:/path/to/repo" }
  auto_merge_on_approve: false,  // when true, auto squash-merge PR after review LGTM
  event_webhook_url: null,       // POST step events to this URL (null = disabled)
  runtime_fallback_chain: null,  // ordered runtime list for fallback on PROVIDER errors, e.g. ["opencode", "codex", "claude"]
  model_map: {},                  // { "opencode": { "plan": "anthropic/claude-opus-4", "default": "anthropic/claude-sonnet-4" }, "codex": { ... } }
  cost_routing: null,             // { tiers: [{ budget_pct_remaining: 50, model_map: { opencode: { default: "provider/model" } } }] }
  step_timeout_sec: {
    plan: 300,
    implement: 600,
    review: 300,
    test: 300,
    execute: 600,   // same as implement — full task execution
    default: 300
  },
  signal_max_count: 500,              // max signals kept in board.json; overflow archived to signal-archive.jsonl
  hooks_after_worktree_create: '',    // shell command run after worktree created
  hooks_before_run: '',               // shell command run before agent starts
  hooks_after_run: '',                // shell command run after agent completes
  budget_per_task: null,              // max cost per task in USD (null = unlimited)
};

// --- Evolution Layer: Schema validation ---
const VALID_ACTION_TYPES = ['controls_patch', 'dispatch_hint', 'lesson_write', 'set_pipeline', 'noop'];
const VALID_RISK_LEVELS = ['low', 'medium', 'high'];
const VALID_LESSON_STATUSES = ['active', 'validated', 'invalidated', 'superseded'];

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

function ensureEvolutionFields(board) {
  if (!Array.isArray(board.signals)) board.signals = [];
  if (!Array.isArray(board.insights)) board.insights = [];
  if (!Array.isArray(board.lessons)) board.lessons = [];
  return board;
}

// --- Signal Retention ---

/**
 * trimSignals — 超過 signal_max_count 的 signals 歸檔到 signal-archive.jsonl，
 * 保留最新的 max 條在 board.signals。
 * @param {object} board - board 物件
 * @param {string} archivePath - signal-archive.jsonl 的絕對路徑
 * @returns {number} 歸檔的 signal 數量
 */
function trimSignals(board, archivePath) {
  const max = getControls(board).signal_max_count;
  if (!board.signals || board.signals.length <= max) return 0;
  const overflow = board.signals.slice(0, -max);
  board.signals = board.signals.slice(-max);
  if (archivePath) {
    for (const sig of overflow) {
      storage.appendLog(archivePath, sig);
    }
  } else {
    console.warn(`[trimSignals] archivePath is falsy — dropping ${overflow.length} overflow signal(s)`);
  }
  return overflow.length;
}

// --- Evolution Layer: Gate Logic ---

function applyInsightAction(board, insight) {
  const action = insight.suggestedAction || {};
  switch (action.type) {
    case 'controls_patch':
      if (!board.controls) board.controls = {};
      Object.assign(board.controls, action.payload || {});
      break;
    case 'dispatch_hint':
      if (!board.controls) board.controls = {};
      if (!Array.isArray(board.controls.dispatch_hints)) board.controls.dispatch_hints = [];
      board.controls.dispatch_hints.push(action.payload);
      break;
    case 'lesson_write':
      board.lessons = board.lessons || [];
      board.lessons.push({
        id: uid('les'),
        ts: nowIso(),
        by: insight.by,
        fromInsight: insight.id,
        rule: action.payload?.rule || insight.judgement,
        effect: null,
        status: 'active',
        validatedAt: null,
        supersededBy: null,
      });
      break;
    case 'set_pipeline': {
      const taskId = action.payload?.taskId || action.payload?.task_id;
      const steps = action.payload?.steps;
      if (!taskId || (!Array.isArray(steps) && typeof steps !== 'string')) break;

      const tasks = board.taskPlan?.tasks || [];
      const task = tasks.find(t => t.id === taskId);
      if (!task) break;

      // Store semantic pipeline on task. Auto-dispatch and step creation will use this.
      task.pipeline = steps;
      task.history = task.history || [];
      task.history.push({
        ts: nowIso(),
        status: task.status || 'pending',
        reason: `pipeline_updated:${insight.id}`,
      });
      break;
    }
    case 'noop':
    default:
      break;
  }
}

function snapshotControls(currentControls, patchPayload) {
  const snapshot = {};
  for (const key of Object.keys(patchPayload || {})) {
    snapshot[key] = currentControls[key] !== undefined ? currentControls[key] : null;
  }
  return snapshot;
}

function autoApplyInsights(board) {
  const controls = getControls(board);
  if (!controls.auto_apply_insights) return;

  ensureEvolutionFields(board);
  const pending = board.insights.filter(i =>
    i.status === 'pending' && i.risk === 'low'
  );
  if (pending.length === 0) return;

  // Safety valve 1: count auto-applies in last 24h
  const now = Date.now();
  const h24 = 24 * 60 * 60 * 1000;
  const recentAutoApplied = board.signals.filter(s =>
    s.type === 'insight_applied' &&
    s.data?.auto === true &&
    (now - new Date(s.ts).getTime()) < h24
  );

  // Safety valve 2: max 3 consecutive auto-applies before human review
  if (recentAutoApplied.length >= 3) {
    console.log('[gate] safety valve: 3 auto-applies in 24h, pausing for human');
    return;
  }

  // Safety valve 3: skip actions matching rolled-back insights
  const rolledBack = board.insights
    .filter(i => i.status === 'rolled_back')
    .map(i => JSON.stringify(i.suggestedAction));

  for (const ins of pending) {
    if (rolledBack.includes(JSON.stringify(ins.suggestedAction))) {
      console.log(`[gate] skip ${ins.id}: same action was rolled back before`);
      continue;
    }

    const sameType = recentAutoApplied.some(s =>
      s.data?.actionType === ins.suggestedAction?.type
    );
    if (sameType) {
      console.log(`[gate] skip ${ins.id}: same action type already applied in 24h`);
      continue;
    }

    // --- Execute apply ---
    console.log(`[gate] auto-applying insight ${ins.id} (risk: low, action: ${ins.suggestedAction?.type})`);

    if (ins.suggestedAction?.type === 'controls_patch') {
      ins.snapshot = snapshotControls(controls, ins.suggestedAction.payload);
    }

    applyInsightAction(board, ins);
    ins.status = 'applied';
    ins.appliedAt = nowIso();

    board.signals.push({
      id: uid('sig'),
      ts: nowIso(),
      by: 'gate',
      type: 'insight_applied',
      content: `Auto-applied: ${ins.judgement}`,
      refs: [ins.id],
      data: {
        insightId: ins.id,
        actionType: ins.suggestedAction?.type,
        auto: true,
        snapshot: ins.snapshot || null,
      },
    });

    break; // apply one at a time
  }
}

function verifyAppliedInsights(board) {
  ensureEvolutionFields(board);
  const applied = board.insights.filter(i =>
    i.status === 'applied' &&
    i.appliedAt
  );

  for (const ins of applied) {
    if (board.lessons.some(l => l.fromInsight === ins.id)) continue;

    const applyTime = new Date(ins.appliedAt).getTime();
    const verifyAfter = ins.verifyAfter || 3;

    const laterReviews = board.signals.filter(s =>
      s.type === 'review_result' &&
      typeof s.data?.score === 'number' &&
      new Date(s.ts).getTime() > applyTime
    );

    if (laterReviews.length < verifyAfter) continue;

    const afterScores = laterReviews.map(s => s.data.score);
    const avgAfter = Math.round(afterScores.reduce((a, b) => a + b, 0) / afterScores.length);

    const beforeReviews = board.signals.filter(s =>
      s.type === 'review_result' &&
      typeof s.data?.score === 'number' &&
      new Date(s.ts).getTime() <= applyTime
    ).slice(-verifyAfter);

    if (beforeReviews.length === 0) continue;

    const beforeScores = beforeReviews.map(s => s.data.score);
    const avgBefore = Math.round(beforeScores.reduce((a, b) => a + b, 0) / beforeScores.length);
    const delta = avgAfter - avgBefore;

    console.log(`[verify] insight ${ins.id}: avg score ${avgBefore} → ${avgAfter} (delta: ${delta > 0 ? '+' : ''}${delta})`);

    if (delta >= 5) {
      // Improvement → crystallize lesson
      console.log(`[verify] improvement confirmed, writing lesson`);

      board.lessons.push({
        id: uid('les'),
        ts: nowIso(),
        by: 'gate',
        fromInsight: ins.id,
        rule: ins.judgement,
        effect: `avg score ${avgBefore} → ${avgAfter} (+${delta})`,
        status: 'validated',
        validatedAt: nowIso(),
        supersededBy: null,
      });

      board.signals.push({
        id: uid('sig'),
        ts: nowIso(),
        by: 'gate',
        type: 'lesson_validated',
        content: `Insight ${ins.id} verified: avg score ${avgBefore} → ${avgAfter}`,
        refs: [ins.id],
        data: { insightId: ins.id, avgBefore, avgAfter, delta },
      });

    } else if (delta <= -5) {
      // Degradation → rollback
      console.log(`[verify] degradation detected, rolling back`);

      if (ins.snapshot) {
        board.controls = board.controls || {};
        for (const [key, val] of Object.entries(ins.snapshot)) {
          if (val === null) {
            delete board.controls[key];
          } else {
            board.controls[key] = val;
          }
        }
      }

      ins.status = 'rolled_back';

      board.signals.push({
        id: uid('sig'),
        ts: nowIso(),
        by: 'gate',
        type: 'insight_rolled_back',
        content: `Rolled back insight ${ins.id}: avg score ${avgBefore} → ${avgAfter} (${delta})`,
        refs: [ins.id],
        data: { insightId: ins.id, avgBefore, avgAfter, delta, restoredControls: ins.snapshot },
      });

    } else {
      // Neutral → wait more; accept after 3x reviews
      if (laterReviews.length >= verifyAfter * 3) {
        console.log(`[verify] neutral after ${laterReviews.length} reviews, accepting as lesson`);
        board.lessons.push({
          id: uid('les'),
          ts: nowIso(),
          by: 'gate',
          fromInsight: ins.id,
          rule: ins.judgement,
          effect: `avg score neutral (${avgBefore} → ${avgAfter})`,
          status: 'active',
          validatedAt: null,
          supersededBy: null,
        });
      }
    }
  }
}

// Preferred model routing map (used in instructions/logging).
// Note: `openclaw agent` CLI currently has no `--model` flag, so direct per-task
// dispatch cannot hard-force model at runtime; bulk sessions_spawn flow should pass
// these model ids explicitly.
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
 * Resolve model hint for a dispatch plan.
 * Priority: model_map[runtime][stepType] > model_map[runtime].default > (openclaw) AGENT_MODEL_MAP > null
 * CLI runtimes (opencode, codex, claude) only get a model if model_map is configured.
 */
/**
 * Validate modelHint format: must be "provider/model" with non-empty parts.
 * Returns { valid, normalized, warning, reason }.
 * null/undefined → valid (no hint). Bad format → invalid with reason.
 * Unknown but well-formatted → valid with warning.
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
 * 回傳 model hint string 或 null。
 */
function resolveCostRoutingModel(runtimeHint, stepType, controls, budget) {
  const costRouting = controls?.cost_routing;
  if (!costRouting?.tiers?.length || !budget) return null;
  const pctRemaining = budgetPctRemaining(budget);
  // 依 budget_pct_remaining 由低到高排序，最嚴格的 tier（最低閾值）優先匹配
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
  // Per-task model override takes highest priority — validate format first
  if (task.modelHint) {
    const v = validateModelHint(task.modelHint);
    if (!v.valid) {
      console.warn(`[resolveModelHint] invalid modelHint for ${task.id}: ${v.reason} — falling through to model_map`);
    } else {
      return v.normalized;
    }
  }
  // Cost-based tier override — budget low → use cheaper model
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
  // CLI runtimes don't understand AGENT_MODEL_MAP IDs — return null unless model_map configured
  if (runtimeHint === 'claude' || runtimeHint === 'opencode' || runtimeHint === 'codex') return null;
  return preferredModelFor(task.assignee);
}

function getControls(board) {
  return { ...DEFAULT_CONTROLS, ...(board.controls || {}) };
}

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
    // Include structured payload from step output (proposal, plan, etc.)
    if (dep.result?.payload) {
      entry.payload = dep.result.payload;
    }
    // Include output reference from last succeeded step
    const lastStep = dep.steps?.filter(s => s.state === 'succeeded').pop();
    if (lastStep?.output_ref) {
      entry.output_ref = lastStep.output_ref;
    }
    results.push(entry);
  }
  return results;
}

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

  // Tier 3: Universal (validated only)
  for (const l of allLessons) {
    if (seen.has(l.id)) continue;
    if (l.status === 'validated') {
      matched.push({ id: l.id, rule: l.rule, relevance: 'universal', status: l.status });
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

// --- Edda Decision Injection (Layer 1 of Agent Protection) ---

let _eddaDecisionCache = { ts: 0, decisions: [] };
const EDDA_DECISION_CACHE_TTL_MS = 60_000;

/**
 * Load architectural decisions from edda ledger.
 * Cached for 60s. Graceful degradation if edda not installed.
 * @returns {Array<{ key: string, value: string, reason: string, ts: string }>}
 */
function loadEddaDecisions() {
  const now = Date.now();
  if (now - _eddaDecisionCache.ts < EDDA_DECISION_CACHE_TTL_MS && _eddaDecisionCache.decisions.length > 0) {
    return _eddaDecisionCache.decisions;
  }

  const eddaCmd = process.env.EDDA_CMD;
  if (!eddaCmd) return _eddaDecisionCache.decisions;

  try {
    const cmd = process.platform === 'win32'
      ? `cmd.exe /d /s /c ${eddaCmd} log --tag decision --json --limit 50`
      : `${eddaCmd} log --tag decision --json --limit 50`;

    const raw = execSync(cmd, {
      encoding: 'utf8',
      timeout: 5000,
      cwd: path.resolve(DIR, '..'),
    }).trim();

    if (!raw) { _eddaDecisionCache = { ts: now, decisions: [] }; return []; }

    const decisions = raw.split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          const evt = JSON.parse(line);
          const d = evt.payload?.decision;
          if (!d?.key) return null;
          return { key: d.key, value: d.value, reason: d.reason, ts: evt.ts };
        } catch { return null; }
      })
      .filter(Boolean);

    _eddaDecisionCache = { ts: now, decisions };
    return decisions;
  } catch {
    return _eddaDecisionCache.decisions;
  }
}

/**
 * Build a "PROTECTED DECISIONS" prompt section from edda decisions.
 * Tells agents which architectural choices must not be reverted.
 * @returns {string[]} lines to inject into dispatch prompt
 */
function buildProtectedDecisionsSection() {
  const decisions = loadEddaDecisions();
  if (decisions.length === 0) return [];

  // Filter to infrastructure/architecture decisions (broadly relevant)
  const relevant = decisions.filter(d =>
    /^(dispatch|runtime|step-worker|kernel|route-engine|management|server)\./.test(d.key)
  );
  if (relevant.length === 0) return [];

  const lines = [];
  lines.push('');
  lines.push('## PROTECTED DECISIONS \u2014 do NOT revert these');
  lines.push('The following architectural decisions were made deliberately. Do not change code that implements them:');
  lines.push('');

  let charCount = 0;
  const MAX_CHARS = 2000;

  for (const d of relevant) {
    const line = `- **${d.key}** = ${d.value} \u2014 ${d.reason}`;
    if (charCount + line.length > MAX_CHARS) {
      lines.push('  ... (more decisions omitted)');
      break;
    }
    lines.push(line);
    charCount += line.length;
  }

  lines.push('');
  lines.push('If you encounter code that seems wrong but implements one of these decisions, LEAVE IT ALONE.');

  return lines;
}

/**
 * Build a "Coding Standards" section by extracting key rules from skill files.
 * Cached per projectRoot so skill files are read only once per target project.
 * @param {string} [projectRoot] — target project root; null = karvi itself
 * @returns {string[]} lines to inject into dispatch prompt
 */
function buildSkillContextSection(projectRoot) {
  if (!buildSkillContextSection._cacheMap) {
    buildSkillContextSection._cacheMap = new Map();
  }
  const cacheKey = projectRoot || '__default__';

  if (!buildSkillContextSection._cacheMap.has(cacheKey)) {
    const excerpts = [];

    // Resolve skill directory: project-specific first, then karvi's server/skills/
    const candidates = [];
    if (projectRoot) {
      candidates.push(path.join(projectRoot, '.claude', 'skills'));
      candidates.push(path.join(projectRoot, 'server', 'skills'));
    }
    candidates.push(path.join(__dirname, 'skills'));
    const skillDir = candidates.find(d => fs.existsSync(d)) || path.join(__dirname, 'skills');

    // Extract coding rules from engineer-playbook
    const epPath = path.join(skillDir, 'engineer-playbook', 'SKILL.md');
    if (fs.existsSync(epPath)) {
      const ep = fs.readFileSync(epPath, 'utf8');
      const match = ep.match(/## (?:Step 4|Code Style|代碼規範|coding|執行任務)[\s\S]*?(?=\n## |\n---)/i);
      if (match) excerpts.push(match[0].trim().slice(0, 600));
    }

    // Extract constraints from blackboard-basics
    const bbPath = path.join(skillDir, 'blackboard-basics', 'SKILL.md');
    if (fs.existsSync(bbPath)) {
      const bb = fs.readFileSync(bbPath, 'utf8');
      const match = bb.match(/## (?:設計約束|Design Constraints|6 大約束)[\s\S]*?(?=\n## |\n---)/i);
      if (match) excerpts.push(match[0].trim().slice(0, 400));
    }

    // Extract from project-principles skill (common across projects)
    const ppPath = path.join(skillDir, 'project-principles', 'SKILL.md');
    if (fs.existsSync(ppPath)) {
      const pp = fs.readFileSync(ppPath, 'utf8');
      const match = pp.match(/## (?:Core Principles|核心原則|Architecture)[\s\S]*?(?=\n## |\n---)/i);
      if (match) excerpts.push(match[0].trim().slice(0, 400));
    }

    if (excerpts.length === 0) {
      if (!projectRoot) {
        excerpts.push(
          '- Zero external dependencies (Node.js built-in modules only)\n' +
          '- Atomic file writes (write to .tmp then rename)\n' +
          '- Windows-compatible: spawn via cmd.exe /d /s /c\n' +
          '- board.json is single source of truth — agents do NOT write board directly\n' +
          '- Follow existing code patterns — do NOT invent new ones\n' +
          '- Run node -c <file> on every modified JavaScript file'
        );
      } else {
        excerpts.push(
          '- Follow existing code patterns — do NOT invent new ones\n' +
          '- Atomic file writes (write to .tmp then rename)\n' +
          '- Run syntax checks on every modified file'
        );
      }
    }
    buildSkillContextSection._cacheMap.set(cacheKey, excerpts);
  }

  const lines = ['', '## Coding Standards (from project skills)'];
  for (const excerpt of buildSkillContextSection._cacheMap.get(cacheKey)) {
    lines.push(excerpt);
  }
  return lines;
}

/**
 * Build a "Completion Criteria" section to prevent agents from declaring done prematurely.
 * @returns {string[]} lines to inject into dispatch prompt
 */
function buildCompletionCriteriaSection() {
  return [
    '',
    '## Completion Criteria',
    'Before declaring done, you MUST verify ALL of the following:',
    '1. Re-read the task description — confirm every bullet/numbered item is addressed',
    '2. List each requirement and its implementation status',
    '3. Run `node -c <file>` on every modified JavaScript file to verify syntax',
    '4. If any requirement was skipped, state why explicitly',
    '5. Commit your changes with a descriptive message before finishing',
  ];
}

function buildTaskDispatchMessage(board, task, options = {}) {
  const lines = [];

  // --- Header ---
  lines.push('【任務派發】');
  lines.push('');

  // --- Required reading ---
  lines.push('必讀（按順序讀完再動手）：');
  lines.push(`1. ${path.join(WORKSPACE, 'project', 'task-engine', 'skills', 'blackboard-basics', 'SKILL.md')}`);
  lines.push(`2. ${path.join(WORKSPACE, 'project', 'task-engine', 'skills', 'engineer-playbook', 'SKILL.md')}`);
  if (board.taskPlan?.spec) {
    lines.push(`3. ${path.join(DIR, board.taskPlan.spec)}`);
  }
  lines.push('');

  // --- Task details ---
  lines.push(`目標：${board.taskPlan?.goal || '(未設定)'}`);
  lines.push(`任務 ID：${task.id}`);
  lines.push(`任務名稱：${task.title}`);
  const preferredModel = preferredModelFor(task.assignee);
  lines.push(`Assignee：${task.assignee}${preferredModel ? `（preferred model: ${preferredModel}）` : ''}`);
  if (task.description) lines.push(`說明：${task.description}`);
  if (task.depends?.length) lines.push(`依賴：${task.depends.join(', ')}（已 approved）`);
  lines.push('');

  // --- Spec content injection ---
  const specContent = readSpecContent(board.taskPlan?.spec);
  if (specContent) {
    lines.push('=== SPEC 內容（完整規格，照此實作）===');
    lines.push(specContent);
    lines.push('=== SPEC 結束 ===');
    lines.push('');
  }

  // --- Upstream artifacts ---
  const upstream = gatherUpstreamArtifacts(board, task);
  if (upstream.length > 0) {
    lines.push('前置任務產出（你的任務建立在這些成果之上）：');
    for (const u of upstream) {
      lines.push(`  ${u.id} (${u.title}) [${u.status}]`);
      if (u.summary) lines.push(`    交付摘要：${u.summary}`);
    }
    lines.push('');
  }

  // --- Reporting API ---
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

  // --- Expected output format ---
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

  // --- Evolution Layer: Dispatch hints ---
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

  // --- Preflight Checklist: Relevant Lessons ---
  const preflight = buildPreflightSection(board, task, options);
  if (preflight.lines.length > 0) {
    lines.push(...preflight.lines);
  }

  // --- Protected Decisions (edda) ---
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

  // Review result
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

  // Inject spec again for context
  const specContent = readSpecContent(board.taskPlan?.spec);
  if (specContent) {
    lines.push('');
    lines.push('=== 原始 SPEC（供參考）===');
    lines.push(specContent);
    lines.push('=== SPEC 結束 ===');
  }

  // --- Preflight Checklist: Relevant Lessons ---
  const preflight = buildPreflightSection(board, task, options);
  if (preflight.lines.length > 0) {
    lines.push(...preflight.lines);
  }

  // --- Protected Decisions (edda) ---
  const protectedDecisions = buildProtectedDecisionsSection();
  if (protectedDecisions.length > 0) {
    lines.push(...protectedDecisions);
  }

  return lines.join('\n');
}

/**
 * Build an English dispatch message for CLI-based runtimes (opencode, claude).
 * These runtimes use models that may not understand Chinese dispatch templates.
 */
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

  // Upstream artifacts
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

  // Coding standards from skill files (resolve from target project if set)
  lines.push(...buildSkillContextSection(resolveRepoRoot(task, board)));

  // Completion criteria — prevent premature "done"
  lines.push(...buildCompletionCriteriaSection());

  // Preflight lessons
  const preflight = buildPreflightSection(board, task, options);
  if (preflight.lines.length > 0) {
    lines.push('');
    lines.push(...preflight.lines);
  }

  // --- Protected Decisions (edda) ---
  const protectedDecisions = buildProtectedDecisionsSection();
  if (protectedDecisions.length > 0) {
    lines.push(...protectedDecisions);
  }

  return lines.join('\n');
}

/**
 * Resolve the owner (human) participant's ID from the board.
 * Used by API-key-based runtimes (e.g. claude-api) to retrieve per-user credentials from vault.
 * @param {object} board - The board object
 * @returns {string} userId (defaults to 'default' if no human participant found)
 */
function resolveOwnerId(board) {
  const humans = (board.participants || []).filter(p => p.type === 'human');
  return humans[0]?.id || 'default';
}

function buildDispatchPlan(board, task, options = {}) {
  const mode = options.mode === 'redispatch' ? 'redispatch' : 'dispatch';

  const controls = getControls(board);

  const runtimeHint = options.runtimeHint
    || board.controls?.preferred_runtime
    || 'openclaw';

  // Compute lesson matching once, pass to message builders
  const lessonResult = matchLessonsForTask(board, task);

  // CLI-based runtimes (opencode, claude, codex) need English prompts
  const usesGenericMessage = runtimeHint === 'opencode' || runtimeHint === 'claude' || runtimeHint === 'codex';

  const message = mode === 'redispatch'
    ? buildRedispatchMessage(board, task, { lessonResult })
    : usesGenericMessage
      ? buildGenericDispatchMessage(board, task, { lessonResult })
      : buildTaskDispatchMessage(board, task, {
          requireTaskResult: options.requireTaskResult || false,
          lessonResult,
        });

  // Runtime selection rationale
  const runtimeRationale = options.runtimeHint
    ? 'caller_specified: ' + options.runtimeHint
    : board.controls?.preferred_runtime
      ? 'board_preferred: ' + board.controls.preferred_runtime
      : 'default: openclaw';

  // Skill / Role inference
  const taskSkill = task.skill || null;
  const profile = (taskSkill && SKILL_ROLE_MAP[taskSkill]) || null;

  // Resolve owner userId for API-key-based runtimes (e.g. claude-api)
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
    // Model selection: model_map[runtime][stepType] > model_map[runtime].default > (openclaw only) AGENT_MODEL_MAP > null
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
    // Preflight metadata
    injectedLessons: lessonResult.ids,
    injectedLessonCount: lessonResult.ids.length,
    runtimeSelection: {
      chosen: runtimeHint,
      rationale: runtimeRationale,
    },
    // Step-level orchestration (null for legacy dispatch, populated by kernel)
    steps: options.steps || null,
    // Git worktree path for parallel execution (set by tryAutoDispatch)
    workingDir: options.workingDir || null,
  };
}

// --- Step-level helpers ---

// Default multi-step pipeline. Tasks can override with ['execute'] for single-step mode.
const DEFAULT_STEP_PIPELINE = [
  'plan',
  'implement',
  { type: 'review', revision_target: 'implement' },
];

// 預建 pipeline 範本，使用者可透過 resolvePipeline 直接引用名稱
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
    // 先查 board 自訂範本，再查內建範本
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
    return DEFAULT_STEP_PIPELINE.map(type => stepSchema.createStep(task.id, runId, type));
  }

  return normalized.map(stepDef => {
    const opts = {};
    if (stepDef.instruction) opts.instruction = stepDef.instruction;
    if (stepDef.skill) opts.skill = stepDef.skill;
    // Per-step runtime_hint > task-level runtimeHint > default
    if (stepDef.runtime_hint) opts.runtime_hint = stepDef.runtime_hint;
    else if (task.runtimeHint) opts.runtime_hint = task.runtimeHint;
    if (stepDef.retry_policy) opts.retry_policy = stepDef.retry_policy;
    if (stepDef.revision_target) opts.revision_target = stepDef.revision_target;
    if (stepDef.max_revision_cycles != null) opts.max_revision_cycles = stepDef.max_revision_cycles;
    return stepSchema.createStep(task.id, runId, stepDef.type, opts);
  });
}

function getDependencyDepth(task, allTasks, visited) {
  if (visited.has(task.id)) return 0; // cycle → treat as root
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

  // 1. Unlock deps first
  autoUnlockDependents(board);

  // 2. Find dispatched tasks not currently running
  const ready = tasks.filter(t => {
    if (t.status !== 'dispatched') return false;
    if (t.dispatch?.state === 'dispatching') return false;
    const isAgent = t.assignee && t.assignee !== 'human' && t.assignee !== 'main';
    return isAgent;
  });

  if (ready.length === 0) return null;

  // 3. Sort by dependency depth (topological order: no-deps first)
  const depthMap = new Map();
  for (const t of ready) depthMap.set(t.id, getDependencyDepth(t, tasks, new Set()));
  ready.sort((a, b) => depthMap.get(a.id) - depthMap.get(b.id));

  // 4. Prefer tasks matching dispatch_hints
  const hints = board.controls?.dispatch_hints || [];
  let picked = ready[0];
  for (const task of ready) {
    const hint = hints.find(h => h.preferAgent && task.assignee === h.preferAgent);
    if (hint) { picked = task; break; }
  }

  return picked;
}

function autoUnlockDependents(board) {
  const allTasks = board.taskPlan?.tasks || [];
  const unlocked = [];
  allTasks.forEach(t => {
    if (t.status === 'pending' && t.depends?.length > 0) {
      const allDepsMet = t.depends.every(depId => {
        const dep = allTasks.find(d => d.id === depId);
        if (!dep) return false;
        // completionTrigger === 'pr_merged' requires PR actually merged
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
  DEFAULT_CONTROLS,
  VALID_ACTION_TYPES,
  VALID_RISK_LEVELS,
  VALID_LESSON_STATUSES,
  AGENT_MODEL_MAP,
  ALLOWED_TASK_TRANSITIONS,
  ensureEvolutionFields,
  applyInsightAction,
  snapshotControls,
  autoApplyInsights,
  verifyAppliedInsights,
  preferredModelFor,
  getControls,
  canTransitionTaskStatus,
  ensureTaskTransition,
  parseTaskResultFromLastLine,
  readSpecContent,
  gatherUpstreamArtifacts,
  matchLessonsForTask,
  buildPreflightSection,
  loadEddaDecisions,
  buildProtectedDecisionsSection,
  buildSkillContextSection,
  buildCompletionCriteriaSection,
  buildTaskDispatchMessage,
  buildRedispatchMessage,
  buildDispatchPlan,
  validateModelHint,
  resolveOwnerId,
  DISPATCH_PLAN_VERSION,
  VALID_DISPATCH_STATES,
  SKILL_ROLE_MAP,
  DEFAULT_CODEX_ROLE,
  pickNextTask,
  autoUnlockDependents,
  resolvePipeline,
  normalizePipelineEntry,
  generateStepsForTask,
  DEFAULT_STEP_PIPELINE,
  BUILT_IN_TEMPLATES,
  trimSignals,
  budgetPctRemaining,
  resolveCostRoutingModel,
};
