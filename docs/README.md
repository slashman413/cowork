# Cowork Documentation

Detailed manuals for the Cowork multi-agent hub. Start with the top-level
[README](../README.md) for the overview and quick start; the guides below go deep
on specific subsystems.

## Guides

| Doc | What it covers |
|-----|----------------|
| **[workflow-builder.md](workflow-builder.md)** | **The complete Workflows manual** — the two execution modes (`dag` vs `orchestrated`) explained in full, the template schema, parameters & interpolation, validation & cycle detection, running & tracing, routing, authoring (by hand / API / the `workflow-builder` meta-workflow), configuration knobs, the REST surface, recipes, and failure modes. |
| **[dashboard.md](dashboard.md)** | **Page-by-page manual of the web dashboard** — every nav tab (Dashboard, Portal, Chat, Inbox, Workflows, Agents, Brains, Agencies, Connections, Configuration), what it shows, and the REST endpoints behind it. |
| [self-improvement-env-sharing.md](self-improvement-env-sharing.md) | The human-gated lesson loop and brain environment sharing — overview. |
| [design-self-improvement-env-sharing.md](design-self-improvement-env-sharing.md) | Design notes for the self-improvement + env-sharing feature. |
| [specs-self-improvement-env-sharing.md](specs-self-improvement-env-sharing.md) | Full specification for the same. |

## Top-level references

- [../README.md](../README.md) — project overview, quick start, feature tour.
- [../PROTOCOL.md](../PROTOCOL.md) — the task protocol every worker follows.
- [../JOIN-AS-A-BRAIN.md](../JOIN-AS-A-BRAIN.md) — connect a remote brain to the hub.
- [../CONVENTIONS.md](../CONVENTIONS.md) — operating rules for executing agents.

## Where things live in the repo

```
workflows/          Workflow templates (*.json) — DAG + orchestrated
workflow-runs/      Orchestrated run records + decision logs (gitignored)
server/src/core/    The engine: workflows.ts, dispatcher.ts, store.ts, …
server/src/api/     REST routers (workflows.ts, router.ts, sse.ts)
server/public/      The dashboard SPA (index.html + js/app.js)
docs/               You are here
```
