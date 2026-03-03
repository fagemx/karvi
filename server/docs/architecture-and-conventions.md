# 架構與代碼規範

> 日期：2026-03-03
> 用途：開發參考。新增模組、修改現有程式碼、撰寫測試時遵循此文件。
> 適用對象：人類開發者和 AI agent

---

## 技術棧

| 項目 | 選擇 | 說明 |
|------|------|------|
| 語言 | JavaScript (Node.js v22+) | 漸進遷移到 TypeScript |
| 外部依賴 | 應用層零依賴，基礎設施層可放寬 | 詳見「依賴規則」 |
| 資料格式 | JSON (board.json) + JSONL (append-only log) | 原子寫入 |
| HTTP | Node.js 內建 `http` 模組 | 不用 express |
| 即時通訊 | SSE (Server-Sent Events) | 不用 WebSocket |
| Runtime | 5 個 adapter: openclaw, codex, claude, claude-api, opencode | 透過 `runtime-contract.js` 驗證介面 |

---

## 專案結構

```
server/
├── server.js              ← 啟動入口：依賴組裝、route chain、init、graceful shutdown
├── blackboard-server.js   ← HTTP 骨架：CORS、MIME、SSE、JSON read/write、rate limit
├── storage.js             ← 儲存抽象層（backend 選擇：json / sqlite）
├── storage-json.js        ← JSON 檔案 backend（原子寫入）
│
├── management.js          ← 業務邏輯核心：controls、lessons、dispatch message 建構
├── kernel.js              ← step 事件路由 + task lifecycle + revision loop
├── step-worker.js         ← step 執行引擎：dispatch → parse → artifact → transition
├── step-schema.js         ← step 狀態機 + 資料結構定義
├── route-engine.js        ← step 流程決策：next step、failure routing、remediation
├── context-compiler.js    ← dispatch envelope 建構（從 step + task + board 組裝上下文）
├── artifact-store.js      ← step artifact 讀寫（input/output/review）
│
├── runtime-contract.js    ← runtime adapter 介面驗證
├── runtime-openclaw.js    ← OpenClaw CLI adapter
├── runtime-opencode.js    ← OpenCode CLI adapter
├── runtime-claude.js      ← Claude Code CLI adapter
├── runtime-claude-api.js  ← Claude API (HTTP) adapter
├── runtime-codex.js       ← Codex CLI adapter
│
├── protected-diff-guard.js← @protected 標記解析 + git diff 驗證
├── process-review.js      ← 品質審查腳本
├── retro.js               ← 回顧分析（signal → insight → lesson）
│
├── routes/                ← HTTP route 模組（每個檔案 = 一組 endpoint）
│   ├── tasks.js           ← task CRUD + dispatch + worktree + auto-dispatch
│   ├── controls.js        ← controls CRUD
│   ├── chat.js            ← conversation + turn dispatch
│   ├── village.js         ← village management
│   ├── projects.js        ← project CRUD + pause/resume
│   ├── push.js            ← push notification token 管理
│   ├── vault.js           ← secret storage
│   ├── usage.js           ← usage metrics
│   ├── github.js          ← GitHub integration endpoints
│   ├── jira.js            ← Jira integration endpoints
│   ├── evolution.js       ← signals / insights / lessons endpoints
│   └── briefs.js          ← scoped brief 管理
│
├── village/               ← Village 子系統
│   ├── village-scheduler.js ← 排程引擎
│   ├── cycle-watchdog.js    ← stall detection
│   └── retro.js             ← village-level 回顧
│
├── docs/                  ← 架構文件（就是你現在讀的）
├── specs/                 ← 規格文件
├── skills/                ← agent 知識庫
├── briefs/                ← dispatch 時產生的 scoped brief（不進 git）
└── test-*.js              ← 測試檔案
```

---

## 模組模式

### 1. Factory Pattern — 需要 deps 注入的有狀態模組

```javascript
// kernel.js, step-worker.js, vault.js, village-scheduler.js
function createKernel(deps) {
  // deps 在 closure 裡，模組內部可用
  async function onStepEvent(signal, board, helpers) {
    const { stepSchema, mgmt, artifactStore } = deps;
    // ...
  }
  return { onStepEvent };
}
module.exports = { createKernel };
```

**使用時機：** 模組需要存取 deps（其他模組的參照）且有內部狀態。

### 2. Plain Function Export — 無狀態工具模組

```javascript
// management.js, step-schema.js, route-engine.js, context-compiler.js
function buildDispatchPlan(board, task, options) { ... }
function transitionStep(step, newState, extra) { ... }
function decideNextStep(runState, deps) { ... }

module.exports = { buildDispatchPlan, transitionStep, decideNextStep };
```

**使用時機：** 純函式，輸入 → 輸出，不依賴外部狀態。

### 3. Runtime Adapter — 符合 runtime-contract 的介面物件

```javascript
// runtime-opencode.js, runtime-claude.js, etc.
function dispatch(plan) { return new Promise(...); }
function extractReplyText(parsed, stdout) { ... }
function extractSessionId(parsed) { ... }
function extractUsage(parsed, stdout) { ... }
function capabilities() { return { runtime: 'opencode', ... }; }

module.exports = { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities };
```

**必須實作的介面**（`runtime-contract.js` 在啟動時驗證）：

```javascript
// runtime-contract.js 驗證的 shape
{
  dispatch: Function,           // (plan) → Promise<{ code, stdout, stderr, parsed }>
  extractReplyText: Function,   // (parsed, stdout) → string
  extractSessionId: Function,   // (parsed) → string|null
  extractUsage: Function,       // (parsed, stdout) → { inputTokens, outputTokens, totalCost }|null
  capabilities: Function,       // () → { runtime, supportsReview, supportsSessionResume, ... }
}
```

### 4. Route Module — HTTP endpoint 處理

```javascript
// routes/controls.js
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function controlsRoutes(req, res, helpers, deps) {
  const { mgmt } = deps;

  // 精確匹配 URL + method
  if (req.method === 'GET' && req.url === '/api/controls') {
    const board = helpers.readBoard();
    return json(res, 200, mgmt.getControls(board));
  }

  // 參數化路由用 regex
  const match = req.url.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === 'POST' && match) {
    const taskId = match[1];
    // ...
  }

  return false;  // 不是我的路由，交給下一個
};
```

**規則：**
- 回傳 `false` = 沒匹配，繼續 chain
- 回傳其他值（或不回傳） = 已處理
- `helpers` 物件提供 board 讀寫 + 工具函式
- `deps` 物件提供所有模組參照

**`helpers` 介面：**

```javascript
{
  json(res, statusCode, data),     // 回傳 JSON response
  parseBody(req, maxBytes?),       // 解析 request body → Promise<object>
  readBoard(),                     // 讀取 board.json → object
  writeBoard(board),               // 寫入 board.json（原子寫入 + SSE broadcast）
  appendLog(entry),                // 追加到 task-log.jsonl
  broadcastSSE(event, data),       // 推送 SSE 事件
  nowIso(),                        // 當前時間 ISO 8601
  uid(prefix),                     // 產生唯一 ID（如 'sig-1234567-abc'）
}
```

---

## 命名規範

| 類型 | 風格 | 範例 |
|------|------|------|
| 檔案名 | `kebab-case` | `step-worker.js`, `route-engine.js` |
| 變數 / 函式 | `camelCase` | `taskId`, `buildDispatchPlan()` |
| 常數 | `UPPER_SNAKE_CASE` | `DEFAULT_CONTROLS`, `LOCK_GRACE_MS` |
| JSON 資料欄位 | `snake_case` | `step_id`, `run_id`, `lock_expires_at` |
| CSS class | N/A（無 CSS 模組） | — |
| test helper | 短名 | `ok()`, `fail()`, `makeRunState()` |

**特別注意：** JavaScript 程式碼用 `camelCase`，但 board.json 裡的資料欄位用 `snake_case`。這是歷史慣例，不要混用。

```javascript
// ✅ 正確
const stepId = step.step_id;
const lockExpiresAt = step.lock_expires_at;

// ❌ 錯誤 — 不要在資料欄位用 camelCase
step.stepId = '...';        // 應該是 step.step_id
step.lockExpiresAt = '...'; // 應該是 step.lock_expires_at
```

---

## 依賴注入

### deps 物件

所有模組的依賴透過一個共用的 `deps` 物件傳遞，在 `server.js` 組裝：

```javascript
// server.js
const deps = {
  // 外部模組
  vault, githubApi, runtime, RUNTIMES, getRuntime,
  mgmt, push, usage, jiraIntegration, githubIntegration,
  digestTask, timelineTask, confidenceEngine,

  // 設定
  ctx, PUSH_TOKENS_PATH, DIR, DATA_DIR,

  // Step-level 模組
  stepSchema, artifactStore, routeEngine, contextCompiler,

  // 有循環依賴的模組（建立後填入）
  stepWorker: null,   // createStepWorker(deps) 後設定
  kernel: null,       // createKernel(deps) 後設定

  // 跨模組函式（tasks.js init 後設定）
  tryAutoDispatch: null,
  redispatchTask: null,
};
```

**規則：**
- 不要在模組內部直接 `require` 其他業務模組（除非是工具函式）
- 需要其他模組的功能 → 從 deps 取
- Factory 模組在 closure 裡持有 deps 參照
- Route 模組每次呼叫都收到 deps 參數

### 循環依賴處理

```javascript
// kernel ↔ stepWorker 循環依賴
// 解法：stepWorker 先建立，kernel 後建立
// stepWorker 對 kernel 的呼叫用 setImmediate 延遲
deps.stepWorker = require('./step-worker').createStepWorker(deps);
deps.kernel = require('./kernel').createKernel(deps);
// 此時 deps.kernel 已設定，stepWorker 的 setImmediate callback 能安全存取
```

---

## Board 讀寫

### 原子寫入

```javascript
// storage-json.js — write 流程
function writeBoard(boardPath, board) {
  const tmpPath = path.join(dir, `.board-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(board, null, 2), 'utf8');
  fs.renameSync(tmpPath, boardPath);   // POSIX: atomic; Windows: best-effort
}
```

### 讀-改-寫 Pattern

```javascript
// ✅ 正確：每次操作都讀最新的 board
const board = helpers.readBoard();
const task = board.taskPlan.tasks.find(t => t.id === taskId);
task.status = 'completed';
helpers.writeBoard(board);

// ❌ 錯誤：用 stale board
// 不要在函式開頭讀 board 然後在很久之後才寫回去
```

### SSE 自動推送

`helpers.writeBoard(board)` 會自動：
1. 寫入 board.json
2. 加 `meta.updatedAt` 時間戳
3. `broadcastSSE('board', board)` 推送給所有 SSE client

不需要手動 broadcastSSE board 變更。

---

## 錯誤處理

### 層級

```
Level 1: Route handler — catch + json(res, 4xx/5xx)
Level 2: Step execution — catch + transition step to failed + emit signal
Level 3: Fire-and-forget — .catch(err => console.error(...))
Level 4: Best-effort — try {} catch {} (empty catch)
```

### 規則

```javascript
// Route handler — 回傳 HTTP error
try {
  const board = helpers.readBoard();
  return json(res, 200, data);
} catch (error) {
  return json(res, 500, { error: error.message });
}

// 業務邏輯 — 拋出帶 .code 的 Error
const err = new Error(`Invalid transition: ${from} → ${to}`);
err.code = 'INVALID_STEP_TRANSITION';
throw err;

// 非同步 fire-and-forget — 不要 swallow，至少 log
deps.kernel.onStepEvent(signal, board, helpers).catch(err =>
  console.error(`[kernel] callback error:`, err.message));

// Best-effort 操作 — 可以 swallow（heartbeat、cleanup）
try { plan.onActivity(); } catch {}
try { fs.unlinkSync(tmpFile); } catch {}
```

### 降級啟動

可選模組在 `server.js` 用 try/catch 載入，失敗不擋啟動：

```javascript
let runtimeCodex = null;
try { runtimeCodex = require('./runtime-codex'); } catch { /* not installed, skip */ }

// 使用時檢查 null
if (runtimeCodex) { RUNTIMES.codex = runtimeCodex; }
```

---

## 日誌格式

```
[module-name] message
[module-name:contextId] message
```

| Level | 用途 | 範例 |
|-------|------|------|
| `console.log` | 正常操作 | `[kernel] step completed: T-1:implement` |
| `console.warn` | 降級運行 | `[telemetry] init failed, continuing without telemetry` |
| `console.error` | 需要注意的錯誤 | `[step-worker] dispatch error for S3: timeout` |

**格式規則：**
- 第一個 token 必須是 `[module-name]`
- context id 用 `:` 接在 module name 後面
- 狀態變化用 `→` 符號：`running → succeeded`
- 數值用 `=` 格式：`reason=stop cost=0.02`
- 不要用 emoji

```javascript
// ✅ 正確
console.log(`[step-worker] step ${stepId}: running → succeeded`);
console.log('[opencode-rt] step_finish: reason=%s cost=%s', reason, cost);
console.error(`[kernel] executeStep error for ${stepId}:`, err.message);

// ❌ 錯誤
console.log('Step completed!');           // 缺 [module-name]
console.log(`✅ Step ${stepId} done`);    // 不要用 emoji
```

---

## Windows 相容性

### spawn 用 `cmd.exe` wrapper

```javascript
// ✅ 正確 — Windows .cmd shim 必須透過 cmd.exe 呼叫
const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : CLI_EXE;
const spawnArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', CLI_EXE, ...args]
  : args;
const child = spawn(spawnCmd, spawnArgs, { shell: false, windowsHide: true });
```

### killTree 用 `taskkill`

```javascript
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {}
}
```

**注意：** 這段程式碼目前在 5 個 runtime adapter 裡各複製了一份。未來應抽到 `platform.js`。

### 路徑處理

```javascript
// ✅ 用 path.join，不要硬寫分隔符
const boardPath = path.join(DATA_DIR, 'board.json');

// ❌ 不要硬寫
const boardPath = DATA_DIR + '/board.json';    // Windows 下可能出問題
const boardPath = DATA_DIR + '\\board.json';   // Unix 下壞掉
```

---

## 測試規範

### 現有格式（舊）

```javascript
// test-step-schema.js — 自帶 runner
let passed = 0, failed = 0;
function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }
```

### 新格式（推薦）

```javascript
// 使用 Node 22 內建的 node:test
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('step-schema', () => {
  describe('createStep', () => {
    it('returns correct defaults', () => {
      const step = stepSchema.createStep('T-1', 'run-1', 'plan');
      assert.strictEqual(step.state, 'queued');
    });
  });
});
```

**跑法：** `node --test server/test-*.js`

### 測試命名

```
test-{module-name}.js        ← 單元測試
test-{feature}-smoke.js      ← 冒煙測試（啟動 server）
test-{scenario}-integration.js ← 整合測試
```

### 測試 Helper 工廠

```javascript
// 建立測試用的假資料，避免每個 test 重複寫
function makeTask(overrides = {}) {
  return {
    id: 'T-1', title: 'test task', status: 'pending',
    steps: [], history: [], ...overrides,
  };
}

function makeStep(overrides = {}) {
  return stepSchema.createStep(
    overrides.taskId || 'T-1',
    overrides.runId || 'run-1',
    overrides.type || 'implement',
  );
}
```

---

## @protected 標記

防止 AI agent 在 auto-dispatch 時意外刪除關鍵程式碼。

### 語法

```javascript
// 單行保護
// @protected decision:<key> — <reason>
<protected code>

// 多行保護
// @protected decision:<key> — <reason>
<protected code line 1>
<protected code line 2>
// @end-protected
```

### 範例

```javascript
// @protected decision:dispatch.modelHint — CLI runtimes manage own model selection
modelHint: (runtimeHint === 'claude' || runtimeHint === 'opencode') ? null : preferredModelFor(task.assignee),

// @protected decision:runtime.opencode.msgFile — cmd.exe truncates multi-line positional args
const msgFile = path.join(os.tmpdir(), `karvi-dispatch-${Date.now()}.md`);
fs.writeFileSync(msgFile, plan.message, 'utf8');
args.push('--file', msgFile, '--', 'Read the attached file for your task.');
// @end-protected
```

### 規則

- 只標記**有過被 agent 錯誤刪除的程式碼**或**反直覺的設計決策**
- 不要過度使用 — 標太多等於沒標
- key 用 `domain.aspect` 格式，跟 edda decision key 一致
- reason 簡短說明為什麼這樣寫

---

## 依賴規則

### 應用層（零依賴）

以下模組只能 require Node.js 內建模組和專案內的其他模組：

```
management.js, kernel.js, step-worker.js, route-engine.js,
step-schema.js, context-compiler.js, artifact-store.js,
runtime-*.js, protected-diff-guard.js, routes/*.js
```

### 基礎設施層（可放寬）

以下模組可以使用經過審核的外部依賴：

```
storage.js / storage-*.js  → better-sqlite3（未來）
test-*.js                  → node:test（Node 22 內建）
```

### 引入新依賴的條件

1. 無 transitive dependency（或 < 3 個）
2. Actively maintained（最近 6 個月有 commit）
3. 有 TypeScript types（或 @types 包）
4. 記錄 edda decision：`edda decide "deps.{name}={version}" --reason "why"`

---

## 反模式

### 不要做

```javascript
// ❌ 在 route handler 裡直接 require 業務模組
module.exports = function myRoute(req, res, helpers, deps) {
  const mgmt = require('../management');  // 應該從 deps 取
};

// ❌ 在資料欄位用 camelCase
step.stepId = '...';         // 應該是 step.step_id

// ❌ 跳過 helpers 直接操作 board
const board = JSON.parse(fs.readFileSync('board.json'));  // 應該用 helpers.readBoard()

// ❌ 不 log 就 swallow error（除非是 best-effort 操作）
try { importantOperation(); } catch {}

// ❌ 同步阻塞長操作
const result = execSync('long-running-command', { timeout: 60000 });  // 用 spawn + async

// ❌ 硬寫路徑分隔符
const p = dir + '\\file.json';  // 用 path.join(dir, 'file.json')
```

### 要做

```javascript
// ✅ 從 deps 取模組
module.exports = function myRoute(req, res, helpers, deps) {
  const { mgmt } = deps;
};

// ✅ 資料欄位用 snake_case
step.step_id = stepSchema.stepId(taskId, stepType);

// ✅ 透過 helpers 操作 board
const board = helpers.readBoard();
helpers.writeBoard(board);

// ✅ 至少 log error
someAsyncOp().catch(err => console.error('[module] op failed:', err.message));

// ✅ 用 path.join
const p = path.join(dir, 'file.json');
```
