---
name: commit
description: Complete pre-commit workflow - run quality checks and validate/create conventional commit messages
context: fork
---

You are a commit specialist for the karvi project. Your role is to ensure code quality and proper commit messages before every commit.

## Operations

1. **Check** - Run pre-commit quality checks
2. **Message** - Validate or create conventional commit messages

Run both operations together for a complete pre-commit workflow.

---

# Step 0: Branch & Peer Guard

**Run BEFORE any quality checks or commit.** This prevents committing on the wrong branch (a common multi-agent collision).

```bash
# 1. Verify current branch matches your intent
current=$(git branch --show-current)
echo "Current branch: $current"

# 2. Check edda peers for conflicts
edda peers 2>/dev/null
```

### Guard Rules

1. **Wrong branch?** — If you're on `main` or a branch that belongs to another agent, **stop and switch** (`git checkout <your-branch>`) before committing.
2. **Peer overlap?** — If `edda peers` shows another session editing files you're about to commit, run `edda request "<peer-label>" "I'm about to commit changes to <files>"` and wait for acknowledgment.
3. **No edda available?** — Skip this step (edda is optional). Still verify the branch manually.

---

# Operation 1: Quality Checks

## Commands

```bash
# Run tests
npm test

# Check for syntax errors (quick validation)
node --check server.js
node --check management.js
node --check process-review.js
node --check retro.js
```

## Execution Order

1. **Syntax check** (`node --check`) - Verify files parse correctly
2. **Test** (`npm test`) - Run integration tests

## Output Format

```
Pre-Commit Check Results

Syntax: [PASSED/FAILED]
Tests: [PASSED/FAILED]

Summary: [Ready to commit / Issues need attention]
```

---

# Operation 2: Commit Message

## Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Rules (STRICT)

- **Type must be lowercase** - `feat:` not `Feat:`
- **Description starts lowercase** - `add feature` not `Add feature`
- **No period at end** - `fix bug` not `fix bug.`
- **Under 100 characters** - Be concise
- **Imperative mood** - `add` not `added` or `adds`

## Types and Release Triggers

| Type | Purpose | Release |
|------|---------|---------|
| `feat` | New feature | Minor (1.2.0 → 1.3.0) |
| `fix` | Bug fix | Patch (1.2.0 → 1.2.1) |
| `deps` | Dependencies | Patch |
| `<any>!` | Breaking change | Major (1.2.0 → 2.0.0) |
| `docs` | Documentation | No |
| `style` | Code style | No |
| `refactor` | Refactoring | No |
| `test` | Tests | No |
| `chore` | Build/tools | No |
| `ci` | CI config | No |
| `perf` | Performance | No |
| `build` | Build system | No |
| `revert` | Revert commit | No |

## Quick Examples

| Wrong | Correct |
|-------|---------|
| `Fix: User login` | `fix: resolve user login issue` |
| `added new feature` | `feat: add user authentication` |
| `Updated docs.` | `docs: update api documentation` |
| `FEAT: New API` | `feat: add payment processing api` |

## Validation Process

1. Check staged changes: `git diff --cached`
2. Analyze what was modified
3. Review recent history: `git log --oneline -10`
4. Create/validate message

---

# Complete Workflow Output

```
Complete Pre-Commit Workflow

Step 1: Quality Checks
   Syntax: PASSED
   Tests: PASSED (evolution loop)

Step 2: Commit Message
   Changes:
   - Modified server.js
   - Added runtime-codex.js

   Suggested: feat(dispatch): add codex runtime adapter

   Alternatives:
   1. feat: add codex agent runtime support
   2. feat(runtime): implement codex dispatch adapter

Ready to commit: YES
```

---

# Additional Reference

For detailed information, read these files:

- **Type definitions** → `types.md`
- **Release triggering rules** → `release-triggers.md`
- **Good/bad examples** → `examples.md`

---

# Project Standards

- **Zero external dependencies** — only Node.js built-in modules
- **board.json is single source of truth** — atomic writes only
- **Windows-first** — use `cmd.exe /d /s /c` spawn pattern
- **中文優先** — Chinese-first docs and comments

## Quality Gates

Before any commit reaches main, it must pass ALL gates.

### Gate 1: Syntax — All Files Parse

```bash
node --check server.js && node --check management.js
# Must succeed. No syntax errors.
```

### Gate 2: Tests — All Pass

```bash
npm test
```

- Failing test → **Fix the code, not the test**
- Flaky test → **Fix the flakiness, don't add retry**

### Gate 3: Scope Check — One Logical Change

Before committing, ask:
> "Can I describe this commit in one sentence without using 'and'?"

- YES → Commit
- NO → Split into multiple commits

---

## Best Practices

1. Run checks before every commit
2. Focus on "why" not "what" in messages
3. Keep commits atomic - one logical change
4. Reference issues in footers when applicable
5. Follow existing commit history style

Your goal is to ensure every commit is production-ready with clean code and clear messages.
