/**
 * hook-system.js — 輕量級 Hook 系統
 *
 * Hook 是放在 hooks/ 目錄下的 JS 檔案，匯出事件處理函數。
 * 事件：task_created, task_completed, step_started, step_completed, dispatch_started
 *
 * Hook 註冊：server 啟動時掃描 hooks/ 目錄
 * Hook 執行：fire-and-forget（非阻塞，錯誤只 log）
 *
 * 零外部依賴，只用 Node.js 內建模組。
 */
const fs = require('fs');
const path = require('path');

const SUPPORTED_EVENTS = [
  'task_created',
  'task_completed',
  'step_started',
  'step_completed',
  'dispatch_started',
];

let registeredHooks = [];

function getHooksDir(serverDir) {
  return path.join(serverDir, 'hooks');
}

function scanHooks(hooksDir) {
  const hooks = [];

  if (!fs.existsSync(hooksDir)) {
    return hooks;
  }

  const entries = fs.readdirSync(hooksDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

    const hookPath = path.join(hooksDir, entry.name);
    const hookName = entry.name.replace(/\.js$/, '');

    try {
      const hookModule = require(hookPath);

      if (typeof hookModule === 'function') {
        hooks.push({
          name: hookName,
          file: entry.name,
          events: SUPPORTED_EVENTS,
          handler: hookModule,
        });
      } else if (typeof hookModule === 'object' && hookModule !== null) {
        for (const eventName of SUPPORTED_EVENTS) {
          const handler = hookModule[eventName];
          if (typeof handler === 'function') {
            hooks.push({
              name: `${hookName}:${eventName}`,
              file: entry.name,
              events: [eventName],
              handler,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[hook-system] 載入 hook 失敗 ${entry.name}: ${err.message}`);
    }
  }

  return hooks;
}

function init(hooksDir) {
  registeredHooks = scanHooks(hooksDir);

  if (registeredHooks.length > 0) {
    const eventCounts = {};
    for (const h of registeredHooks) {
      for (const ev of h.events) {
        eventCounts[ev] = (eventCounts[ev] || 0) + 1;
      }
    }
    const summary = SUPPORTED_EVENTS.map(ev => `${ev}:${eventCounts[ev] || 0}`).join(', ');
    console.log(`[hook-system] 註冊 ${registeredHooks.length} 個 hook（${summary}）`);
  }

  return registeredHooks;
}

function emit(eventName, data) {
  if (!SUPPORTED_EVENTS.includes(eventName)) {
    console.warn(`[hook-system] 未知事件: ${eventName}`);
    return;
  }

  for (const hook of registeredHooks) {
    if (!hook.events.includes(eventName)) continue;

    setImmediate(() => {
      try {
        const result = hook.handler(eventName, data);
        if (result && typeof result.catch === 'function') {
          result.catch(err => {
            console.error(`[hook-system] hook ${hook.name} 錯誤 (${eventName}): ${err.message}`);
          });
        }
      } catch (err) {
        console.error(`[hook-system] hook ${hook.name} 錯誤 (${eventName}): ${err.message}`);
      }
    });
  }
}

function listHooks() {
  return registeredHooks.map(h => ({
    name: h.name,
    file: h.file,
    events: h.events,
  }));
}

function getSupportedEvents() {
  return [...SUPPORTED_EVENTS];
}

module.exports = {
  init,
  emit,
  listHooks,
  getSupportedEvents,
  getHooksDir,
  SUPPORTED_EVENTS,
};
