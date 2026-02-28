#!/usr/bin/env node
/**
 * storage-json.js — JSON file storage backend
 *
 * Implements the storage interface for board.json + task-log.jsonl
 * using atomic writes (write to .tmp then rename) for crash safety.
 *
 * Interface:
 *   readBoard(boardPath) → object
 *   writeBoard(boardPath, board) → void
 *   appendLog(logPath, entry) → void
 *   boardExists(boardPath) → boolean
 *   ensureLogFile(logPath) → void
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function readBoard(boardPath) {
  return JSON.parse(fs.readFileSync(boardPath, 'utf8'));
}

function writeBoard(boardPath, board) {
  const dir = path.dirname(boardPath);
  const tmpPath = path.join(dir, `.board-${process.pid}-${Date.now()}.tmp`);
  const data = JSON.stringify(board, null, 2);
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, boardPath);
}

function appendLog(logPath, entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // best-effort: log append failure is non-fatal
  }
}

function boardExists(boardPath) {
  return fs.existsSync(boardPath);
}

function ensureLogFile(logPath) {
  if (!fs.existsSync(logPath)) {
    try { fs.writeFileSync(logPath, '', 'utf8'); } catch {}
  }
}

module.exports = {
  name: 'json',
  readBoard,
  writeBoard,
  appendLog,
  boardExists,
  ensureLogFile,
};
