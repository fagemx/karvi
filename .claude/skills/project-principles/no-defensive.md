# Avoid Defensive Programming

**Let errors propagate naturally. Don't over-catch or swallow errors.**

## What is Defensive Programming?

Defensive programming is the practice of adding excessive error handling, validation, and safety checks to "defend" against errors - even when those errors should naturally propagate or can't be meaningfully handled.

**In this project, we AVOID defensive programming.**

## Core Philosophy

**Only handle errors when you can meaningfully recover.**

In a zero-dependency Node.js server, keep error handling simple and purposeful. Don't wrap every operation in try/catch — catch errors at the level where you can actually do something about them (the HTTP handler).

## The Three Rules

### 1. Only Handle Errors When You Can Meaningfully Recover

**Bad - Defensive programming:**
```javascript
function createTask(board, taskData) {
  try {
    const task = { id: taskData.id, status: 'pending', ...taskData };
    try {
      board.taskPlan.tasks.push(task);
      try {
        saveBoard(board);
        return task;
      } catch (e) {
        console.error('Failed to save board:', e);
        return null;
      }
    } catch (e) {
      console.error('Failed to push task:', e);
      return null;
    }
  } catch (e) {
    console.error('Failed to create task:', e);
    return null;
  }
}
```

**Problems:**
- Catches all errors indiscriminately
- Returns null — masks the real problem
- `console.error` before returning null adds noise
- Caller has no idea what went wrong

**Good - Let errors propagate:**
```javascript
function createTask(board, taskData) {
  const task = { id: taskData.id, status: 'pending', ...taskData };
  board.taskPlan.tasks.push(task);
  saveBoard(board);
  return task;
}
```

**Why good:**
- If saveBoard fails, the error propagates with full stack trace
- Caller (HTTP handler) decides how to respond
- Simpler and more maintainable

### 2. Let Errors Bubble Up — Catch at the Boundary

**Bad - Catching too early:**
```javascript
function getTask(board, taskId) {
  try {
    const task = board.taskPlan.tasks.find(t => t.id === taskId);
    if (!task) {
      console.warn('Task not found:', taskId);
      return null;
    }
    return task;
  } catch (e) {
    console.error('Error finding task:', e);
    return null;
  }
}
```

**Problems:**
- try/catch around code that can't throw
- Returning null masks the "not found" case
- Logging at wrong level

**Good - Let it propagate:**
```javascript
function getTask(board, taskId) {
  const task = board.taskPlan.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}
```

**Why good:**
- Error propagates with clear message
- HTTP handler catches and returns 404
- No unnecessary try/catch

### 3. Trust Internal Data

**Bad - Over-defensive validation:**
```javascript
function calculateProgress(tasks) {
  if (!tasks) return 0;
  if (!Array.isArray(tasks)) return 0;
  if (tasks.length === 0) return 0;

  let completed = 0;
  for (const task of tasks) {
    if (task && typeof task === 'object' && typeof task.status === 'string') {
      if (task.status === 'completed') {
        completed++;
      }
    }
  }
  return tasks.length > 0 ? completed / tasks.length : 0;
}
```

**Problems:**
- Overly defensive — tasks comes from board.json which we control
- Silently returns 0 for bad data instead of failing fast
- If data is corrupted, we WANT to know about it

**Good - Trust internal data:**
```javascript
function calculateProgress(tasks) {
  if (tasks.length === 0) return 0;
  const completed = tasks.filter(t => t.status === 'completed').length;
  return completed / tasks.length;
}
```

**Why good:**
- board.json is our single source of truth — if tasks is corrupt, we want it to blow up
- Simple, readable, correct
- Validate at the boundary (API input), not inside utility functions

## When to Use Explicit Error Handling

### When You Have Specific Recovery Logic

```javascript
function loadBoard(boardPath) {
  try {
    return JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Meaningful recovery: create default board
      const defaultBoard = { taskPlan: { tasks: [] }, signals: [], insights: [] };
      fs.writeFileSync(boardPath, JSON.stringify(defaultBoard, null, 2));
      return defaultBoard;
    }
    throw e; // Re-throw other errors (corrupt JSON, permission denied)
  }
}
```

**Why good:** Specific fallback for "file not found". Not just logging and re-throwing.

### When You Need to Transform the Error for the API

```javascript
function handleTaskUpdate(req, res, board) {
  try {
    const task = getTask(board, req.params.id); // may throw "not found"
    updateTaskStatus(task, req.body.status);     // may throw "invalid transition"
    saveBoard(board);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
  } catch (e) {
    if (e.message.includes('not found')) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: e.message }));
    } else if (e.message.includes('invalid')) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    } else {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }
}
```

**Why good:** HTTP handler is the right place to transform errors into status codes.

### When You Need Cleanup Logic

```javascript
function processWithTempFile(data) {
  const tmpPath = path.join(os.tmpdir(), `karvi-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    const result = doProcessing(tmpPath);
    return result;
  } finally {
    // Cleanup regardless of success or failure
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
```

**Why good:** finally handles cleanup. The empty catch on unlink is acceptable — cleanup failure is non-critical.

## Project-Specific Guidelines

### Board Operations

**Bad:**
```javascript
function saveBoard(board) {
  try {
    const json = JSON.stringify(board, null, 2);
    try {
      fs.writeFileSync(BOARD_PATH, json);
      console.log('Board saved successfully');
    } catch (e) {
      console.error('Failed to write board:', e);
      throw e;
    }
  } catch (e) {
    console.error('Failed to stringify board:', e);
    throw e;
  }
}
```

**Good:**
```javascript
function saveBoard(board) {
  const json = JSON.stringify(board, null, 2);
  const tmpPath = BOARD_PATH + '.tmp';
  fs.writeFileSync(tmpPath, json);
  fs.renameSync(tmpPath, BOARD_PATH); // atomic write
}
```

**Why:** Atomic write prevents corruption. If stringify or write fails, it throws naturally with full context.

### HTTP Request Handlers

**Bad:**
```javascript
// Catching every possible thing in every handler
if (url === '/api/tasks') {
  try {
    const board = loadBoard();
    if (board && board.taskPlan && board.taskPlan.tasks) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(board.taskPlan.tasks));
    } else {
      res.writeHead(500);
      res.end('Invalid board structure');
    }
  } catch (e) {
    console.error('Error in /api/tasks:', e);
    res.writeHead(500);
    res.end('Internal error');
  }
}
```

**Good:**
```javascript
// Trust the board structure — validate at write time, not every read
if (url === '/api/tasks') {
  const board = loadBoard();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(board.taskPlan.tasks));
}
```

**Why:** board.json is our single source of truth. If it's corrupt, we have bigger problems. Top-level error handler catches unexpected errors.

## Mental Framework

Before adding explicit error handling, ask:

### 1. Can I Meaningfully Handle This Error?

- "Log and re-throw" → Not meaningful, let it propagate
- "Return null/undefined" → Masks problem, let it propagate
- "Show HTTP error to user" → Meaningful (in handler layer)
- "Use fallback data" → Meaningful

### 2. Where Should This Error Be Handled?

- In utility function → Too early, let it propagate
- In data layer → Too early, let it propagate
- In HTTP handler → Right place
- In server.on('error') → Right place for uncaught errors

### 3. Would Silent Failure Be Worse Than Crashing?

- Returning null for missing task → User gets confusing 200 with empty data
- Throwing for missing task → User gets clear 404
- **Failing loudly is almost always better than failing silently**

## Common Anti-Patterns

### Anti-Pattern 1: Log and Re-throw

**Never do this:**
```javascript
try {
  doSomething();
} catch (e) {
  console.error('Failed:', e);
  throw e;
}
```

**Why bad:** Just let it throw. The top-level handler does the logging.

### Anti-Pattern 2: Return null/undefined on Error

**Avoid this:**
```javascript
function findTask(board, id) {
  try {
    return board.taskPlan.tasks.find(t => t.id === id) || null;
  } catch {
    return null;
  }
}
```

**Better:**
```javascript
function findTask(board, id) {
  return board.taskPlan.tasks.find(t => t.id === id) || null;
  // If board is corrupt, let it blow up — that's a real bug
}
```

### Anti-Pattern 3: Redundant Type Checks on Internal Data

**Avoid this:**
```javascript
if (task && typeof task.status === 'string' && task.status === 'completed') {
```

**Better:**
```javascript
if (task.status === 'completed') {
```

## Benefits of Avoiding Defensive Programming

### Cleaner Code
- Less boilerplate
- Easier to read
- Clearer logic flow

### Better Debugging
- Errors surface with full context and stack trace
- No masked failures
- Easier to identify root cause

### Idiomatic Node.js
- Let errors propagate naturally
- Handle at boundaries
- Trust the data you control

## Remember

**Trust your data. Let errors propagate. Catch at the boundary.**

Only add explicit error handling when you have a specific, meaningful way to handle the error.

**"The best error handling is no error handling — in the right places."**
