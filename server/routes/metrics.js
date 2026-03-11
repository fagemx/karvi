/**
 * routes/metrics.js — Per-Agent Quality Metrics API (#345)
 *
 * GET /api/metrics/agents — 按 runtime+model 聚合 step 成功率、tokens、duration
 *
 * 查詢參數:
 *   from      — 起始時間 ISO string（>=）
 *   to        — 結束時間 ISO string（<=）
 *   runtime   — 過濾 runtime（精確匹配）
 *   model     — 過濾 model（精確匹配）
 *   step_type — 過濾 step 類型（精確匹配）
 */
const fs = require('fs');
const bb = require('../blackboard-server');
const { json } = bb;

// Step terminal events that carry metrics (enriched in step-worker.js)
const METRIC_EVENTS = new Set(['step_completed', 'step_dead', 'step_failed']);

function readLogEntries(logPath) {
  const raw = fs.readFileSync(logPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch { /* skip unparseable lines */ }
  }
  return entries;
}

function matchEntry(entry, filters) {
  if (!METRIC_EVENTS.has(entry.event)) return false;
  // Must have runtime or model to be useful for per-agent tracking
  if (!entry.runtime && !entry.model) return false;
  if (filters.from && entry.ts < filters.from) return false;
  if (filters.to && entry.ts > filters.to) return false;
  if (filters.runtime && entry.runtime !== filters.runtime) return false;
  if (filters.model && entry.model !== filters.model) return false;
  if (filters.step_type && entry.step_type !== filters.step_type) return false;
  return true;
}

function aggregate(entries) {
  // Group by runtime + model
  const groups = new Map();

  for (const entry of entries) {
    const key = `${entry.runtime || 'unknown'}::${entry.model || 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        runtime: entry.runtime || 'unknown',
        model: entry.model || 'unknown',
        total_steps: 0,
        succeeded: 0,
        failed: 0,
        total_tokens: 0,
        total_duration_ms: 0,
        by_step_type: {},
      });
    }
    const g = groups.get(key);
    g.total_steps++;

    const isSuccess = entry.to === 'succeeded';
    if (isSuccess) g.succeeded++;
    else g.failed++;

    g.total_tokens += entry.tokens_used || 0;
    g.total_duration_ms += entry.duration_ms || 0;

    // Per step_type breakdown
    const st = entry.step_type || 'unknown';
    if (!g.by_step_type[st]) {
      g.by_step_type[st] = { total: 0, succeeded: 0, failed: 0 };
    }
    const stg = g.by_step_type[st];
    stg.total++;
    if (isSuccess) stg.succeeded++;
    else stg.failed++;
  }

  // Compute rates
  const agents = [];
  for (const g of groups.values()) {
    g.success_rate = g.total_steps > 0 ? Math.round((g.succeeded / g.total_steps) * 1000) / 1000 : 0;
    g.avg_duration_ms = g.total_steps > 0 ? Math.round(g.total_duration_ms / g.total_steps) : 0;

    for (const st of Object.values(g.by_step_type)) {
      st.success_rate = st.total > 0 ? Math.round((st.succeeded / st.total) * 1000) / 1000 : 0;
    }

    agents.push(g);
  }

  // Sort by total_steps descending
  agents.sort((a, b) => b.total_steps - a.total_steps);
  return agents;
}

module.exports = function metricsRoutes(req, res, helpers, deps) {
  if (req.method !== 'GET') return false;

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/metrics/agents') return false;

  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  const runtime = url.searchParams.get('runtime') || null;
  const model = url.searchParams.get('model') || null;
  const step_type = url.searchParams.get('step_type') || null;

  const filters = { from, to, runtime, model, step_type };

  let allEntries;
  try {
    allEntries = readLogEntries(deps.ctx.logPath);
  } catch {
    // Log file may not exist yet
    return json(res, 200, { agents: [], period: { from, to }, total_entries: 0 });
  }

  const filtered = allEntries.filter(e => matchEntry(e, filters));
  const agents = aggregate(filtered);

  return json(res, 200, {
    agents,
    period: { from, to },
    total_entries: filtered.length,
  });
};
