# Goals redesign — from *abandon* to *recoverable block* (ADR-007)

**Status:** Accepted · **Date:** 2026-08-15 · **Supersedes the terminal `abandoned`
state introduced in** `goals-architecture.md` (ADR-003 termination model).

This document is two things: a **deep survey of what makes a goal realistic, practical,
and achievable**, and the **design record** for the change that survey motivated —
replacing the Goals engine's terminal `abandoned` status with a *recoverable* `blocked`
status that always carries a specific, checkable resume condition.

---

## 1. The problem that triggered this

The first real long-horizon goal on the platform — *"Grow Gumroad revenue to
$10,000/month"* (`goal-278e9d28`) — ended like this:

> `finish` — *"Achiever made no usable progress after 5 turns (no usable decision from
> the Achiever (timeout or unparseable JSON)) — goal abandoned, NOT completed."*

Read that closely. The goal was not impossible. The work was not wrong. The *Achiever
brain returned unparseable output / timed out five times in a row* — a **transient
infrastructure fault** — and the engine responded by **permanently discarding a
multi-week objective and every phase of progress under it**. There was no way back: an
`abandoned` goal could not be edited, resumed, or retried. The only recovery was to
author the whole goal again from scratch.

That is the opposite of resilient. It is also, per the goal-setting literature below,
the opposite of how achievable goals are supposed to behave when they hit an obstacle.

---

## 2. Deep survey: what makes a goal realistic, practical, and achievable

Five well-supported bodies of work converge on the same shape.

### 2.1 Locke & Latham — Goal-Setting Theory
The most validated theory in the field (100+ tasks, 40,000+ participants, eight
countries). Performance rises with five conditions:

1. **Clarity / specificity** — a specific goal outperforms "do your best." Specificity is
   what makes progress *measurable*.
2. **Challenge** — hard-but-attainable goals beat easy ones; unattainable ones destroy
   commitment.
3. **Commitment** — the goal must be owned; commitment collapses when the goal feels
   impossible or arbitrary.
4. **Feedback** — regular progress feedback lets the actor "raise effort or change
   strategy." Goals + feedback beat goals alone.
5. **Task complexity** — complex goals need to be broken down and given time.

A key sub-finding: **proximal sub-goals beat one distal goal.** Breaking a far-off goal
into near-term waypoints raises self-efficacy, persistence, and performance.

> **Cowork already does the good parts.** Binary `successCriteria` = clarity + measurable
> feedback. `phases` = proximal sub-goals. Judger reports/minutes = the feedback loop.
> **What it got wrong is condition 2–3 under obstacles:** when a goal stalled, the engine
> *killed commitment* by discarding the goal, instead of surfacing the obstacle so effort
> or strategy could change.

### 2.2 SMART
Specific, Measurable, **Achievable**, Relevant, Time-bound. The "A" is the whole point of
this task. Achievability is not a property you assert once at authoring — it is something
that can *change* (a credential expires, a market moves, a budget proves too small). A
resilient system must be able to say **"this became unachievable *under the current
constraints* — here is what would make it achievable again,"** rather than "give up."

### 2.3 OKRs — committed vs. aspirational
OKRs separate the qualitative **Objective** from measurable **Key Results**, and
distinguish *committed* KRs (should hit) from *stretch* KRs (may miss — and missing is
information, not failure). The lesson for an autonomous engine: **not hitting a metric is
a signal to re-plan, never grounds to terminate.**

### 2.4 WOOP + Implementation Intentions (Oettingen & Gollwitzer)
This is the load-bearing piece for the redesign. **WOOP** = **W**ish, **O**utcome,
**O**bstacle, **P**lan. Mental contrasting (naming the obstacle, not just the wish)
produces *stronger* commitment and achievement than positive thinking alone. The "P" is an
**implementation intention** — a concrete `WHEN <obstacle> THEN <response>` if-then plan.
A 2006 Gollwitzer & Sheeran meta-analysis (k=94) put if-then plans at **d ≈ 0.65** on goal
attainment — a medium-to-large effect.

> **This is exactly what a `blocked` state should encode.** An obstacle without a stated
> way out is a disguised "give up." An obstacle **paired with a specific unblock
> condition** is an implementation intention: *"WHEN the step budget is raised above N,
> THEN resume."* That single reframing turns a dead-end into a recovery contract — and it
> is the "specific criteria" the task asked for.

### 2.5 Agentic-AI resilience — the circuit breaker
Production guidance for long-running autonomous agents is unambiguous:

- **Unclear goals are the top failure mode**, cascading into every later action; agents
  also *drift semantically* (high activity, zero progress) and *exhaust budgets silently*.
- The recommended control is a **circuit breaker** with three states: **CLOSED** (normal),
  **OPEN** (fault detected — stop taking autonomous actions that compound damage), and
  **HALF-OPEN** (a guarded retry).
- Recovery pattern: *"roll back to the last safe state and retry with tighter rules,"* and
  *"sparse human guidance can interrupt unproductive loops and restore forward progress
  without replacing the agent's core work."*

> **`abandoned` is the anti-pattern here — it is the breaker welded permanently OPEN.**
> The resilient design maps cleanly: `active` = CLOSED, `blocked` = OPEN (stop compounding,
> name the fault, hold budget), `resume` = HALF-OPEN (a human asserts the unblock
> condition holds; give the goal one clean turn).

### 2.6 Synthesis — the design principles
1. A goal is **never silently "done"** (already true) **and never silently thrown away**
   (this change).
2. Only **success is terminal.** Every non-success stop is a **hold with a stated way
   out** — an obstacle plus its implementation intention.
3. **Stops must be recoverable.** Editing the constraint that caused the stop (budget,
   criterion, brain) and resuming is the intended path.
4. **Name the obstacle specifically.** "blocked" alone is useless; "blocked *because X*,
   resume *when Y*" is an actionable contract.
5. **Make achievement easier by design**, not just by exhortation: evidence-bound
   criteria, a phase loop that always has work, scheduled checkpoints so real-world waits
   cost nothing, and a budget sized to the horizon. (These were already the outcome-goal
   guardrails; they are reaffirmed here.)

---

## 3. The redesign

### 3.1 Status model

| Before | After |
|--------|-------|
| `draft → active → paused → achieved` **/ `abandoned` (terminal)** | `draft → active → paused → achieved` **/ `blocked` (recoverable)** |
| `abandoned` was terminal, uneditable, unrecoverable | `blocked` holds the goal, records **why** + **how to resume**, and is fully editable + resumable |
| Only exits: achieved / abandoned | Only **terminal** state is `achieved`; `blocked` always has a way back; `delete` is the explicit "truly dead" |

`GoalRecord` gains two fields, set while blocked and cleared on resume:

- **`blockReason`** — the obstacle (WOOP "Obstacle").
- **`unblockCriteria`** — the specific, checkable condition to resume (WOOP "Plan" /
  implementation intention). `block()` fills a sensible default if a caller omits it, so a
  block **can never** be a way-out-less dead end.

### 3.2 Every former `abandon` path now `block`s — with a concrete contract

| Trigger | Old | New `blockReason` → `unblockCriteria` |
|---------|-----|--------------------------------------|
| Step budget exhausted | `abandoned` | *"step budget exhausted (N tasks)…"* → *"Raise stepBudget above N, or narrow the criterion, then resume; else delete."* |
| `MAX_GOAL_FAILURES` consecutive no-progress turns (usually a transient brain fault) | `abandoned` | *"no usable progress after N turns…"* → *"The Achiever brain is reachable and returns a parseable decision (usually a transient fault); verify the brain, then resume."* |
| Human decision to stop | `POST /abandon` | `POST /block` with `reason` + `unblockCriteria` (or **Delete** if truly done) |

### 3.3 The Achiever can now block *itself* (the biggest achievability win)

A fourth Achiever move joins `evaluate | plan | emit`:

```json
{ "kind": "block",
  "reason": "needs the Gumroad API token to read revenue",
  "unblockCriteria": "GUMROAD_TOKEN is present in ~/.priv" }
```

Previously, when the Achiever hit a real obstacle it *could not clear* (a missing
credential, an external dependency, a human-only decision), its only honest option was
`evaluate{met:false}` — which counts as *no progress* and, repeated, tripped the failure
guard into `abandoned` with a **generic** reason. Now it declares the obstacle **with its
own specific unblock condition**, and the goal holds gracefully. A self-declared block
counts as *progress* (the loop resolved cleanly), not a failure. This is WOOP's
obstacle→plan performed by the agent at reasoning time — the single change most likely to
turn "stalls into a vague death" into "stops with an actionable next step."

### 3.4 Resume = circuit-breaker HALF-OPEN
`activate()` now also accepts `blocked`. Resuming clears `blockReason`/`unblockCriteria`,
records a `resume` history event, and resets the consecutive-failure counter — the human
(or a met unblock condition) asserts the obstacle is cleared, and the goal gets one clean
turn. If the obstacle persists, it simply blocks again with a fresh, honest reason. No
infinite loop: blocked goals are excluded from the drive loop exactly like paused ones.

### 3.5 What deliberately did **not** change
- **Workflow *runs*** still `abandon` with a reason. A run is ephemeral (it ends by
  design); a goal *persists*. The two termination models are intentionally different, and
  only the goal one changed.
- Binary-criterion enforcement, the step budget, the Judger loop, scheduled checkpoints,
  and the outcome-goal guardrails are all retained — the redesign makes goals *survive
  obstacles*, it does not loosen the discipline that makes them terminate honestly.

---

## 4. Why this makes goals more achievable (not just more forgiving)

1. **Transient faults stop being fatal.** The exact failure that killed `goal-278e9d28`
   (a few unparseable Achiever replies) now parks the goal recoverably; one resume
   continues weeks of work instead of re-authoring it.
2. **Obstacles become actionable.** "blocked because the budget is too small, resume when
   it's raised" tells the operator precisely what to do; "abandoned" told them only that
   it's over.
3. **The agent can ask for help honestly.** Self-declared blocks route real
   human-in-the-loop decisions to a human *with the exact unblock condition attached*,
   instead of spinning turns until a guard kills the goal.
4. **Commitment survives setbacks** (Locke & Latham 2–3): a missed metric or a hit
   guardrail is now a re-plan/resume signal, never a termination.
5. **It is resilient by the book** — the CLOSED/OPEN/HALF-OPEN circuit breaker that the
   agentic-AI literature prescribes for long-running agents.

---

## 5. Surface changes (implementation map)

- **`types.ts`** — `GoalRecord.status` drops `abandoned`, adds `blocked`; adds
  `blockReason` + `unblockCriteria`; `GoalDecision.kind` adds `block`/`resume`;
  `AchieverDecision.kind` adds `block` + `unblockCriteria`.
- **`core/goals.ts`** — `abandon()` → `block(goalId, reason, unblockCriteria)`;
  `activate()` accepts `blocked` and clears the contract on resume; `update()` allows
  editing a `blocked` goal (only `achieved` is uneditable); `applyAchieverDecision()`
  handles the `block` move.
- **`core/dispatcher.ts`** — budget-exhaustion and failure-ceiling paths call `block()`
  with concrete resume contracts; the parser and Achiever prompt accept/teach the `block`
  move; a block counts as progress.
- **`api/goals.ts`** — `POST /goals/:id/abandon` → `POST /goals/:id/block`
  (`reason` + `unblockCriteria`).
- **`mcp/server.ts`** — `update_goal_progress` accepts `kind:"block"` + `unblockCriteria`.
- **`public/js/app.js`** — status colour, **Block** + **Resume** controls, a blocked-panel
  showing *Blocked: … / Resume when: …*, and refreshed help text.
- **Skill docs** (`deploy/skills/{claude,hermes,agy,codex}-cowork.SKILL.md`) — updated to
  the blocked/resume model and the self-block move.

All 190 server tests pass, including new coverage for the block/resume contract, the
default-unblock guarantee, editability of blocked goals, `achieved` terminality, and the
Achiever's self-declared block.

---

## Sources
- Locke & Latham, *Building a Practically Useful Theory of Goal Setting and Task
  Motivation* — https://med.stanford.edu/content/dam/sm/s-spire/documents/PD.locke-and-latham-retrospective_Paper.pdf
- Goal-Setting Theory overview — https://www.sciencedirect.com/topics/social-sciences/goal-setting-theory
- Locke & Latham five-principle framework — https://strategicmanagementinsight.com/tools/locke-lathams-five-principle-framework/
- WOOP / mental contrasting (Oettingen) — https://woopmylife.org/en/publications
- WOOP + implementation intentions (Gollwitzer) — https://www.hprc-online.org/mental-fitness/performance-psychology/woop-4-simple-steps-help-you-achieve-your-goals
- AI agent failure modes — https://www.trantorinc.com/blog/ai-agent-failure-modes-what-goes-wrong-design-resilience
- AI agent self-healing / circuit breaker (CLOSED/OPEN/HALF-OPEN) — https://zylos.ai/research/2026-03-02-ai-agent-self-healing-recovery-patterns/
- Human-in-the-loop checkpoints for agents — https://www.mindstudio.ai/blog/human-in-the-loop-checkpoints-ai-agents-full-autonomy
