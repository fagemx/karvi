/**
 * kill-tree.js - Kill an entire process tree (cross-platform).
 *
 * Supports graceful (SIGTERM) and hard (SIGKILL) kill modes.
 * Windows: SIGTERM uses taskkill without /F (sends WM_CLOSE for graceful shutdown),
 *          SIGKILL uses taskkill /F (forced termination).
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
      const forceFlag = signal === 'SIGTERM' ? '' : ' /F';
      execSync(`taskkill /PID ${pid} /T${forceFlag}`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch (err) {
    if (err.code !== 'ESRCH') {
      console.error(`[kill-tree] failed to kill pid=${pid} signal=${signal}:`, err.message);
    }
  }
}

module.exports = killTree;
