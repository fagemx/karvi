/**
 * runtime-contract.js — Runtime Adapter Interface Contract
 *
 * Defines the required interface for all Karvi runtime adapters and provides
 * a validation function to check compliance at startup.
 *
 * Every runtime adapter (openclaw, codex, claude, claude-api) must export
 * objects implementing all 5 required methods.
 *
 * @typedef {Object} RuntimeAdapter
 * @property {function} dispatch          - Execute a task via the runtime
 * @property {function} extractReplyText  - Extract reply text from runtime output
 * @property {function} extractSessionId  - Extract session ID from runtime output
 * @property {function} extractUsage      - Extract token usage from runtime output
 * @property {function} capabilities      - Return runtime capability descriptor
 */

/**
 * Required method names for a valid runtime adapter.
 * @type {string[]}
 */
const REQUIRED_METHODS = [
  'dispatch',
  'extractReplyText',
  'extractSessionId',
  'extractUsage',
  'capabilities',
];

/**
 * Validate that a runtime adapter object implements the full interface contract.
 *
 * Checks that all 5 required methods exist and are functions.
 * Throws with a clear, actionable error message on failure.
 *
 * @param {string} name - Runtime name (for error messages)
 * @param {*} rt - The runtime adapter object to validate
 * @throws {Error} If rt is null/undefined or missing required methods
 */
function validateRuntime(name, rt) {
  if (rt == null || typeof rt !== 'object') {
    throw new Error(
      `[runtime-contract] Runtime "${name}" is ${rt === null ? 'null' : typeof rt}` +
      ` \u2014 expected an object with methods: ${REQUIRED_METHODS.join(', ')}`
    );
  }

  const missing = [];
  const nonFunction = [];

  for (const method of REQUIRED_METHODS) {
    if (!(method in rt)) {
      missing.push(method);
    } else if (typeof rt[method] !== 'function') {
      nonFunction.push(`${method} (got ${typeof rt[method]})`);
    }
  }

  if (missing.length > 0 || nonFunction.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(`missing: ${missing.join(', ')}`);
    }
    if (nonFunction.length > 0) {
      parts.push(`not a function: ${nonFunction.join(', ')}`);
    }
    throw new Error(
      `[runtime-contract] Runtime "${name}" does not satisfy the adapter interface \u2014 ${parts.join('; ')}`
    );
  }
}

/**
 * Validate all runtimes in a RUNTIMES map.
 *
 * @param {Object<string, RuntimeAdapter>} runtimes - Map of name -> runtime adapter
 * @throws {Error} On first invalid runtime found
 */
function validateAllRuntimes(runtimes) {
  for (const [name, rt] of Object.entries(runtimes)) {
    validateRuntime(name, rt);
  }
}

module.exports = { REQUIRED_METHODS, validateRuntime, validateAllRuntimes };
