/**
 * post-check.js — Post-execution verification layer
 *
 * Scope guard, contract validation, auto-finalize, and git status checks.
 * Extracted from step-worker.js (issue #473) for SRP compliance.
 */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Check working directory for uncommitted git changes.
 * Returns { hasUncommittedChanges, files }.
 * If the directory is not a git repo, returns a clean result (no-op).
 */
async function runPostCheck(workDir) {
  const opts = { cwd: workDir, encoding: 'utf8', timeout: 10000 };
  const result = { hasUncommittedChanges: false, files: [], hasNewCommit: false };

  if (!workDir) return result;

  try {
    const porcelain = execSync('git status --porcelain', opts).trim();
    if (porcelain) {
      result.hasUncommittedChanges = true;
      result.files = porcelain.split('\n').map(l => l.trim()).filter(Boolean);
    }
  } catch (err) {
    // Not a git repo or git not available — skip post-check
    return result;
  }

  return result;
}

/**
 * Attempt to commit all uncommitted changes on behalf of the agent.
 * Returns { ok, commitHash } on success or { ok, error } on failure.
 */
function autoFinalize(workDir, envelope) {
  const opts = { cwd: workDir, encoding: 'utf8', timeout: 30000 };
  try {
    execSync('git add -A', opts);
    const msg = `chore: auto-finalize step ${envelope.step_id} for ${envelope.task_id}`;
    execFileSync('git', ['commit', '-m', msg], opts);
    const hash = execSync('git log -1 --format=%h', opts).trim();

    // Try to push if on a branch
    let pushed = false;
    try {
      execSync('git push', opts);
      pushed = true;
    } catch {
      // Push failed — try setting upstream
      try {
        const branch = execSync('git branch --show-current', opts).trim();
        if (branch) {
          execFileSync('git', ['push', '-u', 'origin', branch], opts);
          pushed = true;
        }
      } catch {
        // Push truly failed — still consider commit as success
      }
    }

    // If push succeeded and this is an implement step, try to create PR (GH-329)
    let prUrl = null;
    if (pushed && envelope.step_type === 'implement') {
      try {
        const branch = execSync('git branch --show-current', opts).trim();
        // Check if PR already exists
        const existing = execFileSync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1'], opts).trim();
        const prs = JSON.parse(existing || '[]');
        if (prs.length > 0) {
          prUrl = prs[0].url;
        } else {
          const title = `${envelope.task_id}: auto-finalized implementation`;
          const body = `Auto-created PR for ${envelope.task_id}.\\n\\nAgent wrote code but did not complete git workflow. Auto-finalized by Karvi step-worker.`;
          const out = execFileSync('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch], opts).trim();
          prUrl = out; // gh pr create outputs the PR URL
        }
      } catch (prErr) {
        console.warn(`[step-worker] auto-finalize PR creation failed for ${envelope.task_id}:`, prErr.message?.slice(0, 200));
      }
    }

    return { ok: true, commitHash: hash, prUrl };
  } catch (err) {
    return { ok: false, error: err.message?.slice(0, 200) || 'unknown' };
  }
}

/**
 * Revert files that fall outside the task's scope config.
 * Default deny: .claude/** (most common agent scope creep target).
 * Returns { reverted: string[], kept: string[] }.
 */
function applyScopeGuard(workDir, scopeConfig, changedFiles) {
  const DEFAULT_DENY = ['.claude/**'];
  const deny = (scopeConfig?.deny || []).concat(DEFAULT_DENY);
  const allow = scopeConfig?.allow || [];

  const reverted = [];
  const kept = [];

  for (const entry of changedFiles) {
    // git status --porcelain format: "XY filename" (first 2 chars = status, char 3 = space)
    const statusCode = entry.slice(0, 2).trim();
    const filePath = entry.slice(3);

    if (isOutOfScope(filePath, allow, deny)) {
      revertFile(workDir, filePath, statusCode);
      reverted.push(filePath);
    } else {
      kept.push(filePath);
    }
  }

  return { reverted, kept };
}

function isOutOfScope(filePath, allow, deny) {
  // Deny takes priority
  for (const pattern of deny) {
    if (path.matchesGlob(filePath, pattern)) return true;
  }
  // If allow list exists, file must match at least one
  if (allow.length > 0) {
    return !allow.some(pattern => path.matchesGlob(filePath, pattern));
  }
  return false;
}

function revertFile(workDir, filePath, statusCode) {
  const opts = { cwd: workDir, encoding: 'utf8', timeout: 5000 };

  if (statusCode === '??' || statusCode === 'A') {
    // Untracked or newly added — delete
    const fullPath = path.join(workDir, filePath);
    if (fs.existsSync(fullPath)) {
      fs.statSync(fullPath).isDirectory()
        ? fs.rmSync(fullPath, { recursive: true })
        : fs.unlinkSync(fullPath);
    }
  } else {
    // Modified or deleted — restore from HEAD
    execFileSync('git', ['checkout', '--', filePath], opts);
  }
}

/**
 * Validate a deliverable contract after agent reports success.
 * Returns { ok: true } or { ok: false, reason: "..." }.
 *
 * @param {object} contract      - { deliverable, acceptance, file_path? }
 * @param {object} agentOutput   - { status, summary, payload, failure }
 * @param {object} postCheckResult - From runPostCheck()
 * @param {string} workDir       - Working directory
 */
function validateContract(contract, agentOutput, postCheckResult, workDir) {
  if (!contract || !contract.deliverable) return { ok: true };

  switch (contract.deliverable) {
    case 'pr':             return validatePrDeliverable(agentOutput, workDir);
    case 'file':           return validateFileDeliverable(contract, workDir);
    case 'artifact':       return validateArtifactDeliverable(agentOutput);
    case 'command_result': return validateCommandResultDeliverable(agentOutput);
    case 'issue':          return validateIssueDeliverable(agentOutput);
    default:               return { ok: true }; // unknown type → pass (forward-compat)
  }
}

function validatePrDeliverable(agentOutput, workDir) {
  if (!workDir) return { ok: false, reason: 'deliverable pr: no working directory' };
  const opts = { cwd: workDir, encoding: 'utf8', timeout: 15000 };

  // Check for new commits
  try {
    const log = execSync('git log --oneline -1', opts).trim();
    if (!log) return { ok: false, reason: 'deliverable pr: no commits found' };
  } catch {
    return { ok: false, reason: 'deliverable pr: git log failed (not a git repo?)' };
  }

  // Check for PR URL in agent summary or try gh pr list
  const text = agentOutput.summary || '';
  const hasPrUrl = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(text);
  if (hasPrUrl) return { ok: true };

  try {
    const branch = execSync('git branch --show-current', opts).trim();
    if (branch) {
      const prList = execFileSync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1'], opts).trim();
      const prs = JSON.parse(prList || '[]');
      if (prs.length > 0) return { ok: true };
    }
  } catch {
    // gh CLI not available — fall through
  }

  return { ok: false, reason: 'deliverable pr: no PR found for current branch' };
}

function validateFileDeliverable(contract, workDir) {
  if (!workDir) return { ok: false, reason: 'deliverable file: no working directory' };
  const filePath = contract.file_path;
  if (!filePath) return { ok: false, reason: 'deliverable file: contract.file_path not specified' };

  const resolved = path.resolve(workDir, filePath);

  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: `deliverable file: ${filePath} does not exist` };
  }
  const stat = fs.statSync(resolved);
  if (stat.size === 0) {
    return { ok: false, reason: `deliverable file: ${filePath} is empty` };
  }
  return { ok: true };
}

function validateArtifactDeliverable(agentOutput) {
  if (!agentOutput.payload) {
    return { ok: false, reason: 'deliverable artifact: payload is null/empty' };
  }
  const summary = agentOutput.summary || '';
  if (summary.length < 50) {
    return { ok: false, reason: `deliverable artifact: summary too short (${summary.length} chars, need 50+)` };
  }
  return { ok: true };
}

function validateCommandResultDeliverable(agentOutput) {
  const summary = agentOutput.summary || '';
  if (!summary) {
    return { ok: false, reason: 'deliverable command_result: summary is empty' };
  }
  return { ok: true };
}

function validateIssueDeliverable(agentOutput) {
  const text = [agentOutput.summary || '', JSON.stringify(agentOutput.payload || '')].join(' ');
  const hasIssueUrl = /github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(text);
  if (hasIssueUrl) return { ok: true };
  return { ok: false, reason: 'deliverable issue: no GitHub issue URL found in output' };
}

module.exports = {
  runPostCheck,
  autoFinalize,
  applyScopeGuard,
  isOutOfScope,
  revertFile,
  validateContract,
};
