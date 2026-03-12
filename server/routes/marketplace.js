'use strict';
/**
 * routes/marketplace.js — Skill Marketplace API
 *
 * Skills are directories in server/skills/ with a manifest.json.
 *
 * GET  /api/skills           — list all marketplace skills with metadata
 * GET  /api/skills/:name     — get single skill detail
 * POST /api/skills/:name/install — install skill to active skills
 */
const fs = require('fs');
const path = require('path');
const bb = require('../blackboard-server');
const { json } = bb;
const { requireRole } = require('./_shared');

const MARKETPLACE_DIR = path.join(__dirname, '..', 'skills');
const CACHE_TTL_MS = 60_000;
let _cache = null;
let _cacheTs = 0;

const semver = require('./_semver');

function urlMatch(url, pattern) {
  return url === pattern || url.startsWith(pattern + '?');
}

function parseUrlParam(url, prefix) {
  const after = url.slice(prefix.length);
  const queryIdx = after.indexOf('?');
  return queryIdx < 0 ? after : after.slice(0, queryIdx);
}

function readManifest(skillDir) {
  const manifestPath = path.join(skillDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    if (!manifest.name || !manifest.version) return null;
    return {
      name: String(manifest.name),
      version: String(manifest.version),
      description: String(manifest.description || ''),
      tags: Array.isArray(manifest.tags) ? manifest.tags.map(String) : [],
      author: manifest.author ? String(manifest.author) : null,
      dependencies: manifest.dependencies || {},
    };
  } catch {
    return null;
  }
}

function listMarketplaceSkills() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;

  if (!fs.existsSync(MARKETPLACE_DIR)) {
    _cache = [];
    _cacheTs = now;
    return _cache;
  }

  const skills = [];
  for (const entry of fs.readdirSync(MARKETPLACE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(MARKETPLACE_DIR, entry.name);
    const manifest = readManifest(skillDir);
    if (!manifest) continue;

    const skillId = entry.name;
    const skillPath = path.join(MARKETPLACE_DIR, skillId);

    skills.push({
      id: skillId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      tags: manifest.tags,
      author: manifest.author,
      dependencies: manifest.dependencies,
      installed: false,
    });
  }

  _cache = skills;
  _cacheTs = now;
  return _cache;
}

function isSafeSkillId(skillId) {
  return skillId && /^[a-zA-Z0-9_-]+$/.test(skillId);
}

function getSkillDetail(skillId) {
  if (!isSafeSkillId(skillId)) return null;
  const skillDir = path.join(MARKETPLACE_DIR, skillId);
  if (!fs.existsSync(skillDir)) return null;

  const manifest = readManifest(skillDir);
  if (!manifest) return null;

  const files = [];
  function walk(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else {
        files.push(relPath);
      }
    }
  }
  walk(skillDir, '');

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  let readme = null;
  if (fs.existsSync(skillMdPath)) {
    readme = fs.readFileSync(skillMdPath, 'utf8');
  }

  return {
    id: skillId,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    tags: manifest.tags,
    author: manifest.author,
    dependencies: manifest.dependencies,
    files,
    readme,
    path: skillDir,
  };
}

function installSkill(skillId, projectRoot) {
  if (!isSafeSkillId(skillId)) {
    return { ok: false, error: 'invalid_skill_id', message: 'Skill ID must be alphanumeric, hyphens, or underscores only' };
  }
  const skillDir = path.join(MARKETPLACE_DIR, skillId);
  if (!fs.existsSync(skillDir)) {
    return { ok: false, error: 'skill_not_found', message: `Skill "${skillId}" not found in marketplace` };
  }

  const manifest = readManifest(skillDir);
  if (!manifest) {
    return { ok: false, error: 'invalid_manifest', message: `Skill "${skillId}" has invalid or missing manifest.json` };
  }

  const targetDir = path.join(projectRoot, '.claude', 'skills', skillId);

  if (fs.existsSync(targetDir)) {
    const targetManifestPath = path.join(targetDir, 'manifest.json');
    if (fs.existsSync(targetManifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(targetManifestPath, 'utf8'));
        if (existing.version && manifest.version) {
          const cmp = semver.compare(existing.version, manifest.version);
          if (cmp >= 0) {
            return { ok: false, error: 'already_installed', message: `Skill "${skillId}" already installed (v${existing.version})`, currentVersion: existing.version };
          }
        }
      } catch { /* ignore parse errors, proceed with install */ }
    }
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  copyDir(skillDir, targetDir);

  return {
    ok: true,
    skill: {
      id: skillId,
      name: manifest.name,
      version: manifest.version,
      installedTo: targetDir,
    },
  };
}

module.exports = function marketplaceRoutes(req, res, helpers, deps) {
  const projectRoot = deps.ctx.dir;

  if (req.method === 'GET' && urlMatch(req.url, '/api/skills')) {
    try {
      const skills = listMarketplaceSkills();
      const installedDir = path.join(projectRoot, '.claude', 'skills');
      const installedSkills = new Set();
      if (fs.existsSync(installedDir)) {
        for (const entry of fs.readdirSync(installedDir, { withFileTypes: true })) {
          if (entry.isDirectory()) installedSkills.add(entry.name);
        }
      }
      const result = skills.map(s => ({ ...s, installed: installedSkills.has(s.id) }));
      return json(res, 200, { skills: result, total: result.length });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  const detailMatch = req.method === 'GET' && req.url.match(/^\/api\/skills\/([^/?]+)$/);
  if (detailMatch) {
    try {
      const skillId = decodeURIComponent(detailMatch[1]);
      const skill = getSkillDetail(skillId);
      if (!skill) {
        return json(res, 404, { error: 'skill_not_found', message: `Skill "${skillId}" not found` });
      }
      const installedDir = path.join(projectRoot, '.claude', 'skills', skillId);
      skill.installed = fs.existsSync(installedDir);
      return json(res, 200, skill);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  const installMatch = req.method === 'POST' && req.url.match(/^\/api\/skills\/([^/?]+)\/install$/);
  if (installMatch) {
    if (requireRole(req, res, 'operator')) return;
    try {
      const skillId = decodeURIComponent(installMatch[1]);
      const result = installSkill(skillId, projectRoot);
      if (result.ok) {
        helpers.appendLog({ ts: helpers.nowIso(), event: 'skill_installed', skillId, version: result.skill.version });
        return json(res, 200, result);
      }
      const statusCode = result.error === 'skill_not_found' ? 404 : (result.error === 'already_installed' ? 200 : 400);
      return json(res, statusCode, result);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  return false;
};

module.exports.listMarketplaceSkills = listMarketplaceSkills;
module.exports.getSkillDetail = getSkillDetail;
module.exports.installSkill = installSkill;
module.exports._resetCache = () => { _cache = null; _cacheTs = 0; };
