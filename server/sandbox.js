/**
 * sandbox.js — Container sandbox manager for user code execution
 *
 * 透過 Docker CLI (child_process) 提供 container-level 隔離。
 * 零外部依賴 — 不用 dockerode，直接 spawn docker commands。
 *
 * 三種模式：
 * 1. container — 完整 Docker container 隔離（需要 Docker）
 * 2. direct — 直接執行，無隔離（開發/無 Docker 環境 fallback）
 *
 * Issue #168: feat(saas): container sandbox for user code execution
 */
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

// --- Docker availability detection ---

let _dockerAvailable = null;
let _dockerCheckedAt = 0;
const DOCKER_CACHE_TTL_MS = 60000; // 60s TTL

/**
 * 檢查 Docker 是否可用（結果快取，60s TTL）。
 * @returns {boolean}
 */
function isDockerAvailable() {
  const now = Date.now();
  if (_dockerAvailable !== null && (now - _dockerCheckedAt) < DOCKER_CACHE_TTL_MS) {
    return _dockerAvailable;
  }
  try {
    execFileSync('docker', ['info'], {
      timeout: 10000,
      stdio: 'ignore',
    });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  _dockerCheckedAt = now;
  console.log(`[sandbox] Docker available: ${_dockerAvailable}`);
  return _dockerAvailable;
}

/**
 * 重設 Docker 可用性快取（測試用）。
 */
function resetDockerCache() {
  _dockerAvailable = null;
  _dockerCheckedAt = 0;
}

// --- Default sandbox limits ---

const DEFAULT_LIMITS = {
  memory: '512m',       // container memory limit
  cpus: '1.0',          // CPU quota
  pids_limit: 256,      // max processes inside container
  tmpfs_size: '100m',   // /tmp tmpfs size
  read_only: true,      // read-only root filesystem
  network: 'none',      // network mode: 'none' (isolated) or 'bridge'
};

// --- Image name validation ---

const IMAGE_NAME_RE = /^[a-zA-Z0-9._\/-]+(:[a-zA-Z0-9._-]+)?$/;

/**
 * 驗證 Docker image 名稱，防止 CLI injection。
 * @param {string} name
 * @returns {boolean}
 */
function isValidImageName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 256 && IMAGE_NAME_RE.test(name);
}

// --- Sandbox limits validation ---

const ALLOWED_LIMIT_KEYS = new Set(['memory', 'cpus', 'pids_limit', 'tmpfs_size', 'read_only', 'network']);

/**
 * 過濾並驗證 sandbox_limits，只允許白名單 keys。
 * network 只能是 'none'。
 * @param {object} raw — 來自 controls.sandbox_limits
 * @returns {object} 過濾後的 limits
 */
function sanitizeLimits(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!ALLOWED_LIMIT_KEYS.has(key)) continue;
    out[key] = val;
  }
  // network 只允許 'none'（安全約束）
  if ('network' in out && out.network !== 'none') {
    console.warn(`[sandbox] sandbox_limits.network="${out.network}" rejected — forcing 'none'`);
    out.network = 'none';
  }
  return out;
}

// --- Sandbox configuration resolution ---

/**
 * 從 board controls 解析 sandbox 設定。
 *
 * Controls 欄位：
 *   sandbox_enabled  {boolean} — 是否啟用 container sandbox
 *   sandbox_image    {string}  — Docker image 名稱
 *   sandbox_limits   {object}  — 資源限制覆蓋
 *
 * @param {object} controls — board controls (from mgmt.getControls)
 * @returns {{ enabled: boolean, image: string, limits: object }}
 */
function resolveSandboxConfig(controls) {
  const enabled = controls.sandbox_enabled === true;

  // 驗證 image 名稱
  const rawImage = controls.sandbox_image || 'karvi-sandbox:latest';
  const image = isValidImageName(rawImage) ? rawImage : 'karvi-sandbox:latest';
  if (rawImage !== image) {
    console.warn(`[sandbox] invalid sandbox_image "${rawImage}" — using default`);
  }

  // 過濾 limits（whitelist keys + network 鎖 'none'）
  const limits = { ...DEFAULT_LIMITS, ...sanitizeLimits(controls.sandbox_limits) };
  return { enabled, image, limits };
}

// --- Docker command builders ---

/**
 * 建構 docker run 命令的參數陣列。
 *
 * 安全措施：
 * - --cap-drop ALL: 移除所有 Linux capabilities
 * - --read-only: root filesystem 唯讀
 * - --tmpfs /tmp: 可寫暫存空間（受限大小）
 * - --tmpfs /output: agent 寫 artifacts 的空間
 * - --network none: 預設無網路
 * - --memory / --cpus / --pids-limit: 資源限制
 * - --security-opt no-new-privileges: 阻止 privilege escalation
 * - -v workingDir:/workspace:ro: 工作目錄唯讀掛載（防 .git/hooks 逃逸）
 *
 * @param {object} opts
 * @param {string} opts.image — Docker image
 * @param {object} opts.limits — 資源限制
 * @param {string} opts.workingDir — 工作目錄（host path，會 bind mount 為 :ro）
 * @param {string} opts.command — 要在 container 內執行的 shell 命令
 * @param {object} [opts.env] — 額外環境變數 { KEY: VALUE }
 * @param {number} [opts.timeoutSec] — container 執行超時（秒）
 * @returns {string[]} docker run 的參數陣列
 */
function buildDockerRunArgs(opts) {
  const { image, limits, workingDir, command, env } = opts;

  // Container 內的工作路徑 — 統一用 /workspace
  const containerWorkDir = '/workspace';

  const args = [
    'run', '--rm',
    // 安全 — 移除所有 capabilities
    '--cap-drop', 'ALL',
    // 資源限制
    '--memory', limits.memory,
    '--cpus', limits.cpus,
    '--pids-limit', String(limits.pids_limit),
    // 安全
    '--security-opt', 'no-new-privileges',
    // 網路
    '--network', limits.network || 'none',
  ];

  // 唯讀 root filesystem + tmpfs for /tmp
  if (limits.read_only) {
    args.push('--read-only');
    args.push('--tmpfs', `/tmp:size=${limits.tmpfs_size},exec`);
  }

  // Agent 寫 artifacts 的 tmpfs（不依賴 host mount :rw）
  args.push('--tmpfs', '/output:size=200m,exec');

  // Bind mount 工作目錄（唯讀 — 防止 .git/hooks 逃逸）
  if (workingDir) {
    args.push('-v', `${workingDir}:${containerWorkDir}:ro`);
    args.push('-w', containerWorkDir);
  }

  // 環境變數（過濾敏感的 KARVI_ 系列，只傳明確允許的）
  const safeEnvKeys = ['NODE_ENV', 'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL'];
  if (env) {
    for (const [key, val] of Object.entries(env)) {
      if (safeEnvKeys.includes(key) || key.startsWith('SANDBOX_')) {
        args.push('-e', `${key}=${val}`);
      }
    }
  }

  args.push(image);

  // 執行命令
  args.push('sh', '-c', command);

  return args;
}

/**
 * 在 Docker container 內同步執行命令（用於 claude-api runtime 的 bash tool）。
 *
 * @param {object} opts
 * @param {string} opts.image — Docker image
 * @param {object} opts.limits — 資源限制
 * @param {string} opts.workingDir — Host 工作目錄
 * @param {string} opts.command — Shell 命令
 * @param {number} [opts.timeoutMs=30000] — 超時（毫秒）
 * @param {object} [opts.env] — 額外環境變數
 * @returns {string} 命令輸出
 * @throws {Error} 命令失敗或超時
 */
function execInContainer(opts) {
  const { image, limits, workingDir, command, timeoutMs = 30000, env } = opts;
  const dockerArgs = buildDockerRunArgs({ image, limits, workingDir, command, env });

  return execFileSync('docker', dockerArgs, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

// --- Sandbox mode resolution ---

/**
 * 判斷實際執行模式：container 或 direct。
 *
 * 決策邏輯：
 * 1. sandbox_enabled=false → direct
 * 2. sandbox_enabled=true + Docker 可用 → container
 * 3. sandbox_enabled=true + Docker 不可用 → direct (降級 + 警告)
 *
 * @param {object} controls — board controls
 * @returns {{ mode: 'container'|'direct', config: object, degraded: boolean }}
 */
function resolveExecutionMode(controls) {
  const config = resolveSandboxConfig(controls);

  if (!config.enabled) {
    return { mode: 'direct', config, degraded: false };
  }

  if (isDockerAvailable()) {
    return { mode: 'container', config, degraded: false };
  }

  // Docker 不可用但 sandbox 被啟用 — 降級到直接執行
  console.warn('[sandbox] sandbox_enabled=true but Docker unavailable — falling back to direct execution');
  return { mode: 'direct', config, degraded: true };
}

// --- Dockerfile generation helper ---

/**
 * 產生基本的 sandbox Dockerfile 內容。
 * 用於 `docker build` 建構 sandbox image。
 *
 * @param {object} [opts]
 * @param {string} [opts.baseImage='node:22-slim'] — 基礎 image
 * @param {string[]} [opts.extraPackages=[]] — 額外 apt packages
 * @returns {string} Dockerfile 內容
 */
function generateDockerfile(opts = {}) {
  const { baseImage = 'node:22-slim', extraPackages = [] } = opts;
  const pkgs = ['git', 'curl', ...extraPackages].join(' ');
  return [
    `FROM ${baseImage}`,
    '',
    '# 安裝基本工具',
    `RUN apt-get update && apt-get install -y --no-install-recommends ${pkgs} && rm -rf /var/lib/apt/lists/*`,
    '',
    '# 建立非 root 用戶',
    'RUN groupadd -r sandbox && useradd -r -g sandbox -m -s /bin/bash sandbox',
    '',
    '# 工作目錄',
    'WORKDIR /workspace',
    '',
    '# 以非 root 執行',
    'USER sandbox',
    '',
    'CMD ["bash"]',
  ].join('\n');
}

/**
 * 建構 sandbox Docker image（如果不存在）。
 *
 * @param {string} imageName — image 名稱（含 tag）
 * @param {object} [opts] — 傳給 generateDockerfile 的選項
 * @returns {boolean} 是否成功建構
 */
function ensureSandboxImage(imageName, opts = {}) {
  if (!isDockerAvailable()) return false;
  if (!isValidImageName(imageName)) {
    console.error(`[sandbox] invalid image name: ${imageName}`);
    return false;
  }

  // 檢查 image 是否已存在
  try {
    execFileSync('docker', ['image', 'inspect', imageName], {
      stdio: 'ignore',
      timeout: 10000,
    });
    console.log(`[sandbox] image ${imageName} already exists`);
    return true;
  } catch {
    // Image 不存在，需要建構
  }

  console.log(`[sandbox] building image ${imageName}...`);
  const dockerfile = generateDockerfile(opts);
  const tmpDir = path.join(os.tmpdir(), `karvi-sandbox-build-${Date.now()}`);
  const fs = require('fs');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), dockerfile, 'utf8');

  try {
    execFileSync('docker', ['build', '-t', imageName, tmpDir], {
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log(`[sandbox] image ${imageName} built successfully`);
    return true;
  } catch (err) {
    console.error(`[sandbox] image build failed: ${err.message}`);
    return false;
  } finally {
    // 清理暫存目錄
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

module.exports = {
  isDockerAvailable,
  resetDockerCache,
  resolveSandboxConfig,
  resolveExecutionMode,
  buildDockerRunArgs,
  execInContainer,
  ensureSandboxImage,
  generateDockerfile,
  isValidImageName,
  sanitizeLimits,
  DEFAULT_LIMITS,
  DOCKER_CACHE_TTL_MS,
};
