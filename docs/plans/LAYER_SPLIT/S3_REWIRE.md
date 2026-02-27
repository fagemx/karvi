# S3: server.js 改為薄殼

## 目標

server.js 改成只做三件事：
1. 初始化 blackboard-server context
2. 編排（串接 management + runtime）
3. HTTP 路由

## 前置條件

- S1（management.js 存在）
- S2（runtime-openclaw.js 存在）

## 步驟

### 1. 修改 server.js 開頭 imports

刪掉已搬走的函式，改成 require：

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const mgmt = require('./management');
const runtime = require('./runtime-openclaw');

const DIR = __dirname;

const ctx = bb.createContext({
  dir: DIR,
  boardPath: path.join(DIR, 'board.json'),
  logPath: path.join(DIR, 'task-log.jsonl'),
  port: Number(process.env.PORT || 3461),
  boardType: 'task-engine',
});

const { nowIso, uid, json } = bb;
const readBoard = () => bb.readBoard(ctx);
const writeBoard = (b) => bb.writeBoard(ctx, b);
const appendLog = (e) => bb.appendLog(ctx, e);
const broadcastSSE = (ev, d) => bb.broadcastSSE(ctx, ev, d);
```

注意：不再需要 `const { spawn } = require('child_process')`（已在 runtime 裡）。
不再需要 `OPENCLAW_CMD`、`SKILLS_DIR`、`PROCESS_REVIEW`、`WORKSPACE`。

### 2. 刪除已搬走的函式

刪除以下區塊（已在 management.js 或 runtime-openclaw.js）：

- `DEFAULT_CONTROLS` → 改用 `mgmt.DEFAULT_CONTROLS`
- `VALID_ACTION_TYPES` 等 → 改用 `mgmt.VALID_*`
- `ensureEvolutionFields` → `mgmt.ensureEvolutionFields`
- `applyInsightAction` → `mgmt.applyInsightAction`
- `snapshotControls` → `mgmt.snapshotControls`
- `autoApplyInsights` → `mgmt.autoApplyInsights`
- `verifyAppliedInsights` → `mgmt.verifyAppliedInsights`
- `AGENT_MODEL_MAP` → `mgmt.AGENT_MODEL_MAP`
- `preferredModelFor` → `mgmt.preferredModelFor`
- `getControls` → `mgmt.getControls`
- `ALLOWED_TASK_TRANSITIONS` → `mgmt.ALLOWED_TASK_TRANSITIONS`
- `canTransitionTaskStatus` → `mgmt.canTransitionTaskStatus`
- `ensureTaskTransition` → `mgmt.ensureTaskTransition`
- `parseTaskResultFromLastLine` → `mgmt.parseTaskResultFromLastLine`
- `readSpecContent` → `mgmt.readSpecContent`
- `gatherUpstreamArtifacts` → `mgmt.gatherUpstreamArtifacts`
- `buildTaskDispatchMessage` → `mgmt.buildTaskDispatchMessage`
- `buildRedispatchMessage` → `mgmt.buildRedispatchMessage`
- `autoUnlockDependents` → `mgmt.autoUnlockDependents`
- `runOpenclawTurn` → `runtime.runOpenclawTurn`
- `spawnReview` → `runtime.spawnReview`
- `extractReplyText` → `runtime.extractReplyText`
- `extractSessionId` → `runtime.extractSessionId`

### 3. 全域替換呼叫點

在 server.js 裡，所有呼叫上述函式的地方加上前綴。

高頻呼叫（用全域替換處理）：

| 搜尋 | 替換 | 出現次數（估） |
|------|------|-------------|
| `getControls(` | `mgmt.getControls(` | ~8 |
| `ensureEvolutionFields(` | `mgmt.ensureEvolutionFields(` | ~6 |
| `autoApplyInsights(` | `mgmt.autoApplyInsights(` | ~3 |
| `verifyAppliedInsights(` | `mgmt.verifyAppliedInsights(` | ~2 |
| `ensureTaskTransition(` | `mgmt.ensureTaskTransition(` | ~5 |
| `canTransitionTaskStatus(` | `mgmt.canTransitionTaskStatus(` | ~2 |
| `parseTaskResultFromLastLine(` | `mgmt.parseTaskResultFromLastLine(` | ~2 |
| `buildTaskDispatchMessage(` | `mgmt.buildTaskDispatchMessage(` | ~2 |
| `buildRedispatchMessage(` | `mgmt.buildRedispatchMessage(` | ~1 |
| `autoUnlockDependents(` | `mgmt.autoUnlockDependents(` | ~3 |
| `preferredModelFor(` | `mgmt.preferredModelFor(` | ~3 |
| `readSpecContent(` | `mgmt.readSpecContent(` | ~1 |
| `gatherUpstreamArtifacts(` | `mgmt.gatherUpstreamArtifacts(` | ~1 |
| `applyInsightAction(` | `mgmt.applyInsightAction(` | ~1 |
| `snapshotControls(` | `mgmt.snapshotControls(` | ~1 |
| `runOpenclawTurn(` | `runtime.runOpenclawTurn(` | ~3 |
| `extractReplyText(` | `runtime.extractReplyText(` | ~3 |
| `extractSessionId(` | `runtime.extractSessionId(` | ~3 |

**注意**：搜尋時要確認是函式呼叫，不是函式定義（定義已被刪）。

### 4. 改造 spawnReview 呼叫點

原始 `spawnReview(taskId)` 內部用了 `ctx.boardPath`、`readBoard`、`broadcastSSE`、`getControls`、`redispatchTask`。

改成：
```javascript
runtime.spawnReview(taskId, {
  boardPath: ctx.boardPath,
  onComplete: (code) => {
    try {
      const updatedBoard = readBoard();
      broadcastSSE('board', updatedBoard);
      const ctrl = mgmt.getControls(updatedBoard);
      const task = (updatedBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
      if (
        ctrl.auto_redispatch &&
        task &&
        task.status === 'needs_revision' &&
        (task.reviewAttempts || 0) < ctrl.max_review_attempts
      ) {
        console.log(`[review:${taskId}] auto-redispatch triggered`);
        setImmediate(() => redispatchTask(updatedBoard, task));
      }
    } catch (err) {
      console.error(`[review:${taskId}] post-review error: ${err.message}`);
    }
  },
});
```

### 5. 處理 HTTP 路由中的常數引用

路由裡有些地方直接用了 `VALID_ACTION_TYPES`、`VALID_RISK_LEVELS`、`DEFAULT_CONTROLS` 等常數。改成 `mgmt.VALID_ACTION_TYPES` 等。

具體位置（搜 `/api/controls` 路由的 `allowed`）：
```javascript
// 原本：
const allowed = Object.keys(DEFAULT_CONTROLS);
// 改成：
const allowed = Object.keys(mgmt.DEFAULT_CONTROLS);
```

### 6. 保留 `const processing = new Map()`

`processing` 是 processQueue 的狀態鎖，留在 server.js（編排層）。

## 驗證

```bash
node -c server.js
# 啟動 server 確認沒 crash
node server.js &
# smoke test
node ../../smoke-test.js 3461
# evolution loop test（先清 board）
node test-evolution-loop.js
```

## 完成後的 server.js 結構

```
server.js (~1300 行)
  ├── require('./management')
  ├── require('./runtime-openclaw')
  ├── blackboard-server context
  ├── conversation helpers (normalizeText, conversationById, etc.)
  ├── redispatchTask() — 編排
  ├── processQueue() — 編排
  └── HTTP routes (1097+)
```
