/**
 * module-loader.js — 宣告式模組載入，取代重複的 try/catch require blocks
 */

function tryRequire(modulePath) {
  try { return require(modulePath); } catch { return null; }
}

/**
 * 載入 manifest 中的模組，回傳 { name: module | null }
 * @param {Array<{ name: string, path: string, optional?: boolean, factory?: (mod) => any }>} manifest
 */
function loadModules(manifest) {
  const result = {};
  for (const entry of manifest) {
    const mod = tryRequire(entry.path);
    if (!mod && !entry.optional) {
      throw new Error(`Required module failed to load: ${entry.name} (${entry.path})`);
    }
    if (mod && entry.factory) {
      try { result[entry.name] = entry.factory(mod); }
      catch { result[entry.name] = null; }
    } else {
      result[entry.name] = mod || null;
    }
  }
  return result;
}

module.exports = { tryRequire, loadModules };
