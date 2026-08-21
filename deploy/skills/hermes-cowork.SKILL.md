---
name: cowork
description: >-
  Multi-agent Cowork MCP framework: register agents with brains, dispatch and
  schedule tasks, heartbeat, agencies, inbox, artifacts, dashboard. Local MCP
  server at :6868.
version: 1.0.0
author: Hermes
platforms: [linux]
metadata:
  hermes:
    tags: Cowork, MCP, Multi-Agent, Coordination, Brain-Registration
---

# Cowork MCP Framework

Multi-agent coordination framework (slashman413/cowork) running as a local MCP server
on `http://localhost:6868`. Agents register with capabilities AND brains (model specs),
dispatch cross-platform tasks, heartbeat, and query agencies/inbox.

> **There is no report store.** `file_report` and `complete_task(report_path:)` were
> removed. A task's complete record is `task.result` + `artifacts/<task-id>/`.

> **Operating rules:** every task you execute runs under [CONVENTIONS.md](https://github.com/slashman413/cowork/blob/main/CONVENTIONS.md) —
> put output in `$COWORK_ARTIFACTS_DIR`, use your full permissions freely, and ask
> rather than guess when blocked. They are injected into your prompt automatically.

## When to Use

- "Dispatch a task to Claude for code review" / "create a task for another agent"
- "Show me the agencies" / "what agents are available"
- "Check my inbox" / "list pending tasks"
- "Schedule this for 9am tomorrow" (`create_task(scheduled_at: …)`)
- "Show the dashboard" / "what's happening across agents"
- "Register this agent" / "add my brains"
- Cross-platform agent coordination (Hermes, Claude, Gemini, Antigravity, Codex, etc.)
- Heartbeat monitoring / agent lifecycle management

## Prerequisites

- Cowork MCP server: systemd service `cowork-mcp.service` (auto-starts at boot)
  - Config: `~/.cowork/config.json` (real per-server; repo `config.json` is a template)
  - Port: 6868, no API key required
- `agency-agents` — a git submodule at `./agency-agents` (init: `git submodule update --init`)
- Hermes MCP endpoint: `mcp_endpoints: { cowork: "http://localhost:6868/mcp" }`
- Hermes model CLIs: `hermes` (qwen35b/qwen27b/deepseek/deepseek-v4-pro), optional `claude`, `agy`, `codex`, `ollama`

## Key Paths

- `cowork/` — repo root (e.g. `~/cowork/` or wherever you cloned it)
- `inbox/` — Task queue (JSON files, auto-managed)
- `artifacts/` — Per-task output files (audio/video/md), downloadable from the Inbox
- `.status/` — Runtime state (auto-managed)
- `deploy/remote-brain-client.mjs` — Remote brain registration script (zero-config)
- `deploy/presets/hermes.json` — Hermes preset: qwen35b, qwen27b, deepseek, deepseek-v4-pro
- `deploy/presets/claude.json` — Claude preset: opus, sonnet, fable, default

## Quick Reference

### MCP Tools (via integration — mcp__cowork__*)

| Tool | Purpose |
|------|---------|
| `register_agent` | Register agent with platform, name, capabilities, AND brains (model specs) |
| `heartbeat` | Update status and current task (keep agent alive) |
| `deregister_agent` | Remove agent and all its brains from the registry |
| `get_roster` | Search agents across all platforms |
| `create_task` | Create a task for another agent/platform; optional `scheduled_at` (ISO 8601) parks it until launch time, optional `interaction` asks a human for input first |
| `claim_task` | Claim a pending inbox task |
| `complete_task` | Mark a task as done — `task_id` + `result` only |
| `list_inbox` | List inbox tasks with status/platform filters |
| `get_dashboard` | Get full dashboard data (agents, inbox, services) |
| `list_resources` | List available resources from MCP server |
| `read_resource` | Read a resource by URI |

### REST API (port 6868)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Dashboard overview (activeAgents, inboxSummary, uptime) |
| GET | `/api/connections` | Live MCP clients (heartbeat) + per-brain ran/submitted counters |
| GET | `/api/roster` | Agencies (filterable by division/search/category) |
| GET | `/api/roster-divisions` | Agencies grouped by division (for the Agents view) |
| GET | `/api/dispatcher` | Special agents + brains + defaultChain + divisionChains + running |
| GET / PUT | `/api/chains`, `/api/chains/default`, `/api/chains/division/:div` | Read / edit brain fallback chains |
| GET / PUT / DELETE | `/api/brains`, `/api/brains/:id` | Brain registry (cascades on delete) |
| GET / PUT / DELETE | `/api/agents-config`, `/api/agents-config/:name` | Special-executor chains |
| GET | `/api/artifacts/:taskId`, `/api/artifacts/:taskId/:file` | List / download task artifacts |
| GET | `/api/inbox?status=pending` | Inbox tasks (filterable) |
| POST | `/api/inbox` | Create a new task |
| PATCH | `/api/inbox/:id` | Claim or complete a task |
| POST | `/api/inbox/:id/rerun` | Re-queue a FAILED (chain-exhausted) task from the top of its chain |
| POST | `/api/inbox/:id/continue` | Spawn a follow-up to a finished task (same brain by default) |
| POST | `/api/inbox/:id/interaction` | Submit a person's answers → releases a `wait-input` task |
| GET | `/api/config` | Current configuration |
| GET | `/api/events` | SSE event stream (real-time) |

SSE event types are camelCase: `agentRegistered`, `taskCreated`, `taskClaimed`,
`taskCompleted`, `heartbeat`.

### Web Dashboard

- `http://localhost:6868/` — Web UI (dashboard, Connections, inbox, Agents, Brains,
  agencies, workflows, chat) with a raw/rendered markdown viewer and artifact downloads

### MCP Inspector (debugging)

```bash
npx @modelcontextprotocol/inspector http://localhost:6868/mcp
```

## Agent Registration (with Brains)

Register with `register_agent`, passing a `brains` array to declare models you can run:

```
register_agent(
  platform="hermes",
  agent_name="hermes-agent-01",
  capabilities=["engineering", "research", "planner", "generalist"],
  current_task="Working on X",
  brains=[
    {"id": "local-ha-qwen35b",  "location": "local", "exec": "hermes", "model": "nvidia/Qwen3.6-35B-A3B-NVFP4"},
    {"id": "local-ha-qwen27b",  "location": "local", "exec": "hermes", "model": "nvidia/Qwen3.6-27B-NVFP4"},
    {"id": "local-ha-deepseek-v4-pro", "location": "local", "exec": "hermes", "model": "deepseek-ai/deepseek-v4-pro"},
    {"id": "local-ha-deepseek", "location": "local", "exec": "hermes", "model": "deepseek:deepseek-v4-flash"}
  ]
)
```

Available exec types: `hermes`, `claude`, `agy`, `codex`, `ollama`.
Location: `local` (runs on this machine) or `remote` (runs on another machine).

Brains persist until explicitly deregistered — they do NOT auto-remove on disconnect.

### Remote Brain Client

A machine can join as a remote brain provider with zero config:

```bash
COWORK_URL=http://<cowork-host>:6868 node cowork/deploy/remote-brain-client.mjs
```

Auto-detects `claude`/`hermes`/`agy`/`codex`/`ollama` CLIs and declares matching brains.
For remote machines, use a systemd service:

```bash
cp cowork/deploy/cowork-remote-brain@.service ~/.config/systemd/user/
# Edit env file, enable service
```

## CEO Flow (Discord idea -> company execution)

When the user shares a business idea or multi-part request:

0. FIRST check `list_inbox` (status pending + in-progress): if the request is already
   covered by existing tasks (an orchestrator may have decomposed it into subtasks),
   do NOT file new ones; report status instead.

1. Create EXACTLY ONE orchestrator task via `create_task`:
   - `title`: the idea in one line
   - `description`: the full request, verbatim + context
   - `from_platform`, `from_agent`: your identity
   - `context: {"role": "orchestrator"}`, `tags: ["orchestrator"]`

2. The dispatcher runs the orchestrator brain; it decomposes the idea into subtasks.
   Each unassigned subtask is **routed in two stages** — an orchestrator/classifier
   brain (default qwen35b) picks a **division** (1 of 19), then an **agent**
   (1 of 285) whose `.md` persona becomes the system prompt, run on that division's
   brain chain (or the global default). Target directly with `context.agent: "<slug>"`.

3. Track progress with `list_inbox` / `get_dashboard`; results appear on the task card;
   any generated files land in `cowork/artifacts/<task-id>/` (downloadable).

### Routing model (config.json orchestration)

There is **no fixed role→brain table** anymore. Only three **special executors** carry
their own chains; everything else routes through the Agencies:

| Executor | Kind | Brain chain source |
|----------|------|--------------------|
| orchestrator | special | `orchestration.agents.orchestrator.brains` |
| generalist | special | `orchestration.agents.generalist.brains` |
| video | special | `orchestration.agents.video.brains` (LTX only — never Wan/Hunyuan) |
| any of 285 agents | Agencies | `orchestration.divisionChains[<division>]` if set, else `orchestration.defaultChain` |

- **Global default chain**: `orchestration.defaultChain` — drag-reorder in the Brains
  view (`PUT /api/chains/default`).
- **Per-division override**: `orchestration.divisionChains[<division>]` — set/clear in
  the Agents view (`PUT /api/chains/division/:division`; empty reverts to default).
- Chains run top→bottom with failure handover; `remoteGraceMs` (60s) auto-advances past
  an unclaimed remote rung. Pin a single task with `context.brain: "<id>"`.

## Goals (long-lived objectives)

State in `goals/<goalId>.json`. A goal drives toward one **binary success criterion**
on the normal task machinery, via two roles:

- **Achiever** — exactly ONE move per turn: `evaluate` (answer the Yes/No gate), `plan`
  (append the next phase), or `emit` (generate that phase's tasks).
- **Judger** — wakes when a phase's terminal task finishes, writes a report + minutes
  into artifacts, and re-arms the Achiever.

A goal ends **`achieved`** (the only terminal state). If it hits an obstacle it can't
clear itself it goes **`blocked`** — a *recoverable* hold recording the reason **and** the
specific condition to resume (`unblockCriteria`). `blocked` is **self-healing**: the drive
loop **auto-resumes** it on an exponential backoff (minutes, then hours) for a HALF-OPEN
probe, so it recovers on its own once the obstacle clears — recovery never waits on a
human. Never a silent "done" and never a silent give-up: a human can **resume now** to
retry at once, or **delete** it if it's truly dead. Turns happen only when no generated
task is open.

**Scheduled checkpoints.** An emitted task may carry a future `scheduledAt` (ISO 8601):

```json
{ "kind": "emit",
  "tasks": [ { "title": "Measure MRR", "scheduledAt": "2026-09-14T00:00:00Z" } ] }
```

`scheduled` is an *open* status, so an outstanding checkpoint keeps the goal
non-quiescent: **no turns, no budget spent** while real time passes. Emit one whenever
the next honest step is to let the world change (a month of revenue, an indexing
window) — it is the correct move, not a stall. Unparseable or past times are dropped
and the task runs now, so one bad date never aborts an emit.

**Two guards block a goal** (recoverably). `stepBudget` (default 24) counts *lifetime*
execution tasks; `MAX_GOAL_FAILURES` (5) counts *consecutive* Achiever turns that neither
plan nor emit — and an `evaluate{met:false}` is one of those. When either trips the goal
is **blocked with a concrete resume contract** (raise the budget / narrow the criterion,
or verify the brain) and then **auto-retried on a backoff** — a transient brain blip
self-heals in minutes, and raising the budget lets it self-resume with no click, not
discarded. Both punish metric-open objectives, so a
goal riding an external number needs an evidence-bound criterion ("does a dated snapshot
in artifacts show X?", not "is X true?"), a phase loop that always has work to emit,
scheduled checkpoints, and a budget sized for the horizon. The dashboard's 💰 📈 🧲
starters are already shaped this way — copy one rather than writing a bare metric. The
Achiever can also **block itself** (`{"kind":"block","reason":"…","unblockCriteria":"…"}`)
when it hits a missing credential, an external dependency, or a human-only decision.

`GET/POST /api/goals` · `GET/PATCH/DELETE /api/goals/:id` ·
`POST /api/goals/:id/{activate,pause,block}` · `GET /api/goals/:id/tasks`

## Procedure

### 1. Register + Declare Brains

Call `register_agent` at the start of a session to be discoverable:

```
register_agent(
  platform="hermes",
  agent_name="hermes-agent-01",
  capabilities=["engineering", "research", "planner", "generalist"],
  current_task="Working on X",
  brains=[{"id": "local-ha-qwen35b", "location": "local", "exec": "hermes", "model": "nvidia/Qwen3.6-35B-A3B-NVFP4"}]
)
```

If already registered, your MCP tools already have the brains — skip re-registration.

### 2. Heartbeat

Call `heartbeat` periodically to keep your agent active in the dashboard:

```
heartbeat(agent_id="your-agent-id", status="working", current_task="Doing X")
```

Statuses: `idle`, `working`, `blocked`.

### 3. Dispatch a Task

```
create_task(
  title="Task title",
  description="Full description",
  from_platform="hermes",
  from_agent="hermes-agent-01",
  to_platform="claude",
  to_agent="engineering-code-reviewer",
  priority="normal",
  skill="code-review",
  context={"key": "value"},
  tags=["tag1", "tag2"]
)
```

### 4. Check Inbox

```
list_inbox(status="pending", platform="hermes")
```

### 5. Claim + Complete Tasks

```
claim_task(task_id="<id>", agent_id="your-agent-id")
complete_task(task_id="<id>", result="Results here")
```

### 6. Deliver the output (no reports)

Write every file you produce into `$COWORK_ARTIFACTS_DIR` (= `cowork/artifacts/<task-id>/`,
already your working directory) using **relative paths** — those become the downloadable
artifacts on the task card. Your stdout becomes `task.result`; long output is truncated
there but saved in full as `result.md`, so the deliverable belongs in a file, not only in
stdout. Do not write outside that directory unless the brief names a destination, and do
not invent filenames — the artifact list is read off disk.

If you cannot finish without a decision only the user can make, end your output with a
line beginning `NEEDS_INPUT:` followed by your question(s), one per line. The dispatcher
parks the task on `wait-input` and re-dispatches it once the user answers (their replies
arrive on `context.humanInput`). Never emit a rate-limit or quota notice as the
deliverable — the verifier rejects those and hands the task to the next brain in the chain.

### 7. Query Agencies

```
get_roster(category="engineering", search="keyword", active_only=true)
```

### 8. Check Dashboard

```
get_dashboard()
```

Shows active agents, inbox stats, service health (vllm, firecrawl, forgejo).

## Heartbeat Pattern

For long-running sessions, call heartbeat every ~5 minutes:

```
heartbeat(agent_id="b27e60cf-e3ec-4a2a-8215-70759a53b33f", status="working", current_task="Continuing X")
```

The cowork server tracks `lastHeartbeat` per agent. Agents not heartbeating in ~30 min
may appear stale on the dashboard.

## Credential / local-filesystem rule (CONVENTIONS.md §6)

Any task that needs the **local filesystem** — credentials under `~/.priv/`, or any path
under the cowork host's home dir — MUST run on a **local** brain. Pin it explicitly:
`context: {"brain": "local-ha-deepseek-v4-pro"}`. `remote-*` brains cannot see that
filesystem; such a task routed to one will fail or vanish. If you are a remote brain and
the brief needs local files, report the routing error and stop — do not fake it.

## REST API: task creation body shape (critical)

`POST /api/inbox` does **not** take the MCP tool's flat argument names. Use the nested
task schema:

```json
{
  "title": "…",
  "description": "…",
  "from": {"platform": "hermes", "agent": "<your agent name>"},
  "to": {},
  "context": {"brain": "local-ha-deepseek-v4-pro"}
}
```

- `from` — an object with `platform` + `agent` (NOT `from_platform` / `from_agent`);
  it is the only required field besides `title` and `description`
- `to` — an object, `{}` when unassigned (NOT a bare string like `"hermes"`; a string is
  silently read as no target)
- scheduling — this endpoint accepts **either** `scheduledAt` or `scheduled_at`
- `inputs: [{token, name}]` — attach files staged via `POST /api/uploads?name=<file>`

The flat `from_platform` / `from_agent` / `to_platform` / `to_agent` form is the **MCP
`create_task` tool's** interface only.

## Pitfalls

- Server must be running — check with `curl -s http://localhost:6868/api/status`
- MCP endpoint: `/mcp` (Streamable HTTP). REST API: `/api/...`. Do not mix.
- `apiKey` in config.json: if set, all requests need `Authorization: Bearer ***` header.
- Task lifecycle: `scheduled` / `wait-input` → `pending` → `claimed` → `in-progress` →
  `done` / `rejected`; a task whose whole chain was rejected finishes `failed: true`
  (re-queue with `POST /api/inbox/:id/rerun`). `scheduled` and `wait-input` are held OUT
  of the pending pool — never claimed or routed until released.
- SSE at `/api/events` needs `curl -N` (no buffering).
- Chain/brain edits via the dashboard or `/api/chains*`, `/api/agents-config`,
  `/api/brains` are applied live AND persisted to config.json (no restart). Only manual
  hand-edits of config.json require a restart.
- Brains persist until `deregister_agent` — they do NOT auto-remove on disconnect.
- If `agency-agents` repo is missing/misconfigured, Agencies queries return empty.
- Port is 6868, NOT 4200.

## Verification

```bash
# Health check
curl -s http://localhost:6868/api/status | python3 -m json.tool

# List active agents
curl -s http://localhost:6868/api/agents | python3 -m json.tool

# Test MCP tool
curl -s -X POST http://localhost:6868/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_dashboard","arguments":{}}, "id":1}' | python3 -m json.tool

# Watch events
curl -N http://localhost:6868/api/events
```

## Systemd Service

```bash
systemctl --user status cowork-mcp      # Check status
systemctl --user restart cowork-mcp     # Restart
systemctl --user enable cowork-mcp      # Enable at boot
```

The service runs from the repo's `server/` directory
(`WorkingDirectory`), loading `../config.json`. The old `agents-coworking` path is
retired.