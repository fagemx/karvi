/**
 * routes/vault.js — Vault CRUD
 *
 * GET /api/vault/status
 * POST /api/vault/store
 * GET /api/vault/keys/:userId
 * DELETE /api/vault/delete/:userId/:keyName
 */
const bb = require('../blackboard-server');
const { json } = bb;
const { requireRole } = require('./_shared');

const VALID_VAULT_ID = /^[a-zA-Z0-9_-]+$/;

module.exports = function vaultRoutes(req, res, helpers, deps) {
  const { vault } = deps;

  if (req.method === 'GET' && req.url === '/api/vault/status') {
    return json(res, 200, { enabled: vault.isEnabled() });
  }

  if (req.url.startsWith('/api/vault/') && !vault.isEnabled()) {
    return json(res, 503, { error: 'Vault not configured (KARVI_VAULT_KEY not set)' });
  }

  if (req.method === 'POST' && req.url === '/api/vault/store') {
    if (requireRole(req, res, 'admin')) return;
    helpers.parseBody(req).then(payload => {
      const { userId, keyName, value } = payload;
      if (!userId || !VALID_VAULT_ID.test(userId)) return json(res, 400, { error: 'Invalid userId' });
      if (!keyName || !VALID_VAULT_ID.test(keyName)) return json(res, 400, { error: 'Invalid keyName' });
      if (!value) return json(res, 400, { error: 'value is required' });
      const result = vault.store(userId, keyName, value);
      json(res, result.ok ? 200 : 400, result);
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  const vaultKeysMatch = req.url.match(/^\/api\/vault\/keys\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && vaultKeysMatch) {
    if (requireRole(req, res, 'operator')) return;
    const userId = vaultKeysMatch[1];
    const result = vault.list(userId);
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  const vaultDeleteMatch = req.url.match(/^\/api\/vault\/delete\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'DELETE' && vaultDeleteMatch) {
    if (requireRole(req, res, 'admin')) return;
    const [, userId, keyName] = vaultDeleteMatch;
    const result = vault.delete(userId, keyName);
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  return false;
};
