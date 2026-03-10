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
    } catch (err) {
      console.warn('[codex-rt] unable to resolve codex via "where":', err.message);
    }
  }

  return 'codex';
}

const CODEX_EXE = resolveCodexPath();

const killTree = require('./kill-tree');
const { createIdleController } = require('./runtime-utils');

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

    // Enable network access in sandbox so agent can use gh CLI, git push, etc.
    args.push('-c', 'sandbox_workspace_write.network_access=true');
    // Inherit full parent environment so gh auth tokens are available
    args.push('-c', 'shell_environment_policy.inherit=all');

    const model = plan.modelHint || process.env.CODEX_MODEL || null;
    if (model) args.push('-m', model);

    if (!plan.workingDir) {
      return reject(new Error(
        `[codex-rt] CRITICAL: workingDir is null for task ${plan.taskId}. ` +
        `Cannot dispatch agent without target directory.`
      ));
    }
    const workDir = plan.workingDir;
    if (!plan.sessionId) {
      args.push('-C', workDir);
    }

    // '-' tells codex to read the prompt from stdin (avoids cmd.exe multi-line truncation)
    args.push('-');

    // Write dispatch message to temp file for debugging/inspection (deleted after settle)
    const msgFile = path.join(os.tmpdir(), `karvi-dispatch-${Date.now()}.md`);
    fs.writeFileSync(msgFile, plan.message, 'utf8');

    const baseTimeoutMs = (plan.timeoutSec || 300) * 1000;
    // Codex does extended reasoning before emitting events — 120s too aggressive
    const IDLE_TIMEOUT_MS = Math.min(baseTimeoutMs, 300_000);
    const TOOL_TIMEOUT_MS = baseTimeoutMs;
    
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
      try {
        plan.onActivity();
      } catch (err) {
        console.error('[codex-rt] onActivity callback failed:', err.message);
      }
    }

    // Validate cwd exists before spawn (fail immediately, not after 300s timeout)
    if (!fs.existsSync(workDir)) {
      return reject(new Error(`ENOENT: working directory does not exist: ${workDir}`));
    }

    const env = { ...process.env };

    // Ensure GH_TOKEN is set for gh CLI auth inside sandbox
    // (sandbox can't access Windows credential store / keyring)
    if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
      try {
        const token = execSync('gh auth token', { encoding: 'utf8', timeout: 5000 }).trim();
        if (token) env.GH_TOKEN = token;
      } catch (err) {
        console.warn('[codex-rt] unable to read gh auth token:', err.message);
      }
    }

    // Resolve spawn command: prefer direct node invocation to avoid cmd.exe ENOENT in Git Bash
    let spawnCmd, spawnArgs;
    if (process.platform === 'win32' && CODEX_EXE.endsWith('.cmd')) {
      // .cmd shim wraps: node <prefix>/node_modules/@openai/codex/bin/codex.js
      const prefix = path.dirname(CODEX_EXE);
      const jsEntry = path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(jsEntry)) {
        spawnCmd = process.execPath; // node
        spawnArgs = [jsEntry, ...args];
      } else {
        spawnCmd = 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', CODEX_EXE, ...args];
      }
    } else {
      spawnCmd = CODEX_EXE;
      spawnArgs = args;
    }

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

    const idleController = createIdleController({
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      toolTimeoutMs: TOOL_TIMEOUT_MS,
      logPrefix: '[codex-rt]',
      onTimeout: (timeoutMs, depth) => {
        console.log('[codex-rt] idle for %ds (depth=%d), killing',
          Math.round(timeoutMs / 1000), depth);
        settle(new Error(`codex idle for ${Math.round(timeoutMs / 1000)}s`));
        killTree(child.pid);
      }
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const heartbeatInterval = setInterval(() => heartbeat(), HEARTBEAT_INTERVAL_MS);

    function settle(err, result) {
      if (settled) return;
      settled = true;
      idleController.dispose();
      clearInterval(heartbeatInterval);
      try {
        fs.unlinkSync(msgFile);
      } catch (err) {
        console.warn('[codex-rt] temp message cleanup failed:', err.message);
      }
      if (err) reject(err); else resolve(result);
    }

    idleController.touch();

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
      idleController.touch();
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
            idleController.enterToolExecution();
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
            } catch (err) {
              console.error('[codex-rt] onProgress callback failed:', err.message);
            }
          }
        }

        // item.completed — tool execution finished (only for non-agent_message items)
        if (obj.type === 'item.completed' && obj.item?.type !== 'agent_message') {
          idleController.exitToolExecution();
        }

        // turn.completed — accumulate tokens/cost + reset tool execution depth
        if (obj.type === 'turn.completed') {
          const usage = obj.usage || {};
          totalTokens.input += usage.input_tokens || 0;
          totalTokens.output += usage.output_tokens || 0;
          if (obj.cost) totalCost += obj.cost;
          console.log('[codex-rt] turn.completed: tokens=%j (cumulative: %j)',
            usage, totalTokens);
          // turn.completed means all items in this turn are done — reset depth
          // (prevents stale depth from missed item.completed events)
          idleController.forceResetDepth('turn.completed');
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
      idleController.touch();
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
    supportsReview: true,
    supportsSessionResume: true,
    supportsModelSelection: true,
    supportsBudgetLimit: false,
    supportsToolRestriction: false,
    supportsEffortLevel: false,
  };
}

module.exports = { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities };
