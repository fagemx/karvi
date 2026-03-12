#!/usr/bin/env node
/**
 * storage-sqlite.js — SQLite storage backend (stub)
 *
 * Placeholder for future SQLite-based storage.
 * All methods throw a clear error directing users to use the JSON backend
 * or implement the SQLite backend when needed.
 *
 * Future implementation will use Node.js 22+ built-in SQLite support
 * (node:sqlite) to maintain the zero-dependency constraint.
 */

const NOT_IMPLEMENTED = 'SQLite storage backend is not yet implemented. '
  + 'Set KARVI_STORAGE=json (default) or implement storage-sqlite.js. '
  + 'See issue #37 for roadmap.';

function readBoard(/* boardPath */) {
  throw new Error(NOT_IMPLEMENTED);
}

function writeBoard(/* boardPath, board */) {
  throw new Error(NOT_IMPLEMENTED);
}

function appendLog(/* logPath, entry */) {
  throw new Error(NOT_IMPLEMENTED);
}

function boardExists(/* boardPath */) {
  throw new Error(NOT_IMPLEMENTED);
}

function ensureLogFile(/* logPath */) {
  throw new Error(NOT_IMPLEMENTED);
}

function readLogEntries(/* logPath, filters */) {
  throw new Error(NOT_IMPLEMENTED);
}

function readArchiveEntries(/* archivePath, opts */) {
  throw new Error(NOT_IMPLEMENTED);
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
};
