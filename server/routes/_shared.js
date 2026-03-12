/**
 * _shared.js — Shared helper functions used across route modules.
 *
 * Pure utility functions extracted from server.js.
 * No side effects, no external dependencies.
 */
const bb = require('../blackboard-server');
const { hasRole } = require('../rbac');

const { nowIso, uid, json } = bb;

function conversationById(board, id) {
  return (board.conversations || []).find(c => c.id === id);
}

function participantById(board, id) {
  return (board.participants || []).find(p => p.id === id);
}

function createConversation({ id, title, members, defaultAutoTurns = 6 }) {
  return {
    id,
    title,
    members,
    status: 'active',
    settings: {
      autoRunQueue: true,
      defaultAutoTurns,
    },
    runtime: {
      running: false,
      stopRequested: false,
      lastRunAt: null,
    },
    sessionIds: members.reduce((acc, m) => {
      acc[m] = null;
      return acc;
    }, {}),
    queue: [],
    messages: [
      {
        id: uid('msg'),
        ts: nowIso(),
        type: 'system',
        from: 'human',
        to: 'human',
        text: `房間 ${title} 已建立。`,
      },
    ],
  };
}

function pushMessage(conv, msg) {
  conv.messages = conv.messages || [];
  conv.messages.push(msg);
  if (conv.messages.length > 1000) conv.messages = conv.messages.slice(-1000);
}

function enqueueTurn(conv, turn) {
  conv.queue = conv.queue || [];
  conv.queue.push(turn);
}

function requeueRunningTurns(conv, reason = 'manual_resume') {
  conv.queue = conv.queue || [];
  let count = 0;
  for (const t of conv.queue) {
    if (t.status === 'running') {
      t.status = 'queued';
      t.requeuedAt = nowIso();
      t.requeueReason = reason;
      t.history = t.history || [];
      t.history.push({ ts: nowIso(), event: 'requeued', reason });
      count += 1;
    }
  }
  return count;
}

function normalizeText(input) {
  return String(input || '').replace(/\r\n/g, '\n').trim();
}

/**
 * Get user ID from request (per-user attribution).
 * Priority: req.karviUser (gateway/auth) > X-Karvi-User header > query param > default
 */
function getUserId(req) {
  const url = new URL(req.url, 'http://localhost');
  return req.karviUser
    || req.headers['x-karvi-user']
    || url.searchParams.get('userId')
    || 'default';
}

function getUserIdForTask() {
  return 'default';
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

/**
 * requireRole — 檢查 request 的角色是否滿足最低要求。
 * RBAC 未啟用（req.karviRole === null）時所有操作都放行。
 * @param {object} req
 * @param {object} res
 * @param {string} minRole — 'admin' | 'operator' | 'viewer'
 * @returns {boolean} true = 已攔截（已回 403），呼叫端應 return；false = 放行
 */
function requireRole(req, res, minRole) {
  // RBAC 未啟用 → 放行
  if (req.karviRole === null || req.karviRole === undefined) return false;
  if (hasRole(req.karviRole, minRole)) return false;
  // 權限不足
  console.log(`[rbac] 403 ${req.karviRole} tried ${req.method} ${req.url}`);
  json(res, 403, { error: 'forbidden', requiredRole: minRole, currentRole: req.karviRole });
  return true;
}

/**
 * Create a signal object with user attribution.
 * Route-layer wrapper: preserves (opts, req, helpers) signature for backward compat.
 * Actual logic lives in server/signal.js.
 */
const { createSignal: _createSignal } = require('../signal');
function createSignal(opts, req, helpers) {
  return _createSignal(opts, helpers, req);
}

/**
 * Get attribution string for logging.
 * @param {object} req - Request object
 * @returns {string} Attribution string (e.g., "user:alice" or "role:admin" or "anonymous")
 */
function getAttribution(req) {
  if (req?.karviUser) return `user:${req.karviUser}`;
  if (req?.karviRole) return `role:${req.karviRole}`;
  return 'anonymous';
}

module.exports = {
  conversationById,
  participantById,
  createConversation,
  pushMessage,
  enqueueTurn,
  requeueRunningTurns,
  normalizeText,
  getUserId,
  getUserIdForTask,
  deepMerge,
  requireRole,
  createSignal,
  getAttribution,
};
