# Cowork Documentation

Detailed manuals for the Cowork multi-agent hub. Start with the top-level
[README](../README.md) for the overview and quick start; the guides below go deep
on specific subsystems.

## Guides

| Doc | What it covers |
|-----|----------------|
| **[dashboard.md](dashboard.md)** | **Page-by-page manual of the web dashboard** — every nav tab (Overview, Portal, Tasks, Recipes, Calendar, Goals, Routing, Agents, Personas, Workers, Configuration), what it shows, and the REST endpoints behind it. |
| [self-improvement-env-sharing.md](self-improvement-env-sharing.md) | The human-gated lesson loop and agent environment sharing — overview. |

## Top-level references

- [../README.md](../README.md) — project overview, quick start, feature tour.
- [../PROTOCOL.md](../PROTOCOL.md) — the task protocol every worker follows.
- [../JOIN-AS-AN-AGENT.md](../JOIN-AS-AN-AGENT.md) — connect a remote agent to the hub.
- [../CONVENTIONS.md](../CONVENTIONS.md) — operating rules for executing agents.

## Where things live in the repo

```
server/src/core/    The engine: dispatcher.ts, store.ts, …
server/src/api/     REST routers (router.ts, sse.ts)
server/public/      The dashboard SPA (index.html + js/app.js)
docs/               You are here
```
