const { spawn, execSync } = require('child_process');
const path = require('path');

const DIR = __dirname;
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const STEP_RESULT_RE = /STEP_RESULT:\s*(\{.*\})/;

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

function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const args = ['-p'];

    if (plan.sessionId) args.push('--resume', plan.sessionId);

    // Stream JSON with partial messages — get token-level events during tool use.
    // Without --include-partial-messages, only complete turn-boundary events are
    // emitted. A single turn with many tool calls can take >5 minutes with zero
    // events, causing the inactivity timer to fire prematurely.
    args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');

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
    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : CLAUDE_CMD;
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', CLAUDE_CMD, ...args]
      : args;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const timeoutMs = (plan.timeoutSec || 300) * 1000;
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: workDir,
      env,
      windowsHide: true,
      shell: false,
    });

    let lastAssistantText = '';  // text from the most recent assistant message
    let sessionId = null;
    let inputTokens = null;
    let outputTokens = null;
    let totalCost = null;
    let stderr = '';
    let settled = false;
    let lineBuf = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => (stderr += c));

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(result);
    }

    function buildResult() {
      return {
        code: 0,
        stdout: lastAssistantText,
        stderr,
        parsed: {
          result: lastAssistantText || null,
          session_id: sessionId,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_cost: totalCost,
        },
      };
    }

    // --- NDJSON parsing: one complete JSON object per line ---
    child.stdout.on('data', chunk => {
      lineBuf += chunk;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        // Activity detected — reset inactivity timer
        resetInactivityTimer();

        if (obj.session_id) sessionId = obj.session_id;

        // --- (1) result event: definitive completion (may be missing per known bug) ---
        if (obj.type === 'result') {
          if (obj.result) lastAssistantText = obj.result;
          if (obj.session_id) sessionId = obj.session_id;
          inputTokens = obj.usage?.input_tokens ?? obj.input_tokens ?? inputTokens;
          outputTokens = obj.usage?.output_tokens ?? obj.output_tokens ?? outputTokens;
          totalCost = obj.total_cost_usd ?? obj.total_cost ?? totalCost;
          settle(
            obj.is_error ? new Error(obj.result || 'claude reported error') : null,
            obj.is_error ? undefined : buildResult(),
          );
          killTree(child.pid);
          return;
        }

        // --- (2) assistant event: complete message after each turn ---
        if (obj.type === 'assistant' && obj.message) {
          const msg = obj.message;
          const text = extractTextFromContent(msg.content);
          if (text) lastAssistantText = text;
          if (msg.usage) {
            inputTokens = msg.usage.input_tokens ?? inputTokens;
            outputTokens = msg.usage.output_tokens ?? outputTokens;
          }

          // Primary completion signal: STEP_RESULT in assistant text
          if (STEP_RESULT_RE.test(text)) {
            settle(null, buildResult());
            killTree(child.pid);
            return;
          }
        }
      }
    });

    // --- Inactivity timeout: resets on every stream event ---
    // If claude is producing output, it's alive. Only kill when truly idle.
    const INACTIVITY_MS = timeoutMs; // use plan timeout as inactivity window
    let timer = null;
    function resetInactivityTimer() {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        settle(new Error(`claude idle for ${Math.round(INACTIVITY_MS / 1000)}s (no stream events)`));
        killTree(child.pid);
      }, INACTIVITY_MS);
    }
    resetInactivityTimer(); // start initial timer

    child.on('error', err => settle(err));

    // --- Process exit: fallback if no STEP_RESULT / result event was seen ---
    child.on('close', code => {
      // Flush remaining buffer
      if (lineBuf.trim()) {
        try {
          const obj = JSON.parse(lineBuf);
          if (obj.type === 'result') {
            if (obj.result) lastAssistantText = obj.result;
            inputTokens = obj.usage?.input_tokens ?? inputTokens;
            outputTokens = obj.usage?.output_tokens ?? outputTokens;
            totalCost = obj.total_cost_usd ?? totalCost;
          }
          if (obj.type === 'assistant' && obj.message) {
            const text = extractTextFromContent(obj.message.content);
            if (text) lastAssistantText = text;
          }
          if (obj.session_id) sessionId = obj.session_id;
        } catch {}
      }

      if (code !== 0) {
        settle(new Error(stderr || lastAssistantText || `claude exited ${code}`));
        return;
      }
      settle(null, buildResult());
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
