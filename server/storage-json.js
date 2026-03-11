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
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  
  if (typeof board._version !== 'number') {
    board._version = 0;
  }
  
  return board;
}

function writeBoard(boardPath, board) {
  const { OptimisticLockError } = require('./errors');
  
  if (typeof board._version !== 'number') {
    board._version = 0;
  }
  
  let currentVersion = 0;
  try {
    const current = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    currentVersion = current._version || 0;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[storage] warning: could not read board for version check:', err.message);
    }
    currentVersion = 0;
  }
  
  if (board._version !== currentVersion) {
    throw new OptimisticLockError(
      `Version conflict: expected ${currentVersion}, got ${board._version}`,
      currentVersion,
      board._version
    );
  }
  
  board._version++;
  
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
    fs.writeFileSync(logPath, '', 'utf8');
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
