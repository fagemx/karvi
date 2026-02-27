# Task Engine 三層自治架構

> 版本：0.1（規劃階段）
> 日期：2026-02-25
> 狀態：Draft

---

## 設計目標

建立一個可自我進化的多 agent 任務系統。核心理念：

1. **由小到大**：先在小範圍做到可靠的自動化，再往上組裝
2. **每層有自己的迴路**：sense → decide → act → evaluate
3. **越往上越謹慎**：底層高自治，上層低自治
4. **進化不是重複**：系統要能改變自己做事的方式

---

## 三層架構

```
┌────────────────────────────────────────────────────────┐
│  Strategic（戰略層）                                    │
│  問題：做什麼？往哪走？                                 │
│  自治度：低 — Human 決定，agent 只是顧問                │
│  迴路週期：週/月                                        │
│  參與者：Tamp（Human）+ Nox（Lead）                     │
│  輸入：Operational 層的 metrics + proposals              │
│  輸出：專案方向、新 spec、優先級調整                     │
└────────────────────┬───────────────────────────────────┘
                     │ ↓ 目標、spec、優先級
                     │ ↑ metrics 摘要、趨勢、proposals
┌────────────────────▼───────────────────────────────────┐
│  Operational（戰術層）                                  │
│  問題：做得怎樣？哪裡需要改進？                          │
│  自治度：中 — 低風險自動、高風險等人                      │
│  迴路週期：天                                           │
│  工具：retro.js（回顧腳本）                              │
│  輸入：Tactical 層的 task-log + review scores            │
│  輸出：proposals[], metrics, 改善行動                    │
└────────────────────┬───────────────────────────────────┘
                     │ ↓ taskPlan、controls 調整、skill 更新
                     │ ↑ task status、review score、blocked reason
┌────────────────────▼───────────────────────────────────┐
│  Tactical（執行層）                                     │
│  問題：怎麼做？做完怎麼檢查？                            │
│  自治度：高 — 自動執行 + 自動審查 + 自動修正              │
│  迴路週期：分鐘                                         │
│  工具：server.js + process-review.js                     │
│  輸入：taskPlan、spec、controls                          │
│  輸出：完成的任務、review 數據、事件日誌                  │
└────────────────────────────────────────────────────────┘
```

---

## 每一層的自治預算

| 層 | 能自動做的 | 必須等人的 |
|---|---|---|
| **Tactical** | 執行任務、審查打分、修正重試 | 超過 max_attempts 的卡住任務 |
| **Operational** | 改 threshold、換 assignee、更新 skill checklist | 開新專案、改架構、砍功能 |
| **Strategic** | 提出觀察和建議 | 所有方向性決策 |

原則：**越往上，agent 的角色從「執行者」變成「顧問」。**

---

## 資訊流方向

### 往下（控制流）
- Strategic → Operational：目標（goal）、規格（spec）、優先級
- Operational → Tactical：任務計畫（taskPlan）、控制參數（controls）、skill 更新

### 往上（報告流）
- Tactical → Operational：任務狀態、review score、blocked reason、completion time
- Operational → Strategic：metrics 摘要、趨勢分析、proposals 清單

### 關鍵原則
- **往上傳的是壓縮後的摘要，不是原始數據**
- **往下傳的是目標，不是步驟**
- 每一層自己決定「怎麼做」，上層只決定「做什麼」

---

## 對應到現有元件

| 元件 | 層 | 角色 | 狀態 |
|------|---|------|------|
| `server.js` | Tactical | 任務調度、狀態管理、API | ✅ 已完成 |
| `process-review.js` | Tactical | 品質閘門（deterministic + LLM） | ✅ 已完成 |
| `buildTaskDispatchMessage` | Tactical | 派發訊息組裝（注入 spec + context） | ✅ 已完成 |
| `redispatchTask` | Tactical | 審查失敗後自動修正 | ✅ 已完成 |
| `retro.js` | Operational | 回顧分析 + 生成 proposals | ❌ 待做 |
| `proposals[]` in board.json | Operational | 結構化改善建議 | ❌ 待做 |
| `auto-apply` | Operational | 低風險 proposal 自動執行 | ❌ 待做 |
| metrics dashboard | Operational | UI 顯示趨勢 | ❌ 待做 |
| Tamp ↔ Nox 對話 | Strategic | 方向決策 | ✅ 手動進行中 |
| retro metrics → 對話 | Strategic | 結構化輸入 | ❌ 待做 |

---

## 進度

```
Tactical:     ████████████████████░░  ~85%
Operational:  ██░░░░░░░░░░░░░░░░░░  ~10%
Strategic:    █░░░░░░░░░░░░░░░░░░░  ~5%
```

---

## 相關文件

- [hardening-plan.md](hardening-plan.md) — Phase 1-4 強化計畫（已完成）
- [tactical-layer.md](tactical-layer.md) — 執行層詳細設計
- [operational-layer.md](operational-layer.md) — 感知/回顧/提案層設計
- [strategic-layer.md](strategic-layer.md) — 戰略層設計
- [dispatch-protocol.md](dispatch-protocol.md) — 派發協議規格
- [evolution-loop.md](evolution-loop.md) — 自我進化迴路設計（已被 blackboard-evolution 取代，保留作歷史參考）
- **[blackboard-evolution.md](blackboard-evolution.md) — 黑板式進化：核心設計哲學（取代管線式 evolution-loop）**
- [../../CONTRACT.md](../../CONTRACT.md) — 黑板共用核心 contract
- [../../blackboard-architecture.md](../../blackboard-architecture.md) — 黑板架構總覽
