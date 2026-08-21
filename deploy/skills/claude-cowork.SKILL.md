---
name: cowork
description: Coordinate with other AI agents (Hermes, Antigravity/Gemini, Codex, other Claude sessions) via the Cowork MCP server — register presence and brains, dispatch/schedule cross-platform tasks, work the shared inbox, run workflows, browse the Agencies, and collect artifacts. Use when the user wants to dispatch work to another agent/platform, check the shared task inbox, see which agents/brains are active, run a cowork workflow, or when you are executing a cowork task yourself.
---

# Cowork — Multi-Agent Coordination

The `cowork` MCP server (http://localhost:6868/mcp, systemd user service `cowork-mcp`)
is the shared coordination hub for every AI agent on this box. Repo:
`~/workspace/github/slashman413/cowork`. Dashboard: http://localhost:6868/
(remote: LAN or Tailscale IP on :6868). Live config: `~/.cowork/config.json` — the
repo's `config.json` is a **template only**; all dashboard/API edits persist to the
live copy, no restart needed.

> **There is no report store.** `file_report` was removed. A task's complete record is
> `task.result` + `artifacts/<task-id>/`. Ignore any older doc that mentions
> `file_report`, `complete_task(report_path:)`, or `/api/reports` — those endpoints and
> tools do not exist.

## The tool surface (all 9 tools, exact)

| Tool | Args that matter |
|------|------------------|
| `register_agent` | `platform`, `agent_name`, `session_id?`, `capabilities?[]`, `current_task?`, `brains?[]` → returns `id` + `registered_brains` |
| `deregister_agent` | `agent_id` — **cascades out every brain this agent registered** |
| `heartbeat` | `agent_id`, `status?` (`idle`\|`working`\|`blocked`), `current_task?`, `usage?` |
| `create_task` | `title`, `description`, `from_platform`, `from_agent`, `to_platform?`, `to_agent?`, `priority?`, `skill?`, `context?`, `tags?`, `scheduled_at?`, `interaction?` |
| `claim_task` | `task_id`, `agent_id` |
| `complete_task` | `task_id`, `result?` — **no `report_path`** |
| `list_inbox` | `status?` (`wait-input`\|`scheduled`\|`pending`\|`claimed`\|`in-progress`\|`done`\|`rejected`), `platform?`, `agent?`, `limit?` (default 20) |
| `get_roster` | `platform?`, `category?` (= division), `search?`, `active_only?` |
| `get_dashboard` | — |

Resources: `cowork://status`, `cowork://roster`.

## Session workflow

1. **Register once** before other calls. Declare your local Claude brains only if this
   box's brain client isn't already doing it (check `GET /api/brains` first —
   `local-cc-opus/-sonnet/-fable/-default` are usually already registered by the local
   brain service, and re-declaring the **same ids** is a harmless idempotent refresh):
   ```
   register_agent(
     platform: "claude",
     agent_name: "<short name for this session/box>",
     capabilities: ["local-cc-opus", "local-cc-sonnet", "local-cc-fable"],
     brains: [
       { id: "local-cc-opus",   location: "local", exec: "claude", model: "claude-opus-4-8" },
       { id: "local-cc-sonnet", location: "local", exec: "claude", model: "claude-sonnet-5" },
       { id: "local-cc-fable",  location: "local", exec: "claude", model: "claude-fable-5" }
     ]
   )
   ```
   Save the returned `id`. Omit `brains` entirely if you're only dispatching/observing.
   > ⚠️ **Never call `deregister_agent`** for shared local brains on exit — it cascades
   > them out of the default chain, every division chain, and every special agent, and
   > the box's routing config depends on them. Just disconnect; brains persist.
2. **Heartbeat** when starting/finishing work: `heartbeat(agent_id, status, current_task)`.
   Agents are pruned after ~10 min of silence (brains are not).
3. **Dispatch**: `create_task(...)` with a `context` that routes it (below).
4. **Work the inbox**: `list_inbox(status:"pending")` → `claim_task` → do the work →
   `complete_task(task_id, result)`. Claims are atomic — first caller wins.
5. **Situational awareness**: `get_dashboard()`, `get_roster(search?, category?)`.

## Routing — what to put in `context`

| Field | Effect |
|-------|--------|
| `agent` (or `role`, alias) | An agent slug or special-executor name → **skips the classifier** |
| `division` | Force the division; the router still picks the persona |
| `brain` | Pin one brain id → overrides the whole chain |
| `dependsOn: [taskIds]` | Gate until those finish, then inject their results into the brief |
| `humanInput` | Answers from a human-in-the-loop round (server-written, read-only to you) |

With none of these set, an **LLM router** runs two stages: pick 1 of 19 **divisions**,
then 1 of ~285 **agents** in it; that agent's full `.md` persona becomes the
system prompt. Tag a task `manual` to skip routing and dispatch entirely.

Special executors (`orchestration.agents`): `orchestrator`, `generalist`, `video` only.
The **CEO flow** is one `context: {"agent": "orchestrator"}` task carrying the raw idea
— the orchestrator decomposes it and fans out subtasks itself. Before filing one, check
`list_inbox` for pending/in-progress work that already covers the request.

## Task lifecycle

```
scheduled ─┐
wait-input ┴→ pending → claimed → in-progress → done
                                              → rejected / failed(chain exhausted)
```

- **`scheduled`** — `create_task(scheduled_at: "<ISO 8601>")` parks the task out of the
  pending pool until its launch time. Omit it (or pass a past time) to run now. A goal
  Achiever can park its own work the same way via `scheduledAt` on an emitted task —
  see Goals below, where it doubles as the checkpoint mechanism.
- **`wait-input`** — held out of the pending pool, never routed, until a person answers.
  Two ways in: (a) you attach an `interaction` packet at creation
  (`{prompt?, fields:[{id,label,type?,options?,required?,placeholder?}]}`) so the Inbox
  card renders a form; (b) an executing brain asks a question (see below). Answers land
  on `context.humanInput` and release the task back to `pending`.
- **`failed`** — every brain in the chain was rejected by the verifier. Shown under the
  red *failed* filter, re-queued with `POST /api/inbox/:id/rerun` (keeps brief + inputs).
- **follow-up** — `POST /api/inbox/:id/continue` on a finished-successful task spawns a
  follow-up (same brain by default; `{brain:""}` to re-route, `{brain:"<id>"}` to pin).

Priorities: `low` / `normal` / `high` / `urgent`.

## Executing a cowork task (binding — CONVENTIONS.md is injected into your prompt)

When *you* are the brain running a dispatched task:

1. **Output goes in `$COWORK_ARTIFACTS_DIR`** (= `cowork/artifacts/<task-id>/`, already
   your cwd). Write relative paths; never `/tmp`, never the repo root or `server/`.
   Stdout becomes `task.result` (truncated; the full text is saved as `result.md`), so
   put the deliverable in a file, not only in stdout. Do **not** create a "report".
2. **You have full permissions** — edit any file, run git, rebuild/restart services,
   edit `config.json` / `~/.cowork/config.json`. Shared repo: think before overwriting.
3. **Read-only / hands-off**: `inputs/<task-id>/` (files a person attached — read them
   in place), and `inbox/`, `.status/`, `workflow-runs/` (server-owned).
4. **Finish honestly.** Blocked on a decision only the user can make? End your output
   with a line starting **`NEEDS_INPUT:`** followed by your question(s), one per line —
   the dispatcher parks the task on `wait-input` instead of marking it done, and
   re-dispatches it with the answers. Never fabricate success, never claim files you
   didn't write (the artifact list is read off disk), and never emit a rate-limit/quota
   notice as the deliverable — the **verifier** rejects those and hands the task to the
   next brain in the chain.
5. **Stay inside the task.** One task, one deliverable; no side quests, no new cowork
   tasks unless the brief asks you to decompose.
6. **Credential/local-filesystem tasks must run on a local brain.** Anything touching
   `~/.priv/` or `/home/wayne/...` — pin `context: {"brain": "local-ha-deepseek-v4-pro"}`
   (or another `local-*`). `remote-*` brains cannot see this filesystem; if you are one
   and the task needs it, report the routing error and stop.

## Brains, chains, and the verifier

**Brain = model × exec × location.** `exec` ∈ `claude | hermes | agy | codex | ollama | script`.
On this box today: `local-ha-*` (Hermes: qwen35b/qwen27b/deepseek/deepseek-v4-pro),
`local-agy-*` (Antigravity: gemini-3.x, claude-opus-4-6-thinking, gpt-oss-120b),
`local-cc-*` (Claude Code), `local-codex-*`, `local-comfy-ltx` (LTX video — never
Wan/Hunyuan), `remote-ai-code-gen-cc-*`. Read the live set with `GET /api/brains`;
don't trust any hardcoded list, including this one.

**Chains** run top → bottom: `chain[0]` runs; on a failed/rejected result the dispatcher
**hands over** to `chain[1]`, `[2]`… until success or exhaustion (then `failed: true`).
- Global default: `orchestration.defaultChain` (`PUT /api/chains/default`, drag-reorder
  in the **Brains** view).
- Per-division override: `orchestration.divisionChains[<division>]`
  (`PUT /api/chains/division/:division`; empty body reverts to default).
- Special executors carry their own chain (`PUT /api/agents-config/:name`).
- `remoteGraceMs` (60s here) auto-advances past a **remote** rung no client claimed, so a
  cold remote brain never stalls a chain. `staleClaimMs` (30 min) reclaims tasks orphaned
  by a dead agent.

**Env manifests** — a declared brain may carry `env: {paths, tools, secrets, net, traits}`:
machine-detected *facts, names only, never secret values* (the remote-brain client
auto-detects them; the server caps each list). Today they're informational; the routing
filter that consumes them is not built yet.

**Lesson ledger** — every verifier rejection and every `wait-input` parking appends one
JSON line to `decisions/lessons.jsonl` (fail-soft, never breaks dispatch). Event-driven
and human-gated by design: there is no autonomous improver agent.

## Artifacts & inputs

- **Out**: `artifacts/<task-id>/` — persistent, downloadable from the Inbox card or
  `GET /api/artifacts/:taskId[/:file]`. Remote brains upload via `POST` to the same path.
- **In**: `inputs/<task-id>/` — files a person attached (Chat 📎 or an Inbox card),
  mirrored onto `context.inputFiles`; survive a re-run. Stage with
  `POST /api/uploads?name=<file>` → `{token}`, then attach via
  `POST /api/inbox/:id/inputs {inputs:[{token,name}]}`.

## Workflows

Templates in `workflows/<id>.json`, two modes. **`dag`** (default): steps wired by
`dependsOn`, expanded into inbox tasks up front — deterministic and inspectable.
**`orchestrated`**: steps are a *candidate library*; after each step the orchestrator
brain picks the next one (or `DONE`) from the `goal` + results so far, logging every
decision to `workflow-runs/<runId>.json`. Shipped: `idea-to-launch` (flagship),
`build-and-ship`, `product-spec`, `feedback-to-roadmap`, `gtm-campaign`, `finance-close`,
`expand-perspectives`, `content-pipeline`, `product-brief`, `adaptive-research`,
`plan-execution`.

```bash
curl -s -X POST localhost:6868/api/workflows/<id>/run \
  -H 'content-type: application/json' -d '{"params":{"idea":"..."},"dryRun":true}'
```

Steps pin a `division` or `agent` (never a `brain`) so chains stay editable from the
dashboard. Templates are validated on load (unique keys, deps exist, DAG acyclic);
invalid ones are skipped and surfaced at `GET /api/workflows-invalid`.

## Goals (long-lived objectives, beneath Workflows)

**The `/goal` + `/loop` idiom.** A goal *is* Claude-CLI's `/goal` (declare the objective +
its binary "done") paired with a `/loop` that runs 24/7 **until it's met**: the dispatcher
drives the Achiever↔Judger cycle continuously, sleeps for free on checkpoints, blocks
recoverably on obstacles, and terminates **only** on `achieved` — never a timer. Curated
`/goal`+`/loop` starter pairs live in one source of truth, `GET /api/goals/templates`
(the dashboard reads the same endpoint). Full mapping + copy-paste templates:
`docs/goal-loop-idiom.md`.

State in `goals/<goalId>.json`. A goal drives toward one **binary success criterion**
via two roles on the normal task machinery: the **Achiever** takes one move per turn
(`evaluate` | `plan` a phase | `emit` that phase's tasks), and the **Judger** wakes when
a phase's terminal task finishes, writes a report + minutes, and re-arms the Achiever.
A goal ends **`achieved`** (criterion met) — the only terminal state. If it hits an
obstacle it can't clear itself, it goes **`blocked`**: a *recoverable* hold that records
the reason **and** the specific condition to resume (`unblockCriteria`). `blocked` is
**self-healing** — the drive loop **auto-resumes** it on an exponential backoff (minutes,
then hours), giving it a HALF-OPEN probe that continues the moment the obstacle clears, so
recovery **never waits on a human**. Never a silent "done" and never a silent give-up — a
human can **Resume now** to retry immediately after a fix, or **Delete** it if it's truly
dead. Turns only happen when no generated task is open.

**Checkpoints.** An emitted task may carry `scheduledAt` (ISO 8601, future) —
`{"kind":"emit","tasks":[{"title":"Measure MRR","scheduledAt":"2026-09-14T00:00:00Z"}]}`.
Because `scheduled` is an *open* status, an outstanding checkpoint keeps the goal
non-quiescent, so it takes **no turns and spends no budget** while real time passes.
This is the correct move whenever the next honest step is to let the world change
(a month of revenue, an indexing window) — not a stall. Unparseable or past times are
dropped and the task runs now, so one bad date never aborts an emit.

**Two guards block a goal** (recoverably), and both bite metric-open objectives:
`stepBudget` (default 24) counts *lifetime* execution tasks, and `MAX_GOAL_FAILURES`
(5) counts *consecutive* Achiever turns that neither plan nor emit — an
`evaluate{met:false}` is one of those. When a guard trips, the goal is **blocked with a
concrete resume contract** (raise the budget / narrow the criterion; or verify the brain)
and then **auto-retried on a backoff** — so a transient brain blip self-heals in minutes,
and raising the budget lets the goal self-resume with no click; it is never thrown away.
So a goal whose criterion depends on an
external number needs an evidence-bound criterion ("does a dated snapshot in artifacts
show X?", not "is X true?"), a phase loop that always has work to emit, scheduled
checkpoints, and a budget sized for the horizon. The dashboard's 💰 📈 🧲 starters are set
up this way. The Achiever can also **block itself** — `{"kind":"block","reason":"…",
"unblockCriteria":"…"}` — the honest move when it hits a missing credential, an external
dependency, or a decision only a human can make.

`GET/POST /api/goals` · `GET /api/goals/templates` (starter library) ·
`GET/PATCH/DELETE /api/goals/:id` · `POST /api/goals/:id/{activate,pause,block}` ·
`GET /api/goals/:id/tasks`.

## REST mirror (http://localhost:6868/api/...)

`GET status | agents | connections | brains | dispatcher | chains | roster |
roster-divisions | system | services | config | events(SSE) | workflows |
workflow-runs[/:runId] | artifacts/:taskId[/:file] | inputs/:taskId[/:file]` ·
`GET/POST inbox` · `GET inbox/:id` · `PATCH inbox/:id {action: claim|complete}` ·
`POST inbox/:id/{rerun,continue,inputs,interaction}` · `POST inbox/purge` ·
`DELETE inbox/:id` · `POST uploads?name=` · `PUT chains/default`,
`chains/division/:div` · `GET/PUT/DELETE brains/:id`, `agents-config/:name` ·
`POST workflows/:id/run` · `GET/POST goals`, `GET/PATCH/DELETE goals/:id`,
`POST goals/:id/{activate,pause,block}`, `GET goals/:id/tasks`.

SSE event names are camelCase: `agentRegistered`, `taskCreated`, `taskClaimed`,
`taskCompleted`, `heartbeat` (older docs list snake_case names and a `report_filed`
event — both are wrong). Consume with `curl -N`.

## Ops

```bash
systemctl --user {status,restart} cowork-mcp        # server
journalctl --user -u cowork-mcp -f
curl -s localhost:6868/api/status | jq              # health
cd ~/workspace/github/slashman413/cowork/server && npm test   # engine tests
```

Pitfalls: `/mcp` is MCP, `/api` is REST — don't mix. If `server.apiKey` is set every
request needs `Authorization: Bearer …`. Port is 6868. A missing `agency-agents`
submodule makes the Agencies empty (`git submodule update --init`). Canonical copies of
this skill live in `deploy/skills/` — edit there and re-run `deploy/install-skill.sh`,
or keep both in sync by hand.
