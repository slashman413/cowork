# Rule → what enforces it

Maintainers' table for [`CONVENTIONS.md`](../CONVENTIONS.md) (plan item P2-2,
"encode lessons in structure"). CONVENTIONS.md is injected **in full** into every
dispatched prompt, so this table lives here to keep that text short.

Each row is one rule from CONVENTIONS.md and the mechanism that makes it true
without the agent's cooperation. **Unenforced** means the rule is prose only:
compliance depends on the agent reading and obeying it. The monthly correct-loop
task (`GET /api/lessons/classes?days=30`) proposes structural fixes for recurring
lesson classes and updates this table. The goal is fewer **Unenforced** rows each month.

Levels: **Enforced** = a code path blocks or corrects the violation ·
**Partial** = detected/measured or covers only some cases · **Unenforced** = prose only.

| § | Rule | Enforced by | Level |
|---|------|-------------|-------|
| 1 | Write output to `$COWORK_ARTIFACTS_DIR` | Dispatcher sets the env var and spawns local brains with `cwd` = the artifacts dir (`dispatcher.ts` runTask). Nothing stops a write elsewhere. | Partial |
| 1 | stdout is the result; long output goes to `result.md` | Dispatcher saves the full output to `artifacts/<id>/result.md` and truncates `task.result` | Enforced |
| 1 | No separate "report" store | No report endpoint/store exists (structural) | Enforced |
| 2 | Full permissions, used deliberately | A grant, not a constraint. Nothing checks "deliberately". | n/a |
| 3 | `inputs/<id>/` is read-only | Nothing checks it (no chmod, no write check) | **Unenforced** |
| 3 | Never touch `inbox/`, `.status/`, `workflow-runs/` | Nothing checks it | **Unenforced** |
| 4 | Say plainly when you can't do the task; no fabricated success | Result verifier: deterministic checks + LLM gate (`result-verifier.ts`); spec verifier P1-1 in **shadow** (flags but does not reject) | Partial |
| 4 | `NEEDS_INPUT:` parks on wait-input | `detectInputRequest` → `store.parkForInput`; ADR-009 auto-answer then answers non-human-only questions | Enforced |
| 4 | Never return a rate-limit / quota notice as the deliverable | `DEFAULT_FAIL_PATTERNS` + `isRateLimitFailure` reject and hand over; the Store brain cooldown (`Store.noteBrainRateLimited` / `brainCooldownUntil`, decided from CLI signals; it replaced the P0-1 `brain-cooldown.ts` breaker) stops re-dispatch to the limited brain | Enforced |
| 4 | Don't claim files you didn't create | The task card lists artifacts from disk, so a claimed file that doesn't exist is visible. Nothing compares the claims to the listing. | Partial |
| 4 | End with `STATUS:` / `EVIDENCE:` footer | `parseStatusFooter`: BLOCKED → failed with no handover; DONE_WITH_CONCERNS is flagged; a missing footer is only **measured** (`context.hasEvidence`, `/api/metrics/quality` EVIDENCE %), never rejected | Partial |
| 4 | Evidence table (pushed / deployed / tests pass …) | P1-1 spec verifier checks claims against evidence. It runs in **shadow** mode (`verifier.spec.mode`), so it records lessons but does not reject. | Partial |
| 4 | `WAITING_ON_BACKGROUND:` defers instead of closing | `detectBackgroundWait` → `store.deferForBackground` re-runs later | Enforced |
| 4 | Rulings, not stalls (`RULING:` lines) | Rulings parsed into `context.rulings` (P0-4) and aggregated into `decisions/rulings.tsv` (P2-3, `GET /api/rulings`). ADR-009 auto-answer resolves permission-type wait-inputs. Permission-type stalls are measured (`waitInput.permissionChoice`). | Partial |
| 4 | Keep `progress.md`; return partial results at T-5 min | P1-3: timebox injected into the brief; on re-run or handover the dispatcher injects `progress.md` as "Prior progress". Nothing forces the agent to write it. | Partial |
| 5 | One task, one deliverable; no side quests | P0-3 brief `scope` / `acceptance` injected; spec verifier (shadow) judges scope | Partial |
| 5 | Don't create cowork tasks unless the brief asks | Nothing checks it (task-create API has no parent/brief gate) | **Unenforced** |
| 5 | Don't install system packages / change machine state | Nothing checks it | **Unenforced** |
| 5 | Never archive / unarchive / delete / change visibility of a GitHub repo or disable a workflow without CEO approval | Nothing in cowork checks it (prose + incident note only) | **Unenforced** |
| 6 | Credential / local-filesystem tasks run on `local-hermes-qwen3.8-27b` | WF-3 brain `env` manifests are recorded (`registerBrain`), but the router-side `requires` filter is **not wired** yet. Only a manual `context.brain` pin works. | **Unenforced** |
| 6 | A remote brain without access reports a routing error, not a fake result | Result verifier + spec verifier (shadow) | Partial |

**Count (2026-10-20):** 21 rules: 5 Enforced, 9 Partial, 6 Unenforced (§3 ×2,
§5 ×3, §6 routing), 1 n/a. The strongest structural candidates for these are already
on the correct-loop menu: the `env-requires` filter for §6, and a router rule or
workflow gate for the §5 GitHub actions.

## How a new rule gets enforced

The remedy menu in `server/src/core/correct-loop.ts` is ordered structure first:

1. **router rule**: `orchestration.agentChains` / `divisionChains`
2. **brain cooldown**: Store cooldown (`Store.noteBrainRateLimited`) + `orchestration.autoRerunRateLimited`
3. **brain `env` requires-filter** (WF-3)
4. **verifier failPattern**: `orchestration.verifier.failPatterns`
5. **workflow gate**: `workflows/*.json` step `gate` (P1-2)
6. **acceptance criterion**: brief `acceptance` / `scope` (P0-3)
7. **CONVENTIONS.md prose note**: last resort, and it must pass the
   `eval-prompt-change` A/B harness (P2-1)

A structural option is proposed only when its check, replayed over past
`lessons.jsonl` events, would have caught ≥2 of them. Those events are cited.
When you add a remedy, update its row here.
