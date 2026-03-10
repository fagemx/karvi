/**
 * worktree.js — Git worktree helpers for parallel task execution.
 *
 * Each GH task gets its own worktree so agents can run concurrently
 * without git conflicts. Worktrees are created under .claude/worktrees/<taskId>.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Recursively copy a directory. Overwrites existing files.
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function sanitizeId(taskId) {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Copy essential .claude/ files into a worktree.
 * Always overwrites to ensure latest versions from main repo.
 */
function copyEssentialFiles(repoRoot, worktreePath) {
  const destClaudeDir = path.join(worktreePath, '.claude');
  fs.mkdirSync(destClaudeDir, { recursive: true });

  // settings.json — agent permissions
  const srcSettings = path.join(repoRoot, '.claude', 'settings.json');
  if (fs.existsSync(srcSettings)) {
    fs.copyFileSync(srcSettings, path.join(destClaudeDir, 'settings.json'));
  }

  // skills/ — agent skills (always overwrite to pick up updates)
  const srcSkills = path.join(repoRoot, '.claude', 'skills');
  if (fs.existsSync(srcSkills)) {
    copyDirSync(srcSkills, path.join(destClaudeDir, 'skills'));
  }

  // CLAUDE.md — project instructions
  const srcClaudeMd = path.join(repoRoot, '.claude', 'CLAUDE.md');
  if (fs.existsSync(srcClaudeMd)) {
    fs.copyFileSync(srcClaudeMd, path.join(destClaudeDir, 'CLAUDE.md'));
  }

  // AGENTS.md — opencode agent rules
  const srcAgentsMd = path.join(repoRoot, 'AGENTS.md');
  const destAgentsMd = path.join(worktreePath, 'AGENTS.md');
  if (fs.existsSync(srcAgentsMd)) {
    fs.copyFileSync(srcAgentsMd, destAgentsMd);
  }
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
    // Validate it's a real git worktree (has .git file), not an empty/broken dir
    const gitMarker = path.join(worktreePath, '.git');
    if (fs.existsSync(gitMarker)) {
      // Existing valid worktree — ensure essential files are up-to-date
      copyEssentialFiles(repoRoot, worktreePath);
      return { worktreePath, branch };
    }
    // Broken worktree — remove empty dir and recreate
    console.log(`[worktree] broken worktree detected for ${taskId} (no .git marker), recreating`);
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch (err) {
      console.error(`[worktree] failed to remove broken worktree dir for ${taskId}:`, err.message);
    }
  }

  // Ensure parent dir exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Clean up ghost branch from previous crashed run (prevents "branch already exists" error)
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe', timeout: 5000 });
    console.log(`[worktree] cleaned up ghost branch ${branch}`);
  } catch (err) {
    // Branch doesn't exist — expected for first run
    console.log(`[worktree] ghost branch cleanup skipped for ${branch}:`, err.message);
  }

  // Prune stale worktree references that point to deleted directories
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe', timeout: 5000 });
  } catch (err) {
    // Non-fatal
    console.warn('[worktree] prune before add failed:', err.message);
  }

  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 30000,
  });

  copyEssentialFiles(repoRoot, worktreePath);
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

  // Prune stale worktree references first
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe', timeout: 5000 });
  } catch (err) {
    console.warn('[worktree] prune before remove failed:', err.message);
  }

  // Remove worktree directory if it exists
  if (fs.existsSync(worktreePath)) {
    try {
      execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
        cwd: repoRoot,
        stdio: 'pipe',
        timeout: 15000,
      });
    } catch (err) {
      console.error(`[worktree] git worktree remove failed for ${taskId}:`, err.message);
      // Fallback: force-delete the directory so no broken empty dir remains
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error(`[worktree] fallback directory cleanup failed for ${taskId}:`, cleanupErr.message);
      }
    }
  } else {
    // Directory doesn't exist but git might still have a stale worktree ref
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe', timeout: 5000 });
    } catch (err) {
      console.warn('[worktree] prune for missing worktree failed:', err.message);
    }
  }

  // Always try to delete branch (even if worktree remove failed/skipped)
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch (err) {
    // Branch may not exist or already deleted
    console.log(`[worktree] branch delete skipped for ${branch}:`, err.message);
  }
}

module.exports = { createWorktree, removeWorktree, sanitizeId };
