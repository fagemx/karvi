# Operational Layer（感知回顧層）

> 狀態：~10% 完成（規劃階段）
> 迴路週期：天
> 自治度：中
> ⚠️ 本層的輸出格式已更新為 `signals / insights / lessons`（詳見 **blackboard-evolution.md**）
> retro.js 的 Observe→Analyze→Propose 管線保留作為內部行為模式，不是強制架構

---

## 職責

觀察 Tactical 層的執行數據，分析模式，提出改善建議，低風險的自動執行。

**一句話**：Tactical 層是「做事」，Operational 層是「看做得怎樣，怎麼做更好」。

---

## 迴路

```
 ┌────────────────────────────────────────────────────┐
 │                                                    │
 ▼                                                    │
Sense（感知）                                          │
 收集 tactical 層的原始數據                             │
 │                                                    │
 ▼                                                    │
Analyze（分析）                                        │
 計算 metrics，偵測 pattern                             │
 │                                                    │
 ▼                                                    │
Propose（提案）                                        │
 生成結構化 proposals                                   │
 │                                                    │
 ├── 低風險 → Auto-apply                               │
 │     改 controls, threshold                          │
 │     │                                              │
 │     ▼                                              │
 │   Effect（成效追蹤）─────────────────────────────────┘
 │     觀察改變後的 metrics
 │
 ├── 中風險 → 建 task（由 Tactical 層執行）
 │     改 skill 文件, review checklist
 │
 └── 高風險 → 等 Human
       新專案, 架構變更
```

---

## 核心元件：retro.js

### 定位

跟 `process-review.js` 同級的原子腳本。不是 server，不常態運行。

```
project/task-engine/
├── server.js              ← 主 server
├── process-review.js      ← 原子腳本：任務級審查
├── retro.js               ← 原子腳本：系統級回顧（新）
├── board.json             ← 黑板
├── task-log.jsonl         ← 事件日誌
└── index.html             ← UI
```

### 輸入

| 來源 | 內容 | 用途 |
|------|------|------|
| `task-log.jsonl` | 所有事件（dispatch, reply, review, error） | 計算時間、頻率、成功率 |
| `board.json` tasks[] | 每個任務的 history, review, score | 計算 agent 表現 |
| `board.json` controls | 當前設定 | 跟 metrics 比較，判斷是否需要調整 |

### 輸出

寫回 `board.json` 的兩個區塊：

```json
{
  "retro": {
    "lastRunAt": "2026-02-25T...",
    "version": 1,
    "metrics": { ... },
    "insights": [ ... ]
  },
  "proposals": [ ... ]
}
```

### 觸發方式

| 方式 | 怎麼跑 | 頻率 |
|------|--------|------|
| 手動 | UI 按鈕 → `POST /api/retro` → server spawn | 隨時 |
| Heartbeat | Nox 在 heartbeat 排程 spawn | 每天 1-2 次 |
| Cron | openclaw cron 排程 | 可設每日/每週 |
| 自動 | 每 N 個任務 approved 後自動觸發 | 待評估 |

### CLI

```
node retro.js                      # 完整回顧
node retro.js --dry-run             # 預覽（不寫 board）
node retro.js --since 2026-02-24    # 只分析特定日期後的數據
node retro.js --board path.json     # 自訂 board 路徑
```

---

## Metrics（指標設計）

### Agent 表現

```json
{
  "agents": {
    "engineer_lite": {
      "taskCount": 5,
      "avgScore": 62,
      "scoreDistribution": { "0-49": 1, "50-69": 2, "70-89": 2, "90-100": 0 },
      "avgCompletionMinutes": 12,
      "avgReviewAttempts": 2.4,
      "blockedRate": 0.2,
      "byTaskType": {
        "server": { "avgScore": 42, "count": 2 },
        "ui": { "avgScore": 75, "count": 2 },
        "skeleton": { "avgScore": 88, "count": 1 }
      }
    },
    "engineer_pro": {
      "taskCount": 3,
      "avgScore": 81,
      "avgCompletionMinutes": 35,
      "avgReviewAttempts": 1.2,
      "blockedRate": 0.0
    }
  }
}
```

### Review 效能

```json
{
  "review": {
    "totalReviews": 12,
    "deterministicFailRate": 0.15,
    "llmParseSuccessRate": 0.7,
    "avgScore": 68,
    "scoreBySource": {
      "line": { "count": 4, "avgScore": 75 },
      "keyword": { "count": 3, "avgScore": 55 },
      "fallback": { "count": 5, "avgScore": null }
    },
    "topIssues": [
      { "pattern": "外部依賴", "count": 3 },
      { "pattern": "REVIEW_RESULT 格式錯誤", "count": 5 },
      { "pattern": "空檔案", "count": 1 }
    ]
  }
}
```

### 系統健康

```json
{
  "health": {
    "taskCompletionRate": 0.75,
    "avgTimeToApprovalMinutes": 45,
    "manualOverrideRate": 0.4,
    "redispatchSuccessRate": 0.0,
    "blockedReasons": [
      { "reason": "spec 不清楚", "count": 2 },
      { "reason": "找不到定義", "count": 1 }
    ]
  }
}
```

---

## Insights（洞察）

retro.js 根據 metrics 生成結構化洞察：

```json
{
  "insights": [
    {
      "type": "agent_mismatch",
      "severity": "medium",
      "message": "engineer_lite 在 server 類任務 avgScore 42，低於 threshold 70",
      "evidence": { "agent": "engineer_lite", "taskType": "server", "avgScore": 42, "count": 2 },
      "suggestedAction": "改用 engineer_pro 處理 server 類任務"
    },
    {
      "type": "review_parser_issue",
      "severity": "high",
      "message": "70% 的 review 結果依賴 fallback 解析",
      "evidence": { "fallbackRate": 0.7 },
      "suggestedAction": "更新 review prompt 或換用更穩定的 review agent"
    },
    {
      "type": "threshold_too_high",
      "severity": "low",
      "message": "40% 的任務需要 Human 手動通過，threshold 可能過高",
      "evidence": { "manualOverrideRate": 0.4, "threshold": 70 },
      "suggestedAction": "降低 quality_threshold 至 60"
    }
  ]
}
```

---

## Proposals（提案設計）

### 結構

```json
{
  "id": "prop-20260225-001",
  "type": "assignee_change | threshold_adjust | skill_update | review_config | new_check",
  "title": "server.js 類任務改用 engineer_pro",
  "description": "根據 retro 分析...",
  "risk": "low | medium | high",
  "evidence": { ... },
  "action": {
    "type": "controls_patch | task_create | file_edit | info_only",
    "payload": { ... }
  },
  "status": "pending | approved | rejected | applied | deferred",
  "effect": {
    "tracked": false,
    "metric": "agents.engineer_pro.avgScore",
    "baseline": 81,
    "target": 85,
    "actual": null
  },
  "createdAt": "2026-02-25T...",
  "createdBy": "retro.js",
  "resolvedAt": null,
  "resolvedBy": null
}
```

### 風險分級與自動化

| 風險 | action.type | 處理方式 | 例子 |
|------|-------------|---------|------|
| **low** | `controls_patch` | auto-apply（改 board.controls） | 調 threshold、換 review_agent |
| **medium** | `task_create` | 建 task 讓 agent 執行 | 更新 skill 文件、加 deterministic check |
| **high** | `info_only` | 只記錄，等 Human | 開新專案、改架構、換模型 |

### Auto-apply 邏輯

```
if proposal.risk === 'low' && controls.auto_apply_proposals === true:
  直接 patch board.controls
  proposal.status = 'applied'
  proposal.effect.tracked = true
  → 下次 retro 時追蹤 metric 是否改善
```

---

## Server API（新增）

| Method | Path | 說明 |
|--------|------|------|
| `POST` | `/api/retro` | 觸發 retro.js（spawn） |
| `GET` | `/api/retro` | 讀 board.retro（最近一次結果） |
| `GET` | `/api/proposals` | 列出所有 proposals |
| `POST` | `/api/proposals/:id` | 更新 proposal 狀態（approve/reject/defer） |

### POST /api/proposals/:id

```json
// approve（低風險自動 apply，中高風險只標記）
{ "action": "approve" }

// reject
{ "action": "reject", "reason": "不適用當前情況" }

// defer
{ "action": "defer", "until": "2026-03-01" }
```

---

## UI 設計

### Proposals 面板（sidebar 或 tab）

```
┌─────────────────────────────────────┐
│ Proposals (3 pending)               │
├─────────────────────────────────────┤
│ ⚠️ server 類任務改用 engineer_pro   │
│    risk: low  |  evidence: avg 42   │
│    [✅ Approve] [❌ Reject] [⏸ Defer]│
├─────────────────────────────────────┤
│ 🔴 更新 review prompt 模板          │
│    risk: medium  |  fallback 70%    │
│    [✅ Approve] [❌ Reject] [⏸ Defer]│
├─────────────────────────────────────┤
│ 💡 降低 threshold 至 60             │
│    risk: low  |  manual override 40%│
│    [✅ Approve] [❌ Reject] [⏸ Defer]│
└─────────────────────────────────────┘
```

### Metrics 面板

```
┌─────────────────────────────────────┐
│ System Metrics (last retro: 2h ago) │
├─────────────────────────────────────┤
│ Completion rate:  75%               │
│ Avg time to approval: 45 min       │
│ Manual override rate: 40% ⚠️       │
│ Redispatch success: N/A            │
├─────────────────────────────────────┤
│ Agent Performance                   │
│ engineer_lite  avg 62  ████████░░   │
│ engineer_pro   avg 81  ████████████ │
├─────────────────────────────────────┤
│ [🔄 Run Retro Now]                 │
└─────────────────────────────────────┘
```

---

## 與 Tactical 層的邊界

| 行為 | 誰做 | 為什麼 |
|------|------|--------|
| 執行任務 | Tactical | 即時性，分鐘級 |
| 審查任務 | Tactical | 即時性，跟著 completed 觸發 |
| 分析趨勢 | Operational | 需要跨任務歷史數據 |
| 調參數 | Operational | 基於趨勢，不是單次結果 |
| 更新 skill | Operational | 影響所有未來任務 |

**原則**：Tactical 層不應該自己改 controls 或 skill。它只負責在當前參數下執行。改參數是 Operational 的事。

---

## 與 Strategic 層的邊界

Operational 層不決定：
- 做什麼專案
- 目標是什麼
- 優先級排序

它只向上報告：
- 「系統現在的表現如何」（metrics）
- 「我觀察到什麼問題」（insights）
- 「我建議怎麼改」（proposals）

Strategic 層（Human + Lead）決定是否採納。
