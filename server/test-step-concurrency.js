/**
 * test-step-concurrency.js — Unit tests for per-step-type concurrency limits (GH-279)
 */

const assert = require('assert');
const {
  countRunningStepsByType,
  canDispatchStepType,
} = require('./routes/tasks');

// Mock mgmt for testing
const mockMgmt = {
  getControls: (board) => board.controls || {}
};

console.log('\n=== Test: countRunningStepsByType ===\n');

// Test 1: Empty board
{
  const board = { taskPlan: { tasks: [] } };
  const count = countRunningStepsByType('plan', board);
  assert.strictEqual(count, 0, 'Empty board should return 0');
  console.log('✓ Empty board returns 0');
}

// Test 2: Board with no running steps
{
  const board = {
    taskPlan: {
      tasks: [
        { steps: [{ type: 'plan', state: 'queued' }] },
        { steps: [{ type: 'implement', state: 'succeeded' }] }
      ]
    }
  };
  const count = countRunningStepsByType('plan', board);
  assert.strictEqual(count, 0, 'No running steps should return 0');
  console.log('✓ No running steps returns 0');
}

// Test 3: Count running steps by type
{
  const board = {
    taskPlan: {
      tasks: [
        { steps: [{ type: 'plan', state: 'running' }] },
        { steps: [{ type: 'plan', state: 'running' }, { type: 'implement', state: 'running' }] },
        { steps: [{ type: 'plan', state: 'queued' }] }
      ]
    }
  };
  const planCount = countRunningStepsByType('plan', board);
  assert.strictEqual(planCount, 2, 'Should count 2 running plan steps');
  const implCount = countRunningStepsByType('implement', board);
  assert.strictEqual(implCount, 1, 'Should count 1 running implement step');
  const reviewCount = countRunningStepsByType('review', board);
  assert.strictEqual(reviewCount, 0, 'Should count 0 running review steps');
  console.log('✓ Counts running steps correctly by type');
}

// Test 4: Tasks without steps
{
  const board = {
    taskPlan: {
      tasks: [
        { steps: [{ type: 'plan', state: 'running' }] },
        { }, // No steps
        { steps: null }, // Null steps
        { steps: [{ type: 'plan', state: 'running' }] }
      ]
    }
  };
  const count = countRunningStepsByType('plan', board);
  assert.strictEqual(count, 2, 'Should handle tasks without steps');
  console.log('✓ Handles tasks without steps');
}

// Test 5: Null/undefined board
{
  const count1 = countRunningStepsByType('plan', null);
  assert.strictEqual(count1, 0, 'Null board should return 0');
  const count2 = countRunningStepsByType('plan', undefined);
  assert.strictEqual(count2, 0, 'Undefined board should return 0');
  console.log('✓ Handles null/undefined board');
}

console.log('\n=== Test: canDispatchStepType ===\n');

// Test 6: No limit set (backward compatibility)
{
  const board = {
    controls: { max_concurrent_by_type: null },
    taskPlan: { tasks: [] }
  };
  const result = canDispatchStepType('plan', board, mockMgmt);
  assert.strictEqual(result, true, 'No limit should return true');
  console.log('✓ No limit returns true (backward compatible)');
}

// Test 7: Limit not set for specific type
{
  const board = {
    controls: { max_concurrent_by_type: { implement: 2 } },
    taskPlan: { tasks: [] }
  };
  const result = canDispatchStepType('plan', board, mockMgmt);
  assert.strictEqual(result, true, 'No limit for specific type should return true');
  console.log('✓ No limit for specific type returns true');
}

// Test 8: Under limit
{
  const board = {
    controls: { max_concurrent_by_type: { plan: 3 } },
    taskPlan: {
      tasks: [
        { steps: [{ type: 'plan', state: 'running' }] }
      ]
    }
  };
  const result = canDispatchStepType('plan', board, mockMgmt);
  assert.strictEqual(result, true, 'Under limit should return true');
  console.log('✓ Under limit returns true');
}

// Test 9: At limit
{
  const board = {
    controls: { max_concurrent_by_type: { plan: 2 } },
    taskPlan: {
      tasks: [
        { steps: [{ type: 'plan', state: 'running' }] },
        { steps: [{ type: 'plan', state: 'running' }] }
      ]
    }
  };
  const result = canDispatchStepType('plan', board, mockMgmt);
  assert.strictEqual(result, false, 'At limit should return false');
  console.log('✓ At limit returns false');
}

// Test 10: Over limit
{
  const board = {
    controls: { max_concurrent_by_type: { plan: 1 } },
    taskPlan: {
      tasks: [
        { steps: [{ type: 'plan', state: 'running' }] },
        { steps: [{ type: 'plan', state: 'running' }] }
      ]
    }
  };
  const result = canDispatchStepType('plan', board, mockMgmt);
  assert.strictEqual(result, false, 'Over limit should return false');
  console.log('✓ Over limit returns false');
}

// Test 11: Different types have independent limits
{
  const board = {
    controls: { max_concurrent_by_type: { plan: 1, implement: 2 } },
    taskPlan: {
      tasks: [
        { steps: [{ type: 'plan', state: 'running' }] },
        { steps: [{ type: 'implement', state: 'running' }] }
      ]
    }
  };
  const planResult = canDispatchStepType('plan', board, mockMgmt);
  const implResult = canDispatchStepType('implement', board, mockMgmt);
  assert.strictEqual(planResult, false, 'Plan at limit');
  assert.strictEqual(implResult, true, 'Implement under limit');
  console.log('✓ Different types have independent limits');
}

console.log('\n=== Test: Controls validation ===\n');

// Test 12: Validation logic (simulated)
function validateMaxConcurrentByType(val) {
  if (val === null || typeof val !== 'object') {
    return null;
  }
  const valid = {};
  for (const [stepType, limit] of Object.entries(val)) {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      valid[stepType] = Math.max(1, Math.min(10, Math.floor(limit)));
    }
  }
  return Object.keys(valid).length > 0 ? valid : null;
}

// Test null
{
  const result = validateMaxConcurrentByType(null);
  assert.deepStrictEqual(result, null, 'null should return null');
  console.log('✓ null returns null');
}

// Test non-object
{
  const result = validateMaxConcurrentByType('invalid');
  assert.deepStrictEqual(result, null, 'Non-object should return null');
  console.log('✓ Non-object returns null');
}

// Test empty object
{
  const result = validateMaxConcurrentByType({});
  assert.deepStrictEqual(result, null, 'Empty object should return null');
  console.log('✓ Empty object returns null');
}

// Test valid limits
{
  const result = validateMaxConcurrentByType({ plan: 3, implement: 2 });
  assert.deepStrictEqual(result, { plan: 3, implement: 2 }, 'Valid limits should be preserved');
  console.log('✓ Valid limits preserved');
}

// Test limit clamping
{
  const result = validateMaxConcurrentByType({ plan: 0, implement: 15, review: -1 });
  assert.deepStrictEqual(result, { implement: 10 }, 'Should clamp to 1-10 range');
  console.log('✓ Limits clamped to 1-10 range');
}

// Test non-numeric values
{
  const result = validateMaxConcurrentByType({ plan: '3', implement: null, review: undefined });
  assert.deepStrictEqual(result, null, 'Non-numeric values should be filtered out');
  console.log('✓ Non-numeric values filtered out');
}

// Test decimal values
{
  const result = validateMaxConcurrentByType({ plan: 2.7, implement: 3.1 });
  assert.deepStrictEqual(result, { plan: 2, implement: 3 }, 'Should floor decimal values');
  console.log('✓ Decimal values floored');
}

console.log('\n=== All tests passed! ===\n');
