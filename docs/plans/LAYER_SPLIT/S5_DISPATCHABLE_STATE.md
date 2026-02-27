# S5: 建立代理可派發狀態（Dispatchable State）

## 目標

在 **S1-S4（拆層完成）** 的基礎上，補一層「管理層可直接派發給任意 runtime 的中立狀態」。

完成後要達成：

1. `management.js` 不只輸出文字訊息，還能輸出 **結構化 dispatch plan**
2. `server.js` 在 board 的 task 上維護 **`task.dispatch.state` 狀態流轉**
3. `runtime-openclaw.js` 提供 `dispatch(plan)` wrapper（與未來 `runtime-codex.js` 對齊）
4. **行為保持不變**（仍由 OpenClaw 實際執行）

---

## 為什麼這一步要接在 S4 後面

S1-S4 解決的是「檔案分層」；S5 解決的是「介面分層」。

如果沒有 S5，管理層仍然主要輸出：

- `buildTaskDispatchMessage(...)` → 字串
- `buildRedispatchMessage(...)` → 字串

這會讓下一步接 `runtime-codex.js` 時，還是得在 server.js 裡塞一堆 `if runtime === 'codex' ...` 的轉換邏輯。

S5 的目標是把這個轉換提前收斂到管理層與 runtime adapter 的交界面。

---

## 前置條件

- [x] S1: `management.js`
- [x] S2: `runtime-openclaw.js`
- [x] S3: `server.js` 薄殼
- [x] S4: 驗證通過（行為 100% 不變）

---

## 設計原則（必須遵守）

1. **行為不變**
   - 現有 OpenClaw 派發流程、review 流程、queue 流程都不能改行為。

2. **管理層輸出中立格式**
   - 管理層可以提供 `runtimeHint`，但不能耦合 OpenClaw CLI 參數細節。

3. **server 是 board.json 單寫者**
   - runtime 不直接寫 `board.json`
   - runtime 只回傳結果，由 server 更新 board + SSE

4. **Schema 只加不破**
   - `task.dispatch` 為新增欄位（可選）
   - 不修改既有 task 狀態機的語義

---

## 新增資料模型（board 上的 task.dispatch）

每個 task 可新增一個 `dispatch` 欄位（可選）：

```json
{
  "dispatch": {
    "version": 1,
    "state": "prepared",
    "planId": "disp_xxx",
    "runtime": "openclaw",
    "agentId": "engineer_pro",
    "model": "gpt-5",
    "timeoutSec": 180,
    "preparedAt": "2026-02-26T07:00:00.000Z",
    "startedAt": null,
    "finishedAt": null,
    "sessionId": null,
    "lastError": null
  }
}
```

### `dispatch.state` 狀態值（最小集合）

| 值 | 意義 | 由誰寫入 |
|----|------|----------|
| `prepared` | 已有可派發 plan，尚未呼叫 runtime | server（在 runtime 前） |
| `dispatching` | 已呼叫 runtime，等待結果 | server |
| `completed` | runtime 成功回傳 | server |
| `failed` | runtime 失敗或 timeout | server |

> 註：S5 不需要新增更多狀態（例如 `queued` / `cancelled`），避免擴張。

---

## 新增資料模型（management 輸出的 Dispatch Plan）

新增一個 **runtime-neutral** 的派發物件（不一定完整落盤，server 可只落 `task.dispatch` 摘要）：

```javascript
{
  kind: 'task_dispatch',
  version: 1,
  planId: 'disp_xxx',
  taskId: task.id,
  mode: 'dispatch' | 'redispatch',
  runtimeHint: 'openclaw',
  agentId: task.assignee,                // board.json 用 assignee
  modelHint: preferredModelFor(task.assignee),
  timeoutSec: 180,
  sessionId: task.sessionId || null,
  message: '...',               // 給 runtime 的主要內容（暫時仍是文字）
  createdAt: nowIso(),
  upstreamTaskIds: task.depends || [],   // board.json 用 depends
  artifacts: [...],             // 上游產出摘要（若有）
  controlsSnapshot: { ... }     // 可用於追蹤決策原因（摘要即可）
}
```

**重要：**
- `message` 可以先沿用現有 `buildTaskDispatchMessage / buildRedispatchMessage`
- 先把 plan 做出來，再讓 runtime adapter 轉譯
- S5 不做 CSV/TOML 真正輸出；那是 `runtime-codex.js` 的責任

---

## 變更範圍（只改這三個檔案）

- `project/task-engine/management.js`
- `project/task-engine/runtime-openclaw.js`
- `project/task-engine/server.js`

不改：

- `process-review.js`
- `retro.js`
- `blackboard-server.js`
- `board.json` 現有欄位語義

---

## 步驟

### 1. `management.js` 新增 Dispatch Plan 建構函式

新增常數（檔案頂部常數區）：

```javascript
const DISPATCH_PLAN_VERSION = 1;
const VALID_DISPATCH_STATES = new Set(['prepared', 'dispatching', 'completed', 'failed']);
```

新增函式（放在 `buildTaskDispatchMessage` / `buildRedispatchMessage` 附近）：

```javascript
function buildDispatchPlan(board, task, options = {}) { ... }
```

#### `buildDispatchPlan` 要做的事

1. 判斷 mode
   - `options.mode === 'redispatch'` 時用 `buildRedispatchMessage`
   - 否則用 `buildTaskDispatchMessage`

2. 產生 plan
   - `planId` 用 `uid('disp')`
   - `runtimeHint` 預設 `'openclaw'`
   - `modelHint` 用 `preferredModelFor(task.assignee)`
   - `timeoutSec` 先沿用現行派發 timeout（可由 options 覆蓋）

3. 蒐集摘要資訊（不要重複重算太多）
   - `controlsSnapshot`：用 `getControls(board)` 的摘要
   - `upstreamTaskIds`：從 `task.depends || []`
   - `artifacts`：沿用 `gatherUpstreamArtifacts(board, task)` 的結果（可摘要化）

#### 相容性要求

- **保留** `buildTaskDispatchMessage` 與 `buildRedispatchMessage`（現有呼叫點仍可用）
- S5 可以先在 server 新呼叫 `buildDispatchPlan`，再逐步替換舊流程

#### `module.exports` 要新增

```javascript
DISPATCH_PLAN_VERSION,
VALID_DISPATCH_STATES,
buildDispatchPlan,
```

---

### 2. `runtime-openclaw.js` 新增 `dispatch(plan)` wrapper（保留舊 API）

新增函式：

```javascript
function dispatch(plan) {
  return runOpenclawTurn({
    agentId: plan.agentId,
    sessionId: plan.sessionId || undefined,
    message: plan.message,
    timeoutSec: plan.timeoutSec || 180,
  });
}
```

可選（推薦）新增：

```javascript
function capabilities() {
  return {
    runtime: 'openclaw',
    supportsReview: true,
    supportsSessionResume: true,
    supportsStructuredDispatchPlan: true,
  };
}
```

`module.exports` 更新（保留舊函式）：

```javascript
module.exports = {
  dispatch,
  capabilities, // 若有實作
  runOpenclawTurn,
  spawnReview,
  extractReplyText,
  extractSessionId,
};
```

---

### 3. `server.js` 在派發流程寫入 `task.dispatch.state`

修改點：`processQueue()` 與 `redispatchTask()` 的 runtime 呼叫前後。

#### 3.1 派發前：建立 plan + 標記 `prepared`

在原本組 message 的位置，改成：

```javascript
const plan = mgmt.buildDispatchPlan(board, task, { mode: 'dispatch' /* 或 redispatch */ });
```

然後在呼叫 runtime 前，寫入 task：

```javascript
task.dispatch = {
  version: mgmt.DISPATCH_PLAN_VERSION,
  state: 'prepared',
  planId: plan.planId,
  runtime: plan.runtimeHint,
  agentId: plan.agentId,
  model: plan.modelHint || null,
  timeoutSec: plan.timeoutSec || 180,
  preparedAt: plan.createdAt,
  startedAt: null,
  finishedAt: null,
  sessionId: plan.sessionId || null,
  lastError: null,
};
```

> 寫完後照既有流程 `writeBoard(board)` + `broadcastSSE(...)`。

#### 3.2 呼叫 runtime 前一刻：標記 `dispatching`

```javascript
task.dispatch.state = 'dispatching';
task.dispatch.startedAt = nowIso();
writeBoard(board);
broadcastSSE('board', board);
```

#### 3.3 runtime 成功後：標記 `completed`

在成功路徑更新：

```javascript
task.dispatch.state = 'completed';
task.dispatch.finishedAt = nowIso();
task.dispatch.sessionId = runtime.extractSessionId(result.parsed) || task.dispatch.sessionId || null;
task.dispatch.lastError = null;
```

#### 3.4 runtime 失敗 / timeout：標記 `failed`

在 `catch` 或錯誤分支更新：

```javascript
task.dispatch = task.dispatch || {};
task.dispatch.state = 'failed';
task.dispatch.finishedAt = nowIso();
task.dispatch.lastError = err.message || String(err);
```

**注意：**
- 不要讓 `task.dispatch.state` 取代原本 `task.status`
- `task.status` 還是原本的任務狀態機（queued / running / done / ...）
- `dispatch.state` 是執行層觀測狀態，兩者並存

---

### 4. 保持 `spawnReview` 與 review 流程不變

S5 不改 review 行為，只做一個可選補強：

- 若 review 觸發 auto-redispatch，新的 redispatch 也走 `buildDispatchPlan(..., { mode: 'redispatch' })`

不要：

- 改 `process-review.js`
- 改 review 結果判斷規則

---

## 驗證

### 1. 語法與 module 載入

```bash
node -c management.js
node -c runtime-openclaw.js
node -c server.js
node -e "const m=require('./management'); console.log('buildDispatchPlan' in m, 'DISPATCH_PLAN_VERSION' in m)"
```

### 2. 行為不變驗證（沿用 S4）

```bash
# server 啟動
node server.js

# 另一個 terminal
node ../../smoke-test.js 3461
node test-evolution-loop.js
```

預期：與 S4 相同，全通過。

### 3. 新增觀測驗證（task.dispatch）

至少驗一個任務從派發到完成的 `task.dispatch.state` 流轉：

- `prepared`
- `dispatching`
- `completed`（或失敗情況下 `failed`）

可以用：

```bash
node -e "const b=require('./board.json'); console.log(JSON.stringify((b.taskPlan?.tasks||[]).map(t=>({id:t.id,status:t.status,dispatch:t.dispatch&&t.dispatch.state})), null, 2))"
```

---

## 不要做的事（S5 範圍外）

- 不要在 S5 直接實作完整 `runtime-codex.js`
- 不要把 CSV/TOML 輸出硬塞進 `management.js`
- 不要把完整 `message`（超長 prompt）寫進 `board.json`（容易膨脹）
- 不要讓 runtime adapter 直接寫 `board.json`

---

## 完成標記（更新 `00_OVERVIEW.md`）

```
[x] S5: 代理可派發狀態（Codex 前置）
```

完成 S5 後，下一步才是：

- `runtime-codex.js`（吃同一個 dispatch plan）
- `runtime-dryrun.js`（驗證管理決策）
- CSV / TOML / SKILL.md 的 runtime 轉譯輸出
