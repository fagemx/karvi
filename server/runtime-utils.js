/**
 * runtime-utils.js — Shared idle detection for CLI runtimes
 *
 * Extracts the duplicated idle/tool timeout state machine from
 * runtime-opencode.js and runtime-codex.js into a reusable controller.
 *
 * Usage:
 *   const idleController = createIdleController({
 *     idleTimeoutMs: 120_000,
 *     toolTimeoutMs: 300_000,
 *     logPrefix: '[opencode-rt]',
 *     onTimeout: (timeoutMs, depth) => { ... }
 *   });
 *   idleController.touch();              // reset inactivity timer
 *   idleController.enterToolExecution(); // switch to tool timeout
 *   idleController.exitToolExecution();  // return to idle timeout
 *   idleController.dispose();            // clear all timers
 */

function createIdleController(options) {
  const {
    idleTimeoutMs,
    toolTimeoutMs,
    logPrefix = '[runtime]',
    onTimeout,
    guardTimeoutMs = 600_000
  } = options;

  let depth = 0;
  let currentTimeoutMs = idleTimeoutMs;
  let timer = null;
  let guardTimer = null;
  let disposed = false;

  function resetTimer() {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!disposed) onTimeout(currentTimeoutMs, depth);
    }, currentTimeoutMs);
  }

  function enterToolExecution() {
    if (disposed) return;
    depth++;
    if (depth === 1) {
      currentTimeoutMs = toolTimeoutMs;
      console.log(`${logPrefix} entering tool execution (depth=${depth}), timeout=${Math.round(currentTimeoutMs / 1000)}s`);
      if (guardTimeoutMs && !guardTimer) {
        guardTimer = setTimeout(() => {
          if (depth > 0) {
            console.log(`${logPrefix} safety guard triggered, resetting depth from ${depth}`);
            depth = 0;
            currentTimeoutMs = idleTimeoutMs;
            resetTimer();
          }
        }, guardTimeoutMs);
      }
      resetTimer();
    }
  }

  function exitToolExecution() {
    if (disposed) return;
    if (depth > 0) {
      depth--;
      if (depth === 0) {
        currentTimeoutMs = idleTimeoutMs;
        console.log(`${logPrefix} exited tool execution (depth=${depth}), timeout=${Math.round(currentTimeoutMs / 1000)}s`);
        if (guardTimer) {
          clearTimeout(guardTimer);
          guardTimer = null;
        }
        resetTimer();
      }
    }
  }

  function forceResetDepth(reason) {
    if (disposed) return;
    if (depth > 0) {
      console.log(`${logPrefix} force reset depth from ${depth} (${reason})`);
      depth = 0;
      currentTimeoutMs = idleTimeoutMs;
      if (guardTimer) {
        clearTimeout(guardTimer);
        guardTimer = null;
      }
      resetTimer();
    }
  }

  function dispose() {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (guardTimer) {
      clearTimeout(guardTimer);
      guardTimer = null;
    }
  }

  return {
    enterToolExecution,
    exitToolExecution,
    forceResetDepth,
    touch: resetTimer,
    dispose,
    get depth() { return depth; },
    get currentTimeoutMs() { return currentTimeoutMs; }
  };
}

module.exports = { createIdleController };
