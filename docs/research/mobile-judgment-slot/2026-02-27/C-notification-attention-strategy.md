# C 軍團報告：手機端「高槓桿判斷喚醒」通知策略（v0）

> 目標：讓手機通知只在「需要人類判斷且影響大」時出現，而不是把 Task Board 複製到手機。
> 範圍：可直接落地在 task-engine 現有 `signals / insights` 結構。

---

## 設計原則（先立邊界）

1. **通知不是資訊同步，而是判斷插槽（judgment slot）**。
2. **沒有要求你做決策的訊息，不推播**（只留在 board）。
3. **同一問題只喚醒一次**，後續以合併/升級處理。
4. **10 秒可判斷**：推播內容必須能在鎖屏完成「要不要介入」判斷。
5. **低可逆 + 低外溢 + 高信心**優先機器自動化，不打擾人。

### 反模式（明確避免）

- 把每次 `status_change` 都推到手機。
- 同一 task 反覆 blocked 反覆震動。
- 只有「發生了什麼」沒有「你要決定什麼」。
- 推播文字過長，必須點進去看才知道是否重要。

---

## 一、通知分類（什麼該推，什麼不該推）

> 核心：只推播 A 類（高槓桿判斷），B 類做合併摘要，C 類不推播。

### A 類（立即喚醒，P1）

#### A1. 分歧判斷（Divergence）
**定義**：同一 `signal/about` 出現互斥建議，且系統無法自動決定。
- 例：兩個 insight 對同一問題給出相反行動（`dispatch_hint` A vs B）。
- 寫入建議：
  - `signals.type = "insight_divergence"`
  - `insights.by = "notify-evaluator"`，`judgement = "需要 human 在互斥方案間決策"`

#### A2. 不可逆決策（Irreversible）
**定義**：一旦執行，短期難回復或回復成本高。
- 例：
  - 將 task 推到 `approved`（下游解鎖、路徑改變）
  - `controls_patch` 涉及關鍵控制（如關閉 `auto_review`、大幅降低 `quality_threshold`）
- 寫入建議：
  - `signals.type = "irreversible_decision_needed"`
  - `data.irreversible = true`

#### A3. 高風險阻塞（High-risk Blocker）
**定義**：阻塞同時具備「時效壓力 + 影響面擴散」。
- 例：
  - task `blocked` 超過 SLA，且下游依賴 >= 2
  - 同一 task 連續 dispatch/re-dispatch error
- 寫入建議：
  - `signals.type = "high_risk_blocker"`
  - `data.blockedMinutes`、`data.downstreamBlocked`

### B 類（合併後推播，P2）

#### B1. 趨勢退化但未臨界
- 例：`review_result` 平均分數下滑，但尚未造成大量阻塞。
- 處理：10~30 分鐘摘要推播一次（含趨勢箭頭與建議）。

#### B2. 重複低中風險異常
- 例：同類錯誤在多 task 出現，但單一事件不需要即時決策。
- 處理：批次摘要，不即時震動。

### C 類（不推播，僅寫板）

- 一般 `status_change`（pending/in_progress/completed）
- 可自動修復且已處理的低風險事件
- 純資訊更新（沒有決策需求）

---

## 二、節流策略（去重、合併、冷卻）

## 2.1 去重鍵（Dedup Key）

```text
notifyKey = {category}:{primaryRef}:{decisionType}:{rootCauseHash}
```

建議對應：
- `category`：divergence / irreversible / blocker
- `primaryRef`：taskId 或 insightId（取 `refs[0]`）
- `decisionType`：approve/rework/assignee_switch/controls_patch
- `rootCauseHash`：標準化錯誤原因摘要

> 同 `notifyKey` 在 dedup 視窗內只保留一筆，其他累計到 `data.repeatCount`。

## 2.2 合併策略（Merge）

- **時間窗合併**：3 分鐘內、同 category + 同主體，合併成一則。
- **內容合併**：只保留「最新狀態 + 變化量（delta）」。
- **跨 task 合併**：相同 root cause 可做「群組摘要」（最多列 3 個 task，其餘顯示 +N）。

## 2.3 冷卻時間（Cooldown）

- P1（A 類）同 key 冷卻：**20 分鐘**
- P2（B 類）同 key 冷卻：**60 分鐘**
- 全域上限：**每 24 小時最多 8 則主動喚醒**（超過改為摘要）

## 2.4 升級規則（避免沉默失敗）

即使在冷卻中，符合以下任一條件可「突破冷卻再通知」：
1. `blast_radius` 上升一級以上
2. 事件從可逆變不可逆
3. 截止時間進入 30 分鐘內

## 2.5 一次只佔用一個判斷槽（Judgment Slot Lock）

- 同一時間只允許 1 則「待決策」通知處於開啟狀態。
- 新事件先排隊；若新事件優先級更高，取代舊槽並在舊事件寫 `signals.type="notify_superseded"`。

---

## 三、訊息模板（10 秒內可判斷）

## 3.1 最小必備欄位（鎖屏版）

1. **你要決定什麼**（一行問題句）
2. **事件類型**（分歧 / 不可逆 / 阻塞）
3. **風險三指標**：`U/C/B`（urgency/confidence/blast radius）
4. **影響面**：受影響 task 數 / track 數
5. **截止時間**（或剩餘時間）
6. **建議預設動作**（若不回覆）
7. **快速操作**（最多 3 個按鈕）

## 3.2 推播文案模板

### 模板 A：分歧判斷
```text
[需決策] T12 指派策略分歧
A: engineer_pro（品質較高）
B: engineer_lite（速度較快）
U2/C0.58/B2｜影響 3 下游｜15 分內決定
```

### 模板 B：不可逆決策
```text
[不可逆] 是否批准 T7 並解鎖 4 下游？
目前 review: 71/70（邊際通過）
U3/C0.62/B3｜逾時將延後整體 phase
```

### 模板 C：高風險阻塞
```text
[高風險阻塞] T9 blocked 52 分鐘
原因：spec 衝突，已重派 2 次失敗
U3/C0.74/B2｜影響 2 tasks｜建議：人工拆解
```

## 3.3 對應資料欄位（可直接放進 signal/insight.data）

```json
{
  "mobile": {
    "notifyKey": "blocker:T9:manual_unblock:spec_conflict",
    "decision": "是否人工拆解 T9？",
    "options": ["拆解", "再重派", "延後"],
    "defaultAction": "再重派",
    "urgency": 3,
    "confidence": 0.74,
    "blastRadius": 2,
    "irreversible": false,
    "deadlineTs": "2026-02-27T04:00:00+08:00",
    "impact": { "tasks": 2, "tracks": 1 }
  }
}
```

---

## 四、優先級定義（urgency / confidence / blast radius）

## 4.1 三軸量尺（v0）

### Urgency（U: 0~3）
- 0：>24h 不影響關鍵路徑
- 1：4~24h 內需處理
- 2：30m~4h 內需決策
- 3：<30m 或正在擴大損害

### Confidence（C: 0~1）
- 0.0~0.4：低（證據不足、分歧大）
- 0.4~0.7：中低
- 0.7~0.85：中高
- 0.85~1.0：高（可傾向自動化）

### Blast Radius（B: 0~3）
- 0：單 task、無依賴
- 1：單 track、<=2 下游
- 2：多 task（3~5）或跨角色
- 3：整個 phase / 關鍵控制層（controls）

## 4.2 喚醒分數（Wake Score）

```text
wakeScore = 0.50*(U/3) + 0.35*(B/3) + 0.15*(1-C) + irreversibleBonus
irreversibleBonus = 0.20（若不可逆，否則 0）
```

### 分級
- `>= 0.80`：**P1 即時喚醒**（震動/聲音）
- `0.60 ~ 0.79`：**P1 即時靜默**（不連續震動）
- `0.45 ~ 0.59`：**P2 合併推播**（10 分鐘窗）
- `< 0.45`：不推播，只寫板

> 核心取捨：**confidence 越低越偏向叫人**，因為那代表機器不確定；但若 U/B 都低，仍不打擾。

---

## 五、v0 規則表（可直接映射到 signals/insights）

| 規則ID | 觸發來源 | 條件 | 動作 | 節流/冷卻 | 寫回 |
|---|---|---|---|---|---|
| N01 | `insights` | 同 `about` 出現互斥建議 | 產生 A1 推播候選 | dedup 15m | `signal: insight_divergence` |
| N02 | `status_change` | `to=blocked` 且 `blockedMinutes>=30` 且 `downstream>=2` | A3 即時喚醒 | key 20m | `signal: high_risk_blocker` |
| N03 | `error` | 同 task 15m 內 dispatch/redispatch error >=2 | A3 即時喚醒 | key 20m | `signal: high_risk_blocker` |
| N04 | `insight` (`controls_patch`) | 修改關鍵 controls（auto_review/threshold 大幅變更） | A2 即時喚醒 | key 20m | `signal: irreversible_decision_needed` |
| N05 | `status_change` | `to=approved` 且下游解鎖數>=3 且 review 邊際通過 | A2 即時喚醒 | key 20m | `signal: irreversible_decision_needed` |
| N06 | `review_result` | 最近 5 筆平均下降 >=8 分但未觸發 N02~N05 | B1 摘要推播 | 60m | `signal: quality_drift_digest` |
| N07 | 任意候選 | 與既有 `notifyKey` 相同 | 不新推播，僅累加 | dedup 15m | `signal: notify_suppressed` |
| N08 | 任意候選 | 在 cooldown 內但 `U/B` 上升或變不可逆 | 允許突破冷卻重推 | override | `signal: notify_escalated` |
| N09 | 任意候選 | 24h 已達 8 則喚醒 | 降級為摘要 | global cap | `signal: notify_rate_limited` |
| N10 | 已推播事件 | 已有更新且可在 10 秒內補充判斷 | 發送「更新版」而非新事件 | 同 key 更新 | `signal: notify_updated` |

---

## 落地建議（task-engine v0 實作路線）

1. **新增一個輕量 evaluator（可類 retro.js）**：讀 `/api/signals + /api/insights`，輸出通知決策。  
2. **決策結果先寫回 signals**（如 `notify_suppressed / notify_escalated / ...`），保留可稽核性。  
3. **只有需要人類判斷的事件才推到手機**；其餘維持 board 可見，不進通知通道。  

### 建議的 insight 寫法（符合現有 API）

```json
{
  "by": "notify-evaluator",
  "about": "sig-xxx",
  "judgement": "需要 human 決策：T9 是否人工拆解",
  "reasoning": "U3/B2/C0.74，阻塞 52 分鐘，影響 2 下游",
  "suggestedAction": { "type": "noop", "payload": {} },
  "risk": "medium",
  "data": {
    "patternType": "mobile_judgment_slot",
    "notify": {
      "priority": "P1",
      "notifyKey": "blocker:T9:manual_unblock:spec_conflict"
    }
  }
}
```

---

## 結論

這套策略的重點不是「更即時」，而是「更節制地叫醒人」：只在分歧、不可逆、或高風險阻塞時佔用注意力。  
透過 dedup/merge/cooldown + judgment slot lock，可把通知量控制在低頻，但保留高價值介入點。  
在 task-engine 現有 `signals / insights` API 下即可落地，不需先改核心狀態機。