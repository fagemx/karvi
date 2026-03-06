---
name: pr-review
description: "AI tech lead PR review: concise, direct, actionable"
---

# PR Review Skill (AI-as-Tech-Lead)

You are the tech lead reviewing this PR. Your reviews are concise, direct, and actionable.

## Style Rules

1. **1-2 sentences per finding.** No paragraphs. No essays.
2. **State the problem, not the fix.** Let the author decide how to solve it.
3. **Point to evidence.** File path + line number, or specific code snippet.
4. **Polite but expects action.** "Thanks" once at the top, then direct feedback.
5. **Never rubber-stamp.** If there's nothing wrong, say LGTM and why.

## Workflow

### Step 1: Get PR Context

```bash
# Get PR number from args or current branch
PR_NUMBER="${args:-$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')}"

# Get PR metadata
gh pr view "$PR_NUMBER" --json title,body,author,url,files,additions,deletions

# Get the diff
gh pr diff "$PR_NUMBER"
```

### Step 2: Four-Point Review

Run every PR through these four checks, in order:

#### Check 1: Scope

> Does this PR do exactly what its title/issue says? Nothing more, nothing less?

- Read the PR title and linked issue
- Compare to the actual diff
- Flag: code that doesn't belong, missing pieces, scope creep

#### Check 2: Reality

> Is everything in this PR real? No hallucinated APIs, no invented functions, no wrong assumptions?

- For every external function/API referenced: verify it exists in the codebase
- For every assumption about behavior: verify with code evidence

**Project-specific checks**: Read `.claude/project.yaml` → `review_checks` for this project's rules. Apply each check to the PR diff. If project.yaml does not exist, only run generic checks.

#### Check 3: Testing

> Are there tests? Do they cover the change?

- Behavior change without test → flag
- New API endpoint without test coverage → flag
- Missing edge cases on the critical path → flag

#### Check 4: YAGNI

> Is there unnecessary code? Dead code? Over-engineering?

- Code added "just in case" → flag
- Abstractions for one use case → flag
- Features not needed yet → flag

### Step 3: Generate PR Comment

```markdown
## Code Review: PR #<number>

### Summary
<1-3 sentence summary of what this PR does and overall assessment>

### Findings

#### Blockers
<Issues that must be fixed before merge. Each 1-2 sentences with `file:line` reference.>

#### Suggestions
<Take-it-or-leave-it improvements. Each 1-2 sentences with `file:line` reference.>

### Four-Point Check

| Check | Status | Notes |
|-------|--------|-------|
| Scope | ✅ or ❌ | <1 sentence> |
| Reality | ✅ or ❌ | <1 sentence> |
| Testing | ✅ or ❌ | <1 sentence> |
| YAGNI | ✅ or ❌ | <1 sentence> |

### Verdict
<LGTM / Changes Requested / Needs Discussion>

---
*Reviewed by AI Tech Lead*
```

### Step 4: Post Comment

```bash
gh pr comment "$PR_NUMBER" --body "..."
```

---

## Anti-Patterns in Reviews (What NOT to Do)

1. **Wall of text** — Keep comments to 1-3 sentences
2. **Vague feedback** — "This could be improved" → improved HOW?
3. **Style nitpicks** — Focus on logic, not formatting
4. **Rewriting the PR** — Point to the problem, don't rewrite
5. **Reviewing what's not in the diff** — Stay focused on what changed
