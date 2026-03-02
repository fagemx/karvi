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

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
