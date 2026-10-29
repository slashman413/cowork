# Contributing to cowork (maintainers)

This file is for people and agents who **change cowork itself**. It is not
injected into task prompts. `CONVENTIONS.md` is, in full, on every dispatch, so
maintainer-only rules live here to keep the prompt short and to keep this rule
from changing agent behaviour by being in it.

## Verify before you commit

```bash
cd server && npm run build && npm test     # tsc + the node:test suite (tsx --test)
```

The suite uses `node:test`. `npx vitest run` executes the files but reports
"no tests", so use `npm test` for the pass/fail count.

Server changes only go live after a restart. Never `systemctl restart cowork-mcp`
from inside a task (it kills the task). Use:

```bash
systemd-run --user --collect --unit=cowork-redeploy-<id> deploy/redeploy-server-when-idle.sh
```

## Prompt changes need an eval run (P2-1)

An edit to any of the following **must cite an `eval-prompt-change` run id and
its Δ in the commit message**:

- `CONVENTIONS.md` (the operating rules injected into every task)
- the verifier prompts in `server/src/core/result-verifier.ts`
  (`buildVerifierPrompt`, the spec-verifier prompt)
- a top-10 persona: the 10 roster agents with the most done tasks in the inbox
  (`agency-agents/**/<slug>.md`)

Without a measurement, rule tweaks are guesses. The eval replays 5 historical
done tasks of the affected family under the new and the old text in sandboxes.
Then one blinded judge from another model family scores both sets on a fixed
rubric.

**Run it.** Variant A = your new text, variant B = the current text, so a
positive Δ means the change helps:

```bash
git show HEAD:CONVENTIONS.md > /tmp/conventions-old.md
# dashboard: Workflows → "Eval a prompt change", or:
curl -s --cacert ~/.cowork/tls/cert.pem -H "Authorization: Bearer $COWORK_API_KEY" \
  -X POST https://localhost:6868/api/workflows/eval-prompt-change/run -H 'Content-Type: application/json' \
  -d '{"params":{"family":"engineering","variantA":"CONVENTIONS.md","variantB":"/tmp/conventions-old.md"}}'
# or without the hub's scheduler (same code path):
cd server && node dist/eval-cli.js run --family engineering --a ../CONVENTIONS.md --b /tmp/conventions-old.md --out /tmp/eval-out
```

`family` is a division (`engineering`, `marketing`, …) or an agent slug. Pick
the family the change affects most. For a persona, that is the persona's own
slug. For `CONVENTIONS.md`, use the busiest division. The run writes
`eval-report.md` (per-task scores, Δ(A−B), the outward-action check) into the
judge step's artifacts.

**Cite it** in the commit message body:

```
eval-prompt-change <runId> Δ(A−B)=+1.4 n=5 (family engineering, judge local-agy-gemini-4-argon-medium)
```

**Read it honestly.** With n = 5, |Δ| < 2 (of 25) is noise. The rule asks you
to measure and cite, not to reach a threshold. A change with a negative Δ needs
a sentence in the commit explaining why it ships anyway. If the report's
outward-action check is not clean, find out what happened before you trust the
numbers.

**Exempt:** typo/format-only edits that change no instruction (say
`eval: exempt (typo)` in the commit), and edits to this file.

### How the sandbox works

Each replay runs on the family's executor brain (the first runnable local
brain of its chain) with the variant swapped in for `CONVENTIONS.md`. It gets
the original task text and brief, and a "SANDBOX REPLAY — do not perform
outward actions" banner plus a hard `scope.forbid` in the prompt. Its
environment has credentials and the hub key stripped. Git hooks refuse
commit/push. `ssh`/`gh`/`vercel`/`wrangler`/`systemctl`/`docker` shims log and
refuse. `curl` is limited to unauthenticated GET/HEAD. The harness snapshots
every workspace repo (HEAD, refs, `git status`) and the task list before and
after, and reports any difference. Network calls made from inside python/node
code are not intercepted. They would only show up as side effects in those
snapshots.
