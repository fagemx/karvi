# Phase 1: Research — Issue #98

## Problem Statement

`buildEnvelope()` in `server/context-compiler.js:17-85` destructures `runState` into `{ task, steps }` at line 18 without checking either is truthy. If `task` is `null`/`undefined`, the function crashes at `task.id` (line 44), `task.budget` (line 49), `task.spec` / `task.depends` (lines 89-91 via `buildConstraints`), `task.description` / `task.title` (line 72). If `steps` is `null`/`undefined`, it crashes earlier at `steps.find()` (line 22).

## Code Analysis

### `buildEnvelope` signature & flow (`context-compiler.js:17-85`)

```js
function buildEnvelope(decision, runState, deps) {
  const { task, steps } = runState;        // line 18 — no guard
  const { artifactStore, stepSchema } = deps;

  const targetStepId = decision.next_step?.step_id;
  const targetStep = steps.find(...);       // line 22 — crashes if steps is null
  if (!targetStep) return null;             // line 23 — guard exists for targetStep

  // ... later accesses task.id, task.budget, task.description, task.spec, task.depends
}
```

**Existing guard pattern**: Line 23 already returns `null` early when `targetStep` is falsy. The same defensive pattern should apply to `task` and `steps`.

### Callers of `buildEnvelope`

1. **`server/kernel.js:88`** — Called inside `handleStepComplete`. The `runState` is built at line 62 as `{ task, steps: task.steps, ... }`. Here `task` comes from `board.taskPlan.tasks.find(...)` which could theoretically return `undefined` if the task was deleted between reads. If `task` is undefined, `task.steps` would crash even before `buildEnvelope` is called, so the kernel has its own crash path. However, `buildEnvelope` should still be defensive.

2. **`server/routes/tasks.js:1063`** — Called in the batch dispatch endpoint. The `currentTask` is looked up at line 1060 via `(currentBoard.taskPlan?.tasks || []).find(...)`. If `currentTask` is `undefined`, then line 1061 crashes at `currentTask.steps`. Same pattern — caller also lacks guard, but `buildEnvelope` should not assume callers are safe.

### Crash vectors

| Input | Crash location | Error |
|-------|---------------|-------|
| `task = null` | Line 22: `steps.find()` if `steps` comes from `task.steps` (caller crash) or Line 44: `task.id` | `TypeError: Cannot read properties of null` |
| `task = undefined` | Same as null | Same |
| `steps = null` | Line 22: `steps.find()` | `TypeError: Cannot read properties of null (reading 'find')` |
| `steps = undefined` | Line 22: `steps.find()` | Same |

### Existing test coverage

- `test-context-compiler.js:122-128` tests missing target step (returns `null`) — this confirms the early-return pattern is expected
- No test for `task = null` or `steps = null`

## Summary

The fix is straightforward: add a null guard for `task` and `steps` after destructuring on line 18, matching the existing `!targetStep` guard pattern on line 23. Two test cases needed to cover the acceptance criteria.
