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
    npm run go -- 123 --repo /path override repo path
    npm run go -- 123 -y           skip confirmation

  Options:
    --skill <name>   Skill to use for the task
    --repo <path>    Working directory (default: auto-detect from git)
    -y, --yes        Skip confirmation prompt
    -h, --help       Show this help
`);
  process.exit(0);
}

const issues = [];
let skill = null;
let repoOverride = null;
let skipConfirm = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--skill' && args[i + 1]) { skill = args[++i]; continue; }
  if (arg === '--repo' && args[i + 1]) { repoOverride = args[++i]; continue; }
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
    const raw = execSync(
      `gh issue view ${num} --json title,state,url`,
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
        reject(new Error(`Cannot connect to localhost:${PORT} — is the server running? (npm start)`));
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
  const repo = detectRepo();

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
  if (skill) console.log(`  ├─ Skill:   ${skill}`);
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
    const t = { issue: num, title };
    if (skill) t.skill = skill;
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
