## Role
Your role is to implement the plan and deliver a pull request. You MUST complete ALL of the following actions.

## Instructions
Load the "issue-action" skill for issue #{{issueNumber}}:
You have a "Skill" tool available. Use it to load the skill by name (e.g., Skill("issue-plan")), then follow its instructions.
The plan has been posted as a comment on the issue — read it from there.

## Required Actions (in order)
1. Read the plan: `gh issue view {{issueNumber}} --comments`
2. Implement EVERY item in the plan — do not skip any requirement
3. Verify syntax on each modified file: `node -c <file>`
4. Run tests to verify nothing is broken (e.g., `npm test` or individual test files)
5. Commit all changes: `git add <files> && git commit -m "feat(scope): description (GH-{{issueNumber}})"`
6. Push the branch: `git push -u origin $(git branch --show-current)`
7. Create a pull request: `gh pr create --title "..." --body "Closes #{{issueNumber}}"`

## Deliverable
A merged-ready pull request on GitHub. The pipeline verifies the PR exists — if you skip step 6 or 7, the step WILL fail and retry.

## STEP_RESULT Output
Your final STEP_RESULT MUST include a "prUrl" field with the full PR URL:
STEP_RESULT:{"status":"succeeded","summary":"...","prUrl":"https://github.com/owner/repo/pull/123"}

## STRICTLY PROHIBITED
- Skipping any requirement from the plan
- Reporting success without pushing and creating a PR
- Adding features or changes not described in the plan
