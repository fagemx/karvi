# Layer Split — 代理派發指令

## 給代理的指令

你的任務是把 `project/task-engine/server.js`（1996 行）拆成三個檔案。拆完後行為 100% 不變。

### 必讀文件（按順序讀）

1. `project/task-engine/docs/plans/LAYER_SPLIT/00_OVERVIEW.md` — 總覽 + 分割地圖
2. `project/task-engine/docs/plans/LAYER_SPLIT/S1_MANAGEMENT.md` — management.js 規格
3. `project/task-engine/docs/plans/LAYER_SPLIT/S2_RUNTIME.md` — runtime-openclaw.js 規格
4. `project/task-engine/docs/plans/LAYER_SPLIT/S3_REWIRE.md` — server.js 改造規格
5. `project/task-engine/docs/plans/LAYER_SPLIT/S4_VALIDATE.md` — 驗證清單
6. `project/task-engine/docs/plans/LAYER_SPLIT/S5_DISPATCHABLE_STATE.md` — 代理可派發狀態（Codex 前置）
7. `project/task-engine/docs/plans/LAYER_SPLIT/S6_HIGH_LEVEL_API.md` — 高層 API（統一入口）
8. `project/task-engine/docs/plans/LAYER_SPLIT/S7_CODEX_RUNTIME.md` — Codex Runtime + Skill 共用
9. `project/task-engine/docs/plans/LAYER_SPLIT/S8_SCOPED_BOARDS.md` — 分層黑板 + Brief 整合

### 執行順序

1. **讀 server.js**（完整讀一次，理解結構）
2. **做 S1**：建 `management.js`，從 server.js 剪出 ~600 行純決策函式
3. **做 S2**：建 `runtime-openclaw.js`，從 server.js 剪出 ~100 行 OpenClaw 相關函式
4. **做 S3**：改 server.js — `require('./management')` + `require('./runtime-openclaw')` + 全域替換呼叫點
5. **做 S4**：跑所有驗證
   - `node -c` 三個檔案
   - 啟動 server（port 3461）
   - `node project/smoke-test.js 3461` → 9/9
   - 清 board + `node project/task-engine/test-evolution-loop.js` → 全通
6. **做 S5**：建立代理可派發狀態（dispatchable state）
   - `management.js` 新增 `buildDispatchPlan(...)`
   - `server.js` 在派發流程寫入 `task.dispatch.state`
   - `runtime-openclaw.js` 新增 `dispatch(plan)` wrapper（保留舊 API）
   - 行為不變，仍以 OpenClaw 為實際執行 runtime
7. **做 S6**：高層原子 API
   - `management.js` 新增 `pickNextTask(...)`
   - `server.js` 新增 `POST /api/dispatch-next`、`POST /api/retro`、`POST /api/project`
   - 每個 API 只做一件事，不綁管線
   - `/api/project` 接受 taskPlan + autoStart
8. **做 S7**：Codex Runtime + Skill 共用
   - 遷移 skills 到 `~/.agents/skills/` + 建 symlink
   - 建 `~/.codex/agents/*.toml`（worker / designer / reviewer）
   - 建 `runtime-codex.js`（介面與 runtime-openclaw.js 對齊）
   - `management.js` 擴充 `buildDispatchPlan` 加入 `requiredSkills` / `codexRole`
   - `server.js` 加 `getRuntime(hint)` 選擇器
9. **做 S8**：Scoped Boards（分層黑板）
   - `server.js` 加 `readBrief/writeBrief` helper
   - 新增 `GET/PATCH/PUT /api/brief/:taskId` 路由
   - 掛載 brief-panel UI 到 `/brief/:taskId`
   - `/api/project` 擴充：有 skill 的 task 自動建 brief
   - brief-panel index.html 微調 API 端點
10. 更新 `00_OVERVIEW.md` 的 Progress Tracker

### 注意事項

- **不改任何邏輯**，只搬位置 + 改呼叫前綴
- `spawnReview` 需要 callback 改造（見 S2 和 S3 的說明）
- Windows 環境，用 `taskkill /F /PID` 殺程序，不是 `kill`
- `wc -l` 不可用，用 PowerShell：`(Get-Content file).Count`
- server.js 裡的 `&&` 鏈式命令不可用，用 `;` 或分開跑
- port 3461 可能有殘留程序：`netstat -ano | findstr 3461` 檢查

### 不要做的事

- 不要改 index.html
- 不要改 process-review.js
- 不要改 retro.js
- 不要改 blackboard-server.js
- 不要改 smoke-test.js 或 test-evolution-loop.js
- 不要加新功能
- 不要改 board.json 既有欄位語義（S5 新增 `task.dispatch` 是允許的）
- 不要在 S5 直接做完整 `runtime-codex.js`（S7 才做）
- S7 不要刪除 `runtime-openclaw.js` 的舊 API（保留相容）
- S7 不要改 SKILL.md 內容（只搬位置建 symlink）
- S7 載入 `runtime-codex.js` 要用 `try/catch`（Codex 不一定已安裝）
- S8 不要大改 brief-panel UI 邏輯（只改 API 端點和 SSE 訂閱）
- S8 不要把 brief 內容塞進 board.json（分離才是目的）
- S8 不要刪除 brief-panel 的獨立 server.js（保留相容）
