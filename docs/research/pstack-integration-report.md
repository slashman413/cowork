# pstack integration report: update of 2026-11-03 (continuation run)

**Status: G1–G14 are all DONE. PR automation (auth, branch protection, bot approval, squash merge, read-back) is DONE and verified live on the local Forgejo.** Only the GitHub-side steps remain BLOCKED, because the user chose not to use `gh` for GitHub (§B). These defaults were applied: staged rollout P1→P3, squash merge, repo scope `slashman413/cowork` only, ALL skills exposed to Claude (the user overrode G8's 8-skill core), and shadow→enforce promotion gated on metrics.

The original investigation (sections 0–6) follows unchanged after this update.

## A. G1–G14 status

| ID | Status | Commit | What changed | Test (passing) |
|---|---|---|---|---|
| G1 | DONE | `6f63b55` | `loadConfig` deep-merges `PS_DEFAULTS` (methods, tiers, verifier.spec, verifier.panel, prAutomation); live values win. A `[pstack] …` status line is logged at boot. The live `~/.cowork/config.json` now has all five keys. Every other key is byte-identical; a backup is at `~/.cowork/backups/config.json.pre-pstack-20261103` | `server/src/config.test.ts`: "missing methods falls back to defaults (G1)" and "live values win" |
| G2 | DONE | `9e47379` | The dispatcher defers a task (≤60 s, `sharpenPending`) while its intake sharpen is in flight and acceptance is empty. `execute()` re-reads the task right before `buildPrompt` | `server/src/core/dispatcher-sharpen-race.test.ts` (3 tests, including a real `tick()`) |
| G3 | DONE | `a348ea2` | `technical-writing` added to `VENDORED_SKILL_MAP`, the config cards, and the sharpener playbook list | `methods.test.ts` |
| G4 | DONE | `a348ea2` | 7 new cards (`methods/{perf-issue,refactoring,prototype,runtime-forensics,eval,opening-a-pr,babysit}.md`, all ≤1.2 KB). `METHOD_PLAYBOOKS` is the single list of keys. The sharpener now drops unknown playbook keys | `methods.test.ts` (14 cards); `sharpener.test.ts` "rejects unknown keys" |
| G5 | DONE | `9e47379` | `context.review: none \| llm \| panel`. The panel runs the multi-family interrogate panel plus lead even without acceptance criteria, and enforces when requested explicitly. With `panel.judgmentTier` on, judgment-tier and PR tasks get the panel automatically | `review-panel.test.ts` (existing, passing), `dispatcher-panel-gate.test.ts` (5 tests) |
| G6 | DONE | `9e47379` | `context.arena: true \| n \| {runners, rubric}` creates N runner tasks from distinct model families plus a judge task. The parent becomes the synthesis step through `dependsOn` | `dispatcher-arena.test.ts` (4 tests, including a real `tick()` fan-out) |
| G7 | DONE | `6f92445` (wired in `9e47379`) | Unslop rule in `artifact-lint.ts` for `outputs/*.md` when the playbook is `content` or `technical-writing`. It warns only and never blocks | `artifact-lint.test.ts` "unslop rule" |
| G8 | DONE (override: ALL skills) | `39a5017` | `scripts/install-pstack-skills.sh` symlinks all 58 vendored skills into `~/.claude/skills`, rsyncs them to `~/.agents/skills`, and links `~/.hermes/skills`. `--check` exits 1 on any drift. Backup: `~/.cowork/backups/pstack-installed-skills-20261103.tgz` | `scripts/install-pstack-skills.sh --check` → "all 58 installed and identical"; acceptance diff loop is empty |
| G9 | DONE | `4cd5826` | Create form: **Method** select (`context.playbook`), **Review** select (none/LLM/panel/arena), and a **pstack skill** input with a datalist (`context.skill`), all filled from the new `GET /api/pstack`. `/pstack <name> <text>` works on `POST /api/inbox` and MCP `create_task`. The Chat page was retired on 2026-10-30, so the command is handled on the server for every create path | `playbooks.test.ts` (8 tests, including an HTTP create test) |
| G10 | DONE | `9e47379` | `context.skill: "<pstack skill>"`. Local brains are pointed at the vendored `SKILL.md`; remote brains get its first 1.2 KB inline | `methods.test.ts` "G10 …" (4 tests: local, remote, unsafe names, `buildPrompt` local and remote) |
| G11 | DONE (decision) | n/a | Every one of the 58 skills is now reachable through `context.skill`, `/pstack`, the Create form, or Claude's own skill list. Chat-UX skills (`bro`, `ketchup`, `ketchup-video`, `in-your-own-words`) and personal-tooling skills (`make-bot-ui`, `automate-me`) get no method card and no auto-trigger: they don't fit a batch hub | n/a |
| G12 | DONE (test-level) | existing | Phase close → `decisions.tsv` + a different-family `## Attention` review is covered end to end at dispatcher level by `goal-trail.test.ts` ("phase close logs the trail and creates a different-family Attention review"). No live LLM Goal was run in this timebox | `goal-trail.test.ts`, `goals.test.ts` |
| G13 | DONE | `39a5017` | Pin moved from `0c3333f` to `6c75f4e67546` (upstream HEAD, 18 commits newer; `vendor/pstack/PIN`). Installed copies equal the vendored ones | `diff -r` loop / `install-pstack-skills.sh --check` |
| G14 | DONE (config) | `a348ea2` | Sharpener and spec verifier stay in `shadow`. The existing shadow-review job promotes to `enforce` when false rejects are ≤10% (`maxFalseRejectRate: 0.1`) over at least 30 decisive verdicts (`minDecisiveVerdicts: 30`, set in both the template and the live config). Metrics: `/api/metrics/quality` | config in place |

Security follow-up: `88b9b13`. A PR URL that is merely quoted in a result (for example, copied from fetched content) no longer spawns a watcher. Only `PR_OPENED:` lines, or lines saying "opened/created", count. The watcher also checks the PR's label and branch through `gh` before acting.

## B. PR automation: implemented vs blocked

**Update (second continuation, 2026-11-03):** for security reasons the user chose not to use `gh` with GitHub, and allowed testing on the local Forgejo instead (`http://localhost:3001`, Forgejo 17.0.1). The full approve-and-merge loop now runs, and has been verified, on Forgejo. Only the GitHub-specific steps are still BLOCKED.

| Step | Status | Evidence |
|---|---|---|
| `orchestration.prAutomation` config block (default `mode: "shadow"`, repos, label, escalatePaths, mergeMethod squash, maxFixRounds 2, watchIntervalMin 10) | DONE (`6f63b55`) | `config.test.ts`; present in the live config |
| Dispatcher hook: a PR URL in a done result sets `context.prUrl`; an opened PR in scope spawns one recurring `[pr-watch]` task (`recurrence: minutes/10`), deduplicated | DONE (`9e47379`, `88b9b13`; Forgejo URLs in this run) | `pr-automation.test.ts`, `forgejo-shepherd.test.ts` "dispatcher hook: an opened Forgejo PR…" |
| Escalation-path filter and merge policy (`decidePrAction`) | DONE | `pr-automation.test.ts`; live: PR #2 (touches `deploy/`) → `NEEDS_HUMAN`, comment only, left open |
| **Server-side executor (the P2 prerequisite):** `core/forgejo-shepherd.ts` plus the CLI `server/src/cli/pr-shepherd.ts`. The pr-watch brain only reviews. Every forge write goes through this code, which checks the opt-in label, that the author is not the bot, CI status, `decidePrAction`, and that the verified head SHA matches the current head. After a merge it reads the PR back | DONE, **verified live** | `forgejo-shepherd.test.ts` (10 tests); live log `artifacts/df75cf56-…/forgejo-e2e.log` |
| P0 auth (Forgejo) | DONE | Users `cowork-author` (opens PRs) and `cowork-bot` (approves and merges); tokens in `~/.priv/forgejo-cowork-{author,bot}-token` (mode 600). The live config names the file, never the token |
| Branch protection on `main` | DONE on Forgejo | `pr-shepherd.ts --protect cowork/pr-sandbox` → `required_approvals:1`, `merge_whitelist:[cowork-bot]`, `dismiss_stale_approvals:true`. The author's direct merge → `HTTP 405 "User not allowed to merge PR"`; self-approval → `HTTP 422 "approve your own pull is not allowed"` |
| Bot identity (second approver) | DONE on Forgejo | `cowork-bot` is a separate user and owns the `cowork` org |
| Approve + squash merge + read-back | DONE, **verified live** | PR #4: FAIL verdict → fix comment only. PASS on head `d9dffba4e37e` → `performed: [approve, merge:squash, read-back:merged]`; the forge shows `merged:true, merged_by:cowork-bot, merge_commit_sha:45dad03a`. A PASS on a stale SHA → `wait: patch-id drift`, no writes |
| GitHub (`slashman413/cowork`): `gh` auth, branch protection, approve/merge | **BLOCKED (by choice)** | `gh auth status` → `The token in /home/maxchang/.config/gh/hosts.yml is invalid`; `gh pr list -R slashman413/cowork` → `HTTP 401: Bad credentials`. The user declined to use `gh` for GitHub, so this repo stays in `mode: shadow` and its watcher still describes the `gh` steps. Porting the shepherd to GitHub means adding a GitHub client next to `ForgejoClient`; `decidePrAction` and the CLI contract stay the same |

**Live config** (`~/.cowork/config.json`; backup `~/.cowork/backups/config.json.pre-forgejo-20261103`; every other key unchanged): `repos += cowork/pr-sandbox`, `repoModes: {"cowork/pr-sandbox": "merge"}`, `forges: [{kind: forgejo, baseUrl: http://localhost:3001, tokenFile: ~/.priv/forgejo-cowork-bot-token, botUser: cowork-bot}]`. The global `mode` stays `shadow`, so only the sandbox auto-merges. To promote another Forgejo repo, add it to `repos` and set its `repoModes` entry to `approve`, then later `merge`.

**Bugs found by the live run and fixed in this commit** (recorded in the e2e log):
1. The first PR (#1) was opened before protection existed, and the author's direct merge succeeded (HTTP 200). Lesson: run `--protect` before enabling a repo.
2. With an approvals whitelist, Forgejo dropped the org-owner bot from the list. Every approval was then non-official, and merges failed with "Does not have enough approvals". The rule now uses `enable_approvals_whitelist:false`; the merge whitelist plus Forgejo's ban on self-approval keep the guarantee.
3. A bot approval made under the old rule stayed `official:false`. The shepherd now re-approves unless the head has an official approval.
4. Security review findings, all fixed (`fix(pr-automation)` commit). (a) The changed-file list was read from a single page, so an escalation path on a later page could slip through. It now reads every page and escalates when it hits the page cap. (b) A rename that moves a file out of an escalation path now counts its old path too. (c) The reviewed diff was not tied to the verified SHA. `--diff` now prints `HEAD <sha>` and returns the diff only if the head didn't change while it was being read, and Forgejo's merge call is pinned with `head_commit_id`. Live re-run: PR #5 merged by `cowork-bot` (`749364e1`). Follow-up: pagination now stops only on an empty page, because the server may cap page size below the requested limit. **Residual risk, open:** an author with write access could push B and then force-push back to A in the milliseconds between `--diff`'s two reads (A-B-A). The diff is read from the mutable `pulls/{n}.diff`; a diff addressed by SHA through the compare web route returned 404 with token auth. Mitigations in place: the merge is pinned to `head_commit_id`, and `dismiss_stale_approvals` is on.

**Forgejo use:** a brain that opens a PR prints `PR_OPENED: http://localhost:3001/<owner>/<repo>/pulls/<n>`. The dispatcher spawns `[pr-watch]`, which runs:
`npx tsx server/src/cli/pr-shepherd.ts --pr <url> --status`, then `--diff` (the diff pinned to `HEAD <sha>`), reviews it, then runs
`npx tsx server/src/cli/pr-shepherd.ts --pr <url> --verdict PASS|PASS+NOTES|FAIL --verified-sha <head>`.
Exit codes: 0 = OK or done, 2 = needs a human (escalation), 3 = blocked, 1 = error.

## C. How to trigger pstack now

- **Dashboard → New task:** choose a Method (a playbook card), a Review (none / LLM / panel / arena), and optionally a pstack skill.
- **Any create path** (REST `POST /api/inbox`, MCP `create_task`, a recipe): start the title or brief with `/pstack <playbook|skill> <text>`.
- **Context fields:** `playbook`, `skill`, `review`, `arena`, `tier: "judgment"` (with `panel.judgmentTier`).
- **Automatic triggers:** the sharpener picks a playbook at intake (now validated against 14 keys); method cards marked `"on"` are injected; the unslop lint runs on content and technical-writing outputs; a PR opened in a result is watched.
- **Claude Code sessions:** all 58 pstack skills sit in `~/.claude/skills` and trigger by their own descriptions.

---

# pstack integration in cowork: status, triggers, gaps, and a PR auto-merge plan

*Investigated 2026-11-03 on `main` @ `54e8595`. Vendored pstack is pinned at `0c3333f`. This was a read-only investigation: no source code or config was changed.*

---

## 0. TL;DR

1. **Ported in code: 8 work items (PS-1 to PS-8), 2026-10-20 to 10-21.** PS-1 sharpener, PS-2 interrogate panel, PS-3 arena, PS-4 method cards, PS-5 rollup rule, PS-6 numeric-claim criterion, PS-7 goal decision trail and attention review, PS-8 unslop gates. **Only 4 of them still run in production.** PS-2's workflow gate, PS-3 arena, and PS-8 gates were deleted with the Workflows subsystem in `54e8595` on 2026-11-02. PS-2 survives only as an opt-in judgment-tier path inside the spec verifier.
2. **The live config disables most of what the repo template turns on.** The server reads `~/.cowork/config.json`, not the repo `config.json` (`server/src/config.ts:14`). The live file has **no** `orchestration.methods`, `orchestration.tiers`, `verifier.spec`, or `verifier.panel` keys. As a result:
   - **Method cards (PS-4) are never injected**, even `research-report`, which the template marks `on`.
   - **The spec verifier never judges sharpened acceptance criteria.** It falls back to the generic LLM verdict, which runs only for `high` and `urgent` priority tasks.
   - **The review panel (PS-2) is off.**
3. **The sharpener (PS-1) does run, through a code default** (`server/src/config.ts:155`). 21 of 87 tasks in `inbox/` carry `acceptanceSource: "sharpened"`. However, **the executor often never sees the sharpened brief**, because of a race: background sharpening at intake stamps `sharpenStartedAt`, and the dispatcher then skips its own pass (`server/src/core/sharpener.ts:86`) without waiting. **This task is a live example.** Its record holds 4 acceptance criteria and a `playbook: research-report`, but the prompt it ran with had no `# Acceptance criteria` section and no `# Method` section.
4. **pstack as a skill library:** all 56 skills are installed for **Hermes** (`~/.hermes/skills`) and for **Codex/Antigravity** (`~/.agents/skills`). For **Claude Code brains**, 53 of 56 were moved to `~/.claude/skills-parked/` on 2026-10-29 to save tokens. Only `recall`, `reflect`, and `tdd` stay active. Claude brains (`local-cc-*`) can't trigger pstack skills by description or by `/name`.
5. **Nothing in cowork maps a prompt keyword, slash command, or UI action to a pstack skill.** The only UI surface is a "sharpened" badge and an editable acceptance list (`server/public/js/app.js:1506`).
6. **PR automation:** pstack's `poteto-mode` ships a full babysit/ship toolchain (`watch-pr` with typed verdicts `READY`, `BLOCKER`, `WAITING`, `TIMEOUT`). None of it is wired. It also can't run on this host yet: `gh` returns **HTTP 401 Bad credentials**, and the `watch-pr` launcher needs **Bun**, which isn't installed. Section 5 gives a 5-phase plan.

---

## 1. Integration timeline (git evidence)

| Date | Commit | Item | What landed | Still live? |
|---|---|---|---|---|
| 10-20 | `a9d6e74` | P1-4 | Role → brain tiers, inspired by `setup-pstack` (`server/src/core/tiers.ts:2`) | Code yes. Live config has no `tiers` key, so tier lists are empty |
| 10-20 | `af98e35` | **PS-1** | Brief sharpener at intake, shadow mode | **Yes** (code default `enabled: true, mode: shadow`) |
| 10-20 | `619cbf9` | **PS-5, PS-6** | Orchestrator rollup rule. Numeric-claim verifier criterion | **Yes** (always-on code) |
| 10-20 | `5c5f0f5` | **PS-2** | interrogate-style multi-family panel + lead judgment buckets | Workflow gate **deleted**. Judgment-tier spec path kept but **off** |
| 10-20 | `e33ca23` | **PS-7** | Goal `decisions.tsv` trail, cross-family Attention review, figure-it-out planner rules | Code yes. **Never exercised:** `goals/` holds no `decisions.tsv` |
| 10-20 | `996e764` | **PS-8** | unslop criterion on public-content workflow gates | **Deleted** (workflow JSONs removed). `methods/content.md` remains |
| 10-20 | `f693004` | **PS-4** | Vendors pstack @`0c3333f`, 6 method cards, `scripts/sync-pstack.sh` | Code yes. **Inert live** (no `methods` key) |
| 10-21 | `ec8c20a` | **PS-3** | arena workflow primitive | **Deleted** in `54e8595` |
| 10-30 | `b9a1d6b`, `bca80e4` | — | Restored PS-1..8 after a branch mix-up. Fixed the sharpener blocking Create and double-dispatching | — |
| 11-02 | `54e8595` | — | "remove workflows page and subsystem" | Took PS-2 gates, PS-3, and PS-8 with it |

Tests for what remains pass: `npx tsx --test` over methods, goal-trail, sharpener, review-panel, dispatcher-rollup, and result-verifier gives **107 pass, 0 fail** (log: `../ps-tests.log`).

---

## 2. Coverage table: all 56 vendored skills

The **"Agent skill"** column shows where the skill file is installed for brains to discover by description:
- **H/A**: `~/.hermes/skills` and `~/.agents/skills` (Hermes, Codex, and Antigravity brains).
- **C**: `~/.claude/skills` (Claude Code brains).
- **parked**: in `~/.claude/skills-parked`, invisible to Claude.

All 56 are in H/A. Only `recall`, `reflect`, and `tdd` are in C.

The **Status** column uses these values:
- **ported**: re-implemented in server code.
- **card**: a cowork method card or principle bullet inside one.
- **removed**: was ported, then deleted with Workflows.
- **vendored only**: no server hook.

| # | Skill | Status | Where (cowork) | Plan ID | Agent skill |
|---|---|---|---|---|---|
| 1 | architect | vendored only | — | — | H/A, parked |
| 2 | arena | **removed** | was `workflows.ts` arena step (deleted `54e8595`) | PS-3 | H/A, parked |
| 3 | automate-me | vendored only | — | — | H/A, parked |
| 4 | benchmark-checklist | ported (partial) | numeric-claim criterion `server/src/core/result-verifier.ts:396` | PS-6 | H/A, parked |
| 5 | blast-radius | card | `ops-change` → `server/src/core/methods.ts:15`, `methods/ops-change.md:16` | PS-4 | H/A, parked |
| 6 | bro | vendored only | — | — | H/A, parked |
| 7 | correct | vendored only (cowork has its own `correct-loop.ts`, not derived from pstack) | — | — | H/A, parked |
| 8 | create-formal-verification-skill | vendored only. **Not installed anywhere** | — | — | none |
| 9 | create-verification-skill | vendored only | — | — | H/A, parked |
| 10 | figure-it-out | ported (planner rules) | `FIGURE_IT_OUT_RULES` `server/src/core/goals.ts:32` | PS-7 | H/A, parked |
| 11 | how | card | `investigation` → `server/src/core/methods.ts:10` | PS-4 | H/A, parked |
| 12 | interrogate | ported, **off** | `server/src/core/review-panel.ts:70` (reviewer), `server/src/core/review-panel.ts:89` (lead), hook `server/src/core/dispatcher.ts:1840` | PS-2 | H/A, parked |
| 13 | in-your-own-words | vendored only | — | — | H/A, parked |
| 14 | ketchup | vendored only | — | — | H/A (modified copy), parked |
| 15 | maintain-formal-verification-skill | vendored only. **Not installed anywhere** | — | — | none |
| 16 | maintain-verification-skill | vendored only | — | — | H/A, parked |
| 17 | make-bot-ui | vendored only | — | — | H/A, parked |
| 18 | no-comments | vendored only | — | — | H/A, parked |
| 19 | poteto-help | vendored only | — | — | H/A (modified), parked |
| 20 | poteto-mode | card (2 playbooks) + brief contract | `bug-fix`/`feature` → `server/src/core/methods.ts:11`. The `orchestrate` brief → `server/src/core/brief.ts:2`. **PR playbooks (babysit, shipping, opening-a-pr, autopilot) not wired** | PS-4, P0-3 | H/A, parked |
| 21 | principle-attack-the-premise | card bullet | `methods/investigation.md:17` | PS-4 | H/A, parked |
| 22 | principle-boundary-discipline | card bullet | `methods/feature.md:17` | PS-4 | H/A, parked |
| 23 | principle-build-the-lever | vendored only | — | — | H/A, parked |
| 24 | principle-encode-lessons-in-structure | vendored only | — | — | H/A, parked |
| 25 | principle-exhaust-the-design-space | vendored only | — | — | H/A, parked |
| 26 | principle-experience-first | vendored only | — | — | H/A, parked |
| 27 | principle-explain-the-number | card + ported | `research-report` → `server/src/core/methods.ts:13`. `NUMERIC_CLAIM_CRITERION` `server/src/core/result-verifier.ts:331` | PS-4, PS-6 | H/A, parked |
| 28 | principle-fix-root-causes | card bullet | `methods/bug-fix.md:15` | PS-4 | H/A, parked |
| 29 | principle-foundational-thinking | vendored only | — | — | H/A, parked |
| 30 | principle-guard-the-context-window | vendored only | — | — | H/A, parked |
| 31 | principle-laziness-protocol | vendored only | — | — | H/A, parked |
| 32 | principle-make-operations-idempotent | card bullet | `methods/ops-change.md:15` | PS-4 | H/A, parked |
| 33 | principle-migrate-callers-then-delete-legacy-apis | vendored only | — | — | H/A (modified), parked |
| 34 | principle-minimize-reader-load | card bullet | `methods/investigation.md:15`, `methods/research-report.md:17` | PS-4 | H/A, parked |
| 35 | principle-model-the-domain | card bullet | `methods/feature.md:15` | PS-4 | H/A, parked |
| 36 | principle-never-block-on-the-human | convention (text) | CONVENTIONS "Rulings, not stalls" (`CONVENTIONS.md:94`). No code hook | — | H/A, parked |
| 37 | principle-outcome-oriented-execution | vendored only | — | — | H/A, parked |
| 38 | principle-prove-it-works | card bullet + convention | `methods/bug-fix.md:17`, `methods/ops-change.md:17`. The EVIDENCE-table rule in CONVENTIONS §4 | PS-4 | H/A, parked |
| 39 | principle-redesign-from-first-principles | vendored only | — | — | H/A, parked |
| 40 | principle-separate-before-serializing-shared-state | vendored only | — | — | H/A, parked |
| 41 | principle-sequence-verifiable-units | card bullet | `methods/bug-fix.md:16`, `methods/feature.md:16` | PS-4 | H/A, parked |
| 42 | principle-subtract-before-you-add | vendored only | — | — | H/A, parked |
| 43 | principle-test-behavior-not-implementation | vendored only | — | — | H/A, parked |
| 44 | principle-type-system-discipline | vendored only | — | — | H/A (modified), parked |
| 45 | recall | vendored only (agent skill) | — | — | H/A, **C** |
| 46 | reflect | vendored only (agent skill) | — | — | H/A, **C** |
| 47 | setup-pstack | inspiration | tier model `server/src/core/tiers.ts:2` | P1-4 | H/A (modified), parked |
| 48 | sharpen | **ported, live (shadow)** | `server/src/core/sharpener.ts:93` prompt, `server/src/core/sharpener.ts:81` skip rules, intake `server/src/api/router.ts:126` and `server/src/mcp/server.ts:323`, dispatch fallback `server/src/core/dispatcher.ts:2407` | PS-1 | H/A (modified), parked |
| 49 | show-me-your-work | ported | `server/src/core/goal-trail.ts:53`, Attention review `server/src/core/goals.ts:671` | PS-7 | H/A, parked |
| 50 | swarm | ported (rollup rule only) | `server/src/core/result-verifier.ts:1147`, `server/src/core/dispatcher.ts:2129` | PS-5 | H/A (modified), parked |
| 51 | tdd | vendored only (agent skill) | — | — | H/A, **C** |
| 52 | teach | vendored only | — | — | H/A, parked |
| 53 | technical-writing | card, **orphan** | `methods/technical-writing.md:1` exists but is not in `VENDORED_SKILL_MAP` (`server/src/core/methods.ts:9`) or in config cards. 1 task already got `playbook: technical-writing` from the sharpener | PS-8 | H/A, parked |
| 54 | typescript-best-practices | vendored only | — | — | H/A (modified), parked |
| 55 | unslop | card. Gate **removed** | `content` → `server/src/core/methods.ts:14`, `methods/content.md:1`. Workflow gate deleted `54e8595` | PS-4, PS-8 | H/A, parked |
| 56 | why | vendored only | — | — | H/A, parked |

**Tally:**

| Status | Skills |
|---|---|
| Ported in code and live by default | 4 (sharpen, swarm-rollup, explain-the-number/benchmark numeric criterion, figure-it-out + show-me-your-work in goals) |
| Ported but off | 2 (interrogate, setup-pstack tiers) |
| Removed | 1 (arena), plus unslop's gate |
| Method card or bullet only | 14 |
| Vendored only | 35 |

---

## 3. How to use pstack in cowork today (trigger map)

### 3a. Automatic, server-side

| pstack feature | Trigger | Happens without user action? | Live today? | Source |
|---|---|---|---|---|
| **sharpen** | Any task created via the dashboard/REST (`POST` tasks) or the MCP `create_task`, unless it already has `context.acceptance`, has `context.sharpen:false`, has `tier:mechanical`, or is a gate/review/eval task | Yes | **Yes, shadow.** It writes `acceptance`/`verify`/`outsideCheck`/`playbook` into the task context. Executor visibility is subject to the race below. The judge doesn't enforce the criteria | `server/src/core/sharpener.ts:81`, `server/src/api/router.ts:126`, `server/src/mcp/server.ts:323` |
| sharpen (fallback) | Task reaches dispatch with no acceptance and **no** `sharpenStartedAt` | Yes | Yes | `server/src/core/dispatcher.ts:2407` |
| Method card (`# Method` section) | `context.playbook` ∈ {investigation, bug-fix, feature, research-report, content, ops-change}, **and** `orchestration.methods.enabled` **and** `cards[key]==='on'` | Yes, if the sharpener or a human sets `playbook` | **No.** The live config has no `methods` key, so `isMethodCardActive` returns false (`server/src/core/methods.ts:23`) | `server/src/core/dispatcher.ts:1387`, `server/src/core/methods.ts:49` |
| interrogate panel | `context.tier==='judgment'` **and** acceptance present **and** `verifier.spec.enabled` **and** `verifier.panel.judgmentTier` | Yes | **No** (all three config keys absent live) | `server/src/core/dispatcher.ts:1840` |
| Spec verifier on sharpened criteria | acceptance present **and** `verifier.spec.enabled` | Yes | **No.** It falls back to `llmVerdict`, which is gated to `high`/`urgent` | `server/src/core/dispatcher.ts:1765` |
| Rollup rule (swarm) | A result `STATUS: DONE` whose `context.dependsOn` has a FAILED task that the result doesn't name → forced to `DONE_WITH_CONCERNS` | Yes | **Yes** | `server/src/core/dispatcher.ts:2129` |
| Numeric-claim criterion | The result reports a measured %/×/ms, and an LLM or spec verifier runs | Yes | Yes, when a verifier runs | `server/src/core/result-verifier.ts:337` |
| figure-it-out planner rules | Every Goal "Achiever" planning prompt | Yes | Yes, but no Goals have run (`goals/` is empty) | `server/src/core/goals.ts:32` |
| show-me-your-work trail + Attention review | Goal phase tasks finish or phase closes. Opt-out: `orchestration.goalAttention:false` | Yes | Code is live, **never exercised** | `server/src/core/goal-trail.ts:53`, `server/src/core/goals.ts:671` |

### 3b. Manual: what a user can do right now

1. **Set the playbook yourself.** Put `"playbook": "bug-fix"` (or another card key) in the task's context JSON. It has no effect until `orchestration.methods` is copied into `~/.cowork/config.json` (see G1).
2. **Write your own acceptance criteria** in the Create dialog. Human criteria skip the sharpener and render as `# Acceptance criteria` in the prompt (`server/src/core/brief.ts:80`).
3. **Opt out of sharpening:** add `"sharpen": false` to the context.
4. **Invoke a pstack skill by name in the task text.** For example: "use the `interrogate` skill on this diff", or "/how does the dispatcher route remote brains".
   - This works **only** on Hermes, Codex, and Antigravity brains, whose skill homes contain pstack. Pin with `context.brain`, e.g. `local-hermes-*` or a `local-agy-*` brain.
   - On Claude brains, 53 of 56 skills are parked and won't resolve. Pointing the agent at the file explicitly works on any local brain: "Read `vendor/pstack/skills/interrogate/SKILL.md` and follow it."
5. **Description-matched auto-trigger inside the brain.** On Hermes, Codex, and Antigravity, phrases from a skill's `description:` cause the harness to load it, with no cowork involvement. Examples: "tear this apart", "stress test this code" → `interrogate`; "blast radius of X" → `blast-radius`; "how does X work" → `how`; "swarm this" → `swarm`.

### 3c. UX surfaces

- The task card and edit dialog show a **"sharpened"** badge next to generated criteria, and the criteria are editable (`server/public/js/app.js:1506`, `server/public/js/app.js:2501`).
- There is **no** playbook picker, slash-command palette, or "run with pstack skill X" control. **There is also no prompt-keyword router in cowork itself.**

### 3d. Runtime check: this task was the probe

**RULING:** I used this task as the runtime probe instead of submitting a new task through `create_task`. The cowork rules say not to create tasks unless the brief asks. The cost if wrong is low: this task exercised the same intake path.

| Probe | Result |
|---|---|
| Sharpen | ✅ ran. The task record has 4 `acceptance` items, 3 `verify` commands, `outsideCheck`, `playbook: research-report`, 6 `openChoices`, and `acceptanceSource: sharpened` |
| Brief delivered to executor | ❌ The dispatched prompt had only `# Timebox` and `# Context` (`{brain, sharpenStartedAt}`). There was no `# Acceptance criteria`. **Race confirmed.** |
| Method card | ❌ No `# Method` section, although `playbook=research-report`, which is `on` in the repo template |
| Review panel | ❌ Off (no `verifier.panel` live). Not a judgment-tier task anyway |
| Sharpener failure log | `decisions/lessons.jsonl` has 3 `sharpen-failed` entries (2× 60 s timeout, 1× exit 143) |

---

## 4. Gaps and the full-integration plan

### 4a. Gap list

| ID | Gap | Fix (hook point) | Test to add or extend |
|---|---|---|---|
| **G1** | Live `~/.cowork/config.json` lacks `methods`, `tiers`, `verifier.spec`, and `verifier.panel`. The repo template has them | Merge the template keys into the live config (keep existing keys). Better: have `loadConfig` deep-merge these keys from `defaultConfig` the way it does for `sharpener` (`server/src/config.ts:155`), and log which PS features are on at boot | `server/src/config.test.ts`: a missing `methods` key falls back to the defaults |
| **G2** | Race: background sharpen vs. dispatch. The executor misses the sharpened brief | In the dispatcher's claim path, if `sharpenStartedAt` is set and less than 60 s old and acceptance is still empty, defer the task one tick. Otherwise re-read the task right before `buildPrompt` | `dispatcher-sharpen-race.test.ts` |
| **G3** | `technical-writing` card is orphaned | Add to `VENDORED_SKILL_MAP` and to config `cards`. Add to the sharpener prompt's playbook list (`server/src/core/sharpener.ts:115`) | `methods.test.ts` |
| **G4** | Sharpener playbook vocabulary covers 6 keys. pstack `poteto-mode/playbooks/` has 23 | Add cards for `perf-issue`, `refactoring`, `prototype`, `runtime-forensics`, `eval`, `opening-a-pr`, and `babysit` (≤1.2 KB each). Extend the enum in the prompt | `methods.test.ts`, `sharpener.test.ts` (rejects unknown keys) |
| **G5** | interrogate panel only reachable for `tier:judgment` + spec; Workflow gates deleted | Re-home the panel as a **task-level gate**: `context.review: "panel"` (or auto on `tier: judgment` and on PR tasks) triggers `runPanel` after the executor finishes | `review-panel.test.ts` + `dispatcher-panel-gate.test.ts` |
| **G6** | arena removed with Workflows | Re-home as a **task fan-out**: `context.arena: {runners, rubric}` makes the dispatcher create N child tasks + a judge + a synthesis task, using the `dependsOn` and rollup machinery that already exists | `dispatcher-arena.test.ts` (port `workflows-arena.test.ts` from `ec8c20a`) |
| **G7** | unslop gate removed | Run unslop as an artifact-lint rule on `outputs/*.md` when `playbook ∈ {content, technical-writing}`, through the existing `artifact-lint.ts` | `artifact-lint.test.ts` |
| **G8** | Claude brains can't see pstack (53 parked) | Don't un-park everything; that would undo the token saving. Symlink a curated **8-skill core** into `~/.claude/skills`: interrogate, how, why, blast-radius, sharpen, show-me-your-work, swarm, unslop. The rest stay reachable through method-card "Optional reading" paths | Manual: `ls ~/.claude/skills`. Add a `skill-auditor` check |
| **G9** | No UX trigger | Dashboard: a "Method" dropdown (playbook keys) and a "Review: none / LLM / panel / arena" select in Create. Chat: `/pstack <skill> <text>` sets `context.playbook` or `context.skill` | UI smoke via the `run` skill |
| **G10** | `skill` in context isn't honored | New `context.skill: "<pstack-name>"`. For local brains, prepend "Read and follow `vendor/pstack/skills/<name>/SKILL.md`". For remote brains, inline the first 1.2 KB | `methods.test.ts` |
| **G11** | 35 skills are vendored only | Use them as optional reading through G10, or skip them. For example, `bro`, `ketchup`, and `in-your-own-words` are chat UX, a poor fit for a batch hub. `make-bot-ui` and `automate-me` are personal-tooling skills | — |
| **G12** | Goals (PS-7) never exercised | Run one small Goal end to end and confirm `goals/<id>/decisions.tsv` and the `## Attention` section | `goals.test.ts` exists. Add an e2e smoke |
| **G13** | Vendor pin `0c3333f` is 2+ weeks old. 7 installed copies diverge (marked "modified") | Re-run `scripts/sync-pstack.sh <new-sha>` and install from `vendor/` so installed copies equal vendored copies | `diff -r` check in CI |
| **G14** | Shadow → enforce never promoted | Use `/api/metrics/quality`. Promote the sharpener and spec verifier to `enforce` once false-reject is ≤10% over ≥30 tasks (the `maxFalseRejectRate` already exists in the template) | metrics |

### 4b. Recommended order

**Full integration = every skill reachable, the right ones automatic.**

| Phase | Items | Effort | Effect |
|---|---|---|---|
| **1. Make what's built actually run** | G1, G2, G3 | ~½ day | Unlocks PS-2, PS-4, and the spec verifier immediately. Highest value per line |
| **2. Restore lost primitives without Workflows** | G5, G6, G7 | 2–3 days | Panel, arena, and unslop as task-level options |
| **3. Reachability** | G8, G10, G9 | 1–2 days | Any pstack skill usable on any brain, by field, UI, or `/pstack` |
| **4. Vocabulary** | G4, G13 | 1 day | More playbooks. Fresh pin |
| **5. Promote** | G14, G12 | Continuous | Turn shadow features to enforce based on metrics |

---

## 5. Plan: automated PR approval and merge

### 5a. Building blocks already in `vendor/pstack/skills/poteto-mode/`

| Block | What it gives us |
|---|---|
| `playbooks/opening-a-pr.md` | PR format: Conventional-Commit title. Body sections Why / What changed / Scope / Blast Radius / Verification. Opened ready, not draft. Runs `interrogate` + `no-comments` before review |
| `playbooks/babysit.md` | Modes `drive`, `background`, `threads-only`, and `check`. Order: conflicts, then threads, then CI. One retry for flakes. Never mutates the stack. "Babysitting never authorizes merging" (step 9) |
| `references/bugbot-triage.md` | Every bot comment classified `fix` / `dismiss` / `ask`. Security, auth, data, and migration items always escalate |
| `playbooks/shipping.md` | Merge only on a **verdict from an agent that didn't write the code** (`PASS`, `PASS+NOTES`, `FAIL`). "Green CI and an approving bot review are not verdicts". `git patch-id` checks that a verdict still covers the head. `gh pr merge --squash`, then read back `state, mergedAt` |
| `playbooks/autopilot-full.md` | Owner-per-PR plus independent swarm verification. "Never give or bypass an approval the forge enforces" |
| `scripts/watch-pr/` | Typed watcher. Exit codes: `READY` 0, `BLOCKER` 2 (conflicts), 3 (threads), 4 (failing checks), 6 (merge gate), 7 (status query), `TIMEOUT` 5. Emits JSON. Uses `gh` via `node:child_process`. **Bun is needed only by `bootstrap.ts`** |

### 5b. Prerequisites (blocking today)

1. **`gh` auth is broken:** `gh pr list -R slashman413/cowork` returns `HTTP 401 Bad credentials`. Re-auth the account, or use a fine-grained token with `pull_requests:write`, `contents:write`, `checks:read`.
2. **Runtime for `watch-pr`.** Either install Bun, or run `npx tsx vendor/pstack/skills/poteto-mode/scripts/watch-pr/cli.ts …` after `npm i commander@14`. Only `bootstrap.ts` uses `Bun.spawnSync`.
3. **Branch protection on `main`:** require the `CI Pipeline / test` check (`.github/workflows/ci.yml`) and enable auto-merge.
4. **Second identity for approvals.** GitHub doesn't let a PR author approve their own PR. If agents push as `slashman413`, a bot account or GitHub App must give the approval. Per autopilot-full step 6, the bot must never bypass a required human review.

### 5c. Design: a `pr-shepherd` loop in cowork

```
agent task opens PR (opening-a-pr card)
        │  result contains PR URL  ──► dispatcher detects /github.com/.+/pull/\d+/
        ▼
[pr-watch] task (mechanical tier, cron 10 min)  ← watch-pr --pr N --status-only (JSON)
        │ BLOCKER 2 conflicts  → park; notify owner task "rebase needed" (never auto-rebase stacks)
        │ BLOCKER 3 threads    → [pr-triage] task: bugbot-triage rubric → fix | dismiss | ask(NEEDS_INPUT)
        │ BLOCKER 4 CI         → classify: flake → 1 rerun; same failure twice → [pr-fix] task to original brain
        │ WAITING              → re-arm next tick
        ▼ READY (CI green, no threads, mergeable)
[pr-verify] task — different model family than author (tiers.reviewChain), tier judgment:
        runs interrogate panel (G5) over the diff + runs the change (tests / run skill)
        → PASS | PASS+NOTES | FAIL  (records patch-id of head)
        ▼ PASS and policy allows
[pr-merge] (server-side, no LLM):
        re-check patch-id == verified patch-id; re-run watch-pr --status-only == READY
        gh pr review --approve (bot identity)  →  gh pr merge --squash --delete-branch
        read-back gh pr view --json state,mergedAt  → write evidence to task result
```

The **gating signals**, all required to merge:

1. CI checks green: watch-pr `ci-clean`.
2. `mergeStateStatus` allows the merge: no conflict, no branch-protection block.
3. Zero unresolved review threads. Each bot thread is triaged as `fix` (with a commit SHA) or `dismiss` (with a disproof).
4. An independent verifier `PASS` from a different family, whose `git patch-id` matches the current head.
5. The policy tier for the repo or path allows auto-merge (see 5d).
6. The PR touches nothing on the **escalation list**: auth, secrets, `~/.priv`, `deploy/`, `.github/workflows/`, `config.json`, migrations, or billing. These files always go to a human. This matches the bugbot-triage "Do not skip" boundaries and cowork §5.

**What happens on failure:**

| Failure | Action |
|---|---|
| Verifier `FAIL` | Findings go back to the author brain as a fix task (max 2 rounds). Then park on `wait-input` |
| Patch-id drift after verify | Re-verify with a single verifier, not a full panel |
| Merge command "succeeds" but read-back isn't merged | Mark `DONE_WITH_CONCERNS` and alert. Never retry blindly |
| A third rebase is needed | Hold and report (autopilot-full step 5) |

**Where it hooks into cowork:**

| Hook | What it does |
|---|---|
| A **recipe/cron** (`recurrence.ts`) | Runs `pr-watch` every 10 min over open PRs labelled `cowork-auto` |
| A **dispatcher post-result hook** | Spots PR URLs in results and adds them to the watch list (`context.prUrl`) |
| A **Goal** option | `goal.ship: true` makes the phase-close Judger wait for `pr-merge` evidence |
| New config block | `orchestration.prAutomation {enabled, mode: shadow\|approve\|merge, repos: [], escalatePaths: [], mergeMethod: "squash", maxFixRounds: 2}` |

### 5d. Rollout

| Phase | Mode | Gate to advance |
|---|---|---|
| P0 | Fix `gh` auth, install runtime, branch protection | `gh pr list` works. `watch-pr --status-only` prints JSON for a test PR |
| P1 | **shadow**: watch + verify, and post the verdict as a PR comment only | 2 weeks: verifier agreement with human merges ≥ 90%, false-PASS = 0 |
| P2 | **approve**: the bot approves on PASS. A human clicks merge | 20 PRs with no post-merge revert |
| P3 | **merge**: the bot merges `cowork-auto` PRs in `slashman413/cowork`, except escalation paths | Ongoing. Measure revert rate and time-to-merge |
| P4 | Other repos. GitLab (e.g. Kneron leipzig) needs a `glab`/MR-API adapter in place of `gh`. watch-pr is GitHub-only per babysit.md step 6 | Separate decision |

---

## 6. Open questions (your call; the plan above uses the defaults in brackets)

1. **Autonomy level for PR automation:** full auto-merge, bot-approve plus human merge, or comment-only? [Default: staged P1 → P3 as above.]
2. **Bot identity:** create a GitHub App or bot account for approvals, or keep merges human-approved because the author and approver would be the same account?
3. **Repo scope:** only `slashman413/cowork`, or also the GitLab/Kneron repos (that needs an MR adapter)?
4. **Merge strategy:** squash (pstack's default), merge, or rebase?
5. **Claude skill exposure:** accept about 3–5k extra tokens per call to restore the 8-skill pstack core to `~/.claude/skills` (G8)? This partly reverses the 2026-10-29 token-efficiency parking.
6. **Promote to enforce:** turn the sharpener and spec verifier from shadow to enforce now, or after G14's metrics?
7. **Apply G1 now?** Copying `methods`/`tiers`/`verifier.spec`/`verifier.panel` into the live `~/.cowork/config.json` is a one-line-per-key, reversible config change. I didn't make it because this task was scoped as an investigation.
