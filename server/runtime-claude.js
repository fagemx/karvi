const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIR = __dirname;
const STEP_RESULT_RE = /STEP_RESULT:\s*(\{.*\})/;

/**
 * Resolve the absolute path to claude executable.
 *
 * On Windows, passing a custom env to spawn() breaks PATH resolution
 * (the case-insensitive proxy on process.env is lost). We resolve the
 * full path once at startup to sidestep this.
 */
function resolveClaudePath() {
  if (process.env.CLAUDE_CMD) return process.env.CLAUDE_CMD;

  if (process.platform === 'win32') {
    // Try `where` first
    try {
      const p = execSync('where claude', { encoding: 'utf8', timeout: 5000 })
        .trim().split('\n')[0].trim();
      if (p && fs.existsSync(p)) return p;
    } catch {}
    // Fallback: common install location
    const local = path.join(process.env.USERPROFILE || '', '.local/bin/claude.exe');
    if (fs.existsSync(local)) return local;
  }

  return 'claude'; // Unix: PATH works fine with custom env
}

const CLAUDE_EXE = resolveClaudePath();

/**
 * Kill an entire process tree.
 * Windows: taskkill /T /F (tree kill). Unix: negative pid (process group).
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
 * Dispatch a plan to Claude Code headless CLI.
 *
 * Uses --output-format json (not stream-json) for reliable single-object
 * output. The CLI outputs one complete JSON result when the task finishes.
 * We parse stdout incrementally; as soon as valid JSON is received we
 * resolve and kill the process tree (CLI may hang after completion).
 */
function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json'];

    if (plan.sessionId) args.push('--resume', plan.sessionId);
    if (plan.modelHint) args.push('--model', plan.modelHint);
    if (plan.codexRole) args.push('--agent', plan.codexRole);
    if (plan.maxBudgetUsd) args.push('--max-budget-usd', String(plan.maxBudgetUsd));
    if (plan.allowedTools && plan.allowedTools.length) {
      args.push('--allowedTools', ...plan.allowedTools);
    }
    if (plan.effort) args.push('--effort', plan.effort);
    if (plan.systemPrompt) args.push('--append-system-prompt', plan.systemPrompt);

    args.push(plan.message);

    const workDir = plan.workingDir || path.resolve(DIR, '..');
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const timeoutMs = (plan.timeoutSec || 300) * 1000;
    console.log('[claude-rt] spawn:', CLAUDE_EXE);
    console.log('[claude-rt] args:', JSON.stringify(args.filter(a => a !== plan.message)));
    console.log('[claude-rt] message length:', plan.message?.length || 0);
    console.log('[claude-rt] cwd:', workDir, 'timeout:', timeoutMs);

    const child = spawn(CLAUDE_EXE, args, {
      cwd: workDir,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],  // stdin MUST be ignored on Windows
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(result);
    }

    function buildResult(obj) {
      return {
        code: 0,
        stdout: obj.result || '',
        stderr,
        parsed: {
          result: obj.result || null,
          session_id: obj.session_id || null,
          input_tokens: obj.usage?.input_tokens ?? null,
          output_tokens: obj.usage?.output_tokens ?? null,
          total_cost: obj.total_cost_usd ?? obj.cost_usd ?? null,
        },
      };
    }

    // --- stdout: accumulate and try to parse as complete JSON ---
    child.stdout.on('data', chunk => {
      stdout += chunk;
      try {
        const obj = JSON.parse(stdout);
        // Successfully parsed — CLI has finished outputting result
        console.log('[claude-rt] result received: type=%s is_error=%s cost=%s',
          obj.type, obj.is_error, obj.total_cost_usd);
        if (obj.is_error) {
          settle(new Error(obj.result || 'claude reported error'));
        } else {
          settle(null, buildResult(obj));
        }
        // Kill process tree — CLI may hang after outputting result
        killTree(child.pid);
      } catch {
        // JSON not yet complete, wait for more data
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length <= 1000) {
        console.log('[claude-rt] stderr:', chunk.slice(0, 200));
      }
    });

    // --- Wall-clock timeout as safety net ---
    const timer = setTimeout(() => {
      console.log('[claude-rt] timeout after %ds (stdout: %d bytes, stderr: %d bytes)',
        Math.round(timeoutMs / 1000), stdout.length, stderr.length);
      settle(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`));
      killTree(child.pid);
    }, timeoutMs);

    child.on('error', err => {
      console.log('[claude-rt] spawn error:', err.message);
      settle(err);
    });

    // --- Process exit: fallback if stdout wasn't parsed yet ---
    child.on('close', code => {
      console.log('[claude-rt] close: code=%d stdout=%d stderr=%d settled=%s',
        code, stdout.length, stderr.length, settled);
      if (settled) return;

      if (code !== 0) {
        settle(new Error(stderr || `claude exited ${code}`));
        return;
      }

      // Try to parse whatever we have
      try {
        const obj = JSON.parse(stdout);
        if (obj.is_error) {
          settle(new Error(obj.result || 'claude reported error'));
        } else {
          settle(null, buildResult(obj));
        }
      } catch {
        settle(new Error('claude exited 0 but no valid JSON output'));
      }
    });
  });
}

function extractReplyText(parsed, stdout) {
  if (parsed?.result) return parsed.result;
  if (parsed?.content) return parsed.content;
  return stdout?.slice(-2000) || '';
}

function extractSessionId(parsed) {
  return parsed?.session_id || null;
}

function capabilities() {
  return {
    runtime: 'claude',
    supportsReview: false,
    supportsSessionResume: true,
    supportsModelSelection: true,
    supportsBudgetLimit: true,
    supportsToolRestriction: true,
    supportsEffortLevel: true,
  };
}

/**
 * Extract token usage from parsed output.
 */
function extractUsage(parsed, _stdout) {
  if (!parsed) return null;
  const inp = parsed.input_tokens ?? null;
  const out = parsed.output_tokens ?? null;
  const cost = parsed.total_cost ?? null;
  if (inp == null && out == null && cost == null) return null;
  return { inputTokens: inp, outputTokens: out, totalCost: cost };
}

module.exports = { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities };
