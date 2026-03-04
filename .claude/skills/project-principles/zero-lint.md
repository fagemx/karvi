# Zero Tolerance for Sloppy Code

**All code must be clean. No dead code, no silenced errors, no sloppy shortcuts.**

## Core Principle

In this project, code quality is enforced through discipline, not external tools. Since we have zero external dependencies (no ESLint, no Prettier), **we maintain quality through consistent practices and vigilance**.

**If something smells wrong, fix it — don't ignore it.**

## The Four Rules

### 1. Never Leave Commented-Out Code

**Never do this:**
```javascript
function dispatchTask(task, board) {
  // const timeout = getTimeout(task);
  // if (timeout > MAX_TIMEOUT) {
  //   console.warn('Task timeout exceeded');
  //   return null;
  // }
  const msg = buildMessage(task, board);
  return spawnAgent(task.assignee, msg);
}
```

**Why this is bad:**
- Creates visual noise
- No one knows if it's still relevant
- Becomes permanent "temporary" code
- git history preserves everything

**Do this instead:**
```javascript
function dispatchTask(task, board) {
  const msg = buildMessage(task, board);
  return spawnAgent(task.assignee, msg);
}

// If you need the old code, use: git log -p -- server.js
```

### 2. Never Swallow Errors Silently

**Never do this:**
```javascript
try {
  const data = JSON.parse(rawBody);
  processData(data);
} catch (e) {
  // ignore
}

// Or the implicit version:
try { doSomething(); } catch {}
```

**Why this is bad:**
- Bugs become invisible
- Debugging becomes impossible
- Silent failures cause downstream problems

**Do this instead:**
```javascript
// If you truly don't care about the error, document WHY
try {
  fs.unlinkSync(tmpPath);
} catch {
  // Cleanup failure is non-critical — file may already be deleted
}

// For everything else, let it propagate or handle meaningfully
const data = JSON.parse(rawBody); // throws on invalid JSON — good!
processData(data);
```

### 3. Fix the Underlying Issue

Don't suppress symptoms — address the root cause.

**Bad — Suppressing the symptom:**
```javascript
// Hiding a real problem
const value = obj?.deeply?.nested?.value ?? 'fallback';
// Why is it sometimes undefined? Fix the source, not the consumer.

// Wrapping everything in try/catch "just in case"
try {
  board.taskPlan.tasks.forEach(t => { /* ... */ });
} catch {
  console.log('tasks might not exist');
}
```

**Good — Fixing the cause:**
```javascript
// Ensure board always has tasks (in loadBoard or createBoard)
function loadBoard() {
  const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  // Ensure required structure exists
  board.taskPlan = board.taskPlan || { tasks: [] };
  board.signals = board.signals || [];
  return board;
}

// Now consumers can trust the structure
board.taskPlan.tasks.forEach(t => { /* ... */ });
```

### 4. Keep Functions Focused and Clean

Every function should do one thing clearly.

**Bad:**
```javascript
function handleRequest(req, res) {
  // 200 lines of mixed concerns:
  // - URL parsing
  // - Authentication
  // - Body parsing
  // - Business logic
  // - Response formatting
  // - Error handling
  // - Logging
}
```

**Good:**
```javascript
function handleRequest(req, res) {
  const { url, method } = parseRequest(req);

  if (method === 'POST' && url === '/api/tasks') {
    return handleCreateTask(req, res);
  }
  if (method === 'GET' && url === '/api/board') {
    return handleGetBoard(req, res);
  }
  // ...
}
```

## Common Code Smells and Solutions

### Dead Code

**Bad:**
```javascript
function unusedHelper() {
  // This function is never called
  return 42;
}
```

**Good — Remove it:**
```javascript
// Delete the function. Git history preserves it if needed later.
```

### Unused Variables

**Bad:**
```javascript
function processTask(task, config, metadata) {
  // Only using task, config and metadata are unused
  return task.status === 'completed';
}
```

**Good — Remove or use:**
```javascript
function processTask(task) {
  return task.status === 'completed';
}
```

### Console.log Left Behind

**Bad:**
```javascript
function dispatchTask(task) {
  console.log('dispatching task:', task);          // debug leftover
  console.log('task.assignee:', task.assignee);    // debug leftover
  const result = spawnAgent(task.assignee, msg);
  console.log('dispatch result:', result);         // debug leftover
  return result;
}
```

**Good:**
```javascript
function dispatchTask(task) {
  const result = spawnAgent(task.assignee, msg);
  return result;
}

// Use intentional logging for important events, not debug scatter
```

### Redundant Conditions

**Bad:**
```javascript
if (task.status === 'completed') {
  return true;
} else {
  return false;
}
```

**Good:**
```javascript
return task.status === 'completed';
```

### Inconsistent Naming

**Bad:**
```javascript
const tsk = board.taskPlan.tasks.find(t => t.id === taskID);
const stat = tsk.status;
const res = checkStat(stat);
```

**Good:**
```javascript
const task = board.taskPlan.tasks.find(t => t.id === taskId);
const status = task.status;
const isValid = isValidStatus(status);
```

### Long Parameter Lists

**Bad:**
```javascript
function createTask(id, title, spec, status, assignee, depends, result, blocker, score) {
  return { id, title, spec, status, assignee, depends, result, blocker, score };
}
```

**Good:**
```javascript
function createTask({ id, title, spec, assignee = null, depends = [] }) {
  return {
    id, title, spec,
    status: TASK_STATUS.PENDING,
    assignee,
    depends,
    result: null,
    blocker: null,
    reviewScore: null,
  };
}
```

## Pre-Commit Workflow

### Always check before committing:

```bash
# Verify all modified .js files parse correctly
node --check server.js
node --check management.js
node --check process-review.js
node --check retro.js

# Run tests
npm test
```

All must pass before committing.

## When You Think a Pattern is Wasteful

If you believe a clean code rule is unnecessary:

1. **First, assume the rule is right** — It probably is
2. **Understand the rule's purpose** — Why does this pattern exist?
3. **Try to follow it** — There's usually a good reason
4. **Discuss with the team** — Don't just break the pattern

**In this project, we maintain zero tolerance.** Don't take shortcuts.

## Benefits of Zero-Sloppy Tolerance

### Consistent Code Quality
- All code follows same standards
- No exceptions create inconsistency
- Easy to understand codebase

### Catch Bugs Early
- Dead code might indicate logic errors
- Unused variables might mean a forgotten step
- Silenced errors hide real problems

### Better Collaboration
- No arguments about code style
- Clear expectations
- Code review is about logic, not formatting

### Easier Maintenance
- Find dead code by searching
- Refactor with confidence
- No technical debt accumulation

## Remember

**Clean code is not optional — it's the baseline.**

- Never leave commented-out code
- Never swallow errors silently
- Fix the root cause, not the symptom
- Keep functions focused

**"If it's not worth doing right, it's not worth doing."**
