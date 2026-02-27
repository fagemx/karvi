/**
 * integration-jira.js — Jira integration for Karvi Task Engine
 *
 * Inbound:  Jira webhook → task dispatch
 * Outbound: task status change → Jira transition + comment
 *
 * Zero external dependencies — uses node:https and node:crypto only.
 * All Jira secrets live in environment variables, never in board.json.
 */

const https = require('https');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getConfig(board) {
  return board.integrations?.jira || null;
}

function isEnabled(board) {
  const cfg = getConfig(board);
  return !!(cfg?.enabled && process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL);
}

// ---------------------------------------------------------------------------
// HTTPS client (zero-dep)
// ---------------------------------------------------------------------------

function jiraRequest(method, apiPath, body) {
  const host = process.env.JIRA_HOST;
  if (!host) return Promise.reject(new Error('JIRA_HOST not set'));

  const token = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString('base64');

  const data = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host,
      path: apiPath,
      method,
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: d });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapJiraToKarvi(jiraStatus, config) {
  if (!config?.statusMapping) return null;
  return config.statusMapping[jiraStatus] || null;
}

function mapKarviToJira(karviStatus, config) {
  if (!config?.reverseMapping) return null;
  return config.reverseMapping[karviStatus] || null;
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

function verifyWebhookToken(url) {
  const secret = process.env.JIRA_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured = skip verification

  const parsed = new URL(url, 'http://localhost');
  const token = parsed.searchParams.get('token') || '';

  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(secret)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inbound: handle Jira webhook
// ---------------------------------------------------------------------------

/**
 * handleWebhook(board, payload, url)
 *
 * @param {object} board  — current board state
 * @param {object} payload — Jira webhook JSON body
 * @param {string} url    — request URL (for token verification)
 * @returns {{ action, task?, karviStatus?, error? }}
 */
function handleWebhook(board, payload, url) {
  // 1. Verify token
  if (!verifyWebhookToken(url)) {
    return { action: 'rejected', error: 'Invalid webhook token' };
  }

  const config = getConfig(board);
  if (!config?.enabled) {
    return { action: 'skipped', error: 'Jira integration disabled' };
  }

  // 2. Parse event
  const event = payload.webhookEvent;
  if (event !== 'jira:issue_updated') {
    return { action: 'skipped', error: `Unsupported event: ${event}` };
  }

  // 3. Find status change in changelog
  const items = payload.changelog?.items || [];
  const statusChange = items.find(i => i.field === 'status');
  if (!statusChange) {
    return { action: 'skipped', error: 'No status change in event' };
  }

  const newJiraStatus = statusChange.toString;

  // 4. Check trigger condition
  if (config.triggerStatus && newJiraStatus !== config.triggerStatus) {
    return { action: 'skipped', error: `Status "${newJiraStatus}" is not trigger "${config.triggerStatus}"` };
  }

  // 5. Map to Karvi status
  const karviStatus = mapJiraToKarvi(newJiraStatus, config);
  if (!karviStatus) {
    return { action: 'skipped', error: `No mapping for Jira status "${newJiraStatus}"` };
  }

  // 6. Find matching task by jiraKey
  const issueKey = payload.issue?.key;
  if (!issueKey) {
    return { action: 'skipped', error: 'No issue key in payload' };
  }

  const tasks = board.taskPlan?.tasks || [];
  const task = tasks.find(t =>
    t.jiraKey === issueKey ||
    t.id === issueKey ||
    (t.title && t.title.includes(issueKey))
  );

  if (!task) {
    return { action: 'skipped', error: `No task matches Jira key "${issueKey}"` };
  }

  return {
    action: karviStatus === 'pending' ? 'dispatch' : 'status_change',
    task,
    karviStatus,
    issueKey,
  };
}

// ---------------------------------------------------------------------------
// Outbound: notify Jira of task events
// ---------------------------------------------------------------------------

/**
 * notifyJira(board, task, event)
 *
 * Fire-and-forget notification to Jira. Never throws — logs errors only.
 *
 * @param {object} board — current board state
 * @param {object} task  — the task that changed
 * @param {object} event — { type: 'status_change'|'pr_created', newStatus?, prUrl? }
 */
async function notifyJira(board, task, event) {
  const config = getConfig(board);
  if (!config?.enabled) return;

  const issueKey = task.jiraKey;
  if (!issueKey) return; // task not linked to Jira

  try {
    if (event.type === 'status_change' && event.newStatus) {
      const jiraStatus = mapKarviToJira(event.newStatus, config);

      // Human gate: block auto-transition when merge requires human review
      const gated = config.humanGate?.enabled
        && config.humanGate?.mergeRequiresHuman
        && event.newStatus === 'approved';

      // Transition the Jira issue (unless gated)
      if (jiraStatus && !gated) {
        const transitionId = await findTransitionId(issueKey, jiraStatus);
        if (transitionId) {
          await jiraRequest('POST', `/rest/api/3/issue/${issueKey}/transitions`, {
            transition: { id: transitionId },
          });
        }
      }

      // Add comment for notable events
      const comment = buildComment(task, event, config);
      if (comment) {
        await jiraRequest('POST', `/rest/api/3/issue/${issueKey}/comment`, {
          body: { type: 'doc', version: 1, content: [
            { type: 'paragraph', content: [{ type: 'text', text: comment }] },
          ]},
        });
      }
    }

    if (event.type === 'pr_created' && event.prUrl) {
      await jiraRequest('POST', `/rest/api/3/issue/${issueKey}/comment`, {
        body: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [
            { type: 'text', text: `PR created: ${event.prUrl}` },
          ]},
        ]},
      });
    }
  } catch (err) {
    console.error(`[jira] notifyJira failed for ${issueKey}:`, err.message);
  }
}

/**
 * Find the Jira transition ID for a target status name.
 */
async function findTransitionId(issueKey, targetStatusName) {
  const resp = await jiraRequest('GET', `/rest/api/3/issue/${issueKey}/transitions`);
  if (resp.status !== 200 || !resp.body?.transitions) return null;

  const match = resp.body.transitions.find(t =>
    t.name === targetStatusName ||
    t.to?.name === targetStatusName
  );
  return match?.id || null;
}

/**
 * Build a human-readable comment for notable status changes.
 */
function buildComment(task, event, config) {
  const status = event.newStatus;
  if (status === 'completed') {
    return `[Karvi] Task "${task.title}" completed.${task.result?.summary ? ' ' + task.result.summary : ''}`;
  }
  if (status === 'blocked') {
    return `[Karvi] Task "${task.title}" is blocked.${task.blocker?.reason ? ' Reason: ' + task.blocker.reason : ''}`;
  }
  if (status === 'approved') {
    const gated = config?.humanGate?.enabled && config?.humanGate?.mergeRequiresHuman;
    if (gated) {
      return `[Karvi] Task "${task.title}" approved. Human merge review required — auto-merge disabled by human gate policy.`;
    }
    return `[Karvi] Task "${task.title}" approved and ready for merge.`;
  }
  return null; // no comment for other statuses
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

async function testConnection() {
  if (!process.env.JIRA_HOST || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
    return { ok: false, error: 'Missing environment variables (JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN)' };
  }
  try {
    const resp = await jiraRequest('GET', '/rest/api/3/myself');
    if (resp.status === 200) {
      return { ok: true, user: resp.body?.displayName || resp.body?.emailAddress };
    }
    return { ok: false, error: `HTTP ${resp.status}`, body: resp.body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getConfig,
  isEnabled,
  handleWebhook,
  notifyJira,
  testConnection,
  mapJiraToKarvi,
  mapKarviToJira,
  // exposed for testing
  jiraRequest,
  verifyWebhookToken,
};
