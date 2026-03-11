'use strict';
/**
 * routes/discovery.js — Runtime, Skill & Preflight Discovery API
 *
 * GET /api/runtimes          — list registered runtimes + capabilities
 * GET /api/skills            — list available skills from .claude/skills/
 * GET /api/health/preflight  — environment readiness check
 * GET /api/capabilities      — aggregate discovery: runtimes, stepTypes, models, providers
 */
const fs = require('fs');
const path = require('path');
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

  return false;
};

module.exports.listRuntimes = listRuntimes;
module.exports.listSkills = listSkills;
module.exports.runPreflight = runPreflight;
module.exports.buildCapabilities = buildCapabilities;
module.exports.discoverProviders = discoverProviders;
module.exports.listStepTypes = listStepTypes;
module.exports.parseFrontmatter = parseFrontmatter;
module.exports._resetCaches = () => { _skillsCache = null; _skillsCacheTs = 0; _preflightCache = null; _preflightCacheTs = 0; _providersCache = null; };
