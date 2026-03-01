#!/usr/bin/env node
/**
 * test-github-webhook.js — Integration tests for GitHub webhook (issue #110)
 *
 * Tests: HMAC verification, issue→task creation, dedup, filters, priority mapping.
 *
 * Usage: node server/test-github-webhook.js
 */
const assert = require('assert');
const crypto = require('crypto');
const gh = require('./integration-github');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  \u2705 ${label}`); }
function fail(label, reason) { failed++; console.log(`  \u274c ${label}: ${reason}`); process.exitCode = 1; }

async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { fail(label, err.message); }
}

function makePayload(overrides = {}) {
  return {
    action: 'opened',
    issue: {
      number: 42,
      title: 'Fix login redirect bug',
      body: 'When clicking login, the redirect goes to the wrong page.',
      html_url: 'https://github.com/owner/repo/issues/42',
      user: { login: 'alice' },
      labels: [{ name: 'bug' }],
      ...(overrides.issue || {}),
    },
    repository: { full_name: 'owner/repo', ...(overrides.repository || {}) },
    ...(overrides.top || {}),
  };
}

function makeBoard(tasks = []) {
  return { taskPlan: { tasks }, integrations: {} };
}

function makeConfig(overrides = {}) {
  return { enabled: true, ...overrides };
}

(async () => {
  console.log('\n=== GitHub Webhook Integration Tests (issue #110) ===\n');

  // --- HMAC Signature Verification ---

  await test('verifySignature: valid HMAC passes', async () => {
    const secret = 'webhook-secret-123';
    const body = '{"action":"opened","issue":{"number":1}}';
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.strictEqual(gh.verifySignature(body, sig, secret), true);
  });

  await test('verifySignature: invalid HMAC fails', async () => {
    assert.strictEqual(gh.verifySignature('body', 'sha256=deadbeef00112233', 'secret'), false);
  });

  await test('verifySignature: missing header fails', async () => {
    assert.strictEqual(gh.verifySignature('body', undefined, 'secret'), false);
    assert.strictEqual(gh.verifySignature('body', '', 'secret'), false);
  });

  await test('verifySignature: no secret configured → passes (skip mode)', async () => {
    assert.strictEqual(gh.verifySignature('body', undefined, null), true);
    assert.strictEqual(gh.verifySignature('body', undefined, ''), true);
  });

  // --- handleWebhook: Core Flow ---

  await test('handleWebhook: issues.opened → create_task with correct shape', async () => {
    const board = makeBoard();
    const payload = makePayload();
    const config = makeConfig();
    const result = gh.handleWebhook(board, payload, config);

    assert.strictEqual(result.action, 'create_task');
    assert.strictEqual(result.issueNumber, 42);

    const task = result.task;
    assert.strictEqual(task.id, 'GH-42');
    assert.strictEqual(task.title, 'Fix login redirect bug');
    assert.strictEqual(task.description, 'When clicking login, the redirect goes to the wrong page.');
    assert.strictEqual(task.status, 'dispatched');
    assert.strictEqual(task.priority, 'P1'); // bug label → P1
    assert.strictEqual(task.assignee, 'engineer_lite');

    // Source fields
    assert.strictEqual(task.source.type, 'github_issue');
    assert.strictEqual(task.source.number, 42);
    assert.strictEqual(task.source.repo, 'owner/repo');
    assert.strictEqual(task.source.url, 'https://github.com/owner/repo/issues/42');
    assert.strictEqual(task.source.author, 'alice');

    // githubIssue shorthand
    assert.strictEqual(task.githubIssue.number, 42);
    assert.strictEqual(task.githubIssue.repo, 'owner/repo');

    // History
    assert.strictEqual(task.history.length, 1);
    assert.strictEqual(task.history[0].status, 'created');
    assert.strictEqual(task.history[0].by, 'github-webhook');
  });

  await test('handleWebhook: issues.closed → skipped', async () => {
    const payload = makePayload({ top: { action: 'closed' } });
    const result = gh.handleWebhook(makeBoard(), payload, makeConfig());
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('closed'));
  });

  // --- Dedup ---

  await test('handleWebhook: duplicate issue number+repo → skipped', async () => {
    const existing = { id: 'GH-42', source: { type: 'github_issue', number: 42, repo: 'owner/repo' } };
    const board = makeBoard([existing]);
    const result = gh.handleWebhook(board, makePayload(), makeConfig());
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('Duplicate'));
  });

  await test('handleWebhook: same number different repo → NOT duplicate', async () => {
    const existing = { id: 'GH-42', source: { type: 'github_issue', number: 42, repo: 'other/repo' } };
    const board = makeBoard([existing]);
    const result = gh.handleWebhook(board, makePayload(), makeConfig());
    assert.strictEqual(result.action, 'create_task');
  });

  // --- Filters ---

  await test('handleWebhook: enabled=false → skipped', async () => {
    const result = gh.handleWebhook(makeBoard(), makePayload(), makeConfig({ enabled: false }));
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('disabled'));
  });

  await test('handleWebhook: ignoreLabels match → skipped', async () => {
    const payload = makePayload({ issue: { labels: [{ name: 'wontfix' }] } });
    const config = makeConfig({ ignoreLabels: ['wontfix', 'question'] });
    const result = gh.handleWebhook(makeBoard(), payload, config);
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('ignoreLabels'));
  });

  await test('handleWebhook: targetRepos filter → skipped if repo not in list', async () => {
    const payload = makePayload({ repository: { full_name: 'other/repo' } });
    const config = makeConfig({ targetRepos: ['owner/repo'] });
    const result = gh.handleWebhook(makeBoard(), payload, config);
    assert.strictEqual(result.action, 'skipped');
    assert.ok(result.error.includes('not in targetRepos'));
  });

  await test('handleWebhook: empty targetRepos → accepts all repos', async () => {
    const payload = makePayload({ repository: { full_name: 'any/repo' } });
    const config = makeConfig({ targetRepos: [] });
    const result = gh.handleWebhook(makeBoard(), payload, config);
    assert.strictEqual(result.action, 'create_task');
  });

  // --- Label → Priority Mapping ---

  await test('mapLabelToPriority: label mapping works correctly', async () => {
    // Default mappings
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'critical' }], {}), 'P0');
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'bug' }], {}), 'P1');
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'enhancement' }], {}), 'P2');
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'documentation' }], {}), 'P3');

    // Case insensitive
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'Bug' }], {}), 'P1');
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'CRITICAL' }], {}), 'P0');

    // Unknown → P2 default
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'random-label' }], {}), 'P2');
    assert.strictEqual(gh.mapLabelToPriority([], {}), 'P2');

    // Custom map override
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'hotfix' }], { labelPriorityMap: { hotfix: 'P0' } }), 'P0');

    // First matching label wins
    assert.strictEqual(gh.mapLabelToPriority([{ name: 'enhancement' }, { name: 'bug' }], {}), 'P2');
  });

  // --- Summary ---
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
