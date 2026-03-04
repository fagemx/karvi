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

## 開發慣例

- 不加外部依賴 — 這是核心設計約束
- Windows-first: spawn 用 `cmd.exe /d /s /c` pattern
- board.json 是 single source of truth，原子寫入
- 中文優先的文件和註釋
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
