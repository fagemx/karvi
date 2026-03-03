const fs = require('fs');
const path = require('path');

// --- Edit push.js ---
const pushPath = path.join(__dirname, '..', 'server', 'push.js');
let push = fs.readFileSync(pushPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Update buildNotification signature + add village early-return
push = push.replace(
  'function buildNotification(task, eventType) {\n  const map = {',
  `function buildNotification(task, eventType, extra) {
  // --- Village events (task may be null, data comes from extra) ---
  if (eventType.startsWith('village.')) {
    return buildVillageNotification(eventType, extra || {});
  }

  const map = {`
);

// 2. Insert buildVillageNotification before "High-Level" section
const marker = `// ---------------------------------------------------------------------------
// High-Level: Notify + Cleanup stale tokens
// ---------------------------------------------------------------------------`;

const villageBuilder = `// ---------------------------------------------------------------------------
// Village Notification Builder (#124)
// ---------------------------------------------------------------------------

function buildVillageNotification(eventType, data) {
  const map = {
    'village.meeting_started': {
      title: 'Village: Meeting Started',
      body: \`\${data.departmentCount} departments started proposing\`,
      action: 'view_status',
    },
    'village.proposals_ready': {
      title: 'Village: Proposals Ready',
      body: \`\${data.departmentCount} department proposals submitted\`,
      action: 'view_plan',
    },
    'village.plan_ready': {
      title: 'Village: Weekly Plan Ready',
      body: 'Chief synthesized plan \\u2014 tap to review',
      action: 'approve',
    },
    'village.plan_executing': {
      title: 'Village: Plan Executing',
      body: \`\${data.taskCount} tasks dispatched for this week\`,
      action: 'view_status',
    },
    'village.checkin_summary': {
      title: 'Village: Check-in Summary',
      body: \`\${data.completed}/\${data.total} tasks complete, \${data.blocked} blocked\`,
      action: 'view_status',
    },
  };

  const entry = map[eventType];
  if (!entry) return null;

  return {
    title: entry.title,
    body: entry.body,
    data: {
      type: 'village',
      cycleId: data.cycleId,
      action: entry.action,
      eventType,
      url: \`karvi:///village/\${data.cycleId || 'current'}\`,
    },
  };
}

`;

push = push.replace(marker, villageBuilder + marker);

// 3. Update notifyTaskEvent signature
push = push.replace(
  'async function notifyTaskEvent(filePath, task, eventType) {\n  const notification = buildNotification(task, eventType);',
  'async function notifyTaskEvent(filePath, task, eventType, extra) {\n  const notification = buildNotification(task, eventType, extra);'
);

fs.writeFileSync(pushPath, push);
console.log('push.js updated');

// --- Edit routes/village.js ---
const villagePath = path.join(__dirname, '..', 'server', 'routes', 'village.js');
let village = fs.readFileSync(villagePath, 'utf8').replace(/\r\n/g, '\n');

const villageOld = `        helpers.broadcastSSE('village_meeting', { cycleId, meetingType, phase: 'proposal' });

        // Auto-dispatch dispatched tasks`;

const villageNew = `        helpers.broadcastSSE('village_meeting', { cycleId, meetingType, phase: 'proposal' });

        // Push notification: meeting started (fire-and-forget)
        if (deps.push && deps.PUSH_TOKENS_PATH) {
          deps.push.notifyTaskEvent(deps.PUSH_TOKENS_PATH, null, 'village.meeting_started', {
            departmentCount: village.departments.length,
            cycleId,
          }).catch(err => console.error('[push] village.meeting_started notify failed:', err.message));
        }

        // Auto-dispatch dispatched tasks`;

if (!village.includes(villageOld)) {
  console.error('village.js: target string not found');
  process.exit(1);
}
village = village.replace(villageOld, villageNew);
fs.writeFileSync(villagePath, village);
console.log('routes/village.js updated');
