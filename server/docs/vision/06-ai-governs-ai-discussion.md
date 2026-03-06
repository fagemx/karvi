# 06 — AI 治理 AI：完整討論記錄

> 2026-03-06 對話記錄整理

## 背景

這段討論發生在研究完 Symphony、Paperclip、LangWatch、gws 之後。從「Karvi 是什麼」推演到「AI 治理 AI」的可能性與價值。

---

## 討論 1：垂直與水平的新理解

**用戶提出：**

> 這是一個新的垂直水平理解。垂直領域應該是工作職業，例如律師或行銷。每一種職業會使用很多不同 pipeline 或 step。反而某些基礎工作兩者是類似的，可以用類似的 step 工作架構。
>
> 新的理解是 — 誰來把需求包裝起來？你要考慮到現在人人養龍蝦（人人用 Claude），或許沒這麼快速但也很強烈。這樣的話整個事情要重新評估。

**分析：**

```
垂直（職業）        水平（基礎動作）
─────────         ─────────────
律師               研究 → 草擬 → 審查 → 修改
行銷               研究 → 草擬 → 審查 → 修改
工程師             研究 → 草擬 → 審查 → 修改
                        |
                   骨架一樣，差別在：
                   - 輸入（判例 vs 受眾 vs codebase）
                   - 驗收（法律正確 vs 轉換率 vs test pass）
```

**包裝者是誰？**

| 包裝者 | 模式 | 問題 |
|--------|------|------|
| 平台包裝 | Harvey（律師 SaaS）、Jasper（行銷 SaaS） | 用戶被鎖在平台定義的 workflow 裡 |
| 用戶自己包裝 | 直接跟 Claude 說 | 複雜任務管不了、沒有追蹤和控制 |
| **AI 包裝** | AI 理解意圖 → 自己編排 pipeline | 需要可靠的執行基礎設施 |

答案是第三個：**AI 自己包裝。** 用戶說意圖，AI 理解意圖，AI 用工具組裝 pipeline，基礎設施保證執行。

---

## 討論 2：真實世界不是「做一次然後複製」

**用戶提出：**

> 不是做過一次，也不是單純可重複。現在更細微的服務體驗你要想一下。通常做過一次之後，只要稍微有條件變化，通常就誤判。可重複執行也是，通常會希望 AI 能夠在意圖理解的範圍內工作。用說說 A，但其實是 B。AI 要能兼具 AB 的能力，甚至組合出 C 的能力。運行也是，會有不同例外條件，或是不是正確答案的問題。

**分析：**

用戶說「幫我處理這個合約」：

```
看起來像 A（標準審查）
  但其實是 B（有特殊條款）
  過程中冒出 C（發現關聯問題）
  條件會變（對方改了條款）
  產出不是對錯（是取捨判斷）
```

這不是固定 pipeline 能處理的。需要：
- **意圖理解**：A 背後是 B
- **動態編排**：遇到例外就調整 step
- **適應性**：不是重試是重新理解
- **判斷力**：產出是建議 + 理由 + 替代方案

---

## 討論 3：讓 AI 編排執行引擎

**用戶提出：**

> 讓 AI 編排執行引擎的工具、做法、協議、基礎。用戶如果有一套 AI 很熟悉的工具，而且基礎已經有了，這樣就能調整 pipeline size。

**討論 CLI vs MCP：**

> 為何是 MCP server？現在大家都在避免 MCP 往 CLI。我覺得概念對，但是方法還要想。這跟 workflow.md 的方法有關嗎？

```
MCP: 要啟動 server → 維護連線 → 處理協議 → 每個 client 實作不同
CLI: 一行指令 → stdout → 完事
```

Symphony 用 CLI（`codex app-server`），Google Workspace 用 CLI（`gws`）。趨勢是 CLI 成為最通用的 agent tool protocol。

---

## 討論 4：Karvi 的層次 — Agent Execution Kernel

**用戶提出：**

> 然後再加上 Karvi 執行的相關能力。把概念想再想清楚。你還沒抓到 Karvi 的層次 — 後面運行程度、追蹤、控制運行。

**分析 — AI 能做 vs Karvi 能做：**

```
AI 能做的：
  ✅ 理解意圖
  ✅ 決定要哪些 step
  ✅ 組裝 pipeline
  ✅ 遇到例外重新調整

AI 做不到的：
  ❌ 同時跑 3 個 agent 並追蹤每一個
  ❌ agent 掛了自動重試
  ❌ 控制 token 燒到上限就停
  ❌ 保證隔離（不會互相踩檔案）
  ❌ 記錄每個 step 的 input/output/耗時/成本
  ❌ 跑到一半讓人類介入再繼續
```

**OS 類比：**

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

**四層架構：**

```
Layer 1: 編排（AI 負責）— 讀 workflow → 決定 steps → 下指令
Layer 2: 執行保證 — worktree 隔離、step 狀態機、retry、合約驗證
Layer 3: 運行控制 — kill、pause、resume、預算硬停、人類閘門
Layer 4: 可觀測 — SSE 進度、artifact 存檔、JSONL audit log、成本追蹤
```

**用戶追問：**

> 這是什麼樣的架構？怎麼用技術的方式講？我覺得很難描述，連帶理自己都很難意識到。

答案：**Agent Execution Kernel** — 像作業系統核心，但服務對象是 AI agent 而不是一般程式。

---

## 討論 5：AI 治理 AI — 村莊到國家

**用戶提出：**

> 所以照理說 AI 可以自行運行，之後有村莊、有國家都能用 AI 治理 AI，或互動交流。

**推演：**

```
一個 agent + Karvi kernel    = 一個能可靠執行任務的單元
多個 agent + Karvi kernel    = 一個能自治的工作群（村莊）
多個村莊 + 村莊間協議        = 一個能協作的網路（國家）
```

**每一層都是 Kernel 的用戶：**

```
Layer 0: Kernel（Karvi）
  提供：隔離、追蹤、控制、恢復
  不做判斷，只提供保證

Layer 1: 工作者 Agent
  用 kernel 執行任務，自己決定怎麼做

Layer 2: 村莊管理者（Village Chief）
  一個 AI 管理者 + 多個 AI 工作者
  管理者用 kernel 的 API 編排工作者
  管理者自己也跑在 kernel 上

Layer 3: 國家協調者（Nation Coordinator）
  多個村莊之間的協調
  更高層的 AI 協調者
  也跑在 kernel 上
```

**關鍵洞察：** Kernel 不需要知道上面跑的是「工人」還是「管理者」還是「協調者」。對 kernel 來說，都是 task + step + agent。治理邏輯在 agent 裡，不在 kernel 裡。

就像 OS 不知道跑的是 Word 還是另一個 OS（VM）。它只管 process。

**對應已有的規劃：**

| Issue | 對應 |
|-------|------|
| #148 feat(village): multi-village board registry | 每個 village 是一個 process group |
| #149 feat(territory): cross-village coordination | IPC（inter-process communication） |
| #150 feat(nation): strategic governance layer | Init system / systemd |

這些不是「新功能」，是 kernel 上面的 userspace 程式。

---

## 討論 6：AI 治理 AI 的真正價值

**用戶提出：**

> 你的 A B 方法很不錯。假設 AI 打造 AI、AI 治理 AI 可行的話，最大的價值在哪裡？首先一開始大家會看到 token 會暴增。另外會覺得沒有什麼技術進展，只是原本的 workflow 技術而已。而且最容易的事，發明了沒地方用或過度設計。相反的優點方面有可能是什麼？我覺得這裡很難看見未來的發展，因為人類的位置越來越少，就難預測。

**風險（用戶自己列的）：**

```
- Token 暴增（AI 治理 AI = AI 花錢指揮 AI 花錢）
- 技術上沒突破（就是 workflow + process management）
- 最怕：精心設計了一套系統，沒人用
```

**分析 — 優點可能是什麼：**

答案是 **信任**。

當 AI 做越來越多事，人類真正在意的不是「AI 怎麼做的」，是：

```
- 有沒有做對？
- 花了多少？
- 出事能不能停？
- 事後能不能查？
```

這四個問題，AI 自己回答不了。你問 Claude「你剛才花了多少 token」，它不知道。你問它「你確定做對了嗎」，它說確定但你不能驗證。

**Kernel 的價值不是讓 AI 更強，是讓人類能信任 AI 的工作。**

```
沒有 Kernel:
  用戶 → 叫 AI 做事 → AI 說做完了 → 用戶只能信或不信

有 Kernel:
  用戶 → 叫 AI 做事 → Kernel 記錄每一步 → 用戶能查、能停、能算帳
```

### 更深一層

Kernel 的用戶未來不是人，是另一個 AI。

```
現在：人 → 需要信任 AI → Kernel 提供可查可控
未來：AI → 需要信任另一個 AI → Kernel 提供執行保證
```

AI 委派工作給另一個 AI 時，它也需要知道：做完了沒、花了多少、有沒有出錯。這不是人類的需求，是任何「委派者」的需求 — 不管委派者是人還是 AI。

**所以真正的價值可能是：** 不是「給人用的 agent 管理工具」，是「任何委派者（人或 AI）都需要的執行保證協議」。就像 HTTPS — 不管你是人在瀏覽網頁還是程式在呼叫 API，你都需要傳輸保證。**Kernel 是執行層的 HTTPS。**

### 三種未來情境

| 情境 | 說明 | Kernel 的角色 |
|------|------|--------------|
| 樂觀 | AI agent 成為主流工作方式 | 誰都需要 kernel，Karvi 成為標準 |
| 中性 | AI 夠強不需要分步驟 | 一個 prompt 搞定一切，kernel 沒用 |
| 悲觀 | 大廠自己做 kernel | 開源專案沒機會 |

中性情境最值得想。但目前看起來，**越複雜的任務越需要分段** — 因為一次做完容易跑偏，分段能在中途修正。這個需求短期不會消失。

### 未知變數

Token 成本會不會降到趨近於零。如果 token 幾乎免費，「AI 治理 AI」的成本問題就消失了。但如果 token 保持有價，成本控制就是剛需。這個變數不在我們手上。

---

## 核心結論

1. **Karvi 是 Agent Execution Kernel** — OS 類比最精確
2. **AI 是編排者，Karvi 是後勤** — AI 管「做什麼」，Kernel 管「怎麼可靠地做」
3. **村莊/國家是 userspace 程式** — 治理邏輯不在 kernel 裡
4. **Kernel 的價值是信任** — 讓委派者（人或 AI）能查、能停、能算帳
5. **Kernel = 執行層的 HTTPS** — 任何委派關係都需要的保證協議
6. **先穩 kernel，再長上層** — cancel(#274)、kill(#214)、成本追蹤是 P0
