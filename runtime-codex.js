const { spawn } = require('child_process');
const path = require('path');

const DIR = __dirname;
const CODEX_CMD = process.env.CODEX_CMD || 'codex';

function dispatch(plan) {
  return new Promise((resolve, reject) => {
    let args;

    if (plan.sessionId) {
      // Resume existing session
      args = ['exec', 'resume', plan.sessionId];
    } else {
      // New session
      args = ['exec'];
    }

    args.push('--full-auto', '--json');

    if (plan.modelHint) args.push('-m', plan.modelHint);

    const workDir = plan.workingDir || path.resolve(DIR, '..', '..');
    args.push('-C', workDir);

    if (plan.codexRole) {
      args.push('-c', `agents.default.config_file=agents/${plan.codexRole}.toml`);
    }

    args.push('--', plan.message);

    const child = spawn(CODEX_CMD, args, {
      cwd: workDir,
      windowsHide: true,
      shell: false,
      timeout: (plan.timeoutSec || 180) * 1000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));

    child.on('error', err => reject(err));
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `codex exited ${code}`));
      }

      let lastMessage = null;
      for (const line of stdout.trim().split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'message' || ev.message) lastMessage = ev;
        } catch {}
      }

      resolve({
        code,
        stdout,
        stderr,
        parsed: lastMessage,
        sessionId: lastMessage?.session_id || null,
      });
    });
  });
}

function extractReplyText(parsed, stdout) {
  if (parsed?.message) return parsed.message;
  if (parsed?.content) return parsed.content;

  const lines = (stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.message || ev.content) return ev.message || ev.content;
    } catch {}
  }
  return stdout?.slice(-2000) || '';
}

function extractSessionId(parsed) {
  return parsed?.session_id || null;
}

function capabilities() {
  return {
    runtime: 'codex',
    supportsReview: false,
    supportsSessionResume: true,
    supportsRoles: true,
    supportsMultiAgent: true,
  };
}

module.exports = { dispatch, extractReplyText, extractSessionId, capabilities };
