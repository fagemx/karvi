---
name: code-quality
description: Deep code review and quality analysis for the karvi JavaScript project
context: fork
---

# Code Quality Specialist

You are a code quality specialist for the karvi project. Your role is to perform comprehensive code reviews and clean up code quality issues in JavaScript code.

## Operations

This skill supports two operations:

1. **review** - Comprehensive code review with bad smell detection
2. **cleanup** - Remove unnecessary code, fix quality issues

Parse the operation from the `args` parameter:
- `review <pr-id|commit-id|description>` - Review code changes
- `cleanup` - Clean up code quality issues

## Operation 1: Code Review

Perform comprehensive code reviews that analyze commits and generate detailed reports.

### Usage Examples

```
review 123                           # Review PR #123
review abc123..def456               # Review commit range
review abc123                       # Review single commit
review "dispatch changes"           # Review by description
```

### Workflow

1. **Parse Input and Determine Review Scope**
   - If input is a PR number (digits only), fetch commits from GitHub PR
   - If input is a commit range (contains `..`), use git rev-list
   - If input is a single commit hash, review just that commit
   - If input is natural language, review commits from the last week

2. **Create Review Directory Structure**
   - Create directory: `codereviews/YYYYMMDD` (based on current date)
   - All review files will be stored in this directory

3. **Generate Commit List**
   - Create `codereviews/YYYYMMDD/commit-list.md` with checkboxes for each commit
   - Include commit metadata: hash, subject, author, date
   - Add review criteria section

4. **Review Each Commit Against Bad Smells**
   - For each commit, analyze code changes against all code quality issues
   - Create individual review file: `codereviews/YYYYMMDD/review-{short-hash}.md`

5. **Review Criteria (Bad Smell Analysis)**

   Analyze each commit for these JavaScript code quality issues:

   **Testing Patterns** (refer to `.claude/skills/testing/SKILL.md`)
   - Check for proper integration test coverage
   - Verify tests use real HTTP calls (not mocked server internals)
   - Verify tests validate board.json state changes
   - Check test quality and completeness

   **Error Handling (Bad Smell #1)**
   - Identify silently swallowed errors (empty `catch {}`)
   - Flag `console.error` + return null patterns (should propagate)
   - Identify catch-and-rethrow without transformation
   - Flag returning `undefined` on error instead of throwing
   - Suggest letting errors propagate to HTTP handler boundary

   **External Dependencies (Bad Smell #2)**
   - Flag any `require()` of non-built-in modules
   - Zero external dependency is a hard constraint
   - Verify only `http`, `fs`, `path`, `child_process`, `os`, `url`, `crypto` etc.
   - Zero tolerance for npm packages

   **Dead Code (Bad Smell #3)**
   - Identify commented-out code blocks
   - Flag unused functions, variables, and parameters
   - Check for unreachable code after return/throw
   - Flag `// TODO` and `// FIXME` that have been there for weeks

   **Data Structure Violations (Bad Smell #4)**
   - Flag magic strings for task statuses, event types
   - Flag loose object literals that should use factory functions
   - Flag inconsistent field naming across similar objects
   - Verify board.json schema is respected

   **Unsafe Operations (Bad Smell #5)**
   - Flag `eval()` or `Function()` constructor usage
   - Flag `JSON.parse()` without try/catch on external input
   - Flag `child_process.exec()` with unsanitized input
   - Flag `fs` operations without path validation on user input

   **Console.log Pollution (Bad Smell #6)**
   - Flag debug `console.log` left in production code
   - Distinguish from intentional logging (server start, errors)
   - Flag `console.warn` / `console.error` used for flow control

   **Panic-prone Code (Bad Smell #7)**
   - Flag accessing array indices without bounds checking on external data
   - Flag `JSON.parse()` on unvalidated input without try/catch
   - Flag property access chains without null checks on external data
   - Exception: internal data (board.json we control) can be trusted

   **Hardcoded Configuration (Bad Smell #8)**
   - Flag hardcoded ports, URLs, timeouts
   - Verify configurable values use environment variables or constants
   - Check for hardcoded secrets or API keys

   **Non-Atomic Writes (Bad Smell #9)**
   - Flag direct `fs.writeFileSync(boardPath, ...)` without temp+rename
   - board.json must use atomic write pattern (write tmp → rename)
   - Flag concurrent read-modify-write without locking consideration

   **Over-Engineering (Bad Smell #10)**
   - Flag classes where plain functions suffice
   - Flag abstractions with only one user
   - Flag config objects where 80% of fields are unused
   - Flag premature abstractions (YAGNI violations)

   **Callback/Promise Anti-Patterns (Bad Smell #11)**
   - Flag unhandled promise rejections
   - Flag callback hell (>3 nesting levels)
   - Flag mixing callback and promise patterns
   - Flag `async` functions that never `await`

   **Windows Compatibility (Bad Smell #12)**
   - Flag `child_process.spawn` without Windows-compatible command wrapping
   - Verify Windows uses `cmd.exe /d /s /c` pattern for spawning
   - Flag hardcoded Unix paths (`/tmp/` instead of `os.tmpdir()`)
   - Flag Unix-only shell syntax in spawn commands

   **Test Quality (Bad Smell #13)**
   - Flag tests that only check HTTP status without verifying body
   - Flag tests that don't clean up state (leftover board.json modifications)
   - Flag tests without meaningful assertions
   - Verify tests cover error paths, not just happy paths

   **Import Organization (Bad Smell #14)**
   - Flag unused `require()` calls
   - Check `require()` grouping (built-in → local files)
   - Flag dynamic requires that could be static

6. **Generate Review Files**

   Create individual review file for each commit with this structure:

   ```markdown
   # Code Review: {short-hash}

   ## Commit Information
   **Hash:** `{full-hash}`
   **Subject:** {commit-subject}
   **Author:** {author-name} <{author-email}>
   **Date:** {commit-date}

   ## Changes Summary
   ```diff
   {git show --stat output}
   ```

   ## Bad Smell Analysis

   ### 1. Error Handling (#1, #5)
   - Silent swallowing: [locations]
   - Unsafe operations: [locations]
   - Assessment: [detailed analysis]

   ### 2. Data Structures (#4)
   - Magic strings: [locations]
   - Inconsistent schemas: [locations]
   - Recommendations: [improvements]

   ### 3. Code Quality (#3, #6, #9, #10)
   - Dead code: [locations]
   - Console.log pollution: [locations]
   - Non-atomic writes: [locations]
   - Over-engineering: [locations]

   ### 4. Safety (#2, #7, #12)
   - External dependencies: [locations]
   - Panic-prone code: [locations]
   - Windows compatibility: [locations]

   ### 5. Async & IO (#11, #9)
   - Promise anti-patterns: [locations]
   - Non-atomic writes: [locations]
   - Recommendations: [improvements]

   ### 6. Test Quality (#13)
   - Test files modified: [list]
   - Quality assessment: [analysis]
   - Missing scenarios: [list]

   ### 7. Import & Style (#14)
   - Unused requires: [locations]
   - Organization issues: [locations]

   ## Files Changed
   {list of files}

   ## Recommendations
   - [Specific actionable recommendations]
   - [Highlight concerns]
   - [Note positive aspects]

   ---
   *Review completed on: {date}*
   ```

7. **Update Commit List with Links**
   - Replace checkboxes with links to review files
   - Mark commits as reviewed with [x]

8. **Generate Summary**

   Add summary section to commit-list.md:

   ```markdown
   ## Review Summary

   **Total Commits Reviewed:** {count}

   ### Key Findings by Category

   #### Critical Issues (Fix Required)
   - [List P0 issues found across commits]

   #### High Priority Issues
   - [List P1 issues found across commits]

   #### Medium Priority Issues
   - [List P2 issues found across commits]

   ### Bad Smell Statistics
   - Error handling issues: {count}
   - External dependencies: {count}
   - Dead code: {count}
   - Data structure violations: {count}
   - Unsafe operations: {count}
   - Console.log pollution: {count}
   - Non-atomic writes: {count}
   - [etc for all 14 categories]

   ### Architecture & Design
   - Adherence to YAGNI: [assessment]
   - Error propagation quality: [assessment]
   - Zero-dependency compliance: [assessment]
   - Over-engineering concerns: [list]
   - Good design decisions: [list]

   ### Action Items
   - [ ] Priority fixes (P0): [list with file:line references]
   - [ ] Suggested improvements (P1): [list]
   - [ ] Follow-up tasks (P2): [list]
   ```

9. **Final Output**
   - Display summary of review findings
   - Provide path to review directory
   - Highlight critical issues requiring immediate attention

### Implementation Notes for Review Operation

- Use `gh pr view {pr-id} --json commits --jq '.commits[].oid'` to fetch PR commits
- Use `git rev-list {range} --reverse` for commit ranges
- Use `git log --since="1 week ago" --pretty=format:"%H"` for natural language
- Use `git show --stat {commit}` for change summary
- Use `git show {commit}` to analyze actual code changes
- Generate review files in date-based directory structure

## Operation 2: Code Cleanup

Automatically find and fix code quality issues that violate project principles.

### Usage

```
cleanup
```

### Workflow

1. **Search for Code Quality Issues**

   Search in the project root for these patterns:

   **Pattern A: Dead / Commented-Out Code**
   ```javascript
   // Blocks of commented-out code
   // function oldHelper() {
   //   return something;
   // }
   ```

   **Pattern B: Silent Error Swallowing**
   ```javascript
   try {
     doSomething();
   } catch {} // empty catch — hiding real errors
   ```

   **Pattern C: Console.log Leftover**
   ```javascript
   console.log('debug:', someVar);  // debug leftover in production
   ```

   **DO NOT remove** patterns that have:
   - Meaningful error recovery (fallback data, retry logic)
   - Intentional logging (server start, important events, error reporting)
   - Cleanup logic (temp file deletion in finally block)
   - Documentation-style comments that explain WHY

   Target: Find up to 10 fixable issues

2. **Validate Safety**

   For each identified issue, verify:

   - No side effects from removal
   - Not part of error recovery logic
   - Not intentional logging
   - Not security-critical code

   Create summary table:
   ```markdown
   | File | Lines | Pattern | Safe to Fix | Reason |
   |------|-------|---------|-------------|--------|
   | server.js | 45-52 | Commented code | Yes | Dead feature removed 3 weeks ago |
   | ... | ... | ... | ... | ... |
   ```

3. **Modify Code**

   For each validated issue:

   - Remove commented-out code blocks
   - Add meaningful error handling where errors are silently swallowed
   - Remove debug console.log statements
   - Remove dead/unused functions

   Run verification:
   ```bash
   node --check server.js
   node --check management.js
   node --check process-review.js
   node --check retro.js
   npm test
   ```

4. **Create Pull Request**

   - Create feature branch: `refactor/code-cleanup-YYYYMMDD`
   - Commit with conventional commit message:
     ```
     refactor: clean up code quality issues

     Remove commented-out code, fix silent error swallowing,
     and remove debug console.log statements.

     Files modified:
     - server.js (remove dead code block, fix error handling)
     - management.js (remove debug logging)

     All files pass node --check and npm test.
     ```
   - Push and create PR with summary table

5. **Report to User**

   Provide summary report:

   ```markdown
   ## Code Cleanup Summary

   ### Files Modified
   | File | Changes | Pattern Fixed |
   |------|---------|---------------|
   | ... | ... | ... |

   ### Validation Results
   - Issues identified: {count}
   - Issues fixed: {count}
   - Issues skipped: {count} (with reasons)

   ### Verification
   - Syntax check: [PASS/FAIL]
   - Tests: [PASS/FAIL]

   ### PR Link
   https://github.com/fagemx/karvi/pull/...

   ### Next Steps
   - [ ] Merge PR (if approved)
   - [ ] Address review comments (if any)
   ```

### Implementation Notes for Cleanup Operation

- Use Grep to find commented code blocks, empty catch blocks, console.log
- Validate each fix manually before applying
- Test thoroughly after each change
- Create atomic commits for easier review
- Reference CLAUDE.md principles

## General Guidelines

### Code Quality Principles from CLAUDE.md

1. **YAGNI (You Aren't Gonna Need It)**
   - Don't add functionality until needed
   - Start with simplest solution
   - Avoid premature abstractions

2. **Let Errors Propagate**
   - Handle errors at the HTTP handler boundary
   - Don't catch just to log and re-throw
   - Trust internal data structures

3. **Consistent Data Structures**
   - Use constants for enum-like values
   - Factory functions for complex objects
   - Validate at boundaries, trust internally

4. **Zero External Dependencies**
   - Only Node.js built-in modules
   - Never add npm packages
   - This is a hard, non-negotiable constraint

### Review Communication Style

- Be specific and actionable in recommendations
- Reference exact file paths and line numbers
- Cite relevant bad smell categories by number
- Prioritize issues by severity (P0 = critical, P1 = high, P2 = medium)
- Highlight both problems AND good practices
- Use markdown formatting for readability

### Error Handling in Reviews

When encountering errors:
- If GitHub CLI fails, fall back to git commands
- If commit doesn't exist, report and continue with others
- If file is too large, summarize key points
- Always complete the review even if some steps fail

## Example Usage

```
# Review a pull request
args: "review 123"

# Review commit range
args: "review abc123..def456"

# Clean up code quality issues
args: "cleanup"
```

## Output Structure

### For Review Operation
```
codereviews/
└── YYYYMMDD/
    ├── commit-list.md      # Master checklist with summary
    ├── review-abc123.md    # Individual commit review
    ├── review-def456.md    # Individual commit review
    └── ...
```

### For Cleanup Operation
- Branch: `refactor/code-cleanup-YYYYMMDD`
- PR with detailed summary table
- Individual commits for each file modified

## References

- Project principles: `.claude/skills/project-principles/SKILL.md`
- Testing patterns: `.claude/skills/testing/SKILL.md`
- CLAUDE.md project guidelines
- Conventional commits: https://www.conventionalcommits.org/
