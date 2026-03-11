---
name: dispatch
description: Dispatch tasks to Karvi with correct runtime, provider, and model configuration
---

# Task Dispatch Skill

You are a Karvi dispatch specialist. Use this skill to dispatch GitHub issues as tasks to Karvi's execution engine.

## Quick Reference

### CLI Dispatch (recommended)

```bash
# Basic — uses server's default runtime and model
npm run go -- <issue-number>

# Specify runtime
npm run go -- <issue> --runtime opencode
npm run go -- <issue> --runtime codex

# Specify runtime + model (overrides all defaults)
npm run go -- <issue> --runtime opencode --model <provider-id>/<model-id>

# Cross-project dispatch
npm run go -- <issue> --repo C:\path\to\other\project

# Multiple issues
npm run go -- 100 101 102

# Skip confirmation
npm run go -- <issue> -y
```

### curl Dispatch

```bash
curl -X POST http://localhost:3461/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "title": "GH-XXX: task title",
    "tasks": [{
      "id": "GH-XXX",
      "title": "feat(scope): description",
      "assignee": "engineer_lite",
      "runtimeHint": "opencode",
      "modelHint": "provider-id/model-id",
      "description": "Implement GitHub issue #XXX. See https://github.com/owner/repo/issues/XXX"
    }]
  }'
```

## Runtimes

| Runtime | Tool | Best for | Sandbox |
|---------|------|----------|---------|
| `opencode` | opencode CLI | Flexible, supports custom providers | No sandbox |
| `codex` | Codex CLI | OpenAI models, sandboxed execution | workspace-write |
| `claude` | Claude Code CLI | Anthropic models | No sandbox |

### How runtime is selected

```
1. task.runtimeHint (--runtime flag or payload)
2. controls.preferred_runtime (server setting)
3. "openclaw" (default)
```

## Model Selection

### Priority chain

```
1. task.modelHint        ← per-task (--model flag or payload)
2. model_map[runtime][stepType]  ← global, per step type
3. model_map[runtime].default    ← global fallback
4. null                          ← runtime uses its own default config
```

### model_map format

The `modelHint` and `model_map` values use format: `<provider-id>/<model-id>`

The provider-id must match a provider defined in the runtime's config:
- opencode: `opencode.json` in project root
- codex: built-in OpenAI models

### Setting global model_map

```bash
curl -X POST http://localhost:3461/api/controls \
  -H "Content-Type: application/json" \
  -d '{"model_map": {"opencode": {"default": "provider/model"}}}'
```

### Clearing model_map (use runtime defaults)

```bash
curl -X POST http://localhost:3461/api/controls \
  -H "Content-Type: application/json" \
  -d '{"model_map": {}}'
```

## Cross-Project Dispatch

To dispatch tasks to a different repo (e.g., edda from karvi):

### target_repo formats (IMPORTANT)

| Format | Example | OK? |
|--------|---------|-----|
| Absolute path | `"C:\\ai_agent\\edda"` or `"C:/ai_agent/edda"` | ✅ |
| GitHub slug + repo_map | `"fagemx/edda"` | ✅ (needs repo_map) |
| Relative path | `"../edda"` | ❌ Rejected |
| Unescaped Windows path | `"C:\ai_agent\edda"` | ❌ Backslash escape bug |

### Setup repo_map for slug-based dispatch

```bash
curl -X POST http://localhost:3461/api/controls \
  -H "Content-Type: application/json" \
  -d '{"repo_map": {"fagemx/edda": "C:/ai_agent/edda"}}'
```

### CLI cross-project

```bash
npm run go -- 145 --repo C:\ai_agent\edda
```

### curl cross-project

```bash
curl -X POST http://localhost:3461/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "title": "EDDA-145: task title",
    "tasks": [{
      "id": "EDDA-145",
      "title": "feat: description",
      "assignee": "engineer_lite",
      "target_repo": "fagemx/edda",
      "description": "Implement issue fagemx/edda#145"
    }]
  }'
```

## Multi-Model Dispatch (different model per task)

```bash
# Task A: OpenRouter
npm run go -- 100 --runtime opencode --model openrouter/anthropic/claude-sonnet-4

# Task B: T8Star
npm run go -- 101 --runtime opencode --model custom-ai-t8star-cn/gpt-5.3-codex-high

# Task C: z.ai
npm run go -- 102 --runtime opencode --model zai-coding-plan/glm-5

# Task D: Codex native
npm run go -- 103 --runtime codex
```

## Pre-Dispatch Checklist

1. **Server running?** `curl http://localhost:3461/api/health/preflight`
2. **Controls correct?** `curl http://localhost:3461/api/controls`
   - `auto_dispatch: true` — tasks auto-start
   - `use_worktrees: true` — isolated workspaces
   - `use_step_pipeline: true` — plan → implement → review
3. **API key set?** Check `.env` for the provider's key
4. **opencode.json exists?** For custom providers, target repo needs `opencode.json`

## Common Pitfalls

| Mistake | Fix |
|---------|-----|
| `autoStart: true` in payload | Don't use — bypasses worktree + step pipeline |
| Windows path not escaped in JSON | Use `\\` or `/` in JSON strings |
| Custom provider not found | Ensure `opencode.json` is in target repo root |
| model_map overrides your intent | Clear it: `{"model_map": {}}` |
| Task stuck as "dispatched" | Manual dispatch: `curl -X POST .../api/tasks/GH-XXX/dispatch` |

## Monitoring

```bash
# Quick status
curl -s http://localhost:3461/api/board | node -e "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.taskPlan?.tasks?.forEach(t => {
    console.log(t.id, t.status, t.modelHint||'');
    (t.steps||[]).forEach(s => console.log('  ', s.step_id, s.state));
  })"

# Dashboard
open http://localhost:3461
```
