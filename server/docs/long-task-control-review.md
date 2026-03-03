# 長任務控制與 Session 切換 — 設計評審

> 評審日期：2026-03-03
> 依據：原始規劃文件 + codebase 實際驗證（5 個 runtime adapter、step-worker、kernel、routes 全讀過）

---

## 背景：這份文件在講什麼

Karvi 是多 agent 任務引擎。使用者定義任務，Karvi 派發給 AI agent（Claude Code、OpenClaw、OpenCode 等）執行。問題出在：**agent 一旦開始跑，使用者幾乎無法控制它。**

### 觸發事件

一個自動派發的 agent（opencode session）跑了 30+ 分鐘的任務，中途使用者想切換做別的事。結果：

1. **停不掉** — 沒有 API 可以中止正在跑的特定 agent，只能停整個 queue
2. **停錯東西** — 使用者按了 conversation stop，結果把不該停的長任務也殺了
3. **不知道停了什麼** — UI 沒有顯示哪些 execution 在跑、哪些被停了
4. **殭屍殘留** — 有時 agent process 沒被殺乾淨，佔住資源但 board 上看不到

「按 Stop 結果不可預期」是致命的信任問題 — 無論是單人使用還是多租戶部署，execution 控制必須可靠。

### 原始規劃的提案

有人寫了一份完整的產品規格，提出四週的實作計畫：

- **Execution Registry**：追蹤每個正在跑的 process 的 PID、狀態、owner
- **三種停止語義**：Soft Stop / Graceful Cancel / Hard Kill
- **任務分類**：interactive / background_script / detached_job
- **Cancel 狀態機**：新增 cancelling / cancelled / interrupted 狀態
- **5 個新 API 端點** + **UI Stop Modal**
- **Runtime Contract V2**：dispatch() 改為回傳 runHandle 而非 Promise

本文件是對這份規劃的**工程可行性評審**。

---

## 第一部分：現況驗證

先確認原始規劃對 Karvi 現狀的描述是否正確。以下每一項都有讀過原始碼確認。

### 已有能力（全部正確）

| 能力 | 怎麼做的 | 程式碼位置 |
|------|----------|-----------|
| **Conversation queue stop/resume** | `POST /api/conversations/:id/stop` 設 `stopRequested=true`，queue loop 下一輪檢查到就停 | `routes/chat.js:454-505` |
| **Project pause/resume** | `POST /api/projects/:id/pause` 設 `status='paused'`，auto-dispatch 看到 paused 就跳過 | `routes/projects.js:223-253` |
| **dispatch.state 狀態機** | task.dispatch 物件追蹤 `prepared → dispatching → completed/failed` | `routes/tasks.js:112-216` |
| **Runtime session resume** | OpenClaw 用 `--session-id`，Claude 用 `--resume`，runtime capabilities 宣告 `supportsSessionResume: true` | `runtime-openclaw.js:49-52`, `runtime-claude.js:72-73` |
| **Requeue recovery** | server 重啟或 resume 時，`requeueRunningTurns()` 把卡在 `running` 的 turn 改回 `queued` | `routes/_shared.js:63-77` |

**結論：原始規劃的「已有能力」部分全部準確。**

### 缺口（6/7 準確，1 個需修正）

| 缺口聲明 | 驗證結果 | 詳細說明 |
|----------|----------|----------|
| **無精準中止單一 execution** | ✅ 準確 | `dispatch()` 回傳 Promise。child process 的 PID 封在 Promise executor 的 closure 裡，外部完全拿不到。唯一的 `killTree(pid)` 是 runtime 內部在 timeout 或完成時自己呼叫。 |
| **無統一取消語義** | ✅ 準確 | 目前只有 queue-level 的 stop（停接新任務）和 project-level 的 pause（暫停派發）。沒有 task-level 或 step-level 的 cancel/abort。 |
| **無 execution registry** | ⚠️ 半對 | `instance-manager.js` 確實有 PID registry（`childProcesses` Map + `isProcessAlive()` 檢查）。但這是 **SaaS 多租戶版本**用來管理「每個用戶的 server process」，不是管理「每個 task 的 agent process」。Task execution 層完全沒有 registry。 |
| **無長任務分類與保留策略** | ✅ 準確 | 所有 task 一視同仁，沒有 interactive/background/detached 區分。 |
| **無 stop policy engine** | ✅ 準確 | 停止行為是硬編碼的，不能依任務類型自動決策。 |
| **無 cancel 狀態機** | ✅ 準確 | task status 沒有 cancelling/cancelled/interrupted。dispatch.state 也沒有 stopping/stopped/cancelled。唯一的「失敗」路徑是 lock 過期 → retry-poller 標記 failed。 |
| **無呈現停了什麼** | ✅ 準確 | UI 按 stop 後沒有任何回饋告訴用戶「停了哪些 execution、保留了哪些」。 |

---

## 第二部分：工程可行性風險

原始規劃的產品方向是對的，但工程落地有三個被低估的風險。

### 風險 1: Runtime Contract V2 — 改動量被嚴重低估

**問題的本質：** 原始規劃要求 `dispatch()` 回傳 `runHandle`（含 `stop(mode)` 方法），但現在 5 個 runtime adapter 全部回傳 Promise，process 生命週期完全封裝在內部。

```javascript
// 現在的 runtime-claude.js — PID 鎖在 closure 裡
function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args);     // ← PID 在這
    child.on('close', () => resolve(...));    // ← 外部只拿到結果
    setTimeout(() => killTree(child.pid), timeout);  // ← kill 邏輯也在內部
  });
}
```

要改成 runHandle，需要：

1. 把 Promise 拆成「啟動」和「等待結果」兩個階段
2. 暴露 kill callback 到外部
3. 處理「kill 之後 Promise 怎麼 resolve/reject」的語義
4. **每個 runtime 的停止機制不同**：

| Runtime | 當前停止方式 | 改為 runHandle 的難度 |
|---------|-------------|----------------------|
| openclaw | `taskkill /T /F`（殺 process tree） | 中 — 直接暴露 PID |
| claude | `taskkill /T /F`（殺 process tree） | 中 — 直接暴露 PID |
| opencode | NDJSON stream 解析 + process kill | **高** — stream 要 drain，不能硬殺否則丟結果 |
| claude-api | HTTPS request（無 process） | 低 — AbortController |
| codex | child process | 中 — 直接暴露 PID |

5. 改完還要更新 `runtime-contract.js` 的驗證邏輯 + 所有 test

**原始規劃把這放在 Phase 1（1 週），實際上光這一項就需要 1 週。**

**建議：** 先只改 claude + opencode（最常用的兩個），其他 runtime 延後。

### 風險 2: 一次性全做 vs 介面先行、實作分層

原始規劃一口氣提出 6 個新系統：

- Execution Registry（新模組 + 持久化）
- Stop Policy Engine（依任務類型自動決策）
- Cancel 狀態機（6 個新狀態 × 多個物件）
- 4 個新 API 端點
- UI Stop Modal（三選一 + risk label）
- Runtime Contract V2（5 個 adapter 重寫）

問題不是這些功能不需要，而是**同時實作所有功能的交付風險太高**。正確的做法是：

1. **API 介面一次設計對** — `POST /api/steps/:id/kill`、`GET /api/executions` 的 contract 現在就定義
2. **實作分層替換** — 第一版 in-memory Map，多節點時換成 Redis-backed，API 不變
3. **每層交付後驗證** — 確認 kill 語義正確，再加 policy engine

最小改動就能解決 80% 痛點：

```javascript
// 改動 1: dispatch() 多回傳一個 kill()                   ← ~20 行
function dispatch(plan) {
  let killFn = () => {};
  const promise = new Promise((resolve, reject) => {
    const child = spawn(...);
    killFn = () => killTree(child.pid);
    // ... 其餘不變
  });
  return { promise, kill: killFn };
}

// 改動 2: step-worker 存 kill callback                    ← ~10 行
const activeExecutions = new Map();  // stepId → kill()
// dispatch 時: activeExecutions.set(stepId, handle.kill)
// 完成時: activeExecutions.delete(stepId)

// 改動 3: 新端點                                         ← ~15 行
// POST /api/steps/:id/kill → activeExecutions.get(id)()
```

**45 行改動，使用者就能精準殺掉任何正在跑的 step。**

### 風險 3: Detached Job 和單程序架構衝突

原始規劃的核心概念之一是 `detached_job` — 不受 session stop 影響的長任務。

Detached job 需要解決的底層問題（無論單機或多節點部署）：

1. **Process 生命週期跨越 server 重啟** — in-memory 狀態消失，需要持久化 registry
2. **Graceful shutdown 時間窗** — 當前 5 秒 timeout，長任務需要 drain 機制
3. **跨平台 process 管理** — Windows `taskkill /T /F` vs Unix signal handling，detached child 不會被自動管理
4. **PID 漂移** — 重啟後 OS 可能把同一個 PID 分配給不同 process，registry 需要驗證機制
5. **Orphan 清掃** — 沒有 supervisor 的情況下，server crash 後的殭屍 process 需要偵測和回收

要真正做 detached job：

```
必須有：
1. Execution registry 持久化到磁碟（不只是 memory Map）
2. 重啟後 PID 對帳 + 驗證 process 還活著
3. Orphan process 清掃機制
4. 或者根本不用 child process，改用 job queue + worker pattern
```

**這不是「1 週」能做完的。原始規劃 Phase 3 的估計（1 週）至少需要 2-3 週。**

### 風險 4: Step Pipeline 和 Legacy Dispatch 的路徑分歧

原始規劃隱含假設：dispatch 只有一條路徑。但 Karvi 實際上有兩條完全不同的 dispatch 路徑，改 `dispatch()` 回傳值時**兩條都要改**，否則 Tier 1 只解決一半問題。

| 路徑 | 進入方式 | 程式碼位置 | 有什麼保護 |
|------|----------|-----------|-----------|
| **Step pipeline** | task 有 step 定義 → step-worker 逐步執行 | `step-worker.js:executeStep()` | lock、retry-poller、heartbeat、post-check、contract validation、protected-diff-guard |
| **Legacy dispatch** | `POST /api/tasks/:id/dispatch` 直接呼叫 | `routes/tasks.js:tryAutoDispatch()` | 幾乎沒有 — 直接 `await dispatch(plan)` 拿結果 |

這造成三個問題：

1. **kill 能力不一致** — Tier 1 的 `activeExecutions` Map 如果只加在 step-worker，legacy path 派出去的 agent 還是殺不掉
2. **保護層不對稱** — step pipeline 有 three-layer protection（PR #211），legacy path 完全沒有
3. **auto-dispatch 走哪條不確定** — 取決於 `controls.use_step_pipeline` 和 task 是否有 step 定義

**建議：Tier 1 實作時，兩條路徑都要加 kill callback 註冊。長期應該收斂成一條路徑（step pipeline），legacy dispatch 降級為 step pipeline 的 thin wrapper。**

---

## 第三部分：建議落地順序

把原始規劃的 4 Phase（各 1 週）重新分成 3 Tier，從最小改動開始。

### Tier 1: 最小可行控制（1-2 天）

目標：使用者能精準殺掉指定 step，不影響其他正在跑的任務。

| 項目 | 改動 | 預估 |
|------|------|------|
| A. `dispatch()` 回傳 `{ promise, kill() }` | 改 claude + opencode 兩個 runtime | 3 小時 |
| B. step-worker 維護 `activeExecutions` Map | 新增 ~10 行 | 1 小時 |
| C. `POST /api/steps/:id/kill` 端點 | 新增 ~15 行 | 1 小時 |
| D. dispatch.state 加 `cancelled` 狀態 | 改 routes/tasks.js + step-schema.js | 1 小時 |

**完成後的能力：** 使用者呼叫 `POST /api/steps/S3/kill` → 對應的 agent process 被終止 → step 標記 cancelled → 其他 step 不受影響。

### Tier 2: 完整控制面（1 週）

目標：UI 上有完整的停止/保留體驗。

| 項目 | 改動 | 預估 |
|------|------|------|
| E. Execution Registry（memory + 定期寫檔） | 新模組 ~100 行 | 3 小時 |
| F. `GET /api/executions` 端點 | 查詢 registry | 1 小時 |
| G. conversation stop 擴充 `stopRunning` 參數 | 改現有端點 | 2 小時 |
| H. UI stop modal（三選一） | 改 index.html | 3 小時 |
| I. 長任務標記 `executionMode: background_script` | task schema 擴充 | 2 小時 |

**完成後的能力：** 使用者按 Stop 時看到三個選項（只停 queue / soft stop / hard kill），長任務可標記為 background 預設保留。

### Tier 3: 多節點 + 持久化（2-3 週）

目標：多節點部署下的可靠執行控制。Registry 持久化、跨機器 kill、crash recovery。

| 項目 | 改動 | 預估 |
|------|------|------|
| J. Stop Policy Engine | 依任務類型自動決策 | 1 週 |
| K. Detached Job 完整生命週期 | Registry 持久化 + PID 對帳 + orphan 清掃 | 1 週 |
| L. 剩餘 3 個 runtime 的 runHandle 改造 | openclaw + codex + claude-api | 3 天 |
| M. Crash Recovery 壓力測試 + SLA | 模擬各種 crash 場景 | 3 天 |

---

## 第四部分：和現有端點的關係

原始規劃提了 5 個新 API，但其中 2 個和現有端點重疊。落地時必須統一，不能開兩個做同一件事的端點。

| 原始規劃 | 現有端點 | 處理方式 |
|----------|----------|----------|
| `POST /api/conversations/:id/stop`（加新參數） | ✅ 已存在（`routes/chat.js:454`） | **擴充**現有端點，body 加 `stopRunning: "none" \| "soft" \| "hard"` |
| `POST /api/conversations/:id/resume` | ✅ 已存在（`routes/chat.js:482`） | **保持**現有行為，不動 |
| `POST /api/executions/:runId/stop` | ❌ 不存在 | **Tier 2** 新增 |
| `GET /api/executions` | ❌ 不存在 | **Tier 2** 新增 |
| `POST /api/tasks/:id/stop` | ❌ 不存在（但有 dispatch.state） | **Tier 1** 新增，整合 dispatch.state 的 cancelled 狀態 |

---

## 第五部分：原始規劃品質評估

| 面向 | 評分 | 說明 |
|------|------|------|
| 問題定義 | **9/10** | 四類痛點（混合執行、長任務誤殺、殭屍殘留、控制權不對等）分析精準，都是真實場景 |
| 現況分析 | **8/10** | 「已有能力」全部正確；「缺口」6/7 正確，instance-manager 的 registry 被忽略（雖然它不是 task 層的） |
| 功能設計 | **7/10** | Execution Registry + Stop Semantics + Cancel 狀態機內部邏輯自洽，但沒考慮和現有程式碼的整合成本 |
| API 設計 | **7/10** | 端點設計合理，但沒處理和現有 conversation stop/resume 端點的重疊問題 |
| Runtime V2 | **5/10** | 方向完全正確，但嚴重低估改動量。5 個 adapter × 不同停止語義 × 測試 = 不是 Phase 1 能做完的 |
| 分期規劃 | **6/10** | Phase 1「1 週」包含 Runtime V2 + Registry + 狀態機 + stop hook，實際 2 週起跳 |
| 驗收標準 | **8/10** | 6 條 DoD 清晰可測，尤其「重啟後不遺失 execution 控制資訊」是好的測試案例 |

**總評：產品方向正確，工程交付策略需要調整。**

它準確描述了目標（使用者能精準控制每個 execution 的生命週期），但缺少漸進交付路徑。正確的策略是：**API 介面一次設計到位（包含多租戶場景），實作分層替換（memory → file → DB → job queue），每層交付後驗證再推下一層。** Tier 不是「小 → 大」的規模分級，是交付風險控制。

---

## 追蹤

- **#214** — Tier 1 實作（dispatch kill + activeExecutions + API endpoint）
- **#213** — Scope lock（限制 agent 可修改的檔案範圍，防止範圍爆炸）
- **PR #211** — Three-layer agent protection（edda decisions + @protected annotations + diff guard）已 merge
