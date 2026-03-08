/**
 * runtime-codex.js — Codex CLI runtime adapter
 *
 * Dispatches tasks via `codex exec --json --full-auto`.
 * NDJSON stream: thread.started → turn.started → item.* → turn.completed.
 * Supports session resume (exec resume), model selection (-m),
 * and working directory (-C).
 *
 * Ref: https://developers.openai.com/codex/noninteractive
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIR = __dirname;
const STEP_RESULT_RE = /STEP_RESULT:\s*(\{.*\})/;

/**
 * Resolve the absolute path to codex executable.
 * On Windows, npm packages install as .cmd shims — we must use that,
 * not the POSIX shell script that `where` returns first.
 */
function resolveCodexPath() {
  if (process.env.CODEX_CMD) return process.env.CODEX_CMD;

  if (process.platform === 'win32') {
    try {
      const lines = execSync('where codex', { encoding: 'utf8', timeout: 5000 })
        .trim().split(/\r?\n/);
      const cmd = lines.find(l => l.trim().endsWith('.cmd'));
      if (cmd && fs.existsSync(cmd.trim())) return cmd.trim();
      const first = lines[0]?.trim();
      if (first && fs.existsSync(first)) return first;
    } catch {}
  }

  return 'codex';
}

const CODEX_EXE = resolveCodexPath();

const killTree = require('./kill-tree');

/**
 * Dispatch a plan to Codex headless CLI.
 *
 * Uses --json for NDJSON stream events.
 * Events: thread.started, turn.started, item.started, item.completed,
 *         turn.completed, turn.failed, error.
 * Prompt is piped via stdin (using '-') to avoid cmd.exe multi-line truncation.
 * Inactivity timer resets on every event.
 */
function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const args = ['exec'];

    if (plan.sessionId) {
      args.push('resume', plan.sessionId);
    }

    args.push('--full-auto', '--json');

    const model = plan.modelHint || process.env.CODEX_MODEL || null;
    if (model) args.push('-m', model);

    if (!plan.workingDir) {
      return reject(new Error(
        `[codex-rt] CRITICAL: workingDir is null for task ${plan.taskId}. ` +
        `Cannot dispatch agent without target directory.`
      ));
    }
    const workDir = plan.workingDir;
    if (!plan.sessionId) args.push('-C', workDir);

    // '-' tells codex to read the prompt from stdin (avoids cmd.exe multi-line truncation)
    args.push('-');

    // Write dispatch message to temp file for debugging/inspection (deleted after settle)
    const msgFile = path.join(os.tmpdir(), `karvi-dispatch-${Date.now()}.md`);
    fs.writeFileSync(msgFile, plan.message, 'utf8');

    const baseTimeoutMs = (plan.timeoutSec || 300) * 1000;
    const TOOL_TIMEOUT_MS = baseTimeoutMs;
    const IDLE_TIMEOUT_MS = Math.min(baseTimeoutMs, 120_000);
    let currentTimeoutMs = IDLE_TIMEOUT_MS;
    
    console.log('[codex-rt] spawn:', CODEX_EXE);
    console.log('[codex-rt] model:', model || '(default)');
    console.log('[codex-rt] message length:', plan.message?.length || 0);
    console.log('[codex-rt] message file:', msgFile);
    console.log('[codex-rt] cwd:', workDir, 'base timeout:', baseTimeoutMs,
      'idle timeout:', IDLE_TIMEOUT_MS, 'tool timeout:', TOOL_TIMEOUT_MS);

    let lastHeartbeat = 0;
    const HEARTBEAT_INTERVAL_MS = 60_000;
    function heartbeat() {
      if (!plan.onActivity) return;
      const now = Date.now();
      if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
      lastHeartbeat = now;
      try { plan.onActivity(); } catch {}
    }

    const env = { ...process.env };

    // Windows: .cmd shims must be invoked via cmd.exe
    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : CODEX_EXE;
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', CODEX_EXE, ...args]
      : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: workDir,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Allow external abort (kill step)
    if (plan.signal) {
      plan.signal.addEventListener('abort', () => killTree(child.pid), { once: true });
    }

    // Pipe message via stdin then close (codex reads prompt from stdin when '-' is used)
    child.stdin.write(plan.message);
    child.stdin.end();

    let stderr = '';
    let settled = false;
    let lineBuf = '';
    let threadId = null;
    let lastText = '';
    let totalTokens = { input: 0, output: 0 };
    let totalCost = 0;
    let toolCallCount = 0;
    let toolExecutionDepth = 0;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const heartbeatInterval = setInterval(() => heartbeat(), HEARTBEAT_INTERVAL_MS);

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      clearInterval(heartbeatInterval);
      try { fs.unlinkSync(msgFile); } catch {}
      if (err) reject(err); else resolve(result);
    }

    function enterToolExecution() {
      toolExecutionDepth++;
      if (toolExecutionDepth === 1) {
        currentTimeoutMs = TOOL_TIMEOUT_MS;
        console.log('[codex-rt] entering tool execution (depth=%d), timeout=%ds',
          toolExecutionDepth, Math.round(currentTimeoutMs / 1000));
        resetInactivityTimer();
      }
    }

    function exitToolExecution() {
      if (toolExecutionDepth > 0) {
        toolExecutionDepth--;
        if (toolExecutionDepth === 0) {
          currentTimeoutMs = IDLE_TIMEOUT_MS;
          console.log('[codex-rt] exited tool execution (depth=%d), timeout=%ds',
            toolExecutionDepth, Math.round(currentTimeoutMs / 1000));
          resetInactivityTimer();
        }
      }
    }

    let inactivityTimer = null;
    function resetInactivityTimer() {
      if (settled) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        console.log('[codex-rt] idle for %ds (depth=%d), killing',
          Math.round(currentTimeoutMs / 1000), toolExecutionDepth);
        settle(new Error(`codex idle for ${Math.round(currentTimeoutMs / 1000)}s`));
        killTree(child.pid);
      }, currentTimeoutMs);
    }
    resetInactivityTimer();

    function buildResult(text) {
      return {
        code: 0,
        stdout: text || lastText || '',
        stderr,
        parsed: {
          result: text || lastText || null,
          session_id: threadId,
          input_tokens: totalTokens.input || null,
          output_tokens: totalTokens.output || null,
          total_cost: totalCost || null,
        },
      };
    }

    // NDJSON parsing — codex event types:
    // thread.started, turn.started, turn.completed, turn.failed,
    // item.started, item.completed, error
    child.stdout.on('data', chunk => {
      lineBuf += chunk;
      resetInactivityTimer();
      heartbeat();

      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        // thread.started — extract thread/session ID
        if (obj.type === 'thread.started' && obj.thread_id) {
          threadId = obj.thread_id;
        }

        // item.completed with agent_message — accumulate text
        if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
          const text = obj.item.text || '';
          if (text) {
            lastText += text;

            const m = STEP_RESULT_RE.exec(lastText);
            if (m) {
              console.log('[codex-rt] STEP_RESULT detected');
              settle(null, buildResult(lastText));
              killTree(child.pid);
              return;
            }
          }
        }

        // item.started — track tool/command usage for progress
        if (obj.type === 'item.started' && obj.item) {
          if (obj.item.type !== 'agent_message') {
            enterToolExecution();
          }
          toolCallCount++;
          if (plan.onProgress) {
            try {
              plan.onProgress({
                type: 'tool_call',
                tool_name: obj.item.command || obj.item.type || null,
                tool_calls: toolCallCount,
                tokens: { ...totalTokens },
              });
            } catch {}
          }
        }

        // item.completed — tool execution finished
        if (obj.type === 'item.completed') {
          exitToolExecution();
        }

        // turn.completed — accumulate tokens/cost
        if (obj.type === 'turn.completed') {
          const usage = obj.usage || {};
          totalTokens.input += usage.input_tokens || 0;
          totalTokens.output += usage.output_tokens || 0;
          if (obj.cost) totalCost += obj.cost;
          console.log('[codex-rt] turn.completed: tokens=%j (cumulative: %j)',
            usage, totalTokens);
        }

        // turn.failed — log but don't settle (codex may have more turns)
        if (obj.type === 'turn.failed') {
          console.log('[codex-rt] turn.failed:', JSON.stringify(obj).slice(0, 500));
        }

        // error event — log
        if (obj.type === 'error') {
          console.log('[codex-rt] error event:', JSON.stringify(obj).slice(0, 500));
        }

        // Debug: log unknown event types
        if (!['thread.started', 'turn.started', 'turn.completed', 'turn.failed',
              'item.started', 'item.completed', 'error'].includes(obj.type)) {
          console.log('[codex-rt] event type=%s keys=%s', obj.type, Object.keys(obj).join(','));
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      resetInactivityTimer();
      heartbeat();
      if (stderr.length <= 1000) {
        console.log('[codex-rt] stderr:', chunk.slice(0, 200));
      }
    });

    child.on('error', err => {
      console.log('[codex-rt] spawn error:', err.message);
      settle(err);
    });

    child.on('close', code => {
      console.log('[codex-rt] close: code=%d settled=%s lastText=%d totalOut=%d',
        code, settled, lastText.length, totalTokens.output);
      if (settled) return;

      if (code !== 0) {
        settle(new Error(stderr || `codex exited ${code}`));
        return;
      }

      if (lastText) {
        settle(null, buildResult(lastText));
        return;
      }

      // Fallback: codex completed with output tokens but no agent_message events captured
      if (totalTokens.output > 0) {
        console.log('[codex-rt] no text events but %d output tokens — settling as success', totalTokens.output);
        settle(null, buildResult(`[agent completed: ${totalTokens.output} output tokens, ${toolCallCount} tool calls]`));
        return;
      }

      settle(new Error('codex exited 0 but no output received'));
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
    runtime: 'codex',
    supportsReview: false,
    supportsSessionResume: true,
    supportsModelSelection: true,
    supportsBudgetLimit: false,
    supportsToolRestriction: false,
    supportsEffortLevel: false,
  };
}

module.exports = { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities };
