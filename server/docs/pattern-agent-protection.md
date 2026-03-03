# Pattern: Three-Layer Agent Protection

When autonomous agents modify code (via dispatch, CI, or any automated pipeline), they can inadvertently revert critical fixes or delete important annotations because they lack the context of *why* code was written a certain way.

This pattern prevents that with three independent defense layers.

## Problem

An agent:
1. Sees code that looks "wrong" or "unnecessary" to it
2. Rewrites/reverts it to what it considers "cleaner"
3. Pushes the change, breaking something that was intentionally fixed

Root cause: the agent doesn't know the **decision history** behind the code.

## Architecture

| Layer | Mechanism | What it catches |
|-------|-----------|-----------------|
| 1. Context Injection | Inject decision history into the agent's prompt | Agent doesn't know why code exists |
| 2. Code Annotation | `@protected` comments on critical lines | Agent ignores prompt context |
| 3. Diff Guard | Post-execution validation of protected ranges | Both above fail |

Each layer is independent. Any single layer prevents the damage.

---

## Layer 1: Context Injection

**Concept**: Before dispatching an agent, load relevant architectural decisions and inject them into the prompt as a "do not revert" section.

### Implementation sketch

```
function loadDecisions() {
  // Source: decision log, ADR files, database, or any structured store
  // Return: [{ key, value, reason, timestamp }]
}

function buildProtectionSection(decisions, relevantDomains) {
  const relevant = decisions.filter(d =>
    relevantDomains.some(domain => d.key.startsWith(domain))
  );
  if (!relevant.length) return '';

  const lines = relevant.map(d =>
    `- ${d.key} = ${d.value} — ${d.reason}`
  );
  return [
    '## PROTECTED DECISIONS — do NOT revert these',
    ...lines
  ].join('\n');
}
```

### Integration point
Append the protection section to whatever prompt/message your dispatch system sends to the agent.

### Requirements
- Decision store (ADR files, JSON log, database — anything queryable)
- Domain filtering to keep the section small and relevant
- Budget cap (e.g., 2000 chars) to avoid bloating the prompt
- Graceful degradation if decision store is unavailable

---

## Layer 2: @protected Annotations

**Concept**: Mark critical code lines with a structured comment. Agents that respect annotations will skip them; Layer 3 catches agents that don't.

### Format

Single line:
```javascript
// @protected decision:auth.jwt-rotation — tokens must rotate every 24h per compliance
const TOKEN_TTL = 86400;
```

Multi-line block:
```javascript
// @protected decision:db.connection-pool — pool size tuned for 100 concurrent users
const pool = createPool({
  min: 5,
  max: 20,
  idleTimeout: 30000,
});
// @end-protected
```

### Comment style support
```javascript
// @protected ...          // JavaScript, TypeScript, Go, Rust, C
# @protected ...           // Python, Ruby, Shell, YAML
/* @protected ... */       // CSS, multi-line JS
-- @protected ...          // SQL
```

### Parser

```
function parseProtectedAnnotations(content) {
  const annotations = [];
  const lines = content.split('\n');
  const pattern = /(?:\/\/|#|\/\*|--)\s*@protected\s+decision:(\S+)\s*(?:—|-)\s*(.+?)$/;
  const endPattern = /(?:\/\/|#|\/\*|--)\s*@end-protected/;

  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (match) {
      current = { startLine: i + 1, key: match[1], reason: match[2].trim() };
    }
    if (current) {
      const end = lines[i].match(endPattern);
      if (end || (!lines[i + 1]?.match(pattern) && !current.multiline)) {
        current.endLine = end ? i + 1 : current.startLine + 1;
        annotations.push({ ...current });
        current = current.multiline ? null : current;
        if (!end && !lines[i].match(endPattern)) {
          current = null;
        }
      }
    }
  }
  return annotations;  // [{ startLine, endLine, key, reason }]
}
```

---

## Layer 3: Diff Guard

**Concept**: After the agent finishes, validate that no protected line ranges were modified. If violated, reject the change.

### Algorithm

```
function validateProtectedDiff(workDir) {
  // 1. Detect what changed
  const modifiedFiles = git('diff', '--name-only', base);

  // 2. For each modified file, get the ORIGINAL content
  const originalContent = git('show', `${base}:${file}`);

  // 3. Parse @protected annotations from original
  const annotations = parseProtectedAnnotations(originalContent);
  if (!annotations.length) continue;  // no protected code in this file

  // 4. Parse the unified diff to find which original lines changed
  const diff = git('diff', base, '--', file);
  const modifiedLines = parseModifiedOriginalLines(diff);

  // 5. Cross-check: did any modified line fall in a protected range?
  for (const ann of annotations) {
    for (let line = ann.startLine; line <= ann.endLine; line++) {
      if (modifiedLines.has(line)) {
        violations.push({
          file, line, key: ann.key, reason: ann.reason
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
```

### On violation

Choose a response appropriate to your system:
- **Reject**: mark the step/task as failed with a specific failure mode
- **Revert**: `git revert --no-edit HEAD` if already committed
- **Alert**: notify a human reviewer
- **Retry**: re-dispatch with stronger instructions

### Remediation limits
Set a max retry count for protection violations (e.g., 2 attempts). If the agent keeps violating after retries, escalate to human review.

---

## Adoption Checklist

1. **Pick your decision store** — ADR files, JSON log, database, or a tool like edda
2. **Identify critical code** — lines that have been reverted before, or encode non-obvious constraints
3. **Add `@protected` annotations** to those lines
4. **Wire Layer 1** into your dispatch/prompt pipeline
5. **Wire Layer 3** into your post-execution validation
6. **Define failure response** — reject, revert, alert, or retry
7. **Test** — create a temp repo, protect a line, simulate a violation

## Trade-offs

| Pro | Con |
|-----|-----|
| Each layer is independent — defense in depth | Annotation overhead on developers |
| Works with any agent (LLM-agnostic) | Diff guard adds latency to post-check |
| No agent modification needed | Protected annotations can become stale |
| Graceful degradation at every layer | Over-protection can block legitimate refactors |

## When NOT to use this

- Code that changes frequently (annotations become noise)
- Teams where agents don't push directly (human review is sufficient)
- Trivial code with no non-obvious constraints
