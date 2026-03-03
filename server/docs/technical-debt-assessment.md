# 技術債評估：Node.js / 純 JS / 零依賴

> 日期：2026-03-03
> 結論：Node.js 不需要換。純 JS → TypeScript 漸進遷移、零依賴在基礎設施層放寬、大檔案拆分。

---

## 結論先行

| 問題 | 嚴重度 | 要不要換 |
|------|--------|----------|
| Node.js 語言本身 | 不是問題 | ❌ 不換 — event loop 模型完美適合「等 30 個 child process」 |
| 純 JavaScript 沒有型別 | **高** | ✅ 漸進加 TypeScript |
| 零外部依賴 | 中 | ⚠️ 應用層維持，基礎設施層放寬 |
| 單檔案膨脹 | 中 | ✅ 拆分 |
| 測試沒有框架 | 低→中 | ✅ 改用 `node:test`（Node 22 內建） |

---

## 問題 1：純 JS 沒有型別 — 最大的定時炸彈

### 現狀

30+ 個模組互相傳物件，沒有任何編譯期型別檢查。

```javascript
// management.js — buildDispatchPlan 回傳什麼？
function buildDispatchPlan(board, task, options) {
  return {
    message: ...,
    timeoutSec: ...,     // number? string? undefined?
    modelHint: ...,      // null? string?
    workingDir: ...,
  };
}

// step-worker.js — 收到的 envelope 長什麼樣？
async function executeStep(envelope, board, helpers) {
  const rt = deps.getRuntime(envelope.runtimeHint);  // 如果 runtimeHint 拼錯？
  const plan = { ...envelope };                       // 如果 envelope 少了欄位？
}
```

### 風險場景

| 場景 | 後果 |
|------|------|
| board.json schema 加一個欄位 | 所有讀這個欄位的地方靠人腦記，漏改 = runtime error |
| `controls` 改名某個 key | `management.js` 裡 30+ function 互相引用，IDE 找不完 |
| runtime adapter interface 變更 | `runtime-contract.js` 有驗證，但只在啟動時跑一次，新加的方法不會被檢查 |
| Territory 加 multi-board | `readBoard()` 簽名從 `() → Board` 變成 `(territoryId) → Board`，所有呼叫點都要改 |

### 現有 JSDoc 覆蓋率

部分模組有 JSDoc，但不統一：

| 模組 | JSDoc 狀態 |
|------|-----------|
| `step-worker.js` | ✅ 主要函式有 `@param` |
| `kernel.js` | ✅ `createKernel`, `onStepEvent` 有 |
| `management.js` | ⚠️ 部分有（`matchLessonsForTask` 等），大部分沒有 |
| `runtime-contract.js` | ✅ 有 `@typedef RuntimeAdapter` |
| `route-engine.js` | ❌ 完全沒有 |
| `step-schema.js` | ❌ 完全沒有 |
| `context-compiler.js` | ❌ 完全沒有 |
| `routes/*.js` | ❌ 完全沒有 |

### 解決方案：JSDoc → TypeScript 漸進遷移

**Phase 1（現在就能開始，不改任何基礎設施）：**

對核心資料結構加 JSDoc typedef，讓 VS Code 的 TypeScript Language Server 介入：

```javascript
// types.js (新檔案，純 JSDoc typedef，不是 .ts)

/** @typedef {'pending'|'dispatched'|'in_progress'|'completed'|'blocked'|'reviewing'|'approved'|'needs_revision'} TaskStatus */

/** @typedef {{
 *   id: string,
 *   title: string,
 *   status: TaskStatus,
 *   assignee?: string,
 *   steps?: Step[],
 *   budget?: Budget,
 *   dispatch?: DispatchState,
 *   history: HistoryEntry[],
 * }} Task */

/** @typedef {'queued'|'running'|'succeeded'|'failed'|'dead'|'cancelled'} StepState */

/** @typedef {{
 *   step_id: string,
 *   run_id: string,
 *   type: string,
 *   state: StepState,
 *   attempt: number,
 *   locked_by?: string,
 *   lock_expires_at?: string,
 *   retry_policy: RetryPolicy,
 * }} Step */

/** @typedef {{
 *   message: string,
 *   timeoutSec: number,
 *   modelHint: string|null,
 *   workingDir: string,
 *   sessionId?: string,
 *   runtimeHint?: string,
 *   onActivity?: () => void,
 * }} DispatchPlan */
```

使用時只需一行 import：

```javascript
/** @type {import('./types').Task} */
const task = board.taskPlan.tasks.find(t => t.id === taskId);
```

**Phase 2（Territory 開始前）：**

改 `jsconfig.json`（或 `tsconfig.json` with `allowJs: true, checkJs: true`），啟用整個專案的型別檢查：

```json
{
  "compilerOptions": {
    "checkJs": true,
    "allowJs": true,
    "strict": false,
    "noEmit": true,
    "target": "ES2022",
    "module": "commonjs"
  },
  "include": ["server/**/*.js"]
}
```

**Phase 3（可選，不急）：**

核心模組逐步從 `.js` 改成 `.ts`。從依賴最少的開始：`step-schema.ts` → `route-engine.ts` → `context-compiler.ts`。

---

## 問題 2：零依賴在基礎設施層變成負債

### 現狀

| 手刻的基礎設施 | 程式碼位置 | 行數 | 成熟方案 |
|---------------|-----------|------|----------|
| HTTP routing + CORS + MIME | `blackboard-server.js` | ~470 行 | express/fastify |
| JSON 檔案原子寫入 | `storage-json.js` | ~56 行 | better-sqlite3 (ACID) |
| SSE 管理 | `blackboard-server.js` | ~80 行 | 自寫的夠用 |
| Rate limiter | `rate-limiter.js` | ~60 行 | 自寫的夠用 |
| Test runner | 每個 test 檔案自帶 | 分散 | `node:test`（內建） |
| Job queue（#214 之後要寫） | 不存在 | 預估 ~300 行 | bull/bee-queue |

### 分析：哪些該繼續手刻，哪些不該

**繼續手刻（成本低、風險可控）：**

- HTTP routing — 現有的 pattern 已經夠用，route 模組加起來不到 20 個。fastify 引入的複雜度不值得。
- SSE — 邏輯簡單，broadcast + client tracking。
- Rate limiter — ~60 行 token bucket，夠用。

**應該用成熟方案（自己寫有 bug 風險）：**

- **JSON 檔案儲存 → better-sqlite3** — 現在的「讀→改→寫整個 JSON」在 30 agent 併發下會出 race condition。`fs.renameSync` 在 Windows 上不是真正的 atomic（如果目標檔案被其他 process 讀取中，會 fail）。SQLite 的 WAL mode 天然解決這個問題。
- **Test runner → `node:test`** — Node 22 內建的 test runner，不算外部依賴。支援 `describe/it`、`assert`、`--watch`、coverage report。現在每個 test 檔案自帶 `ok()/fail()` 是技術債。
- **Job queue** — 如果寫 async dispatch（`design-async-dispatch.md`），自己寫 queue 的持久化 + crash recovery + 併發控制是巨大的 bug 來源。但如果 Village 規模不需要 async dispatch，可以暫時不引入。

### 解決方案：分層放寬

```
┌─────────────────────────────────────────────────┐
│  應用層（保持零依賴）                              │
│  management.js, kernel.js, route-engine.js,      │
│  step-worker.js, context-compiler.js             │
│  → 純 Node.js 內建模組，不引入任何外部套件          │
├─────────────────────────────────────────────────┤
│  基礎設施層（允許最小依賴）                         │
│  storage → better-sqlite3（1 個 C addon）         │
│  test → node:test（Node 22 內建）                 │
│  queue → 視 Territory 需求決定                    │
│  → 只允許成熟、維護良好、最小 API surface 的方案     │
├─────────────────────────────────────────────────┤
│  Node.js 內建模組                                │
│  http, fs, path, child_process, crypto, os       │
│  → 永遠不需要外部替代                              │
└─────────────────────────────────────────────────┘
```

**規則：**
1. 應用邏輯永遠零依賴
2. 基礎設施可用外部方案，但必須：無 transitive dependency（或 < 3 個）、actively maintained、有 TypeScript types
3. `node:test` 不算外部依賴（Node 22 內建）
4. 每引入一個依賴需要記錄 edda decision + 理由

---

## 問題 3：單檔案膨脹

### 現狀

超過 500 行的檔案：

| 檔案 | 行數 | 職責 |
|------|------|------|
| `routes/tasks.js` | **2009** | 任務 CRUD + dispatch + worktree + auto-dispatch + Nox batch |
| `management.js` | **1093** | controls + lessons + dispatch builder + pipeline template + model mapping + edda |
| `smoke-test.js` | 872 | 端到端測試 |
| `timeline-task.js` | 850 | timeline 產生 |
| `integration-jira.js` | 816 | Jira 雙向同步 |
| `step-worker.js` | 705 | step 執行 + post-check + preflight + contract validation |
| `kernel.js` | 514 | step 事件路由 + revision loop + task lifecycle |
| `routes/chat.js` | 516 | conversation + turn dispatch |

### 最需要拆的：`routes/tasks.js`（2009 行）和 `management.js`（1093 行）

**`routes/tasks.js` 拆分方案：**

```
routes/tasks.js (2009 行)
  → routes/tasks/index.js        — route 入口，dispatch 到子模組
  → routes/tasks/crud.js         — task CRUD (create, update status, delete)
  → routes/tasks/dispatch.js     — tryAutoDispatch, redispatchTask, dispatch flow
  → routes/tasks/worktree.js     — worktree 建立和清理
  → routes/tasks/nox.js          — Nox bulk dispatch
  → routes/tasks/_shared.js      — 共用的 participant lookup, push helpers
```

**`management.js` 拆分方案：**

```
management.js (1093 行)
  → management/index.js          — re-export
  → management/controls.js       — controls CRUD, validation, defaults
  → management/lessons.js        — matchLessonsForTask, lesson matching
  → management/dispatch-builder.js — buildDispatchPlan, buildTaskDispatchMessage, buildRedispatchMessage
  → management/pipeline.js       — pipeline template resolution
  → management/model-map.js      — AGENT_MODEL_MAP, preferredModelFor
  → management/edda.js           — loadEddaDecisions, buildProtectedDecisionsSection
```

### 時機

不需要專門排期。在做 #218（dispatch convergence）時順手拆 `routes/tasks.js`，因為那次改動本身就要重寫 dispatch 流程。`management.js` 在做 lesson 有效性驗證時順手拆。

---

## 問題 4：測試基礎設施

### 現狀

每個 test 檔案自帶 runner：

```javascript
// 每個 test-*.js 都重複這些
let passed = 0, failed = 0;
function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }
```

沒有：
- 統一的 test runner（每個檔案獨立跑 `node server/test-xxx.js`）
- Coverage report
- Watch mode
- Before/after hooks
- Test isolation（test 之間共享全域狀態）

### 解決方案：遷移到 `node:test`

Node 22 內建的 `node:test` 模組，不算外部依賴：

```javascript
// 遷移後的 test-step-schema.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const stepSchema = require('./step-schema');

describe('step-schema', () => {
  describe('createStep', () => {
    it('returns correct defaults', () => {
      const step = stepSchema.createStep('T-00001', 'run-abc', 'plan');
      assert.strictEqual(step.state, 'queued');
    });
  });

  describe('transitionStep', () => {
    it('queued → running', () => {
      const step = stepSchema.createStep('T-1', 'run-1', 'plan');
      stepSchema.transitionStep(step, 'running', { locked_by: 'test' });
      assert.strictEqual(step.state, 'running');
    });

    it('rejects invalid transition', () => {
      const step = stepSchema.createStep('T-1', 'run-1', 'plan');
      assert.throws(() => stepSchema.transitionStep(step, 'succeeded'));
    });
  });
});
```

跑法：`node --test server/test-*.js`

附贈：`--experimental-test-coverage` flag 免費拿到 coverage。

### 時機

不急。新寫的 test 直接用 `node:test`，舊 test 有空時遷移。兩種格式可以共存。

---

## 問題 5：Windows 開發的隱性成本

### 現狀

Karvi 是 Windows-first 開發（`process.platform === 'win32'` 分支在 5 個 runtime adapter 裡都有）。

| Windows 特有處理 | 位置 |
|-----------------|------|
| `cmd.exe /d /s /c` spawn pattern | 所有 runtime adapter |
| `.cmd` shim detection（`where opencode`） | `runtime-opencode.js:24-41` |
| `taskkill /PID /T /F` kill tree | 所有 runtime adapter |
| `fs.renameSync` 不保證 atomic | `storage-json.js` |
| path separator `\` vs `/` | 分散在各處 |

### 風險

這些不是 bug，但每加一個新模組都要記得處理 Windows 差異。Territory 的 multi-board 如果用 filesystem path routing，Windows 的 path handling 會更複雜。

### 建議

抽一個 `platform.js` 工具模組：

```javascript
// platform.js
const IS_WIN = process.platform === 'win32';

function killTree(pid) { ... }  // 目前分散在 5 個 runtime 裡
function spawnCli(cmd, args, opts) { ... }  // cmd.exe wrapping
function atomicWrite(filePath, data) { ... }  // .tmp + rename
```

目前 `killTree` 在每個 runtime adapter 裡各寫了一次，完全相同的程式碼複製了 5 份。

---

## 總結：不需要做的 vs 需要做的

### 不需要做

- ❌ 換語言（Go/Rust/Python）— Node.js 的 async I/O 完美適合這個場景
- ❌ 引入 Express/Fastify — 現有 routing 夠用，引入的複雜度不值得
- ❌ 一次性全面重構 — 會停擺所有功能開發

### 需要做（按優先序）

| 優先 | 動作 | 時機 | 影響 |
|------|------|------|------|
| **P0** | JSDoc typedef for Board/Task/Step/Controls | 現在 | 所有模組受益，防止 schema 改動炸掉 |
| **P1** | `node:test` — 新 test 直接用 | 現在 | 免費拿到 coverage + watch |
| **P1** | `platform.js` — 抽共用的 killTree/spawnCli | 下次改 runtime 時 | 消除 5 份重複程式碼 |
| **P2** | 拆 `routes/tasks.js` | #218 dispatch convergence 時 | 2009 行 → 5 個 ~400 行檔案 |
| **P2** | 拆 `management.js` | lesson 驗證 issue 時 | 1093 行 → 6 個 ~180 行檔案 |
| **P3** | `storage-json.js` → `better-sqlite3` | Territory 開始前 | 解決併發寫入 race condition |
| **P3** | `tsconfig.json` with `checkJs: true` | JSDoc 覆蓋率 > 50% 後 | 全專案型別檢查 |
