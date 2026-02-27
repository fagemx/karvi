# Blackboard Evolution（黑板式進化）

> 狀態：核心設計哲學
> 日期：2026-02-25
> 這份文件取代 evolution-loop.md 中的管線式設計

---

## 為什麼不用管線

前一版設計（evolution-loop.md）提出了 `Observe → Analyze → Propose → Gate → Mutate → Evaluate` 管線。

**問題**：管線式進化有致命矛盾 — 進化的對象是管線本身，但管線不能改自己。要改管線就需要 meta-管線，然後 meta-meta-管線...無限遞迴。

更根本的問題：**硬性步驟消滅彈性**。如果進化必須走固定步驟，那進化本身就不能進化。步驟會變成天花板。

黑板哲學的核心差異：

```
管線：  資料流過固定步驟（A → B → C → D）
黑板：  資料在板上，誰能貢獻誰就來（沒有固定順序）
```

如果進化要有彈性，它本身就應該是黑板，不是管線。

---

## 自我進化的本質

自我進化不是「加一個進化模組」。是讓整個系統的運作方式本身就具有進化性。

就像生物進化不是一個器官。不存在「進化器」。進化是因為整個系統的結構允許：

- **變異**：有人（agent 或 human）往黑板寫了新想法/觀察/建議
- **選擇**：有人評估它（低風險自動生效、高風險等人）
- **留存**：有效的改變被保留（寫入 skill、controls、規則）
- **淘汰**：無效的改變被標記、回滾

不需要管線驅動。只需要黑板上有對的區域，讓這些事情自然發生。

---

## 最小結構：三個區域

board.json 加三個欄位：

```json
{
  "meta": { ... },
  "taskPlan": { ... },
  "controls": { ... },

  "signals": [],
  "insights": [],
  "lessons": []
}
```

**任何參與者**（server.js、process-review.js、retro.js、Nox、Human、heartbeat、cron）都可以往這三個欄位寫東西。

### signals — 「發生了什麼」

客觀事實，不含判斷。

```json
{
  "id": "sig-20260225-001",
  "ts": "2026-02-25T10:00:00Z",
  "by": "process-review.js",
  "type": "review_pattern",
  "content": "engineer_lite 在 server 類任務連續 3 次 score < 50",
  "refs": ["T1", "T2", "T5"],
  "data": { "agent": "engineer_lite", "taskType": "server", "scores": [42, 38, 45] }
}
```

```json
{
  "id": "sig-20260225-002",
  "ts": "2026-02-25T10:05:00Z",
  "by": "human",
  "type": "request",
  "content": "做一個 dashboard"
}
```

```json
{
  "id": "sig-20260225-003",
  "ts": "2026-02-25T10:10:00Z",
  "by": "server.js",
  "type": "import",
  "content": "gctx planA 導入：8 tracks, 18 tasks, 4 層依賴",
  "refs": ["C:/ai_agent/gctx/docs/planA/"]
}
```

信號來源：
- `process-review.js`：審查結果、失敗模式
- `server.js`：狀態變化、超時、錯誤
- `Human`：需求、觀察、直覺
- `heartbeat`：環境掃描（email、calendar、code drift）
- `smoke-test.js`：健康檢查結果
- `retro.js`：統計數據

### insights — 「我覺得怎樣」

主觀判斷 + 建議行動。任何人都可以對任何 signal 寫 insight。

```json
{
  "id": "ins-20260225-001",
  "ts": "2026-02-25T10:02:00Z",
  "by": "retro.js",
  "about": "sig-20260225-001",
  "judgement": "engineer_lite 不適合 server 類任務",
  "reasoning": "3 次 avg score 42，低於 threshold 70，且 engineer_pro 在同類任務 avg 78",
  "suggestedAction": {
    "type": "controls_patch",
    "payload": { "assignee_hint": { "server": "engineer_pro" } }
  },
  "risk": "low",
  "confidence": "high"
}
```

```json
{
  "id": "ins-20260225-002",
  "ts": "2026-02-25T10:06:00Z",
  "by": "nox",
  "about": "sig-20260225-002",
  "judgement": "這是一個中型 feature，不是小任務",
  "reasoning": "需要 UI 區塊 + API endpoint + 數據彙整，至少 3 個 tasks",
  "suggestedAction": {
    "type": "scoping",
    "payload": { "questions": ["只顯示 metrics 還是含 proposals？", "加在現有 sidebar 還是新 tab？"] }
  },
  "risk": "medium"
}
```

```json
{
  "id": "ins-20260225-003",
  "ts": "2026-02-25T10:06:30Z",
  "by": "nier",
  "about": "sig-20260225-002",
  "judgement": "可以在現有 index.html 加一個 section 完成",
  "reasoning": "只要加 20 行 HTML/JS，不需要新 API",
  "suggestedAction": {
    "type": "direct_do",
    "payload": {}
  },
  "risk": "low"
}
```

**注意**：同一個 signal 可以有多個 insight（不同 agent 有不同看法）。沒有「正確答案」。由 Human 或 gate 決定採哪一個。

### lessons — 「我們學到了什麼」

從 effect 結晶出來的規則。是系統的「長期記憶」。

```json
{
  "id": "les-20260225-001",
  "ts": "2026-02-25T12:00:00Z",
  "by": "retro.js",
  "fromInsight": "ins-20260225-001",
  "applied": true,
  "effect": "avg score 42 → 78 (改用 engineer_pro 後)",
  "rule": "server 類任務用 engineer_pro",
  "status": "validated",
  "validatedAt": "2026-02-26T10:00:00Z"
}
```

```json
{
  "id": "les-20260225-002",
  "ts": "2026-02-25T15:00:00Z",
  "by": "human",
  "fromInsight": null,
  "applied": true,
  "effect": "一句話看起來像小任務但花了 3 小時",
  "rule": "涉及多個檔案的 config 改動，應判斷為中型任務",
  "status": "active"
}
```

Lesson 的生命週期：
- `active`：正在使用
- `validated`：被後續數據驗證有效
- `invalidated`：被後續數據推翻
- `superseded`：被更新的 lesson 取代

---

## 沒有固定順序

這是跟管線的根本區別。以下都是合法的路徑：

```
路徑 A（完整流程）：
  signal → insight → decision → action → effect → lesson

路徑 B（直覺修正）：
  signal → lesson（很明顯的，不需要分析）

路徑 C（討論後放棄）：
  signal → insight A + insight B → decision: 不行動

路徑 D（Human 直接寫 lesson）：
  lesson（基於經驗，不需要 signal）

路徑 E（回滾）：
  lesson → signal（發現 lesson 無效）→ 新 insight → 推翻舊 lesson

路徑 F（級聯）：
  signal → insight → action → 新 signal → 新 insight → ...
```

**沒有一條路徑是「標準流程」。** 哪條路徑最合適，取決於當時黑板上的情況。

---

## 顆粒度是判斷，不是分類

### 問題

不同的輸入有不同的顆粒度：

| 輸入 | 看起來的大小 | 實際的大小 |
|------|------------|-----------|
| 「改一下 threshold」 | 微 | 微 |
| 「做一個 dashboard」 | 小？ | 可能是中型 feature |
| gctx planA | 大 | 大（但已有完整 spec） |
| 「交易策略優化」 | 不確定 | 長期，metric-based |
| 「加一個 dashboard」 | 小？ | 取決於問 3 個問題後的答案 |

### 解法：顆粒度判斷是 insight

在黑板模式下，顆粒度不是一個「配置」或「分類系統」。它是一個 insight。

```
request 寫入 signals：「做一個 dashboard」

agent A 寫 insight：
  「這是中型 feature，需要 scoping，至少 3 個 tasks」

agent B 寫 insight：
  「可以直接在現有 UI 加 20 行完成」

Human 看兩個 insight，做 decision。
```

不需要預先定義「微/小/中/大/專案」五種類型和對應流程。讓判斷浮現。

### 判斷本身也可以進化

```
lesson：
  「外表像小事的 config 改動，如果涉及多個檔案，應判斷為中型任務」
  來源：上次判斷錯誤的經驗
```

下次任何 agent 做顆粒度判斷時，會讀到這條 lesson，改變自己的判斷。

---

## 什麼時候用什麼規模的回應

也是 insight，不是 config：

| 情況 | insight 建議 | 為什麼 |
|------|-------------|--------|
| 改 config 值 | 直接做，不用 task engine | 5 秒鐘的事 |
| 一個函數修正 | 開一個 task，直接派 | 有明確 scope |
| 一個新功能 | 先 scoping（問 3 個問題）→ 寫 mini-spec → 拆 tasks | 需要釐清範圍 |
| 多 agent 觀點 | 開 agent-room 討論 → 再決定 | 涉及架構決策 |
| 大型專案 | 導入 spec → 拆 tracks → 拆 tasks → batch 派發 | 有完整規格，需要 DAG 管理 |
| 指標類任務 | 定 metric → 做 → 觀察期 → 比較 before/after | 成果不是檔案 |

**這個表格本身也是 lessons 的集合。** 隨著經驗累積，表格會進化。

---

## 感知方式也是黑板上的判斷

不需要預設「什麼時候該感知什麼」。

```
signal: 「最近 7 天沒有跑過 smoke-test」
  → insight: 「應該定期跑 smoke-test」
  → lesson: 「smoke-test 每 3 天跑一次」

signal: 「review 連續失敗 5 次」
  → insight: 「review prompt 可能有問題」
  → 不需要等 retro，process-review.js 自己就能寫這個 signal

signal: 「Human 2 天沒看 board 了」
  → insight: 「可能需要主動通知重要事項」
  → lesson: 「重要 signal 超過 4 小時未讀，走 heartbeat 通知」
```

**感知方式本身是可進化的。** 新的 lesson 可以改變未來感知的頻率和方式。

---

## 跟現有系統的整合

### 不需要大改

現有的 task-engine 已經有：
- `board.json` ← 加 3 個欄位
- `server.js` ← 加讀寫 signals/insights/lessons 的 API
- `process-review.js` ← 可以寫 signal（審查結果模式）
- `index.html` ← 加一個 signals/insights/lessons 的顯示面板

### 誰寫什麼

| 參與者 | 寫 signals | 寫 insights | 寫 lessons |
|--------|-----------|-------------|-----------|
| `server.js` | ✅ 狀態變化、錯誤、超時 | ❌ | ❌ |
| `process-review.js` | ✅ 審查結果、失敗模式 | ❌ | ❌ |
| `retro.js` | ✅ 統計數據 | ✅ 模式分析 | ✅ 從 effect 結晶 |
| Nox (Lead) | ✅ 觀察 | ✅ 判斷 + 建議 | ✅ 經驗 |
| Human | ✅ 需求、直覺 | ✅ 決策 | ✅ 方向 |
| heartbeat | ✅ 環境掃描 | ❌ | ❌ |
| 其他 agent | ✅ 回報 | ✅ 觀點 | ❌ |

### Server API（新增）

```
GET  /api/signals              → 列出所有 signals
POST /api/signals              → 寫入新 signal
GET  /api/insights             → 列出所有 insights
POST /api/insights             → 寫入新 insight
GET  /api/lessons              → 列出所有 lessons
POST /api/lessons              → 寫入新 lesson
POST /api/insights/:id/apply   → 執行 insight 的 suggestedAction
POST /api/lessons/:id/status   → 更新 lesson 狀態
```

### Gate 邏輯

insight 的 `suggestedAction` 執行策略：

```
if insight.risk === 'low' && controls.auto_apply_insights === true:
  自動執行
  
if insight.risk === 'medium':
  通知 Human，等確認
  
if insight.risk === 'high':
  只記錄，不執行
```

安全閥：
- 同類型 insight 24 小時內最多自動執行 1 次
- 連續 3 次自動執行後強制等 Human
- 自動執行後必須產生 signal 記錄效果

---

## 跟管線式設計的共存

evolution-loop.md 的 `Observe → Analyze → Propose → Gate → Mutate → Evaluate` 不需要廢棄。

它可以是 **retro.js 的內部邏輯**（一種特定的「agent 行為模式」），但不是系統層級的強制流程。

```
retro.js 的行為：
  1. 讀 signals（observe）
  2. 計算 metrics（analyze）
  3. 寫 insights（propose）
  4. 如果有已 applied 的 insight，追蹤效果（evaluate）
  5. 效果好 → 寫 lesson
```

這是 retro.js 自己的做事方式。其他 agent 不一定要走同樣的路。Nox 可能直覺寫 lesson。Human 可能直接改 controls。

**管線是可選的行為模式，不是系統架構。**

---

## 市場參照

| 框架 | 架構 | 進化能力 |
|------|------|---------|
| AutoGPT | goal → plan → execute loop | 無。每次重新開始 |
| CrewAI | agents + tasks + process（管線） | 無。角色和流程固定 |
| LangGraph | state machine + edges | 低。graph 結構是靜態的 |
| MetaGPT | shared memory + SOP | 低。SOP 是固定的 |
| Devin / Cursor agent | 單 agent + tool use | 無。沒有多 agent，沒有記憶累積 |
| ADAS（學術） | meta-agent 設計 agent | 概念有，無實用實作 |
| **黑板式進化** | 共享板 + signal/insight/lesson | **高。資料即架構，改資料即改行為** |

大多數框架的思路：**更強的 agent → 更好的結果**。
我們的思路：**更好的知識累積 → 長期越來越好**。

差異：他們依賴模型能力的天花板。我們依賴知識累積的速度。

---

## 核心原則

1. **不是系統在進化。是黑板上的內容在進化。系統只是讀黑板的人。**

2. **進化不是步驟。進化是結構的性質。** 如果結構允許變異、選擇、留存、淘汰，進化就會自然發生。

3. **輕便才有彈性。** 三個 JSON 陣列（signals, insights, lessons）比任何框架都輕。但足以承載整個進化機制。

4. **判斷比分類重要。** 不預設「五種任務類型」。讓 agent 寫 insight 判斷，讓判斷本身也可進化。

5. **管線是行為模式，不是系統架構。** agent 可以選擇走管線（retro.js），也可以不走（直覺修正）。

6. **不可變物存在。** 黑板本身的結構、Human 介入點、安全閥 — 這些是制度，不可被進化覆蓋。系統可以改策略（怎麼做），不能改制度（規則本身）。
