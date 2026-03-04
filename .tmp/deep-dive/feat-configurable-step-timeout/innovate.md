# Innovation Phase: Configurable Step Timeout

## Proposed Solution: Per-Type Controls

Based on the research and requirements, I propose implementing **Approach 3: Per-type controls**. This approach provides the best balance between flexibility and ease of use, and aligns with the suggested implementation in the issue.

### 1. Data Structure in `controls`
Add a `step_timeout_sec` object to `DEFAULT_CONTROLS` in `server/management.js`:
```javascript
const DEFAULT_CONTROLS = {
  // ...
  step_timeout_sec: {
    plan: 300,
    implement: 600,
    review: 300,
    test: 300,
    default: 300
  }
};
```

### 2. Update `context-compiler.js`
Modify `buildEnvelope` to retrieve the timeout from controls. Since `buildEnvelope` currently doesn't have access to the `board` or `controls` directly (other than through `deps`), we have two options:
- **A. Pass `controls` to `buildEnvelope`**: Update all callers to pass the current controls.
- **B. Add `getControls` to `deps`**: Since `mgmt` is already in `deps`, we just need to ensure the `board` is available.

Wait, `server/routes/tasks.js` and `server/kernel.js` both have access to the `board` and call `buildEnvelope`.

Actually, `context-compiler.js` line 86 currently is:
```javascript
    timeout_ms: targetStep.retry_policy?.timeout_ms || 300_000,
```
If we want to respect `controls`, we should change it to:
```javascript
    timeout_ms: targetStep.retry_policy?.timeout_ms || (getStepTimeout(stepType, controls) * 1000),
```

### 3. Implementation Details

#### `server/management.js`
- Add `step_timeout_sec` to `DEFAULT_CONTROLS`.
- Ensure `getControls` merges it correctly.

#### `server/routes/controls.js`
- Add validation for `step_timeout_sec` in the POST handler.
- It should allow patching individual keys within `step_timeout_sec` or the whole object.
- Example: `PATCH /api/controls` with `{"step_timeout_sec": {"implement": 900}}`.

#### `server/context-compiler.js`
- Modify `buildEnvelope` to accept `controls` in `runState` or `deps`.
- `runState` currently contains `{ task, steps, run_id, budget }`. Adding `controls` here seems appropriate.

#### `server/routes/tasks.js` & `server/kernel.js`
- Update callers of `buildEnvelope` to include `controls` in `runState`.

### 4. Trade-offs and Considerations
- **Simplicity vs Flexibility**: Per-type controls are slightly more complex than a single global value but much more useful.
- **Backward Compatibility**: Existing tasks with `retry_policy.timeout_ms` will continue to work as they take precedence.
- **UI Impact**: The frontend `Controls` panel will need to be updated to support this object (out of scope for this backend task, but the API should support it).

## Alternative: Simple `default_step_timeout_sec`
If we want to keep it strictly to a single value as suggested by the name `default_step_timeout_sec` in the dispatch, we could do:
- `default_step_timeout_sec`: 300
- Hardcoded `implement` boost: 2x (e.g. 600)
But this is less "configurable" than the per-type map.

I will stick with the per-type map as it's what was requested in "Option B" of the issue.
