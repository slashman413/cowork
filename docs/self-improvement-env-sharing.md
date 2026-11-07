# Self-Improvement + Env-Sharing — implementation status

Constraint: improvement is
**event-driven and human-gated** — no cron, no autonomous "improver" agent.

This is a phased rollout following the specs' own build order. Each phase is
independently shippable.

## Shipped

### WF-1 — Lesson ledger (cross-task memory)
- `server/src/core/lessons.ts` — `extractRequires` (deterministic `path:`/`tool:`/`secret:`
  extraction, no LLM), `deriveAgentFamily`, `titleSlug`, `buildLesson` (caps
  reason→500 chars, requires→10), `appendLesson` (**never-throw**, best-effort).
- Wired into the dispatcher at the four failure/park sites (`recordLesson`), next
  to `recordFailedAgent`. On every verifier rejection and every `wait-input`
  parking (remote + local paths) one JSON line is appended to
  `decisions/lessons.jsonl`. Ledger failure (full/unwritable disk) is swallowed
  after logging — it can never break dispatch.
- Tests: `server/src/core/lessons.test.ts`.

### WF-3 Part R — Agent env manifests (RC-1 fix)
- `types.ts`: `AgentEnv` ({paths, tools, secrets, net, traits}) + `AgentConfig.env`.
- `mcp/server.ts`: `env` added to the (closed) `register_agent` zod schema **and**
  forwarded through `registerAgent` — both halves, per RC-1; forgetting the
  forward would silently no-op. Server caps each list to ≤200 entries × ≤300 chars
  (`capEnv`).
- `deploy/remote-agent-client.mjs`: `detectEnv()` auto-detects tools (`command -v`),
  paths (`test -d` over `$ENV_PATHS`, default `~/workspace:~/.priv`), and credential
  **names** under `~/.priv/` (never values). Declared in the registration handshake.
- Tests: `server/src/core/agent-env.test.ts` (RC-1 persistence round-trip).

`secrets` carries credential NAMES only — no secret value ever transits the
handshake, the store, or an artifact.

## Not yet built (next phases, unchanged plan)

- **WF-3 Parts T+D** — `context.requires` on tasks + the `planFor()`/`chainFor()`
  routing filter that consumes the manifests (RC-2 attempt-indexing and RC-3
  auto-unpark subtleties apply). This is what structurally kills the misroute class.
- **WF-4** — env-store (`env-store/*.json`) merged per task at claim, delivered via
  `cowork-env.json` + process env. Secret-shaped keys refused.
- **WF-2** — recurrence detector → human-gated `wait-input` proposal task, and
  application to `routing-rules.json` / `playbooks/<agent>.md`. (The read-only half exists:
  `server/src/core/correct-loop.ts` + `GET /api/lessons/classes` group lessons into classes and
  draft a remedy menu; no proposal task or apply step is built.)
- **A4** — optional `LESSON:` line from the LLM verifier (recall boost).

Runtime data files (`decisions/*.jsonl`, `routing-rules.json`, `playbooks/`) are
server-owned state and are gitignored.
