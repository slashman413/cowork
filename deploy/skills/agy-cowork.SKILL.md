---
name: cowork
description: Full-lifecycle Cowork multi-agent framework skill — register brains, dispatch and schedule tasks, collect artifacts, run workflows, and administer the local Cowork MCP server at http://localhost:6868.
---

# Cowork — Multi-Agent Coordination Skill

You are connected to the **Cowork MCP server** at `http://localhost:6868/mcp` (configured
in `~/.gemini/config/mcp.json`). Cowork is a filesystem-based MCP server + Web UI
dashboard that enables multi-platform AI agents (Claude Code, Antigravity, Hermes, Gemini
CLI, and others) to coordinate, dispatch tasks, and share results through a single pane of
glass.

> **There is no report store.** `file_report` and `complete_task(report_path:)` were
> removed. A task's complete record is `task.result` + `artifacts/<task-id>/`.

> **Operating rules:** every task you execute runs under [CONVENTIONS.md](https://github.com/slashman413/cowork/blob/main/CONVENTIONS.md) —
> put output in `$COWORK_ARTIFACTS_DIR`, use your full permissions freely, and ask
> rather than guess when blocked. They are injected into your prompt automatically.

## When to Use

- "Dispatch a task to Claude / Hermes for code review" / "create a task for another agent"
- "Show me the agencies" / "what agents are available"
- "Check my inbox" / "list pending tasks"
- "Schedule this for 9am tomorrow" (`create_task(scheduled_at: …)`)
- "Show the dashboard" / "what's happening across agents"
- "Register this agent" / "add my brains"
- Cross-platform agent coordination (Antigravity, Claude Code, Hermes, Codex, etc.)
- Heartbeat monitoring / agent lifecycle management

## Prerequisites

- **Cowork MCP server**: systemd user service `cowork-mcp.service` (auto-starts at boot)
  - Config: `~/.cowork/config.json`
  - Port: 6868, no API key required
- **Antigravity MCP endpoint**: `~/.gemini/config/mcp.json` →
  `{ "mcpServers": { "cowork": { "url": "http://localhost:6868/mcp" } } }`
- **Brain client service**: `cowork-local-brain@agy.service` (systemd user unit)
  - Config: `~/.config/cowork-local-brain/agy.env`
  - Script: `~/workspace/github/slashman413/cowork/deploy/remote-brain-client.mjs`
- **Cowork repo**: `~/workspace/github/slashman413/cowork/`
- `agency-agents` — a git submodule at `./agency-agents` (init: `git submodule update --init`)

## Key Paths

| Path | Purpose |
|------|---------|
| `~/.gemini/config/mcp.json` | Antigravity MCP server connections |
| `~/.cowork/config.json` | Server configuration (port, brains, chains, orchestration) |
| `~/.config/cowork-local-brain/agy.env` | Brain client env (COWORK_URL, BRAINS, EXEC, HOST) |
| `~/.config/systemd/user/cowork-local-brain@.service` | Systemd template unit |
| `~/workspace/github/slashman413/cowork/` | Source repo |
| `inbox/` | Task queue (JSON files, server-owned — never edit by hand) |
| `artifacts/<task-id>/` | Per-task OUTPUT files — write yours here; downloadable from the Inbox |
| `inputs/<task-id>/` | Per-task INPUT files a person attached — read-only |
| `decisions/lessons.jsonl` | Lesson ledger (server-owned, gitignored) |
| `.status/` | Runtime state (auto-managed) |
| `deploy/remote-brain-client.mjs` | Remote brain registration script (zero-config) |

## Registered Local Brains (via `agy.env`)

| Brain ID | Model | Location |
|----------|-------|----------|
| `local-agy-gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | local |
| `local-agy-gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | local |
| `local-agy-gemini-3.6-flash-low` | Gemini 3.6 Flash (Low) | local |
| `local-agy-gemini-3.5-flash-high` | Gemini 3.5 Flash (High) | local |
| `local-agy-gemini-3.5-flash-medium` | Gemini 3.5 Flash (Medium) | local |
| `local-agy-gemini-3.5-flash-low` | Gemini 3.5 Flash (Low) | local |
| `local-agy-gemini-3.1-pro-high` | Gemini 3.1 Pro (High) | local |
| `local-agy-gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | local |
| `local-agy-claude-sonnet-4-6` | Claude Sonnet 4.6 | local |
| `local-agy-claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | local |
| `local-agy-gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | local |

---

## MCP Tools Reference

All tools are called via the `cowork` MCP server. Use these tools directly.

### Agent Lifecycle

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `register_agent` | Register as a worker; declare brains (supports `env` capability manifests) | `platform`, `agent_name`, `capabilities[]`, `brains[]` |
| `deregister_agent` | Remove agent AND cascade-remove all its brains | `agent_id` |
| `heartbeat` | Keep-alive; report status and current task | `agent_id`, `status` (`idle`/`working`/`blocked`), `current_task` |

### Task Management

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `create_task` | Create a cross-platform task | `title`, `description`, `from_platform`, `from_agent`, `to_platform`, `to_agent`, `priority`, `context`, `tags`, `scheduled_at`, `interaction` |
| `list_inbox` | List tasks (filterable by status/platform) | `status` (`wait-input`/`scheduled`/`pending`/`claimed`/`in-progress`/`done`/`rejected`), `platform`, `agent`, `limit` |
| `claim_task` | Claim a pending task | `task_id`, `agent_id` |
| `complete_task` | Mark task as done with result | `task_id`, `result` |

`scheduled_at` (ISO 8601) parks a task as `scheduled` until its launch time — default is
run now. `interaction` (`{prompt?, fields:[{id,label,type?,options?,required?}]}`) renders
a form on the Inbox card and holds the task on `wait-input` until a person answers; their
replies arrive on `context.humanInput`.

### Agencies & Intelligence

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `get_roster` | Search the Agencies (~285 agents) | `division`, `search`, `limit` |
| `get_dashboard` | Full dashboard snapshot | _(none)_ |

---

## Agent Registration (with Brains)

Register once per session with `register_agent`, declaring your brains so they propagate
into the brain registry (visible under **Connections** and targetable via `context.brain`):

```
register_agent(
  platform="antigravity",
  agent_name="local",
  capabilities=[
    "local-agy-gemini-3.6-flash-high",
    "local-agy-gemini-3.6-flash-medium",
    "local-agy-gemini-3.6-flash-low",
    "local-agy-gemini-3.5-flash-high",
    "local-agy-gemini-3.5-flash-medium",
    "local-agy-gemini-3.5-flash-low",
    "local-agy-gemini-3.1-pro-high",
    "local-agy-gemini-3.1-pro-low",
    "local-agy-claude-sonnet-4-6",
    "local-agy-claude-opus-4-6-thinking",
    "local-agy-gpt-oss-120b-medium"
  ],
  brains=[
    {"id": "local-agy-gemini-3.6-flash-high",   "location": "local", "exec": "agy", "model": "gemini-3.6-flash-high"},
    {"id": "local-agy-gemini-3.6-flash-medium",  "location": "local", "exec": "agy", "model": "gemini-3.6-flash-medium"},
    {"id": "local-agy-gemini-3.6-flash-low",     "location": "local", "exec": "agy", "model": "gemini-3.6-flash-low"},
    {"id": "local-agy-gemini-3.5-flash-high",    "location": "local", "exec": "agy", "model": "gemini-3.5-flash-high"},
    {"id": "local-agy-gemini-3.5-flash-medium",  "location": "local", "exec": "agy", "model": "gemini-3.5-flash-medium"},
    {"id": "local-agy-gemini-3.5-flash-low",     "location": "local", "exec": "agy", "model": "gemini-3.5-flash-low"},
    {"id": "local-agy-gemini-3.1-pro-high",      "location": "local", "exec": "agy", "model": "gemini-3.1-pro-high"},
    {"id": "local-agy-gemini-3.1-pro-low",       "location": "local", "exec": "agy", "model": "gemini-3.1-pro-low"},
    {"id": "local-agy-claude-sonnet-4-6",        "location": "local", "exec": "agy", "model": "claude-sonnet-4-6"},
    {"id": "local-agy-claude-opus-4-6-thinking", "location": "local", "exec": "agy", "model": "claude-opus-4-6-thinking"},
    {"id": "local-agy-gpt-oss-120b-medium",      "location": "local", "exec": "agy", "model": "gpt-oss-120b-medium"}
  ]
)
```

Save the returned `id`. The server auto-registers each declared brain. Declaring the
**same ids** the box already uses just refreshes them (idempotent) — do NOT invent new
ids for the same models.

> ⚠️ The background brain client (`cowork-local-brain@agy.service`) already handles
> brain registration and task polling automatically. Interactive Antigravity sessions
> typically only need to **create tasks**, **check the inbox/dashboard**, and
> **file reports** — you do NOT need to re-register brains that the systemd service
> already declared.

> ⚠️ Do **not** call `deregister_agent` for these local brains on exit — it cascades
> them out of the default/division chains that the box's config depends on. Just
> disconnect; brains persist (they're only removed by an explicit deregister).

### Brain Environment Manifests (`env`)

When declaring brains in `register_agent`, each brain object supports an optional `env` capability manifest (`BrainEnv: { paths[], tools[], secrets[], traits[] }`):
- **Purpose**: Enables the router to avoid dispatching tasks to hosts lacking required CLI tools, directory paths, or credentials.
- **Secrets Rule (Zero Leakage)**: The `secrets` array must declare credential **names only** (e.g., file basenames under `~/.priv/`), **never** secret values or file contents.
- **Auto-Detection**: `deploy/remote-brain-client.mjs` automatically calls `detectEnv()` to probe installed binaries (`$ENV_TOOLS` or standard list), directories (`$ENV_PATHS`), and secret file basenames. The Cowork server defensively caps each list to ≤200 items of ≤300 characters (`capEnv`).

---

## Dispatcher — Automatic Execution (Two-Stage Routing)

The always-on coordinator (shown in **Connections** as `cowork/orchestrator`) polls the
inbox and executes any task that resolves to an executor. Routing is **two-stage**:
an orchestrator/classifier brain (default Qwen3.6-35B-A3B) first picks a **division**
(1 of 19), then picks an **agent** (1 of 285) inside it. The chosen agent's full
`.md` persona (from the `agency-agents` repo) becomes the system prompt, run on the
division's brain chain. You can also target directly: `context.agent: "<agent-slug>"`
or a special-executor name skips classification.

### Executors: Special Agents + the Agencies

- **Special executors** live in `config.json → orchestration.agents` (only
  `orchestrator`, `generalist`, `video`) — each is `{description, brains: [...]}` with
  its own chain. Edit in the dashboard **Agents** view → *Special executors*
  (or `PUT /api/agents-config/:name`).
- **Agencies agents** are the 285 personas in `agency-agents`, grouped into 19 divisions
  (`GET /api/roster-divisions`). They don't carry their own chain — they run on the
  **division chain** if one is set, else the **global default chain**.

### Brain Fallback Chains (Global Default + Per-Division Override)

- **Global default**: `config.json → orchestration.defaultChain` — the fallback chain
  every agent uses unless its division overrides it. Reorder by **drag & drop**
  in the dashboard **Brains** view (`PUT /api/chains/default`).
- **Per-division override**: `orchestration.divisionChains[<division>]` — set/clear in
  the **Agents** view per division (`PUT /api/chains/division/:division`; empty body
  reverts to the default).
- A chain runs top → bottom: task runs on `chain[0]`; on failure the dispatcher **hands
  over to `chain[1]`, then `[2]`…**, filing a report each attempt, until success or the
  chain is exhausted. `remoteGraceMs` (default 60s) auto-advances past a **remote** rung
  whose owning client hasn't claimed it, so a cold remote brain never stalls the chain.
- Pin one task to a specific brain with `context.brain: "<id>"` (overrides the chain).

### Brains = Model × Platform × Location

`config.json → orchestration.brains` (`GET /api/brains`) — the execution identities a
chain references: `local-ha-qwen35b/-deepseek` (Hermes),
`local-cc-opus/-sonnet/-fable` (Claude), `local-agy-*` (Antigravity/Gemini),
`local-comfy-ltx` (LTX video), `remote-<host>-…`. **Local** brains
the dispatcher spawns; **remote** brains it leaves `pending` for that machine's client
to claim.

- **Brains auto-register**: a connecting client declares them via `register_agent`'s
  `brains` field; `deregister_agent` (or the Brains UI) removes them and cascades the
  removal out of the default chain, every division chain, and every special agent.
- **Remote brain client**: poll `list_inbox(status:"pending")`, take tasks whose
  `context.brain` is one of yours, `claim_task` → run → `complete_task`. Ready-made
  helper: `deploy/remote-brain-client.mjs`; onboarding doc: `JOIN-AS-A-BRAIN.md`.

### Execution Timeouts & agy `--print-timeout`

When the Cowork dispatcher launches Antigravity (`agy`) as a worker in print mode (`agy -p`), it automatically appends `--print-timeout ${taskTimeoutMs}ms` (pinning to Cowork's `config.json -> orchestration.taskTimeoutMs`, default 50 minutes / 3,000,000 ms). This prevents agy's default `5m0s` print mode wait cap from prematurely aborting multi-step operations (such as compiling or building and pushing repositories). Cowork acts as the sole timeout authority.

### Lesson Ledger (WF-1 Cross-Task Memory)

Cowork features an event-driven, human-gated learning system. When a task fails verification or parks on `wait-input`, the dispatcher deterministically extracts required tools, paths, and secrets (`extractRequires`) and appends a structured record to `decisions/lessons.jsonl`. Ledger logging is fail-soft and never throws or breaks dispatch loops, laying the foundation for human-gated proposals and routing rule improvements without autonomous background improver agents.

---

## Operating as a Brain Worker

When invoked to operate as a Cowork brain (rather than interactive use), follow this
lifecycle:

### Step 1 — Register

```json
{
  "platform": "antigravity",
  "agent_name": "local",
  "capabilities": ["local-agy-gemini-3.1-pro-high"],
  "brains": [{
    "id": "local-agy-gemini-3.1-pro-high",
    "location": "local",
    "exec": "agy",
    "model": "gemini-3.1-pro-high"
  }]
}
```

Save the returned `agent_id` — you need it for all subsequent calls.

### Step 2 — Poll & Execute Loop

```
loop:
  1. heartbeat(agent_id, status="idle")
  2. list_inbox(status="pending", limit=50)
  3. Filter for tasks where context.brain matches one of your brain IDs
  4. claim_task(task_id, agent_id)
  5. heartbeat(agent_id, status="working", current_task=<task title>)
  6. Execute the task — write output files into $COWORK_ARTIFACTS_DIR
  7. complete_task(task_id, result)
  8. heartbeat(agent_id, status="idle")
  9. Wait POLL_MS (default 5000ms), repeat
```

### Step 3 — Deregister on Exit

Always call `deregister_agent(agent_id)` before stopping. Brains are NOT auto-removed
on disconnect — they persist until explicitly deregistered, and ghost brains will clutter
the dashboard.

---

## Procedure (Interactive Use)

### 1. Check Dashboard

```
get_dashboard()
```

Shows active agents, inbox stats, and service health (`vllm`, `firecrawl`, and the `forgejo` self-hosted Git server at `http://localhost:3001`). The Portal launcher categorizes services (e.g., Forgejo under **Dev**).

### 2. Heartbeat

Call `heartbeat` periodically to keep your agent active on the dashboard:

```
heartbeat(agent_id="<your-agent-id>", status="working", current_task="Doing X")
```

Statuses: `idle`, `working`, `blocked`. Agents are pruned after ~10 min without heartbeat.

### 3. Dispatch a Task

```
create_task(
  title="Task title",
  description="Full description with context",
  from_platform="antigravity",
  from_agent="local",
  priority="normal",
  context={"role": "orchestrator"},
  tags=["orchestrator"]
)
```

Add `context: {"role": "<role>"}` to have the server execute it automatically via the
dispatcher. For direct targeting: `context: {"agent": "<agent-slug>"}` or
`context: {"brain": "<brain-id>"}`.

### 4. Check Inbox

```
list_inbox(status="pending", platform="antigravity")
```

### 5. Claim + Complete Tasks

```
claim_task(task_id="<id>", agent_id="<your-agent-id>")
complete_task(task_id="<id>", result="Results here")
```

### 6. Deliver the Output (No Reports)

Write every file you produce into `$COWORK_ARTIFACTS_DIR` (= `cowork/artifacts/<task-id>/`,
already your working directory) using **relative paths** — those become the downloadable
artifacts on the task card. Your stdout becomes `task.result`; long output is truncated
there but saved in full as `result.md`, so the deliverable belongs in a file, not only in
stdout. Do not write outside that directory unless the brief names a destination, and do
not invent filenames — the artifact list is read off disk.

If you cannot finish without a decision only the user can make, end your output with a
line beginning `NEEDS_INPUT:` followed by your question(s), one per line. The dispatcher
parks the task on `wait-input` and re-dispatches it once the user answers. Never emit a
rate-limit or quota notice as the deliverable — the verifier rejects those and hands the
task to the next brain in the chain.

### 7. Query Agencies

```
get_roster(division="engineering", search="keyword")
```

---

## CEO Flow

Tell any agent (e.g. Hermes on Discord) an idea → it files ONE `orchestrator` task → the
orchestrator decomposes and fans out → results + full transcripts appear on the dashboard.
Each task's full output is its `result` (plus `result.md` and any files in
`artifacts/<task-id>/`).

When dispatching from Antigravity:

1. FIRST check `list_inbox` (status pending + in-progress): if the request is already
   covered by existing tasks (an orchestrator may have decomposed it into subtasks),
   do NOT file new ones; report status instead.
2. Create EXACTLY ONE orchestrator task via `create_task`:
   - `title`: the idea in one line
   - `description`: the full request, verbatim + context
   - `from_platform`: `"antigravity"`, `from_agent`: `"local"`
   - `context: {"role": "orchestrator"}`, `tags: ["orchestrator"]`
3. Track progress with `list_inbox` / `get_dashboard`; results appear on the task card;
   any generated files land in `cowork/artifacts/<task-id>/` (downloadable).

---

## Workflows

Workflows are reusable JSON templates in `cowork/workflows/`. Two modes:

### DAG Mode (default)

Static, deterministic. Steps form a DAG wired by `dependsOn`. The entire graph is
expanded into inbox tasks up front.

```json
{
  "id": "content-pipeline",
  "params": ["topic"],
  "steps": [
    { "key": "research", "title": "Research: {{topic}}", "division": "marketing" },
    { "key": "draft", "title": "Draft {{topic}}", "division": "marketing", "dependsOn": ["research"] },
    { "key": "review", "title": "Review {{topic}}", "agent": "code-reviewer", "dependsOn": ["draft"] }
  ]
}
```

### Orchestrated Mode

Adaptive, LLM-driven. Steps are a candidate library. After each step completes, the
orchestrator brain decides the next step or says `DONE`.

```json
{
  "id": "adaptive-research",
  "mode": "orchestrated",
  "goal": "Produce a decision-ready brief answering: {{question}}",
  "params": ["question"],
  "steps": [
    { "key": "scope", "title": "Scope the question" },
    { "key": "deep-dive", "title": "Deep dive on the crux" },
    { "key": "brief", "title": "Write the decision brief" }
  ]
}
```

### Running a Workflow

```
POST http://localhost:6868/api/workflows/<id>/run
Body: { "params": { "topic": "value" }, "dryRun": false }
```

---

## Goals (Long-Lived Objectives)

State lives in `goals/<goalId>.json`. A Goal drives toward one **binary success
criterion** using the ordinary task machinery, via two roles:

- **Achiever** — takes exactly ONE move per turn: `evaluate` (answer the Yes/No gate),
  `plan` (append the next phase), `emit` (generate that phase's tasks), or `block`
  (declare an obstacle it can't clear, with the condition to resume).
- **Judger** — wakes when a phase's terminal task finishes, writes a report + meeting
  minutes into artifacts, and re-arms the Achiever.

A Goal ends **`achieved`** when the criterion is met — the only terminal state. If it hits
an obstacle it can't clear itself it goes **`blocked`**: a *recoverable* hold recording the
reason **and** `unblockCriteria`, the specific condition that would let it resume. `blocked`
is **self-healing**: the drive loop **auto-resumes** it on an exponential backoff (minutes,
then hours) for a HALF-OPEN probe, so it recovers on its own once the obstacle clears —
recovery never waits on a human. Never a silent "done" and never a silent give-up — a human
can **resume now** to retry immediately, or **delete** it if it's truly dead. Turns only
occur when no generated task is open.

### Scheduled Checkpoints (`scheduledAt`)

An emitted task may carry a future `scheduledAt` (ISO 8601):

```json
{ "kind": "emit",
  "tasks": [ { "title": "Measure MRR", "scheduledAt": "2026-09-14T00:00:00Z" } ] }
```

Because `scheduled` is an **open** status, an outstanding checkpoint keeps the Goal
non-quiescent — it takes **no turns and spends no budget** while real-world time
passes. Emitting a checkpoint is the correct move whenever the next honest step is to
let the world change (a month of revenue, a search-indexing window); it is not a stall.
Unparseable or already-past times are dropped and the task simply runs now, so one bad
date can never abort an emit.

### Two Guards Block a Goal (recoverably)

| Guard | Counts | Default |
|-------|--------|---------|
| `stepBudget` | **Lifetime** execution tasks generated | 24 |
| `MAX_GOAL_FAILURES` | **Consecutive** Achiever turns that neither plan nor emit | 5 |

An `evaluate{met:false}` is one of those non-progressing turns. When a guard trips the
Goal is **blocked with a concrete resume contract** (raise the budget / narrow the
criterion, or verify the brain) and then **auto-retried on a backoff** — a transient brain
blip self-heals in minutes, and raising the budget lets it self-resume with no click; held,
not thrown away. Both guards punish
metric-open objectives ("$10k/month"), which is why such a Goal needs an
**evidence-bound** criterion ("does a dated snapshot in artifacts show X?" rather than
"is X true?"), a phase loop that always has real work to emit, scheduled checkpoints,
and a budget sized for the horizon. The dashboard's 💰 📈 🧲 starters ship set up this
way; copy that shape rather than writing a bare metric.

---

## REST API Quick Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Dashboard overview (activeAgents, inboxSummary, uptime) |
| `GET` | `/api/agents` | Active agents |
| `GET` | `/api/connections` | Live MCP clients with per-brain stats |
| `GET` | `/api/roster` | Agencies (filterable by division/search) |
| `GET` | `/api/roster-divisions` | Agencies grouped by division |
| `GET` | `/api/dispatcher` | Special agents + brains + defaultChain + divisionChains + running |
| `GET/PUT` | `/api/chains/default` | Global default chain |
| `GET/PUT` | `/api/chains/division/:div` | Per-division chain |
| `GET/PUT/DELETE` | `/api/brains`, `/api/brains/:id` | Brain registry (cascades on delete) |
| `GET/PUT/DELETE` | `/api/agents-config`, `/api/agents-config/:name` | Special-executor chains |
| `GET` | `/api/artifacts/:taskId`, `/api/artifacts/:taskId/:file` | List / download task artifacts |
| `GET` | `/api/inbox?status=pending` | Inbox tasks (filterable) |
| `POST` | `/api/inbox` | Create a new task |
| `PATCH` | `/api/inbox/:id` | Claim or complete a task |
| `POST` | `/api/inbox/:id/rerun` | Re-queue a FAILED (chain-exhausted) task from the top of its chain |
| `POST` | `/api/inbox/:id/continue` | Spawn a follow-up to a finished task (same brain by default) |
| `POST` | `/api/inbox/:id/interaction` | Submit a person's answers → releases a `wait-input` task |
| `GET`/`POST` | `/api/inputs/:taskId`, `/api/inbox/:id/inputs` | List / attach task input files |
| `GET` | `/api/config` | Current configuration |
| `GET` | `/api/workflows` | Workflow templates |
| `POST` | `/api/workflows/:id/run` | Start a workflow run |
| `GET` | `/api/workflow-runs/:runId` | Run status and decision log |
| `GET`/`POST` | `/api/goals` | List goals / create one |
| `GET`/`PATCH`/`DELETE` | `/api/goals/:id` | Read, edit, or remove a goal |
| `POST` | `/api/goals/:id/activate`, `/pause`, `/block` | Drive a goal's lifecycle (`activate` also resumes a blocked goal; `block` takes a `reason` + `unblockCriteria`) |
| `GET` | `/api/goals/:id/tasks` | The tasks a goal generated |
| `GET` | `/api/events` | SSE event stream (real-time) |

### Web Dashboard

- `http://localhost:6868/` — Web UI (dashboard, Connections, inbox, reports, Agents,
  Brains, Agencies) with raw/rendered markdown viewer and artifact downloads
- **Inbox UX**: Real-time SSE updates preserve card expansion and scroll position; status pills display live counts; and a **+ New task** toolbar button lets you create and dispatch tasks with title, brief, priority, and target brain directly from the Inbox without routing through Chat.

---

## Administration & Operations

### Service Management

```bash
# Cowork MCP server
systemctl --user status cowork-mcp
systemctl --user restart cowork-mcp

# Brain client (the background Node.js process that polls and claims tasks)
systemctl --user status cowork-local-brain@agy
systemctl --user restart cowork-local-brain@agy
journalctl --user -u cowork-local-brain@agy -f   # live logs
```

### Modifying Brains

Edit `~/.config/cowork-local-brain/agy.env`, then:
1. Note the current agent ID from `.status/agents.json` or `GET /api/agents`
2. `systemctl --user restart cowork-local-brain@agy`
3. Deregister the old agent ID via `deregister_agent` MCP tool (brains persist until
   explicitly deregistered!)

### Debugging

```bash
# Test MCP endpoint with inspector
npx @modelcontextprotocol/inspector http://localhost:6868/mcp

# Quick health check
curl -s http://localhost:6868/api/status | jq

# Watch real-time SSE events
curl -N http://localhost:6868/api/events

# Check active agents
curl -s http://localhost:6868/api/agents | jq

# Check registered brains
curl -s http://localhost:6868/api/brains | jq
```

---

## Task Priority Levels

| Priority | Use When |
|----------|----------|
| `low` | Nice-to-have, no deadline |
| `normal` | Standard work item |
| `high` | Time-sensitive, blocks other work |
| `urgent` | Drop everything, handle immediately |

---

## SSE Events (Real-Time)

Subscribe at `GET /api/events` for live updates. Type names are **camelCase** and each
frame is `{ type, payload, timestamp }`:

| Event | Payload |
|-------|---------|
| `agentRegistered` | `{ agent }` |
| `heartbeat` | `{ agentId, status, currentTask? }` |
| `taskCreated` | `{ task }` |
| `taskClaimed` | `{ task, agentId }` |
| `taskCompleted` | `{ task }` |

There is no `agent_disconnected` event (silently pruned) and no `report_filed` event
(the report store was removed).

---

## Artifacts

A task that produces files (audio/video/markdown) collects them into a **persistent**
per-task dir `cowork/artifacts/<task-id>/` (never `/tmp`), downloadable from the Inbox
or `GET /api/artifacts/:taskId/:file`.

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
