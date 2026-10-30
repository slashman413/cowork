# Method: feature

Build new capabilities through domain-modeled design and small verifiable units.

## Steps

1. Model domain & invariants: understand existing subsystem flow and structure types before logic.
2. Decompose safely: identify blocking first steps, independent workstreams, and shared state splits.
3. Implement surgical diffs: use explicit domain models; avoid scattered booleans and speculative layers.
4. Verify on target surface: test behavior directly against acceptance criteria, covering edge cases.
5. Sequence units: build, verify, and commit each small unit before starting the next.

## Principles

- `model-the-domain`: Structure state as explicit data models and state machines over scattered flags.
- `sequence-verifiable-units`: Build one verifiable piece at a time; each change advances working code.
- `boundary-discipline`: Separate shared state before serializing; keep interface contracts tight.

## Evidence

- Test suite runner summary showing new tests and existing suites passing.
- Clean build and typecheck output.
- Deliverable artifact or diff demonstrating acceptance criteria are met.
