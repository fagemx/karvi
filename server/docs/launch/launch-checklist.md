# Karvi 上線 Checklist

> 逐項勾選，全過才上線。分 OSS 自架版和 SaaS 版兩軌。

---

## 技術基礎（OSS + SaaS 都要）

### 核心功能
- [ ] `npm start` 可正常啟動（port 3461）
- [ ] `GET /health` 回 200 + JSON
- [ ] `GET /api/board` 回 board.json 內容
- [ ] `GET /api/events` SSE 連線正常，board 更新即時推送
- [ ] Task lifecycle 完整：pending → dispatched → in_progress → completed
- [ ] Pipeline dispatch 正常：step 依序執行、失敗回退
- [ ] Review 流程正常：auto-review → score → pass/fail
- [ ] Confidence signals 計算正確（6 維）
- [ ] Timeline 事件正常記錄到 task-log.jsonl

### 穩定性
- [ ] `npm test` 全過（0 failures）
- [ ] `node server/smoke-test.js 3461` 全過
- [ ] 無 console error（正常操作下）
- [ ] Server restart 後自動恢復 expired locks
- [ ] Graceful shutdown 正常（SIGTERM + POST /api/shutdown）
- [ ] `process.on('unhandledRejection')` 不會靜默退出
- [ ] `process.on('uncaughtException')` 觸發 graceful shutdown
- [ ] Load test 50 並發無 data loss

### 安全
- [ ] `KARVI_API_TOKEN` 環境變數啟用時，無 token 的請求回 401
- [ ] CORS 只允許白名單 origin（`KARVI_CORS_ORIGINS`）
- [ ] Rate limiting 啟用（120 req/min per IP，可配置）
- [ ] Auth 端點有獨立限流（login 10/min, register 3/min）
- [ ] Board.json 有樂觀鎖（`meta._rev`），並發寫入不互相覆蓋
- [ ] X-Forwarded-For 只在 trusted proxy 模式下使用
- [ ] 無已知 XSS、注入、path traversal 漏洞
- [ ] `.env` 和 vault 檔案在 `.gitignore`

### 資料安全
- [ ] Board.json 原子寫入（.tmp → rename）
- [ ] Board.json.bak 備份存在
- [ ] Task-log.jsonl append-only，不會被覆蓋
- [ ] 備份策略已文件化（至少手動備份指令）
- [ ] 災難恢復流程已測試（從 backup 還原 board.json）

### 部署
- [ ] Docker image build 成功
- [ ] `docker run` 可啟動 + health check 通過
- [ ] Fly.io deploy 成功（如使用）
- [ ] 環境變數完整清單已文件化
- [ ] Persistent volume 掛載正確（/data 目錄）
- [ ] HTTPS 已啟用（reverse proxy 或 Cloudflare Tunnel）

### 監控
- [ ] `/health` 端點可被外部監控打
- [ ] Telemetry 可關閉（`KARVI_TELEMETRY=0`）
- [ ] Usage tracking 正常記錄（dispatches, runtime seconds, tokens）
- [ ] 錯誤有足夠 context（不是 "something went wrong"）

### 文件
- [ ] README 有快速開始指南
- [ ] 環境變數表完整
- [ ] API 端點清單（至少列出 method + path + 說明）
- [ ] Runbook（常見問題 + 解法）
- [ ] 備份策略文件
- [ ] CHANGELOG 存在

---

## SaaS 專屬（Week 3-4 才勾）

### 多租戶
- [ ] 使用者註冊 + 登入正常
- [ ] 每個使用者有獨立 board instance
- [ ] Instance 間資料完全隔離
- [ ] 使用者刪除帳號 → 資料清除

### 計費
- [ ] Stripe 訂閱建立正常
- [ ] Webhook 接收 subscription events
- [ ] 用量計費正常（dispatch 次數 / runtime）
- [ ] 超限暫停 + 通知
- [ ] 免費 tier 有限制
- [ ] 付費 tier 解鎖

### 安全（進階）
- [ ] 使用者代碼沙箱隔離
- [ ] 網路限制（白名單 domain）
- [ ] CPU/Memory limits
- [ ] 靜態加密已啟用
- [ ] OWASP Top 10 審計通過

### 合規
- [ ] Privacy Policy 頁面
- [ ] Terms of Service 頁面
- [ ] Cookie consent（如適用）
- [ ] GDPR data export（如服務歐洲使用者）

### 自動化
- [ ] CD pipeline：main merge → test → deploy
- [ ] Health check 失敗 → auto rollback
- [ ] 告警規則：server down / error rate / disk usage

---

## 上線日當天

### 上線前（T-1 小時）
- [ ] 最新 main branch 已 deploy
- [ ] Health check 綠燈
- [ ] 手動測試核心流程（建 task → dispatch → complete）
- [ ] 監控 dashboard 看得到數據
- [ ] 備份已做一份

### 上線後（T+1 小時）
- [ ] 確認外部可存取
- [ ] 確認第一個使用者可以操作
- [ ] 確認 SSE 即時更新正常
- [ ] 確認無異常 error log
- [ ] 截圖存證（for 紀念）

### 上線後（T+24 小時）
- [ ] 檢查 error log 無異常
- [ ] 檢查 disk usage 正常
- [ ] 檢查 rate limit 無誤封
- [ ] 收集第一批 feedback

---

## Go/No-Go 判斷

### OSS 版 Go 條件（全部必須 Yes）
1. `npm test` 全過？
2. Smoke test 全過？
3. Docker run 可用？
4. README 可讀？
5. 無已知 P0 bug？

→ 5/5 Yes = **GO**，否則 **NO-GO**

### SaaS 版 Go 條件（全部必須 Yes）
1. OSS Go 條件全過？
2. 安全審計通過？
3. Billing 整合測試通過？
4. Load test 50 並發通過？
5. 備份 + 恢復流程已測試？
6. Runbook 已寫？

→ 6/6 Yes = **GO**，否則 **NO-GO**
