---
name: testing
description: Comprehensive testing patterns and anti-patterns for writing and reviewing tests
context: fork
---

# Testing Skill

Use this skill when writing tests, reviewing test code, or investigating test failures.

## Documentation

Read the relevant reference based on context:

| Context | Reference |
|---------|-----------|
| General testing | This document |
| Anti-patterns | [Anti-Patterns](#anti-patterns) section below |
| Patterns | [Patterns](#patterns) section below |
| Server testing | [Server Testing](#server-testing) section below |
| Evolution testing | [Evolution Testing](#evolution-testing) section below |
| Smoke testing | [Smoke Testing](#smoke-testing) section below |

## Key Principles

1. **Integration tests are primary** — test at system entry points (HTTP endpoints, CLI scripts)
2. **Mock at the boundary** — only mock external services (agent runtimes), not internal code
3. **Use real infrastructure** — real filesystem (tmpdir), real board.json, real HTTP server
4. **Test behavior, not implementation** — verify outcomes (HTTP responses, board state), not internal function calls

## Test Organization

This project uses standalone test scripts — no test framework (no Jest, Mocha, etc.):

```
test-evolution-loop.js   # Integration test: signal → insight → lesson pipeline
smoke-test.js            # HTTP endpoint validation (port-based, reusable)
```

**Convention:** Tests are standalone Node.js scripts that start the server, exercise endpoints, and validate results. Run with `node <test-file>.js`.

## Commands

```bash
# Run main integration test
npm test                          # → node test-evolution-loop.js

# Run smoke test against running server
node smoke-test.js 3461           # Validate all HTTP endpoints

# Run smoke test for specific endpoint
node smoke-test.js 3461 /api/controls

# Run syntax checks on all source files
node --check server.js && node --check management.js && node --check retro.js
```

## Setup Pattern

Tests typically follow this pattern:

```javascript
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Start server as child process
const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: '0' }, // random port
  stdio: ['pipe', 'pipe', 'pipe'],
});

// 2. Wait for server to be ready (parse port from stdout)
// 3. Run test requests
// 4. Validate responses and board state
// 5. Kill server and clean up

process.on('exit', () => {
  server.kill();
  // Clean up test board.json if created
});
```

**Key points:**
- Use random or unique ports to prevent collisions between parallel tests
- Always clean up: kill server process, remove temp files
- Use `process.on('exit')` for cleanup guarantee
- For board state tests, use a separate board file or reset between tests

## Patterns

### Use Real HTTP Requests for API Tests

```javascript
function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Usage
const res = await request(port, 'GET', '/api/board');
assert(res.status === 200);
const board = res.json();
assert(board.taskPlan !== undefined);
```

### Use Board State for Verification

```javascript
// Instead of mocking internals, check board.json state
async function test_taskCreation(port) {
  // Act: create task plan via API
  await request(port, 'POST', '/api/tasks', {
    goal: 'Test goal',
    phase: 'test',
    tasks: [{ id: 'T1', title: 'test task', spec: 'do something', status: 'pending' }],
  });

  // Assert: verify board state via API
  const res = await request(port, 'GET', '/api/tasks');
  const plan = res.json();
  assert(plan.tasks.length === 1);
  assert(plan.tasks[0].id === 'T1');
  assert(plan.tasks[0].status === 'pending');
}
```

### Test Task Lifecycle

```javascript
async function test_taskLifecycle(port) {
  // Setup: create task plan
  await request(port, 'POST', '/api/tasks', {
    goal: 'lifecycle test',
    phase: 'test',
    tasks: [{ id: 'T1', title: 'task', spec: 'spec', status: 'pending' }],
  });

  // Dispatch
  await request(port, 'POST', '/api/tasks/T1/dispatch', { assignee: 'agent-1' });
  let board = (await request(port, 'GET', '/api/board')).json();
  assert(board.taskPlan.tasks[0].status === 'dispatched');

  // Update to in_progress
  await request(port, 'POST', '/api/tasks/T1/status', { status: 'in_progress' });
  board = (await request(port, 'GET', '/api/board')).json();
  assert(board.taskPlan.tasks[0].status === 'in_progress');

  // Complete
  await request(port, 'POST', '/api/tasks/T1/update', {
    status: 'completed',
    result: 'Task completed successfully',
  });
  board = (await request(port, 'GET', '/api/board')).json();
  assert(board.taskPlan.tasks[0].status === 'completed');
}
```

### Test SSE Events

```javascript
async function test_sseEvents(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/api/events`, res => {
      let received = '';
      res.on('data', chunk => {
        received += chunk.toString();
        if (received.includes('data:')) {
          res.destroy(); // Got an event, test passes
          resolve();
        }
      });
      setTimeout(() => {
        res.destroy();
        reject(new Error('No SSE event received within timeout'));
      }, 5000);
    });

    // Trigger an event by modifying the board
    setTimeout(() => {
      request(port, 'POST', '/api/tasks', { goal: 'sse test', phase: 'test', tasks: [] });
    }, 100);
  });
}
```

## Anti-Patterns

### AP-1: Don't Mock Internal Functions

```javascript
// BAD: Mocking internal board loading
const originalLoadBoard = loadBoard;
loadBoard = () => ({ taskPlan: { tasks: [] } }); // mocked
// test...
loadBoard = originalLoadBoard;

// GOOD: Test through HTTP API with real board
await request(port, 'POST', '/api/tasks', { goal: 'test', phase: 'p', tasks: [] });
const board = (await request(port, 'GET', '/api/board')).json();
assert(board.taskPlan.tasks.length === 0);
```

### AP-2: Don't Test Implementation Details

```javascript
// BAD: Asserting internal file format
const raw = fs.readFileSync('board.json', 'utf8');
assert(raw.includes('"status":"pending"'));

// GOOD: Test through public API behavior
const res = await request(port, 'GET', '/api/tasks');
const plan = res.json();
assert(plan.tasks[0].status === 'pending');
```

### AP-3: Don't Leak Test State

```javascript
// BAD: Tests depend on shared board.json
// Test A creates tasks, Test B expects them to exist

// GOOD: Each test sets up its own state
async function test_something(port) {
  // Setup: create fresh task plan
  await request(port, 'POST', '/api/tasks', {
    goal: 'isolated test',
    phase: 'test',
    tasks: [{ id: 'T1', title: 'test', spec: 'spec', status: 'pending' }],
  });
  // Test against this specific state
}
```

### AP-4: Don't Check Only Status Codes

```javascript
// BAD: Only checking HTTP status
const res = await request(port, 'GET', '/api/board');
assert(res.status === 200); // Passes even if response body is wrong!

// GOOD: Check status AND body
const res = await request(port, 'GET', '/api/board');
assert(res.status === 200);
const board = res.json();
assert(board.taskPlan !== undefined);
assert(Array.isArray(board.taskPlan.tasks));
```

### AP-5: Don't Use Arbitrary Sleeps

```javascript
// BAD: Arbitrary sleep hoping server is ready
await new Promise(r => setTimeout(r, 5000));

// GOOD: Poll until server responds
async function waitForServer(port, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await request(port, 'GET', '/api/board');
      return; // Server is ready
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start within timeout');
}
```

### AP-6: Don't Forget Cleanup

```javascript
// BAD: Leaving server process running
const server = spawn('node', ['server.js']);
// tests run...
// server still running after tests finish!

// GOOD: Always clean up
const server = spawn('node', ['server.js']);
try {
  await waitForServer(port);
  await runTests(port);
} finally {
  server.kill();
  // Clean up test artifacts
  try { fs.unlinkSync('test-board.json'); } catch {}
}
```

## Server Testing

Tests for server.js HTTP endpoints.

**Key patterns:**
- Start server with `node server.js` as child process
- Use a separate port (not 3461) to avoid conflicts
- Test all CRUD operations through HTTP
- Verify board.json state changes through GET /api/board
- Test error cases (404, 400, invalid transitions)

**Endpoints to test:**
- `GET /api/board` — returns full board
- `POST /api/tasks` — creates task plan
- `POST /api/tasks/:id/dispatch` — dispatches task
- `POST /api/tasks/:id/status` — updates status
- `POST /api/tasks/:id/update` — updates task fields
- `POST /api/tasks/:id/unblock` — unblocks task
- `POST /api/tasks/dispatch` — batch dispatch
- `GET /api/signals` — returns signals
- `POST /api/signals` — emits signal
- `GET /api/insights` — returns insights
- `GET /api/events` — SSE stream

## Evolution Testing

Tests for the signal → insight → lesson pipeline (test-evolution-loop.js).

**Key patterns:**
- Post signals via `/api/signals`
- Run retro.js to generate insights from signals
- Verify insights appear via `/api/insights`
- Apply insights and verify lessons are created
- End-to-end: signals → retro → insights → apply → lessons

## Smoke Testing

Quick validation that all endpoints respond correctly (smoke-test.js).

**Key patterns:**
- Accepts port as CLI argument
- Tests each endpoint with minimal request
- Validates HTTP status codes
- Checks Content-Type headers
- Validates JSON response structure
- Can target specific endpoints: `node smoke-test.js 3461 /api/controls`

---

## Checklist for New Tests

Before submitting:
- [ ] Test uses real HTTP requests (not mocked internals)
- [ ] Test sets up its own state (no dependency on other tests)
- [ ] Test cleans up: kills server, removes temp files
- [ ] Test verifies both HTTP status and response body
- [ ] Test covers error paths, not just happy paths
- [ ] Test passes when run standalone: `node <test-file>.js`
- [ ] No arbitrary sleeps — use polling or event-based waiting

## References

- Code quality skill: `.claude/skills/code-quality/SKILL.md`
- Project principles: `.claude/skills/project-principles/SKILL.md`
- CLAUDE.md testing conventions
