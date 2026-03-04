# Research Phase: Progressive Prompt Injection

## Issue Summary
GH-235 proposes filtering context sections by step type in `buildStepMessage()` to reduce token waste. Currently, every step dispatch receives all context sections regardless of relevance.

## Current Implementation Analysis

### Key Files
- `server/step-worker.js:627-803` — `buildStepMessage()` function
- `server/management.js:618-714` — Section builder functions

### Section Injection Order (current)

| Section | Function | Lines | Always Injected? |
|---------|----------|-------|------------------|
| Requirements | inline | 738-741 | Yes (if present) |
| Upstream Artifacts | inline | 744-757 | Yes (if present) |
| Coding Standards | `buildSkillContextSection()` | 760-762 | **YES** (unconditional) |
| Completion Criteria | `buildCompletionCriteriaSection()` | 765-766 | **YES** (unconditional) |
| Preflight Lessons | `buildPreflightSection()` | 769-775 | **YES** (if board+task) |
| Protected Decisions | `buildProtectedDecisionsSection()` | 792-795 | **YES** (unconditional) |

### Problem: Unconditional Injection

```javascript
// step-worker.js:760-762 — ALWAYS injected
const skillLines = mgmt.buildSkillContextSection();
if (skillLines.length > 0) lines.push(...skillLines);

// step-worker.js:765-766 — ALWAYS injected  
const completionLines = mgmt.buildCompletionCriteriaSection();
if (completionLines.length > 0) lines.push(...completionLines);

// step-worker.js:792-795 — ALWAYS injected
const protectedLines = mgmt.buildProtectedDecisionsSection();
if (protectedLines.length > 0) lines.push(...protectedLines);
```

### Token Waste Analysis

| Section | Approx. Tokens | Wasted On |
|---------|---------------|-----------|
| Coding Standards | ~400 | plan, review, test |
| Completion Criteria | ~150 | plan, review, test |
| Protected Decisions | ~200-600 | plan, test |
| **Per irrelevant step** | **~750-1150** | |

For a 3-step pipeline (plan → implement → review), waste = ~1500-2300 tokens.

### Step Type Analysis

| Step Type | What It Does | What It Needs |
|-----------|--------------|---------------|
| **plan** | Research, create plan | requirements, upstream artifacts, preflight lessons |
| **implement** | Write code, create PR | ALL sections |
| **test** | Run CI, fix failures | coding standards (for fixes) |
| **review** | Code quality check | requirements (to verify against) |

## Proposed Solution

### STEP_CONTEXT_SECTIONS Map

```javascript
const STEP_CONTEXT_SECTIONS = {
  plan:      ['requirements', 'upstream_artifacts', 'preflight_lessons'],
  implement: ['requirements', 'upstream_artifacts', 'coding_standards', 'completion_criteria', 'protected_decisions', 'preflight_lessons'],
  test:      ['coding_standards'],
  review:    ['requirements'],
};
```

### Implementation Approach

1. Define `STEP_CONTEXT_SECTIONS` at module scope in `step-worker.js`
2. In `buildStepMessage()`, get allowed sections: `STEP_CONTEXT_SECTIONS[envelope.step_type] || []`
3. Wrap each conditional section with `if (allowed.includes('section_name'))`

### Changes Required

| File | Change |
|------|--------|
| `step-worker.js:627` | Add `STEP_CONTEXT_SECTIONS` constant |
| `step-worker.js:760` | Wrap coding standards injection |
| `step-worker.js:765` | Wrap completion criteria injection |
| `step-worker.js:792` | Wrap protected decisions injection |
| `step-worker.js:769` | Wrap preflight lessons injection (already has board+task check) |

### Edge Cases

1. **Unknown step_type**: Should fall back to empty array (no conditional sections)
2. **Missing envelope**: Function receives envelope as parameter, always present
3. **Future step types**: Map can be extended without code changes

## Testing Strategy

### Unit Tests
- `node -c server/step-worker.js` — syntax check
- `node server/test-step-worker.js` — existing tests must pass

### Manual Verification
1. Create a plan step → verify message lacks coding standards
2. Create an implement step → verify message has all sections
3. Create a review step → verify message lacks completion criteria
4. Create a test step → verify message has only coding standards

## Evidence Locations

- `server/step-worker.js:627` — `buildStepMessage()` function start
- `server/step-worker.js:760` — Coding standards injection
- `server/step-worker.js:765` — Completion criteria injection
- `server/step-worker.js:769` — Preflight lessons injection
- `server/step-worker.js:792` — Protected decisions injection
- `server/management.js:618` — `buildProtectedDecisionsSection()`
- `server/management.js:658` — `buildSkillContextSection()`
- `server/management.js:703` — `buildCompletionCriteriaSection()`
- `server/management.js:518` — `buildPreflightSection()`

## Open Questions

1. Should `requirements` and `upstream_artifacts` be in the map for clarity, or kept as unconditional?
   - **Recommendation**: Keep unconditional as per task description — "always injected"
2. Should `preflight_lessons` be included for all step types?
   - **Task spec says**: plan only, but lessons could benefit implement too
   - **Recommendation**: Follow task spec (plan only), can extend later
