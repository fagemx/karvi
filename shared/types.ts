/**
 * shared/types.ts — Karvi Task Engine Type Definitions
 *
 * Single source of truth for all data structures used by the backend
 * (server/) and future mobile app (app/).
 *
 * Extracted from: server.js, management.js, process-review.js,
 * retro.js, runtime-openclaw.js, runtime-codex.js
 */

// ---------------------------------------------------------------------------
// Enums / Literal Unions
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'pending'
  | 'dispatched'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'reviewing'
  | 'approved'
  | 'needs_revision';

export type DispatchStateValue =
  | 'prepared'
  | 'dispatching'
  | 'completed'
  | 'failed';

export type InsightStatus = 'pending' | 'applied' | 'rolled_back';

export type LessonStatus = 'active' | 'validated' | 'invalidated' | 'superseded';

export type RiskLevel = 'low' | 'medium' | 'high';

export type ActionType = 'controls_patch' | 'dispatch_hint' | 'lesson_write' | 'noop';

export type TurnStatus = 'queued' | 'running' | 'done' | 'error';

export type MessageType = 'system' | 'message' | 'error';

export type RuntimeName = 'openclaw' | 'codex' | 'claude';

export type TaskPlanPhase = 'idle' | 'planning' | 'executing' | 'done';

// ---------------------------------------------------------------------------
// Core Types
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  ts: string;
  status: string;
  by: string;
  reason?: string;
  attempt?: number;
  model?: string;
  update?: Record<string, unknown>;
  issues?: string[];
  from?: string;
  unblockedBy?: string;
  message?: string;
  score?: number;
  event?: string;
}

export interface ReviewResult {
  score: number;
  issues?: string[];
  summary?: string;
  threshold?: number;
  report?: string;
  source?: string;
  verdict?: string;
  reviewedAt?: string;
  attempt?: number;
  error?: string;
}

export interface TaskResult {
  status?: string;
  summary?: string;
  reason?: string;
  prUrl?: string;
  payload?: Record<string, unknown> | null;
}

/** PR metadata — stored on task.pr when a pipeline produces a PR */
export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  url: string;
  outcome: 'merged' | 'closed' | null;
  mergedAt?: string;
  closedAt?: string;
  mergedBy?: string;
  closedBy?: string;
}

// ---------------------------------------------------------------------------
// GitHub PR Types
// ---------------------------------------------------------------------------

export interface GitHubPRSummary {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  user: { login: string; avatar_url: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
}

export interface GitHubPRFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface DispatchState {
  version: number;
  state: DispatchStateValue;
  planId: string;
  runtime: RuntimeName;
  agentId: string;
  model?: string | null;
  timeoutSec: number;
  preparedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  sessionId?: string | null;
  lastError?: string | null;
}

/** Individual task — accessed via GET/POST/PUT /api/tasks */
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string;
  depends?: string[];
  skill?: string;
  type?: string;
  track?: string;
  briefPath?: string;
  startedAt?: string | null;
  completedAt?: string;
  approvedAt?: string;
  lastReply?: string;
  lastReplyAt?: string;
  lastDispatchModel?: string | null;
  reviewAttempts?: number;
  childSessionKey?: string | null;
  dispatch?: DispatchState;
  result?: TaskResult;
  pr?: PRInfo;
  review?: ReviewResult;
  blocker?: { reason: string; askedAt: string } | null;
  history?: HistoryEntry[];
  jiraKey?: string;
  jiraUrl?: string;
  source?: string;
  priority?: string;
}

// ---------------------------------------------------------------------------
// Evolution Types
// ---------------------------------------------------------------------------

/** Signal — embedded in board.signals[] */
export interface Signal {
  id: string;
  ts: string;
  by: string;
  type: string;
  content: string;
  refs: string[];
  data?: Record<string, unknown>;
}

/** Insight — accessed via GET/POST /api/insights */
export interface Insight {
  id: string;
  ts: string;
  by: string;
  about?: string | null;
  judgement: string;
  reasoning?: string | null;
  suggestedAction: {
    type: ActionType;
    payload?: Record<string, unknown> | null;
  };
  risk: RiskLevel;
  status: InsightStatus;
  snapshot?: Record<string, unknown> | null;
  appliedAt?: string | null;
  verifyAfter?: number;
  data?: Record<string, unknown>;
}

/** Lesson — accessed via GET/POST /api/lessons */
export interface Lesson {
  id: string;
  ts: string;
  by: string;
  fromInsight: string;
  rule: string;
  effect?: string | null;
  status: LessonStatus;
  validatedAt?: string | null;
  supersededBy?: string | null;
}

/** Controls — accessed via GET/POST /api/controls */
export interface Controls {
  auto_review: boolean;
  auto_redispatch: boolean;
  max_review_attempts: number;
  quality_threshold: number;
  review_timeout_sec: number;
  review_agent: string;
  auto_apply_insights: boolean;
  dispatch_hints?: DispatchHint[];
  preferred_runtime?: string;
}

export interface DispatchHint {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Conversation Types
// ---------------------------------------------------------------------------

/** Message — element of conversation.messages[] */
export interface Message {
  id: string;
  ts: string;
  type: MessageType;
  from: string;
  to: string;
  text: string;
  turnId?: string;
  sessionId?: string;
}

/** Turn — element of conversation.queue[] */
export interface Turn {
  id: string;
  createdAt: string;
  status: TurnStatus;
  from: string;
  to: string;
  text: string;
  timeoutSec: number;
  result?: { reply: string; sessionId?: string | null };
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  requeuedAt?: string;
  requeueReason?: string;
  history?: unknown[];
  loop?: {
    enabled: boolean;
    pair: [string, string];
    remaining: number;
  };
}

/** Conversation — accessed via GET/POST /api/conversations */
export interface Conversation {
  id: string;
  title: string;
  members: string[];
  status: string;
  settings: {
    autoRunQueue: boolean;
    defaultAutoTurns: number;
  };
  runtime: {
    running: boolean;
    stopRequested: boolean;
    lastRunAt?: string | null;
  };
  sessionIds: Record<string, string | null>;
  queue: Turn[];
  messages: Message[];
}

/** Participant — element of board.participants[] */
export interface Participant {
  id: string;
  type: 'agent' | 'human';
  displayName: string;
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Board (Top-level)
// ---------------------------------------------------------------------------

export interface TaskPlan {
  goal?: string;
  phase?: TaskPlanPhase;
  spec?: string;
  title?: string;
  createdAt?: string;
  tasks: Task[];
}

export interface BoardMeta {
  updatedAt: string;
  boardType: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

/** Jira integration config — stored in board.integrations.jira */
export interface JiraConfig {
  enabled: boolean;
  projectKey: string;
  statusMapping: Record<string, TaskStatus>;
  reverseMapping: Record<string, string>;
  triggerStatus?: string;
  autoDispatchOnCreate?: boolean;
  humanGate: {
    enabled: boolean;
    mergeRequiresHuman: boolean;
  };
}

export interface Integrations {
  jira?: JiraConfig;
}

/** Board — accessed via GET/POST /api/board */
export interface Board {
  taskPlan: TaskPlan;
  conversations: Conversation[];
  participants: Participant[];
  signals: Signal[];
  insights: Insight[];
  lessons: Lesson[];
  lessons_archive?: Lesson[];
  controls: Controls;
  integrations?: Integrations;
  meta: BoardMeta;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** DispatchPlan — produced by management.js buildDispatchPlan() */
export interface DispatchPlan {
  kind: 'task_dispatch';
  version: number;
  planId: string;
  taskId: string;
  mode: 'dispatch' | 'redispatch';
  runtimeHint: RuntimeName;
  agentId: string;
  modelHint?: string | null;
  timeoutSec: number;
  sessionId?: string | null;
  message: string;
  createdAt: string;
  upstreamTaskIds: string[];
  artifacts: unknown[];
  requiredSkills: string[];
  codexRole?: string;
  controlsSnapshot: {
    quality_threshold: number;
    auto_review: boolean;
    auto_redispatch: boolean;
    max_review_attempts: number;
  };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

/** Brief — accessed via GET/POST /api/brief/:taskId */
export interface Brief {
  meta: {
    updatedAt: string;
    boardType: 'brief';
    version: number;
    taskId: string;
  };
  project?: { name: string };
  shotspec?: {
    status: string;
    shots: Array<{
      retries?: number;
      score?: number;
      status?: string;
      [key: string]: unknown;
    }>;
  };
  refpack?: {
    status: string;
    assets: Record<string, unknown>;
  };
  controls?: {
    auto_retry: boolean;
    max_retries: number;
    quality_threshold: number;
    paused: boolean;
  };
  log?: unknown[];
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** RuntimeResult — returned by runtime-*.js dispatch() */
export interface RuntimeResult {
  code: number;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown> | null;
  sessionId?: string | null;
}

// ---------------------------------------------------------------------------
// L3 Timeline Types
// ---------------------------------------------------------------------------

export type TimelineNodeType =
  | 'dispatch'    // agent dispatched
  | 'status'      // status transition
  | 'decision'    // automated decision (insight applied)
  | 'supersede'   // decision/lesson superseded or rolled back
  | 'policy'      // lesson validated / policy extracted
  | 'review'      // review result
  | 'note'        // general note / log entry
  | 'error';      // error event

export interface TimelineNodeRefs {
  supersedes?: string | null;
  supersededBy?: string | null;
  insightId?: string | null;
  lessonId?: string | null;
}

/** TimelineNode — unified timeline entry for L3 deep timeline */
export interface TimelineNode {
  id: string;
  ts: string;
  type: TimelineNodeType;
  title: string;
  detail?: string;
  source: 'history' | 'signal' | 'insight' | 'lesson' | 'dispatch' | 'review';
  refs: TimelineNodeRefs;
  meta?: Record<string, unknown>;
}

/** DeliveryReport — exportable task delivery report */
export interface DeliveryReport {
  version: 'delivery_report.v1';
  taskId: string;
  generatedAt: string;
  summary: {
    title: string;
    status: string;
    score: number | null;
    durationMin: number | null;
    decisionCount: number;
    supersededCount: number;
    lessonsApplied: number;
  };
  timeline: TimelineNode[];
  digest?: object | null;
}
