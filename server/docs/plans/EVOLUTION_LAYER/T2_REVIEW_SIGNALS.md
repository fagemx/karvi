# T2: Review Signal Emitter

> Batch 2（T1 完成後，可與 T3、T4 並行）
> 改動檔案：`project/task-engine/process-review.js`
> 預估：1 小時

---

## 開始前

```bash
# Step 1: 讀契約
cat project/CONTRACT.md
cat project/task-engine/docs/plans/EVOLUTION_LAYER/CONTRACT.md

# Step 2: 確認 T1 已完成 — signal API 可用
curl -s http://localhost:3461/api/signals | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).length >= 0 ? 'T1 OK' : 'T1 NOT READY')"

# Step 3: 讀 process-review.js 理解現有結構
cat project/task-engine/process-review.js

# Step 4: 執行下方步驟
```

---

## 最終結果

- `process-review.js` 每次審查完成後，自動 POST 一筆 signal 到 `/api/signals`
- signal 包含：審查分數、通過/未通過、deterministic issues、agent 和 task 資訊
- 不改變 process-review.js 的任何現有邏輯和輸出
- `node -c process-review.js` 通過

---

## 實作步驟

### Step 1: 新增 emitSignal 函數

**位置**：`process-review.js` 頂部，helper functions 區域（在 `appendLog` 附近）

```js
function emitSignal(signal) {
  const port = 3461;
  const body = JSON.stringify(signal);
  const req = require('http').request({
    hostname: 'localhost',
    port,
    path: '/api/signals',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {});
  req.on('error', () => {}); // fire-and-forget
  req.end(body);
}
```

**設計決策**：
- 用 `http.request` 不是 `fetch`（Node.js 16 相容）
- fire-and-forget：signal 失敗不影響審查流程
- port 硬編碼 3461（跟 server.js 一致，process-review.js 已在同目錄下）

### Step 2: 審查完成後 emit signal

**位置**：`process-review.js` 的審查結果確定後（找到寫入 board 的地方，在那之後 emit）

找到 `process-review.js` 中設定 task.status 為 `approved` 或 `needs_revision` 的位置。在每個分支之後加入 signal emit：

**approved 分支**：

```js
emitSignal({
  by: 'process-review.js',
  type: 'review_result',
  content: `${task.id} 審查通過 (score: ${score}/${threshold})`,
  refs: [task.id],
  data: {
    taskId: task.id,
    assignee: task.assignee || null,
    result: 'approved',
    score: score,
    threshold: threshold,
    deterministicIssues: issues.length,
    attempt: task.reviewAttempts || 1,
  }
});
```

**needs_revision 分支**：

```js
emitSignal({
  by: 'process-review.js',
  type: 'review_result',
  content: `${task.id} 審查未通過 (score: ${score}/${threshold}, issues: ${issues.length})`,
  refs: [task.id],
  data: {
    taskId: task.id,
    assignee: task.assignee || null,
    result: 'needs_revision',
    score: score,
    threshold: threshold,
    deterministicIssues: issues.length,
    issuesSummary: issues.slice(0, 5).join('; '),
    attempt: task.reviewAttempts || 1,
  }
});
```

**skip-llm 或 deterministic-only 分支**（如果有）：

```js
emitSignal({
  by: 'process-review.js',
  type: 'review_result',
  content: `${task.id} deterministic 檢查完成 (issues: ${issues.length})`,
  refs: [task.id],
  data: {
    taskId: task.id,
    result: 'deterministic_only',
    deterministicIssues: issues.length,
  }
});
```

### Step 3: 注意事項

1. **不要改任何現有邏輯**。signal emit 是附加行為，不影響審查結果。
2. **不要 await signal emit**。它是 fire-and-forget，不應阻塞審查流程。
3. **score 和 threshold 變數名稱可能不同**。讀 process-review.js 的實際變數名，不要假設。
4. **issues 可能是陣列或字串**。確認 data 格式安全。

### Step 4: 自檢

```bash
# 語法檢查
node -c process-review.js

# 確認 server 在跑
curl -s http://localhost:3461/api/signals | node -e "console.log('server OK')"

# 跑一次 review（dry-run 或真實）
node process-review.js --dry-run

# 檢查 signals 是否增加
curl -s http://localhost:3461/api/signals | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const rs=d.filter(s=>s.type==='review_result');console.log('review signals:', rs.length)"
```

如果目前沒有 completed 狀態的任務可以 review，可以手動測試 emitSignal：

```bash
node -e "
const http = require('http');
const body = JSON.stringify({by:'process-review.js',type:'review_result',content:'T-test approved (score: 85/70)',refs:['T-test'],data:{taskId:'T-test',result:'approved',score:85,threshold:70}});
const req = http.request({hostname:'localhost',port:3461,path:'/api/signals',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, res => {let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))});
req.end(body);
"
```
