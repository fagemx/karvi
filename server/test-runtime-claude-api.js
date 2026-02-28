#!/usr/bin/env node
/**
 * test-runtime-claude-api.js — Unit tests for Claude API runtime adapter
 *
 * Tests the runtime interface, vault integration, tool execution,
 * path traversal prevention, and conversation loop logic.
 *
 * Usage: node server/test-runtime-claude-api.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const runtimeModule = require('./runtime-claude-api');
const { _internal } = runtimeModule;

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    errors.push(testName);
    console.log(`  ✗ ${testName}`);
  }
}

function assertThrows(fn, testName, expectedMsg) {
  try {
    fn();
    failed++;
    errors.push(`${testName} (did not throw)`);
    console.log(`  ✗ ${testName} — expected throw but didn't`);
  } catch (err) {
    if (expectedMsg && !err.message.includes(expectedMsg)) {
      failed++;
      errors.push(`${testName} (wrong message: ${err.message})`);
      console.log(`  ✗ ${testName} — wrong error: ${err.message}`);
    } else {
      passed++;
      console.log(`  ✓ ${testName}`);
    }
  }
}

async function assertRejects(fn, testName, expectedMsg) {
  try {
    await fn();
    failed++;
    errors.push(`${testName} (did not reject)`);
    console.log(`  ✗ ${testName} — expected rejection but didn't`);
  } catch (err) {
    if (expectedMsg && !err.message.includes(expectedMsg)) {
      failed++;
      errors.push(`${testName} (wrong message: ${err.message})`);
      console.log(`  ✗ ${testName} — wrong error: ${err.message}`);
    } else {
      passed++;
      console.log(`  ✓ ${testName}`);
    }
  }
}

// --- Temp directory for tool tests ---
let tmpDir;

function setupTempDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karvi-claude-api-test-'));
  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello, World!', 'utf8');
  fs.mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested content', 'utf8');
}

function cleanupTempDir() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// --- Mock vault ---
function createMockVault(keys = {}) {
  return {
    isEnabled: () => true,
    retrieve: (userId, keyName) => {
      const val = keys[`${userId}:${keyName}`];
      return val ? Buffer.from(val) : null;
    },
    store: () => ({ ok: true }),
    has: (userId, keyName) => !!keys[`${userId}:${keyName}`],
    list: () => ({ ok: true, keys: [] }),
    delete: () => ({ ok: true }),
  };
}

function createDisabledVault() {
  return {
    isEnabled: () => false,
    retrieve: () => null,
    store: () => ({ ok: false, error: 'Vault not configured' }),
    has: () => false,
    list: () => ({ ok: false }),
    delete: () => ({ ok: false }),
  };
}

// ============================================================
// Test Suites
// ============================================================

async function runTests() {
  console.log('\n=== runtime-claude-api.js Unit Tests ===\n');

  // ----------------------------------------------------------
  // 1. Factory creation
  // ----------------------------------------------------------
  console.log('--- Factory Creation ---');

  const mockVault = createMockVault({ 'user1:anthropic_api_key': 'sk-ant-test-key-123' });
  const rt = runtimeModule.create({ vault: mockVault });

  assert(typeof rt.dispatch === 'function', '1a. create() returns dispatch function');
  assert(typeof rt.extractReplyText === 'function', '1b. create() returns extractReplyText function');
  assert(typeof rt.extractSessionId === 'function', '1c. create() returns extractSessionId function');
  assert(typeof rt.capabilities === 'function', '1d. create() returns capabilities function');

  // ----------------------------------------------------------
  // 2. Factory creation without vault
  // ----------------------------------------------------------
  console.log('\n--- Factory Without Vault ---');

  const rtNoVault = runtimeModule.create({});
  assert(typeof rtNoVault.dispatch === 'function', '2a. create({}) returns dispatch function');
  assert(typeof rtNoVault.capabilities === 'function', '2b. create({}) returns capabilities function');

  // Dispatch should fail when vault is null
  await assertRejects(
    () => rtNoVault.dispatch({ userId: 'user1', message: 'test' }),
    '2c. dispatch without vault throws clear error',
    'Vault is not configured'
  );

  // ----------------------------------------------------------
  // 3. Credential resolution — key present
  // ----------------------------------------------------------
  console.log('\n--- Credential Resolution ---');

  const key = _internal.resolveApiKey(mockVault, 'user1');
  assert(key === 'sk-ant-test-key-123', '3a. resolveApiKey returns correct key');

  // ----------------------------------------------------------
  // 4. Credential resolution — key missing
  // ----------------------------------------------------------
  assertThrows(
    () => _internal.resolveApiKey(mockVault, 'nonexistent-user'),
    '4a. resolveApiKey throws for missing key',
    'No anthropic_api_key found'
  );

  // ----------------------------------------------------------
  // 5. Credential resolution — vault disabled
  // ----------------------------------------------------------
  const disabledVault = createDisabledVault();
  assertThrows(
    () => _internal.resolveApiKey(disabledVault, 'user1'),
    '5a. resolveApiKey throws when vault disabled',
    'Vault is not configured'
  );

  // ----------------------------------------------------------
  // 6. Credential resolution — no userId
  // ----------------------------------------------------------
  assertThrows(
    () => _internal.resolveApiKey(mockVault, ''),
    '6a. resolveApiKey throws when userId is empty',
    'userId is required'
  );

  assertThrows(
    () => _internal.resolveApiKey(mockVault, null),
    '6b. resolveApiKey throws when userId is null',
    'userId is required'
  );

  // ----------------------------------------------------------
  // 7. Tool definitions
  // ----------------------------------------------------------
  console.log('\n--- Tool Definitions ---');

  const tools = _internal.buildTools();
  assert(Array.isArray(tools), '7a. buildTools returns array');
  assert(tools.length === 4, '7b. buildTools returns 4 tools');

  const toolNames = tools.map(t => t.name);
  assert(toolNames.includes('read_file'), '7c. includes read_file');
  assert(toolNames.includes('write_file'), '7d. includes write_file');
  assert(toolNames.includes('bash'), '7e. includes bash');
  assert(toolNames.includes('list_directory'), '7f. includes list_directory');

  // Verify tool schema structure
  for (const tool of tools) {
    assert(typeof tool.name === 'string', `7g. tool "${tool.name}" has name`);
    assert(typeof tool.description === 'string', `7h. tool "${tool.name}" has description`);
    assert(typeof tool.input_schema === 'object', `7i. tool "${tool.name}" has input_schema`);
    assert(tool.input_schema.type === 'object', `7j. tool "${tool.name}" schema type is object`);
  }

  // ----------------------------------------------------------
  // 8. Path traversal prevention
  // ----------------------------------------------------------
  console.log('\n--- Path Traversal Prevention ---');

  setupTempDir();

  // Valid paths
  const validPath = _internal.safePath(tmpDir, 'hello.txt');
  assert(validPath === path.join(tmpDir, 'hello.txt'), '8a. safePath resolves valid file');

  const nestedValid = _internal.safePath(tmpDir, 'subdir/nested.txt');
  assert(nestedValid === path.join(tmpDir, 'subdir', 'nested.txt'), '8b. safePath resolves nested path');

  const dotPath = _internal.safePath(tmpDir, '.');
  assert(dotPath === path.resolve(tmpDir), '8c. safePath resolves "." to workingDir');

  // Invalid paths (traversal attempts)
  assertThrows(
    () => _internal.safePath(tmpDir, '../../../etc/passwd'),
    '8d. safePath rejects ../../../etc/passwd',
    'Path traversal denied'
  );

  assertThrows(
    () => _internal.safePath(tmpDir, '..'),
    '8e. safePath rejects ".."',
    'Path traversal denied'
  );

  assertThrows(
    () => _internal.safePath(tmpDir, 'subdir/../../etc/shadow'),
    '8f. safePath rejects subdir/../../etc/shadow',
    'Path traversal denied'
  );

  // Null byte injection
  assertThrows(
    () => _internal.safePath(tmpDir, 'file\0.txt'),
    '8g. safePath rejects null byte in path',
    'null byte'
  );

  // ----------------------------------------------------------
  // 9. Tool execution — read_file
  // ----------------------------------------------------------
  console.log('\n--- Tool Execution ---');

  const readResult = _internal.executeToolCall('read_file', { path: 'hello.txt' }, tmpDir);
  assert(readResult === 'Hello, World!', '9a. read_file returns file content');

  // Nested file
  const nestedRead = _internal.executeToolCall('read_file', { path: 'subdir/nested.txt' }, tmpDir);
  assert(nestedRead === 'nested content', '9b. read_file reads nested file');

  // Non-existent file
  const missingFile = _internal.executeToolCall('read_file', { path: 'nonexistent.txt' }, tmpDir);
  assert(missingFile.startsWith('Error:'), '9c. read_file returns error for missing file');

  // ----------------------------------------------------------
  // 10. Tool execution — path traversal blocked
  // ----------------------------------------------------------
  const traversalResult = _internal.executeToolCall('read_file', { path: '../../../etc/passwd' }, tmpDir);
  assert(traversalResult.includes('Path traversal denied'), '10a. read_file blocks path traversal');

  // ----------------------------------------------------------
  // 11. Tool execution — write_file
  // ----------------------------------------------------------
  const writeResult = _internal.executeToolCall('write_file', { path: 'output.txt', content: 'test output' }, tmpDir);
  assert(writeResult.includes('File written'), '11a. write_file writes file');
  assert(fs.readFileSync(path.join(tmpDir, 'output.txt'), 'utf8') === 'test output', '11b. write_file content correct');

  // Write with parent directory creation
  const deepWrite = _internal.executeToolCall('write_file', { path: 'deep/nested/dir/file.txt', content: 'deep' }, tmpDir);
  assert(deepWrite.includes('File written'), '11c. write_file creates parent dirs');
  assert(fs.existsSync(path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt')), '11d. deep file exists');

  // Write with path traversal blocked
  const writeTraversal = _internal.executeToolCall('write_file', { path: '../../evil.txt', content: 'bad' }, tmpDir);
  assert(writeTraversal.includes('Path traversal denied'), '11e. write_file blocks path traversal');

  // ----------------------------------------------------------
  // 12. Tool execution — bash
  // ----------------------------------------------------------
  const bashResult = _internal.executeToolCall('bash', { command: 'echo hello-bash' }, tmpDir);
  assert(bashResult.trim() === 'hello-bash', '12a. bash executes command');

  // ----------------------------------------------------------
  // 13. Tool execution — list_directory
  // ----------------------------------------------------------
  const listResult = _internal.executeToolCall('list_directory', { path: '.' }, tmpDir);
  assert(listResult.includes('hello.txt'), '13a. list_directory lists files');
  assert(listResult.includes('[dir] subdir'), '13b. list_directory shows directories');
  assert(listResult.includes('[file]'), '13c. list_directory shows file type indicators');

  // ----------------------------------------------------------
  // 14. Tool execution — unknown tool
  // ----------------------------------------------------------
  const unknownResult = _internal.executeToolCall('nonexistent_tool', {}, tmpDir);
  assert(unknownResult.includes('Unknown tool'), '14a. unknown tool returns error message');

  cleanupTempDir();

  // ----------------------------------------------------------
  // 15. extractReplyText
  // ----------------------------------------------------------
  console.log('\n--- Extract Reply Text ---');

  const textResponse = {
    content: [
      { type: 'text', text: 'This is the reply.' },
    ],
  };
  assert(rt.extractReplyText(textResponse, '') === 'This is the reply.', '15a. extractReplyText from content[0].text');

  // Multiple text blocks
  const multiText = {
    content: [
      { type: 'text', text: 'Part 1' },
      { type: 'tool_use', id: 'xyz', name: 'read_file', input: {} },
      { type: 'text', text: 'Part 2' },
    ],
  };
  assert(rt.extractReplyText(multiText, '') === 'Part 1\n\nPart 2', '15b. extractReplyText concatenates text blocks');

  // Fallback to stdout
  assert(rt.extractReplyText(null, 'fallback text') === 'fallback text', '15c. extractReplyText falls back to stdout');

  // Empty
  assert(rt.extractReplyText(null, '') === '(empty reply)', '15d. extractReplyText returns default for empty');

  // No text blocks
  const noText = { content: [{ type: 'tool_use', id: 'xyz', name: 'read_file', input: {} }] };
  assert(rt.extractReplyText(noText, 'fallback') === 'fallback', '15e. extractReplyText fallback when no text blocks');

  // ----------------------------------------------------------
  // 16. extractSessionId
  // ----------------------------------------------------------
  console.log('\n--- Extract Session ID ---');

  const withId = { id: 'msg_01abc123', content: [] };
  assert(rt.extractSessionId(withId) === 'msg_01abc123', '16a. extractSessionId returns message id');

  assert(rt.extractSessionId(null) === null, '16b. extractSessionId returns null for null');
  assert(rt.extractSessionId({}) === null, '16c. extractSessionId returns null for empty obj');

  // ----------------------------------------------------------
  // 17. capabilities
  // ----------------------------------------------------------
  console.log('\n--- Capabilities ---');

  const caps = rt.capabilities();
  assert(caps.runtime === 'claude-api', '17a. runtime name is claude-api');
  assert(caps.supportsReview === false, '17b. supportsReview is false');
  assert(caps.supportsSessionResume === false, '17c. supportsSessionResume is false');
  assert(caps.supportsModelSelection === true, '17d. supportsModelSelection is true');
  assert(caps.supportsBudgetTracking === true, '17e. supportsBudgetTracking is true');
  assert(caps.supportsToolUse === true, '17f. supportsToolUse is true');

  // ----------------------------------------------------------
  // 18. dispatch rejects without userId
  // ----------------------------------------------------------
  console.log('\n--- Dispatch Edge Cases ---');

  await assertRejects(
    () => rt.dispatch({ message: 'test' }),
    '18a. dispatch rejects when userId is missing',
    'userId is required'
  );

  // dispatch with disabled vault
  const rtDisabled = runtimeModule.create({ vault: disabledVault });
  await assertRejects(
    () => rtDisabled.dispatch({ userId: 'user1', message: 'test' }),
    '18b. dispatch rejects when vault is disabled',
    'Vault is not configured'
  );

  // ----------------------------------------------------------
  // 19. extractUsage
  // ----------------------------------------------------------
  console.log('\n--- Extract Usage ---');

  assert(typeof rt.extractUsage === 'function', '19a. create() returns extractUsage function');

  // Multi-turn: _accumulatedUsage takes priority
  {
    const parsed = {
      _accumulatedUsage: { input_tokens: 500, output_tokens: 200 },
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const usage = rt.extractUsage(parsed, '');
    assert(usage.inputTokens === 500, '19b. extractUsage prefers _accumulatedUsage input_tokens');
    assert(usage.outputTokens === 200, '19c. extractUsage prefers _accumulatedUsage output_tokens');
  }

  // Single-turn: falls back to parsed.usage
  {
    const parsed = {
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const usage = rt.extractUsage(parsed, '');
    assert(usage.inputTokens === 100, '19d. extractUsage falls back to parsed.usage input_tokens');
    assert(usage.outputTokens === 50, '19e. extractUsage falls back to parsed.usage output_tokens');
  }

  // Null parsed returns null
  {
    const usage = rt.extractUsage(null, 'some stdout');
    assert(usage === null, '19f. extractUsage returns null for null parsed');
  }

  // Empty object (no usage data) returns null
  {
    const usage = rt.extractUsage({}, '');
    assert(usage === null, '19g. extractUsage returns null for empty object');
  }

  // Return shape: { inputTokens, outputTokens, totalCost }
  {
    const parsed = { _accumulatedUsage: { input_tokens: 10, output_tokens: 20 } };
    const usage = rt.extractUsage(parsed, '');
    assert('inputTokens' in usage, '19h. extractUsage result has inputTokens');
    assert('outputTokens' in usage, '19i. extractUsage result has outputTokens');
    assert('totalCost' in usage, '19j. extractUsage result has totalCost');
    assert(usage.totalCost === null, '19k. extractUsage totalCost is null (no cost from API)');
  }

  // Partial usage: only input_tokens present
  {
    const parsed = { usage: { input_tokens: 42 } };
    const usage = rt.extractUsage(parsed, '');
    assert(usage !== null, '19l. extractUsage returns object when at least one token field present');
    assert(usage.inputTokens === 42, '19m. extractUsage partial: inputTokens is 42');
    assert(usage.outputTokens === null, '19n. extractUsage partial: outputTokens is null');
  }

  // ----------------------------------------------------------
  // 20. Module exports structure
  // ----------------------------------------------------------
  console.log('\n--- Module Exports ---');

  assert(typeof runtimeModule.create === 'function', '20a. module exports create function');
  assert(typeof runtimeModule._internal === 'object', '20b. module exports _internal object');
  assert(typeof _internal.httpsPost === 'function', '20c. _internal.httpsPost exists');
  assert(typeof _internal.resolveApiKey === 'function', '20d. _internal.resolveApiKey exists');
  assert(typeof _internal.buildTools === 'function', '20e. _internal.buildTools exists');
  assert(typeof _internal.safePath === 'function', '20f. _internal.safePath exists');
  assert(typeof _internal.executeToolCall === 'function', '20g. _internal.executeToolCall exists');
  assert(typeof _internal.runConversationLoop === 'function', '20h. _internal.runConversationLoop exists');

  // ----------------------------------------------------------
  // 21. Conversation loop — end_turn stops loop
  // ----------------------------------------------------------
  console.log('\n--- Conversation Loop ---');

  // Mock httpsPost to simulate a single-turn end_turn response
  const origHttpsPost = _internal.httpsPost;

  // Test: loop ends on end_turn with text response
  {
    let callCount = 0;
    _internal.httpsPost = async () => {
      callCount++;
      return {
        status: 200,
        body: {
          id: 'msg_mock_end',
          content: [{ type: 'text', text: 'Task completed.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      };
    };

    const loopResult = await _internal.runConversationLoop({
      apiKey: 'sk-test',
      userMessage: 'do something',
      tools: _internal.buildTools(),
      workingDir: os.tmpdir(),
      maxTurns: 5,
      timeoutSec: 10,
    });

    assert(callCount === 1, '21a. end_turn stops loop after 1 API call');
    assert(loopResult.turns === 1, '21b. turns count is 1');
    assert(loopResult.usage.input_tokens === 100, '21c. usage.input_tokens accumulated');
    assert(loopResult.usage.output_tokens === 50, '21d. usage.output_tokens accumulated');
    assert(loopResult.response.id === 'msg_mock_end', '21e. last response is returned');
  }

  // Test: loop handles tool_use then end_turn (multi-turn)
  {
    let callCount = 0;
    _internal.httpsPost = async () => {
      callCount++;
      if (callCount === 1) {
        // First turn: tool use
        return {
          status: 200,
          body: {
            id: 'msg_mock_tool',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'list_directory', input: { path: '.' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 80, output_tokens: 30 },
          },
        };
      }
      // Second turn: end_turn
      return {
        status: 200,
        body: {
          id: 'msg_mock_done',
          content: [{ type: 'text', text: 'Done listing.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 120, output_tokens: 40 },
        },
      };
    };

    const loopResult = await _internal.runConversationLoop({
      apiKey: 'sk-test',
      userMessage: 'list files',
      tools: _internal.buildTools(),
      workingDir: os.tmpdir(),
      maxTurns: 5,
      timeoutSec: 10,
    });

    assert(callCount === 2, '21f. multi-turn: 2 API calls for tool_use then end_turn');
    assert(loopResult.turns === 2, '21g. multi-turn: turns count is 2');
    assert(loopResult.usage.input_tokens === 200, '21h. multi-turn: usage accumulated across turns');
  }

  // Test: loop rejects on API error
  {
    _internal.httpsPost = async () => {
      return {
        status: 401,
        body: { error: { type: 'authentication_error', message: 'Invalid API key' } },
      };
    };

    await assertRejects(
      () => _internal.runConversationLoop({
        apiKey: 'sk-bad',
        userMessage: 'test',
        tools: [],
        workingDir: os.tmpdir(),
        maxTurns: 3,
        timeoutSec: 10,
      }),
      '21i. loop rejects on API 401 error',
      'Claude API error'
    );
  }

  // Test: loop rejects on timeout
  {
    _internal.httpsPost = async () => {
      return {
        status: 200,
        body: {
          id: 'msg_timeout',
          content: [
            { type: 'tool_use', id: 'tu_t', name: 'bash', input: { command: 'echo hi' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      };
    };

    await assertRejects(
      () => _internal.runConversationLoop({
        apiKey: 'sk-test',
        userMessage: 'loop forever',
        tools: _internal.buildTools(),
        workingDir: os.tmpdir(),
        maxTurns: 100,
        timeoutSec: 0, // immediate timeout
      }),
      '21j. loop rejects on total timeout',
      'timed out'
    );
  }

  // Test: dispatch result flows through extractUsage correctly (end-to-end)
  {
    let callCount = 0;
    _internal.httpsPost = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 200,
          body: {
            id: 'msg_e2e_tool',
            content: [
              { type: 'tool_use', id: 'tu_e2e', name: 'bash', input: { command: 'echo ok' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 60, output_tokens: 20 },
          },
        };
      }
      return {
        status: 200,
        body: {
          id: 'msg_e2e_done',
          content: [{ type: 'text', text: 'All done.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 90, output_tokens: 35 },
        },
      };
    };

    const dispatchResult = await rt.dispatch({
      userId: 'user1',
      message: 'e2e test',
      workingDir: os.tmpdir(),
      timeoutSec: 10,
    });

    // dispatch.parsed should have _accumulatedUsage attached
    assert(dispatchResult.parsed._accumulatedUsage != null, '21k. dispatch attaches _accumulatedUsage to parsed');
    assert(dispatchResult.parsed._accumulatedUsage.input_tokens === 150, '21l. _accumulatedUsage.input_tokens is accumulated total');
    assert(dispatchResult.parsed._accumulatedUsage.output_tokens === 55, '21m. _accumulatedUsage.output_tokens is accumulated total');

    // extractUsage should pick up _accumulatedUsage
    const usage = rt.extractUsage(dispatchResult.parsed, dispatchResult.stdout);
    assert(usage !== null, '21n. extractUsage returns non-null from dispatch result');
    assert(usage.inputTokens === 150, '21o. extractUsage.inputTokens matches accumulated total');
    assert(usage.outputTokens === 55, '21p. extractUsage.outputTokens matches accumulated total');
    assert(usage.totalCost === null, '21q. extractUsage.totalCost is null');
  }

  // Restore original httpsPost
  _internal.httpsPost = origHttpsPost;

  // ----------------------------------------------------------
  // 22. httpsPost error handling
  // ----------------------------------------------------------
  console.log('\n--- httpsPost Error Handling ---');

  // Test: httpsPost returns error status from API (not a rejection)
  // The real API responds with 401 for fake keys — verify we get { status, body }
  {
    const result = await _internal.httpsPost('fake-key', { model: 'x', max_tokens: 1, messages: [] }, 5000);
    assert(typeof result.status === 'number', '22a. httpsPost returns status number');
    assert(result.status >= 400, '22b. httpsPost returns error status for bad key');
    assert(typeof result.body === 'object', '22c. httpsPost returns parsed error body');
  }

  // Test: httpsPost handles timeout via mock (verifying the wrapper message)
  {
    // Swap httpsPost with a mock that simulates a timeout rejection
    const origFn = _internal.httpsPost;
    _internal.httpsPost = async () => {
      throw new Error('Claude API request timed out after 100ms');
    };

    await assertRejects(
      () => _internal.runConversationLoop({
        apiKey: 'sk-test',
        userMessage: 'test',
        tools: [],
        workingDir: os.tmpdir(),
        maxTurns: 1,
        timeoutSec: 30,
      }),
      '22d. httpsPost timeout propagates through conversation loop',
      'timed out'
    );
    _internal.httpsPost = origFn;
  }

  // Test: httpsPost handles network error via mock
  {
    const origFn = _internal.httpsPost;
    _internal.httpsPost = async () => {
      throw new Error('Claude API network error: getaddrinfo ENOTFOUND');
    };

    await assertRejects(
      () => _internal.runConversationLoop({
        apiKey: 'sk-test',
        userMessage: 'test',
        tools: [],
        workingDir: os.tmpdir(),
        maxTurns: 1,
        timeoutSec: 30,
      }),
      '22e. httpsPost network error propagates through conversation loop',
      'network error'
    );
    _internal.httpsPost = origFn;
  }

  // ----------------------------------------------------------
  // Summary
  // ----------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (errors.length > 0) {
    console.log('\nFailed tests:');
    errors.forEach(e => console.log(`  - ${e}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
