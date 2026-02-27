# Strategic Layer（戰略層）

> 狀態：~5% 完成（概念階段）
> 迴路週期：週/月
> 自治度：低 — Human 主導

---

## 職責

決定「做什麼」和「往哪走」。這是 Human 的領域，agent 是顧問。

---

## 現狀

目前戰略層完全靠 Tamp 和 Nox 的主對話（main session）：

```
Tamp: 「我想做 X」
Nox:  「好，我來寫 spec」
Tamp: 「改一下 Y」
Nox:  「OK，task plan 已更新」
Tamp: 「開始派」
```

**問題**：
1. Nox 沒有結構化的「系統現況」輸入，只靠 Tamp 口述
2. 沒有數據支撐決策（哪個 agent 表現好？哪類任務常失敗？）
3. 沒有回顧機制（上次的決定對不對？）
4. 方向性決策散落在對話裡，沒有留存

---

## 目標狀態

```
                     ┌─────────────────────┐
                     │  Operational Layer   │
                     │  retro.js 分析結果    │
                     └──────────┬──────────┘
                                │
                     metrics + proposals + insights
                                │
                     ┌──────────▼──────────┐
                     │   Strategic Layer    │
                     │                     │
                     │   Tamp 看到：       │
                     │   - 系統 dashboard   │
                     │   - pending proposals│
                     │   - 趨勢報告        │
                     │                     │
                     │   Tamp 決定：       │
                     │   - approve/reject  │
                     │   - 新方向          │
                     │   - 優先級調整       │
                     │                     │
                     │   Nox 執行：        │
                     │   - 寫 spec         │
                     │   - 拆 taskPlan     │
                     │   - 派發            │
                     └─────────────────────┘
```

---

## Human 介面

### 輸入管道（Strategic → 系統）

| 管道 | 方式 | 例子 |
|------|------|------|
| **直接對話** | Tamp ↔ Nox main session | 「幫我做 X」 |
| **UI 操作** | Task Engine UI 按鈕 | approve proposal、建 task |
| **Spec 文件** | 寫 markdown → Nox 讀 | 完整需求規格 |
| **Board 直改** | 改 board.json 或 API | 緊急調整 |

### 輸出管道（系統 → Strategic）

| 管道 | 內容 | 頻率 |
|------|------|------|
| **Retro 報告** | metrics + insights + proposals | 每天 |
| **SSE 推送** | 即時狀態變化 | 即時 |
| **Daily summary** | memory/YYYY-MM-DD.md 摘要 | heartbeat |
| **主動通知** | blocked 任務、高風險 proposal | 隨事件 |

---

## 決策類型與自治度

| 決策 | 誰做 | 自治度 | 觸發 |
|------|------|--------|------|
| 新專案方向 | Human | 0% | Tamp 發起 |
| 寫 spec | Nox (Lead) | 50% | Human 指令，Nox 執行 |
| 拆 taskPlan | Nox (Lead) | 70% | 基於 spec，Nox 判斷 |
| 選 assignee | Nox → 未來 retro 建議 | 70% → 90% | 基於歷史 metrics |
| 定 threshold | retro proposal | 80% | 數據驅動 |
| 架構重構 | Human | 0% | 人工判斷 |
| 砍功能 | Human | 0% | 人工判斷 |
| 新增 agent | Human | 0% | 人工決策 |
| 調模型 | retro proposal | 50% | 數據建議 + Human 確認 |

---

## Nox 作為 Lead 的角色演進

### 現在

```
Tamp 說做什麼 → Nox 全手動（寫 spec + 拆 task + 派發 + 追蹤 + 審查）
```

### 短期（Operational 層上線後）

```
Tamp 說做什麼 → Nox 寫 spec + 拆 task
                → 派發交給 server 自動
                → 審查交給 process-review.js
                → 趨勢分析交給 retro.js
                → Nox 只處理例外和 Human 請求
```

### 中期

```
retro.js 發現問題 → 生成 proposal
  → 低風險 auto-apply
  → 中風險 Nox 裁定
  → 高風險 Tamp 裁定
```

### 遠期

```
signal 偵測 → retro 分析 → proposal → gate → execute
  → Nox 的角色從「操作者」變成「治理者」
  → 大部分日常運作自動化
  → Human 只處理方向性問題和例外
```

---

## 與 Operational 層的介面

### Operational → Strategic

```json
// retro 報告給 Strategic 層的摘要
{
  "summary": {
    "period": "2026-02-24 ~ 2026-02-25",
    "tasksCompleted": 8,
    "tasksApproved": 6,
    "manualOverrides": 2,
    "avgScore": 68,
    "topIssue": "engineer_lite 在 server 類任務表現不佳",
    "pendingProposals": 3,
    "appliedProposals": 1,
    "trend": "improving"
  }
}
```

### Strategic → Operational

- Approve / reject proposals
- 手動新增 proposal（Human 的想法也可以進 proposal queue）
- 調整 auto-apply 策略（哪些風險等級可以自動）
- 設定 retro 觸發頻率

---

## 尚未設計的部分

1. **multi-project 支援**：目前只有一個 taskPlan，未來需要跨專案 dashboard
2. **cost tracking**：不同模型的成本追蹤，讓 Strategic 層做預算決策
3. **goal decomposition**：從高層目標自動拆成 taskPlan（目前由 Nox 手動）
4. **risk assessment**：新任務的風險評估（影響範圍、相依性、回滾難度）
5. **priority system**：多個 proposal / task 之間的優先級排序
