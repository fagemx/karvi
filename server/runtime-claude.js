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
 * Extract all text from a Claude assistant message content array.
 */
function extractTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

/**
 * Dispatch a plan to Claude Code headless CLI.
 *
 * Uses --output-format stream-json for real-time NDJSON events.
 * Each line is a complete JSON object (assistant message, result, etc.).
 * Inactivity timer resets on every event — only kills truly idle processes.
 * STEP_RESULT detection resolves immediately without waiting for exit.
 */
function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--verbose', '--output-format', 'stream-json'];

    if (plan.sessionId) args.push('--resume', plan.sessionId);
    if (plan.modelHint) args.push('--model', plan.modelHint);
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

    let stderr = '';
    let settled = false;
    let lineBuf = '';
    let lastResult = null;   // last result event (definitive completion)
    let sessionId = null;
    let lastAssistantText = '';  // accumulated assistant text for STEP_RESULT detection

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      if (err) reject(err); else resolve(result);
    }

    // --- Inactivity timeout: resets on every stream event ---
    let inactivityTimer = null;
    function resetInactivityTimer() {
      if (settled) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        console.log('[claude-rt] idle for %ds (no stream events), killing',
          Math.round(timeoutMs / 1000));
        settle(new Error(`claude idle for ${Math.round(timeoutMs / 1000)}s (no stream events)`));
        killTree(child.pid);
      }, timeoutMs);
    }
    resetInactivityTimer();

    function buildResult(text) {
      return {
        code: 0,
        stdout: text || lastAssistantText || '',
        stderr,
        parsed: {
          result: text || lastAssistantText || null,
          session_id: sessionId,
          input_tokens: lastResult?.usage?.input_tokens ?? null,
          output_tokens: lastResult?.usage?.output_tokens ?? null,
          total_cost: lastResult?.total_cost_usd ?? lastResult?.cost_usd ?? null,
        },
      };
    }

    // --- NDJSON parsing: one complete JSON object per line ---
    child.stdout.on('data', chunk => {
      lineBuf += chunk;
      resetInactivityTimer();

      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.session_id) sessionId = obj.session_id;

        // --- (1) result event: definitive completion ---
        if (obj.type === 'result') {
          lastResult = obj;
          const text = obj.result || extractTextFromContent(obj.content) || '';
          console.log('[claude-rt] result event: is_error=%s cost=%s',
            obj.is_error, obj.total_cost_usd);
          if (obj.is_error) {
            settle(new Error(text || 'claude reported error'));
          } else {
            settle(null, buildResult(text));
          }
          killTree(child.pid);
          return;
        }

        // --- (2) assistant message: accumulate text, check for STEP_RESULT ---
        if (obj.type === 'assistant') {
          const text = extractTextFromContent(obj.message?.content || obj.content);
          if (text) lastAssistantText = text;

          const m = STEP_RESULT_RE.exec(text);
          if (m) {
            console.log('[claude-rt] STEP_RESULT detected in assistant message');
            settle(null, buildResult(text));
            killTree(child.pid);
            return;
          }
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      resetInactivityTimer();
      if (stderr.length <= 1000) {
        console.log('[claude-rt] stderr:', chunk.slice(0, 200));
      }
    });

    child.on('error', err => {
      console.log('[claude-rt] spawn error:', err.message);
      settle(err);
    });

    // --- Process exit: fallback if no result event was received ---
    child.on('close', code => {
      console.log('[claude-rt] close: code=%d settled=%s', code, settled);
      if (settled) return;

      if (code !== 0) {
        settle(new Error(stderr || `claude exited ${code}`));
        return;
      }

      // Process exited cleanly but no result event — use last assistant text
      if (lastAssistantText) {
        settle(null, buildResult(lastAssistantText));
      } else {
        settle(new Error('claude exited 0 but no output received'));
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
