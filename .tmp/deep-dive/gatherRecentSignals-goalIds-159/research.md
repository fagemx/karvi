# Research: gatherRecentSignals ignores goalIds (#159)

## Bug Location

**File**: `server/village/village-meeting.js:58`
**Function**: `gatherRecentSignals(board, goalIds, limit)`

## Current Behavior

```js
function gatherRecentSignals(board, goalIds, limit) {
  const max = limit || 10;
  const signals = (board.signals || []).slice(-max * 3);
  if (signals.length === 0) return '(no recent signals)';

  const relevant = signals
    .filter(s => s.type === 'review_result' || s.type === 'status_change' || s.type === 'lesson_validated')
    .slice(-max);
  // goalIds is never referenced - all departments get identical signals
}
```

Called at line 233: `gatherRecentSignals(board, dept.goalIds || [])` -- `goalIds` is passed but silently ignored.

## Signal Structure in the Codebase

All signals follow this shape:
```js
{
  id: 'sig-xxx',
  ts: '2026-...',
  by: 'server.js' | 'gate' | 'kernel' | 'village-retro' | 'plan-dispatcher',
  type: string,
  content: string,
  refs: string[],      // typically task IDs
  data: { ... }        // type-specific payload
}
```

### Signal Types Relevant to `gatherRecentSignals`

| Type | Emitter | `refs` | `data` fields |
|------|---------|--------|---------------|
| `status_change` | `routes/tasks.js:651,877` | `[taskId]` | `{ taskId, from, to, assignee }` |
| `review_result` | `routes/evolution.js:57` (custom) | custom | custom |
| `lesson_validated` | `management.js:240` | (none) | insight-related |

### Other Signal Types (NOT currently gathered)

| Type | Emitter | `data` fields |
|------|---------|---------------|
| `steps_created` | `routes/tasks.js` | `{ taskId, runId, count }` |
| `step_completed/failed/dead` | `routes/tasks.js` | `{ taskId, stepId, from, to }` |
| `insight_applied/rolled_back` | `management.js` | insight data |
| `village_plan_dispatched` | `plan-dispatcher.js` | `{ cycleId, taskIds }` |
| `cycle_task_result` | `retro.js` | `{ cycleId, taskId, department }` |
| `cycle_completed` | `retro.js` | `{ cycleId, total, completed }` |

## Goal -> Signal Mapping Chain

**No signal currently carries `data.goalId` directly.** The connection is indirect:

```
goalIds -> departments (dept.goalIds) -> tasks (task.department) -> signals (signal.refs / signal.data.taskId)
```

- Execution tasks created by `plan-dispatcher.js` carry `task.department` (line 125)
- `status_change` signals carry `data.taskId` and `refs: [taskId]`
- `cycle_task_result` signals (from retro) carry `data.department`

## Call Sites

Only 1 call site:
- `village-meeting.js:233` -- inside `generateMeetingTasks()` during proposal task construction

## Test Coverage

- `test-village-smoke.js` exercises `generateMeetingTasks()` and validates proposal instruction content
- No direct test for `gatherRecentSignals()` filtering behavior
- Test board at line 37-59 has `goalIds: ['G1']` on the engineering department

## Impact Assessment

- **In single-department setups** (current): no visible impact -- only one department sees all signals anyway
- **In multi-department setups**: engineering dept receives content-team signals and vice versa, adding noise to proposal prompts leading to less focused proposals
- **Data correctness**: the comment at line 63 says "Prefer signals related to the department's goals" but the code doesn't implement this

## Key Constraint

Since no signal currently carries `data.goalId`, filtering must use indirect mapping: `goalIds -> board.village.departments -> matching dept IDs -> board.taskPlan.tasks with matching department -> signal.refs/data.taskId`. Generic signals without task references (like `lesson_validated`) need a fallback policy.
