/**
 * routes/github.js — GitHub API proxy
 *
 * Token stays on server — app calls these proxy endpoints,
 * server retrieves PAT from vault.
 *
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
  const { vault, githubApi } = deps;

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
