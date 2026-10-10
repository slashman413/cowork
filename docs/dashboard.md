# Dashboard — Page-by-Page Manual

The Cowork web UI (served from `server/public/`, default `http://localhost:6868`)
is a single-page app with a left-hand nav. This is a reference for **every page**,
what it shows, and which REST endpoints back it — so you can drive the same
behavior from scripts when you want to.

Nav order and labels (from `server/public/index.html`):

| Page | Label | Backing endpoints (main) |
|------|-------|--------------------------|
| [Overview](#overview) | Overview | `GET /api/status`, `GET /api/system`, `GET /api/system/details/:kind` |
| [Portal](#portal) | Portal | `GET /api/portal` (portal.json) + `GET /api/services` |
| [Chat](#chat) | Chat | `POST /api/inbox`, `GET /api/inbox/:id` |
| [Inbox](#inbox) | Task Inbox | `GET/POST /api/inbox`, `PATCH /api/inbox/:id` |
| [Workflows](#workflows) | Workflows | `GET /api/workflows*`, `POST /api/workflows/:id/run`, `GET /api/workflow-runs*` |
| [Agents](#agents) | Agents | `GET/PUT /api/agents-config`, `/api/chains*` |
| [Brains](#brains) | Brains | `GET/PUT/DELETE /api/brains*` |
| [Agencies](#agencies) | Agencies | `GET /api/roster`, `/api/roster-divisions` |
| [Connections](#connections) | Connections | `GET /api/connections` |
| [Configuration](#configuration) | Configuration | `GET /api/config` |

All pages consume the live SSE event stream (`GET /api/events`) so cards update in
place as tasks are created, claimed, and completed.

---

## Overview

(Formerly "Dashboard"; old `#dashboard` links still land here.)

The at-a-glance overview (`GET /api/status` → `DashboardData`):

- **Host metrics bar** — CPU / GPU / Memory / Core Temp tiles from `GET /api/system`,
  refreshed every 3s. **Click a tile** for a live detail dialog
  (`GET /api/system/details/cpu|gpu|memory|thermal`, refreshed every 2.5s while open):
  - **CPU** — model mix, load averages, task counts, uptime, per-core usage + clock,
    and the top processes by *current* CPU (with their docker container).
  - **GPU** — per-GPU utilisation, memory (or "unified" on GB10), temperature,
    power, clocks, P-state, driver, UUID, and the processes holding GPU memory.
  - **Memory** — used / cache / free breakdown, the full meminfo summary, swap,
    GPU allocations (on unified memory these are *not* in any process's RSS), and
    the top processes by resident memory.
  - **Temp** — every thermal zone plus GPU temperature.

- **Active agents** — how many MCP clients are currently registered.
- **Inbox summary** — counts for `pending`, `scheduled`, `waitingInput`,
  `inProgress`, `completed`, and `failed` (tasks that exhausted their fallback
  chain).
- **Platform status** — per-platform up/down.
- **Agencies count** and **uptime**.

Use it to confirm the server is live and to see the shape of the queue before
diving into the Inbox.

---

## Portal

A **launcher** for the self-hosted web services this host runs. Nothing is
hard-coded in the UI — the whole catalog comes from **`portal.json`**:

- Repo `portal.json` = the default catalog (this DGX Spark's services). The live
  copy is **`~/.cowork/portal.json`** (override with `COWORK_PORTAL`), seeded from
  the repo file on first start. An install that still had a `services` block in
  `config.json` gets those entries merged into the seeded file once; after that
  `config.services` is ignored.
- The file is **hot-reloaded** — save it and refresh the Portal, no restart.
  Invalid entries are listed in a warning box above the cards; a file that fails
  to parse keeps serving the last good catalog.

```jsonc
{
  "accent": "#2563EB",                       // default card colour
  "categories": ["Knowledge", "Dev", "Ops"], // section order; unlisted ones sort after A→Z
  "services": {
    "forgejo": {
      "url": "http://localhost:3001",        // required: http(s)://… or a /path on the dashboard
      "label": "Forgejo",
      "description": "Self-hosted Git server.",
      "icon": "git-fork",                    // any lucide icon name
      "category": "Dev",
      "enabled": true,                       // false = listed, never probed
      "order": 1,                            // position inside its category
      "accent": "#F97316",                   // per-card colour
      "probe": "http://localhost:3001/api/healthz", // health-check URL, or false
      "unit": "forgejo.service",             // systemd --user unit → Start/Stop/Restart
      "controllable": true                   // also expose Autostart toggle
    }
  }
}
```

`localhost` URLs are rewritten to the dashboard's own host so links work from
other machines. Status dots come from `GET /api/services`, probed server-side every
3s. Lifecycle buttons additionally need `serviceControl.enabled` and
`server.apiKey` in `config.json` (that security switch stays there on purpose).
The `obsidian` key is special: its status is "vault exists on disk", not an HTTP probe.

---

## Chat

A direct line to the company. A chat message is **the same `POST /api/inbox`
contract as any task** — you're really creating a task and streaming its result
back into the transcript. The composer lets you:

- pick a **brain**, a **division**, or a specific **agent** (a two-stage picker;
  an empty division = auto-route), or leave it all on auto;
- attach files (staged as task **inputs**);
- keep a per-session transcript (persisted across nav within a session).

The composer **locks per brain** (not globally) while a message is in flight, so
you can hold several conversations at once. Recent sessions appear as chips you can
reopen or delete. Chat never auto-re-renders mid-typing — it updates only the
transcript.

Think of Chat as "dispatch one task and watch it," versus the Inbox's "manage all
tasks."

---

## Inbox

The task queue and the heart of the operator view. Each card is a `Task`
(`types.ts`). Statuses you'll see:

- `wait-input` — holding an unanswered human-in-the-loop **interaction** packet;
  deliberately held out of scheduling until a person submits answers.
- `scheduled` — a future `scheduledAt` launch time; released to `pending` when due.
- `pending` — eligible for routing/claiming.
- `claimed` / `in-progress` — a brain is (or is about to be) working it.
- `done` — completed and verified.
- `rejected` / `failed` — `failed: true` marks a task that exhausted its whole
  fallback chain; the UI groups these red and offers a confirm-gated re-run.

What you can do here:

- **Create** a task (`POST /api/inbox`), optionally attaching uploaded files
  (`POST /api/uploads` → token → `inputs: [{token, name}]`).
- **Claim / complete** (`PATCH /api/inbox/:id`).
- **Re-run** a failed task (`POST /api/inbox/:id/rerun`) — reset to pending from
  the top of its chain, keeping its inputs.
- **Attach inputs** to an existing task (`GET/POST /api/inbox/:id/inputs`).
- **Download artifacts** a task produced (`GET /api/artifacts/:taskId/:file`).

Tasks created by a workflow run carry `context.workflowId` / `workflowRunId` /
`stepKey`, which is how the Workflows tab groups them (see below).

---

## Workflows

Declarative pipelines — this page renders each template as a **live graph** (fan-
through pipelines and fan-out/fan-in diamonds), with **Dry run** and **Run**
controls, and renders each run's live status (a DAG for static runs, a decision
timeline for adaptive ones).

This page is documented in full in **[workflow-builder.md](workflow-builder.md)** —
read that for the schema, both execution modes, authoring, configuration, and the
complete REST surface.

Backing endpoints: `GET /api/workflows`, `/api/workflows/:id`,
`/api/workflows-invalid`, `POST /api/workflows`, `PUT /api/workflows/:id`,
`POST /api/workflows/:id/run`, `GET /api/workflow-runs`, `/api/workflow-runs/:runId`.

---

## Agents

Edit **who runs what** without touching code. Two kinds of worker:

- **Special (non-Agencies) executors** — `orchestrator` (router/decomposer),
  `generalist` (fallback), `video` (media pipeline). Each has its own ordered
  **brain fallback chain** (`orchestration.agents[*].brains`), edited here
  (`GET/PUT/DELETE /api/agents-config`).
- **Agencies agents** — resolved through **chains**: the global `defaultChain`, a
  per-division override (`divisionChains[*]`), or a per-agent override
  (`agentChains[*]`, highest precedence). Edited via `GET/PUT /api/chains`,
  `/chains/default`, `/chains/division/:div`.

A chain is an **ordered list of brain ids**: `brains[0]` is tried first, and on
failed verification the dispatcher hands the task to `brains[1]`, then `brains[2]`,
and so on. Chains are drag-sortable in the UI. This is why shipped workflows pin a
`division`/`agent` and never a `brain` — you retune execution here, live.

---

## Brains

The **brain registry** (`GET/PUT/DELETE /api/brains`). A *brain* is a concrete
execution identity — a specific model on a specific platform at a specific
location (`BrainConfig`):

- **local** brains (`location: "local"`) are spawned by the dispatcher itself
  (`exec`: `claude` / `hermes` / `agy` / `codex` / `ollama` / `script`, plus
  `model`/`command`).
- **remote** brains (`location: "remote"`) are left in the inbox for that remote
  MCP client to claim itself (`host` is a routing hint).

Brains can be configured by hand or **auto-registered** by a connecting MCP client
(`dynamic: true`) with an `env` manifest of machine-detected facts (paths, tools,
credential *names*, net, traits) so the router can avoid landing a task on a host
that lacks what it needs. Deleting a brain cascades — it's removed from every chain
that referenced it.

---

## Agencies

The full catalog of specialist agents (`GET /api/roster`, filterable by division;
`GET /api/roster-divisions` groups them for this view). Each `AgentCard` carries a
slug, name, description, emoji/color/vibe, and division. This is the pool the
two-stage router picks from when a task isn't pinned to a specific agent — browse
it to learn which specialist a `division`/`agent` pin will reach.

---

## Connections

Live MCP clients and their usage (`GET /api/connections`). Shows:

- each connected client (by heartbeat) and the brains it offers;
- per-brain **ran / submitted** counters;
- for brains whose `exec` has a queryable rate limit (claude, codex, …), the
  **usage windows** — percent used and reset time — from `BrainUsage`
  (local brains probed by the server; remote brains self-report via heartbeat).
  Brains with no external quota (hermes/ollama/script) stay hidden here.

Use this to see who's actually online and how close a metered brain is to its cap.

---

## Configuration

The current server configuration (`GET /api/config`), including `paths`,
`platforms`, `services`, `inbox`, and the full `orchestration` block (chains,
brains, classifier, verifier, `maxConcurrent`, `pollIntervalMs`, `taskTimeoutMs`,
`maxWorkflowSteps`, stale/hard claim bounds, etc.). This view is the read model for
the settings the Agents and Brains pages edit.

---

*See also: [../README.md](../README.md) for the project overview and quick start,
[../PROTOCOL.md](../PROTOCOL.md) for the task protocol, and
[../JOIN-AS-A-BRAIN.md](../JOIN-AS-A-BRAIN.md) for connecting a remote brain.*
