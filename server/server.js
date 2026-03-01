#!/usr/bin/env node
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

let runtimeCodex = null;
try { runtimeCodex = require('./runtime-codex'); } catch { /* codex not installed, skip */ }

let runtimeClaude = null;
try { runtimeClaude = require('./runtime-claude'); } catch { /* claude not installed, skip */ }

let jiraIntegration = null;
try { jiraIntegration = require('./integration-jira'); } catch { /* jira integration not available, skip */ }

let githubIntegration = null;
try { githubIntegration = require('./integration-github'); } catch { /* github integration not available, skip */ }

let digestTask = null;
try { digestTask = require('./digest-task'); } catch { /* digest-task not available, skip */ }

let timelineTask = null;
try { timelineTask = require('./timeline-task'); } catch { /* timeline-task not available, skip */ }

let confidenceEngine = null;
try { confidenceEngine = require('./confidence-engine'); } catch { /* confidence-engine not available, skip */ }

const telemetry = require('./telemetry');
const push = require('./push');
const { createScheduler } = require('./village/village-scheduler');
const githubApi = require('./github-api');
const usage = require('./usage');

const vault = require('./vault').createVault({ vaultDir: path.join(__dirname, 'vaults') });

// Claude API runtime — factory pattern, injects vault for per-user API key retrieval
let runtimeClaudeApi = null;
try { runtimeClaudeApi = require('./runtime-claude-api').create({ vault }); } catch { /* claude-api not configured, skip */ }

const { validateAllRuntimes } = require('./runtime-contract');

const RUNTIMES = {
  openclaw: runtime,
  ...(runtimeCodex ? { codex: runtimeCodex } : {}),
  ...(runtimeClaude ? { claude: runtimeClaude } : {}),
  ...(runtimeClaudeApi ? { 'claude-api': runtimeClaudeApi } : {}),
};

// Validate all registered runtimes at startup
validateAllRuntimes(RUNTIMES);

function getRuntime(hint) {
  return RUNTIMES[hint] || runtime;
}

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..');
const DATA_DIR = process.env.DATA_DIR || DIR;
const PUSH_TOKENS_PATH = path.join(DATA_DIR, 'push-tokens.json');

const ctx = bb.createContext({
  dir: ROOT,
  boardPath: path.join(DATA_DIR, 'board.json'),
  logPath: path.join(DATA_DIR, 'task-log.jsonl'),
  port: Number(process.env.PORT || 3461),
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
const tasksRoutes = require('./routes/tasks');

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
  tasksRoutes,
];

const { json } = bb;

const server = bb.createServer(ctx, (req, res, helpers) => {
  for (const route of routes) {
    const result = route(req, res, helpers, deps);
    if (result !== false) return;
  }

  // POST /api/shutdown — graceful shutdown (critical for Windows where SIGTERM kills immediately)
  if (req.method === 'POST' && req.url === '/api/shutdown') {
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
  },
});

// --- Evolution Layer: Ensure board has evolution fields on startup ---
const readBoard = () => bb.readBoard(ctx);
const writeBoard = (b) => bb.writeBoard(ctx, b);
const broadcastSSE = (ev, d) => bb.broadcastSSE(ctx, ev, d);

const initBoard = readBoard();
let dirty = false;
if (!Array.isArray(initBoard.signals)) { initBoard.signals = []; dirty = true; }
if (!Array.isArray(initBoard.insights)) { initBoard.insights = []; dirty = true; }
if (!Array.isArray(initBoard.lessons)) { initBoard.lessons = []; dirty = true; }
// Village Chief: ensure village block exists on startup
if (!initBoard.village) { villageRoutes.ensureVillage(initBoard); dirty = true; }
if (dirty) writeBoard(initBoard);

// --- Recover expired step locks (crashed dispatch recovery) ---
const { recoverExpiredLocks } = require('./step-worker');
const recoveredLocks = recoverExpiredLocks(initBoard);
if (recoveredLocks > 0) {
  console.log(`[step-worker] recovered ${recoveredLocks} expired step lock(s)`);
  writeBoard(initBoard);
}

// --- Retry poller: re-dispatch steps stuck in queued with past scheduled_at ---
const RETRY_POLL_MS = 10_000;
const retryPoller = setInterval(() => {
  try {
    const board = readBoard();
    const now = new Date().toISOString();
    for (const task of board.taskPlan?.tasks || []) {
      if (!task.steps || task.status === 'completed' || task.status === 'approved') continue;
      for (const step of task.steps) {
        if (step.state === 'queued' && step.attempt > 0 && step.scheduled_at && step.scheduled_at <= now) {
          console.log(`[retry-poller] re-dispatching ${step.step_id} (attempt ${step.attempt})`);
          const runState = { task, steps: task.steps, run_id: step.run_id, budget: task.budget };
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
}, RETRY_POLL_MS);

// --- Telemetry init ---
let telemetryHandle;
try {
  telemetryHandle = telemetry.init({
    dataDir: DATA_DIR,
    readBoard,
  });
} catch (err) {
  console.warn(`[telemetry] init failed, continuing without telemetry: ${err.message}`);
}

// --- Usage tracking init ---
let usageHandle;
try {
  usageHandle = usage.init({
    dataDir: DATA_DIR,
    broadcastSSE,
    readBoard,
  });
  // SSE connection tracking callback
  ctx.onSSEDisconnect = ({ minutes }) => {
    usage.record('default', 'sse.connect', { sessionMinutes: minutes });
  };
} catch (err) {
  console.warn(`[usage] init failed, continuing without usage tracking: ${err.message}`);
}

// --- Village Scheduler (Cadence Engine) ---
let villageScheduler = null;
try {
  villageScheduler = createScheduler({
    helpers: routeHelpers,
    tryAutoDispatch: (taskId) => deps.tryAutoDispatch && deps.tryAutoDispatch(taskId),
  });
  villageScheduler.start();
} catch (err) {
  console.warn(`[village-scheduler] init failed, continuing without scheduler: ${err.message}`);
}

// --- Graceful Shutdown ---
function gracefulShutdown() {
  console.log('[server] shutting down...');
  clearInterval(retryPoller);
  villageScheduler?.stop();
  telemetryHandle?.stop();
  usageHandle?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

bb.listen(server, ctx);
