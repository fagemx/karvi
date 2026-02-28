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
// ADF (Atlassian Document Format) → plain text
// ---------------------------------------------------------------------------

/**
 * adfToPlainText(node) — recursively extract plain text from Jira ADF JSON.
 * Unknown node types gracefully return empty string.
 *
 * @param {object|string|null} node — ADF node or raw string
 * @returns {string}
 */
function adfToPlainText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (!Array.isArray(node.content)) return '';
  const parts = node.content.map(child => adfToPlainText(child));
  // Add newline after block-level nodes (paragraph, heading, listItem, etc.)
  const blockTypes = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableCell']);
  if (blockTypes.has(node.type)) {
    return parts.join('') + '\n';
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Priority mapping (Jira → Karvi P0-P4)
// ---------------------------------------------------------------------------

const JIRA_PRIORITY_MAP = {
  'Highest':  'P0',
  'Blocker':  'P0',
  'Critical': 'P0',
  'High':     'P1',
  'Medium':   'P2',
  'Normal':   'P2',
  'Low':      'P3',
  'Minor':    'P3',
  'Lowest':   'P4',
  'Trivial':  'P4',
};

/**
 * mapJiraPriority(name) — map Jira priority name to P0-P4.
 * Returns 'P2' (Medium) as default for unknown priorities.
 */
function mapJiraPriority(name) {
  if (!name) return 'P2';
  return JIRA_PRIORITY_MAP[name] || 'P2';
}

// ---------------------------------------------------------------------------
// Build Karvi task from Jira issue
// ---------------------------------------------------------------------------

/**
 * buildTaskFromIssue(issue, config)
 *
 * @param {object} issue — Jira issue object from webhook payload
 * @param {object} config — board.integrations.jira config
 * @returns {object} Karvi task object
 */
function buildTaskFromIssue(issue, config) {
  const fields = issue.fields || {};
  const key = issue.key || '';
  const host = process.env.JIRA_HOST || '';
  const jiraUrl = host ? `https://${host}/browse/${key}` : '';

  // Extract description — could be ADF object or plain string
  let description = '';
  if (fields.description) {
    if (typeof fields.description === 'string') {
      description = fields.description;
    } else {
      description = adfToPlainText(fields.description).trim();
    }
  }
  // Truncate to 2000 chars
  const MAX_DESC = 2000;
  if (description.length > MAX_DESC) {
    description = description.slice(0, MAX_DESC) + '... (truncated)';
  }

  const priority = mapJiraPriority(fields.priority?.name);
  const assignee = fields.assignee?.displayName || null;

  return {
    id: key,
    title: fields.summary || key,
    description,
    status: 'pending',
    jiraKey: key,
    jiraUrl,
    source: 'jira',
    priority,
    assignee: assignee,
    depends: [],
    history: [{ ts: new Date().toISOString(), status: 'created', by: 'jira-webhook' }],
  };
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

  // --- Handle issue_created: build new task ---
  if (event === 'jira:issue_created') {
    const issue = payload.issue;
    if (!issue?.key) {
      return { action: 'skipped', error: 'No issue key in payload' };
    }

    // Dedup: skip if task with same jiraKey already exists
    const tasks = board.taskPlan?.tasks || [];
    if (tasks.some(t => t.jiraKey === issue.key)) {
      return { action: 'skipped', error: `Task already exists for ${issue.key}` };
    }

    const task = buildTaskFromIssue(issue, config);
    return {
      action: 'create_task',
      task,
      issueKey: issue.key,
    };
  }

  // --- Handle issue_updated: existing logic ---
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
  adfToPlainText,
  mapJiraPriority,
  buildTaskFromIssue,
};

// ---------------------------------------------------------------------------
// Self-tests (run via: node server/integration-jira.js)
// ---------------------------------------------------------------------------

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  function ok(name) { passed++; console.log(`  OK: ${name}`); }
  function fail(name, err) { failed++; console.log(`  FAIL: ${name}: ${err}`); }

  console.log('integration-jira.js self-tests\n');

  // --- adfToPlainText ---
  try {
    const adf = {
      type: 'doc', version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' World' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
      ],
    };
    const result = adfToPlainText(adf);
    if (!result.includes('Hello World')) throw new Error(`missing "Hello World" in: ${result}`);
    if (!result.includes('Second paragraph')) throw new Error(`missing "Second paragraph" in: ${result}`);
    ok('adfToPlainText: nested paragraphs');
  } catch (e) { fail('adfToPlainText: nested paragraphs', e.message); }

  try {
    if (adfToPlainText(null) !== '') throw new Error('null should return empty');
    if (adfToPlainText('plain') !== 'plain') throw new Error('string should pass through');
    if (adfToPlainText({}) !== '') throw new Error('empty object should return empty');
    ok('adfToPlainText: edge cases (null, string, empty)');
  } catch (e) { fail('adfToPlainText: edge cases', e.message); }

  // --- mapJiraPriority ---
  try {
    if (mapJiraPriority('Highest') !== 'P0') throw new Error('Highest should be P0');
    if (mapJiraPriority('High') !== 'P1') throw new Error('High should be P1');
    if (mapJiraPriority('Medium') !== 'P2') throw new Error('Medium should be P2');
    if (mapJiraPriority('Low') !== 'P3') throw new Error('Low should be P3');
    if (mapJiraPriority('Lowest') !== 'P4') throw new Error('Lowest should be P4');
    if (mapJiraPriority(null) !== 'P2') throw new Error('null should default to P2');
    if (mapJiraPriority('UnknownPriority') !== 'P2') throw new Error('unknown should default to P2');
    ok('mapJiraPriority: all mappings');
  } catch (e) { fail('mapJiraPriority', e.message); }

  // --- buildTaskFromIssue ---
  try {
    process.env.JIRA_HOST = 'test.atlassian.net';
    const issue = {
      key: 'TEST-42',
      fields: {
        summary: 'Fix login bug',
        description: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Users cannot log in' }] },
        ]},
        priority: { name: 'Critical' },
        assignee: { displayName: 'Alice' },
      },
    };
    const task = buildTaskFromIssue(issue, {});
    if (task.id !== 'TEST-42') throw new Error(`id: ${task.id}`);
    if (task.jiraKey !== 'TEST-42') throw new Error(`jiraKey: ${task.jiraKey}`);
    if (task.jiraUrl !== 'https://test.atlassian.net/browse/TEST-42') throw new Error(`jiraUrl: ${task.jiraUrl}`);
    if (task.source !== 'jira') throw new Error(`source: ${task.source}`);
    if (task.priority !== 'P0') throw new Error(`priority: ${task.priority}`);
    if (task.status !== 'pending') throw new Error(`status: ${task.status}`);
    if (!task.description.includes('Users cannot log in')) throw new Error(`description: ${task.description}`);
    if (task.assignee !== 'Alice') throw new Error(`assignee: ${task.assignee}`);
    ok('buildTaskFromIssue: full field mapping');
    delete process.env.JIRA_HOST;
  } catch (e) { fail('buildTaskFromIssue', e.message); delete process.env.JIRA_HOST; }

  // --- handleWebhook: issue_created ---
  try {
    const board = {
      integrations: { jira: { enabled: true } },
      taskPlan: { tasks: [] },
    };
    const payload = {
      webhookEvent: 'jira:issue_created',
      issue: {
        key: 'PROJ-1',
        fields: { summary: 'New feature', priority: { name: 'Medium' } },
      },
    };
    const result = handleWebhook(board, payload, 'http://localhost/api/webhooks/jira');
    if (result.action !== 'create_task') throw new Error(`action: ${result.action}`);
    if (result.task.id !== 'PROJ-1') throw new Error(`task.id: ${result.task.id}`);
    if (result.issueKey !== 'PROJ-1') throw new Error(`issueKey: ${result.issueKey}`);
    ok('handleWebhook: issue_created → create_task');
  } catch (e) { fail('handleWebhook: issue_created', e.message); }

  // --- handleWebhook: dedup ---
  try {
    const board = {
      integrations: { jira: { enabled: true } },
      taskPlan: { tasks: [{ id: 'PROJ-1', jiraKey: 'PROJ-1', title: 'Existing' }] },
    };
    const payload = {
      webhookEvent: 'jira:issue_created',
      issue: {
        key: 'PROJ-1',
        fields: { summary: 'Duplicate' },
      },
    };
    const result = handleWebhook(board, payload, 'http://localhost/api/webhooks/jira');
    if (result.action !== 'skipped') throw new Error(`action: ${result.action}`);
    if (!result.error.includes('already exists')) throw new Error(`error: ${result.error}`);
    ok('handleWebhook: dedup → skipped');
  } catch (e) { fail('handleWebhook: dedup', e.message); }

  // --- handleWebhook: issue_updated still works (regression check) ---
  try {
    const board = {
      integrations: { jira: { enabled: true, statusMapping: { 'Done': 'completed' } } },
      taskPlan: { tasks: [{ id: 'REG-1', jiraKey: 'REG-1', title: 'Regression test', status: 'in_progress' }] },
    };
    const payload = {
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'REG-1' },
      changelog: { items: [{ field: 'status', toString: 'Done' }] },
    };
    const result = handleWebhook(board, payload, 'http://localhost/api/webhooks/jira');
    if (result.action !== 'status_change') throw new Error(`action: ${result.action}`);
    if (result.karviStatus !== 'completed') throw new Error(`karviStatus: ${result.karviStatus}`);
    ok('handleWebhook: issue_updated regression → status_change');
  } catch (e) { fail('handleWebhook: issue_updated regression', e.message); }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
