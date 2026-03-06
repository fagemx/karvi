# Karvi Starter Kit — 專案啟動母版

通用的 Claude Code skills + commands 母版。新專案只需要：

1. 複製 `commands/` 和 `skills/` 到專案的 `.claude/`
2. 填寫 `project.yaml`（或讓 AI 自動生成）
3. 寫 `CLAUDE.md`

即可獲得完整的 AI 工作流程：issue 規劃、commit 品質、PR 管理、code review。

## 使用方式

```bash
# 複製到新專案
cp -r starter-kit/commands/  /path/to/new-project/.claude/commands/
cp -r starter-kit/skills/    /path/to/new-project/.claude/skills/
cp starter-kit/project.yaml.template /path/to/new-project/.claude/project.yaml

# 編輯 project.yaml 填入專案資訊
# 或讓 AI 讀 package.json / tsconfig.json 自動生成
```

## 目錄結構

```
starter-kit/
  project.yaml.template     ← 專案配置模板
  CLAUDE.md.template         ← CLAUDE.md 範例
  commands/                  ← 通用 commands（直接複製）
    deep-research.md
    deep-innovate.md
    deep-plan.md
  skills/                    ← 通用 skills（讀 project.yaml 適配）
    commit/SKILL.md
    pull-request/SKILL.md
    pr-review/SKILL.md
    issue-plan/SKILL.md
    issue-create/SKILL.md
```

## 設計原則

- **Skills 不硬寫專案細節** — 讀 project.yaml 取得配置
- **project.yaml 不存在也能用** — skill 有合理的 fallback
- **Commands 100% 通用** — 不含任何專案特定內容
