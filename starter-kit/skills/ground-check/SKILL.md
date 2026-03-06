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
- A task description: `"implement cascade logic for chain combos"`
- A spec doc path: `docs/05-data-formats.md`
- An issue number: `#15`
- A feature idea: `"add AI chat engine with context memory"`

## What This Skill Does

1. **Reads the task** — understands what needs to be built
2. **Scans actual code** — checks what exists today in the codebase
3. **Reports readiness** — concrete findings, not theoretical analysis
4. **Identifies the gap** — when something isn't ready, names the specific missing piece

## Output Categories

### Ready (can start now)

Infrastructure exists. You can start coding this today.
- Required functions/modules are implemented (not stubs)
- Required API endpoints or interfaces are live
- Required data structures exist
- Prerequisite work is done

### Almost (one piece away)

80%+ foundation exists, but one specific thing is missing.
- Report EXACTLY what's missing (file, function, interface, data field)
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
- **Required interfaces**: Which APIs, types, or contracts must be available?
- **Required data structures**: What schemas, config files, or data formats?
- **Required file layouts**: What directory structure must exist?
- **Required prior work**: What must be built first?

If the task references an issue, read it:
```bash
gh issue view <issue-id> --json title,body
```

If the task references a spec doc, read it directly.

### Step 2: Understand Project Context

**Read `.claude/project.yaml`** for project configuration.
**Read `.claude/CLAUDE.md`** for project structure, conventions, and architecture.

### Step 3: Check Each Requirement Against Code

For each requirement, verify in the actual codebase:

**Functions & Exports**
```bash
# Does the function/class exist?
grep -rn "function <name>\|class <name>\|export.*<name>" --include="*.ts" --include="*.js" .

# Is it a stub or real implementation?
grep -rn "TODO\|FIXME\|throw.*not implemented" --include="*.ts" --include="*.js" .
```

**Data Structures**
```bash
# Do the required types/interfaces exist?
grep -rn "interface <name>\|type <name>" --include="*.ts" .

# Do the required data files exist?
ls data/ docs/ 2>/dev/null
```

**Dependencies Between Modules**
```bash
# What does this module import?
grep -rn "import.*from\|require(" <target-file>

# What imports this module?
grep -rn "from.*<module-name>" --include="*.ts" --include="*.js" .
```

**Test Coverage**
```bash
# Do tests exist for the target module?
find . -name "*<module-name>*test*" -o -name "*<module-name>*spec*" 2>/dev/null
```

### Step 4: Verify Build Health

Run the project's quality checks from project.yaml:

```bash
# Syntax check (from project.yaml quality.syntax_check)
# Test suite (from project.yaml quality.test_command)
```

If project.yaml doesn't exist, try common defaults:
```bash
npm test 2>/dev/null || npx vitest run 2>/dev/null
```

### Step 5: Report

Generate the report:

```markdown
## Ground Check: <task name>

### Prerequisites

| Requirement | Status | Detail |
|------------|--------|--------|
| board.ts core module | Ready | Board class implemented with full API |
| match.ts detection | Ready | matchThree() and matchPattern() exist |
| cascade.ts chain logic | Almost | cascade() exists but missing combo counter |
| special.ts gem rules | Not Ready | File doesn't exist yet |

### Verdict

**Almost ready** — 1 blocker: special gem generation rules not implemented.

### Recommended Action

1. Create special.ts following match.ts pattern → then this task is fully ready
2. OR: start with basic cascade logic, add special gems later

### Buildable Sub-Pieces

Even without the blocker, these parts are buildable now:
- Basic cascade drop logic
- Chain counter
- Unit tests for simple cascades
```

## Task Types

### New Feature
Check if the API endpoints, data structures, and module functions needed already exist.

### Refactoring
Check what depends on the code being refactored (blast radius — grep for function/export usage).

### Bug Fix
Check if tests exist for the affected code path.

### Integration
Check if both sides of the integration are implemented.

The scan procedure is the same — always check actual code, not just docs.

## What This Skill Does NOT Do

- Does NOT suggest what to build (use issue-scan for that)
- Does NOT create issues or PRs
- Does NOT modify code
- Does NOT evaluate design quality — only infrastructure readiness
