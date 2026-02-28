const fs = require('fs');
const path = require('path');
const bb = require('./blackboard-server');
const { nowIso, uid } = bb;

const DIR = __dirname;
const SKILLS_DIR = path.join(DIR, 'skills');
const WORKSPACE = path.resolve(DIR, '..', '..', '..');
const PORT = Number(process.env.PORT || 3461);

const DEFAULT_CONTROLS = {
  auto_review: true,
  auto_redispatch: false,
  max_review_attempts: 3,
  quality_threshold: 70,
  review_timeout_sec: 180,
  review_agent: 'engineer_lite',
  auto_apply_insights: true,
  telemetry_enabled: true,
};

// --- Evolution Layer: Schema validation ---
const VALID_ACTION_TYPES = ['controls_patch', 'dispatch_hint', 'lesson_write', 'noop'];
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


function getControls(board) {
  return { ...DEFAULT_CONTROLS, ...(board.controls || {}) };
}

const ALLOWED_TASK_TRANSITIONS = {
  pending: ['dispatched'],
  dispatched: ['in_progress', 'pending'],
  in_progress: ['blocked', 'completed'],
  blocked: ['in_progress'],
  completed: ['reviewing', 'approved', 'needs_revision'],
  reviewing: ['approved', 'needs_revision'],
  needs_revision: ['in_progress', 'approved'],
  approved: [],
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
    results.push(entry);
  }
  return results;
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

  // --- Evolution Layer: Active Lessons ---
  const activeLessons = (board.lessons || [])
    .filter(l => l.status === 'active' || l.status === 'validated');
  if (activeLessons.length > 0) {
    lines.push('');
    lines.push('=== 經驗規則（請遵守）===');
    let charCount = 0;
    for (const l of activeLessons) {
      const line = `- ${l.rule}`;
      if (charCount + line.length > 500) {
        lines.push('  ... (更多規則省略)');
        break;
      }
      lines.push(line);
      charCount += line.length;
    }
    lines.push('=== 規則結束 ===');
  }

  return lines.join('\n');
}

function buildRedispatchMessage(board, task) {
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

  // --- Evolution Layer: Active Lessons ---
  const activeLessons = (board.lessons || [])
    .filter(l => l.status === 'active' || l.status === 'validated');
  if (activeLessons.length > 0) {
    lines.push('');
    lines.push('=== 經驗規則（請遵守）===');
    let charCount = 0;
    for (const l of activeLessons) {
      const line = `- ${l.rule}`;
      if (charCount + line.length > 500) {
        lines.push('  ... (更多規則省略)');
        break;
      }
      lines.push(line);
      charCount += line.length;
    }
    lines.push('=== 規則結束 ===');
  }

  return lines.join('\n');
}

function buildDispatchPlan(board, task, options = {}) {
  const mode = options.mode === 'redispatch' ? 'redispatch' : 'dispatch';
  const message = mode === 'redispatch'
    ? buildRedispatchMessage(board, task)
    : buildTaskDispatchMessage(board, task, { requireTaskResult: options.requireTaskResult || false });

  const controls = getControls(board);

  const runtimeHint = options.runtimeHint
    || board.controls?.preferred_runtime
    || 'openclaw';

  // Skill / Role inference
  const taskSkill = task.skill || null;
  const profile = (taskSkill && SKILL_ROLE_MAP[taskSkill]) || null;

  return {
    kind: 'task_dispatch',
    version: DISPATCH_PLAN_VERSION,
    planId: uid('disp'),
    taskId: task.id,
    mode,
    runtimeHint,
    agentId: task.assignee,
    modelHint: preferredModelFor(task.assignee),
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
      auto_review: controls.auto_review,
      auto_redispatch: controls.auto_redispatch,
      max_review_attempts: controls.max_review_attempts,
    },
  };
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

  // 3. Prefer tasks matching dispatch_hints
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
  allTasks.forEach(t => {
    if (t.status === 'pending' && t.depends?.length > 0) {
      const allDepsApproved = t.depends.every(depId => {
        const dep = allTasks.find(d => d.id === depId);
        return dep && dep.status === 'approved';
      });
      if (allDepsApproved) {
        t.status = 'dispatched';
        t.history = t.history || [];
        t.history.push({ ts: nowIso(), status: 'dispatched', reason: 'dependencies_approved' });
      }
    }
  });
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
  buildTaskDispatchMessage,
  buildRedispatchMessage,
  buildDispatchPlan,
  DISPATCH_PLAN_VERSION,
  VALID_DISPATCH_STATES,
  SKILL_ROLE_MAP,
  DEFAULT_CODEX_ROLE,
  pickNextTask,
  autoUnlockDependents,
};
