/**
 * hook-runner.js — 執行 workspace lifecycle hooks
 *
 * 在 worktree 建立後、agent 啟動前/完成後執行使用者定義的 shell 命令。
 * Non-fatal：hook 失敗只 log warning，不阻擋 pipeline。
 */
const { spawn } = require('child_process');

/**
 * runHook — 執行一個 hook shell command (Windows-first: cmd.exe /d /s /c)
 *
 * @param {string} hookName   — hook 名稱 (用於 log)
 * @param {string} command    — shell command to run
 * @param {string} cwd        — working directory
 * @param {object} env        — environment variables (merged with process.env)
 * @param {number} timeoutMs  — timeout in ms (default 30s)
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, timedOut: boolean}>}
 */
function runHook(hookName, command, cwd, env, timeoutMs = 30_000) {
  if (!command || !command.trim()) {
    return Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0, timedOut: false });
  }

  return new Promise((resolve) => {
    const mergedEnv = { ...process.env, ...env };
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const ok = code === 0 && !timedOut;
      if (!ok) {
        console.warn(`[hook] ${hookName} ${timedOut ? 'timed out' : `exited ${code}`}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`);
      } else {
        console.log(`[hook] ${hookName} ok (${Math.round(Date.now())})`);
      }
      resolve({ ok, stdout, stderr, code, timedOut });
    });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.warn(`[hook] ${hookName} spawn error: ${err.message}`);
      resolve({ ok: false, stdout, stderr: err.message, code: null, timedOut: false });
    });
  });
}

module.exports = { runHook };
