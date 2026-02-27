# Evolution Layer — Validation Plan

## 每個 Task 的驗收標準

### T1: Evolution API Foundation

| 項目 | 通過條件 | 驗證方式 |
|------|---------|---------|
| 語法 | `node -c server.js` exit 0 | CLI |
| board 初始化 | server 啟動後 board.json 含 signals[], insights[], lessons[] | `node -e "const b=require('./board.json');console.log(Array.isArray(b.signals),Array.isArray(b.insights),Array.isArray(b.lessons))"` → 全 true |
| GET /api/signals | 回傳 JSON 陣列 | `curl -s localhost:3461/api/signals` |
| POST /api/signals | 回 201 + signal 有 id, ts | `curl -s -X POST localhost:3461/api/signals -H 'Content-Type:application/json' -d '{"by":"v","type":"t","content":"c"}'` |
| signals 上限 | 超過 500 筆自動截斷最舊 | 寫入 501 筆後 GET 確認長度 <= 500 |
| GET /api/insights | 回傳 JSON 陣列 | `curl -s localhost:3461/api/insights` |
| POST /api/insights | 驗證 risk enum, suggestedAction.type enum | 傳無效值回 400 |
| POST /api/insights/:id/apply | status 變 applied, 產生 insight_applied signal | 手動測試 |
| GET /api/lessons | 回傳 JSON 陣列 | `curl -s localhost:3461/api/lessons` |
| POST /api/lessons | 自動歸檔 invalidated/superseded（>100 筆時） | 邊界測試 |
| POST /api/lessons/:id/status | validated 設 validatedAt | 手動測試 |
| server-side signals | 任務狀態變化自動寫 signal | 改一個 task status 後檢查 signals |
| 現有 API 不受影響 | 所有原有 endpoint 行為不變 | `node project/smoke-test.js 3461` 原有 checks 全過 |

### T2: Review Signal Emitter

| 項目 | 通過條件 | 驗證方式 |
|------|---------|---------|
| 語法 | `node -c process-review.js` exit 0 | CLI |
| signal emit | 審查完成後 /api/signals 多一筆 type=review_result | 跑一次真實 review 或 mock |
| signal 內容 | 包含 taskId, assignee, result, score, threshold | 讀 signal 的 data |
| fire-and-forget | server 不在線時 process-review.js 不 crash | 停 server 後跑 review |
| 不改現有邏輯 | 審查結果、log 輸出、board 寫入行為不變 | 比對改前改後的 review 結果 |

### T3: Retro Engine

| 項目 | 通過條件 | 驗證方式 |
|------|---------|---------|
| 語法 | `node -c retro.js` exit 0 | CLI |
| 零依賴 | 只用 Node 內建 + blackboard-server | `grep "require(" retro.js` |
| dry-run | `node retro.js --dry-run` 不寫入，只印出 | 跑前跑後 insights 數量不變 |
| agent_underperform | 3 筆低分 signal → 產出 insight | test-evolution-loop.js |
| 不重複 | 重跑 retro.js 不會產出重複 insight | 跑兩次後計數 |
| effect tracking | applied insight + 3 筆後續 review → 產出 lesson | test-evolution-loop.js |
| signals-only mode | `--signals-only` 只印統計不生成 insight | CLI 測試 |

### T4: Evolution UI Panel

| 項目 | 通過條件 | 驗證方式 |
|------|---------|---------|
| 預設收合 | 頁面載入時 evolution panel 收合 | 目視 |
| 展開/收合 | 點標題列可切換 | 目視 |
| 三個 tab | Signals, Insights, Lessons 切換正常 | 目視 |
| signals 渲染 | 顯示 by, type 色標, content, 時間 | 目視 |
| insights 渲染 | 顯示 risk 色標, judgement, Apply/Reject 按鈕 | 目視 |
| lessons 渲染 | 顯示 rule, status 色標 | 目視 |
| Apply 按鈕 | 點擊後 insight status → applied | 手動 |
| Reject 按鈕 | 點擊後 insight status → rejected | 手動 |
| pending badge | 有 pending insight 時顯示數字 | 手動 |
| SSE 即時 | POST signal 後 UI 不需重新整理即顯示 | 手動 |
| 不影響現有 UI | 任務管理面板功能不變 | 比對改前改後 |
| console 無錯 | 瀏覽器 F12 console 無 JS error | 瀏覽器 |

### T5: Gate Logic + Auto-Rollback + Lesson Injection

| 項目 | 通過條件 | 驗證方式 |
|------|---------|---------|
| 語法 | `node -c server.js` exit 0 | CLI |
| auto_apply_insights | DEFAULT_CONTROLS 含此欄位，**預設 true** | `grep auto_apply server.js` |
| 自動 apply | POST low-risk insight → 自動 applied（不需手動） | API 測試 |
| snapshot | applied insight 有 snapshot 欄位（記錄 apply 前的 controls） | GET /api/insights 確認 |
| appliedAt | applied insight 有 appliedAt 時間戳 | GET /api/insights 確認 |
| 效果驗證 — 改善 | apply 後 3 筆高分 review signal → 自動寫 lesson (validated) | API 測試 |
| 效果驗證 — 惡化 | apply 後 3 筆低分 review signal → 自動回滾 controls + rolled_back | API 測試 |
| 回滾正確 | 回滾後 controls 恢復到 snapshot 值 | 比對 controls |
| rolled_back 不重複 | 被 rolled_back 的 action 不會再被自動 apply | POST 同類型 insight，確認仍 pending |
| 安全閥 24h | 同類型 24h 內只 apply 1 次 | 連續 POST 2 個同類型，第 2 個仍 pending |
| 安全閥 3 次 | 連續 3 次後停止 | POST 4 個，第 4 個仍 pending |
| medium/high 不 apply | risk !== low 時不自動 apply | POST medium-risk, 確認仍 pending |
| lesson 注入 dispatch | 有 active/validated lesson 時 dispatch message 含 lessons 段落 | 看 server log |
| lesson <= 500 chars | 多條 lesson 時截斷 | 新增 20 條 lesson，確認 dispatch message 不超長 |
| lesson 注入 redispatch | buildRedispatchMessage 也含 lessons | 看 redispatch message |
| dispatch_hints 消費 | 有 hint 時 dispatch message 含建議 | 手動測試 |
| UI checkbox | auto_apply_insights 有 UI 控制（預設勾選） | 目視 |
| rollback signal | 回滾時產生 type=insight_rolled_back 的 signal | API 測試 |
| validated signal | 驗證通過時產生 type=lesson_validated 的 signal | API 測試 |

### T6: End-to-End Validation

| 項目 | 通過條件 | 驗證方式 |
|------|---------|---------|
| smoke-test | evolution checks 全部 ✅ | `node project/smoke-test.js 3461` |
| test-evolution-loop.js | 完整迴路全部 ✅ | `node project/task-engine/test-evolution-loop.js` |
| 完整迴路 | signal → retro → insight → apply → effect → lesson | test script 輸出 |

---

## 整體驗收

完成所有 6 個 Task 後，執行以下命令確認系統健全：

```bash
# 1. 語法全通過
node -c project/task-engine/server.js
node -c project/task-engine/process-review.js
node -c project/task-engine/retro.js

# 2. smoke-test 全通過（包含 evolution checks）
node project/smoke-test.js 3461

# 3. 完整迴路測試通過
node project/task-engine/test-evolution-loop.js

# 4. 現有功能不受影響
# 手動：在 UI 上新增任務、dispatch、review，確認行為不變
```
