# 09 — Step 庫與動態組合：自動化怎麼管理

> 2026-03-06 討論記錄

## 問題

已經有 dispatch（執行 pipeline），之後有規劃 pipeline，再之後會有更多自動化。怎麼管理？每一個實現都需要實際的規則才能拆 step。規則越來越多不會失控嗎？

## 核心回答

**規則不是越來越多，是一個有限的 step 庫 + AI 動態組合。管理的是 step 庫的品質，不是 pipeline 的數量。**

## 每個 step 需要什麼才能被 dispatch

```
一個 step =
  - 做什麼（prompt / instruction）
  - 輸入是什麼（前一步的產出）
  - 產出是什麼（格式、驗收標準）
  - 完成條件（怎麼判斷做完了）
```

沒有這四個東西，就不是 step，就沒辦法 dispatch。所以對 — 每個實現都需要規則。

## 但規則有層次

```
Level 1: Kernel 層規則（固定，不用管）
  - step 狀態機（queued → running → succeeded/dead）
  - retry 邏輯（3 次、backoff）
  - worktree 隔離
  - artifact 存取
  → Karvi 已經有了，所有 pipeline 共用

Level 2: Pipeline 層規則（少量，人定義）
  - 執行 pipeline: plan → implement → review
  - 規劃 pipeline: research → design → validate → scope → split
  - 每種 pipeline 定義一次，反覆使用
  → Symphony 的 WORKFLOW.md 概念

Level 3: Step 層規則（具體，可以 AI 生成）
  - plan step 的 prompt 怎麼寫
  - review step 要檢查什麼
  - design step 的產出格式
  → skills + templates
```

## Pipeline 不會無限增長

Pipeline 種類不會爆炸，因為它們可以組合：

```
不是這樣（每次全新定義）：
  pipeline A: step1 → step2 → step3
  pipeline B: step1 → step4 → step5
  pipeline C: step1 → step2 → step5

而是這樣（組合已有的 steps）：
  可用的 steps: [research, design, validate, scope, split, implement, review, deploy]
  pipeline A = research → design → implement → review
  pipeline B = research → implement → review
  pipeline C = design → validate → scope → split → dispatch(pipeline B)
```

**Step 是積木，pipeline 是積木的組合方式。** 管理的是 step 庫，不是 pipeline 數量。

## 規則本身的自動化

```
現在：人定義 pipeline（哪些 step、什麼順序）
未來：AI 看到用戶意圖 → 自己決定需要哪些 step → 組裝 pipeline
```

範例：

```
用戶：「幫我做一個三消遊戲」
AI 判斷：這需要 research → design → validate → scope → split → dispatch

用戶：「幫我修這個 bug」
AI 判斷：這只需要 implement → review

用戶：「評估一下要不要用這個框架」
AI 判斷：這只需要 research
```

**AI 不是寫規則，是選規則。** Step 的規則是預先定義好的，AI 的工作是根據意圖選擇和組合。

## 管理方式

### 1. Step 庫（有限的積木集合）

```
規劃類：
  - research    技術調研、競品分析、約束確認
  - design      系統設計、資料格式、介面約定
  - validate    對照需求找缺口
  - scope       MVP 定義、優先級排序
  - split       拆成 issues + 依賴圖

執行類：
  - plan        讀 issue、研究 codebase、產出計畫
  - implement   寫 code、commit、建 PR
  - review      審查 PR diff

運維類（未來）：
  - deploy      部署
  - monitor     監控
  - rollback    回滾
```

每個 step 有自己的 skill/template。**新增 step 才需要寫新規則。**

### 2. Pipeline 模板（常見的組合）

```
execution:    plan → implement → review
planning:     research → design → validate → scope → split
quick-fix:    implement → review
evaluation:   research
full-project: research → design → validate → scope → split → dispatch(execution)
```

模板是建議，AI 可以調整。

### 3. AI 組裝（動態）

```
AI 根據意圖：
  1. 選擇需要哪些 steps
  2. 決定順序和依賴
  3. 決定哪些 step 之間需要人類閘門
  4. 組裝成 pipeline
  5. 交給 Karvi kernel 執行
```

Kernel 不管組合方式，只管每個 step 的執行保證。

## 跟其他 Vision 文件的關係

| 文件 | 關係 |
|------|------|
| 03-agent-execution-kernel.md | Kernel 提供 Level 1 規則 |
| 04-village-nation.md | Village Chief 做 AI 組裝 |
| 07-planning-automation.md | 規劃 pipeline 是第一個新 pipeline 模板 |
| 08-cross-repo-skills.md | Skills 是 Level 3 規則的載體 |
