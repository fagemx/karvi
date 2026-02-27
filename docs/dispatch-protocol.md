# Dispatch Protocol（派發協議）

> 狀態：v2（已從一句話派發升級到完整上下文派發）
> 最後更新：2026-02-25

---

## 問題背景

OpenClaw agent 的根本限制：**context window 有限，認知能力隨任務複雜度下降。**

這意味著派發訊息的品質直接決定任務成功率。一句話派發 → agent 猜測 → 高失敗率。完整上下文派發 → agent 理解 → 高成功率。

---

## 派發訊息結構

### v2 結構（當前）

```
┌─────────────────────────────────────────────────────┐
│ 1. Header（任務標識）                                 │
│    任務 ID、名稱、目標                                │
├─────────────────────────────────────────────────────┤
│ 2. Required Reading（必讀清單）                       │
│    skill 路徑（blackboard-basics, engineer-playbook）  │
│    spec 路徑                                         │
├─────────────────────────────────────────────────────┤
│ 3. Task Details（任務細節）                            │
│    描述、依賴                                         │
├─────────────────────────────────────────────────────┤
│ 4. Spec Content（規格注入）                           │
│    完整 spec 內容（截斷至 4000 字元）                   │
├─────────────────────────────────────────────────────┤
│ 5. Upstream Artifacts（上游產出）                      │
│    前置任務的 lastReply 摘要                           │
├─────────────────────────────────────────────────────┤
│ 6. Reporting API（回報指令）                          │
│    完整的 HTTP API 呼叫範例                            │
├─────────────────────────────────────────────────────┤
│ 7. Expected Output（期望輸出格式）                     │
│    檔案清單 + 自檢結果 + 注意事項                      │
└─────────────────────────────────────────────────────┘
```

### v1（已棄用）

```
【任務派發】
目標：{goal}
任務 ID：{id}
任務名稱：{title}
說明：{description}
請直接執行這個任務。完成後回報結果摘要。
```

**v1 → v2 差異**：從 ~100 字元 → ~2000-6000 字元。增加 spec 注入、上游產出、API 指令。

---

## 兩條派發路線

### 路線 A：Bulk Dispatch（通過 Lead）

```
Human → POST /api/tasks/dispatch → server.js
  → 組裝所有 ready tasks 的摘要
  → 發送給 Nox（main agent）
  → Nox 用 sessions_spawn 逐個派出
  → Nox 指定 model、注入上下文
```

**Nox 派發時的補充**：
- `sessions_spawn` 可帶 `model` 參數（server 直接派不行）
- Nox 可以根據任務類型選擇最合適的模型
- Nox 可以在 task message 裡加入主觀判斷

**適用場景**：
- 首次派發一批任務
- 需要根據任務類型選模型
- 需要 Lead 判斷的複雜任務

### 路線 B：Per-task Dispatch（直接派）

```
Human → POST /api/tasks/{id}/dispatch → server.js
  → buildTaskDispatchMessage() 組裝完整訊息
  → runOpenclawTurn() 直接呼叫 agent
  → agent 回覆存為 lastReply
  → Human 在 UI 決定狀態
```

**適用場景**：
- 簡單任務
- re-dispatch（修正後重新派發）
- 不需要 Lead 介入

### 路線 C：Auto Re-dispatch（自動修正）

```
process-review.js → needs_revision
  → spawnReview close handler 偵測
  → auto_redispatch 啟用？
  → redispatchTask() 組裝修正指令
  → 包含 review score + issues + 原始 spec
  → 發送給原 agent（同 session 保持上下文）
```

**適用場景**：
- 審查不通過，自動發回修正

---

## Spec 注入策略

### 讀取

```javascript
function readSpecContent(specRelPath) {
  const fullPath = path.join(DIR, specRelPath);  // DIR = task-engine/
  const content = fs.readFileSync(fullPath, 'utf8');
  const MAX_SPEC = 4000;
  if (content.length > MAX_SPEC) {
    return content.slice(0, MAX_SPEC) + '\n... (spec 超過 4000 字元，已截斷) ...';
  }
  return content;
}
```

### 截斷策略

| Spec 大小 | 處理 |
|-----------|------|
| < 4000 chars | 完整注入 |
| 4000-8000 chars | 截斷，附註 |
| > 8000 chars | 只注入當前任務相關的 section（待實作） |

### 未來改善：智慧截斷

目前是粗暴截斷前 4000 字元。更好的方式：
1. 解析 spec 的 markdown 結構
2. 保留 schema + API 定義（agent 最需要的）
3. 截斷 UI 設計和背景說明（相對不急）
4. 或者按任務 ID 只取對應的 section

---

## 上游產出注入

### 原理

有依賴的任務（`depends: ["T1"]`），需要知道 T1 做了什麼。

```javascript
function gatherUpstreamArtifacts(board, task) {
  const allTasks = board.taskPlan?.tasks || [];
  const results = [];
  for (const depId of task.depends) {
    const dep = allTasks.find(t => t.id === depId);
    if (!dep) continue;
    const entry = { id: dep.id, title: dep.title, status: dep.status };
    if (dep.lastReply) {
      entry.summary = dep.lastReply.slice(0, 600);
    }
    results.push(entry);
  }
  return results;
}
```

### 注入格式

```
前置任務產出（你的任務建立在這些成果之上）：
  T1 (建立專案骨架) [approved]
    交付摘要：建立了 board.json、server.js、index.html，
    語法檢查通過，server 在 port 3462 可啟動。
```

### 限制

- 目前只有 `lastReply`（純文字），沒有結構化的檔案清單
- 截斷至 600 字元，複雜任務可能資訊不足
- 未來可改為 artifact 物件：`{ files: [...], changes: [...], notes: [...] }`

---

## 修正指令結構（Re-dispatch）

```
┌─────────────────────────────────────────────────────┐
│ 1. Header（修正指令標識）                             │
│    任務 ID、名稱                                     │
├─────────────────────────────────────────────────────┤
│ 2. Review Result（審查結果）                          │
│    分數、閾值、未達標                                  │
├─────────────────────────────────────────────────────┤
│ 3. Issues（發現的問題）                               │
│    結構化問題清單                                      │
├─────────────────────────────────────────────────────┤
│ 4. Report（審查報告摘要）                             │
│    LLM 的完整評語（截斷至 1500 字元）                  │
├─────────────────────────────────────────────────────┤
│ 5. Instruction（修正指令）                            │
│    「根據以上修正，回報 completed」                     │
├─────────────────────────────────────────────────────┤
│ 6. Spec（原始規格，供參考）                           │
│    完整 spec 再次注入                                  │
├─────────────────────────────────────────────────────┤
│ 7. Reporting API（回報指令）                          │
│    POST /api/tasks/{id}/status                       │
└─────────────────────────────────────────────────────┘
```

---

## Agent 回報協議

### Agent 完成時

Agent 回覆應包含：
```
【交付報告：{taskId}】

建立/修改的檔案：
- {完整路徑} — {一句話說明}
- {完整路徑} — {一句話說明}

自檢結果：
- node -c server.js: ✅
- board.json parse: ✅
- smoke-test: ✅

注意事項：
- {後續任務需要知道的}
```

### Agent 卡住時

```
reason 必須具體：
  ❌ 「卡住了」
  ✅ 「spec 裡沒定義 synthesis phase 的 prompt 模板，需要 Lead 補充」
```

### 回報方式

| 方式 | 程式碼 | 誰做 |
|------|--------|------|
| HTTP API | `POST /api/tasks/{id}/status` | Agent（如果有 exec 工具） |
| 文字回覆 | lastReply 儲存 | Server 收到後等 Human 決定 |
| TASK_RESULT | `TASK_RESULT:{"status":"completed","summary":"..."}` | Agent（可選格式） |

---

## 安全閥

| 機制 | 預設 | 作用 |
|------|------|------|
| `max_review_attempts` | 3 | 審查循環上限 |
| `review_timeout_sec` | 180 | 單次 LLM 呼叫超時 |
| `runOpenclawTurn timeout` | 300 | 任務執行超時 |
| Transition guard | 嚴格 | 不允許非法狀態轉換 |
| Task history | 無限 | 完整審計軌跡 |
| Message cap | 1000 | 防止 board 無限增長 |
