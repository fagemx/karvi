/**
 * routes/status.js — Status Aggregation API
 *
 * GET /api/status — returns core only (default)
 * GET /api/status?fields=core,steps,errors,metrics,events,agent_metrics — specific groups
 * GET /api/status?fields=all — all groups
 *
 * Field Groups:
 *   - core: summary + task list
 *   - steps: all step details
 *   - errors: failed signals + failed steps
 *   - metrics: aggregated budget usage
 *   - events: recent signals
 *   - agent_metrics: per-step quality metrics (model, runtime, result, tokens, cost)
 */
const os = require('os');
const bb = require('../blackboard-server');
const artifactStore = require('../artifact-store');
const { json } = bb;

function formatAge(ms) {
  if (ms == null) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function buildCore(board) {
  const tasks = board.taskPlan?.tasks || [];
  const summary = {
    active: tasks.filter(t => t.status === 'in_progress').length,
    succeeded: tasks.filter(t => ['completed', 'approved'].includes(t.status)).length,
    failed: tasks.filter(t => ['blocked', 'needs_revision'].includes(t.status)).length,
  };
  
  const taskList = tasks.map(task => {
    const runningStep = (task.steps || []).find(s => s.state === 'running');
    const completedSteps = (task.steps || []).filter(s => s.state === 'succeeded').length;
    const totalSteps = (task.steps || []).length;
    const startedAt = task.startedAt || task.history?.[0]?.ts;
    const ageMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
    
    return {
      id: task.id,
      title: task.title || '',
      status: task.status,
      step: runningStep?.type || null,
      progress: totalSteps > 0 ? `${completedSteps}/${totalSteps}` : null,
      age: formatAge(ageMs),
    };
  });
  
  return { summary, tasks: taskList };
}

function buildSteps(board) {
  const steps = [];
  for (const task of (board.taskPlan?.tasks || [])) {
    for (const step of (task.steps || [])) {
      steps.push({
        task_id: task.id,
        step_id: step.step_id,
        type: step.type,
        state: step.state,
        attempt: step.attempt || 0,
        duration_ms: step.duration_ms || null,
      });
    }
  }
  return steps;
}

function buildErrors(board, helpers) {
  const errors = [];
  
  // From signals
  for (const sig of (board.signals || []).filter(s => s.type === 'error')) {
    errors.push({
      ts: sig.ts,
      type: 'signal',
      task_id: sig.data?.taskId || null,
      step_id: null,
      message: sig.content,
    });
  }
  
  // From failed/dead steps
  for (const task of (board.taskPlan?.tasks || [])) {
    for (const step of (task.steps || []).filter(s => s.state === 'failed' || s.state === 'dead')) {
      errors.push({
        ts: helpers.nowIso(), // Step doesn't have timestamp, use current time
        type: 'step',
        task_id: task.id,
        step_id: step.step_id,
        message: `Step ${step.step_id} ${step.state}`,
      });
    }
  }
  
  return errors.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 50);
}

function buildMetrics(board) {
  const metrics = {
    total_tokens: 0,
    total_wall_clock_ms: 0,
    total_llm_calls: 0,
    total_steps: 0,
  };
  
  for (const task of (board.taskPlan?.tasks || [])) {
    const used = task.budget?.used || {};
    metrics.total_tokens += used.tokens || 0;
    metrics.total_wall_clock_ms += used.wall_clock_ms || 0;
    metrics.total_llm_calls += used.llm_calls || 0;
    metrics.total_steps += used.steps || 0;
  }
  
  return metrics;
}

function buildEvents(board) {
  return (board.signals || [])
    .slice(-50)
    .reverse()
    .map(sig => ({
      ts: sig.ts,
      type: sig.type,
      content: sig.content,
      refs: sig.refs || [],
    }));
}

function buildAgentMetrics(board) {
  const metrics = [];
  
  for (const task of (board.taskPlan?.tasks || [])) {
    for (const step of (task.steps || [])) {
      if (step.state !== 'succeeded' && step.state !== 'failed' && step.state !== 'dead') continue;
      if (!step.run_id) continue;
      
      let output = null;
      try {
        output = artifactStore.readArtifact(step.run_id, step.step_id, 'output');
      } catch {
        // Skip if artifact cannot be read
      }
      
      metrics.push({
        task_id: task.id,
        step_id: step.step_id,
        step_type: step.type,
        run_id: step.run_id,
        model: output?.model_used || null,
        runtime: output?.runtime || null,
        result: output?.status || (step.state === 'succeeded' ? 'succeeded' : 'failed'),
        tokens: output?.tokens_used || 0,
        cost: output?.cost || null,
        duration_ms: output?.duration_ms || null,
        attempt: step.attempt || 0,
        ts: step.state === 'succeeded' ? (step.completed_at || null) : null,
      });
    }
  }
  
  return metrics;
}

module.exports = function statusRoutes(req, res, helpers, deps) {
  if (req.method !== 'GET') return false;
  
  const urlMatch = req.url.match(/^\/api\/status(\?|$)/);
  if (!urlMatch) return false;
  
  try {
    const url = new URL(req.url, 'http://localhost');
    const fieldsParam = url.searchParams.get('fields') || 'core';
    
    const requestedFields = new Set(
      fieldsParam === 'all'
        ? ['core', 'steps', 'errors', 'metrics', 'events', 'agent_metrics']
        : fieldsParam.split(',').map(f => f.trim()).filter(Boolean)
    );
    
    const board = helpers.readBoard();
    const instance_id = process.env.KARVI_INSTANCE_ID || os.hostname();
    
    const response = {
      instance_id,
      ts: helpers.nowIso(),
    };
    
    if (requestedFields.has('core')) response.core = buildCore(board);
    if (requestedFields.has('steps')) response.steps = buildSteps(board);
    if (requestedFields.has('errors')) response.errors = buildErrors(board, helpers);
    if (requestedFields.has('metrics')) response.metrics = buildMetrics(board);
    if (requestedFields.has('events')) response.events = buildEvents(board);
    if (requestedFields.has('agent_metrics')) response.agent_metrics = buildAgentMetrics(board);
    
    return json(res, 200, response);
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
};
