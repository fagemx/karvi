# 04 — 從 Kernel 到村莊到國家

> 2026-03-06 研究筆記

## 核心推論

如果 Karvi 是 Agent Execution Kernel，那上面可以跑任何「程式」— 包括治理其他 agent 的 AI。

```
一個 agent + kernel    = 一個能可靠執行任務的單元
多個 agent + kernel    = 一個能自治的工作群（村莊）
多個村莊 + 協議        = 一個能協作的網路（國家）
```

## 每一層都是 Kernel 的用戶

```
Layer 0: Kernel（Karvi）
  提供：隔離、追蹤、控制、恢復
  不做判斷，只提供保證

Layer 1: 工作者 Agent
  用 kernel 執行任務
  自己決定怎麼做

Layer 2: 村莊管理者（Village Chief）
  一個 AI 管理者 + 多個 AI 工作者
  管理者用 kernel 的 API 編排工作者
  管理者自己也跑在 kernel 上

Layer 3: 國家協調者（Nation Coordinator）
  多個村莊之間的協調
  更高層的 AI 協調者
  也跑在 kernel 上
```

**每一層的 AI 都用同一套 kernel primitives。** Kernel 不需要知道上面跑的是「工人」還是「管理者」還是「協調者」。對 kernel 來說，都是 task + step + agent。

就像 OS 不知道跑的是 Word 還是另一個 OS（VM）。它只管 process。

## 對應 OS 概念

| 村莊/國家概念 | OS 對應 |
|-------------|---------|
| Village board | Process group |
| Village Chief | Parent process（fork + 管理 children） |
| Territory coordination | IPC（inter-process communication） |
| Nation / Coordinator | Init system / systemd |
| 村莊間協議 | Network protocol |

## 已有的規劃

```
#148 feat(village): multi-village board registry
#149 feat(territory): cross-village coordination
#150 feat(nation): strategic governance layer with Nox coordinator
```

這些不是「新功能」，是 **kernel 上面的 userspace 程式**。

Village Chief 就是一個跑在 Karvi 上的 agent，它的「工作」是：
- 接收目標
- 拆解成 tasks
- 用 kernel API 派給其他 agent
- 監控進度
- 處理例外
- 向上匯報

它跟寫 code 的 agent 用的是同一套 kernel。

## AI 治理 AI

```
用戶：「我要一個電商網站」

Nation Coordinator（AI）：
  → 拆成 3 個村莊的工作
  → karvi task create --village frontend "建前端"
  → karvi task create --village backend "建 API"
  → karvi task create --village infra "建部署"

Village Chief - Frontend（AI）：
  → 拆成具體 tasks
  → karvi step add "設計頁面" → karvi step add "寫元件" → karvi step add "測試"
  → 派給工作者 agent

Village Chief - Backend（AI）：
  → 同理

Kernel（Karvi）全程保證：
  → 每個村莊隔離
  → 每個 task 追蹤
  → 跨村莊依賴管理
  → 總預算控制
  → 任何一層出問題都能 kill / retry / escalate
```

## 但前提是 Kernel 要先穩

```
OS 不穩 → 所有程式都不穩
Kernel 不穩 → 所有村莊、國家都不穩
```

### Kernel 現在的狀態

| 能力 | 狀態 | 說明 |
|------|------|------|
| Worktree 隔離 | 有 | 每個 task 獨立 worktree |
| Step 狀態機 | 有 | queued → running → succeeded/dead |
| Retry + backoff | 有 | 3 次重試，指數退避 |
| Artifact 存檔 | 有 | input/output per step |
| JSONL audit log | 有 | append-only |
| SSE 即時進度 | 有 | tool call 計數 |
| Kill step | **缺** | #214 |
| Cancel task | **缺** | #274 |
| 成本追蹤 | **缺** | 沒有 per-step token/美元記錄 |
| 預算硬停 | **缺** | 超支不會停 |
| 人類閘門 | **缺** | step 間無法插入人類審批 |
| Idle detection | **不準** | #273 |
| 重試感知 prompt | **缺** | #277 |

### 村莊要能運作，Kernel 至少需要

1. **能停** — kill + cancel（管理者要能停掉失控的工人）
2. **能限** — 預算上限（管理者要能限制資源）
3. **能看** — 成本 + 進度追蹤（管理者要能監控）
4. **能恢復** — retry with context（失敗不是重來是繼續）

## 優先級

```
現在：把 Kernel 做穩（Layer 2-4 補齊）
之後：Village / Nation 自然能長出來（Layer 1 的 userspace 程式）
```

不急著做 #148-#150。地基先穩，上層結構自然能蓋。

---

上一篇：[03-agent-execution-kernel.md](03-agent-execution-kernel.md) — Agent Execution Kernel
下一篇：[05-kernel-gaps-and-priorities.md](05-kernel-gaps-and-priorities.md) — Kernel 缺口與優先級
