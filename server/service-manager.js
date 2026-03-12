/**
 * service-manager.js — 統一管理 background service 生命週期
 *
 * 所有 setInterval/setTimeout background tasks 註冊到這裡，
 * 統一 start/stop/status，graceful shutdown 時一次關閉。
 */

class ServiceManager {
  constructor() {
    /** @type {Map<string, {start: Function, stop: Function, healthCheck?: Function, running: boolean, startedAt: string|null, error: string|null}>} */
    this._services = new Map();
  }

  /**
   * 註冊一個 background service。
   * @param {string} name - 服務名稱（唯一）
   * @param {{ start: Function, stop: Function, healthCheck?: Function }} handlers
   */
  register(name, handlers) {
    if (this._services.has(name)) {
      throw new Error(`Service "${name}" already registered`);
    }
    this._services.set(name, {
      start: handlers.start,
      stop: handlers.stop,
      healthCheck: handlers.healthCheck || null,
      running: false,
      startedAt: null,
      error: null,
    });
  }

  /**
   * 啟動所有已註冊的服務。
   */
  startAll() {
    for (const [name, svc] of this._services) {
      if (svc.running) continue;
      try {
        svc.start();
        svc.running = true;
        svc.startedAt = new Date().toISOString();
        svc.error = null;
        console.log(`[service-manager] started: ${name}`);
      } catch (err) {
        svc.error = err.message;
        console.warn(`[service-manager] failed to start ${name}: ${err.message}`);
      }
    }
  }

  /**
   * 停止所有已啟動的服務（反向順序，後註冊的先停）。
   */
  stopAll() {
    const entries = [...this._services.entries()].reverse();
    for (const [name, svc] of entries) {
      if (!svc.running) continue;
      try {
        svc.stop();
        svc.running = false;
        console.log(`[service-manager] stopped: ${name}`);
      } catch (err) {
        console.warn(`[service-manager] error stopping ${name}: ${err.message}`);
      }
    }
  }

  /**
   * 回傳所有服務的狀態。
   * @returns {Object<string, {running: boolean, startedAt: string|null, healthy: boolean|null, error: string|null}>}
   */
  status() {
    const result = {};
    for (const [name, svc] of this._services) {
      let healthy = null;
      if (svc.running && svc.healthCheck) {
        try {
          healthy = !!svc.healthCheck();
        } catch {
          healthy = false;
        }
      }
      result[name] = {
        running: svc.running,
        startedAt: svc.startedAt,
        healthy,
        error: svc.error,
      };
    }
    return result;
  }
}

function createServiceManager() {
  return new ServiceManager();
}

module.exports = { createServiceManager };
