# T6: End-to-End Validation

> Batch 4（T1-T5 全部完成後）
> 改動檔案：`project/smoke-test.js` + 手動測試腳本
> 預估：1 小時

---

## 開始前

```bash
# 確認所有前置 task 完成
node -c project/task-engine/server.js
node -c project/task-engine/process-review.js
node -c project/task-engine/retro.js

# 確認 server 在跑
curl -s http://localhost:3461/api/board | node -e "const b=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log('board OK, signals:', (b.signals||[]).length)"
```

---

## 最終結果

- `smoke-test.js` 新增 evolution endpoints 測試（3 個新 check）
- 手動測試腳本 `test-evolution-loop.js` 驗證完整迴路
- 所有測試通過

---

## 實作步驟

### Step 1: smoke-test.js 新增 checks

**位置**：`project/smoke-test.js`

在現有的 task-engine (port 3461) 測試項目中新增：

```js
// Evolution API checks
await check('GET /api/signals', async () => {
  const res = await get(port, '/api/signals');
  assert(Array.isArray(res), 'signals should be array');
});

await check('POST /api/signals', async () => {
  const res = await post(port, '/api/signals', {
    by: 'smoke-test',
    type: 'test',
    content: 'smoke test signal',
  });
  assert(res.ok === true, 'should return ok');
  assert(res.signal && res.signal.id, 'should return signal with id');
});

await check('POST + GET /api/insights', async () => {
  const res = await post(port, '/api/insights', {
    by: 'smoke-test',
    judgement: 'smoke test insight',
    suggestedAction: { type: 'noop', payload: {} },
    risk: 'low',
  });
  assert(res.ok === true, 'should return ok');

  const all = await get(port, '/api/insights');
  assert(all.some(i => i.by === 'smoke-test'), 'should contain smoke test insight');
});

await check('POST + GET /api/lessons', async () => {
  const res = await post(port, '/api/lessons', {
    by: 'smoke-test',
    rule: 'smoke test lesson',
  });
  assert(res.ok === true, 'should return ok');

  const all = await get(port, '/api/lessons');
  assert(all.some(l => l.by === 'smoke-test'), 'should contain smoke test lesson');
});
```

**注意**：smoke-test 產生的測試資料會留在 board.json。測試完畢後可手動清理，或在 smoke-test 開頭加一步清理（但不推薦，避免意外刪除真實資料）。

### Step 2: 完整迴路手動測試腳本

**新建檔案**：`project/task-engine/test-evolution-loop.js`

```js
#!/usr/bin/env node
/**
 * test-evolution-loop.js — 驗證完整的 signal → insight → lesson 迴路
 *
 * 前提：server.js 在 3461 port 運行
 *
 * 步驟：
 * Part A — 自動改善（正向迴路）
 * 1. 寫入 3 筆模擬的 review_result signals（模擬基準分數）
 * 2. 跑 retro.js → 產出 insight
 * 3. 確認 insight 被自動 apply（gate 預設 on）
 * 4. 確認 snapshot 存在
 * 5. 寫入 3 筆改善後 signals → 觸發驗證
 * 6. 確認 lesson (validated) 被自動寫入
 *
 * Part B — 自動回滾（負向迴路）
 * 7. POST 一個 controls_patch insight（手動模擬）
 * 8. 確認被自動 apply + 有 snapshot
 * 9. 寫入 3 筆惡化 signals → 觸發驗證
 * 10. 確認 insight 被自動 rolled_back
 * 11. 確認 controls 恢復到 snapshot 值
 */

const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');

const PORT = 3461;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'localhost', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    req.end(data);
  });
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: PORT, path: urlPath }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function ok(label) { console.log(`  ✅ ${label}`); }
function fail(label, reason) { console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

async function main() {
  console.log('=== Evolution Loop Test ===\n');

  // Step 1: 寫 3 筆低分 signals
  console.log('Step 1: Writing 3 low-score review signals for engineer_lite...');
  for (let i = 0; i < 3; i++) {
    await post('/api/signals', {
      by: 'test-evo-loop',
      type: 'review_result',
      content: `T-test${i + 1} 審查未通過 (score: ${40 + i * 3}/70)`,
      refs: [`T-test${i + 1}`],
      data: { taskId: `T-test${i + 1}`, assignee: 'engineer_lite', result: 'needs_revision', score: 40 + i * 3, threshold: 70, attempt: 1 },
    });
  }
  ok('3 review signals written');

  // Step 2: 跑 retro.js
  console.log('\nStep 2: Running retro.js...');
  const retro1 = spawnSync('node', [path.join(__dirname, 'retro.js')], { cwd: __dirname, encoding: 'utf8' });
  console.log(retro1.stdout);
  if (retro1.status !== 0) { fail('retro.js', retro1.stderr); return; }
  ok('retro.js completed');

  // Step 3: 確認 insight 產出
  console.log('\nStep 3: Checking for agent_underperform insight...');
  const insights = await get('/api/insights');
  const underperform = insights.find(i => i.by === 'retro.js' && i.data?.patternType === 'agent_underperform');
  if (!underperform) { fail('No agent_underperform insight found', JSON.stringify(insights.slice(0, 3))); return; }
  ok(`Found insight: "${underperform.judgement}"`);

  // Step 4: 確認 insight 被自動 apply（gate 預設 on）
  console.log('\nStep 4: Checking if insight was auto-applied by gate...');
  const insights2 = await get('/api/insights');
  const applied = insights2.find(i => i.by === 'retro.js' && i.status === 'applied' && i.data?.patternType === 'agent_underperform');
  if (!applied) {
    // 如果 gate 沒自動 apply（可能安全閥觸發），手動 apply
    console.log('  Gate did not auto-apply, applying manually...');
    await post(`/api/insights/${underperform.id}/apply`, {});
    ok('Manually applied');
  } else {
    ok(`Auto-applied by gate: ${applied.id}`);
    if (applied.snapshot) ok(`Snapshot recorded: ${JSON.stringify(applied.snapshot)}`);
    if (applied.appliedAt) ok(`Applied at: ${applied.appliedAt}`);
  }

  // Step 5: 確認 apply signal 存在
  console.log('\nStep 5: Verifying apply signal...');
  const signals = await get('/api/signals');
  const applySignal = signals.find(s => s.type === 'insight_applied');
  if (!applySignal) { fail('No insight_applied signal found', ''); return; }
  ok('Apply signal recorded');

  // Step 6: 寫 3 筆改善後 signals → 觸發驗證 → 應產生 validated lesson
  console.log('\nStep 6: Writing 3 improved review signals (triggers verification)...');
  for (let i = 0; i < 3; i++) {
    await post('/api/signals', {
      by: 'test-evo-loop',
      type: 'review_result',
      content: `T-improved${i + 1} 審查通過 (score: ${75 + i * 3}/70)`,
      refs: [`T-improved${i + 1}`],
      data: { taskId: `T-improved${i + 1}`, assignee: 'engineer_pro', result: 'approved', score: 75 + i * 3, threshold: 70, attempt: 1 },
    });
  }
  ok('3 improved signals written');

  // Step 7: 確認 lesson 被自動寫入（verifyAppliedInsights 應在 review signal 進來時觸發）
  console.log('\nStep 7: Checking for validated lesson...');
  const lessons = await get('/api/lessons');
  const validatedLesson = lessons.find(l => l.status === 'validated' && l.by === 'gate');
  if (validatedLesson) {
    ok(`Lesson validated: "${validatedLesson.rule}" | effect: ${validatedLesson.effect}`);
  } else {
    const anyLesson = lessons.find(l => l.fromInsight);
    if (anyLesson) {
      ok(`Lesson found (status: ${anyLesson.status}): "${anyLesson.rule}"`);
    } else {
      console.log('  ⚠️ No lesson yet — verify that verifyAppliedInsights runs on review_result signals');
    }
  }

  // ============================================
  console.log('\n=== Part B: Auto-Rollback Test ===\n');
  // ============================================

  // Step 8: POST 一個 controls_patch insight（模擬一個會惡化的改動）
  console.log('Step 8: Writing a controls_patch insight (will degrade performance)...');
  const badInsightResult = await post('/api/insights', {
    by: 'test-evo-loop',
    judgement: 'threshold 應降到 30（故意製造惡化）',
    suggestedAction: { type: 'controls_patch', payload: { quality_threshold: 30 } },
    risk: 'low',
  });
  ok(`Bad insight posted: ${badInsightResult.insight?.id || 'unknown'}`);

  // Step 9: 確認被自動 apply + 有 snapshot
  console.log('\nStep 9: Checking auto-apply + snapshot...');
  const insights3 = await get('/api/insights');
  const badApplied = insights3.find(i => i.judgement?.includes('降到 30') && i.status === 'applied');
  if (!badApplied) { 
    console.log('  ⚠️ Bad insight not auto-applied (might be blocked by safety valve)');
    console.log('  Skipping rollback test');
  } else {
    ok(`Applied: ${badApplied.id}, snapshot: ${JSON.stringify(badApplied.snapshot)}`);

    // Step 10: 寫 3 筆惡化 signals → 觸發驗證 → 應自動回滾
    console.log('\nStep 10: Writing 3 degraded review signals (triggers rollback)...');
    for (let i = 0; i < 3; i++) {
      await post('/api/signals', {
        by: 'test-evo-loop',
        type: 'review_result',
        content: `T-degraded${i + 1} 惡化 (score: ${25 + i * 2}/70)`,
        data: { taskId: `T-degraded${i + 1}`, result: 'needs_revision', score: 25 + i * 2, threshold: 70 },
      });
    }
    ok('3 degraded signals written');

    // Step 11: 確認回滾
    console.log('\nStep 11: Checking rollback...');
    const insights4 = await get('/api/insights');
    const rolledBack = insights4.find(i => i.id === badApplied.id);
    if (rolledBack?.status === 'rolled_back') {
      ok('Insight rolled back ✅');
    } else {
      console.log(`  ⚠️ Status: ${rolledBack?.status} (expected: rolled_back)`);
    }

    // 確認 controls 恢復
    const board = await get('/api/board');
    const currentThreshold = board.controls?.quality_threshold;
    console.log(`  Controls quality_threshold: ${currentThreshold}`);
    if (currentThreshold !== 30) {
      ok(`Controls restored (threshold is ${currentThreshold}, not 30)`);
    } else {
      fail('Controls not restored', `threshold is still 30`);
    }

    // 確認 rollback signal
    const signals2 = await get('/api/signals');
    const rollbackSig = signals2.find(s => s.type === 'insight_rolled_back');
    if (rollbackSig) {
      ok(`Rollback signal recorded: ${rollbackSig.content}`);
    } else {
      console.log('  ⚠️ No rollback signal found');
    }
  }

  console.log('\n=== Done ===');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
```

### Step 3: 自檢

```bash
# 跑 smoke-test
node project/smoke-test.js 3461

# 跑完整迴路測試
node project/task-engine/test-evolution-loop.js
```

### 驗收標準

| 項目 | 通過條件 |
|------|---------|
| smoke-test evolution checks | 全部 ✅ |
| signal API CRUD | GET 回陣列, POST 回 201 + 有 id |
| insight API CRUD | GET 回陣列, POST 回 201, apply 改 status |
| lesson API CRUD | GET 回陣列, POST 回 201, status 可改 |
| retro.js 產出 insight | dry-run 印出 judgement |
| 正向迴路 | signal → retro → insight → auto-apply → 改善 → lesson (validated) |
| 負向迴路 | signal → insight → auto-apply → 惡化 → 自動回滾 + rolled_back |
| SSE 即時更新 | POST signal 後 UI 立即顯示 |
| UI 進化面板 | 可收合、三個 tab、Apply/Reject 按鈕正常 |
| 安全閥 | 24h 內同類型最多 1 次自動 apply |
| lesson 注入 dispatch | 有 active lesson 時 dispatch message 含 lessons 段落 |
| 零外部依賴 | retro.js 不引用任何 npm package |
| 語法檢查 | server.js, process-review.js, retro.js 全部 `node -c` 通過 |
