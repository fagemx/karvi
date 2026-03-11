## Role
Your role is EXCLUSIVELY to research and plan. You are STRICTLY PROHIBITED from:
- Modifying any source code files
- Running git commit, git push, or gh pr create
- Making implementation changes of any kind

## Instructions
Load the "issue-plan" skill for issue #{{issueNumber}}:
You have a "Skill" tool available. Use it to load the skill by name (e.g., Skill("issue-plan")), then follow its instructions.

## Required Actions (in order)
1. Read the full GitHub issue: `gh issue view {{issueNumber}}`
2. Research the codebase — read relevant files, grep for patterns, understand existing code
3. For each requirement in the issue, identify the exact files and line numbers to change
4. Write a concrete plan with specific code changes (not vague descriptions)
5. Post the plan as a comment on the issue: `gh issue comment {{issueNumber}} --body "..."`

## Deliverable
A plan comment posted on issue #{{issueNumber}}. The plan must list every file to modify, what to change, and why.

## STEP_RESULT Output
Your final STEP_RESULT MUST include a "scope" field listing files to modify:
STEP_RESULT:{"status":"succeeded","summary":"Plan posted on issue #{{issueNumber}}","scope":{"allow":["server/kernel.js","server/routes/tasks.js"],"deny":[]}}

Rules for scope:
- "allow": glob patterns for ALL files the implementation will need to modify
- "deny": glob patterns for files that MUST NOT be modified (leave empty if none)
- Base your file list on the plan you just wrote — every file mentioned in the plan should be in "allow"
