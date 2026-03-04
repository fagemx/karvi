---
name: project-principles
description: Core architectural and code quality principles that guide all development decisions in the karvi project
---

# Project Principles Skill

This skill defines the fundamental design principles and coding standards for the karvi project. These principles are MANDATORY for all code written in this project and should guide every development decision.

## The Four Core Principles

### 1. YAGNI (You Aren't Gonna Need It) - CORE PRINCIPLE

**Don't add functionality until it's actually needed.**

Quick rules:
- Start with the simplest solution that works
- Avoid premature abstractions
- Delete unused code aggressively
- No "just in case" features

**When coding:** Ask "Do we need this NOW?" If not, don't add it.

> For detailed guidelines and examples, read `yagni.md`

### 2. Proper Error Handling (Not Defensive Programming)

**Let errors propagate naturally. Don't swallow or over-handle errors.**

Quick rules:
- Only handle errors when you can meaningfully recover
- Let errors bubble up with throw — catch at the boundary (HTTP handler level)
- Don't wrap every call in try/catch — handle errors where you can act on them
- Trust the caller to handle errors they receive

**When coding:** Only add explicit error handling when you have specific recovery logic.

> For detailed guidelines and examples, read `no-defensive.md`

### 3. Consistent Data Structures

**Use well-defined objects and clear schemas. Avoid magic strings and loose typing.**

Quick rules:
- Define clear object shapes for all data (board.json schema, API request/response)
- Use constants for status values, event types, and other enums
- Validate external input at system boundaries (API handlers), trust internal data
- Name fields descriptively — `taskId` not `id`, `assigneeAgent` not `agent`

**When coding:** If a domain concept uses a raw string, define it as a constant or schema.

> For detailed guidelines and examples, read `type-safety.md`

### 4. Zero Tolerance for Sloppy Code

**All code must be clean. No dead code, no silenced errors, no sloppy shortcuts.**

Quick rules:
- Never leave commented-out code — git history preserves it
- Never add `// eslint-disable` or equivalent suppressions
- Fix the underlying issue, don't suppress the symptom
- Run `node --check` on all files before committing

**When coding:** If something smells wrong, fix it — don't ignore it.

> For detailed guidelines and examples, read `zero-lint.md`

## Quick Reference: Code Quality Checklist

Before writing any code, verify:
- Is this feature needed NOW? (YAGNI)
- Am I propagating errors properly? (Error Handling)
- Are data structures well-defined with clear schemas? (Data Structures)
- Is the code clean with no dead code or suppressions? (Zero Sloppy)

## When to Load Additional Context

- **Starting a new feature?** Read `yagni.md` first
- **Handling errors?** Read `no-defensive.md`
- **Defining data formats?** Read `type-safety.md`
- **Code smells?** Read `zero-lint.md`

## Integration with Workflow

These principles should be applied:
1. **Before writing code** - Plan with YAGNI in mind
2. **While writing code** - Follow data structure patterns and proper error handling
3. **Before committing** - Ensure clean code with `node --check` on modified files
4. **During code review** - Verify adherence to all principles

## Philosophy

These principles exist to:
- Keep the codebase simple and maintainable
- Prevent technical debt accumulation
- Ensure high code quality
- Make the project easy to understand and modify

They may feel restrictive at first, but they lead to cleaner, more maintainable code.

## Conflict Resolution

If principles seem to conflict:
1. YAGNI takes precedence - simplicity wins
2. Zero external dependencies is non-negotiable
3. When in doubt, choose the simpler solution
