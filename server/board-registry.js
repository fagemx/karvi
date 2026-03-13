/**
 * board-registry.js — Multi-Village Board Registry
 *
 * Manages multiple village boards, each with its own:
 *   - board.json (task plan, village config, signals, etc.)
 *   - task-log.jsonl (append-only audit log)
 *   - artifacts/ directory
 *
 * The "default" village maps to the legacy single-board (backward compatible).
 * Named villages live under data/villages/{villageId}/.
 *
 * Usage:
 *   const registry = require('./board-registry');
 *   const reg = registry.createRegistry({ dataDir, bbModule, boardType });
 *   reg.registerVillage('v-strategy', { name: '戰略村' });
 *   const ctx = reg.getContext('v-strategy');
 *   const helpers = reg.getHelpers('v-strategy');
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_VILLAGE_ID = 'default';
const VILLAGE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Create a board registry instance.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - Base data directory (where board.json lives for legacy)
 * @param {object} opts.bb - blackboard-server module reference
 * @param {string} opts.boardType - Board type string for meta enforcement
 * @param {object} opts.defaultCtx - The existing default context (legacy single-board)
 * @returns {object} registry API
 */
function createRegistry(opts) {
  const { dataDir, bb, boardType, defaultCtx } = opts;
  const villagesDir = path.join(dataDir, 'villages');

  // In-memory registry: villageId → { meta, ctx }
  const villages = new Map();

  // Register the default village (legacy board)
  villages.set(DEFAULT_VILLAGE_ID, {
    meta: { id: DEFAULT_VILLAGE_ID, name: 'Default Village', createdAt: null },
    ctx: defaultCtx,
  });

  /**
   * Ensure the villages base directory exists.
   */
  function ensureVillagesDir() {
    if (!fs.existsSync(villagesDir)) {
      fs.mkdirSync(villagesDir, { recursive: true });
    }
  }

  /**
   * Get the data directory for a village.
   */
  function villageDataDir(villageId) {
    if (villageId === DEFAULT_VILLAGE_ID) return dataDir;
    if (!VILLAGE_ID_RE.test(villageId)) throw new Error('Invalid village ID');
    return path.join(villagesDir, villageId);
  }

  /**
   * Create a bb context for a named village.
   */
  function createVillageContext(villageId) {
    const vDir = villageDataDir(villageId);
    if (!fs.existsSync(vDir)) {
      fs.mkdirSync(vDir, { recursive: true });
    }

    return bb.createContext({
      dir: defaultCtx.dir,  // static files still from root
      boardPath: path.join(vDir, 'board.json'),
      logPath: path.join(vDir, 'task-log.jsonl'),
      signalArchivePath: path.join(vDir, 'signal-archive.jsonl'),
      port: defaultCtx.port,  // same port, different routes
      boardType: boardType || 'task-engine',
      // Inherit auth from default
      apiToken: defaultCtx.apiToken,
      rateLimit: false, // rate limiting is handled at server level
    });
  }

  /**
   * Register a new village.
   *
   * @param {string} villageId - Unique village identifier (e.g. 'v-strategy')
   * @param {object} meta - Village metadata { name, territoryId, ... }
   * @returns {{ id: string, name: string, status: string }}
   */
  function registerVillage(villageId, meta = {}) {
    if (!villageId || typeof villageId !== 'string') {
      throw new Error('villageId is required and must be a string');
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(villageId)) {
      throw new Error('villageId must match /^[a-z0-9][a-z0-9_-]*$/ (lowercase, no spaces)');
    }

    // Already registered → update meta only
    if (villages.has(villageId)) {
      const existing = villages.get(villageId);
      Object.assign(existing.meta, meta);
      return formatVillageInfo(villageId);
    }

    ensureVillagesDir();
    const ctx = createVillageContext(villageId);

    const now = new Date().toISOString();
    const villageMeta = {
      id: villageId,
      name: meta.name || villageId,
      territoryId: meta.territoryId || null,
      createdAt: now,
      ...meta,
    };

    villages.set(villageId, { meta: villageMeta, ctx });

    // Ensure village board.json exists with default structure
    bb.ensureBoardExists(ctx, {
      taskPlan: { goal: '', phase: 'idle', tasks: [] },
      pipelineTemplates: {},
      projects: [],
      conversations: [],
      participants: [],
      signals: [],
      insights: [],
      lessons: [],
      village: {
        villageId,
        territoryId: meta.territoryId || null,
        goals: [],
        departments: [],
        currentCycle: null,
        sharedArtifacts: [],
        territoryGoals: [],
      },
      controls: {
        auto_review: true,
        auto_redispatch: false,
        max_review_attempts: 3,
        quality_threshold: 70,
        cycle_stall_timeout_hours: 4,
      },
    });

    console.log(`[board-registry] registered village: ${villageId} (${villageMeta.name})`);
    return formatVillageInfo(villageId);
  }

  /**
   * Get the bb context for a village.
   *
   * @param {string} villageId
   * @returns {object|null} The bb context, or null if not registered
   */
  function getContext(villageId) {
    const entry = villages.get(villageId || DEFAULT_VILLAGE_ID);
    return entry ? entry.ctx : null;
  }

  /**
   * Get a helpers object for a village (matching the routeHelpers interface).
   *
   * @param {string} villageId
   * @returns {object|null} helpers object, or null if not registered
   */
  function getHelpers(villageId) {
    const ctx = getContext(villageId);
    if (!ctx) return null;

    return {
      json: bb.json,
      parseBody: (req, maxBytes) => bb.parseBody(req, maxBytes || ctx.maxBodyBytes),
      readBoard: () => bb.readBoard(ctx),
      writeBoard: (b) => bb.writeBoard(ctx, b),
      appendLog: (e) => bb.appendLog(ctx, e),
      broadcastSSE: (ev, d) => bb.broadcastSSE(ctx, ev, d),
      signalArchivePath: ctx.signalArchivePath,
      nowIso: bb.nowIso,
      uid: bb.uid,
    };
  }

  /**
   * List all registered villages.
   *
   * @returns {object[]} Array of { id, name, status, ... }
   */
  function listVillages() {
    const result = [];
    for (const [id] of villages) {
      result.push(formatVillageInfo(id));
    }
    return result;
  }

  /**
   * Check if a village is registered.
   */
  function hasVillage(villageId) {
    return villages.has(villageId || DEFAULT_VILLAGE_ID);
  }

  /**
   * Get the nation-level context (top-level board / default village).
   */
  function getNationContext() {
    return getContext(DEFAULT_VILLAGE_ID);
  }

  /**
   * Scan the villages directory on startup and auto-register any existing villages.
   */
  function discoverExistingVillages() {
    if (!fs.existsSync(villagesDir)) return;
    const entries = fs.readdirSync(villagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const villageId = entry.name;
      if (!VILLAGE_ID_RE.test(villageId)) continue;
      if (villages.has(villageId)) continue;

      const vDir = path.join(villagesDir, villageId);
      const boardPath = path.join(vDir, 'board.json');
      if (!fs.existsSync(boardPath)) continue;

      // Read village name from existing board
      let name = villageId;
      try {
        const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
        name = board.village?.name || board.village?.villageId || villageId;
      } catch { /* ignore parse errors */ }

      const ctx = createVillageContext(villageId);
      villages.set(villageId, {
        meta: { id: villageId, name, createdAt: null },
        ctx,
      });
      console.log(`[board-registry] discovered existing village: ${villageId}`);
    }
  }

  /**
   * Format village info for API responses.
   */
  function formatVillageInfo(villageId) {
    const entry = villages.get(villageId);
    if (!entry) return null;
    return {
      id: villageId,
      name: entry.meta.name,
      territoryId: entry.meta.territoryId || null,
      createdAt: entry.meta.createdAt,
      status: 'active',
    };
  }

  return {
    registerVillage,
    getContext,
    getHelpers,
    listVillages,
    hasVillage,
    getNationContext,
    discoverExistingVillages,
    formatVillageInfo,
    DEFAULT_VILLAGE_ID,
  };
}

module.exports = { createRegistry, DEFAULT_VILLAGE_ID };
