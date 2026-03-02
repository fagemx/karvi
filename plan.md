# GH-159: Bridge - Capture PR Outcomes (merged/blocked/reverted)

## Chosen Approach

Add a PR outcome tracking bridge that monitors GitHub PR lifecycle events for tasks
that created PRs during their pipeline execution. When a PR is merged, closed without
merge (blocked), or its merge commit is reverted, the bridge records the outcome on
the task and emits a board signal.

Two intake paths:
1. GitHub Webhook (primary, real-time): Extend integration-github.js to handle
   pull_request events (closed+merged, closed+!merged) and push events (revert
   detection via commit message parsing).
2. Polling fallback (secondary, cheap): A periodic poll that checks open/recently-closed
   PRs via github-api.js:fetchPR() for tasks that have a prUrl but no recorded outcome.

Outcome recording:
- New task.prOutcome field: { status, prNumber, repo, mergedAt?, closedAt?,
  revertedAt?, mergeCommitSha?, detectedBy }
- New board signal types: pr_merged, pr_closed, pr_reverted
- Jira integration notified when PR outcome changes

## Task Breakdown

### Task 1: Extend TaskResult and Task types for PR outcome tracking
Files: shared/types.ts
Dependencies: None

Add PrOutcome interface with fields: status (merged|closed|reverted), prNumber, repo,
mergedAt, closedAt, revertedAt, mergeCommitSha, detectedBy (webhook|poll).
Add prOutcome to Task interface. Add prNumber and prRepo to TaskResult interface.

### Task 2: Extract PR info from implement step output into task
Files: server/kernel.js
Dependencies: Task 1

In kernel.js:onStepEvent() after reading step output artifact (line 67), before routing:
- Check if step type is implement and status is succeeded
- Parse output.summary and output.payload for PR URL pattern
  (github.com/owner/repo/pull/number)
- If found, set task.prUrl, task.prNumber, task.prRepo on latestTask

### Task 3: Handle pull_request webhook events for merged/closed
Files: server/integration-github.js, server/routes/github.js
Dependencies: Task 1, Task 2

New handlePullRequestEvent(board, payload, config) in integration-github.js:
- Accept payloads where action === closed
- Check payload.pull_request.merged to distinguish merged vs closed-without-merge
- Find matching task by PR number + repo
- Return { action: pr_merged|pr_closed, taskId, prNumber, outcome } or { action: skipped }

Modify handleWebhook() to detect event type and delegate accordingly.
In routes/github.js, handle pr_merged/pr_closed results: set task.prOutcome,
add history entry, emit board signal, persist board.

### Task 4: Detect reverted PRs from push events
Files: server/integration-github.js
Dependencies: Task 3

New handlePushEvent(board, payload, config):
- Iterate payload.commits[]
- Check if commit.message matches revert patterns or This reverts commit sha
- Match reverted SHA against task prOutcome.mergeCommitSha
- Return { action: pr_reverted, taskId, ... } or { action: skipped }

In handleWebhook(), detect push events (payload.ref without pull_request/issue)
and delegate to handlePushEvent().

### Task 5: PR outcome polling fallback
Files: server/pr-poller.js (new), server/server.js
Dependencies: Task 2

New module with pollPrOutcomes(), startPrPoller(), stopPrPoller().
Scans tasks with prNumber+prRepo but no prOutcome, calls fetchPR, records outcomes.
Rate-limited: max 5 API calls per poll cycle, 60s interval.
Start on server boot if GitHub PAT configured. Stop on graceful shutdown.

### Task 6: Jira notification for PR outcomes
Files: server/integration-jira.js
Dependencies: Task 3

Extend notifyJira() for pr_merged, pr_closed, pr_reverted event types.
Post appropriate Jira comments and map to status transitions if configured.

### Task 7: Tests
Files: server/test-pr-outcome.js (new)
Dependencies: Tasks 2-6

12 test cases:
1. PR URL extraction from payload
2. PR URL extraction from summary string
3. Webhook: pull_request closed+merged -> prOutcome.status = merged
4. Webhook: pull_request closed+not merged -> prOutcome.status = closed
5. Webhook: push with revert commit -> prOutcome.status = reverted
6. Webhook: unmatched PR -> skipped
7. Webhook: duplicate outcome -> idempotent
8. Poller: detects merged PR
9. Poller: respects rate limit (max 5 calls/cycle)
10. Poller: skips tasks with existing outcome
11. Signal emission: correct signal type + data per outcome
12. Jira notification: correct comment per outcome type

Self-contained, assert-based, no external test framework.

## Dependency Graph

Task 1 (types) -> Task 2 (PR extraction) -> Task 3 (webhook merged/closed)
Task 3 -> Task 4 (webhook reverted), Task 6 (Jira)
Task 2 -> Task 5 (polling fallback)
Task 7 (tests) depends on all above

## Risk Assessment

- Webhook not configured: Polling fallback ensures outcomes captured regardless
- PR URL not in STEP_RESULT: Also parse from summary field using regex
- Revert false positives: Only match when SHA matches known mergeCommitSha
- GitHub API rate limits: Poller limited to 5 calls/cycle
- Board write races: Existing atomic write pattern handles this

## Definition of Done

1. PR merged/closed/reverted events captured via webhook OR polling
2. task.prOutcome field populated with structured outcome data
3. Board signals emitted for each outcome type
4. Jira integration notified (when enabled)
5. All 12 test cases pass
6. Existing tests still pass (test-github-webhook.js, test-bridge.js)
7. No external dependencies added
