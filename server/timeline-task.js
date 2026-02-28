/**
 * timeline-task.js — L3 Deep Timeline + Exportable Delivery Report
 *
 * 從 board.json 既有資料組裝任務時間軸，產生 TimelineNode[]。
 * 支援 HTML 報告匯出（@media print → PDF），零外部依賴。
 *
 * 資料來源優先順序：
 * 1. task.history[]    — 永遠可用
 * 2. board.signals[]   — 永遠可用（依 refs 過濾）
 * 3. task.dispatch     — 永遠可用
 * 4. task.review       — 永遠可用
 * 5. board.insights[]  — 演化層啟用時可用
 * 6. board.lessons[]   — 演化層啟用時可用
 * 7. task.digest       — L2 啟用時可用
 * 8. Edda decisions    — 未來：EDDA_CMD 可用時
 *
 * @module timeline-task
 */

// --- ID generator ---

let _idCounter = 0;

/**
 * 產生唯一 timeline node ID。
 * @param {string} prefix - 節點類型前綴
 * @returns {string}
 */
function tlnId(prefix) {
  return `tln-${prefix}-${Date.now().toString(36)}-${(++_idCounter).toString(36)}`;
}

// --- Source mappers ---

/**
 * 從 task.history[] 映射 timeline nodes。
 * @param {object} task
 * @returns {Array} TimelineNode[]
 */
function fromHistory(task) {
  const history = task.history || [];
  return history.map(entry => {
    const type = mapHistoryType(entry);
    const title = buildHistoryTitle(entry);
    const detail = buildHistoryDetail(entry);

    return {
      id: tlnId('h'),
      ts: entry.ts || new Date().toISOString(),
      type,
      title,
      detail: detail || undefined,
      source: 'history',
      refs: {},
      meta: { status: entry.status, by: entry.by, attempt: entry.attempt },
    };
  });
}

/**
 * 從 history entry 判斷 timeline node type。
 * @param {object} entry - HistoryEntry
 * @returns {string} TimelineNodeType
 */
function mapHistoryType(entry) {
  const s = entry.status || '';
  const by = entry.by || '';

  // dispatch 事件
  if ((s === 'in_progress' || s === 'dispatched') && (by.includes('dispatch') || by.includes('auto'))) {
    return 'dispatch';
  }
  // blocked = error
  if (s === 'blocked') return 'error';
  // completed / approved = status
  if (s === 'completed' || s === 'approved') return 'status';
  // reviewing = status
  if (s === 'reviewing' || s === 'needs_revision') return 'status';
  // pending = status
  if (s === 'pending') return 'status';
  // 其他
  return 'note';
}

/**
 * 組裝 history entry 的標題。
 * @param {object} entry
 * @returns {string}
 */
function buildHistoryTitle(entry) {
  const s = entry.status || 'unknown';
  const by = entry.by || '';

  if (s === 'in_progress' && by.includes('dispatch')) {
    const model = entry.model ? ` (model: ${entry.model})` : '';
    return `Dispatched${model}`;
  }
  if (s === 'dispatched') {
    return `Dispatched by ${by}`;
  }
  if (s === 'blocked') {
    return `Blocked: ${entry.reason || entry.message || 'unknown reason'}`;
  }
  if (s === 'completed') {
    const score = entry.score != null ? ` (score: ${entry.score})` : '';
    return `Task completed${score}`;
  }
  if (s === 'approved') {
    return `Task approved`;
  }
  if (s === 'reviewing') {
    return `Review started`;
  }
  if (s === 'needs_revision') {
    return `Needs revision`;
  }
  if (s === 'pending') {
    if (entry.from) return `Status reset: ${entry.from} -> pending`;
    return `Task pending`;
  }

  return `${s} (by ${by})`;
}

/**
 * 組裝 history entry 的詳細描述。
 * @param {object} entry
 * @returns {string|null}
 */
function buildHistoryDetail(entry) {
  const parts = [];
  if (entry.reason) parts.push(`Reason: ${entry.reason}`);
  if (entry.message) parts.push(entry.message);
  if (entry.model) parts.push(`Model: ${entry.model}`);
  if (entry.attempt) parts.push(`Attempt: ${entry.attempt}`);
  if (entry.unblockedBy) parts.push(`Unblocked by: ${entry.unblockedBy}`);
  if (entry.issues?.length) parts.push(`Issues: ${entry.issues.join(', ')}`);
  return parts.length > 0 ? parts.join('\n') : null;
}

// ---

/**
 * 從 board.signals[] 映射 timeline nodes（依 taskId 過濾）。
 * @param {object} board
 * @param {string} taskId
 * @returns {Array} TimelineNode[]
 */
function fromSignals(board, taskId) {
  const signals = (board.signals || []).filter(s => {
    return s.refs && s.refs.includes(taskId);
  });

  return signals.map(signal => {
    const type = mapSignalType(signal.type);
    const title = signal.content || `Signal: ${signal.type}`;

    return {
      id: tlnId('s'),
      ts: signal.ts,
      type,
      title,
      detail: signal.data ? JSON.stringify(signal.data, null, 2) : undefined,
      source: 'signal',
      refs: {},
      meta: { signalId: signal.id, signalType: signal.type, by: signal.by },
    };
  });
}

/**
 * 從 signal type 映射 timeline node type。
 * @param {string} signalType
 * @returns {string}
 */
function mapSignalType(signalType) {
  switch (signalType) {
    case 'status_change': return 'status';
    case 'review_result': return 'review';
    case 'insight_applied': return 'decision';
    case 'insight_rolled_back': return 'supersede';
    case 'lesson_validated': return 'policy';
    case 'error': return 'error';
    default: return 'note';
  }
}

// ---

/**
 * 從 task.dispatch 映射 timeline nodes。
 * @param {object} task
 * @returns {Array} TimelineNode[]
 */
function fromDispatch(task) {
  if (!task.dispatch) return [];

  const d = task.dispatch;
  const nodes = [];

  // dispatch prepared
  if (d.preparedAt) {
    nodes.push({
      id: tlnId('d'),
      ts: d.preparedAt,
      type: 'dispatch',
      title: `Dispatch prepared: ${d.runtime || 'unknown'} runtime`,
      detail: [
        `Agent: ${d.agentId || 'unknown'}`,
        d.model ? `Model: ${d.model}` : null,
        `Timeout: ${d.timeoutSec || '?'}s`,
        d.planId ? `Plan: ${d.planId}` : null,
      ].filter(Boolean).join('\n'),
      source: 'dispatch',
      refs: {},
      meta: { runtime: d.runtime, agentId: d.agentId, model: d.model },
    });
  }

  // dispatch started
  if (d.startedAt) {
    nodes.push({
      id: tlnId('d'),
      ts: d.startedAt,
      type: 'dispatch',
      title: `Agent started execution`,
      detail: d.sessionId ? `Session: ${d.sessionId}` : undefined,
      source: 'dispatch',
      refs: {},
      meta: { sessionId: d.sessionId },
    });
  }

  // dispatch finished
  if (d.finishedAt) {
    const isFail = d.state === 'failed';
    nodes.push({
      id: tlnId('d'),
      ts: d.finishedAt,
      type: isFail ? 'error' : 'status',
      title: isFail ? `Dispatch failed` : `Agent execution finished`,
      detail: d.lastError || undefined,
      source: 'dispatch',
      refs: {},
      meta: { state: d.state },
    });
  }

  return nodes;
}

// ---

/**
 * 從 task.review 映射 timeline nodes。
 * @param {object} task
 * @returns {Array} TimelineNode[]
 */
function fromReview(task) {
  if (!task.review) return [];

  const r = task.review;
  const verdict = r.verdict || (r.score >= (r.threshold || 70) ? 'pass' : 'fail');
  const issueCount = r.issues?.length || 0;

  return [{
    id: tlnId('r'),
    ts: r.reviewedAt || new Date().toISOString(),
    type: 'review',
    title: `Review: ${r.score}/100 — ${verdict}${issueCount > 0 ? `, ${issueCount} issue(s)` : ''}`,
    detail: [
      r.summary || null,
      r.issues?.length ? `Issues:\n${r.issues.map(i => `  - ${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n')}` : null,
      r.report ? `Report: ${r.report.slice(0, 500)}` : null,
    ].filter(Boolean).join('\n\n'),
    source: 'review',
    refs: {},
    meta: { score: r.score, verdict, threshold: r.threshold, attempt: r.attempt },
  }];
}

// ---

/**
 * 從 board.insights[] 映射與 task 相關的 timeline nodes。
 * 透過 signals 的 refs 建立 insight <-> task 關聯。
 * @param {object} board
 * @param {string} taskId
 * @returns {Array} TimelineNode[]
 */
function fromInsights(board, taskId) {
  const insights = board.insights || [];
  if (insights.length === 0) return [];

  // 找出 task 相關的 signal IDs
  const taskSignalIds = new Set(
    (board.signals || [])
      .filter(s => s.refs && s.refs.includes(taskId))
      .map(s => s.id)
  );

  // insight 的 data.signalId 或 data.taskId 關聯到此 task
  const taskInsights = insights.filter(ins => {
    if (ins.data?.taskId === taskId) return true;
    if (ins.data?.signalId && taskSignalIds.has(ins.data.signalId)) return true;
    if (ins.about && ins.about.includes(taskId)) return true;
    return false;
  });

  return taskInsights.map(ins => {
    const type = ins.status === 'rolled_back' ? 'supersede' : 'decision';
    const actionDesc = ins.suggestedAction?.type || 'unknown action';

    return {
      id: tlnId('i'),
      ts: ins.appliedAt || ins.ts,
      type,
      title: type === 'supersede'
        ? `Rolled back: ${ins.judgement?.slice(0, 80) || actionDesc}`
        : `Applied: ${ins.judgement?.slice(0, 80) || actionDesc}`,
      detail: [
        ins.reasoning || null,
        `Action: ${actionDesc}`,
        `Risk: ${ins.risk || 'unknown'}`,
      ].filter(Boolean).join('\n'),
      source: 'insight',
      refs: { insightId: ins.id },
      meta: { status: ins.status, action: ins.suggestedAction },
    };
  });
}

// ---

/**
 * 從 board.lessons[] 映射與 task 相關的 timeline nodes。
 * 透過 fromInsight 鏈回 task-related insights。
 * @param {object} board
 * @param {string} taskId
 * @returns {Array} TimelineNode[]
 */
function fromLessons(board, taskId) {
  const lessons = board.lessons || [];
  if (lessons.length === 0) return [];

  // 先找出 task 相關的 insight IDs
  const taskInsightIds = new Set(
    fromInsights(board, taskId).map(n => n.refs.insightId).filter(Boolean)
  );

  if (taskInsightIds.size === 0) return [];

  // 找出從 task insights 衍生的 lessons
  const taskLessons = lessons.filter(l => taskInsightIds.has(l.fromInsight));

  return taskLessons.map(lesson => {
    const isSuperseded = lesson.status === 'superseded';
    const type = isSuperseded ? 'supersede' : (lesson.status === 'validated' ? 'policy' : 'note');

    return {
      id: tlnId('l'),
      ts: lesson.validatedAt || lesson.ts,
      type,
      title: isSuperseded
        ? `Lesson superseded: ${lesson.rule?.slice(0, 80) || '(no rule)'}`
        : `Lesson: ${lesson.rule?.slice(0, 80) || '(no rule)'}`,
      detail: [
        lesson.effect || null,
        isSuperseded && lesson.supersededBy ? `Superseded by: ${lesson.supersededBy}` : null,
      ].filter(Boolean).join('\n') || undefined,
      source: 'lesson',
      refs: {
        lessonId: lesson.id,
        insightId: lesson.fromInsight,
        supersededBy: lesson.supersededBy || null,
      },
      meta: { status: lesson.status },
    };
  });
}

// --- Deduplication ---

/**
 * 去重：history 和 signals 可能重複記錄同一事件。
 * 以 (ts ±1s, type, 相似 title) 為指紋。
 * Signal 版本優先（資料較豐富）。
 *
 * @param {Array} nodes
 * @returns {Array}
 */
function deduplicateNodes(nodes) {
  const seen = new Map();

  for (const node of nodes) {
    // 建立去重 key：timestamp 取整到秒 + type
    const tsSec = node.ts ? node.ts.slice(0, 19) : '';
    const key = `${tsSec}|${node.type}`;

    if (seen.has(key)) {
      const existing = seen.get(key);
      // 優先保留 signal/insight/lesson（較豐富），覆蓋 history
      if (existing.source === 'history' && node.source !== 'history') {
        seen.set(key, node);
      }
      // 同 source 則保留先出現的
    } else {
      seen.set(key, node);
    }
  }

  return Array.from(seen.values());
}

// --- Duration computation ---

/**
 * 計算任務耗時（分鐘）。
 * 從 dispatch.startedAt（或第一條 history）到 dispatch.finishedAt（或最後一條 history）。
 *
 * @param {object} task
 * @returns {number|null}
 */
function computeDuration(task) {
  let start = null;
  let end = null;

  // 優先使用 dispatch 時間
  if (task.dispatch?.startedAt) {
    start = new Date(task.dispatch.startedAt);
  }
  if (task.dispatch?.finishedAt) {
    end = new Date(task.dispatch.finishedAt);
  }

  // fallback 到 history
  if (!start && task.history?.length) {
    start = new Date(task.history[0].ts);
  }
  if (!end && task.history?.length) {
    end = new Date(task.history[task.history.length - 1].ts);
  }

  if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  const diffMs = end.getTime() - start.getTime();
  if (diffMs <= 0) return null;

  return Math.round(diffMs / 60000);
}

// --- Main assembly ---

/**
 * 從所有資料來源組裝完整 timeline。
 *
 * @param {object} board - board.json 完整物件
 * @param {object} task - 任務物件
 * @returns {Array} TimelineNode[] — 依時間排序
 */
function assembleTimeline(board, task) {
  const nodes = [];

  // Source 1: task.history[] — 永遠可用
  nodes.push(...fromHistory(task));

  // Source 2: board.signals[] — 依 refs 過濾
  nodes.push(...fromSignals(board, task.id));

  // Source 3: task.dispatch metadata
  nodes.push(...fromDispatch(task));

  // Source 4: task.review
  nodes.push(...fromReview(task));

  // Source 5: board.insights[] — 演化層
  nodes.push(...fromInsights(board, task.id));

  // Source 6: board.lessons[] — 演化層
  nodes.push(...fromLessons(board, task.id));

  // 去重
  const deduped = deduplicateNodes(nodes);

  // 依時間排序
  return deduped.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// --- Delivery Report ---

/**
 * 組建 delivery report 資料結構。
 *
 * @param {object} board
 * @param {object} task
 * @returns {object} DeliveryReport
 */
function buildDeliveryReport(board, task) {
  const timeline = assembleTimeline(board, task);
  const durationMin = computeDuration(task);

  return {
    version: 'delivery_report.v1',
    taskId: task.id,
    generatedAt: new Date().toISOString(),
    summary: {
      title: task.title || '(untitled)',
      status: task.status || 'unknown',
      score: task.review?.score ?? null,
      durationMin,
      decisionCount: timeline.filter(n => n.type === 'decision').length,
      supersededCount: timeline.filter(n => n.type === 'supersede').length,
      lessonsApplied: timeline.filter(n => n.type === 'policy').length,
    },
    timeline,
    digest: task.digest || null,
  };
}

// --- HTML Report ---

/**
 * HTML entity escape。
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 格式化 ISO 時間為易讀格式。
 * @param {string} ts - ISO 8601
 * @returns {string}
 */
function fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  } catch {
    return ts;
  }
}

/**
 * Timeline node type 對應的顏色。
 */
const NODE_COLORS = {
  dispatch: '#06b6d4',
  status: '#eab308',
  decision: '#3b82f6',
  supersede: '#f97316',
  policy: '#22c55e',
  review: '#a855f7',
  note: '#9ca3af',
  error: '#ef4444',
};

/**
 * Timeline node type 對應的 emoji（報告用）。
 */
const NODE_ICONS = {
  dispatch: '&#128640;', // rocket
  status: '&#9889;',     // lightning
  decision: '&#128161;', // lightbulb
  supersede: '&#128260;', // cycle arrows
  policy: '&#128220;',   // scroll
  review: '&#128269;',   // magnifying glass
  note: '&#128221;',     // memo
  error: '&#9888;',      // warning
};

/**
 * 產生自包含 HTML 報告字串。
 * 含嵌入 CSS、@media print 樣式、Print to PDF 按鈕。
 *
 * @param {object} report - DeliveryReport
 * @returns {string} HTML string
 */
function renderReportHTML(report) {
  const s = report.summary;
  const timeline = report.timeline || [];

  const timelineHtml = timeline.map(node => {
    const color = NODE_COLORS[node.type] || '#9ca3af';
    const icon = NODE_ICONS[node.type] || '&#9679;';
    const isSupersede = node.type === 'supersede';
    const titleStyle = isSupersede ? 'text-decoration: line-through; opacity: 0.7;' : '';

    return `
      <div class="tln" style="border-left-color: ${color};">
        <div class="tln-dot" style="background: ${color};">${icon}</div>
        <div class="tln-content">
          <div class="tln-time">${escHtml(fmtTime(node.ts))}</div>
          <div class="tln-type" style="color: ${color};">${escHtml(node.type).toUpperCase()}</div>
          <div class="tln-title" style="${titleStyle}">${escHtml(node.title)}</div>
          ${node.detail ? `<div class="tln-detail"><pre>${escHtml(node.detail)}</pre></div>` : ''}
        </div>
      </div>`;
  }).join('\n');

  // L2 digest section
  let digestHtml = '';
  if (report.digest) {
    const d = report.digest;
    digestHtml = `
    <div class="section">
      <h2>L2 Digest</h2>
      ${d.one_liner ? `<p class="digest-one-liner">${escHtml(d.one_liner)}</p>` : ''}
      ${d.risk ? `<p>Risk: <span class="risk-${escHtml(d.risk.level || 'unknown')}">${escHtml(d.risk.level || 'unknown')}</span></p>` : ''}
      ${d.bullets?.what?.length ? `
        <h3>What</h3>
        <ul>${d.bullets.what.map(b => `<li>${escHtml(b)}</li>`).join('')}</ul>
      ` : ''}
      ${d.bullets?.why?.length ? `
        <h3>Why</h3>
        <ul>${d.bullets.why.map(b => `<li>${escHtml(b)}</li>`).join('')}</ul>
      ` : ''}
      ${d.bullets?.risk?.length ? `
        <h3>Risk Assessment</h3>
        <ul>${d.bullets.risk.map(b => `<li>${escHtml(b)}</li>`).join('')}</ul>
      ` : ''}
      ${d.warnings?.length ? `
        <h3>Warnings</h3>
        <ul>${d.warnings.map(w => `<li><strong>${escHtml(w.code)}</strong>: ${escHtml(w.text)}</li>`).join('')}</ul>
      ` : ''}
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Delivery Report — ${escHtml(s.title)} (${escHtml(report.taskId)})</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1923;
      color: #e0e0e0;
      margin: 0;
      padding: 24px;
      line-height: 1.6;
    }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: #7aa2f7; margin-bottom: 4px; font-size: 24px; }
    h2 { color: #7aa2f7; border-bottom: 1px solid #2a3862; padding-bottom: 8px; margin-top: 32px; }
    h3 { color: #a9b1d6; margin-top: 16px; font-size: 14px; }
    .subtitle { color: #9ca3af; font-size: 14px; margin-bottom: 24px; }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin: 16px 0 32px 0;
    }
    .summary-card {
      background: #1a2332;
      border: 1px solid #2a3862;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .summary-card .label { color: #9ca3af; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    .summary-card .value { font-size: 24px; font-weight: 700; color: #e0e0e0; margin-top: 4px; }
    .summary-card .value.score { color: #22c55e; }
    .summary-card .value.warn { color: #f97316; }

    .tln {
      position: relative;
      border-left: 3px solid #4a5568;
      padding: 12px 0 12px 24px;
      margin-left: 16px;
    }
    .tln-dot {
      position: absolute;
      left: -12px;
      top: 14px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      background: #4a5568;
      color: #fff;
    }
    .tln-content { }
    .tln-time { color: #6b7280; font-size: 11px; }
    .tln-type { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; margin: 2px 0; }
    .tln-title { font-weight: 600; font-size: 14px; }
    .tln-detail {
      color: #9ca3af;
      font-size: 12px;
      margin-top: 4px;
      background: #1a2332;
      border-radius: 4px;
      padding: 8px;
    }
    .tln-detail pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: inherit; }

    .digest-one-liner { font-size: 18px; font-weight: 600; color: #a9b1d6; }
    .risk-low { color: #22c55e; }
    .risk-medium { color: #eab308; }
    .risk-high { color: #ef4444; }
    .risk-unknown { color: #9ca3af; }

    ul { padding-left: 20px; }
    li { margin-bottom: 4px; }

    .print-bar {
      text-align: right;
      margin-bottom: 16px;
    }
    .print-btn {
      background: #7aa2f7;
      color: #0f1923;
      border: none;
      padding: 8px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
    }
    .print-btn:hover { background: #89b4fa; }

    .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #2a3862; color: #6b7280; font-size: 12px; }

    /* --- Print styles --- */
    @media print {
      body { background: #fff; color: #000; padding: 16px; }
      h1 { color: #1a365d; }
      h2 { color: #1a365d; border-bottom-color: #ccc; }
      h3 { color: #374151; }
      .subtitle { color: #6b7280; }
      .summary-card { background: #f9fafb; border-color: #d1d5db; }
      .summary-card .label { color: #6b7280; }
      .summary-card .value { color: #111827; }
      .summary-card .value.score { color: #166534; }
      .summary-card .value.warn { color: #c2410c; }
      .tln { border-left-color: #d1d5db; }
      .tln-detail { background: #f9fafb; }
      .tln-title { color: #111827; }
      .tln-time { color: #6b7280; }
      .print-bar { display: none; }
      .digest-one-liner { color: #374151; }
      .risk-low { color: #166534; }
      .risk-medium { color: #a16207; }
      .risk-high { color: #dc2626; }
      .footer { color: #9ca3af; border-top-color: #d1d5db; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="print-bar">
      <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    </div>

    <h1>${escHtml(s.title)}</h1>
    <div class="subtitle">
      Task ${escHtml(report.taskId)} &mdash; Generated: ${escHtml(fmtTime(report.generatedAt))}
    </div>

    <div class="section">
      <h2>Summary</h2>
      <div class="summary-grid">
        <div class="summary-card">
          <div class="label">Status</div>
          <div class="value">${escHtml(s.status)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Score</div>
          <div class="value ${s.score != null && s.score >= 70 ? 'score' : 'warn'}">${s.score != null ? s.score : 'N/A'}</div>
        </div>
        <div class="summary-card">
          <div class="label">Duration</div>
          <div class="value">${s.durationMin != null ? s.durationMin + ' min' : 'N/A'}</div>
        </div>
        <div class="summary-card">
          <div class="label">Decisions</div>
          <div class="value">${s.decisionCount}</div>
        </div>
        <div class="summary-card">
          <div class="label">Superseded</div>
          <div class="value ${s.supersededCount > 0 ? 'warn' : ''}">${s.supersededCount}</div>
        </div>
        <div class="summary-card">
          <div class="label">Lessons</div>
          <div class="value">${s.lessonsApplied}</div>
        </div>
      </div>
    </div>

    ${digestHtml}

    <div class="section">
      <h2>Timeline (${timeline.length} events)</h2>
      ${timeline.length === 0
        ? '<p style="color: #9ca3af;">No timeline events recorded.</p>'
        : timelineHtml}
    </div>

    <div class="footer">
      Karvi Task Engine &mdash; L3 Delivery Report v1 &mdash; ${escHtml(fmtTime(report.generatedAt))}
    </div>
  </div>

  <script>
    // Auto-print when ?print=1 parameter present
    if (new URLSearchParams(window.location.search).get('print') === '1') {
      window.addEventListener('load', () => setTimeout(() => window.print(), 500));
    }
  </script>
</body>
</html>`;
}

// --- Exports ---

module.exports = {
  assembleTimeline,
  buildDeliveryReport,
  renderReportHTML,
  // Exposed for testing
  _internal: {
    fromHistory,
    fromSignals,
    fromDispatch,
    fromReview,
    fromInsights,
    fromLessons,
    deduplicateNodes,
    computeDuration,
    mapHistoryType,
    mapSignalType,
    escHtml,
    fmtTime,
    NODE_COLORS,
  },
};
