/**
 * routes/executions.js — Execution Registry API
 *
 * GET /api/executions — 列出執行中的 agent（stepId、task_id、runtime、elapsed）
 *
 * 從 step-worker 的 activeExecutions Map 讀取即時執行狀態，
 * 並從 board 補充 step type 和 progress 資訊。
 */
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function executionsRoutes(req, res, helpers, deps) {
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/api/executions') return false;

  const executions = deps.stepWorker.getActiveExecutions();
  const board = helpers.readBoard();
  const tasks = board.taskPlan?.tasks || [];

  // 補充 board 上的 step 資訊（type、progress）
  const enriched = executions.map(exec => {
    const task = tasks.find(t => t.id === exec.task_id);
    const step = task?.steps?.find(s => s.step_id === exec.stepId);
    return {
      step_id: exec.stepId,
      task_id: exec.task_id,
      runtime: exec.runtime,
      step_type: step?.type || null,
      started_at: new Date(exec.startedAt).toISOString(),
      elapsed_ms: exec.elapsed_ms,
      progress: step?.progress || null,
    };
  });

  return json(res, 200, { executions: enriched });
};
