# 12 — Guardian Agent：快速糾正代替深度審查

> 2026-03-06 討論記錄

## 問題

實際 dispatch 時，執行代理常犯機械性錯誤 — 搞混路徑、少步驟、誤解意思、放錯位置。一個 step 出錯就整條 pipeline 中斷，人要介入手動修。

```
Step 1: plan     → agent 做完了
Step 2: implement → agent 搞混路徑，寫到錯的目錄
                  → 或少了一個步驟
                  → 或誤解了 plan 的意思
Step 3: review   → 根本到不了這裡，因為 step 2 已經爛了

結果：整條 pipeline 死掉，人要介入，手動修，重來。
```

問題不是 agent 笨，是 **pipeline 太脆弱** — 一個 step 出錯就全掛。

同時，Vision 11 的安全規則是靜態定義，執行中沒人監控。

## 核心洞察

不需要深度審查每一步，需要的是**快速判斷明顯錯誤並糾正**。

```
Reviewer（現有的 review step）：
  - 讀完整 PR diff
  - 檢查邏輯、品質、風格
  - 慢、貴
  - 目的：確保品質

Guardian（新概念）：
  - 掃 step 產出的表面
  - 檢查：路徑對不對？格式對不對？有沒有產出？有沒有越界？
  - 快（幾秒）、便宜（少量 token，部分不用 LLM）
  - 目的：確保機械正確性 + 安全邊界
```

## Guardian 的雙層架構

Guardian 不是純 code 也不是純 LLM — 是兩層依序執行：

```
Guardian 執行順序：
  1. 機械性檢查（code，0 成本）
     → 路徑、格式、存在性、越界
     → 失敗就直接處理，不用叫 LLM

  2. 語義性檢查（LLM，低成本）
     → 只有機械性檢查通過才跑
     → 意圖對齊、完成度、矛盾偵測
     → 用便宜模型（Haiku 級別）
     → 只看摘要不看完整 diff
```

先零成本擋明顯錯誤，再低成本判斷語義問題。不是二選一。

### Layer 1: 機械性檢查（不需要 LLM，零成本）

```
1. 路徑檢查
   → agent 的檔案變更都在 worktree 內嗎？
   → 有沒有寫到 worktree 外面？
   → 規則：git diff --name-only 全部在預期目錄內

2. 產出存在性
   → plan step 有沒有產出 plan？（artifact 存在嗎？）
   → implement step 有沒有 commit？（git log 有新 commit 嗎？）
   → review step 有沒有 verdict？（artifact 有 LGTM/REJECT 嗎？）

3. 格式檢查
   → plan 的格式對嗎？（有沒有該有的 section？）
   → commit message 符合 conventional commits 嗎？

4. 越界偵測（安全相關）
   → agent 有沒有改 workflow/skill 文件？
   → agent 有沒有存取其他 worktree？
   → agent 有沒有呼叫不在白名單的操作？
```

### Layer 2: 語義性檢查（LLM，低成本）

只有 Layer 1 通過才執行。用便宜模型（Haiku 級別），只看摘要不看完整 diff。

```
5. 意圖對齊
   → plan 說「改 A 模組」，implement 卻改了 B → 明顯偏離
   → 不需要讀懂 code，只要比對 plan 的目標和 diff 的檔案路徑

6. 遺漏偵測
   → plan 列了 3 個步驟，commit 只做了 1 個 → 明顯少了
   → 比對 plan 的 checklist 和實際 diff

7. 自相矛盾
   → step message 說「不要改 X」，但 diff 包含 X → 明顯違反
```

### Guardian LLM vs Review LLM

Guardian 可以用 LLM，但用法跟 review step 的 LLM 完全不同：

```
Review LLM（現有 review step）：
  - 輸入：完整 diff（可能幾千行）
  - 問題：「這段 code 品質如何？有沒有 bug？」
  - 深度高、成本高
  - 用強模型（Sonnet/Opus 級別）

Guardian LLM：
  - 輸入：step 指令 + step 產出的摘要（不是完整 diff）
  - 問題：「這個 agent 有沒有做對事情？明顯偏離嗎？」
  - 深度低、成本低
  - 用便宜模型就夠（Haiku 級別）
```

### Guardian LLM Prompt 範例

```
你是 pipeline 的品質檢查員。不需要審查程式碼品質。
只需要判斷：agent 有沒有按指令完成工作？

Step 指令：「修改 auth 模組，加入 JWT 驗證」
Step 產出摘要：
  - 改了 3 個檔案：database.js, schema.js, migration.js
  - commit message: "refactor: restructure database schema"
  - 沒有碰 auth 相關檔案

判斷：PASS / DRIFT（偏離）/ INCOMPLETE（未完成）/ VIOLATION（越界）
如果不是 PASS，簡短說明原因。
```

這個 prompt 用 Haiku 跑，幾秒完成，成本幾乎可以忽略。

### 為什麼用 LLM 而不只是 code

```
純 code 檢查能抓的：
  ✅ 路徑錯了
  ✅ 沒有 commit
  ✅ 格式不對
  ❌ agent 理解錯了意思但產出格式正確
  ❌ agent 做了一半覺得做完了
  ❌ agent 偷偷改了不該改的邏輯

加了 LLM 能抓的：
  ✅ 以上全部
  ✅ 「plan 說改 auth，你怎麼改了 database？」
  ✅ 「你只做了 3 件事中的 1 件」
  ✅ 「這個改動跟 issue 要求的完全無關」
```

格式正確但語義錯誤 — 這是純 code 檢查永遠抓不到的。LLM 層是必要的。

## Guardian 能做什麼

關鍵：**Guardian 不只是報錯，是能糾正。**

```
層級 1: 自動修正（不需要人）
  → 路徑錯了 → 移到正確位置
  → commit message 格式不對 → amend
  → 少了 artifact → 從 agent 的 output 提取

層級 2: 帶 context 重試（不需要人）
  → agent 搞混意思 → guardian 寫更清楚的指令 → 重新跑這個 step
  → 不是盲目 retry，是帶著「你剛才錯在哪」的 retry

層級 3: 上報（需要人）
  → 越界操作 → 停止 + 通知用戶（安全問題）
  → 重試 2 次還是錯 → 停止 + 通知用戶（能力問題）
  → 可疑行為 → 標記 + 繼續但加強監控
```

```
之前（脆弱）：
  step 出錯 → pipeline 死掉 → 人介入 → 手動修 → 重來

之後（韌性）：
  step 出錯 → guardian 發現 → 自動修正或重試 → pipeline 繼續
  step 越界 → guardian 發現 → 停止 + 通知人（安全）
```

## 跟安全模型（Vision 11）的整合

Guardian 是 Vision 11 安全規則的**運行時實現**：

```
Vision 11 定義了「什麼不能做」（靜態規則）
Guardian 負責「即時偵測有沒有做」（動態執行）

Layer 0 硬規則 → Guardian 檢查是否被違反
Layer 2 操作白名單 → Guardian 檢查是否越界
Layer 3 變更偵測 → Guardian 檢查 hash
```

```
之前的安全模型：
  規則定義好 → kernel 執行前檢查 → 執行中沒人管 → 執行後 review

加了 Guardian：
  規則定義好 → kernel 執行前檢查 → 執行中 guardian 監控 → 執行後 review
                                    ^^^^^^^^^^^^^^^^
                                    填補了中間的空白
```

## 在 Pipeline 中的位置

```
之前：
  plan ──→ implement ──→ review
       直接        直接

之後：
  plan ──→ 🛡️ ──→ implement ──→ 🛡️ ──→ review ──→ 🛡️
       guardian          guardian          guardian
```

Guardian 不是一個 step，是 **kernel 的能力**。就像 OS 的 page fault handler — 不是程式的一部分，是 OS 在背後自動做的。

## 成本分析

```
一次完整 review（現有 review step）：
  → 讀完整 diff + 多項檢查
  → ~5000-10000 tokens
  → ~$0.05-0.10

一次 guardian check：
  → Layer 1 機械性檢查：0 tokens（純 code）
  → Layer 2 語義性檢查：~500-1000 tokens（Haiku 級別）
  → ~$0.005-0.01

一條 3-step pipeline：
  → 3 次 guardian = ~$0.015-0.03
  → 1 次 review = ~$0.05-0.10
  → Guardian 成本是 review 的 1/5 到 1/10
```

**用 1/10 的成本擋掉 80% 的機械性錯誤，讓 review 能專注在真正的品質問題。**

## 實作距離

```
已經有的：
  ✅ step 狀態機（step-worker.js）
  ✅ artifact store（artifact-store.js）
  ✅ post-check 機制（step 完成後的檢查點）
  ✅ worktree 隔離

需要加的：
  1. post-check 擴展為 guardian check     → 小（擴展現有機制）
  2. 機械性檢查規則                       → 小（路徑、格式、存在性）
  3. 語義性檢查（LLM 輕量判斷）          → 中（新增 LLM 呼叫）
  4. 自動修正 / 帶 context 重試           → 中（重試帶錯誤訊息）
  5. 越界偵測 + 通知                      → 小（比對白名單）
```

Post-check 已經存在於 step-worker.js — 現在只做簡單的狀態推進。把它擴展成 guardian 是最自然的路徑。

## 跟其他 Vision 文件的關係

| 文件 | 關係 |
|------|------|
| 11-workflow-security-model.md | Guardian 是安全規則的運行時實現 |
| 10-workflow-file-architecture.md | Guardian 驗證 agent 有沒有按 workflow 執行 |
| 09-step-library-and-composition.md | Guardian 驗證 step 的完成條件（done_when） |
| 07-planning-automation.md | 規劃 pipeline 也需要 guardian（設計文件格式對嗎？缺口有沒有漏？） |
| 03-agent-execution-kernel.md | Guardian 是 Layer 2（執行保證）的強化 |

## 一句話

**不要等 review 才發現問題 — 每個 step 之間放一個快速、便宜的 guardian，擋掉 80% 的機械性錯誤和安全越界。Guardian 是 kernel 的能力，不是 pipeline 的 step。用 1/10 的成本讓 pipeline 從脆弱變韌性。**
