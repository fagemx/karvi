/**
 * blocker-types.js — Blocker 類型定義與工具函數
 */

const BLOCKER_TYPES = {
  DEAD_LETTER: 'dead_letter',
  REPO_ERROR: 'repo_error',
  WORKTREE_ERROR: 'worktree_error',
  DEPENDENCY: 'dependency',
  MANUAL: 'manual',
  UNKNOWN: 'unknown',
};

function inferBlockerType(reason) {
  if (!reason) return BLOCKER_TYPES.UNKNOWN;
  const r = reason.toLowerCase();
  if (r.includes('dead letter')) return BLOCKER_TYPES.DEAD_LETTER;
  if (r.includes('repo validation')) return BLOCKER_TYPES.REPO_ERROR;
  if (r.includes('worktree')) return BLOCKER_TYPES.WORKTREE_ERROR;
  return BLOCKER_TYPES.MANUAL;
}

function shouldUnblockOnReset(blocker) {
  if (!blocker) return false;
  if (blocker.type) return blocker.type === BLOCKER_TYPES.DEAD_LETTER;
  return inferBlockerType(blocker.reason) === BLOCKER_TYPES.DEAD_LETTER;
}

module.exports = { BLOCKER_TYPES, inferBlockerType, shouldUnblockOnReset };
