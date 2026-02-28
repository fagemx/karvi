const { spawn } = require('child_process');
const path = require('path');

const DIR = __dirname;
const OPENCLAW_CMD = process.env.OPENCLAW_CMD || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
const PROCESS_REVIEW = path.join(DIR, 'process-review.js');

function normalizeText(input) {
  return String(input || '').replace(/\r\n/g, '\n').trim();
}

function extractReplyText(obj, fallback = '') {
  const payloads = obj?.result?.payloads;
  if (Array.isArray(payloads) && payloads.length > 0) {
    const text = payloads.map(p => p?.text).filter(Boolean).join('\n\n').trim();
    if (text) return text;
  }

  const candidates = [
    obj?.reply,
    obj?.text,
    obj?.result?.reply,
    obj?.result?.text,
    obj?.data?.reply,
    obj?.data?.text,
  ];

  for (const c of candidates) {
    const t = normalizeText(c);
    if (t) return t;
  }

  return normalizeText(fallback) || '(empty reply)';
}

function extractSessionId(obj) {
  return (
    obj?.result?.meta?.agentMeta?.sessionId ||
    obj?.meta?.agentMeta?.sessionId ||
    obj?.sessionId ||
    null
  );
}

function runOpenclawTurn({ agentId, sessionId, message, timeoutSec = 180 }) {
  return new Promise((resolve, reject) => {
    const args = ['agent'];

    if (sessionId) {
      args.push('--session-id', sessionId);
    } else {
      args.push('--agent', agentId);
    }

    args.push('--message', message, '--json', '--timeout', String(timeoutSec));

    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', OPENCLAW_CMD, ...args]
      : args;

    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : OPENCLAW_CMD;

    const spawnEnv = { ...process.env };
    if (process.platform === 'win32') {
      spawnEnv.PYTHONIOENCODING = 'utf-8';
      spawnEnv.PYTHONUTF8 = '1';
    }

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: DIR,
      windowsHide: true,
      shell: false,
      env: spawnEnv,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));

    child.on('error', reject);

    child.on('close', code => {
      const out = stdout.trim();
      const err = stderr.trim();

      if (code !== 0) {
        return reject(new Error(err || out || `openclaw exited with code ${code}`));
      }

      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        // keep parsed as null
      }

      resolve({ code, stdout: out, stderr: err, parsed });
    });
  });
}

function spawnReview(taskId, options = {}) {
  const boardPath = options.boardPath || path.join(DIR, 'board.json');
  const onComplete = options.onComplete || (() => {});

  const args = ['--task', taskId, '--board', boardPath];
  console.log(`[review] spawning: node process-review.js ${args.join(' ')}`);

  const child = spawn('node', [PROCESS_REVIEW, ...args], {
    cwd: DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => process.stdout.write(`[review:${taskId}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[review:${taskId}] ${d}`));

  child.on('close', code => {
    console.log(`[review:${taskId}] exit ${code}`);
    onComplete(code);
  });

  child.unref();
}

function dispatch(plan) {
  return runOpenclawTurn({
    agentId: plan.agentId,
    sessionId: plan.sessionId || undefined,
    message: plan.message,
    timeoutSec: plan.timeoutSec || 180,
  });
}

function capabilities() {
  return {
    runtime: 'openclaw',
    supportsReview: true,
    supportsSessionResume: true,
    supportsStructuredDispatchPlan: true,
  };
}

/**
 * Extract token usage from openclaw output.
 * Openclaw CLI does not report token usage — returns null.
 */
function extractUsage(parsed, stdout) {
  return null;
}

module.exports = {
  dispatch,
  capabilities,
  runOpenclawTurn,
  spawnReview,
  extractReplyText,
  extractSessionId,
  extractUsage,
};
