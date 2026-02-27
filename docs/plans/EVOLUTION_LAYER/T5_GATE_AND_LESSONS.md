# T5: Gate Logic + Auto-Rollback + Lesson Injection

> Batch 3（T1 + T3 完成後）
> 改動檔案：`project/task-engine/server.js`
> 預估：3 小時

---

## 開始前

```bash
# Step 1: 讀契約（特別注意安全閥和自動改善完整流程）
cat project/CONTRACT.md
cat project/task-engine/docs/plans/EVOLUTION_LAYER/CONTRACT.md

# Step 2: 確認 T1 已完成
curl -s http://localhost:3461/api/insights | node -e "console.log('insights API OK')"
curl -s http://localhost:3461/api/lessons | node -e "console.log('lessons API OK')"

# Step 3: 確認 T3 retro.js 存在
node -c project/task-engine/retro.js

# Step 4: 讀 server.js 的 buildTaskDispatchMessage 和 POST /api/insights/:id/apply
# 理解現有結構

# Step 5: 執行下方步驟
```

---

## 最終結果

- gate **預設開啟**：low-risk insight 自動 apply，不等人
- apply 前自動快照 controls → 回滾有依據
- apply 後自動驗證效果（等 N 筆 review signal）
- 效果好 → 結晶 lesson (validated)
- 效果差 → 自動回滾 controls + insight 標記 rolled_back
- `buildTaskDispatchMessage` 注入 active lessons（<= 500 字元）
- `buildRedispatchMessage` 也注入 lessons
- UI 有 auto_apply_insights 開關（預設 on）
- `node -c server.js` 通過

---

## 核心設計：觀察 → 行動 → 驗證 → 保留或回滾

```
insight 進來 (risk: low)
  │
  ▼
Gate: 快照 → Apply → 記錄
  │
  ▼
系統用新 controls 跑任務
  │
  ▼ (累積 3 筆 review signal)
  │
  ▼
驗證：比較 apply 前後 avg score
  │
  ├── 改善 (+5↑) → lesson (validated) ✅
  ├── 持平 (±5)  → 繼續觀察
  └── 惡化 (-5↓) → 回滾 controls + rolled_back ❌
```

**人不需要按任何按鈕。** 系統自己改、自己驗、不好自己退。

---

## 實作步驟

### Step 1: 新增 controls 欄位

**位置**：`server.js` 的 `DEFAULT_CONTROLS`

```js
auto_apply_insights: true,
```

**注意：預設 true，不是 false。** 這是改善真正發生的前提。

### Step 2: applyInsightAction — 抽出 apply 核心邏輯

讓 `POST /api/insights/:id/apply`（手動）和 gate（自動）共用。

```js
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
      });
      break;
    case 'noop':
    default:
      break;
  }
}
```

### Step 3: snapshotControls — 快照被修改的 keys

```js
function snapshotControls(currentControls, patchPayload) {
  const snapshot = {};
  for (const key of Object.keys(patchPayload || {})) {
    snapshot[key] = currentControls[key] !== undefined ? currentControls[key] : null;
  }
  return snapshot;
}
```

### Step 4: autoApplyInsights — Gate 主邏輯

```js
function autoApplyInsights(board) {
  const controls = getControls(board);
  if (!controls.auto_apply_insights) return;

  const pending = (board.insights || []).filter(i =>
    i.status === 'pending' && i.risk === 'low'
  );
  if (pending.length === 0) return;

  // 安全閥 1: 最近 24h 內自動 apply 次數
  const now = Date.now();
  const h24 = 24 * 60 * 60 * 1000;
  const recentAutoApplied = (board.signals || []).filter(s =>
    s.type === 'insight_applied' &&
    s.data?.auto === true &&
    (now - new Date(s.ts).getTime()) < h24
  );

  // 安全閥 2: 連續 3 次自動後強制等人
  if (recentAutoApplied.length >= 3) {
    console.log('[gate] safety valve: 3 auto-applies in 24h, pausing for human');
    return;
  }

  // 安全閥 3: 不重複 apply 已 rolled_back 的同類 action
  const rolledBack = (board.insights || [])
    .filter(i => i.status === 'rolled_back')
    .map(i => JSON.stringify(i.suggestedAction));

  for (const ins of pending) {
    // 跳過跟已回滾 insight 相同的 action
    if (rolledBack.includes(JSON.stringify(ins.suggestedAction))) {
      console.log(`[gate] skip ${ins.id}: same action was rolled back before`);
      continue;
    }

    // 同 actionType 24h 限 1 次
    const sameType = recentAutoApplied.some(s =>
      s.data?.actionType === ins.suggestedAction?.type
    );
    if (sameType) {
      console.log(`[gate] skip ${ins.id}: same action type already applied in 24h`);
      continue;
    }

    // --- 執行 apply ---
    console.log(`[gate] auto-applying insight ${ins.id} (risk: low, action: ${ins.suggestedAction?.type})`);

    // 快照（controls_patch 才需要）
    if (ins.suggestedAction?.type === 'controls_patch') {
      ins.snapshot = snapshotControls(controls, ins.suggestedAction.payload);
    }

    applyInsightAction(board, ins);
    ins.status = 'applied';
    ins.appliedAt = nowIso();

    // 記錄 signal
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

    break; // 每次只 apply 一個
  }
}
```

### Step 5: verifyAppliedInsights — 效果驗證 + 自動回滾

```js
function verifyAppliedInsights(board) {
  const applied = (board.insights || []).filter(i =>
    i.status === 'applied' &&
    i.appliedAt &&
    i.suggestedAction?.type === 'controls_patch' &&
    i.snapshot
  );

  for (const ins of applied) {
    const applyTime = new Date(ins.appliedAt).getTime();
    const verifyAfter = ins.verifyAfter || 3;

    // 找 apply 之後的 review signals
    const laterReviews = (board.signals || []).filter(s =>
      s.type === 'review_result' &&
      typeof s.data?.score === 'number' &&
      new Date(s.ts).getTime() > applyTime
    );

    if (laterReviews.length < verifyAfter) continue; // 還不夠，繼續等

    // 計算 apply 後的 avg score
    const afterScores = laterReviews.map(s => s.data.score);
    const avgAfter = Math.round(afterScores.reduce((a, b) => a + b, 0) / afterScores.length);

    // 計算 apply 前的 avg score（取 apply 前最後 verifyAfter 筆）
    const beforeReviews = (board.signals || []).filter(s =>
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
      // 改善 → 結晶 lesson
      console.log(`[verify] ✅ improvement confirmed, writing lesson`);
      ins.status = 'applied'; // 保持 applied

      board.lessons = board.lessons || [];
      board.lessons.push({
        id: uid('les'),
        ts: nowIso(),
        by: 'gate',
        fromInsight: ins.id,
        rule: ins.judgement,
        effect: `avg score ${avgBefore} → ${avgAfter} (+${delta})`,
        status: 'validated',
        validatedAt: nowIso(),
      });

      board.signals.push({
        id: uid('sig'),
        ts: nowIso(),
        by: 'gate',
        type: 'lesson_validated',
        content: `Insight ${ins.id} 驗證通過：avg score ${avgBefore} → ${avgAfter}`,
        refs: [ins.id],
        data: { insightId: ins.id, avgBefore, avgAfter, delta },
      });

    } else if (delta <= -5) {
      // 惡化 → 回滾
      console.log(`[verify] ❌ degradation detected, rolling back`);

      // 還原 controls
      if (ins.snapshot) {
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
        content: `Rolled back insight ${ins.id}：avg score ${avgBefore} → ${avgAfter} (${delta})`,
        refs: [ins.id],
        data: { insightId: ins.id, avgBefore, avgAfter, delta, restoredControls: ins.snapshot },
      });

    } else {
      // 持平 → 不動作，等更多資料
      // 但如果已等超過 verifyAfter * 3 筆 review 仍持平，接受為 lesson
      if (laterReviews.length >= verifyAfter * 3) {
        console.log(`[verify] ≈ neutral after ${laterReviews.length} reviews, accepting as lesson`);
        board.lessons = board.lessons || [];
        board.lessons.push({
          id: uid('les'),
          ts: nowIso(),
          by: 'gate',
          fromInsight: ins.id,
          rule: ins.judgement,
          effect: `avg score 持平 (${avgBefore} → ${avgAfter})，無害`,
          status: 'active',
        });
      }
    }
  }
}
```

### Step 6: 驗證觸發時機

`verifyAppliedInsights(board)` 在以下時機呼叫：

1. **每次 review signal 寫入時**（`POST /api/signals` 且 type === 'review_result'）
2. **retro.js 跑時**（retro.js 可以在最後呼叫 `POST /api/verify`，或由 server 在收到 signal 時自動觸發）

最簡單的方式：在 `POST /api/signals` handler 裡，如果 signal.type === 'review_result'，就順便跑 `verifyAppliedInsights(board)`。

```js
// 在 POST /api/signals handler 裡，push signal 之後：
if (body.type === 'review_result') {
  verifyAppliedInsights(board);
}
autoApplyInsights(board);
writeBoard(board);
```

### Step 7: Lesson 注入到 dispatch

**位置**：`buildTaskDispatchMessage` 函數尾部（在 `return lines.join('\n')` 之前）

```js
// --- Active Lessons ---
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
```

**同樣的注入也加到 `buildRedispatchMessage`**，位置在 spec 注入之後。

### Step 8: dispatch_hints 消費

在 `buildTaskDispatchMessage` 中，如果 `board.controls.dispatch_hints` 有匹配當前 task 的 hint：

```js
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
```

### Step 9: UI — 新增 auto_apply_insights 控制

在 index.html 的 Review Controls 面板新增 checkbox：

```
☑ 低風險 insight 自動改善 (auto_apply_insights)
```

沿用現有 `auto_review` 和 `auto_redispatch` checkbox 的模式。
**注意**：預設勾選（因為 DEFAULT_CONTROLS 是 true）。

### Step 10: 自檢

```bash
# 語法
node -c server.js

# 確認預設開啟
node -e "const s=require('fs').readFileSync('project/task-engine/server.js','utf8');const m=s.match(/auto_apply_insights:\s*(true|false)/);console.log('default:', m && m[1])"
# 預期：default: true

# 測試完整流程
# 1. 寫 3 筆低分 signals（模擬 apply 前的基準）
for i in 1 2 3; do
  curl -s -X POST http://localhost:3461/api/signals \
    -H "Content-Type: application/json" \
    -d "{\"by\":\"test\",\"type\":\"review_result\",\"content\":\"before\",\"data\":{\"score\":45,\"assignee\":\"engineer_lite\",\"result\":\"needs_revision\"}}"
done

# 2. POST 一個 low-risk insight（應該自動 apply）
curl -s -X POST http://localhost:3461/api/insights \
  -H "Content-Type: application/json" \
  -d '{"by":"retro.js","judgement":"threshold 應提高到 80","suggestedAction":{"type":"controls_patch","payload":{"quality_threshold":80}},"risk":"low"}'

# 3. 確認自動 applied + 有 snapshot
curl -s http://localhost:3461/api/insights | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const applied=d.find(i=>i.status==='applied' && i.snapshot);
  console.log('applied:', !!applied, 'snapshot:', applied?.snapshot);
"

# 4. 寫 3 筆改善後的 signals（觸發驗證）
for i in 1 2 3; do
  curl -s -X POST http://localhost:3461/api/signals \
    -H "Content-Type: application/json" \
    -d "{\"by\":\"test\",\"type\":\"review_result\",\"content\":\"after\",\"data\":{\"score\":82,\"assignee\":\"engineer_pro\",\"result\":\"approved\"}}"
done

# 5. 確認 lesson 被寫入（驗證成功）
curl -s http://localhost:3461/api/lessons | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const validated=d.filter(l=>l.status==='validated');
  console.log('validated lessons:', validated.length);
  validated.forEach(l=>console.log('  -', l.rule, '|', l.effect));
"

# 測試回滾：寫 3 筆惡化的 signals
# （先 apply 一個新 insight，然後寫低分 signals，確認自動回滾）
```
