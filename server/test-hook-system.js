/**
 * test-hook-system.js — Hook 系統單元測試
 */
const assert = require('assert');
const path = require('path');
const hookSystem = require('./hook-system');

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function mockConsole() {
  const logs = [];
  console.log = (...args) => logs.push(['log', ...args]);
  console.warn = (...args) => logs.push(['warn', ...args]);
  console.error = (...args) => logs.push(['error', ...args]);
  return logs;
}

function restoreConsole() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function testGetSupportedEvents() {
  const events = hookSystem.getSupportedEvents();
  assert.deepStrictEqual(events, [
    'task_created',
    'task_completed',
    'step_started',
    'step_completed',
    'dispatch_started',
  ]);
  console.log('  ✓ getSupportedEvents() 返回正確的事件列表');
}

async function testListHooksEmpty() {
  const hooks = hookSystem.listHooks();
  assert.ok(Array.isArray(hooks));
  console.log(`  ✓ listHooks() 返回陣列 (${hooks.length} 個 hook)`);
}

async function testEmitUnknownEvent() {
  const logs = mockConsole();
  hookSystem.emit('unknown_event', {});
  restoreConsole();
  const warnLog = logs.find(l => l[0] === 'warn' && l[1].includes('未知事件'));
  assert.ok(warnLog, '應該 log 警告訊息');
  console.log('  ✓ emit() 對未知事件發出警告');
}

async function testInitWithNonexistentDir() {
  const logs = mockConsole();
  const hooks = hookSystem.init('/nonexistent/path');
  restoreConsole();
  assert.deepStrictEqual(hooks, []);
  console.log('  ✓ init() 對不存在的目錄返回空陣列');
}

async function testHookFiresAndForgets() {
  let hookCalled = false;
  let receivedEvent = null;
  let receivedData = null;

  const testHandler = (event, data) => {
    hookCalled = true;
    receivedEvent = event;
    receivedData = data;
  };

  const testHooksDir = path.join(__dirname, 'hooks');
  const fs = require('fs');
  const testHookPath = path.join(testHooksDir, 'test-hook.js');

  fs.writeFileSync(testHookPath, `
module.exports = {
  task_created: (event, data) => {
    global.__testHookCalled = true;
    global.__testHookEvent = event;
    global.__testHookData = data;
  }
};
`);

  const logs = mockConsole();
  hookSystem.init(testHooksDir);
  hookSystem.emit('task_created', { taskId: 'TEST-123' });
  restoreConsole();

  await new Promise(resolve => setTimeout(resolve, 50));

  fs.unlinkSync(testHookPath);

  assert.ok(global.__testHookCalled, 'Hook 應該被調用');
  assert.strictEqual(global.__testHookEvent, 'task_created');
  assert.deepStrictEqual(global.__testHookData, { taskId: 'TEST-123' });

  delete global.__testHookCalled;
  delete global.__testHookEvent;
  delete global.__testHookData;

  console.log('  ✓ emit() 觸發 hook 並正確傳遞參數');
}

async function runTests() {
  console.log('\n=== Hook System 測試 ===\n');

  await testGetSupportedEvents();
  await testListHooksEmpty();
  await testEmitUnknownEvent();
  await testInitWithNonexistentDir();
  await testHookFiresAndForgets();

  console.log('\n=== 所有測試通過 ===\n');
}

runTests().catch(err => {
  restoreConsole();
  console.error('測試失敗:', err);
  process.exit(1);
});
