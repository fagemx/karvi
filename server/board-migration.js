/**
 * board-migration.js — Centralized board schema migration
 *
 * All board schema changes go through this module.
 * Each migration is idempotent: running twice produces the same result.
 */

/**
 * Migration: ensure board.signals exists as an array
 */
function migrateEnsureSignals(board) {
  if (!Array.isArray(board.signals)) {
    board.signals = [];
    return true;
  }
  return false;
}

/**
 * Migration: ensure board.insights exists as an array
 */
function migrateEnsureInsights(board) {
  if (!Array.isArray(board.insights)) {
    board.insights = [];
    return true;
  }
  return false;
}

/**
 * Migration: ensure board.lessons exists as an array
 */
function migrateEnsureLessons(board) {
  if (!Array.isArray(board.lessons)) {
    board.lessons = [];
    return true;
  }
  return false;
}

/**
 * Migration: ensure board.projects exists as an array
 */
function migrateEnsureProjects(board) {
  if (!Array.isArray(board.projects)) {
    board.projects = [];
    return true;
  }
  return false;
}

/**
 * Migration: ensure board.village exists via villageRoutes.ensureVillage
 */
function migrateEnsureVillage(board, deps) {
  if (!board.village) {
    deps.villageRoutes.ensureVillage(board);
    return true;
  }
  return false;
}

/**
 * Migration: ensure village governance fields exist (#165)
 */
function migrateEnsureVillageGovernance(board) {
  if (!board.village) return false;
  let changed = false;
  if (!Array.isArray(board.village.pending_questions)) {
    board.village.pending_questions = [];
    changed = true;
  }
  if (!Array.isArray(board.village.command_history)) {
    board.village.command_history = [];
    changed = true;
  }
  return changed;
}

/**
 * Migration: recover expired step locks
 */
function migrateRecoverExpiredLocks(board, deps) {
  const recovered = deps.recoverExpiredLocks(board);
  return recovered > 0;
}

/**
 * All migrations in order of execution.
 * Each entry: { name, fn }
 * fn(board, deps) -> boolean (true if migration was applied)
 */
const MIGRATIONS = [
  { name: 'ensure-signals', fn: migrateEnsureSignals },
  { name: 'ensure-insights', fn: migrateEnsureInsights },
  { name: 'ensure-lessons', fn: migrateEnsureLessons },
  { name: 'ensure-projects', fn: migrateEnsureProjects },
  { name: 'ensure-village', fn: migrateEnsureVillage },
  { name: 'ensure-village-governance', fn: migrateEnsureVillageGovernance },
  { name: 'recover-expired-locks', fn: migrateRecoverExpiredLocks },
];

/**
 * Run all migrations on a board.
 *
 * @param {Object} board - The board object to migrate (mutated in place)
 * @param {Object} deps - Dependencies: { villageRoutes, recoverExpiredLocks }
 * @returns {{ dirty: boolean, applied: string[] }}
 */
function migrateBoard(board, deps) {
  const applied = [];
  let dirty = false;

  for (const { name, fn } of MIGRATIONS) {
    const changed = fn(board, deps);
    if (changed) {
      applied.push(name);
      dirty = true;
    }
  }

  return { dirty, applied };
}

module.exports = {
  migrateBoard,
  MIGRATIONS,
};
