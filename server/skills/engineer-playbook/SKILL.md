# Skill: Engineer Playbook

> 你被指派了一個任務。按照這個 SOP 執行。

---

## Step 0: 確認環境

你正在 Windows 上工作。以下工具可用：
- `node` (v22+)
- `curl.exe`（注意不是 `curl`，PowerShell 的 `curl` 是 `Invoke-WebRequest` 的 alias）
- `openclaw.cmd`
- 檔案讀寫（`read`, `write`, `edit`）
- Shell 指令（`exec`）

Task Engine 跑在 `http://localhost:3461`。

---

## Step 1: 讀 Spec

你的任務訊息裡會包含 spec 路徑，例如：
```
Spec: project/task-engine/specs/dialectic-arena.md
```

**先讀完 spec 再動手。** Spec 包含：
- 技術背景（你需要知道的架構知識）
- Schema 定義（board.json 長什麼樣）
- API 設計（server 要提供哪些 endpoint）
- UI 設計（畫面佈局、顏色、互動邏輯）
- 驗收標準（做到什麼程度算完成）

---

## Step 2: 讀參考文件

Spec 裡會列出「必須參考的檔案」，通常是：
- 現有的 `server.js` — 看 pattern 怎麼寫
- 現有的 `index.html` — 看 UI pattern（dark theme、SSE client、元件風格）
- `project/CONTRACT.md` — 共用 server 核心的規格
- 相關的規劃文件

**不要自己發明新 pattern。** 照現有的寫法走。

---

## Step 3: 回報「開始」

動手之前，先告訴 Task Engine 你開始了：

```powershell
Invoke-RestMethod -Uri "http://localhost:3461/api/tasks/{你的taskId}/status" -Method POST -ContentType "application/json" -Body '{"status":"in_progress"}'
```

把 `{你的taskId}` 換成實際的 ID（例如 `T1`, `T2`）。

---

## Step 4: 執行任務

按 spec 寫 code。注意：

### 必須遵守的規則
- **零外部依賴** — 只用 Node.js built-in modules
- **使用 blackboard-server.js** — 新 app 必須用 `bb.createServer(ctx, routeHandler)`，不自己寫 `http.createServer`
- **board.json 是唯一事實來源** — 不要另外存狀態
- **所有 board 寫入走 writeBoard()** — SSE 推送由 bb core 自動處理
- **createContext 要設 boardType** — `bb.createContext({ boardType: 'my-app', ... })`
- **Windows spawn pattern** — `spawn('cmd.exe', ['/d', '/s', '/c', 'openclaw.cmd', ...args])`
- **Agent 不直接寫 board** — server 解析 agent 回覆後寫入
- **UTF-8** — 所有字串用 UTF-8

### Server 骨架（新 app 必用）

```js
const bb = require('../blackboard-server');
const ctx = bb.createContext({
  dir: __dirname,
  boardPath: path.join(__dirname, 'board.json'),
  logPath: path.join(__dirname, 'app-log.jsonl'),
  port: 3462,
  boardType: 'my-new-app',
});

const { nowIso, uid, json } = bb;
const readBoard = () => bb.readBoard(ctx);
const writeBoard = (b) => bb.writeBoard(ctx, b);
const appendLog = (e) => bb.appendLog(ctx, e);

const server = bb.createServer(ctx, (req, res, helpers) => {
  // 你的 domain routes here
  return false; // fall through to static
});
bb.listen(server, ctx);
```

bb core 自動提供：CORS、OPTIONS、`/api/board` (GET/POST)、`/api/events` (SSE)、static files。

### 程式碼風格
- 參考 `project/task-engine/server.js` 的命名和結構
- 函式名用 camelCase
- API 路徑用 `/api/` prefix
- 回傳 JSON：`{ ok: true, ... }` 或 `{ error: "message" }`
- Log 用 `appendLog({ ts: nowIso(), event: '...', ... })`

### 測試
- 寫完後跑 `node -c server.js` 確認 syntax
- 跑 smoke test：`node project/smoke-test.js {port} {domain-route}`
- 如果可以的話，啟動 server 測試 API

---

## Step 5: 回報結果

### 完成了

```powershell
Invoke-RestMethod -Uri "http://localhost:3461/api/tasks/{taskId}/status" -Method POST -ContentType "application/json" -Body '{"status":"completed"}'
```

在你的回覆裡**必須**包含以下格式：

```
【交付報告：{taskId}】

建立/修改的檔案：
- {檔案路徑} — {一句話說明}
- {檔案路徑} — {一句話說明}

自檢結果：
- node -c server.js: ✅/❌
- board.json parse: ✅/❌
- smoke-test: ✅/❌（如果適用）
- server 啟動測試: ✅/❌（如果適用）
- API 測試: ✅/❌（如果適用）

注意事項：
- {任何後續任務需要知道的事}
```

不要只說「做完了」。要列檔案、列自檢結果。

**回報 completed 後，process-review.js 會自動啟動審查。** 審查通過 → approved；不通過 → needs_revision，等 Human 決定。

### 卡住了

```powershell
Invoke-RestMethod -Uri "http://localhost:3461/api/tasks/{taskId}/status" -Method POST -ContentType "application/json" -Body '{"status":"blocked","reason":"具體卡在哪裡"}'
```

**reason 要寫清楚：**
- ❌ 「卡住了」
- ✅ 「spec 裡沒定義 synthesis phase 的 prompt 模板，需要 Lead 補充」

---

## Step 6: 依賴任務

如果你的任務有 `depends`（例如 `depends: ["T1"]`），表示要等 T1 完成且 **approved** 你才能開始。

- T1 approved 後 Task Engine 會自動把你的狀態從 `pending` 變成 `dispatched`
- 你被 dispatch 時才開始做
- **不要假設依賴任務的產出路徑** — 讀 board.json 或問 Lead

注意：是 `approved` 才解鎖，不是 `completed`。`completed` 只表示做完，還要過審查。

---

## 快速參考卡

```
讀 spec     →  read("project/task-engine/specs/xxx.md")
讀 contract →  read("project/CONTRACT.md")
回報開始    →  POST /api/tasks/{id}/status  {"status":"in_progress"}
回報完成    →  POST /api/tasks/{id}/status  {"status":"completed"}
回報卡住    →  POST /api/tasks/{id}/status  {"status":"blocked","reason":"..."}
讀黑板      →  GET  /api/board
語法檢查    →  node -c server.js
smoke test  →  node project/smoke-test.js {port} {domain-route}
```
