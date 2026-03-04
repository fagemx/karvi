# Plan Phase: Progressive Prompt Injection

## Goal
Filter context sections by step type in `buildStepMessage()` to reduce token waste by ~750-1150 tokens per irrelevant step.

## Implementation Plan

### Step 1: Define STEP_CONTEXT_SECTIONS Map
**File:** `server/step-worker.js`
**Location:** After line 637 (after `SKILL_TOOL_HINT` constant, before `STEP_SKILL_MAP`)

```javascript
// Map step types to allowed context sections
// Sections NOT in this list are NOT injected for that step type
const STEP_CONTEXT_SECTIONS = {
  plan:      ['requirements', 'upstream_artifacts', 'preflight_lessons'],
  implement: ['requirements', 'upstream_artifacts', 'coding_standards', 'completion_criteria', 'protected_decisions', 'preflight_lessons'],
  test:      ['coding_standards'],
  review:    ['requirements'],
};
```

### Step 2: Add Helper Function
**File:** `server/step-worker.js`
**Location:** After `STEP_CONTEXT_SECTIONS` definition

```javascript
function shouldInjectSection(stepType, sectionName) {
  const allowed = STEP_CONTEXT_SECTIONS[stepType] || [];
  return allowed.includes(sectionName);
}
```

### Step 3: Wrap Coding Standards Injection
**File:** `server/step-worker.js`
**Location:** Lines 759-762

**Before:**
```javascript
  // Coding standards from skill files
  const mgmt = require('./management');
  const skillLines = mgmt.buildSkillContextSection();
  if (skillLines.length > 0) lines.push(...skillLines);
```

**After:**
```javascript
  // Coding standards from skill files
  if (shouldInjectSection(envelope.step_type, 'coding_standards')) {
    const mgmt = require('./management');
    const skillLines = mgmt.buildSkillContextSection();
    if (skillLines.length > 0) lines.push(...skillLines);
  }
```

**Note:** Move `const mgmt = require('./management');` to top of function or module scope to avoid repeated requires.

### Step 4: Wrap Completion Criteria Injection
**File:** `server/step-worker.js`
**Location:** Lines 764-766

**Before:**
```javascript
  // Completion criteria — prevent premature "done"
  const completionLines = mgmt.buildCompletionCriteriaSection();
  if (completionLines.length > 0) lines.push(...completionLines);
```

**After:**
```javascript
  // Completion criteria — prevent premature "done"
  if (shouldInjectSection(envelope.step_type, 'completion_criteria')) {
    const completionLines = mgmt.buildCompletionCriteriaSection();
    if (completionLines.length > 0) lines.push(...completionLines);
  }
```

### Step 5: Wrap Preflight Lessons Injection
**File:** `server/step-worker.js`
**Location:** Lines 768-775

**Before:**
```javascript
  // Preflight lessons (previously missing from step pipeline)
  if (board && task) {
    const preflight = mgmt.buildPreflightSection(board, task);
    if (preflight.lines.length > 0) {
      lines.push('');
      lines.push(...preflight.lines);
    }
  }
```

**After:**
```javascript
  // Preflight lessons (previously missing from step pipeline)
  if (shouldInjectSection(envelope.step_type, 'preflight_lessons') && board && task) {
    const preflight = mgmt.buildPreflightSection(board, task);
    if (preflight.lines.length > 0) {
      lines.push('');
      lines.push(...preflight.lines);
    }
  }
```

### Step 6: Wrap Protected Decisions Injection
**File:** `server/step-worker.js`
**Location:** Lines 791-795

**Before:**
```javascript
  // Protected edda decisions — prevent agents from reverting critical fixes
  const protectedLines = mgmt.buildProtectedDecisionsSection();
  if (protectedLines.length > 0) {
    lines.push(...protectedLines);
  }
```

**After:**
```javascript
  // Protected edda decisions — prevent agents from reverting critical fixes
  if (shouldInjectSection(envelope.step_type, 'protected_decisions')) {
    const protectedLines = mgmt.buildProtectedDecisionsSection();
    if (protectedLines.length > 0) {
      lines.push(...protectedLines);
    }
  }
```

### Step 7: Move mgmt require to Module Scope (Optional Optimization)
**File:** `server/step-worker.js`
**Location:** Top of file with other requires

Add:
```javascript
const mgmt = require('./management');
```

Then remove `const mgmt = require('./management');` from inside `buildStepMessage()`.

## Test Plan

### Syntax Check
```bash
node -c server/step-worker.js
```

### Unit Tests
```bash
node server/test-step-worker.js
```

### Manual Verification
Create test cases for each step type:

| Step Type | Expected Sections | Not Expected |
|-----------|------------------|--------------|
| plan | requirements, upstream_artifacts, preflight_lessons | coding_standards, completion_criteria, protected_decisions |
| implement | ALL sections | none |
| test | coding_standards | requirements, completion_criteria, protected_decisions, preflight_lessons |
| review | requirements | coding_standards, completion_criteria, protected_decisions, preflight_lessons |

### Verification Script
```javascript
// Quick test to verify filtering
const stepWorker = require('./server/step-worker');

// Mock envelope for plan step
const planEnvelope = { step_type: 'plan', task_id: 'GH-TEST', input_refs: {} };
const msg = stepWorker.buildStepMessage(planEnvelope, [], {}, {});
console.log('Plan step contains coding_standards:', msg.includes('Coding Standards'));
console.log('Plan step contains completion_criteria:', msg.includes('Completion Criteria'));
```

## Files Changed

| File | Lines Changed | Change Type |
|------|---------------|-------------|
| `server/step-worker.js` | +15, ~10 | Add constant, helper, wrap conditionals |

## Rollback Plan
If issues arise, simply remove the `shouldInjectSection()` checks to restore unconditional injection.

## Summary
1. Add `STEP_CONTEXT_SECTIONS` constant (4 step types × their allowed sections)
2. Add `shouldInjectSection()` helper function
3. Wrap 4 section injections with conditional checks
4. Verify with syntax check + unit tests + manual verification
