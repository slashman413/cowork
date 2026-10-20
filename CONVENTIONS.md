# Cowork Operating Rules

**Every agent and brain executing a cowork task must follow these rules.** They are
injected into your prompt at dispatch time — treat them as binding, not advisory.
They exist because agents share one repository and one task store: a file written to
the wrong place is at best noise and at worst someone else's data loss.

---

## 1. Where output goes

There is exactly **one** place for the files you produce:

```
$COWORK_ARTIFACTS_DIR      →  cowork/artifacts/<task-id>/
```

That variable is set for you on every run, and your working directory is already
that folder. So:

- **Write with relative paths.** `report.md`, `chart.png`, `data.csv` all land in the
  right place automatically.
- **Never write outside it** unless the task explicitly names a destination. Do not
  write into the repo root, `server/`, or anyone's home directory.
- Everything you leave there becomes a **downloadable artifact** on the task card.
- Your stdout becomes the task **result** (summary). Long output is truncated in the
  result — the full text is saved for you as `result.md`, so put the deliverable in
  the artifacts dir, not only in stdout.

**Do not create a "report".** There is no report store. `task.result` +
`artifacts/<task-id>/` is the complete record of a task.

## 2. You have full permissions

Agents have **full permissions**. Nothing here is off-limits:

- You **may** create, edit, or delete files anywhere in the repo.
- You **may** run any `git` commands, install dependencies, rebuild and restart
  services, and rebuild the cowork server itself.
- You **may** edit `config.json` and the live config at `~/.cowork/config.json`.

Use this power deliberately — you share one repo and one task store with other
agents, so think before you overwrite someone else's work — but you are not
prohibited from anything.

## 3. Runtime directories are owned by the server

| Path | Owner | You may |
|------|-------|---------|
| `artifacts/<task-id>/` | you, for your task | read + write |
| `inputs/<task-id>/` | the person who attached files | read only |
| `inbox/`, `.status/`, `workflow-runs/` | the server | never touch |

Files a person attached to your task are listed in your prompt and live in
`inputs/<task-id>/` — read them there; do not copy them around.

## 4. Finish honestly

- If you **cannot** do the task, say so plainly and say why. A refusal or an error is
  a legitimate result; a fabricated success is not.
- If you are **blocked on a decision only the user can make**, ask. End your output
  with your question(s). The verifier detects this and parks the task on
  `wait-input` for a human, instead of marking it done.
- Never emit a rate-limit / quota / "try again later" notice as if it were the
  deliverable — the verifier rejects those and hands the task to the next brain.
- Do not claim you created a file you did not create. The artifacts list is generated
  from what is actually on disk, so an invented filename is immediately visible.
- **End every result with a status footer** (`NEEDS_INPUT:` / `WAITING_ON_BACKGROUND:`
  still take precedence when they apply):
  ```
  STATUS: DONE | DONE_WITH_CONCERNS | BLOCKED
  EVIDENCE:
  - <command run / URL checked / file produced> → <observed result>
  CONCERNS: <only if DONE_WITH_CONCERNS>
  ```
  `BLOCKED` = cannot finish for a reason another brain would hit too (say why on the
  STATUS line); the task fails and is not retried. A claim without evidence is not done:

  | Claim | Required evidence |
  |---|---|
  | pushed | `git log origin/<branch>` shows the commit |
  | deployed | HTTP 200 from the live URL |
  | uploaded / published | the platform's id or URL |
  | agent / subtask completed | its diff or artifact — never its self-report |
  | tests pass | the runner's summary line |
  | measured X% / Nx | the command that measured it + the sample count |
  | file created | path + size |

**Rulings, not stalls.** Ask the user (`NEEDS_INPUT:`) only when the next step is:
(1) irreversible or destructive; (2) about security or credentials; (3) an
outward-facing publish/merge that norms say to confirm; or (4) every path forward is a
guess. Otherwise decide, keep going, and record each call in the result as
`RULING: <decision> — <why> — <cost if wrong>`. §5's GitHub archive/visibility/workflow
rule stays a hard stop.

**Progress ledger (`progress.md`).** Long or multi-step tasks keep
`artifacts/<task-id>/progress.md` updated after each step as `- [x] <step> — <evidence>`
lines. At T-5 min of your timebox, write `progress.md` and return partial results with
`WAITING_ON_BACKGROUND:` or `STATUS: BLOCKED`. On a re-run or handover, resume from
`# Prior progress — resume, do not redo` without redoing completed steps.

## 5. Stay inside your task

- One task, one deliverable. Do not spawn side quests, refactors, or "while I'm here"
  improvements that the brief did not ask for.
- Do not create new cowork tasks unless the brief asks you to decompose work.
- Do not install system packages or change machine state as a side effect.
- **Never archive, unarchive, delete, or change the visibility of a GitHub repo, and
  never disable a workflow**, unless the CEO explicitly approved that specific repo or
  workflow. These actions stop scheduled jobs. Propose them as action items with
  evidence (last commit, last workflow run, live Pages status, maintaining-overall
  status) and let the CEO decide. (Added 2026-10-05 after the daily GitHub review
  archived 66 repos without approval.)

## 6. Credential tasks MUST use a local brain (Inc 6 rule)

Any task that needs access to the **local filesystem** — especially credentials under
`~/.priv/` (Cloudflare, Gumroad, Twitter/X, YouTube, GitHub tokens, Mautic, NAS) or
any `/home/wayne/` path — must run on a **local brain** (`local-hermes-qwen3.8-27b`).

- **Remote brains on other machines (e.g. `remote-ai-code-gen-cc-opus-4-8`) cannot
  access `/home/wayne/`.** A credential task routed to one will fail or vanish.
  If you are a remote brain and the task requires `~/.priv/` or local files, do NOT
  fake it — report the routing error and stop (see rule 4).
- `remote-` in a brain id means a client claims the task, not always another
  machine: `remote-codex-*` runs on this host. Still pin credential tasks to the
  local brain above.
- When dispatching, pin the brain: `context: {"brain": "local-hermes-qwen3.8-27b"}`.
  Old ids (`local-ha-qwen3-8-27b`, …) still resolve, but use the canonical one.
- Full rule + incident history: `/home/wayne/.hermes/cowork-routing-rules.md`.

---

*Full protocol: [PROTOCOL.md](PROTOCOL.md). Joining as a remote brain:
[JOIN-AS-A-BRAIN.md](JOIN-AS-A-BRAIN.md).*
