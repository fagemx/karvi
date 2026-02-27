# T3: Retro Engine

> Batch 2（T1 完成後，可與 T2、T4 並行）
> 新建檔案：`project/task-engine/retro.js`
> 預估：3-4 小時

---

## 開始前

```bash
# Step 1: 讀契約
cat project/CONTRACT.md
cat project/task-engine/docs/plans/EVOLUTION_LAYER/CONTRACT.md

# Step 2: 讀設計哲學
cat project/task-engine/docs/blackboard-evolution.md

# Step 3: 確認 T1 已完成 — API 可用
curl -s http://localhost:3461/api/signals
curl -s http://localhost:3461/api/insights

# Step 4: 了解現有 board 結構
node -e "console.log(JSON.stringify(Object.keys(require('./project/task-engine/board.json')), null, 2))"

# Step 5: 執行下方步驟
```

---

## 最終結果

- 新檔 `project/task-engine/retro.js` — CLI 工具
- 讀取 board.json 的 signals 和 taskPlan，進行 deterministic 模式分析
- 自動產出 insights（寫入 board.insights via API）
- 追蹤已 applied insights 的效果，結晶為 lessons
- 零外部依賴（只用 Node.js 內建 + blackboard-server）
- `node -c retro.js` 通過
- `node retro.js --dry-run` 可跑

---

## CLI 介面

```bash
node retro.js                  # 完整回顧：分析 signals → 寫 insights + lessons
node retro.js --dry-run        # 預覽模式：只印出會寫什麼，不寫入
node retro.js --signals-only   # 只統計 signals，不生成 insights
node retro.js --board path     # 指定 board 路徑
node retro.js --port 3461      # 指定 server port（用於 API 寫入）
```

---

## 實作步驟

### Step 1: 骨架

**檔案**：`project/task-engine/retro.js`

```js
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

// ... (後續 steps 實作的函數)

async function main() {
  const args = parseArgs();
  const boardPath = args.board || DEFAULT_BOARD;
  const port = args.port || DEFAULT_PORT;
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));

  console.log(`[retro] board: ${boardPath}`);
  console.log(`[retro] signals: ${(board.signals || []).length}`);
  console.log(`[retro] insights: ${(board.insights || []).length}`);
  console.log(`[retro] lessons: ${(board.lessons || []).length}`);

  // Step 2: 統計
  const stats = computeStats(board);
  console.log(`[retro] stats:`, JSON.stringify(stats, null, 2));
  if (args.signalsOnly) return;

  // Step 3: 模式偵測
  const patterns = detectPatterns(board, stats);
  console.log(`[retro] detected ${patterns.length} patterns`);

  // Step 4: 生成 insights
  const newInsights = generateInsights(patterns, board);
  console.log(`[retro] generated ${newInsights.length} new insights`);

  // Step 5: 效果追蹤 → lessons
  const newLessons = trackEffects(board);
  console.log(`[retro] generated ${newLessons.length} new lessons`);

  if (args.dryRun) {
    console.log('\n[retro] DRY RUN — would write:');
    for (const ins of newInsights) console.log('  insight:', ins.judgement);
    for (const les of newLessons) console.log('  lesson:', les.rule);
    return;
  }

  // 寫入
  for (const ins of newInsights) await postToApi(port, '/api/insights', ins);
  for (const les of newLessons) await postToApi(port, '/api/lessons', les);

  console.log(`[retro] done. wrote ${newInsights.length} insights, ${newLessons.length} lessons`);
}

main().catch(err => { console.error('[retro] fatal:', err.message); process.exit(1); });
```

### Step 2: computeStats — 統計 signals

讀取 `board.signals`，計算以下統計：

```js
function computeStats(board) {
  const signals = board.signals || [];
  const reviewSignals = signals.filter(s => s.type === 'review_result');

  // 按 agent 分組的審查結果
  const byAgent = {};
  for (const s of reviewSignals) {
    const agent = s.data?.assignee || 'unknown';
    if (!byAgent[agent]) byAgent[agent] = { total: 0, approved: 0, rejected: 0, scores: [] };
    byAgent[agent].total++;
    if (s.data?.result === 'approved') byAgent[agent].approved++;
    if (s.data?.result === 'needs_revision') byAgent[agent].rejected++;
    if (typeof s.data?.score === 'number') byAgent[agent].scores.push(s.data.score);
  }

  // 按 taskType 分組（如果 signals 帶 taskType）
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

  // 整體統計
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
```

### Step 3: detectPatterns — 模式偵測

**純 deterministic，不用 LLM。** 偵測以下模式：

```js
function detectPatterns(board, stats) {
  const patterns = [];
  const controls = board.controls || {};
  const threshold = controls.quality_threshold || 70;

  // Pattern 1: 某 agent 連續失敗
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

  // Pattern 2: 某 agent 表現特別好
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

  // Pattern 3: 整體 avg score 趨勢（最近 10 筆 vs 之前 10 筆）
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

  // Pattern 4: 高 redispatch 次數
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
```

### Step 4: generateInsights — 從模式生成 insights

```js
function generateInsights(patterns, board) {
  const insights = [];
  const existingInsights = board.insights || [];

  for (const p of patterns) {
    // 避免重複：如果已有同類型、同 agent 的 pending insight，跳過
    const isDuplicate = existingInsights.some(ins =>
      ins.status === 'pending' &&
      ins.data?.patternType === p.type &&
      ins.data?.agent === p.agent
    );
    if (isDuplicate) continue;

    if (p.type === 'agent_underperform') {
      // 找表現最好的 agent 作為替代建議
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
        judgement: `${p.agent} 在最近 3 次審查 avg score ${p.avgScore}，低於 threshold ${p.threshold}`,
        reasoning: `連續 3 次 scores: [${p.recentScores.join(', ')}]` +
          (best ? `。${best[0]} avg score ${best[1]}，表現更好` : ''),
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
        judgement: `${p.taskId} 已 redispatch ${p.attempts} 次，可能 spec 不清楚或任務太複雜`,
        reasoning: `redispatch 超過 3 次通常代表修正方向有誤，不是代碼問題而是理解問題`,
        suggestedAction: { type: 'noop', payload: {} },
        risk: 'medium',
        data: { patternType: p.type, taskId: p.taskId, assignee: p.assignee },
      });
    }

    if (p.type === 'score_improving') {
      insights.push({
        by: 'retro.js',
        about: null,
        judgement: `整體審查分數上升趨勢：avg ${p.avgPrev} → ${p.avgRecent} (+${p.delta})`,
        reasoning: '最近 10 筆 vs 之前 10 筆比較',
        suggestedAction: { type: 'noop', payload: {} },
        risk: 'low',
        data: { patternType: p.type },
      });
    }

    if (p.type === 'score_declining') {
      insights.push({
        by: 'retro.js',
        about: null,
        judgement: `整體審查分數下降趨勢：avg ${p.avgPrev} → ${p.avgRecent} (${p.delta})`,
        reasoning: '最近 10 筆 vs 之前 10 筆比較。可能 threshold 需調整或 spec 品質下降',
        suggestedAction: { type: 'noop', payload: {} },
        risk: 'medium',
        data: { patternType: p.type },
      });
    }
  }

  return insights;
}
```

### Step 5: trackEffects — 追蹤 applied insights 的效果

```js
function trackEffects(board) {
  const lessons = [];
  const appliedInsights = (board.insights || []).filter(ins => ins.status === 'applied');
  const existingLessons = board.lessons || [];

  for (const ins of appliedInsights) {
    // 如果已有這個 insight 產出的 lesson，跳過
    if (existingLessons.some(l => l.fromInsight === ins.id)) continue;

    // 只追蹤有 dispatch_hint 或 controls_patch 的 applied insights
    if (!['dispatch_hint', 'controls_patch'].includes(ins.suggestedAction?.type)) continue;

    // 找 apply 之後的 signals
    const applySignal = (board.signals || []).find(s =>
      s.type === 'insight_applied' && s.data?.insightId === ins.id
    );
    if (!applySignal) continue;

    const applyTime = new Date(applySignal.ts).getTime();
    const laterReviews = (board.signals || []).filter(s =>
      s.type === 'review_result' &&
      new Date(s.ts).getTime() > applyTime
    );

    // 需要至少 3 筆後續 review 才能判斷效果
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
          ? `avg score ${beforeScore} → ${avgLater} (change: ${avgLater - beforeScore > 0 ? '+' : ''}${avgLater - beforeScore})`
          : `avg score after apply: ${avgLater}`,
        status: avgLater >= (board.controls?.quality_threshold || 70) ? 'validated' : 'active',
        validatedAt: avgLater >= (board.controls?.quality_threshold || 70) ? nowIso() : null,
      });
    }
  }

  return lessons;
}
```

### Step 6: postToApi helper

```js
function postToApi(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port,
      path,
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
```

### Step 7: 自檢

```bash
# 語法
node -c retro.js

# dry-run（不需要 server 跑）
node retro.js --dry-run

# 真實跑（需要 server 在 3461）
node retro.js

# 確認 insights 寫入
curl -s http://localhost:3461/api/insights | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log('insights by retro:', d.filter(i=>i.by==='retro.js').length)"
```
