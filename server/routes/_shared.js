/**
 * _shared.js — Shared helper functions used across route modules.
 *
 * Pure utility functions extracted from server.js.
 * No side effects, no external dependencies.
 */
const bb = require('../blackboard-server');

const { nowIso, uid } = bb;

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

function getUserId(req) {
  const url = new URL(req.url, 'http://localhost');
  return req.headers['x-karvi-user']
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
};
