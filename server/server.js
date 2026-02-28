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

let digestTask = null;
try { digestTask = require('./digest-task'); } catch { /* digest-task not available, skip */ }

let timelineTask = null;
try { timelineTask = require('./timeline-task'); } catch { /* timeline-task not available, skip */ }

let confidenceEngine = null;
try { confidenceEngine = require('./confidence-engine'); } catch { /* confidence-engine not available, skip */ }

const telemetry = require('./telemetry');
const push = require('./push');
const githubApi = require('./github-api');
const usage = require('./usage');

const vault = require('./vault').createVault({ vaultDir: path.join(__dirname, 'vaults') });

// Claude API runtime — factory pattern, injects vault for per-user API key retrieval
let runtimeClaudeApi = null;
try { runtimeClaudeApi = require('./runtime-claude-api').create({ vault }); } catch { /* claude-api not configured, skip */ }

const RUNTIMES = {
  openclaw: runtime,
  ...(runtimeCodex ? { codex: runtimeCodex } : {}),
  ...(runtimeClaude ? { claude: runtimeClaude } : {}),
  ...(runtimeClaudeApi ? { 'claude-api': runtimeClaudeApi } : {}),
};

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

  // Kernel (set after deps object is created)
  kernel: null,

  // Cross-module functions (set by tasks.js init)
  tryAutoDispatch: null,
  redispatchTask: null,
};

// --- Initialize kernel ---
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
if (dirty) writeBoard(initBoard);

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

// --- Graceful Shutdown ---
function gracefulShutdown() {
  console.log('[server] shutting down...');
  telemetryHandle?.stop();
  usageHandle?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

bb.listen(server, ctx);
