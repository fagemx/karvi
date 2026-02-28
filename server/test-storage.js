#!/usr/bin/env node
/**
 * test-storage.js — Unit tests for storage-json.js, storage-sqlite.js, and storage.js
 *
 * Run: node server/test-storage.js
 *
 * Tests the JSON file storage backend (primary), the SQLite stub, and the
 * storage factory. All file operations use temp directories for isolation.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const storageJson = require('./storage-json');
const storageSqlite = require('./storage-sqlite');

let tmpDir;
let passed = 0;
let failed = 0;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-test-storage-'));
  console.log(`[test] tmpDir: ${tmpDir}`);
}

function teardown() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

// Helper: create a board path inside tmpDir
function boardPath(name) {
  return path.join(tmpDir, name || 'board.json');
}

// Helper: create a log path inside tmpDir
function logPath(name) {
  return path.join(tmpDir, name || 'task-log.jsonl');
}

// Helper: minimal valid board object
function sampleBoard(overrides) {
  return {
    version: 1,
    projectName: 'test-project',
    tasks: [
      { id: 'T1', title: 'First task', status: 'backlog' },
      { id: 'T2', title: 'Second task', status: 'done' },
    ],
    controls: {},
    ...overrides,
  };
}

// =============================================================================
// storage-json.js tests
// =============================================================================

function test_boardExists_missing() {
  test('1. boardExists returns false for missing file', () => {
    const bp = boardPath('nonexistent.json');
    assert.strictEqual(storageJson.boardExists(bp), false);
  });
}

function test_writeRead_roundtrip() {
  test('2. writeBoard + readBoard roundtrip preserves all fields', () => {
    const bp = boardPath('roundtrip.json');
    const board = sampleBoard();
    storageJson.writeBoard(bp, board);
    const loaded = storageJson.readBoard(bp);
    assert.deepStrictEqual(loaded, board);
  });
}

function test_writeBoard_nested_dir() {
  test('3. writeBoard works in nested directory', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'board.json');
    const dir = path.dirname(nested);
    // writeBoard expects the parent dir to exist (it writes a .tmp file there),
    // which mirrors real usage in blackboard-server.js.
    fs.mkdirSync(dir, { recursive: true });
    const board = sampleBoard({ projectName: 'nested' });
    storageJson.writeBoard(nested, board);
    assert.strictEqual(fs.existsSync(nested), true);
    const loaded = storageJson.readBoard(nested);
    assert.strictEqual(loaded.projectName, 'nested');
  });
}

function test_readBoard_missing() {
  test('4. readBoard throws for missing file', () => {
    const bp = boardPath('missing.json');
    assert.throws(() => {
      storageJson.readBoard(bp);
    }, /ENOENT|no such file/i);
  });
}

function test_writeBoard_overwrite() {
  test('5. writeBoard overwrites existing board', () => {
    const bp = boardPath('overwrite.json');
    storageJson.writeBoard(bp, sampleBoard({ projectName: 'v1' }));
    storageJson.writeBoard(bp, sampleBoard({ projectName: 'v2' }));
    const loaded = storageJson.readBoard(bp);
    assert.strictEqual(loaded.projectName, 'v2');
  });
}

function test_boardExists_true() {
  test('6. boardExists returns true after writeBoard', () => {
    const bp = boardPath('exists-check.json');
    storageJson.writeBoard(bp, sampleBoard());
    assert.strictEqual(storageJson.boardExists(bp), true);
  });
}

function test_appendLog_creates() {
  test('7. appendLog creates log file if missing', () => {
    const lp = logPath('new-log.jsonl');
    assert.strictEqual(fs.existsSync(lp), false);
    storageJson.appendLog(lp, { action: 'test', ts: Date.now() });
    assert.strictEqual(fs.existsSync(lp), true);
  });
}

function test_appendLog_appends() {
  test('8. appendLog appends entries correctly', () => {
    const lp = logPath('append.jsonl');
    const entry1 = { action: 'create', taskId: 'T1', ts: 1 };
    const entry2 = { action: 'update', taskId: 'T2', ts: 2 };
    const entry3 = { action: 'delete', taskId: 'T3', ts: 3 };

    storageJson.appendLog(lp, entry1);
    storageJson.appendLog(lp, entry2);
    storageJson.appendLog(lp, entry3);

    const lines = fs.readFileSync(lp, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3);
    assert.deepStrictEqual(JSON.parse(lines[0]), entry1);
    assert.deepStrictEqual(JSON.parse(lines[1]), entry2);
    assert.deepStrictEqual(JSON.parse(lines[2]), entry3);
  });
}

function test_ensureLogFile_creates() {
  test('9. ensureLogFile creates empty file if missing', () => {
    const lp = logPath('ensure.jsonl');
    assert.strictEqual(fs.existsSync(lp), false);
    storageJson.ensureLogFile(lp);
    assert.strictEqual(fs.existsSync(lp), true);
    assert.strictEqual(fs.readFileSync(lp, 'utf8'), '');
  });
}

function test_ensureLogFile_idempotent() {
  test('10. ensureLogFile does not overwrite existing log', () => {
    const lp = logPath('ensure-idem.jsonl');
    storageJson.appendLog(lp, { action: 'first' });
    storageJson.ensureLogFile(lp);
    const content = fs.readFileSync(lp, 'utf8').trim();
    assert.strictEqual(content.length > 0, true, 'existing content should be preserved');
    assert.deepStrictEqual(JSON.parse(content), { action: 'first' });
  });
}

function test_multiWrite_integrity() {
  test('11. Multiple writeBoard calls preserve integrity', () => {
    const bp = boardPath('multi-write.json');
    for (let i = 0; i < 20; i++) {
      storageJson.writeBoard(bp, sampleBoard({ projectName: `iter-${i}` }));
    }
    const loaded = storageJson.readBoard(bp);
    assert.strictEqual(loaded.projectName, 'iter-19');
    assert.strictEqual(loaded.tasks.length, 2);
  });
}

function test_largeBoard_roundtrip() {
  test('12. Large board (many tasks) roundtrip', () => {
    const bp = boardPath('large.json');
    const tasks = [];
    for (let i = 0; i < 500; i++) {
      tasks.push({ id: `T${i}`, title: `Task number ${i}`, status: 'backlog' });
    }
    const board = sampleBoard({ tasks });
    storageJson.writeBoard(bp, board);
    const loaded = storageJson.readBoard(bp);
    assert.strictEqual(loaded.tasks.length, 500);
    assert.strictEqual(loaded.tasks[499].id, 'T499');
  });
}

function test_specialChars_roundtrip() {
  test('13. Board with special characters roundtrip', () => {
    const bp = boardPath('special.json');
    const board = sampleBoard({
      projectName: '\u9805\u76EE\u540D\u7A31 \u2014 "quotes" & <angles> \\\\ backslash',
      tasks: [
        { id: 'T1', title: '\u30BF\u30B9\u30AF with \u00E9mojis \uD83C\uDF89 and newline\nin title', status: 'backlog' },
        { id: 'T2', title: 'null \u0000 byte and tab\there', status: 'done' },
      ],
    });
    storageJson.writeBoard(bp, board);
    const loaded = storageJson.readBoard(bp);
    assert.strictEqual(loaded.projectName, board.projectName);
    assert.strictEqual(loaded.tasks[0].title, board.tasks[0].title);
    assert.strictEqual(loaded.tasks[1].title, board.tasks[1].title);
  });
}

function test_corruptedJson() {
  test('14. readBoard throws on corrupted JSON', () => {
    const bp = boardPath('corrupt.json');
    fs.writeFileSync(bp, '{ this is not valid json !!!', 'utf8');
    assert.throws(() => {
      storageJson.readBoard(bp);
    }, /Unexpected token|JSON/i);
  });
}

function test_jsonExportsName() {
  test('15. storage-json exports name = "json"', () => {
    assert.strictEqual(storageJson.name, 'json');
  });
}

// =============================================================================
// storage-sqlite.js tests
// =============================================================================

function test_sqliteLoads() {
  test('16. storage-sqlite module loads without error', () => {
    assert.ok(storageSqlite, 'module should be truthy');
    assert.strictEqual(storageSqlite.name, 'sqlite');
  });
}

function test_sqliteThrows() {
  test('17. All sqlite methods throw "not yet implemented"', () => {
    const methods = ['readBoard', 'writeBoard', 'appendLog', 'boardExists', 'ensureLogFile'];
    for (const m of methods) {
      assert.strictEqual(typeof storageSqlite[m], 'function', `${m} should be a function`);
      assert.throws(() => {
        storageSqlite[m]('dummy');
      }, /not yet implemented/i, `${m} should throw NOT_IMPLEMENTED`);
    }
  });
}

function test_sqliteInterfaceShape() {
  test('18. storage-sqlite exports same interface shape as storage-json', () => {
    const jsonKeys = Object.keys(storageJson).sort();
    const sqliteKeys = Object.keys(storageSqlite).sort();
    assert.deepStrictEqual(sqliteKeys, jsonKeys,
      'both backends should export the same set of keys');
  });
}

// =============================================================================
// storage.js factory tests
// =============================================================================

function test_factoryApiShape() {
  test('19. Default storage export provides expected API shape', () => {
    const storage = require('./storage');
    const requiredMethods = ['readBoard', 'writeBoard', 'appendLog', 'boardExists', 'ensureLogFile'];
    for (const m of requiredMethods) {
      assert.strictEqual(typeof storage[m], 'function', `storage.${m} should be a function`);
    }
    assert.ok(storage.name, 'storage should have a name property');
  });
}

function test_factoryDefaultJson() {
  test('20. Factory returns json backend by default', () => {
    if (process.env.KARVI_STORAGE && process.env.KARVI_STORAGE !== 'json') {
      console.log('    (skipped: KARVI_STORAGE=' + process.env.KARVI_STORAGE + ')');
      passed++;
      return;
    }
    const storage = require('./storage');
    assert.strictEqual(storage.name, 'json');
  });
}

// =============================================================================
// Run all tests
// =============================================================================

function main() {
  console.log('=== Storage Tests ===');
  setup();

  try {
    // storage-json.js
    console.log('\n--- storage-json.js ---\n');
    test_boardExists_missing();
    test_writeRead_roundtrip();
    test_writeBoard_nested_dir();
    test_readBoard_missing();
    test_writeBoard_overwrite();
    test_boardExists_true();
    test_appendLog_creates();
    test_appendLog_appends();
    test_ensureLogFile_creates();
    test_ensureLogFile_idempotent();
    test_multiWrite_integrity();
    test_largeBoard_roundtrip();
    test_specialChars_roundtrip();
    test_corruptedJson();
    test_jsonExportsName();

    // storage-sqlite.js
    console.log('\n--- storage-sqlite.js ---\n');
    test_sqliteLoads();
    test_sqliteThrows();
    test_sqliteInterfaceShape();

    // storage.js factory
    console.log('\n--- storage.js (factory) ---\n');
    test_factoryApiShape();
    test_factoryDefaultJson();
  } finally {
    teardown();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${passed + failed} total ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
