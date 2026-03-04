# Innovation Phase: Anchor-Based Context Slicing

## Solution Approaches

### Approach 1: Minimal Change (Task Description Compliant)

**Implementation**:
1. Add UPSTREAM_RELEVANCE map in buildStepMessage()
2. Change injection logic to use summary + output_ref
3. Add output_ref to gatherUpstreamArtifacts()

**Pros**:
- Directly implements task requirements
- Minimal code changes
- Low risk of breaking existing behavior
- Easy to test

**Cons**:
- "implement needs plan summary + payload" requirement unclear
- May not achieve full token savings if payload still included for implement
- output_ref for task dependencies requires additional logic

**Complexity**: Low

---

### Approach 2: Strict Summary-Only with Conditional Payload

**Implementation**:
1. Define UPSTREAM_RELEVANCE with fine-grained field control:
   ```javascript
   const UPSTREAM_RELEVANCE = {
     plan: null,  // no upstream
     implement: { fields: ['summary', 'payload'], condition: 'payload_size < 500' },
     test: { fields: ['summary'] },
     review: { fields: ['summary'] },
   };
   ```
2. Always inject summary + output_ref
3. Only inject payload if it's small OR explicitly required

**Pros**:
- Maximum token savings
- Flexible for future step types
- Clear semantic boundaries

**Cons**:
- More complex logic
- Need to determine "payload size" threshold
- May break if implement step actually needs full plan payload

**Complexity**: Medium

---

### Approach 3: Step-Level Output Reference Chain

**Implementation**:
1. Change gatherUpstreamArtifacts to work with step-level outputs:
   ```javascript
   // For each dependency task, find last completed step
   const lastStep = dep.steps?.filter(s => s.state === 'succeeded').pop();
   if (lastStep) {
     entry.output_ref = lastStep.output_ref;
     entry.summary = lastStep.summary || dep.lastReply?.slice(0, 600);
   }
   ```
2. Build step-to-step artifact chain instead of task-to-task

**Pros**:
- More precise output_ref (points to actual step output file)
- Aligns with step pipeline architecture
- Future-ready for multi-step dependencies

**Cons**:
- Requires task.steps to be populated (may not always be available)
- More complex dependency resolution
- Changes artifact gathering semantics

**Complexity**: High

---

## Trade-off Analysis

### Token Savings vs Information Loss

**Critical Question**: What does implement step actually need from plan?

**Scenario Analysis**:

1. **Plan output structure** (typical):
   ```json
   {
     "status": "succeeded",
     "summary": "Plan: Modify step-worker.js to add UPSTREAM_RELEVANCE...",
     "payload": {
       "conclusions": ["Change line 750", "Add map at line 640"],
       "files_to_modify": ["server/step-worker.js"],
       "reasoning": "Long analysis with grep results..."
     }
   }
   ```

2. **Implement step needs**:
   - Which files to modify
   - What changes to make
   - Why (context)

3. **Review step needs**:
   - Summary of what was implemented
   - PR diff (fetched separately via `gh pr diff`)

**Conclusion**: 
- Implement needs `payload.conclusions` and `payload.files_to_modify` (structured data)
- Implement does NOT need `payload.reasoning` (analysis text)
- Review needs only summary

---

### Recommended Hybrid Approach

**Strategy**: Conditional payload inclusion based on structure

```javascript
const UPSTREAM_RELEVANCE = {
  plan: null,  // First step, no upstream
  implement: { 
    include: ['summary', 'payload'],  // Full payload for now
    // Future: could extract only conclusions/files_to_modify
  },
  test: { 
    include: ['summary']  // Only summary
  },
  review: { 
    include: ['summary']  // Only summary, diff fetched separately
  },
};
```

**Injection Logic**:
```javascript
for (const u of upstreamArtifacts) {
  lines.push(`### ${u.id} — ${u.title || '(untitled)'} [${u.status}]`);
  
  const relevance = UPSTREAM_RELEVANCE[envelope.step_type];
  if (!relevance) continue;  // plan step has no upstream
  
  // Always include summary
  if (relevance.include.includes('summary') && u.summary) {
    lines.push(u.summary);
  }
  
  // Conditionally include payload
  if (relevance.include.includes('payload') && u.payload) {
    lines.push('```json');
    lines.push(JSON.stringify(u.payload, null, 2));
    lines.push('```');
  }
  
  // Always add reference to full output
  if (u.output_ref) {
    lines.push(`(Full output: ${u.output_ref})`);
  }
}
```

**Rationale**:
- Implements task requirements directly
- Keeps implement step functional (has access to plan payload)
- Reduces tokens for test/review steps (summary only)
- Provides output_ref for all steps (agent can read full file if needed)
- Low risk, easy to test

---

## Output Reference Strategy

### Problem: Task Dependencies vs Step Outputs

**Current Flow**:
- gatherUpstreamArtifacts() works with `task.depends` (task-level dependencies)
- But output_ref is on steps, not tasks

**Solution Options**:

**Option A**: Add output_ref at task level
- Track latest step output_ref in task.result
- Simple, but requires updating task completion logic

**Option B**: Resolve step from task in gatherUpstreamArtifacts
- Find last succeeded step from dep.steps array
- Use step.output_ref
- More accurate, but requires steps to be populated

**Option C**: Use artifact path pattern
- Construct path: `artifacts/{run_id}/{task_id}:{step_type}.output.json`
- Requires knowing which step type is relevant
- No code changes to task/step structure

**Recommendation**: **Option B** - Most accurate, aligns with step pipeline

```javascript
// In gatherUpstreamArtifacts()
for (const depId of task.depends) {
  const dep = allTasks.find(t => t.id === depId);
  if (!dep) continue;
  
  const entry = { id: dep.id, title: dep.title, status: dep.status };
  
  // Get summary from task level
  if (dep.lastReply) {
    entry.summary = dep.lastReply.slice(0, 600);
  } else if (dep.result?.summary) {
    entry.summary = dep.result.summary.slice(0, 600);
  }
  
  // Get payload from task level
  if (dep.result?.payload) {
    entry.payload = dep.result.payload;
  }
  
  // Get output_ref from last succeeded step
  const lastStep = dep.steps?.filter(s => s.state === 'succeeded').pop();
  if (lastStep?.output_ref) {
    entry.output_ref = lastStep.output_ref;
  }
  
  results.push(entry);
}
```

---

## Testing Strategy

### Unit Tests to Add

1. **UPSTREAM_RELEVANCE filtering**:
   - Test that plan step gets no upstream
   - Test that implement gets summary + payload
   - Test that test/review get only summary

2. **output_ref inclusion**:
   - Test that output_ref is included when available
   - Test graceful handling when output_ref is null

3. **Summary injection**:
   - Test that summary is used when payload is null
   - Test that both summary and payload can be included

### Integration Test

- Create a full step pipeline run
- Verify review step message does NOT contain implement full payload
- Verify implement step message DOES contain plan payload

---

## Risk Assessment

### Low Risk
- Changes isolated to buildStepMessage() and gatherUpstreamArtifacts()
- No changes to artifact storage format
- Backward compatible (agents can still read full files via output_ref)

### Medium Risk
- Implement step may break if plan payload is needed but filtered out
- Mitigation: Include full payload for implement step (as per task requirements)

### No Risk
- No database schema changes
- No API changes
- No breaking changes to agent protocol

---

## Decision Matrix

| Approach | Token Savings | Implementation Effort | Risk | Future-Proof |
|----------|---------------|----------------------|------|--------------|
| Minimal (Approach 1) | Medium | Low | Low | Medium |
| Conditional (Approach 2) | High | Medium | Medium | High |
| Step Chain (Approach 3) | High | High | Medium | Very High |

**Selected**: **Approach 1 (Minimal)** with **Option B for output_ref**

**Justification**:
- Implements task requirements exactly
- Low risk, easy to test
- Provides foundation for future enhancements (can add conditional logic later)
- output_ref from last step is most accurate
