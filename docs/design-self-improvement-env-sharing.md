# Cowork: Task-Driven Self-Improvement + Shared Environment for Remote Brains

**Design report — workflow architecture** · repo audited at commit `c080a38`
· source: `~/workspace/github/slashman413/cowork` (server/src, deploy/remote-brain-client.mjs, PROTOCOL.md, CONVENTIONS.md)

---

## 0. Constraint restated

> "I don't want a cronjob-like Hermes Agent to make decisions of self-improvement and task automation."

So the design rule for everything below is:

- **Detection is deterministic** (event-driven, inside the existing task lifecycle — no scheduler, no autonomous agent loop).
- **Decisions are human-gated** (proposals surface through the mechanism cowork already has for exactly this: `wait-input` interaction packets).
- **Application is data, not code** (approved lessons become injected prompt text / routing metadata, the same way `CONVENTIONS.md` and agent personas are already injected — nothing self-modifies).

No cron. No agent that "wakes up and decides". The trigger for every improvement action is a *task finishing* — an event the server already handles.

---

## 1. What the repo already has (the raw material)

The good news: ~70% of the self-improvement loop already exists as disconnected pieces.

| Existing piece | Where | What it gives us |
|---|---|---|
| Deterministic result verifier | `server/src/core/result-verifier.ts` (fail patterns, min-length) | Machine-readable *failure reasons* per attempt |
| Optional LLM verifier | `dispatcher.ts` `llmVerdict` (config-gated) | Quality judgment: on-topic vs. refusal/off-topic |
| Failed-brain trail | `dispatcher.ts:811` `recordFailedBrain` → `task.context.failedBrains[{brain, agent, attempt, reason, at}]` | Per-task audit of *which brain failed, in order, why* |
| `wait-input` parking | `result-verifier.ts` `detectInputRequest` + dispatcher precedence gate | The **human-in-the-loop primitive** — a task that becomes a question is held for a person, never auto-scheduled |
| Fallback chains + handover | `dispatcher.ts` `chainFor`/`verifyReportedCompletion` | Automatic retry routing (already "improvement at runtime", just memoryless) |
| CONVENTIONS.md prompt injection | `remote-brain-client.mjs:46-49` + dispatcher prompt builder | A **rules file injected into every prompt** — the natural home for learned rules (rule #6, the Inc-6 credential-routing rule, was exactly this: an incident distilled into an injected rule, by hand) |
| Agent personas | `context.persona` stamped by dispatcher | Per-agent prompt layer → natural home for per-agent playbooks |
| `paths.decisions` (`decisions/`) | `config.ts:53`, created by `store.ts:46` | A directory that exists, is server-owned, and is **currently written by nothing** — free real estate for the lesson ledger |
| Per-task inputs channel | `inputs/<task-id>/` + client `downloadInputs()` | An existing server→brain file-push mechanism (reusable for env bundles) |
| Brains registry via handshake | `register_agent {brains:[{id, exec, model, host, location}]}` | The registration payload is already extensible — capability facts can ride it |

What's *missing* is: (a) memory across tasks — every failure is recorded on the task and then forgotten; the same misroute repeats (the operator's memory log shows ~10 recurring "task landed on a host without the needed files/creds → BLOCKED" incidents); and (b) any machine-readable notion of what a brain's *environment* can do — brains are only `{exec, model, host}`, so the router cannot know that `remote-ai-code-gen-cc-*` has no `/home/wayne`, no `~/.priv` credentials, no `xurl` token.

Those two gaps are the two designs below, and they interlock: **most "self-improvement" a task network needs is routing improvement, and routing improvement is impossible without environment facts.**

---

## 2. Design A — Task-driven self-improvement (no autonomous scheduler)

### A1. Lesson ledger (deterministic capture — always on, zero LLM)

Add one append-only file the server writes at the two moments a task teaches something:

```
decisions/lessons.jsonl        # server-owned, one JSON object per line
```

Written by the dispatcher (a ~30-line addition next to `recordFailedBrain`, `dispatcher.ts:811`):

1. **On verifier rejection** (both local runs and `verifyReportedCompletion`): record the failure signature.
2. **On `wait-input` parking**: record the question signature (a brain asking "which environment?" *is* an environment lesson).

```json
{"at":"2026-08-04T…","kind":"verify-fail","task":"9a188ca9","titleSlug":"content-workflow-integration",
 "agent":"workflow-architect","brain":"remote-ai-code-gen-cc-opus","attempt":1,
 "reason":"matched failure pattern \"…\"","requiresGuess":["path:/home/wayne"]}
```

`requiresGuess` is extracted deterministically: a small regex pass over the failure text / result for absolute paths, `command not found: X`, `ENOENT`, `permission denied`, credential-store names. No model call. This is pure event capture — nothing decides anything.

**Why JSONL in `decisions/`**: the dir already exists in config and store bootstrap; append-only survives crashes; trivially greppable; and it keeps lessons *out of* task context (task JSON is archived after 30 days — lessons must outlive tasks).

### A2. Recurrence detector → proposal task (deterministic trigger, human decision)

This is the replacement for the Hermes-cron pattern. Instead of a scheduled agent scanning for things to improve, the **trigger is the write itself**: every time the dispatcher appends a lesson, it runs a synchronous counter over the ledger:

```
same (titleSlug-family OR requiresGuess signature) AND same brain-family
seen ≥ N times (default 3) in the last M days (default 30)
AND no open/answered proposal already exists for this signature
→ create ONE task with status wait-input, addressed to the human
```

The proposal task's interaction packet *is* the decision UI (the dashboard already renders these):

> **Recurring failure detected** (7 occurrences since 2026-06-28):
> tasks matching *"AI Workflow Builder git-init"* fail on `remote-ai-code-gen-*` with `path:/home/wayne absent`.
> Proposed remedies — pick one:
> 1. Add routing rule: tasks tagged `requires: path:/home/wayne` never route to `remote-*` brains (auto-enforced once brains declare env facts — see Design B).
> 2. Append a rule to `CONVENTIONS.md` §6 naming this task family.
> 3. Add a per-agent playbook note for `workflow-architect`.
> 4. Dismiss (suppress this signature for 90 days).

Key properties satisfying the constraint:

- **No polling, no cron** — the check runs inline in an event handler that already runs on every task completion. Zero new processes.
- **The system never applies its own proposal.** The dispatcher can *detect* and *draft*; only a human answer to the `wait-input` packet applies anything. Cowork's existing lifecycle guarantees `wait-input` tasks are "deliberately held OUT of the pending pool — the orchestrator never schedules, routes, or reassigns" (PROTOCOL.md §2). The safety property is inherited, not new code.
- **Idempotent** — one open proposal per signature; duplicates are suppressed by the ledger check.

### A3. Applying an approved lesson (data, not code)

Three application surfaces, all already-injected prompt/config layers, in order of preference:

| Surface | Mechanism | When to use |
|---|---|---|
| **Routing metadata** | `decisions/routing-rules.json` — `{match: {requires|titlePattern|tags}, deny: [brainGlob], preferChain: [...]}`; consulted by `chainFor()`/`planFor()` before selecting a rung | Environment-shaped lessons (the majority). Structural fix — the failure becomes *impossible*, not just warned about |
| **`decisions/playbooks/<agent>.md`** | Injected into the prompt after the persona, same as `CONVENTIONS.md` is today (client `buildPrompt()` + dispatcher prompt builder each gain ~3 lines) | Behavioral lessons scoped to one agent ("always emit merge scripts as artifacts; wayne-host applies them") |
| **`CONVENTIONS.md` edit** | The proposal task's artifact contains the drafted diff; human applies via normal git flow | Network-wide rules (rare; keep this file short — it's prepended to *every* prompt) |

The first two are hot-reloaded data files — no rebuild, no restart, no self-modifying code. The dispatcher reads them fresh per tick (it already re-reads config-adjacent state per tick).

### A4. Optional: retro line from the LLM verifier (recall, not decide)

The config-gated LLM verifier (`buildVerifierPrompt`) already reads task + result. Extend its prompt by one line: after PASS/FAIL, optionally emit `LESSON: <one sentence>` when the attempt revealed an environment/process gap. Parsed lessons are **only appended to the ledger** (feeding A2's counter) — they are never injected into prompts and never acted on directly. This raises recall on failures the regexes can't classify, while keeping every *decision* human. Ship this last; the deterministic path alone covers the recurring incidents in the operator's history.

### A5. What NOT to build

- No "self-improvement agent" persona in the Agencies. An agent whose job is to improve the system recreates the Hermes-cron problem with extra steps.
- No auto-editing of CONVENTIONS.md / config.json by any brain (CONVENTIONS §2 already forbids it; keep it that way).
- No feedback loop where lessons alter *verifier* patterns automatically — a bad learned pattern would silently reject good work. Verifier pattern changes stay code-reviewed.

---

## 3. Design B — Sharing environment/variables among remote brains

Two distinct problems hide in "environment issues", and they need different mechanisms:

- **B-I: knowledge of environments** — the router doesn't know what each brain's host has, so tasks land where they cannot run (the dominant failure class in the incident history).
- **B-II: distribution of values** — non-secret config (URLs, slugs, repo paths, API endpoints) and secrets (tokens) that a correctly-routed brain still needs.

### B-I. Brain capability manifests (route right the first time)

Extend the registration handshake — the payload is free-form JSON already, so this is backward-compatible:

```json
{ "id": "remote-aicodegen-cc-fable", "exec": "claude", "model": "claude-fable-5",
  "host": "aicodegen", "location": "remote",
  "env": {
    "paths":   ["/home/maxchang/workspace/github/slashman413"],
    "tools":   ["git", "gh", "node20", "python3.12", "ffmpeg"],
    "secrets": [],
    "net":     ["github.com", "api.gumroad.com"],
    "traits":  ["linux-x86_64", "no-gpu"]
  } }
```

**Client side** (`remote-brain-client.mjs`): auto-detect exactly like the existing CLI auto-detect (`hasCli()` pattern, lines 68/80-99): `command -v` for tools, `test -d` for a configurable path list, names (never values) of files under `~/.priv/`. Optional `ENV_FACTS_FILE` for manual extras. ~40 lines.

**Server side**: store `env` on the brain record; dashboard Brains view shows it.

**Task side**: a task may declare needs — set by the creator, a workflow step template, or (fallback) the same deterministic extractor from A1 running over the *description* at create time:

```json
"context": { "requires": ["path:/home/wayne", "secret:gumroad", "tool:xurl"] }
```

**Routing**: in `planFor()`/`chainFor()` (dispatcher.ts:282-311), filter chain rungs to brains whose `env` satisfies `requires`; a brain with no `env` block is treated permissively (legacy behavior) except against `secret:*`/`path:` requirements, which fail closed. If **no** brain satisfies the requirement, the task goes straight to `wait-input` with a generated question — "No registered brain has `path:/home/wayne`. Attach the files, relax the requirement, or bring that host online" — instead of burning a fallback chain and producing another BLOCKED artifact.

This single change structurally eliminates the recurring misroute class (Gentle-Soul uploads, wayne-host repo tasks, credential jobs), and it *generalizes CONVENTIONS §6* from a prose rule one specific brain-family must remember into machine-enforced routing. It also composes with Design A: approved routing-rule lessons (A3) compile down to `requires`/deny entries.

### B-II. Shared variable store (values, scoped, non-secret by default)

Add a small server-owned KV, filesystem-based like everything else in cowork:

```
env-store/
  global.json                    # {"LINK_BASE":"https://slashmantools.us", "GUMROAD_SLUGS":"diwoc,vzalgb,…"}
  brain/<brain-glob>.json        # per-brain-family overrides
  task-type/<tag>.json           # e.g. task-type/social-publish.json
```

Delivery — reuse both existing channels, no new client protocol:

1. **Env injection**: at claim time the client fetches `GET /api/env/<task-id>` (server merges global → task-type → brain scope for *that* task) and spreads it into the child env in `runModel()` — one line next to the existing `COWORK_ARTIFACTS_DIR` injection (client line 185; local dispatcher spawn at dispatcher.ts:955 gets the same).
2. **File form**: the merged snapshot is *also* written as `cowork-env.json` into the existing `inputs/<task-id>/` flow, so brains that read attached inputs (they already do) see it without any client upgrade. This makes the feature work on day one with old clients.

Prompt note appended by `buildPrompt()`: *"Shared environment for this task is in `$COWORK_ENV`/`cowork-env.json` — use these values instead of guessing URLs, slugs, or paths."* (The "link_base guessed, brief math off" incident is exactly the failure this kills.)

**Secrets policy — deliberately conservative:**

- Default: the env store is for **non-secret** config only. Server refuses keys matching `/(TOKEN|SECRET|KEY|PASSWORD)/i` in `global.json` unless explicitly allow-listed.
- Real credentials keep the existing Inc-6 rule: route to the brain that already holds them (which B-I now enforces mechanically via `secret:<name>` requirements — the credential never moves; the *task* moves).
- If a secret genuinely must be shared across hosts, do it out-of-band with `sops`/`age` (encrypted file in a private repo; each brain host holds its own age key) — not through the task server, whose artifacts/inputs/results are all plaintext on disk and visible in the dashboard. Broadcasting tokens through a coordination server multiplies both blast radius and the number of hosts that can get an account banned; the operator's ban-safety rule argues for fewer credential holders, not more.
- Everything served from `env-store/` is logged: `{key-names, task, brain, at}` → `decisions/env-access.jsonl` (values never logged). That log also feeds A1's requires-extractor with ground truth about what tasks actually consume.

### B-III. Interlock summary

```
task created ──▶ requires extracted/declared
                     │
                     ▼
        router matches requires × brain env manifests ──▶ right host, or wait-input immediately
                     │
                     ▼
        claim: server merges env-store scopes ──▶ injected as process env + cowork-env.json input
                     │
                     ▼
        run → verifier → (fail/park?) ──▶ lessons.jsonl (deterministic append)
                     │                          │
                     ▼                          ▼ (≥N recurrences, inline check)
                   done                 wait-input PROPOSAL task → human approves
                                                │
                                                ▼
                              routing-rules.json / playbooks/<agent>.md / CONVENTIONS diff
                                        (data reloaded next tick — loop closed, human in it)
```

---

## 4. Implementation plan (incremental, each step independently shippable)

| # | Step | Touches | Size | Payoff |
|---|---|---|---|---|
| 1 | Lesson ledger (A1): append on verify-fail + wait-input, with regex `requiresGuess` | `dispatcher.ts` (+~60 loc), new `core/lessons.ts` | S | Memory across tasks; instrumentation for everything else |
| 2 | Env facts in handshake + Brains view (B-I client+server halves) | `remote-brain-client.mjs` (+~40), `roster.ts`/store, dashboard | S–M | Visibility: *why* a brain can't take a task becomes inspectable |
| 3 | `requires` routing filter + fail-closed → `wait-input` when unsatisfiable | `dispatcher.ts` `planFor`/`chainFor` (+~50) | M | Kills the recurring-misroute class outright |
| 4 | Env store + claim-time merge + `cowork-env.json` input + env injection | new `core/env-store.ts` (~120), api route, client (+~15) | M | No more guessed URLs/slugs; old clients covered via inputs channel |
| 5 | Recurrence detector → proposal `wait-input` task (A2) + `routing-rules.json` / playbook injection (A3) | `dispatcher.ts` (+~80), prompt builders (+~10) | M | The human-gated improvement loop, end to end |
| 6 | (Optional) LLM-verifier `LESSON:` line (A4) | `result-verifier.ts` (+~15) | XS | Recall boost; strictly additive |

Tests follow the house pattern (`dispatcher-*.test.ts` colocated): step 3 gets `dispatcher-requires.test.ts` (satisfiable / unsatisfiable / legacy-no-env cases), step 5 gets a recurrence-threshold + idempotency test.

## 5. Explicit answers to the two questions

**"How to automate self-improvement about given tasks, without a Hermes-cron making decisions?"**
Make improvement an *event-driven, human-gated* pipeline: the dispatcher (already in the path of every task completion) deterministically records failure/question signatures to a ledger; a recurrence threshold — checked inline at write time, never on a schedule — drafts a *proposal* as a `wait-input` task; a human's answer applies it as reloadable data (routing rules, per-agent playbooks, CONVENTIONS edits). The system detects and drafts; only the operator decides. Cowork's existing `wait-input` semantics guarantee proposals can never self-execute.

**"How to share environment/variables among remote brains so they won't be blocked?"**
Two layers. (1) Share *knowledge* of environments: brains declare auto-detected env manifests (paths/tools/secret-names/net) in the existing registration handshake, tasks declare `requires`, and the router matches them — so a task needing `/home/wayne` or a Gumroad token simply never lands on a host lacking it, and an unsatisfiable task parks on `wait-input` immediately with a precise question. (2) Share *values* for non-secret config through a scoped server-side env store, merged per task at claim time and delivered via process env plus the existing `inputs/` channel. Actual secrets deliberately do **not** travel through the task server — the task goes to the credential, enforced now by routing metadata instead of a prose rule.
