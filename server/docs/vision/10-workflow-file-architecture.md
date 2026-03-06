# 10 — Workflow 文件架構：讓 Step 跟 Skill 一樣軟

> 2026-03-06 討論記錄

## 問題

Step 庫（09）解決了「管理什麼」的問題 — 管理有限的 step 積木，不是無限的 pipeline。但有一個更根本的問題：

```
Skill = Markdown 檔案（軟）
  → 容易複製、改寫、組合
  → AI 能讀、能寫、能調整
  → 放在 .claude/skills/，任何 repo 都能有

Step = JavaScript code（硬）
  → 寫死在 step-worker.js
  → 新增 step 要改 server code
  → AI 不能自己調整 pipeline
```

**Skill 是軟的，Step 是硬的。這限制了 AI 自己組裝 pipeline 的能力。**

## 核心洞察

一個 step 的定義就四件事：

```
1. 做什麼 → prompt（可以是 skill 的引用）
2. 輸入是什麼 → 前一步的 artifact
3. 產出是什麼 → 格式要求
4. 完成條件 → 怎麼判斷做完了
```

這四件事完全可以寫成聲明式的文件 — 不需要是 code。

## Symphony 的 WORKFLOW.md 啟發

Symphony 的做法：pipeline 定義放在 repo 根目錄的 WORKFLOW.md，agent 讀它來決定要跑什麼 step。

```yaml
# Symphony WORKFLOW.md 概念
steps:
  - id: plan
    instruction: "讀 issue，研究 codebase，產出實作計畫"
    output: "plan.md"

  - id: implement
    instruction: "根據計畫寫 code"
    input: "plan.md"
    output: "committed code"

  - id: review
    instruction: "審查 diff，檢查品質"
    input: "git diff"
    output: "review verdict"
```

Pipeline 定義從 code 變成了文件。Agent 讀文件 → 知道要跑什麼 → 按順序執行。

## Karvi 的 Workflow 文件架構

### 目錄結構

```
.claude/
  skills/              ← HOW（怎麼做的具體指令）
    issue-plan/SKILL.md
    commit/SKILL.md
    pr-review/SKILL.md
    research/SKILL.md
    system-design/SKILL.md

  workflows/           ← WHAT + WHEN（做什麼、什麼順序、什麼條件）
    execution.md        ← plan → implement → review
    planning.md         ← research → design → validate → scope → split
    quick-fix.md        ← implement → review
    evaluation.md       ← research
```

### Workflow 文件格式

```yaml
# execution.md
name: 執行 pipeline
description: 從 issue 到 PR 的標準執行流程

steps:
  - id: plan
    skill: issue-plan           # ← 引用 skill（HOW）
    output: plan artifact       # ← 產出什麼
    done_when: plan written to issue comment  # ← 完成條件

  - id: implement
    skill: null                 # ← 不需要特別 skill，直接寫 code
    input: plan artifact        # ← 上一步的產出
    output: committed code
    done_when: git diff non-empty

  - id: review
    skill: pr-review            # ← 引用 skill
    input: PR diff
    output: review verdict
    done_when: verdict is LGTM or REJECT
    gate: human_approval        # ← 人類閘門（07 定義的概念）
```

```yaml
# planning.md
name: 規劃 pipeline
description: 從用戶意圖到可執行 issues 的規劃流程

steps:
  - id: research
    skill: deep-research
    input: 用戶意圖 + 參考資料
    output: 技術決策表（markdown）
    done_when: 決策表包含至少 3 個技術選項的比較
    gate: human_approval

  - id: design
    skill: system-design
    input: research artifact
    output: 設計文件（每個系統一份 markdown）
    done_when: 所有核心系統都有設計文件
    gate: human_approval

  - id: validate
    skill: gap-analysis
    input: design artifacts + 原始需求
    output: 缺口清單 + 補充設計
    done_when: 所有需求都有對應的設計覆蓋

  - id: scope
    skill: mvp-scoping
    input: validated design
    output: MVP 範圍文件
    done_when: MVP 範圍有明確的 in/out 清單
    gate: human_approval

  - id: split
    skill: task-splitting
    input: MVP 範圍
    output: GitHub issues + 依賴圖
    done_when: 每個 issue 都有 AC 和估計大小
    dispatch: execution          # ← 自動用 execution workflow dispatch
```

### Workflow 之間的串接

```
planning.md 的最後一個 step（split）：
  dispatch: execution
  → split 產出的每個 issue 自動用 execution.md workflow dispatch

這就是「AI 治理 AI」的機械化：
  規劃 AI 跑 planning workflow
    → 產出 issues
    → 每個 issue 自動用 execution workflow dispatch 給 worker AI
    → worker AI 跑 execution workflow
    → 產出 PR
```

## Step 和 Skill 的關係

```
Workflow（聲明順序和條件）
  └── Step 1 → 引用 Skill A（具體指令）
  └── Step 2 → 引用 Skill B
  └── Step 3 → 無 skill（通用動作）

Workflow = 指揮官的作戰計畫（誰先動、誰後動、什麼條件暫停）
Skill = 每個士兵的專業訓練（怎麼偵察、怎麼射擊、怎麼撤退）
Kernel = 後勤保障（補給、通訊、醫療、追蹤）
```

**三者分離：**

| 層 | 負責什麼 | 誰定義 | 存在哪 |
|----|---------|--------|--------|
| Workflow | 順序、條件、閘門 | 人或 AI | .claude/workflows/ |
| Skill | 具體指令、checklist | 人或 AI | .claude/skills/ |
| Kernel | 執行保證、隔離、追蹤 | Karvi code | step-worker.js |

## 最小可複用單位是什麼

```
不是 workflow（太大，是組合）
不是 step（中等，是一個動作槽位）
是 skill（最小，是一組可獨立使用的指令）
```

Skill 已經是原子了。問題不在 skill 不夠原子，是 step 的定義方式太硬。

解法不是把規則拆更小，是把 step 定義從 code 提升到文件：

```
之前：
  step 定義 = JavaScript code（硬）→ 不能被 AI 操作
  skill 定義 = Markdown file（軟）→ 能被 AI 操作

之後：
  step 定義 = Workflow file（軟）→ 跟 skill 一樣能被 AI 操作
  skill 定義 = Markdown file（軟）→ 能被 AI 操作
  → 兩者都軟 → AI 能完全自主組裝 pipeline
```

## AI 怎麼快速建立自己的庫

```
1. AI 看到用戶意圖
2. AI 檢查已有的 workflows/ 和 skills/
3. 缺 workflow？
   → AI 寫一個新的 workflow 文件（聲明式，不是 code）
   → 格式固定（YAML/markdown），AI 非常擅長產生
4. 缺 skill？
   → AI 寫一個新的 SKILL.md（已經能做）
5. Karvi kernel 讀 workflow 文件 → 建 steps → 執行

AI 不改 code，只寫文件。
```

### 範例：AI 遇到新專案類型

```
用戶：「幫我做一個行銷活動」

AI 檢查：
  workflows/execution.md  ✅ 有（通用）
  workflows/planning.md   ✅ 有（通用）
  skills/research          ✅ 有（通用）
  skills/campaign-design   ❌ 沒有

AI 動作：
  1. 寫 .claude/skills/campaign-design/SKILL.md
     （行銷活動設計的 checklist、產出格式、驗收標準）
  2. planning.md 的 design step 已引用 skill
     → 只要 skill 存在，pipeline 自動能用
  3. 不需要改 workflow，不需要改 kernel code
```

### 範例：AI 需要全新 pipeline

```
用戶：「幫我做 A/B test 然後分析結果」

AI 檢查：
  workflows/ 裡沒有適合的

AI 動作：
  1. 寫 .claude/workflows/ab-testing.md
     steps:
       - id: setup
         skill: null
         output: test configuration
         done_when: A/B variants defined
       - id: deploy
         skill: null
         input: test config
         output: deployed variants
         done_when: both variants live
         gate: human_approval
       - id: analyze
         skill: data-analysis
         input: test results
         output: analysis report
         done_when: winner identified with confidence
  2. 如果 skills/data-analysis 不存在，也一起寫
  3. Karvi kernel 讀新 workflow → 建 steps → 執行
```

## Karvi Kernel 需要的改動

### 現在（hardcoded）

```javascript
// step-worker.js
function buildSteps(task) {
  return [
    { step_id: 'plan', ... },
    { step_id: 'implement', ... },
    { step_id: 'review', ... }
  ];
}
```

### 目標（讀 workflow 文件）

```javascript
// step-worker.js
function buildSteps(task, workflowFile) {
  const workflow = parseWorkflow(workflowFile);
  // workflowFile = '.claude/workflows/execution.md'
  // 或由 AI 在 dispatch 時指定

  return workflow.steps.map(stepDef => ({
    step_id: stepDef.id,
    skill: stepDef.skill,        // agent 執行時 load 這個 skill
    input: stepDef.input,        // 從前一步 artifact 帶入
    output: stepDef.output,      // 期望產出
    done_when: stepDef.done_when,// 完成條件
    gate: stepDef.gate || null,  // 人類閘門
  }));
}
```

### 改動量估計

| 改動 | 大小 | 說明 |
|------|------|------|
| workflow 文件解析器 | 小 | 解析 YAML-like markdown → step 定義 |
| buildSteps 改為讀 workflow | 小 | 現有 hardcode → 讀文件 |
| dispatch 時指定 workflow | 小 | API 加一個 `workflow` 參數 |
| step 執行時注入 skill 引用 | 中 | agent prompt 帶入 skill 名稱 |
| step 產出串接 | 中 | artifact → 下一步 input（07 已定義） |
| workflow 間 dispatch | 中 | split step 完成 → 自動用另一個 workflow dispatch |

總共 3-4 個 issue 的量，跟 07 的缺口有重疊（step 產出串接、動態 task 生成）。

## 跟其他 Vision 文件的關係

| 文件 | 關係 |
|------|------|
| 07-planning-automation.md | planning.md 就是規劃 pipeline 的 workflow 文件 |
| 08-cross-repo-skills.md | workflows/ 也需要考慮跨 repo 可攜性 |
| 09-step-library-and-composition.md | step 庫 = workflows/ + skills/ 的組合 |
| 03-agent-execution-kernel.md | kernel 只管執行保證，不管 workflow 內容 |
| 04-village-nation.md | Village Chief 用 AI 組裝 workflow → dispatch |

## 一句話

**把 step 定義從 code 提升到文件，讓 workflow 跟 skill 一樣軟。AI 不改 code，只寫文件 — workflow 定義順序，skill 定義做法，kernel 保證執行。三者分離，各自演化。**
