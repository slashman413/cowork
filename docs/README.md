# Cowork Documentation

Detailed manuals for the Cowork multi-agent hub. Start with the top-level
[README](../README.md) for the overview and quick start; the guides below go deep
on specific subsystems.

## Guides

| Doc | What it covers |
|-----|----------------|
| **[dashboard.md](dashboard.md)** | **Page-by-page manual of the web dashboard** — every nav tab (Overview, Portal, Tasks, Recipes, Calendar, Goals, Routing, Agents, Workers, Configuration), plus Integrations, what it shows, and the REST endpoints behind it. |
| [self-improvement-env-sharing.md](self-improvement-env-sharing.md) | The human-gated lesson loop and agent environment sharing — overview. |
| [calendar-ux.md](calendar-ux.md) | The Calendar page: scheduled and recurring tasks on a time axis, UX spec and data contract. |
| [goals-redesign.md](goals-redesign.md) | Goals engine and the recoverable, self-healing `blocked` state (ADR-007, ADR-008). |
| [goal-loop-idiom.md](goal-loop-idiom.md) | Authoring a goal with the `/goal` + `/loop` idiom and the starter templates (ADR-010). |
| [goal-display-states.md](goal-display-states.md) | The display-state words the Goals page, `GET /api/goals` and `list_goals` share. |
| [autonomous-input-handling.md](autonomous-input-handling.md) | How the orchestrator auto-answers `wait-input` tasks as the CEO's delegate (ADR-009). |
| [rule-enforcement.md](rule-enforcement.md) | Maintainers' table: which code enforces each rule in `CONVENTIONS.md`. |
| [tasks-page-performance.md](tasks-page-performance.md) | Why the Tasks page was slow and what each fix bought (2026-11-02). |
| [architecture/flood-guard.md](architecture/flood-guard.md) | The recurring-task flood guard: one run in flight per recurring task. |
| [plans/goals-token-and-ux-plan.md](plans/goals-token-and-ux-plan.md) | Goals token-efficiency and UX plan (implemented 2026-11-06). |
| [cowork-hub.html](cowork-hub.html) | Interactive architecture diagram of the hub (`cowork-hub.architecture.json` is its data). |

## Top-level references

- [../README.md](../README.md) — project overview, quick start, feature tour.
- [../PROTOCOL.md](../PROTOCOL.md) — the task protocol every worker follows.
- [../JOIN-AS-AN-AGENT.md](../JOIN-AS-AN-AGENT.md) — connect a remote agent to the hub.
- [../CONVENTIONS.md](../CONVENTIONS.md) — operating rules for executing agents.

## Where things live in the repo

```
server/src/core/    The engine: dispatcher.ts, store.ts, …
server/src/api/     REST routers (router.ts, goals.ts, recipes.ts, sse.ts)
server/public/      The dashboard SPA (index.html + js/app.js)
docs/               You are here
```
