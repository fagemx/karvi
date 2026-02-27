# Evolution Layer — Planning Pack

## 目標

在現有 Task Engine 上搭建進化層：`signals`（客觀事實）、`insights`（主觀判斷）、`lessons`（沉澱規則）。讓系統能觀察自己的運作、提出改善建議、累積經驗規則。

設計哲學詳見 `docs/blackboard-evolution.md`。

**一句話**：讓 task-engine 從「執行工具」升級為「會學習的執行工具」。

---

## 現有基礎設施

| 元件 | 路徑 | 狀態 |
|------|------|------|
| blackboard-server.js | `project/blackboard-server.js` | ✅ |
| task-engine server | `project/task-engine/server.js` (1654 行) | ✅ |
| process-review.js | `project/task-engine/process-review.js` (549 行) | ✅ |
| index.html (UI) | `project/task-engine/index.html` (1308 行) | ✅ |
| board.json | `project/task-engine/board.json` | ✅ |
| smoke-test.js | `project/smoke-test.js` | ✅ |
| CONTRACT.md | `project/CONTRACT.md` | ✅ |

---

## Task 清單

| Task | 名稱 | 改動範圍 | 依賴 | 預估 |
|------|------|---------|------|------|
| T1 | Evolution API Foundation | `server.js` | — | 2-3h |
| T2 | Review Signal Emitter | `process-review.js` | T1 | 1h |
| T3 | Retro Engine | 新檔 `retro.js` | T1 | 3-4h |
| T4 | Evolution UI Panel | `index.html` | T1 | 2-3h |
| T5 | Gate Logic + Auto-Rollback + Lesson Injection | `server.js` | T1, T3 | 3h |
| T6 | End-to-End Validation | `smoke-test.js` + 手動測試 | T1-T5 | 1h |

**Total: 6 Tasks, ~13h**

---

## Dependency Graph

```
T1 (Evolution API Foundation)
 ├── T2 (Review Signal Emitter)    ← 可並行
 ├── T3 (Retro Engine)             ← 可並行
 └── T4 (Evolution UI Panel)       ← 可並行

T1 + T3 → T5 (Gate Logic + Lesson Injection)

T1-T5 → T6 (End-to-End Validation)
```

---

## Batch 分配

### Batch 1（必須先完成，單一 agent）

| Agent | Task | 改動檔案 |
|-------|------|---------|
| Agent 1 | T1: Evolution API Foundation | `server.js` |

**原因**：T1 修改 `server.js` 加入 8 個新 API endpoint + board schema 擴展，是所有後續任務的基礎。

### Batch 2（T1 完成後，三個 agent 並行）

| Agent | Task | 改動檔案 | 與其他 agent 衝突 |
|-------|------|---------|-----------------|
| Agent 1 | T2: Review Signal Emitter | `process-review.js` | 無 |
| Agent 2 | T3: Retro Engine | 新檔 `retro.js` | 無 |
| Agent 3 | T4: Evolution UI Panel | `index.html` | 無 |

**原因**：三個任務各自修改不同檔案，完全可並行。

### Batch 3（T1 + T3 完成後，單一 agent）

| Agent | Task | 改動檔案 |
|-------|------|---------|
| Agent 1 | T5: Gate Logic + Lesson Injection | `server.js` |

**原因**：Gate 需要讀 insights（T1 的 API），lesson injection 需要了解 retro.js 產出的 lesson 格式（T3）。

### Batch 4（全部完成後）

| Agent | Task | 改動檔案 |
|-------|------|---------|
| Agent 1 | T6: End-to-End Validation | `smoke-test.js` + 手動 |

---

## 執行順序圖

```
時間 ─────────────────────────────────────────────────→

Batch 1:  [====== T1: Evolution API ======]
                                           │
Batch 2:                                   ├── [== T2: Review Signals ==]
                                           ├── [==== T3: Retro Engine ====]
                                           └── [=== T4: Evolution UI ===]
                                                                          │
Batch 3:                                                                  [== T5: Gate + Lessons ==]
                                                                                                    │
Batch 4:                                                                                            [= T6: Validation =]
```

---

## Progress Tracker

### Batch 1
```
[x] T1: Evolution API Foundation
```

### Batch 2
```
[x] T2: Review Signal Emitter
[x] T3: Retro Engine
[x] T4: Evolution UI Panel
```

### Batch 3
```
[x] T5: Gate Logic + Lesson Injection
```

### Batch 4
```
[ ] T6: End-to-End Validation
```

---

## 必讀文件

所有 agent 開始前必須讀以下文件：

1. **`project/CONTRACT.md`** — 黑板共用核心契約
2. **`project/task-engine/docs/plans/EVOLUTION_LAYER/CONTRACT.md`** — 進化層專用契約
3. **各自的 Task 文件** — `T1_EVOLUTION_API.md` 等

建議額外讀（理解設計意圖）：
- `project/task-engine/docs/blackboard-evolution.md` — 進化哲學
- `project/task-engine/docs/architecture.md` — 三層架構總覽
