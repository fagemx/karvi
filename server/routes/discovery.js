'use strict';
/**
 * routes/discovery.js — Runtime, Skill & Preflight Discovery API
 *
 * GET /api/runtimes          — list registered runtimes + capabilities
 * GET /api/skills            — list available skills from .claude/skills/
 * GET /api/health/preflight  — environment readiness check
 * GET /api/capabilities      — aggregate discovery: runtimes, stepTypes, models, providers
 * GET /api/health/providers  — provider health check (key + endpoint reachability)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const bb = require('../blackboard-server');
const { json } = bb;
const { STEP_OBJECTIVES, STEP_DEFAULT_CONTRACTS } = require('../context-compiler');
const { DEFAULT_CONTROLS, DEFAULT_STEP_PIPELINE } = require('../management');

let _skillsCache = null;
let _skillsCacheTs = 0;
const SKILLS_TTL_MS = 300_000;
let _preflightCache = null;
let _preflightCacheTs = 0;
const PREFLIGHT_TTL_MS = 30_000;
let _providersCache = null;
const _providerCache = new Map();
const PROVIDER_TTL_MS = 30_000;

function listRuntimes(deps) {
  const runtimes = [];
  for (const [id, rt] of Object.entries(deps.RUNTIMES)) {
    const caps = typeof rt.capabilities === 'function' ? rt.capabilities() : {};
    runtimes.push({
      id,
      installed: true,
      supportsSessionResume: caps.supportsSessionResume || false,
      supportsModelSelection: caps.supportsModelSelection || false,
    });
  }
  return runtimes;
}

function listSkills(projectRoot) {
  const now = Date.now();
  if (_skillsCache && (now - _skillsCacheTs) < SKILLS_TTL_MS) return _skillsCache;
  const skillsDir = path.join(projectRoot, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  const skills = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const content = fs.readFileSync(skillFile, 'utf8');
    const fm = parseFrontmatter(content);
    skills.push({
      id: entry.name,
      name: fm.name || entry.name,
      description: fm.description || '',
    });
  }
  _skillsCache = skills;
  _skillsCacheTs = now;
  return skills;
}

function parseFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    val = val.replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

function runPreflight(deps) {
  const now = Date.now();
  if (_preflightCache && (now - _preflightCacheTs) < PREFLIGHT_TTL_MS) {
    return _preflightCache;
  }

  const checks = {};

  checks.node = { ok: true, version: process.version };

  checks.git = probe('git --version', /git version ([\d.]+)/);
  checks.gh = probe('gh --version', /gh version ([\d.]+)/);

  if (checks.gh.ok) {
    try {
      const out = execSync('gh auth status 2>&1', { encoding: 'utf8', timeout: 5000 });
      const userMatch = out.match(/Logged in to .* account (\S+)/);
      checks.gh.authenticated = true;
      if (userMatch) checks.gh.user = userMatch[1];
    } catch {
      checks.gh.authenticated = false;
    }
  }

  checks.runtimes = {
    available: Object.keys(deps.RUNTIMES),
    count: Object.keys(deps.RUNTIMES).length,
  };

  checks.env = {
    KARVI_API_TOKEN: process.env.KARVI_API_TOKEN ? 'set' : 'not_set',
    KARVI_VAULT_KEY: process.env.KARVI_VAULT_KEY ? 'set' : 'not_set',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : 'not_set',
  };

  const warnings = [];
  if (checks.runtimes.count === 0) warnings.push('No agent runtimes available — dispatch will fail');
  if (!checks.gh.ok) warnings.push('gh CLI not found — step pipeline features limited');
  if (checks.env.KARVI_API_TOKEN === 'not_set') warnings.push('KARVI_API_TOKEN not set — API is open to anyone on the network');

  const ready = checks.runtimes.count > 0 && checks.git.ok;

  _preflightCache = { version: getVersion(), checks, ready, warnings };
  _preflightCacheTs = now;
  return _preflightCache;
}

function probe(cmd, versionRegex) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    const match = out.match(versionRegex);
    return { ok: true, version: match ? match[1] : 'unknown' };
  } catch {
    return { ok: false };
  }
}

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// --- Capabilities aggregation ---

function discoverProviders(projectRoot) {
  if (_providersCache) return _providersCache;
  const providers = [
    { id: 'anthropic', name: 'Anthropic', models: [], runtimes: ['openclaw', 'claude', 'claude-api'] },
  ];
  const configPath = path.join(projectRoot, 'opencode.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.provider && typeof config.provider === 'object') {
      for (const [id, def] of Object.entries(config.provider)) {
        providers.push({
          id,
          name: def.name || id,
          models: Object.keys(def.models || {}),
          runtimes: ['opencode'],
        });
      }
    }
  }
  _providersCache = providers;
  return providers;
}

function listStepTypes() {
  const timeouts = DEFAULT_CONTROLS.step_timeout_sec || {};
  const types = Object.keys(STEP_OBJECTIVES);
  if (!types.includes('execute')) types.push('execute');
  return types.map(type => ({
    type,
    objective: STEP_OBJECTIVES[type] || `Execute step: ${type}`,
    defaultTimeoutSec: timeouts[type] || timeouts.default || 300,
    contract: STEP_DEFAULT_CONTRACTS[type] || null,
  }));
}

function buildCapabilities(deps, helpers) {
  // Runtimes — full capabilities from each adapter
  const runtimes = [];
  for (const [id, rt] of Object.entries(deps.RUNTIMES)) {
    const caps = typeof rt.capabilities === 'function' ? rt.capabilities() : {};
    runtimes.push({ id, installed: true, capabilities: caps });
  }

  // Step types — from STEP_OBJECTIVES + defaults
  const stepTypes = listStepTypes();

  // Models — live from board controls
  const board = helpers.readBoard();
  const controls = board.controls || {};
  const models = {
    configured: controls.model_map || {},
    source: 'controls.model_map',
  };

  // Providers — cached, read from opencode.json + implicit
  const providers = discoverProviders(deps.ctx.dir);

  // Default pipeline
  const defaultPipeline = DEFAULT_STEP_PIPELINE.map(entry =>
    typeof entry === 'string' ? entry : entry.type
  );

  return { runtimes, stepTypes, models, providers, defaultPipeline };
}

// --- Provider Health Check ---

/**
 * 分類錯誤類型：auth / network / rate_limit / unknown
 */
function classifyError(err, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus === 429) return 'rate_limit';
  if (err) {
    const code = err.code || '';
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code)) return 'network';
    if (err.message && err.message.includes('timed out')) return 'network';
  }
  return 'unknown';
}

/**
 * HTTP(S) probe — 發 request 到外部 endpoint，回傳健康狀態。
 * @param {string} urlStr - 完整 URL
 * @param {object} headers - 額外 headers（如 Authorization）
 * @param {number} timeoutMs - 超時毫秒
 * @returns {Promise<{ok: boolean, latency_ms: number, http_status?: number, error_type?: string, message?: string}>}
 */
function httpProbe(urlStr, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      timeout: timeoutMs,
    };

    const req = mod.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const latency_ms = Date.now() - start;
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ ok: true, latency_ms, http_status: res.statusCode });
        } else {
          resolve({
            ok: false,
            latency_ms,
            http_status: res.statusCode,
            error_type: classifyError(null, res.statusCode),
            message: `HTTP ${res.statusCode}`,
          });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        latency_ms: Date.now() - start,
        error_type: 'network',
        message: `Request timed out after ${timeoutMs}ms`,
      });
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        latency_ms: Date.now() - start,
        error_type: classifyError(err, null),
        message: err.message,
      });
    });

    req.end();
  });
}

/**
 * 探測 CLI runtime（openclaw, claude, codex）是否已安裝。
 */
function probeCliRuntime(id) {
  const cmdMap = { openclaw: 'openclaw', claude: 'claude', codex: 'codex', opencode: 'opencode' };
  const cmd = cmdMap[id] || id;
  const whereCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
  let cli_installed = false;
  try {
    execSync(whereCmd, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    cli_installed = true;
  } catch { /* not found */ }
  return { cli_installed };
}

/**
 * 探測單個 provider 的健康狀態。
 * @returns {Promise<{id, type, status, latency_ms?, checks, error?}>}
 */
async function probeProvider(id, rt, deps) {
  const caps = typeof rt.capabilities === 'function' ? rt.capabilities() : {};
  const runtimeName = caps.runtime || id;

  // Claude API — 深度探測
  if (runtimeName === 'claude-api') {
    const checks = { key_configured: false, endpoint_reachable: false };
    // 檢查 vault 是否啟用
    const vault = deps.vault;
    const vaultEnabled = vault && typeof vault.isEnabled === 'function' && vault.isEnabled();
    checks.key_configured = vaultEnabled;
    if (!vaultEnabled) {
      return {
        id, type: 'api', status: 'unhealthy', checks,
        error: { type: 'not_configured', message: 'Vault not configured — cannot retrieve API key' },
      };
    }
    // Probe Anthropic API endpoint (GET to /v1/messages returns 405 Method Not Allowed — 但表示 endpoint 可達 + TLS 握手成功)
    const probeResult = await httpProbe('https://api.anthropic.com/v1/messages', {
      'anthropic-version': '2023-06-01',
    });
    // 405 = endpoint reachable (GET not allowed, but server responded)
    if (probeResult.ok || probeResult.http_status === 405) {
      checks.endpoint_reachable = true;
      return { id, type: 'api', status: 'healthy', latency_ms: probeResult.latency_ms, checks };
    }
    // auth 或 rate_limit 也表示 endpoint 可達
    if (probeResult.http_status === 401 || probeResult.http_status === 403) {
      checks.endpoint_reachable = true;
      return {
        id, type: 'api', status: 'degraded', latency_ms: probeResult.latency_ms, checks,
        error: { type: 'auth', message: 'API key may be invalid (endpoint reachable but auth failed)' },
      };
    }
    if (probeResult.http_status === 429) {
      checks.endpoint_reachable = true;
      return {
        id, type: 'api', status: 'degraded', latency_ms: probeResult.latency_ms, checks,
        error: { type: 'rate_limit', message: 'Rate limited by provider' },
      };
    }
    return {
      id, type: 'api', status: 'unhealthy', latency_ms: probeResult.latency_ms, checks,
      error: { type: probeResult.error_type || 'network', message: probeResult.message },
    };
  }

  // OpenCode — CLI + env + optional API probe
  if (runtimeName === 'opencode') {
    const cliCheck = probeCliRuntime('opencode');
    const envKey = process.env.T8STAR_API_KEY || process.env.OPENAI_API_KEY || '';
    const checks = {
      cli_installed: cliCheck.cli_installed,
      env_configured: envKey.length > 0,
    };
    // 嘗試探測 T8Star endpoint（如果有 config）
    if (envKey && process.env.T8STAR_API_KEY) {
      const probeResult = await httpProbe('https://ai.t8star.cn/v1/models', {
        'Authorization': `Bearer ${envKey}`,
      });
      checks.endpoint_reachable = probeResult.ok;
      if (!probeResult.ok) {
        const status = checks.cli_installed ? 'degraded' : 'unhealthy';
        return {
          id, type: 'hybrid', status, latency_ms: probeResult.latency_ms, checks,
          error: { type: probeResult.error_type || 'network', message: probeResult.message },
        };
      }
      return { id, type: 'hybrid', status: 'healthy', latency_ms: probeResult.latency_ms, checks };
    }
    const status = cliCheck.cli_installed ? (envKey ? 'healthy' : 'degraded') : 'unhealthy';
    const error = !cliCheck.cli_installed
      ? { type: 'not_installed', message: 'opencode CLI not found' }
      : (!envKey ? { type: 'not_configured', message: 'No API key configured (T8STAR_API_KEY or OPENAI_API_KEY)' } : undefined);
    return { id, type: 'hybrid', status, checks, ...(error ? { error } : {}) };
  }

  // CLI-only runtimes (openclaw, claude, codex)
  const cliCheck = probeCliRuntime(id);
  const envMap = { codex: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY' };
  const envVar = envMap[id];
  const checks = { cli_installed: cliCheck.cli_installed };
  if (envVar) checks.env_configured = !!process.env[envVar];

  const status = cliCheck.cli_installed ? 'healthy' : 'unhealthy';
  const error = !cliCheck.cli_installed
    ? { type: 'not_installed', message: `${id} CLI not found` }
    : undefined;
  return { id, type: 'cli', status, checks, ...(error ? { error } : {}) };
}

/**
 * 探測所有已註冊的 provider，支援 30 秒 cache。
 */
async function probeAllProviders(deps, filterId) {
  const ids = filterId ? [filterId] : Object.keys(deps.RUNTIMES);
  const results = [];

  for (const id of ids) {
    const rt = deps.RUNTIMES[id];
    if (!rt) {
      results.push({ id, type: 'unknown', status: 'unhealthy', checks: {}, error: { type: 'not_installed', message: `Runtime "${id}" not registered` } });
      continue;
    }

    // Cache check
    const now = Date.now();
    const cached = _providerCache.get(id);
    if (cached && (now - cached.ts) < PROVIDER_TTL_MS) {
      results.push(cached.result);
      continue;
    }

    const result = await probeProvider(id, rt, deps);
    _providerCache.set(id, { ts: now, result });
    results.push(result);
  }

  return results;
}

function urlMatch(url, pattern) {
  return url === pattern || url.startsWith(pattern + '?');
}

module.exports = function discoveryRoutes(req, res, helpers, deps) {
  if (req.method === 'GET' && urlMatch(req.url, '/api/runtimes')) {
    const runtimes = listRuntimes(deps);
    return json(res, 200, {
      runtimes,
      default: 'openclaw',
      available_count: runtimes.length,
    });
  }

  if (req.method === 'GET' && urlMatch(req.url, '/api/skills')) {
    const projectRoot = deps.ctx.dir;
    const skills = listSkills(projectRoot);
    return json(res, 200, { skills });
  }

  if (req.method === 'GET' && urlMatch(req.url, '/api/health/preflight')) {
    const result = runPreflight(deps);
    return json(res, 200, result);
  }

  if (req.method === 'GET' && urlMatch(req.url, '/api/capabilities')) {
    const result = buildCapabilities(deps, helpers);
    return json(res, 200, result);
  }

  if (req.method === 'GET' && urlMatch(req.url, '/api/health/providers')) {
    const url = new URL(req.url, 'http://localhost');
    const filterId = url.searchParams.get('id') || null;
    probeAllProviders(deps, filterId).then((providers) => {
      json(res, 200, { ts: helpers.nowIso(), providers });
    }).catch((err) => {
      json(res, 500, { error: err.message });
    });
    return;
  }

  return false;
};

module.exports.listRuntimes = listRuntimes;
module.exports.listSkills = listSkills;
module.exports.runPreflight = runPreflight;
module.exports.buildCapabilities = buildCapabilities;
module.exports.discoverProviders = discoverProviders;
module.exports.listStepTypes = listStepTypes;
module.exports.parseFrontmatter = parseFrontmatter;
module.exports.probeAllProviders = probeAllProviders;
module.exports.classifyError = classifyError;
module.exports._resetCaches = () => { _skillsCache = null; _skillsCacheTs = 0; _preflightCache = null; _preflightCacheTs = 0; _providersCache = null; _providerCache.clear(); };
