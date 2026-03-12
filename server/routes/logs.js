/**
 * routes/logs.js — Audit Log Query API
 *
 * GET /api/logs — 結構化查詢 task-log.jsonl（透過 storage layer stream 逐行讀取）
 *
 * 查詢參數:
 *   taskId  — 過濾 taskId（精確匹配 entry.taskId 或 entry.data.taskId）
 *   event   — 過濾事件類型（精確匹配 entry.event）
 *   user    — 過濾使用者（精確匹配 entry.user）
 *   from    — 起始時間 ISO string（>=）
 *   to      — 結束時間 ISO string（<=）
 *   limit   — 每頁筆數，預設 5000，上限 10000
 *   offset  — 跳過筆數，預設 0
 *   sort    — asc|desc，預設 desc
 *   format  — json|jsonl，預設 json
 */
const bb = require('../blackboard-server');
const storage = require('../storage');
const { json } = bb;

const MAX_LIMIT = 10000;
const DEFAULT_LIMIT = 5000;

module.exports = function logsRoutes(req, res, helpers, deps) {
  if (req.method !== 'GET') return false;

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/logs') return false;

  const taskId = url.searchParams.get('taskId') || null;
  const event = url.searchParams.get('event') || null;
  const user = url.searchParams.get('user') || null;
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  const sort = url.searchParams.get('sort') === 'asc' ? 'asc' : 'desc';
  const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'json';

  let limit = parseInt(url.searchParams.get('limit'), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  let offset = parseInt(url.searchParams.get('offset'), 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const filters = { taskId, event, user, from, to };

  // 透過 storage layer 非同步 stream 讀取
  storage.readLogEntries(deps.ctx.logPath, filters).then((filtered) => {
    // 排序
    filtered.sort((a, b) => {
      const cmp = (a.ts || '').localeCompare(b.ts || '');
      return sort === 'asc' ? cmp : -cmp;
    });

    const total = filtered.length;
    const entries = filtered.slice(offset, offset + limit);

    if (format === 'jsonl') {
      const body = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.end(body);
      return;
    }

    json(res, 200, { total, limit, offset, entries });
  }).catch((err) => {
    console.error('[logs] failed to read log file:', err.message);
    json(res, 500, { error: 'failed to read log file' });
  });

  return true; // 告訴 router 此 route 已接管 response（非同步）
};
