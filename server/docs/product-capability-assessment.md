# Karvi 產品能力評估 — AI 工程團隊的執行控制層

> 評估日期：2026-03-11
> 目標：盤點四大核心能力的實現程度，找出產品等級缺口

## 定位

Karvi 佔住的位置：**AI 工程團隊的執行控制層**。

| 層 | 誰在做 | Karvi 的位置 |
|---|---|---|
| 編排層 — 決定做什麼 | Jira、Linear、PM | 上游，不碰 |
| 執行層 — agent 寫程式碼 | Devin、Codex、Claude Code、opencode | 下游，可插拔 runtime |
| 控制層 — 執行過程的可控性 | **空缺** | **← Karvi** |

四個真價值：
1. **可控性**：把 AI coding 從黑盒變成可中斷、可追蹤、可審計
2. **效率**：縮短 issue → PR → merge 週期，降低返工
3. **信任**：主管敢放權給 agent，因為有 policy + trace + rollback
4. **可組合性**：runtime 可插拔、model 可切換、step 可組合

---

## 總覽

| 能力 | 完成度 | 核心已有 | 最大缺口 |
|------|--------|---------|---------|
| **可控性** | ~68% | step kill、task cancel、SSE 追蹤、controls API、worktree 隔離 | budget 不強制、無 soft stop、審計日誌無查詢 API |
| **效率** | ~80% | issue→PR 全自動、worktree 並行、step pipeline 自動推進、批量 dispatch | kill step 不完整、timeout 誤殺、retry 不帶 context |
| **信任** | ~64% | usage tracking、task-log 審計、confidence engine L1/L2、vault、rate limit | 無 RBAC、無 per-agent 品質追蹤、artifact 不可查詢 |
| **可組合性** | ~65% | 4 runtime adapter + 合約驗證、model_map 三層級、pipeline 可自訂、skill 複製 | 無 discovery endpoint、無 hook/plugin、無 step contract |

---

## 1. 可控性 (Controllability)

> 把 AI coding 從黑盒變成可中斷、可追蹤、可審計

### 已實現

#### 可中斷
- **Step kill 端點** (`routes/tasks.js:1538-1572`) — `POST /api/tasks/:id/steps/:stepId/kill`
- **Task cancel 端點** (`routes/tasks.js:1145-1237`) — `POST /api/tasks/:id/cancel`，一次取消所有 running/queued step
- **AbortController** (`step-worker.js:257, 563-569`) — `activeExecutions` Map 追蹤執行中 step
- **Process tree kill** (`kill-tree.js`) — `taskkill /T /F` 殺整棵 process tree

#### 可追蹤
- **SSE 實時更新** (`blackboard-server.js:211-244`) — 全域 + per-task stream
- **Step 進度** (`step-worker.js:212-253`) — tool_calls、tokens、last_tool、elapsed_ms
- **Status API** (`routes/status.js`) — `GET /api/status` 快照
- **Task progress API** (`routes/tasks.js:685-748`) — `GET /api/tasks/:id/progress`
- **Signal 歷史** (`management.js:60-65`) — board.signals（max 500 條）

#### 可審計
- **Task-log JSONL** (`blackboard-server.js:207-208`) — append-only 事件日誌
- **Artifact store** (`artifact-store.js`) — per-step input/output/log JSON
- **Timeline** (`timeline-task.js`) — per-task 事件時間線，可匯出 HTML

#### Policy 控制
- **Controls API** (`routes/controls.js`) — 讀寫所有控制參數
- **並發限制** — `max_concurrent_tasks`、`max_concurrent_by_type`
- **超時配置** — `step_timeout_sec` per-step-type
- **Budget 框架** (`route-engine.js:23-28`) — max_llm_calls、max_tokens、max_wall_clock_ms

#### Rollback
- **Worktree 隔離** (`worktree.js`) — 每個 task 獨立 branch + worktree
- **Protected-diff-guard** (`protected-diff-guard.js`) — 防止修改 @protected 標記的代碼
- **Step retry** (`route-engine.js`) — 9 種 failure mode，分類重試策略

### 缺口

| 優先級 | 缺口 | 說明 |
|--------|------|------|
| P0 | Budget 不強制 | 目前只記錄不約束，agent 花多少都行 |
| P0 | Kill step 語義不統一 (#214) | opencode 無 graceful shutdown，runtime 間行為不一致 |
| P0 | Cancel task race condition (#274) | worktree cleanup 有競爭條件 |
| P1 | 無 soft stop | 只有 hard kill，無 graceful cancel |
| P1 | 心跳綁 stdout | tool 執行中無 heartbeat → timeout 誤殺 |
| P1 | 無審計日誌查詢 API | task-log.jsonl 無結構化查詢 |
| P1 | Scope lock (#213) | 無法限制 agent 可修改的檔案 |
| P2 | 無 execution registry | PID 封裝在 runtime 內，無法查詢執行中的 agent |
| P2 | 動態自動化調整 | 無法根據成功率自動調整 controls |
| P2 | Streaming artifact log | 無 tail -f 風格的即時日誌 |

---

## 2. 效率 (Efficiency)

> 縮短 issue → PR → merge 週期，降低返工

### 已實現

#### 自動化程度
- **Issue → PR 全自動** — webhook → task → worktree → 3-step pipeline → PR → auto-merge
- **E2E 驗證**：6 分鐘完成 issue → PR，成本 $1.78
- **Auto-finalize** (`step-worker.js`) — agent 未做 git 時自動 commit + push + PR
- **Auto-merge** (`kernel.js:385-421`) — approved 後自動 squash-merge

#### 並行執行
- **Worktree 隔離** (`worktree.js`) — 多 task 同時跑，無 git 衝突
- **Task 並發** — `max_concurrent_tasks: 2`（可調）
- **Step-type 並發** — `max_concurrent_by_type`（plan: 3, implement: 2 等）
- **Project 並發** — per-project concurrency limit

#### Step Pipeline
- **Auto-advance** (`kernel.js:129-170`) — step 完成自動推進下一個
- **Route engine** (`route-engine.js`) — 成功→next、失敗→retry/human_review/dead_letter
- **Revision cycle** — review 失敗自動回到 implement（max 2 cycles）
- **Post-check** — 未提交代碼、測試失敗、protected code 違反自動檢測

#### 返工降低
- **Auto-review step** — 自動品質審查
- **Error classification** — 9 種失敗模式，針對性重試
- **Process-review** (`process-review.js`) — 確定性 + LLM 品質評分

#### 批量操作
- **npm run go** (`scripts/go.js`) — `npm run go -- 123 124 125` 一次派發多個
- **POST /api/projects** — 單一 payload 包含多個 task
- **Dependency management** — DFS 循環偵測、依賴完成自動推進

#### Cross-project
- **Repo map** (`management.js:31`) — GitHub slug → 本地路徑
- **Repo resolver** (`repo-resolver.js`) — 解析 target_repo
- **Config 複製** — opencode.json、skills、CLAUDE.md 自動複製到 worktree

### 缺口

| 優先級 | 缺口 | 說明 |
|--------|------|------|
| P0 | Kill step (#214) | 長任務無法中止 |
| P0 | Cancel task (#274) | 無法乾淨關閉任務 |
| P1 | Timeout 誤殺 (#273) | idle detection 綁 stdout，tool 執行中被殺 |
| P1 | Retry-aware prompt (#277) | 重試時不帶上次失敗原因 |
| P1 | Cancelled step state (#219) | kill 後無專用狀態 |
| P2 | 批量 dispatch 無進度回饋 | npm run go 完成後不知各 task 狀態 |
| P2 | Dependency 排序 | ready tasks 順序隨意，無拓撲排序 |
| P2 | UI 批量操作 | Dashboard 無批量 dispatch 按鈕 |

---

## 3. 信任 (Trust)

> 主管敢放權給 agent，因為有 policy + trace + rollback

### 已實現

#### 成本追蹤
- **Usage module** (`usage.js`) — per-user、per-month JSONL 審計
- **Usage limits** (`management.js:25-26`) — dispatches/runtime_sec/tokens per month
- **Budget per task** (`route-engine.js:23-28`) — max 50 LLM calls、2M tokens、30 min、20 steps
- **Budget exceeded → dead letter** — 超預算自動路由到 dead_letter

#### 審計追蹤
- **Task-log JSONL** — append-only，記錄所有事件
- **Task history timeline** (`timeline-task.js`) — 可匯出 HTML/PDF
- **Board signals** — max 500 條狀態變更事件
- **Step artifacts** — per-step input/output/log 完整保存

#### 品質保證
- **Confidence engine L1** (`confidence-engine.js`) — 6 維信號燈（tests、quality、scope、requirements、preflight、agent）
- **Digest task L2** (`digest-task.js`) — LLM 摘要決策
- **Process-review** — 確定性檢查 + LLM 評分，threshold 70
- **Review verdict** (`route-engine.js:91-107`) — approve/reject/revision

#### 權限控制
- **API token auth** (`blackboard-server.js:144-162`) — Bearer token + timing-safe compare
- **Vault** (`vault.js`) — AES-256-GCM per-user credential 加密儲存
- **Rate limiter** (`rate-limiter.js`) — token bucket 120 req/min per IP
- **CORS whitelist** — 可配置允許的 origin
- **Proxy trust** — CF-Connecting-IP / X-Forwarded-For

#### 失敗處理
- **Dead letter** (`kernel.js:275-286`) — 不可恢復的失敗自動標記
- **Failure classification** — 9 種模式，each 有 remediation limit
- **Escalation to human** — 權限/不可恢復失敗 → push notification
- **Protected code guard** — 違反只 revert 受影響檔案，保留其他工作

### 缺口

| 優先級 | 缺口 | 說明 |
|--------|------|------|
| P0 | Budget 不強制 | dispatch 前不檢查預算，只在 routing 時檢查（太晚） |
| P0 | 無 RBAC | API token 一把鑰匙開所有門 |
| P0 | Artifact 不可查詢 | 無 `/api/artifacts` endpoint |
| P1 | 無 per-agent 品質追蹤 | 無法比較「Claude 95% vs Codex 70%」 |
| P1 | 無 rollback API | 無法 git revert + state rollback |
| P1 | Signal 只保留 500 條 | 長期專案丟失歷史 |
| P1 | 無用戶歸屬 | API call 不記錄是誰操作的 |
| P2 | 無 cost-aware retry | 重試不考慮已花費成本 |
| P2 | L3 confidence 未實現 | 完整決策鏈追溯（edda 整合）待做 |
| P2 | 無 post-mortem 分析 | 失敗後無自動根因分析 |

---

## 4. 可組合性 (Composability)

> Runtime 可插拔、model 可切換、step 可組合

### 已實現

#### Runtime 插拔
- **統一合約** (`runtime-contract.js`) — 5 個必需方法 + 啟動時自動驗證
- **4 個 adapter** — openclaw、opencode、codex、claude（+ claude-api）
- **Runtime 選擇** — per-step hint > task hint > default
- **可選依賴** — 未安裝的 runtime 安全跳過

#### Model 切換
- **model_map** (`management.js:33`) — per-runtime、per-step-type
- **優先級鏈** — task.modelHint > model_map[runtime][stepType] > model_map[runtime].default > null
- **即時生效** — 改 controls 不需重啟
- **所有 runtime 支援** — opencode (`--model`)、codex (`-m`)、claude (`--model`)

#### Step 組合
- **Pipeline 可自訂** — string 或 `{ type, instruction, skill, runtime_hint, retry_policy }`
- **預設 pipeline** — plan → implement → review（review 失敗回 implement）
- **Step 輸出串接** (`context-compiler.js`) — 上一步 output → 下一步 input
- **Pipeline 模板** — `resolvePipeline()` 支援模板查找

#### Provider 管理
- **opencode.json** — 自訂 provider 註冊（T8Star、z.ai 等）
- **Config 自動複製** — worktree 建立時複製 opencode.json
- **API key 管理** — .env + vault

#### 跨專案複用
- **Skill 複製** — `.claude/skills/**` 自動複製到 worktree
- **三層 skill 架構** — L1 通用 + L2 專案 + L3 per-step instruction
- **CLAUDE.md / AGENTS.md 複製** — 專案指導自動帶入

### 缺口

| 優先級 | 缺口 | 說明 |
|--------|------|------|
| P0 | 無 discovery endpoint | 無 `/api/capabilities` 列出 runtime/model/provider |
| P0 | 無 provider health check | 無法驗證 API key 有效、endpoint 可達 |
| P1 | 無 step contract | 步驟間無顯式輸入/輸出契約 |
| P1 | 無 pipeline 模板倉庫 | 無預建 security-review 等範本 |
| P1 | 無 cost-based model routing | 預算低不會自動降級模型 |
| P1 | Model hint 無驗證 | modelHint 打錯不會報錯 |
| P2 | 無 hook/plugin system | post-check、review 邏輯無法自訂 |
| P2 | 無 runtime fallback chain | A 失敗無法自動降級到 B |
| P2 | 無 storage abstraction | board/log/artifact 硬綁 fs |
| P2 | 無 skill marketplace | 無版本管理、無依賴宣告 |
| P2 | 無並行 step | pipeline 只支援線性序列 |

---

## P0 缺口清單（跨四大能力）

| # | 缺口 | 影響能力 | 說明 |
|---|------|---------|------|
| 1 | Budget 強制執行 | 可控+信任 | dispatch 前檢查預算，超支自動停止 |
| 2 | Kill step 統一化 (#214) | 可控+效率 | 所有 runtime 支援 graceful cancel |
| 3 | Cancel task 完整性 (#274) | 可控+效率 | worktree cleanup race condition |
| 4 | 審計日誌查詢 API | 信任+可控 | `GET /api/logs` 結構化查詢 |
| 5 | Discovery endpoint | 可組合 | `GET /api/capabilities` 列出可用 runtime/model/provider |
| 6 | Provider health check | 可組合+信任 | 診斷 API 連線、key 有效性 |
| 7 | RBAC | 信任 | per-user 權限控制 |
| 8 | Artifact 查詢 API | 信任 | `GET /api/artifacts` endpoint |

## P1 缺口清單

| # | 缺口 | 影響能力 |
|---|------|---------|
| 9 | Smart idle detection (#273) | 效率+可控 |
| 10 | Retry-aware prompt (#277) | 效率 |
| 11 | Scope lock (#213) | 信任+可控 |
| 12 | Per-agent 品質追蹤 | 信任 |
| 13 | Step contract | 可組合 |
| 14 | Pipeline 模板倉庫 | 可組合 |
| 15 | Cost-based model routing | 信任+可組合 |
| 16 | Rollback API | 信任 |
| 17 | Soft stop / graceful cancel | 可控 |
| 18 | Signal 保留策略 | 信任 |

## P2 缺口清單

| # | 缺口 | 影響能力 |
|---|------|---------|
| 19 | 動態自動化調整 | 可控 |
| 20 | Runtime fallback chain | 可組合 |
| 21 | Storage abstraction | 可組合+信任 |
| 22 | Hook/plugin system | 可組合 |
| 23 | Streaming artifact log | 可控 |
| 24 | Skill marketplace | 可組合 |
| 25 | Execution registry | 可控 |
| 26 | 並行 step | 可組合 |
| 27 | Post-mortem 分析 | 信任 |
| 28 | L3 confidence (edda) | 信任 |

---

## Karvi × Edda 分工規劃

### 區分原則

| 維度 | Karvi 的事 | Edda 的事 |
|------|-----------|----------|
| **時機** | 即時（執行中 <100ms 要答案） | 反思（事後分析、跨 session 學習） |
| **資料** | 執行事件（step 跑了、花了多少 token） | 決策記錄（為什麼選這個、學到什麼） |
| **範圍** | 單次任務/step 生命週期 | 跨任務、跨 session 的模式 |
| **角色** | **執行 + 強制**（擋住、殺掉、限制） | **記錄 + 建議**（追蹤、分析、提案） |

**Karvi 是警察，Edda 是法官 + 歷史學家。**
警察需要即時反應（擋人、抓人），法官需要完整證據和推理（判決、立法）。

### 缺口重新分配

#### 純 Karvi（執行層，Edda 做不了）

| # | 缺口 | 為什麼是 Karvi |
|---|------|---------------|
| 1 | Budget 強制執行 | dispatch 前即時攔截，延遲 <10ms |
| 2 | Kill step (#214) | runtime process 生命週期控制 |
| 3 | Cancel task (#274) | worktree + process 清理 |
| 4 | Discovery endpoint | Karvi 自己知道裝了哪些 runtime |
| 5 | Provider health check | 即時網路探測 |
| 6 | Smart idle detection (#273) | runtime 層 stdout/heartbeat |
| 7 | Retry-aware prompt (#277) | step-worker 注入上下文 |
| 8 | Soft stop / graceful cancel | runtime signal 處理 |
| 9 | Streaming artifact log | 即時 tail -f 執行日誌 |

#### 純 Edda（治理層，Karvi 不該自建）

| # | 缺口 | 為什麼是 Edda |
|---|------|---------------|
| 10 | Decision explanation ledger | 決策追溯是 Edda 核心身份 |
| 11 | Post-mortem 分析 | 跨 session 反思，免疫系統 |
| 12 | L3 confidence（決策鏈） | hash-chained ledger 已有 |
| 13 | Scope lock（邏輯層） | claims + off-limits 協調 |
| 14 | Skill marketplace / 版本管理 | 跨專案知識治理 |

#### Edda 定策略 → Karvi 強制執行（整合項）

| # | 缺口 | Edda 做什麼 | Karvi 做什麼 |
|---|------|------------|-------------|
| 15 | RBAC | 定義 actors + policy.yaml | API middleware 攔截 |
| 16 | Per-agent 品質追蹤 | 聚合歷史數據、算成功率 | 輸出原始 metrics（step 結果、token、cost） |
| 17 | 動態自動化調整 | 分析模式 → 提案 controls patch | 接收 patch、套用到 board |
| 18 | Cost-based model routing | 學習「哪個 model CP 值高」→ 建議 model_map | 在 dispatch 時套用 model_map |
| 19 | Scope lock（強制層） | 定義 claim 範圍 | step-worker post-check 拒絕超範圍 diff |

#### 兩邊都要建但查不同東西

| # | 缺口 | Karvi 的資料 | Edda 的資料 |
|---|------|-------------|------------|
| 20 | 審計查詢 | 執行事件（step timeline、token、cost） | 決策鏈（為什麼選這個 model/runtime） |
| 21 | 通知 | SSE（即時 UI） | ntfy/Telegram（人類非同步通知） |

### 整合管道（需要新建）

```
用戶 → Karvi（派發 + 執行 + 強制）
              ↓ 事件流（step 結果、metrics）
         Edda（記錄 + 分析 + 治理）
              ↓ 建議流（controls patch、policy）
         Karvi（套用建議）
```

| # | 管道 | 說明 |
|---|------|------|
| 22 | Karvi → Edda 事件管道 | step 完成/失敗時，推送到 edda ledger |
| 23 | Edda → Karvi 建議管道 | edda 分析後，POST /api/controls 建議 patch |
| 24 | 共用身份 | RBAC policy 在 Edda，enforcement 在 Karvi，需統一 user identity |

### Edda 應有的完整能力（已有 + 缺口）

Edda 的定位：**Accountable Memory — agent 決策可追溯、可推翻、可審計的治理記憶。**

#### 已有能力

| 能力 | 模組 | 說明 |
|------|------|------|
| **決策追蹤** | edda-core + edda-ledger | hash-chained append-only ledger，`edda decide`/`edda ask` |
| **多 agent 協調** | edda-bridge-claude/peers | claims、off-limits、binding decisions、peer heartbeat |
| **Post-mortem** | edda-postmortem | 6 種觸發器、免疫系統規則 lifecycle（proposed→active→dormant→dead） |
| **結構化查詢** | edda-ask + edda-search-fts | 精確鍵查找、領域查找、關鍵字搜尋、全文索引 |
| **Context 注入** | edda-pack + edda-derive | 預算感知的上下文打包，session start 自動注入 |
| **Transcript 消化** | edda-transcript | delta-based ingestion，分類 tool calls / commits / decisions |
| **計畫編排** | edda-conductor | YAML 多階段計畫、狀態機、check engine、event log |
| **治理審批** | edda-cli/cmd_draft | draft propose/approve/reject，多階段審批流程 |
| **通知** | edda-notify | ntfy / webhook / Telegram，事件型觸發 |
| **即時觀測** | edda-cli/cmd_watch | TUI 即時 peer dashboard、event stream |
| **MCP 整合** | edda-mcp | 7 個 MCP tool，任何 MCP 客戶端可用 |

#### 缺口：Karvi 整合層

Edda 目前是「被動記錄者」— agent 主動呼叫 `edda decide` 才記錄。
要成為「主動治理者」，需要能消費 Karvi 的執行事件並主動行動。

| # | 缺口 | 說明 | 觸發方式 |
|---|------|------|---------|
| A | **Karvi 事件消費者** | 接收 step 結果、token usage、cost → 寫入 ledger | Karvi webhook / SSE 訂閱 |
| B | **Model 品質聚合** | 按 model/runtime 聚合成功率、cost、延遲 | 定期從 ledger 計算 |
| C | **Controls 建議器** | 基於品質數據 → 自動產生 controls_patch 提案 | 品質指標觸發閾值 |
| D | **RBAC 強制 API** | 讓 Karvi 查詢「user X 可以做 action Y 嗎？」 | HTTP API / CLI |
| E | **Scope claim → diff guard** | 把 claim 範圍轉成 Karvi 可用的 file whitelist | 查詢 API |

#### 缺口：主動治理能力

Edda 應該從「被動記錄」進化到「主動發現問題 → 提案 → 等待批准 → 執行」。

| # | 缺口 | 說明 | 理想流程 |
|---|------|------|---------|
| F | **能力掃描器** | 定期掃描 codebase，盤點能力缺口 | 排程 or 觸發（新 milestone 時） |
| G | **趨勢分析** | 成功率下降？成本上升？返工增多？ | 消費 Karvi metrics → 偵測異常 |
| H | **Issue 提案** | 分析結果 → draft propose → 人批准 → gh issue create | `edda propose-issue` |
| I | **Controls 自動調整** | 成功率 < 60% → 提案關 auto_dispatch | `edda propose-patch` → 人批准 → POST /api/controls |
| J | **Model 建議** | 「model X 過去 7 天成功率 95%，cost $0.5/task」→ 建議切換 | 聚合後自動提案 |

#### 缺口：跨專案治理

Edda 管多個專案時，需要統一的治理視角。

| # | 缺口 | 說明 |
|---|------|------|
| K | **跨專案 metrics dashboard** | karvi + edda + game 的品質/成本一覽 |
| L | **Skill 註冊表** | 哪些 skill 在哪些專案、哪個版本、使用率 |
| M | **Decision 跨專案同步** | 「karvi 決定用 OpenRouter」→ edda 同步到其他專案 |
| N | **統一 actor 管理** | 跨專案的 user/agent 身份 + 權限 |

#### 理想運作循環

```
Karvi 執行任務
  → 產生事件（step 結果、metrics）
  → 推送給 Edda

Edda 消化事件
  → 寫入 ledger（永久記錄）
  → 聚合分析（成功率、成本趨勢）
  → 偵測異常（成功率下降、預算超支）

Edda 發現問題
  → 分析根因（跨 session 數據 + 決策鏈）
  → 產生提案（issue draft / controls patch / model 建議）
  → `edda draft propose`（等待人類批准）

人類批准
  → Edda 執行提案
    → gh issue create（開 issue）
    → POST /api/controls（調整 Karvi）
    → edda decide（記錄決策）
```

**關鍵：人類永遠在 loop 裡。** Edda 不自行決定，只提案。
這是 Edda 的核心價值 — 「Accountable」意味著每個改變都有人批准、有記錄、可追溯。

### 背景自動化架構

#### 問題

現在 Edda 的治理功能全靠 agent 主動呼叫（`edda decide`、`edda note`）。
但實際上 agent 在忙著寫程式碼時根本不會記得做這些事。
結果：戰略性對話做了大量決策，一個都沒記到 ledger 裡。

#### 方向：背景代理（Background Agent）

治理分析不需要即時回應。應該用背景 LLM 代理非同步處理：

```
即時路徑（現有，保留）
  bridge hook → 注入 context / 更新 heartbeat → <10ms

背景路徑（新增）
  transcript 落地 → 背景代理偵測 → LLM 處理 → 寫回 ledger
  不阻塞主對話，延遲可接受（秒～分鐘級）
```

#### 背景代理類型

| 代理 | 觸發 | 做什麼 | 產出 |
|------|------|--------|------|
| **Decision Extractor** | 新 transcript chunk | 掃描對話，自動抽取決策 | `edda decide` 寫入 ledger |
| **Session Digester** | session 結束 | 摘要整個 session 的工作 | `edda note` + session digest |
| **Pattern Detector** | 每 N 個 events | 偵測失敗模式、成本異常、品質趨勢 | 異常 signal + draft propose |
| **Capability Scanner** | 定期 / milestone | 掃描 codebase 盤點能力缺口 | issue drafts |
| **Metrics Aggregator** | Karvi step 完成 | 聚合 per-model 成功率、cost | 更新 metrics store |

#### 運作方式

```
                    ┌─────────────────────────────┐
                    │     Edda Background Daemon   │
                    │                              │
  transcript ──────>│  Decision Extractor (LLM)    │──> ledger
  落地檔案          │  Session Digester (LLM)      │──> notes
                    │  Pattern Detector (rules)    │──> alerts
  Karvi SSE ──────>│  Metrics Aggregator (計算)    │──> metrics
  事件流            │  Capability Scanner (LLM)    │──> drafts
                    │                              │
                    └──────────┬───────────────────┘
                               │ 發現問題
                               ▼
                    edda draft propose
                               │ 人類批准
                               ▼
                    gh issue create / POST /api/controls
```

#### 設計原則

1. **不阻塞主流程** — 所有 LLM 呼叫在背景，主對話零延遲
2. **冪等** — 重複處理同一段 transcript 不會產生重複決策
3. **可審計** — 背景代理的每個動作都記入 ledger（`by: "edda-bg/decision-extractor"`）
4. **成本可控** — 用便宜 model（haiku 級別），設 daily budget cap
5. **人類閘門** — 背景代理只產生 draft，不自動執行任何改變

#### 優先實作順序

| 階段 | 代理 | 價值 | 難度 |
|------|------|------|------|
| **Phase 1** | Decision Extractor | 最大痛點 — agent 忘記記錄決策 | 中（需要好的 prompt） |
| **Phase 1** | Session Digester | SessionEnd 時自動摘要 | 低（已有 transcript） |
| **Phase 2** | Metrics Aggregator | Karvi 整合基礎 | 中（需要 SSE 消費） |
| **Phase 2** | Pattern Detector | 異常偵測 | 中（規則 + 閾值） |
| **Phase 3** | Capability Scanner | 最高價值但最複雜 | 高（codebase 分析） |

#### 與 Karvi 的關係

Karvi 已經有背景代理的模式 — step-worker 就是非同步執行 agent 任務。
Edda 的背景代理可以借鑑 Karvi 的 step-worker 架構：
- 用 Karvi dispatch 來執行 Edda 的分析任務（Edda 是 Karvi 的用戶）
- 或 Edda 自建輕量 daemon（不依賴 Karvi，獨立運作）

建議：Phase 1 自建（transcript 處理不需要 Karvi 的 worktree/step 機制），
Phase 2+ 考慮用 Karvi dispatch（複雜分析任務受益於 step pipeline）。

### 核心洞察

不是「這個功能誰做」，是「**這個功能的哪個階段誰做**」。

以品質追蹤為例：
- 原始數據 → Karvi 產生（step 結果、token、cost）
- 聚合分析 → Edda 做（成功率、趨勢）
- 偵測異常 → Edda 主動發現
- 建議調整 → Edda 提案（controls patch / issue draft）
- 人類批准 → draft approve
- 套用執行 → Karvi 強制（model_map 切換）

**兩個產品的分工不是靜態邊界，是動態循環。**

---

## 產品化補充（新增）

> 目的：把「能力盤點」升級為「可驗收、可排期、可定價」的實作文件。

### A. 成功指標（KPI / SLO）

> 說明：以下 baseline 若尚未量測，先以「當前 2 週平均值」回填。目標分為 30 / 60 / 90 天。

| 能力 | 指標 | Baseline | 30 天 | 60 天 | 90 天 |
|---|---|---:|---:|---:|---:|
| 可控性 | step kill 成功率（3 秒內） | TBD | 85% | 93% | 97% |
| 可控性 | task cancel 清理成功率（無殘留 process/worktree） | TBD | 80% | 90% | 95% |
| 可控性 | hard kill 比例（越低越好） | TBD | <40% | <25% | <15% |
| 效率 | issue → PR 中位時間（分鐘） | TBD | -15% | -30% | -40% |
| 效率 | 平均 revision cycle 次數 | TBD | <1.8 | <1.5 | <1.3 |
| 效率 | dead-letter rate | TBD | <12% | <8% | <5% |
| 信任 | 人工介入率（manual escalation/task） | TBD | <25% | <18% | <12% |
| 信任 | 審計查詢 P95 響應時間（logs/artifacts） | TBD | <2s | <1.2s | <800ms |
| 可組合性 | 新增 runtime 導入時間（從 adapter 到可跑） | TBD | <1 天 | <6 小時 | <3 小時 |
| 可組合性 | model hint 失敗率（配置錯誤/不可用） | TBD | <8% | <3% | <1% |

---

### B. P0 缺口驗收標準（Definition of Done）

| P0 項目 | DoD（做到才算完成） | 驗證方式 |
|---|---|---|
| Budget 強制執行 | dispatch 前完成 budget gate；超支回傳結構化錯誤（code + reason + remaining） | API 單元測試 + E2E（超預算 task 被拒） |
| Kill step 統一化 | 4 runtime 進入一致狀態機：`running → cancelling → cancelled/failed`；都支援 timeout fallback | 跨 runtime 整合測試 |
| Cancel task 完整性 | cancel 後無 orphan process、無殘留 lock、worktree 可回收；可重入（重複 cancel 不報錯） | chaos 測試 + 壓力測試 |
| 審計日誌查詢 API | `GET /api/logs` 支援 taskId/time/action/user 過濾、分頁、排序、匯出 | API contract 測試 |
| Discovery endpoint | `GET /api/capabilities` 列出 runtime/model/provider/stepType 與可用狀態 | 啟動後快照比對 |
| Provider health check | 支援 key/endpoint reachability 診斷，區分 auth/network/rate-limit 錯誤 | 模擬失敗注入測試 |
| RBAC | 最少 3 角色（admin/operator/viewer），敏感操作（cancel/kill/controls）有權限閘門 | 權限矩陣測試 |
| Artifact 查詢 API | `GET /api/artifacts` 可依 task/step/type/filter 查詢，支援 metadata + 預簽名下載 | API + UI 驗收 |

---

### C. Karvi × Edda 事件契約（最小可用版本）

> 目的：避免「概念對齊但資料對不起來」。先用 v1 契約把事件流打通。

#### Event Envelope v1

```json
{
  "version": "karvi.event.v1",
  "event_id": "evt_01H...",
  "event_type": "step_started|step_completed|step_failed|step_cancelled",
  "occurred_at": "2026-03-11T04:50:00Z",
  "trace_id": "trace_...",
  "task_id": "task_...",
  "step_id": "step_...",
  "project": "owner/repo",
  "runtime": "openclaw|opencode|codex|claude",
  "model": "...",
  "actor": {
    "kind": "user|agent|system",
    "id": "..."
  },
  "usage": {
    "token_in": 0,
    "token_out": 0,
    "cost_usd": 0,
    "latency_ms": 0
  },
  "result": {
    "status": "success|failed|cancelled",
    "error_code": null,
    "retryable": false
  },
  "decision_ref": null
}
```

#### 契約規則
- `event_id` 全域唯一；consumer 以此做冪等去重。
- `trace_id` 貫穿同一 task 的全部 steps。
- `occurred_at` 一律 ISO-8601 UTC。
- `result.error_code` 使用固定枚舉（network/auth/timeout/policy/...）。
- `decision_ref` 可選，用來回鏈到 Edda ledger event。

---

### D. 能力 → 商業化映射

| 能力模組 | 產品屬性 | 商業意義 |
|---|---|---|
| Budget gate + Kill/Cancel 完整性 | 門檻能力（沒有就不能上線） | 降低事故成本、建立最小可控性 |
| RBAC + Audit Query + Artifact API | 企業必備能力 | 可進 Team/Enterprise 方案與合規採購 |
| Provider health + Discovery | 導入體驗能力 | 降低 POC 摩擦，提高啟用率 |
| Per-agent 品質追蹤 + cost-based routing | 差異化能力 | 可做 Pro 升級（效率/成本優化） |
| Edda L3 decision chain + postmortem | 高階信任能力 | 支撐顧問/治理型高單價服務 |

---

### E. Anti-goals（v1 明確不做）

> 目的：防止 scope creep，保證 P0 先落地。

1. 不做「全自動自治」：所有 controls patch / policy 變更都需 human approval。
2. 不做 plugin marketplace：先把 runtime contract + capabilities API 穩定。
3. 不做跨雲 storage abstraction：v1 固定 fs + API 查詢。
4. 不做並行 step DAG：v1 先穩定線性 pipeline（plan→implement→review）。
5. 不做跨專案統一控制台 UI：先打通事件契約與查詢 API。

---

## 核心檔案參考

| 模組 | 檔案 | 關鍵行號 |
|------|------|---------|
| Runtime 合約 | `runtime-contract.js` | 1-90 |
| Runtime 註冊 | `server.js` | 53-66 |
| Step pipeline | `management.js` | 1080-1139 |
| Step schema | `step-schema.js` | 1-185 |
| Step worker | `step-worker.js` | 78-500+ |
| Route engine | `route-engine.js` | 111-206 |
| Kernel | `kernel.js` | 64-342 |
| Context compiler | `context-compiler.js` | 18-148 |
| Controls | `management.js` | 14-41 |
| Usage tracking | `usage.js` | 1-488 |
| Confidence engine | `confidence-engine.js` | 1-100 |
| Artifact store | `artifact-store.js` | 1-90 |
| Worktree | `worktree.js` | 1-203 |
| Protected guard | `protected-diff-guard.js` | — |
| Vault | `vault.js` | 1-175 |
| Rate limiter | `rate-limiter.js` | 1-152 |
