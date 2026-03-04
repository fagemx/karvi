<h1 align="center">Karvi</h1>

<p align="center">
  <strong>Multi-agent task orchestration engine with real-time tracking.</strong><br/>
  Blackboard pattern, JSON-based, zero external dependencies — pure Node.js.
</p>

<p align="center">
  <a href="https://github.com/fagemx/karvi"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" alt="Node" /></a>
  <a href="https://github.com/fagemx/karvi/blob/main/package.json"><img src="https://img.shields.io/badge/dependencies-0-blue?style=flat-square" alt="Dependencies" /></a>
  <a href="https://github.com/fagemx/karvi/blob/main/package.json"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  <a href="https://github.com/fagemx/karvi/stargazers"><img src="https://img.shields.io/github/stars/fagemx/karvi?style=flat-square" alt="Stars" /></a>
</p>

<p align="center">
  <a href="#what-is-karvi">What is Karvi?</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#runtimes">Runtimes</a> ·
  <a href="#api">API</a> ·
  <a href="#evolution-layer">Evolution Layer</a>
</p>

---

## What is Karvi?

Karvi is a task orchestration engine for AI agents. You define a goal and a set of tasks — Karvi dispatches them to agents, tracks progress in real time, and manages the full lifecycle from planning through review and approval.

Everything runs from a single `board.json` file (the "blackboard"), a single `server.js` with zero npm dependencies, and a single `index.html` for the web UI. No build step, no framework, no config files.

```
Director (Human)                   board.json
    │  define goal, plan tasks         │
    ▼                                  ▼
  Server ──── dispatch ────→  Agent A (OpenClaw)
    │                         Agent B (Claude Code)
    │  ◄── status updates ──  Agent C (Codex)
    │                         Agent D (Edda Conductor)
    ▼
  Web UI ──── SSE ────→ real-time task board + timeline
```

| Role | What it does |
|------|-------------|
| **Director** (Human) | Sets goals, creates task plans, approves or intervenes |
| **Server** | Manages board.json, dispatches tasks, collects replies, runs reviews |
| **Agents** | Receive tasks, execute, report back via REST API |
| **Web UI** | Real-time task board with SSE — cards, actions, timeline |

## Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| **Node.js** | v22+ | Runs the server |
| **git** | 2.x | Worktree creation, agent commits |
| **gh** (GitHub CLI) | 2.x | Issue fetch, PR create/merge — required by step pipeline |
| **Agent CLI** (at least one) | — | Executes tasks. Supported: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://github.com/opencode-ai/opencode), [Codex](https://github.com/openai/codex), OpenClaw |

Verify:

```bash
node -v    # v22.x.x
git --version   # git version 2.x
gh --version && gh auth status   # logged in
```

## Quick Start

```bash
git clone https://github.com/fagemx/karvi.git
cd karvi
npm start
# → http://localhost:3461
```

No `npm install` needed — zero dependencies.

Dispatch your first task:

```bash
npm run go -- <issue-number>
```

See the [Getting Started Guide](docs/getting-started.md) for a complete walkthrough.

## Configuration

Copy the environment template and adjust as needed:

```bash
cp env.template .env
```

For local development, the defaults work out of the box — no configuration required. The server auto-loads `.env` on startup.

For remote access or production, set at minimum:

| Variable | Purpose |
|----------|---------|
| `KARVI_API_TOKEN` | Protect API with Bearer token |
| `KARVI_VAULT_KEY` | Enable encrypted secret storage (GitHub PAT, etc.) |

See [`env.template`](env.template) for the full list of 35+ available options.

### Remote Access

Want to access Karvi from your phone or another device? See the **[Self-Hosting Guide](docs/self-hosting.md)** — set up a free Cloudflare Tunnel in under 10 minutes.

## Architecture

### Task Lifecycle

```
pending → dispatched → in_progress → completed → reviewing → approved
                           │                          │
                           └→ blocked                 └→ needs_revision → in_progress
                               │
                               └→ (human unblock) → in_progress
```

- Dependencies auto-unlock: when T1 is approved, T3 (`depends: [T1]`) auto-transitions to `dispatched`
- All tasks approved → phase automatically becomes `done`

### Project Structure

```
server/
  server.js              HTTP server (REST API + SSE + dispatch)
  blackboard-server.js   Shared server skeleton (CORS, MIME, SSE, JSON read/write)
  management.js          Evolution layer (controls, insights, lessons)
  process-review.js      Task quality review
  retro.js               Retrospective analysis (pattern → insight)
  runtime-openclaw.js    OpenClaw runtime adapter
  runtime-claude.js      Claude Code runtime adapter
  runtime-codex.js       Codex runtime adapter
  skills/                Agent knowledge base
shared/
  types.ts               Type definitions (Board, Task, DispatchPlan, etc.)
index.html               Web UI (single file, zero dependencies)
board.json               Blackboard (single source of truth)
task-log.jsonl           Event log (append-only)
```

## Runtimes

Karvi dispatches tasks through pluggable runtime adapters. Each adapter spawns an AI agent CLI and collects the result.

| Runtime | CLI | Session Resume | Model Selection | Extras |
|---------|-----|:-:|:-:|--------|
| **OpenClaw** | `openclaw agent` | `--session-id` | — | Review spawning |
| **Claude Code** | `claude -p` | `--resume` | `--model` | Budget limit, effort level, tool restriction |
| **Codex** | `codex exec` | `exec resume` | `-m` | Role-based config |
| **Edda** | `edda conduct run` | — | — | Multi-phase plans, auto-retry, budget tracking |

Select a runtime per-task or globally:

```bash
# Global default
curl -X POST http://localhost:3461/api/controls \
  -H 'Content-Type: application/json' \
  -d '{"preferred_runtime": "claude"}'

# Per-task dispatch
curl -X POST http://localhost:3461/api/tasks/T3/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"runtimeHint": "edda"}'
```

Runtimes load with try/catch — if a CLI isn't installed, the runtime is silently skipped.

## API

### Task Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/board` | Full board.json |
| GET | `/api/tasks` | Task plan |
| POST | `/api/tasks` | Create/replace task plan (`{ goal, phase, tasks }`) |
| POST | `/api/tasks/:id/dispatch` | Dispatch single task to assignee agent |
| POST | `/api/tasks/:id/status` | Update task status (`{ status, reason? }`) |
| POST | `/api/tasks/:id/update` | Update task fields (`{ status, result, blocker }`) |
| POST | `/api/tasks/:id/unblock` | Unblock a blocked task (`{ message }`) |
| POST | `/api/tasks/dispatch` | Bulk dispatch all ready tasks |
| POST | `/api/dispatch-next` | Dispatch next ready task (sequential) |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/conversations` | Create room |
| POST | `/api/conversations/:id/send` | Send message |
| POST | `/api/conversations/:id/run` | Run queue |
| POST | `/api/conversations/:id/stop` | Stop queue |
| POST | `/api/conversations/:id/resume` | Resume queue |
| POST | `/api/participants` | Add participant |

### Evolution Layer

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/controls` | Read current controls |
| POST | `/api/controls` | Update controls (partial merge) |
| POST | `/api/retro` | Trigger retrospective analysis |
| GET | `/api/events` | SSE event stream |

## Evolution Layer

Karvi includes a self-improving feedback loop that learns from task reviews:

```
Task completed
    │
    ▼
  Review (process-review.js)
    │  score + issues
    ▼
  Retro (retro.js)
    │  pattern detection
    ▼
  Insight (suggestedAction)
    │  risk = low → auto-apply
    ▼
  Verify (3+ reviews later)
    │
    ├→ score improved → crystallize as Lesson
    └→ score degraded → rollback
```

| Concept | What it is |
|---------|-----------|
| **Controls** | Tunable parameters (quality threshold, auto-review, auto-redispatch) |
| **Signals** | Events recorded during task lifecycle (review results, dispatches) |
| **Insights** | Patterns detected by retro analysis, with suggested actions |
| **Lessons** | Validated insights that become permanent rules injected into future dispatches |

Safety valves prevent runaway automation: max 3 auto-applies per 24h, no re-applying rolled-back actions, no duplicate action types.

## Design Decisions

- **board.json is the single source of truth** — atomic writes, SSE broadcast on every change
- **Zero external dependencies** — only Node.js built-in modules (`http`, `fs`, `path`, `child_process`)
- **Per-task dispatch** — tasks go directly to assignee agents, no intermediary routing
- **Fire-and-forget** — dispatch is async, server doesn't block waiting for agent completion
- **Windows-first spawn** — all runtimes use `cmd.exe /d /s /c` pattern for cross-platform reliability
- **Human controls state** — buttons in UI are more reliable than parsing natural language responses

## License

MIT
