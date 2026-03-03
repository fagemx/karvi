# Innovation: gatherRecentSignals goalIds Filtering (#159)

## Problem Statement

`gatherRecentSignals(board, goalIds, limit)` accepts `goalIds` but never uses them. All departments receive identical signal context regardless of their assigned goals.

## Approach A: Indirect Task-Based Filtering

**How it works**: Map `goalIds` -> departments -> task IDs -> filter signals by `refs`/`data.taskId`.

```js
function gatherRecentSignals(board, goalIds, limit) {
  const max = limit || 10;
  const signals = (board.signals || []).slice(-max * 3);
  if (signals.length === 0) return '(no recent signals)';

  const typed = signals.filter(s =>
    s.type === 'review_result' || s.type === 'status_change' || s.type === 'lesson_validated'
  );
  if (typed.length === 0) return '(no relevant signals)';

  // If no goalIds provided, return all (backward compat)
  if (!goalIds || goalIds.length === 0) {
    return typed.slice(-max).map(s => `- [${s.type}] ${s.content || s.id}`).join('\n');
  }

  // Build set of task IDs related to these goals via department mapping
  const depts = board.village?.departments || [];
  const relevantDeptIds = new Set();
  for (const dept of depts) {
    if ((dept.goalIds || []).some(gid => goalIds.includes(gid))) {
      relevantDeptIds.add(dept.id);
    }
  }
  const tasks = board.taskPlan?.tasks || [];
  const relevantTaskIds = new Set();
  for (const t of tasks) {
    if (t.department && relevantDeptIds.has(t.department)) {
      relevantTaskIds.add(t.id);
    }
  }

  // Filter: signal references a relevant task, or has no task ref (generic)
  const filtered = typed.filter(s => {
    if (s.data?.taskId && relevantTaskIds.has(s.data.taskId)) return true;
    if (Array.isArray(s.refs) && s.refs.some(r => relevantTaskIds.has(r))) return true;
    // Generic signals (no task ref) - include as universally relevant
    if (!s.data?.taskId && (!Array.isArray(s.refs) || s.refs.length === 0)) return true;
    return false;
  });

  if (filtered.length === 0) return '(no relevant signals)';
  return filtered.slice(-max).map(s => `- [${s.type}] ${s.content || s.id}`).join('\n');
}
```

**Pros**:
- Works with existing signal structure -- no emitter changes needed
- Backward compatible: empty goalIds returns all signals
- Generic signals (lesson_validated) still included for all departments

**Cons**:
- Depends on board having tasks with department field populated
- Multiple lookups (departments -> tasks -> signals) adds complexity
- In early cycles with no tasks yet, all departments get same (generic) signals

## Approach B: Direct `data.goalId` Matching + Emitter Enhancement

**How it works**: Check `signal.data.goalId` / `signal.data.goalIds` directly. Requires updating signal emitters to include goal associations.

**Pros**:
- Cleaner, O(1) lookup per signal
- Self-documenting signal structure

**Cons**:
- Requires changing multiple signal emitter sites (routes/tasks.js, management.js, retro.js)
- Larger blast radius -- many files touched for a bug fix
- Goal mapping still needed at emit time (same complexity, different location)

## Approach C: Hybrid (Direct + Indirect Fallback)

**How it works**: Check `data.goalId` first (for future-proofed signals), then fall back to task-based indirect filtering.

```js
const filtered = typed.filter(s => {
  // Direct goal match (future-proof)
  if (s.data?.goalId && goalIds.includes(s.data.goalId)) return true;
  if (Array.isArray(s.data?.goalIds) && s.data.goalIds.some(g => goalIds.includes(g))) return true;
  // Indirect: task reference match
  if (s.data?.taskId && relevantTaskIds.has(s.data.taskId)) return true;
  if (Array.isArray(s.refs) && s.refs.some(r => relevantTaskIds.has(r))) return true;
  // Generic (no refs) - include
  if (!s.data?.taskId && (!Array.isArray(s.refs) || s.refs.length === 0)) return true;
  return false;
});
```

**Pros**:
- Future-proof: when emitters add goalId later, filtering automatically improves
- Works today via indirect path
- Minimal blast radius (only village-meeting.js changes)

**Cons**:
- Slightly more filter conditions

## Recommendation: Approach C (Hybrid)

Approach C is the best balance:
1. **Minimal blast radius** -- only `village-meeting.js` changes
2. **Works today** with existing signal structure via indirect task-department mapping
3. **Future-proof** -- supports direct `data.goalId` when signals are enriched later
4. **Backward compatible** -- empty goalIds returns all signals
5. **Generic signals included** -- `lesson_validated` (no task ref) still reaches all departments

The indirect mapping logic is straightforward (< 15 lines) and the performance is fine given the 500-signal cap on `board.signals` and typical `limit=10`.

## Test Strategy

1. **Unit test**: `gatherRecentSignals` with multi-department board, verify each department only sees its own signals
2. **Unit test**: Empty goalIds returns all signals (backward compat)
3. **Unit test**: Signals without task refs (generic) are included for all departments
4. **Integration**: Existing smoke test still passes
