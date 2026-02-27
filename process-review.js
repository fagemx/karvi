#!/usr/bin/env node
/**
 * process-review.js — Atomic review script for Task Engine
 *
 * Usage:
 *   node process-review.js                    # review all completed tasks
 *   node process-review.js --task T3          # review specific task
 *   node process-review.js --dry-run          # preview only
 *   node process-review.js --skip-llm         # deterministic checks only
 *   node process-review.js --threshold 80     # override quality threshold
 *   node process-review.js --board path.json  # custom board path
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const DEFAULT_BOARD = path.join(DIR, 'board.json');
const LOG_PATH = path.join(DIR, 'task-log.jsonl');
const OPENCLAW_CMD = process.env.OPENCLAW_CMD || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');

const DEFAULT_CONTROLS = {
  auto_review: true,
  max_review_attempts: 3,
  quality_threshold: 70,
  review_timeout_sec: 180,
  review_agent: 'engineer_lite',
};

const NODE_BUILTINS = new Set([
  'http','https','fs','path','child_process','url','crypto','os','stream',
  'events','net','querystring','util','zlib','assert','buffer','cluster',
  'dgram','dns','domain','readline','repl','string_decoder','tls','tty',
  'v8','vm','worker_threads',
]);

// --- CLI ---

function parseArgs() {
  const args = { task: null, dryRun: false, skipLlm: false, threshold: null, board: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task' && argv[i + 1]) args.task = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--skip-llm') args.skipLlm = true;
    else if (argv[i] === '--threshold' && argv[i + 1]) args.threshold = Number(argv[++i]);
    else if (argv[i] === '--board' && argv[i + 1]) args.board = argv[++i];
  }
  return args;
}

function nowIso() { return new Date().toISOString(); }

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendLog(entry) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); } catch {}
}

function emitSignal(signal) {
  const port = 3461;
  const body = JSON.stringify(signal);
  const req = require('http').request({
    hostname: 'localhost',
    port,
    path: '/api/signals',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {});
  req.on('error', () => {}); // fire-and-forget
  req.end(body);
}

// --- Target directory inference ---

function inferTargetDir(board, task) {
  const specPath = board.taskPlan?.spec || '';
  const WORKSPACE = path.resolve(DIR, '..', '..');
  let targetDir = '';

  if (specPath) {
    try {
      const specContent = fs.readFileSync(path.join(DIR, specPath), 'utf8');
      const m = specContent.match(/^project\/([a-z0-9-]+)\/$/m);
      if (m) targetDir = path.join(WORKSPACE, 'project', m[1]);
    } catch {}
  }

  if (!targetDir && task.description) {
    const m = task.description.match(/project\/([a-z0-9-]+)/);
    if (m) targetDir = path.join(WORKSPACE, 'project', m[1]);
  }

  if (!targetDir && board.taskPlan?.goal) {
    const goalClean = (board.taskPlan.goal || '').replace(/[（）()]/g, '');
    try {
      const projectDir = path.join(WORKSPACE, 'project');
      if (fs.existsSync(projectDir)) {
        for (const d of fs.readdirSync(projectDir)) {
          if (goalClean.toLowerCase().includes(d.toLowerCase())) {
            targetDir = path.join(WORKSPACE, 'project', d);
            break;
          }
        }
      }
    } catch {}
  }

  return targetDir;
}

// --- Deterministic checks ---

function runDeterministicChecks(targetDir) {
  const issues = [];
  if (!targetDir || !fs.existsSync(targetDir)) {
    return { issues: ['Target directory not found or unresolved'], files: [], excerpts: [] };
  }

  const MAX_FILES = 15;
  const MAX_CHARS = 2000;
  const files = [];
  const excerpts = [];

  const candidates = fs.readdirSync(targetDir)
    .filter(f => /\.(js|html|json|md|css)$/i.test(f))
    .slice(0, MAX_FILES);

  for (const f of candidates) {
    const fullPath = path.join(targetDir, f);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      files.push({ name: f, size: stat.size });

      const content = fs.readFileSync(fullPath, 'utf8');

      if (content.trim().length === 0) {
        issues.push(`${f}: file is empty`);
        continue;
      }

      if (f.endsWith('.json')) {
        try { JSON.parse(content); }
        catch (e) { issues.push(`${f}: invalid JSON — ${e.message}`); }
      }

      if (f.endsWith('.js')) {
        const externalReqs = content.match(/require\(['"]([^./][^'"]*)['"]\)/g) || [];
        for (const req of externalReqs) {
          const m = req.match(/require\(['"]([^'"]+)['"]\)/);
          if (m && !NODE_BUILTINS.has(m[1]) && !m[1].startsWith('.') && !m[1].startsWith('node:')) {
            issues.push(`${f}: external dependency "${m[1]}" (zero-dependency violation)`);
          }
        }
      }

      const lines = content.split('\n');
      const excerpt = lines.length > 80
        ? lines.slice(0, 40).join('\n') + `\n... (${lines.length - 80} lines omitted) ...\n` + lines.slice(-40).join('\n')
        : content;
      excerpts.push({ name: f, excerpt: excerpt.slice(0, MAX_CHARS) });
    } catch {}
  }

  return { issues, files, excerpts };
}

// --- LLM review ---

function callReviewer(task, excerpts, controls) {
  const fileList = excerpts.map(e => `- ${e.name}`).join('\n');
  const codeContent = excerpts.slice(0, 8)
    .map(e => `=== ${e.name} ===\n${e.excerpt}`)
    .join('\n\n---\n\n');

  const prompt = `You are a code reviewer. Review the code below for task "${task.id}: ${task.title}".

IMPORTANT: The code is provided below. Do NOT ask for code. Review it NOW.

Files: ${fileList}

--- CODE START ---
${codeContent}
--- CODE END ---

Review checklist:
1. Does the code work? (syntax errors, logic bugs)
2. Zero external dependencies? (only Node.js built-ins allowed)
3. Windows compatible? (path separators, spawn patterns)
4. UTF-8 handling correct?
5. Overall quality and completeness

YOUR OUTPUT MUST END WITH THIS EXACT LINE:
REVIEW_RESULT:{"score":85,"issues":[],"summary":"one line summary"}

Score guide:
  90-100: Production ready
  70-89:  Minor issues, acceptable
  50-69:  Has problems
  0-49:   Major issues`;

  const agentId = controls.review_agent || 'engineer_lite';
  const timeout = controls.review_timeout_sec || 180;

  const args = ['agent', '--agent', agentId, '--message', prompt, '--json', '--timeout', String(timeout)];

  const spawnArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', OPENCLAW_CMD, ...args]
    : args;
  const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : OPENCLAW_CMD;

  const spawnEnv = { ...process.env };
  if (process.platform === 'win32') {
    spawnEnv.PYTHONIOENCODING = 'utf-8';
    spawnEnv.PYTHONUTF8 = '1';
  }

  const result = spawnSync(spawnCmd, spawnArgs, {
    cwd: DIR,
    windowsHide: true,
    shell: false,
    env: spawnEnv,
    encoding: 'utf8',
    timeout: (timeout + 30) * 1000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `exit code ${result.status}`);

  let replyText = '';
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const payloads = parsed?.result?.payloads;
    if (Array.isArray(payloads) && payloads.length > 0) {
      replyText = payloads.map(p => p?.text).filter(Boolean).join('\n\n').trim();
    }
    if (!replyText) {
      replyText = parsed?.reply || parsed?.text || parsed?.result?.reply || parsed?.result?.text || '';
    }
  } catch {}

  if (!replyText) replyText = result.stdout.trim();

  return replyText;
}

// --- Parse review result ---

function parseReviewResult(text) {
  let result = null;
  let source = null;

  // Strategy 1: REVIEW_RESULT line
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(/^REVIEW_RESULT:\s*(\{.*\})$/);
    if (m) {
      try { result = JSON.parse(m[1]); source = 'line'; } catch {}
      break;
    }
  }

  // Strategy 2: inline
  if (!result) {
    const m = text.match(/REVIEW_RESULT:\s*(\{[^\n]*\})/);
    if (m) try { result = JSON.parse(m[1]); source = 'inline'; } catch {}
  }

  // Strategy 3: JSON code block
  if (!result) {
    const m = text.match(/```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/);
    if (m) {
      try {
        const p = JSON.parse(m[1]);
        if (typeof p.score === 'number' || typeof p.pass === 'boolean') { result = p; source = 'code_block'; }
      } catch {}
    }
  }

  // Strategy 4: bare JSON with score or pass
  if (!result) {
    const m = text.match(/\{[^{}]*"(?:score|pass)"\s*:[^{}]*\}/);
    if (m) try { result = JSON.parse(m[0]); source = 'bare_json'; } catch {}
  }

  // Strategy 5: keyword inference
  if (!result) {
    const lower = text.toLowerCase();
    const passWords = ['all checks pass', 'no issues found', 'looks good', 'lgtm', '通過'];
    const failWords = ['fail', 'issue', 'problem', 'error', 'bug', '問題', '未通過'];
    const hasPass = passWords.some(s => lower.includes(s));
    const hasFail = failWords.some(s => lower.includes(s));
    if (hasPass && !hasFail) { result = { score: 85, issues: [], summary: 'Inferred pass' }; source = 'keyword'; }
    else if (hasFail) { result = { score: 40, issues: ['Issues found in review text'], summary: 'Inferred fail' }; source = 'keyword'; }
  }

  if (!result) {
    return { score: null, issues: ['Reviewer produced no parseable result'], summary: null, source: 'fallback' };
  }

  // Normalize: ensure we have a score
  let score = Number.isFinite(result.score) ? result.score : null;
  if (score === null && typeof result.pass === 'boolean') {
    score = result.pass ? 90 : 35;
  }

  return {
    score,
    issues: Array.isArray(result.issues) ? result.issues : [],
    summary: result.summary || null,
    source,
  };
}

// --- Evaluate score vs threshold ---

function evaluate(score, threshold) {
  if (score === null) return { pass: false, reason: 'No valid score' };
  if (score >= threshold) return { pass: true, reason: `Score ${score} >= threshold ${threshold}` };
  return { pass: false, reason: `Score ${score} < threshold ${threshold}` };
}

// --- Main ---

function main() {
  const args = parseArgs();
  const boardPath = args.board || DEFAULT_BOARD;

  if (!fs.existsSync(boardPath)) {
    console.error(`Board not found: ${boardPath}`);
    process.exit(1);
  }

  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const controls = { ...DEFAULT_CONTROLS, ...(board.controls || {}) };
  const threshold = args.threshold || controls.quality_threshold;

  const tasks = board.taskPlan?.tasks || [];
  let targets;

  if (args.task) {
    const t = tasks.find(t => t.id === args.task);
    if (!t) { console.error(`Task ${args.task} not found`); process.exit(1); }
    targets = [t];
  } else {
    targets = tasks.filter(t => t.status === 'completed');
  }

  if (targets.length === 0) {
    console.log('No tasks to review.');
    return;
  }

  // Backup
  if (!args.dryRun) {
    try { fs.copyFileSync(boardPath, boardPath + '.bak'); } catch {}
  }

  const conv = board.conversations?.[0];
  let processed = 0;

  for (const task of targets) {
    console.log(`\n--- Reviewing ${task.id}: ${task.title} ---`);

    task.reviewAttempts = (task.reviewAttempts || 0) + 1;

    if (task.reviewAttempts > controls.max_review_attempts) {
      console.log(`  SKIP: max attempts reached (${controls.max_review_attempts})`);
      task.status = 'needs_revision';
      task.history = task.history || [];
      task.history.push({ ts: nowIso(), status: 'needs_revision', by: 'max-attempts' });
      if (conv) conv.messages.push({
        id: uid('msg'), ts: nowIso(), type: 'error', from: 'system', to: 'human',
        text: `【${task.id}】review 已達上限（${controls.max_review_attempts} 次）`,
      });
      appendLog({ ts: nowIso(), event: 'review_max_attempts', taskId: task.id });
      processed++;
      continue;
    }

    // Skip Lead/Human tasks
    if (task.assignee === 'main' || task.assignee === 'human') {
      console.log(`  AUTO-APPROVE: Lead/Human task`);
      task.status = 'approved';
      task.approvedAt = nowIso();
      task.history = task.history || [];
      task.history.push({ ts: nowIso(), status: 'approved', by: 'auto-skip', reason: 'Lead/Human task' });
      appendLog({ ts: nowIso(), event: 'review_skipped', taskId: task.id });
      processed++;
      continue;
    }

    const targetDir = inferTargetDir(board, task);
    console.log(`  targetDir: ${targetDir || '(unresolved)'}`);

    // Deterministic checks
    const det = runDeterministicChecks(targetDir);
    console.log(`  files: ${det.files.length}, deterministic issues: ${det.issues.length}`);

    if (det.issues.length > 0) {
      console.log(`  DETERMINISTIC FAIL:`);
      det.issues.forEach(i => console.log(`    - ${i}`));

      if (!args.dryRun) {
        task.status = 'needs_revision';
        task.history = task.history || [];
        task.history.push({ ts: nowIso(), status: 'needs_revision', by: 'deterministic-check', issues: det.issues });
        task.review = {
          score: 0, issues: det.issues, source: 'deterministic',
          reviewedAt: nowIso(), attempt: task.reviewAttempts,
        };
        if (conv) conv.messages.push({
          id: uid('msg'), ts: nowIso(), type: 'error', from: 'system', to: 'human',
          text: `【${task.id} 預檢未通過 ⚠️】\n${det.issues.map(i => '- ' + i).join('\n')}\n(未呼叫 LLM)`,
        });
      }
      appendLog({ ts: nowIso(), event: 'review_deterministic_fail', taskId: task.id, issues: det.issues });
      processed++;
      continue;
    }

    if (det.files.length === 0) {
      console.log(`  NO FILES: nothing to review`);
      if (!args.dryRun) {
        task.status = 'needs_revision';
        task.history = task.history || [];
        task.history.push({ ts: nowIso(), status: 'needs_revision', by: 'deterministic-check', issues: ['No files'] });
        task.review = { score: 0, issues: ['No reviewable files found'], source: 'deterministic', reviewedAt: nowIso() };
        if (conv) conv.messages.push({
          id: uid('msg'), ts: nowIso(), type: 'error', from: 'system', to: 'human',
          text: `【${task.id}】找不到可審查的檔案`,
        });
      }
      processed++;
      continue;
    }

    if (args.skipLlm) {
      console.log(`  DETERMINISTIC PASS (--skip-llm)`);
      if (!args.dryRun) {
        task.status = 'approved';
        task.approvedAt = nowIso();
        task.history = task.history || [];
        task.history.push({ ts: nowIso(), status: 'approved', by: 'deterministic-only' });
        task.review = { score: 100, issues: [], source: 'deterministic-only', reviewedAt: nowIso() };
      }
      processed++;
      continue;
    }

    // LLM review
    console.log(`  Calling reviewer (${controls.review_agent})...`);
    if (args.dryRun) {
      console.log(`  DRY RUN: would call LLM here`);
      processed++;
      continue;
    }

    task.status = 'reviewing';
    task.history = task.history || [];
    task.history.push({ ts: nowIso(), status: 'reviewing', by: 'process-review', attempt: task.reviewAttempts });
    if (conv) conv.messages.push({
      id: uid('msg'), ts: nowIso(), type: 'system', from: 'system', to: 'human',
      text: `【${task.id} 審查中】第 ${task.reviewAttempts}/${controls.max_review_attempts} 次`,
    });
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), 'utf8');

    let replyText;
    try {
      replyText = callReviewer(task, det.excerpts, controls);
    } catch (err) {
      console.error(`  REVIEWER ERROR: ${err.message}`);
      task.status = 'needs_revision';
      task.review = { error: err.message, reviewedAt: nowIso(), attempt: task.reviewAttempts };
      task.history.push({ ts: nowIso(), status: 'needs_revision', by: 'review-error', error: err.message });
      if (conv) conv.messages.push({
        id: uid('msg'), ts: nowIso(), type: 'error', from: 'system', to: 'human',
        text: `【${task.id} 審查錯誤】${err.message}`,
      });
      appendLog({ ts: nowIso(), event: 'review_error', taskId: task.id, error: err.message });
      processed++;
      continue;
    }

    const parsed = parseReviewResult(replyText);
    console.log(`  Score: ${parsed.score} (source: ${parsed.source}), threshold: ${threshold}`);

    const verdict = evaluate(parsed.score, threshold);
    console.log(`  Verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.reason}`);

    task.review = {
      score: parsed.score,
      issues: parsed.issues,
      summary: parsed.summary,
      source: parsed.source,
      report: replyText.slice(0, 2000),
      threshold,
      verdict: verdict.reason,
      reviewedAt: nowIso(),
      attempt: task.reviewAttempts,
    };

    if (verdict.pass) {
      task.status = 'approved';
      task.approvedAt = nowIso();
      task.history.push({ ts: nowIso(), status: 'approved', by: 'process-review', score: parsed.score });
      if (conv) conv.messages.push({
        id: uid('msg'), ts: nowIso(), type: 'message', from: 'system', to: 'human',
        text: `【${task.id} 審查通過 ✅】Score: ${parsed.score} (${parsed.source})\n${(parsed.summary || '').slice(0, 200)}`,
      });
      appendLog({ ts: nowIso(), event: 'review_passed', taskId: task.id, score: parsed.score, source: parsed.source });
      emitSignal({
        by: 'process-review.js',
        type: 'review_result',
        content: `${task.id} 審查通過 (score: ${parsed.score}/${threshold})`,
        refs: [task.id],
        data: {
          taskId: task.id,
          assignee: task.assignee || null,
          result: 'approved',
          score: parsed.score,
          threshold: threshold,
          deterministicIssues: parsed.issues.length,
          attempt: task.reviewAttempts || 1,
        },
      });
    } else {
      task.status = 'needs_revision';
      task.history.push({ ts: nowIso(), status: 'needs_revision', by: 'process-review', score: parsed.score, issues: parsed.issues });
      if (conv) conv.messages.push({
        id: uid('msg'), ts: nowIso(), type: 'error', from: 'system', to: 'human',
        text: `【${task.id} 審查未通過 ❌】Score: ${parsed.score}/${threshold} (${parsed.source})\n${parsed.issues.map(i => '- ' + i).join('\n')}\n\n等待 Human 決定`,
      });
      appendLog({ ts: nowIso(), event: 'review_failed', taskId: task.id, score: parsed.score, issues: parsed.issues });
      emitSignal({
        by: 'process-review.js',
        type: 'review_result',
        content: `${task.id} 審查未通過 (score: ${parsed.score}/${threshold}, issues: ${parsed.issues.length})`,
        refs: [task.id],
        data: {
          taskId: task.id,
          assignee: task.assignee || null,
          result: 'needs_revision',
          score: parsed.score,
          threshold: threshold,
          deterministicIssues: parsed.issues.length,
          issuesSummary: parsed.issues.slice(0, 5).join('; '),
          attempt: task.reviewAttempts || 1,
        },
      });
    }

    processed++;
  }

  // Unlock dependents for newly approved tasks
  const allTasks = board.taskPlan?.tasks || [];
  for (const t of allTasks) {
    if (t.status === 'pending' && t.depends?.length > 0) {
      const allDepsApproved = t.depends.every(depId => {
        const dep = allTasks.find(d => d.id === depId);
        return dep && dep.status === 'approved';
      });
      if (allDepsApproved) {
        t.status = 'dispatched';
        t.history = t.history || [];
        t.history.push({ ts: nowIso(), status: 'dispatched', reason: 'dependencies_approved' });
        console.log(`  UNLOCKED: ${t.id} (dependencies met)`);
        appendLog({ ts: nowIso(), event: 'task_auto_dispatched', taskId: t.id });
      }
    }
  }

  // Check if all done
  if (allTasks.length > 0 && allTasks.every(t => t.status === 'approved')) {
    board.taskPlan.phase = 'done';
  }

  // Atomic write
  if (!args.dryRun && processed > 0) {
    board.meta = board.meta || {};
    board.meta.updatedAt = nowIso();
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), 'utf8');
    console.log(`\nBoard updated. ${processed} task(s) processed.`);
  } else if (args.dryRun) {
    console.log(`\nDRY RUN complete. ${processed} task(s) would be processed.`);
  }
}

main();
