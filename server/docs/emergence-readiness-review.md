# 湧現就緒度評審

> 日期：2026-03-03
> 用途：三軌對照（長任務 × 國家治理 × 湧現能力），作為架構決策的檢視基準
> 原則：不做只求上線的 MVP，做能累積的結構

---

## 為什麼不能只做 MVP

市場上每個 agent 框架都在做 MVP：能跑任務、能接 API、能出結果。這產生三個問題：

1. **MVP 不累積** — 每次任務都是一次性的，結果用完就丟，下一次從零開始
2. **MVP 不收斂** — 沒有回饋閉環，同樣的錯誤重複犯，agent 永遠不會變好
3. **MVP 不協作** — 多 agent 各做各的，沒有共享知識也沒有分工協議

Karvi 的差異化不是「能跑任務」（誰都能），而是**任務跑完之後留下了什麼**。如果架構不支持累積，karvi 就只是另一個 task runner。

**湧現的前提是累積。累積的前提是結構。結構不會從 MVP 裡長出來。**

---

## 八個湧現因素：深度審視

### 因素 1：任務多樣性

> 只做單一任務不會湧現，跨場景才會逼出抽象能力。

**為什麼重要：** 如果 karvi 只跑 coding task，agent 學到的全是「怎麼改程式碼」。要湧現路由能力和流程壓縮，需要 agent 見過「寫文件」「跑測試」「審核 PR」「分析數據」等不同類型的任務，才能抽象出「什麼任務該怎麼處理」的 meta-pattern。

**Karvi 現狀：**

| 有的 | 缺的 |
|------|------|
| step pipeline 支援 plan / implement / review / custom | 實際使用幾乎全是 coding（implement step） |
| pipeline templates 可定義不同流程（PR #184） | 沒有非 coding 的 template 範例 |
| 多 runtime adapter（5 個） | runtime 選擇是靜態映射，不是根據任務類型 |

**長任務關聯：** 長任務天然帶來多樣性 — 一個大任務內部會有 research、implement、test、document 等子步驟。step pipeline 的多 step 設計已經支持這個。

**國家關聯：** 6 個 Village 各有專長（frontend、backend、infra、data、security、docs），天然提供任務多樣性。但需要跨 Village 的任務路由才能利用。

**湧現就緒度：⬤⬤⬤◯◯ (3/5)** — 結構有，實際多樣性不夠。

**關鍵動作：**
- 不需要新 issue。多樣性隨使用者場景自然增加
- pipeline template 加幾個非 coding 範例（docs、analysis、migration）會有催化效果

---

### 因素 2：高品質回饋信號

> 沒有真實回饋，只有文字回覆，就無法進化。

**為什麼重要：** 這是湧現和「看起來聰明」的分界線。沒有可驗證的回饋，agent 無法知道自己做對了還是做錯了，lesson 系統學到的都是噪音。

**Karvi 現狀：**

| 信號 | 來源 | 品質 | 程式碼位置 |
|------|------|------|-----------|
| 品質評分 | `process-review.js` 的 LLM 審查 | 中 — LLM 自己評自己，有 bias | `process-review.js` |
| PR merge/reject | GitHub integration | **高** — 人類行為是最真實的信號 | `integration-github.js` |
| CI pass/fail | GitHub checks（尚未接入） | **高** — 二元、客觀、不可偽造 | 未實作 |
| step succeeded/failed | step-worker 回報 | 中 — 只知道跑完沒有，不知道品質 | `step-worker.js` |
| retry 次數 | step-schema retry_policy | 中 — 間接信號，retry 多 = 不穩定 | `step-schema.js` |
| token 消耗 | usage tracking | 低 — 花得多不代表做得差 | `usage/` |
| 人工評分 | 不存在 | — | — |
| 商業結果 | 不存在 | — | — |

**關鍵洞察：** karvi 有三層回饋，但只用了最弱的一層。

```
Layer 1（弱）: agent 自己說「我做完了」          ← 現在主要依賴這個
Layer 2（中）: CI/test 驗證結果是否正確          ← 有接口但沒接通
Layer 3（強）: 人類行為（merge/reject/revert）    ← 有 GitHub integration 但沒回寫到 lesson
```

**長任務關聯：** 長任務的回饋延遲更長（跑 30 分鐘才知道結果），需要中間信號（test pass、lint pass）作為 checkpoint。

**國家關聯：** 30 個 agent 的回饋量是 3 個的 10 倍。如果回饋品質低，lesson 系統會被噪音淹沒。**高品質回饋是 scale up 的前提。**

**湧現就緒度：⬤⬤◯◯◯ (2/5)** — 有管道但信號品質不夠。

**關鍵動作：**
- [ ] **接 CI 結果到 step 回饋**（PR merge → step succeeded 是正信號，CI fail → 負信號）
- [ ] **PR merge/reject 回寫到 lesson 系統**（retro.js 增加 GitHub event 信號源）
- [ ] confidence L1 信號燈（#52）作為品質 checkpoint

---

### 因素 3：可累積記憶

> 不只存對話，要存「做了什麼 → 結果如何 → 下次怎麼改」。

**為什麼重要：** 這是 karvi 和所有 agent 框架最大的差異點。大多數框架的記憶 = conversation history，用完就丟。Karvi 有 edda（決策追蹤）+ retro.js（回顧分析）+ lesson injection（知識注入），形成完整的「經驗累積 → 行為改變」鏈。

**Karvi 現狀：**

```
signal（原始事件）
  → retro.js 分析
    → insight（趨勢識別）
      → lesson（可操作知識）
        → preflight injection（注入下一次 dispatch）
          → agent 行為改變
```

| 環節 | 狀態 | 說明 |
|------|------|------|
| signal 收集 | ✅ 運作中 | step 完成/失敗都產生 signal |
| retro 分析 | ✅ 運作中 | `retro.js` 定期掃描 signal → insight |
| insight → lesson | ✅ 運作中 | `management.js:matchLessonsForTask()` |
| lesson → preflight | ✅ 運作中 | dispatch message 注入 relevant lessons |
| edda 決策追蹤 | ✅ 運作中 | `edda decide` + `edda log` |
| edda → dispatch | ✅ 運作中 | PR #211 three-layer protection |

**這是 karvi 最強的部分。** 但有兩個隱患：

1. **lesson 品質取決於 signal 品質** — 如果因素 2 的回饋信號是低品質的，累積下來的 lesson 也是低品質的
2. **lesson 沒有淘汰機制** — 錯誤的 lesson 會一直注入，沒有「驗證 lesson 是否有效」的閉環

**長任務關聯：** 長任務產生更多 signal（多 step），lesson 累積更快。但也更容易累積噪音。

**國家關聯：** 30 agent 共享 lesson pool。一個 agent 的錯誤 lesson 會污染其他 29 個。需要 lesson 的 scope（per-village? per-territory? global?）。

**湧現就緒度：⬤⬤⬤⬤◯ (4/5)** — 最強的一環，但缺淘汰機制。

**關鍵動作：**
- [ ] lesson 有效性驗證：注入 lesson 後的任務成功率 vs 未注入的對照
- [ ] lesson 淘汰：連續 N 次注入後任務仍然 fail → 標記 lesson 為 ineffective
- [ ] lesson scope：Village 級 lesson 不污染其他 Village

---

### 因素 4：閉環機制

> 沒有 retry/修正迴路，就只是一次性工具呼叫。

**為什麼重要：** 單次 dispatch 只是 API call。plan → act → review → retry 的循環才能產生「行為修正」，這是湧現的最小單元。

**Karvi 現狀：**

```
plan step → implement step → review step → (pass) → complete
                                         → (fail) → revision loop (PR #181)
                                                     → re-implement with feedback
                                                     → re-review
                                                     → max_review_attempts → dead
```

| 閉環 | 狀態 | 說明 |
|------|------|------|
| step retry（同一步重試） | ✅ | backoff: 5s, 10s, 20s → dead |
| revision loop（修正重做） | ✅ | kernel 根據 review 結果決定 re-implement（PR #181） |
| failure mode routing | ✅ | `route-engine.js` 的 FAILURE_MODES → 不同 remediation 策略 |
| cross-task learning | ✅ | 失敗 → signal → retro → lesson → 下一個任務的 preflight |

**這是完整的三層閉環：**

```
閉環 1（微觀）: step retry — 同一步骤重試            秒級
閉環 2（中觀）: revision loop — 修正後重做            分鐘級
閉環 3（宏觀）: signal → lesson → preflight — 跨任務  小時/天級
```

**長任務關聯：** 長任務需要更深的閉環。一個 implement step 跑 30 分鐘失敗，盲目 retry 浪費資源。需要 kernel 分析失敗原因 → 調整策略（換 model、縮小 scope、拆步驟）再重試。

**國家關聯：** 30 agent 的閉環會互相干擾。Agent A 的 retry 佔用資源 → Agent B 超時 → 級聯失敗。需要全局的 retry budget。

**湧現就緒度：⬤⬤⬤⬤◯ (4/5)** — 三層閉環已有，缺智慧化（失敗後策略調整而非盲目重試）。

**關鍵動作：**
- [ ] kernel 的 revision decision 從規則 → LLM：分析失敗原因，決定重試策略
- [ ] 全局 retry budget：每小時最多 N 次 retry，防止級聯失敗

---

### 因素 5：環境可操作性

> 能改檔、跑測試、查資料、發任務，才有機會形成複合能力。

**Karvi 現狀：**

| 能力 | 狀態 | 透過 |
|------|------|------|
| 改檔案 | ✅ | runtime CLI（Claude Code、OpenCode 等）的內建工具 |
| 跑測試 | ✅ | agent 可以 `npm test`、`node test.js` 等 |
| 讀 codebase | ✅ | agent 有 file read/search 能力 |
| Git 操作 | ✅ | agent 可以 commit、push、create PR |
| 發 HTTP 請求 | ⚠️ | agent 可以但沒有結構化的 API 呼叫能力 |
| 發任務給其他 agent | ❌ | 沒有 agent-to-agent dispatch 機制 |
| 查詢 board 狀態 | ❌ | agent 不知道其他任務的狀態 |

**關鍵缺口：agent 是盲的。** 它能操作環境，但看不到 karvi 系統本身的狀態。一個 agent 不知道：
- 其他 agent 在做什麼
- 自己的任務在更大 pipeline 裡的位置
- board 上有哪些 blocked task 等著它的結果

**長任務關聯：** 長任務的 agent 更需要感知系統狀態 — 「我的下游 step 在等我」「deadline 快到了」「budget 快用完了」。

**國家關聯：** 跨 Village 協作的前提是 agent 能感知其他 Village 的存在和狀態。

**湧現就緒度：⬤⬤⬤◯◯ (3/5)** — 環境操作能力夠，但系統感知能力為零。

**關鍵動作：**
- [ ] dispatch message 注入系統狀態摘要（你的 step 是第 3/5 步、budget 剩 60%、下游 step 在等你）
- [ ] agent-to-agent signal：agent 完成某步後通知相關 agent（透過 kernel signal，不是直接呼叫）

---

### 因素 6：角色分工與協議

> 明確角色與交接協議會催生協作層能力（而不是互相覆蓋）。

**Karvi 現狀：**

| 機制 | 狀態 | 說明 |
|------|------|------|
| Village agent 角色 | ✅ | 參與者有 role（engineer、reviewer 等） |
| edda claim/request | ✅ | 多 agent 協調：宣告範圍、請求跨界 |
| scope lock（#213） | 未實作 | 限制 agent 可改的檔案 |
| step-level 分工 | ✅ | plan step 和 implement step 可以不同 agent |
| review 分工 | ✅ | `review_agent` control 指定審查者 |
| 交接協議 | ⚠️ | step 之間靠 artifact 傳遞，但沒有結構化的 handoff format |

**關鍵洞察：** 分工不是問題，**交接才是**。兩個 agent 之間的資訊傳遞目前靠 artifact（一坨文字），沒有結構化的 schema。Plan agent 的輸出是自由文字，implement agent 要自己解讀。

**國家關聯：** 跨 Village 交接更脆弱 — 不同 Village 的 agent 可能用不同 runtime（claude vs opencode），prompt 格式不同，artifact 解讀方式不同。

**湧現就緒度：⬤⬤⬤◯◯ (3/5)** — 分工結構有，交接品質低。

**關鍵動作：**
- [ ] artifact schema：plan step 輸出結構化 JSON（file_list、acceptance_criteria、constraints），不是自由文字
- [ ] #213 scope lock 實作：讓分工的邊界可執行

---

### 因素 7：選擇壓力與成本壓力

> token 預算、時間上限、成功率目標，會逼出更有效策略。

**為什麼重要：** 沒有壓力，agent 會用最笨的方式解決問題（讀所有檔案、改所有東西、用最貴的 model）。壓力逼出效率，效率累積成能力。

**Karvi 現狀：**

| 壓力源 | 狀態 | 實際效果 |
|--------|------|----------|
| token budget（`task.budget`） | ⚠️ 欄位存在但不強制 | agent 花多少都行，budget 只是記錄 |
| 時間限制（timeout） | ⚠️ 寫死 5 分鐘（#216） | 太短不夠用，太長沒壓力 |
| retry 上限（`max_attempts: 3`） | ✅ 強制 | 3 次機會，用完就 dead |
| 成功率目標 | ❌ 不存在 | 沒有「agent A 成功率要 > 80%」的門檻 |
| 成本追蹤 | ⚠️ usage tracking 有記錄 | 但沒有反壓 — 花再多也不會降級 |
| model 降級 | ❌ 不存在 | 所有任務都用最貴的 model，沒有「簡單任務用便宜 model」 |

**長任務關聯：** 長任務天然消耗更多 token。沒有 budget 壓力 → 一個 30 分鐘的任務可能花掉 $5 → 30 個 agent 同時跑 = $150/小時。

**國家關聯：** Nation 級別必須有預算分配。Territory A 花太多 → Territory B 沒額度。

**湧現就緒度：⬤◯◯◯◯ (1/5)** — 最弱的因素。有數據但完全沒壓力。

**關鍵動作：**
- [ ] **budget 強制執行**：token 超過 budget → 自動降級 model 或暫停派發
- [ ] **model 分級**：簡單 step（lint fix、doc update）用便宜 model，複雜 step 用貴 model
- [ ] **成功率門檻**：agent 連續 N 次 fail → 暫停派發 + 發 signal 給人類

---

### 因素 8：人類介入節點設計

> 什麼要人工批准、什麼可自動，會決定湧現是「可用」還是「失控」。

**Karvi 現狀：**

| 介入點 | 機制 | 預設 |
|--------|------|------|
| 任務派發 | `auto_dispatch` control | off（需手動） |
| 品質審查 | `auto_review` control | on |
| 重新派發 | `auto_redispatch` control | off（需手動） |
| PR 合併 | GitHub PR review | 手動 |
| lesson 應用 | `auto_apply_insights` control | on |
| step kill | #214（未實作） | 無法 kill |

**關鍵洞察：** 介入節點的設計是對的 — 每個自動化都有開關。但缺少**動態調整**：

```
理想狀態：
  agent 成功率 > 90% → auto_dispatch: on, auto_redispatch: on
  agent 成功率 60-90% → auto_dispatch: on, auto_redispatch: off（失敗了等人看）
  agent 成功率 < 60% → auto_dispatch: off（全部手動）
```

這就是「品質校準能力」的基礎 — 系統根據歷史表現自動調整自動化程度。

**湧現就緒度：⬤⬤⬤◯◯ (3/5)** — 節點設計好，缺動態調整。

**關鍵動作：**
- [ ] 基於成功率的自動化程度調整（controls 值隨歷史表現變化）
- [ ] escalation 觸發器：某些 failure pattern → 強制人工介入（不只是 retry）

---

## 壞能力防禦

湧現不只產生好能力。以下是必須預防的負面湧現：

### Reward Hacking（為過指標而非真解決）

**場景：** agent 學到「刪掉失敗的 test case → CI pass → step succeeded」比「修 bug」更快。

| 防護 | 狀態 |
|------|------|
| protected-diff-guard（PR #211） | ✅ 擋 @protected 標記的程式碼 |
| scope lock（#213） | 未實作 — 限制可改檔案 |
| test coverage 不降檢查 | ❌ 沒有 — 最大漏洞 |

**關鍵動作：**
- [ ] post-check 加 test coverage diff：coverage 下降 → step failed
- [ ] 偵測「刪 test」行為：diff 裡刪除 test file 或 describe/it block → 自動 flag

### Zombie Tasks（無效循環）

**場景：** task retry → 同樣失敗 → retry → 同樣失敗 → 耗盡資源但沒進展。

| 防護 | 狀態 |
|------|------|
| max_attempts: 3 | ✅ |
| dead state（terminal） | ✅ |
| cycle_stall_timeout_hours: 4 | ✅ |
| 失敗原因分析 → 換策略 | ❌ 盲目重試 |

**現有防護足夠防止無限循環，但不夠防止「浪費 3 次機會做同樣的事」。**

**關鍵動作：**
- [ ] retry 前比對上次失敗原因：相同原因 → 不盲目重試，先換策略

### 過度自動化（該停不停、該問不問）

**場景：** auto_dispatch + auto_review + auto_redispatch 全開 → agent 改壞了 → 自己 review 自己 pass → 推上去。

| 防護 | 狀態 |
|------|------|
| auto_review / auto_redispatch 開關 | ✅ |
| quality_threshold | ✅ |
| review_agent ≠ implement_agent | ⚠️ 可以但不強制 |

**關鍵動作：**
- [ ] 強制 review_agent ≠ implement_agent（不能自己審自己）

### 任務漂移（偏離原目標）

**場景：** 要改一個 bug，agent 順手重構了周邊程式碼，引入新 bug。

| 防護 | 狀態 |
|------|------|
| scope lock（#213） | 未實作 |
| protected-diff-guard（PR #211） | ✅ 但只保護標記過的行 |
| post-check file list | 未實作 |

**#213 是最關鍵的防漂移機制。未實作 = 任務漂移完全沒防護。**

---

## 三軌對照總覽

```
因素                    Village    Territory    Nation    湧現
                        (長任務)    (30 agent)   (Nox)    (累積進化)
─────────────────────────────────────────────────────────────────
1. 任務多樣性            ◯          ◯           ◯        ⬤⬤⬤◯◯
2. 高品質回饋            ●          ●●          ●●●      ⬤⬤◯◯◯  ← 最大瓶頸
3. 可累積記憶            ◯          ●           ●●       ⬤⬤⬤⬤◯  ← 最強
4. 閉環機制              ◯          ●           ●        ⬤⬤⬤⬤◯
5. 環境可操作性          ◯          ●           ●●       ⬤⬤⬤◯◯
6. 角色分工              ◯          ●●          ●●●      ⬤⬤⬤◯◯
7. 選擇壓力              ●          ●●●         ●●●      ⬤◯◯◯◯  ← 最弱
8. 人類介入              ◯          ●           ●●       ⬤⬤⬤◯◯

◯ = 不需要額外工作    ● = 需要一些工作    ●● = 需要顯著工作    ●●● = 需要設計突破
⬤ = 就緒    ◯ = 未就緒
```

### 解讀

**湧現就緒度排序：**

```
最強 ──→ 最弱

可累積記憶 (4/5)  >  閉環機制 (4/5)  >  任務多樣性 (3/5)
                                       環境可操作性 (3/5)
                                       角色分工 (3/5)
                                       人類介入 (3/5)
                                     >  高品質回饋 (2/5)
                                     >  選擇壓力 (1/5)
```

**結論：karvi 的累積和閉環是同類最強，但回饋品質和成本壓力是最弱的兩環。**

補強這兩環比加新功能重要。一個有高品質回饋 + 成本壓力的 5-agent Village，比一個沒有的 30-agent Territory 更接近湧現。

---

## 關鍵動作清單

按「對湧現推力」排序，不是按「容易程度」排序。

### Tier 1：補最弱的兩環（回饋 + 壓力）

| 動作 | 補強因素 | 大小 | 依賴 |
|------|----------|------|------|
| CI pass/fail 結果回寫到 step 信號 | 回饋 | 中 | GitHub integration |
| PR merge/reject 回寫到 lesson 系統 | 回饋 | 中 | retro.js 擴充 |
| budget 超額 → 自動降級 model | 壓力 | 中 | usage tracking |
| 簡單 step 用便宜 model 的路由邏輯 | 壓力 | 中 | model 分級規則 |
| confidence L1 信號燈（#52） | 回饋 | 中 | 已有設計 |

### Tier 2：強化已有優勢（記憶 + 閉環）

| 動作 | 補強因素 | 大小 | 依賴 |
|------|----------|------|------|
| lesson 有效性驗證 + 淘汰 | 記憶 | 中 | 需要 A/B 對照邏輯 |
| retry 前分析失敗原因 → 換策略 | 閉環 | 中 | kernel LLM 決策 |
| artifact 結構化 schema | 分工 | 小 | plan step 輸出格式 |
| dispatch message 注入系統狀態 | 環境感知 | 小 | context-compiler 擴充 |

### Tier 3：防禦負面湧現

| 動作 | 防禦 | 大小 | 依賴 |
|------|------|------|------|
| #213 scope lock | 任務漂移 | 中 | 已有 issue |
| test coverage 不降檢查 | reward hacking | 小 | post-check 擴充 |
| 強制 review_agent ≠ implement_agent | 過度自動化 | 小 | controls 擴充 |
| 基於成功率的自動化程度調整 | 失控 | 中 | 歷史數據 + threshold |

---

## 反 MVP 原則

每次要做新功能時，問三個問題：

1. **這個功能跑完之後留下了什麼？** 如果答案是「什麼都沒留下」→ 重新設計
2. **這個功能的結果會回饋到哪裡？** 如果答案是「不會回饋」→ 加回饋閉環
3. **這個功能在 30 agent 規模下還能用嗎？** 如果答案是「不能」→ 先設計介面再實作

**MVP 是「能跑就好」。Karvi 要的是「跑完之後系統變得更好」。**

---

## 追蹤

### 已有 Issue（基礎設施）
- #213 — scope lock
- #214 — execution kill
- #215 — heartbeat 補齊
- #216 — timeout 可配置
- #217 — opencode NDJSON bug
- #218 — dispatch convergence
- #219 — cancelled state

### 已有設計文件
- `docs/long-task-control-review.md` — 長任務控制評審
- `docs/design-async-dispatch.md` — 同步→異步 dispatch 架構

### 待開 Issue（湧現相關）
- [ ] CI/PR 結果回寫到 signal + lesson
- [ ] budget 強制執行 + model 降級
- [ ] lesson 有效性驗證 + 淘汰機制
- [ ] confidence L1 信號燈（已有 #52，需確認狀態）
- [ ] post-check test coverage 不降

### 待寫設計文件
- [ ] Multi-board 架構（Territory 基礎）
- [ ] 跨 Village 信號協議
- [ ] Nox 調度器設計
