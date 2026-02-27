# Evolution Loop（自我進化迴路）

> 狀態：已被 `blackboard-evolution.md` 取代
> 日期：2026-02-25
> ⚠️ 本文件的管線式設計已重新設計為黑板式進化，詳見 **blackboard-evolution.md**
> 以下內容保留作為歷史參考，retro.js 可繼續使用本文件的 Observe→Analyze→Propose 作為「行為模式」，但不再是系統級架構

---

## 核心問題

「學習」跟「重複」的差別是什麼？

- **重複**：每次都用同樣的方式做，不管上次的結果
- **學習**：根據上次的結果，改變這次的做法

Task Engine 目前是在「重複」。它能執行任務、審查、修正，但下一批任務的做法跟上一批完全一樣。即使某個 agent 連續失敗 10 次，系統也不會自動換 agent。

**進化迴路的目標**：讓系統能改變自己的行為。

---

## 可變物（Mutable Surface）

系統能改變的東西，按影響範圍排序：

```
影響範圍：小 ──────────────────────── 大

Controls          Prompt 模板         Skill 文件        架構
(quality_threshold, (dispatch message   (engineer-playbook, (新元件,
 review_agent,      結構和措辭)         review-checklist)   新 app)
 auto_redispatch)
     │                  │                  │                │
     │                  │                  │                │
   低風險             低-中風險           中風險            高風險
   auto-apply         auto-apply?        建 task           等 Human
```

### 具體可變物清單

| 可變物 | 改什麼 | 風險 | 例子 |
|--------|--------|------|------|
| `quality_threshold` | 審查通過標準 | 低 | 70 → 60 |
| `review_agent` | 審查用的模型 | 低 | engineer_lite → engineer_pro |
| `auto_redispatch` | 是否自動修正 | 低 | false → true |
| `max_review_attempts` | 審查次數上限 | 低 | 3 → 5 |
| 預設 assignee 映射 | 任務類型 → agent | 低 | server → engineer_pro |
| dispatch message 結構 | 派發訊息內容 | 中 | 加入新的 context 段落 |
| review prompt | 審查提示詞 | 中 | 修改打分標準 |
| engineer-playbook | 工程師行為規範 | 中 | 加新規則 |
| review-checklist | 審查項目 | 中 | 加新 deterministic check |
| blackboard-basics | 基礎架構說明 | 中 | 更新 API 文件 |
| process-review.js | 審查邏輯 | 高 | 改 fallback 策略 |
| server.js | 主調度邏輯 | 高 | 改狀態機 |
| 新的原子腳本 | 新能力 | 高 | 加 retro.js |

---

## 進化迴路詳細設計

```
┌────────────────────────────────────────────────────────┐
│                                                        │
│  ┌──────┐    ┌─────────┐    ┌──────────┐    ┌───────┐  │
│  │Observe│──→│ Analyze  │──→│ Propose  │──→│ Gate   │  │
│  │觀察   │    │ 分析     │    │ 提案     │    │ 閘門   │  │
│  └──────┘    └─────────┘    └──────────┘    └───┬───┘  │
│       ↑                                         │      │
│       │         ┌──────────┐    ┌─────────┐     │      │
│       └─────────│ Evaluate │←───│ Mutate  │←────┘      │
│                 │ 評估     │    │ 突變     │            │
│                 └──────────┘    └─────────┘            │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 1. Observe（觀察）

**輸入**：task-log.jsonl + board.json history
**方法**：retro.js 讀取原始事件數據
**輸出**：metrics（結構化數據）

觀察什麼：
- 每個 agent 在每種任務類型的 review score
- 每種 review failure 的原因分布
- blocked 的原因分布
- 完成時間分布
- redispatch 成功率
- Human 手動介入率

### 2. Analyze（分析）

**輸入**：metrics
**方法**：規則匹配 + 閾值偵測
**輸出**：insights（結構化洞察）

分析邏輯（deterministic，不需要 LLM）：

```javascript
// 例：偵測 agent-任務類型不匹配
for (const [agent, data] of Object.entries(metrics.agents)) {
  for (const [taskType, perf] of Object.entries(data.byTaskType || {})) {
    if (perf.avgScore < controls.quality_threshold && perf.count >= 2) {
      insights.push({
        type: 'agent_mismatch',
        agent, taskType,
        avgScore: perf.avgScore,
        threshold: controls.quality_threshold,
        count: perf.count,
      });
    }
  }
}

// 例：偵測 threshold 過高
if (metrics.health.manualOverrideRate > 0.3) {
  insights.push({
    type: 'threshold_too_high',
    overrideRate: metrics.health.manualOverrideRate,
    currentThreshold: controls.quality_threshold,
  });
}

// 例：偵測 review parser 問題
if (metrics.review.llmParseSuccessRate < 0.6) {
  insights.push({
    type: 'review_parser_unreliable',
    successRate: metrics.review.llmParseSuccessRate,
  });
}
```

**關鍵**：分析是 deterministic 的。不用 LLM 做判斷。規則可以增加，但每條規則的邏輯是確定性的。

### 3. Propose（提案）

**輸入**：insights
**方法**：insight → proposal 映射表
**輸出**：proposals[]

映射表：

| Insight Type | Proposal Type | Risk | Action |
|---|---|---|---|
| `agent_mismatch` | `assignee_change` | low | 改預設 assignee 映射 |
| `threshold_too_high` | `threshold_adjust` | low | 降低 quality_threshold |
| `threshold_too_low` | `threshold_adjust` | low | 提高 quality_threshold |
| `review_parser_unreliable` | `review_config` | medium | 換 review_agent 或改 prompt |
| `recurring_block_reason` | `skill_update` | medium | 更新 engineer-playbook |
| `redispatch_always_fails` | `review_config` | medium | 關閉 auto_redispatch |
| `task_type_needs_spec` | `spec_improvement` | medium | 要求 Lead 補充 spec |
| `system_bottleneck` | `architecture_change` | high | 等 Human 評估 |

### 4. Gate（閘門）

**輸入**：proposals[]
**方法**：風險分級 + 自動化策略
**輸出**：approved / pending / rejected

```
if proposal.risk === 'low' && controls.auto_apply_proposals:
  → auto-approve → 直接進入 Mutate
  
if proposal.risk === 'medium':
  → pending → 等 Nox 或 Human 審核
  
if proposal.risk === 'high':
  → pending → 必須等 Human
```

auto-apply 有額外安全閥：
- 同類型 proposal 24 小時內最多 auto-apply 1 次
- 連續 3 次 auto-apply 後強制等 Human 確認
- auto-apply 的結果必須被 Evaluate 追蹤

### 5. Mutate（突變）

**輸入**：approved proposal
**方法**：根據 action.type 執行

| action.type | 做什麼 | 怎麼做 |
|---|---|---|
| `controls_patch` | 改 board.json controls | 直接 JSON merge |
| `assignee_map_update` | 改預設 assignee 映射 | 寫入 board.json 新區塊 |
| `task_create` | 建任務讓 agent 修改檔案 | 寫入 taskPlan.tasks[] |
| `info_only` | 只記錄 | 不執行任何動作 |

### 6. Evaluate（評估）

**輸入**：已執行的 proposal + 後續的 metrics
**方法**：比較 baseline vs actual
**輸出**：proposal.effect 更新

```json
{
  "effect": {
    "tracked": true,
    "metric": "agents.engineer_pro.avgScore",
    "baseline": 42,
    "target": 78,
    "actual": 81,
    "verdict": "effective",
    "evaluatedAt": "2026-03-01T..."
  }
}
```

**verdict**：
- `effective`：actual >= target → 強化這條規則
- `neutral`：actual 在 baseline ± 10% → 標記觀察
- `ineffective`：actual < baseline → 回滾 + 生成新 proposal
- `pending`：還沒有足夠數據

---

## 進化的邊界（不可變物）

有些東西系統不應該改變自己：

| 不可變物 | 為什麼 |
|----------|--------|
| 黑板架構本身 | 基座不能自我修改 |
| CONTRACT.md | 合約是人類定的 |
| 零外部依賴約束 | 核心設計原則 |
| Human 介入點 | 安全閥不能被繞過 |
| 風險分級規則 | 閘門不能自我放寬 |
| Transition guard | 狀態機不能自我修改 |
| 資料格式（boardType, meta） | 向下相容保證 |

**原則**：系統可以改變「策略」（怎麼做），不能改變「制度」（規則本身）。

---

## 跟 Edda 的關係

Edda 是 decision memory for coding agents。進化迴路的 Evaluate 結果可以餵入 Edda：

```
Edda 記錄：
  決策：「server 類任務用 engineer_lite」
  結果：「avg score 42，3 次失敗」
  教訓：「server 類任務需要 engineer_pro」
  
  決策：「quality_threshold 設 70」
  結果：「40% manual override」
  教訓：「60 更合適」
```

但這是未來整合，不是當前重點。

---

## 實作路線圖

### Phase 1：有眼睛（能看）

```
retro.js 讀 log → 計算 metrics → 寫入 board.retro
server.js 加 /api/retro endpoint
index.html 加 metrics 面板
```

**成果**：Human 不用手動翻 log，有 dashboard 看趨勢

### Phase 2：有嘴巴（能提建議）

```
retro.js 根據 metrics → 生成 insights → 生成 proposals
server.js 加 /api/proposals endpoints
index.html 加 proposals 面板 + approve/reject 按鈕
```

**成果**：系統會主動說「我覺得應該改 X」

### Phase 3：有手（能自動改）

```
server.js 處理 auto-apply（低風險 proposal）
retro.js 追蹤 proposal 效果（evaluate）
```

**成果**：低風險的改善自動執行，Human 只處理例外

### Phase 4：有記憶（能累積經驗）

```
proposal 效果記錄 → 長期知識庫
成功的 proposal → 變成永久規則
失敗的 proposal → 標記避免重複
跨 taskPlan 的學習（不只看單次專案）
```

**成果**：系統越用越聰明，不重複犯錯

---

## 風險與緩解

| 風險 | 描述 | 緩解 |
|------|------|------|
| 過度調整 | 系統基於少量數據做太大的改變 | 最小觀察數量（count >= 2） |
| 振盪 | threshold 上上下下 | 冷卻期（24h 內同類型最多 1 次） |
| 自我放水 | 系統降低標準讓自己看起來好 | threshold 有下限（不低於 40） |
| 資料不足 | 任務太少，統計不顯著 | 標記 confidence level |
| 失控循環 | auto-apply 連環觸發 | 連續 3 次後強制等 Human |
