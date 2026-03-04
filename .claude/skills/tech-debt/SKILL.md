---
name: tech-debt
description: Technical debt management - scan JavaScript codebase for bad smells and create tracking issues
context: fork
---

# Technical Debt Management Skill

You are a technical debt management specialist for the karvi project. Your role is to scan the JavaScript codebase for code quality issues and help track technical debt systematically.

## Operations

This skill supports two operations:

1. **research** - Fast scan to locate suspicious files and detailed analysis
2. **issue** - Create GitHub issue based on research findings

Parse the operation from the `args` parameter:
- `research` - Scan codebase and generate detailed report
- `issue` - Create GitHub issue from research results (auto-runs research if not done)

## Operation 1: Research

Perform a comprehensive scan of the codebase to identify technical debt using fast pattern matching followed by detailed analysis.

### Workflow

#### Phase 1: Fast Scan

Use fast pattern matching to locate suspicious files. Search in the project root for:

**1. Large Files (>500 lines)**
```bash
find . -type f -name "*.js" -not -path "*/node_modules/*" -not -path "*/.git/*" -exec wc -l {} + | awk '$1 > 500 {print $1, $2}' | sort -rn
```

**2. TODO/FIXME/HACK Comments**
```bash
grep -rn "TODO\|FIXME\|HACK\|XXX\|STUB" --include="*.js" --exclude-dir=node_modules
```

**3. Console.log in Production Code**
```bash
grep -rn "console\.log\|console\.warn\|console\.error" --include="*.js" --exclude-dir=node_modules | grep -v "test\|smoke"
```

**4. Hardcoded Values**
```bash
grep -rn "localhost\|127\.0\.0\.1\|:3461\|:3460\|:3456" --include="*.js" --exclude-dir=node_modules | grep -v "test\|README"
```

**5. Error Swallowing (empty catch blocks)**
```bash
grep -rn "catch\s*(" --include="*.js" --exclude-dir=node_modules -A 2 | grep -B 1 "}"
```

**6. Long Functions (complex logic blocks)**
```bash
# Files with deep nesting (proxy for complexity)
grep -rn "                    " --include="*.js" -l --exclude-dir=node_modules
```

**7. Duplicated Code Patterns**
```bash
# Look for repeated patterns across files
grep -rn "fs\.writeFileSync\|fs\.readFileSync" --include="*.js" --exclude-dir=node_modules
```

**8. Missing Error Handling in HTTP Handlers**
```bash
grep -rn "res\.end\|res\.writeHead" --include="*.js" --exclude-dir=node_modules | grep -v "catch\|try\|error"
```

#### Phase 2: Detailed Analysis

For each file identified in Phase 1, perform detailed analysis:

1. **Read the full file content**
2. **Categorize issues** by bad smell type
3. **Calculate severity** (Critical/High/Medium/Low)
4. **Identify specific violations** with line numbers
5. **Suggest remediation** strategies

**Severity Levels:**
- **Critical (P0)**: Zero-tolerance violations
  - Error swallowing (empty catch blocks in request handlers)
  - Missing atomic writes to board.json
  - External dependency added (violates zero-dep constraint)
- **High (P1)**: Significant issues
  - Files >800 lines (needs splitting)
  - Hardcoded config that should be configurable
  - Missing error handling in API endpoints
- **Medium (P2)**: Issues that should be addressed
  - Files >500 lines
  - TODO/FIXME comments
  - console.log in production code
- **Low (P3)**: Minor issues or code smells
  - Deep nesting (>4 levels)
  - Inconsistent naming
  - Missing JSDoc on public functions

#### Phase 3: Generate Report

Create detailed report in `/tmp/tech-debt-YYYYMMDD/`

#### Phase 4: User Report

Provide a medium-detail summary to the user with findings by severity.

---

## Operation 2: Issue

Create a GitHub issue based on research findings. If research hasn't been run, automatically run it first.

### Workflow

#### Step 1: Check for Existing Research

```bash
LATEST_REPORT=$(ls -td /tmp/tech-debt-* 2>/dev/null | head -1)
```

#### Step 2: Create GitHub Issue

```bash
gh issue create \
  --repo fagemx/karvi \
  --title "[Tech Debt] Codebase Quality Scan - $(date +%Y-%m-%d)" \
  --body-file /tmp/tech-debt-{date}/github-issue-body.md \
  --label "tech-debt,quality,refactoring"
```

Use `<details>` sections for long content. Split into comments if exceeding 65K character limit.

---

## General Guidelines

### Scanning Principles

1. **Comprehensive Coverage** - Scan all .js files
2. **Efficient Execution** - Use fast pattern matching first, only read files that match
3. **Accurate Analysis** - Read full file content for matched files, verify patterns in context
4. **Actionable Reporting** - Provide specific file paths, line numbers, and remediation steps

### Karvi-Specific Quality Standards

**Zero Tolerance (P0):**
- External `require()` calls (zero-dep constraint)
- Non-atomic board.json writes
- Error swallowing in API handlers

**High Priority (P1):**
- Files >800 lines (server.js may already be there — track, don't panic)
- Missing error handling on HTTP endpoints
- Hardcoded configuration

**Medium Priority (P2):**
- Files >500 lines
- TODO/FIXME comments
- Excessive console.log

---

## References

- Code quality skill: `.claude/skills/code-quality/SKILL.md`
- Project principles: `.claude/skills/project-principles/SKILL.md`
