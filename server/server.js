#!/usr/bin/env node
require('./load-env');
/**
 * server.js — Karvi Task Engine HTTP Server
 *
 * Bootstrap, dependency assembly, route chain, init, and graceful shutdown.
 * Route handlers live in server/routes/*.js
 */
const fs = require('fs');
const path = require('path');
const bb = require('./blackboard-server');
const mgmt = require('./management');
const runtime = require('./runtime-openclaw');
const { loadModules } = require('./module-loader');

const telemetry = require('./telemetry');
const push = require('./push');
const { createScheduler } = require('./village/village-scheduler');
const githubApi = require('./github-api');
const usage = require('./usage');
const { createServiceManager } = require('./service-manager');

const vault = require('./vault').createVault({ vaultDir: path.join(__dirname, 'vaults') });

const opt = loadModules([
  { name: 'runtimeCodex',     path: './runtime-codex',       optional: true },
  { name: 'runtimeClaude',    path: './runtime-claude',      optional: true },
  { name: 'jiraIntegration',  path: './integration-jira',    optional: true },
  { name: 'githubIntegration', path: './integration-github', optional: true },
  { name: 'digestTask',       path: './digest-task',         optional: true },
  { name: 'timelineTask',     path: './timeline-task',       optional: true },
  { name: 'confidenceEngine', path: './confidence-engine',   optional: true },
  { name: 'runtimeClaudeApi', path: './runtime-claude-api',  optional: true, factory: mod => mod.create({ vault }) },
  { name: 'runtimeOpencode',  path: './runtime-opencode',    optional: true },
]);

const { runtimeCodex, runtimeClaude, jiraIntegration, githubIntegration,
        digestTask, timelineTask, confidenceEngine, runtimeClaudeApi,
        runtimeOpencode } = opt;

const { validateAllRuntimes } = require('./runtime-contract');
const { migrateBoard } = require('./board-migration');

const RUNTIMES = {
  openclaw: runtime,
  ...(runtimeCodex ? { codex: runtimeCodex } : {}),
  ...(runtimeClaude ? { claude: runtimeClaude } : {}),
  ...(runtimeClaudeApi ? { 'claude-api': runtimeClaudeApi } : {}),
  ...(runtimeOpencode ? { opencode: runtimeOpencode } : {}),
};

// Validate all registered runtimes at startup
validateAllRuntimes(RUNTIMES);

function getRuntime(hint) {
  return RUNTIMES[hint] || runtime;
}

const DIR = __dirname;
const ROOT = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : path.resolve(DIR, '..');
const DATA_DIR = process.env.DATA_DIR || DIR;
const PUSH_TOKENS_PATH = path.join(DATA_DIR, 'push-tokens.json');

const HOST = process.env.HOST || process.env.BIND_ADDRESS || undefined;

const ctx = bb.createContext({
  dir: process.env.KARVI_PKG_DIR || ROOT,
  boardPath: path.join(DATA_DIR, 'board.json'),
  logPath: path.join(DATA_DIR, 'task-log.jsonl'),
  port: Number(process.env.PORT || 3461),
  host: HOST,
  boardType: 'task-engine',
});

// --- Dependency injection object ---
const deps = {
  // External modules
  vault,
  githubApi,
  runtime,
  RUNTIMES,
  getRuntime,
  mgmt,
  push,
  usage,
  jiraIntegration,
  githubIntegration,
  digestTask,
  timelineTask,
  confidenceEngine,

  // Config / paths
  ctx,
  PUSH_TOKENS_PATH,
  DIR,
  DATA_DIR,

  // Step-level modules
  stepSchema: require('./step-schema'),
  artifactStore: require('./artifact-store'),
  routeEngine: require('./route-engine'),
  contextCompiler: require('./context-compiler'),

  // StepWorker + Kernel (set after deps object is created)
  stepWorker: null,
  kernel: null,

  // Cross-module functions (set by tasks.js init)
  tryAutoDispatch: null,
  redispatchTask: null,
};

/**
 * Circular dependency: kernel ↔ stepWorker
 *
 * kernel.onStepEvent()  calls  deps.stepWorker.executeStep()   (next_step dispatch)
 * stepWorker.executeStep() calls  deps.kernel.onStepEvent()     (terminal-state callback via setImmediate)
 *
 * Both receive the shared `deps` object by reference. Init order matters:
 * stepWorker is created first so that kernel can call deps.stepWorker immediately.
 * kernel is created second; stepWorker's callback to deps.kernel is deferred via
 * setImmediate, so deps.kernel is guaranteed to be set by the time it fires.
 *
 * Do NOT reorder these two lines.
 */
deps.stepWorker = require('./step-worker').createStepWorker(deps);
deps.kernel = require('./kernel').createKernel(deps);

// --- Route modules ---
const pushRoutes = require('./routes/push');
const vaultRoutes = require('./routes/vault');
const usageRoutes = require('./routes/usage');
const controlsRoutes = require('./routes/controls');
const githubRoutes = require('./routes/github');
const evolutionRoutes = require('./routes/evolution');
const briefsRoutes = require('./routes/briefs');
const chatRoutes = require('./routes/chat');
const jiraRoutes = require('./routes/jira');
const villageRoutes = require('./routes/village');
const projectsRoutes = require('./routes/projects');
const tasksRoutes = require('./routes/tasks');
const statusRoutes = require('./routes/status');
const discoveryRoutes = require('./routes/discovery');
const versionRoutes = require('./routes/version');
const artifactsRoutes = require('./routes/artifacts');
const logsRoutes = require('./routes/logs');
const eddaRoutes = require('./routes/edda');
const executionsRoutes = require('./routes/executions');

const postmortem = require('./postmortem');

function postmortemRoute(req, res, helpers, deps) {
  return postmortem.handlePostmortem(req, res, helpers, deps);
}

// --- Route chain ---
const routes = [
  pushRoutes,
  vaultRoutes,
  usageRoutes,
  controlsRoutes,
  githubRoutes,
  evolutionRoutes,
  briefsRoutes,
  chatRoutes,
  jiraRoutes,
  villageRoutes,
  projectsRoutes,
  tasksRoutes,
  postmortemRoute,
  statusRoutes,
  versionRoutes,
  discoveryRoutes,
  artifactsRoutes,
  logsRoutes,
  eddaRoutes,
  executionsRoutes,
];

const { json } = bb;

const server = bb.createServer(ctx, (req, res, helpers) => {
  inFlightRequests++;
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    inFlightRequests--;
    return originalEnd(...args);
  };

  for (const route of routes) {
    const result = route(req, res, helpers, deps);
    if (result !== false) return;
  }

  // GET /api/services/status — background service health
  if (req.method === 'GET' && req.url === '/api/services/status') {
    return json(res, 200, serviceManager.status());
  }

  // POST /api/shutdown — graceful shutdown (critical for Windows where SIGTERM kills immediately)
  if (req.method === 'POST' && req.url === '/api/shutdown') {
    // Admin-only: shutdown requires highest privilege
    if (req.karviRole !== null && req.karviRole !== undefined && req.karviRole !== 'admin') {
      console.log(`[rbac] 403 ${req.karviRole} tried POST /api/shutdown`);
      return json(res, 403, { error: 'forbidden', requiredRole: 'admin', currentRole: req.karviRole });
    }
    json(res, 200, { ok: true, message: 'shutting down' });
    setImmediate(gracefulShutdown);
    return;
  }

  return false; // fall through to bb static file serving
});

// --- Initialize cross-module deps (tasks.js exports tryAutoDispatch/redispatchTask) ---
// Build a helpers-like object matching what route modules expect
const routeHelpers = {
  json,
  parseBody: (req, maxBytes) => bb.parseBody(req, maxBytes || ctx.maxBodyBytes),
  readBoard: () => bb.readBoard(ctx),
  writeBoard: (b) => bb.writeBoard(ctx, b),
  appendLog: (e) => bb.appendLog(ctx, e),
  broadcastSSE: (ev, d) => bb.broadcastSSE(ctx, ev, d),
  nowIso: bb.nowIso,
  uid: bb.uid,
};
tasksRoutes.init(deps, routeHelpers);

// --- Ensure board.json exists (support fresh clone) ---
bb.ensureBoardExists(ctx, {
  taskPlan: { goal: '', phase: 'idle', tasks: [] },
  pipelineTemplates: {},
  projects: [],
  conversations: [],
  participants: [],
  signals: [],
  insights: [],
  lessons: [],
  controls: {
    auto_review: true,
    auto_redispatch: false,
    max_review_attempts: 3,
    quality_threshold: 70,
    review_timeout_sec: 180,
    review_agent: 'engineer_lite',
    auto_apply_insights: true,
    cycle_stall_timeout_hours: 4,
    step_timeout_sec: {
      plan: 300,
      implement: 600,
      review: 300,
      test: 300,
      default: 300
    },
  },
});

// --- Evolution Layer: Ensure board has evolution fields on startup ---
const readBoard = () => bb.readBoard(ctx);
const writeBoard = (b) => bb.writeBoard(ctx, b);
const appendLog = (e) => bb.appendLog(ctx, e);
const broadcastSSE = (ev, d) => bb.broadcastSSE(ctx, ev, d);

const initBoard = readBoard();
const { recoverExpiredLocks } = require('./step-worker');
const migrationResult = migrateBoard(initBoard, { villageRoutes, recoverExpiredLocks });
if (migrationResult.applied.length > 0) {
  console.log(`[migration] applied: ${migrationResult.applied.join(', ')}`);
}
if (migrationResult.dirty) {
  writeBoard(initBoard);
}

// --- Service Manager: 統一管理所有 background services ---
const serviceManager = createServiceManager();
deps.serviceManager = serviceManager;

// 1. Retry poller: re-dispatch steps stuck in queued with past scheduled_at
const RETRY_POLL_MS = 10_000;
let retryPollerTimer = null;
function retryPollerTick() {
  try {
    const board = readBoard();
    const now = new Date().toISOString();
    for (const task of board.taskPlan?.tasks || []) {
      if (!task.steps || task.status === 'completed' || task.status === 'approved') continue;
      for (const step of task.steps) {
        // Safety net: recover steps stuck in 'running' with expired locks
        if (step.state === 'running' && step.lock_expires_at && step.lock_expires_at <= now) {
          // Activity-aware: if step was active recently, renew lock instead of killing
          // But cap total runtime at 3x timeout to prevent infinite renewal
          const lastActivity = step.progress?.last_activity;
          const dispatchedAt = step.progress?.dispatched_at;
          const timeout = step.retry_policy?.timeout_ms || 300_000;
          const maxTotalMs = timeout * 3;
          const totalElapsed = dispatchedAt ? Date.now() - new Date(dispatchedAt).getTime() : 0;
          if (lastActivity && totalElapsed < maxTotalMs) {
            const silentMs = Date.now() - new Date(lastActivity).getTime();
            const graceMs = 120_000; // 2 min grace after last activity
            if (silentMs < graceMs) {
              console.log(`[retry-poller] ${step.step_id} lock expired but active ${Math.round(silentMs/1000)}s ago, renewing (total: ${Math.round(totalElapsed/1000)}s/${Math.round(maxTotalMs/1000)}s)`);
              step.lock_expires_at = new Date(Date.now() + timeout + 30_000).toISOString();
              writeBoard(board);
              continue;
            }
          }
          const actualError = step.progress?.dispatched_at
            ? `Lock expired — no activity for ${lastActivity ? Math.round((Date.now() - new Date(lastActivity).getTime())/1000) + 's' : 'unknown duration'}`
            : 'Lock expired — runtime never started (spawn may have failed)';
          console.log(`[retry-poller] ${step.step_id}: ${actualError} (locked_by=${step.locked_by})`);
          deps.stepSchema.transitionStep(step, 'failed', {
            error: actualError,
          });
          writeBoard(board);
          // If step went dead (max_attempts exhausted), trigger kernel for dead-letter routing
          if (step.state === 'dead') {
            const signal = { type: 'step_dead', data: { taskId: task.id, stepId: step.step_id } };
            setImmediate(() => {
              deps.kernel.onStepEvent(signal, readBoard(), routeHelpers)
                .catch(err => console.error(`[retry-poller] kernel callback error:`, err.message));
            });
          }
          return; // one step per poll cycle to avoid races
        }
        if (step.state === 'queued' && step.attempt > 0 && step.scheduled_at && step.scheduled_at <= now) {
          console.log(`[retry-poller] re-dispatching ${step.step_id} (attempt ${step.attempt})`);
          const runState = { task, steps: task.steps, run_id: step.run_id, budget: task.budget, controls: mgmt.getControls(board) };
          const decision = { action: 'next_step', next_step: { step_id: step.step_id, step_type: step.type } };
          const envelope = deps.contextCompiler.buildEnvelope(decision, runState, deps);
          if (!envelope) continue;
          deps.artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'input', envelope);
          deps.stepSchema.transitionStep(step, 'running', {
            locked_by: 'retry-poller',
            input_ref: deps.artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'input'),
          });
          writeBoard(board);
          deps.stepWorker.executeStep(envelope, readBoard(), routeHelpers).catch(err =>
            console.error(`[retry-poller] error for ${step.step_id}:`, err.message));
          return; // one step per poll cycle to avoid races
        }
      }
    }
  } catch (err) {
    console.error('[retry-poller] error:', err.message);
  }
}
serviceManager.register('retry-poller', {
  start() { retryPollerTimer = setInterval(retryPollerTick, RETRY_POLL_MS); },
  stop() { clearInterval(retryPollerTimer); retryPollerTimer = null; },
  healthCheck() { return retryPollerTimer !== null; },
});

// 2. TTL cleanup: auto-remove stale terminal tasks
const CLEANUP_POLL_MS = 60_000;
const TTL_CANCELLED_MS = 1 * 3600_000;       // 1 hour
const TTL_BLOCKED_DEAD_MS = 6 * 3600_000;    // 6 hours
const TTL_APPROVED_MS = 24 * 3600_000;        // 24 hours
let cleanupPollerTimer = null;
function cleanupPollerTick() {
  try {
    const board = readBoard();
    const tasks = board.taskPlan?.tasks || [];
    const now = Date.now();
    let removed = 0;

    for (let i = tasks.length - 1; i >= 0; i--) {
      const t = tasks[i];
      const ts = t.completedAt || t.startedAt || t.createdAt;
      if (!ts) continue;
      const age = now - new Date(ts).getTime();

      let shouldRemove = false;
      if (t.status === 'cancelled' && age > TTL_CANCELLED_MS) {
        shouldRemove = true;
      } else if (t.status === 'blocked' && age > TTL_BLOCKED_DEAD_MS) {
        const hasRunning = (t.steps || []).some(s => s.state === 'running');
        if (!hasRunning) shouldRemove = true;
      } else if (t.status === 'approved' && age > TTL_APPROVED_MS) {
        shouldRemove = true;
      }

      if (shouldRemove) {
        if (t.status === 'approved') {
          const stepSummary = (t.steps || []).map(s => ({ id: s.step_id, state: s.state }));
          appendLog({
            ts: new Date().toISOString(), event: 'task_archived', taskId: t.id,
            title: t.title, status: t.status, branch: t.worktreeBranch || null,
            steps: stepSummary, createdAt: t.createdAt, completedAt: t.completedAt,
          });
        }
        // Worktree cleanup — log path before removal so user can salvage code
        if (t.worktreeDir) {
          console.log(`[cleanup] removing worktree for ${t.id}: ${t.worktreeDir} (status: ${t.status})`);
          const repoRoot = path.resolve(__dirname);
          const worktreeHelper = require('./worktree');
          const cleanId = t.id;
          setTimeout(() => {
            try { worktreeHelper.removeWorktree(repoRoot, cleanId); }
            catch (e) { console.error(`[cleanup] worktree cleanup failed for ${cleanId}: ${e.message}`); }
          }, 3000);
        }
        appendLog({ ts: new Date().toISOString(), event: 'task_removed', taskId: t.id, finalStatus: t.status, worktreeDir: t.worktreeDir || null });
        tasks.splice(i, 1);
        removed++;
      }
    }

    if (removed > 0) {
      writeBoard(board);
      broadcastSSE('board', board);
      console.log(`[cleanup] removed ${removed} stale task(s)`);
    }
  } catch (err) {
    console.error('[cleanup] error:', err.message);
  }
}
serviceManager.register('cleanup-poller', {
  start() { cleanupPollerTimer = setInterval(cleanupPollerTick, CLEANUP_POLL_MS); },
  stop() { clearInterval(cleanupPollerTimer); cleanupPollerTimer = null; },
  healthCheck() { return cleanupPollerTimer !== null; },
});

// 3. Telemetry
let telemetryHandle = null;
serviceManager.register('telemetry', {
  start() {
    telemetryHandle = telemetry.init({ dataDir: DATA_DIR, readBoard });
  },
  stop() { telemetryHandle?.stop(); },
  healthCheck() { return telemetryHandle && !telemetryHandle.disabled; },
});

// 4. Usage tracking
let usageHandle = null;
serviceManager.register('usage-tracking', {
  start() {
    usageHandle = usage.init({ dataDir: DATA_DIR, broadcastSSE, readBoard });
    ctx.onSSEDisconnect = ({ minutes }) => {
      usage.record('default', 'sse.connect', { sessionMinutes: minutes });
    };
  },
  stop() { usageHandle?.stop(); },
  healthCheck() { return usageHandle !== null; },
});

// 5. Village Scheduler (Cadence Engine)
let villageScheduler = null;
serviceManager.register('village-scheduler', {
  start() {
    villageScheduler = createScheduler({
      helpers: routeHelpers,
      tryAutoDispatch: (taskId) => deps.tryAutoDispatch && deps.tryAutoDispatch(taskId),
    });
    villageScheduler.start();
  },
  stop() { villageScheduler?.stop(); },
  healthCheck() { return villageScheduler !== null; },
});

// --- Start all background services ---
serviceManager.startAll();

// --- Graceful Shutdown with Request Draining ---
let inFlightRequests = 0;
const DRAIN_TIMEOUT_MS = 30000;

function gracefulShutdown() {
  console.log('[server] shutting down...');
  serviceManager.stopAll();

  if (inFlightRequests === 0) {
    server.close(() => process.exit(0));
  } else {
    console.log(`[server] draining ${inFlightRequests} in-flight request(s)...`);
    const drainDeadline = setTimeout(() => {
      console.log('[server] drain timeout, forcing exit');
      process.exit(1);
    }, DRAIN_TIMEOUT_MS);

    const checkDrain = setInterval(() => {
      if (inFlightRequests === 0) {
        clearInterval(checkDrain);
        clearTimeout(drainDeadline);
        server.close(() => process.exit(0));
      }
    }, 100);
  }
  setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS + 1000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Warn if auto_dispatch is on but no target_repo is configured
{
  const board = bb.readBoard(ctx);
  const ctrl = mgmt.getControls(board);
  if (ctrl.auto_dispatch && !ctrl.target_repo) {
    console.warn('[WARN] auto_dispatch is ON but target_repo is not set. Tasks will dispatch against karvi codebase (dogfood mode).');
  }
}

// Security guard: block startup on non-localhost bind without API token
// Only fires when HOST is explicitly set — default (undefined) is safe for local dev
{
  const isLocal = !HOST || ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!isLocal && !ctx.apiToken) {
    if (process.argv.includes('--force')) {
      console.warn('[SECURITY] API token not set but --force used. Proceeding without auth on %s:%d', HOST, ctx.port);
    } else {
      console.error('[SECURITY] API token not set but server is binding to %s:%d', HOST, ctx.port);
      console.error('           Set KARVI_API_TOKEN or use --force to bypass this check');
      process.exit(1);
    }
  }
}

// --- Boot banner ---
{
  const runtimeNames = Object.keys(RUNTIMES);
  const allRt = ['openclaw', 'claude', 'claude-api', 'codex', 'opencode'];
  const rtLine = allRt.map(r => runtimeNames.includes(r) ? `${r} ✅` : `${r} ❌`).join('  ');
  const tokenStatus = ctx.roleTokens?.active
    ? `RBAC (${[...new Set(ctx.roleTokens.tokenMap.values())].join(', ')})`
    : process.env.KARVI_API_TOKEN ? 'token set' : 'no token (local only)';
  const addr = HOST || 'localhost';

  console.log('');
  console.log(`  Karvi v${require('../package.json').version} — http://${addr}:${ctx.port}`);
  console.log(`  Runtimes:  ${rtLine}`);
  console.log(`  Auth:      ${tokenStatus}`);
  console.log('');
  console.log(`  Quick start:  npm run go -- <issue-number>`);
  console.log('');
}

bb.listen(server, ctx);
