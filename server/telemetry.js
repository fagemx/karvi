/**
 * telemetry.js — 匿名使用統計模組
 *
 * 收集去識別化的使用數據，幫助了解 Karvi 自架版使用情況。
 * - 零外部依賴（只用 Node.js 內建模組）
 * - 不收集任何 PII（無 IP、無 email、無任務內容）
 * - 雙重 opt-out：KARVI_TELEMETRY=0 環境變數 或 controls API toggle
 * - 24 小時彙總一次，非即時回報
 * - 網路錯誤靜默失敗（air-gapped 環境友好）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const TELEMETRY_ENDPOINT = 'https://telemetry.karvi.io/v1/report';
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INSTALL_ID_FILE = '.karvi-telemetry-id';

// --- Install ID ---

/**
 * 取得或建立安裝 UUID（存在 DATA_DIR/.karvi-telemetry-id）
 * 用於去重，非追蹤用途。
 */
function getOrCreateInstallId(dataDir) {
  const idPath = path.join(dataDir, INSTALL_ID_FILE);
  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing && existing.length >= 32) return existing;
  } catch { /* file doesn't exist yet */ }

  const newId = crypto.randomUUID();
  try {
    fs.writeFileSync(idPath, newId, 'utf8');
  } catch (err) {
    // 無法寫入也不阻擋啟動，用暫時 ID
    console.warn(`[telemetry] cannot write install ID: ${err.message}`);
    return newId;
  }
  return newId;
}

// --- Opt-out check ---

/**
 * 判斷 telemetry 是否被環境變數停用。
 * KARVI_TELEMETRY=0 | off | false | no → 停用
 */
function isEnvOptedOut() {
  const val = (process.env.KARVI_TELEMETRY || '').toLowerCase().trim();
  return ['0', 'off', 'false', 'no'].includes(val);
}

/**
 * 完整的 opt-out 判斷：環境變數 OR controls API toggle
 */
function isDisabled(readBoardFn) {
  if (isEnvOptedOut()) return true;
  try {
    const board = readBoardFn();
    const controls = board.controls || {};
    if (controls.telemetry_enabled === false) return true;
  } catch { /* board read failure doesn't block */ }
  return false;
}

// --- Data collection (16 safe data points) ---

/**
 * 從 board 收集匿名使用數據。
 * 只有數量/比例，不含任何任務內容或使用者資料。
 */
function collectPayload(installId, readBoardFn, startedAt) {
  let board = {};
  try { board = readBoardFn(); } catch { /* empty board fallback */ }

  const tasks = board.taskPlan?.tasks || [];
  const signals = board.signals || [];
  const insights = board.insights || [];
  const lessons = board.lessons || [];
  const conversations = board.conversations || [];
  const participants = board.participants || [];
  const controls = board.controls || {};

  // Runtime 使用分布（只有 runtime 名稱計數）
  const runtimeCounts = {};
  for (const t of tasks) {
    const rt = t.dispatch?.runtime || t.runtimeHint || 'unknown';
    runtimeCounts[rt] = (runtimeCounts[rt] || 0) + 1;
  }

  // 任務狀態分布
  const statusCounts = {};
  for (const t of tasks) {
    const s = t.status || 'unknown';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  // 錯誤信號數
  const errorSignalCount = signals.filter(s => s.type === 'error').length;

  // Uptime
  const uptimeHours = Math.round((Date.now() - startedAt) / 3600000 * 100) / 100;

  // 版本號
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    version = pkg.version || version;
  } catch { /* package.json read failure */ }

  return {
    // 1. 安裝 ID（random UUID，去重用，非追蹤）
    installId,
    // 2. Karvi 版本號
    version,
    // 3. Node.js 版本
    nodeVersion: process.version,
    // 4. OS 平台
    osPlatform: os.platform(),
    // 5. OS 架構
    osArch: os.arch(),
    // 6. 任務總數
    taskCount: tasks.length,
    // 7. 任務狀態分布
    taskStatusCounts: statusCounts,
    // 8. Runtime 使用分布
    runtimeCounts,
    // 9. 參與者數量（agents vs humans）
    participantCount: participants.length,
    agentCount: participants.filter(p => p.type === 'agent').length,
    // 10. 對話數量
    conversationCount: conversations.length,
    // 11. 信號總數
    signalCount: signals.length,
    // 12. 錯誤信號數
    errorSignalCount,
    // 13. Insight 數量
    insightCount: insights.length,
    // 14. Lesson 數量
    lessonCount: lessons.length,
    // 15. Uptime（小時）
    uptimeHours,
    // 16. 功能開關狀態（只記 on/off，不記值）
    featureFlags: {
      autoReview: !!controls.auto_review,
      autoRedispatch: !!controls.auto_redispatch,
      autoApplyInsights: !!controls.auto_apply_insights,
      telemetryEnabled: controls.telemetry_enabled !== false,
    },
    // 回報時間
    reportedAt: new Date().toISOString(),
  };
}

// --- HTTP reporter ---

/**
 * 透過 HTTPS POST 送出 telemetry payload。
 * 靜默失敗 — 任何網路錯誤都不會影響 server。
 */
function sendReport(payload) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(payload);
      const url = new URL(TELEMETRY_ENDPOINT);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent': `karvi-telemetry/${payload.version || '0.0.0'}`,
        },
        timeout: 10000, // 10 second timeout
      };

      const req = https.request(options, (res) => {
        // 不管回應，靜默結束
        res.resume();
        resolve({ sent: true, statusCode: res.statusCode });
      });

      req.on('error', () => {
        // 靜默失敗（air-gapped、DNS 失敗、網路不通等）
        resolve({ sent: false, error: 'network_error' });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ sent: false, error: 'timeout' });
      });

      req.write(data);
      req.end();
    } catch {
      // 任何非預期錯誤，靜默
      resolve({ sent: false, error: 'unexpected' });
    }
  });
}

// --- Startup banner ---

function printBanner() {
  console.log('');
  console.log('[telemetry] Karvi collects anonymous usage data to improve the product.');
  console.log('[telemetry] No PII is collected. Data is reported once every 24 hours.');
  console.log('[telemetry] To opt out: set KARVI_TELEMETRY=0 or POST /api/controls {"telemetry_enabled":false}');
  console.log('');
}

// --- Main init ---

/**
 * 初始化 telemetry 模組。在 server 啟動時呼叫一次。
 *
 * @param {Object} options
 * @param {string} options.dataDir - 資料目錄（放 install ID 檔案）
 * @param {Function} options.readBoard - 讀取 board 的函式
 * @returns {Object} telemetry handle with stop() method
 */
function init({ dataDir, readBoard }) {
  // 環境變數 opt-out：完全不初始化
  if (isEnvOptedOut()) {
    console.log('[telemetry] disabled via KARVI_TELEMETRY env var');
    return { stop() {}, disabled: true };
  }

  const installId = getOrCreateInstallId(dataDir);
  const startedAt = Date.now();

  // 首次啟動提示
  printBanner();

  // 定期回報
  const timer = setInterval(async () => {
    // 每次回報前重新檢查 controls toggle
    if (isDisabled(readBoard)) {
      return; // controls 關閉了，跳過本次
    }
    const payload = collectPayload(installId, readBoard, startedAt);
    await sendReport(payload);
  }, REPORT_INTERVAL_MS);

  // 不阻擋 process exit
  if (timer.unref) timer.unref();

  return {
    /** 手動停止定期回報 */
    stop() {
      clearInterval(timer);
    },
    /** 手動觸發一次回報（用於測試或 graceful shutdown） */
    async report() {
      if (isDisabled(readBoard)) return { sent: false, reason: 'disabled' };
      const payload = collectPayload(installId, readBoard, startedAt);
      return sendReport(payload);
    },
    /** 取得目前的 payload（用於除錯） */
    getPayload() {
      return collectPayload(installId, readBoard, startedAt);
    },
    disabled: false,
    installId,
  };
}

module.exports = {
  init,
  // 匯出內部函式供測試用
  _internals: {
    getOrCreateInstallId,
    isEnvOptedOut,
    isDisabled,
    collectPayload,
    sendReport,
    TELEMETRY_ENDPOINT,
    REPORT_INTERVAL_MS,
    INSTALL_ID_FILE,
  },
};
