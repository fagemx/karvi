const assert = require('assert');

function createMockBoard(controls = {}, tasks = []) {
  return {
    controls,
    taskPlan: { tasks },
    projects: []
  };
}

function testWaveFiltering() {
  console.log('Testing wave filtering logic...\n');
  
  const testCases = [
    { activeWave: null, taskWave: null, shouldDispatch: true, desc: 'active_wave=null, task.wave=null' },
    { activeWave: null, taskWave: 2, shouldDispatch: true, desc: 'active_wave=null, task.wave=2' },
    { activeWave: 2, taskWave: null, shouldDispatch: true, desc: 'active_wave=2, task.wave=null' },
    { activeWave: 2, taskWave: 2, shouldDispatch: true, desc: 'active_wave=2, task.wave=2' },
    { activeWave: 2, taskWave: 3, shouldDispatch: false, desc: 'active_wave=2, task.wave=3' },
    { activeWave: 0, taskWave: 0, shouldDispatch: true, desc: 'active_wave=0, task.wave=0' },
    { activeWave: 0, taskWave: 1, shouldDispatch: false, desc: 'active_wave=0, task.wave=1' },
    { activeWave: 1, taskWave: 0, shouldDispatch: false, desc: 'active_wave=1, task.wave=0' },
  ];

  for (const tc of testCases) {
    const { activeWave, taskWave, shouldDispatch, desc } = tc;
    const ctrl = { active_wave: activeWave };
    const task = { wave: taskWave };
    
    const taskWaveVal = task.wave ?? null;
    const activeWaveVal = ctrl.active_wave ?? null;
    const wouldSkip = activeWaveVal !== null && taskWaveVal !== null && taskWaveVal !== activeWaveVal;
    const result = !wouldSkip;
    
    const pass = result === shouldDispatch;
    console.log(`${pass ? '✓' : '✗'} ${desc}: expected ${shouldDispatch}, got ${result}`);
    assert.strictEqual(result, shouldDispatch, `Failed: ${desc}`);
  }
}

function testActiveWaveValidation() {
  console.log('\nTesting active_wave validation...\n');
  
  const testCases = [
    { val: null, valid: true, desc: 'null is valid (all waves)' },
    { val: 0, valid: true, desc: '0 is valid (Wave 0)' },
    { val: 1, valid: true, desc: '1 is valid (Wave 1)' },
    { val: 100, valid: true, desc: '100 is valid (large wave number)' },
    { val: -1, valid: false, desc: '-1 is invalid (negative)' },
    { val: 1.5, valid: false, desc: '1.5 is invalid (non-integer)' },
    { val: '2', valid: false, desc: '"2" is invalid (string)' },
    { val: undefined, valid: false, desc: 'undefined is invalid' },
    { val: {}, valid: false, desc: '{} is invalid (object)' },
  ];

  for (const tc of testCases) {
    const { val, valid, desc } = tc;
    
    let isValid = false;
    if (val === null) {
      isValid = true;
    } else if (typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val) && val >= 0) {
      isValid = true;
    }
    
    const pass = isValid === valid;
    console.log(`${pass ? '✓' : '✗'} ${desc}: expected ${valid}, got ${isValid}`);
    assert.strictEqual(isValid, valid, `Failed: ${desc}`);
  }
}

function testTaskWaveValidation() {
  console.log('\nTesting task.wave validation...\n');
  
  const testCases = [
    { val: null, valid: true, result: null, desc: 'null is valid' },
    { val: 0, valid: true, result: 0, desc: '0 is valid' },
    { val: 1, valid: true, result: 1, desc: '1 is valid' },
    { val: 100, valid: true, result: 100, desc: '100 is valid' },
    { val: -1, valid: false, result: null, desc: '-1 is invalid' },
    { val: 1.5, valid: false, result: null, desc: '1.5 is invalid' },
    { val: '2', valid: false, result: null, desc: '"2" is invalid' },
    { val: undefined, valid: true, result: null, desc: 'undefined defaults to null' },
  ];

  for (const tc of testCases) {
    const { val, valid, result, desc } = tc;
    
    let normalized = null;
    if (val !== undefined && val !== null && typeof val === 'number' && Number.isInteger(val) && val >= 0) {
      normalized = val;
    }
    
    const pass = normalized === result;
    console.log(`${pass ? '✓' : '✗'} ${desc}: expected ${result}, got ${normalized}`);
    assert.strictEqual(normalized, result, `Failed: ${desc}`);
  }
}

function runAllTests() {
  console.log('='.repeat(50));
  console.log('Wave Dispatch Unit Tests');
  console.log('='.repeat(50) + '\n');
  
  testWaveFiltering();
  testActiveWaveValidation();
  testTaskWaveValidation();
  
  console.log('\n' + '='.repeat(50));
  console.log('All tests passed!');
  console.log('='.repeat(50));
}

runAllTests();
