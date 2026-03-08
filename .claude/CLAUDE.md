# Karvi — Task Engine

多 Agent 任務派發 + 進度追蹤黑板。基於 Blackboard Pattern，JSON + HTML + 零外部依賴。

## 技術棧

- **語言**: 純 JavaScript / Node.js (v22+)
- **零外部依賴**: 只用 Node.js 內建模組 (`http`, `fs`, `path`, `child_process`)
- **資料格式**: JSON (board.json) + JSONL (task-log.jsonl, append-only)
- **UI**: 單一 index.html，SSE 即時更新
- **Runtime**: 支援 openclaw (預設) 和 codex

## 專案結構

```
server/
  server.js            ← HTTP server (REST API + SSE + 任務派發)
  blackboard-server.js ← 共用 server 骨架 (CORS, MIME, SSE, JSON read/write)
  management.js        ← 演化層邏輯 (controls, insights, lessons)
  process-review.js    ← 任務品質審查腳本
  retro.js             ← 回顧分析 (pattern → insight)
  runtime-*.js         ← Agent runtime adapters (openclaw, codex)
  smoke-test.js        ← 端點冒煙測試
  test-evolution-loop.js ← 整合測試
  skills/              ← Agent 知識庫 (blackboard-basics, engineer-playbook 等)
  docs/                ← 架構文件
  specs/               ← 規格文件
  briefs/              ← 執行期產生的 scoped brief (不進 git)
shared/                ← 共用 types/contracts (未來)
index.html             ← Web UI
brief-panel/           ← 分鏡子應用
```

## 常用指令

```bash
npm start                            # 啟動 server (port 3461)
npm test                             # 跑 evolution loop 整合測試
node server/smoke-test.js 3461       # 端點冒煙測試
node server/process-review.js --task T3 --dry-run  # 審查任務
node server/retro.js --dry-run       # 回顧分析 (不寫入)
```

## 開發原則

### 零外部依賴
**這是核心設計約束。** 只用 Node.js 內建模組，不加任何 npm 依賴。

- ✅ `const http = require('http')` — 內建模組
- ✅ `const { spawn } = require('child_process')` — 內建模組
- ❌ `const express = require('express')` — 外部依賴
- ❌ `const axios = require('axios')` — 用 `http.request` 替代

如果某個功能需要外部套件才能實現，先問：能不能用 Node.js 內建 API 做到？

### YAGNI (You Aren't Gonna Need It)
**不加用不到的東西。** 簡單、能動、夠用就好。

- 不要為「未來可能需要」預留抽象層
- 不要建只用一次的 helper / utility
- 三行重複程式碼比一個過早抽象好
- 刪掉沒在用的程式碼，不要留著「以防萬一」

### 避免防禦性程式設計
**讓錯誤自然浮出來。** 不要到處包 try/catch。

- 只在有具體恢復邏輯時才 catch
- 不要 catch 了只 log 再 re-throw
- 信任內部程式碼和 Node.js runtime
- 只在系統邊界驗證（用戶輸入、外部 API 回應）

### Windows-First
**所有 spawn 用 `cmd.exe /d /s /c` pattern。** 因為開發環境是 Windows。

```javascript
// ✅ 正確
spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, env })

// ❌ 錯誤 — Windows 上會失敗
spawn('sh', ['-c', command])
```

路徑用 `path.join()`，不要硬寫 `/` 或 `\\`。

### 資料完整性
- `board.json` 是 single source of truth，原子寫入（先寫 .tmp 再 rename）
- `task-log.jsonl` 是 append-only audit log，不修改、不刪除
- JSON 格式，不用資料庫（直到 scaling 需要）

## 測試

### 測試策略
**整合測試為主，不寫 unit test。** 整合測試自然覆蓋內部邏輯。

```bash
npm test                             # evolution loop 整合測試
node server/smoke-test.js 3461       # 端點冒煙測試（server 要先跑）
```

### 測試原則
- 測試入口點（API routes、CLI commands），不測內部 function
- 不要 mock 內部模組 — 只 mock 外部服務
- 測試失敗要修程式碼，不要跳過測試
- 不加 `.skip`、不加環境變數繞過

## Pre-Commit 檢查

提交前必須通過：

```bash
node --check server/server.js        # syntax check
node --check server/management.js    # syntax check
npm test                             # 整合測試
```

如果專案有 `.claude/project.yaml`，以 `quality.*` 欄位為準。

## Commit 規範

### 格式
```
<type>[optional scope]: <description>
```

### 規則
- type 小寫：`feat:` 不是 `Feat:`
- description 小寫開頭，不加句號
- 100 字元以內
- 祈使語氣：`add` 不是 `added`

### Types
feat, fix, docs, style, refactor, test, chore, ci, perf, build, revert

### 範例
- ✅ `feat(kernel): add step pipeline dispatch`
- ✅ `fix(runtime): handle opencode timeout on Windows`
- ❌ `Fix: Added timeout handling.`（大寫、過去式、句號）

## 品質閘門 (Hard Gates)

### Gate 1 — Read-before-Write
修改任何檔案前，必須先讀過相關區段。不允許「我知道那個檔案大概長什麼樣」就動手改。

### Gate 2 — Baseline / Regression
第一次 Edit 之前，先跑一次品質檢查記錄基線。改完再跑一次。新出現的錯誤優先視為「我引入的」。

```bash
# 基線
node --check server/server.js && node --check server/management.js && npm test
# 改完後再跑同樣的
```

### Gate 3 — Major Change
以下任一條成立，必須先向用戶說明計畫再執行：
- 變更持久化資料結構（board.json schema、task-log 格式）
- 變更跨模組合約（API contract、event payload）
- 影響 3+ 個檔案且跨不同層
- 改路由、權限、安全相關

### Gate 4 — Evidence Ledger
每個關鍵結論必須有證據：檔案路徑 + 行號。沒有證據不得宣稱「已確認」。

## 思考框架

處理任務依序經歷，不需要向用戶說明階段：

1. **理解** — 先搜尋相關程式碼，用不同關鍵字多次搜尋，追蹤符號到定義和使用處
2. **驗證** — 確認理解有代碼證據（具體檔案+行號），確認「改 A 會影響什麼」
3. **規劃** — 列出具體步驟，每步引用具體檔案，重大變更先說明計畫
4. **執行** — 逐步執行，每步完成後驗證結果
5. **總結** — 簡述完成了什麼

## 語言規範

- **程式碼**: 英文（變數名、函數名）
- **文件和註釋**: 中文優先
- **Commit messages**: 英文
- **與用戶溝通**: 用戶的語言

## 其他慣例

- 任務生命週期: `pending → dispatched → in_progress → completed/blocked`
- Repo: github.com/fagemx/karvi

<!-- edda:decision-tracking -->
## Decision Tracking (edda)

This project uses **edda** for decision tracking across sessions.

When you make an architectural decision (choosing a library, defining a pattern,
changing infrastructure), record it:

```bash
edda decide "domain.aspect=value" --reason "why"
```

**What to record:** choosing a database/ORM, auth strategy, error handling pattern,
deployment config, new module structure.

**What NOT to record:** formatting, typo fixes, minor refactors, dependency bumps.

Before ending a session, summarize what you did:

```bash
edda note "completed X; decided Y; next: Z" --tag session
```

<!-- edda:coordination -->
## Multi-Agent Coordination (edda)

When edda detects multiple agents, it injects peer information into your context.

**You MUST follow these rules:**
- **Check Off-limits** before editing any file — if a file is listed under "Off-limits", do NOT edit it
- **Claim your scope** at session start: `edda claim "label" --paths "src/scope/*"`
- **Request before crossing boundaries**: `edda request "peer-label" "your message"`
- **Respect binding decisions** — they apply to all sessions

Ignoring these rules causes merge conflicts and duplicated work.
