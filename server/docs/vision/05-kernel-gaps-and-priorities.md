# 05 — Kernel 缺口與優先級

> 2026-03-06 研究筆記

## 四層架構的完成度

### Layer 2: 執行保證 — 大致有了

| 能力 | 狀態 | Issue |
|------|------|-------|
| Worktree 隔離 | 有 | — |
| Step 狀態機 | 有 | — |
| Retry + backoff | 有 | — |
| 合約驗證 | 有 | — |
| Idle detection | 不準 | #273（已 dispatch） |
| Cancelled step state | 缺 | #219（已 dispatch） |
| 重試感知 prompt | 缺 | #277 |

### Layer 3: 運行控制 — 最大缺口

| 能力 | 狀態 | Issue |
|------|------|-------|
| Kill step（精準終止） | 缺 | #214 |
| Cancel task（關閉任務） | 缺 | #274 |
| 預算硬停 | 缺 | 待開 |
| 人類閘門（step 間審批） | 缺 | 待開 |
| Pause / Resume | 缺 | 待開 |
| 動態 controls 調整 | 有 | — |
| Per-type 併發控制 | 缺 | #279 |

### Layer 4: 可觀測 — 部分有

| 能力 | 狀態 | Issue |
|------|------|-------|
| SSE 即時進度 | 有 | — |
| Artifact 存檔 | 有 | — |
| JSONL audit log | 有 | — |
| 錯誤分類 | 有 | — |
| 成本追蹤（per-step token） | 缺 | 待開 |
| 成本追蹤（美元換算） | 缺 | 待開 |
| 時間追蹤（per-step wall clock） | 部分 | startedAt 有，duration 沒算 |

## 從競品學到的

| 來源 | 學什麼 | 對應 Issue |
|------|--------|-----------|
| Symphony | WORKFLOW.md — prompt 模板化 | #276 |
| Symphony | 重試感知 prompt（attempt 變數） | #277 |
| Symphony | Workspace hooks（before/after） | #278 |
| Paperclip | Per-agent 成本追蹤 + 預算上限 | 待開 |
| Paperclip | Board 審批閘門 | 待開 |
| Google Workspace CLI | CLI 是最通用的 agent interface | 待評估 |

## 優先級排序

### P0 — Kernel 基本完整性（沒這些就不算 kernel）

1. **#274 Cancel task** — 任務關不掉，基本生命週期不完整
2. **#214 Kill step** — 跑起來停不下來，沒有控制力
3. **成本追蹤** — agent 燒多少錢完全不知道，最危險的盲點

### P1 — Kernel 可靠性（讓 AI 能信賴 kernel）

4. **#273 Smart idle detection** — 已 dispatch，解決誤殺問題
5. **#277 Retry-aware prompt** — 重試不是從頭來，帶 context 繼續
6. **#219 Cancelled step state** — 已 dispatch，kill 的前置需求
7. **預算硬停** — 成本追蹤的執行面，超支自動停

### P2 — Kernel 靈活性（讓 AI 能自由編排）

8. **#276 Template-based prompt** — prompt 從 code 搬到模板檔
9. **#278 Workspace hooks** — 可客製的生命週期掛勾
10. **#279 Per-type 併發控制** — plan 多跑、implement 限流
11. **人類閘門** — step 間插入人類審批點

### P3 — 面向未來（Village / Nation 的前置）

12. 跨 task 依賴管理
13. 村莊級 board 隔離
14. 村莊間通訊協議

## 現在 vs 之後

```
現在做：P0 + P1（Kernel 基本完整 + 可靠）
   → 單一 AI 能信賴 Karvi 跑任務

之後做：P2（Kernel 靈活）
   → AI 能自由組裝 pipeline

再之後：P3（Village / Nation）
   → AI 治理 AI，多層自治

不急著做：
   - 組織結構（Paperclip 模式）— 太重
   - Guardrails（LangWatch 模式）— 不同賽道
   - Agent 模擬 — 規模不到
```

## 已追蹤的 Issue 清單

| Issue | 標題 | 優先級 | 狀態 |
|-------|------|--------|------|
| #214 | Kill step | P0 | open |
| #219 | Cancelled step state | P1 | dispatched |
| #249 | Review needs_revision output | P1 | dispatched |
| #273 | Smart idle detection | P1 | dispatched |
| #274 | Cancel task status | P0 | open |
| #276 | Template-based prompt | P2 | open |
| #277 | Retry-aware prompt | P1 | open |
| #278 | Workspace hooks | P2 | open |
| #279 | Per-type concurrency | P2 | open |

待開 issue：成本追蹤、預算硬停、人類閘門。

---

上一篇：[04-village-nation.md](04-village-nation.md) — 從 Kernel 到村莊到國家
