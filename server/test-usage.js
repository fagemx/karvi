#!/usr/bin/env node
/**
 * test-usage.js — Unit tests for server/usage.js
 *
 * Run: node server/test-usage.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const usage = require('./usage');

let tmpDir;
let passed = 0;
let failed = 0;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-usage-test-'));
  console.log(`[test] tmpDir: ${tmpDir}`);
}

function teardown() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
    return false;
  }
  console.log(`  PASS: ${message}`);
  passed++;
  return true;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
    return false;
  }
  console.log(`  PASS: ${message}`);
  passed++;
  return true;
}

// --- Test 1: init creates usage directory ---
function test_init_creates_directory() {
  console.log('\nTest 1: init creates usage directory');
  const handle = usage.init({
    dataDir: tmpDir,
    broadcastSSE: () => {},
    readBoard: () => ({ controls: {} }),
  });
  const usageDir = path.join(tmpDir, 'usage');
  assert(fs.existsSync(usageDir), 'usage directory should exist');
  handle.stop();
}

// --- Test 2: record creates JSONL file ---
function test_record_creates_file() {
  console.log('\nTest 2: record creates JSONL file');
  usage.init({
    dataDir: tmpDir,
    broadcastSSE: () => {},
    readBoard: () => ({ controls: {} }),
  });

  usage.record('testuser', 'dispatch', { taskId: 'T1', runtime: 'openclaw' });

  const month = usage.currentMonth();
  const filePath = path.join(tmpDir, 'usage', 'testuser', `usage-${month}.jsonl`);
  assert(fs.existsSync(filePath), 'usage JSONL file should exist');

  const content = fs.readFileSync(filePath, 'utf8').trim();
  const event = JSON.parse(content);
  assertEqual(event.type, 'dispatch', 'event type should be dispatch');
  assertEqual(event.taskId, 'T1', 'event taskId should be T1');
}

// --- Test 3: record appends multiple lines ---
function test_record_appends() {
  console.log('\nTest 3: record appends valid JSONL lines');
  usage.init({
    dataDir: tmpDir,
    broadcastSSE: () => {},
    readBoard: () => ({ controls: {} }),
  });

  usage.record('testuser', 'dispatch', { taskId: 'T2' });
  usage.record('testuser', 'agent.runtime', { taskId: 'T2', durationSec: 45 });
  usage.record('testuser', 'api.tokens', { taskId: 'T2', input: 1200, output: 800 });

  const month = usage.currentMonth();
  const filePath = path.join(tmpDir, 'usage', 'testuser', `usage-${month}.jsonl`);
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  // Previous test already wrote 1 line, so we have 4 total
  assert(lines.length >= 3, `should have at least 3 lines, got ${lines.length}`);

  // Verify each line is valid JSON
  let allValid = true;
  for (const line of lines) {
    try { JSON.parse(line); } catch { allValid = false; }
  }
  assert(allValid, 'all lines should be valid JSON');
}

// --- Test 4: query returns correct aggregation ---
function test_query_aggregation() {
  console.log('\nTest 4: query returns correct aggregation');
  // Re-init to rebuild cache from files written in previous tests
  usage.init({
    dataDir: tmpDir,
    broadcastSSE: () => {},
    readBoard: () => ({ controls: {} }),
  });

  const result = usage.query('testuser');
  assertEqual(result.userId, 'testuser', 'userId should match');
  assertEqual(result.month, usage.currentMonth(), 'month should be current');
  assert(result.dispatches >= 2, `dispatches should be >= 2, got ${result.dispatches}`);
  assert(result.runtimeSec >= 45, `runtimeSec should be >= 45, got ${result.runtimeSec}`);
  assert(result.tokens.input >= 1200, `tokens.input should be >= 1200, got ${result.tokens.input}`);
  assert(result.tokens.output >= 800, `tokens.output should be >= 800, got ${result.tokens.output}`);
}

// --- Test 5: query for non-existent user returns zeroes ---
function test_query_nonexistent_user() {
  console.log('\nTest 5: query for non-existent user returns zeroes');
  const result = usage.query('nobody');
  assertEqual(result.userId, 'nobody', 'userId should match');
  assertEqual(result.dispatches, 0, 'dispatches should be 0');
  assertEqual(result.runtimeSec, 0, 'runtimeSec should be 0');
  assertEqual(result.tokens.input, 0, 'tokens.input should be 0');
  assertEqual(result.tokens.output, 0, 'tokens.output should be 0');
  assertEqual(result.events, 0, 'events should be 0');
}

// --- Test 6: summary aggregates across users ---
function test_summary() {
  console.log('\nTest 6: summary aggregates across users');

  // Add events for a second user
  usage.record('user2', 'dispatch', { taskId: 'T10' });
  usage.record('user2', 'agent.runtime', { taskId: 'T10', durationSec: 30 });

  const result = usage.summary();
  assert(result.totalUsers >= 2, `totalUsers should be >= 2, got ${result.totalUsers}`);
  assert(result.totalDispatches >= 3, `totalDispatches should be >= 3, got ${result.totalDispatches}`);
  assert(result.totalRuntimeSec >= 75, `totalRuntimeSec should be >= 75, got ${result.totalRuntimeSec}`);
  assert(Array.isArray(result.topUsers), 'topUsers should be an array');
  assert(result.topUsers.length >= 2, `topUsers should have >= 2 entries, got ${result.topUsers.length}`);
}

// --- Test 7: checkLimits triggers alert when threshold exceeded ---
function test_check_limits_alert() {
  console.log('\nTest 7: checkLimits triggers alert when threshold exceeded');
  let alertSent = false;
  let alertData = null;

  usage.init({
    dataDir: tmpDir,
    broadcastSSE: (event, data) => {
      if (event === 'usage_alert') {
        alertSent = true;
        alertData = data;
      }
    },
    readBoard: () => ({
      controls: {
        usage_limits: {
          dispatches_per_month: 3, // Low limit to trigger alert
        },
        usage_alert_threshold: 0.5,
      },
    }),
  });

  // Record enough dispatches to exceed threshold (50% of 3 = 1.5)
  usage.record('limittest', 'dispatch', { taskId: 'T100' });
  usage.record('limittest', 'dispatch', { taskId: 'T101' });

  const result = usage.checkLimits('limittest');
  assert(result.exceeded, 'exceeded should be true');
  assert(result.alerts.length > 0, 'should have at least 1 alert');
  assert(alertSent, 'SSE alert should have been sent');
  assertEqual(alertData?.metric, 'dispatches', 'alert metric should be dispatches');
}

// --- Test 8: invalid userId is rejected ---
function test_invalid_user_id() {
  console.log('\nTest 8: invalid userId is rejected');
  usage.init({
    dataDir: tmpDir,
    broadcastSSE: () => {},
    readBoard: () => ({ controls: {} }),
  });

  // Record with invalid userId (contains special characters)
  usage.record('user@bad!', 'dispatch', { taskId: 'T50' });

  // Should not create a directory for invalid userId
  const invalidDir = path.join(tmpDir, 'usage', 'user@bad!');
  assert(!fs.existsSync(invalidDir), 'invalid userId directory should not exist');
}

// --- Test 9: cache rebuild on init produces correct counts ---
function test_cache_rebuild() {
  console.log('\nTest 9: cache rebuild on init produces correct counts');

  // Create a fresh tmpDir to avoid interference
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-usage-rebuild-'));
  const month = usage.currentMonth();

  // Write some JSONL manually
  const userDir = path.join(freshDir, 'usage', 'rebuilduser');
  fs.mkdirSync(userDir, { recursive: true });
  const filePath = path.join(userDir, `usage-${month}.jsonl`);
  const events = [
    { ts: new Date().toISOString(), type: 'dispatch', taskId: 'R1' },
    { ts: new Date().toISOString(), type: 'dispatch', taskId: 'R2' },
    { ts: new Date().toISOString(), type: 'dispatch', taskId: 'R3' },
    { ts: new Date().toISOString(), type: 'agent.runtime', taskId: 'R1', durationSec: 100 },
    { ts: new Date().toISOString(), type: 'api.tokens', taskId: 'R1', input: 5000, output: 2000 },
  ];
  fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  // Init should rebuild cache from these files
  usage.init({
    dataDir: freshDir,
    broadcastSSE: () => {},
    readBoard: () => ({ controls: {} }),
  });

  const result = usage.query('rebuilduser', month);
  assertEqual(result.dispatches, 3, 'rebuilt dispatches should be 3');
  assertEqual(result.runtimeSec, 100, 'rebuilt runtimeSec should be 100');
  assertEqual(result.tokens.input, 5000, 'rebuilt tokens.input should be 5000');
  assertEqual(result.tokens.output, 2000, 'rebuilt tokens.output should be 2000');
  assertEqual(result.events, 5, 'rebuilt events should be 5');

  try {
    fs.rmSync(freshDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-usage] cleanup skipped:', err.message);
  }
}

// --- Test 10: SSE connect event tracking ---
function test_sse_connect() {
  console.log('\nTest 10: SSE connect event tracking');
  usage.init({
    dataDir: tmpDir,
    broadcastSSE: () => {},
    readBoard: () => ({ controls: {} }),
  });

  usage.record('sseuser', 'sse.connect', { sessionMinutes: 15.5 });
  usage.record('sseuser', 'sse.connect', { sessionMinutes: 8.2 });

  const result = usage.query('sseuser');
  assert(Math.abs(result.sseMinutes - 23.7) < 0.01, `sseMinutes should be ~23.7, got ${result.sseMinutes}`);
}

// --- Test 11: query with limits info ---
function test_query_with_limits() {
  console.log('\nTest 11: query includes limits info when configured');
  usage.init({
    dataDir: tmpDir,
    broadcastSSE: () => {},
    readBoard: () => ({
      controls: {
        usage_limits: {
          dispatches_per_month: 1000,
          runtime_sec_per_month: 36000,
          tokens_per_month: 10000000,
        },
      },
    }),
  });

  const result = usage.query('testuser');
  assert(result.limits != null, 'limits should be present');
  assert(result.limits.dispatches != null, 'limits.dispatches should be present');
  assert(result.limits.runtimeSec != null, 'limits.runtimeSec should be present');
  assert(result.limits.tokens != null, 'limits.tokens should be present');
  assertEqual(result.limits.dispatches.limit, 1000, 'dispatches limit should be 1000');
}

// --- Test 12: currentMonth format ---
function test_current_month_format() {
  console.log('\nTest 12: currentMonth returns YYYY-MM format');
  const month = usage.currentMonth();
  assert(/^\d{4}-\d{2}$/.test(month), `currentMonth should match YYYY-MM, got ${month}`);
}

// --- Run all tests ---
function main() {
  console.log('=== Usage Tracking Tests ===');
  setup();

  try {
    test_init_creates_directory();
    test_record_creates_file();
    test_record_appends();
    test_query_aggregation();
    test_query_nonexistent_user();
    test_summary();
    test_check_limits_alert();
    test_invalid_user_id();
    test_cache_rebuild();
    test_sse_connect();
    test_query_with_limits();
    test_current_month_format();
  } finally {
    teardown();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
