# Spec: 辯證研究室（Dialectic Arena）

> Author: Nox (Lead)
> Date: 2026-02-25
> Status: Draft — 等待 Tamp 審核後派發

---

## 1. 目標

建一個**結構化辯論黑板**：兩個（或多個）agent 圍繞一個命題，按 phase 推進（thesis → antithesis → synthesis），Human 在旁邊看、插話、最終裁決。

跟 agent-room 的差異：agent-room 是自由對話接力，辯證研究室是**有結構的辯論流程**。

---

## 2. 技術背景（給 Engineer 讀的）

### 2.1 Blackboard Pattern

我們所有應用共用同一個架構模式：

```
board.json  ← single source of truth（JSON 檔）
server.js   ← HTTP server（Node.js, 零外部依賴）
index.html  ← UI（純 HTML/JS/CSS, 零外部依賴）
```

- Server 讀寫 board.json，提供 REST API
- UI 透過 SSE (`/api/events`) 即時更新，不用 polling
- Agent 透過 `openclaw agent --agent <id> --message "..." --json` 觸發
- **Agent 不直接寫 board.json** — agent 回覆文字，server 解析後更新 board

### 2.2 現有三個應用

| 應用 | 路徑 | Port | Schema 重點 |
|------|------|------|------------|
| Brief Panel（分鏡）| `skills/conversapix-storyboard/tools/brief-panel/` | - | shots, shotspec |
| Agent Room（對話）| `project/agent-room/` | 3460 | conversations, queue, messages |
| Task Engine（任務）| `project/task-engine/` | 3461 | taskPlan, tasks, status lifecycle |

### 2.3 必須參考的檔案

- `project/task-engine/server.js` — 最新的 server 範本（含 SSE、spawn pattern、Windows fix）
- `project/task-engine/index.html` — 最新的 UI 範本（SSE client、dark theme、task card pattern）
- `project/agent-room/docs/phase-consensus-dialogue.md` — Phase 設計草案（部分可重用）

### 2.4 設計約束（不可違反）

1. **零外部依賴** — 不准用 npm install，只用 Node.js built-in modules
2. **單一 board.json** — 所有狀態都在這一個檔案裡
3. **SSE 即時推送** — `writeBoard()` 時自動 `broadcastSSE('board', board)`
4. **Windows 相容** — spawn 用 `cmd.exe /d /s /c openclaw.cmd ...args` pattern
5. **Agent 不直接寫 board** — agent 的回覆由 server 解析後寫入
6. **UTF-8 中文友善** — 介面和訊息都用中文

---

## 3. 辯證研究室 Schema

### 3.1 board.json 結構

```json
{
  "meta": {
    "name": "Dialectic Arena",
    "version": 1,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "participants": [
    { "id": "human", "type": "human", "displayName": "Tamp" },
    { "id": "advocate", "type": "agent", "displayName": "Advocate", "agentId": "engineer_pro" },
    { "id": "critic", "type": "agent", "displayName": "Critic", "agentId": "nier" }
  ],
  "arena": {
    "thesis": "均線盲區理論是對的",
    "context": "（背景說明，可選）",
    "status": "active",
    "createdAt": "...",
    "config": {
      "maxRounds": 10,
      "maxMinutes": 30,
      "phases": ["opening", "argument", "rebuttal", "synthesis", "verdict"],
      "autoAdvance": true
    },
    "phase": "opening",
    "round": 1,
    "rounds": [
      {
        "round": 1,
        "phase": "argument",
        "entries": [
          {
            "id": "e1",
            "ts": "...",
            "agent": "advocate",
            "role": "advocate",
            "text": "我認為...",
            "evidence": ["..."],
            "replyTo": null
          },
          {
            "id": "e2",
            "ts": "...",
            "agent": "critic",
            "role": "critic",
            "text": "不對，因為...",
            "evidence": ["..."],
            "replyTo": "e1"
          }
        ]
      }
    ],
    "synthesis": null,
    "verdict": {
      "decided": false,
      "by": null,
      "text": null,
      "decidedAt": null
    },
    "sessionIds": {
      "advocate": null,
      "critic": null
    }
  },
  "log": []
}
```

### 3.2 Phase 流程

```
opening      → Human 或 Lead 設定命題和參與者
argument     → Advocate 論述 → Critic 反駁（可多輪）
rebuttal     → 雙方針對對方論點回擊
synthesis    → 其中一方（或第三方）嘗試整合
verdict      → Human 裁決（或標記「無共識」）
```

Phase 推進由 server 控制，不靠 agent 判斷。
- `argument`: Advocate 說完 → 自動輪到 Critic → Critic 說完 → round + 1
- 達到 `maxRounds` 或 Human 按「進入 synthesis」→ 切 phase
- `verdict` 必須由 Human 手動觸發

### 3.3 停止條件

任一成立就停止自動推進：
- `round > maxRounds`
- 經過時間 > `maxMinutes`
- Human 手動按「停止」或「進入裁決」

---

## 4. Server API

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/board` | 讀取 board.json |
| GET | `/api/events` | SSE 即時更新 |
| POST | `/api/arena` | 建立新辯論（`{ thesis, context?, participants?, config? }`）|
| POST | `/api/arena/advance` | 推進到下一 phase |
| POST | `/api/arena/entry` | Human 手動加一條論述（`{ agent, role, text, evidence? }`）|
| POST | `/api/arena/verdict` | Human 裁決（`{ text, result: "advocate"|"critic"|"draw"|"inconclusive" }`）|
| POST | `/api/arena/stop` | 停止自動推進 |
| POST | `/api/arena/resume` | 恢復自動推進 |
| POST | `/api/arena/dispatch` | 觸發下一個 agent 發言（server 叫 openclaw）|
| POST | `/api/participants` | 新增參與者 |

### 4.1 Dispatch 流程

`POST /api/arena/dispatch` 的邏輯：

1. 讀 board，找目前 phase 和 round
2. 判斷該誰發言（按 advocate → critic 交替）
3. 組裝 prompt：
   - 命題
   - 到目前為止的所有論述（context window 管理：只帶最近 N 條）
   - 角色指示（「你是 advocate，請論述」或「你是 critic，請反駁」）
4. 呼叫 `runOpenclawTurn({ agentId, sessionId, message })`
5. 收到回覆 → 寫入 `arena.rounds[current].entries`
6. 判斷是否自動輪到下一位或 round + 1
7. `writeBoard()` → SSE 推送 → UI 即時更新

### 4.2 Prompt 模板

Advocate:
```
【辯證研究室 — Advocate】
命題：{thesis}
背景：{context}

你的立場：支持此命題。
到目前為止的論述：
{entries formatted}

請提出你的論點。引用具體證據。不要敷衍。
```

Critic:
```
【辯證研究室 — Critic】
命題：{thesis}
背景：{context}

你的立場：反對或質疑此命題。
到目前為止的論述：
{entries formatted}

請針對 Advocate 的論點提出反駁。找出邏輯漏洞、缺少的證據、或錯誤的假設。
```

---

## 5. UI 設計

### 5.1 佈局

```
┌─────────────────────────────────────────────────────┐
│ 辯證研究室 — [命題顯示在這]                           │
│ Phase: argument | Round: 3/10 | ⏱ 12:34             │
├───────────────────────┬─────────────────────────────┤
│ Advocate              │ Critic                      │
│ (左欄)                │ (右欄)                       │
│                       │                             │
│ [R1] 論點 A1          │ [R1] 反駁 C1               │
│ [R2] 回擊 A2          │ [R2] 反駁 C2               │
│ [R3] 論點 A3          │ （等待中...）                │
│                       │                             │
├───────────────────────┴─────────────────────────────┤
│ Human 控制列                                         │
│ [🟢 下一輪] [⏭ 進入 Synthesis] [🛑 停止] [⚖ 裁決]   │
│ [輸入框: 你可以在這裡插話或提供新證據]                  │
├─────────────────────────────────────────────────────┤
│ Synthesis / Verdict 區域（摺疊，有內容時展開）          │
└─────────────────────────────────────────────────────┘
```

### 5.2 左右對照

- 左欄 = Advocate 的所有論述，按 round 排列
- 右欄 = Critic 的所有論述，按 round 排列
- 同一 round 的論述左右對齊
- 正在等待的那一方顯示「等待中...」或 spinner

### 5.3 顏色

- Advocate: 藍色系 (`#4d79ec`)
- Critic: 紅色系 (`#ff6b6b`)
- Human 插話: 綠色系 (`#36c98c`)
- Synthesis: 紫色系 (`#a855f7`)
- Verdict: 金色系 (`#f7b955`)

### 5.4 UI 按鈕邏輯

- **下一輪**: `POST /api/arena/dispatch` — 觸發下一個 agent 發言
- **進入 Synthesis**: `POST /api/arena/advance` with `{ phase: "synthesis" }`
- **停止**: `POST /api/arena/stop`
- **裁決**: 打開裁決 modal → 填寫 → `POST /api/arena/verdict`
- **插話**: `POST /api/arena/entry` with `{ agent: "human", role: "moderator", text: "..." }`

---

## 6. 檔案結構

```
project/dialectic-arena/
├── board.json          ← 黑板
├── server.js           ← HTTP server（~200-300 行）
├── index.html          ← UI（~400-500 行）
├── arena-log.jsonl     ← 事件日誌
└── README.md
```

Port: **3462**

---

## 7. 任務拆解

| Task | 標題 | Assignee | 依賴 | 估時 |
|------|------|----------|------|------|
| T1 | 建立專案骨架 + board.json 初始結構 | engineer_lite | 無 | 15m |
| T2 | 實作 server.js（所有 API + SSE + dispatch）| engineer_pro | T1 | 60m |
| T3 | 實作 index.html（對照 UI + 控制列 + SSE client）| engineer_pro | T1 | 60m |
| T4 | 整合測試 + 修 bug | Nox | T2, T3 | 30m |

---

## 8. 驗收標準

- [ ] 可以設定命題，開始辯論
- [ ] Advocate 和 Critic 自動交替發言
- [ ] 左右對照顯示，同 round 對齊
- [ ] Human 可以隨時插話
- [ ] Human 可以控制 phase 推進
- [ ] Human 可以裁決
- [ ] SSE 即時更新（不用手動刷新）
- [ ] 所有事件寫入 arena-log.jsonl
- [ ] 零外部依賴
