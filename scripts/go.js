#!/usr/bin/env node
'use strict';
/**
 * scripts/go.js — One-command task dispatch
 *
 * Usage:
 *   npm run go -- 123              dispatch issue #123
 *   npm run go -- 123 124 125      dispatch multiple issues
 *   npm run go -- 123 --skill pr   specify skill
 *   npm run go -- 123 --repo /path override working directory
 *   npm run go -- 123 -y           skip confirmation
 */
const http = require('http');
const { execSync } = require('child_process');
const readline = require('readline');

require('../server/load-env');

// --- Parse args ---
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
  Usage: npm run go -- <issue-numbers> [options]

  Examples:
    npm run go -- 123              dispatch issue #123
    npm run go -- 123 124 125      dispatch multiple issues
    npm run go -- 123 --skill pr   use specific skill
    npm run go -- 123 --runtime codex  use specific runtime
    npm run go -- 123 --repo /path override repo path
    npm run go -- 123 -y           skip confirmation

  Options:
    --skill <name>     Skill to use for the task
    --runtime <name>   Runtime to use (openclaw, codex, claude, opencode)
    --repo <path>      Working directory (default: auto-detect from git)
    -y, --yes        Skip confirmation prompt
    -h, --help       Show this help
`);
  process.exit(0);
}

const issues = [];
let skill = null;
let repoOverride = null;
let runtimeHint = null;
let skipConfirm = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--skill' && args[i + 1]) { skill = args[++i]; continue; }
  if (arg === '--repo' && args[i + 1]) { repoOverride = args[++i]; continue; }
  if (arg === '--runtime' && args[i + 1]) { runtimeHint = args[++i]; continue; }
  if (arg === '-y' || arg === '--yes') { skipConfirm = true; continue; }
  if (/^\d+$/.test(arg)) { issues.push(Number(arg)); continue; }
  // Support OWNER/REPO#123 or ORG-123 style
  if (/^[A-Z]+-\d+$/i.test(arg)) {
    const num = Number(arg.split('-').pop());
    issues.push(num);
    continue;
  }
  console.error(`  Unknown argument: ${arg}`);
  process.exit(1);
}

if (issues.length === 0) {
  console.error('  No issue numbers provided. Usage: npm run go -- <issue-number>');
  process.exit(1);
}

const PORT = process.env.KARVI_PORT || process.env.PORT || 3461;

// --- Detect repo (GitHub slug from git remote) ---
function repoSlugFromDir(cwd) {
  try {
    const opts = { encoding: 'utf8', timeout: 5000, cwd: cwd || undefined };
    const remote = execSync('git remote get-url origin', opts).trim();
    const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function detectRepo() {
  return repoSlugFromDir(repoOverride || undefined);
}

// --- Fetch issue info from GitHub ---
function fetchIssue(num) {
  try {
    // If --repo points to a different directory, resolve its GitHub slug for gh -R
    const repoFlag = repoOverride ? (() => {
      const slug = repoSlugFromDir(repoOverride);
      return slug ? `-R ${slug}` : '';
    })() : '';
    const raw = execSync(
      `gh issue view ${num} ${repoFlag} --json title,state,url`,
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(raw);
  } catch (err) {
    const stderr = err.stderr || '';
    if (stderr.includes('Could not resolve') || stderr.includes('not found')) {
      return { error: `Issue #${num} not found` };
    }
    return { error: `Failed to fetch issue #${num}: ${stderr.trim().split('\n')[0]}` };
  }
}

// --- Confirm prompt ---
function confirm(message) {
  return new Promise((resolve) => {
    if (skipConfirm) return resolve(true);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

// --- Preflight check ---
async function runPreflight() {
  console.log('\nPreflight check...');
  
  try {
    const result = await fetchPreflightFromServer();
    return handleServerPreflight(result);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      return runLocalPreflight();
    }
    throw err;
  }
}

async function fetchPreflightFromServer() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: '/api/health/preflight', method: 'GET', timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid preflight response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Preflight timeout')); });
    req.end();
  });
}

function handleServerPreflight(result) {
  const lines = [];
  const failures = [];
  
  lines.push(`  ✓ Server running (localhost:${PORT})`);
  
  if (result.checks.runtimes.count > 0) {
    const names = result.checks.runtimes.available.join(', ');
    lines.push(`  ✓ Runtimes: ${names}`);
  } else {
    lines.push('  ✗ No agent runtime found');
    failures.push({
      name: 'runtimes',
      message: 'Install at least one:\n      npm i -g @anthropic-ai/claude-code\n      npm i -g @opencode-ai/opencode\n      npm i -g @openai/codex'
    });
  }
  
  if (result.checks.gh.ok && result.checks.gh.authenticated) {
    const user = result.checks.gh.user || 'unknown';
    lines.push(`  ✓ gh authenticated (${user})`);
  } else if (!result.checks.gh.ok) {
    lines.push('  ✗ gh CLI not found');
    failures.push({ name: 'gh', message: 'Install: https://cli.github.com' });
  } else {
    lines.push('  ✗ gh not authenticated');
    failures.push({ name: 'gh', message: 'Run: gh auth login' });
  }
  
  if (result.checks.git.ok) {
    lines.push(`  ✓ git available (${result.checks.git.version})`);
  } else {
    lines.push('  ✗ git not found');
    failures.push({ name: 'git', message: 'Install: https://git-scm.com' });
  }
  
  console.log(lines.join('\n'));
  
  if (failures.length > 0) {
    console.log('\n  Dispatch aborted. Fix the issues above and retry.');
    for (const f of failures) {
      console.log(`    ${f.message}`);
    }
    return { ok: false };
  }
  
  return { ok: true };
}

function runLocalPreflight() {
  const lines = [];
  const failures = [];
  let runtimeFound = false;
  
  try {
    execSync('gh --version', { stdio: 'pipe', timeout: 5000 });
    try {
      const out = execSync('gh auth status 2>&1', { encoding: 'utf8', timeout: 5000 });
      const userMatch = out.match(/Logged in to .* account (\S+)/);
      const user = userMatch ? userMatch[1] : 'unknown';
      lines.push(`  ✓ gh authenticated (${user})`);
    } catch {
      lines.push('  ✗ gh not authenticated');
      failures.push({ name: 'gh', message: 'Run: gh auth login' });
    }
  } catch {
    lines.push('  ✗ gh CLI not found');
    failures.push({ name: 'gh', message: 'Install: https://cli.github.com' });
  }
  
  try {
    const out = execSync('git --version', { encoding: 'utf8', timeout: 5000 });
    const match = out.match(/git version ([\d.]+)/);
    const version = match ? match[1] : 'unknown';
    lines.push(`  ✓ git available (${version})`);
  } catch {
    lines.push('  ✗ git not found');
    failures.push({ name: 'git', message: 'Install: https://git-scm.com' });
  }
  
  const runtimeCommands = [
    { cmd: 'claude --version', name: 'claude' },
    { cmd: 'opencode --version', name: 'opencode' },
    { cmd: 'codex --version', name: 'codex' },
  ];
  
  for (const { cmd, name } of runtimeCommands) {
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 5000 });
      lines.push(`  ✓ Runtime CLI found: ${name}`);
      runtimeFound = true;
      break;
    } catch (err) {
      lines.push(`  - Runtime CLI not available: ${name} (${err.message})`);
    }
  }
  
  if (!runtimeFound) {
    lines.push('  ✗ No runtime CLI found');
    failures.push({
      name: 'runtimes',
      message: 'Install at least one:\n      npm i -g @anthropic-ai/claude-code\n      npm i -g @opencode-ai/opencode\n      npm i -g @openai/codex'
    });
  }
  
  console.log(lines.join('\n'));
  
  if (failures.length > 0) {
    console.log('\n  Fix the issues above and retry.');
    for (const f of failures) {
      console.log(`    ${f.message}`);
    }
    return { ok: false };
  }
  
  console.log('\n  Server not running. Start with: npm start');
  return { ok: false, needServer: true };
}

// --- POST to Karvi ---
function dispatch(payload) {
  return new Promise((resolve, reject) => {
    const token = process.env.KARVI_API_TOKEN;
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({ hostname: 'localhost', port: PORT, path: '/api/projects', method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Unexpected response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`Server not running at localhost:${PORT}\n  Start with: npm start`));
      } else {
        reject(err);
      }
    });
    req.write(body);
    req.end();
  });
}

// --- Main ---
async function main() {
  const path = require('path');
  const repo = detectRepo();
  const targetRepo = repoOverride ? path.resolve(repoOverride) : null;

  // Preflight check
  const preflight = await runPreflight();
  if (!preflight.ok) {
    process.exit(preflight.needServer ? 0 : 1);
  }

  console.log('');

  // Fetch all issues
  const issueData = [];
  for (const num of issues) {
    process.stdout.write(`  Fetching #${num}...`);
    const info = fetchIssue(num);
    if (info.error) {
      console.log(` ❌ ${info.error}`);
      process.exit(1);
    }
    if (info.state === 'CLOSED') {
      console.log(` ⚠️  Issue #${num} is closed: ${info.title}`);
      const proceed = await confirm('  Dispatch closed issue? [y/N] ');
      if (!proceed) process.exit(0);
    } else {
      console.log(` ✅ ${info.title}`);
    }
    issueData.push({ num, title: info.title, state: info.state });
  }

  // Preview
  console.log('');
  console.log('  📋 Will dispatch:');
  for (const { num, title } of issueData) {
    console.log(`  ├─ #${num} — ${title}`);
  }
  console.log(`  ├─ Repo:    ${repo || '(not detected)'}`);
  if (targetRepo) console.log(`  ├─ Target:  ${targetRepo}`);
  if (skill) console.log(`  ├─ Skill:   ${skill}`);
  if (runtimeHint) console.log(`  ├─ Runtime: ${runtimeHint}`);
  console.log(`  └─ Server:  localhost:${PORT}`);
  console.log('');

  // Confirm
  const ok = await confirm('  Proceed? [Y/n] ');
  if (!ok) {
    console.log('  Cancelled.');
    process.exit(0);
  }

  // Build payload
  const tasks = issueData.map(({ num, title }) => {
    const t = { issue: num, title, assignee: 'engineer_lite' };
    if (skill) t.skill = skill;
    if (runtimeHint) t.runtimeHint = runtimeHint;
    if (targetRepo) t.target_repo = targetRepo;
    return t;
  });

  const payload = {
    title: issues.length === 1
      ? `Dispatch #${issues[0]}`
      : `Dispatch #${issues.join(', #')}`,
    tasks,
  };
  if (repo) payload.repo = repo;

  // Dispatch
  try {
    const result = await dispatch(payload);
    console.log('');
    console.log(`  ✅ Dispatched ${result.taskCount || issues.length} task(s)!`);
    if (result.project) {
      console.log(`  ├─ Project: ${result.project.id}`);
    }
    console.log(`  └─ Dashboard: http://localhost:${PORT}`);
    console.log('');
  } catch (err) {
    console.error(`\n  ❌ ${err.message}\n`);
    process.exit(1);
  }
}

main();
