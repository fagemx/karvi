#!/usr/bin/env node
/**
 * test-village-smoke.js — Village integration smoke test
 *
 * Exercises the REAL village pipeline end-to-end with mocked runtime.
 * Integration DoD: all 4 checkpoints must pass for the pipeline to work.
 *
 *   1. trigger → board produces proposal tasks (depends correct)
 *   2. proposals complete → synthesis auto-unlocks and executes
 *   3. synthesis artifact contains tasks[]
 *   4. dispatcher creates execution tasks from tasks[]
 *
 * Usage: node server/test-village-smoke.js
 */
const assert = require('assert');
const stepSchema = require('./step-schema');
const artifactStore = require('./artifact-store');
const mgmt = require('./management');
const villageMeeting = require('./village/village-meeting');
const planDispatcher = require('./village/plan-dispatcher');

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, reason) { failed++; console.log(`  ❌ ${label}: ${reason}`); process.exitCode = 1; }

async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { fail(label, err.message); }
}

function observe(label, value) {
  console.log(`  👁 [${label}]`, typeof value === 'object' ? JSON.stringify(value, null, 2).slice(0, 800) : value);
}

// --- Board with minimal village config ---
function createVillageBoard() {
  return {
    taskPlan: { goal: 'village smoke test', phase: 'idle', tasks: [] },
    signals: [],
    insights: [],
    lessons: [],
    participants: [{ id: 'owner', type: 'human' }],
    controls: { auto_review: false, auto_dispatch: false },
    village: {
      departments: [{
        id: 'engineering',
        name: 'Engineering',
        assignee: 'engineer_lite',
        promptFile: 'village/roles/engineering.md',
        goalIds: ['G1'],
      }],
      goals: [
        { id: 'G1', text: 'Improve test coverage', cadence: 'weekly', active: true, metrics: ['coverage %'] },
      ],
      schedule: { weeklyPlanning: { day: 1, hour: 9 } },
      currentCycle: null,
    },
  };
}

let currentBoard = null;
const logEntries = [];

function createMockHelpers(board) {
  currentBoard = JSON.parse(JSON.stringify(board));
  logEntries.length = 0;
  return {
    readBoard: () => currentBoard,
    writeBoard: (b) => { currentBoard = b; },
    appendLog: (e) => { logEntries.push(e); },
    broadcastSSE: () => {},
    nowIso: () => new Date().toISOString(),
    uid: (prefix) => `${prefix}-${Date.now()}-smoke`,
  };
}

const testRunId = `smoke-${Date.now()}`;

// --- Tests ---

(async () => {
  console.log('\n━━━ Village Integration Smoke Test ━━━\n');

  // ══════════════════════════════════════════════════════
  // DoD 1: trigger → board produces proposal tasks (depends correct)
  // ══════════════════════════════════════════════════════
  console.log('── DoD 1: generateMeetingTasks → correct task DAG ──');

  let meetingTasks, proposalTasks, synthesisTasks;

  await test('generateMeetingTasks produces proposal + synthesis', () => {
    const board = createVillageBoard();
    meetingTasks = villageMeeting.generateMeetingTasks(board, 'weekly_planning');
    proposalTasks = meetingTasks.filter(t => t.id.includes('proposal'));
    synthesisTasks = meetingTasks.filter(t => t.id.includes('synthesis'));

    assert.ok(proposalTasks.length >= 1, `expected >= 1 proposal, got ${proposalTasks.length}`);
    assert.strictEqual(synthesisTasks.length, 1, `expected 1 synthesis, got ${synthesisTasks.length}`);
  });

  await test('synthesis depends on all proposals', () => {
    const synthesis = synthesisTasks[0];
    for (const p of proposalTasks) {
      assert.ok(synthesis.depends.includes(p.id), `synthesis should depend on ${p.id}`);
    }
  });

  await test('proposal pipeline carries instruction', () => {
    const instruction = proposalTasks[0].pipeline[0]?.instruction;
    assert.ok(instruction && instruction.length > 50, 'proposal instruction must exist and be substantial');
  });

  await test('generateStepsForTask preserves custom types', () => {
    const pSteps = mgmt.generateStepsForTask(proposalTasks[0], testRunId, proposalTasks[0].pipeline);
    assert.strictEqual(pSteps[0].type, 'propose');
    assert.ok(pSteps[0].instruction, 'step must carry instruction');

    const sSteps = mgmt.generateStepsForTask(synthesisTasks[0], testRunId, synthesisTasks[0].pipeline);
    assert.strictEqual(sSteps[0].type, 'synthesize');
  });

  // ══════════════════════════════════════════════════════
  // DoD 2: step-worker preserves payload + upstream flows
  // ══════════════════════════════════════════════════════
  console.log('\n── DoD 2: data preservation across step-worker ──');

  await test('step-worker payload extraction preserves custom fields', () => {
    // Simulate what step-worker does after parseStepResult
    const stepResult = {
      status: 'succeeded',
      summary: 'Engineering proposal completed',
      proposal: {
        tasks: [{ title: 'Add unit tests for auth module', priority: 'P1' }],
        rationale: 'Coverage is at 42%',
      },
    };

    // This is what our fix does: extract extra fields as payload
    const { status: _s, summary: _sm, error: _e, failure_mode: _f, retryable: _r, ...extra } = stepResult;
    const payload = Object.keys(extra).length > 0 ? extra : null;

    observe('extracted payload', payload);
    assert.ok(payload, 'payload should not be null');
    assert.ok(payload.proposal, 'payload.proposal should be preserved');
    assert.deepStrictEqual(payload.proposal.tasks[0].title, 'Add unit tests for auth module');
  });

  await test('gatherUpstreamArtifacts includes payload from task.result', () => {
    const board = createVillageBoard();
    const proposal = {
      ...proposalTasks[0],
      status: 'approved',
      result: {
        status: 'approved',
        summary: 'Engineering proposal completed',
        payload: {
          proposal: {
            tasks: [{ title: 'Add auth tests', priority: 'P1' }],
            rationale: 'Coverage is at 42%',
          },
        },
      },
    };
    board.taskPlan.tasks = [proposal, synthesisTasks[0]];

    const synthesis = board.taskPlan.tasks[1];
    const upstream = mgmt.gatherUpstreamArtifacts(board, synthesis);

    observe('upstream with payload', upstream);
    assert.ok(upstream.length > 0, 'should find upstream');
    assert.ok(upstream[0].payload, 'upstream should include payload');
    assert.ok(upstream[0].payload.proposal, 'payload should contain proposal');
  });

  // ══════════════════════════════════════════════════════
  // DoD 3: synthesis artifact → plan extraction works
  // ══════════════════════════════════════════════════════
  console.log('\n── DoD 3: plan extraction from synthesis artifact ──');

  await test('extractPlanFromArtifact works with payload.plan as object', () => {
    const artifact = {
      status: 'succeeded',
      summary: 'Plan synthesized',
      payload: {
        plan: {
          tasks: [{ title: 'Add auth tests', department: 'engineering', priority: 'P1' }],
          deferred: [],
          conflicts_resolved: [],
        },
      },
    };

    const plan = planDispatcher.extractPlanFromArtifact(artifact);
    observe('extracted plan (object)', plan);
    assert.ok(plan, 'plan should be extracted');
    assert.ok(Array.isArray(plan.tasks), 'plan.tasks should be array');
    assert.strictEqual(plan.tasks[0].title, 'Add auth tests');
  });

  await test('extractPlanFromArtifact works with payload.plan as array', () => {
    // In case agent outputs plan as array (backward compat)
    const artifact = {
      status: 'succeeded',
      payload: {
        plan: [{ title: 'Task A', department: 'engineering' }],
      },
    };

    const plan = planDispatcher.extractPlanFromArtifact(artifact);
    observe('extracted plan (array)', plan);
    assert.ok(plan, 'plan should be extracted from array format');
    assert.ok(Array.isArray(plan.tasks), 'should be wrapped as { tasks: [...] }');
  });

  await test('extractPlanFromArtifact returns null without payload', () => {
    const artifact = { status: 'succeeded', summary: 'Plan done', tokens_used: 500 };
    const plan = planDispatcher.extractPlanFromArtifact(artifact);
    assert.strictEqual(plan, null, 'should return null when no plan data');
  });

  // ══════════════════════════════════════════════════════
  // DoD 4: dispatcher creates execution tasks from plan
  // ══════════════════════════════════════════════════════
  console.log('\n── DoD 4: parsePlanAndDispatch creates execution tasks ──');

  await test('parsePlanAndDispatch creates tasks on board', () => {
    const board = createVillageBoard();
    board.village.currentCycle = { cycleId: 'cycle-test', phase: 'synthesis' };
    const helpers = createMockHelpers(board);

    const planData = {
      cycle: 'cycle-test',
      tasks: [
        { title: 'Add auth tests', department: 'engineering', assignee: 'engineer_lite', pipeline: ['implement'], priority: 'P1' },
        { title: 'Fix flaky CI', department: 'engineering', pipeline: [{ type: 'implement', instruction: 'Fix auth.test.js' }], priority: 'P2' },
      ],
    };

    const deps = { mgmt, tryAutoDispatch: null, push: null, PUSH_TOKENS_PATH: null };
    const result = planDispatcher.parsePlanAndDispatch(currentBoard, planData, helpers, deps, null);

    assert.strictEqual(result.dispatched, 2, 'should dispatch 2 tasks');
    const execTasks = currentBoard.taskPlan.tasks.filter(t => t.source?.type === 'village_plan');
    assert.strictEqual(execTasks.length, 2, 'board should have 2 execution tasks');
    observe('execution tasks', execTasks.map(t => ({ id: t.id, title: t.title, status: t.status })));
  });

  // ══════════════════════════════════════════════════════
  // DoD 5: parsePlanAndDispatch auto-registers assignees as participants
  // ══════════════════════════════════════════════════════
  console.log('\n── DoD 5: auto-register assignees as participants ──');

  await test('parsePlanAndDispatch registers missing assignees as agent participants', () => {
    const board = createVillageBoard();
    board.village.currentCycle = { cycleId: 'cycle-reg', phase: 'synthesis' };
    // Board has NO agent participants — only 'owner' (human)
    assert.ok(!board.participants.find(p => p.id === 'engineer_lite'), 'precondition: no engineer_lite');
    const helpers = createMockHelpers(board);

    const planData = {
      cycle: 'cycle-reg',
      tasks: [
        { title: 'Task A', assignee: 'engineer_lite', pipeline: ['implement'], priority: 'P1' },
        { title: 'Task B', assignee: 'engineer_pro', pipeline: ['implement'], priority: 'P2' },
      ],
    };

    const deps = { mgmt, tryAutoDispatch: () => {}, push: null, PUSH_TOKENS_PATH: null };

    planDispatcher.parsePlanAndDispatch(currentBoard, planData, helpers, deps, null);

    // Verify assignees were auto-registered
    const lite = currentBoard.participants.find(p => p.id === 'engineer_lite');
    const pro = currentBoard.participants.find(p => p.id === 'engineer_pro');
    assert.ok(lite, 'engineer_lite should be registered');
    assert.strictEqual(lite.type, 'agent', 'should be agent type');
    assert.strictEqual(lite.agentId, 'engineer_lite', 'agentId should match');
    assert.ok(pro, 'engineer_pro should be registered');
    assert.strictEqual(pro.type, 'agent');

    // Verify VT tasks were created with correct assignees
    const vtTasks = currentBoard.taskPlan.tasks.filter(t => t.source?.type === 'village_plan');
    assert.strictEqual(vtTasks.length, 2);
    observe('auto-registered participants', currentBoard.participants.map(p => `${p.id}(${p.type})`));
  });

  await test('parsePlanAndDispatch does not duplicate existing participants', () => {
    const board = createVillageBoard();
    board.participants.push({ id: 'engineer_lite', type: 'agent', displayName: 'Engineer Lite', agentId: 'engineer_lite' });
    board.village.currentCycle = { cycleId: 'cycle-dup', phase: 'synthesis' };
    const helpers = createMockHelpers(board);

    const planData = {
      cycle: 'cycle-dup',
      tasks: [{ title: 'Task X', assignee: 'engineer_lite', pipeline: ['implement'], priority: 'P1' }],
    };
    const deps = { mgmt, tryAutoDispatch: null, push: null, PUSH_TOKENS_PATH: null };
    planDispatcher.parsePlanAndDispatch(currentBoard, planData, helpers, deps, null);

    const matches = currentBoard.participants.filter(p => p.id === 'engineer_lite');
    assert.strictEqual(matches.length, 1, `should not duplicate participant, found ${matches.length}`);
  });

  // ══════════════════════════════════════════════════════
  // DoD 6: gatherRecentSignals filters by goalIds (#159)
  // ══════════════════════════════════════════════════════
  console.log('\n── DoD 6: gatherRecentSignals filters by goalIds ──');

  await test('gatherRecentSignals filters signals by goalIds', () => {
    const board = createVillageBoard();
    board.village.departments.push({
      id: 'content', name: 'Content', assignee: 'engineer_lite',
      promptFile: 'village/roles/engineering.md', goalIds: ['G2'],
    });
    board.village.goals.push({ id: 'G2', text: 'Content goal', active: true });
    board.taskPlan.tasks = [
      { id: 'T-eng-1', department: 'engineering', status: 'completed' },
      { id: 'T-con-1', department: 'content', status: 'completed' },
    ];
    board.signals = [
      { id: 's1', type: 'status_change', content: 'eng signal', refs: ['T-eng-1'], data: { taskId: 'T-eng-1' } },
      { id: 's2', type: 'status_change', content: 'content signal', refs: ['T-con-1'], data: { taskId: 'T-con-1' } },
      { id: 's3', type: 'lesson_validated', content: 'shared lesson', refs: [], data: {} },
    ];
    const result = villageMeeting.gatherRecentSignals(board, ['G1']);
    assert.ok(result.includes('eng signal'), 'should include engineering signal');
    assert.ok(!result.includes('content signal'), 'should NOT include content signal');
    assert.ok(result.includes('shared lesson'), 'should include cross-cutting signal');
  });

  await test('gatherRecentSignals includes cross-cutting signals for any goalIds', () => {
    const board = createVillageBoard();
    board.taskPlan.tasks = [
      { id: 'T-eng-1', department: 'engineering', status: 'completed' },
    ];
    board.signals = [
      { id: 's1', type: 'lesson_validated', content: 'cross-cutting lesson', data: {} },
      { id: 's2', type: 'review_result', content: 'generic review' },
    ];
    const result = villageMeeting.gatherRecentSignals(board, ['G1']);
    assert.ok(result.includes('cross-cutting lesson'), 'lesson_validated always included');
    assert.ok(result.includes('generic review'), 'signal without task ref always included');
  });

  await test('gatherRecentSignals returns all when goalIds empty', () => {
    const board = createVillageBoard();
    board.signals = [
      { id: 's1', type: 'status_change', content: 'sig A', refs: ['T-1'], data: { taskId: 'T-1' } },
      { id: 's2', type: 'status_change', content: 'sig B', refs: ['T-2'], data: { taskId: 'T-2' } },
    ];
    const result = villageMeeting.gatherRecentSignals(board, []);
    assert.ok(result.includes('sig A'), 'empty goalIds -> all signals');
    assert.ok(result.includes('sig B'), 'empty goalIds -> all signals');
  });

  await test('gatherRecentSignals returns all when goalIds undefined', () => {
    const board = createVillageBoard();
    board.signals = [
      { id: 's1', type: 'status_change', content: 'sig X', refs: ['T-1'], data: { taskId: 'T-1' } },
    ];
    const result = villageMeeting.gatherRecentSignals(board);
    assert.ok(result.includes('sig X'), 'undefined goalIds -> all signals');
  });

  await test('gatherRecentSignals returns only cross-cutting when no tasks match dept', () => {
    const board = createVillageBoard();
    // No tasks in board at all
    board.taskPlan.tasks = [];
    board.signals = [
      { id: 's1', type: 'status_change', content: 'task signal', refs: ['T-unknown'], data: { taskId: 'T-unknown' } },
      { id: 's2', type: 'lesson_validated', content: 'lesson signal', data: {} },
    ];
    const result = villageMeeting.gatherRecentSignals(board, ['G1']);
    assert.ok(!result.includes('task signal'), 'task signal for unknown task excluded');
    assert.ok(result.includes('lesson signal'), 'cross-cutting signal included');
  });

  // ══════════════════════════════════════════════════════
  // BONUS: push notifications for village events
  // ══════════════════════════════════════════════════════
  console.log('\n── Bonus: push notifications ──');

  await test('buildNotification handles village events with null task', () => {
    const push = require('./push');

    const tests = [
      ['village.meeting_started', { cycleId: 'cycle-test' }],
      ['village.proposals_ready', { cycleId: 'cycle-test', departmentCount: 3 }],
      ['village.plan_ready', { cycleId: 'cycle-test' }],
      ['village.plan_ready', { cycleId: 'cycle-test', needsApproval: true }],
      ['village.plan_executing', { cycleId: 'cycle-test', taskCount: 5 }],
      ['village.checkin_summary', { cycleId: 'cycle-test', completed: 3, total: 5, blocked: 1 }],
    ];

    for (const [eventType, extra] of tests) {
      const notification = push.buildNotification(null, eventType, extra);
      assert.ok(notification, `${eventType} should produce notification`);
      assert.ok(notification.title, `${eventType} should have title`);
      assert.ok(notification.body, `${eventType} should have body`);
      observe(`${eventType}`, { title: notification.title, body: notification.body });
    }
  });

  await test('buildNotification still works for task events', () => {
    const push = require('./push');
    const task = { id: 'T-1', title: 'Test task', blocker: null, review: null };
    const notification = push.buildNotification(task, 'task.completed');
    assert.ok(notification, 'task.completed should still work');
    assert.ok(notification.title.includes('T-1'));
  });

  await test('buildNotification returns null for unknown events', () => {
    const push = require('./push');
    assert.strictEqual(push.buildNotification(null, 'unknown.event'), null);
  });

  // ══════════════════════════════════════════════════════
  // BONUS: end-to-end schema alignment
  // ══════════════════════════════════════════════════════
  console.log('\n── Bonus: chief.md ↔ dispatcher schema alignment ──');

  await test('chief prompt instructs correct output schema', () => {
    // Use actual chief.md content (not mock) to verify schema alignment
    const chiefContent = villageMeeting.readRoleFile('village/roles/chief.md');
    const instruction = villageMeeting.buildSynthesisInstruction(chiefContent, []);
    // Chief role must tell agent to output plan with "tasks" key (not "plan" key)
    assert.ok(chiefContent.includes('"tasks"'), 'chief.md should use "tasks" key in output format');
    assert.ok(instruction.includes('STEP_RESULT'), 'instruction should mention STEP_RESULT');
  });

  await test('simulated chief output matches dispatcher expectation', () => {
    // Simulate what an agent following the updated chief.md would output
    const stepResult = {
      status: 'succeeded',
      plan: {
        tasks: [{ title: 'Task A', department: 'engineering', assignee: 'engineer_lite', pipeline: ['implement'], priority: 'P1' }],
        deferred: [],
        conflicts_resolved: [],
      },
    };

    // Extract payload (step-worker fix)
    const { status: _s, summary: _sm, error: _e, failure_mode: _f, retryable: _r, ...extra } = stepResult;
    const payload = Object.keys(extra).length > 0 ? extra : null;

    // Build artifact as step-worker would
    const artifact = { status: 'succeeded', summary: 'Plan synthesized', payload };

    // Extract plan (plan-dispatcher)
    const plan = planDispatcher.extractPlanFromArtifact(artifact);
    assert.ok(plan, 'plan should be extractable');
    assert.ok(Array.isArray(plan.tasks), 'plan.tasks should be array');
    assert.strictEqual(plan.tasks[0].title, 'Task A');

    // Feed to dispatcher
    const board = createVillageBoard();
    board.village.currentCycle = { cycleId: 'cycle-e2e', phase: 'synthesis' };
    const helpers = createMockHelpers(board);
    const deps = { mgmt, tryAutoDispatch: null, push: null, PUSH_TOKENS_PATH: null };
    const result = planDispatcher.parsePlanAndDispatch(currentBoard, plan, helpers, deps, null);
    assert.strictEqual(result.dispatched, 1, 'should dispatch 1 task');
    observe('e2e: chief → step-worker → dispatcher → board', `${result.dispatched} task(s) created`);
  });

  // ══════════════════════════════════════════════════════
  // DoD 7: scheduler deduplication guards (#156)
  // ══════════════════════════════════════════════════════
  console.log('\n── DoD 7: scheduler deduplication guards (#156) ──');

  await test('checkSchedule skips when cycle is in execution phase', () => {
    const board = createVillageBoard();
    const now = new Date();
    // Set schedule to match current day/hour so the time check passes
    board.village.schedule.weeklyPlanning = { day: now.getDay(), hour: now.getHours() };
    board.village.currentCycle = { cycleId: 'cycle-exec', phase: 'execution', startedAt: now.toISOString() };
    const taskCountBefore = (board.taskPlan?.tasks || []).length;

    const mockBoard = JSON.parse(JSON.stringify(board));
    const scheduler = require('./village/village-scheduler').createScheduler({
      helpers: {
        readBoard: () => mockBoard,
        writeBoard: () => { throw new Error('should not write'); },
        appendLog: () => {},
        broadcastSSE: () => {},
      },
      tryAutoDispatch: null,
    });
    scheduler.checkSchedule();
    assert.strictEqual(mockBoard.taskPlan.tasks.length, taskCountBefore, 'no new tasks should be added');
  });

  await test('checkSchedule skips when cycle is in awaiting_approval phase', () => {
    const board = createVillageBoard();
    const now = new Date();
    board.village.schedule.weeklyPlanning = { day: now.getDay(), hour: now.getHours() };
    board.village.currentCycle = { cycleId: 'cycle-await', phase: 'awaiting_approval', startedAt: now.toISOString() };

    const mockBoard = JSON.parse(JSON.stringify(board));
    const scheduler = require('./village/village-scheduler').createScheduler({
      helpers: {
        readBoard: () => mockBoard,
        writeBoard: () => { throw new Error('should not write'); },
        appendLog: () => {},
        broadcastSSE: () => {},
      },
      tryAutoDispatch: null,
    });
    scheduler.checkSchedule();
    assert.strictEqual(mockBoard.taskPlan.tasks.length, 0, 'no new tasks should be added');
  });

  await test('triggerMeeting guards all non-terminal phases', () => {
    const nonTerminalPhases = ['proposal', 'awaiting_approval', 'execution', 'checkin'];
    for (const phase of nonTerminalPhases) {
      const board = createVillageBoard();
      board.village.currentCycle = { cycleId: `cycle-${phase}`, phase, startedAt: new Date().toISOString() };
      const mockBoard = JSON.parse(JSON.stringify(board));
      let writeCount = 0;

      const scheduler = require('./village/village-scheduler').createScheduler({
        helpers: {
          readBoard: () => mockBoard,
          writeBoard: () => { writeCount++; },
          appendLog: () => {},
          broadcastSSE: () => {},
        },
        tryAutoDispatch: null,
      });
      // Directly invoke checkSchedule with a matching time window
      // The triggerMeeting idempotency should block even if checkSchedule's phase check passes
      const now = new Date();
      mockBoard.village.schedule = {
        weeklyPlanning: { day: now.getDay(), hour: now.getHours() },
      };
      scheduler.checkSchedule();
      assert.strictEqual(writeCount, 0, `phase "${phase}" should block triggerMeeting`);
    }
  });

  await test('lastTriggeredAt prevents same-hour re-trigger', () => {
    const board = createVillageBoard();
    const now = new Date();
    board.village.schedule.weeklyPlanning = { day: now.getDay(), hour: now.getHours() };
    board.village.schedule.lastTriggeredAt = now.toISOString(); // already triggered this hour
    board.village.currentCycle = null; // no active cycle — would normally trigger

    const mockBoard = JSON.parse(JSON.stringify(board));
    let writeCount = 0;
    const scheduler = require('./village/village-scheduler').createScheduler({
      helpers: {
        readBoard: () => mockBoard,
        writeBoard: () => { writeCount++; },
        appendLog: () => {},
        broadcastSSE: () => {},
      },
      tryAutoDispatch: null,
    });
    scheduler.checkSchedule();
    assert.strictEqual(writeCount, 0, 'lastTriggeredAt in same hour should prevent trigger');
  });

  await test('scheduler triggers when lastTriggeredAt is from previous hour', () => {
    const board = createVillageBoard();
    const now = new Date();
    board.village.schedule.weeklyPlanning = { day: now.getDay(), hour: now.getHours() };
    const previousHour = new Date(now.getTime() - 3600000);
    board.village.schedule.lastTriggeredAt = previousHour.toISOString();
    board.village.currentCycle = null; // no active cycle

    const mockBoard = JSON.parse(JSON.stringify(board));
    let writeCount = 0;
    const scheduler = require('./village/village-scheduler').createScheduler({
      helpers: {
        readBoard: () => mockBoard,
        writeBoard: () => { writeCount++; },
        appendLog: () => {},
        broadcastSSE: () => {},
      },
      tryAutoDispatch: null,
    });
    scheduler.checkSchedule();
    assert.ok(writeCount > 0, 'lastTriggeredAt from previous hour should allow trigger');
  });

  // ══════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════
  console.log('\n════════════════════════════════════════');
  console.log(`Total: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log('\n✅ All integration DoD checkpoints passed.');
    console.log('   Pipeline: trigger → proposals → synthesis → plan → dispatch');
  }
})();
