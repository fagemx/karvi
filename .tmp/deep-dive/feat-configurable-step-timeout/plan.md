# Plan Phase: Configurable Step Timeout

## Implementation Plan

### Step 1: Update `server/management.js`
- Add `step_timeout_sec` to `DEFAULT_CONTROLS`:
  ```javascript
  step_timeout_sec: {
    plan: 300,
    implement: 600,
    review: 300,
    test: 300,
    default: 300
  }
  ```
- No changes needed to `getControls` as it uses spread.

### Step 2: Update `server/routes/controls.js`
- Allow `step_timeout_sec` in the `allowed` keys list.
- Add deep patching logic for `step_timeout_sec`:
  ```javascript
  else if (key === 'step_timeout_sec' && typeof val === 'object' && val !== null) {
    board.controls[key] = { ...mgmt.DEFAULT_CONTROLS.step_timeout_sec, ...board.controls[key], ...val };
    // Validate each key is finite and positive
    for (const k of Object.keys(board.controls[key])) {
      if (typeof board.controls[key][k] === 'number') {
        board.controls[key][k] = Math.max(30, Math.min(3600, board.controls[key][k]));
      }
    }
  }
  ```

### Step 3: Update `server/context-compiler.js`
- Update `buildEnvelope` to use `controls` from `runState`.
- Implement timeout fallback logic:
  ```javascript
  const controls = runState.controls || (deps.mgmt ? deps.mgmt.getControls({}) : {});
  const stepTimeouts = controls.step_timeout_sec || {};
  const timeoutSec = targetStep.retry_policy?.timeout_ms ? (targetStep.retry_policy.timeout_ms / 1000) 
    : (stepTimeouts[stepType] || stepTimeouts.default || 300);
  
  // in envelope
  timeout_ms: timeoutSec * 1000,
  ```

### Step 4: Update Callers of `buildEnvelope`
Pass `controls` in `runState` in the following files:
- `server/routes/tasks.js` (inside `dispatchTask` and `tryAutoDispatch`)
- `server/kernel.js` (inside `onStepEvent` and `onReviewEvent`)
- `server/server.js` (inside the retry poller)

### Step 5: Update `server/server.js` Startup
- Add `step_timeout_sec` defaults to `ensureBoardExists`.

### Step 6: Verification
- Update `server/test-context-compiler.js` with a test case for custom controls.
- Run `node -c` on all files.
- Run `node server/test-context-compiler.js`.

## Risk Assessment
- **Risk**: Passing `controls` to `buildEnvelope` might miss some callers.
- **Mitigation**: I've grepped for all occurrences of `buildEnvelope`.
- **Risk**: Deep patching logic in `controls.js` might overwrite existing settings if not careful.
- **Mitigation**: Use spread `...board.controls[key]` to preserve other keys in the object.
