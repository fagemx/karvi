/**
 * kill-tree.js - Kill an entire process tree (cross-platform).
 *
 * Supports graceful (SIGTERM) and hard (SIGKILL) kill modes.
 * Windows: always hard kill (taskkill /F) - no SIGTERM concept for process trees.
 */
const { execSync } = require('child_process');

/**
 * Kill a process tree.
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

module.exports = killTree;
