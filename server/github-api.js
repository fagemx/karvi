/**
 * github-api.js — GitHub REST API client (zero external dependencies)
 *
 * Uses Node.js built-in `https` module to call GitHub REST API v3.
 * All functions require a GitHub PAT (Personal Access Token).
 *
 * Exported:
 *   fetchPR(token, owner, repo, number)
 *   fetchPRFiles(token, owner, repo, number)
 *   createReview(token, owner, repo, number, event, body)
 *   mergePR(token, owner, repo, number, commitTitle, mergeMethod)
 *   testToken(token)
 */
const https = require('https');

const GITHUB_API = 'api.github.com';
const USER_AGENT = 'Karvi-Task-Engine/1.0';
const API_VERSION = '2022-11-28';

// ---------------------------------------------------------------------------
// Core HTTPS request helper
// ---------------------------------------------------------------------------

function request(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: GITHUB_API,
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
    };
    if (body) {
      const payload = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = data ? JSON.parse(data) : {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: parsed });
        } else {
          reject({ status: res.statusCode, data: parsed });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch PR metadata (title, body, state, user, mergeable, merged, head/base refs)
 */
function fetchPR(token, owner, repo, number) {
  return request('GET', `/repos/${owner}/${repo}/pulls/${number}`, token);
}

/**
 * Fetch PR changed files with patches (unified diff per file)
 */
function fetchPRFiles(token, owner, repo, number) {
  return request('GET', `/repos/${owner}/${repo}/pulls/${number}/files`, token);
}

/**
 * Create a review on a PR
 * @param {string} event - 'APPROVE' or 'REQUEST_CHANGES'
 * @param {string} body - Review comment body (required for REQUEST_CHANGES)
 */
function createReview(token, owner, repo, number, event, body) {
  const payload = { event };
  if (body) payload.body = body;
  return request('POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, token, payload);
}

/**
 * Merge a PR
 * @param {string} commitTitle - Optional commit title for squash merge
 * @param {string} mergeMethod - 'merge', 'squash', or 'rebase' (default: 'squash')
 */
function mergePR(token, owner, repo, number, commitTitle, mergeMethod = 'squash') {
  const payload = { merge_method: mergeMethod };
  if (commitTitle) payload.commit_title = commitTitle;
  return request('PUT', `/repos/${owner}/${repo}/pulls/${number}/merge`, token, payload);
}

/**
 * Test token validity — GET /user to verify PAT and return username + scopes
 */
async function testToken(token) {
  const result = await request('GET', '/user', token);
  return {
    ok: true,
    username: result.data.login,
    name: result.data.name,
    avatar_url: result.data.avatar_url,
  };
}

module.exports = { fetchPR, fetchPRFiles, createReview, mergePR, testToken };
