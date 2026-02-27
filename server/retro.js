#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = __dirname;
const DEFAULT_BOARD = path.join(DIR, 'board.json');
const DEFAULT_PORT = 3461;

function parseArgs() {
  const args = { dryRun: false, signalsOnly: false, board: null, port: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--signals-only') args.signalsOnly = true;
    else if (argv[i] === '--board' && argv[i + 1]) args.board = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
  }
  return args;
}

function nowIso() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function computeStats(board) {
  const signals = board.signals || [];
  const reviewSignals = signals.filter(s => s.type === 'review_result');

  const byAgent = {};
  for (const s of reviewSignals) {
    const agent = s.data?.assignee || 'unknown';
    if (!byAgent[agent]) byAgent[agent] = { total: 0, approved: 0, rejected: 0, scores: [] };
    byAgent[agent].total++;
    if (s.data?.result === 'approved') byAgent[agent].approved++;
    if (s.data?.result === 'needs_revision') byAgent[agent].rejected++;
    if (typeof s.data?.score === 'number') byAgent[agent].scores.push(s.data.score);
  }

  const byTaskType = {};
  for (const s of reviewSignals) {
    const taskId = s.data?.taskId || '';
    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    const taskType = task?.type || task?.track || 'unknown';
    if (!byTaskType[taskType]) byTaskType[taskType] = { total: 0, approved: 0, scores: [] };
    byTaskType[taskType].total++;
    if (s.data?.result === 'approved') byTaskType[taskType].approved++;
    if (typeof s.data?.score === 'number') byTaskType[taskType].scores.push(s.data.score);
  }

  const allScores = reviewSignals.map(s => s.data?.score).filter(s => typeof s === 'number');
  const avgScore = allScores.length ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : null;

  return {
    totalSignals: signals.length,
    totalReviews: reviewSignals.length,
    avgScore,
    byAgent,
    byTaskType,
  };
}

function detectPatterns(board, stats) {
  const patterns = [];
  const controls = board.controls || {};
  const threshold = controls.quality_threshold || 70;

  // Pattern 1: Agent consecutive failures
  for (const [agent, data] of Object.entries(stats.byAgent)) {
    if (data.scores.length >= 3) {
      const recent3 = data.scores.slice(-3);
      const allBelow = recent3.every(s => s < threshold);
      if (allBelow) {
        const avgRecent = Math.round(recent3.reduce((a, b) => a + b, 0) / 3);
        patterns.push({
          type: 'agent_underperform',
          agent,
          avgScore: avgRecent,
          threshold,
          recentScores: recent3,
        });
      }
    }
  }

  // Pattern 2: Agent excels
  for (const [agent, data] of Object.entries(stats.byAgent)) {
    if (data.scores.length >= 3) {
      const avg = Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length);
      if (avg >= threshold + 15 && data.approved / data.total >= 0.8) {
        patterns.push({
          type: 'agent_excels',
          agent,
          avgScore: avg,
          approvalRate: Math.round(data.approved / data.total * 100),
        });
      }
    }
  }

  // Pattern 3: Score trend (recent 10 vs previous 10)
  const allScores = (board.signals || [])
    .filter(s => s.type === 'review_result' && typeof s.data?.score === 'number')
    .map(s => s.data.score);
  if (allScores.length >= 20) {
    const recent10 = allScores.slice(-10);
    const prev10 = allScores.slice(-20, -10);
    const avgRecent = Math.round(recent10.reduce((a, b) => a + b, 0) / 10);
    const avgPrev = Math.round(prev10.reduce((a, b) => a + b, 0) / 10);
    if (avgRecent > avgPrev + 5) {
      patterns.push({ type: 'score_improving', avgRecent, avgPrev, delta: avgRecent - avgPrev });
    } else if (avgRecent < avgPrev - 5) {
      patterns.push({ type: 'score_declining', avgRecent, avgPrev, delta: avgRecent - avgPrev });
    }
  }

  // Pattern 4: High redispatch count
  const tasks = board.taskPlan?.tasks || [];
  for (const t of tasks) {
    if ((t.reviewAttempts || 0) >= 3) {
      patterns.push({
        type: 'high_redispatch',
        taskId: t.id,
        attempts: t.reviewAttempts,
        assignee: t.assignee,
      });
    }
  }

  return patterns;
}

function generateInsights(patterns, board) {
  const insights = [];
  const existingInsights = board.insights || [];

  for (const p of patterns) {
    const isDuplicate = existingInsights.some(ins =>
      ins.status === 'pending' &&
      ins.data?.patternType === p.type &&
      ins.data?.agent === p.agent
    );
    if (isDuplicate) continue;

    if (p.type === 'agent_underperform') {
      const allAgents = Object.entries(
        (board.signals || [])
          .filter(s => s.type === 'review_result' && typeof s.data?.score === 'number')
          .reduce((acc, s) => {
            const a = s.data.assignee || 'unknown';
            if (!acc[a]) acc[a] = [];
            acc[a].push(s.data.score);
            return acc;
          }, {})
      );
      const best = allAgents
        .filter(([a]) => a !== p.agent)
        .map(([a, scores]) => [a, Math.round(scores.reduce((x, y) => x + y, 0) / scores.length)])
        .sort((a, b) => b[1] - a[1])[0];

      insights.push({
        by: 'retro.js',
        about: null,
        judgement: `${p.agent} avg score ${p.avgScore} in last 3 reviews, below threshold ${p.threshold}`,
        reasoning: `Consecutive 3 scores: [${p.recentScores.join(', ')}]` +
          (best ? `. ${best[0]} avg score ${best[1]}, performs better` : ''),
        suggestedAction: best
          ? { type: 'dispatch_hint', payload: { preferAgent: best[0], reason: `avg score ${best[1]} vs ${p.avgScore}` } }
          : { type: 'noop', payload: {} },
        risk: 'low',
        data: { patternType: p.type, agent: p.agent },
      });
    }

    if (p.type === 'high_redispatch') {
      insights.push({
        by: 'retro.js',
        about: null,
        judgement: `${p.taskId} redispatched ${p.attempts} times, possible unclear spec or task too complex`,
        reasoning: `Redispatch >= 3 usually indicates wrong correction direction, not a code issue but a comprehension issue`,
        suggestedAction: { type: 'noop', payload: {} },
        risk: 'medium',
        data: { patternType: p.type, taskId: p.taskId, assignee: p.assignee },
      });
    }

    if (p.type === 'score_improving') {
      insights.push({
        by: 'retro.js',
        about: null,
        judgement: `Overall review score uptrend: avg ${p.avgPrev} -> ${p.avgRecent} (+${p.delta})`,
        reasoning: 'Last 10 vs previous 10 comparison',
        suggestedAction: { type: 'noop', payload: {} },
        risk: 'low',
        data: { patternType: p.type },
      });
    }

    if (p.type === 'score_declining') {
      insights.push({
        by: 'retro.js',
        about: null,
        judgement: `Overall review score downtrend: avg ${p.avgPrev} -> ${p.avgRecent} (${p.delta})`,
        reasoning: 'Last 10 vs previous 10 comparison. Threshold may need adjustment or spec quality declining',
        suggestedAction: { type: 'noop', payload: {} },
        risk: 'medium',
        data: { patternType: p.type },
      });
    }
  }

  return insights;
}

function trackEffects(board) {
  const lessons = [];
  const appliedInsights = (board.insights || []).filter(ins => ins.status === 'applied');
  const existingLessons = board.lessons || [];

  for (const ins of appliedInsights) {
    if (existingLessons.some(l => l.fromInsight === ins.id)) continue;
    if (!['dispatch_hint', 'controls_patch'].includes(ins.suggestedAction?.type)) continue;

    const applySignal = (board.signals || []).find(s =>
      s.type === 'insight_applied' && s.data?.insightId === ins.id
    );
    if (!applySignal) continue;

    const applyTime = new Date(applySignal.ts).getTime();
    const laterReviews = (board.signals || []).filter(s =>
      s.type === 'review_result' &&
      new Date(s.ts).getTime() > applyTime
    );

    if (laterReviews.length < 3) continue;

    const laterScores = laterReviews
      .map(s => s.data?.score)
      .filter(s => typeof s === 'number');
    const avgLater = laterScores.length
      ? Math.round(laterScores.reduce((a, b) => a + b, 0) / laterScores.length)
      : null;

    if (avgLater !== null) {
      const beforeScore = ins.data?.agent
        ? (() => {
            const beforeReviews = (board.signals || []).filter(s =>
              s.type === 'review_result' &&
              s.data?.assignee === ins.data.agent &&
              new Date(s.ts).getTime() < applyTime
            );
            const scores = beforeReviews.map(s => s.data?.score).filter(s => typeof s === 'number');
            return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
          })()
        : null;

      lessons.push({
        by: 'retro.js',
        fromInsight: ins.id,
        rule: ins.judgement,
        effect: beforeScore !== null
          ? `avg score ${beforeScore} -> ${avgLater} (change: ${avgLater - beforeScore > 0 ? '+' : ''}${avgLater - beforeScore})`
          : `avg score after apply: ${avgLater}`,
        status: avgLater >= (board.controls?.quality_threshold || 70) ? 'validated' : 'active',
        validatedAt: avgLater >= (board.controls?.quality_threshold || 70) ? nowIso() : null,
      });
    }
  }

  return lessons;
}

function postToApi(port, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port,
      path: apiPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const args = parseArgs();
  const boardPath = args.board || DEFAULT_BOARD;
  const port = args.port || DEFAULT_PORT;

  if (!fs.existsSync(boardPath)) {
    console.error(`[retro] Board not found: ${boardPath}`);
    console.error('[retro] Start the server first: npm start');
    process.exit(1);
  }

  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));

  console.log(`[retro] board: ${boardPath}`);
  console.log(`[retro] signals: ${(board.signals || []).length}`);
  console.log(`[retro] insights: ${(board.insights || []).length}`);
  console.log(`[retro] lessons: ${(board.lessons || []).length}`);

  // Stats
  const stats = computeStats(board);
  console.log(`[retro] stats:`, JSON.stringify(stats, null, 2));
  if (args.signalsOnly) return;

  // Pattern detection
  const patterns = detectPatterns(board, stats);
  console.log(`[retro] detected ${patterns.length} patterns`);

  // Generate insights
  const newInsights = generateInsights(patterns, board);
  console.log(`[retro] generated ${newInsights.length} new insights`);

  // Track effects -> lessons
  const newLessons = trackEffects(board);
  console.log(`[retro] generated ${newLessons.length} new lessons`);

  if (args.dryRun) {
    console.log('\n[retro] DRY RUN -- would write:');
    for (const ins of newInsights) console.log('  insight:', ins.judgement);
    for (const les of newLessons) console.log('  lesson:', les.rule);
    return;
  }

  // Write to API
  for (const ins of newInsights) await postToApi(port, '/api/insights', ins);
  for (const les of newLessons) await postToApi(port, '/api/lessons', les);

  console.log(`[retro] done. wrote ${newInsights.length} insights, ${newLessons.length} lessons`);
}

main().catch(err => { console.error('[retro] fatal:', err.message); process.exit(1); });
