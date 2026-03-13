/**
 * management.js — 演化層入口（thin re-export facade）
 *
 * 拆分後的子模組：
 *   management/insights.js  — insight apply / auto-apply / verify
 *   management/lessons.js   — lesson matching + preflight
 *   management/evolution.js — evolution fields, signal trim, edda, skill context
 *   management/dispatch.js  — dispatch plan, model resolution, message building,
 *                             task transitions, step pipeline, pick/unlock
 *
 * 所有 require('./management') 的呼叫點無需改動。
 */

// --- Controls (kept in this file — very small, widely imported) ---
const DEFAULT_CONTROLS = {
  auto_dispatch: false,
  auto_review: true,
  auto_redispatch: false,
  max_review_attempts: 3,
  quality_threshold: 70,
  review_timeout_sec: 180,
  review_agent: 'engineer_lite',
  auto_apply_insights: true,
  use_step_pipeline: true,        // DEPRECATED: all dispatch now uses step pipeline (kept for backward compat)
  telemetry_enabled: true,
  usage_limits: null,            // { dispatches_per_month, runtime_sec_per_month, tokens_per_month }
  usage_alert_threshold: 0.8,    // Alert when usage > 80% of limit
  max_concurrent_tasks: 2,       // max in-progress tasks at once (worktree or not)
  max_concurrent_by_type: null,  // { plan: 3, implement: 2, review: 2, test: 1 } or null
  active_wave: null,             // null = all waves, integer = only that wave
  use_worktrees: true,           // create git worktree per task for parallel execution
  target_repo: null,             // absolute path to target repo (null = karvi itself / dogfood mode)
  repo_map: {},                  // GitHub slug → local absolute path, e.g. { "owner/repo": "C:/path/to/repo" }
  auto_merge_on_approve: false,  // when true, auto squash-merge PR after review LGTM
  event_webhook_url: null,       // POST step events to this URL (null = disabled)
  runtime_fallback_chain: null,  // ordered runtime list for fallback on PROVIDER errors, e.g. ["opencode", "codex", "claude"]
  model_map: {},                  // { "opencode": { "plan": "anthropic/claude-opus-4", "default": "anthropic/claude-sonnet-4" }, "codex": { ... } }
  cost_routing: null,             // { tiers: [{ budget_pct_remaining: 50, model_map: { opencode: { default: "provider/model" } } }] }
  step_timeout_sec: {
    plan: 300,
    implement: 600,
    review: 300,
    test: 300,
    execute: 600,   // same as implement — full task execution
    default: 300
  },
  signal_max_count: 500,              // max signals kept in board.json; overflow archived to signal-archive.jsonl
  hooks_after_worktree_create: '',    // shell command run after worktree created
  hooks_before_run: '',               // shell command run before agent starts
  hooks_after_run: '',                // shell command run after agent completes
  budget_per_task: null,              // max cost per task in USD (null = unlimited)
  sandbox_enabled: false,             // enable Docker container sandbox for agent execution
  sandbox_image: 'karvi-sandbox:latest', // Docker image for sandbox containers
  sandbox_limits: null,               // override sandbox resource limits { memory, cpus, pids_limit, network, ... }
};

function getControls(board) {
  return { ...DEFAULT_CONTROLS, ...(board.controls || {}) };
}

// --- Sub-module re-exports ---
const insights = require('./management/insights');
const lessons = require('./management/lessons');
const evolution = require('./management/evolution');
const dispatch = require('./management/dispatch');

module.exports = {
  // Controls (this file)
  DEFAULT_CONTROLS,
  getControls,

  // Insights
  VALID_ACTION_TYPES: insights.VALID_ACTION_TYPES,
  VALID_RISK_LEVELS: insights.VALID_RISK_LEVELS,
  applyInsightAction: insights.applyInsightAction,
  snapshotControls: insights.snapshotControls,
  autoApplyInsights: insights.autoApplyInsights,
  verifyAppliedInsights: insights.verifyAppliedInsights,

  // Lessons
  VALID_LESSON_STATUSES: lessons.VALID_LESSON_STATUSES,
  matchLessonsForTask: lessons.matchLessonsForTask,
  buildPreflightSection: lessons.buildPreflightSection,

  // Evolution
  ensureEvolutionFields: evolution.ensureEvolutionFields,
  trimSignals: evolution.trimSignals,
  loadEddaDecisions: evolution.loadEddaDecisions,
  buildProtectedDecisionsSection: evolution.buildProtectedDecisionsSection,
  buildSkillContextSection: evolution.buildSkillContextSection,
  buildCompletionCriteriaSection: evolution.buildCompletionCriteriaSection,

  // Dispatch
  DISPATCH_PLAN_VERSION: dispatch.DISPATCH_PLAN_VERSION,
  VALID_DISPATCH_STATES: dispatch.VALID_DISPATCH_STATES,
  SKILL_ROLE_MAP: dispatch.SKILL_ROLE_MAP,
  DEFAULT_CODEX_ROLE: dispatch.DEFAULT_CODEX_ROLE,
  AGENT_MODEL_MAP: dispatch.AGENT_MODEL_MAP,
  ALLOWED_TASK_TRANSITIONS: dispatch.ALLOWED_TASK_TRANSITIONS,
  preferredModelFor: dispatch.preferredModelFor,
  validateModelHint: dispatch.validateModelHint,
  budgetPctRemaining: dispatch.budgetPctRemaining,
  resolveCostRoutingModel: dispatch.resolveCostRoutingModel,
  canTransitionTaskStatus: dispatch.canTransitionTaskStatus,
  ensureTaskTransition: dispatch.ensureTaskTransition,
  parseTaskResultFromLastLine: dispatch.parseTaskResultFromLastLine,
  readSpecContent: dispatch.readSpecContent,
  gatherUpstreamArtifacts: dispatch.gatherUpstreamArtifacts,
  buildTaskDispatchMessage: dispatch.buildTaskDispatchMessage,
  buildRedispatchMessage: dispatch.buildRedispatchMessage,
  buildDispatchPlan: dispatch.buildDispatchPlan,
  resolveOwnerId: dispatch.resolveOwnerId,
  pickNextTask: dispatch.pickNextTask,
  autoUnlockDependents: dispatch.autoUnlockDependents,
  resolvePipeline: dispatch.resolvePipeline,
  normalizePipelineEntry: dispatch.normalizePipelineEntry,
  generateStepsForTask: dispatch.generateStepsForTask,
  DEFAULT_STEP_PIPELINE: dispatch.DEFAULT_STEP_PIPELINE,
  BUILT_IN_TEMPLATES: dispatch.BUILT_IN_TEMPLATES,
};
