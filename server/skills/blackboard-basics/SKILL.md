# Skill: Blackboard Basics

> 所有參與 Task Engine 任務的 agent 都必須先讀這份文件。

---

## 什麼是黑板架構（Blackboard Pattern）

一種 1970s 經典 AI 架構。核心概念：

- **一塊共享黑板**（`board.json`）= 唯一的事實來源（single source of truth）
- **多個專家**（agents）讀黑板、做事、結果寫回黑板
- **不需要 orchestrator** — 黑板就是協調機制

---

## 共用核心：blackboard-server.js

所有黑板應用共用同一個 server 骨架（`project/blackboard-server.js`）。

```
app 層（domain logic）
  ↓
bb.createServer(ctx, routeHandler)   ← 共用核心
  ↓
自動提供：CORS / SSE / /api/board / static files
```

建立新 app 只需要：

```js
const bb = require('../blackboard-server');
const ctx = bb.createContext({
  dir: __dirname,
  boardPath: 'board.json',
  logPath: 'app-log.jsonl',
  port: 3462,
  boardType: 'my-app',   // writeBoard() 自動強制 meta.boardType
});
const server = bb.createServer(ctx, (req, res, helpers) => {
  // 你的 domain routes
  return false; // fall through to static
});
bb.listen(server, ctx);
```

完整規格見 `project/CONTRACT.md`。

---

## 6 條設計約束（不可違反）

1. **零外部依賴** — 不准 `npm install`，只用 Node.js built-in modules（`http`, `fs`, `path`, `child_process`）
2. **單一 board.json** — 所有狀態都在一個 JSON 檔裡，不用資料庫
3. **SSE 即時推送** — `writeBoard()` 自動廣播給所有 UI 連線（由 bb core 處理）
4. **Windows 相容** — spawn openclaw 用 `cmd.exe /d /s /c openclaw.cmd ...args` pattern
5. **Agent 不直接寫 board** — agent 只輸出文字回覆，server 負責解析和寫入
6. **UTF-8 中文友善** — 所有介面、訊息、log 都用 UTF-8

---

## Board Invariant（由 core 強制）

每次 `writeBoard()` 都會自動：

- 設定 `meta.boardType` = `ctx.boardType`（不可覆蓋）
- 設定 `meta.version` = `1`（如果缺失）
- 設定 `meta.updatedAt` = 當前 ISO 時間
- 透過 SSE 廣播完整 board

**所有對 board 的寫入必須走 `writeBoard()`**，否則 SSE 不會觸發。
唯一例外：獨立子程序（如 `process-review.js`）可直接寫檔，但父程序必須在子程序結束後補發 SSE。

---

## 現有應用地圖

| 應用 | 路徑 | Port | boardType | 用途 |
|------|------|------|-----------|------|
| Brief Panel（分鏡）| `skills/conversapix-storyboard/tools/brief-panel/` | 3456 | `brief-panel` | AI 分鏡生成 |
| Agent Room（對話）| `project/agent-room/` | 3460 | — | 多 agent 對話接力 |
| Task Engine（任務）| `project/task-engine/` | 3461 | `task-engine` | 任務派發 + 審查 + 進度追蹤 |

Port 分配：3456 brief-panel / 3460 agent-room / 3461 task-engine / 3462+ 未來

---

## Task Engine 怎麼運作

### 角色

| 角色 | 誰 | 做什麼 |
|------|-----|--------|
| **Director** | Human (Tamp) | 定目標、審 spec、批准計劃、裁決 |
| **Lead** | Nox (main agent) | 寫 spec、拆任務、派發 |
| **Engineer** | 你（被指派的 agent）| 讀 spec → 執行任務 → 回報狀態 |
| **Reviewer** | `process-review.js` | 自動審查（deterministic + LLM score） |

### 任務狀態

```
pending → dispatched → in_progress → completed → reviewing → approved
                           │                          │
                           └→ blocked                  └→ needs_revision
                                │                           │
                                └→ (human 回覆)             └→ in_progress（重做）
                                    → in_progress                或 approved（手動通過）
```

### Review Controls

Task Engine 有可調的審查參數（存在 board.json 的 `controls` 區塊）：

| 參數 | 預設 | 說明 |
|------|------|------|
| `auto_review` | `true` | completed 後是否自動觸發審查 |
| `quality_threshold` | `70` | LLM 打分 ≥ 此值才通過 |
| `max_review_attempts` | `3` | 最多自動審查幾次 |
| `review_timeout_sec` | `180` | LLM 呼叫超時秒數 |
| `review_agent` | `engineer_lite` | 執行 review 的 agent |

可從 UI 或 API (`GET/POST /api/controls`) 調整。

---

## Task Engine API（你需要用的）

Base URL: `http://localhost:3461`

### 回報狀態（最重要）

當你開始執行任務：
```powershell
Invoke-RestMethod -Uri "http://localhost:3461/api/tasks/T1/status" -Method POST -ContentType "application/json" -Body '{"status":"in_progress"}'
```

當你完成任務：
```powershell
Invoke-RestMethod -Uri "http://localhost:3461/api/tasks/T1/status" -Method POST -ContentType "application/json" -Body '{"status":"completed"}'
```

當你卡住了：
```powershell
Invoke-RestMethod -Uri "http://localhost:3461/api/tasks/T1/status" -Method POST -ContentType "application/json" -Body '{"status":"blocked","reason":"找不到 XXX 的定義，需要 Human 指路"}'
```

### 其他 API

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/api/board` | 完整 board（由 bb core 提供） |
| `GET` | `/api/events` | SSE 串流（由 bb core 提供） |
| `GET` | `/api/controls` | 當前審查參數 |
| `POST` | `/api/controls` | 更新審查參數 |
| `POST` | `/api/tasks/{id}/review` | 手動觸發審查 |
| `POST` | `/api/tasks/{id}/dispatch` | 派發單一任務 |
| `POST` | `/api/tasks/{id}/unblock` | 回覆 blocked 任務 |

---

## 常見錯誤（避免踩坑）

1. ❌ `npm install express` → 不准，用 bb.createServer
2. ❌ 直接 `fs.writeFileSync('board.json', ...)` 修改黑板 → 用 `writeBoard()` 或 HTTP API
3. ❌ `spawn('openclaw', [...])` → Windows 上會失敗，要用 `spawn('cmd.exe', ['/d', '/s', '/c', 'openclaw.cmd', ...args])`
4. ❌ 用 polling 更新 UI → 用 SSE（`EventSource('/api/events')`）
5. ❌ 把狀態存在變數裡 → 存在 board.json 裡（server 重啟不會丟）
6. ❌ 忘記在 createContext 設 boardType → board 的 meta.boardType 會是 null
