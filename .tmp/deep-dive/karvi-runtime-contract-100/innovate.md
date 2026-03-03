# Phase 2: Innovate — Runtime Contract Design Options

## Issue #100: `chore(server): extract runtime adapter interface contract`

---

## Option A: `validateRuntime()` Function

A pure-function validator that checks a runtime object at registration time.

```js
// runtime-contract.js
const REQUIRED_METHODS = ['dispatch', 'extractReplyText', 'extractSessionId', 'extractUsage', 'capabilities'];

function validateRuntime(name, rt) {
  const errors = [];
  for (const method of REQUIRED_METHODS) {
    if (typeof rt[method] !== 'function') {
      errors.push(`runtime "${name}" is missing required method: ${method}()`);
    }
  }
  // Validate capabilities() returns expected shape
  if (typeof rt.capabilities === 'function') {
    const caps = rt.capabilities();
    if (!caps || typeof caps.runtime !== 'string') {
      errors.push(`runtime "${name}": capabilities().runtime must be a string`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Runtime contract violation:\n  ${errors.join('\n  ')}`);
  }
  return rt; // pass-through for chaining
}
```

**Pros**:
- Zero overhead at dispatch time — validation runs once at startup
- No inheritance chain or class hierarchy
- Easy to add new checks (e.g., dispatch return shape via test call)
- Works with both module-export and factory-pattern adapters
- Existing adapters require zero changes to pass

**Cons**:
- Runtime-only validation (no static analysis / IDE autocomplete)
- Can't verify dispatch() return shape without actually calling it
- No parameter type enforcement

---

## Option B: JSDoc Typedef

Define the contract as JSDoc types that editors/TypeScript-in-JSDoc can check.

```js
// runtime-contract.js

/**
 * @typedef {Object} DispatchResult
 * @property {number} code - Exit code (0 = success)
 * @property {string} stdout - Raw stdout text
 * @property {string} stderr - Raw stderr text
 * @property {object|null} parsed - Parsed JSON output
 */

/**
 * @typedef {Object} UsageInfo
 * @property {number|null} inputTokens
 * @property {number|null} outputTokens
 * @property {number|null} totalCost
 */

/**
 * @typedef {Object} RuntimeCapabilities
 * @property {string} runtime - Runtime identifier name
 * @property {boolean} supportsReview
 * @property {boolean} supportsSessionResume
 */

/**
 * @typedef {Object} RuntimeAdapter
 * @property {(plan: object) => Promise<DispatchResult>} dispatch
 * @property {(parsed: object|null, stdout: string) => string} extractReplyText
 * @property {(parsed: object|null) => string|null} extractSessionId
 * @property {(parsed: object|null, stdout: string) => UsageInfo|null} extractUsage
 * @property {() => RuntimeCapabilities} capabilities
 */
```

**Pros**:
- IDE autocomplete and hover-docs for consumers
- Self-documenting — new adapter authors see the expected shape
- Zero runtime cost
- Can be consumed by `@type {import('./runtime-contract').RuntimeAdapter}`

**Cons**:
- Not enforced at runtime — a broken adapter still loads silently
- JSDoc types are advisory, not checked by Node.js
- Requires discipline to actually annotate adapter exports

---

## Option C: Runtime Base Class

An abstract-ish base class that adapters extend.

```js
class RuntimeBase {
  dispatch(plan) { throw new Error('dispatch() not implemented'); }
  extractReplyText(parsed, stdout) { throw new Error('extractReplyText() not implemented'); }
  extractSessionId(parsed) { throw new Error('extractSessionId() not implemented'); }
  extractUsage(parsed, stdout) { return null; } // safe default
  capabilities() { throw new Error('capabilities() not implemented'); }
}
```

**Pros**:
- `instanceof` check possible at registration
- Shared default implementations (e.g., `extractUsage` → null)
- Familiar OOP pattern

**Cons**:
- **Massive refactor**: All 4 adapters must be rewritten as classes
- claude-api's factory pattern doesn't fit class inheritance cleanly
- Over-engineered for what is essentially a 5-method duck-typed interface
- JavaScript classes add prototype chain overhead for no functional gain here
- Goes against the existing project style (module functions, not classes)

**Verdict**: Rejected — too disruptive for the benefit.

---

## Option D: Duck-Type Check at Startup (Lightweight Validate + Log)

Combine A and B: define the JSDoc typedef AND validate at registration in `server.js`.

```js
// runtime-contract.js
const REQUIRED = ['dispatch', 'extractReplyText', 'extractSessionId', 'extractUsage', 'capabilities'];

/** @param {string} name  @param {object} rt  @returns {RuntimeAdapter} */
function validateRuntime(name, rt) {
  const missing = REQUIRED.filter(m => typeof rt[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Runtime "${name}" missing: ${missing.join(', ')}`);
  }
  const caps = rt.capabilities();
  if (typeof caps?.runtime !== 'string') {
    throw new Error(`Runtime "${name}": capabilities().runtime must be a string`);
  }
  if (caps.runtime !== name) {
    console.warn(`[runtime] "${name}" capabilities().runtime is "${caps.runtime}" (expected "${name}")`);
  }
  return rt;
}

module.exports = { validateRuntime, REQUIRED_METHODS: REQUIRED };
```

Usage in `server.js`:
```js
const { validateRuntime } = require('./runtime-contract');

const RUNTIMES = {};
RUNTIMES.openclaw = validateRuntime('openclaw', runtime);
if (runtimeCodex) RUNTIMES.codex = validateRuntime('codex', runtimeCodex);
if (runtimeClaude) RUNTIMES.claude = validateRuntime('claude', runtimeClaude);
if (runtimeClaudeApi) RUNTIMES['claude-api'] = validateRuntime('claude-api', runtimeClaudeApi);
```

**Pros**:
- Fast-fail at startup if an adapter is broken (not at first dispatch, minutes later)
- JSDoc provides IDE support + documentation
- validateRuntime is a one-liner at each registration site
- Existing adapters pass with zero changes
- Test mocks can be validated too: `validateRuntime('mock', mockRt)`
- Incremental: can later add return-shape validation, capability checks

**Cons**:
- Still can't validate dispatch() return shape statically
- Two things in one file (types + validator) — but it's small enough

---

## Recommendation: **Option D** (Duck-Type Check at Startup)

This is the pragmatic choice because:

1. **Minimal disruption**: No adapter changes needed — all 4 already conform.
2. **Fail-fast**: Server crashes at startup (not at first user request) if an adapter is broken.
3. **Self-documenting**: JSDoc typedef serves as the canonical "what must an adapter implement" reference.
4. **Test-friendly**: Mock objects can be validated in test setup.
5. **Incremental path**: Can add dispatch return shape validation, capabilities schema checks, or even runtime-specific method validation (e.g., openclaw's `spawnReview`) in future iterations.

Option C (base class) is rejected outright — it requires rewriting all adapters and fights the existing functional style. Options A and B are subsets of D.
