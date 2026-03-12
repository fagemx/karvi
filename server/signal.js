/**
 * signal.js — 統一 signal 建構函式
 *
 * 所有 board.signals.push() 都應使用此函式，
 * 確保 signal schema 一致。非 HTTP context（kernel、step-worker）
 * 不需傳 req，直接在 opts.by 指定來源。
 */

/**
 * Create a signal object.
 *
 * @param {object} opts - Signal options
 * @param {string} opts.type - Signal type (e.g., 'status_change', 'step_completed')
 * @param {string} opts.content - Human-readable content
 * @param {string[]} [opts.refs] - References (e.g., task IDs)
 * @param {object} [opts.data] - Additional data
 * @param {string} [opts.by] - Actor identifier (e.g., 'kernel', 'step-worker', 'api')
 * @param {object} helpers - Helper functions with uid() and nowIso()
 * @param {object} [req] - Optional HTTP request for user attribution
 * @returns {object} Signal object ready to push to board.signals
 */
function createSignal(opts, helpers, req) {
  const { type, content, refs = [], data = {}, by } = opts;
  const actor = req?.karviUser || null;
  const role = req?.karviRole || null;

  return {
    id: helpers.uid('sig'),
    ts: helpers.nowIso(),
    by: actor || by || 'api',
    type,
    content,
    refs,
    data: {
      ...data,
      _attribution: actor ? { actor, role } : undefined,
    },
  };
}

module.exports = { createSignal };
