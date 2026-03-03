# Phase 1: Research — Runtime Adapter Interface Contract

## Issue #100: `chore(server): extract runtime adapter interface contract`

---

## 1. Runtime Adapters Inventory

Karvi has **4 runtime adapters**, each wrapping a different AI backend:

| Adapter | File | Pattern | Export Shape |
|---------|------|---------|-------------|
| **openclaw** | `server/runtime-openclaw.js` | Direct module exports | `{ dispatch, capabilities, runOpenclawTurn, spawnReview, extractReplyText, extractSessionId, extractUsage }` |
| **codex** | `server/runtime-codex.js` | Direct module exports | `{ dispatch, extractReplyText, extractSessionId, extractUsage, capabilities }` |
| **claude** | `server/runtime-claude.js` | Direct module exports | `{ dispatch, extractReplyText, extractSessionId, extractUsage, capabilities }` |
| **claude-api** | `server/runtime-claude-api.js` | Factory: `create({ vault })` → instance | `{ dispatch, extractReplyText, extractSessionId, extractUsage, capabilities }` |

## 2. Core Interface Methods (Shared by ALL adapters)

Every runtime adapter exposes these 5 methods:

### `dispatch(plan) → Promise<{code, stdout, stderr, parsed, ...}>`

- **Input**: A `plan` object built by `mgmt.buildDispatchPlan()` with fields: `agentId`, `sessionId`, `message`, `timeoutSec`, `runtimeHint`, `modelHint`, `workingDir`, `codexRole`, `userId`, `controlsSnapshot`, etc.
- **Output shape varies slightly**:
  - openclaw: `{ code, stdout, stderr, parsed }` (parsed = JSON.parse(stdout) or null)
  - codex: `{ code, stdout, stderr, parsed, sessionId }` (parsed = last NDJSON message event)
  - claude: `{ code, stdout, stderr, parsed }` (parsed = JSON.parse(stdout) or null)
  - claude-api: `{ code, stdout, stderr, parsed, usage, turns }` (parsed = full API response, extra `usage` + `turns` fields)

### `extractReplyText(parsed, stdout) → string`

- Extracts the human-readable reply text from dispatch result.
- **Signature inconsistency**: openclaw names params `(obj, fallback)` but functionally receives `(result.parsed, result.stdout)` from callers — works but misleading.
- All callers use: `rt.extractReplyText(result.parsed, result.stdout)`

### `extractSessionId(parsed) → string|null`

- Extracts session/conversation ID for resume capability.
- All callers use: `rt.extractSessionId(result.parsed)`

### `extractUsage(parsed, stdout) → {inputTokens, outputTokens, totalCost}|null`

- Extracts token usage metrics.
- openclaw and codex always return `null` (CLI doesn't report usage).
- claude and claude-api return `{ inputTokens, outputTokens, totalCost }`.
- All callers use: `rt.extractUsage?.(result.parsed, result.stdout)` (optional chaining — defensive).

### `capabilities() → object`

- Returns a descriptor of what the runtime supports.
- Common fields: `runtime` (string name), `supportsReview`, `supportsSessionResume`
- Varying fields: `supportsStructuredDispatchPlan`, `supportsRoles`, `supportsMultiAgent`, `supportsModelSelection`, `supportsBudgetLimit`, `supportsBudgetTracking`, `supportsToolRestriction`, `supportsEffortLevel`, `supportsToolUse`

## 3. Non-Contract Methods (Adapter-Specific)

| Method | Adapter | Usage |
|--------|---------|-------|
| `runOpenclawTurn()` | openclaw only | Used by `routes/chat.js` for conversation turns (bypasses `dispatch()`) |
| `spawnReview()` | openclaw only | Used by `routes/tasks.js` for auto-review (3 call sites) |

These are **directly imported** via `deps.runtime` (always openclaw, the default) — not through `getRuntime()`.

## 4. Registration & Selection (`server.js`)

```js
const RUNTIMES = {
  openclaw: runtime,
  ...(runtimeCodex ? { codex: runtimeCodex } : {}),
  ...(runtimeClaude ? { claude: runtimeClaude } : {}),
  ...(runtimeClaudeApi ? { 'claude-api': runtimeClaudeApi } : {}),
};

function getRuntime(hint) {
  return RUNTIMES[hint] || runtime; // falls back to openclaw
}
```

- openclaw is always loaded (hard require). Others are optional (try/catch).
- claude-api uses factory pattern: `require('./runtime-claude-api').create({ vault })`.
- `getRuntime(hint)` does zero validation — returns whatever is in the map, or default.

## 5. Consumer Call Patterns

### `step-worker.js` (Step Execution)
```js
const rt = deps.getRuntime(runtimeHint);
const result = await rt.dispatch(plan);
const replyText = rt.extractReplyText(result.parsed, result.stdout);
const usage = rt.extractUsage?.(result.parsed, result.stdout) || null;
```

### `routes/tasks.js` (Task Dispatch — 5+ sites)
```js
const rt = deps.getRuntime(plan.runtimeHint);
rt.dispatch(plan).then(result => {
    const replyText = rt.extractReplyText(result.parsed, result.stdout);
    const newSessionId = rt.extractSessionId(result.parsed);
    // ... later:
    const tokenUsage = rt.extractUsage?.(result.parsed, result.stdout);
});
```

### `routes/chat.js` (Conversation — hardcoded to openclaw)
```js
const result = await runtime.runOpenclawTurn({ agentId, sessionId, message, timeoutSec });
const replyText = runtime.extractReplyText(parsed, result.stdout);
const newSessionId = runtime.extractSessionId(parsed);
```

### Test Mocks (`test-step-worker.js`, `test-kernel-integration.js`)
```js
getRuntime: () => ({
    dispatch: async () => ({ code: 0, stdout: '...', stderr: '', parsed: {} }),
    extractReplyText: () => 'Step completed successfully',
    extractSessionId: () => null,
    extractUsage: () => ({ inputTokens: 100, outputTokens: 200, totalCost: 0.01 }),
}),
```

## 6. Identified Issues

1. **No formal contract**: No typedef, interface, or validation — a new adapter could silently omit `extractUsage` and break at runtime.
2. **Signature inconsistency**: openclaw's `extractReplyText(obj, fallback)` vs everyone else's `(parsed, stdout)`.
3. **Optional chaining workaround**: Callers use `rt.extractUsage?.()` defensively, suggesting the method was historically missing from some adapters.
4. **No dispatch result contract**: `dispatch()` return shapes vary (codex adds `sessionId`, claude-api adds `usage`/`turns`). Consumers only rely on `{ code, stdout, stderr, parsed }` — the extra fields are unused.
5. **capabilities() is informational only**: Nothing validates or uses capabilities at registration time.
6. **chat.js hardcoded to openclaw**: Uses `runtime.runOpenclawTurn()` directly, not through `getRuntime()`.
7. **spawnReview() is openclaw-only**: Referenced via `deps.runtime` (always openclaw), not through the runtime interface.
