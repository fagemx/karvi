/**
 * kill-tree.js - Kill an entire process tree (cross-platform).
 *
 * Exports:
 *   killTree(pid, opts)         — hard-kill a process tree
 *   gracefulKill(child, pid, graceMs) — SIGINT first, hard-kill after grace period
 */
const { execSync } = require('child_process');

/**
 * Kill a process tree (hard kill).
 * @param {number} pid
 * @param {{ signal?: string }} opts - 'SIGTERM' for graceful, 'SIGKILL' for hard (default)
 */
function killTree(pid, { signal = 'SIGKILL' } = {}) {
  try {
    if (process.platform === 'win32') {
      // Windows: taskkill /F is always hard kill (no SIGTERM for tree)
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch (err) {
    // ESRCH = process already dead - not an error
    if (err.code !== 'ESRCH') {
      console.error(`[kill-tree] failed to kill pid=${pid} signal=${signal}:`, err.message);
    }
  }
}

/**
 * Graceful two-phase kill: SIGINT first, hard kill after grace period.
 *
 * Phase 1: child.kill('SIGINT') — cross-platform graceful signal.
 *   Windows: Node.js translates to CTRL_C_EVENT.
 *   Unix: standard SIGINT.
 * Phase 2: killTree(pid) — hard kill the entire tree after graceMs.
 *
 * @param {import('child_process').ChildProcess} child - The child process handle
 * @param {number} pid - PID for hard kill fallback (usually child.pid)
 * @param {number} graceMs - Milliseconds to wait before hard kill (default 5000)
 * @returns {NodeJS.Timeout} The hard-kill timer (can be cleared if process exits early)
 */
function gracefulKill(child, pid, graceMs = 5000) {
  // Phase 1: Send SIGINT (cross-platform graceful stop)
  try {
    child.kill('SIGINT');
    console.log('[kill-tree] graceful SIGINT sent to pid=%d, hard kill in %dms', pid, graceMs);
  } catch (err) {
    if (err.code !== 'ESRCH') {
      console.error('[kill-tree] graceful SIGINT failed for pid=%d:', pid, err.message);
    }
  }

  // Phase 2: Hard kill after grace period
  const timer = setTimeout(() => killTree(pid), graceMs);
  timer.unref(); // Don't prevent Node.js exit

  return timer;
}

module.exports = killTree;
module.exports.killTree = killTree;
module.exports.gracefulKill = gracefulKill;
