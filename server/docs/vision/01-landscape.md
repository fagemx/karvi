# 01 — Agent 專案全景：大家在做什麼

> 2026-03-06 研究筆記

## 研究對象

| 專案 | 定位 | 技術棧 | 授權 |
|------|------|--------|------|
| **Symphony** (OpenAI) | Polling Linear → 派 Codex agent | Elixir/OTP | Apache-2.0 |
| **Paperclip** | 虛擬公司，AI 員工組織圖 | TypeScript + Hono + PostgreSQL | MIT |
| **LangWatch** | LLM 可觀測性 + 評估 + Guardrails | Next.js + Python + OpenSearch | BSL 1.1 |
| **Google Workspace CLI** | 一個 CLI 操作所有 Google Workspace API | Rust | Apache-2.0 |

## 共同解的問題

所有 agent 編排專案解的是同一件事：

```
人丟需求 → agent 自動做 → 人驗收
```

差別在抽象層級和鎖定程度。

## Symphony — 最薄的排程器

- Polling Linear（30s 一次）→ 找到 active issue → 派 Codex → 等完成
- 核心創新：**WORKFLOW.md** — 一個檔案搞定 config + prompt template + hooks
- 優點：Spec-first（77KB 規格書）、WORKFLOW.md 熱重載、agent 自己更新 tracker
- 限制：**Linear only + Codex only + 無持久化 + 無 step pipeline**

## Paperclip — 最厚的抽象

- 把 agent 當「員工」，有 CEO、匯報鏈、部門、預算
- 5 層任務結構：Initiative → Project → Milestone → Issue → Sub-issue
- 優點：成本治理一級功能、Board 審批閘門、agent 無關（5 個 adapter）
- 限制：**需要 PostgreSQL、過度抽象（3 個 task 也要建公司）、不管產出**

## LangWatch — 不同賽道

- LLM 品質管控平台，不是 agent 編排
- 50+ evaluator、即時 Guardrails、Agent 模擬
- 跟 Langfuse 競爭，走「評估 + 安全」差異化
- 跟 Karvi 互補不競爭

## Google Workspace CLI — 工具層

- Rust CLI，動態讀 Google Discovery Service，所有 API 一行指令
- MCP server 模式讓 AI agent 直接操作 Google Workspace
- 代表趨勢：**CLI 是最通用的 agent tool protocol**

## 觀察

### 1. 都綁死了某個東西

| 專案 | 綁定 |
|------|------|
| Symphony | Linear + Codex + OpenAI |
| Paperclip | PostgreSQL + 完整 npm 生態 |
| LangWatch | OpenSearch + 5 個容器 |

### 2. 沒人把 step pipeline 做好

Symphony 沒有 step 概念（一個 session 做到底），Paperclip 也沒有（agent 自己決定）。分段執行是 Karvi 獨有的。

### 3. CLI 趨勢

大家避 MCP 往 CLI 走。Symphony 用 CLI（`codex app-server`），Google Workspace 也是 CLI（`gws`）。CLI 是最通用的 agent 介面。

### 4. 共同缺的東西

- 成本追蹤（Symphony 和 Paperclip 有，其他沒有）
- 重試感知 prompt（只有 Symphony 有 `attempt` 變數）
- 失敗任務關閉（普遍缺乏）

---

下一篇：[02-vertical-horizontal.md](02-vertical-horizontal.md) — 垂直與水平的新理解
