---
name: ground-check
description: "Check if codebase supports a planned task — what's ready, what's close, what's missing"
---

# Ground Check

Before starting any task, verify what the codebase actually supports today. This skill bridges the gap between plans and executable reality.

## Usage

```
ground-check <task>
```

Where `<task>` is any of:
- A board task ID: `T3` or `task-review-pipeline`
- A task description: `"implement SSE heartbeat for dashboard"`
- A spec doc path: `spec/evolution-pipeline.md`
- An issue number: `#15`
- A feature idea: `"add runtime adapter for new agent type"`

## What This Skill Does

1. **Reads the task** — understands what needs to be built
2. **Scans actual code** — checks what exists today in the codebase
3. **Reports readiness** — concrete findings, not theoretical analysis
4. **Identifies the gap** — when something isn't ready, names the specific missing piece

## Output Categories

### Ready (can start now)

Infrastructure exists. You can start coding this today.
- Required functions/modules are implemented (not stubs)
- Required API endpoints are live and tested
- Required data structures (board.json schema, task lifecycle) exist
- Server starts clean
- Prerequisite work is done

### Almost (one piece away)

80%+ foundation exists, but one specific thing is missing.
- Report EXACTLY what's missing (file, function, API endpoint, data field)
- Estimate effort to fill the gap (trivial / small / medium)
- Suggest: fill the gap first, or work around it?

### Not Ready (foundation missing)

Prerequisite work hasn't been done yet.
- Identify which prerequisite needs to be done first
- Trace the dependency chain back to something that IS ready
- Report the shortest path from "ready" to "this task"

## Scan Procedure

### Step 1: Parse the Task

Read the task definition. Extract:
- **Required functions**: What exported functions/modules does this need?
- **Required API endpoints**: Which HTTP endpoints must be available?
- **Required data structures**: What board.json fields, task properties, signal types?
- **Required file layouts**: What `board.json`, `briefs/`, `task-log.jsonl` structures must exist?
- **Required design constraints**: What architecture rules apply? (zero deps, atomic writes, etc.)
- **Required prior work**: What must be built first?

If the task references a board task, read it from the running server:
```bash
curl -s http://localhost:3461/api/board | jq '.taskPlan.tasks[] | select(.id == "<task-id>")'
```

If the task references a spec doc, read it:
```bash
cat spec/<doc-name>.md
```

### Step 2: Check Each Requirement Against Code

For each requirement, verify in the actual codebase:

**Functions & Exports**
```bash
# Does the function exist?
grep -rn "function <funcName>" *.js
grep -rn "module\.exports" *.js

# Is it a stub or real implementation?
# Look for TODO, FIXME, or empty function bodies
grep -rn "TODO\|FIXME\|throw.*not implemented" *.js
```

**API Endpoints**
```bash
# Does the endpoint exist in server.js?
grep -n "url.*===\|pathname.*===\|method.*===" server.js

# What HTTP methods does it handle?
grep -n "req.method" server.js

# Does it return the expected response format?
grep -A5 "<endpoint-path>" server.js
```

**Data Structures**
```bash
# Does the board.json schema include what we need?
# Check how tasks/signals/controls are structured
grep -rn "task\.\|signal\.\|control\." server.js management.js

# Check task lifecycle state machine
grep -n "status.*===\|status.*!=" server.js

# Check signal types
grep -n "type.*===" management.js process-review.js
```

**File Operations**
```bash
# Board atomic writes (tmp + rename pattern)
grep -n "writeFileSync\|renameSync\|tmp" server.js management.js

# Task log append
grep -n "appendFileSync\|task-log" server.js

# Brief generation
grep -rn "briefs/\|brief" server.js
```

**Design Constraint Compliance**
```bash
# ZERO-DEP: No require() of external packages
grep -n "require(" *.js | grep -v "node:" | grep -v "require('http')\|require('fs')\|require('path')\|require('child_process')\|require('url')\|require('crypto')"

# ATOMIC-WRITE: board.json writes use tmp+rename
grep -B2 -A2 "board.json" server.js management.js

# WINDOWS-SPAWN: Uses cmd.exe /d /s /c pattern
grep -n "spawn\|exec" runtime-*.js server.js

# SSE-FORMAT: Events follow proper SSE format
grep -n "data:\|event:\|text/event-stream" server.js
```

### Step 3: Cross-Reference Dependencies

Check the module dependency flow:
```
Board state → Task dispatch → Runtime execution → Review → Evolution
```

Module relationships:
```
server.js (HTTP + SSE + dispatch)
  → management.js (evolution: controls, insights, lessons)
  → process-review.js (task quality review)
  → retro.js (pattern detection → insights)
  → runtime-*.js (agent runtime adapters)
```

For each prerequisite:
- Source files exist AND have real implementations
- Server starts without errors
- No TODO/FIXME in the paths this task will call

### Step 4: Verify Server Health

```bash
# Does the server start?
node --check server.js

# Quick smoke test (if server is running)
curl -s http://localhost:3461/api/board | jq '.taskPlan.goal' 2>/dev/null

# Check for syntax errors in all source files
for f in server.js management.js process-review.js retro.js runtime-*.js; do
  node --check "$f" 2>&1
done
```

### Step 5: Report

Generate the report:

```markdown
## Ground Check: <task name>

### Prerequisites

| Requirement | Status | Detail |
|------------|--------|--------|
| server.js dispatch endpoint | Ready | POST /api/tasks/:id/dispatch implemented |
| management.js controls | Ready | readControls() in management.js |
| process-review scoring | Almost | reviewTask() exists, score threshold missing |
| runtime-newagent.js | Not Ready | Adapter file doesn't exist yet |

### Design Constraints

| Rule | Applies | Status |
|------|---------|--------|
| Zero dependencies | Yes | Ready — no external require() |
| Atomic board writes | Yes | Ready — tmp+rename in server.js |
| Windows spawn | Yes | Almost — spawn exists but no cmd.exe wrapper |

### Verdict

**Almost ready** — 1 blocker: runtime adapter for new agent not implemented.

### Recommended Action

1. Create runtime-newagent.js following runtime-openclaw.js pattern → then this task is fully ready
2. OR: start with parts that use existing runtimes

### Buildable Sub-Pieces

Even without the blocker, these parts are buildable now:
- New API endpoint in server.js
- Board schema extension
- SSE event for new status type
```

## Ongoing Development Mode

For tasks beyond initial setup (new features, refactoring, bug fixes):

1. **New feature**: Check if the API endpoints, data structures, and module functions needed already exist
2. **Refactoring**: Check what depends on the code being refactored (blast radius — grep for function/export usage)
3. **Bug fix**: Check if tests exist for the affected code path
4. **Integration**: Check if both sides of the integration are implemented

The scan procedure is the same — always check actual code, not just docs.

## What This Skill Does NOT Do

- Does NOT suggest what to build (that's `/path-forward`)
- Does NOT create issues or PRs
- Does NOT modify code
- Does NOT evaluate design quality — only infrastructure readiness

## References

- Project overview: `CLAUDE.md`
- Architecture docs: `docs/`
- Spec docs: `spec/`
- Board state: `http://localhost:3461/api/board`
