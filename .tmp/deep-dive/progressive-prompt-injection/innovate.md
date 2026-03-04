# Innovation Phase: Progressive Prompt Injection

## Solution Alternatives

### Option A: Hardcoded Map (Recommended)

Define `STEP_CONTEXT_SECTIONS` as a constant in `step-worker.js`.

```javascript
const STEP_CONTEXT_SECTIONS = {
  plan:      ['requirements', 'upstream_artifacts', 'preflight_lessons'],
  implement: ['requirements', 'upstream_artifacts', 'coding_standards', 'completion_criteria', 'protected_decisions', 'preflight_lessons'],
  test:      ['coding_standards'],
  review:    ['requirements'],
};
```

**Pros:**
- Simple, no external dependencies
- Easy to understand and maintain
- Zero runtime overhead
- Changes are explicit and traceable in git

**Cons:**
- Requires code change to add new step types
- Less flexible than config-driven

**Verdict:** ✅ Best fit for current architecture. Step types are stable and well-defined.

---

### Option B: Config-Driven Map

Store the mapping in `board.json` under `controls.step_context_sections`.

**Pros:**
- Can adjust without code changes
- Can be tuned per workspace

**Cons:**
- Adds complexity to board.json
- Migration burden (existing boards need defaults)
- Overkill for stable step types
- board.json is single source of truth for runtime state, not configuration

**Verdict:** ❌ Over-engineering. Step types are architectural, not runtime config.

---

### Option C: Compact Headers with Lazy Expansion

Replace full sections with one-liners, expand on tool failure.

```
## Coding Standards (compact — use Skill("project-principles") for full details)
- Zero external dependencies
- Atomic board.json writes
```

**Pros:**
- Maximum token savings
- Agent can request full details when needed

**Cons:**
- Requires runtime support for `$hint` or similar mechanism
- Issue explicitly marks this as "optional, advanced" and out of scope
- Complex to implement correctly

**Verdict:** ⏸️ Defer. Keep as future enhancement after basic filtering works.

---

### Option D: Heuristic-Based Filtering

Analyze step instructions to infer what context is needed.

**Pros:**
- Automatic, no manual mapping

**Cons:**
- Unreliable (keyword matching is fragile)
- Hard to debug when wrong
- Adds complexity for little gain

**Verdict:** ❌ Over-complicated for this use case.

---

## Recommended Approach: Option A

### Why Hardcoded Map

1. **Step types are stable** — plan, implement, test, review are unlikely to change frequently
2. **Clear semantics** — each step type has well-defined responsibilities
3. **Simple to implement** — ~15 lines of code
4. **Easy to test** — verify each step type in isolation
5. **Follows existing patterns** — similar to `STEP_SKILL_MAP` at line 638

### Implementation Details

#### Location
Add `STEP_CONTEXT_SECTIONS` at module scope in `step-worker.js`, near `STEP_SKILL_MAP` (line 638).

#### Helper Function
Create a helper to check if a section is allowed:

```javascript
function shouldInjectSection(stepType, sectionName) {
  const allowed = STEP_CONTEXT_SECTIONS[stepType] || [];
  return allowed.includes(sectionName);
}
```

#### Injection Points

| Line | Section | Condition |
|------|---------|-----------|
| 760 | Coding Standards | `shouldInjectSection(stepType, 'coding_standards')` |
| 765 | Completion Criteria | `shouldInjectSection(stepType, 'completion_criteria')` |
| 769 | Preflight Lessons | `shouldInjectSection(stepType, 'preflight_lessons') && board && task` |
| 792 | Protected Decisions | `shouldInjectSection(stepType, 'protected_decisions')` |

### Trade-offs Accepted

1. **Not configurable** — Accepted. Step types are architectural, not user-facing.
2. **No compact headers** — Accepted. Can add later without breaking changes.
3. **No dynamic expansion** — Accepted. Would require significant runtime changes.

### Future Extensions

If compact headers become needed later:
1. Add `COMPACT_HEADERS: true` flag to `STEP_CONTEXT_SECTIONS`
2. Create `buildCompactSection()` variants
3. No changes to the filtering logic itself

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Wrong section filtered | Low | Medium | Verify each step type in tests |
| New step type added | Low | Low | Map returns empty array as fallback |
| Section needed unexpectedly | Low | Medium | Can add to map without code changes |

## Conclusion

**Option A (Hardcoded Map)** is the recommended approach. It's simple, maintainable, and aligns with the existing codebase patterns. The implementation requires minimal changes and is easy to test.
