/**
 * digest-task.js — LLM-powered task summary (L2 Why Digest)
 *
 * 產生結構化 JSON 任務摘要，回答「agent 做了什麼、為什麼、風險在哪」。
 * 事件觸發 + 快取模式 — 不做即時 LLM 呼叫。
 *
 * Opt-in: ANTHROPIC_API_KEY 環境變數啟用。無 key = 不產生 digest（L1 仍運作）。
 * 零外部依賴 — 僅使用 Node.js 內建模組 (https)
 *
 * @module digest-task
 */
const https = require('https');

// --- Constants ---
const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.KARVI_DIGEST_MODEL || 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 30000; // 30s — digest is fast

// --- Opt-in check ---

/**
 * 判斷 digest 功能是否啟用。
 * 只要 ANTHROPIC_API_KEY 設定就啟用。
 * @returns {boolean}
 */
function isDigestEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// --- HTTPS caller ---

/**
 * 呼叫 Claude Messages API (single-turn, no tools)。
 * 使用 Node.js 內建 https 模組，模式參考 runtime-claude-api.js。
 *
 * @param {string} apiKey - Anthropic API key
 * @param {string} prompt - 使用者 prompt
 * @param {string} [model] - 模型名稱
 * @returns {Promise<{status: number, body: object}>}
 */
function callClaudeAPI(apiKey, prompt, model) {
  return new Promise((resolve, reject) => {
    const requestBody = {
      model: model || DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: 'You are a task digest generator. Output ONLY valid JSON matching the TaskDigest schema. No markdown, no explanation, no code fences.',
      messages: [{ role: 'user', content: prompt }],
    };
    const payload = JSON.stringify(requestBody);

    const options = {
      hostname: API_HOST,
      port: 443,
      path: API_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-length': Buffer.byteLength(payload),
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          return reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}): ${data.slice(0, 500)}`));
        }
        if (res.statusCode !== 200) {
          const errMsg = parsed?.error?.message || parsed?.error?.type || `HTTP ${res.statusCode}`;
          return reject(new Error(`Claude API error: ${errMsg}`));
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Claude API request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`Claude API network error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

// --- Prompt builder ---

/**
 * 組裝 digest 用的 prompt。
 * @param {object} task - 任務物件
 * @param {object} context - gatherDigestContext() 回傳的上下文
 * @returns {string}
 */
function buildPrompt(task, context) {
  const parts = [];

  parts.push('Generate a TaskDigest JSON for the following task.\n');

  // Task metadata
  parts.push('## Task');
  parts.push(`- id: ${task.id}`);
  parts.push(`- title: ${task.title || '(no title)'}`);
  if (task.description) parts.push(`- description: ${task.description}`);
  if (task.status) parts.push(`- status: ${task.status}`);
  if (context.dispatch) {
    parts.push(`- runtime: ${context.dispatch.runtime}`);
    if (context.dispatch.model) parts.push(`- model: ${context.dispatch.model}`);
    parts.push(`- agent: ${context.dispatch.agentId}`);
  }

  // Review result
  if (context.review) {
    parts.push('\n## Review Result');
    if (context.review.score != null) parts.push(`- score: ${context.review.score}`);
    if (context.review.summary) parts.push(`- summary: ${context.review.summary}`);
    if (context.review.issues?.length) {
      parts.push('- issues:');
      for (const issue of context.review.issues.slice(0, 10)) {
        parts.push(`  - ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`);
      }
    }
  }

  // Lessons
  if (context.lessons?.length) {
    parts.push('\n## Active Lessons');
    for (const l of context.lessons) {
      parts.push(`- ${l}`);
    }
  }

  // L1 confidence (optional, from #52)
  if (context.confidence) {
    parts.push('\n## L1 Confidence Signals');
    parts.push(JSON.stringify(context.confidence, null, 2));
  }

  // Agent last reply excerpt
  if (context.lastReply) {
    parts.push('\n## Agent Last Reply (excerpt)');
    parts.push(context.lastReply.slice(0, 1500));
  }

  // Description as AC proxy
  if (context.description) {
    parts.push('\n## Acceptance Criteria (from description)');
    parts.push(context.description);
  }

  // Output schema
  parts.push('\n## Output Schema (TaskDigest)');
  parts.push(JSON.stringify({
    version: 'task_digest.v1',
    task_id: 'string',
    generated_at: 'ISO 8601',
    one_liner: 'string, max 40 chars, concise summary',
    risk: {
      level: 'low | medium | high | unknown',
      reasons: ['string array'],
    },
    bullets: {
      what: ['what was done'],
      why: ['why it was done'],
      risk: ['risk assessment'],
      notes: ['additional notes'],
    },
    warnings: [{ code: 'string', text: 'string' }],
    provenance: {
      decisions: { count: 0 },
      edda_refs: [],
    },
  }, null, 2));

  parts.push('\n## Constraints');
  parts.push('- one_liner MUST be 40 characters or fewer');
  parts.push('- Each bullets array should have 1-3 items');
  parts.push('- risk.level must be one of: low, medium, high, unknown');
  parts.push('- Output ONLY the JSON object. No markdown, no explanation.');

  return parts.join('\n');
}

// --- Response parser ---

/**
 * 從 LLM 回應中解析 TaskDigest JSON。
 * 多策略解析（參考 process-review.js 的 parseReviewResult 模式）。
 *
 * @param {string} responseText - LLM 回應文字
 * @returns {{ digest: object|null, source: string, error?: string }}
 */
function parseDigestResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return { digest: null, source: 'none', error: 'Empty response' };
  }

  const text = responseText.trim();

  // Strategy 1: Direct JSON parse of full text
  try {
    const parsed = JSON.parse(text);
    if (validateDigest(parsed)) {
      enforceOneLinerLength(parsed);
      return { digest: parsed, source: 'direct' };
    }
  } catch { /* not direct JSON, try next */ }

  // Strategy 2: Extract from ```json code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (validateDigest(parsed)) {
        enforceOneLinerLength(parsed);
        return { digest: parsed, source: 'code_block' };
      }
    } catch { /* code block not valid JSON, try next */ }
  }

  // Strategy 3: Find first { ... } JSON object (greedy)
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (validateDigest(parsed)) {
        enforceOneLinerLength(parsed);
        return { digest: parsed, source: 'brace_extract' };
      }
    } catch { /* brace extract not valid JSON */ }
  }

  return { digest: null, source: 'none', error: 'Could not extract valid TaskDigest JSON from response' };
}

/**
 * 驗證 digest 物件的必要欄位。
 * @param {object} obj
 * @returns {boolean}
 */
function validateDigest(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.task_id && !obj.version) return false;
  if (typeof obj.one_liner !== 'string') return false;
  if (!obj.risk || typeof obj.risk !== 'object') return false;
  if (!obj.bullets || typeof obj.bullets !== 'object') return false;
  return true;
}

/**
 * 強制 one_liner 不超過 40 字元。
 * @param {object} digest
 */
function enforceOneLinerLength(digest) {
  if (digest.one_liner && digest.one_liner.length > 40) {
    digest.one_liner = digest.one_liner.slice(0, 37) + '...';
  }
}

// --- Fallback digest ---

/**
 * 當 LLM 不可用時，產生模板式 digest。
 * @param {object} task
 * @returns {object} TaskDigest
 */
function fallbackDigest(task) {
  return {
    version: 'task_digest.v1',
    task_id: task.id,
    generated_at: new Date().toISOString(),
    one_liner: (task.title || '').slice(0, 40),
    risk: { level: 'unknown', reasons: ['LLM 不可用'] },
    bullets: {
      what: [task.title || '(no title)'],
      why: [task.description || '(no description)'],
      risk: ['無法評估 — LLM 未設定'],
      notes: [`runtime: ${task.dispatch?.runtime || 'unknown'}`],
    },
    warnings: [{ code: 'LLM_UNAVAILABLE', text: 'Digest 由模板產生' }],
    provenance: { decisions: { count: 0 }, edda_refs: [] },
    _fallback: true,
  };
}

// --- Context gathering ---

/**
 * 從 board 和 task 收集 digest 所需的上下文。
 * @param {object} board
 * @param {object} task
 * @returns {object} context
 */
function gatherDigestContext(board, task) {
  return {
    // Review data
    review: task.review || null,

    // Active lessons that apply
    lessons: (board.lessons || [])
      .filter(l => l.status === 'active' || l.status === 'validated')
      .slice(0, 5)
      .map(l => l.rule),

    // Recent signals for this task
    signals: (board.signals || [])
      .filter(s => s.refs?.includes(task.id))
      .slice(-10),

    // Upstream task summaries
    upstream: gatherUpstreamSummaries(board, task),

    // Agent's last reply excerpt (diff summary proxy)
    lastReply: (task.lastReply || '').slice(0, 2000),

    // Dispatch info
    dispatch: {
      runtime: task.dispatch?.runtime || 'unknown',
      model: task.dispatch?.model || null,
      agentId: task.assignee || 'unknown',
    },

    // L1 confidence (from #52, when available)
    confidence: task.confidence || null,

    // Task description as AC proxy
    description: task.description || '',
  };
}

/**
 * 收集上游任務（依賴）的摘要。
 * @param {object} board
 * @param {object} task
 * @returns {Array}
 */
function gatherUpstreamSummaries(board, task) {
  const deps = task.depends || [];
  if (deps.length === 0) return [];
  const tasks = board.taskPlan?.tasks || [];
  return deps.map(depId => {
    const dep = tasks.find(t => t.id === depId);
    if (!dep) return { id: depId, status: 'unknown' };
    return {
      id: dep.id,
      title: dep.title,
      status: dep.status,
      one_liner: dep.digest?.one_liner || null,
    };
  });
}

// --- Main digest generation ---

/**
 * 產生 LLM-powered digest。
 * @param {object} task
 * @param {object} context
 * @returns {Promise<object>} TaskDigest
 */
async function generateDigest(task, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const prompt = buildPrompt(task, context);
  const model = process.env.KARVI_DIGEST_MODEL || DEFAULT_MODEL;

  const response = await callClaudeAPI(apiKey, prompt, model);

  // Extract text content from Claude API response
  const textContent = (response.body.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  const result = parseDigestResponse(textContent);

  if (!result.digest) {
    throw new Error(`Failed to parse digest: ${result.error}`);
  }

  // Ensure required fields
  const digest = result.digest;
  digest.version = digest.version || 'task_digest.v1';
  digest.task_id = task.id;
  digest.generated_at = new Date().toISOString();
  digest._parse_source = result.source;

  return digest;
}

// --- Top-level trigger ---

/**
 * 觸發 digest 產生。從 server.js 呼叫，fire-and-forget async。
 *
 * @param {string} taskId
 * @param {string} event - 觸發事件 ('review_completed', 'approved', 'manual')
 * @param {object} deps - { readBoard, writeBoard, broadcastSSE, appendLog }
 * @returns {Promise<void>}
 */
async function triggerDigest(taskId, event, { readBoard, writeBoard, broadcastSSE, appendLog }) {
  const board = readBoard();
  const task = (board.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (!task) {
    console.warn(`[digest:${taskId}] task not found, skipping`);
    return;
  }

  const context = gatherDigestContext(board, task);
  let digest;

  try {
    digest = await generateDigest(task, context);
  } catch (err) {
    console.warn(`[digest:${taskId}] LLM failed, using fallback:`, err.message);
    digest = fallbackDigest(task);
  }

  digest.trigger_event = event;

  // Atomic write to board (re-read for freshness)
  const latestBoard = readBoard();
  const latestTask = (latestBoard.taskPlan?.tasks || []).find(t => t.id === taskId);
  if (latestTask) {
    latestTask.digest = digest;
    writeBoard(latestBoard);
    broadcastSSE('task.digest_updated', { taskId, digest });
    appendLog({
      ts: new Date().toISOString(),
      event: 'digest_generated',
      taskId,
      trigger: event,
      fallback: !!digest._fallback,
    });
    console.log(`[digest:${taskId}] generated (trigger: ${event}, fallback: ${!!digest._fallback})`);
  }
}

// --- Exports ---

module.exports = {
  isDigestEnabled,
  triggerDigest,     // Called from server.js, fire-and-forget async
  generateDigest,    // For testing
  fallbackDigest,    // For testing
  _internal: {
    callClaudeAPI,
    buildPrompt,
    parseDigestResponse,
    validateDigest,
    enforceOneLinerLength,
    gatherDigestContext,
    gatherUpstreamSummaries,
    API_HOST,
    API_PATH,
    DEFAULT_MODEL,
    REQUEST_TIMEOUT_MS,
  },
};
