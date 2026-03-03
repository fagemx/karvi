/**
 * protected-diff-guard.js — Layer 2+3 of Agent Protection System
 *
 * Layer 2: Parse @protected annotations from source files.
 * Layer 3: Validate git diffs against protected regions — block unauthorized reverts.
 *
 * Annotation format:
 *   // @protected decision:<key> — <reason>
 *   <protected line(s)>
 *
 * Multi-line block:
 *   // @protected decision:<key> — <reason>
 *   <line1>
 *   <line2>
 *   // @end-protected
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Matches: // @protected decision:<key> — <reason>
// Also:    # @protected ...   or   /* @protected ... */
const PROTECTED_RE = /(?:\/\/|#|\/\*)\s*@protected\s+decision:(\S+)\s*(?:\u2014|-)\s*(.+?)(?:\s*\*\/)?$/;
const END_RE = /(?:\/\/|#|\/\*)\s*@end-protected/;

/**
 * Parse @protected annotations from file content string.
 *
 * Each annotation protects lines until @end-protected or the next
 * non-empty, non-comment line (whichever comes first).
 *
 * @param {string} content - File content
 * @returns {Array<{ startLine: number, endLine: number, key: string, reason: string }>}
 *   Lines are 1-indexed.
 */
function parseProtectedAnnotationsFromContent(content) {
  if (!content) return [];
  const lines = content.split('\n');
  const annotations = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(PROTECTED_RE);
    if (!match) continue;

    const key = match[1];
    const reason = match[2].trim();
    const startLine = i + 1; // 1-indexed (the annotation line itself)

    // First scan for @end-protected (explicit block marker takes priority)
    let endLine = startLine;
    let foundEndMarker = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (END_RE.test(lines[j])) {
        endLine = j + 1; // include the @end-protected line
        foundEndMarker = true;
        break;
      }
    }
    // If no @end-protected, protect until the next substantive (non-comment) line
    if (!foundEndMarker) {
      for (let j = i + 1; j < lines.length; j++) {
        const trimmed = lines[j].trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
          continue;
        }
        endLine = j + 1; // 1-indexed
        break;
      }
    }

    annotations.push({ startLine, endLine, key, reason });
  }

  return annotations;
}

/**
 * Parse @protected annotations from a file on disk.
 * @param {string} filePath - Absolute path
 */
function parseProtectedAnnotations(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseProtectedAnnotationsFromContent(content);
  } catch {
    return [];
  }
}

/**
 * Parse a unified diff to extract which original-file line numbers were modified/deleted.
 *
 * Reads @@ hunk headers and counts '-' lines (removed from original).
 * @param {string} unifiedDiff - Output of `git diff`
 * @returns {Set<number>} 1-indexed line numbers from the original that were changed/deleted
 */
function parseModifiedOriginalLines(unifiedDiff) {
  const modified = new Set();
  const lines = unifiedDiff.split('\n');
  let origLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -origStart,origCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+/);
    if (hunkMatch) {
      origLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (origLine === 0) continue; // before first hunk (file header)

    if (line.startsWith('-')) {
      modified.add(origLine);
      origLine++;
    } else if (line.startsWith('+')) {
      // Added line — no original line number to track
    } else if (line.startsWith(' ') || line === '') {
      // Context line
      origLine++;
    }
    // Skip \ No newline at end of file, etc.
  }

  return modified;
}

/**
 * Extract a short snippet from unified diff around a target original line number.
 */
function extractDiffSnippet(unifiedDiff, targetLine) {
  const lines = unifiedDiff.split('\n');
  let origLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const hunkMatch = lines[i].match(/^@@ -(\d+)/);
    if (hunkMatch) {
      origLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (lines[i].startsWith('-') || lines[i].startsWith(' ')) {
      if (origLine === targetLine) {
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        return lines.slice(start, end).join('\n');
      }
      origLine++;
    }
  }
  return '(diff snippet not found)';
}

/**
 * Validate that a git working tree's diff doesn't violate @protected annotations.
 *
 * Strategy:
 *   1. Detect whether changes are committed or uncommitted
 *   2. Get list of modified files
 *   3. For each, parse @protected from the ORIGINAL version
 *   4. Cross-check modified lines against protected ranges
 *
 * @param {string} workDir - Working directory (worktree or repo root)
 * @returns {{ ok: boolean, violations: Array<{ file: string, line: number, key: string, reason: string, diff: string }> }}
 */
function validateProtectedDiff(workDir) {
  if (!workDir) return { ok: true, violations: [] };

  const opts = { cwd: workDir, encoding: 'utf8', timeout: 15000 };

  try {
    // Determine diff base: if no uncommitted changes → compare HEAD~1..HEAD
    // If uncommitted → compare HEAD..working tree
    let diffBase = 'HEAD';
    let diffTarget = ''; // empty = working tree
    try {
      const porcelain = execSync('git status --porcelain', opts).trim();
      if (!porcelain) {
        // Everything committed — diff against parent
        diffBase = 'HEAD~1';
        diffTarget = 'HEAD';
      }
    } catch {
      return { ok: true, violations: [] }; // not a git repo
    }

    // Get modified files
    const diffCmd = diffTarget
      ? `git diff ${diffBase} ${diffTarget} --name-only`
      : `git diff ${diffBase} --name-only`;
    const modifiedFiles = execSync(diffCmd, opts).trim().split('\n').filter(Boolean);
    if (modifiedFiles.length === 0) return { ok: true, violations: [] };

    const violations = [];

    for (const file of modifiedFiles) {
      // Get original version's content to find @protected annotations
      let originalContent;
      try {
        originalContent = execSync(`git show ${diffBase}:${file}`, opts);
      } catch {
        continue; // new file — no protected annotations to check
      }

      const annotations = parseProtectedAnnotationsFromContent(originalContent);
      if (annotations.length === 0) continue;

      // Get unified diff for this specific file
      const fileDiffCmd = diffTarget
        ? `git diff ${diffBase} ${diffTarget} -- "${file}"`
        : `git diff ${diffBase} -- "${file}"`;
      let unifiedDiff;
      try {
        unifiedDiff = execSync(fileDiffCmd, opts);
      } catch {
        continue;
      }

      const modifiedLines = parseModifiedOriginalLines(unifiedDiff);

      // Check for overlap between modified lines and protected ranges
      for (const ann of annotations) {
        for (let line = ann.startLine; line <= ann.endLine; line++) {
          if (modifiedLines.has(line)) {
            violations.push({
              file,
              line,
              key: ann.key,
              reason: ann.reason,
              diff: extractDiffSnippet(unifiedDiff, line),
            });
            break; // one violation per annotation is enough
          }
        }
      }
    }

    return { ok: violations.length === 0, violations };
  } catch (err) {
    // Don't block on guard errors — fail open, log warning
    console.error('[protected-diff-guard] error:', err.message);
    return { ok: true, violations: [] };
  }
}

module.exports = {
  parseProtectedAnnotations,
  parseProtectedAnnotationsFromContent,
  parseModifiedOriginalLines,
  extractDiffSnippet,
  validateProtectedDiff,
};
