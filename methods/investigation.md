# Method: investigation

Read-only codebase or architectural investigation. Produces cited explanations or recommendations, not code changes.

## Steps

1. Assess scope: for narrow questions, explore directly; for cross-cutting subsystems, trace 2-4 distinct structural angles.
2. Trace real paths: read source files directly; do not guess from names.
3. Map the mechanism: document key concepts, data flow, state ownership, and failure boundaries.
4. Synthesize: structure as Overview, Key Concepts, How It Works, Where Things Live, and Gotchas.
5. Ground claims: cite exact `file:line` locations. Push back if the premise is wrong.

## Principles

- `minimize-reader-load`: High compression; count layers between question and answer rather than annotating raw code.
- `prove-it-works`: Base findings on inspected source and execution, never assumptions.
- `attack-the-premise`: Question invalid premises before proposing solutions.

## Evidence

- Exact `file:line` citations for all referenced components and code paths.
- Concrete trace of runtime data flow or execution sequence.
- Tradeoffs table if comparing architectural alternatives.
