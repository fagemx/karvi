'use strict';
/**
 * _semver.js — Lightweight semver utilities (zero external dependencies)
 *
 * Supports basic semver comparison and validation.
 * Format: MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]
 */

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/;

function parse(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(SEMVER_REGEX);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    build: match[5] || null,
  };
}

function valid(version) {
  return parse(version) !== null;
}

function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) {
    const pra = pa.prerelease.split('.');
    const prb = pb.prerelease.split('.');
    for (let i = 0; i < Math.max(pra.length, prb.length); i++) {
      const va = pra[i];
      const vb = prb[i];
      if (va === undefined) return -1;
      if (vb === undefined) return 1;
      const na = /^\d+$/.test(va) ? parseInt(va, 10) : va;
      const nb = /^\d+$/.test(vb) ? parseInt(vb, 10) : vb;
      if (typeof na === 'number' && typeof nb === 'string') return -1;
      if (typeof na === 'string' && typeof nb === 'number') return 1;
      if (na < nb) return -1;
      if (na > nb) return 1;
    }
  }

  return 0;
}

function gt(a, b) { return compare(a, b) > 0; }
function gte(a, b) { return compare(a, b) >= 0; }
function lt(a, b) { return compare(a, b) < 0; }
function lte(a, b) { return compare(a, b) <= 0; }
function eq(a, b) { return compare(a, b) === 0; }
function neq(a, b) { return compare(a, b) !== 0; }

function inc(version, release) {
  const p = parse(version);
  if (!p) return null;
  switch (release) {
    case 'major': return `${p.major + 1}.0.0`;
    case 'minor': return `${p.major}.${p.minor + 1}.0`;
    case 'patch': return `${p.major}.${p.minor}.${p.patch + 1}`;
    default: return null;
  }
}

function satisfies(version, range) {
  const trimmed = range.trim();
  const operatorMatch = trimmed.match(/^([<>=!]+)/);
  const operator = operatorMatch?.[1] || '';
  const cleanRange = trimmed.replace(/^[<>=!^~]+/, '');
  const cmp = compare(version, cleanRange);
  switch (operator) {
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '=':
    case '==': return cmp === 0;
    case '!=': return cmp !== 0;
    default:
      if (range.startsWith('^')) {
        const p = parse(cleanRange);
        if (!p) return false;
        return gte(version, cleanRange) && parse(version).major === p.major;
      }
      if (range.startsWith('~')) {
        const p = parse(cleanRange);
        if (!p) return false;
        return gte(version, cleanRange) &&
               parse(version).major === p.major &&
               parse(version).minor === p.minor;
      }
      return cmp === 0;
  }
}

module.exports = {
  parse,
  valid,
  compare,
  gt,
  gte,
  lt,
  lte,
  eq,
  neq,
  inc,
  satisfies,
};
