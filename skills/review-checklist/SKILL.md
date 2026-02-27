# Skill: Review Checklist

> 任何 agent 都可以用這份 checklist 審查交付成果。不需要是 Lead。

---

## 審查架構

Task Engine 的審查分兩層：

1. **Deterministic pre-checks**（程式碼執行，不花 token）
   - JSON 語法驗證
   - 外部依賴掃描（只允許 Node.js built-in）
   - 空檔案檢測
2. **LLM score-based review**（agent 打分 0-100，程式碼比較 threshold 決定 pass/fail）

全部邏輯在 `process-review.js` 原子腳本裡，由 server.js spawn 執行。

### 流程

```
completed
  → process-review.js --task T1
    → deterministic checks（不過 → needs_revision，跳過 LLM）
    → LLM 打分（score 0-100）
    → score >= threshold → approved
    → score < threshold  → needs_revision
  → server.js 補發 SSE
```

### Controls（可在 UI 或 API 調整）

| 參數 | 預設 | 作用 |
|------|------|------|
| `auto_review` | `true` | completed 後是否自動觸發 |
| `quality_threshold` | `70` | score ≥ 此值才通過 |
| `max_review_attempts` | `3` | 超過次數自動標記 needs_revision |
| `review_agent` | `engineer_lite` | 執行 review 的 agent |
| `review_timeout_sec` | `180` | LLM 呼叫超時 |

---

## 通用審查（所有任務都要過）

### 1. 檔案存在性
- [ ] 任務要求建立的所有檔案都存在
- [ ] 路徑正確（在 spec 指定的目錄下）

驗證方式：
```powershell
Test-Path "C:\Users\fagem\.openclaw\workspace\project\{app}\{file}"
```

### 2. 語法檢查
- [ ] `node -c server.js` 通過（如果有 server.js）
- [ ] `node -e "JSON.parse(require('fs').readFileSync('board.json','utf8'))"` 通過（如果有 board.json）

### 3. 零依賴檢查
- [ ] 沒有 `require('express')`、`require('socket.io')` 等第三方套件
- [ ] 只用 Node.js built-in：`http`, `fs`, `path`, `child_process`, `crypto`, `url`, `os`, `stream`, `events`, `net`, `util`, `zlib`, `querystring`

deterministic pre-check 會自動掃描這個。

### 4. blackboard-server 整合
- [ ] 使用 `bb.createServer(ctx, routeHandler)` 建立 server（不自己寫 http.createServer）
- [ ] `createContext` 有設 `boardType`
- [ ] 所有 board 寫入走 `writeBoard()`（不直接 fs.writeFileSync）
- [ ] `meta.boardType` 正確（由 bb core 自動強制）

### 5. Windows 相容
- [ ] spawn 用 `cmd.exe /d /s /c openclaw.cmd ...args` pattern（如果有 spawn）
- [ ] 沒有 `/bin/bash` 或其他 Unix-only 路徑

### 6. 編碼
- [ ] 所有檔案 UTF-8
- [ ] 中文字串正常顯示

---

## Server 審查（有 server.js 的任務）

### 7. API 完整性
- [ ] spec 裡定義的所有 endpoint 都有實作
- [ ] 每個 endpoint 回傳正確的 JSON 格式（`{ ok: true, ... }` 或 `{ error: "..." }`）

驗證方式：啟動 server 後逐個打 API
```powershell
Start-Process -NoNewWindow node -ArgumentList "server.js"
Invoke-RestMethod -Uri "http://localhost:{port}/api/board" -Method GET
```

### 8. Board 一致性
- [ ] API 操作後 board.json 正確更新
- [ ] `meta.boardType` 和 `meta.version` 存在
- [ ] SSE 有推送（改 board 後 UI 即時更新）

### 9. 錯誤處理
- [ ] 缺少必要參數時回 400
- [ ] 找不到資源時回 404
- [ ] 不會 crash（try/catch 包住主要邏輯）

### 10. Smoke test 通過
```powershell
node project/smoke-test.js {port} {domain-route}
```
6 項全過：board GET / board POST / SSE / static / domain route / CORS

---

## UI 審查（有 index.html 的任務）

### 11. 畫面呈現
- [ ] 打開瀏覽器看到正確佈局（對照 spec 的 ASCII mockup）
- [ ] Dark theme 正常（背景深色、文字淺色）

### 12. 互動
- [ ] 所有按鈕可點擊、打到正確的 API
- [ ] 輸入框可輸入、提交

### 13. 即時更新
- [ ] SSE 連線正常（console 無 error）
- [ ] 改 board → UI 即時刷新（不需手動）

---

## 審查結果

### 手動審查格式

```
【審查結果：{taskId}】

✅ 通過項目：
- 檔案存在性 ✅
- 語法檢查 ✅
- ...

❌ 未通過：
- {項目名}：{具體問題}

結論：✅ 通過 / ❌ 需修改（列出具體修改要求）
```

### process-review.js 輸出格式（自動審查）

LLM 回覆最後一行必須是：
```
REVIEW_RESULT:{"score":85,"issues":[],"summary":"one line summary"}
```

- `score`: 0-100 整數
- `issues`: 問題陣列（空 = 沒問題）
- `summary`: 一句話摘要

程式碼會拿 `score` 跟 `quality_threshold` 比較，**LLM 不做 pass/fail 判定**。

### 解析策略（5 層 fallback）

process-review.js 會依序嘗試：
1. `REVIEW_RESULT:{...}` 獨立行
2. `REVIEW_RESULT:{...}` 行內
3. JSON code block 含 `score` 或 `pass`
4. Bare JSON 含 `score` 或 `pass`
5. Keyword inference（"looks good" → 85 分, "issue" → 40 分）

---

## 自動審查流程

```
in_progress → completed → reviewing → approved（score ≥ threshold）
                                    → needs_revision（score < threshold）
                                        ↓
                                    Human 可以：
                                    - 🔄 重新執行（回 in_progress）
                                    - 🔍 重新審查（再跑 process-review.js）
                                    - ⏭ 手動通過（直接 approved）
```

### CLI 用法

```powershell
# 審查所有 completed 任務
node process-review.js

# 審查特定任務
node process-review.js --task T3

# 只跑 deterministic checks（不花 token）
node process-review.js --skip-llm

# 預覽（不寫入 board）
node process-review.js --dry-run

# 自訂閾值
node process-review.js --threshold 80
```
