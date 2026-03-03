# Phase 3: Implementation Plan — Runtime Contract

## Issue #100: `chore(server): extract runtime adapter interface contract`

**Chosen approach**: Option D — JSDoc typedef + `validateRuntime()` duck-type check at startup.

---

## Deliverables

### 1. New file: `server/runtime-contract.js`

**Content**:
- JSDoc typedefs: `DispatchResult`, `UsageInfo`, `RuntimeCapabilities`, `RuntimeAdapter`
- `REQUIRED_METHODS` constant array: `['dispatch', 'extractReplyText', 'extractSessionId', 'extractUsage', 'capabilities']`
- `validateRuntime(name, rt)` function that:
  - Checks all 5 methods exist and are functions
  - Calls `capabilities()` and validates `runtime` field is a string
  - Warns (does not throw) if `capabilities().runtime !== name`
  - Returns `rt` (pass-through) for chaining
  - Throws `Error` on any hard violation

**Estimated size**: ~80 lines including JSDoc.

### 2. Modify: `server/server.js`

**Changes** (lines ~43-48):
- Import `validateRuntime` from `./runtime-contract`
- Wrap each runtime registration with `validateRuntime()`:

```js
// Before:
const RUNTIMES = {
  openclaw: runtime,
  ...(runtimeCodex ? { codex: runtimeCodex } : {}),
  ...(runtimeClaude ? { claude: runtimeClaude } : {}),
  ...(runtimeClaudeApi ? { 'claude-api': runtimeClaudeApi } : {}),
};

// After:
const { validateRuntime } = require('./runtime-contract');

const RUNTIMES = { openclaw: validateRuntime('openclaw', runtime) };
if (runtimeCodex) RUNTIMES.codex = validateRuntime('codex', runtimeCodex);
if (runtimeClaude) RUNTIMES.claude = validateRuntime('claude', runtimeClaude);
if (runtimeClaudeApi) RUNTIMES['claude-api'] = validateRuntime('claude-api', runtimeClaudeApi);
```

**Impact**: ~10 lines changed. No functional change — all adapters already conform.

### 3. New file: `server/test-runtime-contract.js`

**Test cases**:
1. Valid runtime passes validation (all 5 methods present)
2. Missing `dispatch` throws with clear error message
3. Missing `extractUsage` throws (not silently ignored)
4. Non-function `capabilities` throws
5. `capabilities().runtime` mismatch logs warning but does not throw
6. `capabilities()` missing `runtime` field throws
7. All 4 real adapters pass validation (integration smoke test)
8. Validate returns the runtime object (pass-through assertion)

**Estimated size**: ~120 lines.

### 4. Optional (not in scope, but noted): Adapter annotation

Add `@type {import('./runtime-contract').RuntimeAdapter}` to each adapter's `module.exports` JSDoc. This is a follow-up to give IDE consumers autocomplete when accessing runtime objects. **Not required for this PR** — the typedef exists for reference; annotation can be a separate chore.

---

## Files Touched

| File | Action | Lines Changed |
|------|--------|--------------|
| `server/runtime-contract.js` | **New** | ~80 |
| `server/server.js` | Modify | ~10 |
| `server/test-runtime-contract.js` | **New** | ~120 |

**Total**: ~210 lines across 3 files. Zero changes to existing runtime adapters.

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| validateRuntime throws on a currently-broken optional adapter (e.g., codex not installed) | **None** — optional adapters are wrapped in try/catch; validation only runs if require succeeds | N/A |
| Future adapter author forgets to validate | Low | Document in runtime-contract.js JSDoc header; add server.js inline comment |
| capabilities() call during validation has side effects | **None** — all current capabilities() are pure data returns | Audit in code review |

---

## Execution Order

1. Create `server/runtime-contract.js` with typedef + `validateRuntime()`
2. Create `server/test-runtime-contract.js` and run: `node server/test-runtime-contract.js`
3. Modify `server/server.js` to use `validateRuntime()` at registration
4. Run full test suite: `node server/smoke-test.js` (if available) + existing tests
5. Verify server starts cleanly with `node server/server.js` (all adapters pass validation)

---

## Out of Scope (Future Issues)

- **Dispatch return shape validation**: Could add a `validateDispatchResult(result)` helper — but requires async test dispatch, higher complexity.
- **chat.js runtime abstraction**: `routes/chat.js` hardcodes `runtime.runOpenclawTurn()` — making chat multi-runtime is a separate feature.
- **spawnReview() contract**: `spawnReview()` is openclaw-specific. If review becomes multi-runtime, it needs its own interface. Separate issue.
- **TypeScript migration**: The JSDoc approach gives 80% of TS benefit. Full `.d.ts` or TS migration is a different initiative.
