/**
 * chief-profile.js — Pluggable ChiefProfile System
 *
 * Loads chief personality profiles from chief_profiles/ directory.
 * Each profile has: IDENTITY.md, SOUL.md, governance.json
 *
 * Profiles affect:
 *   1. Chief prompt injection (IDENTITY + SOUL prepended to synthesis/checkin)
 *   2. Governance policy overrides (max_tool_tier, autopilot, human gates)
 *
 * Profile-invariant rules (village constitution) are enforced by server
 * regardless of which profile is active.
 */
const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, 'chief_profiles');

// 內建 profile 名單（啟動時驗證目錄存在）
const BUILTIN_PROFILES = ['ship_first', 'chat_first', 'proposal_first'];

/**
 * List available profile names (directories under chief_profiles/).
 * @returns {string[]}
 */
function listProfiles() {
  try {
    const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Load a single profile by name.
 * @param {string} name - profile directory name (e.g. 'ship_first')
 * @returns {{ name, identity, soul, governance }|null}
 */
function loadProfile(name) {
  if (!isValidProfileName(name)) return null;

  const profileDir = path.join(PROFILES_DIR, name);
  try {
    const stat = fs.statSync(profileDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const identityPath = path.join(profileDir, 'IDENTITY.md');
  const soulPath = path.join(profileDir, 'SOUL.md');
  const govPath = path.join(profileDir, 'governance.json');

  let identity = '';
  let soul = '';
  let governance = {};

  try { identity = fs.readFileSync(identityPath, 'utf8'); } catch { /* optional */ }
  try { soul = fs.readFileSync(soulPath, 'utf8'); } catch { /* optional */ }
  try { governance = JSON.parse(fs.readFileSync(govPath, 'utf8')); } catch { /* optional */ }

  return { name, identity, soul, governance };
}

/**
 * Get the active profile name from board.
 * Falls back to null (no profile = legacy behavior).
 * @param {object} board
 * @returns {string|null}
 */
function getActiveProfileName(board) {
  return board.village?.chief_profile || null;
}

/**
 * Load the active profile from board, or null if none set.
 * @param {object} board
 * @returns {{ name, identity, soul, governance }|null}
 */
function getActiveProfile(board) {
  const name = getActiveProfileName(board);
  if (!name) return null;
  return loadProfile(name);
}

/**
 * Build the personality prompt text from a profile.
 * Combines IDENTITY.md + SOUL.md for injection into chief prompts.
 * @param {{ identity, soul }} profile
 * @returns {string}
 */
function buildPersonalityPrompt(profile) {
  if (!profile) return '';
  const parts = [];
  if (profile.identity) parts.push(profile.identity.trim());
  if (profile.soul) parts.push(profile.soul.trim());
  return parts.join('\n\n');
}

/**
 * Apply governance overrides from profile to the tool tier policy.
 * Profile governance merges ON TOP of board-level policy.
 * Village constitution rules are never overridden.
 *
 * @param {object} basePolicy - resolved policy from resolvePolicy()
 * @param {object} governance - profile's governance.json
 * @returns {object} merged policy
 */
function applyGovernanceOverrides(basePolicy, governance) {
  if (!governance) return basePolicy;

  const merged = { ...basePolicy };

  // max_tool_tier caps the chief_max_tier and default_worker_tier
  if (governance.max_tool_tier) {
    merged.chief_max_tier = capTier(merged.chief_max_tier, governance.max_tool_tier);
    merged.default_worker_tier = capTier(merged.default_worker_tier, governance.max_tool_tier);
  }

  // Propagate governance fields that plan-dispatcher can read
  if (governance.autopilot_allowed !== undefined) {
    merged.autopilot_allowed = governance.autopilot_allowed;
  }
  if (governance.questions_budget !== undefined) {
    merged.questions_budget = governance.questions_budget;
  }
  if (governance.risk_posture) {
    merged.risk_posture = governance.risk_posture;
  }
  if (governance.default_deliverable) {
    merged.default_deliverable = governance.default_deliverable;
  }
  if (Array.isArray(governance.human_gate_triggers)) {
    merged.human_gate_triggers = governance.human_gate_triggers;
  }
  if (governance.cost_policy) {
    merged.cost_policy = governance.cost_policy;
  }

  return merged;
}

// Tier numeric values for comparison
const TIER_LEVELS = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };

/**
 * Cap a tier to a maximum value. Returns the lower of the two.
 * @param {string} tier - e.g. 'T3'
 * @param {string} maxTier - e.g. 'T2'
 * @returns {string} the lower tier
 */
function capTier(tier, maxTier) {
  const a = TIER_LEVELS[tier];
  const b = TIER_LEVELS[maxTier];
  if (a === undefined) return tier;
  if (b === undefined) return tier;
  return a <= b ? tier : maxTier;
}

/**
 * Validate a profile name — must be a safe directory name.
 * @param {string} name
 * @returns {boolean}
 */
function isValidProfileName(name) {
  if (!name || typeof name !== 'string') return false;
  // Only alphanumeric, underscore, hyphen; no path traversal
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

module.exports = {
  PROFILES_DIR,
  BUILTIN_PROFILES,
  listProfiles,
  loadProfile,
  getActiveProfileName,
  getActiveProfile,
  buildPersonalityPrompt,
  applyGovernanceOverrides,
  capTier,
  isValidProfileName,
};
