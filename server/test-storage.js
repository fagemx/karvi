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
    const board = storageJson.readBoard(bp);
    board.projectName = 'v2';
    storageJson.writeBoard(bp, board);
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
    storageJson.writeBoard(bp, sampleBoard({ projectName: 'iter-0' }));
    for (let i = 1; i < 20; i++) {
      const board = storageJson.readBoard(bp);
      board.projectName = `iter-${i}`;
      storageJson.writeBoard(bp, board);
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

function test_sqliteInterfaceShape() {
  test('17. storage-sqlite exports same core interface as storage-json', () => {
    const jsonKeys = Object.keys(storageJson).sort();
    const sqliteKeys = Object.keys(storageSqlite).filter(k => k !== 'closeAll').sort();
    assert.deepStrictEqual(sqliteKeys, jsonKeys,
      'both backends should export the same set of core keys');
  });
}

function test_sqliteBoardRoundtrip() {
  test('18. sqlite: writeBoard + readBoard roundtrip', () => {
    const bp = boardPath('sqlite-roundtrip.json');
    const board = sampleBoard({ _version: 0 });
    storageSqlite.writeBoard(bp, board);
    const loaded = storageSqlite.readBoard(bp);
    assert.strictEqual(loaded.projectName, 'test-project');
    assert.strictEqual(loaded._version, 1);
    assert.strictEqual(loaded.tasks.length, 2);
  });
}

function test_sqliteBoardExists() {
  test('19. sqlite: boardExists false then true', () => {
    const bp = boardPath('sqlite-exists.json');
    assert.strictEqual(storageSqlite.boardExists(bp), false);
    storageSqlite.writeBoard(bp, sampleBoard({ _version: 0 }));
    assert.strictEqual(storageSqlite.boardExists(bp), true);
  });
}

function test_sqliteReadBoardMissing() {
  test('20. sqlite: readBoard throws ENOENT for missing board', () => {
    const bp = boardPath('sqlite-missing.json');
    assert.throws(() => storageSqlite.readBoard(bp), (err) => err.code === 'ENOENT');
  });
}

function test_sqliteOptimisticLock() {
  test('21. sqlite: optimistic locking detects conflict', () => {
    const bp = boardPath('sqlite-lock.json');
    storageSqlite.writeBoard(bp, { projectName: 'test', _version: 0 });
    const copy1 = storageSqlite.readBoard(bp);
    const copy2 = storageSqlite.readBoard(bp);
    copy1.projectName = 'handler1';
    storageSqlite.writeBoard(bp, copy1);
    copy2.projectName = 'handler2';
    assert.throws(() => storageSqlite.writeBoard(bp, copy2), (err) => err.code === 'VERSION_CONFLICT');
  });
}

async function test_sqliteAppendLog() {
  const lp = logPath('sqlite-log.jsonl');
  storageSqlite.ensureLogFile(lp);
  storageSqlite.appendLog(lp, { event: 'create', taskId: 'T1', ts: '2026-01-01' });
  storageSqlite.appendLog(lp, { event: 'update', taskId: 'T2', ts: '2026-01-05' });
  // verify by reading back
  const r = await storageSqlite.readLogEntries(lp, {});
  assert.strictEqual(r.length, 2, 'should have 2 entries');
  console.log('  PASS  22. sqlite: appendLog + ensureLogFile');
  passed++;
}

async function test_sqliteReadLogEntries() {
  const lp = logPath('sqlite-read-log.jsonl');
  storageSqlite.appendLog(lp, { event: 'create', taskId: 'T1', ts: '2026-01-01' });
  storageSqlite.appendLog(lp, { event: 'update', taskId: 'T2', ts: '2026-01-05' });
  storageSqlite.appendLog(lp, { event: 'create', taskId: 'T3', ts: '2026-01-10' });

  const all = await storageSqlite.readLogEntries(lp, {});
  assert.strictEqual(all.length, 3);

  const byTask = await storageSqlite.readLogEntries(lp, { taskId: 'T2' });
  assert.strictEqual(byTask.length, 1);

  const byEvent = await storageSqlite.readLogEntries(lp, { event: 'create' });
  assert.strictEqual(byEvent.length, 2);

  const byTime = await storageSqlite.readLogEntries(lp, { from: '2026-01-03', to: '2026-01-07' });
  assert.strictEqual(byTime.length, 1);

  console.log('  PASS  23. sqlite: readLogEntries filtering');
  passed++;
}

function test_sqliteReadArchiveEntries() {
  test('24. sqlite: readArchiveEntries pagination', () => {
    const ap = logPath('sqlite-archive.jsonl');
    for (let i = 0; i < 10; i++) {
      storageSqlite.appendLog(ap, { id: `sig-${i}`, ts: `2026-01-${String(i + 1).padStart(2, '0')}` });
    }
    const page1 = storageSqlite.readArchiveEntries(ap, { offset: 0, limit: 3 });
    assert.strictEqual(page1.total, 10);
    assert.strictEqual(page1.entries.length, 3);
    assert.strictEqual(page1.entries[0].id, 'sig-0');

    const page2 = storageSqlite.readArchiveEntries(ap, { offset: 8, limit: 5 });
    assert.strictEqual(page2.entries.length, 2);
    assert.strictEqual(page2.entries[0].id, 'sig-8');
  });
}

// =============================================================================
// storage.js factory tests
// =============================================================================

function test_factoryApiShape() {
  test('19. Default storage export provides expected API shape', () => {
    const storage = require('./storage');
    const requiredMethods = ['readBoard', 'writeBoard', 'appendLog', 'readLogEntries', 'readArchiveEntries', 'boardExists', 'ensureLogFile'];
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
// Optimistic Locking Tests
// =============================================================================

function test_versionIncrement() {
  console.log('Test: version increments on write');
  
  const bp = boardPath('version-test.json');
  const board = { projectName: 'test', _version: 0 };
  storageJson.writeBoard(bp, board);
  
  const reloaded = storageJson.readBoard(bp);
  assert(reloaded._version === 1, 'Version should be 1 after first write');
  
  storageJson.writeBoard(bp, reloaded);
  const reloaded2 = storageJson.readBoard(bp);
  assert(reloaded2._version === 2, 'Version should be 2 after second write');
  
  console.log('✓ Version increment works');
}

function test_conflictDetection() {
  console.log('Test: conflict detection');
  
  const bp = boardPath('conflict-test.json');
  
  // Write initial board
  const board1 = { projectName: 'test', _version: 0 };
  storageJson.writeBoard(bp, board1);
  
  // Two handlers read the same version
  const copy1 = storageJson.readBoard(bp);
  const copy2 = storageJson.readBoard(bp);
  
  // First handler writes successfully
  copy1.projectName = 'handler1';
  storageJson.writeBoard(bp, copy1);
  
  // Second handler should fail (version mismatch)
  copy2.projectName = 'handler2';
  try {
    storageJson.writeBoard(bp, copy2);
    assert(false, 'Should have thrown OptimisticLockError');
  } catch (err) {
    assert(err.code === 'VERSION_CONFLICT', 'Should be VERSION_CONFLICT error');
    assert(err.expectedVersion === 2, 'Expected version should be 2 (current on disk)');
    assert(err.actualVersion === 1, 'Actual version should be 1 (stale copy)');
  }
  
  console.log('✓ Conflict detection works');
}

function test_backwardCompatibility() {
  console.log('Test: backward compatibility (no _version field)');
  
  // Write board without _version field using raw fs
  const board = { projectName: 'legacy' };
  const tmpPath = path.join(os.tmpdir(), `test-board-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(board, null, 2));
  
  // Read should add _version
  const loaded = storageJson.readBoard(tmpPath);
  assert(loaded._version === 0, 'Should initialize _version to 0');
  
  // Write should succeed
  storageJson.writeBoard(tmpPath, loaded);
  const reloaded = storageJson.readBoard(tmpPath);
  assert(reloaded._version === 1, 'Version should be 1 after write');
  
  fs.unlinkSync(tmpPath);
  console.log('✓ Backward compatibility works');
}

function test_lockfileCleanup() {
  test('26. writeBoard lockfile is cleaned up after write', () => {
    const bp = boardPath('lockfile-cleanup.json');
    storageJson.writeBoard(bp, sampleBoard());
    // lockfile 應該在 writeBoard 完成後被清除
    assert.strictEqual(fs.existsSync(bp + '.lock'), false, 'lockfile should be cleaned up');
  });
}

function test_lockfileCleanupOnError() {
  test('27. writeBoard lockfile is cleaned up on version conflict', () => {
    const bp = boardPath('lockfile-error.json');
    storageJson.writeBoard(bp, sampleBoard());
    const stale = { ...sampleBoard(), _version: 999 };
    try {
      storageJson.writeBoard(bp, stale);
    } catch (err) {
      assert.strictEqual(err.code, 'VERSION_CONFLICT');
    }
    // lockfile 應該在 error path 也被清除
    assert.strictEqual(fs.existsSync(bp + '.lock'), false, 'lockfile should be cleaned up after error');
  });
}

function test_staleLockRecovery() {
  test('28. writeBoard recovers from stale lockfile', () => {
    const bp = boardPath('stale-lock.json');
    // 建立 stale lockfile（修改時間設為過去）
    const lockPath = bp + '.lock';
    fs.writeFileSync(lockPath, '99999\t0\n');
    // 手動設定 mtime 為 30 秒前，確保超過 STALE_LOCK_MS
    const past = new Date(Date.now() - 30_000);
    fs.utimesSync(lockPath, past, past);
    // writeBoard 應該能清除 stale lock 並成功寫入
    storageJson.writeBoard(bp, sampleBoard());
    const loaded = storageJson.readBoard(bp);
    assert.strictEqual(loaded._version, 1);
    assert.strictEqual(fs.existsSync(lockPath), false, 'stale lockfile should be cleaned up');
  });
}

// =============================================================================
// readLogEntries tests
// =============================================================================

async function test_readLogEntries_basic() {
  const lp = logPath('read-log.jsonl');
  storageJson.appendLog(lp, { event: 'create', taskId: 'T1', ts: '2026-01-01T00:00:00Z' });
  storageJson.appendLog(lp, { event: 'update', taskId: 'T2', ts: '2026-01-02T00:00:00Z' });
  storageJson.appendLog(lp, { event: 'create', taskId: 'T3', ts: '2026-01-03T00:00:00Z' });

  const all = await storageJson.readLogEntries(lp, {});
  assert.strictEqual(all.length, 3, 'should return all 3 entries');

  const filtered = await storageJson.readLogEntries(lp, { taskId: 'T2' });
  assert.strictEqual(filtered.length, 1, 'should return 1 entry for T2');
  assert.strictEqual(filtered[0].taskId, 'T2');

  const byEvent = await storageJson.readLogEntries(lp, { event: 'create' });
  assert.strictEqual(byEvent.length, 2, 'should return 2 create events');

  console.log('  PASS  21. readLogEntries basic filtering');
  passed++;
}

async function test_readLogEntries_time_filter() {
  const lp = logPath('read-log-time.jsonl');
  storageJson.appendLog(lp, { event: 'a', ts: '2026-01-01T00:00:00Z' });
  storageJson.appendLog(lp, { event: 'b', ts: '2026-01-05T00:00:00Z' });
  storageJson.appendLog(lp, { event: 'c', ts: '2026-01-10T00:00:00Z' });

  const result = await storageJson.readLogEntries(lp, {
    from: '2026-01-03T00:00:00Z',
    to: '2026-01-07T00:00:00Z',
  });
  assert.strictEqual(result.length, 1, 'should return 1 entry in time range');
  assert.strictEqual(result[0].event, 'b');

  console.log('  PASS  22. readLogEntries time range filtering');
  passed++;
}

async function test_readLogEntries_missing_file() {
  const lp = logPath('nonexistent-log.jsonl');
  const result = await storageJson.readLogEntries(lp, {});
  assert.strictEqual(result.length, 0, 'should return empty array for missing file');

  console.log('  PASS  23. readLogEntries returns empty for missing file');
  passed++;
}

function test_readArchiveEntries_basic() {
  test('24. readArchiveEntries basic pagination', () => {
    const ap = logPath('archive.jsonl');
    for (let i = 0; i < 10; i++) {
      fs.appendFileSync(ap, JSON.stringify({ id: `sig-${i}`, ts: `2026-01-${String(i + 1).padStart(2, '0')}` }) + '\n');
    }

    const page1 = storageJson.readArchiveEntries(ap, { offset: 0, limit: 3 });
    assert.strictEqual(page1.total, 10, 'total should be 10');
    assert.strictEqual(page1.entries.length, 3, 'first page should have 3 entries');
    assert.strictEqual(page1.entries[0].id, 'sig-0');

    const page2 = storageJson.readArchiveEntries(ap, { offset: 8, limit: 5 });
    assert.strictEqual(page2.entries.length, 2, 'last page should have 2 entries');
    assert.strictEqual(page2.entries[0].id, 'sig-8');
  });
}

function test_readArchiveEntries_missing() {
  test('25. readArchiveEntries returns empty for missing file', () => {
    const result = storageJson.readArchiveEntries(logPath('nonexistent-archive.jsonl'), {});
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.entries.length, 0);
  });
}

// =============================================================================
// Run all tests
// =============================================================================

async function main() {
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

    // Optimistic locking tests
    console.log('\n--- Optimistic Locking ---\n');
    test_versionIncrement();
    test_conflictDetection();
    test_backwardCompatibility();
    test_lockfileCleanup();
    test_lockfileCleanupOnError();
    test_staleLockRecovery();

    // readLogEntries / readArchiveEntries tests
    console.log('\n--- readLogEntries / readArchiveEntries ---\n');
    await test_readLogEntries_basic();
    await test_readLogEntries_time_filter();
    await test_readLogEntries_missing_file();
    test_readArchiveEntries_basic();
    test_readArchiveEntries_missing();

    // storage-sqlite.js
    console.log('\n--- storage-sqlite.js ---\n');
    test_sqliteLoads();
    test_sqliteInterfaceShape();
    test_sqliteBoardRoundtrip();
    test_sqliteBoardExists();
    test_sqliteReadBoardMissing();
    test_sqliteOptimisticLock();
    await test_sqliteAppendLog();
    await test_sqliteReadLogEntries();
    test_sqliteReadArchiveEntries();

    // 清理 SQLite 連線
    storageSqlite.closeAll();

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
