/**
 * test-runtime-utils.js — Unit tests for shared idle detection controller
 *
 * Run: node --test server/test-runtime-utils.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIdleController } = require('./runtime-utils');

describe('createIdleController', () => {
  it('starts in idle mode', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    assert.equal(c.depth, 0);
    assert.equal(c.currentTimeoutMs, 100);
    c.dispose();
  });

  it('switches to tool timeout on first enter', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    c.enterToolExecution();
    assert.equal(c.depth, 1);
    assert.equal(c.currentTimeoutMs, 200);
    c.dispose();
  });

  it('returns to idle on exit', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    c.enterToolExecution();
    c.exitToolExecution();
    assert.equal(c.depth, 0);
    assert.equal(c.currentTimeoutMs, 100);
    c.dispose();
  });

  it('handles nested enter/exit', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    c.enterToolExecution();
    c.enterToolExecution();
    assert.equal(c.depth, 2);
    assert.equal(c.currentTimeoutMs, 200);

    c.exitToolExecution();
    assert.equal(c.depth, 1);
    assert.equal(c.currentTimeoutMs, 200);

    c.exitToolExecution();
    assert.equal(c.depth, 0);
    assert.equal(c.currentTimeoutMs, 100);
    c.dispose();
  });

  it('exit at depth 0 is no-op', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    c.exitToolExecution();
    assert.equal(c.depth, 0);
    assert.equal(c.currentTimeoutMs, 100);
    c.dispose();
  });

  it('forceResetDepth resets when depth > 0', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    c.enterToolExecution();
    c.enterToolExecution();
    assert.equal(c.depth, 2);

    c.forceResetDepth('test');
    assert.equal(c.depth, 0);
    assert.equal(c.currentTimeoutMs, 100);
    c.dispose();
  });

  it('forceResetDepth is no-op when depth is 0', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    c.forceResetDepth('test');
    assert.equal(c.depth, 0);
    assert.equal(c.currentTimeoutMs, 100);
    c.dispose();
  });

  it('touch resets the inactivity timer', (_, done) => {
    let timeoutCalled = false;
    const c = createIdleController({
      idleTimeoutMs: 50,
      toolTimeoutMs: 200,
      onTimeout: () => { timeoutCalled = true; }
    });

    setTimeout(() => {
      c.touch();
    }, 30);

    setTimeout(() => {
      assert.equal(timeoutCalled, false, 'should not timeout because touch() reset timer');
      c.dispose();
      done();
    }, 70);
  });

  it('safety guard resets stuck depth', (_, done) => {
    const c = createIdleController({
      idleTimeoutMs: 1000,
      toolTimeoutMs: 1000,
      guardTimeoutMs: 50,
      onTimeout: () => {}
    });
    c.enterToolExecution();
    assert.equal(c.depth, 1);

    setTimeout(() => {
      assert.equal(c.depth, 0, 'depth should be reset by safety guard');
      assert.equal(c.currentTimeoutMs, 1000, 'should be back to idle timeout');
      c.dispose();
      done();
    }, 100);
  });

  it('safety guard is cleared on normal exit', (_, done) => {
    const c = createIdleController({
      idleTimeoutMs: 1000,
      toolTimeoutMs: 1000,
      guardTimeoutMs: 50,
      onTimeout: () => {}
    });
    c.enterToolExecution();
    c.exitToolExecution();

    setTimeout(() => {
      assert.equal(c.depth, 0, 'depth should still be 0');
      assert.equal(c.currentTimeoutMs, 1000, 'should remain in idle timeout');
      c.dispose();
      done();
    }, 100);
  });

  it('dispose clears all timers', (_, done) => {
    let timeoutCalled = false;
    const c = createIdleController({
      idleTimeoutMs: 50,
      toolTimeoutMs: 200,
      onTimeout: () => { timeoutCalled = true; }
    });
    c.dispose();

    setTimeout(() => {
      assert.equal(timeoutCalled, false, 'timeout should not fire after dispose');
      done();
    }, 100);
  });

  it('methods are no-op after dispose', () => {
    const c = createIdleController({
      idleTimeoutMs: 100,
      toolTimeoutMs: 200,
      onTimeout: () => {}
    });
    c.dispose();

    c.enterToolExecution();
    assert.equal(c.depth, 0, 'enterToolExecution should be no-op after dispose');

    c.exitToolExecution();
    assert.equal(c.depth, 0, 'exitToolExecution should be no-op after dispose');

    c.forceResetDepth('test');
    assert.equal(c.depth, 0, 'forceResetDepth should be no-op after dispose');
  });
});
