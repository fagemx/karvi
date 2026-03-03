# 設計文件：同步 Dispatch → 異步 Job Queue

> 狀態：draft
> 日期：2026-03-03
> 前置：#214 (kill), #218 (dispatch convergence), #219 (cancelled state)

---

## 問題：為什麼現在做不了真正的長任務

現在的 dispatch 是完全同步的：

```
HTTP request → step-worker → await rt.dispatch(plan) → 結果寫回 board
                              ↑
                              這個 await 會 block 整個 step-worker
                              直到 agent 完成或超時
```

### 這造成的限制

| 限制 | 說明 |
|------|------|
| **Server 重啟 = 丟失** | in-memory 的 Promise + child process 全部消失。retry-poller 會撿回 failed，但已完成的工作丟了 |
| **Graceful shutdown 只等 5 秒** | `server.js:340` 的 `setTimeout(() => process.exit(1), 5000)`。30 個 agent 同時跑，5 秒內根本 drain 不完 |
| **沒有 job ID** | dispatch 出去後，唯一的追蹤是 step 的 `locked_by` 和 `lock_expires_at`。沒有獨立的 execution ID 可以查詢狀態 |
| **無法 poll 進度** | client 只能等 SSE 的 step 狀態變化。沒有「agent 目前在做什麼」的中間狀態 |
| **併發瓶頸** | Node.js 單線程 + await block。30 個 agent 同時 dispatch 沒問題（都是 I/O），但 board 的原子寫入會成為瓶頸 |

### 現在能撐多少

老實說，**Village 規模（5-6 agent）用同步 dispatch 完全沒問題**。Node.js 的 async I/O 可以同時等 6 個 child process。問題出在：

1. 沒有 kill 能力（#214 解決）
2. 沒有 restart recovery
3. 沒有進度可見性

#214 + #215 + #216 做完後，Village 的長任務能力就夠用了。**這份文件要解決的是 Territory 級別（30 agent）的問題。**

---

## 目標

```
dispatch(plan) 從「等到結束」變成「丟進 queue 就回來」

Client 可以：
1. POST /api/steps/:id/dispatch → 202 Accepted, 回傳 execution_id
2. GET /api/executions/:id → 查詢狀態（queued/running/progress/completed/failed/cancelled）
3. POST /api/executions/:id/kill → 終止
4. SSE stream 即時推送進度更新

Server 重啟後：
- 持久化的 queue 裡的 pending job 重新撿起
- 正在跑的 process 透過 PID 對帳決定是否還活著
```

---

## 設計空間

### Option A: 最小改動 — Execution Registry + 持久化

不改 dispatch 流程，只加一層 registry 在外面記錄。

```
step-worker.executeStep()
  ├── registry.register(executionId, { stepId, pid, startedAt })
  ├── await rt.dispatch(plan)    ← 還是同步 await
  └── registry.unregister(executionId)

registry 定期 flush 到 executions.jsonl
server 重啟 → 讀 executions.jsonl → PID 對帳 → 活的繼續等，死的標 failed
```

**優點：** 改動最小，不動 dispatch 流程
**缺點：** 還是同步 await，restart recovery 很脆弱（process 還在但 Promise 已經丟了，拿不到結果）

### Option B: Fire-and-forget + 結果回報

dispatch 改成 fire-and-forget，agent 完成後主動回報結果。

```
step-worker.executeStep()
  ├── 啟動 child process
  ├── 註冊到 registry
  └── return（不 await）

child process 完成 → 寫結果到 artifacts/
                   → POST /api/steps/:id/complete（自己回報）
                   或 → watcher 偵測 artifacts/ 變化 → 觸發 kernel
```

**優點：** 真正異步，server 重啟不影響（child process 是 detached 的）
**缺點：** 結果回報機制複雜，需要 process 級的 detach + IPC

### Option C: 內建 Job Queue（推薦）

加一個輕量 job queue 在 step-worker 和 runtime 之間。

```
step-worker.executeStep()
  ├── jobQueue.enqueue({ stepId, envelope, priority })
  └── return executionId

jobQueue (內部 loop):
  ├── dequeue()
  ├── spawn child process
  ├── stream stdout → progress updates (SSE)
  ├── on complete → transitionStep() + kernel.onStepEvent()
  └── on error → retry logic

jobQueue 狀態持久化到 executions.json
server 重啟 → 讀 queue → 重新 dispatch pending jobs
```

**優點：**
- dispatch 立即返回
- 併發控制（max concurrent = N）
- 優先級排序
- 持久化 + restart recovery
- 進度可見性

**缺點：**
- 新模組 ~200-300 行
- step-worker 和 kernel 的接口要改

---

## 推薦：Option C 分階段交付

### Phase 1: Execution Registry（不改 dispatch 流程）

Option A，純加法。在現有同步 dispatch 上面套一層 registry。

```javascript
// execution-registry.js (~80 行)
class ExecutionRegistry {
  constructor(persistPath) { this.active = new Map(); }

  register(execId, { stepId, pid, startedAt, kill }) { ... }
  unregister(execId) { ... }
  get(execId) { ... }
  list() { ... }

  // 持久化
  flush() { /* 寫到 executions.json */ }
  recover() { /* 讀 + PID 對帳 */ }
}
```

這一步就解決：
- `GET /api/executions` — 能看到什麼在跑
- restart recovery — 至少知道哪些 execution 丟了
- 跟 #214 的 `activeExecutions` Map 合併

### Phase 2: Job Queue（改 dispatch 為異步）

```javascript
// job-queue.js (~200 行)
class JobQueue {
  constructor({ maxConcurrent, registry, onComplete, onError }) { ... }

  enqueue(job) { /* 加入 queue, return jobId */ }
  cancel(jobId) { /* kill + 移出 queue */ }

  // 內部 loop
  _processNext() {
    if (this.running.size >= this.maxConcurrent) return;
    const job = this.pending.shift();
    this._execute(job);
  }

  async _execute(job) {
    const handle = rt.dispatch(plan);  // dispatch 還是回傳 { promise, kill }
    this.registry.register(job.id, { pid: ..., kill: handle.kill });
    const result = await handle.promise;
    this.onComplete(job, result);
  }
}
```

這一步解決：
- dispatch 立即返回 execution_id
- 併發控制（Territory: `maxConcurrent: 10`）
- 優先級（urgent step 插隊）

### Phase 3: 進度串流

```javascript
// runtime adapter 的 onProgress callback
plan.onProgress = (event) => {
  // event: { type: 'tool_call', name: 'edit_file', args: { path: '...' } }
  //        { type: 'text', content: '正在分析...' }
  registry.updateProgress(execId, event);
  broadcastSSE('execution:progress', { execId, event });
};
```

這一步解決：
- 「agent 現在在幹嘛」的可見性
- UI 可以顯示即時進度

---

## 跟現有模組的關係

```
                    現在                          改完
                    ────                          ────
step-worker.js      await rt.dispatch(plan)       jobQueue.enqueue(job)
                    直接寫 board                   onComplete callback 寫 board

kernel.js           收 step_succeeded signal       不變（signal 從 onComplete 發）

retry-poller        掃 lock_expires_at             掃 registry 的 stale entries
(server.js)

routes/tasks.js     tryAutoDispatch 直接 dispatch   #218 收斂後走 step pipeline → job queue

context-compiler    buildEnvelope → plan            不變

runtime-*.js        dispatch(plan) → Promise        dispatch(plan) → { promise, kill }
                                                    （#214 已定義）
```

---

## 開放問題

1. **持久化格式？** JSON file（簡單）vs JSONL（append-only, crash safe）vs SQLite（query 方便）
2. **併發上限？** Village: 6, Territory: 10-15, Nation: 需要 multi-process
3. **Graceful shutdown drain 時間？** 現在 5 秒。30 agent 需要多久？30 秒？60 秒？configurable？
4. **進度事件的 schema？** 要不要定標準格式讓所有 runtime 遵守？
5. **跨 process 的 job queue？** 單 Node process 的 queue 不能跨機器。Territory 要多 process 時怎麼辦？

---

## 依賴鏈

```
#214 kill          ──→ Phase 1 (registry)  ──→ Phase 2 (job queue) ──→ Phase 3 (progress)
#218 convergence   ──↗
#219 cancelled     ──↗
#215 heartbeat     （獨立，但 registry 可以接管 heartbeat 職責）
#216 timeout       （獨立，queue 可以用 timeout 做 job-level deadline）
```
