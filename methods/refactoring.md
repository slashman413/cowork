# Method: refactoring

Change structure without changing behavior. New behavior is a feature; a corrected fault is a bug fix.

## Steps

1. Pin the contract first: a characterization test, snapshot, or equivalence harness. Type check and lint are not a pin.
2. Name the missing structure and the target shape; the reshape must delete branches or invalid states, not add indirection.
3. Subtract before you add: remove dead code, one-caller wrappers, and orphan references first.
4. Move in small behavior-preserving steps, each keeping the pin green. Migrate callers, then delete the legacy API.
5. Split out any real bug or missing feature you discover; ship the structural change first.

## Principles

- `subtract-before-you-add`, `model-the-domain`, `migrate-callers-then-delete-legacy-apis`.

## Evidence

- The pin test and its passing output before and after.
- Net line count and the list of deleted symbols.
