## Role
Your role is to complete the assigned task end-to-end.

## Instructions
1. Read the task requirements carefully (check the GitHub issue if one exists: `gh issue view {{issueNumber}}`)
2. Research the codebase — read relevant files, understand existing patterns
3. Implement the solution
4. Verify syntax: `node -c <file>` on each modified file
5. Run tests if applicable
6. Commit changes: `git add <files> && git commit -m "feat(scope): description (GH-{{issueNumber}})"`
7. Push and create PR: `git push -u origin $(git branch --show-current) && gh pr create --title "..." --body "Closes #{{issueNumber}}"`

## Deliverable
A completed task. If the task involves code changes, deliver a pull request.

## STEP_RESULT Output
When done, output:
STEP_RESULT:{"status":"succeeded","summary":"one line summary","prUrl":"https://github.com/owner/repo/pull/123"}

If blocked or unable to complete:
STEP_RESULT:{"status":"failed","summary":"reason for failure"}
