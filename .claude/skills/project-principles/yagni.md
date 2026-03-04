# YAGNI (You Aren't Gonna Need It)

**This is a CORE PRINCIPLE for this project.** We follow the YAGNI principle strictly to keep the codebase simple and maintainable.

## What is YAGNI?

YAGNI stands for "You Aren't Gonna Need It" - a principle that states you should not add functionality until it is actually needed, not just when you foresee that you might need it.

## Core Philosophy

**Start with the simplest solution that works, then evolve as actual needs arise.**

The enemy of good code is not bad code - it's unnecessary code. Every line of code you write:
- Must be tested
- Must be maintained
- Increases complexity
- Can introduce bugs

Therefore, only write code that solves **current, real problems**.

## The Four Rules

### 1. Don't Add Functionality Until It's Actually Needed

**Bad:**
```javascript
// Adding configuration options "just in case"
const DEFAULT_CONFIG = {
  port: 3461,
  host: '0.0.0.0',
  maxRetries: 3,
  retryDelay: 1000,
  enableMetrics: false,
  metricsPort: 9090,
  enableRateLimit: false,
  rateLimitPerMinute: 100,
  enableCaching: false,
  cacheTtl: 300,
  enableWebhooks: false,
  webhookSecret: '',
  // 15 more options we don't use...
};

// We only use port right now
```

**Good:**
```javascript
// Only add what you need NOW
const PORT = process.env.PORT || 3461;

// Add more config options later when they're actually needed
```

### 2. Start with the Simplest Solution That Works

**Bad:**
```javascript
// Over-engineered abstraction for simple use case
class StorageAdapter {
  constructor(type) {
    this.type = type;
    this.adapters = {
      file: new FileAdapter(),
      redis: new RedisAdapter(),     // We don't even use Redis
      postgres: new PostgresAdapter(), // We don't use Postgres either
    };
  }
  get(key) { return this.adapters[this.type].get(key); }
  set(key, val) { return this.adapters[this.type].set(key, val); }
}

// Only using it to read/write board.json
```

**Good:**
```javascript
// Simple solution for current need
function loadBoard() {
  return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
}
function saveBoard(board) {
  const tmp = BOARD_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, BOARD_PATH);
}

// Add abstraction later if you actually need multiple storage backends
```

### 3. Avoid Premature Abstractions

**Bad:**
```javascript
// Creating class hierarchy for 2 similar functions
class Validator {
  validate(value) { throw new Error('Not implemented'); }
}
class TaskIdValidator extends Validator {
  validate(id) { return /^T\d+$/.test(id); }
}
class StatusValidator extends Validator {
  validate(status) { return ['pending', 'dispatched', 'in_progress', 'completed', 'blocked'].includes(status); }
}
class ValidatorFactory {
  static create(type) {
    const validators = { taskId: TaskIdValidator, status: StatusValidator };
    return new validators[type]();
  }
}
```

**Good:**
```javascript
// Simple functions - add abstraction only if you need it
function isValidTaskId(id) { return /^T\d+$/.test(id); }
function isValidStatus(status) {
  return ['pending', 'dispatched', 'in_progress', 'completed', 'blocked'].includes(status);
}
```

### 4. Delete Unused Code Aggressively

**Bad:**
```javascript
// Keeping "just in case" code
function dispatchTask(task, board) {
  // This feature was removed but we kept the code
  // if (task.priority === 'urgent') {
  //   return dispatchUrgent(task);
  // }
  return dispatchNormal(task, board);
}

// Unused utility function "might be useful someday"
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
```

**Good:**
```javascript
// Delete unused code - git history preserves it if you need it
function dispatchTask(task, board) {
  return dispatchNormal(task, board);
}

// deepClone function deleted - add it back if/when needed
```

## Project-Specific Examples

### Test Helpers

**Bad:**
```javascript
// test-utils.js with many unused helpers
function createMockBoard() { /* ... */ }
function createMockTask() { /* ... */ }
function createMockConversation() { /* ... */ }
function setupTestServer() { /* ... */ }
function mockAgentResponse() { /* ... */ }

// Only createMockBoard is actually used in tests
```

**Good:**
```javascript
// test-utils.js with only actively used helpers
function createMockBoard() { /* ... */ }

// Add other helpers only when tests actually need them
```

### API Endpoints

**Bad:**
```javascript
// Adding endpoints we don't need yet
server.on('request', (req, res) => {
  if (url === '/api/tasks') { /* ... */ }
  if (url === '/api/tasks/search') { /* never used */ }
  if (url === '/api/tasks/export') { /* never used */ }
  if (url === '/api/tasks/import') { /* never used */ }
  if (url === '/api/tasks/archive') { /* never used */ }
  if (url === '/api/tasks/analytics') { /* never used */ }
});
```

**Good:**
```javascript
// Only endpoints that are actually called
server.on('request', (req, res) => {
  if (url === '/api/tasks') { /* ... */ }
  // Add search, export, etc. when actually needed
});
```

### Configuration

**Bad:**
```javascript
// Extensive controls object with unused options
const defaultControls = {
  quality_threshold: 70,
  auto_review: true,
  max_review_attempts: 3,
  auto_redispatch: true,
  review_agent: 'engineer_lite',
  // These are never read anywhere:
  enable_notifications: false,
  notification_webhook: '',
  enable_audit_log: false,
  audit_retention_days: 30,
  enable_parallel_dispatch: false,
  max_parallel_tasks: 5,
};
```

**Good:**
```javascript
// Starting minimal - only what the code actually reads
const defaultControls = {
  quality_threshold: 70,
  auto_review: true,
  max_review_attempts: 3,
  auto_redispatch: true,
  review_agent: 'engineer_lite',
};

// Grow controls as features are added
```

### "Just in Case" Parameters

**Bad:**
```javascript
// Adding optional parameters we don't use yet
function dispatchTask(task, board, {
  timeout = 180,
  retries = 3,
  priority = 'normal',
  callback = null,
  dryRun = false,
  verbose = false,
  agent = null,
  metadata = {},
} = {}) {
  // Currently only using task and board...
  const msg = buildDispatchMessage(task, board);
  return spawnAgent(task.assignee, msg);
}
```

**Good:**
```javascript
// Start simple
function dispatchTask(task, board) {
  const msg = buildDispatchMessage(task, board);
  return spawnAgent(task.assignee, msg);
}

// Add timeout, retries, etc. when they're actually needed
```

## When to Add Complexity

Only add complexity when:

### The Need is Current and Real
```javascript
// Bad: Adding caching "just in case performance becomes an issue"
// Good: Adding caching because board.json reads are measured as bottleneck
```

### You Have 3+ Use Cases
```javascript
// Bad: Abstracting after first use
// Good: Abstracting after third similar usage
```

### Complexity is Less Than Duplication
```javascript
// Bad: Creating complex helper to avoid 3 lines of duplication
// Good: Creating helper when duplication causes real maintenance burden
```

## Mental Framework

Before adding any code, ask:

1. **Do we need this RIGHT NOW?**
   - Not "might we need it later"
   - Not "it would be nice to have"
   - RIGHT NOW

2. **What is the simplest solution?**
   - Not "what's the most elegant"
   - Not "what's the most flexible"
   - The SIMPLEST

3. **Can we delete something instead?**
   - Maybe this feature isn't needed at all
   - Maybe existing code can be simplified

## The Rule of Three

A good heuristic:

- **First time:** Write code inline
- **Second time:** Copy and paste (with awareness)
- **Third time:** Abstract into reusable function

Don't abstract before the third use.

## Practical Checklist

Before committing code, ask yourself:

- [ ] Is every function/parameter actually being used?
- [ ] Could this be simpler?
- [ ] Am I building for current needs or imagined future needs?
- [ ] Can I delete any code?
- [ ] Would this code still be needed if requirements change?

If you're building for imagined future needs, STOP and simplify.

## Remember

**The best code is no code at all.**

Every line of code is a liability. Write the minimum necessary to solve the current problem well.

**"Premature optimization is the root of all evil" - Donald Knuth**

This applies to features too:
**"Premature abstraction is the root of all evil."**
