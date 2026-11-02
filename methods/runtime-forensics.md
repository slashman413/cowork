# Method: runtime-forensics

Diagnose a live process by instrumenting it, not by theorizing from source. The deliverable is a cited diagnosis, not a fix.

## Steps

1. Capture a real signal: CPU profile for a spinning process, heap snapshot for a leak, trace for a visual glitch.
2. Reduce the artifact to the smoking gun: hot function, retainer chain, or loop firing without input.
3. Prove the mechanism cheaply (injected logging, live eval) before believing it.
4. Map the finding back to source: file, symbol, and the line that allocates or schedules.
5. Do not fix unless asked; hand over to bug-fix or perf-issue.

## Principles

- `guard-the-context-window`: Parse large artifacts in a sub-step; keep only the reduced finding.
- `prove-it-works`: A hypothesis is not a diagnosis until confirmed on the live process.

## Evidence

- Signal captured, reduced finding, proof of mechanism, `file:line`, artifact paths.
