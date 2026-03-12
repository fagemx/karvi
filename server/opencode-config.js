/**
 * opencode-config.js — opencode.json validation and model resolution
 *
 * Provides:
 * - loadOpenCodeConfig(): Load and validate opencode.json
 * - validateOpenCodeConfig(): Schema validation for opencode.json
 * - resolveModelFromMap(): Resolve provider+model from model_map config
 * - stripSensitiveFields(): Remove API keys for safe API responses
 */
const fs = require('fs');
const path = require('path');

let cachedConfig = null;
let configError = null;

/**
 * Load opencode.json from project root.
 * Returns null if file doesn't exist.
 * Caches result for subsequent calls.
 */
function loadOpenCodeConfig(projectRoot) {
  if (cachedConfig !== null) return { config: cachedConfig, error: null };
  if (configError !== null) return { config: null, error: configError };

  const configPath = path.join(projectRoot, 'opencode.json');
  try {
    if (!fs.existsSync(configPath)) {
      cachedConfig = null;
      return { config: null, error: null };
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const validation = validateOpenCodeConfig(config);
    if (!validation.valid) {
      configError = validation.error;
      return { config: null, error: configError };
    }
    cachedConfig = config;
    return { config, error: null };
  } catch (err) {
    configError = `Failed to load opencode.json: ${err.message}`;
    return { config: null, error: configError };
  }
}

/**
 * Validate opencode.json schema.
 * Must have:
 * - provider object with at least one provider
 * - Each provider must have: name, npm, env (array), models (object)
 * - Each model must have: name, tool_call (boolean), limit object
 */
function validateOpenCodeConfig(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'opencode.json must be an object' };
  }

  const providers = config.provider;
  if (!providers || typeof providers !== 'object') {
    return { valid: false, error: 'opencode.json must have a "provider" object' };
  }

  const providerKeys = Object.keys(providers);
  if (providerKeys.length === 0) {
    return { valid: false, error: 'opencode.json must have at least one provider' };
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') {
      return { valid: false, error: `provider.${providerId} must be an object` };
    }
    if (!provider.name || typeof provider.name !== 'string') {
      return { valid: false, error: `provider.${providerId}.name is required and must be a string` };
    }
    if (!provider.npm || typeof provider.npm !== 'string') {
      return { valid: false, error: `provider.${providerId}.npm is required and must be a string` };
    }
    if (!Array.isArray(provider.env)) {
      return { valid: false, error: `provider.${providerId}.env is required and must be an array` };
    }
    if (!provider.models || typeof provider.models !== 'object') {
      return { valid: false, error: `provider.${providerId}.models is required and must be an object` };
    }

    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model || typeof model !== 'object') {
        return { valid: false, error: `provider.${providerId}.models.${modelId} must be an object` };
      }
      if (!model.name || typeof model.name !== 'string') {
        return { valid: false, error: `provider.${providerId}.models.${modelId}.name is required` };
      }
      if (typeof model.tool_call !== 'boolean') {
        return { valid: false, error: `provider.${providerId}.models.${modelId}.tool_call must be a boolean` };
      }
      if (!model.limit || typeof model.limit !== 'object') {
        return { valid: false, error: `provider.${providerId}.models.${modelId}.limit is required` };
      }
    }
  }

  return { valid: true, error: null };
}

/**
 * Resolve provider+model from model_map config.
 * Input: "custom-ai-t8star-cn/claude-sonnet-4"
 * Output: { provider: "custom-ai-t8star-cn", model: "claude-sonnet-4", providerConfig: {...}, modelConfig: {...} }
 */
function resolveModelFromMap(modelHint, projectRoot) {
  if (!modelHint || typeof modelHint !== 'string') {
    return { resolved: false, error: 'modelHint must be a non-empty string' };
  }

  const trimmed = modelHint.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx < 0) {
    return { resolved: false, error: `modelHint must be in "provider/model" format, got: "${trimmed}"` };
  }

  const providerId = trimmed.slice(0, slashIdx);
  const modelId = trimmed.slice(slashIdx + 1);

  if (!providerId || !modelId) {
    return { resolved: false, error: `modelHint must have both provider and model parts, got: "${trimmed}"` };
  }

  const { config, error } = loadOpenCodeConfig(projectRoot);
  if (error) {
    return { resolved: false, error: `Failed to load opencode.json: ${error}` };
  }
  if (!config) {
    return { resolved: false, error: `Provider "${providerId}" not found (opencode.json not configured)` };
  }

  const providerConfig = config.provider?.[providerId];
  if (!providerConfig) {
    const available = Object.keys(config.provider || {}).join(', ') || 'none';
    return { resolved: false, error: `Provider "${providerId}" not found in opencode.json. Available: ${available}` };
  }

  const modelConfig = providerConfig.models?.[modelId];
  if (!modelConfig) {
    const available = Object.keys(providerConfig.models || {}).join(', ') || 'none';
    return { resolved: false, error: `Model "${modelId}" not found in provider "${providerId}". Available: ${available}` };
  }

  return {
    resolved: true,
    provider: providerId,
    model: modelId,
    fullModelId: trimmed,
    providerConfig: {
      name: providerConfig.name,
      npm: providerConfig.npm,
      env: providerConfig.env,
      options: providerConfig.options,
    },
    modelConfig: {
      name: modelConfig.name,
      tool_call: modelConfig.tool_call,
      limit: modelConfig.limit,
    },
  };
}

/**
 * Strip sensitive fields (API keys) from config for API responses.
 * Removes env array values but keeps structure.
 */
function stripSensitiveFields(config) {
  if (!config || typeof config !== 'object') return config;

  const stripped = JSON.parse(JSON.stringify(config));

  if (stripped.provider) {
    for (const providerId of Object.keys(stripped.provider)) {
      const provider = stripped.provider[providerId];
      if (provider.env && Array.isArray(provider.env)) {
        provider.env = provider.env.map(key => ({ key, set: !!process.env[key] }));
      }
      if (provider.options?.apiKey) {
        provider.options.apiKey = '***REDACTED***';
      }
      if (provider.options?.apiKeyEnv) {
        provider.options.apiKeyEnv = '***REDACTED***';
      }
    }
  }

  return stripped;
}

/**
 * Clear cache (for testing or hot reload).
 */
function clearCache() {
  cachedConfig = null;
  configError = null;
}

module.exports = {
  loadOpenCodeConfig,
  validateOpenCodeConfig,
  resolveModelFromMap,
  stripSensitiveFields,
  clearCache,
};
