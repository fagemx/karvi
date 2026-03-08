# Opencode Dispatch 操作指南

> 交接文件 — 2026-03-09（updated）

## 架構總覽

```
Karvi Server (port 3461)
  ├── POST /api/projects      ← 建立 task（auto_dispatch 自動接手）
  ├── POST /api/tasks/:id/dispatch  ← 手動 dispatch 單一 task
  │
  ├── tryAutoDispatch()        ← 自動流程
  │     ├── worktree.createWorktree()   → .claude/worktrees/GH-XXX/
  │     ├── generateStepsForTask()      → plan → implement → review
  │     └── stepWorker.executeStep()    → 呼叫 opencode run
  │
  ├── buildStepMessage()       ← 產生送給 agent 的 prompt
  │     ├── Role + STRICTLY PROHIBITED + Required Actions + Deliverable
  │     ├── Skill tool 引導（Use the skill tool to load "issue-plan"）
  │     ├── Coding Standards（從 skill 檔萃取）
  │     ├── Completion Criteria（5 點 checklist）
  │     ├── Preflight Lessons（歷史經驗）
  │     ├── Protected Decisions（edda 決策）
  │     └── STEP_RESULT 格式指令（含 prUrl）
  │
  └── kernel.js                ← 自動推進 + PR metadata 提取
        ├── findPrUrl()          → 從 payload.prUrl 或 summary regex 提取
        ├── task.pr 設定         → owner/repo/number/url
        └── auto-merge（可選）   → controls.auto_merge_on_approve
```

## Opencode 如何讀取 Karvi 的設定

| 來源 | 路徑 | 用途 |
|------|------|------|
| System prompt | `~/.claude/CLAUDE.md` + 專案 `.claude/CLAUDE.md` | 專案知識、慣例 |
| Skills | `.claude/skills/**/SKILL.md` | 30+ 技能（issue-plan, pr-review 等） |
| Config | `~/.config/opencode/opencode.json` | 模型、MCP、provider |
| Agent permissions | `build` agent 預設 `"*": "allow"` | Skill tool 可用 |

**重要**：opencode 的 system prompt **不會主動提示** agent 使用 Skill tool。Agent 只能從 tool list 裡的 Skill tool 描述發現 skills。因此 dispatch message 必須明確說 `Use the skill tool to load "xxx" skill`。

## 常用操作

### 1. 全自動 Dispatch（推薦）

**最快方式 — CLI 一行搞定：**

```bash
# 派一個 issue
npm run go -- 279

# 派多個 issue
npm run go -- 276 288

# 跳過確認
npm run go -- 279 -y

# 指定 skill
npm run go -- 279 --skill pr

# 指定 repo 路徑
npm run go -- 138 --repo C:\ai_agent\edda
```

`npm run go` 自動抓 issue title、顯示預覽、確認後 POST `/api/projects`。

**等效 curl（進階用法）：**

```bash
# 確認 controls
curl -s http://localhost:3461/api/controls | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('worktrees:', d.use_worktrees, 'auto_dispatch:', d.auto_dispatch, 'step_pipeline:', d.use_step_pipeline, 'auto_merge:', d.auto_merge_on_approve)"

# 建立任務（auto_dispatch 自動接手）
curl -X POST http://localhost:3461/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "title":"GH-XXX: 任務標題",
    "goal":"目標描述",
    "tasks":[{
      "id":"GH-XXX",
      "title":"feat(scope): 具體標題",
      "assignee":"engineer_lite",
      "description":"Implement GitHub issue #XXX. 詳細描述。See https://github.com/fagemx/karvi/issues/XXX"
    }]
  }'
```

**不要用 `autoStart: true`** — 它繞過 worktree 和 step pipeline。

### 1.5 跨專案 Dispatch（對其他 repo 發任務）

Karvi 可以對任何 Git 專案派發任務，只需在 task 裡加 `target_repo` 欄位。

```bash
curl -X POST http://localhost:3461/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "title":"EDDA-138: scope derivation",
    "tasks":[{
      "id":"EDDA-138",
      "title":"feat: smarter auto-claim scope derivation",
      "assignee":"engineer_lite",
      "target_repo":"C:\\ai_agent\\edda",
      "description":"Implement GitHub issue fagemx/edda#138. See https://github.com/fagemx/edda/issues/138"
    }]
  }'
```

**運作機制：**

| 項目 | 不帶 `target_repo` | 帶 `target_repo` |
|------|-------------------|-----------------|
| Worktree 位置 | `karvi/.claude/worktrees/TASK-ID/` | `{target_repo}/.claude/worktrees/TASK-ID/` |
| Skills 載入 | 從 karvi 的 `.claude/skills/` | 從 target repo 的 `.claude/skills/` |
| Agent CWD | karvi worktree | target repo worktree |
| AGENTS.md | karvi 的 | target repo 的 |
| 任務追蹤 | karvi board | karvi board（集中管理） |

**前提條件：**
- Target repo 必須是有效的 Git repo（`repo-resolver.js` 會驗證）
- Target repo 的 `.claude/CLAUDE.md` 和 `AGENTS.md` 會被自動複製到 worktree
- 如果 target repo 有 `.claude/skills/`，agent 會看到那些 skills

**payload 格式支援：**

`POST /api/projects` 同時支援兩種 task 格式：

```jsonc
// 格式 1：id-based（推薦，支援任意 ID）
{ "id": "EDDA-138", "title": "...", "target_repo": "C:\\ai_agent\\edda" }

// 格式 2：issue-based（legacy，自動加 GH- 前綴）
{ "issue": 138, "title": "...", "target_repo": "C:\\ai_agent\\edda" }
```

**`repo` 欄位（可選）：**
- 帶 `repo`（如 `"repo": "fagemx/edda"`）→ 建立 project entity，支援 pause/resume、concurrency gate、progress tracking
- 不帶 `repo` → 只追加 tasks 到 board，不建 project

**注意：** `/api/project`（singular）仍可用但已 deprecated，請用 `/api/projects`（plural）。

### 2. 手動 Dispatch（server 重啟後或 auto_dispatch 沒接手時）

```bash
curl -X POST http://localhost:3461/api/tasks/GH-XXX/dispatch
```

### 3. 看進度

```bash
# 快速狀態
curl -s http://localhost:3461/api/board | node -e "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.taskPlan?.tasks?.forEach(t => {
    console.log(t.id, t.status);
    (t.steps||[]).forEach(s => console.log('  ', s.step_id, s.state,
      s.progress ? 'tools='+s.progress.tool_calls+' last='+s.progress.last_tool : '',
      s.error||''));
  })"

# 單一 task 進度（含 progress 細節）
curl -s http://localhost:3461/api/tasks/GH-XXX/progress

# Per-task SSE 即時串流
curl -N http://localhost:3461/api/tasks/GH-XXX/stream
```

### 4. 檢查 Dispatch Message 內容

Dispatch message 會寫到 `.tmp/` 目錄：

```bash
# 找最新的 dispatch message
ls -lt .tmp/karvi-dispatch-*.md | head -1

# 檢查內容
cat $(ls -t .tmp/karvi-dispatch-*.md | head -1)
```

**預期內容應包含：**
- `## Role` + `## Required Actions` + `## Deliverable` 結構
- `Use the skill tool to load the "issue-plan" skill`（不是 `Execute /issue-plan`）
- `## Coding Standards (from project skills)` section
- `## Completion Criteria` section
- `STEP_RESULT:{...}` 格式指令（implement step 要求帶 `prUrl`）

### 5. 檢查 Agent 有沒有用 Skill Tool

```bash
# 列出 opencode sessions
opencode session list | head -5

# Export session 並檢查 tool 呼叫
opencode export <session-id> 2>/dev/null > .tmp/oc-check.json

node -e "
  const data = JSON.parse(require('fs').readFileSync('.tmp/oc-check.json','utf8'));
  let usedSkill = false;
  for (const msg of data.messages) {
    for (const part of (msg.parts || [])) {
      if (part.type === 'tool' && part.tool === 'skill') {
        console.log('SKILL TOOL USED:', JSON.stringify(part.state?.input));
        usedSkill = true;
      }
    }
  }
  if (!usedSkill) console.log('WARNING: Agent did NOT use Skill tool');
"
```

### 6. 檢查 Artifacts（step 產出）

```bash
# 列出某 run 的 artifacts
ls server/artifacts/run-*/

# 看 step output
cat server/artifacts/<run-id>/GH-XXX_plan.output.json
```

### 7. 手動 Reset Task（用 API）

```bash
# 重新 dispatch 整個 task（API 方式，不直接改 board.json）
curl -X POST http://localhost:3461/api/tasks/GH-XXX/dispatch

# Reset 單一 step（dead/failed → queued，可重跑）
curl -X POST http://localhost:3461/api/tasks/GH-XXX/steps/GH-XXX:implement/reset

# Kill 正在執行的 step
curl -X POST http://localhost:3461/api/tasks/GH-XXX/steps/GH-XXX:implement/kill
```

**注意**：不要直接寫 `server/board.json` — server 會用記憶體中的版本覆蓋你的修改。所有操作透過 API。

## Opencode 設定

**Config 路徑**: `~/.config/opencode/opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "zai-coding-plan/glm-5",          // 目前使用的模型
  "small_model": "zai-coding-plan/glm-4.5-air",
  "provider": { ... },
  "mcp": { ... }
}
```

**換模型**：直接改 `"model"` 欄位，重啟 server 不需要（每次 dispatch 是新 session）。

## Step Pipeline 流程

每個 task 走 3 個 step：

| Step | 做什麼 | Skill | Contract | 預期時間 |
|------|--------|-------|----------|---------|
| **plan** | 讀 issue、研究 codebase、產出 plan | `issue-plan` | — | 1-3 分鐘 |
| **implement** | 按 plan 寫 code、commit、推 branch、建 PR | `issue-action` | `{ deliverable: 'pr' }` | 2-5 分鐘 |
| **review** | 自我審查 PR diff | `pr-review` | — | 1-2 分鐘 |

**端到端實測**：單個 issue 全 pipeline（plan→implement→review→auto-merge）約 6-10 分鐘。

### Step Instruction 結構（Claude Code 模式）

每個 step 的 dispatch message 遵循統一結構：

```
## Role
你的角色是什麼，STRICTLY PROHIBITED 的行為

## Instructions
載入哪個 skill，從哪裡讀資料

## Required Actions (in order)
1. 具體步驟 1
2. 具體步驟 2
...

## Deliverable
明確的交付物定義

## STEP_RESULT Output（implement only）
要求帶 prUrl 欄位
```

### Contract Enforcement

- Implement step 自動有 `{ deliverable: 'pr' }` contract（`STEP_DEFAULT_CONTRACTS`）
- Post-check 驗證：PR 存在（透過 `gh pr list` 或 summary 中的 URL）
- 驗證失敗 → `CONTRACT_VIOLATION` → 自動重試

### PR Metadata 提取

Kernel 在 task done 時自動提取 PR URL：
1. 優先從 `artifact.payload.prUrl`（structured）
2. Fallback 從 `artifact.summary` regex match
3. 寫入 `task.pr = { owner, repo, number, url, outcome }`

### Auto-Merge（可選）

```bash
# 開啟 auto-merge
curl -X POST http://localhost:3461/api/controls \
  -H "Content-Type: application/json" \
  -d '{"auto_merge_on_approve": true}'
```

需要 vault 裡有 `github_pat`。Review LGTM → task approved → 自動 squash merge PR。

**自動流程**：plan → implement（建 PR）→ review（LGTM）→ task approved → auto-merge PR

**失敗重試**：每個 step 最多 3 次嘗試，backoff 5s → 10s → 20s。3 次都失敗 → step 標記 `dead` → task 標記 `blocked`。

## 已知問題與限制

| 問題 | 狀態 | 說明 |
|------|------|------|
| `.tmp/` 被 commit 進 PR | **已修** | `.gitignore` 加了 `.tmp/` |
| `task.pr` 沒被設定 | **已修** | `findPrUrl` 現在也掃 summary text |
| Agent 不輸出 prUrl | **已修** | implement instruction 明確要求 STEP_RESULT 帶 prUrl |
| Step instruction 太簡陋 | **已修** | 改為 Role + Required Actions + Deliverable 結構 |
| Implement 沒有 contract | **已修** | `STEP_DEFAULT_CONTRACTS: { implement: { deliverable: 'pr' } }` |
| Opencode idle timeout | **已修** | opencode 發 `tool_use` 事件（非 `tool_call`），runtime 現已正確處理，tool 執行期 timeout 提升至 base timeout |
| Server 重啟後 board 覆蓋 | 已知 | Server 記憶體版本覆蓋 disk 版本，不要直接改 board.json |
| full pipeline test flaky | 已知 | `test-bridge.js` 的 full pipeline test 偶爾 timeout |

## 踩過的坑

| 錯誤 | 原因 | 正確做法 |
|------|------|----------|
| `autoStart: true` | 繞過 tryAutoDispatch，走 legacy dispatch | 不用 autoStart，靠 auto_dispatch |
| 直接改 board.json | Server 覆蓋 | 用 API（`POST /api/tasks/:id/dispatch`） |
| `/tmp/` 路徑 | Windows 讀不到 | 用 `.tmp/`（專案根目錄） |
| `git add .` 加了 `.tmp/` | `.gitignore` 沒有 `.tmp/` | 已加入 `.gitignore` |
| Agent summary 有 PR URL 但 task.pr 空 | `findPrUrl` 只看 payload | 已加 summary fallback |
| Ollama 本地模型太慢 | 300s timeout 殺掉 | 用雲端 API（GLM-5）或調 `step_timeout_sec` |
| opencode `tool_use` vs `tool_call` | runtime 只處理 `tool_call`，267 events/session 被忽略 | 已修，`tool_use` + `tool_call` 都處理 |
| spawn ENOENT 誤報 timeout | worktree 目錄不存在，spawn 瞬間失敗但等 300s 才發現 | 已修，dispatch 前驗 cwd + ENOENT 歸類 CONFIG（不重試） |
| worktree 消失後 dispatch 失敗 | cancel 刪 worktree 但 redispatch 不重建 | 已修，step-worker 自動重建缺失 worktree |
| 跨專案 worktree 建錯地方 | `target_repo` 沒正確傳遞 | 已修（GH-250），用 `/api/projects` + `target_repo` |
| 發新 task 覆蓋整個 board | 舊 `/api/project` 用 `=` 覆寫 taskPlan | 已修（GH-250），改為 merge 模式 |
| `/api/project` vs `/api/projects` | 兩個只差一個 s 的 endpoint | 已合併（GH-251），用 `/api/projects` |
