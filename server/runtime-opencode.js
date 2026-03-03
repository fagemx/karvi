/**
 * runtime-opencode.js — OpenCode CLI runtime adapter
 *
 * Dispatches tasks via `opencode run "prompt" --format json`.
 * NDJSON stream: step_start → text* → step_finish (with tokens/cost).
 * Supports session resume (--session), model selection (--model),
 * and working directory (--dir).
 *
 * Ref: https://opencode.ai/docs/cli/
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIR = __dirname;
const STEP_RESULT_RE = /STEP_RESULT:\s*(\{.*\})/;

/**
 * Resolve the absolute path to opencode executable.
 * On Windows, npm packages install as .cmd shims — we must use that,
 * not the POSIX shell script that `where` returns first.
 */
function resolveOpencodePath() {
  if (process.env.OPENCODE_CMD) return process.env.OPENCODE_CMD;

  if (process.platform === 'win32') {
    try {
      const lines = execSync('where opencode', { encoding: 'utf8', timeout: 5000 })
        .trim().split(/\r?\n/);
      // Prefer .cmd shim over POSIX shell script
      const cmd = lines.find(l => l.trim().endsWith('.cmd'));
      if (cmd && fs.existsSync(cmd.trim())) return cmd.trim();
      // Fallback to first result
      const first = lines[0]?.trim();
      if (first && fs.existsSync(first)) return first;
    } catch {}
  }

  return 'opencode';
}

const OPENCODE_EXE = resolveOpencodePath();

/**
 * Kill an entire process tree.
 */
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {}
}

/**
 * Dispatch a plan to OpenCode headless CLI.
 *
 * Uses --format json for NDJSON stream events.
 * Events: step_start, text, tool_call, tool_result, step_finish.
 * Inactivity timer resets on every event.
 */
function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];

    if (plan.sessionId) args.push('--session', plan.sessionId);
    // Model priority: plan.modelHint > OPENCODE_MODEL env > opencode default config
    const model = plan.modelHint || process.env.OPENCODE_MODEL || null;
    if (model) args.push('--model', model);

    const workDir = plan.workingDir || path.resolve(DIR, '..');
    args.push('--dir', workDir);

    // Write message to temp file and attach via --file.
    // cmd.exe truncates multi-line positional args at the first newline,
    // so the full task prompt goes into the file attachment.
    const msgFile = path.join(os.tmpdir(), `karvi-dispatch-${Date.now()}.md`);
    fs.writeFileSync(msgFile, plan.message, 'utf8');
    // --file must come before positional message to avoid yargs misparse
    args.push('--file', msgFile, '--', 'Read the attached file for your task. Implement everything it describes.');

    const timeoutMs = (plan.timeoutSec || 300) * 1000;
    console.log('[opencode-rt] spawn:', OPENCODE_EXE);
    console.log('[opencode-rt] model:', model || '(default)');
    console.log('[opencode-rt] message length:', plan.message?.length || 0);
    console.log('[opencode-rt] message file:', msgFile);
    console.log('[opencode-rt] cwd:', workDir, 'timeout:', timeoutMs);

    const env = { ...process.env };

    // Windows: .cmd shims must be invoked via cmd.exe
    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : OPENCODE_EXE;
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', OPENCODE_EXE, ...args]
      : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: workDir,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    let lineBuf = '';
    let sessionId = null;
    let lastText = '';
    let lastFinish = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      try { fs.unlinkSync(msgFile); } catch {}
      if (err) reject(err); else resolve(result);
    }

    let inactivityTimer = null;
    function resetInactivityTimer() {
      if (settled) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        console.log('[opencode-rt] idle for %ds, killing', Math.round(timeoutMs / 1000));
        settle(new Error(`opencode idle for ${Math.round(timeoutMs / 1000)}s`));
        killTree(child.pid);
      }, timeoutMs);
    }
    resetInactivityTimer();

    function buildResult(text) {
      const tokens = lastFinish?.tokens || {};
      return {
        code: 0,
        stdout: text || lastText || '',
        stderr,
        parsed: {
          result: text || lastText || null,
          session_id: sessionId,
          input_tokens: tokens.input ?? null,
          output_tokens: tokens.output ?? null,
          total_cost: lastFinish?.cost ?? null,
        },
      };
    }

    // NDJSON parsing
    child.stdout.on('data', chunk => {
      lineBuf += chunk;
      resetInactivityTimer();

      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.sessionID) sessionId = obj.sessionID;

        // text event — accumulate
        if (obj.type === 'text' && obj.part?.text) {
          lastText += obj.part.text;

          // Check for STEP_RESULT marker
          const m = STEP_RESULT_RE.exec(lastText);
          if (m) {
            console.log('[opencode-rt] STEP_RESULT detected');
            settle(null, buildResult(lastText));
            killTree(child.pid);
            return;
          }
        }

        // step_finish — only settle on terminal reasons (not tool-calls which means more steps coming)
        if (obj.type === 'step_finish') {
          lastFinish = obj.part || {};
          if (obj.sessionID) sessionId = obj.sessionID;
          console.log('[opencode-rt] step_finish: reason=%s cost=%s tokens=%j',
            lastFinish.reason, lastFinish.cost, lastFinish.tokens);
          // reason=tool-calls means opencode is about to execute tools and continue
          if (lastFinish.reason === 'tool-calls') {
            console.log('[opencode-rt] tool-calls step — waiting for next step');
            continue;
          }
          settle(null, buildResult(lastText));
          killTree(child.pid);
          return;
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      resetInactivityTimer();
      if (stderr.length <= 1000) {
        console.log('[opencode-rt] stderr:', chunk.slice(0, 200));
      }
    });

    child.on('error', err => {
      console.log('[opencode-rt] spawn error:', err.message);
      settle(err);
    });

    child.on('close', code => {
      console.log('[opencode-rt] close: code=%d settled=%s', code, settled);
      if (settled) return;

      if (code !== 0) {
        settle(new Error(stderr || `opencode exited ${code}`));
        return;
      }

      if (lastText) {
        settle(null, buildResult(lastText));
      } else {
        settle(new Error('opencode exited 0 but no output received'));
      }
    });
  });
}

function extractReplyText(parsed, stdout) {
  if (parsed?.result) return parsed.result;
  return stdout?.slice(-2000) || '';
}

function extractSessionId(parsed) {
  return parsed?.session_id || null;
}

function extractUsage(parsed, _stdout) {
  if (!parsed) return null;
  const inp = parsed.input_tokens ?? null;
  const out = parsed.output_tokens ?? null;
  const cost = parsed.total_cost ?? null;
  if (inp == null && out == null && cost == null) return null;
  return { inputTokens: inp, outputTokens: out, totalCost: cost };
}

function capabilities() {
  return {
    runtime: 'opencode',
    supportsReview: false,
    supportsSessionResume: true,
    supportsModelSelection: true,
    supportsBudgetLimit: false,
    supportsToolRestriction: false,
    supportsEffortLevel: false,
  };
}

module.exports = { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities };
