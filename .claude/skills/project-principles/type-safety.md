# Consistent Data Structures

**Use well-defined schemas and clear object shapes. Never rely on magic strings or loose typing.**

## Core Principle

In a zero-dependency JavaScript project, we don't have TypeScript or a type system. Instead, we enforce correctness through **consistent patterns, clear schemas, and disciplined naming**.

**Structural consistency is non-negotiable.**

## The Four Rules

### 1. Use Constants for Enum-Like Values

Raw strings lose semantic meaning and invite typos.

**Never do this:**
```javascript
// Magic strings scattered everywhere
if (task.status === 'in progress') { /* typo: should be 'in_progress' */ }
task.status = 'InProgress'; // inconsistent casing
```

**Always do this:**
```javascript
const TASK_STATUS = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  IN_PROGRESS: 'in_progress',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
};

if (task.status === TASK_STATUS.IN_PROGRESS) { /* safe */ }
task.status = TASK_STATUS.COMPLETED; // consistent
```

### 2. Make Invalid States Obvious

Use clear object shapes so invalid data is visible.

**Never do this:**
```javascript
// Loose object — nothing prevents invalid states
const task = {
  status: 'running',       // not a valid status
  started: 'maybe',        // should be a timestamp or null
  result: 42,              // should be a string or object
};
```

**Always do this:**
```javascript
// Clear schema with documented shape
function createTask(id, title, spec) {
  return {
    id,                    // 'T1', 'T2', etc.
    title,                 // string
    spec,                  // string — what to do
    status: TASK_STATUS.PENDING,
    assignee: null,        // string (agent name) or null
    depends: [],           // string[] — task IDs
    result: null,          // string or null — completion summary
    blocker: null,         // string or null — what's blocking
    lastReply: null,       // string or null — last agent message
    reviewScore: null,     // number 0-100 or null
  };
}
```

### 3. Validate External Input at Boundaries

Trust internal data. Validate at the edges (API handlers, file loading).

**Never do this:**
```javascript
// Validating everywhere
function updateTask(board, taskId, newStatus) {
  if (!board) throw new Error('No board');
  if (!board.taskPlan) throw new Error('No taskPlan');
  if (!Array.isArray(board.taskPlan.tasks)) throw new Error('Tasks not array');
  if (typeof taskId !== 'string') throw new Error('taskId not string');
  // ... 10 more checks
  const task = board.taskPlan.tasks.find(t => t.id === taskId);
  task.status = newStatus;
}
```

**Always do this:**
```javascript
// Validate at the HTTP handler (boundary)
function handleStatusUpdate(req, res, board) {
  const { id } = req.params;
  const { status } = req.body;
  if (!id || !status) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'Missing id or status' }));
  }
  if (!Object.values(TASK_STATUS).includes(status)) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: `Invalid status: ${status}` }));
  }
  // Internal function trusts validated input
  updateTaskStatus(board, id, status);
  saveBoard(board);
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));
}

// Internal function — no validation needed
function updateTaskStatus(board, taskId, status) {
  const task = board.taskPlan.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  task.status = status;
}
```

### 4. Name Fields Descriptively

Clear names prevent confusion across a large codebase.

**Never do this:**
```javascript
const msg = { id: 'T3', a: 'build', s: 'pending', d: ['T1', 'T2'] };
```

**Always do this:**
```javascript
const task = {
  id: 'T3',
  title: 'build UI component',
  status: 'pending',
  depends: ['T1', 'T2'],
};
```

## Common Patterns in Karvi

### Board Schema

The board.json has a well-defined structure. Respect it:

```javascript
// board.json shape
{
  taskPlan: {
    goal: 'string',
    phase: 'string',
    tasks: [/* Task objects */],
  },
  conversations: [/* Conversation objects */],
  participants: [/* Participant objects */],
  signals: [/* Signal objects */],
  insights: [/* Insight objects */],
  lessons: [/* Lesson objects */],
  controls: {/* Control parameters */},
}
```

### Task Status Transitions

```javascript
// Valid transitions — enforce them
const VALID_TRANSITIONS = {
  pending:     ['dispatched'],
  dispatched:  ['in_progress', 'pending'],
  in_progress: ['completed', 'blocked'],
  blocked:     ['in_progress'],
  completed:   [], // terminal
};

function isValidTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) || false;
}
```

### API Response Format

**Bad:**
```javascript
// Inconsistent response formats across endpoints
res.end(JSON.stringify({ task }));           // sometimes wrapped
res.end(JSON.stringify(task));               // sometimes raw
res.end(JSON.stringify({ success: true }));  // sometimes boolean
res.end('ok');                               // sometimes plain text
```

**Good:**
```javascript
// Consistent response format
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify(task)); // Always JSON, always the relevant data
```

### Event/Signal Schema

```javascript
// Well-defined signal structure
function createSignal(type, source, data) {
  return {
    type,           // 'review_result', 'task_completed', etc.
    source,         // 'retro', 'process-review', 'server'
    data,           // type-specific payload
    ts: new Date().toISOString(),
  };
}
```

## Advanced Patterns

### Factory Functions Over Raw Objects

```javascript
// Bad: raw object literals everywhere
const signal = { type: 'review_result', score: 85, task: 'T3', ts: Date.now() };

// Good: factory function ensures consistent shape
function reviewSignal(taskId, score, summary) {
  return createSignal('review_result', 'process-review', {
    taskId, score, summary,
  });
}
```

### Destructuring for Clear Contracts

```javascript
// Bad: accessing random properties
function processTask(obj) {
  doSomething(obj.a, obj.b.c, obj.d[0]);
}

// Good: destructure to show what you need
function processTask({ id, spec, assignee, depends }) {
  const msg = buildMessage(id, spec, depends);
  return dispatch(assignee, msg);
}
```

## Benefits of Structural Consistency

### Catch Errors Early
- Consistent schemas surface mistakes at write time
- Factory functions prevent malformed objects
- Const enums prevent typos

### Self-Documenting Code
- Object shapes serve as documentation
- Clear function contracts
- Easier to understand codebase

### Safer Modifications
- Consistent patterns mean consistent expectations
- Grep for field names across the codebase
- Confidence when refactoring

## Remember

**Structure is not overhead - it's a safety guarantee.**

- Constants for enum-like values
- Factory functions for complex objects
- Validate at boundaries, trust internally
- Name fields descriptively

**If a string appears in more than one place, it should be a constant.**
