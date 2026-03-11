# Karvi API Reference

Complete API documentation with curl examples for all major endpoints.

**Base URL**: `http://localhost:3461` (default port)

**Authentication**: Set `KARVI_API_TOKEN` env var, then include `Authorization: Bearer <token>` header.

---

## Table of Contents

- [Project Management](#project-management)
  - [POST /api/projects](#post-apiprojects)
- [Task Management](#task-management)
  - [POST /api/tasks/:id/dispatch](#post-apitasksiddispatch)
  - [POST /api/tasks/:id/status](#post-apitasksidstatus)
  - [POST /api/tasks/:id/unblock](#post-apitasksidunblock)
  - [POST /api/tasks/:id/update](#post-apitasksidupdate)
  - [POST /api/tasks](#post-apitasks)
  - [GET /api/tasks](#get-apitasks)
  - [POST /api/tasks/dispatch](#post-apitasksdispatch)
  - [POST /api/dispatch-next](#post-apidispatch-next)
- [Board & Events](#board--events)
  - [GET /api/board](#get-apiboard)
  - [GET /api/events](#get-apievents)
  - [GET /api/status](#get-apistatus)
- [Controls](#controls)
  - [GET /api/controls](#get-apicontrols)
  - [POST /api/controls](#post-apicontrols)
- [Evolution Layer](#evolution-layer)
  - [POST /api/retro](#post-apiretro)
- [Vault (Secrets)](#vault-secrets)
  - [GET /api/vault/status](#get-apivaultstatus)
  - [POST /api/vault/store](#post-apivaultstore)
  - [GET /api/vault/keys/:userId](#get-apivaultkeysuserid)
  - [DELETE /api/vault/delete/:userId/:keyName](#delete-apivaultdeleteuseridkeyname)

---

## Project Management

### POST /api/projects

Create a new project with tasks. This is the canonical endpoint for setting up work.

**Request Body Fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Project title |
| `repo` | string | No* | Repository URL (required to create project entity) |
| `tasks` | array | Yes | Array of task objects |
| `concurrency` | number | No | Max parallel tasks (default: 3) |
| `completionTrigger` | string | No | `"pr_merged"` or `"approved"` (default: `"pr_merged"`) |
| `autoStart` | boolean | No | Auto-dispatch first ready task |
| `goal` | string | No | Overall goal description |
| `spec` | string | No | Specification content |

**Task Format (id-based)**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes* | Unique task ID (e.g., `"T1"`, `"GH-123"`) |
| `title` | string | No | Task title |
| `assignee` | string | No | Agent ID to assign |
| `depends` | array | No | Array of task IDs this depends on |
| `skill` | string | No | Skill to invoke |
| `target_repo` | string | No | Override repo for this task |
| `runtimeHint` | string | No | Runtime: `"claude"`, `"opencode"`, `"codex"`, `"edda"` |
| `modelHint` | string | No | Model override |

**Task Format (issue-based, legacy)**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issue` | number | Yes* | GitHub issue number (auto-converts to `GH-{number}`) |
| `title` | string | No | Task title |
| `depends` | array | No | Array of issue numbers or task IDs |

*Use either `id` OR `issue`, not both.

#### Example: Basic Project

```bash
curl -X POST http://localhost:3461/api/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Sprint 1 Tasks",
    "repo": "https://github.com/user/repo",
    "tasks": [
      { "id": "T1", "title": "Setup database", "assignee": "engineer" },
      { "id": "T2", "title": "Add authentication", "depends": ["T1"], "assignee": "engineer" },
      { "id": "T3", "title": "Write tests", "depends": ["T1", "T2"], "assignee": "engineer" }
    ]
  }'
```

**Response (201)**:

```json
{
  "ok": true,
  "title": "Sprint 1 Tasks",
  "taskCount": 3,
  "project": {
    "id": "PROJ-1704067200000-abc123",
    "title": "Sprint 1 Tasks",
    "repo": "https://github.com/user/repo",
    "status": "executing",
    "concurrency": 3,
    "completionTrigger": "pr_merged",
    "taskIds": ["T1", "T2", "T3"],
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "progress": {
    "total": 3,
    "done": 0,
    "in_progress": 0,
    "pending": 2,
    "blocked": 0,
    "pct": 0
  }
}
```

#### Example: Advanced Options

```bash
curl -X POST http://localhost:3461/api/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Feature Implementation",
    "repo": "https://github.com/user/main-repo",
    "concurrency": 2,
    "completionTrigger": "approved",
    "autoStart": true,
    "tasks": [
      {
        "id": "GH-100",
        "title": "Implement login flow",
        "skill": "issue-plan",
        "target_repo": "https://github.com/user/auth-service",
        "runtimeHint": "claude",
        "assignee": "engineer"
      }
    ]
  }'
```

#### Example: Issue-based Tasks (Legacy)

```bash
curl -X POST http://localhost:3461/api/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "GitHub Issues Sprint",
    "repo": "https://github.com/user/repo",
    "tasks": [
      { "issue": 100, "title": "Fix login bug", "assignee": "engineer" },
      { "issue": 101, "depends": [100], "assignee": "engineer" }
    ]
  }'
```

#### Common Errors

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `"title is required"` | Missing title field |
| 400 | `"tasks array is required and must not be empty"` | Missing or empty tasks |
| 400 | `"duplicate task id: T1"` | Two tasks with same ID |
| 400 | `"circular dependency detected in tasks"` | Task A depends on B, B depends on A |
| 400 | `"completionTrigger must be pr_merged or approved"` | Invalid trigger value |
| 400 | `"task must have either 'issue' (number) or 'id' (string)"` | Missing both id and issue |

---

## Task Management

### POST /api/tasks/:id/dispatch

Dispatch a single task to its assigned agent.

**Request Body Fields** (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `runtimeHint` | string | Override runtime: `"claude"`, `"opencode"`, `"codex"`, `"edda"` |
| `runtimeOverride` | string | Force specific runtime (bypasses auto-selection) |

#### Example: Basic Dispatch

```bash
curl -X POST http://localhost:3461/api/tasks/T1/dispatch
```

**Response (200)**:

```json
{
  "ok": true,
  "taskId": "T1",
  "dispatched": true,
  "planId": "plan-1704067200000-abc123",
  "mode": "step-pipeline"
}
```

#### Example: With Runtime Hint

```bash
curl -X POST http://localhost:3461/api/tasks/T1/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"runtimeHint": "claude"}'
```

#### Common Errors

| Status | Error | Cause |
|--------|-------|-------|
| 404 | `"Task T1 not found"` | Task ID doesn't exist |
| 400 | `"assignee not agent"` | Task has no agent assignee |
| 400 | `"dispatch already in progress"` | Concurrent dispatch attempt |

---

### POST /api/tasks/:id/status

Manually update a task's status. Useful for unblocking tasks or marking completion.

**Request Body Fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | Yes | New status (see valid values below) |

**Valid Status Values**:
- `pending` - Waiting for dependencies
- `dispatched` - Ready to dispatch
- `in_progress` - Currently executing
- `blocked` - Blocked, needs human input
- `completed` - Work finished, awaiting review
- `reviewing` - Under review
- `approved` - Passed review, done
- `needs_revision` - Review failed, needs fixes
- `cancelled` - Cancelled

#### Example: Unblock a Blocked Task

```bash
curl -X POST http://localhost:3461/api/tasks/T1/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "in_progress"}'
```

**Response (200)**:

```json
{
  "ok": true,
  "task": {
    "id": "T1",
    "title": "Setup database",
    "status": "in_progress",
    "assignee": "engineer"
  }
}
```

#### Example: Mark as Approved

```bash
curl -X POST http://localhost:3461/api/tasks/T1/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "approved"}'
```

**Note**: Setting status to `approved` automatically unlocks dependent tasks.

#### Common Errors

| Status | Error | Cause |
|--------|-------|-------|
| 404 | `"Task T1 not found"` | Task ID doesn't exist |
| 400 | `"Invalid status..."` | Status not in valid list |
| 400 | `"cannot transition from X to Y"` | Invalid state transition |

---

### POST /api/tasks/:id/unblock

Send a message to unblock a blocked task and resume execution.

**Request Body Fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Human's response to the blocker |

#### Example

```bash
curl -X POST http://localhost:3461/api/tasks/T1/unblock \
  -H 'Content-Type: application/json' \
  -d '{"message": "Use PostgreSQL instead of MySQL. The connection string is in vault."}'
```

**Response (200)**:

```json
{
  "ok": true,
  "task": {
    "id": "T1",
    "status": "in_progress",
    "blocker": null
  }
}
```

---

### POST /api/tasks/:id/update

Update multiple task fields at once.

**Request Body Fields** (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | New status |
| `result` | object | Result object with `summary` |
| `blocker` | object | Blocker with `reason` |
| `childSessionKey` | string | Session ID for continuation |

#### Example

```bash
curl -X POST http://localhost:3461/api/tasks/T1/update \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "completed",
    "result": { "summary": "Database schema created with 5 tables" }
  }'
```

---

### POST /api/tasks

Create or update the task plan (bulk operation).

**Request Body Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `goal` | string | Overall goal |
| `phase` | string | Current phase |
| `tasks` | array | Array of task objects |

#### Example

```bash
curl -X POST http://localhost:3461/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "goal": "Implement user authentication",
    "phase": "executing",
    "tasks": [
      { "id": "T1", "title": "Setup OAuth", "status": "in_progress" },
      { "id": "T2", "title": "Add JWT tokens", "status": "pending", "depends": ["T1"] }
    ]
  }'
```

---

### GET /api/tasks

Get the current task plan.

```bash
curl http://localhost:3461/api/tasks
```

**Response (200)**:

```json
{
  "goal": "Implement user authentication",
  "phase": "executing",
  "tasks": [
    {
      "id": "T1",
      "title": "Setup OAuth",
      "status": "in_progress",
      "assignee": "engineer",
      "depends": []
    }
  ]
}
```

---

### POST /api/tasks/dispatch

Bulk dispatch all ready tasks (status = `dispatched`, dependencies met).

```bash
curl -X POST http://localhost:3461/api/tasks/dispatch
```

**Response (200)**:

```json
{
  "ok": true,
  "dispatched": ["T1", "T4"],
  "skipped": ["T2"],
  "reasons": {
    "T2": "dependencies not met"
  }
}
```

---

### POST /api/dispatch-next

Dispatch the next ready task sequentially (one at a time).

```bash
curl -X POST http://localhost:3461/api/dispatch-next
```

**Response (200)**:

```json
{
  "ok": true,
  "dispatched": "T1",
  "planId": "plan-xxx"
}
```

---

## Board & Events

### GET /api/board

Get the complete board.json (single source of truth).

```bash
curl http://localhost:3461/api/board
```

**Response Structure**:

```json
{
  "meta": {
    "boardType": "karvi",
    "version": 1
  },
  "taskPlan": {
    "goal": "...",
    "phase": "executing",
    "tasks": [...]
  },
  "projects": [...],
  "participants": [...],
  "conversations": [...],
  "controls": {...},
  "signals": [...],
  "insights": [...],
  "lessons": [...]
}
```

**Key Fields**:

| Field | Description |
|-------|-------------|
| `taskPlan` | Task definitions and status |
| `projects` | Project entities with progress |
| `participants` | Agents and humans |
| `conversations` | Chat history |
| `controls` | System configuration |
| `signals` | Event log (last 500) |
| `insights` | Detected patterns |
| `lessons` | Validated learnings |

---

### GET /api/events

Server-Sent Events (SSE) stream for real-time updates.

```bash
curl -N http://localhost:3461/api/events
```

**Event Types**:

| Type | Description |
|------|-------------|
| `board` | Full board update |
| `task_progress` | Task status change |
| `village_meeting` | Meeting triggered |
| `step_update` | Step pipeline progress |

**Event Format**:

```
event: board
data: {"taskPlan":{"tasks":[...]}}

event: task_progress
data: {"taskId":"T1","status":"in_progress"}
```

---

### GET /api/status

Aggregated status snapshot.

**Query Parameters**:

| Param | Description |
|-------|-------------|
| `fields` | Comma-separated: `core,steps,errors,metrics,events` or `all` |

```bash
curl "http://localhost:3461/api/status?fields=core,errors"
```

**Response (200)**:

```json
{
  "instance_id": "hostname",
  "ts": "2024-01-01T00:00:00.000Z",
  "core": {
    "summary": {
      "active": 2,
      "succeeded": 5,
      "failed": 1
    },
    "tasks": [
      {
        "id": "T1",
        "title": "Setup",
        "status": "in_progress",
        "step": "implement",
        "progress": "2/3",
        "age": "15m"
      }
    ]
  },
  "errors": [...]
}
```

---

## Controls

### GET /api/controls

Get current control settings.

```bash
curl http://localhost:3461/api/controls
```

**Response (200)**:

```json
{
  "auto_dispatch": true,
  "auto_review": true,
  "auto_redispatch": true,
  "max_review_attempts": 3,
  "quality_threshold": 85,
  "max_concurrent_tasks": 2,
  "use_step_pipeline": true,
  "use_worktrees": true
}
```

---

### POST /api/controls

Update control settings (partial merge).

```bash
curl -X POST http://localhost:3461/api/controls \
  -H 'Content-Type: application/json' \
  -d '{
    "auto_dispatch": true,
    "auto_review": true,
    "max_concurrent_tasks": 3,
    "quality_threshold": 85
  }'
```

**Response (200)**:

```json
{
  "ok": true,
  "controls": {
    "auto_dispatch": true,
    "auto_review": true,
    "max_concurrent_tasks": 3,
    "quality_threshold": 85
  }
}
```

**Available Controls**:

| Control | Type | Default | Description |
|---------|------|---------|-------------|
| `auto_dispatch` | boolean | false | Auto-dispatch ready tasks |
| `auto_review` | boolean | true | Auto-review completed tasks |
| `auto_redispatch` | boolean | true | Auto-retry failed reviews |
| `max_review_attempts` | number | 3 | Max retry attempts |
| `quality_threshold` | number | 85 | Review score threshold |
| `max_concurrent_tasks` | number | 2 | Parallel task limit |
| `use_step_pipeline` | boolean | true | Enable step pipeline |
| `use_worktrees` | boolean | true | Create git worktrees |
| `auto_merge_on_approve` | boolean | false | Auto-merge approved PRs |

---

## Evolution Layer

### POST /api/retro

Trigger retrospective analysis to detect patterns and generate insights.

```bash
curl -X POST http://localhost:3461/api/retro
```

**Response (200)**:

```json
{
  "ok": true,
  "analyzed": 15,
  "insights": [
    {
      "id": "INS-001",
      "pattern": "Tasks with unclear specs take 3x longer",
      "suggestedAction": "Add spec template requirement",
      "risk": "low"
    }
  ]
}
```

---

## Vault (Secrets)

Encrypted secret storage. Requires `KARVI_VAULT_KEY` environment variable.

### GET /api/vault/status

Check if vault is enabled.

```bash
curl http://localhost:3461/api/vault/status
```

**Response (200)**:

```json
{
  "enabled": true
}
```

---

### POST /api/vault/store

Store a secret value.

**Request Body Fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | string | Yes | User identifier (alphanumeric, dash, underscore) |
| `keyName` | string | Yes | Secret key name |
| `value` | string | Yes | Secret value |

```bash
curl -X POST http://localhost:3461/api/vault/store \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "default",
    "keyName": "GITHUB_PAT",
    "value": "ghp_xxxxxxxxxxxxxxxxxxxx"
  }'
```

**Response (200)**:

```json
{
  "ok": true,
  "userId": "default",
  "keyName": "GITHUB_PAT"
}
```

---

### GET /api/vault/keys/:userId

List stored key names for a user (values not returned).

```bash
curl http://localhost:3461/api/vault/keys/default
```

**Response (200)**:

```json
{
  "ok": true,
  "userId": "default",
  "keys": ["GITHUB_PAT", "OPENAI_API_KEY"]
}
```

---

### DELETE /api/vault/delete/:userId/:keyName

Delete a stored secret.

```bash
curl -X DELETE http://localhost:3461/api/vault/delete/default/GITHUB_PAT
```

**Response (200)**:

```json
{
  "ok": true,
  "deleted": true
}
```

---

## Error Response Format

All errors follow this format:

```json
{
  "error": "Human-readable error message"
}
```

Common HTTP status codes:
- `400` - Bad request (invalid input)
- `404` - Not found
- `409` - Conflict (e.g., duplicate, already exists)
- `422` - Unprocessable entity
- `500` - Server error
- `503` - Service unavailable (e.g., vault not configured)
