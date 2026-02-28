#!/usr/bin/env node
/**
 * storage.js — Storage backend factory
 *
 * Returns the configured storage backend based on KARVI_STORAGE env var.
 * Defaults to 'json' (file-based). Supports lazy require to avoid loading
 * unused backends.
 *
 * Usage:
 *   const storage = require('./storage');
 *   const board = storage.readBoard('/path/to/board.json');
 *   storage.writeBoard('/path/to/board.json', board);
 *   storage.appendLog('/path/to/log.jsonl', entry);
 *
 * Environment:
 *   KARVI_STORAGE=json    (default) — JSON file backend with atomic writes
 *   KARVI_STORAGE=sqlite  (stub)    — future SQLite backend
 */

const BACKEND = (process.env.KARVI_STORAGE || 'json').toLowerCase();

const BACKENDS = {
  json: () => require('./storage-json'),
  sqlite: () => require('./storage-sqlite'),
};

const factory = BACKENDS[BACKEND];
if (!factory) {
  throw new Error(
    `Unknown storage backend: "${BACKEND}". `
    + `Supported: ${Object.keys(BACKENDS).join(', ')}. `
    + 'Set KARVI_STORAGE=json (default) or KARVI_STORAGE=sqlite.'
  );
}

module.exports = factory();
