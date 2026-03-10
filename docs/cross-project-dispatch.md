# 跨專案 Dispatch 指南

> 讓 Karvi 對任何 Git 專案派發 AI agent 任務。

## 前提條件

1. **Karvi server 在跑**（`npm start`，預設 port 3461）
2. **Target repo 是有效的 Git repo**（有 `.git/`）
3. **Agent CLI 已安裝**（opencode / claude / codex）
4. **GitHub CLI 已登入**（`gh auth status`）

## 最快上手

```bash
# 1. 啟動 Karvi（如果還沒跑）
cd C:\ai_agent\karvi && npm start

# 2. 對另一個專案的 issue 派發任務
npm run go -- 42 --repo C:\path\to\your-project
```

這會：
- 抓 issue #42 的 title
- 在 `your-project/.claude/worktrees/GH-42/` 建 worktree
- 跑 plan → implement → review 三步 pipeline
- Agent 在 your-project 的 codebase 上工作
- 任務進度在 Karvi board 集中追蹤

## 進階用法

### 指定 runtime

```bash
# 用 codex (GPT)
npm run go -- 42 --repo C:\path\to\project --runtime codex

# 用 opencode (GLM/T8Star)
npm run go -- 42 --repo C:\path\to\project --runtime opencode
```

### 指定 skill

```bash
# 用 PR review skill
npm run go -- 42 --repo C:\path\to\project --skill pr
```

### curl 方式（完全控制）

```bash
curl -X POST http://localhost:3461/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "title":"YOUR-PROJECT-42: 任務標題",
    "tasks":[{
      "id":"YOUR-42",
      "title":"feat: 具體描述",
      "assignee":"engineer_lite",
      "target_repo":"C:\\path\\to\\your-project",
      "description":"Implement GitHub issue owner/repo#42. See https://github.com/owner/repo/issues/42"
    }]
  }'
```

### 多個 issue 一次派

```bash
npm run go -- 10 11 12 --repo C:\path\to\project
```

## 運作機制

```
Karvi Server (karvi/)
  │
  ├── board.json          ← 任務追蹤（集中在 karvi）
  ├── task-log.jsonl      ← 審計記錄
  └── artifacts/          ← step 產出

Target Repo (your-project/)
  │
  ├── .claude/worktrees/GH-42/   ← Agent 工作目錄（自動建立/清理）
  ├── .claude/CLAUDE.md          ← Agent 讀取的專案知識
  ├── .claude/skills/            ← Agent 可用的 skills
  └── AGENTS.md                  ← Agent 行為指引
```

| 項目 | 放在哪 |
|------|--------|
| Worktree | target repo 的 `.claude/worktrees/` |
| Skills | target repo 的 `.claude/skills/` |
| CLAUDE.md | target repo 的 |
| board.json | karvi 的（集中管理） |
| Artifacts | karvi 的 `server/artifacts/` |

## Target Repo 準備

### 最低要求

只需要是一個 Git repo。Agent 就能工作。

### 建議配置（提升品質）

```
your-project/
  .claude/
    CLAUDE.md          ← 專案規範、技術棧、coding style
    skills/
      issue-plan/      ← 規劃 skill（可從 karvi 複製）
      issue-action/    ← 實作 skill
      pr-review/       ← PR review skill
  AGENTS.md            ← Agent 角色定義（可選）
```

**複製 karvi 的通用 skills：**

```bash
# 複製基礎 skills 到你的專案
cp -r C:\ai_agent\karvi\.claude\skills\issue-plan your-project\.claude\skills\
cp -r C:\ai_agent\karvi\.claude\skills\issue-action your-project\.claude\skills\
cp -r C:\ai_agent\karvi\.claude\skills\pr-review your-project\.claude\skills\
```

### CLAUDE.md 範例

```markdown
# Your Project

## 技術棧
- Language: TypeScript
- Framework: Next.js
- Database: PostgreSQL

## 開發原則
- 所有 PR 必須有測試
- 用 conventional commits
- ...
```

## 監控與管理

```bash
# 看所有任務狀態
curl -s http://localhost:3461/api/board | node -e "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.taskPlan?.tasks?.forEach(t =>
    console.log(t.id, t.status, t.target_repo || 'karvi'))"

# 即時串流某任務
curl -N http://localhost:3461/api/tasks/YOUR-42/stream

# Web UI
open http://localhost:3461

# 清理失敗任務
curl -X POST http://localhost:3461/api/tasks/cleanup \
  -H "Content-Type: application/json" \
  -d '{"statuses": ["cancelled", "blocked"]}'
```

## 常見問題

| 問題 | 原因 | 解法 |
|------|------|------|
| Worktree 建在 karvi 目錄 | 沒加 `target_repo` | 加 `--repo` 或 task payload 加 `target_repo` |
| Agent 看不到專案 skills | target repo 沒有 `.claude/skills/` | 複製 skills 過去 |
| PR 開在錯的 repo | `gh` 的 remote 設定問題 | 確認 target repo 的 `origin` remote 正確 |
| `spawn ENOENT` | Agent CLI 不在 PATH | 確認 `opencode` / `claude` / `codex` 可執行 |
| Agent 不遵守專案規範 | 沒有 CLAUDE.md | 在 target repo 建 `.claude/CLAUDE.md` |
