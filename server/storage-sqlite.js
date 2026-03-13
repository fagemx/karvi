#!/usr/bin/env node
/**
 * storage-sqlite.js — SQLite storage backend
 *
 * 使用 Node.js 22+ 內建 node:sqlite (DatabaseSync) — 零外部依賴。
 * DB 檔案位置：與 boardPath 同目錄的 .karvi.db
 *
 * 設計：
 * - boards table: 以 boardPath 為 key 存 JSON blob + version
 * - logs table: append-only event log，以 logPath 為 namespace
 * - archives table: archive entries，以 archivePath 為 namespace
 * - 所有 JSON 資料以 TEXT 存，SQLite 不解析內部結構
 *
 * Interface (與 storage-json.js 相同):
 *   readBoard(boardPath) → object
 *   writeBoard(boardPath, board) → void
 *   appendLog(logPath, entry) → void
 *   readLogEntries(logPath, filters) → Promise<Entry[]>
 *   readArchiveEntries(archivePath, opts) → { total, entries }
 *   boardExists(boardPath) → boolean
 *   ensureLogFile(logPath) → void
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// DB 實例快取：同一個目錄共用同一個 DB 連線
const dbCache = new Map();

/**
 * 取得或建立 DB 連線。DB 檔案放在 filePath 同目錄下的 .karvi.db。
 * @param {string} filePath - boardPath, logPath, 或 archivePath
 * @returns {DatabaseSync}
 */
function getDb(filePath) {
  const dir = path.dirname(filePath);
  const dbPath = path.join(dir, '.karvi.db');

  if (dbCache.has(dbPath)) return dbCache.get(dbPath);

  const db = new DatabaseSync(dbPath);

  // WAL mode：讀寫併發更好，單 writer 不 block readers
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      board_key  TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      log_key    TEXT NOT NULL,
      event      TEXT,
      task_id    TEXT,
      user_name  TEXT,
      ts         TEXT,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // 加索引加速 readLogEntries 的常見 filter
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_key ON logs (log_key)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_task ON logs (log_key, task_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_event ON logs (log_key, event)
  `);

  // 不需要 archives table — appendLog 寫入 logs table，
  // readArchiveEntries 也從 logs table 讀（以 log_key 區分）。

  dbCache.set(dbPath, db);
  return db;
}

function readBoard(boardPath) {
  const db = getDb(boardPath);
  const row = db.prepare('SELECT data, version FROM boards WHERE board_key = ?').get(boardPath);
  if (!row) {
    const err = new Error(`ENOENT: board not found at ${boardPath}`);
    err.code = 'ENOENT';
    throw err;
  }
  const board = JSON.parse(row.data);
  board._version = row.version;
  return board;
}

function writeBoard(boardPath, board) {
  const { OptimisticLockError } = require('./errors');

  if (typeof board._version !== 'number') {
    board._version = 0;
  }

  const db = getDb(boardPath);
  const existing = db.prepare('SELECT version FROM boards WHERE board_key = ?').get(boardPath);
  const currentVersion = existing ? existing.version : 0;

  if (existing && board._version !== currentVersion) {
    throw new OptimisticLockError(
      `Version conflict: expected ${currentVersion}, got ${board._version}`,
      currentVersion,
      board._version
    );
  }

  board._version = currentVersion + 1;
  const now = new Date().toISOString();
  const data = JSON.stringify(board, null, 2);

  if (existing) {
    db.prepare(
      'UPDATE boards SET data = ?, version = ?, updated_at = ? WHERE board_key = ?'
    ).run(data, board._version, now, boardPath);
  } else {
    db.prepare(
      'INSERT INTO boards (board_key, data, version, updated_at) VALUES (?, ?, ?, ?)'
    ).run(boardPath, data, board._version, now);
  }
}

function appendLog(logPath, entry) {
  const db = getDb(logPath);
  const now = new Date().toISOString();
  const data = JSON.stringify(entry);

  // 從 entry 中提取可查詢欄位
  const event = entry.event || null;
  const taskId = entry.taskId || (entry.data && entry.data.taskId) || null;
  const userName = entry.user || null;
  const ts = entry.ts || null;

  db.prepare(
    'INSERT INTO logs (log_key, event, task_id, user_name, ts, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(logPath, event, taskId, userName, ts, data, now);
}

function boardExists(boardPath) {
  const db = getDb(boardPath);
  const row = db.prepare('SELECT 1 FROM boards WHERE board_key = ?').get(boardPath);
  return !!row;
}

function ensureLogFile(logPath) {
  // 對 SQLite 來說，DB 和 table 在 getDb() 就建好了，這裡只需確保 DB 已初始化
  getDb(logPath);
}

/**
 * 查詢 log entries，支援 filter: { taskId, event, user, from, to }
 * @returns {Promise<object[]>} — 回傳 Promise 以相容 JSON backend 的非同步介面
 */
function readLogEntries(logPath, filters) {
  const db = getDb(logPath);

  let sql = 'SELECT data FROM logs WHERE log_key = ?';
  const params = [logPath];

  if (filters) {
    if (filters.taskId) {
      sql += ' AND task_id = ?';
      params.push(filters.taskId);
    }
    if (filters.event) {
      sql += ' AND event = ?';
      params.push(filters.event);
    }
    if (filters.user) {
      sql += ' AND user_name = ?';
      params.push(filters.user);
    }
    if (filters.from) {
      sql += ' AND ts >= ?';
      params.push(filters.from);
    }
    if (filters.to) {
      sql += ' AND ts <= ?';
      params.push(filters.to);
    }
  }

  sql += ' ORDER BY id ASC';

  const rows = db.prepare(sql).all(...params);
  const entries = rows.map(r => JSON.parse(r.data));
  return Promise.resolve(entries);
}

/**
 * 讀取 archive entries，支援 offset/limit 分頁。
 * @returns {{ total: number, entries: object[] }}
 */
function readArchiveEntries(archivePath, opts) {
  const db = getDb(archivePath);
  const offset = (opts && opts.offset) || 0;
  const limit = (opts && opts.limit) || 100;

  // archives 和 logs 共用同一張 table，以 log_key 區分
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM logs WHERE log_key = ?').get(archivePath);
  const total = countRow ? countRow.cnt : 0;

  if (total === 0) return { total: 0, entries: [] };

  const rows = db.prepare(
    'SELECT data FROM logs WHERE log_key = ? ORDER BY id ASC LIMIT ? OFFSET ?'
  ).all(archivePath, limit, offset);

  const entries = rows.map(r => JSON.parse(r.data));
  return { total, entries };
}

/**
 * 關閉所有 DB 連線（測試清理用）
 */
function closeAll() {
  for (const [, db] of dbCache) {
    db.close();
  }
  dbCache.clear();
}

module.exports = {
  name: 'sqlite',
  readBoard,
  writeBoard,
  appendLog,
  readLogEntries,
  readArchiveEntries,
  boardExists,
  ensureLogFile,
  closeAll,
};
