# Workflows — The Complete Manual

*How Cowork workflows actually work, and how to set up, configure, and customize
your own — from a one-file template to a self-authoring meta-pipeline.*

This document is the deep reference behind the short summary in the README. If you
only remember one thing: **a workflow is a JSON template on disk that turns a
multi-step job into a reusable, inspectable pipeline** — either a *static graph*
that is planned once and walked deterministically (`dag`), or an *adaptive loop*
where an orchestrator brain decides each next move from the results so far
(`orchestrated`). There is no separate "workflow runtime": both modes ultimately
produce the same ordinary inbox tasks the dispatcher already runs.

- Source of truth: `server/src/core/workflows.ts` (the engine),
  `server/src/core/dispatcher.ts` (the DAG walk + orchestrator decision loop),
  `server/src/types.ts` (the schema), `server/src/api/workflows.ts` (REST).
- Templates live in `workflows/*.json`. Adaptive run state lives in
  `workflow-runs/*.json` (gitignored).

---

## Table of contents

1. [Mental model — the two ways to run a pipeline](#1-mental-model)
2. [Anatomy of a template (the full schema)](#2-anatomy-of-a-template)
3. [DAG mode, in depth](#3-dag-mode-in-depth)
4. [Orchestrated (adaptive) mode, in depth](#4-orchestrated-adaptive-mode-in-depth)
5. [Parameters & `{{placeholder}}` interpolation](#5-parameters--placeholder-interpolation)
6. [Validation, cycle detection & error surfacing](#6-validation-cycle-detection--error-surfacing)
7. [Running a workflow (dry-run, real run, run ids)](#7-running-a-workflow)
8. [Where a run's tasks go & how they are traced](#8-where-a-runs-tasks-go--how-they-are-traced)
9. [Routing a step to the right worker (agent / division / brain)](#9-routing-a-step)
10. [Authoring templates: by hand, by API, or by the `workflow-builder`](#10-authoring-templates)
11. [Configuration knobs](#11-configuration-knobs)
12. [The full REST surface](#12-the-full-rest-surface)
13. [Recipes & patterns](#13-recipes--patterns)
14. [Gotchas & failure modes](#14-gotchas--failure-modes)
15. [Reference: shipped workflows](#15-reference-shipped-workflows)

---

## 1. Mental model

A **workflow** is a version-controlled template (`workflows/<id>.json`). Every
template chooses one of two execution modes with its `"mode"` field:

### `dag` · static, pre-expanded, deterministic

The steps form a **directed acyclic graph** wired by `dependsOn`. The moment you
run it, the *whole graph is expanded up front* into N inbox tasks, and each
task's `context.dependsOn` is wired to the **real task ids** of its prerequisites.
From then on there is nothing workflow-specific left to do: the ordinary
dispatcher walks the graph in dependency order, exactly as it would for tasks you
hand-built and linked yourself.

- **Deterministic**: same template + same params → same set of tasks, same shape,
  every time. No LLM re-plans the pipeline.
- **Reusable & inspectable**: the pipeline is a file you can diff, review, and
  dry-run. You are not asking a model to re-derive the plan on each invocation.
- **Good for**: known, repeatable processes — "research → draft → review →
  publish", "spec → build → CI → review → push", a finance close, a fan-out /
  fan-in analysis.

### `orchestrated` · adaptive, orchestrator-driven

The steps are **a library of candidate moves**, not a fixed graph. Running the
template plans *nothing* and creates *no tasks*. Instead, on the dispatcher's next
tick, an **orchestrator brain** is shown the `goal`, the steps completed so far
(with their results), and the steps still available — and it replies with the
single best next step to run, **or `DONE`**. After that step finishes, it is asked
again. The path taken *adapts to what came back*.

- **Adaptive**: the run drills deeper only where the goal needs it, skips steps
  the evidence already made unnecessary, and stops itself when the goal is met.
- **Auditable**: every decision (the chosen step + a short rationale) is appended
  to `workflow-runs/<runId>.json` and rendered as a **decision log** in the UI.
- **Good for**: open-ended work where the right sequence isn't knowable up front —
  research that follows the evidence, plan-execution that reacts to results.

> The two modes are not either/or across your company — they are a per-template
> choice. Ship deterministic DAGs for the processes you already understand, and
> orchestrated templates for the ones where the path is discovered as you go.

---

## 2. Anatomy of a template

A template is a single JSON object (`WorkflowDef` in `types.ts`):

```jsonc
{
  "id": "content-pipeline",          // REQUIRED. Stable id = the filename stem.
  "name": "Content Pipeline",        // Human label shown in the UI.
  "description": "Research → draft → review → publish.",
  "mode": "dag",                     // "dag" (default) | "orchestrated".
  "goal": "…",                       // orchestrated mode ONLY — the objective.
  "params": ["topic"],               // Required run params, used as {{topic}}.
  "steps": [ /* WorkflowStep[] */ ]  // REQUIRED, non-empty.
}
```

Each **step** (`WorkflowStep`) is a task template:

| Field         | Type       | Meaning |
|---------------|------------|---------|
| `key`         | string     | **Required.** Unique-within-the-template node id. Other steps reference it in `dependsOn`; it becomes `context.stepKey`. |
| `title`       | string     | Task title. `{{param}}` placeholders are filled at run time. Falls back to `key` if omitted. |
| `description` | string     | The **standalone brief** the executing agent sees. Falls back to `title`, then `key`. |
| `agent`       | string     | Pin a specific Agencies/special agent (`context.agent`). |
| `division`    | string     | Pin a division so the router only picks within it (`context.division`). |
| `brain`       | string     | Pin an exact execution brain (`context.brain`). |
| `priority`    | enum       | `low` \| `normal` \| `high` \| `urgent`. Default `normal`. |
| `dependsOn`   | string[]   | **Step keys** (not task ids) this step waits for — the DAG edges. |

Notes that matter:

- **`id` is the identity.** On load, if a file omits `id` it defaults to the
  filename (`foo.json` → `foo`). When you author via the API the `id` is
  sanitized to kebab-case and becomes the filename. Keep them in sync.
- **`description` is everything the worker gets.** A dispatched agent sees *only*
  that step's compiled description (plus the shared conventions and any
  prerequisite results). Write each description to be fully self-contained.
- **`dependsOn` names step keys**, and the engine resolves them to real task ids
  at expansion time — you never write task ids in a template.

---

## 3. DAG mode, in depth

### 3.1 What "expand up front" means

When you `POST /api/workflows/<id>/run` a DAG template, `Workflows.run()`:

1. **Validates** the definition (see §6). A bad template is rejected here.
2. **Rejects missing params** — any name in `params` that is absent or an empty
   string aborts the run with `missing required param(s): …`.
3. **Topologically orders** the steps with Kahn's algorithm (`topoOrder`), so
   every dependency comes before its dependents. A cycle throws here.
4. **Creates tasks bottom-up** in that order. Because dependencies are created
   first, their task ids already exist when a dependent step is created, so its
   `context.dependsOn` can be wired to the **real ids** (not the step keys).

Each created task carries:

```jsonc
{
  "context": {
    "workflowId":    "<template id>",
    "workflowRunId": "<this run>",
    "stepKey":       "<this step's key>",
    // + agent / division / brain if the step pinned them
    // + dependsOn: ["<real task id>", …] if the step had prerequisites
  },
  "from": { "platform": "cowork", "agent": "workflow" },
  "tags": ["workflow", "<template id>"],
  "priority": "<step priority or normal>"
}
```

Once the tasks exist, **the workflow layer is done**. There is no ongoing DAG
driver — the plain dispatcher takes over.

### 3.2 How the dispatcher walks the graph

Each dispatch tick, before a task is scheduled, the dispatcher checks
`depsSatisfied(task)`:

```ts
// dispatcher.ts
private depsSatisfied(task: Task): boolean {
  const deps = task.context?.dependsOn;
  if (!Array.isArray(deps) || deps.length === 0) return true;
  return deps.every(id => this.store.getTask(id)?.status === 'done');
}
```

So a step with prerequisites is **held out of scheduling until every prerequisite
task is `done`** — this is the whole of DAG ordering. Steps with no `dependsOn`
are eligible immediately, which is exactly how **fan-out** happens: three
independent steps all start at once; a fourth that `dependsOn` all three waits for
the slowest, giving you **fan-in / synthesis**.

### 3.3 Passing results downstream

A dependent step doesn't just wait — it **receives its inputs**. When the
dispatcher builds the prompt for a task that has `context.dependsOn`, it appends:

```
# Results from prerequisite tasks
## <dep title>

<dep result>
```

for each completed prerequisite. So a synthesis step literally sees the market,
technical, and risk write-ups that fed it. This is why a DAG "diamond" works
end-to-end without you wiring any data plumbing.

### 3.4 A minimal diamond

```json
{
  "id": "product-brief",
  "params": ["idea"],
  "steps": [
    { "key": "market", "title": "Market analysis: {{idea}}", "division": "marketing" },
    { "key": "tech",   "title": "Technical feasibility: {{idea}}", "division": "engineering" },
    { "key": "risk",   "title": "Risk & compliance: {{idea}}", "division": "operations" },
    { "key": "synthesis", "title": "Synthesize the {{idea}} brief",
      "dependsOn": ["market", "tech", "risk"] }
  ]
}
```

`market`, `tech`, `risk` fan out in parallel; `synthesis` fans them in and is fed
all three results.

---

## 4. Orchestrated (adaptive) mode, in depth

### 4.1 Starting a run creates nothing

For `"mode": "orchestrated"`, `run()` delegates to `runOrchestrated()`, which:

- Interpolates the `goal` with the run params.
- Writes a **run record** to `workflow-runs/<runId>.json`:

  ```jsonc
  {
    "runId": "run-1a2b3c4d",
    "workflowId": "adaptive-research",
    "mode": "orchestrated",
    "goal": "Produce a decision-ready brief answering: …",
    "params": { "question": "…" },
    "status": "running",
    "history": [],          // decision log — starts empty
    "createdAt": "…", "updatedAt": "…"
  }
  ```

- Creates **no tasks**. An empty `history` means "the first decision is due."

`dryRun: true` just echoes the candidate step library and the resolved goal.

### 4.2 The decision loop (`driveWorkflows`)

Every dispatch tick, `Dispatcher.driveWorkflows()` runs. For each run that is
**awaiting a decision** — `status: "running"` **and** every task it has created so
far is `done`/`rejected` (`Workflows.runsAwaitingDecision()`) — it does the
following:

1. **Runaway guard.** If the number of dispatched steps ≥
   `orchestration.maxWorkflowSteps` (default **12**), force-finish the run with
   reason `reached step cap (N)`. This stops an orchestrator that never says
   `DONE` from spinning forever.
2. **Exhaustion guard.** Build `decisionContext(runId)`. If there are **no
   candidate steps left** (`available` is empty — every step has been used),
   finish the run with `no candidate steps remain`.
3. **Ask the orchestrator brain.** Build a prompt containing:
   - the `GOAL`,
   - `STEPS ALREADY DONE (with their results)` — each completed step's key,
     status, title, and up to ~400 chars of its result,
   - `CANDIDATE NEXT STEPS` — each remaining step's key, title, and up to ~160
     chars of description,
   - the instruction: *"Reply with ONLY the key of the next step to run, or DONE
     if the goal is met."*
4. **Parse the reply.** The engine takes the **last** match of any candidate key
   or `DONE` in the answer (so a trailing final answer wins), and grabs the last
   non-empty line as the rationale (≤200 chars).
5. **Apply the decision** (`applyDecision`):
   - `DONE` → mark the record `done`, append `{ stepKey: null, reason }`.
   - a step key → create that step's inbox task (tagged
     `["workflow", id, "orchestrated"]`, `context.orchestrated: true`, wired to any
     already-completed dependency tasks), and append
     `{ stepKey, reason, taskId, decidedAt }` to `history`.

A per-run re-entrancy guard (`decidingRuns`) ensures only one decision is in
flight per run at a time.

### 4.3 Honest failure, not fake completion

If the orchestrator brain **times out or replies with something unparseable**,
the engine does **not** treat that as "goal met" (which would silently finish a
run having done nothing). Instead it counts consecutive failures per run and
retries on later ticks; only after `MAX_DECISION_FAILURES` consecutive bad answers
does it abandon the run with a reason that says so explicitly —
*"…gave no usable answer after N attempts … run abandoned, NOT completed."*

### 4.4 Which brain orchestrates?

The decision is made by the **router/orchestrator brain**: the model configured in
`orchestration.classifier` if present, otherwise the first *local, runnable* brain
in the orchestrator/default chain. The per-decision wall-clock budget is
`orchestration.classifier.timeoutMs` (falling back to 300000 ms).

### 4.5 `dependsOn` in orchestrated mode

`dependsOn` is still allowed but is now an **optional hint**: when the
orchestrator picks a step, the engine wires its `context.dependsOn` only to the
tasks of prerequisite steps that have *already run*. It is not a hard gate the way
it is in DAG mode — the orchestrator, not the graph, controls ordering.

---

## 5. Parameters & `{{placeholder}}` interpolation

- **Declare** every run-time variable in `params: [...]`. These are **required**:
  `run()` rejects a run whose params are missing or empty *before* it creates
  anything.
- **Reference** them as `{{name}}` in any step `title`/`description` and in the
  orchestrated `goal`. The interpolator matches `{{ name }}` (whitespace allowed;
  names may contain letters, digits, `.`, `-`).
- **Unknown placeholders are left literally.** `{{foo}}` where `foo` isn't a
  supplied param stays as the text `{{foo}}` in the output — so always list every
  placeholder you use in `params`, or the worker will see raw braces.

```jsonc
{
  "params": ["idea", "region"],
  "steps": [
    { "key": "market",
      "title": "Market analysis: {{idea}} in {{region}}",
      "description": "Size the {{region}} market for \"{{idea}}\" …" }
  ]
}
```

---

## 6. Validation, cycle detection & error surfacing

Templates are validated **on every load** (`list()` re-reads disk each call) and
whenever you author one. `validate()` returns a list of human-readable errors;
`[]` means valid. It checks:

- `id` is a non-empty string;
- `steps` is a non-empty array;
- every step has a **string `key`**, and keys are **unique**;
- every `dependsOn` entry references an **existing step key**;
- the graph is **acyclic** — `topoOrder()` (Kahn's algorithm) throws
  `workflow has a dependency cycle among: …` if any step transitively depends on
  itself. (A cycle would deadlock `depsSatisfied` forever, since a task can never
  reach `done` while it waits on itself.)

**A malformed template does not crash the list — it is skipped.** But it is not
silently lost:

- `GET /api/workflows` returns only the valid templates;
- `GET /api/workflows-invalid` (`listInvalid()`) returns the ones that failed,
  each with its `file`, `id`, and the `errors` (including bad JSON), so the
  dashboard can show the fix at a glance.

---

## 7. Running a workflow

### 7.1 Dry run — inspect the resolved plan, write nothing

```bash
curl -s -X POST localhost:6868/api/workflows/product-brief/run \
  -H 'content-type: application/json' \
  -d '{"dryRun": true, "params": {"idea": "a self-hosted receipts scanner"}}'
```

For a DAG template the response is the **topologically ordered, param-resolved
step list** (deps still shown as step keys) — no tasks created. For an
orchestrated template it echoes the candidate step library + resolved goal. Use
this to sanity-check a template before committing to a real run.

### 7.2 Real run

```bash
curl -s -X POST localhost:6868/api/workflows/product-brief/run \
  -H 'content-type: application/json' \
  -d '{"params": {"idea": "a self-hosted receipts scanner"}}'
```

- **DAG** → HTTP 201 with `{ runId, mode: "dag", tasks: [...] }` — the expanded
  tasks are now in the inbox and the dispatcher will begin walking them.
- **Orchestrated** → HTTP 201 with `{ runId, mode: "orchestrated", goal }` — the
  run record is written; the first decision happens on the next tick.

### 7.3 Run ids

A run id ties one expansion together. It is `run-` + the first 8 chars of a UUID
(e.g. `run-1a2b3c4d`). You may pass your own via the internal `runId` option; the
REST endpoint generates one for you. It is stamped onto every task's
`context.workflowRunId`, which is how the UI groups a run.

---

## 8. Where a run's tasks go & how they are traced

Both modes stamp **every** task they create with three context fields:

| Field                    | Purpose |
|--------------------------|---------|
| `context.workflowId`     | which template |
| `context.workflowRunId`  | which run (one per expansion) |
| `context.stepKey`        | which node of the template |

That is a **zero-schema-change** trace: `context` is already free-form, so no DB
migration was needed to add workflows. The dashboard's **Workflows** tab uses
these to group a run and render it live — a DAG with per-node status for static
runs, a decision timeline for adaptive ones.

Run views are reconstructed on demand:

- **DAG runs** are rebuilt purely from task `context` (`runFromTasks`) — status is
  `failed` if any task is `rejected`, `done` if all are `done`, else `running`.
  DAG runs persist **nothing** extra on disk.
- **Orchestrated runs** are rebuilt from their persisted record + tasks
  (`runFromRecord`), carrying the goal and the full decision log.

`GET /api/workflow-runs` lists them all (newest first); `GET
/api/workflow-runs/:runId` returns one.

---

## 9. Routing a step

Each step can pin **where** it runs, or leave it to the router:

- **`agent`** → `context.agent`: a specific Agencies or special agent.
- **`division`** → `context.division`: constrain routing to one division; the
  router picks the best specialist within it.
- **`brain`** → `context.brain`: an exact execution identity
  (model × platform × location).
- **none** → the two-stage router picks a division, then an agent, then that
  agent's brain fallback chain executes it.

**House rule for shipped templates:** pin a `division` or `agent`, **never a
`brain`.** That keeps the *brain fallback chain* for every role editable live from
the dashboard's **Agents** view (`orchestration.agents[*].brains` for special
agents; `divisionChains[*]` / `defaultChain` for agents) — so you can
change *who* runs a step without touching the template. Pin a `brain` only for a
deliberately hardware- or credential-specific step (e.g. a local media pipeline or
a task that needs a credential only one host holds).

---

## 10. Authoring templates

There are three ways to create a workflow, all producing the same
`workflows/<id>.json`:

### 10.1 By hand (committed to the repo)

Drop a `workflows/<id>.json` file in the repo. It is picked up on the next load
and validated. This is the right path for the pipelines you want in version
control and reviewed in PRs.

### 10.2 By API (authored at runtime)

Templates don't have to be hand-committed — the dashboard, an agent, or a script
can author one live:

```bash
# Create a NEW template (fails if the id already exists):
curl -s -X POST localhost:6868/api/workflows \
  -H 'content-type: application/json' \
  -d @my-workflow.json

# Overwrite / upsert by id (id taken from the path):
curl -s -X PUT localhost:6868/api/workflows/my-workflow \
  -H 'content-type: application/json' \
  -d @my-workflow.json
```

`create()` rules:

- The `id` is **sanitized to kebab-case** and must match
  `^[a-z0-9][a-z0-9-]*$` (lowercase letters, digits, hyphens; starts
  alphanumeric). This is also a path-traversal guard — the id becomes the
  filename.
- The definition is **validated exactly as `list()` would** — an invalid template
  is rejected with the validation errors, not written.
- An existing template is **not clobbered** unless you set `overwrite: true`
  (POST accepts `{ "def": <definition>, "overwrite": true }`; PUT always
  overwrites).

### 10.3 By the `workflow-builder` meta-workflow

The repo ships a workflow that **builds other workflows** —
`workflows/workflow-builder.json`. It is a 3-step DAG that takes a plain-English
`goal` and a new `workflow_id` and produces a registered, runnable template:

| Step       | Does |
|------------|------|
| `design`   | Decomposes the goal into the smallest set of concrete steps — deciding each step's key, title, standalone description, `dependsOn` edges, and division/agent — chooses `dag` vs `orchestrated`, and identifies the run-time params. Output: a markdown design (mode, params, numbered step table). |
| `author`   | Turns the approved design into **one schema-valid definition JSON**, saved to the artifacts dir as `workflow.json`. The step's brief embeds the full schema and the validator's rules so the output registers as-is. `dependsOn: [design]`. |
| `register` | POSTs `workflow.json` to `POST /api/workflows` (retrying as `{def, overwrite:true}` on "already exists"), then **verifies with a dry run**. If the host can't reach the API, it leaves `workflow.json` as the deliverable rather than faking success. `dependsOn: [author]`. |

Run it like any DAG:

```bash
curl -s -X POST localhost:6868/api/workflows/workflow-builder/run \
  -H 'content-type: application/json' \
  -d '{"params": {
        "goal": "Take a raw customer interview transcript and turn it into a prioritized feature list with effort estimates",
        "workflow_id": "interview-to-features"
      }}'
```

When it finishes, `interview-to-features` is a first-class template you can run,
dry-run, and edit like any other — no hand-editing of `workflows/*.json` required.

This is the loop the file name of this doc refers to: **a workflow builder that
lets the company design, author, and register new pipelines for itself.**

---

## 11. Configuration knobs

Workflows read a small amount of config (`config.json` → `orchestration` and
`paths`):

| Key | Default | Effect |
|-----|---------|--------|
| `paths.workflows` | `./workflows` | Directory of templates. `workflow-runs/` is created as its sibling for adaptive run records. |
| `orchestration.maxWorkflowSteps` | `12` | Hard cap on steps an **orchestrated** run may dispatch before it is force-finished (runaway guard). |
| `orchestration.classifier.timeoutMs` | `300000` | Per-decision wall-clock budget for the orchestrator brain in an adaptive run. |
| `orchestration.classifier` | — | Defines the router/orchestrator brain (exec + model). If absent, the first local runnable brain in the orchestrator/default chain decides. |
| `orchestration.agents[*].brains`, `defaultChain`, `divisionChains[*]`, `agentChains[*]` | — | The brain fallback chains that actually execute each step, resolved by the step's `agent`/`division` pin (or the router). Editable live from the **Agents** view. |

There is **no** separate on/off switch for the workflow layer — it is always
available via the REST API. The orchestrated decision loop only runs when
`orchestration.enabled` is true (it is part of the dispatcher tick).

---

## 12. The full REST surface

`server/src/api/workflows.ts`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/workflows` | List valid templates. |
| `GET` | `/api/workflows/:id` | One template (404 if unknown/invalid). |
| `GET` | `/api/workflows-invalid` | Templates that failed to load, each with `file`, `id`, `errors`. |
| `POST` | `/api/workflows` | Author a NEW template. Body: a raw definition, or `{ def, overwrite? }`. 201 `{ ok, workflow }`; 400 with the validation error on failure. |
| `PUT` | `/api/workflows/:id` | Replace/upsert a template; `id` is taken from the path; always overwrites. |
| `POST` | `/api/workflows/:id/run` | Start a run. Body `{ params, dryRun }`. DAG → 201 with expanded `tasks` (or 200 for a dry run); orchestrated → 201 with the run record shape. |
| `GET` | `/api/workflow-runs` | Every run, newest first (DAG grouped from task context; orchestrated from records + decision log). |
| `GET` | `/api/workflow-runs/:runId` | One run's tasks + status (+ goal & decision log for orchestrated). |

---

## 13. Recipes & patterns

**Sequential pipeline** — a chain where each step feeds the next:

```json
"steps": [
  { "key": "research", "title": "Research {{topic}}", "division": "marketing" },
  { "key": "draft",    "title": "Draft {{topic}}",    "division": "marketing", "dependsOn": ["research"] },
  { "key": "review",   "title": "Review {{topic}}",   "agent": "code-reviewer", "dependsOn": ["draft"] },
  { "key": "publish",  "title": "Publish {{topic}}",  "division": "marketing", "dependsOn": ["review"] }
]
```

**Fan-out → fan-in (diamond)** — parallel investigation, one synthesis (see §3.4).

**Multi-lens parallel** — the same subject examined by N independent lenses in
parallel, then merged (`expand-perspectives` ships this shape).

**Adaptive research** — set `mode: "orchestrated"`, give a `goal`, and list
scope / survey / deep-dive / counter / quantify / brief as a *library*; let the
orchestrator drill only where the crux is (`adaptive-research` ships this).

**Self-authoring** — use `workflow-builder` (or `POST /api/workflows`) to let an
agent design and register a new pipeline at runtime (§10.3).

**Design/author before you run** — always `dryRun: true` first to confirm the
resolved plan and catch a missing param or a mis-wired dependency for free.

---

## 14. Gotchas & failure modes

- **Every used `{{placeholder}}` must be in `params`.** An undeclared placeholder
  is left as literal braces in the worker's brief.
- **A rejected DAG dependency blocks its dependents forever.** `depsSatisfied`
  requires each dependency to be `done`; a prerequisite that ends `rejected` (and
  exhausts its fallback chain) never satisfies, so the dependent step never
  dispatches and the run stays `running`/`failed`. Design retryable steps or
  re-run the failed task (`POST /api/inbox/:id/rerun`).
- **Cycles are rejected at validate/run time**, not silently — you'll get
  `dependency cycle among: …`. Keep the graph acyclic.
- **Orchestrated runs can hit the step cap.** If your orchestrator brain never
  emits `DONE`, the run force-finishes at `maxWorkflowSteps` (default 12). Raise
  the cap or tighten the goal/step descriptions so `DONE` is reachable.
- **A flaky orchestrator brain is retried, not faked.** Repeated unparseable/
  timed-out decisions eventually **abandon** the run with an honest reason — it is
  never marked `done` for a run that executed nothing.
- **`id` must equal the intended filename.** By hand, name the file `<id>.json`;
  by API, the id is sanitized and *becomes* the filename. A mismatch means the
  template loads under the filename stem, not your intended id.
- **Pinning a `brain` freezes routing.** Prefer `division`/`agent` so the chain
  stays editable; pin a brain only when the step genuinely needs one host.

---

## 15. Reference: shipped workflows

`workflows/` ships realistic, cross-functional company pipelines. Each pins a
`division`/`agent` (never a `brain`) so chains stay editable.

| Workflow | Mode | What it does |
|----------|------|--------------|
| `idea-to-launch` | dag | The flagship: CEO brief → research + perspectives → PM spec → architecture → engineers build & push to GitHub → marketing + email → sales → finance → go/no-go review. `params: idea` |
| `product-spec` | dag | PM writes a build-ready PRD from user research + feasibility, cut into a first sprint. `params: idea` |
| `build-and-ship` | dag | Spec → architect → build real code → wire GH Actions CI → review → push & verify green. `params: spec` |
| `feedback-to-roadmap` | dag | Feedback → triage → themes → PM initiatives → prioritized roadmap → dispatch the "Now" items. `params: feedback` |
| `gtm-campaign` | dag | Offer/promo → email sequences + auto-reply rules → content → sales enablement → metrics. `params: product` |
| `finance-close` | dag | Bookkeeper reconciles → FP&A variance → forward model → CFO sign-off. `params: period` |
| `expand-perspectives` | dag | Four independent lenses in parallel → synthesized perspective map. `params: idea` |
| `product-brief` | dag | Market + tech + risk fan-out → one-page go/no-go brief. `params: idea` |
| `content-pipeline` | dag | Research → draft → review → publish. `params: topic` |
| `gumroad-implementation` | dag | A worked product-implementation pipeline. |
| `adaptive-research` | orchestrated | Adaptive deep research — the orchestrator drills only where the goal needs it. `params: question` |
| `plan-execution` | orchestrated | Turns a plan into dispatched jobs and drives them to verified completion. `params: plan` |
| `workflow-builder` | dag | Meta: design → author → register a **new** workflow from a goal. `params: goal, workflow_id` |

```bash
# Run the flagship end-to-end company workflow:
curl -s -X POST localhost:6868/api/workflows/idea-to-launch/run \
  -H 'content-type: application/json' -d '{"params":{"idea":"a self-hosted receipts scanner"}}'
```

---

*Engine tests — validation, cycle detection, topological expansion, DAG wiring,
run reconstruction, and the orchestrated decision loop — live in
`server/src/core/workflows.test.ts` and `dispatcher-workflows.test.ts`
(`cd server && npm test`).*
