# Method: babysit

Drive an open pull request to merge-ready, one blocker at a time. Babysitting never authorizes merging.

## Steps

1. Declare a mode before polling: drive, background, threads-only, or check (default drive; small PRs get check).
2. Work only the lowest unmerged PR in a stack.
3. Order: merge conflicts, then review threads, then CI.
4. Triage each bot comment as fix (with commit SHA), dismiss (with disproof), or ask. Security, auth, data, and migration items always escalate to a human.
5. Retry a flaky check once; the same failure twice is real.
6. Never rebase, retarget, or force-push the stack from inside babysit.

## Principles

- `never-block-on-the-human`: Batch questions; keep clearing what you can.
- Stop where the human's call begins: merging belongs to the shipping step.

## Evidence

- Final PR state: checks, unresolved threads, mergeable status.
- Per-thread triage table.
