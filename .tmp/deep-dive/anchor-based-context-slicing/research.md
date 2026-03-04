# Research Phase: Anchor-Based Context Slicing

## Issue Summary

**Issue #237**: feat(steps): anchor-based context slicing — stop injecting full upstream output

**Problem**: Step pipeline currently uses "full text injection" - each step receives the complete upstream artifact as JSON, consuming ~40% of prompt tokens with unnecessary data.

**Solution**: Inject summaries instead of full payloads, with per-step relevance filtering.

---

## Current Implementation Analysis

### 1. Upstream Artifact Injection Location

**File**: `server/step-worker.js`

**Function**: `buildStepMessage(envelope, upstreamArtifacts, board, task)`

**Lines**: 743-757

```javascript
// Inject upstream artifacts (from completed dependency tasks)
if (Array.isArray(upstreamArtifacts) && upstreamArtifacts.length > 0) {
  lines.push('', '## Upstream Task Outputs');
  for (const u of upstreamArtifacts) {
    lines.push(`### ${u.id} — ${u.title || '(untitled)'} [${u.status}]`);
    if (u.payload) {
      lines.push('```json');
      lines.push(JSON.stringify(u.payload, null, 2));
      lines.push('```');
    } else if (u.summary) {
      lines.push(u.summary);
    }
  }
  lines.push('');
}
```

**Current Behavior**:
- Dumps full `u.payload` as formatted JSON (potentially thousands of tokens)
- Falls back to `u.summary` only if payload is null
- No reference to full artifact file
- No filtering based on step type

### 2. Artifact Structure

**Source**: `server/management.js:438-458` - `gatherUpstreamArtifacts()`

**Artifact Fields**:
- `id`: Dependency task ID
- `title`: Task title
- `status`: Task status
- `summary`: Either from `dep.lastReply` or `dep.result.summary` (sliced to 600 chars)
- `payload`: From `dep.result.payload` (structured data, can be large)

**Missing Field**: `output_ref` - Not currently gathered from dependency tasks

### 3. Step Output Reference

**Source**: `server/step-worker.js:312`

When a step completes successfully:
```javascript
output_ref: artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'output')
```

This creates a path like: `server/artifacts/{run_id}/{step_id}.output.json`

### 4. Artifact Storage

**Source**: `server/artifact-store.js`

- Artifacts stored as JSON files in `server/artifacts/{run_id}/`
- Atomic writes using `.tmp` file then rename
- Files named: `{step_id}.{kind}.json` where kind is `input`, `output`, or `log`

---

## Requirements Analysis

### From Task Description

1. **Change upstream injection in buildStepMessage()**:
   - Use `u.summary` instead of `JSON.stringify(u.payload)`
   - Add reference: `(Full output: {u.output_ref})`
   - Keep summary fallback for null payload

2. **Define UPSTREAM_RELEVANCE map**:
   - `implement`: needs plan summary + payload (plan conclusions)
   - `test`: needs implement summary only
   - `review`: needs implement summary only
   - `plan`: no upstream (first step)

3. **Filter injection by step type**:
   - Only include fields defined in UPSTREAM_RELEVANCE for current step type

### Gap Analysis

**Missing in gatherUpstreamArtifacts()**:
- Need to include `output_ref` field from dependency tasks
- Need to understand how to get step-level output_ref from task-level dependency

**Clarification Needed**:
- Issue mentions line 669-682, but actual injection is at 743-757
- Task says "implement needs plan summary + payload" - but payload is the large data we want to avoid
- Need to clarify: does "payload" in requirements mean "plan conclusions" (a subset)?

---

## Codebase Patterns

### Step Type Detection

In `buildStepMessage()`, the envelope contains:
- `envelope.step_type`: 'plan', 'implement', 'test', 'review'

### Existing Test Coverage

**File**: `server/test-step-worker.js`

- Test 10: buildStepMessage includes STEP_RESULT instruction
- Uses `createMockEnvelope()` helper
- Tests basic message structure

**No tests for upstream artifact injection behavior** - this is a gap.

---

## Dependencies & Integration Points

### Files to Modify

1. **server/step-worker.js**:
   - `buildStepMessage()` function (lines 743-757)
   - Add UPSTREAM_RELEVANCE map
   - Filter injection based on step type

2. **server/management.js**:
   - `gatherUpstreamArtifacts()` function (lines 438-458)
   - Add `output_ref` field to artifact objects

### Files to Test

1. **server/test-step-worker.js**:
   - Add tests for UPSTREAM_RELEVANCE filtering
   - Add tests for summary vs payload injection
   - Add tests for output_ref reference

### No Breaking Changes Expected

- Agent behavior: Agents can still read full artifact if needed via output_ref
- Downstream systems: buildStepMessage return value is internal to step-worker
- Artifact format: No changes to artifact storage format

---

## Open Questions

1. **Payload vs Summary for implement step**: 
   - Task says "implement needs plan summary + payload"
   - But issue goal is to avoid large payloads
   - Clarification: Does "payload" here mean "plan conclusions" (subset)?

2. **output_ref for task dependencies**:
   - Steps have output_ref, but gatherUpstreamArtifacts works with tasks
   - How to get step-level output_ref from task dependency?
   - Need to trace: task → last completed step → output_ref

3. **Line number discrepancy**:
   - Issue mentions line 669-682
   - Actual injection is at 743-757
   - Verify if this is the correct location

---

## Evidence Trail

- `server/step-worker.js:627` - buildStepMessage function definition
- `server/step-worker.js:743-757` - upstream artifact injection block
- `server/management.js:438-458` - gatherUpstreamArtifacts function
- `server/management.js:994` - artifacts field in buildDispatchPlan
- `server/artifact-store.js:17-30` - artifactPath and writeArtifact
- `server/step-worker.js:312` - output_ref assignment on step completion
- `server/test-step-worker.js:294-300` - existing buildStepMessage test
