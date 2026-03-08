'use strict';

const fs = require('fs');
const path = require('path');

// Check cwd first (global install), then package root (local dev)
const cwdEnv = path.resolve(process.cwd(), '.env');
const pkgEnv = path.resolve(__dirname, '..', '.env');
const envPath = fs.existsSync(cwdEnv) ? cwdEnv : pkgEnv;
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}
