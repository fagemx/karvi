/**
 * test-runtime-opencode.js — Unit tests for opencode NDJSON stream handling
 *
 * Tests the settlement logic: when does dispatch resolve/reject?
 * Uses node:test (Node 22 built-in).
 *
 * Run: node --test server/test-runtime-opencode.js
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

/**
 * Simulate the NDJSON parsing + settlement logic from runtime-opencode.js.
 *
 * We can't easily test `dispatch()` directly (it spawns a real process),
 * so we extract the core logic into a testable harness that mimics
 * the stdout event handling.
 */
function createStreamHarness(opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  let settled = false;
  let settleResult = null;
  let settleError = null;
  let lineBuf = '';
  let sessionId = null;
  let lastText = '';
  let lastFinish = null;
  let totalTokens = { input: 0, output: 0 };
  let totalCost = 0;
  let killed = false;

  const STEP_RESULT_RE = /STEP_RESULT:\s*(\{.*\})/;

  function settle(err, result) {
    if (settled) return;
    settled = true;
    settleError = err;
    settleResult = result;
  }

  function killTree() {
    killed = true;
  }

  function buildResult(text) {
    return {
      code: 0,
      stdout: text || lastText || '',
      stderr: '',
      parsed: {
        result: text || lastText || null,
        session_id: sessionId,
        input_tokens: totalTokens.input || null,
        output_tokens: totalTokens.output || null,
        total_cost: totalCost || null,
      },
    };
  }

  function feedChunk(chunk) {
    lineBuf += chunk;
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.sessionID) sessionId = obj.sessionID;

      // text event — accumulate
      if (obj.type === 'text' && obj.part?.text) {
        lastText += obj.part.text;

        const m = STEP_RESULT_RE.exec(lastText);
        if (m) {
          settle(null, buildResult(lastText));
          killTree();
          return;
        }
      }

      // step_finish — accumulate tokens/cost, do NOT settle
      if (obj.type === 'step_finish') {
        lastFinish = obj.part || {};
        if (obj.sessionID) sessionId = obj.sessionID;
        const tokens = lastFinish.tokens || {};
        totalTokens.input += tokens.input || 0;
        totalTokens.output += tokens.output || 0;
        totalCost += lastFinish.cost || 0;
      }
    }
  }

  function feedClose(code) {
    if (settled) return;
    if (code !== 0) {
      settle(new Error(`opencode exited ${code}`));
      return;
    }
    if (lastText) {
      settle(null, buildResult(lastText));
    } else {
      settle(new Error('opencode exited 0 but no output received'));
    }
  }

  return {
    feedChunk,
    feedClose,
    get settled() { return settled; },
    get result() { return settleResult; },
    get error() { return settleError; },
    get killed() { return killed; },
    get sessionId() { return sessionId; },
    get totalTokens() { return totalTokens; },
    get totalCost() { return totalCost; },
  };
}

// Helper: create NDJSON line
function ndjson(obj) {
  return JSON.stringify(obj) + '\n';
}

describe('runtime-opencode NDJSON settlement', () => {

  describe('step_finish should NOT trigger settlement', () => {
    it('reason=stop does not settle — waits for process exit', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'step_start', sessionID: 'ses-1', part: {} }));
      h.feedChunk(ndjson({ type: 'text', part: { text: 'Let me analyze this...' } }));
      h.feedChunk(ndjson({
        type: 'step_finish', sessionID: 'ses-1',
        part: { reason: 'stop', cost: 0.01, tokens: { input: 100, output: 50 } },
      }));

      assert.equal(h.settled, false, 'should NOT settle on step_finish reason=stop');
      assert.equal(h.killed, false, 'should NOT kill process');

      // Process exits naturally
      h.feedClose(0);
      assert.equal(h.settled, true, 'should settle on process exit');
      assert.equal(h.result.parsed.result, 'Let me analyze this...');
    });

    it('reason=tool-calls does not settle', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'text', part: { text: 'Reading files...' } }));
      h.feedChunk(ndjson({
        type: 'step_finish',
        part: { reason: 'tool-calls', cost: 0.005, tokens: { input: 50, output: 20 } },
      }));

      assert.equal(h.settled, false, 'should NOT settle on tool-calls');
    });

    it('reason=length does not settle', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'text', part: { text: 'Partial output...' } }));
      h.feedChunk(ndjson({
        type: 'step_finish',
        part: { reason: 'length', cost: 0.02, tokens: { input: 200, output: 4096 } },
      }));

      assert.equal(h.settled, false, 'should NOT settle on reason=length');
    });

    it('unknown reason does not settle', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'text', part: { text: 'Working...' } }));
      h.feedChunk(ndjson({
        type: 'step_finish',
        part: { reason: 'some-future-reason', cost: 0.01, tokens: { input: 100, output: 50 } },
      }));

      assert.equal(h.settled, false, 'should NOT settle on unknown reason');
    });
  });

  describe('multi-step agentic run', () => {
    it('accumulates tokens and cost across multiple step_finish events', () => {
      const h = createStreamHarness();

      // Step 1: model thinks
      h.feedChunk(ndjson({ type: 'text', part: { text: 'Planning...' } }));
      h.feedChunk(ndjson({
        type: 'step_finish',
        part: { reason: 'tool-calls', cost: 0.01, tokens: { input: 100, output: 50 } },
      }));

      // Step 2: tool execution + model response
      h.feedChunk(ndjson({ type: 'tool_use', part: { tool: 'read_file', state: 'completed' } }));
      h.feedChunk(ndjson({ type: 'text', part: { text: ' Implementing...' } }));
      h.feedChunk(ndjson({
        type: 'step_finish',
        part: { reason: 'tool-calls', cost: 0.02, tokens: { input: 200, output: 100 } },
      }));

      // Step 3: final response
      h.feedChunk(ndjson({ type: 'text', part: { text: ' Done.' } }));
      h.feedChunk(ndjson({
        type: 'step_finish', sessionID: 'ses-abc',
        part: { reason: 'stop', cost: 0.005, tokens: { input: 150, output: 30 } },
      }));

      assert.equal(h.settled, false, 'still not settled — waiting for process exit');

      // Process exits
      h.feedClose(0);

      assert.equal(h.settled, true);
      assert.equal(h.result.parsed.result, 'Planning... Implementing... Done.');
      assert.equal(h.result.parsed.input_tokens, 450);   // 100+200+150
      assert.equal(h.result.parsed.output_tokens, 180);   // 50+100+30
      assert.ok(Math.abs(h.result.parsed.total_cost - 0.035) < 1e-10, `cost should be ~0.035, got ${h.result.parsed.total_cost}`);
      assert.equal(h.result.parsed.session_id, 'ses-abc');
    });
  });

  describe('STEP_RESULT marker — fast path', () => {
    it('settles immediately when STEP_RESULT is detected', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'text', part: { text: 'STEP_RESULT: {"status":"succeeded"}' } }));

      assert.equal(h.settled, true, 'should settle immediately on STEP_RESULT');
      assert.equal(h.killed, true, 'should kill process');
      assert.ok(h.result.parsed.result.includes('STEP_RESULT'));
    });

    it('STEP_RESULT works even after step_finish events', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({
        type: 'step_finish',
        part: { reason: 'tool-calls', cost: 0.01, tokens: { input: 100, output: 50 } },
      }));

      assert.equal(h.settled, false);

      h.feedChunk(ndjson({ type: 'text', part: { text: 'STEP_RESULT: {"status":"succeeded"}' } }));

      assert.equal(h.settled, true);
      assert.equal(h.result.parsed.total_cost, 0.01);
    });
  });

  describe('process exit handling', () => {
    it('settles with text on clean exit (code 0)', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'text', part: { text: 'Hello world' } }));
      h.feedClose(0);

      assert.equal(h.settled, true);
      assert.equal(h.result.parsed.result, 'Hello world');
    });

    it('rejects on non-zero exit', () => {
      const h = createStreamHarness();

      h.feedClose(1);

      assert.equal(h.settled, true);
      assert.ok(h.error);
      assert.ok(h.error.message.includes('exited 1'));
    });

    it('rejects on exit 0 with no output', () => {
      const h = createStreamHarness();

      h.feedClose(0);

      assert.equal(h.settled, true);
      assert.ok(h.error);
      assert.ok(h.error.message.includes('no output received'));
    });

    it('does not re-settle if already settled via STEP_RESULT', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'text', part: { text: 'STEP_RESULT: {"ok":true}' } }));
      assert.equal(h.settled, true);

      const firstResult = h.result;
      h.feedClose(0);
      // Result should not change
      assert.equal(h.result, firstResult);
    });
  });

  describe('session ID tracking', () => {
    it('captures sessionID from step_finish', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({
        type: 'step_finish', sessionID: 'ses-xyz',
        part: { reason: 'stop', cost: 0, tokens: {} },
      }));
      h.feedChunk(ndjson({ type: 'text', part: { text: 'done' } }));
      h.feedClose(0);

      assert.equal(h.result.parsed.session_id, 'ses-xyz');
    });

    it('captures sessionID from any event with sessionID field', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({ type: 'step_start', sessionID: 'ses-early' }));
      h.feedChunk(ndjson({ type: 'text', part: { text: 'output' } }));
      h.feedClose(0);

      assert.equal(h.result.parsed.session_id, 'ses-early');
    });
  });

  describe('edge cases', () => {
    it('handles step_finish with missing tokens/cost gracefully', () => {
      const h = createStreamHarness();

      h.feedChunk(ndjson({
        type: 'step_finish',
        part: { reason: 'stop' },  // no cost, no tokens
      }));
      h.feedChunk(ndjson({ type: 'text', part: { text: 'result' } }));
      h.feedClose(0);

      assert.equal(h.settled, true);
      assert.equal(h.result.parsed.total_cost, null);  // 0 → null
      assert.equal(h.result.parsed.input_tokens, null); // 0 → null
    });

    it('handles malformed JSON lines gracefully', () => {
      const h = createStreamHarness();

      h.feedChunk('not json\n');
      h.feedChunk('{broken\n');
      h.feedChunk(ndjson({ type: 'text', part: { text: 'valid' } }));
      h.feedClose(0);

      assert.equal(h.settled, true);
      assert.equal(h.result.parsed.result, 'valid');
    });

    it('handles partial lines across chunks', () => {
      const h = createStreamHarness();

      const line = JSON.stringify({ type: 'text', part: { text: 'split' } });
      // Send first half
      h.feedChunk(line.slice(0, 20));
      assert.equal(h.settled, false);
      // Send second half + newline
      h.feedChunk(line.slice(20) + '\n');
      h.feedClose(0);

      assert.equal(h.result.parsed.result, 'split');
    });
  });
});
