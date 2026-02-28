/**
 * confidence-engine.js — L1 Confidence Signal Computation (#52)
 *
 * 任務完成後計算 6 維信心燈號，純數值/規則運算，不需要 LLM。
 * 模式參考 digest-task.js — 獨立模組、注入依賴、同步觸發。
 *
 * 6 維信號:
 *   tests        — 測試結果 (review issues 關鍵字)
 *   quality      — 審查分數 (review.score)
 *   scope        — 變更範圍 (diff files/lines)
 *   requirements — AC 達成度 (description checkbox)
 *   preflight    — lessons/policy 命中 (management.matchLessonsForTask)
 *   agent        — agent 歷史成功率 (signals review_result)
 *
 * 零外部依賴 — 僅使用 Node.js 內建模組。
 *
 * @module confidence-engine
 */

const mgmt = require('./management');

// --- Constants ---

const SIGNAL_KEYS = ['tests', 'quality', 'scope', 'requirements', 'preflight', 'agent'];

// Thresholds
const QUALITY_GREEN = 70;
const QUALITY_YELLOW = 50;
const SCOPE_GREEN_FILES = 5;
const SCOPE_YELLOW_FILES = 15;
const AGENT_GREEN_RATE = 80;
const AGENT_YELLOW_RATE = 50;
const AGENT_MIN_REVIEWS = 3;
const MAX_WARNINGS = 3;

// --- Individual Signal Computers ---

/**
 * tests 信號: 從 review issues 中偵測測試相關關鍵字。
 * @param {object} task
 * @returns {{ key: string, state: string, label: string } | null}
 */
function computeTestsSignal(task) {
  const review = task.review;
  if (!review) return null;

  const issues = review.issues || [];
  const issueText = issues.map(i => typeof i === 'string' ? i : JSON.stringify(i)).join(' ');

  // Check for test failures
  if (/test.*fail|fail.*test|tests?\s+failed/i.test(issueText)) {
    return { key: 'tests', state: 'red', label: 'Tests fail' };
  }

  // Check for flaky tests
  if (/flaky|intermittent/i.test(issueText)) {
    return { key: 'tests', state: 'yellow', label: 'Flaky tests' };
  }

  // Deterministic-only review with high score = green
  if (review.source === 'deterministic-only' && (review.score || 0) >= 90) {
    return { key: 'tests', state: 'green', label: 'Checks pass' };
  }

  // Review exists with no test issues
  if (review.score != null) {
    return { key: 'tests', state: 'green', label: 'No test issues' };
  }

  return null;
}

/**
 * quality 信號: 直接映射 review.score。
 * @param {object} task
 * @returns {{ key: string, state: string, label: string } | null}
 */
function computeQualitySignal(task) {
  const score = task.review?.score;
  if (score == null) return null;

  if (score >= QUALITY_GREEN) {
    return { key: 'quality', state: 'green', label: `${score}/100` };
  }
  if (score >= QUALITY_YELLOW) {
    return { key: 'quality', state: 'yellow', label: `${score}/100` };
  }
  return { key: 'quality', state: 'red', label: `${score}/100` };
}

/**
 * scope 信號: 從 lastReply 或 review.report 解析檔案數/行數。
 * @param {object} task
 * @returns {{ key: string, state: string, label: string } | null}
 */
function computeScopeSignal(task) {
  // Multi-source extraction with fallback chain
  const sources = [
    task.lastReply || '',
    task.review?.report || '',
    (task.review?.issues || []).join(' '),
  ];

  let files = null;
  let lines = null;

  for (const src of sources) {
    if (files !== null) break;

    // Try to extract file count
    const fileMatch = src.match(/(\d+)\s*(?:files?|檔案)\s*(?:changed|modified|created|affected|touched)?/i);
    if (fileMatch) {
      files = parseInt(fileMatch[1], 10);
    }

    // Try to extract line count
    const lineMatch = src.match(/[+](\d+)\s*(?:lines?|行)/i);
    if (lineMatch) {
      lines = parseInt(lineMatch[1], 10);
    }
  }

  if (files === null) return null;

  const label = lines != null ? `${files} files +${lines}` : `${files} files`;

  if (files <= SCOPE_GREEN_FILES) {
    return { key: 'scope', state: 'green', label };
  }
  if (files <= SCOPE_YELLOW_FILES) {
    return { key: 'scope', state: 'yellow', label };
  }
  return { key: 'scope', state: 'red', label };
}

/**
 * requirements 信號: 解析 task.description 中的 markdown checkbox。
 * @param {object} task
 * @returns {{ key: string, state: string, label: string } | null}
 */
function computeRequirementsSignal(task) {
  const desc = task.description || '';
  const checkboxes = desc.match(/- \[(x| )\]/gi);
  if (!checkboxes || checkboxes.length === 0) return null;

  const total = checkboxes.length;
  const checked = checkboxes.filter(c => /\[x\]/i.test(c)).length;

  if (checked === total) {
    return { key: 'requirements', state: 'green', label: `AC ${checked}/${total}` };
  }
  if (checked >= total * 0.5) {
    return { key: 'requirements', state: 'yellow', label: `AC ${checked}/${total}` };
  }
  return { key: 'requirements', state: 'red', label: `AC ${checked}/${total}` };
}

/**
 * preflight 信號: 檢查 lessons/policy 命中數。
 * @param {object} board
 * @param {object} task
 * @returns {{ key: string, state: string, label: string } | null}
 */
function computePreflightSignal(board, task) {
  let lessonResult;
  try {
    lessonResult = mgmt.matchLessonsForTask(board, task);
  } catch {
    return null;
  }

  const matched = lessonResult.matched || [];
  if (matched.length === 0) {
    return { key: 'preflight', state: 'green', label: 'No hits' };
  }

  // 3+ matches = red
  if (matched.length >= 3) {
    return { key: 'preflight', state: 'red', label: `${matched.length} warnings` };
  }

  // Agent-specific matches = yellow
  if (matched.some(l => l.relevance === 'agent')) {
    return { key: 'preflight', state: 'yellow', label: `Hit ${matched.length}` };
  }

  return { key: 'preflight', state: 'yellow', label: `Hit ${matched.length}` };
}

/**
 * agent 信號: 計算 agent 歷史成功率。
 * @param {object} board
 * @param {object} task
 * @returns {{ key: string, state: string, label: string } | null}
 */
function computeAgentSignal(board, task) {
  const assignee = task.assignee;
  if (!assignee) return null;

  const signals = board.signals || [];
  const reviewSignals = signals.filter(
    s => s.type === 'review_result' && s.data?.assignee === assignee
  );

  if (reviewSignals.length < AGENT_MIN_REVIEWS) return null;

  const total = reviewSignals.length;
  const approved = reviewSignals.filter(s => s.data?.result === 'approved').length;
  const successRate = Math.round((approved / total) * 100);

  if (successRate >= AGENT_GREEN_RATE) {
    return { key: 'agent', state: 'green', label: `Rate ${successRate}%` };
  }
  if (successRate >= AGENT_YELLOW_RATE) {
    return { key: 'agent', state: 'yellow', label: `Rate ${successRate}%` };
  }
  return { key: 'agent', state: 'red', label: `Rate ${successRate}%` };
}

// --- Warning Generation ---

/**
 * 從非綠信號產生警告文字 (最多 MAX_WARNINGS 條)。
 * @param {Array} signals - 非 null 信號列表
 * @param {object} board
 * @param {object} task
 * @returns {string[]}
 */
function generateWarnings(signals, board, task) {
  const warnings = [];

  // Collect non-green signals, prioritize red over yellow
  const redSignals = signals.filter(s => s.state === 'red');
  const yellowSignals = signals.filter(s => s.state === 'yellow');

  const warningCandidates = [...redSignals, ...yellowSignals];

  for (const signal of warningCandidates) {
    if (warnings.length >= MAX_WARNINGS) break;

    switch (signal.key) {
      case 'tests':
        warnings.push(`tests: ${signal.label}`);
        break;
      case 'quality':
        warnings.push(`quality score ${signal.label}`);
        break;
      case 'scope':
        warnings.push(`scope: ${signal.label}`);
        break;
      case 'requirements':
        warnings.push(`requirements: ${signal.label}`);
        break;
      case 'preflight':
        warnings.push(`preflight: ${signal.label}`);
        break;
      case 'agent': {
        // Try to add lesson context for agent warnings
        let agentWarning = `agent: ${signal.label}`;
        try {
          const lessonResult = mgmt.matchLessonsForTask(board, task);
          const agentLessons = (lessonResult.matched || [])
            .filter(l => l.relevance === 'agent');
          if (agentLessons.length > 0) {
            agentWarning = agentLessons[0].rule.slice(0, 50);
          }
        } catch { /* ignore */ }
        warnings.push(agentWarning);
        break;
      }
      default:
        warnings.push(`${signal.key}: ${signal.label}`);
    }
  }

  return warnings;
}

// --- Main Computation ---

/**
 * 計算 6 維信心燈號。純同步運算，不需要 LLM。
 * @param {object} board - 完整 board 物件
 * @param {object} task - 要計算的 task
 * @returns {{ signals: Array, warnings: string[], overall: number, computedAt: string }}
 */
function computeConfidence(board, task) {
  const allSignals = [
    computeTestsSignal(task),
    computeQualitySignal(task),
    computeScopeSignal(task),
    computeRequirementsSignal(task),
    computePreflightSignal(board, task),
    computeAgentSignal(board, task),
  ];

  // Filter out null signals
  const signals = allSignals.filter(Boolean);
  const overall = signals.filter(s => s.state === 'green').length;
  const warnings = generateWarnings(signals, board, task);

  return {
    signals,
    warnings,
    overall,
    computedAt: new Date().toISOString(),
  };
}

// --- Trigger Function ---

/**
 * 觸發信心計算。從 server.js 呼叫，同步執行。
 *
 * @param {string} taskId
 * @param {string} event - 觸發事件 ('review_completed', 'approved', 'manual')
 * @param {object} deps - { readBoard, writeBoard, broadcastSSE, appendLog }
 */
function triggerConfidence(taskId, event, { readBoard, writeBoard, broadcastSSE, appendLog }) {
  const board = readBoard();
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task) {
    console.warn(`[confidence:${taskId}] task not found, skipping`);
    return;
  }

  const confidence = computeConfidence(board, task);

  // Write confidence to task on the same board we just read
  task.confidence = confidence;
  writeBoard(board);
  {
    broadcastSSE('task.confidence_updated', { taskId, confidence });
    appendLog({
      ts: new Date().toISOString(),
      event: 'confidence_computed',
      taskId,
      trigger: event,
      overall: confidence.overall,
      signalCount: confidence.signals.length,
    });
    console.log(`[confidence:${taskId}] computed (trigger: ${event}, overall: ${confidence.overall}/${confidence.signals.length})`);
  }
}

// --- Exports ---

module.exports = {
  computeConfidence,
  triggerConfidence,
  _internal: {
    SIGNAL_KEYS,
    computeTestsSignal,
    computeQualitySignal,
    computeScopeSignal,
    computeRequirementsSignal,
    computePreflightSignal,
    computeAgentSignal,
    generateWarnings,
    QUALITY_GREEN,
    QUALITY_YELLOW,
    SCOPE_GREEN_FILES,
    SCOPE_YELLOW_FILES,
    AGENT_GREEN_RATE,
    AGENT_YELLOW_RATE,
    AGENT_MIN_REVIEWS,
    MAX_WARNINGS,
  },
};
