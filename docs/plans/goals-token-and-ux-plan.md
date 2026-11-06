# Goals: token efficiency and UX plan

**Status:** implemented 2026-11-06 except the time-gated checks (one week live, phase 3 arms). See task 0b0c378e. **Date:** 2026-11-06. **Code baseline:** `main` @ `716339f`.
**Evidence:** scripts, raw output, and screenshots are in `artifacts/b5867526-b135-42b2-b8bd-f2296ab903ef/`.

## 1. Bottom line

1. **Goal tokens go to execution tasks, not to the goal loop.** Of 57.0M tokens measured across goal work, execution tasks used 82%, Judgers 15%, Achiever turns 2%, and Attention reviews 1%. A plan that only shrinks the Achiever prompt would save under 1%.
2. **Nothing records goal tokens today.** Every number here came from reading transcripts by hand. Telemetry comes first, because every later claim depends on it.
3. **The Achiever loop has four bugs that waste turns and stall goals.** It never receives the Judger's minutes, only a relative path, so it ran `find /` to locate them. It treats a rate-limit message as bad JSON. It never falls through its brain chain. It also throws away the reason a move was rejected. One goal blocked 14 times in 23 hours over a single rate limit.
4. **The page hides the state the CEO needs most.** Three "active" goals are actually asleep until 11-14, 11-15, and 12-18, and the page does not say so. Budget use is not shown. A rate-limit pause looks the same as a real blocker. `Raise the budget` is the suggested fix, but the page has no edit control.
5. **Recommendation:** ship in six phases: measure, fix the loop, compact the schema, cut execution context, restructure the page, then finish the flows. Each phase has a numeric gate and a flag or revert path.

Expected result, to be proven in phases 0 to 3:

| Metric | Today | Target | Confidence |
|---|---|---|---|
| Goal tasks with recorded token usage | 0% | 100% of metered brains | High |
| Achiever first-turn context | 26.5k to 28.8k tokens | ≤ 6k | High, measured |
| Failed Achiever turns during a known rate limit | 24 of 32 sessions | 0 | High |
| `GET /api/goals` size | 90 KB | ≤ 3 KB (summary view) | High, prototyped |
| Weighted tokens per execution task | Baseline in phase 0 | −15% | Medium, a hypothesis |
| First goal's top edge, 390 px wide | 880 px | ≤ 180 px | High |

## 2. Question, criteria, and what would refute this

**Question:** which changes reduce the tokens goals use, and make the goals page answer "what needs me, and what happens next?" at a glance, without weakening goal quality?

**Hypothesis:** most savings come from execution context and failed turns, and most UX gains come from a truthful derived status and a list and detail split.

**Decision criteria:** measured token reduction, no drop in verification pass rate, and fewer page interactions to reach a decision.

**This plan is wrong if any of these hold:**

- Phase 0 telemetry shows execution tasks under 50% of goal tokens once non-Claude brains are counted.
- The tool-less Achiever disagrees with the current Achiever on more than 15% of replayed decisions, or makes any unsupported `met:true`.
- Turning off auto-memory lowers the first-pass verification rate by more than 5 points.

## 3. Current state, measured

### 3.1 Where the tokens go

Sample: every goal-generated task in `inbox/` with a Claude transcript. That is 34 of 52 tasks, plus 32 Achiever sessions. The other 18 tasks ran on non-Claude brains and have no usage data, so Attention is undercounted (1 of 7 metered).

Source: `scripts/measure_usage.py`.

| Role | Runs | Messages, median | First-turn context, median | All tokens incl. cache | Share |
|---|---:|---:|---:|---:|---:|
| Execution | 26 | 16 | 36,028 | 46.74M | 82% |
| Judger | 7 | 17 | 35,137 | 8.45M | 15% |
| Achiever | 32 (8 real) | 2.5 (real turns) | 26.5k to 65.9k | 1.30M | 2% |
| Attention | 1 | 9 | 36,528 | 0.49M | 1% |

**Why execution dominates.** Since the lean profile landed on 10-27 (15 execution tasks), the median task starts at 34.8k tokens and sends 15 messages. Each message re-reads the context, so the starting context makes up 43% of cumulative input.

| Execution tasks since 10-27 | Tokens | Assumed weight | Weighted | Share |
|---|---:|---:|---:|---:|
| Cache reads | 24.73M | 0.1× | 2.47M | 40% |
| Cache writes | 1.26M | 1.25× | 1.57M | 25% |
| Output | 0.42M | 5× | 2.12M | 34% |

The weights are the usual Anthropic price ratios, an assumption to check against current pricing. No dollar figures are claimed.

**What limits further gains.** The other 57% of cumulative input is what the task adds as it runs: tool output and the agent's own messages. Tool results total 1.92M characters across 20 tasks, 78% from Bash. Results over 20k characters are only 10% of that, so capping large outputs would save little.

Peak context has a median of 79.6k tokens. Two of 20 tasks passed the 150k "smart zone" that Matt Pocock's skills warn about.

### 3.2 What a run loads before the task says anything

First-turn tokens for `claude -p "Reply with the single word OK."` on Haiku, two runs per variant. The two runs matched exactly in every variant, so run-to-run noise was 0 on this sample. Opus may differ slightly. Source: `scripts/bootstrap_matrix.py`.

| Variant | Tokens | Change |
|---|---:|---|
| A. Task run today (lean, cowork + firecrawl) | 28,188 | baseline |
| B. A with `--tools Bash,Read,Write,Edit,Grep,Glob` | 36,260 | **+8,072, so do not use it** |
| C. A with auto-memory off | 20,545 | −7,643 |
| E. Achiever today (lean, no MCP, cwd `server/`) | 26,933 | baseline |
| F. E with `--tools ''` | 14,391 | −12,542 |
| G. F with auto-memory off | 6,748 | −7,643 |
| H. G in an empty cwd (no project `CLAUDE.md`) | 2,890 | −3,858 |

Result B refuted my starting assumption. A named tool list costs more than the default set, most likely because the named tools load full schemas instead of deferred ones. That idea is dropped.

The Achiever's prompt is about 2.9k tokens (cl100k estimate), of which 1.1k is a fixed tail. The other 27k is environment it does not use. Prompt caching will not help: real turns are hours apart, so a cache entry has expired before the next turn.

### 3.3 The Achiever loop wastes turns

| Finding | Evidence | Effect |
|---|---|---|
| The prompt sends the minutes **path**, then says "the minutes above" | `server/src/core/goals.ts:482` sets `latestMinutes` to `minutes[...].artifact`; `server/src/core/dispatcher.ts:1085` prints it | 8 of the 13 Bash calls in real turns were for that file, several using `find / -path ...`. The instruction to act on the Judger depends on the agent finding it |
| Rate-limit text counts as unparseable JSON | 24 of 32 sessions were `<synthetic>` "You've hit your weekly limit". They used 0 tokens but each counted as a failure | `goal-6710dc94`: 14 blocks in 23 hours, 10-21 08:22 to 10-22 07:19 UTC |
| Only the first local brain in the chain is tried | `execForChain` returns one brain; `askExecutor` has no fallback or cooldown check, while `store.brainCooldownUntil` and `isRateLimitFailure` already exist | The goal's second brain, local Qwen, was never tried |
| Half-open probes pay for a full turn | 3 Opus `block` turns on 10-22 and 10-23, about 65.8k tokens of context each (before the lean profile), each confirming the same expired LINE login | About 197k tokens of context for one repeated answer. The same turn would start near 27k today |
| The reason for a rejected move is lost | Logs on 11-06: `emit rejected — no workable phase`, then more failed turns | `goal-39dbfa70` has 3 of 3 phases audited, a criterion not yet marked met, and no phase to work on. It has blocked 10 times since 11-05 and is still looping |
| Raw Achiever output is discarded on failure | The log only says "timeout or unparseable JSON" | The cause on `goal-39dbfa70` (default router brain) **cannot be determined today** |
| `emit` cannot set `tier`, `acceptance`, or `verify` | No goal task carries `tier`; 22 of 52 tasks went through the sharpener, 22 got a spec verdict | Extra LLM calls per task, and 22 of 34 execution tasks ran on Opus |
| Full Bash on text from untrusted sources | The prompt embeds task results, and the Achiever runs with `--dangerously-skip-permissions` | The judge path already avoids this with `--tools ''` (`server/src/core/dispatcher.ts:1796`) |

### 3.4 Payloads and schema

| Item | Size | Main contents |
|---|---:|---|
| `GET /api/goals` | 90,258 B, ~28.7k tokens | `phases` 42 KB, of which `attention` is 34 KB; `history` 38 KB |
| `GET /api/goals/templates` | 26,098 B | Fetched on every render, even with the form closed |
| One goal's `history` | 24 KB (`goal-6710dc94`) | 34 of 43 rows are block/resume pairs, about 560 characters each, mostly the same text |
| Compact summary, prototyped | 2,369 chars, ~695 tokens | `scripts/ux_probe.py` |

**MCP is not the main prize.** A `list_goals` call could cost 28.7k tokens, but transcripts on this host show 1 `list_goals` and 9 `get_goal` calls, 58k characters in all. Compacting these is cheap and still worth doing, but the benefit is mainly to the page and to server work.

### 3.5 The goals page

Measured live with Playwright (`scripts/capture_goals.py`, `scripts/ux_probe.py`). Screenshots are in `shots/`.

| Measure | 1440×900 | 390×844 |
|---|---:|---:|
| First goal's top edge | 439 px | 880 px, below the fold |
| Goal card heights | 695 to 1,517 px | 1,551 to 5,307 px |
| Total page height, approx. | 4,600 px | 12,800 px |
| Decision log share of card height | 43% to 76% | not measured |
| Leaf text under 12 px | 43 of 228 | 43 of 228 |
| Targets under 24 px (includes inline links) | 29 of 47 | 10 of 47 |
| Emoji used as icons | 40 | 40 |

| Finding | Evidence |
|---|---|
| Sleep is invisible | 3 goals say `active`; each has only a future scheduled task (11-14, 11-15, 12-18). `goal-fcc427a4` will do nothing for six weeks |
| `blocked` mixes unrelated causes | The same red panel covers a rate-limit blip, a parse fault, and a login only the CEO can fix |
| Progress misleads | `goal-39dbfa70` shows a full bar at 3/3 audited, yet is not achieved and has no phase left to run |
| No budget display | The API omits used count; the card omits both numbers |
| No edit control | `PATCH /goals/:id` exists; no page code calls it, though block text tells the reader to raise the budget |
| No task view | `GET /goals/:id/tasks` is unused by the page |
| Re-renders lose state | Any non-heartbeat event re-renders the page after 800 ms. Test: open the form, enter a title, blur, re-render. Result: form closed, title empty. The guard only protects a focused field |
| Each refresh re-fetches 116 KB | `renderGoals` fetches both endpoints |
| No deep link | `#tasks/<id>` works; `#goals/<id>` does not |
| Native dialogs | Block uses two `prompt()` calls; delete uses `confirm()` and does not say how many tasks it removes |
| Low contrast in light theme | Muted text 2.56:1 on white; phase chips 2.15:1 to 2.77:1 (solid color on white, and their tinted fill does not raise it); dark muted 3.97:1 |

Token numbers use tiktoken `cl100k_base` unless taken from `usage` fields, so treat them as estimates. CJK-heavy goal text may count differently under Claude.

## 4. Survey

### 4.1 mattpocock-skills

38 skills are listed in `~/.agents/.skill-lock.json`. `retro`, `writing-for-agents`, and `wait-what` are absent from `~/.agents/skills` but present in `~/.claude/skills`. I read `ask-matt`, `to-spec`, `to-tickets`, `implement`, `wayfinder`, `loop-me`, and `codebase-design` in part, plus the descriptions of `prototype`, `handoff`, and `domain-modeling`.

| Idea | Source | Use here |
|---|---|---|
| A **brief**, not raw output, at a human checkpoint: what was produced, why, and a link to it | `loop-me` | The goal detail leads with a decision brief. The decision log moves behind a tab |
| **Push right:** do maximal work before asking, then ask once | `loop-me` | "Needs you" appears only for human-only conditions; transient faults stay silent |
| **Map as an index, not a store:** one line per decision, detail in one place | `wayfinder` | `history` becomes pointers and counts; attention text stays in its artifact |
| **Deep modules** behind a small interface | `codebase-design` | One `goal-view` module derives status for the API, MCP, and page |
| **Tracer-bullet tickets** sized to one fresh context, with blocking edges | `to-tickets` | Every item in section 8 is a vertical slice with a gate |
| **Smart zone,** about 150k tokens | `ask-matt` | Execution tasks over 150k are flagged in telemetry |
| **Prototype** to settle a UI question with throwaway code | `prototype` | Try the list and detail layout on fixture data before touching `app.js` |
| **Shared vocabulary** | `domain-modeling` | Record the new status words in a glossary or ADR so API and UI match |

### 4.2 pstack skills

Vendored at `vendor/pstack`, pin `6c75f4e`.

| Idea | Source | Use here |
|---|---|---|
| Don't do it, then do it less, then do it cheaper | `poteto-mode/playbooks/perf-issue` | Order of work: stop failed turns, skip LLM probes, then compress |
| One change, one measurement, keep or revert, with a frozen harness | `playbooks/hillclimb` | Phase 3 token work |
| Size phases, cap scope, account for mechanism costs | `principle-guard-the-context-window` | Per-role context budgets |
| Remove first, simplify prompts, cut redundant instructions | `principle-subtract-before-you-add` | Delete before adding, in the prompt and on the page |
| Name what bounds the number | `principle-explain-the-number` | Section 3.1, and why caching and output caps are not on this plan |
| Keep a scripted check a reviewer can re-run | `principle-prove-it-works` | Harnesses are deliverables |
| Evidence is a pointer, never a paragraph | `show-me-your-work` | Attention and block text leave the JSON record |
| Give each actor its own file; merge at read time | `principle-separate-before-serializing-shared-state` | Append-only `history.jsonl`; today's whole-file rewrite stays for the core record only |
| Encode a lesson as a gate, not a note | `principle-encode-lessons-in-structure` | Byte and token budgets become tests |
| Fewer polished features, tighten the core loop | `principle-experience-first` | No new charts or dashboards |
| Count layers and hidden state | `principle-minimize-reader-load` | A derived status replaces reasoning across four fields |
| Baseline first, verify by image diff | `playbooks/visual-parity` | Baseline screenshots before UI work; adapted, because this redesign changes pixels on purpose |
| Model states and find broken paths | `statechart` | Optional: check the status table for dead ends such as "all phases audited, criterion unmet" |

`figure-it-out` rigor is already in the Achiever prompt and stays, in shorter form.

### 4.3 ui-ux-pro-max

Commit `b7d5353e0130`. It has 119 UX guidelines and a searchable database. I ran 10 `--domain ux` queries, one `--design-system` query at density 8, motion 2, and variance 3, and read `references/quick-reference.md`.

| Rule (priority) | Status today | Plan |
|---|---|---|
| `color-not-only`, High | Status and progress rely partly on color | Icon and text on every status; bar paired with text |
| `color-accessible-pairs`, 4.5:1 | Fails (section 3.5) | New semantic text tokens |
| `visual-hierarchy`, `content-priority` | Explainer and form sit above the goals | Goals first, explainer behind a help control |
| `progressive-disclosure` | 12 log rows on every card | Rows, then detail, then tabs |
| `primary-action` | Up to 3 actions per card plus per-page buttons | One primary per screen; the rest in a menu |
| `no-emoji-icons` | 40 emoji | Lucide icons, already loaded |
| Text size floor, 12 px | 43 leaf items under it | 12 px minimum |
| `deep-linking`, `state-preservation` | Neither on this page | `#goals/<id>/<tab>`; patch in place |
| `error-clarity`, `aria-live-errors`, inline error placement (High) | Toast only | Field errors with `aria-describedby`, then focus the first invalid field |
| `confirmation-dialogs`, `success-feedback` | Native dialogs | In-page dialog naming what will be deleted |
| `loading-buttons`, `loading-states` | No busy state | Disable and show progress during a request |
| Contextual live updates (Accessibility) | None | One atomic `role="status"` line per change |
| Label telemetry live only with a current source, plus update time and stale state (design-system output) | "Live" pill has no time | "Updated 12 s ago" and a stale state |
| Target size: 24 CSS px for web (WCAG), 44 for mobile primaries | Fails on small controls | 24 px floor, 44 px for primary mobile controls |

**What I did not adopt:** the design-system output suggested a landing page pattern, Fira fonts, and GSAP scroll reveals. Those suit a marketing page. This is one page in an existing dashboard, so it keeps the current tokens and fonts, and takes only the density scale (8 to 32 px) and status color strategy. One query, "progressive disclosure complex", returned an unrelated result, so that rule comes from the quick reference instead.

## 5. Token efficiency mechanisms

### 5.1 Context budget reduction

| Mechanism | Change | Measured basis | Expected effect |
|---|---|---|---|
| Tool-less Achiever | New `reasonArgv`: `--tools ''`, empty MCP, auto-memory off, empty scratch cwd, no `--dangerously-skip-permissions`. Applies to Claude; other execs unchanged | Matrix E to H | 26.9k to 2.9k before the prompt |
| Zero-token probes | A block records a typed check: `brain-available`, `file-exists`, `http-200`, or `after-time`. The server runs it, and a turn fires only when it passes | 3 repeated `block` turns at ~65.8k each | No LLM turn per failed probe. No free-form commands: this text comes from an LLM. A login check like the LINE one has no typed form, so those goals keep the capped LLM probe, which emits a mechanical task to run the check |
| Rate-limit awareness | Use `isRateLimitFailure` and `brainCooldownUntil`; walk the chain; if all are cooling, set `nextRetryAt` to the reset, with no failure counted and no block row | 24 of 32 sessions | Removes the false-block storm |
| Auto-memory off for goal tasks | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, behind a flag, A/B first | Matrix: −7,643 per run | About 6% of weighted execution tokens |
| Trim `MEMORY.md` | Bring the 2,422-character LINE sticker line back to a one-line pointer. It breaks the index's own rule | Longest line is 16% of the file | Helps all runs, and is the fallback if the A/B fails |
| Judger digest | Give the Judger each task's evidence block and artifact list, and cap report and minutes length | Lean Judgers: 20 messages, about 26k output tokens each | Hypothesis: −30% per Judger |
| Tiered emit | Achiever sets `tier`; default stops being Opus for mechanical and standard work | No goal task has a `tier` today | Less quota use. Token count may not move; measure both |
| Per-goal token budget | Optional `tokenBudget` beside `stepBudget`; over budget blocks with a specific reason | Depends on phase 0 | Bounded spend on long goals |

### 5.2 Prompt payload optimization

Target: Achiever prompt ≤ 3k tokens, total first turn ≤ 6k.

| Part | Today | Change |
|---|---|---|
| Rules tail | 4,825 chars, ~1,111 tokens | ≤ 500 tokens, draft below |
| Minutes | Relative path | Inline `NEXT MOVE` from the latest minutes, up to 600 characters |
| Results | First 300 characters of every task, every phase | Current phase and last audited phase only, using `extractEvidenceBlock`. Earlier phases: one line each |
| Rejected move | Lost | `LAST MOVE REJECTED: <reason>` |
| No workable phase | Text says "plan one" while emit stays allowed | Show only `plan`, `evaluate`, and `block` in that state |
| Emit schema | title, description, scheduledAt | Add `tier`, `acceptance[]`, `verify[]`; skip the sharpener when both lists are present |
| Goal description | Templates append the loop driver, duplicating tail rules | Store `loopKind`; render only the rules unique to that kind |

Draft tail, to be checked by the replay test in phase 1:

```text
Reply with one fenced JSON move: evaluate {met, reason} | plan {phase:{key,title}, reason}
| emit {tasks:[{title, description, tier, acceptance[], verify[], scheduledAt?}], reason}
| block {reason, unblockCheck, unblockCriteria}.
- met:true ends the goal. Use it only when a named task's evidence proves the criterion.
- Treat vague criteria as predicates: first plan a phase that pins a number and its source.
- Test the riskiest unknown first. Baseline before building.
- Tasks do real work. Plans and reports are not progress. Follow execution with verification.
- Follow NEXT MOVE unless evidence contradicts it; if so, say why.
- To let time pass, emit the measurement with a future scheduledAt. That costs nothing.
- If an approach underperformed, change it. An unmet criterion never means stop.
- Block only on what you cannot clear yourself, with a checkable condition.
You have no tools. To read or measure something, emit a task.
```

**Tradeoff of a tool-less Achiever.** It cannot run a quick read-only check during its turn, as it did on 10-12, 10-14, and 10-22. That check becomes an emitted task, which costs a 35k start instead of one Bash call. Of the 13 Bash calls measured, 8 were for the minutes, which inlining removes, and the other 5 were this kind of check. These are rare, so this is accepted, and phase 1's one-week check watches for the emitted-task count rising. Flag: `goals.achieverMode: toolless | legacy`.

### 5.3 Schema compaction

```jsonc
// Before: history row, about 560 chars, repeated 34 times on one goal
{"kind":"block","reason":"Achiever made no usable progress after 5 turns (...)",
 "unblockCriteria":"The Achiever brain is reachable and returns a parseable...","at":"..."}

// After: same-cause cycles coalesce; display text is rendered from the code
{"kind":"block","code":"achiever_no_progress","count":14,"firstAt":"...","lastAt":"..."}
```

| Change | Effect on 4 live goals |
|---|---|
| Move all history to append-only `goals/<id>/history.jsonl`; the record keeps a coalesced tail of 20 rows | `history` 38 KB to about 3 KB |
| Drop inline `phase.attention`; keep `attentionArtifact` and `attentionFlags: n` | `phases` 42 KB to about 8 KB |
| Block reasons use `code` plus optional detail; shared wording lives in one renderer | Removes repeated 400-character text |
| `GET /goals` returns summaries; `?view=full` and `GET /goals/:id` keep the full record | 90 KB to ≤ 3 KB |
| Same default for MCP `list_goals`; `update_goal_progress` returns `{applied, status}` | Up to 28.7k to about 700 tokens per list |
| Fetch templates only when the form opens | −26 KB per refresh |

**Migration:** back up `goals/`, make an idempotent one-way script, and keep reading both shapes for one release. No data is lost: the full history moves to the JSONL file, and attention text already exists in its artifact. Before removing `phase.attention`, check every consumer. `mergeAttention` needs to read the artifact instead.

## 6. Telemetry, the prerequisite

- **Tasks:** the stream parser already sees `total_cost_usd` and `num_turns` (`server/src/core/progress-stream.ts:111-115`). Save `{input, cacheRead, cacheWrite, output, turns, costUsd, brain}` to `task.context.usage`.
- **Achiever turns:** use `--output-format json` for Claude and append one row per turn to `goals/<id>/achiever-turns.jsonl`, with the raw reply on any parse failure.
- **Rollup:** per goal and per phase, in `goal-view`. Show unmetered brains as "not metered", never as 0. Whether `agy` reports usage is unknown and is checked in phase 0.

## 7. UX enhancements

### 7.1 Status visibility: one derived state

A server-side `displayState` replaces reasoning across `status`, phases, open tasks, and backoff fields. Each state always shows an icon, a word, and the next event.

| Display state | Derived from | Line shown | Live example today |
|---|---|---|---|
| Needs you | Block with a human-only code or an open `wait-input` task | "Log in to LINE Creators", with the action | none now |
| Running | A generated task is claimed or in progress | "Running: <task> · 12 min" | none now |
| Thinking | Achiever turn in flight | "Choosing the next move" | none now |
| Auditing | Phase is `completing`, or Judger is open | "Reviewing: <phase>" | none now |
| Sleeping | Only future scheduled tasks are open | "Next check 11-14 10:00" | `goal-2c438b06`, `goal-6710dc94`, `goal-fcc427a4` |
| Retrying | Transient block code, or chain cooling | "Rate limited, retry at 17:00" | `goal-6710dc94` on 10-21 and 10-22 |
| Stuck | All phases audited, criterion unmet, repeated failures | "No phase left to work on" | `goal-39dbfa70` |
| Paused, Draft, Achieved | As stored | Date and closing evidence link | none now |

**Time display:** relative up to 24 hours, then the date. Use tabular numerals (`number-tabular`), plus an "Updated N s ago" line that turns stale when the event stream drops.

### 7.2 Layout hierarchy

```text
Desktop (≥1024 px)                                       Mobile (<1024 px)
┌───────────────────────────────────────────────────┐    ┌────────────────────┐
│ Goals    [All 4][Needs you 0][Sleeping 3] [+ New] │    │ Goals      [+ New] │
├───────────────────────────────────────────────────┤    │ Needs you 0 · All 4│
│ ! NEEDS YOU strip, hidden when empty              │    ├────────────────────┤
├───────────────────────┬───────────────────────────┤    │ ● Stuck            │
│ ● Stuck               │ Promotion campaign        │    │ Promotion campaign │
│ Promotion campaign    │ ● Stuck · no phase left   │    │ No phase left      │
│ No phase left  6/35   │ Plan a phase [primary]    │    │ ▮▮▮  6/35 tasks    │
│ ▮▮▮                   │                           │    ├────────────────────┤
├───────────────────────┤ Done when: <criterion>    │    │ ◐ Sleeping         │
│ ◐ Sleeping            │ Latest brief: <NEXT MOVE> │    │ KDP revenue        │
│ KDP revenue           │ ▮▮▮▯▯ phases  6/35 tasks  │    │ Next check 11-15   │
│ Next check 11-15      │                           │    │ ▮▮▮▯▯  10/200      │
│ ▮▮▮▯▯  10/200         │ [Overview][Phases]        │    └────────────────────┘
└───────────────────────┴ [Decisions][Files]────────┘    Tap: full-screen detail,
                                                         back returns with scroll kept
```

- **Level 1, the page:** goals and filters. The explainer moves to a `?` popover. The create form moves to `#goals/new`, so no re-render can touch it.
- **Level 2, the row:** state, title, next event, phase segments, budget. About 96 px tall, with no log, IDs, or brain chips.
- **Level 3, the detail:** the state line and its one primary action, then the criterion, the latest brief, and progress.
- **Level 4, the tabs:** Phases (tasks, report, minutes, attention count), Decisions (coalesced, newest first), Files, and Settings (brains, budget, tokens).
- **Sort:** Needs you, Stuck, Running, Retrying, Sleeping by next event, Draft, Paused, then Achieved, collapsed.
- **Progress:** segments by phase state with a text count. Never a solid "100%" while the goal is unmet.

### 7.3 Key interaction flows

| Flow | Today | After | Rules |
|---|---|---|---|
| Triage a stuck goal | Read a 1,500 px card and a raw reason, then use the API to change anything | Filter or strip, open the detail, read the cause, click the one action (Plan a phase, Raise budget, Retry now) with busy and success feedback | `primary-action`, `loading-buttons`, `error-clarity` |
| Answer "what happens next?" | Open the Tasks page and work it out | Read it on the row | `content-priority` |
| Follow a phase | Slugs in chips; title in a hover tooltip; files in a separate list | Stepper with real titles (works on touch), then tasks, report, minutes, attention count | `compact-label-overflow`, no hover-only content |
| Edit | No control | Settings tab using `PATCH`. A budget change says "Takes effect on next retry at 17:00" | `success-feedback` |
| Create | Long form above the list, template fills hidden Advanced fields, errors via toast | `#goals/new`: pick a starter, then criterion, then phases, then a preview with budget and loop type. Inline errors, and a warning when a criterion is not Yes/No | `progressive-disclosure`, inline errors, `focus-management` |
| Block | Two native prompts | In-page dialog: reason, resume condition, typed check | `confirmation-dialogs` |
| Delete | `confirm()`, no counts, irreversible | Dialog naming the goal and task count; a "Keep tasks" choice, already supported by the API | `confirmation-dialogs` |
| Live update | Full re-render; form and scroll lost; 116 KB | New `goalUpdated` event patches one row, with one `role="status"` line | `state-preservation` |

**Scope limits:** no framework or build step, and no new charts. Rendering moves out of `renderGoals` into a small `goals-view.js`, following the `calendar.css` and `recipes.css` pattern of per-feature files. Undo for delete is out of scope, because the server deletes immediately.

## 8. Phased implementation roadmap

Each phase is a set of tracer-bullet tickets (`to-tickets`), each runnable in one fresh context, using `tdd` where a seam exists and closing with two-axis `code-review`. Use a worktree, since `main` has others' uncommitted changes in `server/src/api/router.ts`. Remember that server changes are not live until a redeploy via `redeploy-server-when-idle.sh`.

### Phase 0: measure (blocks everything). Size S

| Ticket | Blocked by |
|---|---|
| Save per-run usage to `task.context.usage`; check whether `agy` and `hermes` report it | none |
| Log Achiever turns and raw failed replies | none |
| Freeze harnesses: `scripts/goals-token-baseline.py`, `scripts/goals-ux-baseline.py`, fixture copy of the 4 goals | none |
| Capture why `goal-39dbfa70` replies fail to parse, and record the cause | Achiever log |

**Verification:** 10 consecutive goal tasks show usage or an explicit "not metered". Two baseline runs on the fixture agree within 2%. The harness detects a deliberately added 1k-token line. If telemetry refutes section 2, stop and re-plan.

### Phase 1: fix the loop. Size M

Rate-limit handling and chain fallback; inline `NEXT MOVE`; rejected-move feedback; no-workable-phase handling; compressed tail; tool-less Achiever; `tier`, `acceptance`, and `verify` on emit; typed zero-token probes.

**Verification:**

| Check | Pass |
|---|---|
| Unit test: rate-limit reply on the first brain | Next brain is tried, no failure counted, no block row |
| Unit test: all brains cooling | `nextRetryAt` equals the reset, 0 spawns until then |
| Replay about 15 historical contexts, old vs new prompt, on one model | `kind` agrees ≥ 85%; 0 unsupported `met:true`; each disagreement reviewed by hand. The sample is small, so treat it as a smoke test |
| One real Claude Achiever turn | First-turn context ≤ 6k from `usage` |
| Prompt budget test on fixtures | ≤ 3k tokens, enforced in CI |
| One week live | 0 rate-limit-caused blocks; `Bash` calls in Achiever turns = 0; no rise in mechanical check tasks per goal |

**Rollback:** `goals.achieverMode: legacy`.

### Phase 2: compact the schema. Size M

`goal-view` module; summary list and full detail; coalesced history and JSONL; attention to artifact only; MCP defaults; lazy templates; migration script.

**Verification:** `GET /goals` ≤ 3 KB on the fixture, and `history` rows lose no events compared with the JSONL. The script is idempotent: a second run gives a byte-identical result. All existing goal tests pass, plus a test that reads both shapes. `goals.test.ts` and `goal-trail.test.ts` cover the block/resume and Attention merge paths. The page still works with the old payload until phase 4.

### Phase 3: reduce execution context. Size M, hillclimb rules

One change at a time, each against the frozen harness, keep or revert: Judger digest and length cap; auto-memory A/B; `MEMORY.md` trim; tier routing.

**Verification:**

| Check | Pass |
|---|---|
| Weighted tokens per execution task | −15% from the phase 0 baseline, with ≥ 15 tasks per arm |
| Weighted tokens per Judger | −30%, with ≥ 6 Judgers |
| First-pass verification rate | Not more than 5 points lower |
| Rework and reopened tasks, Attention flags per phase | Not higher |

**Limits on this evidence:** goals generate about 2 tasks a day, so an arm takes one to two weeks, and tasks vary widely. Report a result as VERIFIED, NOT VERIFIED, or INCONCLUSIVE. An inconclusive arm does not ship. If auto-memory fails, keep the trim only.

### Phase 4: page structure. Size M

Baseline screenshots at 1440 and 390 px; throwaway prototype on fixtures, reviewed by the CEO; `displayState`; rows, filters, sort, strip; detail with deep links; patch-in-place via `goalUpdated`; semantic tokens.

**Verification:** `scripts/goals-ux-baseline.py` asserts:

| Measure | Baseline | Pass |
|---|---:|---:|
| First goal's top edge, 1440 and 390 px | 439, 880 | ≤ 180, ≤ 180 |
| 4-goal list height, 390 px | ~12,800 px | ≤ 1,200 px |
| Bytes per refresh | 116 KB | ≤ 3 KB |
| Form or scroll lost on event | Yes | No |
| Sleeping goals labeled with next time | 0 of 3 | 3 of 3 |
| Budget visible | 0 of 4 | 4 of 4 |
| Reload `#goals/<id>/phases` | Not possible | Same view returns |
| Back from detail on mobile | n/a | Scroll restored |
| Keyboard: list, detail, tabs, back | Not tested | Works, with visible focus |

**Glance test:** from the first screen at both sizes, can a reader answer: which goal needs me, what is each doing, and when does it next act? This is a checklist against the screenshots plus one CEO pass. With one user, there is no meaningful time-on-task comparison, so none is claimed.

### Phase 5: flows and accessibility. Size S to M

Settings edit; create flow with inline validation; block and delete dialogs; icons replacing emoji; contrast and text-size fixes; token display in Settings. Sign-off runs the design skill's pre-delivery checks, adapted for web.

**Verification:**

| Measure | Baseline | Pass |
|---|---:|---:|
| axe-core serious or critical issues | Not run | 0, at both sizes and both themes |
| Text and chip contrast | 2.15:1 to 3.97:1 | ≥ 4.5:1 |
| Leaf text under 12 px | 43 | 0 |
| Emoji as icons | 40 | 0 |
| Native `prompt()` and `confirm()` | 3 | 0 |
| Non-inline targets under 24 px | Baseline in phase 4 | 0 |
| Scripted flows: raise budget, retry, plan, block, delete, create invalid then valid | No edit at all | All pass in Playwright on a fixture server, never on live goals |
| `prefers-reduced-motion` | Not handled here | Honored |

## 9. Tradeoffs and options rejected

| Option | Verdict | Why |
|---|---|---|
| Restrict execution tasks to a named tool list | Rejected | Measured +8,072 tokens |
| Prompt caching for Achiever turns | Rejected | Turns are hours apart |
| Cap large tool output | Deferred | Results over 20k characters are only 10% of tool output |
| Shrink only the Achiever | Rejected as the main plan | 2% of tokens; kept for the bug fixes and the permission reduction |
| Summarize history with an LLM | Rejected | Spends tokens to save tokens; coalescing is deterministic |
| Free-form shell in `unblockCheck` | Rejected | The server would run LLM-written commands |
| Prioritize MCP compaction | Lowered | 10 calls measured; still shipped, since the view module provides it for free |
| Rewrite the page in React | Rejected | No build step exists, and the page does not need one |
| Keep cards, only fold the log | Rejected | Cheaper, but leaves sleep, budget, and deep links unsolved |
| Adopt the suggested palette and fonts | Rejected | Would make one page differ from the rest of the dashboard |

## 10. Open items

- **Unknown:** why `goal-39dbfa70` replies fail to parse. Phase 0 captures the raw output.
- **Unknown:** usage reporting from `agy` and `hermes`. 18 of 52 tasks are unmetered until then, and Attention is the most affected role.
- **Not analyzed:** whole-file writes to `goals/<id>.json` from different event paths may lose updates. Moving history to JSONL reduces exposure, but this was not tested.
- **Out of scope:** the fleet-wide bootstrap beyond goal tasks. If the phase 3 changes hold, they are candidates for all tasks, as a separate decision.

## Appendix: reproducing the evidence

Run from `artifacts/b5867526-b135-42b2-b8bd-f2296ab903ef/scripts/`. All are read-only against goals and tasks. `bootstrap_matrix.py` makes 16 short Haiku calls.

| Script | Produces |
|---|---|
| `measure_usage.py` | Section 3.1 role totals |
| `achiever_detail.py` | Real vs rate-limited Achiever turns |
| `bootstrap_matrix.py` | Section 3.2 |
| `reconstruct_prompts.mjs` | Achiever prompt sizes from `server/dist`; copy into `server/` to resolve imports |
| `tool_output_and_state.py` | Tool output shares, live goal state, MCP call counts |
| `capture_goals.py`, `ux_probe.py` | Screenshots, layout metrics, state-loss test, compact payload; need `COWORK_API_KEY` |
