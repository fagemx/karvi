/**
 * routes/github.js — GitHub API proxy + webhook receiver
 *
 * Token stays on server — app calls these proxy endpoints,
 * server retrieves PAT from vault.
 *
 * Webhook (auth bypass — verified via HMAC):
 * POST /api/webhooks/github — receive GitHub issue webhook
 *
 * Config:
 * GET  /api/integrations/github — read GitHub integration config
 * PUT  /api/integrations/github — update GitHub integration config
 *
 * PR proxy:
 * GET  /api/github/token/status
 * POST /api/github/token/test
 * GET  /api/github/pr/:owner/:repo/:number
 * POST /api/github/pr/:owner/:repo/:number/approve
 * POST /api/github/pr/:owner/:repo/:number/request-changes
 * PUT  /api/github/pr/:owner/:repo/:number/merge
 */
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function githubRoutes(req, res, helpers, deps) {
  const { vault, githubApi, githubIntegration, mgmt, push, jiraIntegration, PUSH_TOKENS_PATH } = deps;

  // =========================================================================
  // POST /api/webhooks/github — receive GitHub issue webhook (HMAC verified)
  // =========================================================================
  if (req.method === 'POST' && req.url === '/api/webhooks/github') {
    if (!githubIntegration) { json(res, 404, { error: 'GitHub integration not available' }); return; }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        // HMAC verification — secret from vault, not board
        const secretBuf = vault.has('default', 'github_webhook_secret')
          ? vault.retrieve('default', 'github_webhook_secret')
          : null;
        const secret = secretBuf ? secretBuf.toString('utf8') : null;
        if (secretBuf) secretBuf.fill(0);

        const sig = req.headers['x-hub-signature-256'] || '';
        if (!githubIntegration.verifySignature(body, sig, secret)) {
          json(res, 401, { error: 'Invalid webhook signature' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const board = helpers.readBoard();
        const config = board.integrations?.github || { enabled: false };

        // Route by GitHub event type
        const ghEvent = req.headers['x-github-event'] || '';

        // --- pull_request events: capture PR outcomes ---
        if (ghEvent === 'pull_request') {
          const result = githubIntegration.handlePRWebhook(board, payload, config);

          if (result.action === 'skipped') {
            json(res, 200, { ok: true, skipped: true, reason: result.error });
            return;
          }

          if (result.action === 'pr_outcome') {
            const task = (board.taskPlan?.tasks || []).find(t => t.id === result.taskId);
            if (task && task.pr) {
              task.pr.outcome = result.outcome;
              if (result.outcome === 'merged') {
                task.pr.mergedAt = helpers.nowIso();
                task.pr.mergedBy = result.mergedBy || null;
              } else {
                task.pr.closedAt = helpers.nowIso();
                task.pr.closedBy = result.closedBy || null;
              }

              // Emit signal
              const signalType = result.outcome === 'merged' ? 'pr_merged' : 'pr_closed';
              mgmt.ensureEvolutionFields(board);
              board.signals.push({
                id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'github-webhook',
                type: signalType,
                content: `${result.taskId} PR #${result.prNumber} ${result.outcome}${result.mergedBy ? ` by ${result.mergedBy}` : ''}`,
                refs: [result.taskId],
                data: {
                  taskId: result.taskId,
                  prNumber: result.prNumber,
                  outcome: result.outcome,
                  mergedBy: result.mergedBy || null,
                  closedBy: result.closedBy || null,
                  mergeCommitSha: result.mergeCommitSha || null,
                },
              });
              if (board.signals.length > 500) board.signals = board.signals.slice(-500);

              helpers.writeBoard(board);
              helpers.appendLog({
                ts: helpers.nowIso(),
                event: signalType,
                taskId: result.taskId,
                prNumber: result.prNumber,
                outcome: result.outcome,
                source: 'github-webhook',
              });

              // Jira notification (fire-and-forget)
              if (jiraIntegration?.isEnabled(board)) {
                jiraIntegration.notifyJira(board, task, {
                  type: signalType,
                  prUrl: task.pr.url,
                  mergedBy: result.mergedBy,
                }).catch(err => console.error('[jira] pr outcome notify failed:', err.message));
              }

              // Push notification (fire-and-forget)
              if (push && PUSH_TOKENS_PATH) {
                push.notifyTaskEvent(PUSH_TOKENS_PATH, task, `task.${signalType}`)
                  .catch(err => console.error('[push] pr outcome notify failed:', err.message));
              }
            }
            json(res, 200, { ok: true, action: 'pr_outcome', taskId: result.taskId, outcome: result.outcome });
            return;
          }

          json(res, 200, { ok: true, action: result.action });
          return;
        }

        // --- issues events: create tasks (existing behavior) ---
        const result = githubIntegration.handleWebhook(board, payload, config);

        if (result.action === 'skipped') {
          json(res, 200, { ok: true, skipped: true, reason: result.error });
          return;
        }

        if (result.action === 'create_task' && result.task) {
          board.taskPlan = board.taskPlan || { tasks: [] };
          board.taskPlan.tasks = board.taskPlan.tasks || [];
          board.taskPlan.tasks.push(result.task);
          helpers.writeBoard(board);
          helpers.appendLog({
            ts: helpers.nowIso(),
            event: 'github_task_created',
            taskId: result.task.id,
            issueNumber: result.issueNumber,
            source: 'github-webhook',
          });

          // Auto-dispatch via step pipeline
          if (result.task.status === 'dispatched' && deps.tryAutoDispatch) {
            setImmediate(() => deps.tryAutoDispatch(result.task.id));
          }

          json(res, 201, { ok: true, action: 'create_task', taskId: result.task.id, issueNumber: result.issueNumber });
          return;
        }

        json(res, 200, { ok: true, action: result.action });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  // =========================================================================
  // GET /api/integrations/github — read GitHub integration config
  // =========================================================================
  if (req.method === 'GET' && req.url === '/api/integrations/github') {
    const board = helpers.readBoard();
    const config = board.integrations?.github || { enabled: false };
    json(res, 200, { ...config, webhookSecretConfigured: vault.has('default', 'github_webhook_secret') });
    return;
  }

  // =========================================================================
  // PUT /api/integrations/github — update GitHub integration config
  // =========================================================================
  if (req.method === 'PUT' && req.url === '/api/integrations/github') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');

        // Webhook secret → vault (never stored in board.json)
        if (payload.webhookSecret) {
          vault.store('default', 'github_webhook_secret', payload.webhookSecret);
          delete payload.webhookSecret;
        }

        const board = helpers.readBoard();
        board.integrations = board.integrations || {};
        board.integrations.github = { ...(board.integrations.github || {}), ...payload };
        helpers.writeBoard(board);
        json(res, 200, { ...board.integrations.github, webhookSecretConfigured: vault.has('default', 'github_webhook_secret') });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/github/token/status — check if GitHub PAT is configured (no token retrieval)
  if (req.method === 'GET' && req.url === '/api/github/token/status') {
    return json(res, 200, { configured: vault.has('default', 'github_pat') });
  }

  // POST /api/github/token/test — test stored GitHub PAT validity
  if (req.method === 'POST' && req.url === '/api/github/token/test') {
    if (!vault.isEnabled()) return json(res, 503, { error: 'Vault not configured. Set KARVI_VAULT_KEY environment variable on server.' });
    const tokenBuf = vault.retrieve('default', 'github_pat');
    if (!tokenBuf) return json(res, 400, { error: 'GitHub token not configured. Add your PAT in Settings > Integrations.' });
    const pat = tokenBuf.toString('utf8');
    tokenBuf.fill(0);
    githubApi.testToken(pat).then(result => {
      json(res, 200, result);
    }).catch(err => {
      if (err.status === 401) return json(res, 401, { error: 'GitHub authentication failed. Check your Personal Access Token.' });
      json(res, err.status || 500, { error: err.data?.message || err.message || 'Token test failed' });
    });
    return;
  }

  // GET /api/github/pr/:owner/:repo/:number — fetch PR metadata + files
  const ghPrMatch = req.url.match(/^\/api\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (req.method === 'GET' && ghPrMatch) {
    const [, owner, repo, number] = ghPrMatch;
    if (!vault.isEnabled()) return json(res, 503, { error: 'Vault not configured. Set KARVI_VAULT_KEY environment variable on server.' });
    const tokenBuf = vault.retrieve('default', 'github_pat');
    if (!tokenBuf) return json(res, 400, { error: 'GitHub token not configured. Add your PAT in Settings > Integrations.' });
    const pat = tokenBuf.toString('utf8');
    tokenBuf.fill(0);
    Promise.all([
      githubApi.fetchPR(pat, owner, repo, number),
      githubApi.fetchPRFiles(pat, owner, repo, number),
    ]).then(([pr, files]) => {
      json(res, 200, { pr: pr.data, files: files.data });
    }).catch(err => {
      if (err.status === 401) return json(res, 401, { error: 'GitHub authentication failed. Check your Personal Access Token.' });
      if (err.status === 404) return json(res, 404, { error: `Pull request not found: ${owner}/${repo}#${number}` });
      if (err.status === 403) return json(res, 403, { error: "Permission denied. Your token may lack 'repo' scope." });
      json(res, err.status || 500, { error: err.data?.message || err.message || 'Failed to fetch PR' });
    });
    return;
  }

  // POST /api/github/pr/:owner/:repo/:number/approve — approve PR
  const ghApproveMatch = req.url.match(/^\/api\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)\/approve$/);
  if (req.method === 'POST' && ghApproveMatch) {
    const [, owner, repo, number] = ghApproveMatch;
    if (!vault.isEnabled()) return json(res, 503, { error: 'Vault not configured. Set KARVI_VAULT_KEY environment variable on server.' });
    const tokenBuf = vault.retrieve('default', 'github_pat');
    if (!tokenBuf) return json(res, 400, { error: 'GitHub token not configured. Add your PAT in Settings > Integrations.' });
    const pat = tokenBuf.toString('utf8');
    tokenBuf.fill(0);
    githubApi.createReview(pat, owner, repo, number, 'APPROVE').then(result => {
      json(res, 200, { ok: true, review: result.data });
    }).catch(err => {
      if (err.status === 401) return json(res, 401, { error: 'GitHub authentication failed. Check your Personal Access Token.' });
      if (err.status === 403) return json(res, 403, { error: "Permission denied. Your token may lack 'repo' scope." });
      if (err.status === 422) return json(res, 422, { error: err.data?.message || 'Cannot approve this PR.' });
      json(res, err.status || 500, { error: err.data?.message || err.message || 'Failed to approve PR' });
    });
    return;
  }

  // POST /api/github/pr/:owner/:repo/:number/request-changes — request changes on PR
  const ghRequestChangesMatch = req.url.match(/^\/api\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)\/request-changes$/);
  if (req.method === 'POST' && ghRequestChangesMatch) {
    const [, owner, repo, number] = ghRequestChangesMatch;
    if (!vault.isEnabled()) return json(res, 503, { error: 'Vault not configured. Set KARVI_VAULT_KEY environment variable on server.' });
    const tokenBuf = vault.retrieve('default', 'github_pat');
    if (!tokenBuf) return json(res, 400, { error: 'GitHub token not configured. Add your PAT in Settings > Integrations.' });
    const pat = tokenBuf.toString('utf8');
    tokenBuf.fill(0);
    bb.parseBody(req).then(payload => {
      const body = String(payload.body || '').trim();
      if (!body) return json(res, 400, { error: 'Review body is required for request-changes.' });
      return githubApi.createReview(pat, owner, repo, number, 'REQUEST_CHANGES', body).then(result => {
        json(res, 200, { ok: true, review: result.data });
      });
    }).catch(err => {
      if (err.status === 401) return json(res, 401, { error: 'GitHub authentication failed. Check your Personal Access Token.' });
      if (err.status === 403) return json(res, 403, { error: "Permission denied. Your token may lack 'repo' scope." });
      json(res, err.status || 500, { error: err.data?.message || err.message || 'Failed to request changes' });
    });
    return;
  }

  // PUT /api/github/pr/:owner/:repo/:number/merge — merge PR (squash by default)
  const ghMergeMatch = req.url.match(/^\/api\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)\/merge$/);
  if (req.method === 'PUT' && ghMergeMatch) {
    const [, owner, repo, number] = ghMergeMatch;
    if (!vault.isEnabled()) return json(res, 503, { error: 'Vault not configured. Set KARVI_VAULT_KEY environment variable on server.' });
    const tokenBuf = vault.retrieve('default', 'github_pat');
    if (!tokenBuf) return json(res, 400, { error: 'GitHub token not configured. Add your PAT in Settings > Integrations.' });
    const pat = tokenBuf.toString('utf8');
    tokenBuf.fill(0);
    bb.parseBody(req).then(payload => {
      const commitTitle = payload?.commitTitle || undefined;
      const mergeMethod = payload?.mergeMethod || 'squash';
      return githubApi.mergePR(pat, owner, repo, number, commitTitle, mergeMethod).then(result => {
        json(res, 200, { ok: true, merge: result.data });
      });
    }).catch(err => {
      if (err.status === 401) return json(res, 401, { error: 'GitHub authentication failed. Check your Personal Access Token.' });
      if (err.status === 403) return json(res, 403, { error: "Permission denied. Your token may lack 'repo' scope." });
      if (err.status === 405) return json(res, 405, { error: 'Pull request is not mergeable. It may already be merged or have conflicts.' });
      if (err.status === 409) return json(res, 409, { error: 'Cannot merge: conflicts exist. Resolve conflicts on GitHub first.' });
      json(res, err.status || 500, { error: err.data?.message || err.message || 'Failed to merge PR' });
    });
    return;
  }

  return false;
};
