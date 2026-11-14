---
name: cowork
description: >-
  Multi-agent Cowork MCP framework: register agents with agents, dispatch and
  schedule tasks, heartbeat, personas, inbox, artifacts, dashboard. Local MCP
  server at https://localhost:6868 (self-signed TLS). Recurring tasks + Calendar.
version: 1.3.0
author: Hermes
platforms: [linux]
metadata:
  hermes:
    tags: Cowork, MCP, Multi-Agent, Coordination, Agent-Registration
---

# Cowork MCP Framework

> **Naming (2026-11):** what used to be a "brain" is an **agent**. Pin with `context.agent`, name a persona with
> `context.persona`, and set the level with `context.thinking` (`low|medium|high|xhigh|max`, default `medium`).
> Agent ids never end in `-low`, `-medium` or `-high`. Declare agents in `register_agent`'s `agents` array;
> `agent_id` in the MCP tools is your worker's registration id. See `JOIN-AS-AN-AGENT.md`.

Multi-agent coordination framework (cowork) running as a local MCP server
on `https://localhost:6868` (HTTPS, self-signed — use `curl -k`). Agents register with
capabilities AND agents (model specs), dispatch cross-platform tasks, heartbeat, and query personas/inbox.

> **There is no report store.** `file_report` and `complete_task(report_path:)` were
> removed. A task's complete record is `task.result` + `artifacts/<task-id>/`.

> **Operating rules:** every task you execute runs under [CONVENTIONS.md](CONVENTIONS.md) —
> put output in `$COWORK_ARTIFACTS_DIR`, use your full permissions freely, and ask
> rather than guess when blocked. They are injected into your prompt automatically.

## When to Use

- "Dispatch a task to Claude for code review" / "create a task for another agent"
- "Show me the personas" / "what agents are available"
- "Check my inbox" / "list pending tasks"
- "Schedule this for 9am tomorrow" (`create_task(scheduled_at: …)`)
- "Show the dashboard" / "what's happening across agents"
- "Register this agent" / "add my agents"
- Cross-platform agent coordination (Hermes, Claude, Gemini, Antigravity, Codex, etc.)
- Heartbeat monitoring / agent lifecycle management

## Prerequisites

- Cowork MCP server: systemd service `cowork-mcp.service` (auto-starts at boot)
  - Config: `~/.cowork/config.json` (real per-server; repo `config.json` is a template)
  - Port: 6868. API key: send `Authorization: Bearer $COWORK_API_KEY` (dispatched tasks and agent clients have it in env; the hub on a non-loopback host requires it)
- Personas — the `msitarzewski/agency-agents` persona pack, installed as an integration on first start
  (check `GET /api/integrations/defaults`; re-run with `POST /api/integrations/defaults/provision`)
- Hermes MCP endpoint: `mcp_endpoints: { cowork: "https://localhost:6868/mcp" }`
- Hermes model CLIs: `hermes` (qwen3.8-27b), optional `claude`, `agy`, `codex`, `ollama`

## Key Paths

- `cowork/` — repo root (e.g. `~/cowork/` or wherever you cloned it)
- `inbox/` — Task queue (JSON files, auto-managed)
- `artifacts/` — Per-task output files (audio/video/md), downloadable from the Inbox
- `.status/` — Runtime state (auto-managed)
- `deploy/remote-agent-client.mjs` — Remote agent registration script (zero-config)
- `deploy/presets/hermes.json` — Hermes preset: qwen3.8-27b
- `deploy/presets/claude.json` — Claude preset: opus, sonnet, fable, default

## Quick Reference

### MCP Tools (via integration — mcp__cowork__*)

| Tool | Purpose |
|------|---------|
| `register_agent` | Register agent with platform, name, capabilities, AND agents (model specs) |
| `heartbeat` | Update status and current task (keep agent alive) |
| `deregister_agent` | Remove agent and all its agents from the registry |
| `get_roster` | Search agents across all platforms |
| `create_task` | Create a task for another agent/platform; optional `scheduled_at` (ISO 8601) parks it until launch time, optional `recurrence` makes it a recurring scheduler, optional `interaction` asks a human for input first |
| `claim_task` | Claim a pending inbox task |
| `complete_task` | Mark a task as done — `task_id` + `result` only |
| `list_inbox` | List inbox tasks with status/platform filters |
| `get_dashboard` | Get full dashboard data (agents, inbox, services) |
| `create_goal`, `list_goals`, `get_goal`, `update_goal_progress` | Goals (long-lived objectives) |
| `obsidian_info`, `obsidian_search`, `obsidian_read`, `obsidian_list` | Shared Obsidian vault (when configured) |
| `integrations` | Integrate a git repo as a cowork skill / portal plugin |
| `list_resources` | List available resources from MCP server |
| `read_resource` | Read a resource by URI |

### REST API (port 6868)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Dashboard overview (activeAgents, inboxSummary, uptime) |
| GET | `/api/connections` | Live MCP clients (heartbeat) + per-agent ran/submitted counters |
| GET | `/api/roster` | Personas (filterable by division/search/category) |
| GET | `/api/roster-divisions` | Personas grouped by division |
| GET | `/api/dispatcher` | Special roles + agents + defaultChain + running |
| GET / PUT | `/api/chains`, `/api/chains/default`, `/api/chains/tiers`, `/api/chains/tier/:tier` | Read / edit the default chain and tier lists |
| POST | `/api/inbox/:id/pause`, `/api/inbox/:id/resume` | Pause / resume a task |
| GET / PUT / DELETE | `/api/agents`, `/api/agents/:id` | Agent registry (cascades on delete) |
| GET / PUT / DELETE | `/api/roles-config`, `/api/roles-config/:name` | Special-executor chains |
| GET | `/api/artifacts/:taskId`, `/api/artifacts/:taskId/:file` | List / download task artifacts |
| GET | `/api/inbox?status=pending` | Inbox tasks (filterable) |
| POST | `/api/inbox` | Create a new task |
| PATCH | `/api/inbox/:id` | Claim or complete a task |
| POST | `/api/inbox/:id/rerun` | Re-queue a FAILED (chain-exhausted) task from the top of its chain |
| POST | `/api/inbox/:id/continue` | Spawn a follow-up to a finished task (same agent by default) |
| POST | `/api/inbox/:id/edit` | Edit a task (e.g. `scheduledAt`, `recurrence`) |
| POST | `/api/inbox/:id/run-now` | Run a scheduled/recurring task now (a recurring task re-arms) |
| POST | `/api/inbox/:id/interaction` | Submit a person's answers → releases a `wait-input` task |
| GET | `/api/calendar?from=ISO&to=ISO` | Calendar entries (default 7 days back → 35 ahead, max 100 days) |
| GET | `/api/config` | Current configuration |
| GET | `/api/events` | SSE event stream (real-time) |

SSE event types are camelCase: `agentRegistered`, `taskCreated`, `taskClaimed`,
`taskCompleted`, `heartbeat`.

### Web Dashboard

- `https://localhost:6868/` — Web UI (Overview, Portal, Tasks, Recipes, Calendar,
  Goals, Routing, Agents, Workers, Configuration; Integrations at `/integrations.html`) with a raw/rendered markdown viewer and artifact downloads

### MCP Inspector (debugging)

```bash
npx @modelcontextprotocol/inspector https://localhost:6868/mcp
```

## Agent Registration (with Agents)

Register with `register_agent`, passing a `agents` array to declare models you can run:

```
register_agent(
  platform="hermes",
  agent_name="hermes-agent-01",
  capabilities=["engineering", "research", "planner", "generalist"],
  current_task="Working on X",
  agents=[
    {"id": "local-hermes-qwen3.8-27b", "location": "local", "exec": "hermes", "model": "qwen3.8-27b"}
  ]
)
```

Available exec types: `hermes`, `claude`, `agy`, `codex`, `ollama`, `dsh`, `script`.
Location: `local` (runs on this machine) or `remote` (runs on another machine).

Agents persist until explicitly deregistered — they do NOT auto-remove on disconnect.

### Remote Agent Client

A machine can join as a remote agent provider with zero config:

```bash
COWORK_URL=https://<cowork-host>:6868 NODE_EXTRA_CA_CERTS=~/.cowork/tls/cert.pem \
  node cowork/deploy/remote-agent-client.mjs
```

Node clients must trust the self-signed cert (`NODE_EXTRA_CA_CERTS`), or the MCP
handshake fails with `SELF_SIGNED_CERT_IN_CHAIN`. Clients still on `http://` must be
relaunched with `https://`.

Auto-detects `claude`/`hermes`/`agy`/`codex`/`ollama` CLIs and declares matching agents.
For remote machines, use a systemd service:

```bash
cp cowork/deploy/cowork-remote-agent@.service ~/.config/systemd/user/
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

2. The dispatcher runs the orchestrator agent; it decomposes the idea into subtasks.
   Each unassigned subtask is **routed in two stages** — an orchestrator/classifier
   agent (qwen3.8-27b) picks a **division** (1 of 19) plus a **work role**, then a
   **persona** (1 of ~285) whose `.md` file becomes the system prompt. The work role sets
   the tier + thinking; the task runs on that tier's agents, then the global default chain.
   Target directly at dispatch with `context.persona: "<slug>"` and/or `context.division: "<division>"`.

3. Track progress with `list_inbox` / `get_dashboard`; results appear on the task card;
   any generated files land in `cowork/artifacts/<task-id>/` (downloadable).

### Routing model (config.json orchestration)

There is **no fixed role→agent table** anymore. Only three **special executors** carry
their own chains; everything else runs on its tier list, then the default chain:

| Executor | Kind | Agent chain source |
|----------|------|--------------------|
| orchestrator | special | `orchestration.roleChains.orchestrator.agents` |
| generalist | special | `orchestration.roleChains.generalist.agents` |
| video | special | `orchestration.roleChains.video.agents` (LTX only — never Wan/Hunyuan) |
| any of ~285 personas | persona | `orchestration.tiers[<context.tier>]` if the task has a tier, then `orchestration.defaultChain` |

- **Global default chain**: `orchestration.defaultChain` — drag-reorder in the Routing
  view (`PUT /api/chains/default`). Read the current order with
  `curl -sk https://localhost:6868/api/chains`; it changes often, so don't copy it here.
  deepseek agents are retired (denylisted by `DENYLISTED_AGENT_RE=/deepseek/i`).
- **Tier lists**: `orchestration.tiers.<mechanical|standard|judgment>` (`PUT /api/chains/tier/:tier`).
  With `orchestration.workRoles.enabled` the router's work role sets `context.tier` and
  `context.thinking` (capped by `workRoles.budget`).
- Per-division / per-persona chains were removed on 2026-11-13: `divisionChains`,
  `personaChains` and `/api/chains/division/*` are gone, and leftover keys are ignored.
- The live registry: `curl -sk https://localhost:6868/api/agents`.
  Retired ids resolve via `AGENT_ID_ALIASES` (old qwen3.8 ids → `local-hermes-qwen3.8-27b`).
- Chains run top→bottom with failure handover; `remoteGraceMs` (20s in the template config; 60s code default) auto-advances past
  an unclaimed remote rung. Pin a single task with `context.agent: "<id>"`.
- The Workflows engine and `maxWorkflowSteps` were removed on 2026-11-02; use recipes
  (`/api/recipes`) or goals instead.

## Recurring tasks & Calendar

A task may be **recurring** (e.g. "every day at 08:00"). Recurring tasks are
**schedulers**: they never run their own body — when due they spawn a one-shot
**RUN-CHILD** that does the work, then re-arm. `POST /api/inbox/:id/run-now` fires one
immediately (a recurring task runs this cycle and re-arms).

Set the cadence with a `recurrence` object — MCP `create_task { recurrence }`, REST
`POST /api/inbox { recurrence }` / `POST /api/inbox/:id/edit`, or the dashboard *Repeat*
control:

| `type` | Fields | Example |
|--------|--------|---------|
| `minutes` / `hours` | `interval` | `{ "type": "hours", "interval": 6 }` |
| `daily` | `interval`, `atTime` | `{ "type": "daily", "interval": 1, "atTime": "09:00" }` |
| `weekly` | `interval`, `weekdays` (0=Sun..6=Sat), `atTime` | `{ "type": "weekly", "weekdays": [1,3,5], "atTime": "09:00" }` |
| `monthly` | `interval`, `dayOfMonth`, `atTime` | `{ "type": "monthly", "dayOfMonth": 15, "atTime": "08:00" }` |
| `cron` | `expr` (5-field) | `{ "type": "cron", "expr": "0 9 * * 1-5" }` |

- Optional `until` (ISO 8601) ends the series. Wall-clock fields use the server's local timezone.
- **Fixed-rate, not fixed-delay**: the next fire is phased on the intended `scheduledAt`;
  overruns/downtime skip forward to the next future slot (no catch-up burst).
- Legacy `loopIntervalHours: N` still works as `{ "type": "hours", "interval": N }`.

**Calendar** (dashboard `#calendar`, data from `GET /api/calendar`) shows scheduled and
recurring tasks in Month / Week / Agenda views: dashed = projected fire, solid = real run,
🔁 = recurring series, ⚠ = overdue. Only the **next** fire is movable (drag or
*Reschedule* → `POST /api/inbox/:id/edit {scheduledAt}`); later fires are virtual and
keep the cadence's phase — to change every run, edit the cadence. See
`docs/calendar-ux.md`.

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
or verify the agent) and then **auto-retried on a backoff** — a transient agent blip
self-heals in minutes, and raising the budget lets it self-resume with no click, not
discarded. Both punish metric-open objectives, so a
goal riding an external number needs an evidence-bound criterion ("does a dated snapshot
in artifacts show X?", not "is X true?"), a phase loop that always has work to emit,
scheduled checkpoints, and a budget sized for the horizon. The dashboard's 💰 📈 🧲
starters are already shaped this way — copy one rather than writing a bare metric. The
Achiever can also **block itself** (`{"kind":"block","reason":"…","unblockCriteria":"…"}`)
when it hits a missing credential, an external dependency, or a human-only decision.

`GET/POST /api/goals` (summaries; `?view=full` for whole records) · `GET/PATCH/DELETE /api/goals/:id` ·
`POST /api/goals/:id/{activate,pause,block}` · `GET /api/goals/:id/tasks`

## Procedure

### 1. Register + Declare Agents

Call `register_agent` at the start of a session to be discoverable:

```
register_agent(
  platform="hermes",
  agent_name="hermes-agent-01",
  capabilities=["engineering", "research", "planner", "generalist"],
  current_task="Working on X",
  agents=[{"id": "local-hermes-qwen3.8-27b", "location": "local", "exec": "hermes", "model": "qwen3.8-27b"}]
)
```

If already registered, your MCP tools already have the agents — skip re-registration.

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
deliverable — the verifier rejects those and hands the task to the next agent in the chain.

### 7. Query personas

```
get_roster(category="engineering", search="keyword", active_only=true)
```

### 8. Check Dashboard

```
get_dashboard()
```

Shows active workers, inbox stats, service health (vllm, firecrawl, forgejo).

## Heartbeat Pattern

For long-running sessions, call heartbeat every ~5 minutes:

```
heartbeat(agent_id="b27e60cf-e3ec-4a2a-8215-70759a53b33f", status="working", current_task="Continuing X")
```

The cowork server tracks `lastHeartbeat` per agent. Agents not heartbeating in ~10 min
may appear stale on the dashboard; a task claim goes stale after `staleClaimMs`
(600000 = 10 min).

## Credential / local-filesystem rule (CONVENTIONS.md §6)

Any task that needs the **local filesystem** — credentials under `~/.priv/`, or any path
under the cowork host's home dir — MUST run on a **local** agent. Pin it explicitly:
`context: {"agent": "local-hermes-qwen3.8-27b"}`. `remote-*` agents cannot see that
filesystem; such a task routed to one will fail or vanish. If you are a remote agent and
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
  "context": {"agent": "local-hermes-qwen3.8-27b"}
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

- Server must be running — check with `curl -sk https://localhost:6868/api/status`
- MCP endpoint: `/mcp` (Streamable HTTP). REST API: `/api/...`. Do not mix.
- API key: every /api and /mcp request needs `Authorization: Bearer $COWORK_API_KEY` (or `X-API-Key`). Dispatched tasks and agent clients get `COWORK_API_KEY` in env; never paste the key into task text or output.
- Task lifecycle: `scheduled` / `wait-input` → `pending` → `claimed` → `in-progress` →
  `done` / `rejected`; a task whose whole chain was rejected finishes `failed: true`
  (re-queue with `POST /api/inbox/:id/rerun`). `scheduled` and `wait-input` are held OUT
  of the pending pool — never claimed or routed until released.
- SSE at `/api/events` needs `curl -kN` (no buffering).
- Chain/agent edits via the dashboard or `/api/chains*`, `/api/roles-config`,
  `/api/agents` are applied live AND persisted to config.json (no restart). Only manual
  hand-edits of config.json require a restart.
- Agents persist until `deregister_agent` — they do NOT auto-remove on disconnect.
- If the persona pack integration isn't installed yet, roster queries return empty
  (check `GET /api/integrations/defaults`).

- Port is 6868, NOT 4200.

## Verification

```bash
# Health check
curl -sk https://localhost:6868/api/status | python3 -m json.tool

# List active workers
curl -sk https://localhost:6868/api/agents | python3 -m json.tool

# Test MCP tool
curl -sk -X POST https://localhost:6868/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_dashboard","arguments":{}}, "id":1}' | python3 -m json.tool

# Watch events
curl -kN https://localhost:6868/api/events
```

## Systemd Service

```bash
systemctl --user status cowork-mcp      # Check status
systemctl --user restart cowork-mcp     # Restart
systemctl --user enable cowork-mcp      # Enable at boot
```

The service runs from the repo's `server/` directory
(`WorkingDirectory`), loading `~/.cowork/config.json` (override: `COWORK_CONFIG`; the repo's
`config.json` is only a template). The old `agents-coworking` path is
retired.

## Auth (hub API key, 2026-10-18)

The hub requires an API key on every `/api` and `/mcp` request:
`curl -H "Authorization: Bearer $COWORK_API_KEY" …` (or `X-API-Key`). Dispatched tasks and the
agent clients get `COWORK_API_KEY` in their environment; MCP client configs carry it as a
header. Never paste the key into task text, output or artifacts.
