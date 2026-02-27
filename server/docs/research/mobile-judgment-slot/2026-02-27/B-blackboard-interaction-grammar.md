# B 軍團報告：手機端黑板互動語法（Judgment Slot）

> 主題：讓人類在手機上注入判斷，影響代理群體，而不是做工單式 approve/reject。
> 
> 對齊既有黑板演化：`signals / insights / lessons`，此處語彙升級為 `signal / interpretation / commitment / rule`。

---

## 一、本質定義

### 1.1 Judgment Slot 的核心

手機端不是「審批站」，而是「判斷注入口」：

- **Signal**：發生了什麼（事實）
- **Interpretation**：我怎麼看（解讀）
- **Commitment**：先照這個判斷運作（生效承諾）
- **Rule**：被驗證後沉澱成長期記憶（規則）

> 最小閉環：`signal → interpretation → commitment → (effect) → rule`

### 1.2 與舊語言切割（反 SaaS）

避免語言：`approve / reject / ticket closed`

改用判斷語言：

- **看見**：記錄訊號
- **解讀**：提出觀點
- **採行**：讓觀點在某範圍生效
- **擴散**：把判斷分發到代理群體
- **沉澱**：把有效判斷固化為規則
- **保留分歧**：不強迫收斂成單一答案

### 1.3 最小資料單元（v0）

```json
{
  "board": {
    "signals": [],
    "interpretations": [],
    "commitments": [],
    "rules": []
  }
}
```

> 與現行相容：`interpretations ~= insights`、`rules ~= lessons`。

---

## 二、互動語法（可實作）

## 2.1 手機端最小語法（句型）

統一句型：

`[動詞] [對象] [作用範圍] [可選：理由/信心/風險]`

範例：

- 「**記錄**：review fallback 率 70%」
- 「**解讀**：parser 不穩定，先改 prompt」
- 「**採行（本輪）**：server 任務先配 engineer_pro」
- 「**擴散到**：所有 server 類 task」
- 「**沉澱為規則**：server 類預設 engineer_pro」

### 2.2 動作表（UI 語句 → 黑板事件）

| 層級 | UI 動作語句（給人看的） | 寫入事件 type | 必填欄位 | 結果 |
|---|---|---|---|---|
| Signal | 記錄這個訊號 | `signal.recorded` | `content`, `refs?`, `data?` | 新增事實，待解讀 |
| Interpretation | 我的解讀是… | `interpretation.proposed` | `aboutSignal`, `judgement`, `reasoning?`, `confidence?`, `risk?` | 形成可競爭觀點 |
| Divergence | 保留分歧 | `interpretation.divergence_marked` | `signalId`, `interpretationIds[]` | 並列觀點，不強制合併 |
| Commitment | 先照這個判斷做（一次/本輪/常態） | `commitment.activated` | `interpretationId`, `scope`, `targets` | 判斷開始生效 |
| Diffusion | 擴散到…（代理/任務類型/整輪） | `commitment.diffused` | `commitmentId`, `targets[]` | 多代理共享同一判斷 |
| Rule | 沉澱為規則 | `rule.created` | `fromCommitment`, `rule`, `appliesTo`, `ttl?` | 長期記憶建立 |
| Rollback | 先撤回這條生效判斷 | `commitment.revoked` | `commitmentId`, `reason?` | 立即停止擴散 |
| Evolution | 這條規則降級/廢止 | `rule.updated` | `ruleId`, `status`, `reason` | 記憶可修正 |

### 2.3 作用範圍（一次性 / 本輪 / 永久）

`scope` 最小模型：

```json
{
  "mode": "once | round | permanent",
  "roundId": "optional, for round",
  "consumeLimit": 1,
  "expiresAt": "optional timestamp"
}
```

語義定義：

- **once（一次性）**：只影響下一個命中的決策，消耗即失效（`consumeLimit=1`）
- **round（本輪）**：綁定目前回合/phase，回合結束自動失效（`roundId`）
- **permanent（永久）**：持續有效，直到人工撤銷或被新規則取代

### 2.4 「分歧可見 / 判斷可擴散 / 記憶可沉澱」映射到 UI 動作語句

| 目標能力 | UI 動作語句 | 寫入欄位/事件 | 系統行為 |
|---|---|---|---|
| 分歧可見 | 「並列這兩個解讀」 | `interpretation.divergence_marked` + `divergenceGroupId` | 同一 signal 下顯示多觀點，不覆蓋 |
| 判斷可擴散 | 「把這個判斷套用到 X」 | `commitment.diffused.targets[]` | 指定 agent/任務型別/track 同步採用 |
| 記憶可沉澱 | 「把它沉澱成規則」 | `rule.created`（含 `fromCommitment`） | 後續預設行為被改寫 |

### 2.5 避免 approve/reject 的文案規範

- 不說「批准提案」→ 說「**採行此判斷**」
- 不說「駁回提案」→ 說「**暫不採行，保留分歧**」
- 不說「關閉工單」→ 說「**結束本次承諾**」
- 不說「永久通過」→ 說「**沉澱為規則**」

---

## 三、狀態流（State Flow）

## 3.1 主狀態機

```text
signal.recorded
  ↓
interpretation.proposed (可多個並行)
  ├─> interpretation.divergence_marked（可選）
  ↓
commitment.activated(scope=once|round|permanent)
  ├─> commitment.diffused（可選）
  ├─> commitment.revoked（可選）
  ↓
effect.observed
  ├─> rule.created（有效時）
  └─> interpretation.proposed（失效時產生新解讀）
```

### 3.2 轉移條件表

| from | trigger | to | guard |
|---|---|---|---|
| `signal.recorded` | 新增解讀 | `interpretation.proposed` | 任一參與者可寫 |
| `interpretation.proposed` | 人類注入判斷 | `commitment.activated` | 必須選 scope + targets |
| `commitment.activated` | 選擇擴散 | `commitment.diffused` | `targets` 非空 |
| `commitment.activated` | 觀察到正向效果 | `rule.created` | 有 baseline/effect 證據 |
| `commitment.activated` | 發現副作用 | `commitment.revoked` | 可附 reason |
| `rule.created` | 新證據推翻 | `rule.updated(status=invalidated)` | 必須有 signal/ref |

### 3.3 手機端互動節奏（15 秒注入）

1. 看卡片（signal + 多 interpretation）
2. 點選一個解讀 + 選 `一次/本輪/常態`
3. 勾選擴散目標（預設建議）
4. 送出 `commitment.activated`

> 關鍵：人類輸入的是「判斷方向」，不是逐工單同意書。

---

## 四、v0 API 映射（與現有 task-engine 對齊）

## 4.1 資源與端點（建議）

| Method | Path | 說明 |
|---|---|---|
| `POST` | `/api/signals` | 記錄 signal |
| `POST` | `/api/interpretations` | 建立 interpretation（insight） |
| `POST` | `/api/interpretations/:id/diverge` | 建立分歧群組（可見化） |
| `POST` | `/api/commitments` | 啟用判斷（含 scope + targets） |
| `POST` | `/api/commitments/:id/diffuse` | 擴散到更多目標 |
| `POST` | `/api/commitments/:id/revoke` | 撤回承諾 |
| `POST` | `/api/rules` | 由 commitment 沉澱為 rule |
| `POST` | `/api/rules/:id/status` | `active/validated/invalidated/superseded` |

### 4.2 v0 請求資料結構（最小可跑）

#### A) 建立 interpretation

```json
{
  "aboutSignal": "sig-20260227-001",
  "judgement": "review fallback 率偏高主因是 prompt 格式鬆散",
  "reasoning": "最近 20 次中 fallback 14 次",
  "confidence": "medium",
  "risk": "low",
  "suggestedAction": {
    "type": "review_prompt_patch",
    "payload": { "strictFormat": true }
  }
}
```

#### B) 啟用 commitment（重點：scope）

```json
{
  "interpretationId": "int-20260227-003",
  "scope": {
    "mode": "round",
    "roundId": "phase-2026w09"
  },
  "targets": [
    { "kind": "taskType", "value": "server" },
    { "kind": "agent", "value": "engineer_pro" }
  ],
  "note": "本輪 server 類先用 pro"
}
```

#### C) 沉澱 rule

```json
{
  "fromCommitment": "com-20260227-009",
  "rule": "server 類任務預設 assignee 為 engineer_pro",
  "appliesTo": [
    { "kind": "taskType", "value": "server" }
  ],
  "status": "active",
  "evidence": {
    "baseline": { "avgScore": 42 },
    "after": { "avgScore": 78 }
  }
}
```

### 4.3 與現有欄位的相容映射

| 新語彙 | 現有黑板欄位 | 備註 |
|---|---|---|
| `interpretation` | `insights` | 先 alias，避免一次性 migration |
| `rule` | `lessons` | status 可沿用 active/validated/... |
| `commitment` | （新增）`commitments` | v0 真正缺的中間層 |

---

## 附：v0 設計準則（實作時要守）

1. **先允許分歧，再要求收斂**：UI 必須能並列觀點，不可只保留最後一條。  
2. **scope 是一等公民**：每次「採行」都必選 once/round/permanent。  
3. **擴散顯式化**：判斷是否擴散、擴散到哪裡，要有可追蹤事件。  
4. **沉澱要有證據**：rule.created 需要 baseline/after，避免憑感覺固化。  
5. **語言是行為設計**：禁用 approve/reject 文案，避免把人類降格成工單閘門。  
