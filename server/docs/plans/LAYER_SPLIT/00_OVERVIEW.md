# Layer Split — 管理層 / 執行層 分離

## 目標

把 `server.js`（1996 行）拆成三層：
- **management.js** — 純決策邏輯（不 spawn 程序、不依賴 OpenClaw）
- **runtime-openclaw.js** — OpenClaw 執行適配器
- **server.js** — HTTP 薄殼 + 編排（串接管理層和執行層）

**拆完後行為 100% 不變。** 所有測試必須原樣通過。

---

## 為什麼現在做

1. Evolution Layer 剛落地，server.js 膨脹到 1996 行，管理和執行混在一起
2. 下一步要支援多 runtime（Codex subagent、本機腳本），不拆就得 copy-paste
3. management.js 獨立後，可以被 brief-panel 和未來 app 直接重用
4. 純函式可以單獨測試，不需要啟動 HTTP server

---

## 分割地圖（基於當前 server.js 行號）

### → management.js（搬出去）

| 行號 | 函式 | 用途 |
|------|------|------|
| 27-35 | `DEFAULT_CONTROLS` | 預設控制參數 |
| 37-47 | `VALID_ACTION_TYPES`, `VALID_RISK_LEVELS`, `VALID_LESSON_STATUSES`, `ensureEvolutionFields` | Evolution schema |
| 51-81 | `applyInsightAction` | 套用 insight 行動 |
| 83-89 | `snapshotControls` | 回滾快照 |
| 91-163 | `autoApplyInsights` | Gate 自動套用 |
| 165-278 | `verifyAppliedInsights` | 驗證 + 回滾 |
| 280-290 | `AGENT_MODEL_MAP`, `preferredModelFor` | 代理模型映射 |
| 293-295 | `getControls` | 合併 controls |
| 299-325 | `ALLOWED_TASK_TRANSITIONS`, `canTransitionTaskStatus`, `ensureTaskTransition` | 狀態機 |
| 328-392 | `parseTaskResultFromLastLine` | 解析代理回覆 |
| 394-405 | `readSpecContent` | 讀 spec 檔（唯讀 I/O） |
| 407-423 | `gatherUpstreamArtifacts` | 蒐集上游產出 |
| 425-531 | `buildTaskDispatchMessage` | 組建派發訊息 |
| 533-594 | `buildRedispatchMessage` | 組建重派訊息 |
| 727-743 | `autoUnlockDependents` | 依賴解鎖 |

**共約 600 行。** 特性：不 spawn 任何子程序，不呼叫 OpenClaw，不寫 board.json（由呼叫者寫）。

唯一的 I/O：`readSpecContent` 和 `gatherUpstreamArtifacts` 會 `fs.readFileSync` 讀取 spec/skill 檔案（唯讀，不是副作用）。

### → runtime-openclaw.js（搬出去）

| 行號 | 函式 | 用途 |
|------|------|------|
| 850-909 | `runOpenclawTurn` | spawn openclaw agent 程序 |
| 817-847 | `extractReplyText`, `extractSessionId` | 解析 OpenClaw 回覆 |
| 597-632 | `spawnReview` | spawn process-review.js |

**共約 100 行。** 特性：全部是 `child_process.spawn`，全部依賴 OpenClaw CLI。

### → server.js（留下來）

| 區塊 | 用途 |
|------|------|
| blackboard-server context 初始化 | ctx, readBoard, writeBoard |
| `redispatchTask` (635-725) | 編排：management 生訊息 → runtime 執行 |
| `processQueue` (911-1096) | 編排：讀 queue → management 做決策 → runtime 跑 |
| conversation helpers (745-816) | 對話操作 |
| HTTP 路由 (1097-2260) | 薄殼 |
| 啟動碼 (2255+) | listen |

**留約 1300 行。** 後續可以再拆（路由拆 routes.js），但這次不做。

---

## Task 清單

| Task | 名稱 | 做什麼 | 預估 |
|------|------|--------|------|
| S1 | 建 management.js | 從 server.js 搬函式、module.exports | 2h |
| S2 | 建 runtime-openclaw.js | 搬 runOpenclawTurn / spawnReview / extractors | 1h |
| S3 | 改 server.js 為薄殼 | require 兩個模組、刪已搬的函式、改呼叫點 | 2h |
| S4 | 全量驗證 | syntax check + smoke-test + evolution-loop-test | 30min |

**Total: 4 Tasks, ~5.5h**

依賴：S1 → S3, S2 → S3, S3 → S4（S1 和 S2 可並行）

```
時間 ──────────────────────────────────→

  [==== S1: management.js ====]
                                 ↘
  [== S2: runtime-openclaw.js ==]  → [==== S3: server.js 改薄殼 ====] → [= S4 =]
```

---

## 驗證標準

- [ ] `node -c management.js` 通過
- [ ] `node -c runtime-openclaw.js` 通過
- [ ] `node -c server.js` 通過
- [ ] `node project/smoke-test.js 3461` → 9/9 通過
- [ ] `node project/task-engine/test-evolution-loop.js` → 全通過
- [ ] server.js 行數 < 1400
- [ ] management.js 可被 `require()` 不啟動 server

---

## Progress Tracker

```
[x] S1: management.js
[x] S2: runtime-openclaw.js
[x] S3: server.js 薄殼
[x] S4: 全量驗證
[x] S5: 代理可派發狀態（Codex 前置）
[x] S6: 高層原子 API（dispatch-next / retro / project）
[x] S7: Codex Runtime + Skill 共用層
[x] S8: Scoped Boards（分層黑板 + Brief 整合）
```

---

## Phase 2（接 Codex 代理系統前置）

S1-S4 完成後，server / management / runtime 已經拆層，但管理層目前輸出的核心介面仍然偏向「文字訊息（dispatch message）」。

為了讓 **OpenClaw / Codex / 其他 runtime** 都能吃同一套管理決策，下一步要補的是：

- **代理可派發狀態（dispatchable state）**：task 在 board 裡進入可被 runtime 消費的明確狀態
- **中立 dispatch plan**：management 輸出結構化派發計畫，runtime 各自轉譯

### 新增 Task（接在 S4 後）

| Task | 名稱 | 做什麼 | 預估 |
|------|------|--------|------|
| S5 | 代理可派發狀態（Codex 前置） | 建立 runtime-neutral dispatch plan + task.dispatch 狀態流轉（行為不變） | 1.5h |
| S6 | 高層原子 API | dispatch-next / retro / project 三個原子入口 | 2h |
| S7 | Codex Runtime + Skill 共用 | runtime-codex.js + skill symlink + agent roles + runtime 選擇器 | 3h |
| S8 | Scoped Boards | 分層黑板 + brief 整合到 task-engine，一個 server 多層黑板 | 2.5h |

依賴：`S4 → S5 → S6 → S7`，`S6 → S8`（S7 和 S8 可並行）

### S5 完成後的狀態（目標）

- `management.js` 能輸出 `buildDispatchPlan(...)`（中立物件，不是只有文字）
- `server.js` 在派發前/派發中/派發後，將 task 標記為 `task.dispatch.state`
- `runtime-openclaw.js` 提供 `dispatch(plan)` wrapper（保留 `runOpenclawTurn` 相容）
- S7 新增 `runtime-codex.js`，吃同一個 `plan`（含 skill 共用 + agent roles）
