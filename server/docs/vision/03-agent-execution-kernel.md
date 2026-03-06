# 03 — Agent Execution Kernel

> 2026-03-06 研究筆記

## 一個新品類

Karvi 不是 workflow engine、不是 orchestrator、不是 supervisor。是三者的交集，為 AI agent 設計。

```
Workflow engine  → 提供 step 組合能力
Orchestrator     → 管 agent 生命週期
Supervisor       → 保證可靠性

三者合一 + AI-native interface = Agent Execution Kernel
```

這個東西以前不存在，因為 AI agent 是新的運算單元。

## 類比：作業系統

```
程式 → OS → 硬體
  程式不管記憶體分配、process 排程、檔案寫入
  程式只說「讀這個檔案」
  OS 保證：隔離、排程、資源管理、錯誤恢復

AI Agent → Karvi → Runtime（opencode/codex/任何）
  AI 不管 worktree 怎麼建、timeout 怎麼算、retry 怎麼排
  AI 只說「跑這個 step」
  Karvi 保證：隔離、排程、資源管理、錯誤恢復
```

## OS 概念對應

| OS 概念 | Karvi 對應 |
|---------|-----------|
| Process isolation | Worktree per task |
| Process states | Step 狀態機（queued → running → succeeded / dead） |
| Process scheduler | tryAutoDispatch + 併發控制 |
| Resource limits | 預算上限（token / 時間 / 美元） |
| Signals (SIGKILL, SIGSTOP) | kill / pause / resume |
| Supervisor (systemd) | Retry + backoff + error classification |
| /proc filesystem | SSE progress + GET /api/tasks/:id/progress |
| System log | JSONL append-only audit trail |
| Syscall interface | CLI / REST API |
| Shell scripts | Workflow 模板 |

## AI 能做 vs Karvi 能做

```
AI 能做的：
  - 理解意圖
  - 決定要哪些 step
  - 組裝 pipeline
  - 遇到例外重新調整

AI 做不到的：
  - 同時跑 3 個 agent 並追蹤每一個
  - agent 掛了自動重試
  - 控制 token 燒到上限就停
  - 保證隔離（不會互相踩檔案）
  - 記錄每個 step 的 input/output/耗時/成本
  - 跑到一半讓人類介入再繼續
```

**AI 是指揮，Karvi 是整個後勤系統。AI 只管「做什麼」，Karvi 保證「怎麼做」的品質。**

## 四層架構

```
+-------------------------------------------+
|  Layer 1: 編排（AI 負責）                   |
|  讀 workflow → 決定 steps → 下指令           |
+---------------------+---------------------+
                      |
+---------------------v---------------------+
|  Layer 2: 執行保證（Karvi Kernel）          |
|                                            |
|  隔離    worktree per task，檔案不互踩       |
|  狀態機  step 狀態轉換有規則，不會亂跳       |
|  重試    失敗自動 backoff retry              |
|  超時    idle detection，卡住就殺            |
|  合約    deliverable 必須存在，沒有就重做     |
+---------------------+---------------------+
                      |
+---------------------v---------------------+
|  Layer 3: 運行控制（Karvi Kernel）          |
|                                            |
|  暫停/繼續   人類或 AI 隨時可以喊停          |
|  Kill       精準終止某個 step               |
|  預算硬停   token 到上限整個 task 停下來      |
|  人類閘門   跑完某 step 先讓人看過再繼續      |
|  動態調整   跑到一半改 controls 立即生效      |
+---------------------+---------------------+
                      |
+---------------------v---------------------+
|  Layer 4: 可觀測（Karvi Kernel）            |
|                                            |
|  即時進度   SSE streaming，tool call 計數    |
|  成本追蹤   per-step token + 時間 + 美元     |
|  Artifact   每個 step 的 input/output 存檔   |
|  Audit log  JSONL append-only，不可篡改      |
|  錯誤分類   CONTRACT / TEMPORARY / FATAL     |
+--------------------------------------------+
```

Layer 1 是 AI 的責任。Layer 2-4 是 Karvi kernel 的責任。

## AI 怎麼使用 Kernel

不是 MCP（趨勢在往 CLI 走），是 CLI + Workflow 定義檔。

### CLI Primitives（AI 呼叫的指令）

```bash
karvi task create --title "..." --goal "..."
karvi step add TASK-ID --type research --instruction "..."
karvi step add TASK-ID --type draft --instruction "..."
karvi status TASK-ID
karvi step retry TASK-ID:draft --context "新的理解"
karvi kill TASK-ID:draft
karvi cancel TASK-ID
```

### Workflow 模板（AI 參考的骨架）

```markdown
# workflows/contract-review.md
---
steps:
  - type: research
    instruction: "研究 {{input.contract_type}} 相關判例"
    criteria: "至少找到 3 個相關判例"
  - type: draft
    instruction: "根據研究結果撰寫審查報告"
  - type: validate
    instruction: "檢查法規合規性"
    on_fail:
      add_step: research
      context: "補充研究 {{failure_reason}}"
---
```

Workflow 是起點，不是限制。AI 帶著理解去調整 — 跳過、插入、改變順序、處理例外。

## 一句話定位

> **Agent Execution Kernel — AI agent 的運行保證層。**
>
> 不管誰編排（人或 AI），不管跑什麼 agent（Claude / Codex / 任何），
> Karvi 保證：隔離跑、追蹤到、控制住、失敗能恢復。

## 為什麼難描述

因為這個東西以前不存在。

- **Workflow engine** 假設人定義 DAG — AI 不需要固定 DAG
- **Orchestrator** 假設管的是容器 — Agent 不是容器
- **Supervisor** 假設 process 無狀態 — Agent 有 context、有判斷、有產出

Agent 是新的運算單元。不是 process、不是 container、不是 function。它有意圖、會判斷、會失敗但失敗方式跟 crash 不同（可能是「做錯了」而不是「掛了」）。

就像 Docker 剛出來時很難解釋 —「不是 VM、不是 process、是 container」— 直到大家用了才懂。

---

上一篇：[02-vertical-horizontal.md](02-vertical-horizontal.md) — 垂直與水平的新理解
下一篇：[04-village-nation.md](04-village-nation.md) — 從 Kernel 到村莊到國家
