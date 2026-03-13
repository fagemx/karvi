/**
 * routes/repos.js — Repo provisioning API for SaaS users.
 *
 * Endpoints:
 *   POST   /api/repos          — Register + clone a repo
 *   GET    /api/repos          — List registered repos
 *   GET    /api/repos/:slug    — Get repo info (slug = owner/repo)
 *   DELETE /api/repos/:slug    — Unregister + delete bare clone
 *   POST   /api/repos/:slug/fetch — Force fetch latest from remote
 */

'use strict';

const bb = require('../blackboard-server');
const { json } = bb;
const provisioner = require('../repo-provisioner');

/**
 * Resolve the data root for the current request.
 * SaaS mode: DATA_DIR env points to per-user data directory.
 * Self-hosted: falls back to {serverDir}/../.data
 */
function resolveDataRoot() {
  return process.env.DATA_DIR || require('path').join(__dirname, '..', '..', '.data');
}

/**
 * Resolve a GitHub token from vault for the current user.
 * @param {object} deps
 * @param {string} userId
 * @returns {string|null}
 */
function resolveGitHubToken(deps, userId) {
  const vault = deps.vault;
  if (!vault || !vault.isEnabled()) return null;
  const buf = vault.retrieve(userId || 'default', 'github_pat');
  if (!buf) return null;
  const token = buf.toString('utf8');
  buf.fill(0);
  return token;
}

module.exports = function reposRoute(req, res, helpers, deps) {
  // POST /api/repos — register + clone
  if (req.method === 'POST' && req.url === '/api/repos') {
    helpers.parseBody(req).then(body => {
      const { url, branch } = body;
      if (!url) return json(res, 400, { error: 'url is required (GitHub URL or owner/repo)' });

      const parsed = provisioner.parseGitHubRepo(url);
      if (!parsed) return json(res, 400, { error: 'Invalid GitHub repo. Expected URL or owner/repo slug.' });

      const dataRoot = resolveDataRoot();
      const userId = body.userId || 'default';
      const token = resolveGitHubToken(deps, userId);

      try {
        const result = provisioner.ensureBareClone({
          dataRoot,
          owner: parsed.owner,
          repo: parsed.repo,
          token,
          branch: branch || null,
        });

        const entry = provisioner.registerRepo(dataRoot, parsed.owner, parsed.repo, {
          branch: branch || 'main',
        });

        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'repo_provisioned',
          slug: `${parsed.owner}/${parsed.repo}`,
          barePath: result.barePath,
          created: result.created,
        });

        return json(res, result.created ? 201 : 200, {
          ok: true,
          created: result.created,
          repo: entry,
        });
      } catch (err) {
        console.error(`[repos] clone failed for ${parsed.owner}/${parsed.repo}: ${err.message}`);
        return json(res, 500, { error: `Clone failed: ${err.message}` });
      }
    }).catch(err => json(res, 400, { error: `Bad request: ${err.message}` }));
    return;
  }

  // GET /api/repos — list all
  if (req.method === 'GET' && req.url === '/api/repos') {
    const dataRoot = resolveDataRoot();
    const repos = provisioner.listRepos(dataRoot);
    return json(res, 200, { repos });
  }

  // GET /api/repos/:owner/:repo — get single
  const getMatch = req.method === 'GET' && req.url.match(/^\/api\/repos\/([^/]+)\/([^/]+)$/);
  if (getMatch) {
    const dataRoot = resolveDataRoot();
    const entry = provisioner.getRepo(dataRoot, getMatch[1], getMatch[2]);
    if (!entry) return json(res, 404, { error: 'Repo not registered' });
    return json(res, 200, { repo: entry });
  }

  // DELETE /api/repos/:owner/:repo — unregister
  const delMatch = req.method === 'DELETE' && req.url.match(/^\/api\/repos\/([^/]+)\/([^/]+)$/);
  if (delMatch) {
    const dataRoot = resolveDataRoot();
    const owner = delMatch[1];
    const repo = delMatch[2];
    provisioner.unregisterRepo(dataRoot, owner, repo);
    helpers.appendLog({
      ts: helpers.nowIso(),
      event: 'repo_removed',
      slug: `${owner}/${repo}`,
    });
    return json(res, 200, { ok: true, deleted: `${owner}/${repo}` });
  }

  // POST /api/repos/:owner/:repo/fetch — force fetch
  const fetchMatch = req.method === 'POST' && req.url.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/fetch$/);
  if (fetchMatch) {
    const dataRoot = resolveDataRoot();
    const owner = fetchMatch[1];
    const repo = fetchMatch[2];
    const entry = provisioner.getRepo(dataRoot, owner, repo);
    if (!entry) return json(res, 404, { error: 'Repo not registered' });

    const userId = 'default';
    const token = resolveGitHubToken(deps, userId);

    try {
      provisioner.ensureBareClone({
        dataRoot,
        owner,
        repo,
        token,
      });
      return json(res, 200, { ok: true, fetched: `${owner}/${repo}` });
    } catch (err) {
      return json(res, 500, { error: `Fetch failed: ${err.message}` });
    }
  }

  return false; // not handled
};
