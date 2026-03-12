/**
 * usage.js — Usage Tracking Module (Hybrid: append-on-event + in-memory cache)
 *
 * Tracks per-user resource usage: dispatch count, agent runtime seconds,
 * API token consumption, SSE connection time.
 *
 * Storage: {DATA_DIR}/usage/{userId}/usage-YYYY-MM.jsonl
 * Cache:   Map<"userId:YYYY-MM", aggregation>  — rebuilt on init, updated on record
 *
 * Zero external dependencies.
 */
const fs = require('fs');
const path = require('path');

const VALID_USER_ID = /^[a-zA-Z0-9_-]+$/;
const VALID_EVENT_TYPES = new Set([
  'dispatch',
  'agent.runtime',
  'api.tokens',
  'sse.connect',
  'sse.disconnect',
]);

// In-memory cache: key = "userId:YYYY-MM", value = aggregation object
const cache = new Map();

// Alert rate-limiting: key = "userId:metric", value = last alert timestamp
const alertTimestamps = new Map();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Module-level config (set by init)
let config = null;

function currentMonth() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function usageDir(userId) {
  return path.join(config.dataDir, 'usage', userId);
}

function usageFilePath(userId, month) {
  return path.join(usageDir(userId), `usage-${month}.jsonl`);
}

function emptyAggregation(userId, month) {
  return {
    userId,
    month,
    dispatches: 0,
    runtimeSec: 0,
    tokens: { input: 0, output: 0 },
    cost: 0,
    sseMinutes: 0,
    events: 0,
  };
}

function cacheKey(userId, month) {
  return `${userId}:${month}`;
}

function getOrCreateCache(userId, month) {
  const key = cacheKey(userId, month);
  if (!cache.has(key)) {
    cache.set(key, emptyAggregation(userId, month));
  }
  return cache.get(key);
}

/**
 * Update cache from a single event object.
 */
function updateCacheFromEvent(userId, month, event) {
  const agg = getOrCreateCache(userId, month);
  agg.events += 1;

  switch (event.type) {
    case 'dispatch':
      agg.dispatches += 1;
      break;
    case 'agent.runtime':
      agg.runtimeSec += (event.durationSec || 0);
      break;
    case 'api.tokens':
      if (event.input != null) agg.tokens.input += event.input;
      if (event.output != null) agg.tokens.output += event.output;
      if (event.cost != null) agg.cost += event.cost;
      break;
    case 'sse.connect':
      agg.sseMinutes += (event.sessionMinutes || 0);
      break;
    case 'sse.disconnect':
      // disconnect is informational, no aggregation needed
      break;
  }
}

/**
 * Rebuild cache for current month by scanning usage JSONL files.
 */
function rebuildCache() {
  const month = currentMonth();
  const usageRoot = path.join(config.dataDir, 'usage');

  if (!fs.existsSync(usageRoot)) return;

  let userDirs;
  try {
    userDirs = fs.readdirSync(usageRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return;
  }

  for (const userId of userDirs) {
    const filePath = usageFilePath(userId, month);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          updateCacheFromEvent(userId, month, event);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  console.log(`[usage] cache rebuilt: ${cache.size} user-month entries`);
}

/**
 * Aggregate usage from a JSONL file (for historical months not in cache).
 */
function aggregateFromFile(userId, month) {
  const filePath = usageFilePath(userId, month);
  const agg = emptyAggregation(userId, month);

  if (!fs.existsSync(filePath)) return agg;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        agg.events += 1;
        switch (event.type) {
          case 'dispatch':
            agg.dispatches += 1;
            break;
          case 'agent.runtime':
            agg.runtimeSec += (event.durationSec || 0);
            break;
          case 'api.tokens':
            if (event.input != null) agg.tokens.input += event.input;
            if (event.output != null) agg.tokens.output += event.output;
            if (event.cost != null) agg.cost += event.cost;
            break;
          case 'sse.connect':
            agg.sseMinutes += (event.sessionMinutes || 0);
            break;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // file read error
  }

  return agg;
}

// ─── Public API ───

/**
 * Initialize usage tracking.
 * @param {object} opts - { dataDir, broadcastSSE, readBoard }
 * @returns {{ stop: Function }}
 */
function init(opts) {
  if (!opts || !opts.dataDir) throw new Error('usage.init requires dataDir');

  // Clear stale cache from previous init() calls to prevent double-counting
  cache.clear();
  alertTimestamps.clear();

  config = {
    dataDir: opts.dataDir,
    broadcastSSE: opts.broadcastSSE || (() => {}),
    readBoard: opts.readBoard || (() => ({})),
  };

  // Ensure usage root directory exists
  const usageRoot = path.join(config.dataDir, 'usage');
  if (!fs.existsSync(usageRoot)) {
    fs.mkdirSync(usageRoot, { recursive: true });
  }

  // Rebuild cache from current month files
  rebuildCache();

  console.log('[usage] initialized');

  return {
    stop() {
      console.log('[usage] stopped');
    },
  };
}

/**
 * Record a usage event.
 * @param {string} userId
 * @param {string} type - one of VALID_EVENT_TYPES
 * @param {object} data - event-specific data
 */
function record(userId, type, data = {}) {
  if (!config) return; // not initialized

  // Validate userId
  const uid = String(userId || 'default').trim();
  if (!VALID_USER_ID.test(uid)) {
    console.warn(`[usage] invalid userId: ${uid}`);
    return;
  }

  // Validate type
  if (!VALID_EVENT_TYPES.has(type)) {
    console.warn(`[usage] invalid event type: ${type}`);
    return;
  }

  const month = currentMonth();
  const event = {
    ts: new Date().toISOString(),
    type,
    ...data,
  };

  // Ensure user directory
  const dir = usageDir(uid);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Append to JSONL file
  const filePath = usageFilePath(uid, month);
  try {
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    console.error(`[usage] write error: ${err.message}`);
    return;
  }

  // Update in-memory cache
  updateCacheFromEvent(uid, month, event);

  // Check limits after recording
  checkLimits(uid);
}

/**
 * Query usage for a specific user and month.
 * @param {string} userId
 * @param {string} [month] - YYYY-MM format, defaults to current month
 * @returns {object} aggregation with optional limits info
 */
function query(userId, month) {
  const uid = String(userId || 'default').trim();
  const m = month || currentMonth();
  const key = cacheKey(uid, m);

  let agg;
  if (m === currentMonth() && cache.has(key)) {
    // Return from cache (fast path)
    agg = { ...cache.get(key), tokens: { ...cache.get(key).tokens } };
  } else if (m === currentMonth()) {
    // Current month but not in cache — user has no events
    agg = emptyAggregation(uid, m);
  } else {
    // Historical month — read from file
    agg = aggregateFromFile(uid, m);
  }

  // Attach limits info if configured
  if (config) {
    try {
      const board = config.readBoard();
      const limits = board.controls?.usage_limits;
      if (limits) {
        agg.limits = {};
        if (limits.dispatches_per_month != null) {
          agg.limits.dispatches = {
            limit: limits.dispatches_per_month,
            used: agg.dispatches,
            pct: Math.round((agg.dispatches / limits.dispatches_per_month) * 1000) / 10,
          };
        }
        if (limits.runtime_sec_per_month != null) {
          agg.limits.runtimeSec = {
            limit: limits.runtime_sec_per_month,
            used: agg.runtimeSec,
            pct: Math.round((agg.runtimeSec / limits.runtime_sec_per_month) * 1000) / 10,
          };
        }
        if (limits.tokens_per_month != null) {
          const totalTokens = agg.tokens.input + agg.tokens.output;
          agg.limits.tokens = {
            limit: limits.tokens_per_month,
            used: totalTokens,
            pct: Math.round((totalTokens / limits.tokens_per_month) * 1000) / 10,
          };
        }
      }
    } catch {
      // ignore — limits are optional
    }
  }

  return agg;
}

/**
 * Admin summary across all users for a given month.
 * @param {string} [month] - YYYY-MM format, defaults to current month
 * @returns {object} platform-wide summary
 */
function summary(month) {
  const m = month || currentMonth();
  const usageRoot = path.join(config?.dataDir || '.', 'usage');
  const result = {
    month: m,
    totalUsers: 0,
    totalDispatches: 0,
    totalRuntimeSec: 0,
    totalTokens: { input: 0, output: 0 },
    totalCost: 0,
    topUsers: [],
  };

  if (!fs.existsSync(usageRoot)) return result;

  let userDirs;
  try {
    userDirs = fs.readdirSync(usageRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return result;
  }

  const userAggs = [];
  for (const userId of userDirs) {
    const key = cacheKey(userId, m);
    let agg;

    if (m === currentMonth() && cache.has(key)) {
      agg = cache.get(key);
    } else {
      agg = aggregateFromFile(userId, m);
    }

    if (agg.events === 0) continue;

    result.totalUsers += 1;
    result.totalDispatches += agg.dispatches;
    result.totalRuntimeSec += agg.runtimeSec;
    result.totalTokens.input += agg.tokens.input;
    result.totalTokens.output += agg.tokens.output;
    result.totalCost += agg.cost;

    userAggs.push({
      userId,
      dispatches: agg.dispatches,
      runtimeSec: agg.runtimeSec,
      tokens: agg.tokens.input + agg.tokens.output,
    });
  }

  // Top users by dispatches (descending)
  userAggs.sort((a, b) => b.dispatches - a.dispatches);
  result.topUsers = userAggs.slice(0, 10);

  return result;
}

/**
 * Check usage against configured limits. Broadcast SSE alert if threshold exceeded.
 * @param {string} userId
 * @returns {{ exceeded: boolean, alerts: string[] }}
 */
function checkLimits(userId) {
  const result = { exceeded: false, alerts: [] };
  if (!config) return result;

  let board;
  try {
    board = config.readBoard();
  } catch {
    return result;
  }

  const limits = board.controls?.usage_limits;
  if (!limits) return result;

  const threshold = board.controls?.usage_alert_threshold ?? 0.8;
  const month = currentMonth();
  const key = cacheKey(userId, month);
  const agg = cache.get(key);
  if (!agg) return result;

  const checks = [];

  if (limits.dispatches_per_month != null) {
    checks.push({
      metric: 'dispatches',
      used: agg.dispatches,
      limit: limits.dispatches_per_month,
    });
  }

  if (limits.runtime_sec_per_month != null) {
    checks.push({
      metric: 'runtimeSec',
      used: agg.runtimeSec,
      limit: limits.runtime_sec_per_month,
    });
  }

  if (limits.tokens_per_month != null) {
    const totalTokens = agg.tokens.input + agg.tokens.output;
    checks.push({
      metric: 'tokens',
      used: totalTokens,
      limit: limits.tokens_per_month,
    });
  }

  for (const check of checks) {
    const pct = check.used / check.limit;
    if (pct >= threshold) {
      result.exceeded = true;
      const alertMsg = `${check.metric}: ${check.used}/${check.limit} (${Math.round(pct * 100)}%)`;
      result.alerts.push(alertMsg);

      // Rate-limit alerts: at most 1 per metric per hour
      const alertKey = `${userId}:${check.metric}`;
      const lastAlert = alertTimestamps.get(alertKey) || 0;
      const now = Date.now();
      if (now - lastAlert >= ALERT_COOLDOWN_MS) {
        alertTimestamps.set(alertKey, now);
        config.broadcastSSE('usage_alert', {
          userId,
          month,
          metric: check.metric,
          used: check.used,
          limit: check.limit,
          pct: Math.round(pct * 100),
        });
      }
    }
  }

  return result;
}

/**
 * Enforce usage limits before dispatch. Returns { allowed: true } or
 * { allowed: false, code: 'USAGE_LIMIT_EXCEEDED', metric, used, limit }.
 * Unlike checkLimits (threshold-based alerts), this is a hard gate: used >= limit → block.
 * @param {string} userId
 * @returns {{ allowed: boolean, code?: string, metric?: string, used?: number, limit?: number }}
 */
function enforceUsageLimits(userId) {
  if (!config) return { allowed: true };

  let board;
  try {
    board = config.readBoard();
  } catch {
    return { allowed: true };
  }

  const limits = board.controls?.usage_limits;
  if (!limits) return { allowed: true };

  const month = currentMonth();
  const uid = String(userId || 'default').trim();
  const key = cacheKey(uid, month);
  const agg = cache.get(key) || emptyAggregation(uid, month);

  if (limits.dispatches_per_month != null && agg.dispatches >= limits.dispatches_per_month) {
    return { allowed: false, code: 'USAGE_LIMIT_EXCEEDED', metric: 'dispatches', used: agg.dispatches, limit: limits.dispatches_per_month };
  }

  if (limits.runtime_sec_per_month != null && agg.runtimeSec >= limits.runtime_sec_per_month) {
    return { allowed: false, code: 'USAGE_LIMIT_EXCEEDED', metric: 'runtimeSec', used: agg.runtimeSec, limit: limits.runtime_sec_per_month };
  }

  if (limits.tokens_per_month != null) {
    const totalTokens = agg.tokens.input + agg.tokens.output;
    if (totalTokens >= limits.tokens_per_month) {
      return { allowed: false, code: 'USAGE_LIMIT_EXCEEDED', metric: 'tokens', used: totalTokens, limit: limits.tokens_per_month };
    }
  }

  return { allowed: true };
}

module.exports = {
  init,
  record,
  query,
  summary,
  checkLimits,
  enforceUsageLimits,
  currentMonth,
};
