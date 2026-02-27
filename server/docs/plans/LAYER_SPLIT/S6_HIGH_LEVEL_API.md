# S6: 高層 API（原子入口）

## 目標

加三個原子 API，每個只做一件事。呼叫哪個、什麼順序，由呼叫方（龍蝦/UI/cron）根據 board 狀態決定。

完成後：
1. `POST /api/dispatch-next` — 自動挑下一個可做的任務並派發
2. `POST /api/retro` — 跑一次 retro.js 分析
3. `POST /api/project` — 寫入任務計畫 + 可選自動開始

**沒有 `/api/cycle`。** apply 和 verify 已經是事件驅動的（POST signal 時自動觸發），不需要顯式呼叫。

**三個 API 都走 management.js + runtime，不引入新依賴。**

---

## 前置條件

- [x] S1-S4: 拆層完成
- [x] S5: dispatchable state + buildDispatchPlan

---

## API 1: `POST /api/dispatch-next`

### 功能

找到下一個「可以派發」的任務，自動建 dispatch plan 並執行。

### management.js 新增

```javascript
function pickNextTask(board) {
  const tasks = board.taskPlan?.tasks || [];

  // 1. 先解鎖依賴已滿足的任務
  autoUnlockDependents(board);

  // 2. 找 status === 'dispatched' 且還沒在跑的（沒有 dispatch.state === 'dispatching'）
  const ready = tasks.filter(t => {
    if (t.status !== 'dispatched') return false;
    if (t.dispatch?.state === 'dispatching') return false;
    // 跳過 Lead/Human 任務
    const isAgent = t.assignee && t.assignee !== 'human' && t.assignee !== 'main';
    return isAgent;
  });

  if (ready.length === 0) return null;

  // 3. 用 lessons 調整選擇（如果有 dispatch_hints）
  const hints = board.controls?.dispatch_hints || [];
  let picked = ready[0];

  for (const task of ready) {
    const hint = hints.find(h => h.preferAgent && task.assignee === h.preferAgent);
    if (hint) {
      picked = task;
      break;
    }
  }

  return picked;
}
```

exports 新增 `pickNextTask`。

### server.js 新增路由

```javascript
if (req.method === 'POST' && req.url === '/api/dispatch-next') {
  try {
    const board = readBoard();
    const task = mgmt.pickNextTask(board);

    if (!task) {
      writeBoard(board); // autoUnlockDependents 可能已改 board
      return json(res, 200, { ok: true, dispatched: false, reason: 'no ready tasks' });
    }

    const plan = mgmt.buildDispatchPlan(board, task, { mode: 'dispatch' });

    // 寫 dispatch state
    task.dispatch = {
      version: mgmt.DISPATCH_PLAN_VERSION,
      state: 'prepared',
      planId: plan.planId,
      runtime: plan.runtimeHint,
      agentId: plan.agentId,
      model: plan.modelHint || null,
      timeoutSec: plan.timeoutSec,
      preparedAt: plan.createdAt,
      startedAt: null, finishedAt: null,
      sessionId: plan.sessionId || null,
      lastError: null,
    };

    task.dispatch.state = 'dispatching';
    task.dispatch.startedAt = nowIso();
    writeBoard(board);
    broadcastSSE('board', board);

    // 非同步執行
    runtime.dispatch(plan).then(result => {
      const latestBoard = readBoard();
      const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
      if (latestTask) {
        latestTask.dispatch.state = 'completed';
        latestTask.dispatch.finishedAt = nowIso();
        latestTask.dispatch.sessionId = runtime.extractSessionId(result.parsed) || latestTask.dispatch.sessionId;

        // 更新 task 狀態
        const replyText = runtime.extractReplyText(result.parsed, result.stdout);
        latestTask.lastReply = replyText;
        latestTask.lastReplyAt = nowIso();
      }
      writeBoard(latestBoard);
      broadcastSSE('board', latestBoard);
    }).catch(err => {
      const latestBoard = readBoard();
      const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === task.id);
      if (latestTask) {
        latestTask.dispatch = latestTask.dispatch || {};
        latestTask.dispatch.state = 'failed';
        latestTask.dispatch.finishedAt = nowIso();
        latestTask.dispatch.lastError = err.message;
      }
      writeBoard(latestBoard);
      broadcastSSE('board', latestBoard);
    });

    return json(res, 202, { ok: true, dispatched: true, taskId: task.id, planId: plan.planId });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}
```

回傳 **202 Accepted**（非同步），呼叫方不用等 runtime 跑完。

---

## API 2: `POST /api/retro`

### 功能

跑一次 retro.js 分析。只做感知，不做派發。

retro.js 產出的 insights 會寫到 board → 觸發 `autoApplyInsights`（已經是 reactive 的）。
不需要在這裡顯式呼叫 apply 或 verify。

### server.js 新增路由

```javascript
if (req.method === 'POST' && req.url === '/api/retro') {
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync('node', [path.join(DIR, 'retro.js')], {
      cwd: DIR, encoding: 'utf8', timeout: 30000,
    });

    const board = readBoard();
    broadcastSSE('board', board);

    if (result.status === 0) {
      json(res, 200, {
        ok: true,
        output: result.stdout.trim().slice(-500),
      });
    } else {
      json(res, 500, {
        ok: false,
        error: result.stderr?.slice(0, 500) || 'retro.js failed',
      });
    }
  } catch (error) {
    json(res, 500, { error: error.message });
  }
  return;
}
```

### 誰來呼叫、什麼時候

龍蝦在 heartbeat 時看 board：

```
看 board.signals.length
  ├── 上次 retro 後有 5+ 新 signals → POST /api/retro
  └── 不夠多 → 跳過
```

**龍蝦決定什麼時候跑 retro，不是 API 決定。**

---

## API 3: `POST /api/project`

### 功能

寫入一個任務計畫，然後自動開始第一個可做的任務。

### 先做最小版

不做 LLM 拆任務。用戶/龍蝦提供 taskPlan，系統驗證 + 寫入 + auto-dispatch。

```json
POST /api/project
{
  "title": "品牌影片",
  "tasks": [
    { "id": "T1", "title": "撰寫腳本", "assignee": "engineer_pro" },
    { "id": "T2", "title": "生成分鏡", "assignee": "agent_storyboard", "depends": ["T1"], "skill": "conversapix-storyboard" },
    { "id": "T3", "title": "生成影片", "depends": ["T2"] }
  ],
  "autoStart": true
}
```

### server.js 新增路由

```javascript
if (req.method === 'POST' && req.url === '/api/project') {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');
      const title = String(payload.title || '').trim();
      if (!title) return json(res, 400, { error: 'title is required' });

      const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      if (tasks.length === 0) return json(res, 400, { error: 'tasks array is required and must not be empty' });

      // 驗證 task 結構
      const ids = new Set();
      for (const t of tasks) {
        if (!t.id || !t.title) return json(res, 400, { error: `task missing id or title: ${JSON.stringify(t)}` });
        if (ids.has(t.id)) return json(res, 400, { error: `duplicate task id: ${t.id}` });
        ids.add(t.id);
      }

      // 驗證依賴
      for (const t of tasks) {
        for (const dep of (t.depends || [])) {
          if (!ids.has(dep)) return json(res, 400, { error: `task ${t.id} depends on unknown task ${dep}` });
        }
      }

      // 寫入 board
      const board = readBoard();
      board.taskPlan = {
        title,
        createdAt: nowIso(),
        tasks: tasks.map(t => ({
          id: t.id,
          title: t.title,
          assignee: t.assignee || null,
          status: (t.depends?.length > 0) ? 'pending' : 'dispatched',
          depends: t.depends || [],
          description: t.description || '',
          spec: t.spec || null,
          skill: t.skill || null,
          estimate: t.estimate || null,
          history: [{ ts: nowIso(), status: 'created', by: 'api' }],
        })),
      };

      // 清空舊的 evolution 資料（新專案）
      board.signals = [];
      board.insights = [];
      board.lessons = [];

      writeBoard(board);
      appendLog({ ts: nowIso(), event: 'project_created', title, taskCount: tasks.length });
      broadcastSSE('board', board);

      const result = { ok: true, title, taskCount: tasks.length };

      // autoStart: 自動派發第一個可做的任務
      if (payload.autoStart) {
        const task = mgmt.pickNextTask(board);
        if (task) {
          const plan = mgmt.buildDispatchPlan(board, task, { mode: 'dispatch' });
          task.dispatch = {
            version: mgmt.DISPATCH_PLAN_VERSION,
            state: 'dispatching',
            planId: plan.planId,
            runtime: plan.runtimeHint,
            agentId: plan.agentId,
            model: plan.modelHint || null,
            timeoutSec: plan.timeoutSec,
            preparedAt: plan.createdAt,
            startedAt: nowIso(),
            finishedAt: null, sessionId: null, lastError: null,
          };
          writeBoard(board);

          runtime.dispatch(plan).then(r => {
            const lb = readBoard();
            const lt = (lb.taskPlan?.tasks || []).find(t => t.id === task.id);
            if (lt) {
              lt.dispatch.state = 'completed';
              lt.dispatch.finishedAt = nowIso();
              lt.dispatch.sessionId = runtime.extractSessionId(r.parsed) || null;
              lt.lastReply = runtime.extractReplyText(r.parsed, r.stdout);
              lt.lastReplyAt = nowIso();
            }
            writeBoard(lb);
            broadcastSSE('board', lb);
          }).catch(err => {
            const lb = readBoard();
            const lt = (lb.taskPlan?.tasks || []).find(t => t.id === task.id);
            if (lt) {
              lt.dispatch = lt.dispatch || {};
              lt.dispatch.state = 'failed';
              lt.dispatch.finishedAt = nowIso();
              lt.dispatch.lastError = err.message;
            }
            writeBoard(lb);
          });

          result.autoStarted = task.id;
          result.planId = plan.planId;
        }
      }

      json(res, 201, result);
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  });
  return;
}
```

---

## management.js exports 新增

```javascript
pickNextTask,
```

---

## 驗證

### 1. dispatch-next

```bash
# 確保有 dispatched 狀態的任務在 board 裡
curl -X POST http://localhost:3461/api/dispatch-next
# 預期：{ ok: true, dispatched: true/false, ... }
```

### 2. retro

```bash
curl -X POST http://localhost:3461/api/retro
# 預期：{ ok: true, output: "[retro] done. wrote ..." }
```

### 3. project

```bash
curl -X POST http://localhost:3461/api/project -H "Content-Type: application/json" -d "{\"title\":\"test\",\"tasks\":[{\"id\":\"T1\",\"title\":\"test task\",\"assignee\":\"engineer_lite\"}],\"autoStart\":false}"
# 預期：{ ok: true, title: "test", taskCount: 1 }
```

### 4. 既有測試不壞

```bash
node ../../smoke-test.js 3461
node test-evolution-loop.js
```

---

## 為什麼沒有 `/api/cycle`

`/api/cycle` 會把 retro → apply → verify → dispatch 綁成固定管線。
但 apply 和 verify 已經是事件驅動的（收到 signal/insight 時自動觸發），不需要顯式呼叫。
而 retro 和 dispatch-next 是獨立動作 — 呼叫哪個、什麼順序，應該由呼叫方（龍蝦/cron）看 board 狀態決定。

**API 是手和腳。決策在 board 和觀察者那邊。**

---

## 不要做的事

- 不要用 LLM 做任務拆分（`/api/project` 先接受手動提供的 tasks）
- 不要改 `processQueue` 流程（高層 API 跟 queue 並存，不取代）
- 不要把多個原子操作綁成一條管線
- 不要在 `/api/project` 清空 conversations（只清 evolution 資料）

---

## 完成標記

更新 `00_OVERVIEW.md` Progress Tracker：

```
[x] S6: 高層 API（dispatch-next / retro / project）
```
