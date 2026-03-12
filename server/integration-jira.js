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

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
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
        const parsed = safeJsonParse(d);
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

// Fields that always trigger sync (Jira standard fields)
const SUBSTANTIVE_FIELDS = new Set(['summary', 'description', 'priority']);

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
// @karvi mention command parser
// ---------------------------------------------------------------------------

const JIRA_MENTION_RE = /@karvi\b\s*(.*)/i;

/**
 * parseMentionCommand(commentBody)
 *
 * Extract command from @karvi mention in a Jira comment body.
 * @param {string} commentBody — raw comment text (ADF already converted to plain text)
 * @returns {{ mentioned: boolean, command: string, args: string } | { mentioned: false }}
 */
function parseMentionCommand(commentBody) {
  const match = (commentBody || '').match(JIRA_MENTION_RE);
  if (!match) return { mentioned: false };

  const raw = match[1].trim();
  if (!raw) return { mentioned: true, command: 'implement', args: '' };

  const parts = raw.split(/\s+/);
  const first = parts[0].toLowerCase();

  // Normalize aliases
  if (first === 'fix' || first === 'implement') {
    return { mentioned: true, command: first, args: parts.slice(1).join(' ') };
  }
  if (first === 'status') {
    return { mentioned: true, command: 'status', args: parts.slice(1).join(' ') };
  }
  if (first === 'plan') {
    return { mentioned: true, command: 'plan', args: parts.slice(1).join(' ') };
  }

  // Unknown command → treat as implement with full text as args
  return { mentioned: true, command: 'implement', args: raw };
}

// ---------------------------------------------------------------------------
// Handle comment_created webhook with @karvi mention
// ---------------------------------------------------------------------------

/**
 * handleMentionWebhook(board, payload, config)
 *
 * Processes comment_created events looking for @karvi mentions.
 * Returns action to take: create_task, status_reply, or skipped.
 *
 * @param {object} board — current board state
 * @param {object} payload — parsed Jira webhook JSON body (comment_created event)
 * @param {object|null} config — board.integrations.jira
 * @returns {{ action: string, task?: object, issueKey?: string, existingTask?: object, command?: string, error?: string }}
 */
function handleMentionWebhook(board, payload, config) {
  if (!config?.enabled) {
    return { action: 'skipped', error: 'Jira integration disabled' };
  }

  // Only handle comment_created webhook event
  const webhookEvent = payload.webhookEvent;
  if (webhookEvent !== 'comment_created') {
    return { action: 'skipped', error: `Not a comment_created event (event: ${webhookEvent})` };
  }

  const comment = payload.comment;
  if (!comment?.body) {
    return { action: 'skipped', error: 'No comment body in payload' };
  }

  // Convert ADF comment body to plain text for parsing
  let commentBody = '';
  if (typeof comment.body === 'string') {
    commentBody = comment.body;
  } else {
    commentBody = adfToPlainText(comment.body).trim();
  }

  const parsed = parseMentionCommand(commentBody);
  if (!parsed.mentioned) {
    return { action: 'skipped', error: 'No @karvi mention in comment' };
  }

  const issue = payload.issue;
  if (!issue?.key) {
    return { action: 'skipped', error: 'No issue key in payload' };
  }

  const issueKey = issue.key;
  const tasks = board.taskPlan?.tasks || [];

  // Status command → return existing task info
  if (parsed.command === 'status') {
    const existing = tasks.find(t =>
      t.jiraKey === issueKey ||
      t.id === issueKey
    );
    return { action: 'status_reply', existingTask: existing || null, issueKey, command: 'status' };
  }

  // Check if task already exists for this issue
  const existingTask = tasks.find(t =>
    t.jiraKey === issueKey ||
    t.id === issueKey
  );

  if (existingTask) {
    return { action: 'already_exists', existingTask, issueKey, command: parsed.command };
  }

  // Build task from the issue context
  const task = buildTaskFromMention(issue, commentBody, parsed, config);
  task.status = 'dispatched'; // Auto-dispatch on mention

  return { action: 'create_task', task, issueKey, command: parsed.command };
}

/**
 * buildTaskFromMention(issue, commentBody, parsed, config)
 *
 * Build a Karvi task from a Jira issue when @karvi is mentioned.
 *
 * @param {object} issue — Jira issue object
 * @param {string} commentBody — the comment that triggered the mention
 * @param {object} parsed — parsed mention command { command, args }
 * @param {object} config — board.integrations.jira config
 * @returns {object} Karvi task object
 */
function buildTaskFromMention(issue, commentBody, parsed, config) {
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

  // Append the mention context to description
  if (parsed.args) {
    description += `\n\n--- @karvi mention ---\n${parsed.args}`;
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
    status: 'dispatched',
    jiraKey: key,
    jiraUrl,
    source: 'jira',
    sourceType: 'jira_mention',
    priority,
    assignee,
    depends: [],
    history: [
      { ts: new Date().toISOString(), status: 'created', by: 'jira-mention' },
      { ts: new Date().toISOString(), status: 'dispatched', by: 'jira-mention' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Field change detection (issue #51 — AC/DoD sync)
// ---------------------------------------------------------------------------

/**
 * detectFieldChanges(changelogItems, config)
 *
 * Filters changelog items to find substantive field changes.
 * Returns array of { field, label, fromValue, toValue } or empty array.
 *
 * @param {Array} changelogItems — payload.changelog.items
 * @param {object} config — board.integrations.jira config
 * @returns {Array<{field, label, fromValue, toValue}>}
 */
function detectFieldChanges(changelogItems, config) {
  if (!Array.isArray(changelogItems)) return [];

  // Build set of custom AC/DoD field names from config
  const customFields = new Map();
  if (Array.isArray(config?.acFields)) {
    for (const f of config.acFields) {
      if (f.jiraField) customFields.set(f.jiraField, f.label || f.jiraField);
    }
  }

  const changes = [];
  for (const item of changelogItems) {
    const field = item.field;
    if (!field) continue;

    // Skip status — handled by existing logic
    if (field === 'status') continue;

    if (SUBSTANTIVE_FIELDS.has(field) || customFields.has(field)) {
      changes.push({
        field,
        label: customFields.get(field) || field,
        fromValue: item.fromString || '',
        toValue: item.toString || '',
      });
    }
  }
  return changes;
}

/**
 * computeChangeHash(changes)
 * Deterministic hash of field changes for dedup.
 * Order-independent: sorts before hashing.
 */
function computeChangeHash(changes) {
  const payload = changes
    .map(c => `${c.field}:${c.toValue}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
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

/**
 * verifyHmacSignature(rawBody, signatureHeader, secret)
 *
 * Verifies Jira webhook HMAC-SHA256 signature (for servers that support it).
 * @param {string} rawBody — raw request body string
 * @param {string|undefined} signatureHeader — X-Hub-Signature-256 or custom header value
 * @param {string|null} secret — webhook secret (null = skip verification)
 * @returns {boolean}
 */
function verifyHmacSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

  // --- Handle issue_updated: status + field changes ---
  if (event !== 'jira:issue_updated') {
    return { action: 'skipped', error: `Unsupported event: ${event}` };
  }

  // 3a. Check for status change (existing behavior)
  const items = payload.changelog?.items || [];
  const statusChange = items.find(i => i.field === 'status');

  // 3b. Check for substantive field changes (AC/DoD sync — issue #51)
  const fieldChanges = detectFieldChanges(items, config);

  // If neither status nor field changes, skip
  if (!statusChange && fieldChanges.length === 0) {
    return { action: 'skipped', error: 'No substantive changes in event' };
  }

  // 3c. Find matching task by jiraKey
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

  // 3d. Handle field changes (processed BEFORE status change)
  if (fieldChanges.length > 0) {
    // Compute change hash for dedup
    const changeHash = computeChangeHash(fieldChanges);
    if (task._lastChangeHash === changeHash) {
      return { action: 'skipped', error: 'Duplicate field change (same hash)' };
    }

    // Build updated values from the issue's current fields
    const issue = payload.issue;
    const updatedFields = {};
    for (const change of fieldChanges) {
      if (change.field === 'summary') {
        updatedFields.title = issue.fields?.summary || change.toValue;
      }
      if (change.field === 'description') {
        let desc = '';
        if (issue.fields?.description) {
          desc = typeof issue.fields.description === 'string'
            ? issue.fields.description
            : adfToPlainText(issue.fields.description).trim();
        }
        if (desc.length > 2000) desc = desc.slice(0, 2000) + '... (truncated)';
        updatedFields.description = desc || change.toValue;
      }
      if (change.field === 'priority') {
        updatedFields.priority = mapJiraPriority(issue.fields?.priority?.name || change.toValue);
      }
      // Custom AC/DoD fields → stored in acFields for appending to description
      if (!SUBSTANTIVE_FIELDS.has(change.field)) {
        updatedFields.acFields = updatedFields.acFields || {};
        updatedFields.acFields[change.label] = change.toValue;
      }
    }

    // Determine if this is a priority escalation (P0 < P1 — string compare works)
    const priorityEscalated = !!(updatedFields.priority &&
      updatedFields.priority < (task.priority || 'P2'));

    return {
      action: 'fields_updated',
      task,
      issueKey,
      changes: fieldChanges,
      updatedFields,
      changeHash,
      priorityEscalated,
      // Also return statusChange if both happened in same webhook
      statusChange: statusChange ? {
        newStatus: mapJiraToKarvi(statusChange.toString, config),
        rawStatus: statusChange.toString,
      } : null,
    };
  }

  // 3e. Status-only change (existing logic, unchanged)
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

    if (event.type === 'pr_merged' && event.prUrl) {
      const text = `[Karvi] PR merged${event.mergedBy ? ` by ${event.mergedBy}` : ''}: ${event.prUrl}`;
      await jiraRequest('POST', `/rest/api/3/issue/${issueKey}/comment`, {
        body: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [{ type: 'text', text }] },
        ]},
      });
    }

    if (event.type === 'pr_closed' && event.prUrl) {
      await jiraRequest('POST', `/rest/api/3/issue/${issueKey}/comment`, {
        body: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [
            { type: 'text', text: `[Karvi] PR closed without merge: ${event.prUrl}` },
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
  handleMentionWebhook,
  notifyJira,
  testConnection,
  mapJiraToKarvi,
  mapKarviToJira,
  // exposed for testing
  jiraRequest,
  verifyWebhookToken,
  verifyHmacSignature,
  adfToPlainText,
  mapJiraPriority,
  buildTaskFromIssue,
  buildTaskFromMention,
  detectFieldChanges,
  computeChangeHash,
  parseMentionCommand,
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

  // --- detectFieldChanges: filters substantive fields ---
  try {
    const items = [
      { field: 'summary', fromString: 'Old', toString: 'New' },
      { field: 'status', fromString: 'Open', toString: 'Done' },
      { field: 'Rank', fromString: '1', toString: '2' },
    ];
    const changes = detectFieldChanges(items, {});
    if (changes.length !== 1) throw new Error(`expected 1 change, got ${changes.length}`);
    if (changes[0].field !== 'summary') throw new Error(`expected summary, got ${changes[0].field}`);
    ok('detectFieldChanges: filters substantive fields');
  } catch (e) { fail('detectFieldChanges: filters', e.message); }

  // --- detectFieldChanges: custom AC fields ---
  try {
    const items = [
      { field: 'customfield_10020', fromString: 'old AC', toString: 'new AC' },
    ];
    const config = { acFields: [{ jiraField: 'customfield_10020', label: 'Acceptance Criteria' }] };
    const changes = detectFieldChanges(items, config);
    if (changes.length !== 1) throw new Error(`expected 1, got ${changes.length}`);
    if (changes[0].label !== 'Acceptance Criteria') throw new Error(`label: ${changes[0].label}`);
    ok('detectFieldChanges: custom AC fields');
  } catch (e) { fail('detectFieldChanges: custom AC fields', e.message); }

  // --- computeChangeHash: deterministic and order-independent ---
  try {
    const changes = [
      { field: 'summary', toValue: 'New Title' },
      { field: 'description', toValue: 'New Desc' },
    ];
    const h1 = computeChangeHash(changes);
    const h2 = computeChangeHash([...changes].reverse());
    if (h1 !== h2) throw new Error('hash should be order-independent');
    if (h1.length !== 16) throw new Error(`expected 16-char hash, got ${h1.length}`);
    ok('computeChangeHash: deterministic and order-independent');
  } catch (e) { fail('computeChangeHash', e.message); }

  // --- handleWebhook: fields_updated action ---
  try {
    const board = {
      integrations: { jira: { enabled: true, statusMapping: { 'Done': 'completed' } } },
      taskPlan: { tasks: [{ id: 'UPD-1', jiraKey: 'UPD-1', title: 'Old Title', description: 'Old desc', priority: 'P2', status: 'in_progress' }] },
    };
    const payload = {
      webhookEvent: 'jira:issue_updated',
      issue: {
        key: 'UPD-1',
        fields: { summary: 'New Title', description: 'New desc', priority: { name: 'High' } },
      },
      changelog: {
        items: [
          { field: 'summary', fromString: 'Old Title', toString: 'New Title' },
          { field: 'description', fromString: 'Old desc', toString: 'New desc' },
        ],
      },
    };
    const result = handleWebhook(board, payload, 'http://localhost/api/webhooks/jira');
    if (result.action !== 'fields_updated') throw new Error(`action: ${result.action}`);
    if (result.changes.length !== 2) throw new Error(`changes: ${result.changes.length}`);
    if (result.updatedFields.title !== 'New Title') throw new Error(`title: ${result.updatedFields.title}`);
    ok('handleWebhook: fields_updated action');
  } catch (e) { fail('handleWebhook: fields_updated', e.message); }

  // --- handleWebhook: dedup via change hash ---
  try {
    const board = {
      integrations: { jira: { enabled: true } },
      taskPlan: { tasks: [{ id: 'DUP-1', jiraKey: 'DUP-1', title: 'Title', status: 'in_progress', _lastChangeHash: null }] },
    };
    const payload = {
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'DUP-1', fields: { summary: 'New' } },
      changelog: { items: [{ field: 'summary', fromString: 'Title', toString: 'New' }] },
    };
    const r1 = handleWebhook(board, payload, 'http://localhost/api/webhooks/jira');
    if (r1.action !== 'fields_updated') throw new Error(`first call: ${r1.action}`);
    // Simulate applying the hash
    board.taskPlan.tasks[0]._lastChangeHash = r1.changeHash;
    const r2 = handleWebhook(board, payload, 'http://localhost/api/webhooks/jira');
    if (r2.action !== 'skipped') throw new Error(`second call: ${r2.action}`);
    ok('handleWebhook: dedup via change hash');
  } catch (e) { fail('handleWebhook: dedup via change hash', e.message); }

  // --- handleWebhook: ignores non-substantive fields ---
  try {
    const board = {
      integrations: { jira: { enabled: true } },
      taskPlan: { tasks: [{ id: 'IGN-1', jiraKey: 'IGN-1', title: 'Title', status: 'pending' }] },
    };
    const payload = {
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'IGN-1' },
      changelog: { items: [
        { field: 'Rank', fromString: '1', toString: '2' },
        { field: 'Sprint', fromString: 'Sprint 1', toString: 'Sprint 2' },
      ]},
    };
    const result = handleWebhook(board, payload, 'http://localhost/api/webhooks/jira');
    if (result.action !== 'skipped') throw new Error(`action: ${result.action}`);
    ok('handleWebhook: ignores non-substantive fields');
  } catch (e) { fail('handleWebhook: ignores non-substantive', e.message); }

  // --- verifyHmacSignature ---
  try {
    const secret = 'test-secret';
    const body = '{"webhookEvent":"comment_created"}';
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (!verifyHmacSignature(body, sig, secret)) throw new Error('valid HMAC should pass');
    if (verifyHmacSignature(body, 'sha256=wrong', secret)) throw new Error('invalid HMAC should fail');
    if (verifyHmacSignature(body, undefined, secret)) throw new Error('missing header should fail');
    if (!verifyHmacSignature(body, undefined, null)) throw new Error('no secret should pass');
    ok('verifyHmacSignature: all cases');
  } catch (e) { fail('verifyHmacSignature', e.message); }

  // --- parseMentionCommand ---
  try {
    const r1 = parseMentionCommand('@karvi fix this bug');
    if (!r1.mentioned || r1.command !== 'fix' || r1.args !== 'this bug') throw new Error('fix command failed');
    const r2 = parseMentionCommand('@karvi implement');
    if (!r2.mentioned || r2.command !== 'implement' || r2.args !== '') throw new Error('implement command failed');
    const r3 = parseMentionCommand('@karvi status');
    if (!r3.mentioned || r3.command !== 'status') throw new Error('status command failed');
    const r4 = parseMentionCommand('@karvi');
    if (!r4.mentioned || r4.command !== 'implement') throw new Error('bare @karvi should default to implement');
    const r5 = parseMentionCommand('no mention here');
    if (r5.mentioned) throw new Error('no mention should return false');
    const r6 = parseMentionCommand('@karvi do something custom');
    if (!r6.mentioned || r6.command !== 'implement' || r6.args !== 'do something custom') throw new Error('unknown command should be implement with args');
    ok('parseMentionCommand: all cases');
  } catch (e) { fail('parseMentionCommand', e.message); }

  // --- handleMentionWebhook: comment_created with @karvi → create_task ---
  try {
    process.env.JIRA_HOST = 'test.atlassian.net';
    const board = {
      integrations: { jira: { enabled: true } },
      taskPlan: { tasks: [] },
    };
    const payload = {
      webhookEvent: 'comment_created',
      comment: { body: '@karvi fix the login bug' },
      issue: {
        key: 'MENTION-1',
        fields: { summary: 'Login issue', priority: { name: 'High' } },
      },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    if (result.action !== 'create_task') throw new Error(`action: ${result.action}`);
    if (result.task.id !== 'MENTION-1') throw new Error(`task.id: ${result.task.id}`);
    if (result.task.status !== 'dispatched') throw new Error(`task.status should be dispatched: ${result.task.status}`);
    if (result.command !== 'fix') throw new Error(`command: ${result.command}`);
    if (result.task.sourceType !== 'jira_mention') throw new Error(`sourceType: ${result.task.sourceType}`);
    ok('handleMentionWebhook: @karvi fix → create_task');
    delete process.env.JIRA_HOST;
  } catch (e) { fail('handleMentionWebhook: @karvi fix', e.message); delete process.env.JIRA_HOST; }

  // --- handleMentionWebhook: no mention → skipped ---
  try {
    const board = { integrations: { jira: { enabled: true } }, taskPlan: { tasks: [] } };
    const payload = {
      webhookEvent: 'comment_created',
      comment: { body: 'just a regular comment' },
      issue: { key: 'MENTION-2', fields: { summary: 'Test' } },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    if (result.action !== 'skipped') throw new Error(`action: ${result.action}`);
    if (!result.error.includes('No @karvi mention')) throw new Error(`error: ${result.error}`);
    ok('handleMentionWebhook: no mention → skipped');
  } catch (e) { fail('handleMentionWebhook: no mention', e.message); }

  // --- handleMentionWebhook: @karvi status → status_reply ---
  try {
    const existing = { id: 'MENTION-3', jiraKey: 'MENTION-3', status: 'in_progress' };
    const board = { integrations: { jira: { enabled: true } }, taskPlan: { tasks: [existing] } };
    const payload = {
      webhookEvent: 'comment_created',
      comment: { body: '@karvi status' },
      issue: { key: 'MENTION-3', fields: { summary: 'Test' } },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    if (result.action !== 'status_reply') throw new Error(`action: ${result.action}`);
    if (result.existingTask.id !== 'MENTION-3') throw new Error(`existingTask.id: ${result.existingTask?.id}`);
    ok('handleMentionWebhook: @karvi status → status_reply');
  } catch (e) { fail('handleMentionWebhook: @karvi status', e.message); }

  // --- handleMentionWebhook: duplicate → already_exists ---
  try {
    const existing = { id: 'MENTION-4', jiraKey: 'MENTION-4', status: 'in_progress' };
    const board = { integrations: { jira: { enabled: true } }, taskPlan: { tasks: [existing] } };
    const payload = {
      webhookEvent: 'comment_created',
      comment: { body: '@karvi fix this' },
      issue: { key: 'MENTION-4', fields: { summary: 'Test' } },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    if (result.action !== 'already_exists') throw new Error(`action: ${result.action}`);
    if (result.existingTask.id !== 'MENTION-4') throw new Error(`existingTask.id: ${result.existingTask?.id}`);
    ok('handleMentionWebhook: duplicate → already_exists');
  } catch (e) { fail('handleMentionWebhook: duplicate', e.message); }

  // --- handleMentionWebhook: disabled → skipped ---
  try {
    const board = { integrations: { jira: { enabled: false } }, taskPlan: { tasks: [] } };
    const payload = {
      webhookEvent: 'comment_created',
      comment: { body: '@karvi fix' },
      issue: { key: 'MENTION-5', fields: {} },
    };
    const result = handleMentionWebhook(board, payload, { enabled: false });
    if (result.action !== 'skipped') throw new Error(`action: ${result.action}`);
    ok('handleMentionWebhook: disabled → skipped');
  } catch (e) { fail('handleMentionWebhook: disabled', e.message); }

  // --- handleMentionWebhook: non-comment event → skipped ---
  try {
    const board = { integrations: { jira: { enabled: true } }, taskPlan: { tasks: [] } };
    const payload = {
      webhookEvent: 'jira:issue_created',
      comment: { body: '@karvi fix' },
      issue: { key: 'MENTION-6', fields: {} },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    if (result.action !== 'skipped') throw new Error(`action: ${result.action}`);
    if (!result.error.includes('Not a comment_created')) throw new Error(`error: ${result.error}`);
    ok('handleMentionWebhook: non-comment event → skipped');
  } catch (e) { fail('handleMentionWebhook: non-comment event', e.message); }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
