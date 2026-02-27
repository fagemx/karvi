# S8: Scoped Boards（分層黑板 + Brief 整合）

## 目標

讓 task-engine server 支援**分層黑板**：根黑板 `board.json` 管索引，每個 task 可以有自己的 scoped board（如 `brief.json`）。

完成後：

1. 一個 server（port 3461）同時服務管理層 UI 和領域層 UI
2. 每個 task 可以有 `briefPath`，指向自己的 scoped JSON
3. `/api/brief/:taskId` 讀寫特定 task 的 scoped board
4. brief-panel UI 掛載在 `/brief/:taskId`，改動量極小
5. SSE 支援 scoped 事件（`brief:AD184` 等）

**brief-panel 不再需要獨立 server。**

---

## 前置條件

- [x] S1-S4: 拆層完成
- [x] S5: dispatchable state
- [x] S6: 原子 API
- [ ] S7: Codex Runtime（S8 不依賴 S7，可並行）

---

## 設計原則

1. **索引和內容分離**
   - `board.json` 只有 task 級狀態（輕，幾 KB）
   - scoped board 有領域細節（鏡頭、分數、歷史，可能幾十 KB）
   - Nox 看全局時只載入 `board.json`，不載入 189 份 brief

2. **scoped board 是可選的**
   - 不是每個 task 都需要 scoped board
   - 沒有 `briefPath` 的 task 就是普通任務
   - 有 `briefPath` 的 task 才有 `/api/brief/:taskId` 和 `/brief/:taskId` 路由

3. **寫入走統一路徑**
   - scoped board 的寫入也要觸發 SSE
   - SSE event type 帶 taskId：`{ type: 'brief', taskId: 'AD184', data: {...} }`

4. **blackboard-server.js 的 CONTRACT 適用**
   - 每份 scoped board 也有 `meta.boardType` 和 `meta.version`
   - 寫入走 helper 函式，不直接 `fs.writeFileSync`

---

## 新增資料模型

### task 新增 `briefPath`（可選欄位）

```json
{
  "id": "AD184",
  "title": "時裝-致敬甄環傳",
  "status": "running",
  "assignee": "designer_agent",
  "skill": "conversapix-storyboard",
  "briefPath": "briefs/AD184.json"
}
```

### briefs 目錄

```
project/task-engine/
  ├── board.json
  ├── briefs/              ← 新增
  │   ├── AD184.json
  │   └── AD185.json
  ├── server.js
  ├── management.js
  └── runtime-openclaw.js
```

### scoped board schema（沿用 brief.json 格式）

```json
{
  "meta": {
    "boardType": "brief",
    "version": 1,
    "taskId": "AD184",
    "updatedAt": "2026-02-26T..."
  },
  "project": { ... },
  "shotspec": { "shots": [...] },
  "refpack": { ... },
  "controls": { ... },
  "log": [...]
}
```

---

## 變更範圍

### 1. server.js 新增 scoped board helper

```javascript
const BRIEFS_DIR = path.join(DIR, 'briefs');

function ensureBriefsDir() {
  if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });
}

function readBrief(taskId) {
  const board = readBoard();
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task?.briefPath) return null;
  const p = path.resolve(DIR, task.briefPath);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeBrief(taskId, data) {
  const board = readBoard();
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task?.briefPath) return false;

  data.meta = data.meta || {};
  data.meta.updatedAt = new Date().toISOString();
  data.meta.boardType = data.meta.boardType || 'brief';
  data.meta.version = data.meta.version || 1;
  data.meta.taskId = taskId;

  const p = path.resolve(DIR, task.briefPath);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  broadcastSSE('brief', { taskId, data });
  return true;
}
```

### 2. server.js 新增 API 路由

```javascript
// GET /api/brief/:taskId — 讀取 scoped board
if (req.method === 'GET' && req.url.match(/^\/api\/brief\/[\w-]+$/)) {
  const taskId = req.url.split('/api/brief/')[1];
  const data = readBrief(taskId);
  if (!data) return json(res, 404, { error: 'no brief for this task' });
  return json(res, 200, data);
}

// PATCH /api/brief/:taskId — 更新 scoped board（merge）
if (req.method === 'PATCH' && req.url.match(/^\/api\/brief\/[\w-]+$/)) {
  const taskId = req.url.split('/api/brief/')[1];
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    try {
      const patch = JSON.parse(body || '{}');
      const existing = readBrief(taskId);
      if (!existing) return json(res, 404, { error: 'no brief for this task' });

      const merged = deepMerge(existing, patch);
      writeBrief(taskId, merged);
      return json(res, 200, { ok: true, taskId });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });
  return;
}

// PUT /api/brief/:taskId — 完整覆寫 scoped board
if (req.method === 'PUT' && req.url.match(/^\/api\/brief\/[\w-]+$/)) {
  const taskId = req.url.split('/api/brief/')[1];
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      if (!writeBrief(taskId, data)) return json(res, 404, { error: 'no brief for this task' });
      return json(res, 200, { ok: true, taskId });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });
  return;
}
```

### 3. server.js 掛載 brief-panel 靜態檔案

```javascript
// /brief/:taskId → 回傳 brief-panel 的 index.html
if (req.method === 'GET' && req.url.match(/^\/brief\/[\w-]+$/)) {
  const briefPanelHtml = path.resolve(DIR, '..', '..', 'skills',
    'conversapix-storyboard', 'tools', 'brief-panel', 'index.html');
  if (fs.existsSync(briefPanelHtml)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(briefPanelHtml, 'utf8'));
  }
  return json(res, 404, { error: 'brief-panel not installed' });
}
```

### 4. brief-panel index.html 微調

原本的 API 呼叫：

```javascript
// 舊：固定端點
fetch('/api/brief')
```

改成：

```javascript
// 新：從 URL 讀 taskId
const pathParts = location.pathname.split('/brief/');
const TASK_ID = pathParts[1] || null;
const API_BASE = TASK_ID ? `/api/brief/${TASK_ID}` : '/api/brief';

fetch(API_BASE)
```

SSE 訂閱也要帶 taskId 過濾：

```javascript
const es = new EventSource('/api/events');
es.addEventListener('brief', (e) => {
  const { taskId, data } = JSON.parse(e.data);
  if (taskId === TASK_ID) renderBoard(data);
});
```

---

## /api/project 自動建 brief

S6 的 `/api/project` 要擴充：如果 task 有 `skill` 且 skill 需要 brief，自動建立空的 scoped board。

```javascript
// 在 /api/project handler 裡
for (const t of tasks) {
  if (t.skill && SKILLS_NEEDING_BRIEF.has(t.skill)) {
    ensureBriefsDir();
    const briefPath = `briefs/${t.id}.json`;
    t.briefPath = briefPath;

    const emptyBrief = {
      meta: { boardType: 'brief', version: 1, taskId: t.id },
      project: { name: title },
      shotspec: { status: 'pending', shots: [] },
      refpack: { status: 'empty', assets: {} },
      controls: { auto_retry: true, max_retries: 3, quality_threshold: 85, paused: false },
      log: [{ time: new Date().toISOString(), agent: 'system', action: 'brief_created', detail: `auto-created for ${t.id}` }],
    };
    fs.writeFileSync(path.resolve(DIR, briefPath), JSON.stringify(emptyBrief, null, 2));
  }
}
```

```javascript
const SKILLS_NEEDING_BRIEF = new Set([
  'conversapix-storyboard',
]);
```

---

## 進化層怎麼吃 scoped board

scoped board 裡的資料可以變成 signal：

```javascript
// 任務完成時，從 brief 匯總 signal
function summarizeBriefAsSignal(taskId) {
  const brief = readBrief(taskId);
  if (!brief?.shotspec?.shots) return null;

  const shots = brief.shotspec.shots;
  const totalRetries = shots.reduce((sum, s) => sum + (s.retries || 0), 0);
  const avgScore = shots.reduce((sum, s) => sum + (s.score || 0), 0) / shots.length;

  return {
    type: 'task_brief_summary',
    taskId,
    shotCount: shots.length,
    totalRetries,
    avgScore: Math.round(avgScore),
    passRate: shots.filter(s => s.status === 'pass').length / shots.length,
  };
}
```

retro.js 可以吃這些 signal，產出 insight：
- 「時裝類廣告平均重試 4.2 次，是其他類型的 2 倍 → 降低 quality_threshold 或改善 prompt」

---

## 驗證

### 1. scoped board CRUD

```bash
# 建專案（自動建 brief）
curl -X POST http://localhost:3461/api/project \
  -H "Content-Type: application/json" \
  -d '{"title":"test","tasks":[{"id":"T1","title":"test shot","skill":"conversapix-storyboard"}]}'

# 讀 brief
curl http://localhost:3461/api/brief/T1

# 更新 brief
curl -X PATCH http://localhost:3461/api/brief/T1 \
  -H "Content-Type: application/json" \
  -d '{"shotspec":{"status":"validated"}}'

# brief-panel UI
# 開瀏覽器 → http://localhost:3461/brief/T1
```

### 2. SSE 事件

```bash
curl -N http://localhost:3461/api/events
# PATCH brief 後應該收到 { type: 'brief', taskId: 'T1', data: {...} }
```

### 3. 既有測試不壞

```bash
node ../../smoke-test.js 3461
node test-evolution-loop.js
```

---

## 不要做的事

- 不要大改 brief-panel 的 UI 邏輯（只改 API 端點和 SSE 訂閱）
- 不要把 brief 內容塞進 board.json（分離的意義就在這裡）
- 不要在 management.js 引入 brief 讀寫（那是 server 的事）
- 不要建立 brief 的全域 schema 驗證（每種 skill 的 brief 結構不同，先不強制）
- 不要刪除 brief-panel 的獨立 server.js（保留相容，但不再是必需）

---

## 完成標記

更新 `00_OVERVIEW.md` Progress Tracker：

```
[x] S8: Scoped Boards（分層黑板 + Brief 整合）
```
