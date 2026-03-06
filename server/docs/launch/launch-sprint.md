# Karvi Launch Sprint Plan

> 產出日期：2026-03-03
> 角色：Tech Lead
> 依據：37 個 open issues + 現況掃描 + boring-cashcow phase-6 格式
> 雙軌：OSS 自架版（Week 2 末）+ SaaS 付費版（Week 4 末）

---

## Overview

- 專案名稱：Karvi — AI Task Engine（Blackboard Pattern）
- OSS 目標上線日：Week 2 結束
- SaaS 目標上線日：Week 4 結束
- 目前狀態：核心功能完成，8 個 smoke test 失敗，安全漏洞未封
- 月營運成本估算：VPS $26/月（8vCPU 16GB）或 Fly.io ~$15/月
- 零外部依賴：Node.js 22+ 內建模組only

---

## 現況基線

| 類別 | 完成度 | 說明 |
|------|--------|------|
| 核心引擎 | 95% | dispatch, review, pipeline, confidence, timeline 全通 |
| Docker + Fly.io | 85% | Alpine, health check, non-root, persistent volume |
| Auth + Rate Limit | 60% | Token auth 有，auth 端點限流沒接 |
| 測試 | 75% | 22 unit test 檔 + smoke test（8 failures）|
| CI | ✅ | GitHub Actions: syntax + unit + smoke + evolution |
| 監控 | 70% | usage, telemetry, confidence signals, timeline |
| 文件 | 70% | 架構文件齊，部署文件有，操作手冊缺 |
| 安全 | 60% | CORS/Token/Rate Limit 有，競態/偽造/暴力破解未封 |

---

## 人類一次性任務（開工前）

- [ ] 確認 VPS 或 Fly.io 帳號就位 — 5 分鐘
- [ ] 確認域名（如需要）— 10 分鐘
- [ ] 確認 GitHub repo 設定（branch protection rules）— 5 分鐘
- [ ] 確認 Stripe 帳號（SaaS 才需要）— 20 分鐘
- [ ] 設定 `KARVI_API_TOKEN` 環境變數 — 2 分鐘

---

## Week 1: 修 Blockers + 安全封口

> **目標：** CI 全綠 + 安全漏洞全封 + global error handling。
> **Week 1 結束可看到：** `npm test` 全過，所有端點有適當的錯誤回傳和限流。

### Day 1-2: Smoke Test 修復（#154）

- [ ] Task: 修復 8 個 smoke test 失敗
  - Issue: #154
  - Input: `server/smoke-test.js` 失敗清單
  - Output: CI 全綠
  - 工作內容:
    1. `POST /api/participants` — 補 `board.participants` null guard + 409 duplicate 回傳
    2. `POST /api/webhooks/jira` — Jira disabled 回 200 vs 201 + action field 驗證
    3. `GET /api/tasks/:id/digest` — 不存在的 task 回 404 不是 200
    4. `GET /api/tasks/:id/timeline` — 同上
    5. `GET /api/tasks/:id/report` — 同上
    6. `GET /health` — rate limit exempt 修正
  - 預估時間: 4-6 小時
  - 可平行: ❌（所有後續工作依賴 CI 綠）

### Day 3: 安全 — Auth Rate Limiting（#170, #174）

- [ ] Task: 接通 auth 端點限流
  - Issue: #170, #174
  - Input: `server/rate-limiter.js`（已寫好）+ `server/gateway.js`
  - Output: `/auth/login` 10 req/min, `/auth/register` 3 req/min, session verify 有限流
  - 工作內容:
    1. 在 `gateway.js` 的 auth 路由引入 rate-limiter
    2. 登入: 10 req/min per IP
    3. 註冊: 3 req/min per IP
    4. Session 驗證: 30 req/min per IP
    5. 回 429 + Retry-After header
  - 預估時間: 3-4 小時
  - 可平行: ✅

- [ ] Task: 驗證 X-Forwarded-For header（#172）
  - Issue: #172
  - Input: `server/blackboard-server.js` IP 解析邏輯
  - Output: 不信任未驗證的 proxy header
  - 工作內容:
    1. 加入 `KARVI_TRUST_PROXY` 環境變數（預設 false）
    2. 只在 trusted proxy 模式下讀 X-Forwarded-For
    3. 否則直接用 `req.socket.remoteAddress`
  - 預估時間: 2 小時
  - 可平行: ✅

### Day 4: 安全 — 競態條件（#171, #173）

- [ ] Task: Board.json 樂觀鎖
  - Issue: #171
  - Input: `server/storage-json.js`
  - Output: board.json 有 `meta._rev` 版本欄位，CAS write
  - 工作內容:
    1. `readBoard()` 回傳 `{ board, rev }`
    2. `writeBoard(board, expectedRev)` 比對版本，不一致回 409
    3. 每次寫入 `meta._rev` 遞增
    4. 受影響的所有 write 路徑都帶版本
  - 預估時間: 6-8 小時
  - 可平行: ❌（影響所有寫入路徑）

- [ ] Task: Gateway instance port 序列化（#173）
  - Issue: #173
  - Input: `server/gateway.js`
  - Output: port 分配不會競態重複
  - 工作內容: 用簡單的 mutex 或 atomic counter 保護 port 分配
  - 預估時間: 2-3 小時
  - 可平行: ✅

### Day 5: Global Error Handling + Push Notification Fix

- [ ] Task: 加入 global error handler
  - Input: `server/server.js`
  - Output: 無靜默退出
  - 工作內容:
    1. `process.on('unhandledRejection')` — log + 不退出（生產環境）
    2. `process.on('uncaughtException')` — log + graceful shutdown
    3. 每個 async route handler 包 try-catch
  - 預估時間: 3 小時
  - 可平行: ✅

- [ ] Task: Push notification 加 context/signal（#175）
  - Issue: #175
  - Input: push notification 發送邏輯
  - Output: 失敗時有 error context，不再靜默吞錯
  - 預估時間: 2 小時
  - 可平行: ✅

### Day 6-7: 補測試 + 確認全綠

- [ ] Task: 為 Week 1 修復項目補充測試
  - Output: rate limit 429 測試, board locking 409 測試, 404 測試, error handler 測試
  - 預估時間: 4-6 小時
  - 可平行: ❌（需 Day 1-5 完成）

- [ ] Task: 跑完整 CI pipeline 確認全綠
  - Output: `npm test` + `node server/smoke-test.js` 全過
  - 預估時間: 1 小時
  - 可平行: ❌

### Week 1 交付物
- [ ] CI 全綠（0 failures）
- [ ] Auth 端點有 rate limiting
- [ ] Board.json 有樂觀鎖
- [ ] X-Forwarded-For 驗證
- [ ] Global error handlers
- [ ] Push notification error context
- [ ] 新增測試覆蓋以上修復

---

## Week 2: OSS 發布準備

> **目標：** 自架版可用、文件齊全、一鍵部署。
> **Week 2 結束可看到：** 外部使用者可以 `docker run` 或 `fly deploy` 跑起來。

### Day 1-2: 部署文件 + 操作手冊

- [ ] Task: 更新 Docker 部署文件
  - Output: `server/docs/launch/deploy-docker.md`
  - 工作內容:
    1. Docker Compose 範例（含 volume mount、env vars、health check）
    2. 從 0 到跑起來的 step-by-step
    3. 環境變數完整清單 + 說明
    4. 常見問題 FAQ
  - 預估時間: 3 小時
  - 可平行: ✅

- [ ] Task: 撰寫 Runbook（On-Call 操作手冊）
  - Output: `server/docs/launch/runbook.md`
  - 工作內容:
    1. Server 不回應 → 怎麼查
    2. Board.json 損壞 → 怎麼恢復（.bak + task-log.jsonl 重建）
    3. Task 卡在 running → 怎麼手動重設
    4. Rate limit 誤封 → 怎麼解
    5. Agent timeout → 怎麼調整 controls
    6. Disk 快滿 → 怎麼清 log
  - 預估時間: 4 小時
  - 可平行: ✅

- [ ] Task: 撰寫備份策略
  - Output: `server/docs/launch/backup-strategy.md`
  - 工作內容:
    1. VPS: cron rsync board.json + task-log.jsonl 到遠端
    2. Fly.io: `fly volumes snapshots` 排程
    3. 手動備份指令
    4. 災難恢復流程（從 backup 還原）
  - 預估時間: 2 小時
  - 可平行: ✅

### Day 3: Load Test + 壓力測試

- [ ] Task: 建立 load test 腳本
  - Output: `server/test-load.js`
  - 工作內容:
    1. 模擬 50 並發 client 打 API
    2. 混合 read (GET /api/board) + write (POST /api/tasks/:id/status)
    3. 測量 p50/p95/p99 latency
    4. 確認 rate limiter 正常觸發
    5. 確認 board locking 無 data loss
  - 預估時間: 4-6 小時
  - 可平行: ❌

- [ ] Task: 執行 load test + 修復瓶頸
  - Output: load test 報告 + 瓶頸修復
  - 預估時間: 3-4 小時
  - 可平行: ❌

### Day 4: Structured Logging + Version Endpoint

- [ ] Task: 加入 structured JSON logging
  - Output: 更新 `server/server.js` logging
  - 工作內容:
    1. 封裝 `log(level, msg, meta)` → JSON line to stdout
    2. 替換所有 `console.log` 為 `log()`
    3. 包含 timestamp, level, msg, request_id, task_id
    4. 環境變數 `KARVI_LOG_FORMAT=json|text`（預設 text for dev, json for prod）
  - 預估時間: 4-5 小時
  - 可平行: ✅

- [ ] Task: 實作 GET /api/version（#114）
  - Issue: #114
  - Output: `/api/version` 回傳 version + git hash + uptime
  - 預估時間: 1 小時
  - 可平行: ✅

### Day 5: Refactoring — server.js 瘦身（#147）

- [ ] Task: 評估並開始 server.js 模組拆分
  - Issue: #147
  - Output: 至少拆出 task-routes.js, review-routes.js
  - 工作內容: 根據 #147 的計畫，把 server.js 最大的 route handler 拆出
  - 預估時間: 6-8 小時
  - 可平行: ❌

### Day 6-7: OSS Release Prep

- [ ] Task: 撰寫 README 更新（安裝 + 快速開始）
  - Output: 更新 `README.md`
  - 工作內容:
    1. 一行安裝指令（docker run / npm start）
    2. 3 分鐘快速開始指南
    3. 功能概覽 + 截圖
    4. 環境變數表
    5. 開發者貢獻指南
  - 預估時間: 3 小時
  - 可平行: ✅

- [ ] Task: 撰寫 CHANGELOG + tag v0.1.0
  - Output: `CHANGELOG.md` + git tag `v0.1.0`
  - 預估時間: 1 小時
  - 可平行: ✅

- [ ] 🔴 **人類操作：** 決定是否公開 repo + 確認 license
  - 預估時間: 人類 10 分鐘

### Week 2 交付物
- [ ] 完整部署文件（Docker, Fly.io, VPS）
- [ ] Runbook 操作手冊
- [ ] 備份策略文件
- [ ] Load test 腳本 + 報告
- [ ] Structured JSON logging
- [ ] GET /api/version
- [ ] server.js 模組拆分（至少 2 個模組）
- [ ] README 更新
- [ ] v0.1.0 tag
- [ ] 🔴 人類確認 license

---

## Week 3: SaaS 基礎建設

> **目標：** 多租戶 + 計費 + 安全沙箱。
> **Week 3 結束可看到：** 付費使用者可以註冊、建立 instance、付費。

### Day 1-2: Billing 整合（#35）

- [ ] Task: Stripe 計費整合
  - Issue: #35
  - Input: Stripe API + gateway.js
  - Output: 訂閱管理 + 用量計費
  - 工作內容:
    1. Stripe Checkout Session 建立（free/pro/team tier）
    2. Webhook 接收 subscription events
    3. Usage-based billing（dispatch 次數 / runtime 秒數）
    4. 用量超限 → 暫停 dispatch + 通知
  - 預估時間: 2-3 天
  - 可平行: ❌

### Day 3-4: 安全沙箱（#168）

- [ ] Task: 使用者代碼沙箱隔離
  - Issue: #168
  - Input: runtime-*.js
  - Output: 每個 agent spawn 在隔離容器內
  - 工作內容:
    1. 文件系統隔離（chroot / container）
    2. 網路限制（只允許白名單 domain）
    3. CPU/Memory limits（cgroups）
    4. Timeout 強制終止
  - 預估時間: 2-3 天
  - 可平行: ✅

### Day 5: Repo 自動配置（#167）

- [ ] Task: 自動 git clone + worktree 隔離
  - Issue: #167
  - Input: 使用者提供 repo URL
  - Output: per-task worktree，互不干擾
  - 預估時間: 1 天
  - 可平行: ✅

### Day 6-7: 加密 + 安全審計

- [ ] Task: 靜態加密（#169）
  - Issue: #169
  - Output: `/data` 目錄內容 AES-256 加密
  - 預估時間: 1 天
  - 可平行: ✅

- [ ] Task: OWASP Top 10 安全審計
  - Output: `server/docs/launch/security-audit.md`
  - 工作內容: 逐項檢查所有 API 端點（injection, XSS, auth bypass, SSRF 等）
  - 預估時間: 1 天
  - 可平行: ✅

### Week 3 交付物
- [ ] Stripe 計費整合
- [ ] 使用者代碼沙箱
- [ ] 自動 repo 配置
- [ ] 靜態加密
- [ ] 安全審計報告

---

## Week 4: SaaS 上線 + 監控 + Outreach

> **目標：** SaaS 正式上線，監控跑起來，首批使用者入場。
> **Week 4 結束可看到：** 付費使用者在用，監控告警正常，自動化維運跑著。

### Day 1-2: 監控 + 告警

- [ ] Task: 建立監控 dashboard
  - Output: 內建 `/admin/metrics` 頁面 或 Prometheus exporter
  - 工作內容:
    1. Active users / dispatches per hour / error rate
    2. Board.json size + task-log.jsonl growth rate
    3. Agent success rate / avg duration
    4. Rate limit hit count
  - 預估時間: 1 天
  - 可平行: ✅

- [ ] Task: 設定告警規則
  - Output: 告警 → push notification / email
  - 工作內容:
    1. Server down > 1 min → alert
    2. Error rate > 5% → alert
    3. Disk usage > 80% → alert
    4. Agent timeout rate > 20% → alert
  - 預估時間: 4 小時
  - 可平行: ✅

### Day 3: CD Pipeline（#40）

- [ ] Task: 自動部署 pipeline
  - Issue: #40
  - Output: `.github/workflows/cd.yml`
  - 工作內容:
    1. main merge → test → build Docker image → deploy to Fly.io/VPS
    2. Rollback on health check failure
    3. Slack/push notification on deploy success/failure
  - 預估時間: 1 天
  - 可平行: ✅

### Day 4-5: Beta Launch

- [ ] Task: Soft launch 準備
  - Output: beta 環境 ready
  - 工作內容:
    1. 建立 beta 環境（獨立 instance）
    2. 邀請 5-10 beta users
    3. 建立 feedback 收集管道（GitHub Discussions / Discord）
  - 預估時間: 4 小時
  - 可平行: ❌

- [ ] 🔴 **人類操作：** 邀請 beta users + 設定 Stripe live mode
  - 預估時間: 人類 30 分鐘

- [ ] Task: 修復 beta feedback
  - Output: 根據使用者回報修 bug
  - 預估時間: 2 天（預留）
  - 可平行: ❌

### Day 6-7: 上線 + Outreach

- [ ] Task: 撰寫 launch 文案
  - Output: `server/docs/launch/launch-posts.md`
  - 工作內容: Reddit / HN Show / Twitter thread / Dev.to 文章
  - 預估時間: 3 小時
  - 可平行: ✅

- [ ] 🔴 **人類操作：** 發布 launch posts
  - 預估時間: 人類 15 分鐘

- [ ] Task: 上線前最終檢查
  - Output: `server/docs/launch/final-check-result.md`
  - 工作內容: 跑完整 checklist（見 launch-checklist.md）
  - 預估時間: 2 小時
  - 可平行: ❌

### Week 4 交付物
- [ ] 監控 dashboard + 告警規則
- [ ] CD pipeline
- [ ] Beta 使用者 feedback 已修
- [ ] Launch posts 已發布
- [ ] 最終檢查通過

---

## 時間總覽

| 週次 | 主題 | 工作量 | 人類操作 | 關鍵交付物 |
|------|------|--------|----------|-----------|
| Week 1 | 修 Blockers + 安全 | ~40 小時 | 無 | CI 全綠 + 安全封口 |
| Week 2 | OSS 發布 | ~35 小時 | License 確認 10 分鐘 | v0.1.0 可自架 |
| Week 3 | SaaS 基礎建設 | ~45 小時 | 無 | Billing + 沙箱 + 加密 |
| Week 4 | SaaS 上線 | ~30 小時 | Beta 邀請 + Launch 45 分鐘 | 正式上線 🚀 |
| **合計** | | **~150 小時** | **~1 小時** | |

---

## Issue → Sprint 對照

| Issue | 標題 | Sprint | Priority |
|-------|------|--------|----------|
| #154 | smoke test 8 failures | W1 D1-2 | P0 |
| #170 | auth rate limiting | W1 D3 | P0 |
| #172 | X-Forwarded-For | W1 D3 | P0 |
| #171 | board optimistic locking | W1 D4 | P0 |
| #173 | gateway port race | W1 D4 | P0 |
| #175 | push notification context | W1 D5 | P1 |
| #174 | session rate limit | W1 D3 | P1 |
| #114 | GET /api/version | W2 D4 | P2 |
| #147 | server.js 瘦身 | W2 D5 | P2 |
| #35 | Stripe billing | W3 D1-2 | P1 (SaaS) |
| #168 | code sandbox | W3 D3-4 | P1 (SaaS) |
| #167 | repo provisioning | W3 D5 | P2 (SaaS) |
| #169 | encryption at rest | W3 D6 | P2 (SaaS) |
| #40 | CD pipeline | W4 D3 | P2 |

### 本次不排入的 Issues（Post-Launch）

| Issue | 標題 | 理由 |
|-------|------|------|
| #2 | SQLite/Postgres | 1000+ users 才需要 |
| #118 | Mobile remote access | 差異化功能，非上線必須 |
| #116 | Semantic pipeline | 進階功能 |
| #148-150 | Multi-village / Territory / Nation | 架構演進，上線後 |
| #143-146 | Refactoring batch | 可逐步做 |
| #160-165 | Village governance | 功能演進 |
| #183 | PR #182 review suggestions | 非阻塞 |

---

*Sprint Plan 完成。Week 1 修 blocker 確保 CI 綠 + 安全，Week 2 發 OSS v0.1.0，Week 3-4 只在走 SaaS 路線時才需要。每個 task 獨立可執行，人類操作集中在 Week 2 末和 Week 4。*
