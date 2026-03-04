# Getting Started

From `git clone` to your first dispatched task in under 5 minutes.

## 1. Install Prerequisites

| Tool | Install | Verify |
|------|---------|--------|
| **Node.js 22+** | [nodejs.org](https://nodejs.org/) | `node -v` |
| **git** | [git-scm.com](https://git-scm.com/) | `git --version` |
| **gh** (GitHub CLI) | [cli.github.com](https://cli.github.com/) | `gh auth status` |
| **Agent CLI** (at least one) | See [Runtimes](../README.md#runtimes) | `claude --version` or `opencode version` |

## 2. Clone and Start

```bash
git clone https://github.com/fagemx/karvi.git
cd karvi
cp env.template .env    # optional — defaults work for local dev
npm start
```

You should see the boot banner:

```
  Karvi v0.1.0 — http://localhost:3461
  Runtimes:  openclaw ✅  claude ✅  codex ❌  opencode ✅
  Auth:      no token (local only)

  Quick start:  npm run go -- <issue-number>
```

Open http://localhost:3461 in your browser — you'll see the task board (empty for now).

## 3. Dispatch Your First Task

The fastest way — one command:

```bash
npm run go -- <issue-number>
```

This fetches the issue from GitHub, shows a preview, and dispatches on confirmation:

```
$ npm run go -- 42

  Fetching #42... ✅ feat: add dark mode toggle

  📋 Will dispatch:
  ├─ #42 — feat: add dark mode toggle
  ├─ Repo:    yourname/yourproject
  └─ Server:  localhost:3461

  Proceed? [Y/n] y

  ✅ Dispatched 1 task(s)!
  └─ Dashboard: http://localhost:3461
```

### Alternative: curl

```bash
curl -X POST http://localhost:3461/api/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "My first project",
    "repo": "yourname/yourproject",
    "tasks": [
      { "issue": 42, "title": "feat: add dark mode toggle" },
      { "issue": 43, "title": "test: add toggle tests", "depends": [42] }
    ]
  }'
```

Response:

```json
{
  "ok": true,
  "title": "My first project",
  "taskCount": 2,
  "project": {
    "id": "PROJ-...",
    "status": "executing",
    "taskIds": ["GH-42", "GH-43"]
  }
}
```

Task #42 dispatches immediately. Task #43 waits (depends on #42).

## 4. Watch It Work

### Web UI

Open http://localhost:3461 — task cards update in real time via SSE. You'll see:
- Task status transitions (dispatched → in_progress → completed)
- Agent output and timeline events
- Action buttons (approve, reject, unblock)

### API

```bash
# Current board state
curl http://localhost:3461/api/board

# Task plan only
curl http://localhost:3461/api/tasks

# Environment check
curl http://localhost:3461/api/health/preflight
```

### SSE stream

```bash
curl -N http://localhost:3461/api/events
```

Events stream as tasks progress — useful for scripting or dashboards.

## 5. Review and Approve

When a task completes, it enters the **review** phase. With `auto_review` enabled (the default), Karvi dispatches a review agent automatically.

If the review passes → task moves to `approved`.
If the review requests changes → task cycles back to `in_progress` for revision.

### Manual actions

```bash
# Approve a task
curl -X POST http://localhost:3461/api/tasks/GH-42/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "approved"}'

# Request revision
curl -X POST http://localhost:3461/api/tasks/GH-42/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "needs_revision", "reason": "Missing error handling"}'
```

### Dependency unlock

When GH-42 is approved, GH-43 (which depends on it) auto-transitions from `pending` → `dispatched` and the agent starts working on it.

## 6. Controls

Tune Karvi's behavior without restarting:

```bash
# See current controls
curl http://localhost:3461/api/controls

# Change runtime
curl -X POST http://localhost:3461/api/controls \
  -H 'Content-Type: application/json' \
  -d '{"preferred_runtime": "claude"}'

# Enable/disable auto-dispatch
curl -X POST http://localhost:3461/api/controls \
  -H 'Content-Type: application/json' \
  -d '{"auto_dispatch": true}'
```

Key controls:

| Control | Default | What it does |
|---------|---------|-------------|
| `auto_dispatch` | `true` | Dispatch tasks as soon as dependencies are met |
| `auto_review` | `true` | Auto-dispatch review after task completion |
| `preferred_runtime` | `opencode` | Which agent CLI to use |
| `max_concurrent_tasks` | `4` | Parallel task limit |
| `use_step_pipeline` | `true` | Enable plan → implement → review step pipeline |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ECONNREFUSED` on dispatch | Server not running — run `npm start` first |
| `gh: command not found` | Install GitHub CLI: https://cli.github.com/ |
| Issue fetch fails | Run `gh auth login` to authenticate |
| Agent not found | Install at least one agent CLI (claude, opencode, codex) |
| Port 3461 in use | `PORT=3462 npm start` or kill the existing process |
| `EADDRINUSE` in tests | Previous test didn't clean up — find PID with `netstat` and kill it |

## Next Steps

- **Multiple tasks**: `npm run go -- 42 43 44` dispatches a batch
- **Skills**: `npm run go -- 42 --skill issue-plan` for deep-dive planning
- **Remote access**: See the [Self-Hosting Guide](self-hosting.md) for phone access via Cloudflare Tunnel
- **API reference**: See the [API section](../README.md#api) in the README
- **Environment variables**: See [`env.template`](../env.template) for all 35+ options
