# S1: 建立 management.js

## 目標

從 `server.js` 抽出所有純決策邏輯，建立 `management.js`。

## 前置條件

- 讀完 `00_OVERVIEW.md` 的分割地圖

## 建檔：`project/task-engine/management.js`

### 步驟

1. 建立 `management.js`，開頭：

```javascript
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
```

2. 從 `server.js` **剪下**以下區塊（按原始順序），**貼到** `management.js`：

| 原始行號 | 要搬的內容 |
|---------|-----------|
| 27-35 | `const DEFAULT_CONTROLS = { ... };` |
| 37-40 | `VALID_ACTION_TYPES`, `VALID_RISK_LEVELS`, `VALID_LESSON_STATUSES` |
| 42-47 | `function ensureEvolutionFields(board)` |
| 51-81 | `function applyInsightAction(board, insight)` |
| 83-89 | `function snapshotControls(currentControls, patchPayload)` |
| 91-163 | `function autoApplyInsights(board)` |
| 165-278 | `function verifyAppliedInsights(board)` |
| 280-290 | `const AGENT_MODEL_MAP = { ... }; function preferredModelFor(agentId)` |
| 293-295 | `function getControls(board)` |
| 299-325 | `const ALLOWED_TASK_TRANSITIONS = { ... }; function canTransitionTaskStatus; function ensureTaskTransition` |
| 328-392 | `function parseTaskResultFromLastLine(replyText)` |
| 394-405 | `function readSpecContent(specRelPath)` |
| 407-423 | `function gatherUpstreamArtifacts(board, task)` |
| 425-531 | `function buildTaskDispatchMessage(board, task, options = {})` |
| 533-594 | `function buildRedispatchMessage(board, task)` |
| 727-743 | `function autoUnlockDependents(board)` |

3. 處理依賴：

- `buildTaskDispatchMessage` 和 `buildRedispatchMessage` 內部用到 `nowIso()` 和 `uid()` — 從 `blackboard-server` 引入：
  ```javascript
  const bb = require('../blackboard-server');
  const { nowIso, uid } = bb;
  ```

- `readSpecContent` 和 `gatherUpstreamArtifacts` 用到 `DIR` 和 `WORKSPACE`：
  ```javascript
  const SKILLS_DIR = path.join(DIR, 'skills');
  const WORKSPACE = path.resolve(DIR, '..', '..');
  ```

- `autoApplyInsights` 和 `verifyAppliedInsights` 內部呼叫 `applyInsightAction`, `snapshotControls`, `getControls`, `ensureEvolutionFields` — 這些都在同檔案內，不需要額外 import。

4. 在檔案末尾加 `module.exports`：

```javascript
module.exports = {
  DEFAULT_CONTROLS,
  VALID_ACTION_TYPES,
  VALID_RISK_LEVELS,
  VALID_LESSON_STATUSES,
  AGENT_MODEL_MAP,
  ALLOWED_TASK_TRANSITIONS,
  ensureEvolutionFields,
  applyInsightAction,
  snapshotControls,
  autoApplyInsights,
  verifyAppliedInsights,
  preferredModelFor,
  getControls,
  canTransitionTaskStatus,
  ensureTaskTransition,
  parseTaskResultFromLastLine,
  readSpecContent,
  gatherUpstreamArtifacts,
  buildTaskDispatchMessage,
  buildRedispatchMessage,
  autoUnlockDependents,
};
```

## 注意事項

- `autoApplyInsights` 內有 `console.log('[gate]...')`：保留，這是運行日誌。
- `verifyAppliedInsights` 內有 `console.log('[verify]...')`：保留。
- **不改任何函式邏輯**，只搬位置。
- management.js 不 import `child_process`，不 import server 的 `ctx`。

## 驗證

```bash
node -c management.js
node -e "const m = require('./management'); console.log(Object.keys(m).length, 'exports')"
# 應輸出 21 exports
```
