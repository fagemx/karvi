#!/usr/bin/env node
/**
 * instance-manager.js — Multi-tenant instance lifecycle manager
 *
 * Manages per-user Karvi server processes for the paid SaaS version.
 * Each user gets an isolated process with its own port, data directory,
 * and board.json.
 *
 * Designed as an embedded module (Approach B) — imported by Gateway,
 * no separate HTTP server.
 *
 * Usage:
 *   const mgr = require('./instance-manager');
 *   mgr.init({ dataRoot: '/data' });
 *   const inst = await mgr.createInstance({ userId: 'user-1' });
 *   // inst = { instanceId, userId, port, pid, status, ... }
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// --- Configuration ---
const PORT_MIN = Number(process.env.KARVI_PORT_MIN || 4000);
const PORT_MAX = Number(process.env.KARVI_PORT_MAX || 4999);
const SERVER_SCRIPT = path.join(__dirname, 'server.js');
const DEFAULT_MEMORY_LIMIT_MB = 128;
const HEALTH_CHECK_INTERVAL_MS = 30000;
const MAX_RESTARTS_PER_HOUR = 3;
const SHUTDOWN_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 10000;

// --- State ---
let registry = { meta: {}, instances: {} };
let dataRoot = null;
let healthCheckTimer = null;
const childProcesses = new Map(); // instanceId → ChildProcess

// --- Helpers ---

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from ' + url)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpPost(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function waitForExit(instanceId, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = childProcesses.get(instanceId);
    if (!child) return resolve();
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function waitForReady(child, timeoutMs = STARTUP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout')), timeoutMs);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('running at')) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      reject(new Error(`Process exited during startup (code=${code})`));
    });
  });
}

// --- Registry I/O ---

function registryPath() {
  return path.join(dataRoot, 'instance-registry.json');
}

function loadRegistry() {
  const regPath = registryPath();
  try {
    registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  } catch {
    registry = { meta: {}, instances: {} };
  }
  // Verify PIDs — clean stale entries
  for (const inst of Object.values(registry.instances)) {
    if (inst.pid && !isProcessAlive(inst.pid)) {
      inst.status = 'stopped';
      inst.pid = null;
    }
  }
  saveRegistry();
}

function saveRegistry() {
  registry.meta.updatedAt = new Date().toISOString();
  const regPath = registryPath();
  const tmpPath = regPath + '.tmp';
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
  fs.renameSync(tmpPath, regPath);
}

// --- Port Allocation ---

function allocatePort() {
  const usedPorts = new Set(
    Object.values(registry.instances)
      .filter(i => i.status !== 'stopped' && i.status !== 'failed')
      .map(i => i.port)
  );
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!usedPorts.has(p)) return p;
  }
  throw new Error(`No available ports in range ${PORT_MIN}-${PORT_MAX}`);
}

function freePort(port) {
  // Port is freed implicitly when instance status changes to stopped/failed.
  // This function exists for explicit port management if needed.
  void port;
}

// --- Instance Lifecycle ---

function init({ dataRoot: root }) {
  dataRoot = root;
  fs.mkdirSync(dataRoot, { recursive: true });
  loadRegistry();
}

async function createInstance({ userId, memoryLimitMB = DEFAULT_MEMORY_LIMIT_MB, envExtra = {} }) {
  if (!dataRoot) throw new Error('Instance manager not initialized. Call init() first.');
  if (getInstanceByUserId(userId)) {
    throw new Error(`Instance already exists for user ${userId}`);
  }

  const port = allocatePort();
  const instanceId = `inst-${userId}`;
  const userDataDir = path.join(dataRoot, 'users', userId);
  fs.mkdirSync(path.join(userDataDir, 'briefs'), { recursive: true });

  const child = spawn(process.execPath, [
    `--max-old-space-size=${memoryLimitMB}`,
    SERVER_SCRIPT,
  ], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: userDataDir,
      INSTANCE_ID: instanceId,
      ...envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });

  const instance = {
    instanceId,
    userId,
    port,
    pid: child.pid,
    status: 'starting',
    dataDir: userDataDir,
    memoryLimitMB,
    envExtra, // persisted so restartInstance can re-inject (e.g. KARVI_API_TOKEN)
    createdAt: new Date().toISOString(),
    lastHealthCheck: null,
    healthFailCount: 0,
    restartHistory: [],
  };

  registry.instances[instanceId] = instance;
  childProcesses.set(instanceId, child);

  // Crash detection
  child.on('exit', (code, signal) => {
    handleInstanceExit(instanceId, code, signal);
  });

  // Capture stderr for debugging
  child.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[${instanceId}] ${msg}`);
  });

  saveRegistry();

  // Wait for readiness
  try {
    await waitForReady(child);
    instance.status = 'running';
    saveRegistry();
  } catch (err) {
    console.error(`[instance-manager] ${instanceId} failed to start: ${err.message}`);
    instance.status = 'failed';
    saveRegistry();
  }

  return instance;
}

async function destroyInstance(instanceId, { graceful = true } = {}) {
  const instance = registry.instances[instanceId];
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  if (instance.status === 'stopped') return { ok: true };

  // Mark as stopping to prevent auto-restart race condition
  instance.status = 'stopping';
  saveRegistry();

  if (graceful && instance.port) {
    try {
      await httpPost(`http://localhost:${instance.port}/api/shutdown`);
      await waitForExit(instanceId, SHUTDOWN_TIMEOUT_MS);
    } catch {
      // HTTP shutdown failed, force kill
    }
  }

  // Force kill if still alive
  const child = childProcesses.get(instanceId);
  if (child) {
    try { child.kill(); } catch {}
    childProcesses.delete(instanceId);
  }

  instance.status = 'stopped';
  instance.pid = null;
  saveRegistry();

  return { ok: true };
}

async function restartInstance(instanceId) {
  const instance = registry.instances[instanceId];
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const { userId, memoryLimitMB, envExtra } = instance;
  await destroyInstance(instanceId);

  // Remove old entry so createInstance doesn't throw "already exists"
  delete registry.instances[instanceId];
  saveRegistry();

  return createInstance({ userId, memoryLimitMB, envExtra: envExtra || {} });
}

// --- Query ---

function getInstance(instanceId) {
  return registry.instances[instanceId] || null;
}

function getInstanceByUserId(userId) {
  return Object.values(registry.instances).find(
    i => i.userId === userId && i.status !== 'stopped' && i.status !== 'failed'
  ) || null;
}

function listInstances() {
  return Object.values(registry.instances);
}

// --- Health Checker ---

function startHealthChecker({ intervalMs = HEALTH_CHECK_INTERVAL_MS } = {}) {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    for (const inst of Object.values(registry.instances)) {
      if (inst.status !== 'running') continue;
      checkInstanceHealth(inst);
    }
  }, intervalMs);
}

function stopHealthChecker() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

async function checkInstanceHealth(instance) {
  try {
    const data = await httpGet(`http://localhost:${instance.port}/health`, 5000);
    instance.lastHealthCheck = new Date().toISOString();
    instance.healthFailCount = 0;
    instance.memoryUsageMB = data.memoryMB;

    if (data.memoryMB > instance.memoryLimitMB * 1.5) {
      console.warn(`[instance-manager] ${instance.instanceId} memory ${data.memoryMB}MB exceeds 1.5x limit ${instance.memoryLimitMB}MB`);
    }
    saveRegistry();
  } catch {
    instance.healthFailCount = (instance.healthFailCount || 0) + 1;
    if (instance.healthFailCount >= 3) {
      console.warn(`[instance-manager] ${instance.instanceId} failed ${instance.healthFailCount} health checks, restarting`);
      instance.healthFailCount = 0;
      autoRestart(instance.instanceId);
    }
  }
}

// --- Auto-Restart ---

function handleInstanceExit(instanceId, code, signal) {
  const instance = registry.instances[instanceId];
  if (!instance) return;
  if (instance.status === 'stopped' || instance.status === 'stopping') return; // Expected shutdown

  console.warn(`[instance-manager] ${instanceId} exited unexpectedly (code=${code}, signal=${signal})`);
  childProcesses.delete(instanceId);
  instance.pid = null;

  autoRestart(instanceId);
}

async function autoRestart(instanceId) {
  const instance = registry.instances[instanceId];
  if (!instance) return;

  const now = Date.now();
  const oneHourAgo = now - 3600000;
  const recentRestarts = (instance.restartHistory || []).filter(t => t > oneHourAgo);

  if (recentRestarts.length >= MAX_RESTARTS_PER_HOUR) {
    instance.status = 'failed';
    console.error(`[instance-manager] ${instanceId} exceeded ${MAX_RESTARTS_PER_HOUR} restarts/hour, marking as failed`);
    saveRegistry();
    return;
  }

  instance.restartHistory = [...recentRestarts, now];
  saveRegistry();

  try {
    await restartInstance(instanceId);
    console.log(`[instance-manager] ${instanceId} restarted successfully`);
  } catch (err) {
    console.error(`[instance-manager] ${instanceId} restart failed: ${err.message}`);
    instance.status = 'failed';
    saveRegistry();
  }
}

// --- Shutdown all ---

async function destroyAll() {
  stopHealthChecker();
  const ids = Object.keys(registry.instances).filter(
    id => registry.instances[id].status === 'running' || registry.instances[id].status === 'starting'
  );
  await Promise.all(ids.map(id => destroyInstance(id).catch(() => {})));
}

module.exports = {
  init,
  createInstance,
  destroyInstance,
  restartInstance,
  getInstance,
  getInstanceByUserId,
  listInstances,
  startHealthChecker,
  stopHealthChecker,
  allocatePort,
  freePort,
  loadRegistry,
  saveRegistry,
  destroyAll,
};
