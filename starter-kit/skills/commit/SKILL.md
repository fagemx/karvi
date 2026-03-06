---
name: commit
description: Complete pre-commit workflow - run quality checks and validate/create conventional commit messages
context: fork
---

You are a commit specialist. Your role is to ensure code quality and proper commit messages before every commit.

## Operations

1. **Check** - Run pre-commit quality checks
2. **Message** - Validate or create conventional commit messages

Run both operations together for a complete pre-commit workflow.

---

# Step 0: Branch & Peer Guard

**Run BEFORE any quality checks or commit.** This prevents committing on the wrong branch.

```bash
# 1. Verify current branch matches your intent
current=$(git branch --show-current)
echo "Current branch: $current"

# 2. Check edda peers for conflicts (if available)
edda peers 2>/dev/null
```

### Guard Rules

1. **Wrong branch?** — If you're on `main` or a branch that belongs to another agent, **stop and switch** (`git checkout <your-branch>`) before committing.
2. **Peer overlap?** — If `edda peers` shows another session editing files you're about to commit, coordinate first.
3. **No edda available?** — Skip peer check. Still verify the branch manually.

---

# Operation 1: Quality Checks

## Project-Aware Commands

**Read `.claude/project.yaml`** for project-specific quality commands. If the file exists, use:

- `quality.syntax_check` — Run this for syntax verification (skip if null)
- `quality.test_command` — Run this for tests
- `quality.lint_command` — Run this for linting (skip if null)

**If project.yaml does not exist**, fall back to:

```bash
npm test
```

## Execution Order

1. **Syntax check** — Verify files parse correctly
2. **Lint** — Check code style (if configured)
3. **Test** — Run test suite

## Output Format

```
Pre-Commit Check Results

Syntax: [PASSED/FAILED/SKIPPED]
Lint:   [PASSED/FAILED/SKIPPED]
Tests:  [PASSED/FAILED]

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

## Types

| Type | Purpose | Release |
|------|---------|---------|
| `feat` | New feature | Minor |
| `fix` | Bug fix | Patch |
| `deps` | Dependencies | Patch |
| `<any>!` | Breaking change | Major |
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
   Tests: PASSED

Step 2: Commit Message
   Changes:
   - Modified src/auth.ts
   - Added src/jwt.ts

   Suggested: feat(auth): add JWT token validation

   Alternatives:
   1. feat: add JWT authentication support
   2. feat(auth): implement token-based auth

Ready to commit: YES
```

---

# Quality Gates

Before any commit reaches main, it must pass ALL gates.

### Gate 1: Syntax — All Files Parse

Run the syntax check command from project.yaml. Must succeed.

### Gate 2: Tests — All Pass

Run the test command from project.yaml.

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
