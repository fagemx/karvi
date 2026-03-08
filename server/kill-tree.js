/**
 * kill-tree.js — Kill an entire process tree (cross-platform).
 */
const { execSync } = require('child_process');

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {}
}

module.exports = killTree;
