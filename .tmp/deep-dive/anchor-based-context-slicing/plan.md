# Implementation Plan: Anchor-Based Context Slicing

## Overview

**Goal**: Reduce token usage in step pipeline by injecting summaries instead of full upstream payloads, with per-step relevance filtering.

**Approach**: Minimal change implementation (Approach 1 from innovation phase) with step-level output references (Option B).

---

## Implementation Steps

### Step 1: Add UPSTREAM_RELEVANCE Map

**File**: `server/step-worker.js`

**Location**: Near top of file, after constants (around line 12)

**Change**: Add new constant map

```javascript
// Define which upstream fields each step type needs
const UPSTREAM_RELEVANCE = {
  plan: null,  // First step, no upstream dependencies
  implement: { include: ['summary', 'payload'] },  // Needs plan conclusions
  test: { include: ['summary'] },  // Only needs what was implemented
  review: { include: ['summary'] },  // Only needs what was implemented (diff fetched separately)
};
```

**Rationale**:
- Clear, declarative specification of relevance per step type
- Easy to extend for new step types
- Explicit null for plan step (no upstream)

**Verification**: `node -c server/step-worker.js`

---

### Step 2: Modify buildStepMessage() Injection Logic

**File**: `server/step-worker.js`

**Location**: Lines 743-757

**Current Code**:
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

**New Code**:
```javascript
// Inject upstream artifacts (from completed dependency tasks)
// Use UPSTREAM_RELEVANCE to filter what each step type needs
const relevance = UPSTREAM_RELEVANCE[envelope.step_type];
if (relevance && Array.isArray(upstreamArtifacts) && upstreamArtifacts.length > 0) {
  lines.push('', '## Upstream Task Outputs');
  for (const u of upstreamArtifacts) {
    lines.push(`### ${u.id} — ${u.title || '(untitled)'} [${u.status}]`);
    
    // Include summary if relevant
    if (relevance.include.includes('summary') && u.summary) {
      lines.push(u.summary);
    }
    
    // Include payload if relevant
    if (relevance.include.includes('payload') && u.payload) {
      lines.push('```json');
      lines.push(JSON.stringify(u.payload, null, 2));
      lines.push('```');
    }
    
    // Always add reference to full output file
    if (u.output_ref) {
      lines.push(`(Full output: ${u.output_ref})`);
    }
  }
  lines.push('');
}
```

**Changes**:
1. Check UPSTREAM_RELEVANCE for current step type
2. Only inject if relevance is defined (skip for plan step)
3. Conditionally include summary/payload based on relevance.include
4. Always add output_ref reference when available
5. Remove fallback logic (summary when payload null) - now explicitly controlled

**Verification**: `node -c server/step-worker.js`

---

### Step 3: Add output_ref to gatherUpstreamArtifacts()

**File**: `server/management.js`

**Location**: Lines 438-458

**Current Code**:
```javascript
function gatherUpstreamArtifacts(board, task) {
  if (!task.depends?.length) return [];
  const allTasks = board.taskPlan?.tasks || [];
  const results = [];
  for (const depId of task.depends) {
    const dep = allTasks.find(t => t.id === depId);
    if (!dep) continue;
    const entry = { id: dep.id, title: dep.title, status: dep.status };
    if (dep.lastReply) {
      entry.summary = dep.lastReply.slice(0, 600);
    } else if (dep.result?.summary) {
      entry.summary = dep.result.summary.slice(0, 600);
    }
    // Include structured payload from step output (proposal, plan, etc.)
    if (dep.result?.payload) {
      entry.payload = dep.result.payload;
    }
    results.push(entry);
  }
  return results;
}
```

**New Code**:
```javascript
function gatherUpstreamArtifacts(board, task) {
  if (!task.depends?.length) return [];
  const allTasks = board.taskPlan?.tasks || [];
  const results = [];
  for (const depId of task.depends) {
    const dep = allTasks.find(t => t.id === depId);
    if (!dep) continue;
    const entry = { id: dep.id, title: dep.title, status: dep.status };
    if (dep.lastReply) {
      entry.summary = dep.lastReply.slice(0, 600);
    } else if (dep.result?.summary) {
      entry.summary = dep.result.summary.slice(0, 600);
    }
    // Include structured payload from step output (proposal, plan, etc.)
    if (dep.result?.payload) {
      entry.payload = dep.result.payload;
    }
    // Include output reference from last succeeded step
    const lastStep = dep.steps?.filter(s => s.state === 'succeeded').pop();
    if (lastStep?.output_ref) {
      entry.output_ref = lastStep.output_ref;
    }
    results.push(entry);
  }
  return results;
}
```

**Changes**:
1. Find last succeeded step from dependency task
2. Extract output_ref from that step
3. Add to artifact entry

**Verification**: `node -c server/management.js`

---

### Step 4: Add Unit Tests

**File**: `server/test-step-worker.js`

**Location**: After test 11 (around line 318)

**New Tests**:

```javascript
// Test 12: UPSTREAM_RELEVANCE filters correctly for plan step
await test('buildStepMessage excludes upstream for plan step', () => {
  const envelope = createMockEnvelope({ step_type: 'plan' });
  const upstream = [{ id: 'T-UP1', title: 'Upstream', status: 'completed', summary: 'test' }];
  const message = buildStepMessage(envelope, upstream, null, null);
  assert.ok(!message.includes('Upstream Task Outputs'), 'plan should have no upstream section');
});

// Test 13: UPSTREAM_RELEVANCE includes summary for review step
await test('buildStepMessage includes only summary for review step', () => {
  const envelope = createMockEnvelope({ step_type: 'review' });
  const upstream = [
    { 
      id: 'T-UP1', 
      title: 'Implement', 
      status: 'completed', 
      summary: 'Implemented feature X',
      payload: { files: ['test.js'], details: 'long payload...' },
      output_ref: 'artifacts/run1/T-UP1_implement.output.json'
    }
  ];
  const message = buildStepMessage(envelope, upstream, null, null);
  assert.ok(message.includes('Implemented feature X'), 'should include summary');
  assert.ok(!message.includes('long payload'), 'should NOT include payload for review');
  assert.ok(message.includes('Full output: artifacts/run1/T-UP1_implement.output.json'), 'should include output_ref');
});

// Test 14: UPSTREAM_RELEVANCE includes summary + payload for implement step
await test('buildStepMessage includes summary and payload for implement step', () => {
  const envelope = createMockEnvelope({ step_type: 'implement' });
  const upstream = [
    { 
      id: 'T-UP1', 
      title: 'Plan', 
      status: 'completed', 
      summary: 'Plan summary',
      payload: { conclusions: ['change X', 'change Y'] },
      output_ref: 'artifacts/run1/T-UP1_plan.output.json'
    }
  ];
  const message = buildStepMessage(envelope, upstream, null, null);
  assert.ok(message.includes('Plan summary'), 'should include summary');
  assert.ok(message.includes('"conclusions"'), 'should include payload for implement');
  assert.ok(message.includes('Full output: artifacts/run1/T-UP1_plan.output.json'), 'should include output_ref');
});
```

**Note**: Need to update `createMockEnvelope()` helper to accept overrides for step_type

**Verification**: `node server/test-step-worker.js`

---

### Step 5: Run Full Test Suite

**Commands**:
```bash
# Syntax check all modified files
node -c server/step-worker.js
node -c server/management.js

# Run specific tests
node server/test-step-worker.js
node server/test-step-schema.js
node server/test-context-compiler.js

# Run integration test (if available)
npm test
```

**Expected Results**:
- All syntax checks pass
- All unit tests pass
- No regressions in existing tests

---

## File Change Summary

### server/step-worker.js
- **Add**: UPSTREAM_RELEVANCE constant (after line 12)
- **Modify**: buildStepMessage() upstream injection logic (lines 743-757)

### server/management.js
- **Modify**: gatherUpstreamArtifacts() to include output_ref (lines 438-458)

### server/test-step-worker.js
- **Add**: 3 new tests for UPSTREAM_RELEVANCE filtering

---

## Testing Checklist

- [ ] Syntax check passes on all modified files
- [ ] Unit tests pass (test-step-worker.js)
- [ ] No regressions in related tests (test-step-schema.js, test-context-compiler.js)
- [ ] Plan step receives no upstream artifacts
- [ ] Implement step receives summary + payload
- [ ] Test step receives only summary
- [ ] Review step receives only summary
- [ ] output_ref is included when available
- [ ] output_ref is null-safe (no error when missing)

---

## Rollback Plan

If issues arise:

1. **Revert commit**: `git revert <commit-hash>`
2. **No database migration needed**: Changes are code-only
3. **No artifact format changes**: Existing artifacts remain valid
4. **Agents can still function**: They read from files directly if needed

---

## Success Criteria

1. **Token reduction**: Review step messages are significantly shorter (no implement payload)
2. **Functionality preserved**: Implement step still has access to plan payload
3. **No breaking changes**: All existing tests pass
4. **Clear semantics**: UPSTREAM_RELEVANCE map is self-documenting
5. **Future-proof**: Easy to add new step types or adjust relevance rules

---

## Post-Implementation Verification

After implementation:

1. Run a full step pipeline (plan → implement → test → review)
2. Check review step message in artifacts - should NOT contain implement payload JSON
3. Check implement step message - should contain plan payload
4. Verify output_ref paths are correct and files exist
5. Measure token savings in typical pipeline run

---

## Notes

- **Line number in issue**: Issue mentions line 669-682, but actual injection is at 743-757. Using actual location.
- **Task description vs issue**: Task says "implement needs plan summary + payload", which we're implementing as-is. Future optimization could extract only relevant payload fields.
- **output_ref availability**: Depends on dep.steps being populated. If not available, output_ref will be undefined and gracefully omitted from message.
