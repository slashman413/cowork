# Method: ops-change

Safely execute infrastructure, configuration, database, or service operations.

## Steps

1. Assess blast radius: identify callers, downstreams, consumers, and dependencies before touching systems.
2. Find the safety fact: identify the single fact safety depends on (idempotency, wire compatibility) and prove it with code.
3. Plan rollback: verify a deterministic rollback path exists before modifying state.
4. Execute idempotently: apply changes using operations that converge safely if interrupted or retried.
5. Verify health: inspect real process status, listening ports, health endpoints, and error logs post-change.

## Principles

- `make-operations-idempotent`: Operations converge to the correct state regardless of prior partial runs.
- `blast-radius`: Do not trust writeups; prove the one safety fact by executing real checks.
- `prove-it-works`: Verify actual running processes, sockets, and logs directly—never infer from exit codes alone.

## Evidence

- Blast-radius safety check output proving the safety fact.
- Pre- and post-change service health checks (status, port, curl).
- Verified rollback command or proof of idempotent re-run.
