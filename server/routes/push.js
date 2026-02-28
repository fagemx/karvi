/**
 * routes/push.js — Push token register/unregister
 *
 * POST /api/push-token — register Expo push token
 * DELETE /api/push-token — unregister push token
 */
const bb = require('../blackboard-server');
const { json } = bb;

module.exports = function pushRoutes(req, res, helpers, deps) {

  if (req.method === 'POST' && req.url === '/api/push-token') {
    helpers.parseBody(req).then(payload => {
      const token = String(payload.token || '').trim();
      if (!token || !token.startsWith('ExponentPushToken[')) {
        return json(res, 400, { error: 'Invalid Expo push token' });
      }
      const deviceName = String(payload.deviceName || 'Unknown').trim();
      deps.push.registerToken(deps.PUSH_TOKENS_PATH, token, deviceName);
      json(res, 200, { ok: true });
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  if (req.method === 'DELETE' && req.url === '/api/push-token') {
    helpers.parseBody(req).then(payload => {
      const token = String(payload.token || '').trim();
      if (!token) return json(res, 400, { error: 'token required' });
      deps.push.removeToken(deps.PUSH_TOKENS_PATH, token);
      json(res, 200, { ok: true });
    }).catch(e => json(res, 400, { error: e.message }));
    return;
  }

  return false;
};
