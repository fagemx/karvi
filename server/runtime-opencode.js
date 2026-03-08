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

const killTree = require('./kill-tree');

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

    // @protected decision:runtime.opencode.msgFile — cmd.exe truncates multi-line positional args at first newline; --file must precede -- to avoid yargs misparse
    const msgFile = path.join(os.tmpdir(), `karvi-dispatch-${Date.now()}.md`);
    fs.writeFileSync(msgFile, plan.message, 'utf8');
    args.push('--file', msgFile, '--', 'Read the attached file for your task. Implement everything it describes.');
    // @end-protected

    const baseTimeoutMs = (plan.timeoutSec || 300) * 1000;
    const TOOL_TIMEOUT_MS = baseTimeoutMs;
    const IDLE_TIMEOUT_MS = Math.min(baseTimeoutMs, 120_000);
    let currentTimeoutMs = IDLE_TIMEOUT_MS;
    
    console.log('[opencode-rt] spawn:', OPENCODE_EXE);
    console.log('[opencode-rt] model:', model || '(default)');
    console.log('[opencode-rt] message length:', plan.message?.length || 0);
    console.log('[opencode-rt] message file:', msgFile);
    console.log('[opencode-rt] cwd:', workDir, 'base timeout:', baseTimeoutMs,
      'idle timeout:', IDLE_TIMEOUT_MS, 'tool timeout:', TOOL_TIMEOUT_MS);

    // Heartbeat: notify caller that runtime is alive (for lock renewal)
    let lastHeartbeat = 0;
    const HEARTBEAT_INTERVAL_MS = 60_000;
    function heartbeat() {
      if (!plan.onActivity) return;
      const now = Date.now();
      if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
      lastHeartbeat = now;
      try { plan.onActivity(); } catch {}
    }

    // Validate cwd exists before spawn (fail immediately, not after 300s timeout)
    if (!fs.existsSync(workDir)) {
      return reject(new Error(`ENOENT: working directory does not exist: ${workDir}`));
    }

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

    // Allow external abort (kill step)
    if (plan.signal) {
      plan.signal.addEventListener('abort', () => killTree(child.pid), { once: true });
    }

    let stderr = '';
    let settled = false;
    let lineBuf = '';
    let sessionId = null;
    let lastText = '';
    let lastFinish = null;
    let totalTokens = { input: 0, output: 0 };
    let totalCost = 0;
    let toolCallCount = 0;
    let toolExecutionDepth = 0;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Periodic heartbeat: refresh step lock even during silent tool execution
    // (tools like git push, gh pr create produce no stdout/stderr for minutes)
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
        console.log('[opencode-rt] entering tool execution (depth=%d), timeout=%ds',
          toolExecutionDepth, Math.round(currentTimeoutMs / 1000));
        resetInactivityTimer();
      }
    }

    function exitToolExecution() {
      if (toolExecutionDepth > 0) {
        toolExecutionDepth--;
        if (toolExecutionDepth === 0) {
          currentTimeoutMs = IDLE_TIMEOUT_MS;
          console.log('[opencode-rt] exited tool execution (depth=%d), timeout=%ds',
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
        console.log('[opencode-rt] idle for %ds (depth=%d), killing',
          Math.round(currentTimeoutMs / 1000), toolExecutionDepth);
        settle(new Error(`opencode idle for ${Math.round(currentTimeoutMs / 1000)}s`));
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
          session_id: sessionId,
          input_tokens: totalTokens.input || null,
          output_tokens: totalTokens.output || null,
          total_cost: totalCost || null,
        },
      };
    }

    // NDJSON parsing
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

        if (obj.sessionID) sessionId = obj.sessionID;

        // Debug: log unknown event types to diagnose provider-specific NDJSON formats
        if (!['text', 'step_start', 'step_finish', 'tool_call', 'tool_result', 'tool_use'].includes(obj.type)) {
          console.log('[opencode-rt] event type=%s keys=%s', obj.type, Object.keys(obj).join(','));
        }

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

        // @protected decision:runtime.opencode.settle — never settle on step_finish; let process exit naturally (opencode run is headless)
        if (obj.type === 'step_finish') {
          lastFinish = obj.part || {};
          if (obj.sessionID) sessionId = obj.sessionID;
          // Accumulate tokens and cost across all steps
          const tokens = lastFinish.tokens || {};
          totalTokens.input += tokens.input || 0;
          totalTokens.output += tokens.output || 0;
          totalCost += lastFinish.cost || 0;
          console.log('[opencode-rt] step_finish: reason=%s cost=%s tokens=%j (cumulative: cost=%s tokens=%j)',
            lastFinish.reason, lastFinish.cost, lastFinish.tokens, totalCost, totalTokens);
          // step_finish means a tool call round completed — reset tool execution depth
          // (opencode emits tool_use but no tool_result, so exitToolExecution never fires)
          if (toolExecutionDepth > 0) {
            toolExecutionDepth = 0;
            currentTimeoutMs = IDLE_TIMEOUT_MS;
          }
          // Do NOT settle here. opencode's agentic loop may have more steps.
          // Settlement happens via: STEP_RESULT marker, process exit, or inactivity timeout.
        }
        // @end-protected

        // Emit progress for tool_call/tool_use events (consumed by step-worker onProgress)
        // opencode emits 'tool_use' (not 'tool_call') for tool execution start
        if (obj.type === 'tool_call' || obj.type === 'tool_use') {
          toolCallCount++;
          enterToolExecution();
          if (plan.onProgress) {
            try {
              plan.onProgress({
                type: 'tool_call',
                tool_name: obj.part?.name || null,
                tool_calls: toolCallCount,
                tokens: { ...totalTokens },
              });
            } catch {}
          }
        }

        // Tool execution completed — return to IDLE_TIMEOUT
        if (obj.type === 'tool_result') {
          exitToolExecution();
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      resetInactivityTimer();
      heartbeat();
      if (stderr.length <= 1000) {
        console.log('[opencode-rt] stderr:', chunk.slice(0, 200));
      }
    });

    child.on('error', err => {
      console.log('[opencode-rt] spawn error:', err.message);
      settle(err);
    });

    child.on('close', code => {
      console.log('[opencode-rt] close: code=%d settled=%s lastText=%d totalOut=%d',
        code, settled, lastText.length, totalTokens.output);
      if (settled) return;

      if (code !== 0) {
        settle(new Error(stderr || `opencode exited ${code}`));
        return;
      }

      // Primary: settle with accumulated text output
      if (lastText) {
        settle(null, buildResult(lastText));
        return;
      }

      // Fallback: some providers (e.g. Ollama via opencode) don't emit 'text' NDJSON
      // events, so lastText stays empty. If we received step_finish events with output
      // tokens, the model DID produce output — treat as success with synthetic summary.
      if (totalTokens.output > 0) {
        console.log('[opencode-rt] no text events but %d output tokens — settling as success', totalTokens.output);
        settle(null, buildResult(`[agent completed: ${totalTokens.output} output tokens, ${toolCallCount} tool calls]`));
        return;
      }

      settle(new Error('opencode exited 0 but no output received'));
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
