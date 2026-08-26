# Multi-Agent Cowork Protocol

> Version 1.0.0 — 2026-07-23

This document defines the conventions and schemas used by the Cowork MCP Server
for multi-platform agent coordination.

> **Executing a task?** The binding operating rules are in **[CONVENTIONS.md](CONVENTIONS.md)** —
> they are injected into every dispatched prompt. Task output goes to
> `artifacts/<task-id>/`; there is no separate report store.

---

## 1. Frontmatter Schema (Universal Agent Format)

Every agent definition file uses YAML frontmatter. This is a superset of
Claude Code's format, extended with Hermes triggers and cowork fields.

```yaml
---
# === Identity (required) ===
name: Code Reviewer                     # Human-readable name
description: Code reviewer giving...    # 1-2 sentence summary

# === Presentation (optional) ===
emoji: 👁️                              # Unicode emoji
color: purple                           # Hex or CSS color name
vibe: Reviews code like a mentor...     # 1-sentence personality tagline

# === Routing (optional, Hermes-compatible) ===
triggers:
  - "review this code"
  - "check this PR"

# === Cowork extensions (optional) ===
platforms: [claude, hermes, agy]        # Which platforms can execute this
tags: [code-review, quality, security]  # Searchable tags
---
```

## 2. Task Schema (Inbox Messages)

Tasks are stored as JSON files in the `inbox/` directory:

```json
{
  "id": "task-20260723-abc123",
  "title": "Review auth middleware refactor",
  "description": "Full description of the task...",
  "from": {
    "platform": "antigravity",
    "agent": "self"
  },
  "to": {
    "platform": "claude",
    "agent": "engineering-code-reviewer"
  },
  "priority": "normal",
  "status": "pending",
  "skill": "code-handoff",
  "context": {
    "repo": "slashman413/saas-starter",
    "branch": "main"
  },
  "tags": ["refactor", "auth"],
  "scheduledAt": "2026-07-23T14:00:00.000Z",
  "createdAt": "2026-07-23T14:10:00.000Z",
  "claimedAt": null,
  "claimedBy": null,
  "completedAt": null,
  "result": null
}
```

### Task Status Lifecycle

```
scheduled ─┐
wait-input ┴→ pending → claimed → in-progress → done
                                               → rejected
```

`wait-input` — a task carrying an unanswered human-in-the-loop `interaction`
packet. It is deliberately held OUT of the `pending` pool, so the orchestrator
never schedules, routes, or reassigns it. Once a person submits their answers
(`POST /api/inbox/:id/interaction`) the task is released to `pending` and enters
normal scheduling. Tasks without an interaction packet start directly at `pending`.

`scheduled` — a task whose `scheduledAt` launch time (ISO 8601) is still in the
future. Like `wait-input` it is held OUT of the `pending` pool — never claimed,
routed, or dispatched. The dispatcher checks every tick and releases each due
task to `pending` (or to `wait-input` if it still carries an unanswered
interaction packet). **Default is "now"**: a task created without `scheduledAt`
(or with a past time) enters `pending` immediately. Set it via MCP
`create_task { scheduled_at }`, REST `POST /api/inbox { scheduledAt }`, or the
dashboard's "＋ New task" → *Run at* field.

#### Recurring tasks (flexible cadences)

A task can recur on completion. Set a `recurrence` object (or the legacy
`loopIntervalHours` shorthand); when the run finishes, a fresh iteration is
spawned at the cadence's next fire time. Supported `type`s:

| `type` | Fields | Example |
|--------|--------|---------|
| `minutes` / `hours` | `interval` | `{ "type": "hours", "interval": 6 }` |
| `daily` | `interval`, `atTime` | `{ "type": "daily", "interval": 1, "atTime": "09:00" }` |
| `weekly` | `interval`, `weekdays` (0=Sun..6=Sat), `atTime` | `{ "type": "weekly", "weekdays": [1,3,5], "atTime": "09:00" }` |
| `monthly` | `interval`, `dayOfMonth` (clamped to short months), `atTime` | `{ "type": "monthly", "dayOfMonth": 15, "atTime": "08:00" }` |
| `cron` | `expr` (5-field, server local time) | `{ "type": "cron", "expr": "0 9 * * 1-5" }` |

An optional `until` (ISO 8601) ends the series once the next slot would fall at or
after it. Wall-clock fields (`atTime`, cron) are the server's local timezone.

**Fixed-rate, not fixed-delay.** The next run is phased on the run's *intended*
launch time (`scheduledAt`), not on when it finished — so a run that executes
faster than its interval does **not** delay the next one. If a run overruns its
interval (or the host was down), the scheduler skips whole intervals forward to
the first future slot, preserving phase without emitting a burst of catch-up runs.

Set it via MCP `create_task { recurrence }`, REST `POST /api/inbox { recurrence }`
(and `/inbox/:id/edit`), or the dashboard's *Repeat* control. `loopIntervalHours`
is still honoured as `{ type: "hours", interval: N }`.

### Priority Levels

| Priority | Use When |
|----------|----------|
| `low` | Nice-to-have, no deadline |
| `normal` | Standard work item |
| `high` | Time-sensitive, blocks other work |
| `urgent` | Drop everything, handle immediately |

## 3. MCP Tools Reference

The Cowork MCP Server exposes these tools via Streamable HTTP at `/mcp`:

| Tool | Purpose |
|------|---------|
| `register_agent` | Register an agent session; optionally DECLARE runnable `brains` |
| `deregister_agent` | Remove the agent and cascade-remove every brain it registered |
| `heartbeat` | Update agent status; may carry `usage` — the client's self-measured rate-limit snapshot per brain (`{ exec, windows: [{ label, usedPct, resetsAt }], at }`), shown as meters on the Connections cards. Only metered execs (claude/codex) report; hermes/ollama/script have no quota and send nothing |
| `get_roster` | Query the Agencies (~285 agents across 19 divisions) |
| `create_task` | Create a cross-platform task; optional `scheduled_at` (ISO 8601) parks it as `scheduled` until launch time (default: run now); optional `recurrence` (or legacy `loop_interval_hours`) makes it repeat on a flexible cadence (minutes/hours/daily/weekly/monthly/cron) |
| `claim_task` | Claim a pending task |
| `complete_task` | Mark task as done |
| `list_inbox` | List tasks with filters |
| `get_dashboard` | Get aggregated dashboard data |

**Routing context** — the dispatcher reads these `task.context` fields:
`agent` (an agent slug or special-executor name → skip the classifier),
`brain` (pin one brain id; the dispatcher also *publishes* the target remote brain
here so its client can claim the task), and `division` (override the routed
division). With none set, the two-stage router picks division → agent.

## 4. SSE Events

The server pushes real-time events via Server-Sent Events at `/api/events`. Event
type names are **camelCase** and each frame is `{ type, payload, timestamp }`
(`CoworkEventPayloads` in `server/src/types.ts` is the authority):

| Event | Payload |
|-------|---------|
| `agentRegistered` | `{ agent }` |
| `heartbeat` | `{ agentId, status, currentTask? }` |
| `taskCreated` | `{ task }` |
| `taskClaimed` | `{ task, agentId }` |
| `taskCompleted` | `{ task }` |

Subscribe with `curl -N http://localhost:6868/api/events` (no buffering). There is
no `agent_disconnected` event — a client that stops heartbeating is pruned silently
— and no `report_filed` event: the report store was removed, so a task's record is
`task.result` + `artifacts/<task-id>/`.

## 5. REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Dashboard overview |
| GET | `/api/agents` | Active agents |
| GET | `/api/inbox` | Task list (query: status, platform, limit) |
| POST | `/api/inbox` | Create task |
| PATCH | `/api/inbox/:id` | Claim or complete task |
| GET | `/api/roster` | Agencies (query: division, search) |
| GET | `/api/roster/divisions` | Division metadata |
| GET | `/api/config` | Current configuration |
| GET | `/api/events` | SSE event stream |
