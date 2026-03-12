/**
 * routes/jira.js — Jira Integration Routes
 *
 * POST /api/webhooks/jira — receive Jira webhook (issue_created, issue_updated, comment_created)
 * GET  /api/integrations/jira — read Jira config
 * POST /api/integrations/jira — update Jira config
 * POST /api/integrations/jira/test — test Jira connection
 */
const bb = require('../blackboard-server');
const { json } = bb;
const { pushMessage, requireRole, createSignal } = require('./_shared');

module.exports = function jiraRoutes(req, res, helpers, deps) {
  const { jiraIntegration, mgmt, push, ctx, PUSH_TOKENS_PATH, vault } = deps;

  // POST /api/webhooks/jira — receive Jira webhook
  if (req.method === 'POST' && req.url.startsWith('/api/webhooks/jira')) {
    if (!jiraIntegration) { json(res, 404, { error: 'Jira integration not available' }); return; }

    // Manual body read with size guard (needs raw string for HMAC verification)
    let body = '';
    let received = 0;
    req.on('data', c => {
      received += c.length;
      if (received > 1048576) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      if (received > 1048576) return json(res, 413, { error: 'Payload too large' });
      try {
        // HMAC verification — secret from vault, not board
        const secretBuf = vault && vault.has('default', 'jira_webhook_secret')
          ? vault.retrieve('default', 'jira_webhook_secret')
          : null;
        const secret = secretBuf ? secretBuf.toString('utf8') : null;
        if (secretBuf) secretBuf.fill(0);

        const sig = req.headers['x-hub-signature-256'] || req.headers['x-jira-signature'] || '';
        if (!jiraIntegration.verifyHmacSignature(body, sig, secret)) {
          // Fallback: try URL token verification for backward compat
          if (!jiraIntegration.verifyWebhookToken(req.url)) {
            json(res, 401, { error: 'Invalid webhook signature or token' });
            return;
          }
        }

        const payload = JSON.parse(body || '{}');
        const board = helpers.readBoard();
        const config = board.integrations?.jira || { enabled: false };

        // Route by Jira webhook event type
        const webhookEvent = payload.webhookEvent;

        // --- comment_created events: @karvi mention triggers ---
        if (webhookEvent === 'comment_created') {
          const result = jiraIntegration.handleMentionWebhook(board, payload, config);

          if (result.action === 'skipped') {
            json(res, 200, { ok: true, skipped: true, reason: result.error });
            return;
          }

          // Helper: reply on Jira issue via API
          const replyOnIssue = (issueKey, commentBody) => {
            jiraIntegration.jiraRequest('POST', `/rest/api/3/issue/${issueKey}/comment`, {
              body: { type: 'doc', version: 1, content: [
                { type: 'paragraph', content: [{ type: 'text', text: commentBody }] },
              ]},
            }).catch(err => console.error('[jira-webhook] reply failed:', err.message));
          };

          if (result.action === 'status_reply') {
            const t = result.existingTask;
            const replyBody = t
              ? `Task **${t.id}** is currently **${t.status}**.`
              : `No task found for this issue.`;
            replyOnIssue(result.issueKey, replyBody);
            json(res, 200, { ok: true, action: 'status_reply', taskId: t?.id || null, status: t?.status || null });
            return;
          }

          if (result.action === 'already_exists') {
            const t = result.existingTask;
            const replyBody = `Task **${t.id}** already exists (status: **${t.status}**).`;
            replyOnIssue(result.issueKey, replyBody);
            json(res, 200, { ok: true, action: 'already_exists', taskId: t.id, status: t.status });
            return;
          }

          if (result.action === 'create_task' && result.task) {
            board.taskPlan = board.taskPlan || { tasks: [] };
            board.taskPlan.tasks = board.taskPlan.tasks || [];
            board.taskPlan.tasks.push(result.task);

            // Emit signal before writeBoard so both task + signal are persisted atomically
            mgmt.ensureEvolutionFields(board);
            board.signals.push(createSignal({
              by: 'jira-mention', type: 'mention_task_created',
              content: `@karvi mention → ${result.task.id} created from Jira ${result.issueKey}`,
              refs: [result.task.id],
              data: { taskId: result.task.id, jiraKey: result.issueKey, command: result.command },
            }, req, helpers));
            mgmt.trimSignals(board, helpers.signalArchivePath);
            helpers.writeBoard(board);

            helpers.appendLog({
              ts: helpers.nowIso(),
              event: 'jira_mention_task_created',
              taskId: result.task.id,
              jiraKey: result.issueKey,
              command: result.command,
              source: 'jira-mention',
            });

            // Auto-dispatch via step pipeline
            const willDispatch = result.task.status === 'dispatched' && deps.tryAutoDispatch;
            if (willDispatch) {
              setImmediate(() => deps.tryAutoDispatch(result.task.id));
            }

            // Reply on Jira issue — reflect actual dispatch state
            const replyBody = willDispatch
              ? `Task **${result.task.id}** created and dispatched.`
              : `Task **${result.task.id}** created (status: ${result.task.status}).`;
            replyOnIssue(result.issueKey, replyBody);

            json(res, 201, { ok: true, action: 'create_task', taskId: result.task.id, jiraKey: result.issueKey });
            return;
          }

          json(res, 200, { ok: true, action: result.action });
          return;
        }

        // --- issue_created / issue_updated events: existing behavior ---
        const result = jiraIntegration.handleWebhook(board, payload);

        if (result.action === 'rejected') {
          json(res, 401, { error: result.error });
          return;
        }
        if (result.action === 'skipped') {
          json(res, 200, { ok: true, skipped: true, reason: result.error });
          return;
        }

        // --- Handle create_task: append new task from Jira issue_created ---
        if (result.action === 'create_task' && result.task) {
          board.taskPlan = board.taskPlan || { tasks: [] };
          board.taskPlan.tasks = board.taskPlan.tasks || [];
          board.taskPlan.tasks.push(result.task);
          helpers.writeBoard(board);
          helpers.appendLog({ ts: helpers.nowIso(), event: 'jira_task_created', taskId: result.task.id, jiraKey: result.issueKey, source: 'jira-webhook' });

          // Global auto-dispatch (replaces Jira-specific autoDispatchOnCreate)
          if (result.task.status === 'dispatched') {
            setImmediate(() => deps.tryAutoDispatch(result.task.id));
          }

          // Legacy: Jira-specific auto-dispatch via HTTP loopback (kept for backward compat when global auto_dispatch is off)
          const jiraConfig = board.integrations?.jira || {};
          if (jiraConfig.autoDispatchOnCreate && !mgmt.getControls(board).auto_dispatch) {
            const taskId = result.task.id;
            setImmediate(() => {
              const http = require('http');
              const authToken = process.env.KARVI_API_TOKEN;
              const headers = {};
              if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
              const dreq = http.request({
                hostname: 'localhost',
                port: ctx.port,
                path: `/api/tasks/${encodeURIComponent(taskId)}/dispatch`,
                method: 'POST',
                headers,
              });
              dreq.on('error', err => console.error(`[jira-webhook] auto-dispatch failed for ${taskId}:`, err.message));
              dreq.end();
            });
          }

          json(res, 201, { ok: true, action: 'create_task', taskId: result.task.id, jiraKey: result.issueKey });
          return;
        }

        // --- Handle fields_updated: sync field changes from Jira (issue #51) ---
        if (result.action === 'fields_updated' && result.task) {
          const task = result.task;

          // Apply field updates
          if (result.updatedFields.title) task.title = result.updatedFields.title;
          if (result.updatedFields.description !== undefined) task.description = result.updatedFields.description;
          if (result.updatedFields.priority) task.priority = result.updatedFields.priority;

          // Append custom AC fields to description if present
          if (result.updatedFields.acFields) {
            const acLines = Object.entries(result.updatedFields.acFields)
              .map(([label, value]) => `\n\n--- ${label} ---\n${value}`)
              .join('');
            task.description = (task.description || '') + acLines;
          }

          // Store change hash for dedup
          task._lastChangeHash = result.changeHash;

          // Record in history
          task.history = task.history || [];
          task.history.push({
            ts: helpers.nowIso(),
            event: 'fields_updated',
            by: 'jira-webhook',
            changes: result.changes.map(c => ({
              field: c.field,
              label: c.label,
              from: (c.fromValue || '').slice(0, 200),
              to: (c.toValue || '').slice(0, 200),
            })),
            changeHash: result.changeHash,
          });

          helpers.appendLog({
            ts: helpers.nowIso(),
            event: 'jira_fields_updated',
            taskId: task.id,
            jiraKey: result.issueKey,
            fields: result.changes.map(c => c.field),
            source: 'jira-webhook',
          });

          // SSE: broadcast dedicated event for in-progress tasks
          if (task.status === 'in_progress' || task.status === 'dispatched') {
            helpers.broadcastSSE('task.ac_changed', {
              taskId: task.id,
              changes: result.changes,
              priorityEscalated: result.priorityEscalated || false,
              needsReplan: result.priorityEscalated || false,
            });
          }

          // Push notification for in-progress tasks
          if (push && PUSH_TOKENS_PATH && (task.status === 'in_progress' || task.status === 'dispatched')) {
            push.notifyTaskEvent(PUSH_TOKENS_PATH, task, 'task.ac_changed')
              .catch(err => console.error('[push] ac_changed notify failed:', err.message));
          }

          // If status also changed in same webhook, process it too
          const warnings = [];
          if (result.statusChange?.newStatus) {
            const karviStatus = result.statusChange.newStatus;
            if (karviStatus) {
              try {
                mgmt.ensureTaskTransition(task.status, karviStatus);
                task.status = karviStatus;
                task.history.push({ ts: helpers.nowIso(), status: karviStatus, by: 'jira-webhook' });
              } catch (err) {
                // Field updates still applied, but surface the error to the caller
                console.error(`[jira] Status transition failed alongside field update: ${err.message}`);
                warnings.push(`Status transition to '${karviStatus}' failed: ${err.message}`);
              }
            }
          }

          // Single writeBoard after all mutations (fields + status) are done
          helpers.writeBoard(board);

          const response = {
            ok: true,
            action: 'fields_updated',
            taskId: task.id,
            jiraKey: result.issueKey,
            fieldsChanged: result.changes.map(c => c.field),
            priorityEscalated: result.priorityEscalated || false,
          };
          if (warnings.length) response.warnings = warnings;

          json(res, 200, response);
          return;
        }

        if (result.action === 'dispatch' && result.task) {
          result.task.status = 'dispatched';
          result.task.history = result.task.history || [];
          result.task.history.push({ ts: helpers.nowIso(), status: 'dispatched', by: 'jira-webhook' });
          helpers.writeBoard(board);

          // Auto-trigger dispatch via internal HTTP call to reuse existing dispatch logic
          const taskId = result.task.id;
          setImmediate(() => {
            const http = require('http');
            const authToken = process.env.KARVI_API_TOKEN;
            const headers = {};
            if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
            const dreq = http.request({
              hostname: 'localhost',
              port: ctx.port,
              path: `/api/tasks/${encodeURIComponent(taskId)}/dispatch`,
              method: 'POST',
              headers,
            });
            dreq.on('error', err => console.error(`[jira-webhook] auto-dispatch failed for ${taskId}:`, err.message));
            dreq.end();
          });

          json(res, 200, { ok: true, action: 'dispatch', taskId: result.task.id });
          return;
        }
        if (result.action === 'status_change' && result.task && result.karviStatus) {
          const oldStatus = result.task.status;
          try {
            mgmt.ensureTaskTransition(oldStatus, result.karviStatus);
          } catch (err) {
            json(res, 409, { error: err.message });
            return;
          }
          result.task.status = result.karviStatus;
          result.task.history = result.task.history || [];
          result.task.history.push({ ts: helpers.nowIso(), status: result.karviStatus, by: 'jira-webhook', from: oldStatus });
          helpers.writeBoard(board);
          json(res, 200, { ok: true, action: 'status_change', taskId: result.task.id, newStatus: result.karviStatus });
          return;
        }
        json(res, 200, { ok: true, action: result.action });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/integrations/jira — read Jira config
  if (req.method === 'GET' && req.url === '/api/integrations/jira') {
    const board = helpers.readBoard();
    const config = board.integrations?.jira || { enabled: false };
    json(res, 200, config);
    return;
  }

  // POST /api/integrations/jira — update Jira config
  if (req.method === 'POST' && req.url === '/api/integrations/jira') {
    if (requireRole(req, res, 'admin')) return;
    helpers.parseBody(req).then(payload => {
      const board = helpers.readBoard();
      board.integrations = board.integrations || {};
      board.integrations.jira = { ...(board.integrations.jira || {}), ...payload };
      helpers.writeBoard(board);
      json(res, 200, board.integrations.jira);
    }).catch(err => json(res, err.statusCode === 413 ? 413 : 400, { error: err.message }));
    return;
  }

  // POST /api/integrations/jira/test — test Jira connection
  if (req.method === 'POST' && req.url === '/api/integrations/jira/test') {
    if (!jiraIntegration) { json(res, 404, { error: 'Jira integration not available' }); return; }
    jiraIntegration.testConnection().then(result => {
      json(res, result.ok ? 200 : 502, result);
    }).catch(err => {
      json(res, 500, { ok: false, error: err.message });
    });
    return;
  }

  return false;
};
