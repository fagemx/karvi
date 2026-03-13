/**
 * webhook-emitter.js — Webhook event emission (#333/#443/#444/#447)
 *
 * Thyra-aligned envelope format + exponential backoff retry.
 * Extracted from step-worker.js (issue #473) for SRP compliance.
 * Retry logic added per issue #447: 3 attempts, 1s/5s backoff, dead-letter log.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mgmt = require('./management');
const { createSignal } = require('./signal');

// Map internal signal types to Thyra event_type values
function mapEventType(type) {
  if (type === 'step_succeeded' || type === 'step_failed' || type === 'step_dead') return 'step_completed';
  return type; // step_started, step_cancelled pass through
}

// Map internal step state to Thyra state values
function mapState(state) {
  if (state === 'succeeded') return 'done';
  if (state === 'dead') return 'failed';
  return state; // 'failed', 'cancelled' 保持不變
}

// Compute 0-based step index from task's steps array
function computeStepIndex(board, taskId, stepId) {
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  const idx = (task?.steps || []).findIndex(s => s.step_id === stepId);
  return idx >= 0 ? idx : -1;
}

const WEBHOOK_MAX_RETRIES = 3;
const WEBHOOK_BACKOFF_MS = [1000, 5000]; // 首次失敗等 1s，二次失敗等 5s (#447)

function emitWebhookEvent(board, eventType, payload, helpers = null) {
  const url = mgmt.getControls(board).event_webhook_url;
  if (!url) return;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    console.error(`[webhook] malformed URL, skipping ${eventType}:`, err.message);
    return;
  }

  const now = new Date().toISOString();
  // 巢狀 payload，snake_case 欄位名，符合 Thyra KarviWebhookPayloadSchema
  const nestedPayload = {
    task_id: payload.taskId,
    step_id: payload.stepId,
    step_index: computeStepIndex(board, payload.taskId, payload.stepId),
  };
  // Default state for step_started (call site omits state)
  const rawState = payload.state || (eventType === 'step_started' ? 'running' : undefined);
  if (rawState) nestedPayload.state = mapState(rawState);
  if (payload.stepType) nestedPayload.step_type = payload.stepType;
  if (payload.error) nestedPayload.error = payload.error;

  const envelope = {
    event_type: mapEventType(eventType),
    event_id: `evt_${crypto.randomUUID()}`,
    timestamp: now,
    version: 'karvi.event.v1',
    payload: nestedPayload,
    // Deprecated compat fields — will be removed in v2
    occurred_at: now,
    ts: now,
    event: eventType,
  };
  const body = JSON.stringify(envelope);
  const mod = parsed.protocol === 'https:' ? require('https') : require('http');

  // Non-blocking async retry loop
  (async () => {
    let lastError = null;
    for (let attempt = 0; attempt < WEBHOOK_MAX_RETRIES; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const req = mod.request(parsed, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              'X-Event-Id': envelope.event_id, // 冪等性 key，讓 Thyra 端可以 dedup (#447)
            },
            timeout: 5000,
          }, (res) => {
            res.resume(); // drain response body to free socket
            if (res.statusCode >= 500) {
              reject(new Error(`HTTP ${res.statusCode}`));
            } else if (res.statusCode >= 400) {
              console.error(`[webhook] ${eventType} POST failed: HTTP ${res.statusCode} (not retrying)`);
              resolve({ ok: false, retryable: false });
            } else {
              resolve({ ok: true });
            }
          });
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
          });
          req.end(body);
        });

        if (result.ok) return; // Success
        if (!result.retryable) return; // 4xx, stop retrying
      } catch (err) {
        lastError = err;
        if (attempt < WEBHOOK_MAX_RETRIES - 1) {
          const delay = WEBHOOK_BACKOFF_MS[attempt];
          console.error(`[webhook] ${eventType} attempt ${attempt + 1}/${WEBHOOK_MAX_RETRIES} failed: ${err.message}, retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // Total failure after all retries
    console.error(`[webhook] ${eventType} POST failed after ${WEBHOOK_MAX_RETRIES} retries:`, lastError?.message || 'unknown error');

    // Dead letter log — append-only JSONL 記錄，不會丟失 (#447)
    const deadLetterEntry = {
      ts: new Date().toISOString(),
      event_id: envelope.event_id,
      event_type: eventType,
      url,
      error: lastError?.message || 'unknown error',
      attempts: WEBHOOK_MAX_RETRIES,
      payload: nestedPayload,
    };
    try {
      const dlPath = helpers?.dataDir
        ? path.join(helpers.dataDir, 'webhook-dead-letter.jsonl')
        : path.join(__dirname, '..', 'data', 'webhook-dead-letter.jsonl');
      fs.appendFileSync(dlPath, JSON.stringify(deadLetterEntry) + '\n');
    } catch (dlErr) {
      console.error(`[webhook] failed to write dead letter:`, dlErr.message);
    }

    // Write signal to board if helpers available
    if (helpers && helpers.readBoard && helpers.writeBoard) {
      try {
        const failBoard = helpers.readBoard();
        failBoard.signals = failBoard.signals || [];
        failBoard.signals.push(createSignal({
          by: 'webhook',
          type: 'webhook_delivery_failed',
          content: `Webhook delivery failed for ${eventType}: ${lastError?.message || 'unknown error'}`,
          refs: payload.taskId ? [payload.taskId] : [],
          data: { event_type: eventType, error: lastError?.message, attempts: WEBHOOK_MAX_RETRIES },
        }, helpers));
        mgmt.trimSignals(failBoard, helpers.signalArchivePath);
        helpers.writeBoard(failBoard);
      } catch (signalErr) {
        console.error(`[webhook] failed to write failure signal:`, signalErr.message);
      }
    }
  })();
}

module.exports = { emitWebhookEvent, mapEventType, mapState, computeStepIndex };
