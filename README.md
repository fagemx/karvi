# Task Engine

多 Agent 任務派發 + 進度追蹤黑板。基於 Blackboard Pattern，JSON + HTML + 零外部依賴。

## 快速開始

```bash
cd project/task-engine
node server.js
# → http://localhost:3461
```

## 架構

```
Human (Director)
    │
    ▼
Server (board.json = single source of truth)
    │
    ├→ Agent A (Engineer)
    ├→ Agent B (Engineer)
    └→ Agent C (Engineer)
```

- **Director (Human)**: 定目標、建任務計劃、批准/介入
- **Server**: 管 board.json、派發任務給 agent、收回覆
- **Engineer (Agent)**: 收到任務 → 執行 → 回報

## 任務生命週期

```
pending → dispatched → in_progress → completed
                           │
                           └→ blocked → (human 回覆) → in_progress
```

- 依賴自動解鎖：T1 完成 → T3 (depends: [T1]) 自動變 dispatched
- 全部完成 → phase 自動變 `done`

## API

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/board` | 讀取完整 board.json |
| GET | `/api/tasks` | 讀取 taskPlan |
| POST | `/api/tasks` | 建立/覆蓋 taskPlan（`{ goal, phase, tasks }`）|
| POST | `/api/tasks/:id/dispatch` | 派發單一任務給 assignee agent |
| POST | `/api/tasks/:id/status` | 手動更新任務狀態（`{ status, reason? }`）|
| POST | `/api/tasks/:id/update` | 更新任務欄位（`{ status, result, blocker }`）|
| POST | `/api/tasks/:id/unblock` | 回覆 blocked 任務（`{ message }`）|
| POST | `/api/tasks/dispatch` | 批量派發所有 ready 的任務 |
| POST | `/api/conversations` | 新增房間 |
| POST | `/api/conversations/:id/send` | 發送訊息 |
| POST | `/api/conversations/:id/run` | 手動跑佇列 |
| POST | `/api/conversations/:id/stop` | 停止佇列 |
| POST | `/api/conversations/:id/resume` | 恢復佇列 |
| POST | `/api/participants` | 新增參與者 |

## 任務狀態

| 狀態 | 說明 |
|------|------|
| `pending` | 等待（依賴未滿足或尚未派發）|
| `dispatched` | 已標記準備派發 |
| `in_progress` | Agent 正在執行 |
| `blocked` | 卡住，需要 Human 回覆 |
| `completed` | 完成 |

## UI

兩個 Tab：
- **Task Board**: 任務卡片看板，每張卡有操作按鈕（派發/完成/blocked/unblock）
- **Timeline**: 所有訊息的時間線（agent 回覆、系統事件）

## 檔案

```
board.json       ← 黑板（single source of truth）
server.js        ← HTTP server（零外部依賴）
index.html       ← UI（零外部依賴）
task-log.jsonl   ← 事件日誌（append-only）
```

## 設計決策

- **Human 控制狀態，不靠 agent 回覆解析** — 按按鈕比解析自然語言可靠
- **Per-task 派發** — 直接把任務送給 assignee agent，不透過中間人轉發
- **Fire-and-forget** — 派發是非同步的，server 不等 agent 完成
- **Agent 回覆存在 `lastReply`** — UI 顯示預覽，Human 看完決定標完成或 blocked

## 與其他黑板的關係

同一個 Blackboard Pattern family：

| 應用 | Schema | Port |
|------|--------|------|
| Brief Panel（分鏡）| shotspec | - |
| Agent Room（對話）| conversation | 3460 |
| **Task Engine（任務）** | **taskPlan** | **3461** |
