const { spawn } = require('child_process');
const path = require('path');

const DIR = __dirname;
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';

function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const args = ['-p'];

    // Session resume
    if (plan.sessionId) args.push('--resume', plan.sessionId);

    // JSON output
    args.push('--output-format', 'json');

    // Model selection
    if (plan.modelHint) args.push('--model', plan.modelHint);

    // Agent persona (reuse codexRole field)
    if (plan.codexRole) args.push('--agent', plan.codexRole);

    // Claude-specific extras (passthrough if present on plan)
    if (plan.maxBudgetUsd) args.push('--max-budget-usd', String(plan.maxBudgetUsd));
    if (plan.allowedTools && plan.allowedTools.length) {
      args.push('--allowedTools', ...plan.allowedTools);
    }
    if (plan.effort) args.push('--effort', plan.effort);
    if (plan.systemPrompt) args.push('--append-system-prompt', plan.systemPrompt);

    // The prompt
    args.push(plan.message);

    const workDir = plan.workingDir || path.resolve(DIR, '..');
    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : CLAUDE_CMD;
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', CLAUDE_CMD, ...args]
      : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: workDir,
      windowsHide: true,
      shell: false,
      timeout: (plan.timeoutSec || 300) * 1000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));

    child.on('error', err => reject(err));
    child.on('close', code => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}

      if (code !== 0 || parsed?.is_error) {
        return reject(new Error(
          parsed?.result || stderr || stdout || `claude exited ${code}`
        ));
      }

      resolve({ code, stdout, stderr, parsed });
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
 * Extract token usage from Claude CLI JSON output.
 * @param {object} parsed - parsed JSON from stdout
 * @param {string} stdout - raw stdout
 * @returns {object|null} { inputTokens, outputTokens, totalCost } or null
 */
function extractUsage(parsed, stdout) {
  if (!parsed) return null;
  const inputTokens = parsed.input_tokens ?? parsed.usage?.input_tokens ?? null;
  const outputTokens = parsed.output_tokens ?? parsed.usage?.output_tokens ?? null;
  const totalCost = parsed.total_cost ?? parsed.usage?.total_cost ?? null;
  if (inputTokens == null && outputTokens == null && totalCost == null) return null;
  return { inputTokens, outputTokens, totalCost };
}

module.exports = { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities };
