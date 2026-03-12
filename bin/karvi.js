#!/usr/bin/env node
'use strict';
/**
 * bin/karvi.js — Karvi CLI entry point
 *
 * Usage:
 *   karvi start            start the server
 *   karvi go <issues...>   dispatch GitHub issues
 *   karvi status           show task states
 *   karvi init             create .env config in cwd
 *   karvi --version        show version
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(PKG_ROOT, 'package.json')).version;

const [cmd, ...rest] = process.argv.slice(2);

// --- Help ---
function printHelp() {
  console.log(`
  Karvi v${VERSION} — AI Task Orchestration Engine

  Usage: karvi <command> [options]

  Commands:
    start            Start the server (port 3461 by default)
    go <issues...>   Dispatch GitHub issues (e.g. karvi go 123 456)
    status           Show current task states
    init             Create .env config in current directory

  Options:
    -v, --version    Show version
    -h, --help       Show this help

  Examples:
    karvi start                  start server
    karvi go 279                 dispatch issue #279
    karvi go 276 288 -y          dispatch multiple, skip confirm
    karvi status                 check task progress
    karvi init                   generate .env template

  Docs: https://github.com/fagemx/karvi
`);
}

// --- Commands ---

function cmdStart() {
  const env = { ...process.env };
  // Tell server where the package lives (for index.html, skills, etc.)
  env.KARVI_PKG_DIR = env.KARVI_PKG_DIR || PKG_ROOT;
  // Default data paths to cwd (user's project directory)
  env.DATA_DIR = env.DATA_DIR || process.cwd();
  env.PROJECT_ROOT = env.PROJECT_ROOT || process.cwd();

  const serverJs = path.join(PKG_ROOT, 'server', 'server.js');
  const child = spawn(process.execPath, [serverJs, ...rest], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code || 0));
  // Forward signals
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => child.kill(sig));
  }
}

function cmdGo() {
  const goJs = path.join(PKG_ROOT, 'scripts', 'go.js');
  const child = spawn(process.execPath, [goJs, ...rest], {
    cwd: process.cwd(),
    env: { ...process.env, KARVI_PKG_DIR: PKG_ROOT },
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code || 0));
}

function cmdStatus() {
  const port = process.env.KARVI_PORT || process.env.PORT || 3461;
  const req = http.get(`http://localhost:${port}/api/board`, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      try {
        const board = JSON.parse(data);
        const tasks = board.taskPlan?.tasks || [];
        if (tasks.length === 0) {
          console.log('\n  No tasks on board.\n');
          return;
        }
        console.log('');
        console.log('  ' + 'TASK'.padEnd(16) + 'STATUS'.padEnd(14) + 'STEPS');
        console.log('  ' + '-'.repeat(60));
        for (const t of tasks) {
          const steps = (t.steps || [])
            .map((s) => `${s.type}:${s.state}`)
            .join(' > ');
          console.log('  ' + t.id.padEnd(16) + t.status.padEnd(14) + (steps || '(no steps)'));
        }
        console.log('');
      } catch {
        console.error('  Failed to parse board response.');
        process.exit(1);
      }
    });
  });
  req.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n  Server not running on port ${port}. Start with: karvi start\n`);
    } else {
      console.error(`\n  Error: ${err.message}\n`);
    }
    process.exit(1);
  });
}

function cmdInit() {
  const dest = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(dest)) {
    console.log('\n  .env already exists in this directory. Skipping.\n');
    return;
  }
  const template = path.join(PKG_ROOT, 'env.template');
  if (!fs.existsSync(template)) {
    console.error('\n  env.template not found in package. Cannot initialize.\n');
    process.exit(1);
  }
  fs.copyFileSync(template, dest);
  console.log('\n  Created .env from template. Edit it to configure Karvi.\n');
}

// --- Routing ---

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
} else if (cmd === '--version' || cmd === '-v') {
  console.log(`karvi v${VERSION}`);
} else if (cmd === 'start') {
  cmdStart();
} else if (cmd === 'go') {
  cmdGo();
} else if (cmd === 'status') {
  cmdStatus();
} else if (cmd === 'init') {
  cmdInit();
} else {
  console.error(`\n  Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(1);
}
