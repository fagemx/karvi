/**
 * push.js — Expo Push Notification Module
 *
 * 使用 Node.js 內建 https 模組呼叫 Expo Push API，零外部依賴。
 * Push tokens 儲存在獨立檔案 (push-tokens.json)，不在 board.json 裡，
 * 避免透過 SSE 廣播洩漏 device token。
 *
 * 所有 push 呼叫都是 fire-and-forget，失敗不影響主流程。
 */
const https = require('https');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Token Storage
// ---------------------------------------------------------------------------

function loadTokens(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error('[push] loadTokens error:', err.message);
  }
  return { tokens: [] };
}

function saveTokens(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function registerToken(filePath, token, deviceName) {
  const data = loadTokens(filePath);
  const existing = data.tokens.findIndex(t => t.token === token);
  if (existing >= 0) {
    // Update metadata for existing token
    data.tokens[existing].lastUsedAt = new Date().toISOString();
    data.tokens[existing].deviceName = deviceName || data.tokens[existing].deviceName;
  } else {
    data.tokens.push({
      token,
      deviceName: deviceName || 'Unknown',
      registeredAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
  }
  saveTokens(filePath, data);
}

function removeToken(filePath, token) {
  const data = loadTokens(filePath);
  data.tokens = data.tokens.filter(t => t.token !== token);
  saveTokens(filePath, data);
}

// ---------------------------------------------------------------------------
// Expo Push API
// ---------------------------------------------------------------------------

function sendPush(tokenStrings, { title, body, data }) {
  if (!tokenStrings || tokenStrings.length === 0) return Promise.resolve({ data: [] });

  const messages = tokenStrings.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data: data || {},
  }));

  const postData = JSON.stringify(messages);
  const options = {
    hostname: 'exp.host',
    path: '/--/api/v2/push/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', c => (responseBody += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve({ data: [] });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Expo Push API timeout'));
    });
    req.end(postData);
  });
}

// ---------------------------------------------------------------------------
// Notification Builder
// ---------------------------------------------------------------------------

function buildNotification(task, eventType) {
  const map = {
    'task.completed': {
      title: `${task.id} Completed`,
      body: `${task.title} — waiting for review`,
    },
    'task.blocked': {
      title: `${task.id} Blocked`,
      body: task.blocker?.reason || task.title,
    },
    'task.needs_revision': {
      title: `${task.id} Needs Revision`,
      body: task.review?.summary || task.title,
    },
    'task.approved': {
      title: `${task.id} Approved`,
      body: task.title,
    },
    'dispatch.failed': {
      title: 'Dispatch Failed',
      body: `${task.id}: ${task.blocker?.reason || 'unknown error'}`,
    },
    'all.approved': {
      title: 'All Tasks Complete',
      body: 'All tasks have been approved',
    },
    'task.ac_changed': {
      title: `${task.id} Requirements Updated`,
      body: `${task.title} — acceptance criteria changed, please review`,
    },
    // TODO: pr.created — 當 PR review 功能 (#27) 落地後，加入 PR 建立通知。
    // 屆時需在 server.js 的 PR 建立流程中呼叫 notifyTaskEvent(path, task, 'pr.created')。
    'pr.created': {
      title: `PR Created: ${task.id}`,
      body: task.pr?.url || task.title,
    },
  };

  const msg = map[eventType];
  if (!msg) return null;

  return {
    ...msg,
    data: {
      taskId: task.id,
      eventType,
      url: `karvi:///task/${task.id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// High-Level: Notify + Cleanup stale tokens
// ---------------------------------------------------------------------------

async function notifyTaskEvent(filePath, task, eventType) {
  const notification = buildNotification(task, eventType);
  if (!notification) return;

  const data = loadTokens(filePath);
  if (data.tokens.length === 0) return;

  const tokenStrings = data.tokens.map(t => t.token);
  const result = await sendPush(tokenStrings, notification);

  // Cleanup stale tokens (DeviceNotRegistered)
  if (result.data && Array.isArray(result.data)) {
    const staleTokens = [];
    result.data.forEach((r, i) => {
      if (r.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
        staleTokens.push(tokenStrings[i]);
      }
    });
    if (staleTokens.length > 0) {
      for (const t of staleTokens) {
        removeToken(filePath, t);
      }
      console.log(`[push] Removed ${staleTokens.length} stale token(s)`);
    }
  }

  console.log(`[push] Sent ${eventType} to ${tokenStrings.length} device(s)`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadTokens,
  saveTokens,
  registerToken,
  removeToken,
  sendPush,
  buildNotification,
  notifyTaskEvent,
};
