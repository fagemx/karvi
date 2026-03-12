/**
 * routes/config.js — Config API
 *
 * GET /api/config/opencode — read opencode.json (strips API keys)
 */
const bb = require('../blackboard-server');
const { json } = bb;
const { requireRole } = require('./_shared');
const opencodeConfig = require('../opencode-config');

module.exports = function configRoutes(req, res, helpers, deps) {
  const { ctx } = deps;
  const projectRoot = ctx.dir;

  if (req.method === 'GET' && req.url === '/api/config/opencode') {
    try {
      const { config, error } = opencodeConfig.loadOpenCodeConfig(projectRoot);
      if (error) {
        return json(res, 500, { error: error });
      }
      if (!config) {
        return json(res, 404, { 
          error: 'opencode.json not found',
          hint: 'Create opencode.json in project root with custom provider configuration'
        });
      }
      const safeConfig = opencodeConfig.stripSensitiveFields(config);
      return json(res, 200, { 
        ok: true, 
        config: safeConfig,
        providers: Object.keys(config.provider || {}),
        modelCount: Object.values(config.provider || {}).reduce(
          (sum, p) => sum + Object.keys(p.models || {}).length, 0
        )
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  return false;
};
