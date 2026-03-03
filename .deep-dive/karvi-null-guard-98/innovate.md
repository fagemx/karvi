# Phase 2: Innovate — Issue #98

## Options Considered

### Option A: Guard at top of `buildEnvelope` only

Add `if (!task || !steps) return null;` after line 18 in `context-compiler.js`.

**Pros:**
- Follows the existing guard pattern (line 23: `if (!targetStep) return null`)
- Single point of defense — callers already handle `null` returns (kernel.js:89 `if (!envelope) break`, tasks.js:1064 `if (!envelope) throw ...`)
- Minimal change, minimal risk

**Cons:**
- Callers still have their own crash paths before reaching `buildEnvelope` (e.g., `task.steps` in kernel.js:62)

### Option B: Guard in callers (`kernel.js` and `routes/tasks.js`) only

Add null checks on `task` before constructing `runState`.

**Pros:**
- Prevents crash earlier in the call chain
- Callers can emit better error messages specific to their context

**Cons:**
- Doesn't protect `buildEnvelope` from future callers that forget guards
- Two locations to patch instead of one
- Out of scope per issue definition

### Option C: Both — guard in `buildEnvelope` AND callers

**Pros:**
- Defense in depth
- Protects against all crash vectors

**Cons:**
- Scope creep — issue explicitly says "Out of scope: Other edge cases in context-compiler"
- Caller guards are a separate concern (kernel robustness, route error handling)

## Recommendation: Option A

**Rationale:**
1. The issue explicitly scopes to `buildEnvelope` only
2. Both existing callers already handle `null` return from `buildEnvelope` — kernel breaks, tasks.js throws with descriptive error
3. Matches the existing defensive pattern in the same function
4. Caller-side guards for `task` being null should be a separate issue if needed

**Guard placement**: Immediately after destructuring on line 18, before any access to `task` or `steps`:

```js
const { task, steps } = runState;
if (!task || !steps) return null;   // <-- new guard
```

This prevents both crash vectors (null task and null steps) with a single line, and the `null` return is already handled by all callers.
