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
 *
 * Encryption:
 *   When board.meta.encryption_enabled is true, sensitive fields are
 *   encrypted at rest using AES-256-GCM. Key from KARVI_ENCRYPTION_KEY
 *   or board.meta.encryption_key_path file.
 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');
const enc = require('./encryption');

function ensureEncryptionInitialized(boardPath, board) {
  if (board?.meta?.encryption_key_path) {
    const keyPath = path.resolve(path.dirname(boardPath), board.meta.encryption_key_path);
    if (enc.getKeyPath() !== keyPath) {
      enc.initialize({ keyPath });
    }
  }
}

function readBoard(boardPath) {
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  
  if (typeof board._version !== 'number') {
    board._version = 0;
  }
  
  ensureEncryptionInitialized(boardPath, board);
  
  if (board.meta?.encryption_enabled && enc.isEnabled()) {
    try {
      return enc.decryptBoard(board);
    } catch (err) {
      console.error('[storage] Decryption failed:', err.message);
      throw err;
    }
  }
  
  return board;
}

/**
 * 取得 lockfile 以序列化 writeBoard。
 * 使用 fs.openSync(path, 'wx') 做 atomic create — 跨 process 安全。
 * 回傳 release function；呼叫者必須在 finally 中 release。
 *
 * 若 lockfile 存在超過 STALE_LOCK_MS，視為 stale（持有者 crash），自動清除重試。
 */
const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 5_000;

function acquireLock(boardPath) {
  const lockPath = boardPath + '.lock';
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      // 'wx' = O_CREAT | O_EXCL — 只在檔案不存在時建立，atomic
      const fd = fs.openSync(lockPath, 'wx');
      // 寫入 PID + timestamp 供 stale detection
      fs.writeSync(fd, `${process.pid}\t${Date.now()}\n`);
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* 已被清除 */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // lockfile 存在 — 檢查是否 stale
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          // stale lock — 清除後重試
          try { fs.unlinkSync(lockPath); } catch { /* 另一個 process 先清了 */ }
          continue;
        }
      } catch {
        // lockfile 在 stat 前被正常 release，直接重試
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`[storage] lock timeout: could not acquire ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
      }

      // busy-wait（同步 API 限制）
      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

function writeBoard(boardPath, board) {
  const { OptimisticLockError } = require('./errors');

  if (typeof board._version !== 'number') {
    board._version = 0;
  }

  // 取得 file lock — 確保 read-check-write 是 atomic
  const releaseLock = acquireLock(boardPath);
  try {
    let currentVersion = 0;
    try {
      const currentBoard = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
      currentVersion = currentBoard._version || 0;
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

    ensureEncryptionInitialized(boardPath, board);

    let dataToWrite = board;
    if (board.meta?.encryption_enabled && enc.isEnabled() && !board.meta.encrypted_at) {
      dataToWrite = enc.encryptBoard(board);
    }

    const dir = path.dirname(boardPath);
    const tmpPath = path.join(dir, `.board-${process.pid}-${Date.now()}.tmp`);
    const data = JSON.stringify(dataToWrite, null, 2);
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, boardPath);
  } finally {
    releaseLock();
  }
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
