# Goal display states

The words the goals page, `GET /api/goals` and the MCP `list_goals` tool use for what a goal
is doing. One derivation serves all three: `deriveDisplayState` in `server/src/core/goal-view.ts`.
`status` stays the stored lifecycle; a display state is computed on read and never stored.

| State | Means | Comes from | Primary action |
|---|---|---|---|
| Needs you | Waiting on a person | Open `wait-input` task; budget used up; a block the Achiever or an operator declared | Answer the task, Raise budget, or Retry now |
| Stuck | Will not clear by itself | Repeated failed turns (3 or more blocks), or no phase left to work on | Retry now, or Plan a phase |
| Running | Work is executing or queued | A generated task is claimed, in progress, or runnable | none |
| Thinking | The Achiever's turn | No open work; a turn is in flight or due | none |
| Auditing | The Judger is reviewing | Phase `completing`, or its Judger task is open | none |
| Retrying | A transient fault, will recover | Rate limit, or a first failed turn | Retry now |
| Sleeping | Waiting on purpose | Only future scheduled tasks are open | none |
| Draft, Paused, Achieved | As stored | `status` | Activate or Resume, except Achieved |

Block causes are stored as a code (`rate_limit`, `achiever_no_progress`, `budget_exhausted`,
`token_budget`, `achiever_declared`, `operator`). Older records have the code derived from their text.

## Controls

`orchestration.goals` in the config:

- `achieverMode`: `toolless` (default) or `legacy`. `legacy` restores the previous prompt and argv.
- `autoMemoryAB`: half of goal execution tasks run with auto-memory off. The arm is in `context.usageArm`.
- `judgerDigestAB`: half of Judgers get an evidence digest and length caps. The arm is in `context.usageArm`.

`scripts/goals-token-baseline.py` reports the arms and gives a verdict once they have enough runs.

## Where the record lives

- `goals/<id>.json`: core record with a coalesced tail of at most 20 history rows.
- `goals/<id>/history.jsonl`: every audit row, append-only.
- `goals/<id>/achiever-turns.jsonl`: one row per Achiever turn, with usage, and the raw reply on a failure.
- Attention text lives only in its artifact; the phase keeps a pointer and a flag count.
