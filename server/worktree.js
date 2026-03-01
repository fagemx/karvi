/**
 * worktree.js — Git worktree helpers for parallel task execution.
 *
 * Each GH task gets its own worktree so agents can run concurrently
 * without git conflicts. Worktrees are created under .claude/worktrees/<taskId>.
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function sanitizeId(taskId) {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Create a git worktree for a task.
 * If the worktree already exists (e.g., resume after crash), returns existing path.
 * @param {string} repoRoot — main repo root path
 * @param {string} taskId — task identifier (e.g., "GH-155")
 * @returns {{ worktreePath: string, branch: string }}
 */
function createWorktree(repoRoot, taskId) {
  const sanitized = sanitizeId(taskId);
  const worktreePath = path.join(repoRoot, '.claude', 'worktrees', sanitized);
  const branch = `agent/${sanitized}`;

  if (fs.existsSync(worktreePath)) {
    return { worktreePath, branch };
  }

  // Ensure parent dir exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  execSync(`git worktree add "${worktreePath}" -b "${branch}"`, {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 30000,
  });

  // Copy .claude/settings.json into worktree so agents inherit project permissions.
  // Without this, Claude Code headless mode has no project-level allow-list and
  // blocks all Bash tools (gh, curl, etc.) requiring user approval that never comes.
  const srcSettings = path.join(repoRoot, '.claude', 'settings.json');
  if (fs.existsSync(srcSettings)) {
    const destDir = path.join(worktreePath, '.claude');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcSettings, path.join(destDir, 'settings.json'));
  }

  return { worktreePath, branch };
}

/**
 * Remove a git worktree for a task. Best-effort, does not throw.
 * @param {string} repoRoot
 * @param {string} taskId
 */
function removeWorktree(repoRoot, taskId) {
  const sanitized = sanitizeId(taskId);
  const worktreePath = path.join(repoRoot, '.claude', 'worktrees', sanitized);
  const branch = `agent/${sanitized}`;

  if (!fs.existsSync(worktreePath)) return;

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 15000,
    });
  } catch (err) {
    console.error(`[worktree] remove failed for ${taskId}:`, err.message);
  }

  try {
    execSync(`git branch -D "${branch}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    // Branch may not exist or already deleted
  }
}

/**
 * Count active worktrees under .claude/worktrees/.
 * @param {string} repoRoot
 * @returns {number}
 */
function countActiveWorktrees(repoRoot) {
  const wtDir = path.join(repoRoot, '.claude', 'worktrees');
  if (!fs.existsSync(wtDir)) return 0;
  try {
    return fs.readdirSync(wtDir).filter(f =>
      fs.statSync(path.join(wtDir, f)).isDirectory()
    ).length;
  } catch {
    return 0;
  }
}

module.exports = { createWorktree, removeWorktree, countActiveWorktrees, sanitizeId };
