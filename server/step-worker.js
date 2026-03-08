/**
 * step-worker.js — Step execution layer
 *
 * Wraps runtime adapters with step-level concerns:
 * lease management, duration tracking, structured output parsing,
 * per-step runtime selection, and artifact I/O.
 *
 * Extracted from kernel.js:dispatchStep() (issue #92).
 * Kernel = routing decisions, StepWorker = execution.
 */
const { execSync } = require('child_process');
const mgmt = require('./management');
const { resolveRepoRoot } = require('./repo-resolver');
const LOCK_GRACE_MS = 30_000; // 30s grace on top of step timeout

const ERROR_PATTERNS = [
  // Dispatch error patterns (from err.message)
  { pattern: /idle for \d+s/i, kind: 'TEMPORARY' },
  { pattern: /exited with code/i, kind: 'PROVIDER' },
  { pattern: /ECONNREFUSED/i, kind: 'PROVIDER' },
  { pattern: /ETIMEDOUT/i, kind: 'PROVIDER' },
  { pattern: /ENOTFOUND/i, kind: 'PROVIDER' },

  // Agent failure_mode patterns (from agentOutput.failure.failure_mode)
  { failure_mode: 'TEST_FAILURE', kind: 'AGENT_ERROR' },
  { failure_mode: 'FINALIZE_ERROR', kind: 'FINALIZE' },
  { failure_mode: 'PROTECTED_CODE_VIOLATION', kind: 'PROTECTED' },
  { failure_mode: 'CONTRACT_VIOLATION', kind: 'CONTRACT' },
];

const UPSTREAM_RELEVANCE = {
  plan: null,
  implement: { include: ['summary', 'payload'] },
  test: { include: ['summary'] },
  review: { include: ['summary'] },
};

/**
 * Create the step execution worker.
 *
 * Depends on deps.kernel being set before any terminal-state callback fires.
 * The callback is deferred via setImmediate, so deps.kernel is guaranteed to
 * be set by that time. See server.js for initialization order notes.
 *
 * @param {object} deps - Shared dependency injection object (mutated after creation)
 */
function createStepWorker(deps) {
  const { artifactStore, stepSchema, mgmt } = deps;

  const activeExecutions = new Map(); // stepId → { abort(), startedAt }

  /**
   * Execute a single step: build plan, acquire lock, dispatch to runtime,
   * parse output, write artifact, transition state, emit signal.
   *
   * @param {object} envelope - TaskEnvelope from context-compiler
   * @param {object} board    - Board snapshot
   * @param {object} helpers  - { readBoard, writeBoard, appendLog, nowIso, uid }
   */
  async function executeStep(envelope, board, helpers) {
    const task = (board.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    if (!task) throw new Error(`Task ${envelope.task_id} not found`);

    // 1. Build dispatch plan — compute timeout once, share between lock and runtime
    const timeoutMs = envelope.timeout_ms || 300_000;
    const timeoutSec = Math.ceil(timeoutMs / 1000);
    const plan = mgmt.buildDispatchPlan(board, task, {
      mode: 'dispatch',
      timeoutSec,
      steps: task.steps,
      workingDir: task.worktreeDir || null,
    });
    // Enforce: runtime timeout must match lock timeout (prevent misalignment)
    plan.timeoutSec = timeoutSec;
    const stepMessage = buildStepMessage(envelope, plan.artifacts, board, task);
    plan.message = stepMessage;
    plan.stepId = envelope.step_id;
    plan.stepType = envelope.step_type;

    // 2. Set lock with expiry before dispatch (uses same timeoutMs as runtime)
    const lockBoard = helpers.readBoard();
    const lockTask = (lockBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    const lockStep = lockTask?.steps?.find(s => s.step_id === envelope.step_id);
    if (lockStep && lockStep.state === 'running') {
      lockStep.lock_expires_at = new Date(Date.now() + timeoutMs + LOCK_GRACE_MS).toISOString();
      lockStep.locked_by = 'step-worker';
      helpers.writeBoard(lockBoard);
    }

    // 3. Per-step runtime selection (envelope.runtime_hint takes precedence)
    const step = task.steps?.find(s => s.step_id === envelope.step_id);
    const runtimeHint = envelope.runtime_hint || step?.runtime_hint || plan.runtimeHint;
    const rt = deps.getRuntime(runtimeHint);

    // Inject STEP_RESULT instruction as system prompt — more reliable than
    // putting it in the user message, because system prompts persist across
    // the entire conversation and won't be forgotten by long-running skills.
    if (runtimeHint === 'claude') {
      const resultPrompt = [
        'CRITICAL: When you have completely finished your task, you MUST output the following on a single line (no code fences):',
        'STEP_RESULT:{"status":"succeeded","summary":"one line summary", ...extra fields as instructed}',
        'Include any additional payload fields requested by your task instruction (e.g. "proposal", "plan").',
        'Or on failure:',
        'STEP_RESULT:{"status":"failed","error":"what went wrong","failure_mode":"TEST_FAILURE","retryable":true}',
        'This line MUST appear in your final message. Without it, the pipeline cannot advance.',
      ].join('\n');
      plan.systemPrompt = plan.systemPrompt
        ? plan.systemPrompt + '\n\n' + resultPrompt
        : resultPrompt;
    }

    // 3b. Preflight: check if work is already done (zero tokens)
    const preflightResult = runPreflight(envelope, plan.workingDir || plan.cwd);

    let status, failure, summary, durationMs, usage, postCheckResult, stepResult, sessionId;

    if (preflightResult.alreadyDone) {
      // Skip dispatch — work already exists in codebase
      status = 'succeeded';
      summary = `Preflight: already implemented (${preflightResult.evidence})`;
      failure = null;
      durationMs = 0;
      usage = null;
      postCheckResult = null;
    } else {
      // 4. Dispatch with duration tracking (catch failures to transition step properly)
      //    Heartbeat callback: refresh lock while runtime is alive (prevents retry-poller conflicts)
      plan.onActivity = () => {
        try {
          const hbBoard = helpers.readBoard();
          const hbTask = (hbBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
          const hbStep = hbTask?.steps?.find(s => s.step_id === envelope.step_id);
          if (hbStep && hbStep.state === 'running' && hbStep.locked_by === 'step-worker') {
            hbStep.lock_expires_at = new Date(Date.now() + timeoutMs + LOCK_GRACE_MS).toISOString();
            helpers.writeBoard(hbBoard);
          }
        } catch {}
      };

      // Progress callback: write granular progress to step metadata (throttled)
      const PROGRESS_THROTTLE_MS = 10_000;
      let lastProgressWrite = 0;
      const startMs = Date.now();

      plan.onProgress = (event) => {
        const now = Date.now();
        if (now - lastProgressWrite < PROGRESS_THROTTLE_MS) return;
        lastProgressWrite = now;
        try {
          const pgBoard = helpers.readBoard();
          const pgTask = (pgBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
          const pgStep = pgTask?.steps?.find(s => s.step_id === envelope.step_id);
          if (!pgStep || pgStep.state !== 'running') return;
          pgStep.progress = {
            tool_calls: event.tool_calls || 0,
            tokens: event.tokens || null,
            last_tool: event.tool_name || null,
            last_activity: new Date(now).toISOString(),
            elapsed_ms: now - startMs,
          };
          helpers.writeBoard(pgBoard);
        } catch {}
      };
      let result;
      const ac = new AbortController();
      activeExecutions.set(envelope.step_id, { abort: () => ac.abort(), startedAt: Date.now() });
      plan.signal = ac.signal;
      try {
        result = await rt.dispatch(plan);
      } catch (dispatchErr) {
        activeExecutions.delete(envelope.step_id);
        const dispatchDurationMs = Date.now() - startMs;
        // Transition step to failed instead of leaving it stuck in 'running'
        const failBoard = helpers.readBoard();
        const failTask = (failBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
        const failStep = failTask?.steps?.find(s => s.step_id === envelope.step_id);
        if (failStep && failStep.state === 'running') {
          const errorKind = classifyError(dispatchErr, null);
          stepSchema.transitionStep(failStep, 'failed', {
            error: (dispatchErr.message || 'dispatch error').slice(0, 500),
            errorKind,
          });

          // Emit signal so dashboard/SSE sees dispatch errors
          const signalType = failStep.state === 'dead' ? 'step_dead' : 'step_failed';
          mgmt.ensureEvolutionFields(failBoard);
          failBoard.signals.push({
            id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'step-worker',
            type: signalType,
            content: `${envelope.task_id} step ${envelope.step_id} dispatch error → ${failStep.state}`,
            refs: [envelope.task_id],
            data: { taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: failStep.state, attempt: failStep.attempt },
          });
          if (failBoard.signals.length > 500) failBoard.signals = failBoard.signals.slice(-500);

          helpers.writeBoard(failBoard);
          helpers.appendLog({ ts: helpers.nowIso(), event: 'step_dispatch_error', taskId: envelope.task_id, stepId: envelope.step_id, error: dispatchErr.message, duration_ms: dispatchDurationMs });

          // Trigger kernel for dead steps — dead-letter routing, worktree cleanup, push notification
          if (failStep.state === 'dead' && deps.kernel) {
            const signal = { type: 'step_dead', data: { taskId: envelope.task_id, stepId: envelope.step_id } };
            setImmediate(() => {
              deps.kernel.onStepEvent(signal, helpers.readBoard(), helpers)
                .catch(err => console.error(`[step-worker] kernel callback error for ${envelope.step_id}:`, err.message));
            });
          }
        }
        throw dispatchErr;
      }
      activeExecutions.delete(envelope.step_id);
      durationMs = Date.now() - startMs;

      // 5. Parse output — try STEP_RESULT from extracted reply first (critical for
      //    JSON-wrapping runtimes like claude --output-format json where STEP_RESULT
      //    is inside parsed.result, not in raw stdout)
      const replyText = rt.extractReplyText(result.parsed, result.stdout);
      usage = rt.extractUsage?.(result.parsed, result.stdout) || null;
      sessionId = rt.extractSessionId?.(result.parsed) || null;
      stepResult = parseStepResult(replyText) || parseStepResult(result.stdout);

      if (stepResult) {
        // Structured output from agent
        const validStatuses = ['succeeded', 'needs_revision'];
        status = validStatuses.includes(stepResult.status) ? stepResult.status : 'failed';
        summary = stepResult.summary || replyText?.slice(0, 500) || null;
        failure = status === 'failed' ? {
          failure_signature: stepResult.error || replyText?.slice(0, 200),
          failure_mode: stepResult.failure_mode || null,
          retryable: stepResult.retryable !== false,
        } : null;
      } else {
        // Fall back to exit-code classification
        status = result.code === 0 ? 'succeeded' : 'failed';
        summary = replyText?.slice(0, 500) || null;
        failure = result.code !== 0 ? {
          failure_signature: replyText?.slice(0, 200),
          retryable: true,
        } : null;
      }

      // 5b. Post-condition verification — only when agent self-reported success
      postCheckResult = null;
      if (status === 'succeeded') {
        const postResult = await runPostCheck(plan.workingDir || plan.cwd);
        postCheckResult = postResult;
        if (postResult.hasUncommittedChanges) {
          // Attempt auto-finalize
          const finalized = autoFinalize(plan.workingDir || plan.cwd, envelope);
          if (!finalized.ok) {
            status = 'failed';
            failure = {
              failure_signature: `Post-check: uncommitted changes (${postResult.files.length} files) and auto-finalize failed: ${finalized.error}`,
              failure_mode: 'FINALIZE_ERROR',
              retryable: true,
            };
            summary = `Agent reported success but left uncommitted changes. Auto-finalize failed.`;
          } else {
            summary = (summary || '') + ` [auto-finalized: ${finalized.commitHash}]`;
          }
        }
      }

      // 5b2. Protected code guard — verify no @protected annotations were violated
      if (status === 'succeeded') {
        const { validateProtectedDiff } = require('./protected-diff-guard');
        const guardResult = validateProtectedDiff(plan.workingDir || plan.cwd);
        if (!guardResult.ok) {
          const violationSummary = guardResult.violations
            .map(v => `${v.file}:${v.line} — decision:${v.key} (${v.reason})`)
            .join('; ');
          status = 'failed';
          failure = {
            failure_signature: `Protected code violation: ${violationSummary}`.slice(0, 500),
            failure_mode: 'PROTECTED_CODE_VIOLATION',
            retryable: true,
          };
          summary = `Agent modified protected code. Violations: ${violationSummary}`.slice(0, 500);
          // Attempt revert if auto-finalize already committed
          try {
            if (!postCheckResult?.hasUncommittedChanges) {
              execSync('git revert --no-edit HEAD', {
                cwd: plan.workingDir || plan.cwd,
                encoding: 'utf8',
                timeout: 10000,
              });
            }
          } catch { /* revert failed — violation report triggers retry anyway */ }
        }
      }

      // 5c. Contract validation — verify declared deliverables exist
      if (status === 'succeeded' && envelope.contract?.deliverable) {
        const contractResult = validateContract(
          envelope.contract,
          { status, summary, payload: stepResult, failure },
          postCheckResult,
          plan.workingDir || plan.cwd,
        );
        if (!contractResult.ok) {
          status = 'failed';
          failure = {
            failure_signature: contractResult.reason,
            failure_mode: 'CONTRACT_VIOLATION',
            retryable: true,
          };
          summary = `Contract violation: ${contractResult.reason}`;
        }
      }
    }

    // Preserve full STEP_RESULT payload (proposal, plan, etc.) for downstream modules.
    // Without this, structured data from agents is lost and only summary text survives.
    const payload = stepResult ? (() => {
      const { status: _s, summary: _sm, error: _e, failure_mode: _f, retryable: _r, ...extra } = stepResult;
      return Object.keys(extra).length > 0 ? extra : null;
    })() : null;

    const agentOutput = {
      run_id: envelope.run_id,
      step_id: envelope.step_id,
      status,
      failure,
      summary,
      tokens_used: (usage?.inputTokens || 0) + (usage?.outputTokens || 0),
      duration_ms: durationMs,
      model_used: plan.modelHint,
      post_check: postCheckResult,
      payload,
      sessionId: sessionId || null,
      ...(stepResult?.revision_notes ? { revision_notes: stepResult.revision_notes } : {}),
      ...(preflightResult.alreadyDone ? { skipped: true, preflight: preflightResult } : {}),
    };
    artifactStore.writeArtifact(envelope.run_id, envelope.step_id, 'output', agentOutput);

    // 6. Transition step to final state
    const latestBoard = helpers.readBoard();
    const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
    const latestStep = latestTask?.steps?.find(s => s.step_id === envelope.step_id);
    // Persist session ID on task for subsequent steps / follow-up resume
    if (sessionId && latestTask) {
      latestTask.childSessionKey = sessionId;
    }

    if (latestStep && latestStep.state === 'running') {
      const newState = (agentOutput.status === 'succeeded' || agentOutput.status === 'needs_revision') ? 'succeeded' : 'failed';
      const errorKind = newState === 'failed' ? classifyError(null, agentOutput) : null;
      stepSchema.transitionStep(latestStep, newState, {
        output_ref: artifactStore.artifactPath(envelope.run_id, envelope.step_id, 'output'),
        error: agentOutput.failure?.failure_signature || null,
        errorKind,
      });

      // 7. Emit signal
      const signalType = latestStep.state === 'succeeded' ? 'step_completed'
        : latestStep.state === 'dead' ? 'step_dead'
        : latestStep.state === 'queued' ? 'step_failed'
        : `step_${latestStep.state}`;
      mgmt.ensureEvolutionFields(latestBoard);
      latestBoard.signals.push({
        id: helpers.uid('sig'), ts: helpers.nowIso(), by: 'step-worker',
        type: signalType,
        content: `${envelope.task_id} step ${envelope.step_id} running → ${latestStep.state}`,
        refs: [envelope.task_id],
        data: { taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state, attempt: latestStep.attempt, ...(preflightResult.alreadyDone ? { preflight: { skipped: true, evidence: preflightResult.evidence } } : {}) },
      });
      if (latestBoard.signals.length > 500) latestBoard.signals = latestBoard.signals.slice(-500);
      helpers.writeBoard(latestBoard);
      helpers.appendLog({ ts: helpers.nowIso(), event: signalType, taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state });

      // 8. Trigger kernel for terminal states (via setImmediate to avoid deep recursion)
      const newSignal = {
        type: signalType,
        data: { taskId: envelope.task_id, stepId: envelope.step_id, from: 'running', to: latestStep.state },
      };
      if (deps.kernel) {
        setImmediate(() => {
          deps.kernel.onStepEvent(newSignal, helpers.readBoard(), helpers)
            .catch(err => console.error(`[step-worker] kernel callback error for ${envelope.step_id}:`, err.message));
        });
      }
      // Note: deps.kernel is null during unit tests — this is expected (see server.js init order)
    }

    return agentOutput;
  }

  function killStep(stepId) {
    const exec = activeExecutions.get(stepId);
    if (!exec) return { ok: false, reason: 'not_running' };
    exec.abort();
    activeExecutions.delete(stepId);
    return { ok: true };
  }

  function getActiveExecutions() {
    return Array.from(activeExecutions.entries()).map(([stepId, { startedAt }]) => ({ stepId, startedAt }));
  }

  return { executeStep, killStep, getActiveExecutions };
}

// --- Helpers (module-level, testable) ---

/**
 * Classify error based on dispatch error or agent output.
 * Returns ErrorKind string (TEMPORARY, PROVIDER, AGENT_ERROR, etc.)
 * 
 * @param {Error|null} err - Dispatch error object
 * @param {object|null} agentOutput - Agent output with failure info
 * @returns {string} ErrorKind
 */
function classifyError(err, agentOutput) {
  // Check agent failure_mode first (more specific)
  if (agentOutput?.failure?.failure_mode) {
    for (const rule of ERROR_PATTERNS) {
      if (rule.failure_mode && agentOutput.failure.failure_mode === rule.failure_mode) {
        return rule.kind;
      }
    }
  }
  
  // Check dispatch error patterns
  if (err?.message) {
    for (const rule of ERROR_PATTERNS) {
      if (rule.pattern && rule.pattern.test(err.message)) {
        return rule.kind;
      }
    }
  }
  
  return 'UNKNOWN';
}

/**
 * Check working directory for uncommitted git changes.
 * Returns { hasUncommittedChanges, files }.
 * If the directory is not a git repo, returns a clean result (no-op).
 */
async function runPostCheck(workDir) {
  const opts = { cwd: workDir, encoding: 'utf8', timeout: 10000 };
  const result = { hasUncommittedChanges: false, files: [], hasNewCommit: false };

  if (!workDir) return result;

  try {
    const porcelain = execSync('git status --porcelain', opts).trim();
    if (porcelain) {
      result.hasUncommittedChanges = true;
      result.files = porcelain.split('\n').map(l => l.trim()).filter(Boolean);
    }
  } catch (err) {
    // Not a git repo or git not available — skip post-check
    return result;
  }

  return result;
}

/**
 * Attempt to commit all uncommitted changes on behalf of the agent.
 * Returns { ok, commitHash } on success or { ok, error } on failure.
 */
function autoFinalize(workDir, envelope) {
  const opts = { cwd: workDir, encoding: 'utf8', timeout: 30000 };
  try {
    execSync('git add -A', opts);
    const msg = `chore: auto-finalize step ${envelope.step_id} for ${envelope.task_id}`;
    execSync(`git commit -m "${msg}"`, opts);
    const hash = execSync('git log -1 --format=%h', opts).trim();

    // Try to push if on a branch
    try {
      execSync('git push', opts);
    } catch {
      // Push failed — still consider commit as success
    }

    return { ok: true, commitHash: hash };
  } catch (err) {
    return { ok: false, error: err.message?.slice(0, 200) || 'unknown' };
  }
}

/**
 * Validate a deliverable contract after agent reports success.
 * Returns { ok: true } or { ok: false, reason: "..." }.
 *
 * @param {object} contract      - { deliverable, acceptance, file_path? }
 * @param {object} agentOutput   - { status, summary, payload, failure }
 * @param {object} postCheckResult - From runPostCheck()
 * @param {string} workDir       - Working directory
 */
function validateContract(contract, agentOutput, postCheckResult, workDir) {
  if (!contract || !contract.deliverable) return { ok: true };

  switch (contract.deliverable) {
    case 'pr':             return validatePrDeliverable(agentOutput, workDir);
    case 'file':           return validateFileDeliverable(contract, workDir);
    case 'artifact':       return validateArtifactDeliverable(agentOutput);
    case 'command_result': return validateCommandResultDeliverable(agentOutput);
    case 'issue':          return validateIssueDeliverable(agentOutput);
    default:               return { ok: true }; // unknown type → pass (forward-compat)
  }
}

function validatePrDeliverable(agentOutput, workDir) {
  if (!workDir) return { ok: false, reason: 'deliverable pr: no working directory' };
  const opts = { cwd: workDir, encoding: 'utf8', timeout: 15000 };

  // Check for new commits
  try {
    const log = execSync('git log --oneline -1', opts).trim();
    if (!log) return { ok: false, reason: 'deliverable pr: no commits found' };
  } catch {
    return { ok: false, reason: 'deliverable pr: git log failed (not a git repo?)' };
  }

  // Check for PR URL in agent summary or try gh pr list
  const text = agentOutput.summary || '';
  const hasPrUrl = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(text);
  if (hasPrUrl) return { ok: true };

  try {
    const branch = execSync('git branch --show-current', opts).trim();
    if (branch) {
      const prList = execSync(`gh pr list --head "${branch}" --json url --limit 1`, opts).trim();
      const prs = JSON.parse(prList || '[]');
      if (prs.length > 0) return { ok: true };
    }
  } catch {
    // gh CLI not available — fall through
  }

  return { ok: false, reason: 'deliverable pr: no PR found for current branch' };
}

function validateFileDeliverable(contract, workDir) {
  if (!workDir) return { ok: false, reason: 'deliverable file: no working directory' };
  const filePath = contract.file_path;
  if (!filePath) return { ok: false, reason: 'deliverable file: contract.file_path not specified' };

  const fs = require('fs');
  const path = require('path');
  const resolved = path.resolve(workDir, filePath);

  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: `deliverable file: ${filePath} does not exist` };
  }
  const stat = fs.statSync(resolved);
  if (stat.size === 0) {
    return { ok: false, reason: `deliverable file: ${filePath} is empty` };
  }
  return { ok: true };
}

function validateArtifactDeliverable(agentOutput) {
  if (!agentOutput.payload) {
    return { ok: false, reason: 'deliverable artifact: payload is null/empty' };
  }
  const summary = agentOutput.summary || '';
  if (summary.length < 50) {
    return { ok: false, reason: `deliverable artifact: summary too short (${summary.length} chars, need 50+)` };
  }
  return { ok: true };
}

function validateCommandResultDeliverable(agentOutput) {
  const summary = agentOutput.summary || '';
  if (!summary) {
    return { ok: false, reason: 'deliverable command_result: summary is empty' };
  }
  return { ok: true };
}

function validateIssueDeliverable(agentOutput) {
  const text = [agentOutput.summary || '', JSON.stringify(agentOutput.payload || '')].join(' ');
  const hasIssueUrl = /github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(text);
  if (hasIssueUrl) return { ok: true };
  return { ok: false, reason: 'deliverable issue: no GitHub issue URL found in output' };
}

/**
 * Check if the work described in the envelope has already been implemented.
 * Returns { alreadyDone, evidence, checks }.
 * Only marks as done if ALL extracted targets are found (avoids false positives).
 */
function runPreflight(envelope, workDir) {
  const result = { alreadyDone: false, evidence: null, checks: [] };

  if (!workDir) return result;

  const targets = extractPreflightTargets(envelope.instruction || '');
  if (targets.length === 0) return result; // No targets to check, proceed normally

  const opts = { cwd: workDir, encoding: 'utf8', timeout: 5000 };
  const fs = require('fs');
  const path = require('path');

  let matched = 0;
  for (const target of targets) {
    try {
      let found = false;

      if (target.type === 'file') {
        found = fs.existsSync(path.resolve(workDir, target.value));
      } else if (target.type === 'function' || target.type === 'pattern') {
        try {
          execSync(`git grep -q "${target.value}" -- "*.js" "*.ts"`, opts);
          found = true;
        } catch {
          found = false;
        }
      } else if (target.type === 'route') {
        try {
          execSync(`git grep -q "${target.value}" -- "*.js"`, opts);
          found = true;
        } catch {
          found = false;
        }
      }

      result.checks.push({ target: target.value, type: target.type, found });
      if (found) matched++;
    } catch {
      // Check failed, skip
    }
  }

  // Only mark as already done if ALL targets are found (avoid false positives)
  if (targets.length > 0 && matched === targets.length) {
    result.alreadyDone = true;
    result.evidence = targets.map(t => `${t.type}:${t.value}`).join(', ');
  }

  return result;
}

/**
 * Extract checkable targets (file paths, function names, route patterns)
 * from a step instruction string.
 */
function extractPreflightTargets(instruction) {
  if (!instruction || typeof instruction !== 'string') return [];
  const targets = [];

  // Match file paths like server/village/retro.js or routes/village.js
  const filePaths = instruction.match(/(?:server|routes|village|src)\/[\w\-\/]+\.\w+/g);
  if (filePaths) {
    for (const fp of filePaths) {
      targets.push({ type: 'file', value: fp });
    }
  }

  // Match function names like buildVillageNotification, createScheduler
  const funcNames = instruction.match(/(?:function|const|def)\s+(\w{8,})/g);
  if (funcNames) {
    for (const fn of funcNames) {
      const name = fn.replace(/^(?:function|const|def)\s+/, '');
      targets.push({ type: 'function', value: name });
    }
  }

  // Match route patterns like /api/village/approve
  const routes = instruction.match(/\/api\/[\w\/\-]+/g);
  if (routes) {
    for (const route of routes) {
      targets.push({ type: 'route', value: route });
    }
  }

  // Deduplicate
  const seen = new Set();
  return targets.filter(t => {
    const key = `${t.type}:${t.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse structured STEP_RESULT from agent stdout.
 * Format: STEP_RESULT:{"status":"succeeded","summary":"..."}
 * Scans from last line backward (agent may produce other output before).
 */
function parseStepResult(stdout) {
  if (!stdout) return null;
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^STEP_RESULT:\s*(\{.*\})$/);
    if (match) {
      try { return JSON.parse(match[1]); } catch { continue; }
    }
  }
  return null;
}

/**
 * Build step-specific prompt message from envelope.
 *
 * Core insight: Claude Code skills already contain the full workflow logic
 * for each step. Instead of rewriting objectives, we invoke the corresponding
 * skill directly. The headless agent (`claude -p`) runs in the repo directory
 * and has access to `.claude/skills/`.
 */
function buildStepMessage(envelope, upstreamArtifacts, board, task) {
  // Extract issue number from task source or task ID (GH-123 → 123)
  const source = envelope.input_refs?.task_source;
  const issueNumber = source?.number
    || (envelope.task_id.match(/^GH-(\d+)$/) || [])[1]
    || envelope.task_id;

  // Map built-in engineering steps to skill invocations.
  // Step instructions: explicit role, scope constraints, and deliverable checklist.
  // Pattern from Claude Code: READ-ONLY constraints + "Your role is EXCLUSIVELY to..." framing.
  const SKILL_TOOL_HINT = 'You have a "Skill" tool available. Use it to load the skill by name (e.g., Skill("issue-plan")), then follow its instructions.';

  const STEP_CONTEXT_SECTIONS = {
    plan:      ['requirements', 'upstream_artifacts', 'preflight_lessons'],
    implement: ['requirements', 'upstream_artifacts', 'coding_standards', 'completion_criteria', 'protected_decisions', 'preflight_lessons'],
    test:      ['coding_standards'],
    review:    ['requirements'],
  };

  function shouldInjectSection(stepType, sectionName) {
    const allowed = STEP_CONTEXT_SECTIONS[stepType] || [];
    return allowed.includes(sectionName);
  }

  const STEP_SKILL_MAP = {
    plan: [
      `## Role`,
      `Your role is EXCLUSIVELY to research and plan. You are STRICTLY PROHIBITED from:`,
      `- Modifying any source code files`,
      `- Running git commit, git push, or gh pr create`,
      `- Making implementation changes of any kind`,
      ``,
      `## Instructions`,
      `Load the "issue-plan" skill for issue #${issueNumber}:`,
      SKILL_TOOL_HINT,
      ``,
      `## Required Actions (in order)`,
      `1. Read the full GitHub issue: \`gh issue view ${issueNumber}\``,
      `2. Research the codebase — read relevant files, grep for patterns, understand existing code`,
      `3. For each requirement in the issue, identify the exact files and line numbers to change`,
      `4. Write a concrete plan with specific code changes (not vague descriptions)`,
      `5. Post the plan as a comment on the issue: \`gh issue comment ${issueNumber} --body "..."\``,
      ``,
      `## Deliverable`,
      `A plan comment posted on issue #${issueNumber}. The plan must list every file to modify, what to change, and why.`,
    ].join('\n'),
    implement: [
      `## Role`,
      `Your role is to implement the plan and deliver a pull request. You MUST complete ALL of the following actions.`,
      ``,
      `## Instructions`,
      `Load the "issue-action" skill for issue #${issueNumber}:`,
      SKILL_TOOL_HINT,
      `The plan has been posted as a comment on the issue — read it from there.`,
      ``,
      `## Required Actions (in order)`,
      `1. Read the plan: \`gh issue view ${issueNumber} --comments\``,
      `2. Implement EVERY item in the plan — do not skip any requirement`,
      `3. Verify syntax on each modified file: \`node -c <file>\``,
      `4. Run tests to verify nothing is broken (e.g., \`npm test\` or individual test files)`,
      `5. Commit all changes: \`git add <files> && git commit -m "feat(scope): description (GH-${issueNumber})"\``,
      `6. Push the branch: \`git push -u origin $(git branch --show-current)\``,
      `7. Create a pull request: \`gh pr create --title "..." --body "Closes #${issueNumber}"\``,
      ``,
      `## Deliverable`,
      `A merged-ready pull request on GitHub. The pipeline verifies the PR exists — if you skip step 6 or 7, the step WILL fail and retry.`,
      ``,
      `## STEP_RESULT Output`,
      `Your final STEP_RESULT MUST include a "prUrl" field with the full PR URL:`,
      `STEP_RESULT:{"status":"succeeded","summary":"...","prUrl":"https://github.com/owner/repo/pull/123"}`,
      ``,
      `## STRICTLY PROHIBITED`,
      `- Skipping any requirement from the plan`,
      `- Reporting success without pushing and creating a PR`,
      `- Adding features or changes not described in the plan`,
    ].join('\n'),
    test: [
      `## Role`,
      `Your role is to verify CI passes for the PR.`,
      ``,
      `## Required Actions`,
      `1. Check CI status: \`gh pr checks\``,
      `2. If lint/format failures: auto-fix, commit, and push`,
      `3. If test failures: diagnose, fix, commit, and push`,
      `4. Report final test results`,
    ].join('\n'),
    review: [
      `## Role`,
      `Your role is EXCLUSIVELY to review code quality. You are STRICTLY PROHIBITED from:`,
      `- Modifying any source code files`,
      `- Running git commit or git push`,
      `- Making implementation changes of any kind`,
      ``,
      `## Instructions`,
      `Load the "pr-review" skill:`,
      SKILL_TOOL_HINT,
      ``,
      `## Required Actions (in order)`,
      `1. Find the PR: \`gh pr list --head "$(git branch --show-current)" --json number,url\``,
      `2. Read the full diff: \`gh pr diff <number>\``,
      `3. Run the four-point check: Scope, Reality, Testing, YAGNI`,
      `4. Post your review as a PR comment: \`gh pr comment <number> --body "..."\``,
      `5. Include a clear verdict: **LGTM** or **Changes Requested**`,
      ``,
      `## STEP_RESULT Mapping`,
      `Your final STEP_RESULT status MUST match your verdict:`,
      `- LGTM (no blocking issues): STEP_RESULT:{"status":"succeeded","summary":"LGTM — ..."}`,
      `- Changes Requested: STEP_RESULT:{"status":"needs_revision","summary":"Changes Requested — ...","revision_notes":"what to fix"}`,
      `- Critical blocker (security, data loss): STEP_RESULT:{"status":"failed","summary":"Blocker — ..."}`,
      ``,
      `## Deliverable`,
      `A review comment posted on the PR with a clear verdict.`,
    ].join('\n'),
  };

  // Prefer task-defined semantic instructions over hard-coded step map.
  const skillMsg = (typeof envelope.instruction === 'string' && envelope.instruction.trim())
    || (typeof envelope.skill === 'string' && envelope.skill.trim() ? `Execute ${envelope.skill.trim()}` : null)
    || STEP_SKILL_MAP[envelope.step_type]
    || `Complete the ${envelope.step_type} step for task ${envelope.task_id}.`;

  const stepHeader = String(envelope.step_type || '').toUpperCase();
  const objective = envelope.objective || `Execute step: ${envelope.step_type}`;

  const lines = [
    `Step Dispatch: ${stepHeader}`,
    `Objective: ${objective}`,
    '',
    skillMsg,
    '',
    `Task: ${envelope.task_id}`,
    `Step: ${envelope.step_id} (${envelope.step_type})`,
  ];

  if (envelope.input_refs.task_description) {
    lines.push('', '## Requirements (from task description — implement ALL of these)');
    lines.push('', envelope.input_refs.task_description);
  }

  // Inject upstream artifacts (from completed dependency tasks)
  // Use UPSTREAM_RELEVANCE to filter what each step type needs
  const relevance = UPSTREAM_RELEVANCE[envelope.step_type];
  if (relevance && Array.isArray(upstreamArtifacts) && upstreamArtifacts.length > 0) {
    lines.push('', '## Upstream Task Outputs');
    for (const u of upstreamArtifacts) {
      lines.push(`### ${u.id} — ${u.title || '(untitled)'} [${u.status}]`);
      
      // Include summary if relevant
      if (relevance.include.includes('summary') && u.summary) {
        lines.push(u.summary);
      }
      
      // Include payload if relevant
      if (relevance.include.includes('payload') && u.payload) {
        lines.push('```json');
        lines.push(JSON.stringify(u.payload, null, 2));
        lines.push('```');
      }
      
      // Always add reference to full output file
      if (u.output_ref) {
        lines.push(`(Full output: ${u.output_ref})`);
      }
    }
    lines.push('');
  }

  // Coding standards from skill files (resolve from target project if set)
  if (shouldInjectSection(envelope.step_type, 'coding_standards')) {
    const projectRoot = resolveRepoRoot(task, board);
    const skillLines = mgmt.buildSkillContextSection(projectRoot);
    if (skillLines.length > 0) lines.push(...skillLines);
  }

  // Completion criteria — prevent premature "done"
  if (shouldInjectSection(envelope.step_type, 'completion_criteria')) {
    const completionLines = mgmt.buildCompletionCriteriaSection();
    if (completionLines.length > 0) lines.push(...completionLines);
  }

  // Preflight lessons (previously missing from step pipeline)
  if (shouldInjectSection(envelope.step_type, 'preflight_lessons') && board && task) {
    const preflight = mgmt.buildPreflightSection(board, task);
    if (preflight.lines.length > 0) {
      lines.push('');
      lines.push(...preflight.lines);
    }
  }

  if (envelope.retry_context) {
    lines.push('', '\u26a0 RETRY — this step previously failed:');
    lines.push(`  Attempt: ${envelope.retry_context.attempt}`);
    if (envelope.retry_context.previous_error) lines.push(`  Previous error: ${envelope.retry_context.previous_error}`);
    if (envelope.retry_context.failure_mode) lines.push(`  Failure mode: ${envelope.retry_context.failure_mode}`);
    if (envelope.retry_context.remediation_hint) lines.push(`  Hint: ${envelope.retry_context.remediation_hint}`);
  }

  if (envelope.review_feedback) {
    lines.push('', '🔄 REVISION — the review found issues to fix:');
    lines.push(envelope.review_feedback);
    lines.push('', 'Fix the issues listed above. Do NOT re-implement from scratch — only address the review findings.');
  }

  // Protected edda decisions — prevent agents from reverting critical fixes
  if (shouldInjectSection(envelope.step_type, 'protected_decisions')) {
    const protectedLines = mgmt.buildProtectedDecisionsSection();
    if (protectedLines.length > 0) {
      lines.push(...protectedLines);
    }
  }

  // Instruct agent to output structured result when done
  lines.push('', 'IMPORTANT: When you are completely done, output your result on the LAST line as:');
  lines.push('STEP_RESULT:{"status":"succeeded","summary":"one line summary of what you did"}');
  lines.push('Or on failure:');
  lines.push('STEP_RESULT:{"status":"failed","error":"what went wrong","failure_mode":"TEST_FAILURE","retryable":true}');

  return lines.join('\n');
}

/**
 * Recover expired locks at server startup.
 * Steps stuck in 'running' with expired lock_expires_at get reset to 'queued'.
 */
function recoverExpiredLocks(board) {
  const now = new Date().toISOString();
  let recovered = 0;
  for (const task of board.taskPlan?.tasks || []) {
    for (const step of task.steps || []) {
      if (step.state === 'running' && step.lock_expires_at && step.lock_expires_at < now) {
        step.state = 'queued';
        step.locked_by = null;
        step.lock_expires_at = null;
        step.error = 'Lock expired (server restart recovery)';
        recovered++;
      }
    }
  }
  return recovered;
}

module.exports = { createStepWorker, parseStepResult, buildStepMessage, recoverExpiredLocks, runPreflight, extractPreflightTargets, validateContract, classifyError };
