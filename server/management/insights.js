/**
 * management/insights.js — Insight 相關邏輯
 *
 * applyInsightAction, snapshotControls, autoApplyInsights, verifyAppliedInsights
 */
const bb = require('../blackboard-server');
const { nowIso, uid } = bb;

// Schema validation constants (shared with parent)
const VALID_ACTION_TYPES = ['controls_patch', 'dispatch_hint', 'lesson_write', 'set_pipeline', 'noop'];
const VALID_RISK_LEVELS = ['low', 'medium', 'high'];

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
  // Lazy require to avoid circular — getControls / ensureEvolutionFields live in parent
  const { getControls, ensureEvolutionFields } = require('../management');
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
  const { ensureEvolutionFields } = require('../management');
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

module.exports = {
  VALID_ACTION_TYPES,
  VALID_RISK_LEVELS,
  applyInsightAction,
  snapshotControls,
  autoApplyInsights,
  verifyAppliedInsights,
};
