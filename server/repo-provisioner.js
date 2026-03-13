/**
 * repo-provisioner.js — Automatic repo provisioning for SaaS tasks.
 *
 * Manages bare clone repos and per-task worktrees for paid users.
 * Bare clones live in {dataRoot}/repos/{owner}/{repo}.git
 * Worktrees live in {dataRoot}/worktrees/{taskId}
 *
 * 零外部依賴 — 僅使用 Node.js 內建模組 + git CLI
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Error sanitization ---

/**
 * Strip PAT tokens from git error messages to prevent leaking credentials.
 * @param {string} msg
 * @returns {string}
 */
function sanitizeGitMessage(msg) {
  if (!msg) return msg;
  return msg.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}

// --- URL parsing ---

const GITHUB_URL_RE = /^(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/;
const GITHUB_SLUG_RE = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/;

/**
 * Parse a GitHub repo identifier (URL or slug) into { owner, repo }.
 * @param {string} input - GitHub URL or owner/repo slug
 * @returns {{ owner: string, repo: string } | null}
 */
function parseGitHubRepo(input) {
  if (!input || typeof input !== 'string') return null;
  const urlMatch = input.trim().match(GITHUB_URL_RE);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  const slugMatch = input.trim().match(GITHUB_SLUG_RE);
  if (slugMatch && !path.isAbsolute(input)) return { owner: slugMatch[1], repo: slugMatch[2] };
  return null;
}

/**
 * Build HTTPS clone URL with optional token for authentication.
 * @param {string} owner
 * @param {string} repo
 * @param {string} [token] - GitHub PAT for private repos
 * @returns {string}
 */
function buildCloneUrl(owner, repo, token) {
  if (token) {
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

// --- Bare clone management ---

/**
 * Get the path where a bare clone should live.
 * @param {string} dataRoot - Root data directory (e.g. /data/users/alice)
 * @param {string} owner
 * @param {string} repo
 * @returns {string}
 */
function bareRepoPath(dataRoot, owner, repo) {
  return path.join(dataRoot, 'repos', owner, `${repo}.git`);
}

/**
 * Check if a bare clone already exists and is valid.
 * @param {string} barePath
 * @returns {boolean}
 */
function isBareRepoValid(barePath) {
  if (!fs.existsSync(barePath)) return false;
  try {
    execFileSync('git', ['rev-parse', '--is-bare-repository'], {
      cwd: barePath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone a repo as bare (or fetch if already exists).
 * @param {object} opts
 * @param {string} opts.dataRoot - Root data directory
 * @param {string} opts.owner - GitHub owner
 * @param {string} opts.repo - GitHub repo name
 * @param {string} [opts.token] - GitHub PAT
 * @param {string} [opts.branch] - Default branch to track (defaults to remote HEAD)
 * @returns {{ barePath: string, created: boolean }}
 */
function ensureBareClone(opts) {
  const { dataRoot, owner, repo, token, branch } = opts;
  const barePath = bareRepoPath(dataRoot, owner, repo);

  if (isBareRepoValid(barePath)) {
    // Fetch latest
    const fetchUrl = buildCloneUrl(owner, repo, token);
    try {
      execFileSync('git', ['fetch', '--prune', fetchUrl, '+refs/heads/*:refs/heads/*'], {
        cwd: barePath,
        timeout: 120000,
        stdio: 'pipe',
      });
      console.log(`[repo-provisioner] fetched updates for ${owner}/${repo}`);
    } catch (err) {
      console.warn(`[repo-provisioner] fetch failed for ${owner}/${repo}: ${sanitizeGitMessage(err.message)}`);
    }
    return { barePath, created: false };
  }

  // Clone bare
  fs.mkdirSync(path.dirname(barePath), { recursive: true });
  const cloneUrl = buildCloneUrl(owner, repo, token);
  const args = ['clone', '--bare'];
  if (branch) args.push('--branch', branch);
  args.push(cloneUrl, barePath);

  execFileSync('git', args, {
    timeout: 300000, // 5 min for large repos
    stdio: 'pipe',
  });

  console.log(`[repo-provisioner] bare clone created: ${owner}/${repo} → ${barePath}`);
  return { barePath, created: true };
}

// --- Per-task worktree from bare clone ---

/**
 * Create a worktree from a bare clone for a specific task.
 * @param {object} opts
 * @param {string} opts.barePath - Path to bare repo
 * @param {string} opts.dataRoot - Root data directory
 * @param {string} opts.taskId - Task identifier
 * @param {string} [opts.baseBranch] - Branch to base the worktree on (default: HEAD)
 * @returns {{ worktreePath: string, branch: string }}
 */
function createWorktreeFromBare(opts) {
  const { barePath, dataRoot, taskId, baseBranch } = opts;
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const worktreePath = path.join(dataRoot, 'worktrees', sanitized);
  const branch = `agent/${sanitized}`;

  if (fs.existsSync(worktreePath)) {
    const gitMarker = path.join(worktreePath, '.git');
    if (fs.existsSync(gitMarker)) {
      return { worktreePath, branch };
    }
    // Broken — remove and recreate
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Clean up ghost branch
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: barePath, stdio: 'pipe', timeout: 5000,
    });
  } catch {
    // Branch doesn't exist — expected
  }

  // Prune stale worktrees
  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: barePath, stdio: 'pipe', timeout: 5000,
    });
  } catch {
    // Non-fatal
  }

  // Determine base commit
  const base = baseBranch || 'HEAD';
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch, base], {
    cwd: barePath,
    stdio: 'pipe',
    timeout: 30000,
  });

  console.log(`[repo-provisioner] worktree created: ${taskId} → ${worktreePath} (branch: ${branch})`);
  return { worktreePath, branch };
}

/**
 * Remove a worktree created from a bare clone.
 * @param {string} barePath - Path to bare repo
 * @param {string} dataRoot - Root data directory
 * @param {string} taskId
 */
function removeWorktreeFromBare(barePath, dataRoot, taskId) {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const worktreePath = path.join(dataRoot, 'worktrees', sanitized);
  const branch = `agent/${sanitized}`;

  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: barePath, stdio: 'pipe', timeout: 5000,
    });
  } catch {
    // Non-fatal
  }

  if (fs.existsSync(worktreePath)) {
    try {
      execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
        cwd: barePath, stdio: 'pipe', timeout: 15000,
      });
    } catch {
      try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
  }

  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: barePath, stdio: 'pipe', timeout: 5000,
    });
  } catch {
    // Branch may not exist
  }
}

// --- Push + PR ---

/**
 * Push a branch from a worktree to the remote.
 * @param {string} worktreePath
 * @param {string} branch
 * @param {string} [token] - GitHub PAT for push authentication
 * @param {string} owner
 * @param {string} repo
 */
function pushBranch(worktreePath, branch, token, owner, repo) {
  const pushUrl = buildCloneUrl(owner, repo, token);
  execFileSync('git', ['push', pushUrl, `${branch}:${branch}`], {
    cwd: worktreePath,
    stdio: 'pipe',
    timeout: 60000,
  });
  console.log(`[repo-provisioner] pushed branch ${branch} to ${owner}/${repo}`);
}

/**
 * Check if a worktree has any uncommitted changes or unpushed commits.
 * @param {string} worktreePath
 * @returns {{ hasChanges: boolean, hasUnpushed: boolean }}
 */
function worktreeStatus(worktreePath) {
  let hasChanges = false;
  let hasUnpushed = false;

  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
    hasChanges = status.length > 0;
  } catch {
    // Assume no changes if status fails
  }

  try {
    const log = execFileSync('git', ['log', '@{u}..HEAD', '--oneline'], {
      cwd: worktreePath, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
    hasUnpushed = log.length > 0;
  } catch {
    // No upstream or error — might be unpushed
    hasUnpushed = true;
  }

  return { hasChanges, hasUnpushed };
}

// --- Repo registry (JSON file) ---

/**
 * Read the repo registry for a data root.
 * @param {string} dataRoot
 * @returns {object} Registry object { repos: { "owner/repo": { ... } } }
 */
function readRegistry(dataRoot) {
  const regPath = path.join(dataRoot, 'repo-registry.json');
  try {
    const raw = fs.readFileSync(regPath, 'utf8');
    const reg = JSON.parse(raw);
    // 記錄 mtime 用於 optimistic lock
    reg._mtime = fs.statSync(regPath).mtimeMs;
    return reg;
  } catch {
    return { repos: {} };
  }
}

/**
 * Write the repo registry with optimistic lock.
 * 如果 registry._mtime 存在，寫入前重新檢查檔案 mtime，
 * 不一致表示被其他 process 修改過，拋錯避免覆蓋。
 * @param {string} dataRoot
 * @param {object} registry
 */
function writeRegistry(dataRoot, registry) {
  const regPath = path.join(dataRoot, 'repo-registry.json');

  // Optimistic lock: 檢查 mtime 是否被其他 process 改過
  if (registry._mtime) {
    try {
      const currentMtime = fs.statSync(regPath).mtimeMs;
      if (currentMtime !== registry._mtime) {
        throw new Error('Registry was modified by another process (optimistic lock conflict)');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // 檔案被刪了 — 繼續寫入
    }
  }

  const toWrite = { ...registry };
  delete toWrite._mtime;

  const tmpPath = regPath + '.tmp';
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2));
  fs.renameSync(tmpPath, regPath);
}

/**
 * Register a repo in the registry after cloning.
 * @param {string} dataRoot
 * @param {string} owner
 * @param {string} repo
 * @param {object} meta - Additional metadata
 */
function registerRepo(dataRoot, owner, repo, meta = {}) {
  const registry = readRegistry(dataRoot);
  const slug = `${owner}/${repo}`;
  registry.repos[slug] = {
    owner,
    repo,
    slug,
    barePath: bareRepoPath(dataRoot, owner, repo),
    branch: meta.branch || 'main',
    addedAt: meta.addedAt || new Date().toISOString(),
    lastFetchedAt: new Date().toISOString(),
    ...meta,
  };
  writeRegistry(dataRoot, registry);
  return registry.repos[slug];
}

/**
 * Remove a repo from registry and delete bare clone.
 * @param {string} dataRoot
 * @param {string} owner
 * @param {string} repo
 */
function unregisterRepo(dataRoot, owner, repo) {
  const registry = readRegistry(dataRoot);
  const slug = `${owner}/${repo}`;
  delete registry.repos[slug];
  writeRegistry(dataRoot, registry);

  // Delete bare clone directory
  const barePath = bareRepoPath(dataRoot, owner, repo);
  if (fs.existsSync(barePath)) {
    fs.rmSync(barePath, { recursive: true, force: true });
    console.log(`[repo-provisioner] deleted bare clone: ${barePath}`);
  }
}

/**
 * Get a registered repo's info.
 * @param {string} dataRoot
 * @param {string} owner
 * @param {string} repo
 * @returns {object|null}
 */
function getRepo(dataRoot, owner, repo) {
  const registry = readRegistry(dataRoot);
  return registry.repos[`${owner}/${repo}`] || null;
}

/**
 * List all registered repos.
 * @param {string} dataRoot
 * @returns {Array}
 */
function listRepos(dataRoot) {
  const registry = readRegistry(dataRoot);
  return Object.values(registry.repos);
}

// --- High-level provisioning ---

/**
 * Provision a repo for task execution.
 * Clones if needed, creates worktree, returns workingDir.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot - User data directory
 * @param {string} opts.repoUrl - GitHub URL or slug
 * @param {string} opts.taskId - Task identifier
 * @param {string} [opts.token] - GitHub PAT
 * @param {string} [opts.branch] - Base branch
 * @returns {{ worktreePath: string, branch: string, barePath: string }}
 */
function provisionForTask(opts) {
  const { dataRoot, repoUrl, taskId, token, branch } = opts;

  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub repo: ${repoUrl}. Expected URL or owner/repo slug.`);
  }

  // Step 1: Ensure bare clone exists
  const { barePath } = ensureBareClone({
    dataRoot,
    owner: parsed.owner,
    repo: parsed.repo,
    token,
    branch,
  });

  // Step 2: Register in repo registry
  registerRepo(dataRoot, parsed.owner, parsed.repo, { branch: branch || 'main' });

  // Step 3: Create worktree from bare clone
  const wt = createWorktreeFromBare({
    barePath,
    dataRoot,
    taskId,
    baseBranch: branch || null,
  });

  return { ...wt, barePath, owner: parsed.owner, repo: parsed.repo };
}

/**
 * Clean up a provisioned task worktree.
 * Optionally push changes before removal.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} opts.repoUrl - GitHub URL or slug
 * @param {string} opts.taskId
 * @param {boolean} [opts.pushBeforeRemove] - Push branch before removing worktree
 * @param {string} [opts.token] - GitHub PAT for push
 */
function cleanupTask(opts) {
  const { dataRoot, repoUrl, taskId, pushBeforeRemove, token } = opts;
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) return;

  const barePath = bareRepoPath(dataRoot, parsed.owner, parsed.repo);
  if (!fs.existsSync(barePath)) return;

  if (pushBeforeRemove && token) {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const worktreePath = path.join(dataRoot, 'worktrees', sanitized);
    const branch = `agent/${sanitized}`;
    if (fs.existsSync(worktreePath)) {
      try {
        pushBranch(worktreePath, branch, token, parsed.owner, parsed.repo);
      } catch (err) {
        console.error(`[repo-provisioner] push before cleanup failed for ${taskId}: ${sanitizeGitMessage(err.message)}`);
      }
    }
  }

  removeWorktreeFromBare(barePath, dataRoot, taskId);
}

module.exports = {
  sanitizeGitMessage,
  parseGitHubRepo,
  buildCloneUrl,
  bareRepoPath,
  isBareRepoValid,
  ensureBareClone,
  createWorktreeFromBare,
  removeWorktreeFromBare,
  pushBranch,
  worktreeStatus,
  readRegistry,
  writeRegistry,
  registerRepo,
  unregisterRepo,
  getRepo,
  listRepos,
  provisionForTask,
  cleanupTask,
};
