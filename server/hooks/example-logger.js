/**
 * 範例 Hook：記錄所有事件到 console
 *
 * Hook 檔案放在 server/hooks/ 目錄下，必須是 .js 檔案。
 *
 * 匯出方式：
 * 1. 匯出函數：處理所有事件
 *    module.exports = (eventName, data) => { ... }
 *
 * 2. 匯出物件：只處理特定事件
 *    module.exports = {
 *      task_created: (eventName, data) => { ... },
 *      step_completed: (eventName, data) => { ... },
 *    }
 *
 * 支援的事件：
 *   - task_created: 新任務建立
 *   - task_completed: 任務完成（approved）
 *   - step_started: 步驟開始執行
 *   - step_completed: 步驟完成（成功或失敗）
 *   - dispatch_started: 任務派發開始
 *
 * Hook 是 fire-and-forget：
 *   - 非阻塞，不會影響主流程
 *   - 錯誤只會 log，不會中斷
 *   - 可以是 async function
 */

function logHook(eventName, data) {
  const ts = new Date().toISOString();
  const taskId = data?.taskId || data?.task?.id || '-';
  const stepId = data?.stepId || '-';
  console.log(`[${ts}] [hook] ${eventName} task=${taskId} step=${stepId}`);
}

module.exports = {
  task_created: logHook,
  task_completed: logHook,
  step_started: logHook,
  step_completed: logHook,
  dispatch_started: logHook,
};
