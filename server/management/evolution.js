/**
 * management/evolution.js — Evolution fields, signal trimming, edda decisions, skill context
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const storage = require('../storage');

const DIR = __dirname;

function ensureEvolutionFields(board) {
  if (!Array.isArray(board.signals)) board.signals = [];
  if (!Array.isArray(board.insights)) board.insights = [];
  if (!Array.isArray(board.lessons)) board.lessons = [];
  return board;
}

// --- Signal Retention ---

/**
 * trimSignals — 超過 signal_max_count 的 signals 歸檔到 signal-archive.jsonl，
 * 保留最新的 max 條在 board.signals。
 * @param {object} board - board 物件
 * @param {string} archivePath - signal-archive.jsonl 的絕對路徑
 * @returns {number} 歸檔的 signal 數量
 */
function trimSignals(board, archivePath) {
  // Lazy require to avoid circular — getControls lives in parent
  const { getControls } = require('../management');
  const max = getControls(board).signal_max_count;
  if (!board.signals || board.signals.length <= max) return 0;
  const overflow = board.signals.slice(0, -max);
  board.signals = board.signals.slice(-max);
  if (archivePath) {
    for (const sig of overflow) {
      storage.appendLog(archivePath, sig);
    }
  } else {
    console.warn(`[trimSignals] archivePath is falsy — dropping ${overflow.length} overflow signal(s)`);
  }
  return overflow.length;
}

// --- Edda Decision Injection (Layer 1 of Agent Protection) ---

let _eddaDecisionCache = { ts: 0, decisions: [] };
const EDDA_DECISION_CACHE_TTL_MS = 60_000;

/**
 * Load architectural decisions from edda ledger.
 * Cached for 60s. Graceful degradation if edda not installed.
 * @returns {Array<{ key: string, value: string, reason: string, ts: string }>}
 */
function loadEddaDecisions() {
  const now = Date.now();
  if (now - _eddaDecisionCache.ts < EDDA_DECISION_CACHE_TTL_MS && _eddaDecisionCache.decisions.length > 0) {
    return _eddaDecisionCache.decisions;
  }

  const eddaCmd = process.env.EDDA_CMD;
  if (!eddaCmd) return _eddaDecisionCache.decisions;

  try {
    const cmd = process.platform === 'win32'
      ? `cmd.exe /d /s /c ${eddaCmd} log --tag decision --json --limit 50`
      : `${eddaCmd} log --tag decision --json --limit 50`;

    const raw = execSync(cmd, {
      encoding: 'utf8',
      timeout: 5000,
      cwd: path.resolve(DIR, '..', '..'),
    }).trim();

    if (!raw) { _eddaDecisionCache = { ts: now, decisions: [] }; return []; }

    const decisions = raw.split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          const evt = JSON.parse(line);
          const d = evt.payload?.decision;
          if (!d?.key) return null;
          return { key: d.key, value: d.value, reason: d.reason, ts: evt.ts };
        } catch { return null; }
      })
      .filter(Boolean);

    _eddaDecisionCache = { ts: now, decisions };
    return decisions;
  } catch {
    return _eddaDecisionCache.decisions;
  }
}

/**
 * Build a "PROTECTED DECISIONS" prompt section from edda decisions.
 * Tells agents which architectural choices must not be reverted.
 * @returns {string[]} lines to inject into dispatch prompt
 */
function buildProtectedDecisionsSection() {
  const decisions = loadEddaDecisions();
  if (decisions.length === 0) return [];

  // Filter to infrastructure/architecture decisions (broadly relevant)
  const relevant = decisions.filter(d =>
    /^(dispatch|runtime|step-worker|kernel|route-engine|management|server)\./.test(d.key)
  );
  if (relevant.length === 0) return [];

  const lines = [];
  lines.push('');
  lines.push('## PROTECTED DECISIONS \u2014 do NOT revert these');
  lines.push('The following architectural decisions were made deliberately. Do not change code that implements them:');
  lines.push('');

  let charCount = 0;
  const MAX_CHARS = 2000;

  for (const d of relevant) {
    const line = `- **${d.key}** = ${d.value} \u2014 ${d.reason}`;
    if (charCount + line.length > MAX_CHARS) {
      lines.push('  ... (more decisions omitted)');
      break;
    }
    lines.push(line);
    charCount += line.length;
  }

  lines.push('');
  lines.push('If you encounter code that seems wrong but implements one of these decisions, LEAVE IT ALONE.');

  return lines;
}

/**
 * Build a "Coding Standards" section by extracting key rules from skill files.
 * Cached per projectRoot so skill files are read only once per target project.
 * @param {string} [projectRoot] — target project root; null = karvi itself
 * @returns {string[]} lines to inject into dispatch prompt
 */
function buildSkillContextSection(projectRoot) {
  if (!buildSkillContextSection._cacheMap) {
    buildSkillContextSection._cacheMap = new Map();
  }
  const cacheKey = projectRoot || '__default__';

  if (!buildSkillContextSection._cacheMap.has(cacheKey)) {
    const excerpts = [];

    // Resolve skill directory: project-specific first, then karvi's server/skills/
    const serverDir = path.resolve(DIR, '..');
    const candidates = [];
    if (projectRoot) {
      candidates.push(path.join(projectRoot, '.claude', 'skills'));
      candidates.push(path.join(projectRoot, 'server', 'skills'));
    }
    candidates.push(path.join(serverDir, 'skills'));
    const skillDir = candidates.find(d => fs.existsSync(d)) || path.join(serverDir, 'skills');

    // Extract coding rules from engineer-playbook
    const epPath = path.join(skillDir, 'engineer-playbook', 'SKILL.md');
    if (fs.existsSync(epPath)) {
      const ep = fs.readFileSync(epPath, 'utf8');
      const match = ep.match(/## (?:Step 4|Code Style|代碼規範|coding|執行任務)[\s\S]*?(?=\n## |\n---)/i);
      if (match) excerpts.push(match[0].trim().slice(0, 600));
    }

    // Extract constraints from blackboard-basics
    const bbPath = path.join(skillDir, 'blackboard-basics', 'SKILL.md');
    if (fs.existsSync(bbPath)) {
      const bb = fs.readFileSync(bbPath, 'utf8');
      const match = bb.match(/## (?:設計約束|Design Constraints|6 大約束)[\s\S]*?(?=\n## |\n---)/i);
      if (match) excerpts.push(match[0].trim().slice(0, 400));
    }

    // Extract from project-principles skill (common across projects)
    const ppPath = path.join(skillDir, 'project-principles', 'SKILL.md');
    if (fs.existsSync(ppPath)) {
      const pp = fs.readFileSync(ppPath, 'utf8');
      const match = pp.match(/## (?:Core Principles|核心原則|Architecture)[\s\S]*?(?=\n## |\n---)/i);
      if (match) excerpts.push(match[0].trim().slice(0, 400));
    }

    if (excerpts.length === 0) {
      if (!projectRoot) {
        excerpts.push(
          '- Zero external dependencies (Node.js built-in modules only)\n' +
          '- Atomic file writes (write to .tmp then rename)\n' +
          '- Windows-compatible: spawn via cmd.exe /d /s /c\n' +
          '- board.json is single source of truth — agents do NOT write board directly\n' +
          '- Follow existing code patterns — do NOT invent new ones\n' +
          '- Run node -c <file> on every modified JavaScript file'
        );
      } else {
        excerpts.push(
          '- Follow existing code patterns — do NOT invent new ones\n' +
          '- Atomic file writes (write to .tmp then rename)\n' +
          '- Run syntax checks on every modified file'
        );
      }
    }
    buildSkillContextSection._cacheMap.set(cacheKey, excerpts);
  }

  const lines = ['', '## Coding Standards (from project skills)'];
  for (const excerpt of buildSkillContextSection._cacheMap.get(cacheKey)) {
    lines.push(excerpt);
  }
  return lines;
}

/**
 * Build a "Completion Criteria" section to prevent agents from declaring done prematurely.
 * @returns {string[]} lines to inject into dispatch prompt
 */
function buildCompletionCriteriaSection() {
  return [
    '',
    '## Completion Criteria',
    'Before declaring done, you MUST verify ALL of the following:',
    '1. Re-read the task description — confirm every bullet/numbered item is addressed',
    '2. List each requirement and its implementation status',
    '3. Run `node -c <file>` on every modified JavaScript file to verify syntax',
    '4. If any requirement was skipped, state why explicitly',
    '5. Commit your changes with a descriptive message before finishing',
  ];
}

module.exports = {
  ensureEvolutionFields,
  trimSignals,
  loadEddaDecisions,
  buildProtectedDecisionsSection,
  buildSkillContextSection,
  buildCompletionCriteriaSection,
};
