# Autonomous human-input handling (ADR-009)

## Status
Accepted — implemented in `server/src/core/dispatcher.ts` (`driveWaitInput`).

## Context

A dispatched task that cannot finish without a decision ends its run with a
`NEEDS_INPUT:` marker (or a blocking phrase the result-verifier recognises). The
dispatcher then parks it on the **`wait-input`** status with an *interaction
packet* — a set of questions held OUT of the pending pool until a **person** fills
them in from the Inbox card (`store.submitInteraction`), which releases the task
back to `pending`.

That human-in-the-loop gate is the one place the fleet still needs the CEO to act
manually. The ask (2026-09-27): *"I want the orchestrator to do all the human
interactions so I don't have to do it manually at all."*

## Decision

Add an **opt-in** autonomous answerer, the sibling of `driveGoals`/`driveWorkflows`,
that runs each dispatcher tick when `orchestration.autoAnswer.enabled` is true:

For every task on `wait-input` with an unanswered interaction packet, the
**orchestrator brain** is asked to answer the questions **as the CEO's fully-
authorised delegate**. It replies with one fenced-JSON block — either the answers
keyed by field id, or an honest `escalate`. Answers are submitted via the same
`store.submitInteraction` path a human uses (`submittedBy: "orchestrator
(auto-answer)"`, so the dashboard shows who really answered), releasing the task.

### Guardrails (why this is safe, not a rubber stamp)

1. **Honest escalation, never fabrication.** The orchestrator is instructed to
   `escalate` — leaving the task parked for a human — for any decision a person
   must physically make or that is irreversible/high-stakes: a browser OAuth
   re-auth, entering a password/2FA, spending real money or approving a fee, an
   owner-only console toggle (e.g. enabling GitHub Pages), or deleting production
   data. The orchestrator cannot click a browser button or spend money, so
   answering those would be a lie (CONVENTIONS.md rule 4). An escalated task
   records `context.autoAnswer.escalateReason` and is not retried.
2. **Bounded loop.** A per-task counter (`context.autoAnswer.count`, persisted so
   it survives restarts) caps consecutive auto-answers at
   `autoAnswer.maxAttempts` (default 3). A task that keeps re-asking after the
   ceiling is genuinely undecidable by the orchestrator and is left for a real
   human — the honest fallback.
3. **Explicit human escape hatch.** A task tagged `human-only` (or `manual`) is
   never auto-answered, so the CEO can still force a specific decision back to
   themselves.
4. **Re-entrancy guard + race re-check.** One turn per task at a time
   (`decidingInput`); the task is re-read after the LLM turn so a human who
   answered in the meantime always wins.
5. **Infra blips don't burn attempts.** A timeout / unparseable reply is retried
   next tick without bumping the counter.

## Config

```jsonc
"orchestration": {
  "autoAnswer": {
    "enabled": false,        // opt-in; default keeps the wait-for-a-person behaviour
    "maxAttempts": 3,        // per-task ceiling before leaving it for a human
    "timeoutMs": 300000,     // optional; defaults to classifier.timeoutMs
    "brains": []             // optional; defaults to the orchestrator agent's chain
  }
}
```

## Consequences

- **Easier:** a paused pipeline resumes on its own; the CEO no longer clears the
  Inbox of routine clarifications. Combined with the goals loop (ADR-008), a run
  now self-heals across *both* blocked goals and paused tasks.
- **Harder / traded off:** the orchestrator now makes reversible product decisions
  unattended. That is the point, but it means the quality of those defaults rides
  on the orchestrator brain; the `maxAttempts` ceiling and honest-escalation rule
  bound the blast radius. Left **off by default** so the change is inert until the
  operator flips it on.
- Truly human-only actions (money, browser auth, owner-only toggles) still stop
  for a person — by design, not by omission.
