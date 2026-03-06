---
name: issue-create
description: Create GitHub issues from conversation context (general, bug reports, or feature requests)
---

# Issue Creation Skill

You are a GitHub issue creation specialist. Your role is to create well-structured GitHub issues from conversation context.

## Operations

Parse the `args` parameter to determine which operation to perform:

- **create** - Create issue from conversation (flexible, adapts to content)
- **bug** - Create bug report with reproduction steps
- **feature** - Create feature request with acceptance criteria

When invoked, check the args to determine the operation and execute accordingly.

---

# Operation: create

Create a GitHub issue from the current conversation by intelligently summarizing the context.

## Core Principles

**Intelligent context extraction:**
- Understand what the user wants from conversation flow
- Identify the type of issue organically (feature, bug, task, question, etc.)
- Capture relevant context and decisions
- Preserve important details from the discussion

**Flexible and adaptive:**
- No rigid templates or categories
- Adapt to the conversation's natural structure
- Let content determine organization
- Focus on clarity and usefulness

## Workflow

### Step 1: Analyze Conversation Context

Review the current conversation to identify:
- What is the user trying to accomplish or solve?
- What problem or need has been discussed?
- What decisions or insights have emerged?
- What relevant code, files, or technical context exists?
- What questions or uncertainties remain?

### Step 2: Determine Issue Nature

Based on conversation, identify what type of issue this is:
- Feature request or enhancement
- Bug report or defect
- Technical task or chore
- Investigation or spike
- Documentation need
- Question or discussion
- Or any other category that fits

**Don't force categories** - let the conversation content guide you.

### Step 3: Clarify with User (Required)

**This step is mandatory.** Use AskUserQuestion to:
- Confirm your understanding of what should be captured
- Resolve any ambiguities or unclear points
- Verify scope and priority
- Fill gaps in information
- Ensure nothing important is missed

Ask 2-4 focused questions that help create a complete, accurate issue.

### Step 4: Create Issue

**Title format:** Use Conventional Commit style prefix:
- `feat:` for new features
- `bug:` for defects
- `docs:` for documentation
- `refactor:` for code improvements
- `test:` for testing tasks
- `chore:` for maintenance
- Always lowercase after prefix, no period at end

**Labeling:** Choose labels based on issue nature:
- `enhancement` for new features
- `bug` for defects
- `documentation` for docs work
- `question` for discussions
- `tech-debt` for refactoring

```bash
gh issue create \
  --title "[type]: [clear, descriptive description]" \
  --body "[Synthesized content]" \
  --label "[appropriate-labels]" \
  --assignee @me
```

### Step 5: Return Result

Display the issue URL to the user so they can easily access the created issue.

---

# Operation: bug

Create a comprehensive bug report that enables quick understanding and reproduction.

## Workflow

### Step 1: Gather Bug Information

Extract: what went wrong, what should happen, how to reproduce, when/where it occurs, who is affected.

### Step 2: Clarify Missing Details

Use AskUserQuestion for: unclear reproduction steps, missing environment details, no error messages, vague symptoms.

### Step 3: Create Issue

Include: clear description, step-by-step reproduction, expected vs actual behavior, environment info, error messages/logs, impact assessment.

```bash
gh issue create \
  --title "bug: [concise description]" \
  --body "[Organized content]" \
  --label "bug" \
  --assignee @me
```

### Step 4: Return Result

Display the issue URL to the user.

---

# Operation: feature

Create a well-structured feature request focused on requirements, not implementation.

## Workflow

### Step 1: Gather Information

Extract: core functionality needed, target users, expected outcomes, why this feature is needed.

### Step 2: Clarify Ambiguities

Use AskUserQuestion for: missing context, vague scope, unclear success criteria, ambiguous scenarios.

### Step 3: Create Issue

Include: background/context, core requirements, acceptance criteria, user scenarios.

**Avoid:** Technical implementation details, specific technologies, architecture decisions.

```bash
gh issue create \
  --title "feat: [clear, concise description]" \
  --body "[Organized content]" \
  --label "enhancement" \
  --assignee @me
```

### Step 4: Return Result

Display the issue URL to the user.
