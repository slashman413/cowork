# Method: perf-issue

Fix performance problems by measuring, never by reading source and guessing.

## Steps

1. Baseline: capture a real trace or benchmark on the target surface before changing anything.
2. Hypothesize from the trace; try the cheapest mantra first: don't do it, don't repeat it, do less, do it later, do it concurrently, do it cheaper.
3. Fix one hypothesis at a time; re-measure after each attempt.
4. Compare artifacts numerically. "Inconclusive" or a wrong-surface number is not a pass.

## Principles

- `explain-the-number`: Every claimed speedup names the command, sample count, and variance.
- `sequence-verifiable-units`: Verify each attempt before trying the next.

## Evidence

- Baseline number, post-fix number, delta, sample count.
- Path to the trace or benchmark artifacts.
