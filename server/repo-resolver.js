/**
 * repo-resolver.js — Resolve target repo root for task dispatch.
 *
 * Priority chain:
 *   1. task.target_repo (per-task override)
 *   2. board.controls.target_repo (board-level default)
 *   3. null (caller decides fallback — typically karvi root for dogfood mode)
 *
 * Values can be absolute paths or GitHub slugs (owner/repo).
 * Slugs are resolved via board.controls.repo_map.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function looksLikeSlug(str) {
  return SLUG_RE.test(str) && !path.isAbsolute(str);
}

/**
 * Resolve a single target_repo value to an absolute path.
 * If the value is a GitHub slug, look it up in repo_map.
 * @returns {string|null} Absolute path, or null if slug not in map
 */
function resolveValue(val, repoMap) {
  if (!val) return null;
  if (path.isAbsolute(val)) return val;
  if (looksLikeSlug(val)) {
    const mapped = repoMap[val];
    return mapped ? path.resolve(mapped) : null;
  }
  return path.resolve(val);
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

module.exports = { resolveRepoRoot, validateRepoRoot, looksLikeSlug, resolveValue };
