# Method: bug-fix

Fix bugs by isolating root causes through runtime evidence and verifiable reproduction.

## Steps

1. Reproduce first: establish a deterministic repro (failing test or script) before editing code.
2. Binary-search cause: trace invalid state back to where it first arose; do not patch the symptom.
3. Plan minimal fix: ship only what runtime evidence justifies; no speculative additions.
4. Verify on target surface: verify the failing repro now passes and existing test suites stay green.
5. Sequence delivery: stage the failing repro first in git history, then the fix on top.

## Principles

- `fix-root-causes`: Fix the fault at its origin, not where it surfaced. A guard is only a fix if the state is legitimate.
- `sequence-verifiable-units`: Land failing repro before fix; each unit ends in a verifiable state.
- `prove-it-works`: Prove bug absence on the real surface, not by proxy or "it compiles".

## Evidence

- Failing repro output (before) and passing output (after).
- Test suite summary showing no regressions.
- Root cause citation naming the exact originating fault and `file:line`.
