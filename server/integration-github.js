/**
 * integration-github.js — GitHub webhook integration for Karvi Task Engine
 *
 * Inbound: GitHub issues webhook → task creation + auto-dispatch
 *
 * Zero external dependencies — uses node:crypto only.
 * Webhook secret lives in vault, never in board.json.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getConfig(board) {
  return board.integrations?.github || null;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature verification
// ---------------------------------------------------------------------------

/**
 * verifySignature(rawBody, signatureHeader, secret)
 *
 * Verifies GitHub webhook HMAC-SHA256 signature.
 * @param {string} rawBody — raw request body string
 * @param {string|undefined} signatureHeader — X-Hub-Signature-256 header value
 * @param {string|null} secret — webhook secret (null = skip verification)
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) return true; // no secret configured — skip verification
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
// Dedup
// ---------------------------------------------------------------------------

function isDuplicate(board, issueNumber, repo) {
  return (board.taskPlan?.tasks || []).some(t =>
    t.source?.type === 'github_issue' &&
    t.source?.number === issueNumber &&
    t.source?.repo === repo
  );
}

// ---------------------------------------------------------------------------
// Label → Priority mapping
// ---------------------------------------------------------------------------

const DEFAULT_LABEL_PRIORITY_MAP = {
  'critical': 'P0',
  'bug': 'P1',
  'enhancement': 'P2',
  'documentation': 'P3',
};

function mapLabelToPriority(labels, config) {
  const map = { ...DEFAULT_LABEL_PRIORITY_MAP, ...(config?.labelPriorityMap || {}) };
  for (const label of labels || []) {
    const name = (label.name || label || '').toString().toLowerCase();
    const p = map[name];
    if (p) return p;
  }
  return 'P2';
}

// ---------------------------------------------------------------------------
// Build Karvi task from GitHub issue
// ---------------------------------------------------------------------------

function buildTaskFromIssue(payload, config) {
  const issue = payload.issue || {};
  const repo = payload.repository?.full_name || '';
  const number = issue.number;

  let description = issue.body || '';
  const MAX_DESC = 2000;
  if (description.length > MAX_DESC) {
    description = description.slice(0, MAX_DESC) + '... (truncated)';
  }

  const priority = mapLabelToPriority(issue.labels, config);
  const assignee = config?.assignee || 'engineer_lite';

  return {
    id: `GH-${number}`,
    title: issue.title || `GitHub Issue #${number}`,
    description,
    status: 'dispatched',
    source: {
      type: 'github_issue',
      number,
      repo,
      url: issue.html_url || '',
      author: issue.user?.login || '',
    },
    githubIssue: { number, repo },
    priority,
    assignee,
    depends: [],
    history: [{ ts: new Date().toISOString(), status: 'created', by: 'github-webhook' }],
  };
}

// ---------------------------------------------------------------------------
// @karvi mention command parser
// ---------------------------------------------------------------------------

const MENTION_RE = /@karvi\b\s*(.*)/i;
const SUPPORTED_COMMANDS = ['fix', 'implement', 'status'];

/**
 * parseMentionCommand(commentBody)
 *
 * Extract command from @karvi mention in a comment body.
 * @param {string} commentBody — raw comment text
 * @returns {{ mentioned: boolean, command: string, args: string } | { mentioned: false }}
 */
function parseMentionCommand(commentBody) {
  const match = (commentBody || '').match(MENTION_RE);
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

  // Unknown command → treat as implement with full text as args
  return { mentioned: true, command: 'implement', args: raw };
}

// ---------------------------------------------------------------------------
// Handle issue_comment mention webhook
// ---------------------------------------------------------------------------

/**
 * handleMentionWebhook(board, payload, config)
 *
 * Processes issue_comment events looking for @karvi mentions.
 * Returns action to take: create_task, status_reply, or skipped.
 *
 * @param {object} board — current board state
 * @param {object} payload — parsed GitHub webhook JSON body (issue_comment event)
 * @param {object|null} config — board.integrations.github
 * @returns {{ action: string, task?: object, issueNumber?: number, repo?: string, existingTask?: object, error?: string }}
 */
function handleMentionWebhook(board, payload, config) {
  if (!config?.enabled) {
    return { action: 'skipped', error: 'GitHub integration disabled' };
  }

  // Only handle comment creation
  if (payload.action !== 'created') {
    return { action: 'skipped', error: `Not a comment.created event (action: ${payload.action})` };
  }

  const comment = payload.comment;
  if (!comment?.body) {
    return { action: 'skipped', error: 'No comment body in payload' };
  }

  const parsed = parseMentionCommand(comment.body);
  if (!parsed.mentioned) {
    return { action: 'skipped', error: 'No @karvi mention in comment' };
  }

  const issue = payload.issue;
  if (!issue?.number) {
    return { action: 'skipped', error: 'No issue number in payload' };
  }

  const repo = payload.repository?.full_name || '';

  // Check targetRepos filter
  if (Array.isArray(config.targetRepos) && config.targetRepos.length > 0) {
    if (!config.targetRepos.includes(repo)) {
      return { action: 'skipped', error: `Repo "${repo}" not in targetRepos` };
    }
  }

  const issueNumber = issue.number;

  // Status command → return existing task info
  if (parsed.command === 'status') {
    const existing = (board.taskPlan?.tasks || []).find(t =>
      t.source?.type === 'github_issue' &&
      t.source?.number === issueNumber &&
      t.source?.repo === repo
    );
    if (existing) {
      return { action: 'status_reply', existingTask: existing, issueNumber, repo };
    }
    return { action: 'status_reply', existingTask: null, issueNumber, repo };
  }

  // fix / implement → create task (or report existing)
  if (isDuplicate(board, issueNumber, repo)) {
    const existing = (board.taskPlan?.tasks || []).find(t =>
      t.source?.type === 'github_issue' &&
      t.source?.number === issueNumber &&
      t.source?.repo === repo
    );
    return { action: 'already_exists', existingTask: existing, issueNumber, repo };
  }

  // Build task from the issue context — reuse buildTaskFromIssue
  const task = buildTaskFromIssue(payload, config);
  return { action: 'create_task', task, issueNumber, repo, command: parsed.command };
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

/**
 * handleWebhook(board, payload, config)
 *
 * @param {object} board — current board state
 * @param {object} payload — parsed GitHub webhook JSON body
 * @param {object|null} config — board.integrations.github
 * @returns {{ action: string, task?: object, issueNumber?: number, error?: string }}
 */
function handleWebhook(board, payload, config) {
  if (!config?.enabled) {
    return { action: 'skipped', error: 'GitHub integration disabled' };
  }

  // Only handle issues.opened
  if (payload.action !== 'opened') {
    return { action: 'skipped', error: `Not an issues.opened event (action: ${payload.action})` };
  }

  const issue = payload.issue;
  if (!issue?.number) {
    return { action: 'skipped', error: 'No issue number in payload' };
  }

  const repo = payload.repository?.full_name || '';

  // Check targetRepos filter
  if (Array.isArray(config.targetRepos) && config.targetRepos.length > 0) {
    if (!config.targetRepos.includes(repo)) {
      return { action: 'skipped', error: `Repo "${repo}" not in targetRepos` };
    }
  }

  // Check ignoreLabels filter
  if (Array.isArray(config.ignoreLabels) && config.ignoreLabels.length > 0) {
    const issueLabels = (issue.labels || []).map(l => (l.name || l || '').toString().toLowerCase());
    const ignored = config.ignoreLabels.map(l => l.toLowerCase());
    const match = issueLabels.find(l => ignored.includes(l));
    if (match) {
      return { action: 'skipped', error: `Label "${match}" is in ignoreLabels` };
    }
  }

  // Dedup
  if (isDuplicate(board, issue.number, repo)) {
    return { action: 'skipped', error: `Duplicate: GH-${issue.number} already exists for ${repo}` };
  }

  const task = buildTaskFromIssue(payload, config);
  return { action: 'create_task', task, issueNumber: issue.number };
}

// ---------------------------------------------------------------------------
// PR outcome webhook handler
// ---------------------------------------------------------------------------

/**
 * handlePRWebhook(board, payload, config)
 *
 * Processes GitHub pull_request webhook events to capture PR outcomes.
 * Only handles 'closed' action (merged or not merged).
 *
 * @param {object} board   — current board state
 * @param {object} payload — parsed GitHub webhook JSON body
 * @param {object|null} config — board.integrations.github
 * @returns {{ action: string, taskId?: string, outcome?: string, mergedBy?: string, closedBy?: string, mergeCommitSha?: string, prNumber?: number, error?: string }}
 */
function handlePRWebhook(board, payload, config) {
  if (!config?.enabled) {
    return { action: 'skipped', error: 'GitHub integration disabled' };
  }

  // Only handle pull_request.closed (merged or closed-without-merge)
  if (payload.action !== 'closed') {
    return { action: 'skipped', error: `Not a pull_request.closed event (action: ${payload.action})` };
  }

  const pr = payload.pull_request;
  if (!pr?.number) {
    return { action: 'skipped', error: 'No pull_request number in payload' };
  }

  const prNumber = pr.number;
  const prRepo = payload.repository?.full_name || '';
  const merged = pr.merged === true;
  const outcome = merged ? 'merged' : 'closed';
  const mergedBy = merged ? (pr.merged_by?.login || null) : null;
  const closedBy = !merged ? (pr.user?.login || null) : null;
  const mergeCommitSha = merged ? (pr.merge_commit_sha || null) : null;

  // Find matching task by task.pr.number and task.pr.repo
  const task = (board.taskPlan?.tasks || []).find(t =>
    t.pr?.number === prNumber && t.pr?.repo === prRepo
  );

  if (!task) {
    return { action: 'skipped', error: `No task found with PR #${prNumber} in ${prRepo}` };
  }

  return {
    action: 'pr_outcome',
    taskId: task.id,
    prNumber,
    outcome,
    mergedBy,
    closedBy,
    mergeCommitSha,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getConfig,
  verifySignature,
  handleWebhook,
  handlePRWebhook,
  handleMentionWebhook,
  parseMentionCommand,
  buildTaskFromIssue,
  isDuplicate,
  mapLabelToPriority,
};

// ---------------------------------------------------------------------------
// Self-tests (run via: node server/integration-github.js)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const assert = require('assert');
  let passed = 0;
  let failed = 0;
  function ok(name) { passed++; console.log(`  OK: ${name}`); }
  function fail(name, err) { failed++; console.log(`  FAIL: ${name}: ${err}`); }

  console.log('integration-github.js self-tests\n');

  // --- verifySignature ---
  try {
    const secret = 'test-secret';
    const body = '{"action":"opened"}';
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.strictEqual(verifySignature(body, sig, secret), true);
    ok('verifySignature: valid HMAC passes');
  } catch (e) { fail('verifySignature: valid', e.message); }

  try {
    assert.strictEqual(verifySignature('body', 'sha256=wrong', 'secret'), false);
    ok('verifySignature: invalid HMAC fails');
  } catch (e) { fail('verifySignature: invalid', e.message); }

  try {
    assert.strictEqual(verifySignature('body', undefined, 'secret'), false);
    ok('verifySignature: missing header fails');
  } catch (e) { fail('verifySignature: missing header', e.message); }

  try {
    assert.strictEqual(verifySignature('body', undefined, null), true);
    ok('verifySignature: no secret → passes');
  } catch (e) { fail('verifySignature: no secret', e.message); }

  // --- handleWebhook: issues.opened → create_task ---
  try {
    const board = { taskPlan: { tasks: [] } };
    const payload = {
      action: 'opened',
      issue: {
        number: 42,
        title: 'Fix login bug',
        body: 'Login redirect fails',
        html_url: 'https://github.com/owner/repo/issues/42',
        user: { login: 'alice' },
        labels: [{ name: 'bug' }],
      },
      repository: { full_name: 'owner/repo' },
    };
    const config = { enabled: true };
    const result = handleWebhook(board, payload, config);
    assert.strictEqual(result.action, 'create_task');
    assert.strictEqual(result.task.id, 'GH-42');
    assert.strictEqual(result.task.title, 'Fix login bug');
    assert.strictEqual(result.task.status, 'dispatched');
    assert.strictEqual(result.task.source.type, 'github_issue');
    assert.strictEqual(result.task.source.number, 42);
    assert.strictEqual(result.task.source.repo, 'owner/repo');
    assert.strictEqual(result.task.priority, 'P1'); // bug → P1
    ok('handleWebhook: issues.opened → create_task');
  } catch (e) { fail('handleWebhook: issues.opened', e.message); }

  // --- handleWebhook: issues.closed → skipped ---
  try {
    const result = handleWebhook({ taskPlan: { tasks: [] } }, { action: 'closed', issue: { number: 1 } }, { enabled: true });
    assert.strictEqual(result.action, 'skipped');
    ok('handleWebhook: issues.closed → skipped');
  } catch (e) { fail('handleWebhook: issues.closed', e.message); }

  // --- handleWebhook: duplicate → skipped ---
  try {
    const board = { taskPlan: { tasks: [{ id: 'GH-42', source: { type: 'github_issue', number: 42, repo: 'owner/repo' } }] } };
    const payload = { action: 'opened', issue: { number: 42, title: 'Dup', labels: [] }, repository: { full_name: 'owner/repo' } };
    const result = handleWebhook(board, payload, { enabled: true });
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('Duplicate'));
    ok('handleWebhook: duplicate → skipped');
  } catch (e) { fail('handleWebhook: duplicate', e.message); }

  // --- handleWebhook: disabled → skipped ---
  try {
    const result = handleWebhook({}, { action: 'opened' }, { enabled: false });
    assert.strictEqual(result.action, 'skipped');
    ok('handleWebhook: disabled → skipped');
  } catch (e) { fail('handleWebhook: disabled', e.message); }

  // --- handleWebhook: ignoreLabels → skipped ---
  try {
    const payload = { action: 'opened', issue: { number: 5, title: 'Q', labels: [{ name: 'wontfix' }] }, repository: { full_name: 'o/r' } };
    const result = handleWebhook({ taskPlan: { tasks: [] } }, payload, { enabled: true, ignoreLabels: ['wontfix'] });
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('ignoreLabels'));
    ok('handleWebhook: ignoreLabels → skipped');
  } catch (e) { fail('handleWebhook: ignoreLabels', e.message); }

  // --- handleWebhook: targetRepos → skipped ---
  try {
    const payload = { action: 'opened', issue: { number: 6, title: 'X', labels: [] }, repository: { full_name: 'other/repo' } };
    const result = handleWebhook({ taskPlan: { tasks: [] } }, payload, { enabled: true, targetRepos: ['owner/repo'] });
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('not in targetRepos'));
    ok('handleWebhook: targetRepos → skipped');
  } catch (e) { fail('handleWebhook: targetRepos', e.message); }

  // --- mapLabelToPriority ---
  try {
    assert.strictEqual(mapLabelToPriority([{ name: 'bug' }], {}), 'P1');
    assert.strictEqual(mapLabelToPriority([{ name: 'enhancement' }], {}), 'P2');
    assert.strictEqual(mapLabelToPriority([{ name: 'unknown-label' }], {}), 'P2');
    assert.strictEqual(mapLabelToPriority([{ name: 'critical' }], {}), 'P0');
    assert.strictEqual(mapLabelToPriority([{ name: 'Bug' }], {}), 'P1'); // case insensitive
    assert.strictEqual(mapLabelToPriority([{ name: 'custom' }], { labelPriorityMap: { custom: 'P0' } }), 'P0');
    ok('mapLabelToPriority: all cases');
  } catch (e) { fail('mapLabelToPriority', e.message); }

  // --- buildTaskFromIssue: description truncation ---
  try {
    const longBody = 'x'.repeat(3000);
    const payload = { issue: { number: 99, title: 'Long', body: longBody, labels: [], user: {} }, repository: { full_name: 'a/b' } };
    const task = buildTaskFromIssue(payload, {});
    assert.ok(task.description.length <= 2020); // 2000 + "... (truncated)"
    assert.ok(task.description.endsWith('(truncated)'));
    ok('buildTaskFromIssue: description truncation');
  } catch (e) { fail('buildTaskFromIssue: truncation', e.message); }

  // --- handlePRWebhook: PR merged → pr_outcome with merged ---
  try {
    const board = { taskPlan: { tasks: [
      { id: 'GH-10', pr: { owner: 'owner', repo: 'owner/repo', number: 99, url: 'https://github.com/owner/repo/pull/99', outcome: null } },
    ] } };
    const payload = {
      action: 'closed',
      pull_request: { number: 99, merged: true, merged_by: { login: 'alice' }, merge_commit_sha: 'abc123', user: { login: 'bob' } },
      repository: { full_name: 'owner/repo' },
    };
    const result = handlePRWebhook(board, payload, { enabled: true });
    assert.strictEqual(result.action, 'pr_outcome');
    assert.strictEqual(result.taskId, 'GH-10');
    assert.strictEqual(result.outcome, 'merged');
    assert.strictEqual(result.mergedBy, 'alice');
    assert.strictEqual(result.mergeCommitSha, 'abc123');
    assert.strictEqual(result.closedBy, null);
    ok('handlePRWebhook: PR merged → pr_outcome');
  } catch (e) { fail('handlePRWebhook: PR merged', e.message); }

  // --- handlePRWebhook: PR closed without merge → pr_outcome with closed ---
  try {
    const board = { taskPlan: { tasks: [
      { id: 'GH-11', pr: { owner: 'owner', repo: 'owner/repo', number: 50, url: 'https://github.com/owner/repo/pull/50', outcome: null } },
    ] } };
    const payload = {
      action: 'closed',
      pull_request: { number: 50, merged: false, user: { login: 'carol' } },
      repository: { full_name: 'owner/repo' },
    };
    const result = handlePRWebhook(board, payload, { enabled: true });
    assert.strictEqual(result.action, 'pr_outcome');
    assert.strictEqual(result.taskId, 'GH-11');
    assert.strictEqual(result.outcome, 'closed');
    assert.strictEqual(result.mergedBy, null);
    assert.strictEqual(result.closedBy, 'carol');
    ok('handlePRWebhook: PR closed without merge → pr_outcome');
  } catch (e) { fail('handlePRWebhook: PR closed', e.message); }

  // --- handlePRWebhook: no matching task → skipped ---
  try {
    const board = { taskPlan: { tasks: [
      { id: 'GH-12', pr: { owner: 'owner', repo: 'owner/repo', number: 77, url: 'https://github.com/owner/repo/pull/77', outcome: null } },
    ] } };
    const payload = {
      action: 'closed',
      pull_request: { number: 999, merged: true, merged_by: { login: 'x' } },
      repository: { full_name: 'owner/repo' },
    };
    const result = handlePRWebhook(board, payload, { enabled: true });
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('No task found'));
    ok('handlePRWebhook: no matching task → skipped');
  } catch (e) { fail('handlePRWebhook: no matching task', e.message); }

  // --- handlePRWebhook: disabled → skipped ---
  try {
    const result = handlePRWebhook({}, { action: 'closed', pull_request: { number: 1 } }, { enabled: false });
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('disabled'));
    ok('handlePRWebhook: disabled → skipped');
  } catch (e) { fail('handlePRWebhook: disabled', e.message); }

  // --- handlePRWebhook: non-closed action → skipped ---
  try {
    const result = handlePRWebhook({}, { action: 'opened', pull_request: { number: 1 } }, { enabled: true });
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('Not a pull_request.closed'));
    ok('handlePRWebhook: non-closed action → skipped');
  } catch (e) { fail('handlePRWebhook: non-closed action', e.message); }

  // --- parseMentionCommand ---
  try {
    const r1 = parseMentionCommand('@karvi fix this bug');
    assert.strictEqual(r1.mentioned, true);
    assert.strictEqual(r1.command, 'fix');
    assert.strictEqual(r1.args, 'this bug');
    ok('parseMentionCommand: @karvi fix this bug');
  } catch (e) { fail('parseMentionCommand: fix', e.message); }

  try {
    const r2 = parseMentionCommand('@karvi implement');
    assert.strictEqual(r2.mentioned, true);
    assert.strictEqual(r2.command, 'implement');
    assert.strictEqual(r2.args, '');
    ok('parseMentionCommand: @karvi implement');
  } catch (e) { fail('parseMentionCommand: implement', e.message); }

  try {
    const r3 = parseMentionCommand('@karvi status');
    assert.strictEqual(r3.mentioned, true);
    assert.strictEqual(r3.command, 'status');
    ok('parseMentionCommand: @karvi status');
  } catch (e) { fail('parseMentionCommand: status', e.message); }

  try {
    const r4 = parseMentionCommand('@karvi');
    assert.strictEqual(r4.mentioned, true);
    assert.strictEqual(r4.command, 'implement');
    ok('parseMentionCommand: bare @karvi → implement');
  } catch (e) { fail('parseMentionCommand: bare', e.message); }

  try {
    const r5 = parseMentionCommand('no mention here');
    assert.strictEqual(r5.mentioned, false);
    ok('parseMentionCommand: no mention → mentioned=false');
  } catch (e) { fail('parseMentionCommand: no mention', e.message); }

  try {
    const r6 = parseMentionCommand('@karvi do something custom');
    assert.strictEqual(r6.mentioned, true);
    assert.strictEqual(r6.command, 'implement');
    assert.strictEqual(r6.args, 'do something custom');
    ok('parseMentionCommand: unknown command → implement with args');
  } catch (e) { fail('parseMentionCommand: unknown', e.message); }

  // --- handleMentionWebhook ---
  try {
    const board = { taskPlan: { tasks: [] } };
    const payload = {
      action: 'created',
      comment: { body: '@karvi fix this' },
      issue: { number: 55, title: 'Bug report', body: 'Something broke', labels: [{ name: 'bug' }], html_url: 'https://github.com/owner/repo/issues/55', user: { login: 'bob' } },
      repository: { full_name: 'owner/repo' },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    assert.strictEqual(result.action, 'create_task');
    assert.strictEqual(result.task.id, 'GH-55');
    assert.strictEqual(result.command, 'fix');
    ok('handleMentionWebhook: @karvi fix → create_task');
  } catch (e) { fail('handleMentionWebhook: fix', e.message); }

  try {
    const existing = { id: 'GH-55', status: 'in_progress', source: { type: 'github_issue', number: 55, repo: 'owner/repo' } };
    const board = { taskPlan: { tasks: [existing] } };
    const payload = {
      action: 'created',
      comment: { body: '@karvi fix' },
      issue: { number: 55, title: 'Bug', body: '', labels: [], user: {} },
      repository: { full_name: 'owner/repo' },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    assert.strictEqual(result.action, 'already_exists');
    assert.strictEqual(result.existingTask.id, 'GH-55');
    ok('handleMentionWebhook: duplicate → already_exists');
  } catch (e) { fail('handleMentionWebhook: duplicate', e.message); }

  try {
    const existing = { id: 'GH-60', status: 'completed', source: { type: 'github_issue', number: 60, repo: 'owner/repo' } };
    const board = { taskPlan: { tasks: [existing] } };
    const payload = {
      action: 'created',
      comment: { body: '@karvi status' },
      issue: { number: 60, title: 'Done', body: '', labels: [], user: {} },
      repository: { full_name: 'owner/repo' },
    };
    const result = handleMentionWebhook(board, payload, { enabled: true });
    assert.strictEqual(result.action, 'status_reply');
    assert.strictEqual(result.existingTask.id, 'GH-60');
    ok('handleMentionWebhook: @karvi status → status_reply');
  } catch (e) { fail('handleMentionWebhook: status', e.message); }

  try {
    const result = handleMentionWebhook({}, {
      action: 'created',
      comment: { body: 'just a comment' },
      issue: { number: 1 },
      repository: { full_name: 'o/r' },
    }, { enabled: true });
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('No @karvi mention'));
    ok('handleMentionWebhook: no mention → skipped');
  } catch (e) { fail('handleMentionWebhook: no mention', e.message); }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
