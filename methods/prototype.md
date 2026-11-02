# Method: prototype

Build a throwaway instrument to make one design decision cheaply. The real build follows the feature method.

## Steps

1. Name the decision the prototype must settle. No decision means no prototype.
2. Gather references only when the design space is open.
3. Build in an isolated scratch directory with the lightest stack that renders the idea. No tests, no abstractions.
4. Put alternatives behind one switcher, each variant labeled.
5. Observe each variant on the matching surface: screenshots for visual choices, logged timing or output for behavior.
6. Present alternatives, tradeoffs, and one recommendation.

## Principles

- `exhaust-the-design-space`: Propose variants the requester did not ask for.
- Speed over polish; the rigor is in the comparison.

## Evidence

- The decision, the recommendation, and why.
- Path to the scratch prototype and per-variant screenshots or logs.
