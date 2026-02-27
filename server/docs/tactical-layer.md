# Tactical Layer（執行層）

> 狀態：~85% 完成
> 迴路週期：分鐘級
> 自治度：高

---

## 職責

在小範圍內完成「接任務 → 做事 → 檢查 → 修正」的完整迴路。

---

## 迴路

```
           ┌──────────────────────────────────┐
           │                                  │
           ▼                                  │
       dispatched                             │
           │                                  │
     ┌─────▼─────┐                            │
     │ in_progress│ ←──── redispatchTask()  ───┤
     └─────┬─────┘                            │
           │                                  │
     ┌─────▼─────┐                            │
     │ completed  │                            │
     └─────┬─────┘                            │
           │ auto_review?                     │
     ┌─────▼─────┐                            │
     │ reviewing  │  process-review.js         │
     └─────┬─────┘                            │
           │                                  │
     ┌─────┴─────┐                            │
     │           │                            │
  approved   needs_revision ──── auto_redispatch? ──┘
     │           │
     │        (或 Human 介入)
     ▼
  解鎖下游任務
```

---

## 元件

### 1. server.js — 任務調度器

**職責**：
- 管理任務狀態機（8 個狀態，嚴格 transition guard）
- 派發任務給 agent（兩條路線）
- 接收 agent 回報
- 觸發 auto-review
- 觸發 auto-redispatch
- SSE 即時推送

**狀態機**：
```
pending → dispatched → in_progress → completed → reviewing → approved
                           │                          │
                           └→ blocked                  └→ needs_revision
                                │                           │
                                └→ in_progress               └→ in_progress（重做）
                                                                 或 approved（手動通過）
```

**Transition Guard**：
```javascript
const ALLOWED_TASK_TRANSITIONS = {
  pending:         ['dispatched'],
  dispatched:      ['in_progress', 'pending'],
  in_progress:     ['blocked', 'completed'],
  blocked:         ['in_progress'],
  completed:       ['reviewing', 'approved', 'needs_revision'],
  reviewing:       ['approved', 'needs_revision'],
  needs_revision:  ['in_progress', 'approved'],
  approved:        [],
};
```

### 2. process-review.js — 品質閘門

**職責**：獨立原子腳本，由 server spawn 執行。

**兩層審查**：
1. **Deterministic pre-checks**（不花 token）
   - JSON 語法驗證
   - 外部依賴掃描（只允許 Node.js built-in）
   - 空檔案檢測
2. **LLM score-based review**
   - Agent 打分 0-100
   - 程式碼比較 threshold 決定 pass/fail
   - 5 層 fallback 解析（line → inline → code_block → bare_json → keyword）

**CLI**：
```
node process-review.js                    # 審查所有 completed
node process-review.js --task T3          # 審查特定任務
node process-review.js --skip-llm         # 只跑 deterministic
node process-review.js --dry-run          # 預覽
node process-review.js --threshold 80     # 自訂閾值
```

### 3. buildTaskDispatchMessage — 派發訊息組裝器

**職責**：把薄薄的任務描述擴充成完整的任務包裹。

**注入內容**：
1. 必讀 skill 路徑（blackboard-basics, engineer-playbook）
2. Spec 完整內容（截斷至 4000 字元）
3. 上游任務產出（lastReply 摘要）
4. API 回報指令
5. 期望的輸出格式

詳見 [dispatch-protocol.md](dispatch-protocol.md)。

### 4. redispatchTask — 自動修正器

**職責**：審查失敗後，自動把修正指令發回給 agent。

**觸發條件**：
- `auto_redispatch` = true
- task.status = `needs_revision`
- task.reviewAttempts < max_review_attempts

**修正指令包含**：
- 審查分數和閾值
- 發現的問題清單
- 審查報告摘要
- 原始 spec（供參考）
- API 回報指令

---

## Controls（可調參數）

| 參數 | 預設 | 說明 |
|------|------|------|
| `auto_review` | `true` | completed 後是否自動觸發審查 |
| `auto_redispatch` | `false` | needs_revision 後是否自動修正 |
| `quality_threshold` | `70` | score ≥ 此值才通過 |
| `max_review_attempts` | `3` | 最多審查幾次（安全閥） |
| `review_timeout_sec` | `180` | LLM 呼叫超時 |
| `review_agent` | `engineer_lite` | 執行 review 的 agent |

修改方式：
- UI sidebar（Review Controls 面板）
- `POST /api/controls`

---

## 派發路線

### 路線 A：Bulk Dispatch（通知 Nox 用 sessions_spawn）
```
Human 點 UI → POST /api/tasks/dispatch
  → 找出所有 ready tasks
  → 發訊息給 Nox（main agent）
  → Nox 用 sessions_spawn 派出各 agent
  → 各 agent 回報狀態
```
**適用**：需要 Nox 判斷模型選擇、派發策略的場景

### 路線 B：Per-task Dispatch（server 直接派）
```
Human 點 UI → POST /api/tasks/{id}/dispatch
  → server 直接 runOpenclawTurn
  → agent 回覆存為 lastReply
  → Human 在 UI 決定是否標記 completed
```
**適用**：簡單任務，不需要 Nox 中介

---

## 產出的數據（供 Operational 層使用）

| 數據 | 存在哪 | 用途 |
|------|--------|------|
| 任務狀態變化 | `task-log.jsonl` | 計算完成率、平均時間 |
| Review score | `board.json` task.review | 評估 agent 表現 |
| Blocked reason | `board.json` task.blocker | 分析常見卡點 |
| Review attempts | `board.json` task.reviewAttempts | 評估審查效率 |
| Agent reply | `board.json` task.lastReply | 交付物追蹤 |
| Transition history | `board.json` task.history[] | 完整時間線 |

---

## 已知限制

1. **artifact tracking 不完整**：只有 lastReply（文字），沒有結構化的檔案清單
2. **model 選擇不靈活**：per-task dispatch 用 agent config 預設模型，不能 per-task 指定
3. **無中間進度**：in_progress 到 completed 之間沒有進度報告
4. **session 複用問題**：conversation session 跟 task session 混用，context 可能汙染
5. **單一 taskPlan**：同時只能跑一個 taskPlan

---

## 下一步改善（由 Operational 層驅動）

這些改善不應該由人工決定，應該由 retro.js 根據數據提出 proposals：
- 哪些類型的任務需要更高的 threshold？
- 哪些 agent 在哪類任務表現好？
- 哪些 blocked reason 可以自動解決？
