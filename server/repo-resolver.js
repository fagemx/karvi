/**
 * repo-resolver.js — Resolve target repo root for task dispatch.
 *
 * Priority chain:
 *   1. task.target_repo (per-task override)
 *   2. board.controls.target_repo (board-level default)
 *   3. null (caller decides fallback — typically karvi root for dogfood mode)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * Resolve the repo root for a given task + board config.
 * @param {object} task  - Task object (may have .target_repo)
 * @param {object} board - Board object (may have .controls.target_repo)
 * @returns {string|null} Absolute path or null
 */
function resolveRepoRoot(task, board) {
  if (task?.target_repo) return path.resolve(task.target_repo);
  if (board?.controls?.target_repo) return path.resolve(board.controls.target_repo);
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

module.exports = { resolveRepoRoot, validateRepoRoot };
