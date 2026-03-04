'use strict';
/**
 * routes/discovery.js — Runtime, Skill & Preflight Discovery API
 *
 * GET /api/runtimes          — list registered runtimes + capabilities
 * GET /api/skills            — list available skills from .claude/skills/
 * GET /api/health/preflight  — environment readiness check
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const bb = require('../blackboard-server');
const { json } = bb;

let _skillsCache = null;
let _preflightCache = null;
let _preflightCacheTs = 0;
const PREFLIGHT_TTL_MS = 30_000;

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
  if (_skillsCache) return _skillsCache;
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
  return skills;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
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

module.exports = function discoveryRoutes(req, res, helpers, deps) {
  if (req.method === 'GET' && req.url === '/api/runtimes') {
    const runtimes = listRuntimes(deps);
    return json(res, 200, {
      runtimes,
      default: 'openclaw',
      available_count: runtimes.length,
    });
  }

  if (req.method === 'GET' && req.url === '/api/skills') {
    const projectRoot = deps.ctx.dir;
    const skills = listSkills(projectRoot);
    return json(res, 200, { skills });
  }

  if (req.method === 'GET' && req.url === '/api/health/preflight') {
    const result = runPreflight(deps);
    return json(res, 200, result);
  }

  return false;
};

module.exports.listRuntimes = listRuntimes;
module.exports.listSkills = listSkills;
module.exports.runPreflight = runPreflight;
