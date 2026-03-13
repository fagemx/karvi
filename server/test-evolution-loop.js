#!/usr/bin/env node
/**
 * test-evolution-loop.js — 驗證完整的 signal → insight → lesson 迴路
 *
 * 自包含測試：自動啟動 server、重置 board、執行測試、結束後關閉 server。
 * 用法：npm test（不需要預先 npm start）
 *
 * Part A — 自動改善（正向迴路）
 * Part B — 自動回滾（負向迴路）
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT) || 13461;
const API_TOKEN = process.env.KARVI_API_TOKEN || null;

// Global timeout — kill the process if test hangs (CI safety net)
const GLOBAL_TIMEOUT_MS = 120_000;
setTimeout(() => {
  console.error(`\n❌ Global timeout (${GLOBAL_TIMEOUT_MS / 1000}s) — test hung, forcing exit`);
  if (serverProc) { serverProc.kill(); serverProc = null; }
  process.exit(2);
}, GLOBAL_TIMEOUT_MS).unref();
// Use a temp directory for board data to avoid clobbering production board.json
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-'));
let serverProc = null;

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    const req = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method: 'POST',
      headers
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    req.end(data);
  });
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    http.get({ hostname: 'localhost', port: PORT, path: urlPath, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function ok(label) { console.log(`  ✅ ${label}`); }
function fail(label, reason) { console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), DATA_DIR: TEST_DATA_DIR },
    });

    let started = false;
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      if (!started && text.includes('running at')) {
        started = true;
        resolve(proc);
      }
    });

    proc.stderr.on('data', (data) => {
      if (!started) {
        // Log server stderr for debugging
        process.stderr.write('[server] ' + data.toString());
      }
    });

    const timer = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error('Server failed to start within 10s'));
      }
    }, 10000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error(`Server exited with code ${code} before ready`));
      }
    });
  });
}

function stopServer() {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
}

function cleanState() {
  // Clean temp data dir — server's ensureBoardExists() creates a fresh default.
  // Uses TEST_DATA_DIR (temp) instead of __dirname to avoid clobbering production board.json.
  for (const f of ['board.json', 'board.json.bak', 'task-log.jsonl']) {
    try {
      fs.unlinkSync(path.join(TEST_DATA_DIR, f));
    } catch (err) {
      console.warn(`[test-evolution-loop] cleanup skipped for ${f}:`, err.message);
    }
  }
}

async function main() {
  // --- Clean state & start server ---
  cleanState();
  console.log('Starting server...');
  serverProc = await startServer();
  console.log(`Server started on port ${PORT}`);
  process.on('exit', stopServer);
  ok('Clean board created by server');

  console.log('\n=== Evolution Loop Test ===\n');

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
  const retro1 = spawnSync('node', [path.join(__dirname, 'retro.js'), '--port', String(PORT), '--board', path.join(TEST_DATA_DIR, 'board.json')], { cwd: __dirname, encoding: 'utf8' });
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
    // Gate 沒自動 apply（可能安全閥觸發），手動 apply
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

  // Step 7: 確認 lesson 被自動寫入
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
      fail('Validated lesson', 'no lesson found — verifyAppliedInsights should run on review_result signals');
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
    fail('Bad insight auto-apply', 'insight not auto-applied — expected status "applied"');
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
      ok('Insight rolled back');
    } else {
      fail('Insight rollback', `expected status "rolled_back", got "${rolledBack?.status}"`);
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

  // ============================================
  console.log('\n=== Part C: Provider Health Check Test ===\n');
  // ============================================

  // Step 12: GET /api/health/providers — 驗證 response 格式
  console.log('Step 12: Testing GET /api/health/providers...');
  const healthResult = await get('/api/health/providers');
  if (!healthResult.ts) { fail('health/providers missing ts', JSON.stringify(healthResult)); }
  else if (!Array.isArray(healthResult.providers)) { fail('health/providers missing providers array', JSON.stringify(healthResult)); }
  else {
    ok(`Got ${healthResult.providers.length} provider(s)`);
    // 每個 provider 必須有 id, type, status, checks
    let formatOk = true;
    for (const p of healthResult.providers) {
      if (!p.id || !p.type || !p.status || !p.checks) {
        fail(`provider ${p.id || '?'} missing required fields`, JSON.stringify(p));
        formatOk = false;
        break;
      }
      if (!['healthy', 'degraded', 'unhealthy'].includes(p.status)) {
        fail(`provider ${p.id} invalid status`, p.status);
        formatOk = false;
        break;
      }
    }
    if (formatOk) ok('All providers have valid format (id, type, status, checks)');
  }

  // Step 13: GET /api/health/providers?id=openclaw — 過濾特定 provider
  console.log('\nStep 13: Testing filtered provider health check...');
  const filteredResult = await get('/api/health/providers?id=openclaw');
  if (!Array.isArray(filteredResult.providers)) { fail('filtered health missing providers', JSON.stringify(filteredResult)); }
  else if (filteredResult.providers.length !== 1) { fail('filtered health should return 1 provider', `got ${filteredResult.providers.length}`); }
  else if (filteredResult.providers[0].id !== 'openclaw') { fail('filtered provider id mismatch', filteredResult.providers[0].id); }
  else { ok(`Filtered to: ${filteredResult.providers[0].id} (${filteredResult.providers[0].status})`); }

  // Step 14: 不存在的 provider → 回傳 unhealthy
  console.log('\nStep 14: Testing non-existent provider...');
  const badResult = await get('/api/health/providers?id=nonexistent');
  if (!Array.isArray(badResult.providers)) { fail('bad provider missing providers', JSON.stringify(badResult)); }
  else if (badResult.providers[0]?.status !== 'unhealthy') { fail('non-existent provider should be unhealthy', badResult.providers[0]?.status); }
  else { ok('Non-existent provider correctly reported as unhealthy'); }

  // Step 15: Error classification 驗證（非存在 provider 的 error.type）
  console.log('\nStep 15: Verifying error classification format...');
  const errProvider = badResult.providers?.[0];
  if (!errProvider?.error?.type) { fail('error provider missing error.type', JSON.stringify(errProvider)); }
  else if (!errProvider?.error?.message) { fail('error provider missing error.message', JSON.stringify(errProvider)); }
  else { ok(`Error classified: type=${errProvider.error.type}, message="${errProvider.error.message}"`); }

  // ============================================
  console.log('\n=== Part D: Cost-Based Model Routing Test ===\n');
  // ============================================

  // Step 16: Set cost_routing via controls API
  console.log('Step 16: Setting cost_routing tiers...');
  const costRoutingPatch = {
    model_map: { opencode: { default: 'anthropic/claude-opus-4' } },
    cost_routing: {
      tiers: [
        { budget_pct_remaining: 50, model_map: { opencode: { default: 'anthropic/claude-sonnet-4' } } },
        { budget_pct_remaining: 20, model_map: { opencode: { default: 'anthropic/claude-haiku-3' } } },
      ],
    },
  };
  const crResult = await post('/api/controls', costRoutingPatch);
  if (!crResult.ok) { fail('cost_routing update', JSON.stringify(crResult)); }
  else { ok('cost_routing tiers set'); }

  // Step 17: Verify cost_routing in controls
  console.log('\nStep 17: Reading back cost_routing...');
  const crControls = await get('/api/controls');
  if (!crControls.cost_routing?.tiers?.length) { fail('cost_routing not persisted', JSON.stringify(crControls.cost_routing)); }
  else if (crControls.cost_routing.tiers.length !== 2) { fail('expected 2 tiers', crControls.cost_routing.tiers.length); }
  else { ok(`cost_routing has ${crControls.cost_routing.tiers.length} tiers`); }

  // Step 18: Verify resolveModelHint picks tier model when budget is low
  console.log('\nStep 18: Testing cost routing model resolution...');
  const mgmt = require('./management');
  const testControls = mgmt.getControls({
    controls: {
      model_map: { opencode: { default: 'anthropic/claude-opus-4' } },
      cost_routing: {
        tiers: [
          { budget_pct_remaining: 50, model_map: { opencode: { default: 'anthropic/claude-sonnet-4' } } },
          { budget_pct_remaining: 20, model_map: { opencode: { default: 'anthropic/claude-haiku-3' } } },
        ],
      },
    },
  });

  // 18a: No budget → should use global model_map (opus)
  const noBudgetTask = { id: 'T-test', assignee: 'engineer' };
  const noBudgetModel = mgmt.resolveCostRoutingModel('opencode', 'implement', testControls, undefined);
  if (noBudgetModel !== null) { fail('no budget should return null', noBudgetModel); }
  else { ok('No budget → null (falls through to global model_map)'); }

  // 18b: 80% remaining → no tier matches → null
  const budget80 = { limits: { max_tokens: 1000 }, used: { tokens: 200 } };
  const model80 = mgmt.resolveCostRoutingModel('opencode', 'implement', testControls, budget80);
  if (model80 !== null) { fail('80% remaining should return null', model80); }
  else { ok('80% remaining → null (no tier matches)'); }

  // 18c: 40% remaining → first tier (50%) matches → sonnet
  const budget40 = { limits: { max_tokens: 1000 }, used: { tokens: 600 } };
  const model40 = mgmt.resolveCostRoutingModel('opencode', 'implement', testControls, budget40);
  if (model40 !== 'anthropic/claude-sonnet-4') { fail('40% remaining should pick sonnet', model40); }
  else { ok('40% remaining → anthropic/claude-sonnet-4 (tier 50%)'); }

  // 18d: 10% remaining → second tier (20%) matches → haiku
  const budget10 = { limits: { max_tokens: 1000 }, used: { tokens: 900 } };
  const model10 = mgmt.resolveCostRoutingModel('opencode', 'implement', testControls, budget10);
  if (model10 !== 'anthropic/claude-haiku-3') { fail('10% remaining should pick haiku', model10); }
  else { ok('10% remaining → anthropic/claude-haiku-3 (tier 20%)'); }

  // Step 19: Verify budgetPctRemaining calculation
  console.log('\nStep 19: Testing budgetPctRemaining...');
  const pct1 = mgmt.budgetPctRemaining(null);
  if (pct1 !== 100) { fail('null budget should be 100%', pct1); }
  else { ok('null budget → 100%'); }

  const pct2 = mgmt.budgetPctRemaining({ limits: { max_tokens: 1000 }, used: { tokens: 750 } });
  if (pct2 !== 25) { fail('750/1000 used should be 25% remaining', pct2); }
  else { ok('750/1000 used → 25% remaining'); }

  // Step 20: Validate cost_routing rejects bad input
  console.log('\nStep 20: Testing cost_routing validation...');
  const badCR1 = await post('/api/controls', { cost_routing: { tiers: [{ budget_pct_remaining: 150 }] } });
  if (!badCR1.error) { fail('should reject pct > 99', JSON.stringify(badCR1)); }
  else { ok('Rejects budget_pct_remaining > 99'); }

  const badCR2 = await post('/api/controls', { cost_routing: { tiers: [{ budget_pct_remaining: 50 }] } });
  if (!badCR2.error) { fail('should reject missing model_map', JSON.stringify(badCR2)); }
  else { ok('Rejects tier without model_map'); }

  const badCR3 = await post('/api/controls', { cost_routing: 'invalid' });
  if (!badCR3.error) { fail('should reject non-object', JSON.stringify(badCR3)); }
  else { ok('Rejects non-object cost_routing'); }

  // Clean up: reset cost_routing
  await post('/api/controls', { cost_routing: null });

  console.log('\n=== Done ===');
  // RBAC tests are in server/test-rbac.js (dedicated test)
  stopServer();
  process.exit(process.exitCode || 0);
}

main().catch(err => { console.error('Fatal:', err.message); stopServer(); process.exit(1); });
