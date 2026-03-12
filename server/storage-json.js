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
 *   readLogEntries(logPath, filters) → Promise<Entry[]>
 *   readArchiveEntries(archivePath, opts) → { total, entries }
 *   boardExists(boardPath) → boolean
 *   ensureLogFile(logPath) → void
 */
const fs = require('fs');
const readline = require('readline');
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

/**
 * 逐行 stream 讀取 JSONL，邊讀邊 filter，收集到記憶體的只有匹配的 entries。
 * @param {string} logPath - JSONL 檔案路徑
 * @param {object} filters - { taskId, event, user, from, to }
 * @returns {Promise<object[]>}
 */
function readLogEntries(logPath, filters) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(logPath)) return resolve([]);
    const entries = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(logPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const entry = JSON.parse(trimmed);
        if (matchLogEntry(entry, filters)) {
          entries.push(entry);
        }
      } catch {
        // 跳過無法解析的行
      }
    });
    rl.on('close', () => resolve(entries));
    rl.on('error', reject);
  });
}

/** filter 匹配邏輯（從 routes/logs.js 搬入） */
function matchLogEntry(entry, filters) {
  if (!filters) return true;
  if (filters.taskId) {
    const entryTaskId = entry.taskId || entry.data?.taskId || null;
    if (entryTaskId !== filters.taskId) return false;
  }
  if (filters.event && entry.event !== filters.event) return false;
  if (filters.user && entry.user !== filters.user) return false;
  if (filters.from && entry.ts < filters.from) return false;
  if (filters.to && entry.ts > filters.to) return false;
  return true;
}

/**
 * 讀取 JSONL archive 檔案，支援 offset/limit 分頁。
 * @param {string} archivePath - JSONL archive 路徑
 * @param {object} opts - { offset, limit }
 * @returns {{ total: number, entries: object[] }}
 */
function readArchiveEntries(archivePath, opts) {
  if (!fs.existsSync(archivePath)) return { total: 0, entries: [] };
  const offset = (opts && opts.offset) || 0;
  const limit = (opts && opts.limit) || 100;
  const lines = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  const end = Math.min(offset + limit, lines.length);
  for (let i = offset; i < end; i++) {
    entries.push(JSON.parse(lines[i]));
  }
  return { total: lines.length, entries };
}

module.exports = {
  name: 'json',
  readBoard,
  writeBoard,
  appendLog,
  readLogEntries,
  readArchiveEntries,
  boardExists,
  ensureLogFile,
};
