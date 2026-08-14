---
name: cowork
description: Coordinate with other AI agents through the Cowork MCP server: inspect the shared dashboard and inbox, dispatch, schedule, or claim tasks, search the roster, and deliver task artifacts. Use when the user asks to delegate work, check Cowork task status, or coordinate with another platform.
---

# Cowork — Multi-Agent Coordination

Use the Cowork MCP server at `http://localhost:6868/mcp` as the shared hub for
agents and brain workers. The dashboard is `http://localhost:6868/`; the source repo
is `~/workspace/github/slashman413/cowork`.

Require the `cowork` MCP server to be configured for this Codex session before calling
its tools. If it is unavailable, say so and use the dashboard or REST endpoints only
when the user has requested that alternative.

> **Operating rules:** every task you execute runs under [CONVENTIONS.md](https://github.com/slashman413/cowork/blob/main/CONVENTIONS.md) —
> put output in `$COWORK_ARTIFACTS_DIR`, use your full permissions freely, and ask
> rather than guess when blocked. They are injected into your prompt automatically.

## Local Codex brain

`cowork-local-brain@codex.service` is the persistent worker for
`local-codex-default`. It registers and polls tasks automatically. Do not register the
same brain from an interactive Codex session, and never deregister it on session exit:
that removes the brain from its fallback chains.

Inspect the worker with:

```bash
systemctl --user status cowork-local-brain@codex.service
journalctl --user -u cowork-local-brain@codex.service -n 100 --no-pager
```

## Interactive workflow

1. Register this interactive session once with `register_agent`, using
   `platform: "codex"`, a descriptive `agent_name`, and no `brains` array.
2. Save the returned agent id and send `heartbeat` when starting or completing work.
3. Check `get_dashboard()` or `list_inbox(status: "pending")` before creating work,
   to avoid duplicate tasks.
4. Dispatch with `create_task`. Supply a complete description, origin identity, and
   `context.role` for automatic roster routing. Pin `context.brain` only when a
   specific execution identity is required. Pass `scheduled_at` (ISO 8601) to park the
   task until a launch time, or an `interaction` packet to collect answers from a person
   first (the task waits on `wait-input` until they reply).
5. For assigned manual work: `claim_task` → perform it → `complete_task(task_id, result)`.
   There is no report store and no `report_path` argument — the deliverable is the result
   plus whatever you write into `$COWORK_ARTIFACTS_DIR`.

## Routing

- `context: {"role": "orchestrator"}` starts the two-stage dispatcher: it selects a
  division, then a roster persona and its brain fallback chain.
- `context: {"agent": "<roster-slug>"}` targets one roster persona.
- `context: {"brain": "local-codex-default"}` pins a task to the Codex worker.
- A `manual` tag prevents automatic dispatch.
- A failed brain rung hands the task to the next rung. Do not duplicate the task while
  handover is in progress.

## Goals

A goal (`goals/<goalId>.json`, `/api/goals`) is a long-lived objective driving toward
one binary success criterion. An **Achiever** takes one move per turn — `evaluate`,
`plan` a phase, or `emit` that phase's tasks — and a **Judger** audits each finished
phase, then re-arms the Achiever. It ends `achieved` or `abandoned` with a reason,
never a silent "done".

If you run as the Achiever, two things matter most:

- **Checkpoints.** An emitted task may carry a future `scheduledAt` (ISO 8601). Since
  `scheduled` is an open status, an outstanding checkpoint keeps the goal
  non-quiescent, so it takes no turns and spends no budget while real time passes.
  Emit one when the next honest step is to let the world change — that is the correct
  move, not a stall.
- **Never stop at an unmet criterion.** `stepBudget` (default 24) caps lifetime
  execution tasks, and 5 consecutive turns that neither plan nor emit abandon the goal
  — an `evaluate{met:false}` is one of those. Plan a different approach instead, guided
  by the Judger's latest minutes.

## Core MCP tools

| Tool | Use |
|---|---|
| `register_agent`, `heartbeat` | Maintain interactive session presence |
| `get_dashboard`, `list_inbox` | Check activity and pending work |
| `create_task`, `claim_task`, `complete_task` | Manage task lifecycle |
| `get_roster` | Find an appropriate division or agent |

Keep task results concise but complete. Save deliverable files to the task's
`$COWORK_ARTIFACTS_DIR` when executing as a worker; Cowork uploads those files as
artifacts. Do not hand-edit `inbox/`, `inputs/`, `workflow-runs/`, or `.status/` — they
are server-owned. If you cannot finish without a decision only the user can make, end
your output with a line beginning `NEEDS_INPUT:` followed by your question(s): the task
parks on `wait-input` instead of being marked done, and is re-dispatched once answered.
