# T1: Evolution API Foundation

> Batch 1（必須最先完成）
> 改動檔案：`project/task-engine/server.js`
> 預估：2-3 小時

---

## 開始前

```bash
# Step 1: 讀契約（必讀）
cat project/CONTRACT.md
cat project/task-engine/docs/plans/EVOLUTION_LAYER/CONTRACT.md

# Step 2: 讀設計哲學（建議）
cat project/task-engine/docs/blackboard-evolution.md

# Step 3: 確認現有 server.js 可跑
cd project/task-engine && node -c server.js

# Step 4: 讀本文件，執行下方步驟
```

---

## 最終結果

- `board.json` 自動包含 `signals[]`、`insights[]`、`lessons[]` 三個陣列
- 8 個新 API endpoint 可正常讀寫
- 現有所有 API 不受影響
- `node -c server.js` 通過
- `node project/smoke-test.js 3461 /api/signals` 通過

---

## 實作步驟

### Step 1: board.json 初始化保護

**位置**：`server.js` 頂部，`ctx` 建立之後、API 路由之前

**改動**：新增一個 `ensureEvolutionFields(board)` 函數，確保 board 一定有三個陣列。

```js
function ensureEvolutionFields(board) {
  if (!Array.isArray(board.signals)) board.signals = [];
  if (!Array.isArray(board.insights)) board.insights = [];
  if (!Array.isArray(board.lessons)) board.lessons = [];
  return board;
}
```

在 `readBoard()` 的所有呼叫點之後呼叫此函數是不切實際的。改為在 server 啟動時執行一次初始化：

```js
// server 啟動初始化（放在 listen 之前）
try {
  const initBoard = readBoard();
  let dirty = false;
  if (!Array.isArray(initBoard.signals)) { initBoard.signals = []; dirty = true; }
  if (!Array.isArray(initBoard.insights)) { initBoard.insights = []; dirty = true; }
  if (!Array.isArray(initBoard.lessons)) { initBoard.lessons = []; dirty = true; }
  if (dirty) writeBoard(initBoard);
} catch {}
```

**注意**：不要修改 `readBoard` 函數本身（它是 blackboard-server 的 wrapper）。

### Step 2: Signal API（2 個 endpoint）

**位置**：`server.js` 的 route handler 區塊

**`GET /api/signals`**

```
回傳 board.signals 陣列。
支援 query param ?type=xxx 篩選。
支援 query param ?limit=N 限制筆數（預設 100）。
回傳順序：最新在前（依 ts 降序）。
```

**`POST /api/signals`**

```
接收 body: { by, type, content, refs?, data? }
自動生成 id (sig-<timestamp>-<random>) 和 ts。
push 到 board.signals。
如果 signals.length > 500，截斷最舊的。
writeBoard() 確保 SSE 推送。
回傳 201 { ok: true, signal: <新增的 signal> }。
```

### Step 3: Insight API（3 個 endpoint）

**`GET /api/insights`**

```
回傳 board.insights 陣列。
支援 ?status=pending 篩選。
支援 ?limit=N。
回傳順序：最新在前。
```

**`POST /api/insights`**

```
接收 body: { by, about?, judgement, reasoning?, suggestedAction, risk }
驗證 suggestedAction.type 是 CONTRACT 定義的 4 種之一。
驗證 risk 是 low/medium/high 之一。
自動生成 id + ts。
status 預設 'pending'。
push 到 board.insights。
writeBoard()。
回傳 201。
```

**`POST /api/insights/:id/apply`**

```
找到指定 insight。
如果 insight.status !== 'pending'，回 400。
根據 suggestedAction.type 執行：
  - controls_patch: Object.assign(board.controls, payload)
  - dispatch_hint: board.controls.dispatch_hints = [..., payload]
  - lesson_write: push 新 lesson 到 board.lessons
  - noop: 不做事
將 insight.status 改為 'applied'。
寫一筆 signal 記錄這次 apply（by: 'gate', type: 'insight_applied'）。
writeBoard()。
回傳 200 { ok: true, applied: suggestedAction }。
```

**注意**：這裡的 apply 是手動觸發（從 UI 或 API call）。自動 apply 的 gate 邏輯在 T5。

### Step 4: Lesson API（3 個 endpoint）

**`GET /api/lessons`**

```
回傳 board.lessons 陣列。
支援 ?status=active 篩選。
回傳順序：最新在前。
```

**`POST /api/lessons`**

```
接收 body: { by, rule, fromInsight?, effect?, status? }
status 預設 'active'。
自動生成 id + ts。
push 到 board.lessons。
如果 lessons.length > 100，把 status 為 invalidated/superseded 的移到 board.lessons_archive（如不存在則建立）。
writeBoard()。
回傳 201。
```

**`POST /api/lessons/:id/status`**

```
接收 body: { status, supersededBy? }
驗證 status 是 active/validated/invalidated/superseded 之一。
如果 status === 'validated'，設 validatedAt = now。
如果 status === 'superseded'，設 supersededBy。
writeBoard()。
回傳 200。
```

### Step 5: Server-Side Signal Auto-Emit

在 server.js 的現有邏輯中，於以下時機自動寫入 signal：

**5a. 任務狀態轉移**

位置：處理 `POST /api/tasks/:id/status` 的地方，狀態成功轉移後。

```js
board.signals.push({
  id: uid('sig'),
  ts: nowIso(),
  by: 'server.js',
  type: 'status_change',
  content: `${task.id} ${oldStatus} → ${newStatus}`,
  refs: [task.id],
  data: { taskId: task.id, from: oldStatus, to: newStatus, assignee: task.assignee }
});
```

**不要在每次 writeBoard 都 emit signal**，只在有意義的狀態轉移時。

**5b. Dispatch 失敗**

位置：`runOpenclawTurn` 的 catch handler 或 error 分支。

```js
board.signals.push({
  id: uid('sig'),
  ts: nowIso(),
  by: 'server.js',
  type: 'error',
  content: `${task.id} dispatch failed: ${error.message}`,
  refs: [task.id],
  data: { taskId: task.id, error: error.message }
});
```

**5c. 任務 blocked**

位置：狀態轉移到 `blocked` 時（5a 已涵蓋，但 data 增加 reason）。

### Step 6: 自檢

```bash
# 語法檢查
node -c server.js

# 啟動 server（確保不 crash）
node server.js &
sleep 2

# 測試 signal API
curl -s http://localhost:3461/api/signals | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const a=JSON.parse(d);console.log('signals:', Array.isArray(a), a.length)"

curl -s -X POST http://localhost:3461/api/signals -H "Content-Type: application/json" -d '{"by":"test","type":"test","content":"test signal"}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d))"

# 測試 insight API
curl -s -X POST http://localhost:3461/api/insights -H "Content-Type: application/json" -d '{"by":"test","judgement":"test insight","suggestedAction":{"type":"noop","payload":{}},"risk":"low"}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d))"

# 測試 lesson API
curl -s -X POST http://localhost:3461/api/lessons -H "Content-Type: application/json" -d '{"by":"test","rule":"test lesson"}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d))"

# 確認 board.json 有三個陣列
node -e "const b=require('./board.json'); console.log('signals:', b.signals.length, 'insights:', b.insights.length, 'lessons:', b.lessons.length)"
```

**Windows PowerShell 版本**（agent 在 Windows 環境時使用）：

```powershell
node -c server.js
Invoke-RestMethod -Uri "http://localhost:3461/api/signals" -Method GET
Invoke-RestMethod -Uri "http://localhost:3461/api/signals" -Method POST -ContentType "application/json" -Body '{"by":"test","type":"test","content":"test signal"}'
```
