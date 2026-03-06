# 08 — 跨專案 Dispatch 的 Skill 問題

> 2026-03-06 討論記錄

## 問題

Karvi 跨專案 dispatch（`target_repo`）時，agent 會在 target repo 的 worktree 工作，讀 target repo 的 `.claude/CLAUDE.md` 和 `.claude/skills/`。

但 step message 裡寫死了「Use skill tool to load issue-plan」— 如果 target repo 沒有這個 skill，agent 找不到就會跳過或失敗。

```
Karvi dispatch M3-4 到 game repo
  → agent 在 game repo worktree 工作
  → agent 讀 game repo 的 .claude/CLAUDE.md ✅
  → agent 找 game repo 的 .claude/skills/ ❌ 不存在
  → step message 說「Use skill tool to load issue-plan」
  → agent 找不到 skill → 跳過或失敗
```

## Skills 語言相關性分析

### 通用的（跟語言/專案無關）

| Skill | 為什麼通用 |
|-------|-----------|
| **issue-plan** | 做 research → innovate → plan，用 `gh` 操作 issue，工作流程跟語言無關 |
| **commit** | Conventional Commits 規範是通用的 |
| **pull-request** | 建 PR、推 branch，跟語言無關 |

### 部分相關的（骨架通用，細節要改）

| Skill | 哪裡要改 |
|-------|---------|
| **issue-action** | 有 `edda claim` 和 coordination 步驟，非 Karvi 生態的 repo 沒有 edda |
| **pr-review** | 骨架通用（scope/reality/quality/style 四項檢查），但 checklist 硬寫了 `board.json schema`、`board.json writes atomic` 等 Karvi 特有規則 |

### 完全 Karvi 特有的（不能直接用）

| Skill | 問題 |
|-------|------|
| **project-principles** | 寫的是 Karvi 的架構原則（零依賴、blackboard pattern） |
| **code-quality** | 寫的是 Karvi JavaScript 專案的品質規則 |
| **coord-*** | edda coordination 系列，非 Karvi 生態無用 |

## 解法

### 每個 target repo 需要自己的 skills

```
game repo (.claude/skills/):
  ├── issue-plan/SKILL.md        ← 可直接複製（通用）
  ├── issue-action/SKILL.md      ← 複製後去掉 edda 步驟
  ├── pr-review/SKILL.md         ← 複製骨架，換成遊戲專案的 checklist
  ├── commit/SKILL.md            ← 可直接複製（通用）
  ├── pull-request/SKILL.md      ← 可直接複製（通用）
  ├── project-principles/SKILL.md ← 新寫（遊戲架構原則：純 TS core、EventBus、JSON 驅動）
  └── code-quality/SKILL.md      ← 新寫（TypeScript strict + Vitest 品質規則）
```

### 更長遠的思考：Skill 分層

```
Layer 1: 通用 skills（跨所有專案）
  issue-plan, commit, pull-request
  → 放在某個共用位置，或由 Karvi dispatch 時自動注入

Layer 2: 語言/框架 skills（跨同類專案）
  typescript-quality, vitest-testing, react-patterns
  → 按技術棧分類，可以組合

Layer 3: 專案特定 skills（只屬於一個 repo）
  project-principles, domain-rules
  → 放在 repo 的 .claude/skills/ 裡
```

現在的做法是所有 skill 都在 Layer 3（每個 repo 自己管）。未來可以考慮 Layer 1 自動注入 — dispatch 時如果 target repo 沒有 issue-plan skill，Karvi 從自己的 skills 裡複製過去。

### 跟規劃自動化（07-planning-automation.md）的關係

規劃 pipeline 的每個 step 也需要 skill：

```
research step  → 需要類似 deep-research 的 skill
design step    → 需要系統設計的 skill（產出格式、checklist）
validate step  → 需要缺口分析的 skill
scope step     → 需要 MVP 定義的 skill
split step     → 需要任務拆分的 skill（產出 GitHub issues）
```

這些規劃 skills 也是通用的 — 不管專案類型，research/design/validate 的工作流程是一樣的。差異在 prompt 內容（「設計遊戲系統」vs「設計 API 架構」），不在工作流程。

## 待辦

| 項目 | 優先級 | 說明 |
|------|--------|------|
| 為 game repo 建 skills | P1 | 複製通用 skills + 新寫專案特定 skills |
| Karvi dispatch 自動注入通用 skills | P2 | target repo 缺 skill 時從 Karvi 複製 |
| Skill 分層機制 | P3 | Layer 1/2/3 分離，可組合 |
| 規劃 skills 模板 | P3 | research/design/validate/scope/split |
