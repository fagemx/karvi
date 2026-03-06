# Karvi Launch Readiness — Gap Analysis & Sprint Plan

> 產出日期：2026-03-03
> 版本：v0.1.0 → v1.0 目標
> 依據：codebase 全面探勘 + 36 個 open issues + 20 個 closed issues

---

## Overview

Karvi 目前是**可運作的 self-hosted MVP**，但離「用戶能低阻力上手」還差一段距離。
本文件拆成兩條路線：

| 路線 | 目標用戶 | 上線標準 |
|------|----------|----------|
| **Track A: Self-Hosted** | 開發者自架 | `git clone → npm start → 能用` |
| **Track B: SaaS** | 付費用戶 | 多租戶 + 付款 + 99.5% uptime |

Track A 是前提，Track B 建在 A 之上。

---

## 現況快照

| 類別 | 狀態 | 說明 |
|------|------|------|
| HTTP Server | 🟡 | CORS/Rate-limit/Auth 都有，但無 TLS、無 request tracing |
| 認證 | 🟡 | Bearer token 可用，無 session 管理、無 token 過期 |
| 資料持久化 | 🔴 | board.json 單點故障，無備份、無腐壞復原 |
| 日誌 | 🔴 | console.log 字串，無結構化、無 correlation ID |
| 監控 | 🔴 | `/health` 只回當下狀態，無時序指標、無告警 |
| 測試 | 🟡 | 25 個測試檔，CI 有 8 個 failure (#154) |
| 部署 | 🟡 | Dockerfile + Fly/Railway 文件有，無 K8s、無 staging |
| 文件 | 🟡 | README 清楚，缺 API 範例、troubleshooting、runbook |
| UI | 🟡 | 響應式 + SSE 即時，缺分頁/搜尋/離線/undo |
| 多租戶 | 🔴 | 單 board，無用戶隔離、無 RBAC |
| 擴展 | 🔴 | 單程序 + JSON 檔案，上限 ~10 concurrent tasks |

---

## Track A: Self-Hosted Launch (2 週)

> **目標：** 開發者能在 10 分鐘內跑起來，穩定跑一個月不壞。
> **交付：** v0.2.0 release tag

### Sprint A1: 信任基礎 (Week 1)

讓用戶信任這東西不會壞、壞了能救。

#### Day 1-2: 啟動安全 + 輸入驗證

- [ ] **Task: 啟動驗證 — 無 token 時警告** (#196)
  - 現狀：`KARVI_API_TOKEN` 未設時 server 靜默啟動，public 網路裸奔
  - 做法：啟動時偵測 bind address，非 localhost 且無 token → 大字警告 + 5 秒倒數
  - Output: `server/startup-checks.js` (~50 行)
  - 預估：1 小時
  - 可平行：✅

- [ ] **Task: Board 寫入驗證 — 防止結構腐壞**
  - 現狀：`POST /api/tasks` 直接 `Object.assign(board, payload)` 無驗證
  - 做法：加 JSON Schema 驗證，拒絕不符格式的寫入
  - Output: `server/board-schema.js` (~100 行) + 驗證中介層
  - 預估：2 小時
  - 可平行：✅

- [ ] **Task: 安全 Headers**
  - 現狀：無 CSP、X-Content-Type-Options、X-Frame-Options
  - 做法：在 `blackboard-server.js` response 統一加 headers
  - Output: 修改 `server/blackboard-server.js` (~10 行)
  - 預估：30 分鐘
  - 可平行：✅

#### Day 3-4: 備份 + 復原

- [ ] **Task: Board 自動備份**
  - 現狀：board.json 是唯一副本，壞了全沒
  - 做法：每次寫入前，保留最近 N 個 snapshot (`board.json.1`, `.2`, `.3`)
  - 限制：最多 5 個備份（~1MB），寫入時旋轉
  - Output: 修改 `server/blackboard-server.js` writeBoard (~30 行)
  - 預估：1.5 小時
  - 可平行：❌（改同一個函式）

- [ ] **Task: Board 腐壞自動復原**
  - 現狀：board.json 損壞 → server 起不來（JSON.parse throws）
  - 做法：`readBoard()` catch parse error → 從最近的 `.1` `.2` `.3` 自動回復 → 記 log
  - Output: 修改 `server/blackboard-server.js` readBoard (~20 行)
  - 預估：1 小時
  - 可平行：❌（接上一個 task）

- [ ] **Task: task-log.jsonl 旋轉**
  - 現狀：append-only 無上限，估 250KB/天 → 91MB/年
  - 做法：超過 10MB 時 rename → `task-log.jsonl.1`，保留 3 份
  - Output: 修改 `server/blackboard-server.js` (~20 行)
  - 預估：1 小時
  - 可平行：✅

#### Day 5-6: CI 修復 + 測試補強

- [ ] **Task: 修復 CI 8 個 smoke test failure** (#154)
  - 現狀：participants, jira, tasks, health 端點有 8 個失敗
  - 做法：逐一修復或標記 skip（需跑 CI 確認）
  - Output: 修改 `server/smoke-test.js` + 相關端點
  - 預估：3 小時
  - 可平行：❌

- [ ] **Task: Docker build 加入 CI**
  - 現狀：`ci.yml` 不測 Dockerfile，壞了不知道
  - 做法：加 `docker build` step 到 CI
  - Output: 修改 `.github/workflows/ci.yml`
  - 預估：30 分鐘
  - 可平行：✅

#### Day 7: 結構化日誌

- [ ] **Task: console.log → 結構化 JSON 日誌**
  - 現狀：所有 log 是字串，無 timestamp、無 level、無 request context
  - 做法：建 `server/logger.js`（零依賴），輸出 JSON lines
  - 格式：`{"ts":"...","level":"info","msg":"...","req_id":"...","module":"kernel"}`
  - 暫不改全部，先包裝 + 在關鍵路徑使用（dispatch, step-worker, kernel）
  - Output: `server/logger.js` (~60 行) + 關鍵模組改用
  - 預估：3 小時
  - 可平行：❌

### Sprint A1 交付物
- [ ] 啟動時無 token 警告 ✅
- [ ] Board 寫入驗證 ✅
- [ ] 安全 Headers ✅
- [ ] 自動備份 (5 個 rotation) ✅
- [ ] 腐壞自動復原 ✅
- [ ] Log 旋轉 ✅
- [ ] CI 0 failure ✅
- [ ] Docker build 在 CI ✅
- [ ] 結構化日誌基礎 ✅

---

### Sprint A2: 上手體驗 (Week 2)

讓用戶從 clone 到跑起來不卡關。

#### Day 1-2: 文件補齊

- [ ] **Task: API 文件 — 每個端點有 curl 範例**
  - 現狀：README 列端點表，但沒 request/response 範例
  - 做法：建 `docs/api-reference.md`，每個端點附 curl + 預期 response
  - 預估：3 小時
  - 可平行：✅

- [ ] **Task: Troubleshooting 指南**
  - 現狀：無
  - 做法：收集常見問題（SSE 斷線、runtime 找不到、board 鎖死、dispatch 卡住）
  - Output: `docs/troubleshooting.md`
  - 預估：2 小時
  - 可平行：✅

- [ ] **Task: 事件 Runbook**
  - 現狀：無
  - 做法：寫 3 個場景的 step-by-step 復原流程：
    1. Board.json 腐壞
    2. Step 卡死（lock 過期）
    3. Runtime dispatch 無限重試
  - Output: `docs/runbook.md`
  - 預估：1.5 小時
  - 可平行：✅

#### Day 3-4: UI 最低可用改善

- [ ] **Task: 任務搜尋/篩選**
  - 現狀：50+ 個 task 要全部捲動找
  - 做法：加 client-side 搜尋框 + status filter dropdown
  - Output: 修改 `index.html` (~50 行 JS)
  - 預估：2 小時
  - 可平行：✅

- [ ] **Task: SSE 連線狀態指示器**
  - 現狀：SSE 斷了用戶不知道，以為系統卡住
  - 做法：右上角小圓點（綠=連線/紅=斷線/黃=重連中）
  - Output: 修改 `index.html` (~30 行)
  - 預估：1 小時
  - 可平行：✅

- [ ] **Task: 錯誤訊息改善**
  - 現狀：所有錯誤用 `alert()` 彈窗
  - 做法：改成頁面頂部 toast notification，3 秒自動消失
  - Output: 修改 `index.html` (~40 行)
  - 預估：1 小時
  - 可平行：✅

#### Day 5-6: 部署體驗

- [ ] **Task: .env.example 完善**
  - 現狀：散落在 deploy.md，新用戶不知道要設什麼
  - 做法：建 `.env.example` 列所有 env vars + 註解
  - Output: `.env.example`
  - 預估：30 分鐘
  - 可平行：✅

- [ ] **Task: docker-compose.yml**
  - 現狀：只有 Dockerfile，沒有一鍵啟動
  - 做法：`docker-compose.yml` 含 volume mount + env file + health check
  - Output: `docker-compose.yml`
  - 預估：1 小時
  - 可平行：✅

- [ ] **Task: 首次啟動引導**
  - 現狀：`npm start` 後看到空白 board，不知道下一步
  - 做法：偵測空 board → 顯示 welcome message + 建議第一步（建 task / 設 runtime）
  - Output: 修改 `index.html` (~30 行) + `server/server.js` 初始化邏輯
  - 預估：1.5 小時
  - 可平行：✅

#### Day 7: 版本 + Release

- [ ] **Task: 版本端點** (#114)
  - 做法：`GET /api/version` → `{ version: "0.2.0", node: "22.x", uptime: ... }`
  - Output: 修改 `server/server.js` (~10 行)
  - 預估：30 分鐘
  - 可平行：✅

- [ ] **Task: CHANGELOG + Release Tag**
  - 做法：整理 v0.1.0 → v0.2.0 所有變更，打 git tag，建 GitHub Release
  - Output: `CHANGELOG.md` + `v0.2.0` tag
  - 預估：1 小時
  - 可平行：❌

### Sprint A2 交付物
- [ ] API 文件（curl 範例）✅
- [ ] Troubleshooting 指南 ✅
- [ ] 事件 Runbook ✅
- [ ] UI 搜尋/篩選 ✅
- [ ] SSE 連線指示器 ✅
- [ ] Toast 錯誤訊息 ✅
- [ ] .env.example ✅
- [ ] docker-compose.yml ✅
- [ ] 首次啟動引導 ✅
- [ ] /api/version 端點 ✅
- [ ] v0.2.0 Release ✅

---

## Track B: SaaS Launch (額外 4-6 週)

> **前提：** Track A 完成
> **目標：** 多用戶 + 付款 + 99.5% uptime

### Phase B1: 多租戶基礎 (Week 3-4)

- [ ] **Optimistic Locking** (#171) — 防止 read-modify-write race
- [ ] **Storage 抽象層** (#2) — JSON → SQLite（單機）→ PostgreSQL（多機）
- [ ] **多租戶 Board 隔離** (#148) — 每用戶獨立 board + API scope
- [ ] **Auth + Session 管理** (#20-23) — OAuth / JWT / token rotation / TLS
- [ ] **Gateway 安全** (#170, #172, #173, #174) — rate limit auth、port allocation race、XFF 驗證
- [ ] **Container Sandbox** (#168) — 用戶 code 在容器內執行

### Phase B2: 營運能力 (Week 5-6)

- [ ] **Prometheus Metrics** — request latency, error rate, queue depth, SSE connections
- [ ] **Alerting** — Grafana / PagerDuty 整合
- [ ] **Request Tracing** — OpenTelemetry correlation IDs
- [ ] **Encryption at Rest** (#169) — 用戶資料全加密
- [ ] **Stripe Billing** (#35) — 訂閱制付款
- [ ] **Auto Repo Provisioning** (#167) — git clone + worktree per task
- [ ] **CD Pipeline** (#40) — main merge → auto deploy

### Phase B3: 成長功能 (Week 7+)

- [ ] **Mobile Remote Access** (#118) — tunnel + auth + human gate
- [ ] **Push Notifications** (#49) — 行動端推播
- [ ] **Chronicle** (#186) — 多工具 session 追蹤
- [ ] **Confidence System** (#52-54) — L1 信號燈 / L2 摘要 / L3 深度時間線
- [ ] **Village Governance** (#160-165) — 治理層完整實作
- [ ] **Nation Layer** (#149-150) — 跨 village 協調 + Nox coordinator

---

## Launch Checklist

### Track A: Self-Hosted (v0.2.0)

#### 技術
- [ ] `git clone && npm start` 10 分鐘內可用
- [ ] CI 全綠（0 failure）
- [ ] Docker build 成功
- [ ] docker-compose up 一鍵可跑
- [ ] 無 token 啟動會警告
- [ ] Board 寫入有驗證
- [ ] 備份/復原機制運作
- [ ] 日誌旋轉正常

#### 文件
- [ ] README quick start 跑完無卡關
- [ ] API 每個端點有 curl 範例
- [ ] .env.example 完整
- [ ] Troubleshooting 指南有覆蓋 top 5 問題
- [ ] Runbook 有覆蓋 3 個關鍵場景

#### UI
- [ ] 首次啟動有引導
- [ ] 任務可搜尋/篩選
- [ ] SSE 斷線可見
- [ ] 錯誤不用 alert()

#### 安全
- [ ] Security Headers 存在（CSP, X-Content-Type-Options, X-Frame-Options）
- [ ] 無硬編碼 credentials
- [ ] .env 在 .gitignore

### Track B: SaaS (v1.0)

#### 基礎設施
- [ ] SQLite/PostgreSQL 儲存
- [ ] 多租戶用戶隔離
- [ ] OAuth + JWT 認證
- [ ] Container sandbox
- [ ] Encryption at rest
- [ ] Prometheus + Grafana 監控
- [ ] 99.5% uptime SLO 定義

#### 營運
- [ ] Auto-deploy CI/CD
- [ ] Alerting 設定
- [ ] Request tracing
- [ ] Backup + DR 流程驗證
- [ ] Incident runbook 完整
- [ ] Load test 通過（目標 TBD）

#### 商業
- [ ] Stripe 訂閱制上線
- [ ] 定價頁面
- [ ] Terms of Service
- [ ] Privacy Policy

---

## 時間總覽

| 階段 | 主題 | 工作量 | 關鍵交付物 |
|------|------|--------|-----------|
| Sprint A1 (Week 1) | 信任基礎 | ~14 小時 | 備份/復原 + 輸入驗證 + CI 全綠 |
| Sprint A2 (Week 2) | 上手體驗 | ~15 小時 | 文件 + UI 改善 + docker-compose + v0.2.0 |
| Phase B1 (Week 3-4) | 多租戶 | ~40 小時 | 儲存層 + Auth + Gateway 安全 |
| Phase B2 (Week 5-6) | 營運能力 | ~30 小時 | Metrics + Billing + CD |
| Phase B3 (Week 7+) | 成長功能 | 持續 | Mobile + Confidence + Governance |

---

## Open Issues 對照表

已有 GitHub Issue 的項目直接連結，沒有的標 `NEW`。

| 項目 | Issue | Sprint |
|------|-------|--------|
| 啟動無 token 警告 | #196 | A1 |
| Board 寫入驗證 | NEW | A1 |
| 安全 Headers | NEW | A1 |
| Board 備份/復原 | NEW | A1 |
| Log 旋轉 | NEW | A1 |
| CI 修復 | #154 | A1 |
| Docker CI | NEW | A1 |
| 結構化日誌 | NEW | A1 |
| API 文件 | NEW | A2 |
| Troubleshooting | NEW | A2 |
| Runbook | NEW | A2 |
| UI 搜尋/篩選 | NEW | A2 |
| SSE 指示器 | NEW | A2 |
| Toast 錯誤 | NEW | A2 |
| .env.example | NEW | A2 |
| docker-compose | NEW | A2 |
| 首次引導 | NEW | A2 |
| /api/version | #114 | A2 |
| Optimistic Locking | #171 | B1 |
| Storage 抽象 | #2 | B1 |
| 多租戶 | #148 | B1 |
| Auth | #20-23 | B1 |
| Gateway 安全 | #170-174 | B1 |
| Container Sandbox | #168 | B1 |
| Metrics | NEW | B2 |
| Billing | #35 | B2 |
| CD Pipeline | #40 | B2 |
| Encryption | #169 | B2 |
| Repo Provisioning | #167 | B2 |
| Mobile Access | #118 | B3 |
| Push Notifications | #49 | B3 |
| Confidence System | #52-54 | B3 |

---

*Track A 完成後，開發者能信任這工具不會壞、壞了能救、文件找得到答案。*
*Track B 完成後，可以開始收錢。*
