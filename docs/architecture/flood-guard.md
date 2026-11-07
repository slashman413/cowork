# Cowork: recurring-task flood guard (commit 2d32785)

## Problem
A recurring task works as a scheduler. On every due slot, `Store.releaseDueScheduled`
spawned a new one-shot run-child **without checking whether the previous cycle's run was
still queued**. When agents are short (saturated, rate-limited or cooling down), the runs
don't drain, so each slot added another identical `pending` copy. Those copies then ran
back to back on the same scarce agents. A second path did the same thing:
`autoRerunRateLimited` could re-queue an old failed cycle even after a newer cycle had
already spawned.

## Fix (all ON by default)
| Guard | Where | Behaviour |
|---|---|---|
| **Coalesce** | `store.releaseDueScheduled` | A scheduler has at most **one** run in flight. A run counts as in flight while it is pending, claimed, in progress, waiting for input, or deferred. If a slot fires during that time it is **skipped**: the scheduler re-arms to the next slot and records `context.skippedRuns`, `lastSkippedAt` and `lastSkipReason`, plus a log line. |
| **Backlog hold** | `store.releaseDueScheduled` | When **≥ 30** tasks are already `pending`, due schedulers are **held, not dropped**. Each stays due with `context.heldForBacklog` set, then spawns one run once the queue drains. Slots missed meanwhile are skipped, so no catch-up burst follows. Children spawned in the same tick count toward the limit. |
| **Collapse duplicates** | `store.collapseDuplicateScheduledRuns`, run every dispatcher tick | Cleans up duplicates that are already queued, including ones left over from before this fix. Per scheduler it keeps the in-flight run, or else the newest queued copy, and closes the others as `done` with a `SUPERSEDED:` result (badged as closed-unrun, not failed). A running copy is never touched. |
| **Stale re-run skip** | `dispatcher.autoRerunRateLimited` | A rate-limited failed run is not re-run once a newer cycle of its recurring task exists. Its auto re-run is turned off once (`autoRerunSkipped`), so it is not re-checked every tick. |

## Knobs (`~/.cowork/config.json` → `orchestration.scheduler`)
- `coalesceRuns: false` — restore the old overlapping behaviour fleet-wide
- `maxPendingBacklog: N` — hold threshold (default 30, `0` disables)
- per task: `context.allowOverlappingRuns: true` — this task may overlap (for example, a poller that needs every tick)

"Run now" on a scheduler still always spawns a run, because it is an explicit human action.

## Verification
- `src/core/store-flood-guard.test.ts`: 9/9 pass. Covers skip, the in-progress / wait-input / done cases, opt-outs, hold-then-release, the same-tick limit, collapse keeping the newest or in-flight copy, idempotence, and the superseded re-run check.
- Full server suite: 649/649 pass. One existing recipe test assumed overlapping cycles and was updated to finish cycle 1 first. `tsc --noEmit` is clean.
- Live inbox at fix time: 2 pending, 0 duplicate run-children, so there was nothing to clean up yet.
