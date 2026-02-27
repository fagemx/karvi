const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const EDDA_CMD = process.env.EDDA_CMD || (process.platform === 'win32' ? 'edda.cmd' : 'edda');
const WORKSPACE = path.resolve(DIR, '..', '..', '..');

// --- YAML helpers (hand-built, zero dependencies) ---

function yamlEscape(str) {
  // Indent every line by 6 spaces for YAML block scalar continuation
  return String(str || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .join('\n      ');
}

function buildPlanYaml(plan) {
  const planName = `karvi-${plan.taskId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const timeoutSec = plan.timeoutSec || 300;

  return [
    `name: ${planName}`,
    `description: "Karvi task dispatch: ${plan.taskId}"`,
    `purpose: "Execute karvi task ${plan.taskId}"`,
    `timeout_sec: ${timeoutSec}`,
    `max_attempts: 3`,
    `on_fail: auto_retry`,
    `tags: [karvi, ${plan.taskId}]`,
    `phases:`,
    `  - id: execute`,
    `    prompt: |`,
    `      ${yamlEscape(plan.message)}`,
    `    timeout_sec: ${timeoutSec}`,
    `    on_fail: auto_retry`,
    `    permission_mode: bypassPermissions`,
  ].join('\n') + '\n';
}

// --- Dispatch ---

function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const planName = `karvi-${plan.taskId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const workDir = plan.workingDir || WORKSPACE;

    // Write plan YAML to conductor directory
    const planDir = path.join(workDir, '.edda', 'conductor', planName);
    try {
      fs.mkdirSync(planDir, { recursive: true });
    } catch (err) {
      return reject(new Error(`Failed to create plan dir ${planDir}: ${err.message}`));
    }

    const planFile = path.join(planDir, 'plan.yaml');
    const yamlContent = buildPlanYaml(plan);

    try {
      fs.writeFileSync(planFile, yamlContent, 'utf8');
    } catch (err) {
      return reject(new Error(`Failed to write plan YAML: ${err.message}`));
    }

    // Spawn edda conductor
    const args = ['conduct', 'run', planFile, '--cwd', workDir];

    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : EDDA_CMD;
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', EDDA_CMD, ...args]
      : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: workDir,
      windowsHide: true,
      shell: false,
      timeout: (plan.timeoutSec || 300) * 1000 + 30000, // extra 30s buffer
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));

    child.on('error', reject);

    child.on('close', code => {
      // Read conductor state for structured result
      let state = null;
      try {
        const stateFile = path.join(workDir, '.edda', 'conductor', planName, 'state.json');
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        // state.json may not exist if conductor crashed early
      }

      if (code !== 0 && !state) {
        return reject(new Error(stderr || stdout || `edda exited with code ${code}`));
      }

      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        parsed: state,
        planName,
      });
    });
  });
}

// --- Extract helpers ---

function extractReplyText(result) {
  const state = result?.parsed;
  if (!state) return result?.stdout?.slice(-2000) || '(empty reply)';

  // Find the last passed phase and extract any result text
  const phases = state.phases || [];
  for (let i = phases.length - 1; i >= 0; i--) {
    const ph = phases[i];
    if (ph.status === 'Passed' || ph.status === 'passed') {
      if (ph.result_text) return ph.result_text;
    }
    if (ph.error?.message) {
      return `Phase ${ph.id} failed: ${ph.error.message}`;
    }
  }

  // Fallback: plan-level status
  if (state.plan_status === 'Completed' || state.plan_status === 'completed') {
    return `Plan completed (${phases.filter(p => p.status === 'Passed' || p.status === 'passed').length} phases passed)`;
  }

  return result?.stdout?.slice(-2000) || '(empty reply)';
}

function extractSessionId(result) {
  return result?.planName || null;
}

function capabilities() {
  return {
    runtime: 'edda',
    supportsReview: false,
    supportsSessionResume: false,
    supportsMultiPhase: true,
    supportsBudgetTracking: true,
    supportsAutoCheck: true,
  };
}

module.exports = { dispatch, extractReplyText, extractSessionId, capabilities };
