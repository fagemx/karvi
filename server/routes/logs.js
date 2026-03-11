/**
 * routes/logs.js — Audit Log Query API
 *
 * GET /api/logs — 結構化查詢 task-log.jsonl
 *
 * 查詢參數:
 *   taskId  — 過濾 taskId（精確匹配 entry.taskId 或 entry.data.taskId）
 *   event   — 過濾事件類型（精確匹配 entry.event）
 *   user    — 過濾使用者（精確匹配 entry.user）
 *   from    — 起始時間 ISO string（>=）
 *   to      — 結束時間 ISO string（<=）
 *   limit   — 每頁筆數，預設 100，上限 1000
 *   offset  — 跳過筆數，預設 0
 *   sort    — asc|desc，預設 desc
 *   format  — json|jsonl，預設 json
 */
const fs = require('fs');
const bb = require('../blackboard-server');
const { json } = bb;

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

function readLogEntries(logPath) {
  // NOTE: reads entire file into memory — adequate for single-server JSON file storage.
  // If task-log.jsonl grows beyond ~100 MB, switch to streaming (readline) or pagination at the FS layer.
  const raw = fs.readFileSync(logPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (err) {
      console.warn(`[logs] skipping unparseable JSONL line: ${err.message}`);
    }
  }
  return entries;
}

function matchEntry(entry, filters) {
  if (filters.taskId) {
    const entryTaskId = entry.taskId || entry.data?.taskId || null;
    if (entryTaskId !== filters.taskId) return false;
  }
  if (filters.event && entry.event !== filters.event) return false;
  if (filters.user && entry.user !== filters.user) return false;
  if (filters.from && entry.ts < filters.from) return false;
  if (filters.to && entry.ts > filters.to) return false;
  return true;
}

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

  const allEntries = readLogEntries(deps.ctx.logPath);
  const filtered = allEntries.filter(e => matchEntry(e, filters));

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

  return json(res, 200, { total, limit, offset, entries });
};
