# Phase 3: Implementation Plan — Issue #98

## Change 1: Add null guard in `buildEnvelope`

**File**: `server/context-compiler.js`
**Location**: Line 19 (insert after line 18)

**Current code** (lines 17-20):
```js
function buildEnvelope(decision, runState, deps) {
  const { task, steps } = runState;
  const { artifactStore, stepSchema } = deps;
```

**New code** (lines 17-21):
```js
function buildEnvelope(decision, runState, deps) {
  const { task, steps } = runState;
  if (!task || !steps) return null;
  const { artifactStore, stepSchema } = deps;
```

**Why this exact location**: The guard must be after destructuring (line 18) but before any access to `task` or `steps`. The first access to `steps` is `steps.find()` on current line 22, and the first access to `task` is `task.id` on current line 44. Placing the guard immediately after destructuring covers both.

## Change 2: Add test cases

**File**: `server/test-context-compiler.js`
**Location**: After the existing "returns null for missing target step" test (line 128), before the cleanup block (line 130)

**New test cases to insert**:

```js
test('buildEnvelope returns null when task is null', () => {
  const decision = { action: 'next_step', next_step: { step_id: 'T-1:plan' } };
  const runState = { task: null, steps: [] };
  const deps = { artifactStore, stepSchema };
  const env = contextCompiler.buildEnvelope(decision, runState, deps);
  assert.strictEqual(env, null);
});

test('buildEnvelope returns null when steps is null', () => {
  const decision = { action: 'next_step', next_step: { step_id: 'T-1:plan' } };
  const runState = { task: { id: 'T-1' }, steps: null };
  const deps = { artifactStore, stepSchema };
  const env = contextCompiler.buildEnvelope(decision, runState, deps);
  assert.strictEqual(env, null);
});
```

## Acceptance criteria verification

| Criterion | How verified |
|-----------|-------------|
| `buildEnvelope({ task: null, steps: [] }, ...)` returns `null` | Test 1 above |
| `buildEnvelope({ task: {}, steps: null }, ...)` returns `null` | Test 2 above |
| Test case added and passing | Run `node server/test-context-compiler.js` |

## Diff summary

- **1 line added** in `context-compiler.js` (the guard)
- **2 test cases added** (~14 lines) in `test-context-compiler.js`
- **0 files created or deleted**
- **No schema, API, or cross-module changes** — this is a pure defensive guard

## Branch & PR plan

- Branch: `fix/null-guard-buildenvelope-98`
- PR title: `fix(context-compiler): add null guard for missing task in buildEnvelope`
- Linked issue: closes #98
