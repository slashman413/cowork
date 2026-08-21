# Cowork Self-Improvement + Env-Sharing — Build-Ready Workflow Specs

**Version**: 0.1 · **Date**: 2026-08-04 · **Author**: Workflow Architect
**Continues**: task 824ee0cd (design report `self-improvement-and-env-sharing-design.md`)
**Verified against**: `~/workspace/github/slashman413/cowork` @ `c080a38` (unchanged since the design audit — all line references re-checked live this run)

This document turns the approved design into implementable workflow specifications: four workflows, each with a full tree (happy path + every failure branch), handoff contracts, cleanup inventory, observable states, and test cases derived per branch. A Backend Architect should be able to implement each without guessing failure behavior.

---

## Registry

### View 1 — Workflows

| Workflow | Spec | Status | Trigger | Primary actor |
|---|---|---|---|---|
| WF-1 Lesson capture | §WF-1 | Draft | Verifier rejection OR wait-input parking (event, in-lifecycle) | Dispatcher |
| WF-2 Recurrence proposal | §WF-2 | Draft | Lesson ledger append (inline, same event) | Dispatcher → Human |
| WF-3 Env manifest + requires routing | §WF-3 | Draft | `register_agent` handshake; `planFor()` per tick | Client + Dispatcher |
| WF-4 Env-store delivery | §WF-4 | Draft | Task claim | Server API + Client |
| Lesson application (routing-rules/playbooks reload) | folded into WF-2 steps 6–7 | Draft | Human answers proposal | Human + Dispatcher |
| (existing) Fallback-chain handover | — | Missing spec (pre-existing, out of scope) | verify fail | Dispatcher |

### View 2 — Components

| Component | File(s) | Participates in |
|---|---|---|
| Dispatcher | `server/src/core/dispatcher.ts` | WF-1, WF-2, WF-3 (routing filter), WF-4 (local spawn env) |
| Result verifier | `server/src/core/result-verifier.ts` | WF-1 (failure reasons), WF-2 (optional LESSON line) |
| Store | `server/src/core/store.ts` | WF-2 (`createTask` with interaction packet), WF-4 (inputs channel) |
| MCP server | `server/src/mcp/server.ts:50-100` | WF-3 (handshake schema — **must change**, see RC-1) |
| Remote brain client | `deploy/remote-brain-client.mjs` | WF-3 (env auto-detect), WF-4 (env fetch + injection) |
| New: `core/lessons.ts` | (new) | WF-1, WF-2 |
| New: `core/env-store.ts` | (new) | WF-4 |
| New: `decisions/` data files | `lessons.jsonl`, `routing-rules.json`, `playbooks/*.md`, `env-access.jsonl` | WF-1, WF-2, WF-4 |

### View 3 — Journeys

| Experience | Workflows | Entry |
|---|---|---|
| Operator answers "recurring failure — pick a remedy" card in Inbox | WF-2 | Dashboard wait-input card |
| Operator inspects why a brain can't take a task | WF-3 | Dashboard Brains view (env facts column) |
| A task needing `/home/wayne` never lands on ai-code-gen again | WF-3 | automatic |
| A brain reads `LINK_BASE` instead of guessing it | WF-4 | `cowork-env.json` / `$COWORK_ENV` |

### View 4 — State map (new/changed states only)

| State | Entered by | Exited by |
|---|---|---|
| task `wait-input` (proposal) | WF-2 step 5 | Human submits interaction → WF-2 step 6 |
| task `wait-input` (unroutable) | WF-3 step R4 fail-closed | Human relaxes `requires`, attaches inputs, or a qualifying brain registers |
| lesson `open-proposal` (ledger flag) | WF-2 step 4 | proposal answered or dismissed |

---

## WF-1: Lesson capture

**Overview**: On every verifier rejection and every wait-input parking, the dispatcher appends one structured JSON line to `decisions/lessons.jsonl`. Deterministic, no LLM, no scheduler. This is the memory layer everything else reads.

**Actors**: Dispatcher (writer), filesystem (`decisions/` — exists via `config.ts:53` + store bootstrap), WF-2 (reader).

**Prerequisites**: `decisions/` dir exists (already created by store bootstrap). New module `core/lessons.ts` exporting `appendLesson(l: Lesson): void` and `extractRequires(text: string): string[]`.

**Trigger — exactly four call sites** (verified against `c080a38`):

1. `dispatcher.ts:869` — remote-rung fail path in `verifyReportedCompletion` (next to existing `recordFailedBrain` call).
2. `dispatcher.ts:1025` — local-execute verify-fail path (next to the other `recordFailedBrain` call).
3. `dispatcher.ts:840` and `:855` — `detectInputRequest` returning `needsInput: true` inside `verifyReportedCompletion` (kind `wait-input`).
4. `dispatcher.ts:1010` — local path input-request detection (kind `wait-input`).

### Tree

**STEP 1: Build lesson record** — Actor: Dispatcher. Timeout: n/a (synchronous, in-memory).
Input: `{ task, brainId, agent, attempt, kind: 'verify-fail'|'wait-input', reason|questions, resultText }`.
Action: `extractRequires(resultText + reason)` — deterministic regex pass producing `requiresGuess: string[]`:
  - absolute paths mentioned as missing/absent/ENOENT → `path:<p>`
  - `command not found: X` / `X: not found` → `tool:X`
  - credential-store names (`~/.priv/<name>`, `token`, `OAuth`, `credentials for <svc>`) → `secret:<name>`
Output: `Lesson` object → STEP 2.
FAILURE(regex-miss): `requiresGuess: []` — **not an error**; the lesson is still recorded (WF-2 falls back to titleSlug-family matching).

**STEP 2: Append to ledger** — Actor: `core/lessons.ts`. Timeout: filesystem-synchronous.
Action: `appendFileSync(decisions/lessons.jsonl, JSON.stringify(l) + '\n')`.
SUCCESS → STEP 3 (WF-2 inline check).
FAILURE(EACCES/ENOSPC/ENOENT-dir): log `[lessons] append failed: <err>` to server log and **return** — the task lifecycle MUST NOT be affected by ledger failure. Lesson capture is best-effort observability; a full disk must not break dispatch. No retry (next event writes again anyway).
FAILURE(concurrent write): single-process server, `appendFileSync` under PIPE_BUF-size lines is atomic. Assumption A1 (line length < 4096 bytes) — enforce by truncating `reason` to 500 chars and `requiresGuess` to 10 entries at build time.

**STEP 3**: hand `Lesson` to WF-2's inline check (same call stack). Any WF-2 throw is caught here with the same never-break-dispatch rule.

**Observable states**: Customer/operator see nothing new (by design — capture is silent). Database: none (ledger is not the task store). Logs: one `[lessons] recorded <kind> <taskShortId> <signature>` line per append.

**Cleanup inventory**: nothing to clean — append-only file; no ABORT path creates resources.

### Record schema (handoff contract WF-1 → WF-2, and → any future reader)

```json
{"at":"ISO-8601","kind":"verify-fail|wait-input","task":"<id>","titleSlug":"<kebab of title, first 6 words>",
 "agent":"<agent slug>","brain":"<brain id>","brainFamily":"<brain id with last -segment dropped>",
 "attempt":1,"reason":"<truncated 500>","requiresGuess":["path:/home/wayne"],"questions":["..."]}
```

`brainFamily` derivation: strip the final `-<model>` segment (`remote-ai-code-gen-cc-fable` → `remote-ai-code-gen-cc`). Deterministic; documented in `lessons.ts`.

### Test cases

| TC | Trigger | Expected |
|---|---|---|
| 1-01 | verify-fail on remote rung | one line appended; task lifecycle identical to today (existing `dispatcher-handover.test.ts` assertions still pass) |
| 1-02 | wait-input parked | line with `kind:"wait-input"` + questions |
| 1-03 | result text contains `/home/wayne ... No such file` and `xurl: command not found` | `requiresGuess:["path:/home/wayne","tool:xurl"]` |
| 1-04 | ledger dir unwritable (chmod 500) | task completes/fails exactly as before; error logged; no throw |
| 1-05 | 500-char reason with newlines | single valid JSONL line (newlines escaped) |

---

## WF-2: Recurrence detection → human-gated proposal

**Overview**: Runs inline immediately after every WF-1 append (same event handler — no scheduler, no cron, no polling). If the same failure signature has recurred past a threshold, creates ONE `wait-input` task addressed to the human with concrete remedy options. Only the human's answer applies anything.

**Actors**: Dispatcher (detector + drafter), Store (`createTask`, `store.ts:278` — interaction packet parking at `store.ts:296-301` guarantees the task starts on `wait-input` and is held out of the pending pool), Human (decider), data files (application surface).

**Config** (new `orchestration.lessons` block, all defaulted): `{ threshold: 3, windowDays: 30, suppressDays: 90, enabled: true }`.

### Tree

**STEP 1: Compute signature** — `sig = requiresGuess.length ? sortedJoin(requiresGuess) + '|' + brainFamily : titleSlugFamily + '|' + brainFamily`. Pure function.

**STEP 2: Count occurrences** — read `lessons.jsonl` (stream, filter `at >= now - windowDays`), count lines with equal `sig`. Timeout: none needed at current scale (Assumption A2: ledger < ~50k lines; if exceeded, add a monthly-rotated file — note in code, do not build now).
Output `< threshold` → STOP (normal case, zero cost beyond the scan).
Output `>= threshold` → STEP 3.
FAILURE(unreadable/corrupt line): skip corrupt lines individually (JSON.parse per line in try/catch); never throw.

**STEP 3: Idempotency gate** — a proposal for `sig` already exists if the ledger contains a `kind:"proposal-created"` line for `sig` whose `at` is within `suppressDays` and no matching `kind:"proposal-dismissed"`… **Decision**: track proposal state in the ledger itself (append `proposal-created` / `proposal-answered` / `proposal-dismissed` records) — no second state file, crash-safe, greppable. Gate open → STEP 4; closed → STOP.

**STEP 4: Draft proposal** — build title `Recurring failure: <titleSlugFamily or requires summary> (<n>×)`, description containing: the count and date range, the last 3 task short-ids as evidence, and the remedy menu. Build interaction packet fields (single-select + optional free text):

```json
{"interaction":{"status":"pending","fields":[
  {"id":"remedy","type":"select","label":"Apply which remedy?","options":[
    "routing-rule: deny <brainFamily>-* for requires <sig>",
    "playbook: append note for agent <agent>",
    "conventions: draft a CONVENTIONS.md diff (manual git apply)",
    "dismiss: suppress this signature for 90 days"]},
  {"id":"note","type":"text","label":"Edit/extend the remedy text (optional)"}]}}
```

**STEP 5: Create task** — `store.createTask({ title, description, tags:['lesson-proposal','manual'], context:{ proposalSig: sig }, interaction })`.
The `manual` tag makes `planFor()` return `skip` (dispatcher.ts:288) — belt-and-braces on top of the interaction-packet parking, so a proposal can never be auto-executed even if someone later submits the packet without meaning to route it.
SUCCESS → append `proposal-created` ledger line → STOP (turn ends; human is now in the loop via the Inbox card the dashboard already renders).
FAILURE(createTask throws): log, append nothing, STOP. Next recurrence re-triggers the draft — self-healing, at the cost of the count being ≥ threshold+1. Acceptable.

**STEP 6: Human answers** (async, days later) — existing interaction-answer flow (`store.ts:642` `submitInteraction`). The dispatcher observes answered proposals in its existing tick when the task leaves `wait-input`. **The proposal task's execution is the application step**, run by the dispatcher itself (not a brain — no LLM needed):
  - `remedy = routing-rule` → append entry to `decisions/routing-rules.json` (create file if absent): `{ "match": { "requires": [<sig parts>] }, "deny": ["<brainFamily>-*"], "addedBy": "<proposal task id>", "at": "…" }`.
  - `remedy = playbook` → append the note (from `note` field, else the drafted default) to `decisions/playbooks/<agent>.md`.
  - `remedy = conventions` → write the drafted diff to the proposal task's artifacts dir; mark task done with instructions "apply via git". **Never write CONVENTIONS.md directly** (CONVENTIONS §2).
  - `remedy = dismiss` → append `proposal-dismissed` ledger line.
  All branches: append `proposal-answered`, mark task `done` with a result describing exactly what was written where.
  FAILURE(write EACCES): task → `failed` with the error as result; nothing partially applied (each remedy is a single-file single-append — no multi-resource cleanup needed).

**STEP 7: Hot reload** — `chainFor()`/`planFor()` and the prompt builders read `routing-rules.json`/`playbooks/` fresh per tick with mtime-based caching (Assumption A3: per-tick stat cost is negligible; the dispatcher tick already does store reads).

### Observable states

| Moment | Customer/Operator sees | Ledger | Logs |
|---|---|---|---|
| threshold hit | new Inbox card (wait-input, remedy select) | `proposal-created` | `[lessons] proposal <sig> created task <id>` |
| answered | card completes; task result names the file written | `proposal-answered` | `[lessons] applied remedy <remedy> → <file>` |
| dismissed | card completes "suppressed 90d" | `proposal-dismissed` | — |

### Cleanup inventory

| Resource | Created at | Destroyed by |
|---|---|---|
| proposal task | STEP 5 | normal task lifecycle (30-day archive) — no special cleanup |
| routing-rule entry | STEP 6 | human edit/removal of `routing-rules.json` (it's data; document in README) |
| playbook note | STEP 6 | human edit |

### Test cases

| TC | Trigger | Expected |
|---|---|---|
| 2-01 | 2 same-sig lessons | no proposal |
| 2-02 | 3rd same-sig lesson | exactly one wait-input task with `manual` tag + interaction packet, held out of pending pool |
| 2-03 | 4th same-sig lesson while proposal open | no second proposal |
| 2-04 | answer `routing-rule` | `routing-rules.json` gains one entry; task done; next tick `planFor` respects it (compose with TC 3-xx) |
| 2-05 | answer `dismiss`, then 3 more recurrences within 90d | no new proposal; after 90d, new proposal |
| 2-06 | corrupt line mid-ledger | count skips it; no throw |
| 2-07 | proposal task force-submitted with empty answer | task remains non-routable (`manual`); nothing applied |

---

## WF-3: Env manifests + `requires` routing

**Overview**: Brains declare machine-detected environment facts at registration; tasks declare `context.requires`; `planFor()` filters chain rungs against manifests and fails closed to `wait-input` when no brain qualifies.

### Part R (registration)

**STEP R1: Client auto-detect** (`remote-brain-client.mjs`, ~40 loc next to the existing `hasCli()` pattern) — `command -v` over a fixed tool list + `$ENV_TOOLS` extras; `test -d` over `$ENV_PATHS` (colon-separated, default `$HOME/workspace:$HOME/.priv`); file **names** (never contents) under `~/.priv/` → `secrets`. Timeout: 5s total for all probes; on timeout ship whatever was detected (partial manifest is better than none).

**STEP R2: Handshake** — add `env` to each brain object in `register_agent`.
⚠ **RC-1 (corrects the design report)**: the design claimed the payload is "free-form JSON already". **False** — `server/src/mcp/server.ts:62-69` is a closed zod object; an unknown `env` key is silently stripped, and `registerBrain` (`:83-92`) forwards only whitelisted fields. Required changes: (a) add `env: z.object({ paths: z.array(z.string()), tools: z.array(z.string()), secrets: z.array(z.string()), net: z.array(z.string()).optional(), traits: z.array(z.string()).optional() }).partial().optional()` to the schema; (b) forward `...(b.env ? { env: b.env } : {})` in the `registerBrain` call. Without (b) the feature silently no-ops — this is exactly the class of bug the closed schema hides.
Server caps: ≤200 paths/tools/secrets entries, each ≤300 chars — reject oversize with an error result (the handler already has the try/catch → `isError` path).
Old client (no `env`) → brain stored without `env` → legacy-permissive routing (below). Zero-upgrade compatibility.

**STEP R3: Store + display** — `env` persisted on the brain record in `orchestration.brains`; dashboard Brains view renders it (read-only).

### Part T (task requires)

`context.requires: string[]` with grammar `path:<abs> | tool:<name> | secret:<name> | net:<host>`. Sources in precedence order: (1) explicit at create, (2) workflow step template, (3) fallback: WF-1's `extractRequires()` over the description at create time, stored as `requiresAuto` (advisory — used for routing but shown as "auto-detected" in the dashboard so a human can strike it). A wrong auto-require that unroutes a task is recoverable via the wait-input card (below), so auto-detection failing open is acceptable.

### Part D (dispatch filter) — inserted in `planFor()` (dispatcher.ts:287) and `chainFor()` consumers

**STEP D1: satisfies(brain, requires)** — pure function:
  - brain has `env` → every `requires` entry must match (`path:` by prefix against `env.paths`; `tool:`/`secret:`/`net:` by exact name).
  - brain has **no `env`** (legacy) → permissive for `tool:`/`net:`, **fail-closed for `path:` and `secret:`** (the two classes behind every misroute incident in the operator history).
**STEP D2: filter the chain** — `chain.filter(id => satisfies(brains[id], requires))`, applied after `decisions/routing-rules.json` deny globs (WF-2 output composes here: rules deny, requires filter, then normal attempt indexing over the *filtered* chain).
⚠ Ordering subtlety: `attempt` currently indexes the raw chain. After filtering, `attempt` must index the **filtered** chain, and `chainLen` passed to `brainPlan` must be the filtered length — otherwise a filtered-out rung silently consumes an attempt. Test 3-04 pins this.
**STEP D3: pinned brain** (`context.brain`, dispatcher.ts:299) — a human pin **overrides** requires (explicit human choice beats inference) but logs `[requires] pin overrides unsatisfied <sig>` and appends a WF-1 lesson line if the run then fails (feeds the loop rather than blocking the human).
**STEP D4: fail-closed** — filtered chain empty AND requires non-empty → do NOT return `skip` (which would strand the task silently in pending forever). Instead: set an interaction packet on the task — question: *"No registered brain satisfies `<requires>`. Options: attach the needed files as inputs / remove the requirement / bring a qualifying host online (its next register_agent will unblock this task)."* → task parks on `wait-input`; append a WF-1 lesson (`kind:"wait-input"`, requires as `requiresGuess`) so WF-2 counts it.
**STEP D5: unblock** — when a human answers (drop requirement / attached inputs) the existing interaction flow re-queues it; when a **new brain registers** with a satisfying manifest, the next dispatcher tick… ⚠ won't see it: `wait-input` tasks are held out of the pool. **Resolution**: on `register_agent`, the server scans `wait-input` tasks whose packet was machine-generated by D4 (marked `context.requiresParked: true`) and whose requires are now satisfiable → auto-submit the interaction with answer `"unblocked by <brainId> registration"` and return to pending. This is safe because the packet was machine-created for exactly this condition; human-created packets are never auto-answered.

### Observable states

| State | Customer | Operator | Task JSON | Logs |
|---|---|---|---|---|
| routed with filter | normal | brain label as today | — | `[requires] <task> chain 3→2 after filter` |
| parked D4 | Inbox card with the 3 options | same card + `requiresParked` badge | `status:wait-input, context.requiresParked:true` | `[requires] <task> unroutable: <sig>` |
| auto-unparked D5 | card resolves | task back in pending | `requiresParked` cleared, answer recorded | `[requires] <task> unblocked by <brain>` |

### Cleanup inventory
No resources created; D4's interaction packet is cleared by D5/human answer (single mutation, no partial state).

### Test cases

| TC | Setup | Expected |
|---|---|---|
| 3-01 | requires `path:/home/wayne`; brain A env has it, brain B doesn't | chain = [A] |
| 3-02 | requires `secret:gumroad`; only legacy brains (no env) | fail-closed → wait-input, `requiresParked:true`, lesson appended |
| 3-03 | requires `tool:ffmpeg`; legacy brain | permissive → routed (legacy behavior preserved) |
| 3-04 | 3-rung chain, rung 0 filtered out, attempt=0 | runs on old rung 1; `chainLen=2`; handover math correct |
| 3-05 | pinned brain lacking requires | runs anyway; override logged |
| 3-06 | task parked by 3-02, then qualifying brain registers | auto-unparked to pending |
| 3-07 | human-created wait-input task, brain registers | NOT auto-answered |
| 3-08 | routing-rules.json deny + requires both filter | both applied, deny first |

---

## WF-4: Env-store delivery

**Overview**: server-owned scoped KV (`env-store/global.json`, `env-store/task-type/<tag>.json`, `env-store/brain/<glob>.json`) merged per task at claim time; delivered as process env + `cowork-env.json` through the existing inputs channel.

### Tree

**STEP 1: Write path (operator)** — files edited by hand or via a small API (`PUT /api/env-store/<scope>`; optional, ship file-only first). Server-side validation on **read AND write**: reject keys matching `/(TOKEN|SECRET|KEY|PASSWD|PASSWORD|CREDENTIAL)/i` unless listed in `env-store/allowlist.json`. On read-side violation (someone hand-edited a token in): **drop the key, log loudly** `[env-store] refused secret-shaped key <k> in <file>` — never serve it. Fail-safe beats fail-closed here: one bad key must not withhold the rest of the config from a running task.

**STEP 2: Merge at claim** — `GET /api/env/<task-id>` (claim-authenticated same as other task endpoints). Merge order (later wins): `global` → each matching `task-type/<tag>` in tag order → most-specific matching `brain/<glob>`. Values stringified; result ≤ 32KB (reject larger with 413 — env-vars are not a file store).
FAILURE(no env-store dir / all files absent): return `{}` with 200 — the feature must be a no-op when unconfigured.
FAILURE(malformed JSON in one scope file): skip that file, log, serve the rest (same fail-safe rule).

**STEP 3: Delivery, both channels**:
  a. **Inputs file** (works with OLD clients, ship first): at dispatch/claim the server writes the merged snapshot as `cowork-env.json` into `inputs/<task-id>/` via the existing inputs flow (`downloadInputs()` at client `:219` already fetches everything there). Prompt line appended by both prompt builders: *"Shared environment for this task is in cowork-env.json (also $COWORK_ENV if set) — use these values instead of guessing URLs, slugs, or paths."*
  b. **Process env** (needs client upgrade): client fetches `GET /api/env/<task-id>` after claim; on success spreads into `spawn` env next to `COWORK_ARTIFACTS_DIR` (client `:185`) plus `COWORK_ENV=<abs path to cowork-env.json>`; local dispatcher spawn gets the same. FAILURE(fetch error/timeout 10s): proceed **without** env injection — the inputs-file copy still exists; log a warning. Env delivery must never block a claim.

**STEP 4: Access log** — every non-empty serve appends `{keys:[names only], task, brain, at}` to `decisions/env-access.jsonl` (WF-1's never-break-dispatch rule applies).

**Secrets stay out** (unchanged from design): real credentials never transit the store; `secret:<name>` requires (WF-3) move the *task* to the credential host. Cross-host secret sync, if ever needed, is out-of-band sops/age.

### Observable states
Operator: dashboard task detail lists `cowork-env.json` among inputs (existing inputs rendering — free). Logs: `[env-store] served 4 keys to <task>/<brain>`.

### Cleanup inventory
`cowork-env.json` lives in `inputs/<task-id>/` — lifecycle identical to other inputs (30-day archive). Nothing else created.

### Test cases

| TC | Setup | Expected |
|---|---|---|
| 4-01 | no env-store dir | `GET /api/env/<id>` → `{}`; no `cowork-env.json`; prompts unchanged |
| 4-02 | global + task-type overlap | task-type value wins |
| 4-03 | `GUMROAD_TOKEN` in global.json, not allowlisted | key dropped, loud log, other keys served |
| 4-04 | old client (no upgrade) | `cowork-env.json` appears in inputs; prompt line present |
| 4-05 | env API down at claim | task runs; warning logged; inputs copy present |
| 4-06 | malformed brain/<glob>.json | that scope skipped; global still served |

---

## Reality Checker findings (this pass, spec vs `c080a38`)

| # | Finding | Severity | Resolution |
|---|---|---|---|
| RC-1 | Design said `register_agent` brains payload is "free-form JSON already, backward-compatible". The zod schema (`mcp/server.ts:62-69`) is **closed** and `registerBrain` forwards only whitelisted fields — an `env` key would be silently stripped and the feature would no-op with no error. | High | Spec WF-3 STEP R2 now requires both the schema addition and the forward; TC 3-01 would catch a silent strip. |
| RC-2 | `attempt` indexes the raw chain (`dispatcher.ts:306-311`); naive filtering desyncs attempt/chainLen and silently skips rungs or mis-computes "exhausted". | High | WF-3 STEP D2 mandates filtering before indexing; TC 3-04 pins it. |
| RC-3 | `wait-input` tasks are held out of the pending pool (`store.ts:296-301`, `:314-319`), so a task parked by fail-closed routing would never recover when a qualifying brain joins. | Medium | WF-3 STEP D5: machine-generated packets (marked `requiresParked`) are auto-answered on qualifying registration; human packets never are. |
| RC-4 | Design's "dispatcher re-reads config-adjacent state per tick" was asserted, not verified; nothing hot-reloads `decisions/` today (nothing reads it at all). | Low | WF-2 STEP 7 specifies explicit mtime-cached reads; Assumption A3. |

## Assumptions

| # | Assumption | Verified? | Risk if wrong |
|---|---|---|---|
| A1 | Lesson JSONL lines stay < PIPE_BUF (4096B) after truncation caps | By construction (caps in WF-1 STEP 2) | interleaved lines on concurrent write — mitigated by single-process server anyway |
| A2 | Ledger stays small enough for per-event full scan (<50k lines) | Not verified — depends on task volume | slow ticks; remedy pre-noted (monthly rotation) |
| A3 | Per-tick `stat()` of 2–3 data files is negligible | Highly likely, not measured | none material |
| A4 | Dashboard renders interaction packets with `select` fields | Partially — packets render; `select` type support needs a UI check before WF-2 ships (fallback: text field listing options) | remedy menu degrades to free text |
| A5 | Inputs channel allows server-originated files (not only human-attached) | Not verified — `store.ts:488` suggests inputs are bound at create; claim-time injection may need a small store change | WF-4 STEP 3a needs an extra store method; size S |

## Build order (unchanged from design, now with spec references)

1. WF-1 (S) → 2. WF-3 Part R (S–M, includes RC-1 fix) → 3. WF-3 Parts T+D (M, RC-2/RC-3 fixes) → 4. WF-4 (M, resolve A5 first) → 5. WF-2 (M, check A4 first) → 6. optional LLM `LESSON:` line (XS).
Test files per house convention: `lessons.test.ts`, `dispatcher-requires.test.ts`, `env-store.test.ts`, `dispatcher-proposal.test.ts`.
