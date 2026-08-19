# ADR-010 — The `/goal` + `/loop` idiom: authoring a goal, and the 24/7 loop that drives it

**Status:** Accepted · **Date:** 2026-08-19 · **Builds on** ADR-007/008 (recoverable,
self-healing `blocked`) and the Goals engine (`goals-architecture.md`).

## Context

Claude Code has a mental model users already know: **`/goal`** states *what done looks
like*, and **`/loop`** runs a prompt over and over **until that goal is met**. Cowork's
Goals engine already implements exactly this shape — it just never named it, and its
starter library was trapped inside the dashboard's `public/js/app.js` as a hardcoded
JavaScript array, invisible to the API, to CLI callers, and to agents. Two problems
followed: (1) there was no one place to get *"great templates of `/goal` and the
corresponding `/loop`"*, and (2) any programmatic caller had to re-invent the starters,
guaranteeing drift.

This is **not** a rewrite of the engine. The engine already loops 24/7 until a goal is met
(see "The mapping" below). This ADR names the idiom, and makes the starter library a
first-class, shared resource.

## The mapping — cowork already *is* `/goal` + `/loop`

| Claude CLI | Cowork Goals engine |
|------------|---------------------|
| `/goal` — declare the objective + what "done" means | Author a goal: a **binary `successCriteria`** (the Yes/No gate) + **phases** (proximal waypoints). `POST /api/goals`, then `POST /api/goals/:id/activate`. |
| `/loop` — re-run until the goal is met | The dispatcher's **`driveGoals()`** tick: each turn the **Achiever** takes exactly one move (`evaluate` \| `plan` \| `emit` \| `block`); the **Judger** audits every completed phase. Runs continuously, edge-triggered on work completing. |
| Loop stops when the goal is met | `evaluate → met:true` is the **only** terminal state (`achieved`). Never a timer. |
| Don't spin forever on a wall | A real obstacle → **`blocked`**: recoverable, self-healing, auto-resumes on an exponential backoff (ADR-008). A step-budget/failure ceiling blocks the same way. |
| Let time pass between iterations | Emit a measurement task with a future **`scheduledAt`**; `scheduled` is an *open* status, so the goal sleeps — **no turns, no budget** — until the checkpoint fires. |

So a cowork goal is a `/loop` that **cannot fake "done"** (the result-verifier rejects
fabrication), **cannot silently give up** (only `achieved` is terminal; every other stop
carries a resume contract), and **costs nothing while it waits** on the real world.

## Decision

1. **Name the idiom** and document the mapping above (this file).
2. **Lift the starter library to a single source of truth**: `server/src/core/goal-templates.ts`
   (`GOAL_TEMPLATES`), a curated *source* library — not per-server runtime state, so it
   lives in `server/src/`, never in the gitignored `goals/` dir.
3. **Serve it** at `GET /api/goals/templates` (via `Goals.templates()`), and have the
   dashboard **consume that endpoint** instead of an inlined copy. One library now drives
   the UI, the REST API, and CLI/agents with no drift.
4. **Pair each `/goal` with its `/loop` contract**: every template carries a `loop`
   `{ cadence, prompt, stopWhen }` — the copy-pasteable driver, and the single condition
   that ends it.

## Consequences

- **Easier:** authoring a self-driving goal is one API call or one dashboard click; the
  starters are reachable programmatically; the loop contract is explicit, not folklore.
- **Harder / guarded:** the library must stay activatable — `goal-templates.test.ts`
  runs every template through the engine's own `validate()` and asserts outcome goals
  carry a horizon budget + a checkpoint loop, and every template carries a criterion-based
  (never timer-based) `stopWhen`.
- **Unchanged:** the engine, the Achiever/Judger loop, the block/resume model, the step
  budget, and scheduled checkpoints. This ADR is additive.

---

## Great `/goal` + `/loop` templates

Two families, because goals fail in different ways.

### Shipping goals — deliverable-bound, self-terminating

The criterion flips true the moment a concrete artifact **exists**. Short, cheap, the
default budget (24) is fine. The loop is event-driven: one phase emitted → audited → next.

> **`/goal`** *Ship a new single-page web tool*
> **Success (Yes/No):** Is the tool live on GitHub Pages with a working index.html, og.png, and README?
> **Phases:** Scope & check competitors → Build the tool → Add og.png/README/footer → Deploy & verify it loads
> **`/loop`** *(event-driven):* "Emit the current phase's real build work, let the Judger audit it, then plan or emit the next phase. Don't stop while any phase is unaudited."
> **Stops when:** the tool is live with a working index.html, og.png, and README.

> **`/goal`** *Launch the v1 public API* — **Success:** Is the v1 API deployed to production and publicly documented? · **Phases:** Design contract → Implement → Docs & examples → Deploy & smoke-test · **`/loop`:** "Drive from contract to live; declare success only once the deployed endpoints answer a real smoke test." · **Stops when:** deployed to production and publicly documented.

> **`/goal`** *Automate a recurring task* — **Success:** Does one real scheduled run finish green and produce its expected output file? · **Phases:** Define trigger & output → Write the script → Add workflow YAML & cron → Verify one real run · **`/loop`** *(event-driven, then a scheduled wait):* "Build it, then emit the verification task with a future scheduledAt aligned to the cron so the goal sleeps until the run fires; read the real Actions run." · **Stops when:** one real scheduled run finished green.

> **`/goal`** *Publish an article* — **Success:** Is the article published and reachable at its public URL? · **Phases:** Research & outline → Draft → Edit & visuals → Publish & confirm URL · **Stops when:** the live URL actually loads.

> **`/goal`** *Launch a digital product* — **Success:** Is the product live for sale with a sales page and at least one delivery file? · **Phases:** Define product/audience/price → Create deliverable → Sales page & delivery → Publish & confirm it can be bought · **Stops when:** the listing is live and a delivery file is attached.

### Outcome goals — metric-open, long-horizon, checkpoint-driven

The Achiever **cannot force a market number**, so a naive metric goal spins evaluations
until the budget runs out. Every outcome template carries the four things that make one
survivable: an **evidence-bound** criterion, a **measure → research → ship → wait →
review** phase loop, **scheduled checkpoints**, and a **horizon-sized budget**. Copy the
set if you write your own.

> **`/goal`** *Grow {project} to $10,000/month* *(budget 200)*
> **Success (evidence-bound Yes/No):** Does a dated revenue snapshot in this goal's artifacts show at least $10,000 collected in the trailing 30 days?
> **Phases:** Baseline revenue & earning assets → Research & rank levers by expected monthly value → Ship the top lever → Schedule a 30-day checkpoint & record the dated snapshot → Review what moved the number & choose the next lever
> **`/loop`** *(checkpoint-driven, ~30 days):* "Each cycle: read real revenue into a dated artifact, pick the single highest-leverage lever with an expected monthly value, ship it, then emit the next measurement with a scheduledAt ~30 days out and let the goal sleep. If a lever was flat, change the lever — never ship the same thing harder."
> **Stops when:** a dated snapshot shows ≥ $10,000 in the trailing 30 days. A missed number is a re-plan signal, never a stop.

> **`/goal`** *Grow {project} to 10,000 organic visits/month* *(budget 150)* — **Success:** Does a dated analytics snapshot in artifacts show ≥ 10,000 organic visits in the trailing 30 days? · **Phases:** Baseline traffic & index coverage → Research & rank queries by intent/difficulty → Ship the highest-value pages & fix SEO blockers → Schedule a 45-day checkpoint & record the snapshot → Review which pages earned impressions & pick the next bet · **`/loop`** *(checkpoint-driven, ~45 days):* "Read real analytics into a dated artifact, research/rank queries, ship the best pages, then emit the next measurement ~45 days out. Double down on pages that already earn impressions." · **Stops when:** a dated snapshot shows ≥ 10,000 organic visits.

> **`/goal`** *Reach 100 paying customers for {project}* *(budget 200)* — **Success:** Does a dated snapshot in artifacts show ≥ 100 distinct paying customers on the billing platform? · **Phases:** Baseline the count & where they came from → Research why prospects do/don't buy & rank fixes → Ship the top offer/price/channel fix → Schedule a 30-day checkpoint & record the count → Review what converted & choose the next change · **`/loop`** *(checkpoint-driven, ~30 days):* "Read the real customer count into a dated artifact, research why prospects buy or don't, ship the top fix, emit the next count task ~30 days out. A flat checkpoint means change the offer/price/channel — not ship harder." · **Stops when:** a dated snapshot shows ≥ 100 distinct paying customers.

### How to run one (API)

```bash
# 1. See the library (the /goal starters)
curl -s $COWORK/api/goals/templates | jq '.[].key'

# 2. Author a goal from a template (edit fields freely; {project} → the real name)
curl -s -X POST $COWORK/api/goals -H 'content-type: application/json' -d '{
  "title": "Grow slashmantools to $10,000/month",
  "successCriteria": "Does a dated revenue snapshot in this goal'\''s artifacts show at least $10,000 collected in the trailing 30 days?",
  "phases": [
    {"key":"baseline","title":"Baseline current revenue and inventory earning assets"},
    {"key":"research","title":"Research and rank the highest-leverage levers"},
    {"key":"ship","title":"Ship the top-ranked lever end to end"},
    {"key":"checkpoint","title":"Schedule a 30-day checkpoint and record the dated snapshot"},
    {"key":"review","title":"Review what moved the number and choose the next lever"}
  ],
  "stepBudget": 200,
  "achieverBrainChain": ["local-cc-opus"],
  "judgerBrainChain": ["local-cc-opus"]
}'

# 3. Start the /loop — the dispatcher drives it 24/7 until met
curl -s -X POST $COWORK/api/goals/<goalId>/activate
```

The goal now runs unattended: it emits work, waits on checkpoints for free, blocks
recoverably (and self-resumes) on obstacles, and ends **only** when its evidence-bound
criterion is met.
