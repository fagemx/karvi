# Research Phase: Configurable Step Timeout

## Objective
The goal of this task is to make step timeouts configurable via the `controls` panel in the Karvi board, with sensible defaults for different step types (`plan`, `implement`, `review`).

## Current Implementation

### 1. Step-level defaults
In `server/step-schema.js`, the default retry policy includes a hardcoded 300,000 ms (5 min) timeout:
```javascript
const DEFAULT_RETRY_POLICY = {
  max_attempts: 3,
  backoff_base_ms: 5000,
  backoff_multiplier: 2,
  timeout_ms: 300_000,
};
```

### 2. Context Compilation
In `server/context-compiler.js`, the task envelope's `timeout_ms` is set by checking `targetStep.retry_policy?.timeout_ms` or falling back to 300,000 ms:
```javascript
    timeout_ms: targetStep.retry_policy?.timeout_ms || 300_000,
```

### 3. Controls and Management
Controls are managed in `server/management.js` with `DEFAULT_CONTROLS`:
```javascript
const DEFAULT_CONTROLS = {
  // ...
  review_timeout_sec: 180,
  // ...
};
```
And `buildDispatchPlan` (for legacy dispatch) uses a hardcoded 300s timeout:
```javascript
    timeoutSec: options.timeoutSec || 300,
```

The `server/routes/controls.js` handles PATCH requests to update controls but currently only allows a set list of keys and validates their types/values.

## Proposed Changes

### 1. Update `DEFAULT_CONTROLS`
Add `default_step_timeout_sec` and `step_timeout_overrides` to `DEFAULT_CONTROLS` in `server/management.js`.
```javascript
  default_step_timeout_sec: 300,
  step_timeout_overrides: {
    implement: 600
  },
```

### 2. Update `getControls`
Ensure `getControls` in `server/management.js` correctly merges the new fields.

### 3. Update `step-schema.js` or `context-compiler.js`
The best place to inject the timeout from controls is in `context-compiler.js`, as it already has access to the task and (indirectly) the board state. However, the current `context-compiler.js` doesn't have direct access to the `board`. We might need to pass the controls or the board to it.

Wait, `server/routes/tasks.js` calls `buildEnvelope`:
```javascript
    const runState = { task, steps: task.steps, run_id: runId, budget: task.budget };
    const decision = { action: 'next_step', next_step: { step_id: firstStep.step_id, step_type: firstStep.type } };
    const envelope = deps.contextCompiler.buildEnvelope(decision, runState, deps);
```
`deps` contains `mgmt`. So we can use `deps.mgmt.getControls(board)` in `buildEnvelope` if we pass the board.

Wait, the `runState` has `task`, but not the whole `board`. We might need to pass the board or at least the controls in `deps` or as an argument.

### 4. Update `routes/controls.js`
Modify the loop in `server/routes/controls.js` to allow patching `default_step_timeout_sec` and `step_timeout_overrides`.

## Verification Strategy
- Create a test board with custom timeout settings.
- Verify that `context-compiler.js` picks up the correct timeout based on step type.
- Run existing tests to ensure no regressions.
