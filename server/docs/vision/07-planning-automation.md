# 07 — 規劃階段自動化：AI 組裝 Pipeline

> 2026-03-06 討論記錄

## 問題

Karvi 現在能自動化的是「執行階段」（plan → implement → review）。但執行之前有一整個「規劃階段」：

```
用戶意圖（「我要做一款三消遊戲」）
  ↓
概念討論（劇情向？養成？AI聊天？）
  ↓
技術評估（引擎選擇、架構決策）
  ↓
系統設計（11 份 docs）
  ↓
缺口補充（對照需求找漏洞）
  ↓
MVP 定義
  ↓
任務拆分（GitHub issues）
  ↓
Dispatch（Karvi 派給 agent 執行）
```

**這個規劃過程本身能不能也跑在 Karvi 上？**

## 為什麼要自動化規劃

用戶的洞察：

> 下一次可能是不同的遊戲，不是三消。下一階段可能是其他專案。規模類似的會比較好。但這樣的討論到架構、直接 MVP 甚至成品的過程，是可以 AI 治理 AI 來完成的。

核心意思：**規劃 pipeline 的骨架是通用的，跟專案類型無關。**

```
不變的（可複用）：
  - pipeline 結構（research → design → validate → scope → split）
  - 每個 step 的產出格式（markdown docs, GitHub issues）
  - 驗證方式（缺口分析、MVP 原則「砍內容不砍功能」）
  - Karvi 的執行保證（隔離、追蹤、retry）

變的（每次不同）：
  - 用戶意圖（三消 vs RPG vs SaaS vs 行銷活動）
  - 研究內容（引擎選擇 vs 框架選擇 vs 平台選擇）
  - 設計模板（遊戲系統 vs web 架構 vs API 設計）
  - 拆分粒度
```

## 兩種角色

```
現在的做法：
  人（用戶）←→ AI 對話 → 產出 docs → 手動拆 issues → Karvi dispatch

自動化做法：
  人（用戶）→ 說意圖 → 規劃 AI（Village Chief）→ 自動跑規劃 pipeline → 產出 issues → Karvi dispatch → 執行 AI（Workers）
```

規劃 AI 就是 Village Chief（見 04-village-nation.md）。它本身也跑在 Karvi 上，它的工作不是寫 code，是：

1. 理解用戶意圖
2. 研究可行方案
3. 做設計決策
4. 產出設計文件
5. 拆成可執行的 tasks
6. 用 Karvi API dispatch 給 worker agents

## 規劃 Pipeline 定義

| Step | 做什麼 | 輸入 | 產出 |
|------|--------|------|------|
| **research** | 技術調研、競品分析、約束確認 | 用戶意圖 + 參考資料 | 技術決策表 |
| **design** | 系統設計、資料格式、介面約定 | 技術決策 + 需求 | 設計文件（如 00-06.md） |
| **validate** | 對照需求找缺口 | 設計文件 + 原始需求 | 補充文件（如 09-missing.md） |
| **scope** | MVP 定義、優先級排序 | 完整設計 | MVP 範圍文件（如 10-mvp.md） |
| **split** | 拆成 GitHub issues + 依賴圖 | MVP 範圍 | issues，可被 Karvi dispatch |

對比現有執行 pipeline：

```
執行 pipeline（現有）：
  plan → implement → review
  產出：PR（code）

規劃 pipeline（新增）：
  research → design → validate → scope → split
  產出：docs + issues
```

## 關鍵差異：人類閘門

規劃過程不是線性的。回顧《幻惑怪談》的實際過程：

```
用戶給了流程圖 → AI 寫了 6 份 docs
→ 用戶說「缺章節劇情和好感度交互」→ AI 補了 2 份
→ 用戶又給了一次流程圖 → AI 發現還缺 7 個系統 → 補了 09-missing
→ 用戶說「寫個 MVP」→ AI 寫了 10-mvp
```

**每次用戶的介入都改變了方向。** 這是規劃階段的本質 — 需要人的判斷。

所以規劃 pipeline 跟執行 pipeline 的根本差異：

```
執行 pipeline：agent 自己跑完，人最後 review
規劃 pipeline：每個 step 之間可能需要人確認或補充
```

規劃 pipeline 的完整流程：

```
Village Chief（規劃 AI）：
  → step 1: research（調研引擎、技術、競品）
  → ⏸️ 暫停，讓人確認方向
  → step 2: design（產出系統設計 docs）
  → ⏸️ 暫停，讓人確認設計
  → step 3: validate（找缺口，交叉比對需求）
  → step 4: scope（定 MVP）
  → ⏸️ 暫停，讓人確認範圍
  → step 5: split（拆 issues + 依賴圖）
  → 自動 dispatch issues 給 worker agents

Worker Agents（執行 AI）：
  → plan → implement → review（現有 Karvi pipeline）
```

⏸️ 就是「人類閘門」— step 完成後暫停等人確認，而不是自動推進下一步。

## Karvi Kernel 需要什麼才能支援

### 1. 人類閘門 step（Human Gate）

現在所有 step 完成後自動推進。需要一種新模式：

```javascript
// step 定義加一個 gate 屬性
{
  step_id: "design",
  state: "succeeded",
  gate: "human_approval",  // ← 新增
  // succeeded 但不自動推進，等人確認
}
```

人確認後呼叫 API 放行：
```
POST /api/tasks/:id/steps/:step_id/approve
```

### 2. 規劃 step 模板

像 Symphony 的 WORKFLOW.md，但用於規劃：

```yaml
# planning-workflow.md
steps:
  - id: research
    prompt: |
      研究用戶的專案需求，調研技術選項。
      產出：技術決策表（markdown）
    gate: human_approval

  - id: design
    prompt: |
      根據技術決策，設計系統架構。
      產出：設計文件（每個系統一份 markdown）
    gate: human_approval

  - id: validate
    prompt: |
      交叉比對設計文件和原始需求，找出缺口。
      產出：缺口清單 + 補充設計

  - id: scope
    prompt: |
      定義 MVP 範圍。原則：砍內容不砍功能。
      產出：MVP 範圍文件
    gate: human_approval

  - id: split
    prompt: |
      把 MVP 拆成 GitHub issues，標註依賴關係。
      產出：issues（自動 dispatch）
```

### 3. Step 產出串接

Step 1 的產出自動變成 Step 2 的輸入：

```
research 產出 → 存為 artifact → design step 的 prompt 帶入 artifact
```

現有 artifact-store.js 已經能存 step 產出，但沒有自動帶入下一步的機制。

### 4. 動態 Task 生成

split step 的產出是一組 issues。這些 issues 要自動變成 Karvi tasks 並 dispatch：

```
split step 完成 → 產出 JSON（issues 清單）→ kernel 自動呼叫 POST /api/projects → worker agents 開始執行
```

這是「AI 治理 AI」的核心 — 規劃 AI 的產出直接驅動執行 AI。

## 實作估計

| 缺口 | 涉及的檔案 | 大小 |
|------|-----------|------|
| 人類閘門 step | step-worker.js, kernel.js | 小（加一個 gate check） |
| 規劃 step 模板 | 新增 planning-workflow 概念 | 中（跟 #276 template prompt 可合併） |
| step 產出串接 | step-worker.js, artifact-store.js | 小（artifact → 下一步 prompt） |
| 動態 task 生成 | kernel.js | 中（step 完成後自動建 tasks） |

總共可能 3-4 個 issue 的量。

## 與 Vision 文件的關係

```
01-landscape.md       — 競品研究（別人怎麼做）
02-vertical-horizontal.md — 垂直水平新理解（為什麼需要 AI 包裝）
03-agent-execution-kernel.md — Kernel 定義（四層架構）
04-village-nation.md  — 村莊到國家（AI 治理 AI 的結構）
05-kernel-gaps.md     — Kernel 缺口（P0-P3）
06-ai-governs-ai.md   — AI 治理 AI 討論記錄
07-planning-automation.md — ← 這份：規劃自動化的具體方案
```

## 一句話

**規劃階段跟執行階段用同一個 kernel，差別只在 step 定義和是否有人類閘門。Kernel 不需要知道跑的是「規劃」還是「執行」— 都是 task + step + agent。**
