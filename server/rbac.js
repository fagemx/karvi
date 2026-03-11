/**
 * rbac.js — Role-Based Access Control with Per-User Attribution
 *
 * 從環境變數讀取 per-role token，提供角色解析、權限檢查和用戶歸屬。
 *
 * 環境變數：
 *   KARVI_API_TOKEN          — 既有的單一 token（視為 admin）
 *   KARVI_API_TOKEN_ADMIN    — admin role token
 *   KARVI_API_TOKEN_OPERATOR — operator role token
 *   KARVI_API_TOKEN_VIEWER   — viewer role token
 *   KARVI_USER_TOKENS        — JSON map of userId → token (per-user attribution)
 *
 * 行為：
 *   - 沒有任何 token → local dev mode，不啟用 RBAC
 *   - 只有 KARVI_API_TOKEN → 該 token = admin（向後相容）
 *   - 有 KARVI_API_TOKEN_* → role-based auth
 *   - 有 KARVI_USER_TOKENS → per-user attribution（配合 gateway 使用）
 */
const crypto = require('crypto');

const ROLES = { ADMIN: 'admin', OPERATOR: 'operator', VIEWER: 'viewer' };
const ROLE_LEVEL = { admin: 3, operator: 2, viewer: 1 };

/**
 * 從環境變數建立 token→role 映射表。
 * @returns {{ tokenMap: Map<string, string>, active: boolean }}
 */
function parseRoleTokens() {
  const map = new Map();

  const adminToken = process.env.KARVI_API_TOKEN_ADMIN;
  const operatorToken = process.env.KARVI_API_TOKEN_OPERATOR;
  const viewerToken = process.env.KARVI_API_TOKEN_VIEWER;
  const legacyToken = process.env.KARVI_API_TOKEN;

  if (adminToken) map.set(adminToken, ROLES.ADMIN);
  if (operatorToken) map.set(operatorToken, ROLES.OPERATOR);
  if (viewerToken) map.set(viewerToken, ROLES.VIEWER);

  // 向後相容：KARVI_API_TOKEN 視為 admin（除非已被 KARVI_API_TOKEN_ADMIN 覆蓋）
  if (legacyToken && !map.has(legacyToken)) {
    map.set(legacyToken, ROLES.ADMIN);
  }

  return { tokenMap: map, active: map.size > 0 };
}

/**
 * 從環境變數建立 token→userId 映射表（per-user attribution）。
 * KARVI_USER_TOKENS 格式：JSON object { "userId1": "token1", "userId2": "token2" }
 * @returns {{ userTokenMap: Map<string, string>, active: boolean }}
 */
function parseUserTokens() {
  const map = new Map();
  const userTokensJson = process.env.KARVI_USER_TOKENS;

  if (userTokensJson) {
    try {
      const userTokens = JSON.parse(userTokensJson);
      if (userTokens && typeof userTokens === 'object') {
        for (const [userId, token] of Object.entries(userTokens)) {
          if (typeof token === 'string' && token.trim()) {
            map.set(token.trim(), userId);
          }
        }
      }
    } catch (err) {
      console.error('[rbac] Failed to parse KARVI_USER_TOKENS:', err.message);
    }
  }

  return { userTokenMap: map, active: map.size > 0 };
}

/**
 * Timing-safe token comparison.
 */
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 從 request 的 Bearer token 解析角色。
 * @param {Map<string, string>} tokenMap
 * @param {string} provided — 從 request 提取的 token
 * @returns {string|null} role name or null
 */
function matchRole(tokenMap, provided) {
  if (!provided) return null;
  for (const [token, role] of tokenMap) {
    if (safeCompare(token, provided)) return role;
  }
  return null;
}

/**
 * 檢查角色是否滿足最低要求。
 * @param {string|null} role — 當前角色
 * @param {string} minRole — 最低角色要求
 * @returns {boolean}
 */
function hasRole(role, minRole) {
  if (!role) return false;
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minRole] || 0);
}

/**
 * 從 token 解析 userId（per-user attribution）。
 * @param {Map<string, string>} userTokenMap — token → userId 映射表
 * @param {string} provided — 從 request 提取的 token
 * @returns {string|null} userId or null
 */
function matchUserId(userTokenMap, provided) {
  if (!provided || !userTokenMap) return null;
  for (const [token, userId] of userTokenMap) {
    if (safeCompare(token, provided)) return userId;
  }
  return null;
}

/**
 * 解析 request 的完整歸屬資訊（role + userId）。
 * @param {object} roleTokens — parseRoleTokens() 結果
 * @param {object} userTokens — parseUserTokens() 結果
 * @param {string} provided — 從 request 提取的 token
 * @returns {{ role: string|null, userId: string|null }}
 */
function resolveAttribution(roleTokens, userTokens, provided) {
  const role = roleTokens?.active ? matchRole(roleTokens.tokenMap, provided) : null;
  const userId = userTokens?.active ? matchUserId(userTokens.userTokenMap, provided) : null;
  return { role, userId };
}

module.exports = {
  ROLES,
  ROLE_LEVEL,
  parseRoleTokens,
  parseUserTokens,
  matchRole,
  matchUserId,
  resolveAttribution,
  hasRole,
  safeCompare,
};
