/**
 * runtime-claude-api.js — Claude Messages API runtime adapter
 *
 * 透過 HTTPS 直接呼叫 Claude Messages API，使用 vault 管理的 per-user API key。
 * 適用於 SaaS 環境，不需要本機安裝 Claude CLI。
 *
 * Factory pattern: create({ vault }) → { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities }
 *
 * 零外部依賴 — 僅使用 Node.js 內建模組 (https, fs, path, child_process)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// --- Constants ---
const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TIMEOUT_SEC = 300;
const TOOL_EXEC_TIMEOUT_MS = 30000;

// --- HTTPS Helper ---

/**
 * POST JSON to the Claude Messages API via built-in https module.
 * @param {string} apiKey - Anthropic API key
 * @param {object} body - Request body (messages, tools, etc.)
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise<{status: number, body: object}>}
 */
function httpsPost(apiKey, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

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
      timeout: timeoutMs,
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Claude API request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`Claude API network error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

// --- API Key Resolution ---

/**
 * Resolve the Anthropic API key from vault for a given user.
 * @param {object} vault - Vault instance
 * @param {string} userId - User identifier
 * @returns {string} API key
 */
function resolveApiKey(vault, userId) {
  if (!vault || !vault.isEnabled()) {
    throw new Error('Vault is not configured — cannot retrieve API key for claude-api runtime');
  }
  if (!userId) {
    throw new Error('userId is required for claude-api runtime — set plan.userId or board participant');
  }

  const buf = vault.retrieve(userId, 'anthropic_api_key');
  if (!buf) {
    throw new Error(`No anthropic_api_key found in vault for user "${userId}". Store it via POST /api/vault/store`);
  }

  const key = buf.toString('utf8');
  buf.fill(0); // wipe from memory
  return key;
}

// --- Tool Definitions ---

/**
 * Build Claude API tool definitions for file/bash operations.
 * @returns {Array} Tool definitions in Claude API format
 */
function buildTools() {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file at the given path (relative to working directory).',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to read' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file at the given path (relative to working directory). Creates parent directories if needed.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to write' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'bash',
      description: 'Execute a bash/shell command in the working directory. Use for git, npm, testing, etc.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
    {
      name: 'list_directory',
      description: 'List files and directories at the given path (relative to working directory).',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path to list (defaults to ".")' },
        },
        required: [],
      },
    },
  ];
}

// --- Path Traversal Prevention ---

/**
 * Resolve a relative path within a sandbox directory, preventing path traversal.
 * @param {string} workingDir - The sandbox/working directory
 * @param {string} relativePath - User-provided relative path
 * @returns {string} Resolved absolute path guaranteed to be within workingDir
 * @throws {Error} If path escapes the working directory
 */
function safePath(workingDir, relativePath) {
  // Defense-in-depth: reject null bytes that could truncate C-level path strings
  if (relativePath.includes('\0')) {
    throw new Error(`Path traversal denied: null byte in path`);
  }
  const resolved = path.resolve(workingDir, relativePath);
  const normalizedBase = path.resolve(workingDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal denied: "${relativePath}" resolves outside working directory`);
  }
  return resolved;
}

// --- Tool Execution ---

/**
 * Execute a tool call from Claude's response.
 * @param {string} toolName - Name of the tool to execute
 * @param {object} toolInput - Tool input parameters
 * @param {string} workingDir - Working directory for file/command operations
 * @param {object} [sandboxOpts] - Optional sandbox config { mode, config: { image, limits } }
 * @returns {string} Tool execution result as string
 */
function executeToolCall(toolName, toolInput, workingDir, sandboxOpts) {
  try {
    switch (toolName) {
      case 'read_file': {
        const filePath = safePath(workingDir, toolInput.path);
        return fs.readFileSync(filePath, 'utf8');
      }

      case 'write_file': {
        const filePath = safePath(workingDir, toolInput.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, toolInput.content, 'utf8');
        return `File written: ${toolInput.path}`;
      }

      case 'bash': {
        const cmd = toolInput.command;

        // Container sandbox mode: execute bash inside Docker container
        if (sandboxOpts?.mode === 'container') {
          const sandbox = require('./sandbox');
          return sandbox.execInContainer({
            image: sandboxOpts.config.image,
            limits: sandboxOpts.config.limits,
            workingDir,
            command: cmd,
            timeoutMs: TOOL_EXEC_TIMEOUT_MS,
          });
        }

        // Direct mode: execute bash on host (existing behavior)
        const execOpts = {
          cwd: workingDir,
          timeout: TOOL_EXEC_TIMEOUT_MS,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024, // 1MB
          windowsHide: true,
        };
        const result = process.platform === 'win32'
          ? execFileSync('cmd.exe', ['/d', '/s', '/c', cmd], execOpts)
          : execSync(cmd, { ...execOpts, shell: true });
        return result || '(no output)';
      }

      case 'list_directory': {
        const dirPath = safePath(workingDir, toolInput.path || '.');
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n');
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// --- Conversation Loop ---

/**
 * Run a multi-turn conversation with Claude API, handling tool use.
 *
 * Flow: send message → receive tool_use → execute tool → send tool_result → repeat
 * Continues until Claude responds with end_turn or max turns reached.
 *
 * @param {object} opts
 * @param {string} opts.apiKey - Anthropic API key
 * @param {string} opts.model - Model to use
 * @param {string} opts.systemPrompt - System prompt
 * @param {string} opts.userMessage - Initial user message
 * @param {Array} opts.tools - Tool definitions
 * @param {string} opts.workingDir - Working directory for tool execution
 * @param {number} opts.maxTurns - Maximum conversation turns
 * @param {number} opts.timeoutSec - Total timeout in seconds
 * @param {number} opts.maxTokens - Max tokens per response
 * @param {object} [opts.sandbox] - Sandbox execution mode { mode, config }
 * @returns {Promise<{response: object, usage: {input_tokens: number, output_tokens: number}, turns: number}>}
 */
async function runConversationLoop(opts) {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    systemPrompt,
    userMessage,
    tools,
    workingDir,
    maxTurns = DEFAULT_MAX_TURNS,
    timeoutSec = DEFAULT_TIMEOUT_SEC,
    maxTokens = DEFAULT_MAX_TOKENS,
    sandbox = null,
  } = opts;

  const deadline = Date.now() + timeoutSec * 1000;
  const messages = [{ role: 'user', content: userMessage }];
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  let lastResponse = null;
  let turns = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Check total timeout
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Conversation timed out after ${timeoutSec}s (${turn} turns completed)`);
    }

    const requestBody = {
      model,
      max_tokens: maxTokens,
      messages,
    };
    if (systemPrompt) requestBody.system = systemPrompt;
    if (tools && tools.length > 0) requestBody.tools = tools;

    // Use module.exports._internal.httpsPost so tests can mock it
    const { status, body: response } = await module.exports._internal.httpsPost(apiKey, requestBody, Math.min(remaining, 120000));

    // Handle API errors
    if (status !== 200) {
      const errType = response?.error?.type || 'unknown';
      const errMsg = response?.error?.message || JSON.stringify(response);
      throw new Error(`Claude API error (${status} ${errType}): ${errMsg}`);
    }

    // Accumulate usage
    if (response.usage) {
      totalUsage.input_tokens += response.usage.input_tokens || 0;
      totalUsage.output_tokens += response.usage.output_tokens || 0;
    }

    lastResponse = response;
    turns = turn + 1;

    // Check if Claude wants to use tools
    const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // No tool use or conversation ended — we're done
      break;
    }

    // Add Claude's response to message history
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool call and collect results
    const toolResults = toolUseBlocks.map(block => {
      const result = executeToolCall(block.name, block.input, workingDir, sandbox);
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.slice(0, 50000), // cap tool output to avoid token explosion
      };
    });

    // Send tool results back
    messages.push({ role: 'user', content: toolResults });
  }

  return { response: lastResponse, usage: totalUsage, turns };
}

// --- Phase 2 Deferred Features ---
// TODO(Phase 2): Streaming — use Claude SSE streaming endpoint for real-time
//   progress updates via server SSE broadcast. Requires chunked httpsPost variant.
// Phase 3 (Repo ops) implemented: see repo-provisioner.js + routes/repos.js
// Working directory provisioning happens in routes/tasks.js dispatchTask().

// --- Factory ---

/**
 * Create a claude-api runtime instance with vault injection.
 * @param {object} opts
 * @param {object} opts.vault - Vault instance for API key retrieval
 * @returns {{ dispatch, extractReplyText, extractSessionId, extractUsage, capabilities }}
 */
function create(opts = {}) {
  const vault = opts.vault || null;

  /**
   * Dispatch a task via Claude Messages API.
   *
   * Expects plan.userId to resolve the API key from vault.
   * Uses plan.message as the user prompt, with tool use for file/bash operations.
   *
   * @param {object} plan - Dispatch plan from management.buildDispatchPlan()
   * @returns {Promise<{code: number, stdout: string, stderr: string, parsed: object, usage: object}>}
   */
  async function dispatch(plan) {
    // 0. Validate workingDir first (before any expensive operations)
    if (!plan.workingDir) {
      throw new Error(
        `[claude-api-rt] CRITICAL: workingDir is null for task ${plan.taskId}. ` +
        `Cannot dispatch agent without target directory. ` +
        `This indicates a bug in the dispatch chain.`
      );
    }

    // 1. Resolve API key
    const apiKey = resolveApiKey(vault, plan.userId);

    // 2. Determine model
    const model = plan.modelHint || DEFAULT_MODEL;

    // 3. Build system prompt
    const systemPrompt = [
      'You are a task execution agent. Complete the assigned task thoroughly.',
      'Use the provided tools to read/write files and run commands as needed.',
      'When finished, provide a clear summary of what was done.',
      plan.controlsSnapshot ? `Quality threshold: ${plan.controlsSnapshot.quality_threshold || 70}/100.` : '',
    ].filter(Boolean).join('\n');

    // 4. Working directory (already validated)
    const workingDir = plan.workingDir;

    // 5. Run conversation loop with tools
    const result = await runConversationLoop({
      apiKey,
      model,
      systemPrompt,
      userMessage: plan.message,
      tools: buildTools(),
      workingDir,
      maxTurns: DEFAULT_MAX_TURNS,
      timeoutSec: plan.timeoutSec || DEFAULT_TIMEOUT_SEC,
      maxTokens: DEFAULT_MAX_TOKENS,
      sandbox: plan.sandbox || null,
    });

    // 6. Surface accumulated usage for extractUsage() to find on parsed
    if (result.response) {
      result.response._accumulatedUsage = result.usage;
    }

    // 7. Extract text from final response
    const textBlocks = (result.response?.content || []).filter(b => b.type === 'text');
    const stdout = textBlocks.map(b => b.text).join('\n\n').trim() || '(no text response)';

    return {
      code: 0,
      stdout,
      stderr: '',
      parsed: result.response,
      usage: result.usage,
      turns: result.turns,
    };
  }

  /**
   * Extract reply text from Claude API response.
   * @param {object} parsed - The parsed response object
   * @param {string} stdout - Fallback stdout text
   * @returns {string}
   */
  function extractReplyText(parsed, stdout) {
    if (parsed?.content) {
      const textBlocks = parsed.content.filter(b => b.type === 'text');
      const text = textBlocks.map(b => b.text).join('\n\n').trim();
      if (text) return text;
    }
    return stdout || '(empty reply)';
  }

  /**
   * Extract session/message ID from Claude API response.
   * Claude Messages API returns a unique message `id` per response.
   * @param {object} parsed - The parsed response object
   * @returns {string|null}
   */
  function extractSessionId(parsed) {
    return parsed?.id || null;
  }

  /**
   * Extract token usage from Claude API dispatch result.
   *
   * The dispatch method attaches accumulated multi-turn usage as
   * `parsed._accumulatedUsage`. Falls back to `parsed.usage` for
   * single-turn or direct API response objects.
   *
   * @param {object} parsed - The parsed response object from dispatch
   * @param {string} stdout - Fallback stdout text (unused for claude-api)
   * @returns {object|null} { inputTokens, outputTokens, totalCost } or null
   */
  function extractUsage(parsed, stdout) {
    if (!parsed) return null;
    const acc = parsed._accumulatedUsage;
    const inputTokens = acc?.input_tokens ?? parsed.usage?.input_tokens ?? null;
    const outputTokens = acc?.output_tokens ?? parsed.usage?.output_tokens ?? null;
    const totalCost = null; // Claude API does not return cost
    if (inputTokens == null && outputTokens == null) return null;
    return { inputTokens, outputTokens, totalCost };
  }

  /**
   * Runtime capabilities descriptor.
   * @returns {object}
   */
  function capabilities() {
    return {
      runtime: 'claude-api',
      supportsReview: false,
      supportsSessionResume: false,
      supportsModelSelection: true,
      supportsBudgetTracking: true,
      supportsToolUse: true,
    };
  }

  return { dispatch, extractReplyText, extractSessionId, extractUsage, capabilities };
}

// Export factory + internal helpers (for testing)
module.exports = {
  create,
  // Exported for unit testing only
  _internal: {
    httpsPost,
    resolveApiKey,
    buildTools,
    safePath,
    executeToolCall,
    runConversationLoop,
  },
};
