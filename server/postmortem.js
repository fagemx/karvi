/**
 * postmortem.js — Post-mortem analysis for failed/blocked tasks
 *
 * Generates root cause analysis from step artifacts and error logs.
 * Uses heuristic analysis (error pattern matching, step timeline analysis).
 *
 * POST /api/tasks/:id/postmortem — trigger analysis for a task
 * GET  /api/tasks/:id/postmortem — retrieve existing postmortem
 */
const bb = require('./blackboard-server');
const { json } = bb;
const artifactStore = require('./artifact-store');

const ERROR_PATTERNS = [
  { pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|Network Error/i, category: 'network', severity: 'high' },
  { pattern: /ENOENT|no such file|cannot find module|not found/i, category: 'file_not_found', severity: 'medium' },
  { pattern: /EACCES|EPERM|permission denied|access denied/i, category: 'permission', severity: 'high' },
  { pattern: /ENOMEM|out of memory|heap out of memory/i, category: 'memory', severity: 'critical' },
  { pattern: /timeout|timed out|Timeout/i, category: 'timeout', severity: 'medium' },
  { pattern: /syntax error|parse error|unexpected token/i, category: 'syntax', severity: 'medium' },
  { pattern: /rate limit|too many requests|429/i, category: 'rate_limit', severity: 'medium' },
  { pattern: /authentication|unauthorized|401|invalid.*token/i, category: 'auth', severity: 'high' },
  { pattern: /validation|invalid|schema|required/i, category: 'validation', severity: 'low' },
  { pattern: /dead letter|max.*attempt|exhausted/i, category: 'exhausted', severity: 'high' },
  { pattern: /git.*conflict|merge conflict|CONFLICT/i, category: 'git_conflict', severity: 'medium' },
  { pattern: /port.*in use|EADDRINUSE/i, category: 'port_conflict', severity: 'medium' },
];

const SUGGESTIONS = {
  network: [
    'Check network connectivity and DNS resolution',
    'Verify external service endpoints are accessible',
    'Consider adding retry logic with exponential backoff',
  ],
  file_not_found: [
    'Verify file paths and ensure files exist before access',
    'Check working directory context',
    'Use path.resolve() for absolute paths',
  ],
  permission: [
    'Check file/directory permissions',
    'Run with appropriate user privileges',
    'Verify process has write access to target directories',
  ],
  memory: [
    'Reduce data batch sizes',
    'Implement streaming for large file operations',
    'Check for memory leaks in long-running processes',
  ],
  timeout: [
    'Increase timeout thresholds if operation is expected to take longer',
    'Optimize slow operations',
    'Consider async processing for long-running tasks',
  ],
  syntax: [
    'Review code for syntax errors',
    'Validate JSON/input format before parsing',
    'Check for encoding issues',
  ],
  rate_limit: [
    'Implement request throttling',
    'Add delays between API calls',
    'Consider using request queues',
  ],
  auth: [
    'Verify API credentials are correct and not expired',
    'Check token scopes and permissions',
    'Refresh authentication tokens',
  ],
  validation: [
    'Review input schema requirements',
    'Check for missing required fields',
    'Validate data types match expectations',
  ],
  exhausted: [
    'Review retry strategy and failure patterns',
    'Check if underlying issue was transient',
    'Consider manual intervention',
  ],
  git_conflict: [
    'Resolve merge conflicts manually',
    'Pull latest changes and retry',
    'Check for concurrent modifications',
  ],
  port_conflict: [
    'Kill process using the port',
    'Use a different port',
    'Check for zombie processes',
  ],
  unknown: [
    'Review detailed error logs for specific error messages',
    'Check step artifacts for more context',
    'Consider escalating to human review',
  ],
};

function analyzeErrorPatterns(errorText) {
  if (!errorText || errorText.trim() === '') {
    return [{
      category: 'unknown',
      severity: 'medium',
      match: null,
      suggestions: SUGGESTIONS.unknown,
    }];
  }
  const findings = [];
  for (const { pattern, category, severity } of ERROR_PATTERNS) {
    const matches = errorText.match(pattern);
    if (matches) {
      findings.push({
        category,
        severity,
        match: matches[0],
        suggestions: SUGGESTIONS[category] || SUGGESTIONS.unknown,
      });
    }
  }
  if (findings.length === 0) {
    findings.push({
      category: 'unknown',
      severity: 'medium',
      match: null,
      suggestions: SUGGESTIONS.unknown,
    });
  }
  return findings;
}

function buildTimeline(steps, artifactStore) {
  const timeline = [];
  for (const step of steps || []) {
    const entry = {
      step_id: step.step_id,
      type: step.type,
      state: step.state,
      attempt: step.attempt || 0,
      started_at: step.started_at || null,
      completed_at: step.completed_at || null,
      duration_ms: step.duration_ms || null,
      error: step.error || null,
    };
    if (step.run_id) {
      const logs = artifactStore.readLogLines(step.run_id, step.step_id);
      if (logs.length > 0) {
        entry.log_entries = logs.length;
        const errorLogs = logs.filter(l => l.level === 'error' || l.error);
        if (errorLogs.length > 0) {
          entry.error_log_preview = errorLogs.slice(0, 3).map(l => l.message || l.error || JSON.stringify(l).slice(0, 200));
        }
      }
      const output = artifactStore.readArtifact(step.run_id, step.step_id, 'output');
      if (output) {
        entry.output_status = output.status || null;
        entry.output_summary = output.summary ? output.summary.slice(0, 300) : null;
        if (output.failure) {
          entry.failure_signature = output.failure.failure_signature || output.failure.message || null;
        }
      }
    }
    timeline.push(entry);
  }
  return timeline;
}

function determineRootCause(timeline, errorPatterns) {
  if (errorPatterns.length === 0) {
    return { primary: 'unknown', confidence: 'low', details: 'No error patterns detected' };
  }
  const sorted = [...errorPatterns].sort((a, b) => {
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2);
  });
  const primary = sorted[0];
  const failedSteps = timeline.filter(s => s.state === 'dead' || s.state === 'failed' || s.error);
  let confidence = 'medium';
  if (failedSteps.length === 0) confidence = 'low';
  else if (failedSteps.length === 1 && primary.category !== 'unknown') confidence = 'high';
  return {
    primary: primary.category,
    severity: primary.severity,
    confidence,
    matched_pattern: primary.match,
    affected_steps: failedSteps.map(s => s.step_id),
    details: buildRootCauseDetails(primary, failedSteps),
  };
}

function buildRootCauseDetails(pattern, failedSteps) {
  const parts = [];
  if (pattern.match) {
    parts.push(`Detected ${pattern.category} error: "${pattern.match}"`);
  }
  if (failedSteps.length > 0) {
    parts.push(`Failed step(s): ${failedSteps.map(s => s.step_id).join(', ')}`);
    const errors = failedSteps.filter(s => s.error).map(s => s.error);
    if (errors.length > 0) {
      parts.push(`Error messages: ${errors.slice(0, 2).join('; ')}`);
    }
  }
  return parts.join('. ') || 'Analysis completed but no specific root cause identified';
}

function generateSuggestions(rootCause, timeline) {
  const suggestions = [];
  const primaryPattern = ERROR_PATTERNS.find(p => p.category === rootCause.primary);
  if (primaryPattern) {
    suggestions.push(...(SUGGESTIONS[primaryPattern.category] || []));
  }
  const retryCount = timeline.reduce((sum, s) => sum + (s.attempt || 0), 0);
  if (retryCount > 3) {
    suggestions.push('High retry count detected — consider investigating persistent failure');
  }
  const deadSteps = timeline.filter(s => s.state === 'dead');
  if (deadSteps.length > 0) {
    suggestions.push(`Step(s) reached dead state: ${deadSteps.map(s => s.step_id).join(', ')} — manual review recommended`);
  }
  if (suggestions.length === 0) {
    suggestions.push('Review step artifacts and logs for detailed error information');
  }
  return [...new Set(suggestions)].slice(0, 5);
}

function generatePostmortem(task, artifactStore) {
  const steps = task.steps || [];
  const allErrors = steps
    .filter(s => s.error)
    .map(s => s.error)
    .join('\n');
  const timeline = buildTimeline(steps, artifactStore);
  const errorPatterns = analyzeErrorPatterns(allErrors);
  const rootCause = determineRootCause(timeline, errorPatterns);
  const suggestions = generateSuggestions(rootCause, timeline);
  return {
    generated_at: new Date().toISOString(),
    task_id: task.id,
    task_status: task.status,
    task_blocker: task.blocker || null,
    root_cause: rootCause,
    timeline,
    error_patterns: errorPatterns,
    suggestions,
    summary: buildSummary(rootCause, suggestions),
  };
}

function buildSummary(rootCause, suggestions) {
  if (rootCause.primary === 'unknown') {
    return 'Unable to determine root cause. Manual review of step artifacts recommended.';
  }
  return `Root cause identified as ${rootCause.primary} (${rootCause.confidence} confidence). ${suggestions[0] || 'Review suggestions for remediation steps.'}`;
}

function handlePostmortem(req, res, helpers, deps) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const postmortemMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/postmortem$/);
  if (!postmortemMatch) return false;
  const taskId = decodeURIComponent(postmortemMatch[1]);
  if (req.method === 'GET') {
    try {
      const board = helpers.readBoard();
      const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
      if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
      if (!task.postmortem) return json(res, 404, { error: 'No postmortem available for this task' });
      return json(res, 200, task.postmortem);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }
  if (req.method === 'POST') {
    helpers.parseBody(req).then(body => {
      try {
        const force = body.force === true;
        const board = helpers.readBoard();
        const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
        if (!task) return json(res, 404, { error: `Task ${taskId} not found` });
        if (!force && task.postmortem) {
          return json(res, 200, { ok: true, postmortem: task.postmortem, cached: true });
        }
        const allowedStatuses = ['blocked', 'cancelled', 'approved', 'needs_revision'];
        if (!allowedStatuses.includes(task.status)) {
          return json(res, 400, {
            error: `Postmortem only available for terminal/blocked tasks. Current status: ${task.status}`,
            allowed: allowedStatuses,
          });
        }
        const postmortem = generatePostmortem(task, artifactStore);
        task.postmortem = postmortem;
        helpers.writeBoard(board);
        helpers.appendLog({
          ts: helpers.nowIso(),
          event: 'postmortem_generated',
          taskId,
          root_cause: postmortem.root_cause.primary,
        });
        return json(res, 200, { ok: true, postmortem });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }).catch(e => json(res, 400, { error: e.message }));
    return true;
  }
  return false;
}

module.exports = {
  handlePostmortem,
  generatePostmortem,
  analyzeErrorPatterns,
  buildTimeline,
  determineRootCause,
  generateSuggestions,
  ERROR_PATTERNS,
  SUGGESTIONS,
};
