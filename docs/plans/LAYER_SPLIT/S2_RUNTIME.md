# S2: 建立 runtime-openclaw.js

## 目標

從 `server.js` 抽出所有 OpenClaw 相關的程序派生邏輯。

## 前置條件

- 讀完 `00_OVERVIEW.md`

## 建檔：`project/task-engine/runtime-openclaw.js`

### 步驟

1. 建立 `runtime-openclaw.js`，開頭：

```javascript
const { spawn } = require('child_process');
const path = require('path');

const DIR = __dirname;
const OPENCLAW_CMD = process.env.OPENCLAW_CMD || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
const PROCESS_REVIEW = path.join(DIR, 'process-review.js');
```

2. 從 `server.js` **剪下**以下函式：

| 原始行號 | 函式 |
|---------|------|
| 817-840 | `function extractReplyText(obj, fallback = '')` |
| 841-848 | `function extractSessionId(obj)` |
| 850-909 | `function runOpenclawTurn({ agentId, sessionId, message, timeoutSec = 180 })` |
| 597-632 | `function spawnReview(taskId)` |

3. `spawnReview` 的改造：

原始的 `spawnReview` 用了 `ctx.boardPath`、`readBoard`、`broadcastSSE`、`getControls`、`redispatchTask` —— 這些都是 server.js 的東西。

改成接收 callback：

```javascript
function spawnReview(taskId, options = {}) {
  const boardPath = options.boardPath || path.join(DIR, 'board.json');
  const onComplete = options.onComplete || (() => {});
  
  const args = ['--task', taskId, '--board', boardPath];
  console.log(`[review] spawning: node process-review.js ${args.join(' ')}`);
  
  const child = spawn('node', [PROCESS_REVIEW, ...args], {
    cwd: DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => process.stdout.write(`[review:${taskId}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[review:${taskId}] ${d}`));
  
  child.on('close', code => {
    console.log(`[review:${taskId}] exit ${code}`);
    onComplete(code);
  });
  
  child.unref();
}
```

server.js 那邊改成：
```javascript
runtime.spawnReview(taskId, {
  boardPath: ctx.boardPath,
  onComplete: (code) => {
    const updatedBoard = readBoard();
    broadcastSSE('board', updatedBoard);
    // ... auto-redispatch 邏輯留在 server.js ...
  },
});
```

4. `module.exports`：

```javascript
module.exports = {
  runOpenclawTurn,
  spawnReview,
  extractReplyText,
  extractSessionId,
};
```

## 注意事項

- `runOpenclawTurn` 是完全自包含的（只依賴 OPENCLAW_CMD + child_process），搬出來零風險。
- `extractReplyText` 和 `extractSessionId` 是純函式（解析 JSON），可以在任何地方用。
- `spawnReview` 需要做 callback 改造，因為原始版本直接呼叫了 server.js 的 `readBoard` 等函式。改造後由 server.js 透過 `onComplete` callback 處理後續。

## 驗證

```bash
node -c runtime-openclaw.js
node -e "const r = require('./runtime-openclaw'); console.log(Object.keys(r).length, 'exports')"
# 應輸出 4 exports
```
