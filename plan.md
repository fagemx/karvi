# GH-156: Fix scheduler duplicate meeting trigger within same hour window

## Problem Analysis

`village-scheduler.js checkSchedule()` has two bugs that allow duplicate meetings:

### Bug 1: Wrong phase condition in `checkSchedule()` (line 29)
```javascript
if (!cycle || cycle.phase === 'done' || cycle.phase === 'execution') {
  triggerMeeting('weekly_planning');
}
```
This **allows** triggering when phase is `'execution'` — meaning if the cycle advances from `proposal` → `awaiting_approval` → `execution` within the same hour, the next scheduler tick re-triggers a new meeting on top of the running one.

### Bug 2: Incomplete idempotency guard in `triggerMeeting()` (line 59)
```javascript
if (village.currentCycle && village.currentCycle.phase === 'proposal') {
  // skip — only blocks 'proposal'
}
```
Missing guards for `'awaiting_approval'`, `'execution'`, and `'checkin'` phases. Any non-terminal phase should block a new meeting.

### Bug 3: No timestamp deduplication
Even with correct phase checks, the 1-hour `setInterval` could theoretically fire twice within the same clock hour (timer drift, system sleep/resume). No `lastTriggeredAt` guard exists.

## Village Cycle Phase Lifecycle (for reference)
```
null → proposal → awaiting_approval → execution → done
                                    ↗ (if auto_approve)
       checkin (for midweek_checkin meetings)
```

## Implementation Plan

### Step 1: Fix `checkSchedule()` phase conditions
**File:** `server/village/village-scheduler.js` (lines 25-33, 36-43)

For **weekly planning**: only trigger when there is no active cycle or the current cycle is done.
```javascript
// Before (buggy):
if (!cycle || cycle.phase === 'done' || cycle.phase === 'execution') {

// After (fixed):
if (!cycle || cycle.phase === 'done') {
```

The `midweek_checkin` condition is already correct (only triggers when phase is `'execution'`).

### Step 2: Fix `triggerMeeting()` idempotency guard
**File:** `server/village/village-scheduler.js` (lines 58-62)

Guard against ALL non-terminal phases, not just `'proposal'`:
```javascript
// Before (buggy):
if (village.currentCycle && village.currentCycle.phase === 'proposal') {

// After (fixed):
const activePhase = village.currentCycle?.phase;
if (activePhase && activePhase !== 'done') {
  console.log(`[village-scheduler] skipping ${meetingType} — cycle ... in phase: ${activePhase}`);
  return;
}
```

This blocks triggering for any active phase: `proposal`, `awaiting_approval`, `execution`, `checkin`.

### Step 3: Add `lastTriggeredAt` timestamp deduplication
**File:** `server/village/village-scheduler.js`

In `checkSchedule()`, early return if `schedule.lastTriggeredAt` is within the current hour:
```javascript
const lastTriggered = schedule.lastTriggeredAt ? new Date(schedule.lastTriggeredAt) : null;
if (lastTriggered
    && lastTriggered.getFullYear() === now.getFullYear()
    && lastTriggered.getMonth() === now.getMonth()
    && lastTriggered.getDate() === now.getDate()
    && lastTriggered.getHours() === hour) {
  return; // already triggered this hour
}
```

In `triggerMeeting()`, after successful board write, stamp `schedule.lastTriggeredAt`:
```javascript
if (village.schedule) village.schedule.lastTriggeredAt = now;
```

### Step 4: Add tests to `test-village-smoke.js`
**File:** `server/test-village-smoke.js`

New DoD section — scheduler deduplication:

1. **scheduler skips when cycle is in `execution` phase** — verify no new tasks
2. **scheduler skips when cycle is in `awaiting_approval` phase** — verify no new tasks
3. **`triggerMeeting` guards all non-terminal phases** — test `proposal`, `awaiting_approval`, `execution`, `checkin`
4. **`lastTriggeredAt` prevents same-hour re-trigger** — set timestamp, verify skip

## Files Changed
| File | Change |
|------|--------|
| `server/village/village-scheduler.js` | Fix phase conditions, add `lastTriggeredAt` guard |
| `server/test-village-smoke.js` | Add scheduler deduplication tests |

## Risks & Mitigations
- **Low risk**: Changes are isolated to scheduler guard logic — no changes to meeting generation or task dispatch.
- The `midweek_checkin` path already requires phase `'execution'` and is unaffected by the weekly planning fix.
- The `POST /api/village/trigger` route (manual trigger) already has its own idempotency checks and is unaffected.