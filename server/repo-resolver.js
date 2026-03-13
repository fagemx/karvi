/**
 * repo-resolver.js — Resolve target repo root for task dispatch.
 *
 * Priority chain:
 *   1. task.target_repo (per-task override)
 *   2. board.controls.target_repo (board-level default)
 *   3. null (caller decides fallback — typically karvi root for dogfood mode)
 *
 * Values can be absolute paths or GitHub slugs (owner/repo).
 * Slugs are resolved via board.controls.repo_map, then repo-provisioner registry.
 *
 * GitHub URLs (https://github.com/owner/repo) are also supported and resolved
 * the same way as slugs.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const provisioner = require('./repo-provisioner');

const SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function looksLikeSlug(str) {
  return SLUG_RE.test(str) && !path.isAbsolute(str);
}

/**
 * Resolve a single target_repo value to an absolute path.
 * If the value is a GitHub slug, look it up in repo_map first,
 * then fall back to repo-provisioner registry (for SaaS bare clones).
 * Also handles full GitHub URLs (https://github.com/owner/repo).
 * @returns {string|null} Absolute path, or null if not found
 */
function resolveValue(val, repoMap) {
  if (!val) return null;
  if (path.isAbsolute(val)) return val;

  // Try GitHub URL first
  const parsed = provisioner.parseGitHubRepo(val);
  if (parsed) {
    const slug = `${parsed.owner}/${parsed.repo}`;
    // 1. repo_map (explicit local path mapping)
    const mapped = repoMap[slug];
    if (mapped) return path.resolve(mapped);
    // 2. Provisioner registry (SaaS bare clones)
    const dataRoot = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
    const entry = provisioner.getRepo(dataRoot, parsed.owner, parsed.repo);
    if (entry?.barePath && fs.existsSync(entry.barePath)) return entry.barePath;
    return null;
  }

  if (looksLikeSlug(val)) {
    // 1. repo_map
    const mapped = repoMap[val];
    if (mapped) return path.resolve(mapped);
    // 2. Provisioner registry
    const parts = val.split('/');
    const dataRoot = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
    const entry = provisioner.getRepo(dataRoot, parts[0], parts[1]);
    if (entry?.barePath && fs.existsSync(entry.barePath)) return entry.barePath;
    return null;
  }

  // Reject ambiguous values (not absolute, not slug).
  // Common cause: unescaped Windows backslashes → "C:\ai_agent\edda" becomes "C:ai_agentedda"
  console.warn('[repo-resolver] rejecting ambiguous target_repo: %s (use absolute path or owner/repo slug)', val);
  return null;
}

/**
 * Resolve the repo root for a given task + board config.
 * @param {object} task  - Task object (may have .target_repo)
 * @param {object} board - Board object (may have .controls.target_repo, .controls.repo_map)
 * @returns {string|null} Absolute path or null
 */
function resolveRepoRoot(task, board) {
  const repoMap = board?.controls?.repo_map || {};
  const fromTask = resolveValue(task?.target_repo, repoMap);
  if (fromTask) return fromTask;
  const fromBoard = resolveValue(board?.controls?.target_repo, repoMap);
  if (fromBoard) return fromBoard;
  return null;
}

/**
 * Validate that a resolved path is a valid git repository.
 * Optionally verify git remote matches the expected source.repo identifier.
 * @param {string} resolvedPath - Absolute path to check
 * @param {string} [expectedRepo] - GitHub "owner/name" identifier
 * @returns {{ valid: boolean, error?: string }}
 */
function validateRepoRoot(resolvedPath, expectedRepo) {
  if (!resolvedPath) return { valid: false, error: 'No target_repo configured' };
  if (!fs.existsSync(resolvedPath)) return { valid: false, error: `Path not found: ${resolvedPath}` };

  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: resolvedPath,
      timeout: 5000,
      stdio: 'pipe',
    });
  } catch {
    return { valid: false, error: `Not a git repo: ${resolvedPath}` };
  }

  if (expectedRepo) {
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: resolvedPath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: 'pipe',
      }).trim();
      if (!remote.includes(expectedRepo)) {
        return { valid: false, error: `Remote mismatch: expected ${expectedRepo}, got ${remote}` };
      }
    } catch {
      // No remote configured — acceptable for local-only repos
    }
  }

  return { valid: true };
}

/**
 * Check if a target_repo value looks like a GitHub URL or slug
 * that could be auto-provisioned (as opposed to a local path).
 * @param {string} val
 * @returns {boolean}
 */
function isProvisionable(val) {
  if (!val) return false;
  return !!provisioner.parseGitHubRepo(val);
}

module.exports = { resolveRepoRoot, validateRepoRoot, looksLikeSlug, resolveValue, isProvisionable };
