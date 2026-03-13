/**
 * tool-tiers.js — Tool Tier Governance System (T0-T4)
 *
 * Defines capability tiers for agent actions and enforces per-role limits.
 *
 * Tier definitions:
 *   T0 — Text/thinking only (analysis, planning, writing proposals)
 *   T1 — Read access (read repo, query issues/PRs, read logs, web search)
 *   T2 — Light write / governance (create issue, comment on PR, create/modify tasks, write spec)
 *   T3 — Heavy write / delivery (modify code, commit, push, create PR, run tests)
 *   T4 — Infrastructure (deploy, modify CI/CD, change env vars, DNS)
 *
 * Used by:
 *   - plan-dispatcher.js: attach max_tier to VT tasks based on kind
 *   - village-meeting.js: set tier for proposal/synthesis/checkin tasks
 *   - step-worker.js: read max_tier and enforce before dispatch
 */

// Tier numeric values for comparison
const TIER_LEVELS = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };

// Default role → max tier mapping
const DEFAULT_ROLE_TIERS = {
  chief: 'T2',         // governance only — dispatches, doesn't deliver
  proposal: 'T1',      // read + analyze, produce text proposals
  engineer_lite: 'T3', // code changes + PR
  engineer_pro: 'T3',  // code changes + PR
  ops: 'T4',           // deploy (with human gate)
};

// Kind → default tier mapping (what tier is needed to produce this deliverable)
const KIND_TIER_MAP = {
  code_change: 'T3',
  research: 'T1',
  doc: 'T2',
  ops: 'T4',
  issue_ops: 'T2',
  discussion: 'T0',
};

// Step type → minimum tier required
const STEP_TYPE_TIER_MAP = {
  plan: 'T0',
  propose: 'T1',
  synthesize: 'T2',
  checkin: 'T2',
  implement: 'T3',
  review: 'T1',
  test: 'T3',
  execute: 'T3',
  deploy: 'T4',
};

/**
 * Get the default policy. Board-level village.tool_tier_policy overrides these.
 * @returns {object}
 */
function defaultPolicy() {
  return {
    chief_max_tier: 'T2',
    proposal_max_tier: 'T1',
    default_worker_tier: 'T3',
    tier_upgrade_requires: 'human_gate',
  };
}

/**
 * Resolve the effective tool tier policy from board config.
 * @param {object} board
 * @returns {object} merged policy
 */
function resolvePolicy(board) {
  const defaults = defaultPolicy();
  const boardPolicy = board.village?.tool_tier_policy || {};
  const merged = { ...defaults, ...boardPolicy };
  // Validate tier values — replace invalid with defaults
  for (const key of ['chief_max_tier', 'proposal_max_tier', 'default_worker_tier']) {
    if (TIER_LEVELS[merged[key]] === undefined) {
      merged[key] = defaults[key];
    }
  }
  return merged;
}

/**
 * Determine the max tier for a task based on its kind, role, and policy.
 *
 * Priority: task.max_tier (explicit) > kind mapping > role mapping > policy default
 *
 * @param {object} taskSpec - { kind, assignee, role } from plan data
 * @param {object} policy - resolved tool tier policy
 * @returns {string} tier label (e.g. 'T3')
 */
function resolveTaskTier(taskSpec, policy) {
  // 1. Kind-based tier
  if (taskSpec.kind && KIND_TIER_MAP[taskSpec.kind]) {
    return KIND_TIER_MAP[taskSpec.kind];
  }

  // 2. Role-based tier (from plan-dispatcher role or meeting task type)
  if (taskSpec.role) {
    if (taskSpec.role === 'chief') return policy.chief_max_tier || 'T2';
    if (taskSpec.role === 'proposal') return policy.proposal_max_tier || 'T1';
  }

  // 3. Assignee-based tier from default role map
  if (taskSpec.assignee && DEFAULT_ROLE_TIERS[taskSpec.assignee]) {
    return DEFAULT_ROLE_TIERS[taskSpec.assignee];
  }

  // 4. Fallback to policy default
  return policy.default_worker_tier || 'T3';
}

/**
 * Determine the minimum tier required to execute a step type.
 * @param {string} stepType
 * @returns {string} tier label
 */
function requiredTierForStep(stepType) {
  return STEP_TYPE_TIER_MAP[stepType] || 'T3';
}

/**
 * Check if a tier level allows performing an action at a required tier.
 * @param {string} maxTier - task's max allowed tier (e.g. 'T2')
 * @param {string} requiredTier - tier required for the action (e.g. 'T3')
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkTierAccess(maxTier, requiredTier) {
  const maxLevel = TIER_LEVELS[maxTier];
  const reqLevel = TIER_LEVELS[requiredTier];

  if (maxLevel === undefined || reqLevel === undefined) {
    return { allowed: false, reason: `Unknown tier: ${maxLevel === undefined ? maxTier : requiredTier}` };
  }

  if (maxLevel >= reqLevel) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `step requires ${requiredTier} but task max_tier is ${maxTier}`,
  };
}

/**
 * Build a tier restriction description for the agent's system prompt.
 * Agents are told what tier they operate at so they can self-limit.
 *
 * @param {string} tier - e.g. 'T2'
 * @returns {string} human-readable restriction text
 */
function tierRestrictionPrompt(tier) {
  const level = TIER_LEVELS[tier];
  if (level === undefined) return '';

  const lines = [`## Tool Tier: ${tier}`];

  if (level < 4) lines.push('- You MUST NOT deploy, modify CI/CD, change env vars, or alter DNS.');
  if (level < 3) lines.push('- You MUST NOT modify code, commit, push, create PRs, or run tests.');
  if (level < 2) lines.push('- You MUST NOT create issues, comment on PRs, modify tasks, or write specs.');
  if (level < 1) lines.push('- You MUST NOT read the repository, query issues, or access external data.');

  if (level >= 3) lines.push('- You MAY modify code, commit, push, and create PRs.');
  if (level >= 2 && level < 3) lines.push('- You MAY create issues, comment, modify tasks, and write specs.');
  if (level >= 1 && level < 2) lines.push('- You MAY read the repository, query issues/PRs, and search.');
  if (level === 0) lines.push('- You may only think, analyze, and produce text output.');

  return lines.join('\n');
}

module.exports = {
  TIER_LEVELS,
  DEFAULT_ROLE_TIERS,
  KIND_TIER_MAP,
  STEP_TYPE_TIER_MAP,
  defaultPolicy,
  resolvePolicy,
  resolveTaskTier,
  requiredTierForStep,
  checkTierAccess,
  tierRestrictionPrompt,
};
