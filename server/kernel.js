/**
 * kernel.js — Self-driving kernel event loop
 *
 * Listens for step lifecycle events (step_completed, step_dead, step_failed)
 * and auto-routes to the next action without human intervention.
 *
 * Core principle: Clock = step_completed, not human's next message.
 * UI is just a dashboard.
 */
const routeEngine = require('./route-engine');
const { BLOCKER_TYPES } = require('./blocker-types');
const contextCompiler = require('./context-compiler');
const villageHooks = require('./village-hooks');
const { verifyContract } = require('./village/deliverable-contracts');
const worktreeHelper = require('./worktree');
const { resolveRepoRoot } = require('./repo-resolver');
const provisioner = require('./repo-provisioner');
const { createSignal } = require('./signal');
const { retryOnConflict } = require('./helpers/retry');
const path = require('path');

/**
 * Create the kernel event loop.
 *
 * Depends on deps.stepWorker being set before any step dispatch occurs.
 * See server.js for initialization order and circular dependency notes.
 *
 * @param {object} deps - Shared dependency injection object (mutated after creation)
 */
function createKernel(deps) {
  const { artifactStore, stepSchema, mgmt, push, PUSH_TOKENS_PATH, vault, githubApi } = deps;
  const defaultRepoRoot = path.resolve(__dirname, '..');

  function cleanupWorktree(task, taskId, board) {
    if (!task?.worktreeDir) return;

    // Delay cleanup to let the runtime process fully exit and release file handles.
    // On Windows, opencode may still hold locks when the kernel receives step_completed.
    const CLEANUP_DELAY_MS = 5000;
    setTimeout(() => {
      try {
        // Provisioned repos use bare-clone worktrees (different cleanup path)
        if (task._provisioned?.barePath) {
          provisioner.removeWorktreeFromBare(task._provisioned.barePath, task._provisioned.dataRoot, taskId);
        } else {
          const repoRoot = resolveRepoRoot(task, board) || defaultRepoRoot;
          worktreeHelper.removeWorktree(repoRoot, taskId);
        }
        console.log(`[kernel] worktree cleaned up for ${taskId}`);
      } catch (err) {
        console.error(`[kernel] worktree cleanup failed for ${taskId}:`, err.message);
        // Schedule one more retry after a longer delay
        setTimeout(() => {
          try {
            if (task._provisioned?.barePath) {
              provisioner.removeWorktreeFromBare(task._provisioned.barePath, task._provisioned.dataRoot, taskId);
            } else {
              const repoRoot = resolveRepoRoot(task, board) || defaultRepoRoot;
              worktreeHelper.removeWorktree(repoRoot, taskId);
            }
            console.log(`[kernel] worktree cleaned up for ${taskId} (retry)`);
          } catch (err2) {
            console.error(`[kernel] worktree cleanup retry failed for ${taskId}:`, err2.message);
          }
        }, 15000);
      }
    }, CLEANUP_DELAY_MS);
  }

  /**
   * Called after a step transitions to a terminal state (succeeded, dead)
   * or a failure that was auto-requeued. Runs asynchronously via setImmediate.
   *
   * @param {object} signal  - The signal object from board.signals
   * @param {object} board   - Current board snapshot
   * @param {object} helpers - Route helpers (readBoard, writeBoard, appendLog, etc.)
   */
  async function onStepEvent(signal, board, helpers) {
    const { taskId, stepId } = signal.data || {};
    if (!taskId || !stepId) return;

    const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (!task || !task.steps) return;

    const step = task.steps.find(s => s.step_id === stepId);
    if (!step) return;

    // Only act on terminal states
    if (step.state !== 'succeeded' && step.state !== 'dead') return;

    // Initialize budget tracking on first kernel interaction
    if (!task.budget) {
      task.budget = { limits: { ...routeEngine.BUDGET_DEFAULTS }, used: { llm_calls: 0, tokens: 0, wall_clock_ms: 0, steps: 0, cost: 0 } };
    }
    if (task.budget.used.cost === undefined) task.budget.used.cost = 0;
    task.budget.used.steps = (task.budget.used.steps || 0) + 1;

    // Build agent output from step + artifact
    const output = artifactStore.readArtifact(step.run_id, stepId, 'output');
    const agentOutput = {
      run_id: step.run_id,
      step_id: stepId,
      status: output?.status || (step.state === 'succeeded' ? 'succeeded' : 'failed'),
      failure: output?.failure || (step.error ? { failure_signature: step.error, retryable: true } : null),
      summary: output?.summary || null,
      error: step.error,
      tokens_used: output?.tokens_used || 0,
    };

    // Update budget with token usage and wall clock
    if (agentOutput.tokens_used) {
      task.budget.used.tokens = (task.budget.used.tokens || 0) + agentOutput.tokens_used;
    }
    task.budget.used.llm_calls = (task.budget.used.llm_calls || 0) + 1;
    if (output?.duration_ms) {
      task.budget.used.wall_clock_ms = (task.budget.used.wall_clock_ms || 0) + output.duration_ms;
    }
    if (output?.cost) {
      task.budget.used.cost = (task.budget.used.cost || 0) + output.cost;
    }

    // Route
    const runState = { task, steps: task.steps, run_id: step.run_id, budget: task.budget, controls: mgmt.getControls(board) };
    const decision = routeEngine.decideNext(agentOutput, runState);

    // Log decision
    helpers.appendLog({
      ts: helpers.nowIso(), event: 'route_decision',
      taskId, stepId, action: decision.action, rule: decision.rule,
    });

    // Emit route_decision signal
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
    if (latestTask) latestTask.budget = task.budget;
    mgmt.ensureEvolutionFields(latestBoard);
    latestBoard.signals.push(createSignal({
      by: 'kernel', type: 'route_decision',
      content: `${taskId} ${stepId} → ${decision.action} (${decision.rule})`,
      refs: [taskId], data: { taskId, stepId, decision },
    }, helpers));
    mgmt.trimSignals(latestBoard, helpers.signalArchivePath);

    // Village hook deps (used by multiple cases)
    const villageDeps = { push, PUSH_TOKENS_PATH, mgmt };

    // Execute decision
    switch (decision.action) {
      case 'wait_group': {
        // Parallel group has pending siblings — persist budget update and wait
        console.log(`[kernel] ${taskId} parallel group pending, waiting for siblings`);
        helpers.writeBoard(latestBoard);
        return;
      }

      case 'next_step': {
        const nextStepType = decision.next_step?.step_type;

        // Per-step-type concurrency check
        const ctrl = mgmt.getControls(latestBoard);
        const limit = ctrl.max_concurrent_by_type?.[nextStepType];
        if (limit) {
          let running = 0;
          for (const t of (latestBoard.taskPlan?.tasks || [])) {
            for (const s of (t.steps || [])) {
              if (s.type === nextStepType && s.state === 'running') running++;
            }
          }
          if (running >= limit) {
            console.log(`[kernel] ${nextStepType} concurrency limit reached (${running}/${limit}), queuing step`);
            helpers.writeBoard(latestBoard);
            return;
          }
        }

        const envelope = contextCompiler.buildEnvelope(decision, runState, deps);
        if (!envelope) break;
        // Write input artifact
        artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'input', envelope);
        // Transition next step to running
        const nextStep = latestTask?.steps?.find(s => s.step_id === envelope.step_id);
        if (nextStep && nextStep.state === 'queued') {
          stepSchema.transitionStep(nextStep, 'running', { locked_by: 'kernel', input_ref: artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'input') });
        }
        // Guard: stepWorker must be initialized before persisting state (see server.js init order)
        if (!deps.stepWorker) {
          console.error('[kernel] deps.stepWorker not initialized — check init order in server.js');
          break;
        }
        helpers.writeBoard(latestBoard);
        // Dispatch async via StepWorker (fire-and-forget, errors logged)
        deps.stepWorker.executeStep(envelope, latestBoard, helpers).catch(err =>
          console.error(`[kernel] executeStep error for ${envelope.step_id}:`, err.message));

        // Dispatch parallel siblings (if any) — same group, different steps
        if (Array.isArray(decision.parallel_siblings) && decision.parallel_siblings.length > 0) {
          for (const sibling of decision.parallel_siblings) {
            const sibDecision = { action: 'next_step', next_step: { step_id: sibling.step_id, step_type: sibling.step_type } };
            const sibEnvelope = contextCompiler.buildEnvelope(sibDecision, runState, deps);
            if (!sibEnvelope) continue;

            // Check concurrency limit for sibling's type
            const sibLimit = ctrl.max_concurrent_by_type?.[sibling.step_type];
            if (sibLimit) {
              let sibRunning = 0;
              const freshBoard = helpers.readBoard();
              for (const t of (freshBoard.taskPlan?.tasks || [])) {
                for (const s of (t.steps || [])) {
                  if (s.type === sibling.step_type && s.state === 'running') sibRunning++;
                }
              }
              if (sibRunning >= sibLimit) {
                console.log(`[kernel] ${sibling.step_type} concurrency limit reached for parallel sibling ${sibling.step_id}, scheduling retry`);
                // Re-check after 30s so the sibling doesn't stay queued forever
                const retryTimer = setTimeout(() => {
                  try {
                    const retryBoard = helpers.readBoard();
                    const retryTask = (retryBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
                    const retryStep = retryTask?.steps?.find(s => s.step_id === sibling.step_id);
                    if (retryStep && retryStep.state === 'queued') {
                      console.log(`[kernel] retrying parallel sibling ${sibling.step_id}`);
                      advanceStep(taskId, sibling.step_id, retryBoard);
                    }
                  } catch (err) {
                    console.error(`[kernel] parallel sibling retry failed for ${sibling.step_id}:`, err.message);
                  }
                }, 30000);
                retryTimer.unref();
                continue;
              }
            }

            artifactStore.writeArtifact(sibEnvelope.run_id, sibEnvelope.step_id, 'input', sibEnvelope);
            const sibBoard = helpers.readBoard();
            const sibTask = (sibBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
            const sibStep = sibTask?.steps?.find(s => s.step_id === sibling.step_id);
            if (sibStep && sibStep.state === 'queued') {
              stepSchema.transitionStep(sibStep, 'running', {
                locked_by: 'kernel-parallel',
                input_ref: artifactStore.artifactPath(sibEnvelope.run_id, sibEnvelope.step_id, 'input'),
              });
              helpers.writeBoard(sibBoard);
            }
            deps.stepWorker.executeStep(sibEnvelope, helpers.readBoard(), helpers).catch(err =>
              console.error(`[kernel] parallel executeStep error for ${sibEnvelope.step_id}:`, err.message));
          }
        }

        return;  // writeBoard already called
      }

      case 'revision': {
        // Generic revision: find target and source steps from decision metadata,
        // reset all steps in between, and re-dispatch the target step.
        const targetStepId = decision.next_step?.step_id;
        const sourceStepId = decision.from_step_id;
        const targetStep = latestTask?.steps?.find(s => s.step_id === targetStepId);
        const sourceStep = latestTask?.steps?.find(s => s.step_id === sourceStepId);

        if (targetStep && sourceStep) {
          const targetIdx = latestTask.steps.indexOf(targetStep);
          const sourceIdx = latestTask.steps.indexOf(sourceStep);
          for (let i = targetIdx; i <= sourceIdx; i++) {
            const s = latestTask.steps[i];
            s.state = 'queued';
            s.attempt = 0;
            s.error = null;
            s.output_ref = null;
            s.locked_by = null;
            s.lock_expires_at = null;
          }

          if (!latestTask._revisionCounts) latestTask._revisionCounts = {};
          latestTask._revisionCounts[targetStepId] = (latestTask._revisionCounts[targetStepId] || 0) + 1;

          latestTask.reviewFeedback = decision.review_feedback || null;
          console.log(`[kernel] revision: ${sourceStep.step_id} → ${targetStep.step_id} (cycle ${latestTask._revisionCounts[targetStepId]})`);
        }
        
        const freshRunState = { task: latestTask, steps: latestTask.steps, run_id: runState.run_id, budget: latestTask.budget, controls: mgmt.getControls(latestBoard) };
        const revEnvelope = contextCompiler.buildEnvelope(decision, freshRunState, deps);
        if (revEnvelope && targetStep) {
          artifactStore.writeArtifact(revEnvelope.run_id, revEnvelope.step_id, 'input', revEnvelope);
          stepSchema.transitionStep(targetStep, 'running', {
            locked_by: 'kernel-revision',
            input_ref: artifactStore.artifactPath(revEnvelope.run_id, revEnvelope.step_id, 'input'),
          });
          helpers.writeBoard(latestBoard);
          deps.stepWorker.executeStep(revEnvelope, latestBoard, helpers).catch(err =>
            console.error(`[kernel] revision executeStep error for ${revEnvelope.step_id}:`, err.message));
          return;
        }
        helpers.writeBoard(latestBoard);
        return;
      }

      case 'retry': {
        // Step-schema's transitionStep already handles retry+backoff.
        // Kernel just needs to persist budget update.
        helpers.writeBoard(latestBoard);
        return;
      }

      case 'human_review': {
        if (latestTask) {
          latestTask.blocker = { reason: decision.human_review?.reason || 'Kernel escalated to human', askedAt: helpers.nowIso() };
        }
        latestBoard.signals.push(createSignal({
          by: 'kernel', type: 'human_review_needed',
          content: `${taskId} needs human review: ${decision.human_review?.reason || ''}`,
          refs: [taskId], data: { taskId, stepId, reason: decision.human_review?.reason },
        }, helpers));
        // Village: cycle stall detection for meeting tasks
        if (villageHooks.onTaskBlocked(latestBoard, taskId, latestTask, helpers, villageDeps)) {
          return;
        }
        helpers.writeBoard(latestBoard);
        // Push notification
        if (push && PUSH_TOKENS_PATH && latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.blocked')
            .catch(async err => {
              console.error(`[kernel] push error for task ${taskId}, event task.blocked:`, err.message);
              try {
                await retryOnConflict(async () => {
                  const freshBoard = helpers.readBoard();
                  freshBoard.signals.push(createSignal({
                    by: 'kernel', type: 'push_failed',
                    content: `Push notification failed for ${taskId}: ${err.message}`,
                    refs: [taskId], data: { taskId, eventType: 'task.blocked', error: err.message },
                  }, helpers));
                  mgmt.trimSignals(freshBoard, helpers.signalArchivePath);
                  helpers.writeBoard(freshBoard);
                });
              } catch (retryErr) {
                console.error(`[kernel] push_failed signal write failed after retries:`, retryErr.message);
              }
            });
        }
        return;
      }

      case 'dead_letter': {
        if (latestTask) {
          latestTask.status = 'blocked';
          latestTask.blocker = {
            type: BLOCKER_TYPES.DEAD_LETTER,
            reason: `Dead letter: ${decision.rule}`,
            askedAt: helpers.nowIso()
          };
          // Preserve worktree on failure — agent may have written code that hasn't been
          // committed yet. Deleting it permanently loses work. Worktree will be cleaned
          // up when the task is manually cancelled/deleted or re-dispatched. (GH-325)
        }
        latestBoard.signals.push(createSignal({
          by: 'kernel', type: 'task_dead_letter',
          content: `${taskId} dead-lettered: ${decision.rule}`,
          refs: [taskId], data: { taskId, stepId, rule: decision.rule },
        }, helpers));
        // Village: cycle stall detection for meeting tasks
        if (villageHooks.onTaskBlocked(latestBoard, taskId, latestTask, helpers, villageDeps)) {
          return;
        }
        helpers.writeBoard(latestBoard);
        if (push && PUSH_TOKENS_PATH && latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.blocked')
            .catch(async err => {
              console.error(`[kernel] push error for task ${taskId}, event task.blocked:`, err.message);
              try {
                await retryOnConflict(async () => {
                  const freshBoard = helpers.readBoard();
                  freshBoard.signals.push(createSignal({
                    by: 'kernel', type: 'push_failed',
                    content: `Push notification failed for ${taskId}: ${err.message}`,
                    refs: [taskId], data: { taskId, eventType: 'task.blocked', error: err.message },
                  }, helpers));
                  mgmt.trimSignals(freshBoard, helpers.signalArchivePath);
                  helpers.writeBoard(freshBoard);
                });
              } catch (retryErr) {
                console.error(`[kernel] push_failed signal write failed after retries:`, retryErr.message);
              }
            });
        }
        return;
      }

      case 'done': {
        if (latestTask) {
          // Verify deliverable contract before approving
          if (latestTask.contract) {
            const cv = verifyContract(latestTask, latestBoard, helpers, artifactStore);
            if (!cv.ok) {
              console.warn(`[kernel] contract verification failed for ${taskId}: ${cv.reason}`);
              latestTask.status = 'blocked';
              latestTask.blocker = { type: 'contract_failed', reason: cv.reason };
              latestTask.history = latestTask.history || [];
              latestTask.history.push({ ts: helpers.nowIso(), status: 'blocked', reason: `contract: ${cv.reason}` });

              // Signal + push (match dead_letter side-effects)
              mgmt.ensureEvolutionFields(latestBoard);
              latestBoard.signals.push(createSignal({
                by: 'kernel', type: 'contract_failed',
                content: `${taskId} contract verification failed: ${cv.reason}`,
                refs: [taskId], data: { taskId, kind: latestTask.contract.kind, reason: cv.reason },
              }, helpers));
              mgmt.trimSignals(latestBoard, helpers.signalArchivePath);

              if (push && PUSH_TOKENS_PATH) {
                push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.contract_failed')
                  .catch(err => console.error('[kernel] contract_failed push error:', err.message));
              }

              helpers.writeBoard(latestBoard);
              return;
            }
          }

          // Step pipeline includes review as step[3] — all steps succeeded means approved
          latestTask.status = 'approved';
          latestTask.completedAt = helpers.nowIso();

          // Auto-push for provisioned repos (SaaS): push branch to remote
          if (latestTask._provisioned && latestTask.worktreeDir && vault?.isEnabled()) {
            const prov = latestTask._provisioned;
            const userId = mgmt.resolveOwnerId(latestBoard) || 'default';
            const tokenBuf = vault.retrieve(userId, 'github_pat');
            if (tokenBuf) {
              const pat = tokenBuf.toString('utf8');
              tokenBuf.fill(0);
              try {
                provisioner.pushBranch(latestTask.worktreeDir, latestTask.worktreeBranch, pat, prov.owner, prov.repo);
                console.log(`[kernel] auto-pushed ${latestTask.worktreeBranch} for ${taskId}`);
              } catch (pushErr) {
                console.error(`[kernel] auto-push failed for ${taskId}: ${pushErr.message}`);
              }
            }
          }

          // Worktree stays alive — branch is needed until PR is merged or closed.
          // Primary cleanup: routes/github.js on pr_merged / pr_closed webhook.
          // Fallback: if no webhook fires within 30 min (dogfood / no webhook configured),
          // clean up anyway. Remote branch + PR still exist; only local worktree removed.
          if (latestTask.worktreeDir) {
            const fallbackTaskId = taskId;
            const fallbackTask = latestTask;
            const fallbackBoard = latestBoard;
            setTimeout(() => {
              // Re-read board to check if webhook already cleaned up
              try {
                const freshBoard = helpers.readBoard();
                const freshTask = (freshBoard.taskPlan?.tasks || []).find(t => t.id === fallbackTaskId);
                if (freshTask?.worktreeDir) {
                  cleanupWorktree(freshTask, fallbackTaskId, freshBoard);
                  freshTask.worktreeDir = null;
                  freshTask.worktreeBranch = null;
                  helpers.writeBoard(freshBoard);
                }
              } catch (err) {
                console.error(`[kernel] fallback worktree cleanup failed for ${fallbackTaskId}:`, err.message);
              }
            }, 30 * 60 * 1000); // 30 minutes
          }
          // Preserve payload from last step's artifact for downstream access
          const lastStepOutput = artifactStore.readArtifact(step.run_id, stepId, 'output');
          latestTask.result = {
            status: 'approved',
            summary: lastStepOutput?.summary || `All ${task.steps.length} steps succeeded (including review)`,
            payload: lastStepOutput?.payload || null,
          };

          // Extract structured PR metadata from step artifacts.
          // The implement step typically creates the PR; scan all steps for prUrl.
          const prUrl = findPrUrl(task.steps, step.run_id, artifactStore);
          if (prUrl) {
            const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
            if (prMatch) {
              latestTask.pr = {
                owner: prMatch[1],
                repo: `${prMatch[1]}/${prMatch[2]}`,
                number: Number(prMatch[3]),
                url: prUrl,
                outcome: null,
              };
            }
          }

          // Auto-merge: if enabled and PR metadata is available, squash-merge the PR
          const controls = mgmt.getControls(latestBoard);
          if (controls.auto_merge_on_approve && latestTask.pr && vault?.isEnabled()) {
            const tokenBuf = vault.retrieve('default', 'github_pat');
            if (tokenBuf) {
              const pat = tokenBuf.toString('utf8');
              tokenBuf.fill(0);
              const { owner, number } = latestTask.pr;
              const repoName = latestTask.pr.repo.split('/')[1];
              const commitTitle = `${latestTask.title || taskId} (#${number})`;
              githubApi.mergePR(pat, owner, repoName, number, commitTitle, 'squash')
                .then(async () => {
                  console.log(`[kernel] auto-merged PR #${number} for ${taskId}`);
                  try {
                    await retryOnConflict(async () => {
                      const freshBoard = helpers.readBoard();
                      const freshTask = (freshBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
                      if (freshTask?.pr) {
                        freshTask.pr.outcome = 'merged';
                        freshTask.pr.mergedAt = helpers.nowIso();
                        freshTask.pr.mergedBy = 'karvi-auto-merge';
                        helpers.writeBoard(freshBoard);
                      }
                    });
                  } catch (retryErr) {
                    console.error(`[kernel] auto-merge board update failed after retries:`, retryErr.message);
                  }
                })
                .catch(async err => {
                  console.error(`[kernel] auto-merge failed for PR #${number}:`, err.message);
                  try {
                    await retryOnConflict(async () => {
                      const freshBoard = helpers.readBoard();
                      freshBoard.signals.push(createSignal({
                        by: 'kernel', type: 'auto_merge_failed',
                        content: `Auto-merge failed for ${taskId} PR #${number}: ${err.message}`,
                        refs: [taskId], data: { taskId, prNumber: number, error: err.message },
                      }, helpers));
                      mgmt.trimSignals(freshBoard, helpers.signalArchivePath);
                      helpers.writeBoard(freshBoard);
                    });
                  } catch (retryErr) {
                    console.error(`[kernel] auto_merge_failed signal write failed after retries:`, retryErr.message);
                  }
                });
            }
          }
        }

        // Unlock dependent tasks (autoUnlockDependents checks for 'approved')
        const unlocked = mgmt.autoUnlockDependents(latestBoard);

        // Village: synthesis plan dispatch + cycle completion check
        // Non-blocking — failures logged but don't stop the pipeline.
        try {
          await villageHooks.onTaskDone(latestBoard, latestTask, step, helpers, { artifactStore, push, PUSH_TOKENS_PATH, mgmt, tryAutoDispatch: deps.tryAutoDispatch });
        } catch (err) {
          console.error('[kernel] village onTaskDone hook failed:', err.message);
        }

        // Village: proposals_ready push when synthesis task unlocked
        villageHooks.onTaskUnlocked(latestBoard, unlocked, helpers, { push, PUSH_TOKENS_PATH, mgmt });

        mgmt.trimSignals(latestBoard, helpers.signalArchivePath);

        helpers.writeBoard(latestBoard);

        // Hook system: emit task_completed
        if (deps.hookSystem) {
          deps.hookSystem.emit('task_completed', { taskId, task: latestTask });
        }

        if (push && PUSH_TOKENS_PATH && latestTask) {
          push.notifyTaskEvent(PUSH_TOKENS_PATH, latestTask, 'task.completed')
            .catch(async err => {
              console.error(`[kernel] push error for task ${taskId}, event task.completed:`, err.message);
              try {
                await retryOnConflict(async () => {
                  const freshBoard = helpers.readBoard();
                  freshBoard.signals.push(createSignal({
                    by: 'kernel', type: 'push_failed',
                    content: `Push notification failed for ${taskId}: ${err.message}`,
                    refs: [taskId], data: { taskId, eventType: 'task.completed', error: err.message },
                  }, helpers));
                  mgmt.trimSignals(freshBoard, helpers.signalArchivePath);
                  helpers.writeBoard(freshBoard);
                });
              } catch (retryErr) {
                console.error(`[kernel] push_failed signal write failed after retries:`, retryErr.message);
              }
            });
        }

        // Auto-dispatch newly unblocked tasks (deferred to avoid deep recursion)
        if (unlocked.length > 0 && deps.tryAutoDispatch) {
          for (const id of unlocked) {
            setImmediate(() => deps.tryAutoDispatch(id));
          }
        }
        return;
      }
    }

    // Fallback — persist budget update
    helpers.writeBoard(latestBoard);
  }

  return { onStepEvent };
}

/**
 * Scan step artifacts for a PR URL.
 * Returns the first prUrl found (typically from the implement step), or null.
 */
function findPrUrl(steps, runId, artifactStore) {
  if (!steps || !runId) return null;
  const prRegex = /https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;
  for (const s of steps) {
    const output = artifactStore.readArtifact(runId, s.step_id, 'output');
    // 1. Structured payload field (preferred)
    const url = output?.payload?.prUrl;
    if (url && typeof url === 'string') return url;
    // 2. Fallback: extract from summary text
    const summaryMatch = (output?.summary || '').match(prRegex);
    if (summaryMatch) return summaryMatch[0];
  }
  return null;
}

module.exports = { createKernel, findPrUrl };
