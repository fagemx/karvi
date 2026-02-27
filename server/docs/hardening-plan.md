# Task Engine 強化計畫 ✅ COMPLETED

> 目標：把 task-engine 打磨到跟 brief-panel 一樣穩。
> 原則：不做大重寫，四個 phase 逐步收斂。
> 完成日期：2025-02-24

## 實施紀錄

| Phase | 狀態 | 實施內容 |
|-------|------|----------|
| Phase 1 | ✅ | controls 外部化到 board.json，GET/POST `/api/controls`，UI 面板 |
| Phase 2 | ✅ | LLM 回傳 score (0-100)，程式碼比較 threshold 判定 pass/fail |
| Phase 3 | ✅ | `process-review.js` 原子腳本，server.js 只 spawn，不再內嵌 review |
| Phase 4 | ✅ | `blackboard-server.js` 共用骨架 + task-engine 完整切換使用 |

### 新增檔案
- `project/task-engine/process-review.js` — 獨立 review 腳本
- `project/blackboard-server.js` — 共用 server core

### server.js 變化
- 刪除 321 行 review 邏輯（1815 → 1494 行）
- 新增 `/api/controls` (GET/POST)
- 新增 `/api/tasks/:id/review` (手動觸發 review)
- auto-review 改用 `spawnReview()` 呼叫外部腳本
- 切換至 `blackboard-server.js` 共用核心（1494 → 1407 行）
  - 刪除：http import、MIME、sseClients、broadcastSSE、nowIso、uid、readBoard、writeBoard、appendLog、json、serveStatic
  - 改用：`bb.createServer(ctx, routeHandler)` + `bb.listen(server, ctx)`
  - CORS、SSE、`/api/board`、`/api/events`、static files 全部由 bb 處理
  - BOARD_PATH → `ctx.boardPath`、PORT → `ctx.port`

### UI 變化
- 側邊欄新增 Review Controls 面板
- Task Card 顯示 score/100 + threshold + source
- needs_revision 和 completed 狀態新增 🔍 手動審查按鈕

---

## 問題根源

| | brief-panel（穩） | task-engine（不穩） |
|---|---|---|
| server.js | 167 行 | 1700 行 |
| 智慧在哪 | 外部腳本（process-brief.js） | 全塞在 server.js |
| LLM 的角色 | 只做內容（生圖） | 做控制（review → pass/fail → approved） |
| 設定在哪 | brief.json controls | server.js const |
| 原子性 | process-brief.js 一個 process 完成 | 多步驟 async，中斷會卡住 |

**一句話：brief-panel 把「判斷」和「控制」分開了，task-engine 沒有。**

---

## Phase 1：Controls 外部化

**做什麼：** 把硬寫在 server.js 的設定搬到 board.json。

### board.json 新增 controls 區塊

```json
{
  "controls": {
    "auto_review": true,
    "max_review_attempts": 3,
    "quality_threshold": 70,
    "review_timeout_sec": 180,
    "review_agent": "engineer_lite",
    "on_review_fail": "needs_revision",
    "on_max_attempts": "needs_revision"
  }
}
```

### server.js 改動

```javascript
// 前
const MAX_REVIEW_ATTEMPTS = 3;

// 後
function getControls(board) {
  const defaults = {
    auto_review: true,
    max_review_attempts: 3,
    quality_threshold: 70,
    review_timeout_sec: 180,
    review_agent: 'engineer_lite',
    on_review_fail: 'needs_revision',
    on_max_attempts: 'needs_revision',
  };
  return { ...defaults, ...(board.controls || {}) };
}
```

### UI 改動

- 在 Task Board 加一個「Settings」摺疊區塊
- 顯示 controls 欄位，可即時編輯
- 改動即時 POST /api/controls

### API 新增

```
GET  /api/controls         → 讀取 controls
POST /api/controls         → 更新 controls
```

**驗收：** 從 UI 改 `quality_threshold` → review 結果的 pass/fail 判定跟著變。

**工時：** 半天。

---

## Phase 2：Review = LLM 打分 + 程式碼判定

**做什麼：** LLM 只回傳分數和意見，pass/fail 由程式碼根據 threshold 決定。

### 現在（LLM 做控制）

```
LLM 回覆 → 解析 pass:true/false → approved / needs_revision
```

LLM 直接決定放不放行。

### 之後（LLM 做判斷）

```
LLM 回覆 → 解析 score + issues → 程式碼比較 score vs threshold → approved / needs_revision
```

### Review prompt 改動

```
YOUR OUTPUT MUST END WITH THIS EXACT LINE:
REVIEW_RESULT:{"score":85,"issues":[],"summary":"Looks good"}

Score guide:
  90-100: Production ready, no issues
  70-89:  Minor issues, acceptable
  50-69:  Has problems that should be fixed
  0-49:   Major issues, not acceptable
```

### 判定邏輯

```javascript
function evaluateReview(reviewResult, controls) {
  const score = Number(reviewResult.score);
  if (!Number.isFinite(score)) {
    return { pass: false, reason: 'No valid score from reviewer' };
  }
  if (score >= controls.quality_threshold) {
    return { pass: true, reason: `Score ${score} >= threshold ${controls.quality_threshold}` };
  }
  return {
    pass: false,
    reason: `Score ${score} < threshold ${controls.quality_threshold}`,
    issues: reviewResult.issues || [],
  };
}
```

### UI 改動

- Task card 上顯示 review score（圓環或數字）
- 分數色條：綠 >= 90 / 黃 >= 70 / 紅 < 70
- 點擊展開完整 review report

**關鍵差異：**
- 人可以調整 threshold（Phase 1 的 controls UI）
- 同一份 review，threshold 改了，結論就變了
- LLM 的職責從「判官」降格為「評估員」

**驗收：** reviewer 給 75 分，threshold 設 80 → needs_revision。threshold 改 70 → approved。控制在人手上。

**工時：** 1 天。

---

## Phase 3：原子化 Review 腳本（process-review.js）

**做什麼：** 把 review 邏輯從 server.js 抽出來，變成獨立腳本。

### 為什麼

brief-panel 之所以穩，是因為 `process-brief.js` 把「讀 → 處理 → 寫」放在同一個 process 裡，不會被打斷。

task-engine 的 review 是 server.js 裡的 async callback，中間 readBoard() / writeBoard() 可能被其他請求交錯，server restart 會讓 review 卡在 `reviewing` 狀態。

### process-review.js 設計

```bash
node process-review.js                    # 處理所有 completed
node process-review.js --task T3          # 只處理 T3
node process-review.js --dry-run          # 預覽
node process-review.js --skip-llm         # 只跑 deterministic
node process-review.js --threshold 80     # 臨時覆蓋 threshold
```

### 內部流程

```
1. 讀 board.json
2. 讀 controls
3. 找 status === 'completed' 的 tasks
4. 對每個 task：
   a. 確定性預檢（JSON valid, 無外部依賴, 非空檔）
      → 失敗 → needs_revision, 跳過 LLM
   b. LLM review（spawn openclaw agent）
      → 解析 score + issues
   c. evaluateReview(score, threshold)
      → approved / needs_revision
   d. 更新 task 狀態、history、review 結果
5. 備份 board.json.bak
6. 原子寫入 board.json
```

### server.js 改動

```javascript
// 前（server.js 裡 800 行的 review 邏輯）
if (payload.status === 'completed') {
  setImmediate(() => triggerAutoReview(taskId));
}

// 後（10 行）
if (payload.status === 'completed' && getControls(board).auto_review) {
  const script = path.join(DIR, 'process-review.js');
  const args = ['--task', taskId, '--board', BOARD_PATH];
  spawn('node', [script, ...args], { detached: true, stdio: 'ignore' });
}
```

**server.js 的 review 相關函數全部移除：**
- `triggerAutoReview()` → 刪
- `buildReviewFileContext()` → 移到 process-review.js
- `parseReviewResult()` → 移到 process-review.js
- `inferTargetDir()` → 移到 process-review.js
- `activeReviews` Map → 不需要了（腳本本身是原子的）

**預期 server.js 行數：** 1700 → ~900（砍一半）。

**驗收：** 
1. server.js 跑著 → 手動跑 `node process-review.js --task T1` → board.json 更新 → UI 刷新
2. server restart 時有 completed 的 task → 重啟後 review 不會卡住（因為是獨立 process）

**工時：** 1-2 天。

---

## Phase 4：抽共用骨架（blackboard-server-core）

**做什麼：** 把 brief-panel 和 task-engine 共用的 server 邏輯抽成模組。

### 共用部分

兩套 server.js 都做的事：

| 功能 | brief-panel | task-engine |
|---|---|---|
| 讀 JSON | `GET /api/brief` | `GET /api/board` |
| 寫 JSON | `POST /api/brief` | `POST /api/board` (implicit) |
| 觸發 agent | `POST /api/dispatch` | `POST /api/tasks/dispatch` |
| 靜態檔案 | `GET /*` | `GET /*` |
| SSE | (沒有，用 poll) | `GET /api/events` |
| CORS | 有 | 有 |

### 共用模組設計

```
project/shared/blackboard-server.js
```

```javascript
// blackboard-server.js — 共用骨架
function createBlackboardServer(options) {
  const {
    port,
    boardPath,        // board.json 路徑
    logPath,          // log file 路徑  
    staticDir,        // 靜態檔案目錄
    routes = [],      // 自定義路由 [{ method, pattern, handler }]
    onBoardWrite,     // hook: board 寫入後
    enableSSE = false,
  } = options;

  // ... 共用邏輯 ...
  // readBoard, writeBoard, appendLog, json, serveStatic, CORS, SSE
  
  return { server, readBoard, writeBoard, broadcastSSE };
}
```

### 各應用變成

```javascript
// brief-panel/server.js — 變成 ~50 行
const { createBlackboardServer } = require('../../project/shared/blackboard-server');
const { readBoard, writeBoard } = createBlackboardServer({
  port: 3456,
  boardPath: './brief.json',
  staticDir: __dirname,
  routes: [
    { method: 'POST', pattern: '/api/dispatch', handler: handleDispatch },
    { method: 'POST', pattern: '/api/download', handler: handleDownload },
  ],
});
```

```javascript
// task-engine/server.js — 變成 ~400 行（只剩任務邏輯）
const { createBlackboardServer } = require('../shared/blackboard-server');
const { readBoard, writeBoard, broadcastSSE } = createBlackboardServer({
  port: 3461,
  boardPath: './board.json',
  staticDir: __dirname,
  enableSSE: true,
  routes: [
    { method: 'POST', pattern: '/api/tasks', handler: handleCreatePlan },
    { method: 'POST', pattern: '/api/tasks/:id/status', handler: handleTaskStatus },
    { method: 'POST', pattern: '/api/tasks/:id/dispatch', handler: handleTaskDispatch },
    // ...
  ],
});
```

### 新應用（辯證研究室）只需要

```javascript
const { createBlackboardServer } = require('../shared/blackboard-server');
createBlackboardServer({
  port: 3462,
  boardPath: './board.json',
  staticDir: __dirname,
  enableSSE: true,
  routes: [
    { method: 'POST', pattern: '/api/arena/advance', handler: handleAdvance },
    { method: 'POST', pattern: '/api/arena/verdict', handler: handleVerdict },
  ],
});
```

**驗收：** 
1. brief-panel 和 task-engine 都用 blackboard-server.js
2. 新建一個 dialectic-arena 只需 ~100 行 server.js

**工時：** 2-3 天。

---

## 路線圖

```
Phase 1（半天）        Phase 2（1 天）         Phase 3（1-2 天）     Phase 4（2-3 天）
Controls 外部化   →   Score-based review  →   process-review.js  →  共用骨架
                                                                
board.json        →   LLM 只打分          →   原子操作            → blackboard-server.js
有 controls       →   code 做 pass/fail   →   server.js 砍半      → 新應用 < 100 行
UI 可改設定       →   score 色環          →   不怕中斷             → 共用 SSE/CORS/靜態
```

**每個 phase 獨立可用。** 做完 Phase 1 就比現在好。做完 Phase 3 就跟 brief-panel 一樣穩。Phase 4 是未來投資。

---

## 不做的事

- ❌ 大重寫（保留現有 server.js 的 conversation/queue 邏輯）
- ❌ 換資料庫（board.json 夠用）
- ❌ 加框架（零依賴原則不變）
- ❌ 合併 brief-panel 和 task-engine（用途不同，共用骨架就好）
