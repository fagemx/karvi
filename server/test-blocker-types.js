/**
 * test-blocker-types.js — blocker-types 模組測試
 */
const assert = require('assert');
const { BLOCKER_TYPES, inferBlockerType, shouldUnblockOnReset } = require('./blocker-types');

async function runTests() {
  // Test inferBlockerType
  assert.strictEqual(inferBlockerType('Dead letter: budget_exceeded'), BLOCKER_TYPES.DEAD_LETTER);
  assert.strictEqual(inferBlockerType('Repo validation failed: ...'), BLOCKER_TYPES.REPO_ERROR);
  assert.strictEqual(inferBlockerType('Worktree creation failed: ...'), BLOCKER_TYPES.WORKTREE_ERROR);
  assert.strictEqual(inferBlockerType('Custom reason'), BLOCKER_TYPES.MANUAL);
  assert.strictEqual(inferBlockerType(null), BLOCKER_TYPES.UNKNOWN);
  console.log('✓ inferBlockerType tests passed');

  // Test shouldUnblockOnReset - new structure
  assert.strictEqual(shouldUnblockOnReset({ type: 'dead_letter', reason: '...' }), true);
  assert.strictEqual(shouldUnblockOnReset({ type: 'repo_error', reason: '...' }), false);
  assert.strictEqual(shouldUnblockOnReset({ type: 'manual', reason: '...' }), false);
  console.log('✓ shouldUnblockOnReset new structure tests passed');

  // Test shouldUnblockOnReset - legacy structure (backward compat)
  assert.strictEqual(shouldUnblockOnReset({ reason: 'Dead letter: budget_exceeded' }), true);
  assert.strictEqual(shouldUnblockOnReset({ reason: 'Worktree creation failed' }), false);
  assert.strictEqual(shouldUnblockOnReset({ reason: 'Custom blocker' }), false);
  console.log('✓ shouldUnblockOnReset backward compat tests passed');

  // Test edge cases
  assert.strictEqual(shouldUnblockOnReset(null), false);
  assert.strictEqual(shouldUnblockOnReset(undefined), false);
  assert.strictEqual(shouldUnblockOnReset({}), false);
  console.log('✓ Edge case tests passed');

  console.log('\nAll blocker-types tests passed!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
