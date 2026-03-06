# 13 — 專案啟動母版：通用 Skill + Project Config

> 2026-03-06 討論記錄

## 問題

現有的 skills 和 commands 是基於 Karvi 專案開發的，裡面散落著 Karvi 特定的細節（board.json、node --check server.js、fagemx/karvi 等）。每次新專案都要手動改這些細節。

需要一個「母版」— 乾淨的通用 starter kit，新專案只要填 project.yaml 就能用。

## 靈感來源

Skills 架構參考了 vm0 的 PreparedContext 模式和 skill 組織方式。vm0 是開源專案，我們學習了它的概念後自行建立了整套 skills。母版裡**沒有 vm0 的原始碼**，是完全獨立的實作。

核心差異：
- vm0 的 skills 是為 vm0 專案量身定做的（turbo monorepo、pnpm、特定 bad smell 規則）
- 我們的母版是通用的 — 透過 project.yaml 適配任何專案

## 資產分析

### 來源盤點（vm0 原版 → Karvi 版 → 母版）

```
vm0 原版有的（完全專屬，不放母版）：
  ccstate, cli-design, database-development, dev-server,
  local-testing, ops-utils, query-axiom-logs,
  dev-auth, dev-logs, dev-start, dev-stop, dev-tunnel,
  preview-envs-cleanup, defensive-code-cleanup, settings.json

vm0 原版有，我們改寫成通用的（放母版）：
  commit          → 去掉 node --check server.js，改讀 project.yaml
  pull-request    → 去掉 fagemx/karvi，改讀 project.yaml
  pr-review       → 去掉 board.json 等專屬 checks，改讀 project.yaml
  pr-check        → 去掉 pnpm turbo 指令，改讀 project.yaml
  issue-plan      → 已通用，只改 .tmp 路徑
  issue-action    → 已通用，只改 .tmp 路徑
  issue-create    → 100% 通用，直接複製
  issue-compact   → 100% 通用，直接複製
  issue-scan      → 去掉 fagemx/karvi 和 server.js 掃描，改讀 project.yaml
  deep-research   → 100% 通用，直接複製
  deep-innovate   → 100% 通用，直接複製
  deep-plan       → 100% 通用，直接複製

vm0 原版沒有，我們自己做的（放母版）：
  ground-check    → Karvi 原創，改為通用版
  skill-craft     → Karvi 原創，幾乎不用改
  project-init    → 全新，母版專屬的初始化指令

vm0 原版有，我們不放母版的（專屬性太高）：
  code-quality    → 17 條 bad smell 是 vm0 專屬
  testing         → 指向 vm0 的 docs/testing.md
  tech-debt       → 掃描邏輯跟語言/框架相關
  project-principles → 每個專案的原則不同（由 project.yaml 替代）
```

### Commands（4 個，100% 通用）

| Command | 來源 | 說明 |
|---------|------|------|
| deep-research | vm0 概念，自行撰寫 | 深度研究，純流程不碰 code |
| deep-innovate | vm0 概念，自行撰寫 | 方案探索 |
| deep-plan | vm0 概念，自行撰寫 | 實作規劃 |
| project-init | 全新 | 自動初始化新專案 |

### Skills（11 個）

| Skill | 來源 | 通用化改動 |
|-------|------|-----------|
| commit | vm0 概念改寫 | quality check 改讀 project.yaml |
| pull-request | vm0 概念改寫 | 去掉 repo 硬寫 |
| pr-review | vm0 概念改寫 | 專案 checks 改讀 project.yaml |
| pr-check | vm0 概念改寫 | lint fix 指令改讀 project.yaml |
| issue-plan | vm0 概念改寫 | 已通用 |
| issue-action | vm0 概念改寫 | 已通用 |
| issue-create | vm0 概念改寫 | 100% 通用 |
| issue-compact | vm0 概念改寫 | 100% 通用 |
| issue-scan | vm0 概念改寫 | 掃描指令改讀 project.yaml |
| ground-check | Karvi 原創 | 通用化 |
| skill-craft | Karvi 原創 | 通用化 |

## 解法：project.yaml + 通用 Skill 母版

### project.yaml

一個檔案集中所有專案特定的配置，skill 引用它：

```yaml
project:
  name: my-project
  repo: owner/repo-name
  language: TypeScript
  framework: null

quality:
  syntax_check: "npx tsc --noEmit"
  test_command: "npx vitest run"
  lint_command: null

review_checks:
  - name: "規則名稱"
    rule: "具體描述"

principles:
  - "原則 1"
  - "原則 2"
```

### Skill 引用方式

Skill 不硬寫專案細節，而是：「讀 .claude/project.yaml 取得專案配置」。
如果 project.yaml 不存在，用合理的 fallback。

### 新專案啟動流程

```
方式 A：用 /project-init 指令（推薦）
  1. /project-init C:\path\to\new-project
  2. AI 讀 package.json + tsconfig.json → 自動生成 project.yaml
  3. AI 複製 commands + skills
  4. 完成

方式 B：手動複製
  1. 複製 starter-kit/commands/ 到 .claude/commands/
  2. 複製 starter-kit/skills/ 到 .claude/skills/
  3. 複製 project.yaml.template 到 .claude/project.yaml 並填寫
  4. 寫 CLAUDE.md
  5. 完成
```

## 母版位置與完整結構

```
karvi/
  starter-kit/
    README.md                    ← 使用說明
    project.yaml.template        ← 專案配置模板（填空題）
    CLAUDE.md.template            ← CLAUDE.md 範例骨架
    commands/                     ← 4 個通用 commands
      deep-research.md            ← 深度研究
      deep-innovate.md            ← 方案探索
      deep-plan.md                ← 實作規劃
      project-init.md             ← 專案初始化
    skills/                       ← 11 個通用 skills
      commit/SKILL.md             ← 品質檢查 + conventional commit
      pull-request/SKILL.md       ← PR 建立/merge/列表/留言
      pr-review/SKILL.md          ← AI tech lead 四項審查
      pr-check/SKILL.md           ← CI 監控 + 自動修 lint
      issue-plan/SKILL.md         ← issue 深度規劃（R→I→P）
      issue-action/SKILL.md       ← issue 實作（跟著 plan 寫 code）
      issue-create/SKILL.md       ← 從對話建 issue
      issue-compact/SKILL.md      ← issue 討論整理成乾淨 body
      issue-scan/SKILL.md         ← AI tech lead codebase 掃描
      ground-check/SKILL.md       ← 任務可行性檢查
      skill-craft/SKILL.md        ← 建立新 skill 的 skill
```

## 完整開發工作流

母版提供的 skills 覆蓋完整的開發生命週期：

```
探索階段：
  /deep-research     → 深度研究，只收集資訊不做決定
  /deep-innovate     → 探索多種方案，比較 trade-offs
  /deep-plan         → 產出具體實作計畫

Issue 管理：
  /issue-create      → 從對話建 issue
  /issue-scan        → AI 掃描 codebase 主動發現工作
  /issue-plan 123    → 對 issue 做完整深度規劃（R→I→P）
  /issue-action      → 按計畫實作
  /issue-compact     → 整理 issue 給下一個人接手

品質與 PR：
  /commit            → 品質檢查 + conventional commit
  /pull-request      → PR 建立/merge
  /pr-check          → CI 監控 + 自動修 lint/format
  /pr-review         → AI tech lead 四項審查

基礎設施：
  /ground-check      → 開始前檢查 codebase 就緒度
  /skill-craft       → 建立專案特定的新 skill
  /project-init      → 初始化新專案的 .claude/ 配置
```

## 已驗證的應用

### 《幻惑怪談》遊戲專案（C:\game-dev\match3_game）

```yaml
# .claude/project.yaml
project:
  name: match3-game
  repo: fagemx/match3-game
  language: TypeScript
  framework: Cocos Creator

quality:
  syntax_check: "npx tsc --noEmit"
  test_command: "npx vitest run"
  lint_command: null

review_checks:
  - name: "純 TS core"
    rule: "core/ 和 systems/ 不能 import cocos 模組或任何引擎 API"
  - name: "EventBus 通訊"
    rule: "邏輯層跟表現層必須透過 EventBus 通訊，不能直接 import"
  - name: "JSON 驅動"
    rule: "關卡、角色、劇情、道具資料必須是 JSON 檔案"
  - name: "測試覆蓋"
    rule: "core/ 和 systems/ 的每個模組都要有對應的測試"
```

同一套 skills，因為 project.yaml 不同，行為自動適配：
- `/commit` 跑 `npx tsc --noEmit` + `npx vitest run`（不是 `node --check server.js`）
- `/pr-review` 檢查 EventBus 一致性和純 TS core（不是 board.json atomic writes）
- `/issue-scan` 掃描 `*.ts` 檔案（不是 `*.js`）

## 跟其他 Vision 文件的關係

| 文件 | 關係 |
|------|------|
| 08-cross-repo-skills.md | 母版解決了 skill 可攜性問題 — 通用 skills 不用每個 repo 手寫 |
| 10-workflow-file-architecture.md | workflow + skill + project.yaml 三者分離 |
| 11-workflow-security-model.md | project.yaml 的 review_checks 是安全規則的一部分 |
| 12-guardian-agent.md | guardian 也可以讀 project.yaml 的 review_checks 做機械性檢查 |

## 一句話

**同一套 skills，不同的 project.yaml → 不同的行為。4 個 commands + 11 個 skills 覆蓋完整開發生命週期。專案細節集中在一個配置檔，skill 保持通用。**
