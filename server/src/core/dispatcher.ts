import { matchPersona } from './persona-match.js';
import { spawn, type ChildProcess, execFile } from 'child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Config, RoleConfig, Task, AchieverDecision, RunUsage, PersonaCard } from '../types.js';
import type { AchieverTurn } from './goal-view.js';
import type { EventBus } from './events.js';
import type { Store, CompletionDecision } from './store.js';
import { isFailedTask } from './store.js';
import type { Goals } from './goals.js';
import { FIGURE_IT_OUT_RULES, hashArm, runUnblockCheck } from './goals.js';
import { buildAchieverPrompt } from './achiever-prompt.js';
import { verifyOutput, isRateLimitFailure, isCliRateLimitSignal, buildVerifierPrompt, shouldLlmVerify, parseLlmVerdict, parseSpecVerdict, selectSpecJudges, explainSpecJudgeSkips, DEFAULT_SPEC_JUDGES, extractEvidenceBlock, detectInputRequest, detectBackgroundWait, unaccountedFailedDeps, parseStatusFooter, type StatusFooter, type VerifyVerdict, type VerifierArtifact, type SpecVerdictRecord, type InputOptions, type InputRequest, type BackgroundOptions, type BackgroundWait } from './result-verifier.js';
import { buildLesson, appendLesson, type LessonPanel } from './lessons.js';
import { buildPanelReviewerPrompt, buildLeadJudgmentPrompt, parseLeadJudgment } from './review-panel.js';
import { describeAutoAnswer, logAutoAnswer } from './rulings.js';
import { BRIEF_KEYS, parseBrief, renderBriefSections } from './brief.js';
import { renderMethodPrompt } from './methods.js';
import { sharpenPending, renderSkillPrompt, reviewMode, panelFallbackAcceptance, parseArena, pickArenaAgents, arenaPlan } from './pstack-gates.js';
import { extractPrUrls, openedPrUrls, prInScope, prWatchTaskSpec } from './pr-automation.js';
import { shouldSharpenTask, sharpenTask, mergeSharpenedContext } from './sharpener.js';
import { resolveWorkRoles, workRolesPromptBlock, guessWorkRole, workRoleContext } from './work-roles.js';
import { taskTier, mergeTierChain, reviewChain, agentFamily, type TierName } from './tiers.js';
import { canonicalAgentId } from '../config.js';
import { STREAMING_EXECS, streamArgs, createStreamRenderer, claudeUsage, flatUsage, lastAssistantText } from './progress-stream.js';
import { briefPersona } from './persona-brief.js';
import { agyModelSlug, DEFAULT_THINKING, normalizeThinking, splitThinkingSuffix, thinkingArgs, type ThinkingLevel } from './thinking.js';
import { ClaudeProfile } from './claude-profile.js';
import { killProcessTree } from './proc-tree.js';
import { codeTaskRepo, ensureWorktree, writeWorktreeDiff, pruneStaleWorktrees } from './worktree.js';
import { lintArtifacts, lintReason, resolveSloplint, OUTPUTS_SUBDIR } from './artifact-lint.js';
import { listArtifactFiles } from './artifact-list.js';
import { isAgyModelRejection, diagnoseAgyModelFailure, listAgyModels } from './agy-models.js';
import { dshFailureReason } from './dsh-failure.js';

/** Remove ANSI CSI/OSC escape sequences and lone carriage returns. */
// eslint-disable-next-line no-control-regex
const OSC_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
// Ollama's CLI redraws wrapped words even to a pipe as `<chars>ESC[<N>DESC[K`;
// that sequence means "delete the previous N chars", so apply it, then drop any
// remaining escape sequences and carriage returns.
function stripAnsi(s: string): string {
  return s.replace(/(.{0,200}?)\x1b\[(\d+)D\x1b\[K/gs, (_m, pre, n) => pre.slice(0, Math.max(0, pre.length - Number(n))))
          .replace(OSC_CSI_RE, '').replace(/\r/g, '');
}

/** A turn of a live dialogue (voice assistant): its reply is the deliverable, so
 *  the question-parking / background-deferral / LLM-verifier gates don't apply. */
export function isConversational(task: { context?: Record<string, any> }): boolean {
  return task.context?.conversational === true;
}

/** A fully-resolved execution plan for one attempt of one task. */
interface ExecPlan {
  persona: string;                // special role name or persona slug
  division?: string;            // division for personas (chain + display)
  isRoster: boolean;            // true → run the roster .md persona
  agentId: string;             // agent used this attempt
  attempt: number;             // 0-based index into the resolved agent chain
  chainLen: number;            // length of the chain (0 if pinned)
  pinned: boolean;             // context.agent override (retry same agent)
  label: string;                // worker display + logs
  platform: string;             // active-worker platform bucket
  exec: 'claude' | 'hermes' | 'agy' | 'script' | 'codex' | 'ollama' | 'dsh';
  model: string;
  thinking?: ThinkingLevel;
  command?: string[];
}

/**
 * Dispatcher — the execution layer that turns queued tasks into real agent runs.
 *
 * Polls the inbox for pending tasks that carry a role (context.role, or a tag
 * matching a configured role name), claims them, spawns the mapped platform CLI
 * headlessly, and completes the task with the agent's output. Full stdout is
 * saved to artifacts/<task-id>/result.md so the Web UI shows the full output.
 *
 * Role → executor mapping lives in config.json under `orchestration.roles`:
 *   claude → `claude -p <prompt> --model <model> --dangerously-skip-permissions`
 *   hermes → `hermes -m <model> -z <prompt>`
 *   agy    → `agy -p <prompt> --dangerously-skip-permissions`
 *
 * Tasks WITHOUT a role are left alone (they may be aimed at live interactive
 * agents polling the inbox themselves). Tag a task `manual` to always skip it.
 */
/** Ensure dsh live progress & compaction reporting patch overlay exists and return its path. */
export function ensureDshPatch(artifactsPath?: string): string | undefined {
  try {
    let pluginPath = fileURLToPath(new URL('../../../deploy/dsh/dsh-progress-plugin.mjs', import.meta.url));
    if (!existsSync(pluginPath) && artifactsPath) {
      const repoRoot = resolve(artifactsPath, '..');
      pluginPath = join(repoRoot, 'deploy', 'dsh', 'dsh-progress-plugin.mjs');
    }
    if (!existsSync(pluginPath)) return undefined;
    const patchPath = join(dirname(pluginPath), 'dsh-progress-patch.yml');
    const expectedContent = `# Cowork dsh live progress and context compaction plugin overlay\n- insert:\n    - id: dsh-cowork-progress\n      name: '${pluginPath}'\n`;
    let currentContent = '';
    try { currentContent = readFileSync(patchPath, 'utf-8'); } catch {}
    if (currentContent !== expectedContent) {
      writeFileSync(patchPath, expectedContent, 'utf-8');
    }
    return patchPath;
  } catch {
    return undefined;
  }
}

export class Dispatcher {
  /** Name of the always-on coordinator agent shown in Active Agents. */
  static readonly COORDINATOR_NAME = 'orchestrator';
  private config: Config;
  private store: Store;
  private eventBus: EventBus;
  private goals?: Goals;
  private running = new Map<string, { role: string; startedAt: number; workerId?: string; agentId?: string }>();
  /** Live agent process per running task — killed (whole tree) when the task is deleted. */
  private children = new Map<string, ChildProcess>();
  /** Tasks deleted while their agent was running: their run is discarded, never verified/handed over. */
  private cancelled = new Set<string>();
  private workerId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private classifying = new Set<string>();
  private decidingGoals = new Set<string>();   // goals mid-Achiever-turn (re-entrancy guard)
  private decidingInput = new Set<string>();   // wait-input tasks mid auto-answer (re-entrancy guard)
  /** Consecutive unusable / no-progress Achiever turns per goal. */
  private goalFailures = new Map<string, number>();
  /** Abandon a goal after this many consecutive Achiever turns that make no
   *  progress (garbled decision, or an evaluate that neither ends nor advances). */
  static readonly MAX_GOAL_FAILURES = 5;
  /** Default per-task ceiling on orchestrator auto-answers of a `wait-input`
   *  task before it is left for a real human (overridable via
   *  orchestration.autoAnswer.maxAttempts). */
  static readonly MAX_AUTO_ANSWERS = 3;
  /** Maximum size in bytes of `artifacts/<id>/progress.md` injected into a resumed prompt (P1-3). */
  static readonly PROGRESS_LEDGER_MAX_BYTES = 4096;

  constructor(config: Config, store: Store, eventBus: EventBus, goals?: Goals) {
    this.config = config;
    this.store = store;
    this.eventBus = eventBus;
    this.goals = goals;
    // Deleting a task must stop its agent. Store.deleteTask only removes files;
    // without this the agent (e.g. a dsh run on the local SGLang engine) kept
    // running — and burning GPU — with nobody left to collect its result.
    if (typeof eventBus?.on === 'function') {
      eventBus.on('taskDeleted', (evt: any) => {
        const taskId = evt?.payload?.taskId;
        if (taskId) this.cancelTask(taskId, 'task deleted');
      });
      // Pausing a running task stops its agent the same way; the store keeps the
      // task on `paused` (its pause guard overrides the dying run's last writes).
      eventBus.on('taskPaused', (evt: any) => {
        const taskId = evt?.payload?.task?.id;
        if (taskId) this.cancelTask(taskId, 'task paused');
      });
    }
  }

  /**
   * Stop a task's running agent: SIGTERM its whole process tree, SIGKILL after a
   * grace period. The run is marked cancelled so execute() discards its output
   * instead of verifying / handing it over (which could resurrect the task).
   * Returns false when this dispatcher is not running the task.
   */
  public cancelTask(taskId: string, reason = 'cancelled'): boolean {
    const child = this.children.get(taskId);
    if (!this.running.has(taskId) && !child) return false;
    this.cancelled.add(taskId);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      console.log(`Dispatcher: ${reason} — killing agent process tree (pid ${child.pid}) of task ${taskId}`);
      void killProcessTree(child.pid, { graceMs: this.config.orchestration?.killGraceMs ?? 5000 });
    }
    return true;
  }

  public start(): void {
    const orch = this.config.orchestration;
    if (!orch.enabled) {
      console.log('Dispatcher: disabled (orchestration.enabled = false)');
      return;
    }
    // Drop ghost registrations from previous service runs — there is exactly
    // one coordinator per server process. Sweep the old "dispatcher" name too
    // so a rename doesn't leave a stale card.
    for (const a of this.store.getActiveWorkers()) {
      const isCoordinator = a.platform === 'cowork' && (a.workerName === Dispatcher.COORDINATOR_NAME || a.workerName === 'dispatcher');
      if (isCoordinator || a.sessionId === 'dispatcher-worker') {
        this.store.removeWorker(a.id);
      }
    }
    // Handover: reclaim tasks a previous dispatcher run claimed but never
    // finished (service restart / crash mid-execution). context.dispatched
    // marks dispatcher-owned claims, so live interactive workers' claims are
    // never touched.
    for (const t of this.store.listTasks()) {
      if ((t.status === 'in-progress' || t.status === 'claimed') && t.context?.dispatched) {
        t.status = 'pending';
        delete t.claimedAt;
        delete t.claimedBy;
        this.store.saveTask(t);
        console.log(`Dispatcher: handover — reclaimed orphaned task ${t.id} (${t.title})`);
      }
    }
    const roleNames = Object.keys(this.specialRoles());
    const worker = this.store.registerWorker({
      platform: 'cowork',
      workerName: Dispatcher.COORDINATOR_NAME,
      capabilities: roleNames
    });
    this.workerId = worker.id;
    // Verify EXTERNALLY reported results too: a remote agent (e.g. a
    // remote-examplehost-cc-* client) can report a rate-limit / "session limit"
    // notice as its result and it would otherwise be marked done. The guard runs
    // the same verifier and hands such results to the next fallback agent.
    this.store.setCompletionGuard((t, r) => this.verifyReportedCompletion(t, r));
    this.timer = setInterval(() => this.tick(), orch.pollIntervalMs);
    // Catch-up tick right now instead of waiting a full pollIntervalMs. Server
    // restarts are frequent (redeploys), and setInterval fires its FIRST callback
    // only after one interval — so a scheduled task that came due while the process
    // was down would otherwise sit un-launched for up to pollIntervalMs after every
    // restart (and, if restarts churn faster than the interval, be deferred each
    // time). Running one tick immediately releases any already-due scheduled tasks
    // straight away. Deferred to the next microtask so `start()` finishes first.
    queueMicrotask(() => this.tick());
    const clsMsg = orch.classifier?.enabled ? `classifier ${orch.classifier.model}` : 'classifier off';
    console.log(`Dispatcher: started (agents: ${roleNames.join(', ')}; max ${orch.maxConcurrent} concurrent; ${clsMsg}; staleClaim ${orch.staleClaimMs ?? 0}ms)`);
  }

  /** Run a dispatch pass soon instead of waiting up to pollIntervalMs — used by
   *  interactive surfaces (voice assistant) right after they enqueue a turn.
   *  Coalesced: many kicks within the debounce window cause one tick. */
  public kick(): void {
    if (this.stopped || this.kickTimer) return;
    this.kickTimer = setTimeout(() => { this.kickTimer = null; this.tick(); }, 150);
  }
  private kickTimer: ReturnType<typeof setTimeout> | null = null;

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  public getRunning(): { taskId: string; role: string; startedAt: number }[] {
    return Array.from(this.running.entries()).map(([taskId, r]) => ({ taskId, ...r }));
  }

  /** Special (non-roster) executor agents: orchestrator, generalist, video. */
  private specialRoles(): Record<string, { description: string; agents: string[] }> {
    return this.config.orchestration.roleChains || {};
  }
  private isSpecial(name: string): boolean {
    return !!this.specialRoles()[name];
  }

  /** Resolve the agent fallback chain for an agent. Precedence:
   *   special role      → its own agents[name].agents
   *   persona           → its work-role tier (if any), then the global default chain.
   *   Disabled agents are silently stripped from the resolved chain so they are
   *   never dispatched. */
  private chainFor(persona: string, division?: string, ctx?: Record<string, any>): string[] {
    const orch = this.config.orchestration;
    const agents = orch.agents || {};
    let raw: string[];
    const tier = taskTier(ctx);
    if (this.isSpecial(persona)) {
      raw = orch.roleChains[persona].agents || [];
      // P1-2: when a gated step escalates to `judgment` tier at round >= escalateAgentAt,
      // prepend the judgment tier agents even for special roles (e.g. orchestrator).
      if (ctx?.escalated && tier === 'judgment') {
        raw = mergeTierChain(this.tierList('judgment', ctx), raw);
      }
    } else {
      // Personas no longer carry their own agent routing (the per-division /
      // per-persona chain overrides were removed with the Personas page): a
      // persona shapes the PROMPT, the work role's tier + default chain pick the agent.
      void division;
      raw = orch.defaultChain || [];
      // P1-4: a tier-tagged task tries its tier's agents first, then the normal chain.
      if (tier) raw = mergeTierChain(this.tierList(tier, ctx), raw);
    }
    // Strip disabled agents so the dispatcher never schedules them.
    return raw.filter(id => !agents[id]?.disabled);
  }

  /** Agents of a tier. `review` = a different family than context.reviewOf
   *  (the executor agent being judged), else the judgment list. */
  private tierList(tier: TierName, ctx?: Record<string, any>): string[] {
    const orch = this.config.orchestration;
    if (tier === 'review') {
      const of = typeof ctx?.reviewOf === 'string' ? canonicalAgentId(this.config, ctx.reviewOf) : '';
      if (of) {
        const fromTiers = reviewChain(of, orch.tiers, orch.agents || {});
        const judges = orch.verifier?.spec?.judges
          ? { ...DEFAULT_SPEC_JUDGES, ...orch.verifier.spec.judges }
          : DEFAULT_SPEC_JUDGES;
        const fromJudges = selectSpecJudges(of, { judges, agents: orch.agents || {} });
        return mergeTierChain(fromTiers, fromJudges);
      }
      return orch.tiers?.judgment || [];
    }
    return orch.tiers?.[tier] || [];
  }

  /** The chosen agent for a task: a special role name, or a persona slug. */
  private resolvePersona(task: Task): string | null {
    if (task.tags?.includes('manual')) return null;
    const ctx = task.context || {};
    const named = typeof ctx.persona === 'string' ? ctx.persona : typeof ctx.role === 'string' ? ctx.role : undefined;
    if (named && (this.isSpecial(named) || this.store.getPersona(named))) return named;
    for (const tag of task.tags || []) if (this.isSpecial(tag) || this.store.getPersona(tag)) return tag;
    if (task.skill && (this.isSpecial(task.skill) || this.store.getPersona(task.skill))) return task.skill;
    return null;
  }

  /** How many local runs this ONE agent instance may serve at once. Per-agent
   *  {@link AgentConfig.maxConcurrent}, else orchestration.defaultAgentConcurrency,
   *  else 1. Never returns < 1. Remote agents are governed by their own client, so
   *  this only bounds locally-spawned runs. */
  private agentCap(agentId: string): number {
    const b = this.config.orchestration.agents?.[agentId];
    const cap = b?.maxConcurrent ?? this.config.orchestration.defaultAgentConcurrency ?? 1;
    return cap > 0 ? cap : 1;
  }

  /** How many locally-spawned runs are in flight on `agentId` right now. */
  private agentLoad(agentId: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.agentId === agentId) n++;
    return n;
  }

  /**
   * Record WHY a task is still sitting in the pending pool, for the dashboard's
   * pending cards ("what is it waiting on"). Stored on `context.pendingReason`
   * (+ `pendingReasonAt`). Only writes when the reason text CHANGES, so the 5s
   * dispatch tick doesn't rewrite every pending task file on every pass. A no-op
   * once the task leaves `pending`.
   */
  private markPending(task: Task, reason: string): void {
    const t = this.store.getTask(task.id);
    if (!t || t.status !== 'pending') return;
    if (t.context?.pendingReason === reason) return;
    t.context = { ...(t.context || {}), pendingReason: reason, pendingReasonAt: new Date().toISOString() };
    this.store.saveTask(t);
  }

  /** Drop a stale pending reason the moment a task is actually dispatched, so a
   *  running/finished card never shows a "waiting for…" note. */
  private clearPending(taskId: string): void {
    const t = this.store.getTask(taskId);
    if (!t || !t.context || t.context.pendingReason === undefined) return;
    const ctx = { ...t.context };
    delete ctx.pendingReason;
    delete ctx.pendingReasonAt;
    t.context = ctx;
    this.store.saveTask(t);
  }

  /**
   * AUTOMATIC re-run of rate-limited failures. For each failed task flagged
   * `context.rateLimited` with `context.autoRerunOnReset` (set by default at
   * classification — see Store.classifyRateLimit — unless the user opted out or
   * `orchestration.autoRerunRateLimited.enabled` is false), re-queue it
   * (Store.rerunTask resets it to the top of its chain) once its rate-limit window
   * has reset plus a short grace. The reset time is the one classified at failure
   * (`rateLimitResetsAt`); when that is unknown — the meters hadn't reported a
   * reset — a fixed 1h backoff from `completedAt` still eventually retries so the
   * re-run never silently stalls. Bounded by `maxAttempts` per task so a quota
   * that never comes back doesn't loop forever.
   */
  private autoRerunRateLimited(): void {
    const cfg = this.config.orchestration.autoRerunRateLimited || {};
    const now = Date.now();
    const fallbackMs = 60 * 60 * 1000;   // 1h when no reset time was discoverable
    const graceMs = Math.max(0, cfg.graceSeconds ?? 120) * 1000;
    const maxAttempts = cfg.maxAttempts ?? 6;
    const defaultOn = cfg.enabled !== false;
    for (const t of this.store.listTasks({ status: 'failed' })) {
      const ctx = t.context || {};
      if (ctx.rateLimited !== true) continue;
      // Armed = explicitly on, or UNSET while default-on. Honouring an unset flag
      // here (not only at classification) also covers tasks classified before
      // the default flipped, which would otherwise sit failed forever.
      const armed = ctx.autoRerunOnReset === true || (ctx.autoRerunOnReset === undefined && defaultOn);
      if (!armed) continue;
      if ((Number(ctx.autoRerunCount) || 0) >= maxAttempts) continue;
      const resetAt = typeof ctx.rateLimitResetsAt === 'string' ? Date.parse(ctx.rateLimitResetsAt) : NaN;
      const due = Number.isFinite(resetAt)
        ? now >= resetAt + graceMs
        : (t.completedAt ? now >= Date.parse(t.completedAt) + fallbackMs : false);
      if (!due) continue;
      // A failed run of a recurring task is stale once a NEWER cycle has spawned:
      // re-running it would duplicate that cycle's work on the same scarce
      // agents. Disarm it once (so it isn't re-checked every tick) instead.
      if (this.store.isSupersededScheduledRun(t)) {
        t.context = { ...ctx, autoRerunOnReset: false, autoRerunSkipped: 'superseded by a newer run of its recurring task' };
        this.store.saveTask(t);
        console.log(`Dispatcher: not re-running rate-limited task ${t.id}: a newer run of its recurring task already exists. Task: ${t.title}`);
        continue;
      }
      try {
        const re = this.store.rerunTask(t.id, undefined, { auto: true });
        if (re) console.log(`Dispatcher: auto re-ran rate-limited task ${t.id} (#${re.context?.autoRerunCount}/${maxAttempts}) — usage window reset, back to pending — ${t.title}`);
      } catch (e) { console.error(`Dispatcher: auto-rerun of ${t.id} failed:`, e); }
    }
  }

  /**
   * Pick which rung of a fallback chain to run for a FRESH (unpinned) dispatch,
   * with preference-preserving load balancing.
   *
   * The chain is an ordered PREFERENCE list (best agent first), so the preferred
   * rung `chain[attempt]` wins whenever it has spare capacity — under no contention
   * this returns `chain[attempt]` unchanged, exactly as before. Only when the
   * preferred rung is a LOCAL agent that is SATURATED (at its maxConcurrent) do we
   * scan the rest of the chain and hand the overflow to the local rung with the most
   * spare capacity. That is what stops one reliable workhorse agent (e.g.
   * `local-ha-qwen3-8-27b`) from absorbing every concurrent task while its
   * peers sit idle.
   *
   * Remote rungs and unrunnable/missing agents are left to the caller's existing
   * index-based handling (the remote claim/grace protocol keys on `chain[attempt]`),
   * so this only ever redirects among LOCAL, runnable agents.
   */
  private selectRung(
    chain: string[], attempt: number,
    agents: Record<string, { location: string; exec?: string; maxConcurrent?: number }>
  ): { agentId: string; index: number } {
    const head = chain[attempt];
    const hb = agents[head];
    // Only load-balance a local, runnable preferred rung; anything else keeps the
    // index so remote/skip handling upstream is untouched.
    if (!hb || hb.location !== 'local' || !hb.exec) return { agentId: head, index: attempt };
    const cooling = (id: string) => !!this.store.agentCooldownUntil(id);
    if (this.agentLoad(head) < this.agentCap(head) && !cooling(head)) return { agentId: head, index: attempt };
    // Preferred rung saturated or cooling down on a rate limit → least-loaded local
    // rung with room that isn't cooling (ties: earliest).
    let bestIdx = -1, bestSlack = 0;
    for (let i = attempt; i < chain.length; i++) {
      const b = agents[chain[i]];
      if (!b || b.location !== 'local' || !b.exec || cooling(chain[i])) continue;
      const slack = this.agentCap(chain[i]) - this.agentLoad(chain[i]);
      if (slack > bestSlack) { bestSlack = slack; bestIdx = i; }
    }
    return bestIdx >= 0 ? { agentId: chain[bestIdx], index: bestIdx } : { agentId: head, index: attempt };
  }

  /** Persistent per-task artifacts dir (survives reboot — under the repo, gitignored). */
  private artifactsDir(taskId: string): string {
    return join(this.config.paths.artifacts, taskId);
  }

  /** Ensure dsh live progress & compaction reporting patch overlay exists and return its path. */
  private ensureDshPatch(): string | undefined {
    return ensureDshPatch(this.config.paths.artifacts);
  }

  /**
   * Read `artifacts/<taskId>/progress.md` if present and non-empty, capped to the
   * last {@link Dispatcher.PROGRESS_LEDGER_MAX_BYTES} bytes (4 KB) so a long
   * ledger does not blow up the prompt while keeping the latest completed steps.
   */
  private readProgressLedger(taskId: string): string | null {
    if (!this.config.paths?.artifacts || !taskId) return null;
    const file = join(this.artifactsDir(taskId), 'progress.md');
    try {
      if (!existsSync(file)) return null;
      const raw = readFileSync(file, 'utf-8').trim();
      if (!raw) return null;
      const cap = Dispatcher.PROGRESS_LEDGER_MAX_BYTES;
      const buf = Buffer.from(raw, 'utf-8');
      if (buf.byteLength <= cap) return raw;
      return buf.subarray(buf.byteLength - cap).toString('utf-8').replace(/^\uFFFD+/, '');
    } catch {
      return null;
    }
  }

  /** Compact summary of `artifacts/<taskId>/progress.md` for timeout lessons/handovers, or null if absent. */
  private summarizeProgressLedger(taskId: string): string | null {
    const ledger = this.readProgressLedger(taskId);
    if (!ledger) return null;
    const lines = ledger.split('\n').map(l => l.trim()).filter(Boolean);
    const done = lines.filter(l => /^-\s*\[[xX]\]/.test(l));
    const last = (done[done.length - 1] || lines[lines.length - 1] || '').slice(0, 120);
    return `progress.md (${Buffer.byteLength(ledger, 'utf-8')}B, ${done.length} step(s) done${last ? `: ${last}` : ''})`;
  }

  /** True while a task still has an unanswered human-in-the-loop interaction
   *  packet (fields present and not yet `submitted`). Such a task is dispatchable
   *  only once a person has filled in the questions/checklist from the Inbox
   *  card, so their answers reach the executor via context.humanInput. */
  private awaitingHumanInput(task: Task): boolean {
    const ix = task.interaction;
    return !!ix && Array.isArray(ix.fields) && ix.fields.length > 0 && ix.status !== 'submitted';
  }

  private lastWorktreePrune = 0;
  private lastScheduledRunPurge = 0;

  private tick(): void {
    if (this.stopped || !this.workerId) return;
    const orch = this.config.orchestration;

    // heartbeat keeps the dispatcher and its live workers visible on the dashboard
    this.store.updateHeartbeat({
      workerId: this.workerId,
      status: this.running.size > 0 ? 'working' : 'idle',
      currentTask: Array.from(this.running.keys()).join(', ') || undefined
    });
    for (const r of this.running.values()) {
      if (r.workerId) {
        this.store.updateHeartbeat({ workerId: r.workerId, status: 'working' });
      }
    }

    // Each phase below is isolated in its own try/catch. Previously a throw in
    // any one (e.g. a malformed task crashing reclaimStaleClaims) aborted the rest
    // of the tick — so `releaseDueScheduled` never ran and every scheduled task due
    // that tick was silently stranded until the offending state cleared. Isolating
    // the phases guarantees scheduled releases and the pending dispatch still run
    // even when an auxiliary phase fails.

    // Launch scheduled tasks whose time has come: releaseDueScheduled flips each
    // due task into the pending pool (or onto wait-input if it still needs a
    // person's answers) BEFORE the pending scan below, so a just-due task is
    // dispatched on this very tick rather than the next one. Runs FIRST so nothing
    // upstream can defer a due task.
    try {
      for (const t of this.store.releaseDueScheduled()) {
        console.log(`Dispatcher: scheduled task ${t.id} is due (${t.scheduledAt}) — released to ${t.status} — ${t.title}`);
      }
    } catch (e) { console.error('Dispatcher: releaseDueScheduled failed this tick:', e); }

    // Flood guard: close duplicate queued runs of the same recurring task (only
    // the newest queued copy, or the one already in flight, survives).
    try {
      for (const t of this.store.collapseDuplicateScheduledRuns()) {
        console.log(`Dispatcher: closed duplicate scheduled run ${t.id} (superseded by ${t.context?.supersededBy}). Task: ${t.title}`);
      }
    } catch (e) { console.error('Dispatcher: collapseDuplicateScheduledRuns failed this tick:', e); }

    // Rescue tasks orphaned by a crashed/exited agent (runs every tick, cheap).
    try { this.reclaimStaleClaims(); }
    catch (e) { console.error('Dispatcher: reclaimStaleClaims failed this tick:', e); }

    // Advance any active Goals: for each goal whose work has finished (quiescent),
    // the Achiever agent takes one evaluate/plan/emit turn toward the criterion.
    // Auto-prune worktrees of tasks finished > 7 days ago that were never merged
    // (branch kept). Throttled to hourly.
    try {
      if (Date.now() - this.lastWorktreePrune > 3600_000) {
        this.lastWorktreePrune = Date.now();
        const n = pruneStaleWorktrees(this.store.listTasks(), t => this.store.saveTask(t));
        if (n.length) console.log(`Dispatcher: pruned ${n.length} stale worktree(s): ${n.join(', ')}`);
      }
    } catch (e) { console.error('Dispatcher: worktree prune failed this tick:', e); }

    // Auto-purge finished scheduled runs past inbox.purgeScheduledRunsAfterDays
    // (default 3d) so recurring jobs don't eat disk forever. Throttled to hourly.
    try {
      if (Date.now() - this.lastScheduledRunPurge > 3600_000) {
        this.lastScheduledRunPurge = Date.now();
        (this.store as any).purgeScheduledRuns?.();
      }
    } catch (e) { console.error('Dispatcher: scheduled-run purge failed this tick:', e); }

    try { this.driveGoals(); }
    catch (e) { console.error('Dispatcher: driveGoals failed this tick:', e); }

    // Autonomous human-input handling: for each task parked on `wait-input`, the
    // orchestrator answers the questions on the CEO's behalf and releases it —
    // so a paused task resumes without a person touching the Inbox card. Truly
    // human-only decisions are escalated honestly and left parked (see ADR-009).
    try { this.driveWaitInput(); }
    catch (e) { console.error('Dispatcher: driveWaitInput failed this tick:', e); }

    // Re-run rate-limited failures (default-on, per-task opt-out) once their window resets.
    // Independent of the concurrency gate below (it only re-queues to pending).
    try { this.autoRerunRateLimited(); }
    catch (e) { console.error('Dispatcher: autoRerunRateLimited failed this tick:', e); }

    if (this.running.size >= orch.maxConcurrent) {
      // Still annotate WHY each pending task is waiting, so the dashboard explains
      // the queue even when every execution slot is busy.
      for (const t of this.store.listTasks({ status: 'pending' })) {
        this.markPending(t, `Waiting for a free execution slot — ${this.running.size}/${orch.maxConcurrent} concurrent tasks are already running.`);
      }
      return;
    }

    // FIFO: listTasks sorts newest-first; dispatch oldest first so pipelines
    // (research -> synthesis) run in creation order.
    const pending = this.store.listTasks({ status: 'pending' }).reverse();
    for (const task of pending) {
      if (this.running.size >= orch.maxConcurrent) break;
      if (this.running.has(task.id)) continue;
      // Per-task planning is isolated: a throw while planning/routing ONE task
      // (e.g. a malformed context) must not abort the loop and strand every later
      // pending task — including scheduled tasks just released this tick.
      try {
        // Human-in-the-loop gate (defense-in-depth): a task awaiting a person's
        // answers is parked on the `wait-input` category, so it never appears in the
        // `pending` pool above and is thus never scheduled OR reassigned. This guard
        // stays as a backstop in case a task ever reaches `pending` with its
        // interaction still unanswered — running it now would leave context.humanInput
        // empty, defeating the "supply information in advance" purpose.
        if (this.awaitingHumanInput(task)) continue;
        const plan = this.planFor(task);
        switch (plan.action) {
          case 'skip':                         // manual, or unknown target
            this.markPending(task, task.tags?.includes('manual')
              ? 'Held — tagged `manual`, so it never auto-runs. Use “Run now”, or drop the manual tag, to dispatch it.'
              : 'No eligible agent to run this — its agent chain is empty, exhausted, or every rung is disabled. Edit its persona/agent targeting.');
            continue;
          case 'remote': {
            this.handleRemoteRung(task, plan.exec);
            const cooling = plan.exec?.agentId ? this.store.agentCooldownUntil(plan.exec.agentId) : undefined;
            this.markPending(task, cooling
              ? this.coolingReason(plan.exec!.agentId, cooling)
              : plan.exec?.agentId
              ? `Offered to remote agent \`${plan.exec.agentId}\` — waiting for that machine’s client to connect and claim it.`
              : 'Waiting for a remote agent’s client to connect and claim it.');
            continue;
          }
          case 'route':
            this.route(task);
            this.markPending(task, 'Routing — an agent/division is being auto-assigned; it dispatches on the next tick.');
            continue;
          case 'execute':
            // G6: context.arena fans out into N runner tasks + a judge; this task
            // becomes the synthesis step that waits on them.
            if (this.spawnArena(task)) {
              this.markPending(task, 'Arena: waiting on the runner and judge tasks it spawned.');
              continue;
            }
            // G2: an intake sharpen is still running — defer so the executor sees it.
            if (sharpenPending(task)) {
              this.markPending(task, 'Waiting (≤60 s) for the brief sharpener to add acceptance criteria.');
              continue;
            }
            if (!this.depsSatisfied(task)) {
              this.markPending(task, 'Waiting on an upstream task it depends on to finish first.');
              continue;
            }
            // Per-agent concurrency: if this agent is already at its capacity, skip
            // THIS task (don't break) so a task bound to a different, free agent can
            // still launch this tick. An agent with spare room runs the task
            // concurrently on the same instance. selectRung already steered fresh
            // dispatches toward free rungs; this backstops a pinned task or a fully
            // saturated chain.
            // A task PINNED to an agent that is cooling down on a rate limit is held
            // (running it now would only fail) until the window resets — or until
            // someone reassigns it to another agent from the dashboard.
            if (plan.exec.pinned) {
              const cooling = this.store.agentCooldownUntil(plan.exec.agentId);
              if (cooling) { this.markPending(task, this.coolingReason(plan.exec.agentId, cooling)); continue; }
            }
            if (this.agentLoad(plan.exec.agentId) >= this.agentCap(plan.exec.agentId)) {
              this.markPending(task, `Queued — agent \`${plan.exec.agentId}\` is at capacity (${this.agentLoad(plan.exec.agentId)}/${this.agentCap(plan.exec.agentId)} slots). Runs as soon as a slot frees.`);
              continue;
            }
            this.clearPending(task.id);
            this.execute(task, plan.exec).catch(e => console.error(`Dispatcher: task ${task.id} failed:`, e));
        }
      } catch (e) { console.error(`Dispatcher: planning task ${task.id} failed:`, e); }
    }
  }

  /** Pending-card note for a task held on a rate-limited agent. The dashboard keys
   *  its "Reassign" call-to-action off `context.pendingReason`, so keep the prefix. */
  private coolingReason(agentId: string, until: string): string {
    // until is a UTC ISO-8601 string; render it in the viewer's local time so the
    // pending card matches the dashboard's other rate-limit timestamps (toLocaleString).
    const localUntil = new Date(until).toLocaleString();
    return `Rate-limited — agent \`${agentId}\` is cooling down until ${localUntil}. It runs then, or use ⇄ Reassign to move it to another agent now.`;
  }

  /** A remote agent in a chain is left pending for that machine's client to
   *  claim. We PUBLISH the target agent onto `context.agent` (flagged
   *  `agentAuto` so planFor doesn't treat it as a permanent user pin) — that is
   *  the field the remote-agent client filters on to discover its tasks. If no
   *  client claims it within remoteGraceMs, advance to the next agent so a
   *  clientless remote rung can't stall the task. A pinned remote agent waits
   *  indefinitely (the CEO asked for that exact agent). */
  private handleRemoteRung(task: Task, plan?: ExecPlan): void {
    if (!plan) return;
    this.stampPersona(task, plan);   // so the remote client runs the roster persona too
    if (plan.pinned) return;
    const grace = this.config.orchestration.remoteGraceMs ?? 0;
    const ctx = task.context || {};
    const since = Number(ctx.remoteWaitSince) || 0;
    const now = Date.now();
    // First offer: publish the target agent id so its client can find + claim it.
    if (!since || ctx.agent !== plan.agentId) {
      const t = this.store.getTask(task.id);
      if (t) {
        // attempts = the rung actually offered (cooling rungs may have been skipped),
        // so a later handover advances from THIS rung.
        t.context = { ...(t.context || {}), agent: plan.agentId, agentAuto: true, remoteWaitSince: now, attempts: plan.attempt };
        this.store.saveTask(t);
      }
      return;
    }
    // Unclaimed past the grace window → advance to the next agent in the chain.
    if (grace > 0 && now - since > grace) {
      const t = this.store.getTask(task.id);
      if (t) {
        const attempts = plan.attempt + 1;
        t.context = { ...(t.context || {}), attempts, remoteWaitSince: undefined, agent: undefined, agentAuto: undefined };
        this.store.saveTask(t);
        console.log(`Dispatcher: remote rung ${plan.agentId} unclaimed ${grace}ms — advancing task ${task.id} to next agent`);
      }
    }
  }

  /** Persist the persona's full .md persona onto context.persona so a REMOTE
   *  client — which builds its own prompt from the task — runs the persona too,
   *  not just the task text. Local runs inject the persona directly (buildPrompt),
   *  so only remote rungs need this. Idempotent: skips if already current. */
  private stampPersona(task: Task, plan: ExecPlan): void {
    if (!plan.isRoster || !plan.persona) return;
    const persona = this.store.getPersona(plan.persona)?.persona;
    if (!persona || task.context?.personaPrompt === persona) return;
    const t = this.store.getTask(task.id);
    if (t) {
      t.context = { ...(t.context || {}), personaPrompt: persona, personaName: plan.persona, division: plan.division };
      this.store.saveTask(t);
      task.context = t.context;
    }
  }

  /**
   * Decide how a pending task should run.
   *   1. `manual` tag                 -> skip
   *   2. explicit `context.agent` pin -> run on exactly that agent (retries it)
   *   3. an agent (context.agent/role / tag / skill) -> run on its agent chain
   *      CHAIN at index context.attempts; on failure the handover advances to
   *      the next agent in the list. Agents registry says local (spawn here) or
   *      remote (leave in inbox for that client).
   *   4. nothing -> classify (LLM assigns an agent)
   */
  private planFor(task: Task): { action: 'skip' } | { action: 'remote'; exec?: ExecPlan } | { action: 'route' } | { action: 'execute'; exec: ExecPlan } {
    if (task.tags?.includes('manual')) return { action: 'skip' };
    const agents = this.config.orchestration.agents || {};
    const personaName = this.resolvePersona(task) || '';
    const division = typeof task.context?.division === 'string' ? task.context.division
      : (personaName && !this.isSpecial(personaName) ? this.store.getPersona(personaName)?.division : undefined);
    const attempt = Number(task.context?.attempts) || 0;

    // (2) explicit agent pin — overrides the chain, retries the same agent.
    //     `agentAuto` marks an agent the dispatcher itself published for a remote
    //     chain rung (see handleRemoteRung); that is NOT a user pin, so let it
    //     fall through to the chain logic below (which manages grace/handover).
    //     A disabled agent pin is treated as absent so the task falls through.
    // Canonicalised so a task pinned to a retired agent id before a rename still runs on it.
    const ctxAgent = typeof task.context?.agent === 'string' ? canonicalAgentId(this.config, task.context.agent) : undefined;
    if (ctxAgent && agents[ctxAgent] && !agents[ctxAgent].disabled && !task.context?.agentAuto) {
      return this.agentPlan(personaName, division, ctxAgent, agents[ctxAgent], { pinned: true, attempt, chainLen: 0 });
    }

    // (3) an agent (special or roster) → run on its resolved agent chain. The
    //     preferred rung is chain[attempt]; selectRung keeps it unless it is a
    //     saturated LOCAL agent, in which case the overflow is load-balanced onto
    //     the next local rung with spare capacity.
    if (personaName) {
      const chain = this.chainFor(personaName, division, task.context);
      if (!chain.length || attempt >= chain.length) return { action: 'skip' };  // exhausted / misconfigured
      const { agentId, index } = this.selectRung(chain, attempt, agents);
      const b = agents[agentId];
      if (!b) return { action: 'skip' };
      return this.agentPlan(personaName, division, agentId, b, { pinned: false, attempt: index, chainLen: chain.length });
    }

    // (4) unassigned → two-stage router picks division + persona.
    return { action: 'route' };
  }

  private agentPlan(
    persona: string, division: string | undefined, agentId: string,
    b: { location: string; exec?: string; model?: string; thinking?: ThinkingLevel; command?: string[] },
    meta: { pinned: boolean; attempt: number; chainLen: number }
  ): { action: 'remote'; exec?: ExecPlan } | { action: 'skip' } | { action: 'execute'; exec: ExecPlan } {
    const isRoster = !!persona && !this.isSpecial(persona);
    const label = isRoster ? `${division || '?'} / ${this.store.getPersona(persona)?.name || persona} · ${agentId}` : `${persona || 'task'} · ${agentId}`;
    const exec: ExecPlan = {
      persona, division, isRoster, agentId, attempt: meta.attempt, chainLen: meta.chainLen, pinned: meta.pinned,
      label, platform: this.platformOf(b.exec || 'hermes'),
      exec: (b.exec || 'hermes') as ExecPlan['exec'], model: b.model || '', thinking: b.thinking, command: b.command
    };
    if (b.location === 'remote') return { action: 'remote', exec };   // that machine's client claims it
    if (!b.exec) return { action: 'skip' };
    return { action: 'execute', exec };
  }

  private platformOf(exec: string): string {
    const map: Record<string, string> = { claude: 'claude', agy: 'antigravity', script: 'pipeline', codex: 'codex', ollama: 'ollama', dsh: 'dsh', hermes: 'hermes' };
    return map[exec] || 'hermes';
  }

  /** Orchestrator-facing description of the agent registry (disabled agents excluded). */
  private agentsPromptBlock(): string {
    const agents = this.config.orchestration.agents || {};
    const ids = Object.keys(agents).filter(id => !agents[id].disabled);
    if (!ids.length) return '';
    const lines = ids.map(id => {
      const b = agents[id];
      return `  - ${id} [${b.location}]: ${b.description}`;
    });
    return `Optionally target a specific AGENT (a model on a specific instance) by adding "agent":"<id>" to a subtask's context — e.g. {"role":"engineer","agent":"remote-aicodegen-cc-fable"}. LOCAL agents run here automatically; REMOTE agents are left in the inbox for that machine's client to claim. Available agents:\n${lines.join('\n')}`;
  }

  /**
   * Reclaim in-progress/claimed tasks that are no longer actually being worked.
   *
   * A local/remote agent CLIENT heartbeats continuously (keep-alive) whether or
   * not its claimed execution is still alive — so the old "claimer gone from the
   * roster" test never fired for the common failure: a client whose child CLI
   * crashed / OOM'd / finished without a complete_task call, leaving the task
   * `in-progress` forever while the client sits `idle` on the roster. (Observed:
   * a Phase-3 task stuck 3h, claimed by a live-but-idle hermes client.)
   *
   * A claim is treated as DEAD — and the task re-queued to `pending` — when it is
   * older than staleClaimMs AND any of:
   *   • the claimer has vanished from the roster (crash/exit), OR
   *   • the claimer is still on the roster but reports itself `idle` — its
   *     `running` set is empty, so it is provably not executing this (or any)
   *     task; a stranded claim, OR
   *   • the claim age exceeds the absolute ceiling hardClaimMs — a backstop for a
   *     client wedged on a hung child that keeps reporting `working` (no task
   *     legitimately runs longer than the ceiling; the dispatcher itself kills
   *     local spawns at taskTimeoutMs).
   * A task the dispatcher is running here (`this.running`) or one owned by a
   * heartbeating agent that reports `working` within the window is left alone.
   * Gated by orchestration.staleClaimMs (0 disables).
   */
  private reclaimStaleClaims(): void {
    const orch = this.config.orchestration;
    const staleMs = orch.staleClaimMs ?? 0;
    if (staleMs <= 0) return;
    const hardMs = orch.hardClaimMs && orch.hardClaimMs > 0 ? orch.hardClaimMs : Infinity;
    const active = new Map(this.store.getActiveWorkers().map(a => [a.id, a]));
    for (const t of this.store.listTasks({ status: 'in-progress' })) {
      if (this.running.has(t.id)) continue;   // this dispatcher (and its workers) owns it
      const claimAge = t.claimedAt ? Date.now() - new Date(t.claimedAt).getTime() : Infinity;
      if (claimAge <= staleMs) continue;       // give a live claimer the full grace window first
      const claimer = t.claimedBy ? active.get(t.claimedBy) : undefined;
      // Why the claim is considered dead — drives the log line and the guard.
      let reason: string | null = null;
      if (!claimer) reason = 'claimer gone';
      else if (claimer.status === 'idle') reason = 'claimer idle';   // running set empty → not working it
      else if (claimAge > hardMs) reason = `claim exceeded hard ceiling ${hardMs}ms`;
      if (!reason) continue;                    // claimer present and reports working within the window
      t.status = 'pending';
      const prevClaimer = t.claimedBy;
      delete t.claimedAt;
      delete t.claimedBy;
      t.context = { ...(t.context || {}), dispatched: false };
      this.store.saveTask(t);
      console.log(`Dispatcher: reclaimed stale task ${t.id} (${reason}: ${prevClaimer ?? '?'}) — ${t.title}`);
    }
  }

  /** The agent the router LLM runs on. Prefer the classifier config (a reliable
   *  local model dedicated to routing); otherwise the first LOCAL, runnable agent
   *  in the orchestrator/default chain. Never a remote agent (can't spawn here). */
  private routerModel(): { exec: string; model: string } {
    const orch = this.config.orchestration;
    const cls = orch.classifier;
    if (cls?.exec) return { exec: cls.exec, model: cls.model || '' };
    for (const id of [...(orch.roleChains.orchestrator?.agents || []), ...(orch.defaultChain || [])]) {
      const b = orch.agents?.[id];
      if (b?.location === 'local' && b.exec) return { exec: b.exec, model: b.model || '' };
    }
    return { exec: 'hermes', model: '' };
  }
  private askRouter(prompt: string, timeoutMs: number): Promise<string> {
    const { exec, model } = this.routerModel();
    const argv = this.buildArgv({ exec: exec as RoleConfig['exec'], model }, prompt);
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(out); }, timeoutMs);
      child.stdout.on('data', d => { out += d.toString(); });
      child.on('error', () => resolve(''));
      child.on('close', () => { clearTimeout(timer); resolve(stripAnsi(out)); });
    });
  }

  /**
   * Two-stage router: the orchestrator's agent picks a DIVISION from the roster,
   * then a specific AGENT within it. Writes context.agent (roster slug) +
   * context.division so the next tick executes it on the division's agent chain.
   * Falls back to the `generalist` special role on any failure.
   */
  private route(task: Task): void {
    const cls = this.config.orchestration.classifier;
    if (cls && cls.enabled === false) {
      // Classifier off: still pick a persona from the installed packs by keywords.
      const hit = matchPersona(`${task.title}\n${task.description}`, this.allPersonas());
      if (hit) this.assignPersona(task, hit.slug, hit.division, { personaMatch: 'keyword' });
      else this.assignPersona(task, 'generalist', undefined);
      return;
    }
    if (this.classifying.has(task.id)) return;
    this.classifying.add(task.id);
    const timeout = cls?.timeoutMs || 300000;
    const divisions = this.store.divisionIds();
    const divMeta = this.store.getDivisions() || {};

    (async () => {
      try {
        if (!divisions.length) { this.assignPersona(task, 'generalist', undefined); return; }
        // Work roles (setup-pstack port, core/work-roles.ts): the same reply also
        // names the KIND of work, which picks the tier (agents) and thinking level.
        const wr = this.config.orchestration.workRoles;
        const roles = wr?.enabled ? resolveWorkRoles(wr) : null;
        const divPrompt =
          `You route work in a multi-agent company. Pick the ONE best division for this task` +
          (roles ? `, and the ONE work role that describes it.` : `.`) + `\n\n` +
          `Task: ${task.title}\n${task.description}\n\n` +
          `Divisions:\n` + divisions.map(d => `- ${d}: ${divMeta[d]?.label || d}`).join('\n') +
          (roles ? `\n\nWork roles:\n${workRolesPromptBlock(roles)}\n\nReply with ONLY the division id and the work role id, e.g. "engineering bug-fix".`
                 : `\n\nReply with ONLY the division id.`);
        const divOut = await this.askRouter(divPrompt, timeout);
        const roleId = roles
          ? (this.pickLast(Object.keys(roles), divOut) || guessWorkRole(`${task.title}\n${task.description}`, roles))
          : undefined;
        const extra = roles && roleId ? workRoleContext(roleId, roles, task.context, wr?.budget) : {};
        const pickedDivision = this.pickLast(divisions, divOut);
        // An empty / unparseable reply used to mean divisions[0] and its first
        // persona (every task went to academic/academic-statistician while the
        // router's CLI printed nothing). Fall back to the generalist instead.
        if (!pickedDivision) {
          // LLM router silent/unparseable: match the brief against every installed
          // persona deterministically before giving up on a specialist.
          const hit = matchPersona(`${task.title}\n${task.description}`, this.allPersonas());
          if (hit) {
            console.warn(`Dispatcher: router gave no division for ${task.id} — keyword match → ${hit.division}/${hit.slug} (score ${hit.score})`);
            this.assignPersona(task, hit.slug, hit.division, { ...extra, personaMatch: 'keyword' }); return;
          }
          console.warn(`Dispatcher: router gave no division for ${task.id} (reply ${JSON.stringify(divOut.slice(0, 80))}) — generalist`);
          this.assignPersona(task, cls?.fallbackRole || 'generalist', undefined, extra); return;
        }
        const division = pickedDivision;

        const personasIn = this.store.personasInDivision(division);
        if (!personasIn.length) { this.assignPersona(task, 'generalist', undefined, extra); return; }
        const agPrompt =
          `Pick the ONE best agent in the "${division}" division for this task.\n\n` +
          `Task: ${task.title}\n${task.description}\n\n` +
          `Agents (reply with the exact slug):\n` +
          personasIn.map(a => `- ${a.slug}: ${a.name} — ${(a.description || '').slice(0, 120)}`).join('\n') +
          `\n\nReply with ONLY the slug.`;
        const agOut = await this.askRouter(agPrompt, timeout);
        const chosenSlug = this.pickLast(personasIn.map(a => a.slug), agOut)
          || matchPersona(`${task.title}\n${task.description}`, personasIn)?.slug
          || personasIn[0].slug;
        this.assignPersona(task, chosenSlug, division, extra);
      } catch {
        this.assignPersona(task, 'generalist', undefined);
      } finally {
        this.classifying.delete(task.id);
      }
    })();
  }

  /** Every installed persona (empty when the roster is unavailable). */
  private allPersonas(): PersonaCard[] {
    try { return (this.store as any).getRoster?.() || []; } catch { return []; }
  }

  /** Pick the candidate whose LAST mention in the text is latest — LLMs put the
   *  final answer last, and this avoids a stray earlier mention (e.g. "not an
   *  academic task") beating the real choice. Word-boundary, case-insensitive. */
  private pickLast(candidates: string[], text: string): string | null {
    let best: string | null = null, bestPos = -1;
    for (const c of candidates) {
      const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      let m: RegExpExecArray | null, last = -1;
      while ((m = re.exec(text))) last = m.index;
      if (last > bestPos) { bestPos = last; best = c; }
    }
    return best;
  }

  private assignPersona(task: Task, persona: string, division: string | undefined, extra: Record<string, any> = {}): void {
    const fresh = this.store.getTask(task.id);
    if (fresh && fresh.status === 'pending') {
      // Re-check against the FRESH context: a tier/thinking set while routing ran wins.
      const wr = extra.workRole ? workRoleContext(extra.workRole, resolveWorkRoles(this.config.orchestration.workRoles), fresh.context, this.config.orchestration.workRoles?.budget) : {};
      const how = extra.personaMatch || (this.isSpecial(persona) ? 'fallback' : 'router');
      fresh.context = { ...(fresh.context || {}), persona, ...(division ? { division } : {}), ...wr, routedBy: this.routerModel().model, personaMatch: how };
      this.store.saveTask(fresh);
      console.log(`Dispatcher: routed task ${task.id} -> ${division ? division + '/' : ''}${persona}` +
        (wr.workRole ? ` [${wr.workRole}${wr.tier ? ' tier=' + wr.tier : ''}${wr.thinking ? ' thinking=' + wr.thinking : ''}]` : ''));
    }
  }

  // ── Goals (the Achiever drive loop) ─────────────────────────────────────────

  /**
   * Drive active Goals. For each goal whose generated work has finished
   * (quiescent), the Achiever agent takes ONE structured turn — evaluate the
   * binary success criterion, plan the next phase, or emit a phase's worth of
   * real work — and we materialise that decision via the Goals aggregate.
   * Edge-triggered on work completing, a per-goal
   * re-entrancy guard prevents overlapping turns, and layered runaway guards
   * (self-heal, step budget, consecutive-failure abort) keep an autonomous loop
   * bounded, observable, and interruptible. The Judger half is event-driven
   * (Goals.onTaskCompleted), wired on the eventBus at startup.
   */
  private driveGoals(): void {
    if (!this.goals) return;

    // Self-heal pass, across ALL active goals: a `completing` phase with no live
    // Judger task means the taskCompleted event that should have woken the Judger
    // was dropped. Re-emit it (same spirit as reclaimStaleClaims). This runs over
    // active goals — not just quiescent ones — because a completing phase makes a
    // goal non-quiescent, so it is invisible to goalsAwaitingAchiever below.
    let active: ReturnType<Goals['activeGoals']>;
    try { active = this.goals.activeGoals(); } catch { return; }
    for (const rec of active) {
      const stuck = this.goals.phaseNeedingJudger(rec.goalId);
      if (stuck) this.goals.emitJudgerTask(rec.goalId, stuck);
    }

    // Auto-resume pass (self-healing circuit breaker, ADR-008). A blocked goal is
    // NOT a human-only dead end: once its backoff elapses we resume it for a single
    // HALF-OPEN probe, so recovery never waits on a person. We pre-seed the
    // in-memory failure counter to one-below the ceiling, so ONE more non-progress
    // turn re-opens the breaker (a true one-shot trial) while any real progress
    // clears the counter and the goal is healthy again. A budget-exhausted goal
    // re-blocks for free in the loop below (its overBudget guard fires before any
    // LLM turn), so raising the budget is all a human need do — the goal then
    // self-resumes on the next retry.
    let due: ReturnType<Goals['blockedGoalsDueForRetry']>;
    try { due = this.goals.blockedGoalsDueForRetry(); } catch { due = []; }
    for (const rec of due) {
      if (this.decidingGoals.has(rec.goalId)) continue;
      // Zero-token probe: the server checks the condition itself, and a turn fires
      // only once it passes. The next tick then sees the goal active.
      if (rec.unblockCheck) {
        const check = rec.unblockCheck;
        this.decidingGoals.add(rec.goalId);
        // An unknown agent can never become available, so that check must not hold the goal.
        runUnblockCheck(check, { agentAvailable: id => {
          const known = canonicalAgentId(this.config, id);
          return !this.config.orchestration.agents?.[known] || !this.store.agentCooldownUntil?.(known);
        } })
          .then(passed => {
            if (passed) {
              this.goals!.activate(rec.goalId, { auto: true });
              this.goalFailures.set(rec.goalId, Dispatcher.MAX_GOAL_FAILURES - 1);
            } else this.goals!.deferRetry(rec.goalId);
          })
          .catch(e => console.error(`Dispatcher: goal ${rec.goalId} unblock check failed:`, e))
          .finally(() => this.decidingGoals.delete(rec.goalId));
        continue;
      }
      try {
        this.goals.activate(rec.goalId, { auto: true });
        this.goalFailures.set(rec.goalId, Dispatcher.MAX_GOAL_FAILURES - 1);
        console.log(`Dispatcher: goal ${rec.goalId} auto-resumed for a half-open retry (block #${rec.blockCount ?? '?'})`);
      } catch (e) {
        console.error(`Dispatcher: goal ${rec.goalId} auto-resume failed:`, e);
      }
    }

    const pending = this.goals.goalsAwaitingAchiever();
    for (const rec of pending) {
      const goalId = rec.goalId;
      if (this.decidingGoals.has(goalId)) continue;

      // Runaway guard: an Achiever that never declares success can't outrun its
      // execution-task budget — BLOCK with an honest reason and a concrete unblock
      // contract (never pretend-done, and never a terminal give-up). Raising the
      // budget or narrowing the criterion, then resuming, is the recovery path.
      if (this.goals.overBudget(goalId)) {
        const cap = rec.stepBudget ?? 24;
        this.goals.block(
          goalId,
          `step budget exhausted (${cap} generated tasks) without meeting the success criterion`,
          `Raise this goal's stepBudget above ${cap} (if the criterion is genuinely reachable with more work), OR narrow the success criterion. The goal auto-retries on a backoff and self-resumes once it is back under budget — no need to click Resume. If the objective is no longer worth pursuing, delete the goal.`
        );
        this.goalFailures.delete(goalId);
        continue;
      }
      if (this.goals.overTokenBudget(goalId)) {
        this.goals.block(goalId, `token budget exhausted (${rec.tokenBudget} tokens) without meeting the success criterion`, undefined, { code: 'token_budget' });
        this.goalFailures.delete(goalId);
        continue;
      }

      const ctx = this.goals.achieverContext(goalId);
      if (!ctx) continue;

      this.decidingGoals.add(goalId);
      this.goals.setDeciding(goalId, true);
      const timeout = this.config.orchestration.classifier?.timeoutMs || 300000;
      const mode = this.achieverMode();
      const prompt = mode === 'legacy' ? this.achieverPrompt(ctx) : buildAchieverPrompt(ctx);

      (async () => {
        try {
          const turn = await this.achieverTurn(goalId, rec.achieverAgentChain, prompt, timeout);
          if (turn.held) return;   // every agent rate limited: not a failure
          // Paused, blocked or deleted during the turn: its answer no longer applies.
          if (this.goals!.get(goalId)?.status !== 'active') {
            this.goals!.logAchieverTurn(goalId, { at: new Date().toISOString(), agent: turn.agent, exec: turn.exec, mode, outcome: 'rejected',
              kind: turn.decision?.kind, reason: 'goal no longer active', usage: turn.usage, durationMs: turn.durationMs });
            return;
          }
          const decision = turn.decision;
          if (!decision) { this.registerGoalFailure(goalId, turn.why || 'no usable decision from the Achiever'); return; }
          const applied = this.goals!.applyAchieverDecision(goalId, decision);
          this.goals!.logAchieverTurn(goalId, { at: new Date().toISOString(), agent: turn.agent, exec: turn.exec, mode,
            outcome: applied.rejected ? 'rejected' : 'applied', kind: decision.kind, reason: applied.rejected, usage: turn.usage, durationMs: turn.durationMs });
          // Progress = the goal ended (achieved), the Achiever declared an honest
          // block (loop resolved, recoverable), a phase was planned, or work was
          // emitted. An evaluate(met:false) that neither advances nor emits is NO
          // progress — count it so a stuck goal can't spin on empty evaluations.
          const progressed = applied.achieved || applied.blocked || applied.planned || (applied.emitted ?? 0) > 0;
          if (progressed) this.goalFailures.delete(goalId);
          else this.registerGoalFailure(goalId, applied.rejected || `Achiever turn made no progress (kind=${decision.kind})`);
        } catch (e) {
          console.error(`Dispatcher: goal ${goalId} Achiever turn failed:`, e);
        } finally {
          this.decidingGoals.delete(goalId);
          this.goals!.setDeciding(goalId, false);
        }
      })();
    }
  }

  /** Count a non-progressing Achiever turn; BLOCK the goal (honest reason + a
   *  concrete resume contract) once the consecutive-failure ceiling is hit. This
   *  ceiling most often trips on TRANSIENT infrastructure faults (the Achiever
   *  agent offline, overloaded, or returning unparseable output), so the goal is
   *  held recoverably — not abandoned — and the drive loop AUTOMATICALLY resumes
   *  it on a backoff for a clean HALF-OPEN retry (circuit-breaker OPEN → HALF-OPEN,
   *  ADR-008): a transient blip self-heals in minutes with no human. */
  private registerGoalFailure(goalId: string, why: string): void {
    const n = (this.goalFailures.get(goalId) || 0) + 1;
    this.goalFailures.set(goalId, n);
    console.error(`Dispatcher: goal ${goalId} — ${why} (attempt ${n}/${Dispatcher.MAX_GOAL_FAILURES})`);
    if (n >= Dispatcher.MAX_GOAL_FAILURES) {
      this.goalFailures.delete(goalId);
      this.goals?.block(goalId, `Achiever made no usable progress (${why}) — goal held, NOT completed`, undefined, { code: 'achiever_no_progress' });
    }
  }

  /** Add one run's usage to task.context.usage (retries sum). A run that reported
   *  nothing is marked not metered, so it is never mistaken for zero tokens. */
  private recordRunUsage(taskId: string, agentId: string | undefined, usage: RunUsage | null, arm?: string): void {
    try {
      const t = this.store.getTask?.(taskId);
      if (!t) return;
      const prior = t.context?.usage;
      const merged = !usage
        ? (prior?.input !== undefined ? prior : { metered: false, agent: agentId })
        : {
            input: usage.input + (prior?.input || 0), cacheRead: usage.cacheRead + (prior?.cacheRead || 0),
            cacheWrite: usage.cacheWrite + (prior?.cacheWrite || 0), output: usage.output + (prior?.output || 0),
            turns: (usage.turns || 0) + (prior?.turns || 0),
            ...(usage.costUsd !== undefined || prior?.costUsd !== undefined ? { costUsd: (usage.costUsd || 0) + (prior?.costUsd || 0) } : {}),
            agent: agentId, runs: (prior?.runs || 0) + 1
          };
      t.context = { ...(t.context || {}), usage: merged, ...(arm ? { usageArm: arm } : {}) };
      this.store.saveTask(t);
    } catch (e) { console.warn(`Dispatcher: could not record usage for ${taskId}:`, e); }
  }

  private readHermesUsage(file: string | null): RunUsage | null {
    if (!file) return null;
    try {
      return flatUsage(JSON.parse(readFileSync(file, 'utf-8')));
    } catch { return null; } finally { rmSync(file, { force: true }); }
  }

  private achieverMode(): 'toolless' | 'legacy' {
    return this.config.orchestration.goals?.achieverMode === 'legacy' ? 'legacy' : 'toolless';
  }

  /** The agents an Achiever turn may use, in order: the chain's local, runnable
   *  members. With no chain, a default-chain claude agent and then the router agent:
   *  the prompt embeds untrusted task results, claude is the one exec that can run it
   *  with no tools at all, and one broken agent must not stall every unpinned goal.
   *  Remote agents execute tasks, not this. */
  private achieverAgents(chain?: string[]): { id?: string; exec: string; model: string }[] {
    const orch = this.config.orchestration;
    const agents = orch.agents || {};
    const runnable = (ids: string[]) => ids.map(id => canonicalAgentId(this.config, id)).filter(id => {
      const b = agents[id];
      return b?.location === 'local' && b.exec && !b.disabled;
    }).map(id => ({ id, exec: agents[id].exec as string, model: agents[id].model || '' }));
    const pinned = runnable(chain || []);
    if (pinned.length) return pinned;
    const router = this.routerModel();
    if (chain?.length) return [router];   // pinned to agents that cannot run here
    return [...runnable(orch.defaultChain || []).filter(b => b.exec === 'claude').slice(0, 1), router];
  }

  /**
   * One Achiever turn. Walks the chain past cooling and rate-limited agents. A
   * rate-limit reply is not a bad decision, so it counts as nothing: if the whole
   * chain is cooling the goal is held until the earliest reset with no spawn, no
   * failure and no block row. An empty or unusable reply moves on to the next agent
   * too, and counts as a failure only once the chain is exhausted. Every attempt is
   * logged, with the raw reply when it could not be used, because a failure cannot be
   * diagnosed from a log line alone.
   */
  private async achieverTurn(goalId: string, chain: string[] | undefined, prompt: string, timeoutMs: number): Promise<{
    decision?: AchieverDecision | null; held?: boolean; why?: string; agent?: string; exec?: string; usage?: RunUsage | null; durationMs?: number;
  }> {
    const log = (t: Omit<AchieverTurn, 'at' | 'mode'>) => this.goals!.logAchieverTurn(goalId, { at: new Date().toISOString(), mode: this.achieverMode(), ...t });
    const resets: string[] = [];
    let failed: { why: string; agent?: string; exec?: string; usage?: RunUsage | null; durationMs?: number } | undefined;
    for (const agent of this.achieverAgents(chain)) {
      const cooling = agent.id ? this.store.agentCooldownUntil?.(agent.id) : undefined;
      if (cooling) { resets.push(cooling); continue; }
      const started = Date.now();
      const reply = await this.askAchieverAgent(agent, prompt, timeoutMs);
      const durationMs = Date.now() - started;
      const decision = this.parseAchieverDecision(reply.text);
      const base = { agent: agent.id || agent.model, exec: agent.exec, usage: reply.usage, durationMs };
      if (decision) return { decision, ...base };
      // Checked only after parsing, so a real decision that mentions a rate limit counts as a decision.
      // Some CLIs report a 429 only on stderr.
      if (isRateLimitFailure(reply.text.trim() ? reply.text : reply.stderr || '')) {
        const until = agent.id ? this.store.noteAgentRateLimited?.(agent.id) : undefined;
        resets.push(until || new Date(Date.now() + 15 * 60_000).toISOString());
        log({ ...base, outcome: 'rate-limited', raw: reply.text });
        continue;
      }
      const why = reply.timedOut ? 'Achiever turn timed out' : reply.text.trim() ? 'unparseable reply' : 'empty reply';
      log({ ...base, outcome: reply.timedOut ? 'timeout' : 'unparseable', reason: why, raw: reply.text.trim() ? reply.text : reply.stderr });
      failed = { why, ...base };
    }
    if (failed) return failed;
    if (resets.length) {
      const until = resets.sort()[0];
      this.goals!.holdForRateLimit(goalId, until);
      return { held: true };
    }
    return { why: 'no Achiever agent available' };
  }

  /** argv for one Achiever turn. Only claude is truly tool-free. hermes gets its
   *  narrowest toolset and a usage report, but it has no flag that removes MCP tools
   *  (--safe-mode also drops its provider), so its turn can still call those. */
  private achieverArgv(agent: { exec: string; model: string }, prompt: string, usageFile: string | null): string[] {
    if (this.achieverMode() === 'toolless') {
      if (agent.exec === 'claude') return this.reasonArgv(agent.model, prompt);
      if (agent.exec === 'hermes') return ['hermes', ...(agent.model ? ['-m', agent.model] : []), '-z', prompt, '-t', 'clarify', ...(usageFile ? ['--usage-file', usageFile] : [])];
    }
    return this.buildArgv({ exec: agent.exec as RoleConfig['exec'], model: agent.model }, prompt);
  }

  /** Run one reasoning call for the Achiever on a specific agent. */
  private askAchieverAgent(agent: { exec: string; model: string }, prompt: string, timeoutMs: number): Promise<{ text: string; usage?: RunUsage | null; timedOut?: boolean; stderr?: string }> {
    const lean = this.achieverMode() === 'toolless' && (agent.exec === 'claude' || agent.exec === 'hermes');
    const toolless = lean && agent.exec === 'claude';
    const usageFile = lean && agent.exec === 'hermes' ? join(tmpdir(), `cowork-achiever-usage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`) : null;
    const argv = this.achieverArgv(agent, prompt, usageFile);
    const graceMs = this.config.orchestration?.killGraceMs ?? 5000;
    // A fresh empty cwd per turn: no project CLAUDE.md loads, and no earlier run can
    // leave settings or hooks there for this one to pick up.
    const scratch = lean ? mkdtempSync(join(tmpdir(), 'cowork-achiever-')) : null;
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        env: lean ? { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : { ...process.env },
        ...(scratch ? { cwd: scratch } : {}),
        // Its own process group, so a timeout can kill the whole tree.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      let timedOut = false;
      let done = false;
      const finish = (r: { text: string; usage?: RunUsage | null }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(giveUp);
        if (scratch) rmSync(scratch, { recursive: true, force: true });
        if (usageFile) rmSync(usageFile, { force: true });
        resolve({ ...r, timedOut, stderr: err });
      };
      let giveUp: ReturnType<typeof setTimeout>;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) void killProcessTree(child.pid, { graceMs });
        // A survivor holding the pipe open must not leave this turn in flight forever.
        giveUp = setTimeout(() => finish({ text: stripAnsi(out) }), graceMs + 1000);
      }, timeoutMs);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { if (err.length < 2000) err += d.toString().slice(0, 2000 - err.length); });
      child.on('error', () => finish({ text: '' }));
      child.on('close', () => {
        const clean = stripAnsi(out);
        if (usageFile) { void this.hermesAchieverReply(usageFile, clean).then(finish); return; }
        if (!toolless) return finish({ text: clean });
        // --output-format json: one object with the answer and its usage.
        try {
          const ev = JSON.parse(clean);
          finish({ text: typeof ev.result === 'string' ? ev.result : '', usage: claudeUsage(ev) });
        } catch { finish({ text: clean }); }
      });
    });
  }

  /**
   * hermes -z can finish a turn, store the reply in its session, and still print
   * nothing (exit 1 with `completed: true`). The usage report names the session, so
   * the reply is read back from there instead of wasting the turn.
   */
  private async hermesAchieverReply(usageFile: string, stdout: string): Promise<{ text: string; usage: RunUsage | null }> {
    let report: any = null;
    try { report = JSON.parse(readFileSync(usageFile, 'utf-8')); } catch { /* no report */ }
    rmSync(usageFile, { force: true });
    const usage = flatUsage(report);
    if (stdout.trim() || !report?.completed || typeof report.session_id !== 'string') return { text: stdout, usage };
    const exportFile = `${usageFile}.session.jsonl`;
    try {
      await new Promise<void>((ok, fail) => execFile('hermes', ['sessions', 'export', '--session-id', report.session_id, '--format', 'jsonl', exportFile, '--yes'],
        { timeout: 20_000 }, e => (e ? fail(e) : ok())));
      return { text: lastAssistantText(readFileSync(exportFile, 'utf-8')), usage };
    } catch (e) {
      console.warn('Dispatcher: could not read the hermes session back:', e);
      return { text: '', usage };
    } finally { rmSync(exportFile, { force: true }); }
  }

  /** argv for a pure reasoning call on claude. The prompt embeds task results, which
   *  are untrusted text, so it gets no tools, no MCP and no permission bypass. */
  private reasonArgv(model: string, prompt: string): string[] {
    return ['claude', '-p', prompt, ...(model ? ['--model', model] : []), '--tools', '', '--strict-mcp-config',
      '--setting-sources', 'project,local', '--output-format', 'json'];
  }


  /** The prompt the Achiever agent answers each turn. It frames the criterion as
   *  a strict Yes/No gate and constrains the reply to a single fenced-JSON
   *  decision (evaluate | plan | emit). */
  private achieverPrompt(ctx: NonNullable<ReturnType<Goals['achieverContext']>>): string {
    const rec = ctx.record;
    const lines: string[] = [];
    lines.push(`You are the GOAL ACHIEVER driving a long-lived objective toward a BINARY success criterion. Take exactly ONE move this turn.`, '');
    lines.push(`GOAL: ${rec.title}`);
    if (rec.description) lines.push(`DETAILS: ${rec.description}`);
    lines.push(`SUCCESS CRITERIA (strict Yes/No): ${ctx.successCriteria}`);
    lines.push(`BUDGET: ${ctx.budget.used}/${ctx.budget.cap} execution tasks used.`, '');
    lines.push(`PHASES:`);
    for (const ph of ctx.phases) {
      lines.push(`- ${ph.key} [${ph.status}]: ${ph.title}`);
      for (const r of ph.results) {
        const res = (r.result || '').replace(/\s+/g, ' ').slice(0, 300);
        lines.push(`    · ${r.title} [${r.status}]${res ? ` → ${res}` : ''}`);
      }
    }
    if (ctx.latestMinutes) lines.push('', `Latest Judger minutes: ${ctx.latestMinutes}`);
    lines.push('', `Current workable phase: ${ctx.currentPhaseKey || '(none — plan one)'}`, '');
    lines.push(
      `Reply with ONLY one fenced JSON block describing your single move:`,
      '```json',
      `{ "kind": "evaluate", "met": true|false, "reason": "evidence the criterion is/ isn't met" }`,
      `// OR`,
      `{ "kind": "plan", "phase": { "key": "kebab-case", "title": "..." }, "reason": "why this phase next" }`,
      `// OR`,
      `{ "kind": "emit", "tasks": [ { "title": "...", "description": "the standalone brief", "scheduledAt": "ISO-8601 (optional, future)" } ], "reason": "..." }`,
      `// OR`,
      `{ "kind": "block", "reason": "the concrete obstacle you cannot clear yourself", "unblockCriteria": "the specific, checkable condition that must hold to resume" }`,
      '```',
      FIGURE_IT_OUT_RULES,
      '',
      `Rules: answer evaluate{met:true} ONLY when the criteria are genuinely met (this ENDS the goal). Emit the current phase's real work as a small batch — the last task automatically completes the phase and triggers the Judger. Do not repeat completed work. If no phase is workable, plan one.`,
      '',
      `EXECUTE, don't just describe: producing a PLAN, ANALYSIS, STRATEGY, REPORT, or SUMMARY is NOT achieving the goal — it is at most the setup for the task that does. When the goal is to build / ship / optimize / automate / grow something, it is met ONLY once that work has actually been CARRIED OUT and then VERIFIED — by a test, a review, or a real check that actually ran and passed (a live URL that loads, a green run, a dated snapshot read from the real source). So the tasks you emit must be the real work itself ("build X", "change Y", "run Z", "deploy", "publish"), and every batch of execution must be followed — this phase or the next — by a concrete verification/test/review task that proves it works. NEVER emit only planning or reporting tasks, and NEVER answer evaluate{met:true} while any build, execution, integration, or verification step is still unrun. If the only thing that has happened so far is that plans and reports were written, the goal is NOT met — emit the execution work now.`,
      `Act on the Judger, don't archive it: the Judger's report and minutes above are a MANAGER'S DECISION about what to do next, not a deliverable to file and stop on. Read the latest minutes' recommended next move and DO it this turn — emit the specific work it points to, plan the phase it names, or evaluate if it says the criterion is genuinely met with evidence. Bypassing that recommendation to write another summary is the failure mode that stalls goals; keep the loop moving toward real, verified execution.`,
      '',
      `Waiting on the real world: when the next honest move is to LET TIME PASS (a month of revenue, a cohort of traffic, an indexing window), do not burn turns re-evaluating. Emit the measurement task with a future "scheduledAt". The goal then sleeps — no turns, no budget — until that checkpoint fires. This is the correct move, not a stall.`,
      `Persistence: a criterion that is not yet met is NEVER a reason to stop. If a phase's results disappointed, plan the next phase with a DIFFERENT approach informed by the Judger's minutes above — do not repeat the approach that underperformed.`,
      `Blocking honestly: if — and only if — you hit a real obstacle you cannot clear yourself (a missing credential, an external dependency, a decision only a human can make, a criterion that has become impossible), return kind:"block" with a precise unblockCriteria. A blocked goal is HELD, not abandoned, and it is SELF-HEALING: it stops spending turns and budget, then the system auto-resumes it for a fresh probe on a backoff (minutes at first, later hours), so it recovers on its own the moment the obstacle clears — no human click required. Make unblockCriteria a concrete, checkable condition so that probe can tell whether to proceed. Prefer block over spinning: an evaluate{met:false} that neither plans nor emits counts as no progress, and enough of those will block the goal automatically with a generic reason — declaring the block yourself, with a specific unblockCriteria, is always better.`
    );
    return lines.join('\n');
  }

  /** Tolerant parser for the Achiever's structured decision (ADR-002): pull the
   *  last JSON object out of the reply (fenced or bare) and validate its shape.
   *  Returns null on anything unusable so the caller retries / eventually aborts
   *  rather than silently mis-applying a move. */
  private parseAchieverDecision(text: string): AchieverDecision | null {
    if (!text || !text.trim()) return null;
    const candidates: string[] = [];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi);
    if (fenced) for (const f of fenced) candidates.push(f.replace(/```(?:json)?/i, '').replace(/```$/, ''));
    // Also try the last balanced-looking {...} in the raw text as a fallback.
    const braceMatches = text.match(/\{[\s\S]*\}/g);
    if (braceMatches) candidates.push(braceMatches[braceMatches.length - 1]);
    for (const c of candidates.reverse()) {
      try {
        const obj = JSON.parse(c.trim());
        if (!obj || typeof obj !== 'object') continue;
        if (obj.kind === 'evaluate' && typeof obj.met === 'boolean') return obj as AchieverDecision;
        if (obj.kind === 'plan' && obj.phase && obj.phase.key) return obj as AchieverDecision;
        if (obj.kind === 'emit' && Array.isArray(obj.tasks) && obj.tasks.length) return obj as AchieverDecision;
        if (obj.kind === 'block' && typeof obj.reason === 'string' && obj.reason.trim()) return obj as AchieverDecision;
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  /**
   * Autonomous human-input handling (ADR-009). The sibling of driveGoals(): for
   * each task parked on `wait-input`, the orchestrator agent answers the pending
   * questions ON THE CEO's BEHALF and submits them via store.submitInteraction —
   * releasing the task back to `pending` without a person filling in the Inbox
   * card. A per-task re-entrancy guard prevents overlapping turns, and a per-task
   * attempt counter (context.autoAnswer.count, persisted so it survives restarts)
   * bounds the loop: after maxAttempts consecutive auto-answers the task is left
   * for a real human — a task that keeps re-asking is genuinely undecidable by the
   * orchestrator, and leaving it parked is the honest fallback (never a fabricated
   * answer). The orchestrator may also ESCALATE a single decision it judges
   * human-only (a browser OAuth re-auth, spending money, an owner-only toggle,
   * anything irreversible/legal); that task stays parked with the reason recorded.
   *
   * Opt-in via orchestration.autoAnswer.enabled. A task tagged `human-only` (or
   * `manual`) is never auto-answered — the CEO's explicit escape hatch to force a
   * decision back to themselves.
   */
  private driveWaitInput(): void {
    const cfg = this.config.orchestration.autoAnswer;
    if (!cfg?.enabled) return;
    const maxAttempts = cfg.maxAttempts ?? Dispatcher.MAX_AUTO_ANSWERS;
    const chain = (cfg.agents && cfg.agents.length)
      ? cfg.agents
      : this.config.orchestration.roleChains?.orchestrator?.agents;
    const timeout = cfg.timeoutMs || this.config.orchestration.classifier?.timeoutMs || 300000;

    let parked: Task[];
    try { parked = this.store.listTasks({ status: 'wait-input' }); } catch { return; }
    for (const task of parked) {
      if (this.decidingInput.has(task.id)) continue;
      const ix = task.interaction;
      if (!ix || !Array.isArray(ix.fields) || ix.fields.length === 0) continue;
      if (ix.status === 'submitted') continue;
      // Explicit human-only escape hatch: the CEO can force a decision to wait for
      // them by tagging the task, and an already-escalated task stays put.
      if (task.tags?.includes('human-only') || task.tags?.includes('manual')) continue;
      const meta = (task.context?.autoAnswer as { count?: number; escalated?: boolean } | undefined) || {};
      if (meta.escalated) continue;
      const count = Number(meta.count) || 0;
      if (count >= maxAttempts) continue;   // ceiling hit — left for a real human

      this.decidingInput.add(task.id);
      const prompt = this.autoAnswerPrompt(task);
      const fieldIds = ix.fields.map(f => f.id);
      (async () => {
        try {
          const out = await this.askExecutor(chain, prompt, timeout);
          const decision = this.parseAutoAnswer(out, fieldIds);
          if (!decision) {
            console.error(`Dispatcher: auto-answer for task ${task.id} — no usable decision from the orchestrator (timeout or unparseable)`);
            return;   // no counter bump on an infra blip; retried next tick
          }
          // Re-read: the task may have been answered by a human in the meantime.
          const fresh = this.store.getTask(task.id);
          if (!fresh || fresh.status !== 'wait-input' || fresh.interaction?.status === 'submitted') return;

          if (decision.escalate) {
            fresh.context = {
              ...(fresh.context || {}),
              autoAnswer: { ...meta, escalated: true, escalateReason: decision.reason || 'human-only decision' }
            };
            this.store.saveTask(fresh);
            console.log(`Dispatcher: auto-answer ESCALATED task ${task.id} to a human — ${decision.reason || 'human-only decision'}`);
            return;
          }

          // Persist the attempt counter BEFORE releasing, so the resumed task
          // carries the bumped count if it parks again this same tick.
          fresh.context = {
            ...(fresh.context || {}),
            autoAnswer: {
              ...meta, count: count + 1,
              // P2-3: kept for the decision trail (rulings.tsv) on completion.
              decisions: logAutoAnswer((meta as any).decisions, { at: new Date().toISOString(), answer: describeAutoAnswer(ix.fields, decision.answers) })
            }
          };
          this.store.saveTask(fresh);
          const updated = this.store.submitInteraction({
            taskId: task.id,
            responses: decision.answers,
            submittedBy: 'orchestrator (auto-answer)'
          });
          if (updated) {
            console.log(`Dispatcher: auto-answered task ${task.id} on the CEO's behalf (attempt ${count + 1}/${maxAttempts}) — released to ${updated.status}`);
          }
        } catch (e) {
          console.error(`Dispatcher: auto-answer for task ${task.id} failed:`, e);
        } finally {
          this.decidingInput.delete(task.id);
        }
      })();
    }
  }

  /** The prompt the orchestrator answers to fill a paused task's questions on the
   *  CEO's behalf. It frames the orchestrator as the CEO's delegate, gives it the
   *  full task context, and constrains the reply to one fenced-JSON decision:
   *  either the answers keyed by field id, or an honest escalation. */
  private autoAnswerPrompt(task: Task): string {
    const ix = task.interaction!;
    const lines: string[] = [];
    lines.push(
      `You are the ORCHESTRATOR acting as the CEO's fully-authorised delegate. A task has PAUSED to ask the user (the CEO) questions before it can finish. Answer them ON THE CEO's BEHALF so the work resumes automatically — the CEO does not want to answer these manually.`,
      ''
    );
    lines.push(`TASK: ${task.title}`);
    if (task.description) lines.push(`BRIEF: ${task.description}`);
    if (task.tags?.length) lines.push(`TAGS: ${task.tags.join(', ')}`);
    const prior = task.context?.humanInput as Record<string, unknown> | undefined;
    if (prior && Object.keys(prior).length) {
      lines.push('', 'ANSWERS ALREADY GIVEN in earlier rounds (do not contradict; build on them):');
      for (const [k, v] of Object.entries(prior)) lines.push(`  - ${k}: ${String(v)}`);
    }
    if (task.result) {
      lines.push('', `WHAT THE AGENT PRODUCED / SAID before pausing (context for the questions):`);
      lines.push((task.result || '').replace(/\s+/g, ' ').slice(0, 1500));
    }
    lines.push('', 'QUESTIONS TO ANSWER (answer each by its id):');
    for (const f of ix.fields) {
      const opts = f.options?.length ? ` [choose one: ${f.options.join(' | ')}]` : '';
      const kind = f.type === 'checkbox' ? ' [yes/no → true/false]' : '';
      lines.push(`  - ${f.id}${f.required ? ' (required)' : ''}: ${f.label}${opts}${kind}`);
    }
    lines.push(
      '',
      'Reply with ONLY one fenced JSON block:',
      '```json',
      '{ "answers": { "q1": "your decision on the CEO\'s behalf", "q2": "..." } }',
      '// OR, only when the decision is genuinely one a human MUST make in person:',
      '{ "escalate": true, "reason": "why this needs the human specifically" }',
      '```',
      'Rules:',
      '- DECIDE. You have full authority over strategy, priorities, defaults, naming, scope, and reversible choices. Pick the sensible default a competent CEO would pick and move the work forward — do not hedge or ask back.',
      '- Answer EVERY required field. Use each field\'s id as the key. For a yes/no (checkbox) field answer with true or false; for a choose-one field pick exactly one of the listed options verbatim.',
      '- ESCALATE (do not fabricate) ONLY for a decision a human must physically make or that is irreversible/high-stakes: a browser OAuth re-auth, entering a password/2FA, spending real money or approving a fee, an owner-only console toggle (e.g. enabling GitHub Pages), signing a legal/financial commitment, or deleting production data. You cannot click a browser button or spend money, so answering those would be a lie. Everything else you decide.',
      '- Be concrete and specific — your answer goes straight back into the task as the CEO\'s instruction.'
    );
    return lines.join('\n');
  }

  /** Tolerant parser for the orchestrator's auto-answer decision: pull the JSON
   *  out (fenced or bare) and validate it either escalates or answers at least one
   *  known field id. Coerces checkbox-style booleans through as-is. Returns null on
   *  anything unusable so the caller retries rather than mis-submitting. */
  private parseAutoAnswer(text: string, fieldIds: string[]):
    | { escalate: true; reason?: string }
    | { escalate: false; answers: Record<string, string | boolean> }
    | null {
    if (!text || !text.trim()) return null;
    const candidates: string[] = [];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi);
    if (fenced) for (const f of fenced) candidates.push(f.replace(/```(?:json)?/i, '').replace(/```$/, ''));
    const braceMatches = text.match(/\{[\s\S]*\}/g);
    if (braceMatches) candidates.push(braceMatches[braceMatches.length - 1]);
    for (const c of candidates.reverse()) {
      try {
        const obj = JSON.parse(c.trim());
        if (!obj || typeof obj !== 'object') continue;
        if (obj.escalate === true) return { escalate: true, reason: typeof obj.reason === 'string' ? obj.reason : undefined };
        const raw = obj.answers;
        if (raw && typeof raw === 'object') {
          const answers: Record<string, string | boolean> = {};
          for (const id of fieldIds) {
            if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
            const v = raw[id];
            if (typeof v === 'boolean') answers[id] = v;
            else if (v !== undefined && v !== null) answers[id] = String(v);
          }
          if (Object.keys(answers).length) return { escalate: false, answers };
        }
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  /** Run a named agent CHAIN's first LOCAL, spawnable agent for a reasoning call
   *  (the Achiever's turn). Generalises askRouter, which is pinned to the router
   *  agent; falls back to the router agent if the chain has no local member (its
   *  remote agents are for executing generated tasks, not reasoning here). */
  private askExecutor(chain: string[] | undefined, prompt: string, timeoutMs: number): Promise<string> {
    const { exec, model } = this.execForChain(chain);
    const argv = this.buildArgv({ exec: exec as RoleConfig['exec'], model }, prompt);
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(out); }, timeoutMs);
      child.stdout.on('data', d => { out += d.toString(); });
      child.on('error', () => resolve(''));
      child.on('close', () => { clearTimeout(timer); resolve(stripAnsi(out)); });
    });
  }

  /** First LOCAL, runnable, enabled agent in the given chain; else the router agent. */
  private execForChain(chain?: string[]): { exec: string; model: string } {
    const orch = this.config.orchestration;
    for (const id of chain || []) {
      const b = orch.agents?.[id];
      if (b?.location === 'local' && b.exec && !b.disabled) return { exec: b.exec, model: b.model || '' };
    }
    return this.routerModel();
  }

  /** G6: expand `context.arena` into runner + judge child tasks once. Returns
   *  true when this task now waits on spawned children. */
  private spawnArena(task: Task): boolean {
    const spec = parseArena(task.context?.arena);
    if (!spec || task.context?.arenaChildren) return false;
    const agents = this.config.orchestration.agents || {};
    const runnerAgents = pickArenaAgents(spec.runners, this.config.orchestration.tiers, agents, id => agentFamily(agents[id], id));
    if (runnerAgents.length < 2) return false;     // not enough agents: run as a normal task
    const plan = arenaPlan(task, spec, runnerAgents);
    const from = task.from;
    const runners = plan.runners.map(r => this.store.createTask({ ...r, from, priority: task.priority } as any));
    const judge = this.store.createTask({ ...plan.judge, from, priority: task.priority, context: { ...plan.judge.context, dependsOn: runners.map(r => r.id) } } as any);
    const fresh = this.store.getTask(task.id) || task;
    const prevDeps = Array.isArray(fresh.context?.dependsOn) ? fresh.context!.dependsOn as string[] : [];
    fresh.context = { ...(fresh.context || {}), arenaChildren: { runners: runners.map(r => r.id), judge: judge.id }, arenaRole: 'synthesis',
      dependsOn: [...prevDeps, ...runners.map(r => r.id), judge.id] };
    fresh.description = `${fresh.description || fresh.title}\n\n[arena synthesis] Combine the best of the runner results using the judge's scores (dependency results below). Name the winner and every runner by id.`;
    this.store.saveTask(fresh);
    task.context = fresh.context; task.description = fresh.description;
    console.log(`Dispatcher: arena for ${task.id} → runners ${runners.map(r => r.id).join(',')} judge ${judge.id}`);
    return true;
  }

  /** PR automation hook: a result that opened a PR sets context.prUrl and, when
   *  orchestration.prAutomation covers the repo, spawns one recurring pr-watch task. */
  private notePrUrls(task: Task, text: string): void {
    if (task.context?.prWatch) return;              // the watcher itself mentions the PR
    const refs = extractPrUrls(text);
    if (!refs.length) return;
    task.context = { ...(task.context || {}), prUrl: refs[0].url, ...(refs.length > 1 ? { prUrls: refs.map(r => r.url) } : {}) };
    const cfg = this.config.orchestration.prAutomation;
    for (const ref of openedPrUrls(text)) {          // only PRs this task says it opened
      if (!prInScope(ref, cfg)) continue;
      const exists = this.store.listTasks({}).some(t => t.context?.prWatch && t.context?.prUrl === ref.url && t.status !== 'done');
      if (exists) continue;
      const spec = prWatchTaskSpec(ref, task, cfg);
      try { this.store.createTask({ ...spec, from: task.from, priority: 'normal' } as any); }
      catch (e) { console.error(`Dispatcher: could not create pr-watch for ${ref.url}:`, e); }
    }
  }

  /**
   * `context.dependsOn: ["<task-id>", …]` gates dispatch until every listed
   * task is done. For gated steps (P1-2), downstream steps also wait
   * until the step's review→fix gate reaches `approved` or `ruled` (while the
   * gate's own review task `context.gateReviewFor === id` is allowed to run
   * immediately once the step itself finishes).
   */
  private depsSatisfied(task: Task): boolean {
    const deps = task.context?.dependsOn;
    if (!Array.isArray(deps) || deps.length === 0) return true;
    return deps.every((id: string) => {
      const dep = this.store.getTask(id);
      if (!dep || dep.status !== 'done') return false;
      if (task.context?.gateReviewFor === id) return true;
      const gate = dep.context?.gate as { status?: string } | undefined;
      if (gate && typeof gate === 'object') {
        return gate.status === 'approved' || gate.status === 'ruled';
      }
      return true;
    });
  }

  /** The operating rules every executing agent must follow (CONVENTIONS.md at the
   *  repo root). Read once and cached — injected into every dispatched prompt so a
   *  agent cannot run without them. */
  private conventionsCache: string | null = null;
  private claudeProfile = new ClaudeProfile();
  private conventions(): string {
    if (this.conventionsCache !== null) return this.conventionsCache;
    const file = join(this.config.paths.artifacts, '..', 'CONVENTIONS.md');
    try { this.conventionsCache = readFileSync(file, 'utf-8').trim(); }
    catch { this.conventionsCache = ''; }
    return this.conventionsCache;
  }

  private buildPrompt(task: Task, plan: { persona: string; division?: string; isRoster: boolean; exec?: string; agentId?: string }): string {
    const port = this.config.server.port;
    // Self-referential API base for orchestrator subtask dispatch. Loopback
    // calls to localhost run over plain HTTP (handled by the multiplexed server),
    // which is fast, secure (kernel loopback), and immune to TLS cert hostname
    // mismatch (e.g. Let's Encrypt FQDNs).
    const selfBase = `http://localhost:${port}`;
    // With an API key the child gets it as $COWORK_API_KEY (see runTask env) and
    // the curl references the variable, so the key never lands in the prompt.
    const curlFlags = '-s'
      + (this.config.server.apiKey ? ' -H "Authorization: Bearer $COWORK_API_KEY"' : '');
    const role = plan.persona;
    const artifactsDir = this.artifactsDir(task.id);
    const lines: string[] = [];
    const rules = this.conventions();
    if (rules) lines.push(rules, ``, `---`, ``);
    if (plan.isRoster) {
      // Run the persona's full .md persona as the system prompt.
      const p = this.store.getPersona(plan.persona);
      // ollama agents have no file tools, so they could not follow the brief's
      // pointer to the rest of the persona: give them the full text.
      const persona = p && this.config.orchestration.personaMode !== 'full' && plan.exec !== 'ollama'
        ? briefPersona(p.persona, p.sourcePath).text
        : p?.persona;
      lines.push(persona || `You are the "${plan.persona}" specialist.`, ``, `---`, ``);
      lines.push(`You have been assigned the following task. Work autonomously and produce your final deliverable as plain text (markdown allowed).`, ``);
    } else {
      lines.push(`You are the "${role}" agent in a multi-agent company. Work autonomously and produce your final deliverable as plain text output.`, ``);
    }
    lines.push(`# Task: ${task.title}`, ``, task.description, ``);
    const shownCtx = { ...(task.context || {}) } as Record<string, unknown>;
    // inputFiles is rendered as its own section with readable paths (below), and
    // humanInput as a dedicated "answers" section (below), and the brief fields
    // as their own sections — drop them from the raw context dump so they aren't
    // duplicated or lost as noise in the JSON blob.
    for (const k of ['personaPrompt', 'agentAuto', 'remoteWaitSince', 'dispatched', 'attempts', 'personaName', 'ranPersona', 'ranDivision', 'ranAgent', 'liveAgent', 'liveThinking', 'isRoster', 'inputFiles', 'humanInput', 'awaitingInput', 'inputQuestions', 'backgroundWait', 'specVerdict', 'specFindings', 'gate', 'gateFindings', 'gateReviewFor', 'gateStepKey', 'gateRound', 'gateMaxRounds', 'judgeFamily', 'judgeAgent', 'escalated', 'escalatedAtRound', 'escalatedAgent', 'acceptanceSource', 'outsideCheck', 'deliverable', 'playbook', 'openChoices', 'sharpen', 'usage', 'usageArm', ...BRIEF_KEYS]) delete shownCtx[k];
    // The brief contract (P0-3 / P1-3) gets its own sections right under the task text.
    // Default timeboxMin = taskTimeoutMs / 60000 - 5 (e.g. 50 min cap → 45 min timebox).
    const timeoutMs = Number(this.config.orchestration?.taskTimeoutMs) || 3_000_000;
    const defaultTimeboxMin = Math.max(1, Math.round(timeoutMs / 60_000) - 5);
    lines.push(...renderBriefSections(task.context, defaultTimeboxMin));

    // PS-4: Method injection from context.playbook behind orchestration.methods
    const repoRoot = resolve(this.config.paths?.artifacts || 'artifacts', '..');
    const methodsDir = join(repoRoot, 'methods');
    const isLocal = !plan.agentId || (this.config.orchestration?.agents?.[plan.agentId]?.location !== 'remote' && !plan.agentId.startsWith('remote-'));
    const methodLines = renderMethodPrompt({
      repoRoot,
      methodsDir,
      playbook: typeof task.context?.playbook === 'string' ? task.context.playbook : '',
      isLocal,
      methodsCfg: this.config.orchestration?.methods,
    });
    if (methodLines.length) lines.push(...methodLines);
    // G10: context.skill — any vendored pstack skill, by name.
    lines.push(...renderSkillPrompt({ repoRoot, skill: task.context?.skill, isLocal }));

    if (Object.keys(shownCtx).length > 0) {
      lines.push(`# Context`, '```json', JSON.stringify(shownCtx, null, 2), '```', '');
    }
    // The user answered the question(s) this task paused on. Surface those answers
    // FRONT AND CENTRE (not buried in the context JSON above) with an explicit
    // instruction to proceed — otherwise the agent re-runs from scratch, re-asks
    // the same thing, and the task bounces straight back to wait-input, looking
    // like "nothing happened when I submitted my answers".
    const humanInput = (task.context?.humanInput as Record<string, string | boolean>) || {};
    const answerEntries = Object.entries(humanInput).filter(([, v]) => v !== undefined && v !== '' && v !== null);
    if (answerEntries.length > 0) {
      lines.push(
        `# The user has answered your earlier question(s)`,
        `You previously paused this task to ask for input. The user has now replied — use these answers and CONTINUE the task to completion. Do NOT ask these same questions again; only ask (via NEEDS_INPUT) for genuinely new information you still don't have.`,
        ...answerEntries.map(([q, a]) => `- **${q}** → ${a}`),
        ``
      );
    }
    // This run was RE-ARMED after the agent deferred waiting on long background
    // work it launched. Tell it to first check whether that work has finished —
    // and to defer again (emit the marker) rather than fake a result if not.
    const bgWait = task.context?.backgroundWait as { count?: number; note?: string } | undefined;
    if (bgWait && (Number(bgWait.count) || 0) > 0) {
      lines.push(
        `# Resuming — a background task you started may now be finished`,
        `A previous run of THIS task deferred because long-running background work you launched had not finished (deferral #${bgWait.count}). This is that check-back.`,
        ...(bgWait.note ? [`What it was waiting on: ${bgWait.note}`] : []),
        `First determine whether that background work has now COMPLETED (check its output/logs/status). If it has, use its results and finish the task, producing your final deliverable. If it is STILL running, do NOT invent or guess a result — emit a line beginning "WAITING_ON_BACKGROUND:" describing what you are still waiting on, and the task will be checked again shortly.`,
        ``
      );
    }
    if (task.worktree) {
      lines.push(`# Isolated git worktree`,
        `You are working in an ISOLATED git worktree (${task.worktree.path}) on branch \`${task.worktree.branch}\`. Make your code changes and COMMIT them there. Do NOT touch the main checkout or any other branch — the requester will review and merge your branch.`,
        ``);
    }
    // Prior progress ledger (P1-3): on re-run, handover, or timeout re-dispatch
    // of the same task, if `artifacts/<id>/progress.md` exists, include it (last
    // 4 KB) so the agent resumes from completed steps instead of starting over.
    const priorProgress = this.readProgressLedger(task.id);
    if (task.context?.resumedAfterInterrupt) {
      lines.push(`# Resumed after a pause`,
        `A person paused this task while an earlier run was in progress and has now resumed it. Files that run left in your artifacts dir are still there — check them (and \`progress.md\` if present) and continue rather than starting over.`,
        ``);
    }
    if (priorProgress) {
      lines.push(
        `# Prior progress — resume, do not redo`,
        `A previous run of this task recorded progress in \`progress.md\`. Verify existing artifacts on disk, trust completed steps (\`- [x]\`), and continue from the next unfinished step instead of redoing finished work:`,
        priorProgress,
        ``
      );
    }
    // Files the requester attached for this task. They live in a persistent dir;
    // point the agent at the absolute paths so it can read them regardless of cwd.
    const inputFiles = Array.isArray(task.context?.inputFiles) ? task.context!.inputFiles as string[] : [];
    const inputsDir = inputFiles.length ? this.store.inputsPath(task.id) : null;
    if (inputsDir && inputFiles.length) {
      lines.push(`# Attached input files`,
        `The requester attached these files for you to read (absolute paths):`,
        ...inputFiles.map(f => `- ${join(inputsDir, f)}`), ``);
    }
    const deps = task.context?.dependsOn;
    if (Array.isArray(deps) && deps.length > 0) {
      lines.push(`# Results from prerequisite tasks`);
      for (const id of deps) {
        const dep = this.store.getTask(id);
        if (dep?.result) {
          lines.push(`## ${dep.title}`, '', dep.result, '');
        }
      }
    }
    if (role === 'orchestrator') {
      lines.push(
        `# Orchestrator instructions`,
        `Decompose this request into concrete subtasks and dispatch them to the company via the Cowork REST API — one POST per subtask. Leave the agent UNASSIGNED and the company's router will pick the best specialist from its 250-agent Agencies automatically (or set context.division/context.persona yourself if you know exactly who should do it):`,
        '```bash',
        `curl ${curlFlags} -X POST ${selfBase}/api/inbox -H 'Content-Type: application/json' -d '{"title":"...","description":"...(goal + full standalone instructions)...","from":{"platform":"claude","agent":"orchestrator"},"to":{},"priority":"normal","context":{"acceptance":["<checkable criterion: artifact name, command, URL>"],"verify":["<command or check that proves it>"],"tier":"standard"}}'`,
        '```',
        `Each subtask description must be fully standalone — the executing specialist sees ONLY that description.`,
        `Every subtask POST must carry the brief: the goal (in the description) plus context.acceptance (2-5 concrete, checkable criteria) and context.verify (the commands/URLs/checks that prove them). Optional: context.timeboxMin (minutes) and context.scope {"write":[...],"forbid":[...]}. A subtask you cannot write acceptance for is not scoped yet — scope it further before dispatching it.`,
        `Tag every subtask with context.tier so it runs on the right class of agent: "mechanical" (formatting, file moves, scripted renders, data copying — cheap local agents), "standard" (most building and writing), "judgment" (design decisions, ambiguous briefs, final whole-run review — opus-class), or "review" (judging another subtask's output; add context.reviewOf = the agent id that produced it, and an agent of a different model family is picked). Default to the lowest tier that can do the job.`,
        `To make a subtask wait for others (e.g. a final synthesis step), add their task ids to its context: {"dependsOn":["<id1>","<id2>"]} — the API response to each POST gives the created task's id; dependencies' results are shown to the dependent agent.`,
        `Rollup rule: before the final summary, dispatch a synthesis subtask whose context.dependsOn lists EVERY child you dispatched. Its result must account for every child by id as done, failed, or absorbed (its work folded into another named task), and report PASS / ISSUES / BLOCKED per slice. A gap is not a pass. Silently redoing a missing child's work hides the coverage gap. A synthesis that reports STATUS: DONE without naming a failed child's id is downgraded to DONE_WITH_CONCERNS by the server.`,
        `After dispatching, output a summary of the plan. Check existing tasks first: curl ${curlFlags} ${selfBase}/api/inbox?limit=20`,
        ``
      );
    }
    if (isConversational(task)) {
      // A live dialogue turn: the reply itself is the deliverable. No NEEDS_INPUT /
      // WAITING_ON_BACKGROUND markers — a question to the user is a normal reply.
      lines.push(
        ``,
        `This is ONE TURN of a live conversation. Your stdout is spoken/shown to the user verbatim as your reply. Asking the user a question is a normal, complete reply — do NOT emit NEEDS_INPUT or WAITING_ON_BACKGROUND markers. Scratch files (if any) go in: ${artifactsDir}`
      );
      return lines.join('\n');
    }
    lines.push(
      ``,
      `If you generate any files (documents, media, data), save them to the directory: ${artifactsDir} — they become downloadable from the dashboard when the task completes.`,
      `Put the FINAL deliverable files the user asked for (the report, deck, video, build, …) in its outputs/ subfolder: ${join(artifactsDir, OUTPUTS_SUBDIR)} (also $COWORK_OUTPUTS_DIR). The dashboard lists them as OUTPUTS, apart from the working files (notes, logs, scripts, scratch data) that stay in the artifacts folder.`,
      `When done, your final output (stdout) becomes the task result visible to the CEO on the dashboard.`,
      `If you CANNOT finish without more information or a decision from the user, do NOT guess or invent an answer. End your output with a line beginning "NEEDS_INPUT:" followed by your question(s), one per line. The task will then pause and wait for the user to answer instead of being marked done.`,
      `If you launched LONG-RUNNING BACKGROUND WORK (a background shell/command, a spawned sub-agent, a CI/deploy/render job) that has NOT finished yet, do NOT report a partial result as if the task were done. End your output with a line beginning "WAITING_ON_BACKGROUND:" describing what you are waiting on. The task will be re-run shortly to check whether that work finished, instead of being marked done and closed while it is still in flight.`
    );
    return lines.join('\n');
  }

  /** `taskText` = the task's own title + description for a task run (picks its
   *  MCP servers, or the full profile when it asks for skills/subagents); omit it
   *  for internal reasoning calls (router, verifier, achiever), which run lean
   *  with no MCP servers. */
  /** The level a run uses when nothing more specific was asked for. */
  private thinkingFor(level?: ThinkingLevel): ThinkingLevel {
    return level || normalizeThinking(this.config.orchestration.defaultThinking) || DEFAULT_THINKING;
  }

  private buildArgv(roleCfg: RoleConfig, prompt: string, taskText: string | null = null, fullProfile = false): string[] {
    switch (roleCfg.exec) {
      case 'claude': {
        const lean = fullProfile || this.config.orchestration.claudeProfile === 'full' ? []
          : this.claudeProfile.args(taskText, this.config.orchestration.claudeMcp);
        return ['claude', '-p', prompt, '--model', roleCfg.model,
          ...thinkingArgs('claude', this.thinkingFor(roleCfg.thinking)), '--dangerously-skip-permissions', ...lean];
      }
      case 'hermes':
        return roleCfg.model
          ? ['hermes', '-m', roleCfg.model, ...thinkingArgs('hermes', roleCfg.thinking), '-z', prompt]
          : ['hermes', ...thinkingArgs('hermes', roleCfg.thinking), '-z', prompt];
      case 'agy':
        // agy (Antigravity CLI) print mode defaults to --print-timeout 5m0s and
        // self-aborts there — long before cowork's own taskTimeoutMs kill. That
        // 5-min cap silently truncated multi-step "build + push" tasks mid-run,
        // leaving planning narration with no deliverable (verifier then rejected
        // it). Pin agy's print timeout to cowork's task budget so the dispatcher's
        // SIGTERM at taskTimeoutMs stays the single authority.
        //
        // --model: pin the model the agent ID names. Without it, EVERY local-agy-*
        // agent ran on agy's default model regardless of its configured `model`
        // (e.g. local-agy-gemini-3.8-flash and local-agy-claude-opus-5-5
        // both silently executed on the same default). The agent IDs already carry
        // the exact agy model slug (with the thinking level as its last part, e.g. `gemini-3.8-flash-high`;
        // see `agy models`), built from the model + level by agyModelSlug. Only pass the flag when set — an empty model
        // would make agy reject `--model ''` instead of falling back to its default.
        return ['agy', '-p', prompt, '--print-timeout', `${this.config.orchestration.taskTimeoutMs}ms`,
          ...(roleCfg.model ? ['--model', agyModelSlug(roleCfg.model, roleCfg.thinking || (splitThinkingSuffix(roleCfg.model).level ? undefined : this.thinkingFor()))] : []), '--dangerously-skip-permissions'];
      case 'codex':
        // OpenAI Codex CLI, non-interactive.
        //  --skip-git-repo-check: we spawn codex with cwd = the task's artifacts
        //    dir, which is NOT a git repo. Without this flag codex's pre-flight
        //    aborts with "Not inside a trusted directory and --skip-git-repo-check
        //    was not specified." before producing any output.
        //  --dangerously-bypass-approvals-and-sandbox: the codex parallel of the
        //    --dangerously-skip-permissions that the claude/agy agents use — runs
        //    fully autonomously (never prompts for approval) and lets codex write
        //    its artifacts. Cowork agents run with full permissions by design.
        //  `--` ends option parsing so a prompt starting with a dash isn't
        //    mistaken for a flag.
        return ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
          ...(roleCfg.model ? ['-m', roleCfg.model] : []), ...thinkingArgs('codex', this.thinkingFor(roleCfg.thinking)), '--', prompt];
      case 'ollama':
        // Local Ollama chat model (model required).
        if (!roleCfg.model) throw new Error('exec:ollama needs a model');
        return ['ollama', 'run', roleCfg.model, prompt];
      case 'dsh': {
        // DeepSeek Harness, headless profile: "answer one task, print the result,
        // and exit" — the non-interactive shape an agent needs. dsh is NOT a model
        // server; it talks to a local OpenAI-compatible endpoint (here the SGLang
        // Qwen3.8-27B engine on :30000) via the `local-sglang` provider wired in
        // $DSH_HOME/settings.yaml, which also pins agent-default-model. The model
        // is therefore chosen by that settings file, not a CLI flag, so roleCfg.model
        // is documentation only.
        //
        // Hermetic env is essential: execute() spawns agents with cwd = the task's
        // artifacts dir and a bare env, but dsh resolves its settings.yaml + the
        // `headless` profile from $DSH_HOME (default is the launch cwd — wrong here),
        // and the provider needs its apiKeyEnv present (SGLang ignores the value).
        // env(1) sets both regardless of spawn cwd so the agent is self-contained.
        // The dsh-cowork-progress patch overlay streams turn-by-turn tool executions
        // and live compaction status/progress to stderr -> progress.log.
        const patch = this.ensureDshPatch();
        return ['env', `DSH_HOME=${process.env.HOME}/.dsh`, 'SGLANG_API_KEY=dummy',
          'DSH_PERMISSION_MODE=danger-full-access',
          'dsh', '--profile', 'headless', ...(patch ? ['--patch', patch] : []), prompt];
      }
      case 'script':
        // Task is passed via COWORK_TASK_* env vars (see execute); the command
        // is a fixed pipeline, not an LLM prompt.
        if (!roleCfg.command?.length) throw new Error(`role exec:script needs a "command" array`);
        return roleCfg.command;
      default:
        throw new Error(`Unknown exec type: ${(roleCfg as RoleConfig).exec}`);
    }
  }

  /**
   * Verify a finished attempt actually succeeded. `spawnOk` is the raw exit-code
   * result. A deterministic pattern/emptiness check runs first (catches the
   * rate-limit-that-exited-0 masquerade); if that passes and the LLM verifier is
   * enabled, a verifier agent judges whether the output truly completes the task.
   * A bad verdict makes execute() hand the task to the next agent in the chain.
   *
   * NOTE on ordering: callers MUST run {@link detectInputRequest} on an
   * otherwise-ok result BEFORE the LLM gate (see execute / verifyReportedCompletion).
   * The LLM verifier is told to FAIL anything that "does not actually address the
   * task" — which is exactly what a genuine QUESTION back to the user looks like.
   * Letting it run first would turn a request-for-input into an agent handover and
   * strand the question, never parking it on wait-input. This method is the
   * composition of the two gates for callers that have already ruled out an input
   * request (or don't care).
   */
  private async verifyResult(task: Task, output: { ok: boolean; text: string }, executorAgentId = ''): Promise<VerifyVerdict> {
    const det = this.deterministicVerdict(output);
    if (!det.ok) return det;
    return this.qualityGateVerdict(task, output.text, executorAgentId, (Number(task.context?.attempts) || 0) + 1);
  }

  /** Gate 1 — cheap, deterministic exit-code + pattern/emptiness check. Catches
   *  the rate-limit / quota / overloaded / empty reply that exits 0. */
  private deterministicVerdict(output: { ok: boolean; text: string }): VerifyVerdict {
    const cfg = this.config.orchestration.verifier;
    if (cfg?.enabled === false) return { ok: output.ok, reason: output.ok ? undefined : output.text.slice(0, 200) };
    return verifyOutput(output.text, output.ok, {
      failPatterns: cfg?.failPatterns,
      replacePatterns: cfg?.replacePatterns,
      minLength: cfg?.minLength,
      maxPatternScanLength: cfg?.maxPatternScanLength
    });
  }

  /** Acceptance criteria carried by `task` (P0-3), or [] for legacy tasks. */
  private taskAcceptance(task: Task): string[] {
    const fromCtx = parseBrief(task.context).brief.acceptance;
    if (fromCtx && fromCtx.length) return fromCtx;
    const direct = (task as any).acceptance;
    if (Array.isArray(direct)) return direct.map((s: any) => String(s || '').trim()).filter(Boolean);
    return [];
  }

  /** Collect artifacts produced by `task` with byte sizes (for the spec verifier). */
  /** Cap on files listed to the spec judge (the prompt stays bounded). */
  static readonly SPEC_ARTIFACT_LIST_MAX = 300;

  /**
   * The on-disk artifact listing the spec judge checks deliverables against —
   * RECURSIVE (outputs/, stickers_pack/, promo/ …), relative paths with sizes.
   * It used to list the top level only, so on ee175cea the judge called three
   * deliverables "missing" that sat in subfolders.
   */
  private collectArtifactsWithSizes(task: Task): Array<string | VerifierArtifact> {
    const seen = new Map<string, number>();
    const artRoot = this.config.paths?.artifacts;
    const max = Dispatcher.SPEC_ARTIFACT_LIST_MAX;
    let unlisted = 0;
    if (artRoot && task.id) {
      const root = this.artifactsDir(task.id);
      const walk = (dir: string, rel: string, depth: number) => {
        let names: string[] = [];
        try { names = readdirSync(dir).sort(); } catch { return; }
        for (const f of names) {
          if (f.startsWith('.') || f === 'node_modules') continue;
          if (!rel && (f === 'progress.log' || f === 'result.md')) continue;
          const abs = join(dir, f);
          const name = rel ? `${rel}/${f}` : f;
          let st;
          try { st = statSync(abs); } catch { continue; }
          if (st.isDirectory()) { if (depth < 6) walk(abs, name, depth + 1); continue; }
          if (!st.isFile()) continue;
          if (seen.size >= max) { unlisted++; continue; }
          seen.set(name, st.size);
        }
      };
      walk(root, '', 0);
    }
    const extra = Array.isArray((task as any).artifacts)
      ? (task as any).artifacts
      : Array.isArray(task.context?.artifacts)
        ? task.context!.artifacts
        : [];
    for (const item of extra) {
      if (typeof item === 'string' && item && !seen.has(item)) {
        let size = 0;
        if (artRoot && task.id) {
          try { size = statSync(join(this.artifactsDir(task.id), item)).size; } catch { /* ignore */ }
        }
        seen.set(item, size);
      } else if (item && typeof item === 'object' && typeof item.name === 'string' && !seen.has(item.name)) {
        seen.set(item.name, Number(item.size) || 0);
      }
    }
    const out: Array<string | VerifierArtifact> = Array.from(seen.entries()).map(([name, size]) => ({ name, size }));
    if (unlisted) out.push(`… ${unlisted} more file(s) on disk not listed (listing capped at ${max})`);
    return out;
  }

  /** Spawn a single spec-judge agent through the normal exec path with a short timeout. */
  private runSpecJudge(judgeId: string, prompt: string, timeoutMs: number): Promise<{ ok: boolean; text: string }> {
    const b = this.config.orchestration.agents?.[judgeId];
    const exec = (b?.exec || 'hermes') as RoleConfig['exec'];
    const model = b?.model || '';
    const argv = this.judgeArgv({ exec, model, command: b?.command }, prompt);
    const scratch = mkdtempSync(join(tmpdir(), 'cowork-verifier-'));
    const cleanup = () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ } };
    return new Promise<{ ok: boolean; text: string }>((resolve) => {
      try {
        const child = spawn(argv[0], argv.slice(1), { cwd: scratch, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { err += d.toString(); });
        child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: `SPAWN ERROR: ${e.message}` }); });
        child.on('close', code => {
          clearTimeout(timer);
          if (timedOut) { resolve({ ok: false, text: `TIMEOUT after ${timeoutMs}ms` }); return; }
          const clean = stripAnsi(out).trim();
          if (code === 0 && clean) resolve({ ok: true, text: clean });
          else resolve({ ok: false, text: clean || stripAnsi(err).trim() || `exit code ${code}` });
        });
      } catch (e: any) {
        resolve({ ok: false, text: `SPAWN ERROR: ${e?.message || e}` });
      }
    }).finally(cleanup);
  }

  /** argv for a verifier/judge run. The prompt embeds an untrusted RESULT, so a
   *  claude judge is a pure judge: no tools, no MCP servers, no permission
   *  bypass. Other execs use their normal argv (callers run them in an empty
   *  scratch cwd). */
  private judgeArgv(roleCfg: RoleConfig, prompt: string): string[] {
    if (roleCfg.exec === 'claude' && !roleCfg.command) {
      return ['claude', '-p', prompt, ...(roleCfg.model ? ['--model', roleCfg.model] : []), '--tools', '', '--strict-mcp-config'];
    }
    return this.buildArgv(roleCfg, prompt);
  }

  /** Save `context.specVerdict` onto both the in-memory task and the stored task. */
  private persistSpecVerdict(task: Task, record: SpecVerdictRecord): void {
    task.context = { ...(task.context || {}), specVerdict: record };
    const stored = this.store.getTask(task.id);
    if (stored) {
      stored.context = { ...(stored.context || {}), specVerdict: record };
      this.store.saveTask(stored);
    }
  }

  /** Append failing criteria from an enforce-mode CHANGES_REQUESTED verdict to the task's brief. */
  private appendSpecFindingsToBrief(task: Task, record: SpecVerdictRecord, attemptNumber: number): void {
    const items = record.failedCriteria.length ? record.failedCriteria : [record.summary || 'CHANGES_REQUESTED'];
    const block = [
      `# Spec verifier findings (attempt ${attemptNumber} rejected by ${record.judgeAgent || 'spec-verifier'} — fix these failing criteria)`,
      ...items.map(f => `- ${f}`),
    ].join('\n');
    const appendTo = (desc: string | undefined) => {
      const base = (desc || '').trimEnd();
      return base ? `${base}\n\n${block}` : block;
    };
    task.description = appendTo(task.description);
    task.context = { ...(task.context || {}), specVerdict: record, specFindings: items };
    const stored = this.store.getTask(task.id);
    if (stored) {
      stored.description = task.description;
      stored.context = { ...(stored.context || {}), specVerdict: record, specFindings: items };
      this.store.saveTask(stored);
    }
  }

  /**
   * Gate 2 — quality verification.
   *   - Tasks carrying `acceptance` (P0-3) when `orchestration.verifier.spec.enabled`
   *     is true run the cross-family spec-compliance verifier (P1-1).
   *   - Legacy tasks (no `acceptance`) keep today's behaviour (`llmVerdict`).
   */
  private async qualityGateVerdict(task: Task, text: string, executorAgentId: string, attemptNumber: number): Promise<VerifyVerdict> {
    let acceptance = this.taskAcceptance(task);
    const specCfg = this.config.orchestration.verifier?.spec;
    // G5: task-level review gate (context.review = none | llm | panel).
    const review = reviewMode(task, this.config.orchestration.verifier?.panel);
    if (review === 'none') return { ok: true };
    if (review === 'llm') return this.llmVerdict(task, text);
    if (review === 'panel' && acceptance.length === 0) acceptance = panelFallbackAcceptance(task);
    if (acceptance.length > 0 && (specCfg?.enabled || review === 'panel')) {
      return this.specVerdict(task, text, executorAgentId, attemptNumber, acceptance);
    }
    return this.llmVerdict(task, text);
  }

  /**
   * P1-1 spec-compliance verifier. Selects a cross-family judge agent, runs the
   * spec prompt, and records `context.specVerdict`.
   *   - shadow mode: appends `lessons.jsonl` `kind: "quality-shadow"` and never rejects.
   *   - enforce mode: rejects `CHANGES_REQUESTED` and appends failing criteria to the brief.
   *   - no available judge or judge crash/timeout: records `UNVERIFIABLE` and fails open.
   */
  private async specVerdict(
    task: Task,
    text: string,
    executorAgentId: string,
    attemptNumber: number,
    acceptance: string[]
  ): Promise<VerifyVerdict> {
    const specCfg = this.config.orchestration.verifier?.spec || {};
    const sharpenerCfg = this.config.orchestration.sharpener;
    const isSharpened = task.context?.acceptanceSource === 'sharpened';
    let mode: 'shadow' | 'enforce' = specCfg.mode === 'enforce' ? 'enforce' : 'shadow';
    if (isSharpened) {
      mode = sharpenerCfg?.mode === 'enforce' ? 'enforce' : 'shadow';
    }
    // G5: an explicitly requested panel review (context.review = "panel") enforces.
    if (task.context?.review === 'panel') mode = 'enforce';
    const persona = this.resolvePersona(task)
      || (typeof task.context?.personaName === 'string' ? task.context.personaName : '')
      || executorAgentId;
    const artifacts = this.collectArtifactsWithSizes(task);
    const evidence = extractEvidenceBlock(text);
    const prompt = buildVerifierPrompt(task, text, { acceptance, artifacts, evidence });

    const judgeOpts = {
      agents: this.config.orchestration.agents,
      judges: specCfg.judges,
      isCooling: (id: string) => !!this.store.agentCooldownUntil(id),
      fallbackPool: this.specJudgeFallbackPool(),
    };
    const candidates = selectSpecJudges(executorAgentId, { ...judgeOpts, result: text, acceptance });

    if (candidates.length === 0) {
      const skipped = explainSpecJudgeSkips(executorAgentId, judgeOpts);
      const why = skipped.map(s => `${s.id}: ${s.why}`).join('; ') || 'no candidates configured';
      const record: SpecVerdictRecord = {
        verdict: 'UNVERIFIABLE',
        mode,
        judgeAgent: null,
        executorAgent: executorAgentId,
        criteria: acceptance.map(c => ({ criterion: c, status: 'UNVERIFIABLE', reason: 'no judge agent available' })),
        failedCriteria: [],
        summary: `UNVERIFIABLE — no judge agent available (${why})`.slice(0, 600),
        at: new Date().toISOString(),
        cause: 'no-judge',
        skippedJudges: skipped,
      };
      console.warn(`Dispatcher: spec verifier has no judge for task ${task.id} (executor ${executorAgentId}) — ${why}`);
      this.persistSpecVerdict(task, record);
      if (mode === 'shadow') {
        this.recordLesson(task.id, {
          kind: 'quality-shadow', agent: executorAgentId, persona, attempt: attemptNumber,
          reason: `UNVERIFIABLE (judge=none, cause=no-judge): ${record.summary}`, resultText: text,
        });
      }
      return { ok: true };
    }

    const timeoutMs = specCfg.timeoutMs || 300_000;
    let usedJudgeId: string | null = null;
    let parsed: ReturnType<typeof parseSpecVerdict> | null = null;

    // PS-2: judgment-tier tasks get a multi-family panel + lead when the flag is on.
    const panelCfg = this.config.orchestration.verifier?.panel;
    if (reviewMode(task, panelCfg) === 'panel' || (panelCfg?.enabled !== false && panelCfg?.judgmentTier && taskTier(task.context) === 'judgment')) {
      const tiers = this.config.orchestration.tiers || {};
      const panelJudges = selectSpecJudges(executorAgentId, {
        agents: this.config.orchestration.agents,
        judges: specCfg.judges,
        isCooling: id => !!this.store.agentCooldownUntil(id),
        panel: panelCfg?.size ?? 2,
        panelPool: [...(tiers.judgment || []), ...(tiers.standard || []), ...(tiers.mechanical || [])],
      });
      if (panelJudges.length >= 2) {
        const out = await this.panelSpecVerdict(task, prompt, panelJudges, acceptance, timeoutMs, executorAgentId, persona, attemptNumber);
        if (out) { usedJudgeId = out.judgeId; parsed = out.parsed; }
      }
    }

    for (const judgeId of (parsed ? [] : candidates)) {
      let judgeOut: { ok: boolean; text: string };
      try {
        judgeOut = await this.runSpecJudge(judgeId, prompt, timeoutMs);
      } catch (e: any) {
        console.error(`Dispatcher: spec judge ${judgeId} threw (trying next / failing open):`, e);
        judgeOut = { ok: false, text: `JUDGE ERROR: ${e?.message || e}` };
      }
      const soft = verifyOutput(judgeOut.text, judgeOut.ok);
      if (!judgeOut.ok || !soft.ok) {
        if (isCliRateLimitSignal({ gateFailed: !soft.ok, gateReason: soft.reason })) this.store.noteAgentRateLimited(judgeId);
        continue;
      }
      const p = parseSpecVerdict(judgeOut.text, acceptance, false);
      if (p.crashed) continue;
      usedJudgeId = judgeId;
      parsed = p;
      break;
    }

    if (!parsed || !usedJudgeId) {
      const record: SpecVerdictRecord = {
        verdict: 'UNVERIFIABLE',
        mode,
        judgeAgent: candidates[0] || null,
        executorAgent: executorAgentId,
        criteria: acceptance.map(c => ({ criterion: c, status: 'UNVERIFIABLE', reason: 'judge crashed or timed out (fail-open)' })),
        failedCriteria: [],
        summary: 'UNVERIFIABLE — judge crashed or timed out (fail-open)',
        at: new Date().toISOString(),
        crashed: true,
        cause: 'judge-crashed',
      };
      this.persistSpecVerdict(task, record);
      if (mode === 'shadow') {
        this.recordLesson(task.id, {
          kind: 'quality-shadow', agent: executorAgentId, persona, attempt: attemptNumber,
          reason: `UNVERIFIABLE (judge=${record.judgeAgent || 'none'}, cause=judge-crashed): ${record.summary}`, resultText: text,
        });
      }
      return { ok: true };
    }

    const record: SpecVerdictRecord = {
      verdict: parsed.verdict,
      mode,
      judgeAgent: usedJudgeId,
      executorAgent: executorAgentId,
      criteria: parsed.criteria,
      failedCriteria: parsed.failedCriteria,
      summary: parsed.summary,
      at: new Date().toISOString(),
      ...(parsed.verdict === 'UNVERIFIABLE' ? { cause: 'judge-unverifiable' as const } : {}),
    };
    this.persistSpecVerdict(task, record);

    if (mode === 'shadow') {
      this.recordLesson(task.id, {
        kind: 'quality-shadow', agent: executorAgentId, persona, attempt: attemptNumber,
        reason: `${record.verdict} (judge=${usedJudgeId}): ${record.summary}`, resultText: text,
      });
      return { ok: true };
    }

    if (record.verdict === 'CHANGES_REQUESTED') {
      this.appendSpecFindingsToBrief(task, record, attemptNumber);
      return {
        ok: false,
        reason: `spec verifier (${usedJudgeId}): CHANGES_REQUESTED — ${record.summary}`,
      };
    }
    return { ok: true };
  }

  /** Agents the spec verifier may fall back to when the executor family's
   *  configured judges are all unavailable: the tier lists (judgment, standard,
   *  mechanical) then every family's judge chain. Other-family only (enforced in
   *  selectSpecJudges). */
  private specJudgeFallbackPool(): string[] {
    const tiers = this.config.orchestration.tiers || {};
    const judges = this.config.orchestration.verifier?.spec?.judges || {};
    const pool = [
      ...(tiers.judgment || []), ...(tiers.standard || []), ...(tiers.mechanical || []),
      ...Object.values(judges).flatMap(v => (Array.isArray(v) ? v : [])),
    ];
    return pool.filter((id, i) => id && pool.indexOf(id) === i);
  }

  /**
   * PS-2 panel for the spec verifier: run every panel judge in parallel; when
   * any requests changes, a judgment-tier lead buckets the findings and only
   * Act on findings keep CHANGES_REQUESTED. Returns null when no panel judge
   * produced a usable reply (the caller falls back to the single-judge chain).
   */
  private async panelSpecVerdict(
    task: Task, prompt: string, judges: string[], acceptance: string[], timeoutMs: number,
    executorAgentId: string, persona: string, attemptNumber: number
  ): Promise<{ judgeId: string; parsed: ReturnType<typeof parseSpecVerdict> } | null> {
    const agents = this.config.orchestration.agents || {};
    const replies = await Promise.all(judges.map(async id => {
      try { return { id, ...(await this.runSpecJudge(id, buildPanelReviewerPrompt(prompt), timeoutMs)) }; }
      catch (e: any) { return { id, ok: false, text: `JUDGE ERROR: ${e?.message || e}` }; }
    }));
    const reviews = replies.map(r => {
      const soft = verifyOutput(r.text, r.ok);
      if (isCliRateLimitSignal({ gateFailed: !soft.ok, gateReason: soft.reason })) this.store.noteAgentRateLimited(r.id);
      const p = r.ok && soft.ok ? parseSpecVerdict(r.text, acceptance, false) : null;
      return { id: r.id, family: agentFamily(agents[r.id], r.id), text: r.text, parsed: p && !p.crashed ? p : null };
    });
    const usable = reviews.filter(r => r.parsed);
    if (!usable.length) return null;
    const changes = usable.filter(r => r.parsed!.verdict === 'CHANGES_REQUESTED');
    const lesson = (verdict: string, buckets = { actOn: 0, consider: 0, noted: 0, dismissed: 0 }, leadParsed = true) =>
      this.recordLesson(task.id, {
        kind: 'gate-panel', agent: executorAgentId, persona, attempt: attemptNumber,
        reason: `${verdict} spec panel [${usable.map(r => r.family).join('+')}]: act_on=${buckets.actOn} consider=${buckets.consider} noted=${buckets.noted} dismissed=${buckets.dismissed}${leadParsed ? '' : ' (lead unavailable)'}`,
        panel: { gate: task.id, round: attemptNumber, families: usable.map(r => r.family), buckets, verdict, leadParsed },
      });
    if (!changes.length) {
      lesson(usable[0].parsed!.verdict);
      return { judgeId: usable.map(r => r.id).join('+'), parsed: usable[0].parsed! };
    }

    const tiers = this.config.orchestration.tiers || {};
    const leadAgent = (tiers.judgment || []).find(id => agents[id] && !agents[id].disabled && agents[id].location !== 'remote' && !this.store.agentCooldownUntil(id));
    let lj: ReturnType<typeof parseLeadJudgment> | null = null;
    if (leadAgent) {
      try {
        const out = await this.runSpecJudge(leadAgent, buildLeadJudgmentPrompt({
          title: task.title, description: task.description, acceptance,
          reviews: usable.map(r => ({ family: r.family, agent: r.id, text: r.text })),
        }), timeoutMs);
        if (out.ok) lj = parseLeadJudgment(out.text);
      } catch (e: any) {
        console.error(`Dispatcher: panel lead ${leadAgent} threw (strict fallback):`, e);
      }
    }
    if (!lj || !lj.parsed) {
      // Lead unavailable: strict — the first reviewer that requested changes stands.
      lesson('CHANGES_REQUESTED', undefined, false);
      return { judgeId: changes[0].id, parsed: changes[0].parsed! };
    }
    lesson(lj.verdict, lj.counts);
    const judgeId = `${usable.map(r => r.id).join('+')}>${leadAgent}`;
    if (lj.verdict === 'APPROVED') {
      return { judgeId, parsed: {
        ok: true, verdict: 'APPROVED',
        criteria: acceptance.map(c => ({ criterion: c, status: 'PASS', reason: 'panel lead: no Act-on findings' })),
        failedCriteria: [],
        summary: `APPROVED by lead — act on 0, consider ${lj.counts.consider}, noted ${lj.counts.noted}, dismissed ${lj.counts.dismissed}`,
      } };
    }
    return { judgeId, parsed: {
      ok: false, verdict: 'CHANGES_REQUESTED',
      criteria: lj.actOn.map(f => ({ criterion: 'Act on', status: 'FAIL', reason: f })),
      failedCriteria: lj.actOn,
      summary: `CHANGES_REQUESTED by lead — ${lj.actOn.join('; ').slice(0, 400)}`,
      reason: `spec panel: CHANGES_REQUESTED — ${lj.actOn.join('; ').slice(0, 300)}`,
    } };
  }

  /** Gate 2 (legacy, config-gated) — an LLM verifier agent judges whether the
   *  output GENUINELY completes a legacy task (one without `acceptance`). Fails
   *  open ({ ok: true }) when disabled or on any error. */
  private async llmVerdict(task: Task, text: string): Promise<VerifyVerdict> {
    const cfg = this.config.orchestration.verifier;
    if (!cfg?.llm?.enabled || !shouldLlmVerify(task, cfg.llm.priorities)) return { ok: true };
    try {
      const prompt = buildVerifierPrompt(task, text, { artifacts: this.collectArtifactsWithSizes(task) });
      const argv = this.judgeArgv({ exec: (cfg.llm.exec || 'hermes') as RoleConfig['exec'], model: cfg.llm.model || '' }, prompt);
      const scratch = mkdtempSync(join(tmpdir(), 'cowork-verifier-'));
      const reply = await new Promise<string>((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: scratch, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(out); }, cfg.llm!.timeoutMs || 120000);
        child.stdout.on('data', d => { out += d.toString(); });
        child.on('error', () => resolve(''));
        child.on('close', () => { clearTimeout(timer); resolve(stripAnsi(out)); });
      });
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
      return parseLlmVerdict(reply);
    } catch (e) {
      console.error(`Dispatcher: LLM verifier errored (failing open):`, e);
      return { ok: true };   // never discard a real deliverable because the verifier crashed
    }
  }

  /** Gate 2.7 — deterministic artifact lint (core/artifact-lint.ts, ADR-013) of the
   *  files THIS attempt wrote to the task's artifacts dir. Findings are recorded on
   *  task.context.artifactLint for the reviewer. Returns a rejecting verdict only in
   *  'enforce' mode, with CRITICAL defects, and when this is not the last attempt
   *  of the chain (the last attempt keeps its deliverable — fail open). Never
   *  throws: a lint crash must not cost a real deliverable. */
  private artifactVerdict(task: Task, artDir: string, sinceMs: number, lastAttempt: boolean): VerifyVerdict {
    const mode = this.config.orchestration.verifier?.artifactLint ?? 'enforce';
    if (mode === 'off' || this.config.orchestration.verifier?.enabled === false) return { ok: true };
    try {
      const report = lintArtifacts(artDir, { sinceMs, brief: `${task.title}\n${task.description || ''}`, sloplint: resolveSloplint(), playbook: typeof task.context?.playbook === 'string' ? task.context.playbook : undefined });
      if (!report.files.length) return { ok: true };
      const reject = mode === 'enforce' && report.critical.length > 0 && !lastAttempt;
      const t = this.store.getTask(task.id);
      if (t) {
        t.context = {
          ...(t.context || {}),
          artifactLint: {
            at: new Date().toISOString(), files: report.files.length,
            critical: report.critical.slice(0, 10), warnings: report.warnings.slice(0, 20),
            ...(report.critical.length && !reject ? { downgraded: true } : {}),
          },
        };
        this.store.saveTask(t);
      }
      return reject ? { ok: false, reason: lintReason(report) } : { ok: true };
    } catch (e) {
      console.error(`Dispatcher: artifact lint errored for ${task.id} (failing open):`, e);
      return { ok: true };
    }
  }

  /** Input-request detection options from the verifier config (question phrases). */
  private inputOpts(): InputOptions {
    const cfg = this.config.orchestration.verifier;
    return {
      disabled: cfg?.detectInput === false,
      patterns: cfg?.inputPatterns,
      replacePatterns: cfg?.replaceInputPatterns
    };
  }

  /** Background-wait detection options from the verifier config (wait phrases). */
  private backgroundOpts(): BackgroundOptions {
    const cfg = this.config.orchestration.verifier;
    return {
      disabled: cfg?.detectBackground === false,
      patterns: cfg?.backgroundPatterns,
      replacePatterns: cfg?.replaceBackgroundPatterns
    };
  }

  /** How long to wait before re-running a task deferred on a background wait. */
  private backgroundPollMs(): number {
    const v = this.config.orchestration.verifier?.backgroundPollMs;
    return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 120000;
  }

  /** Safety cap on how many times one task may be deferred for a background wait
   *  before it is completed with whatever it has. */
  private maxBackgroundDeferrals(): number {
    const v = this.config.orchestration.verifier?.maxBackgroundDeferrals;
    return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 30;
  }

  /** How many times this task has already been deferred for a background wait. */
  private backgroundDeferralCount(task: Task): number {
    const bw = task.context?.backgroundWait as { count?: number } | undefined;
    return Number(bw?.count) || 0;
  }

  /** Returns a `defer-background` decision when a reported result is the agent
   *  still waiting on long background work it launched (and the deferral cap is
   *  not yet hit); otherwise null so completion proceeds normally. Shared by both
   *  branches of {@link verifyReportedCompletion}. */
  private backgroundDecision(task: Task, text: string): Extract<CompletionDecision, { action: 'defer-background' }> | null {
    const bg = detectBackgroundWait(text, this.backgroundOpts());
    if (!bg.waiting) return null;
    if (this.backgroundDeferralCount(task) >= this.maxBackgroundDeferrals()) return null;
    return { action: 'defer-background', note: bg.note, pollMs: this.backgroundPollMs() };
  }

  /** P0-2/P0-4: context patch from a result's STATUS/EVIDENCE footer and RULING
   *  lines. Absent fields are written as undefined so a re-run clears a stale flag. */
  private footerContext(f: StatusFooter, task?: Task, text = ''): Record<string, unknown> {
    // PS-5 rollup rule: a STATUS: DONE whose dependsOn includes a FAILED task
    // (failed tasks finish as status 'done' with a FAILED result, so
    // depsSatisfied lets their dependents run) is forced to DONE_WITH_CONCERNS
    // unless the result names that task id (8-char prefix is enough).
    let status = f.status;
    let concerns = f.concerns;
    let unaccounted: string[] = [];
    if (status === 'DONE' && task) unaccounted = this.unaccountedFailedDeps(task, text);
    if (unaccounted.length) {
      status = 'DONE_WITH_CONCERNS';
      concerns = `Rollup gap: depends on failed task(s) ${unaccounted.map(id => id.slice(0, 8)).join(', ')} that the result does not account for (a gap is not a pass).${f.concerns ? ' ' + f.concerns : ''}`;
    }
    return {
      hasEvidence: f.hasEvidence,
      resultStatus: status,
      qualityFlag: status === 'DONE_WITH_CONCERNS' ? 'concerns' : undefined,
      concerns: status === 'DONE_WITH_CONCERNS' ? concerns : undefined,
      unaccountedFailedDeps: unaccounted.length ? unaccounted : undefined,
      blockedReason: f.status === 'BLOCKED' ? f.reason : undefined,
      rulings: f.rulings.length ? f.rulings : undefined
    };
  }

  /** PS-5: failed `context.dependsOn` tasks the result text does not name. */
  private unaccountedFailedDeps(task: Task, text: string): string[] {
    const deps = task.context?.dependsOn;
    if (!Array.isArray(deps) || deps.length === 0) return [];
    return unaccountedFailedDeps(deps.map((id: string) => {
      const dep = this.store.getTask(id);
      return { id, failed: !!dep && isFailedTask(dep) };
    }), text);
  }

  /** A STATUS: BLOCKED result finalises as FAILED (isFailedTask keys on the
   *  prefix) WITHOUT a handover — the blocker is not an agent problem. */
  private blockedResult(f: StatusFooter, text: string): string {
    return `FAILED (blocked): ${f.reason}\n\n${text.length > 2000 ? text.slice(0, 2000) + '\n…' : text}`;
  }

  /** Append a failed-agent record to the task's inbox entry so the fallback trail
   *  is visible on the dashboard: which agents failed, in order, and why. */
  private recordFailedAgent(taskId: string, entry: { agent: string; persona: string; attempt: number; reason: string }, rateLimited = false): void {
    const t = this.store.getTask(taskId);
    if (!t) return;
    const failedAgents = Array.isArray(t.context?.failedAgents) ? t.context!.failedAgents : [];
    failedAgents.push({ ...entry, at: new Date().toISOString() });
    t.context = { ...(t.context || {}), failedAgents };
    this.store.saveTask(t);
    // A rate-limit refusal means that agent is cooling down: hold tasks pinned to it
    // and steer chain routing past it until it resets (Store.agentCooldownUntil).
    // `rateLimited` comes from the CLI's own signals (isCliRateLimitSignal), never
    // from `entry.reason`, which may be the LLM verifier's free text.
    if (entry.agent && rateLimited) {
      const until = this.store.noteAgentRateLimited(entry.agent);
      console.log(`Dispatcher: agent ${entry.agent} hit a rate limit — treated as cooling down until ${until}`);
    }
  }

  /**
   * WF-1: append one lesson to the cross-task ledger (`decisions/lessons.jsonl`).
   * Fired on verifier rejections and wait-input parkings — the two moments a task
   * teaches the network something. Best-effort and NEVER-THROW: capture failing
   * (full disk, permissions) MUST NOT affect the task lifecycle, so the whole body
   * is guarded and errors are swallowed after logging. Deterministic — no LLM.
   */
  private recordLesson(taskId: string, input: {
    kind: 'verify-fail' | 'wait-input' | 'blocked' | 'quality-shadow' | 'gate-panel';
    agent: string;
    persona: string;
    attempt: number;
    title?: string;
    reason?: string;
    resultText?: string;
    questions?: string[];
    panel?: LessonPanel;
  }): void {
    try {
      if (!this.config.paths?.decisions) return;
      const t = this.store.getTask(taskId);
      const lesson = buildLesson({
        kind: input.kind,
        task: taskId,
        title: t?.title || input.title || '',
        persona: input.persona,
        agent: input.agent,
        attempt: input.attempt,
        reason: input.reason,
        resultText: input.resultText,
        questions: input.questions,
        panel: input.panel
      });
      const ok = appendLesson(this.config.paths.decisions, lesson);
      if (ok) {
        const sig = lesson.requiresGuess.length ? lesson.requiresGuess.join(',') : lesson.titleSlug;
        console.log(`[lessons] recorded ${lesson.kind} ${taskId.slice(0, 8)} ${sig}`);
      }
    } catch (e: any) {
      // never let lesson capture break dispatch
      console.error(`[lessons] recordLesson failed (ignored): ${e?.message || e}`);
    }
  }

  /**
   * Completion guard for EXTERNALLY reported results — a remote agent's client
   * calls complete_task / PATCH inbox with its output. That output can itself be
   * a soft failure ("you've hit your session limit", a rate-limit / quota notice,
   * a refusal, or nothing), which the raw complete path would mark done. This
   * verifies the reported result with the same gate as a local run and, on a bad
   * verdict, hands the task to the NEXT agent in the fallback chain (or retries a
   * user-pinned agent), recording the failed agent. Only when the chain is
   * exhausted does it allow completion — as a FAILED summary. Results not
   * attributable to a configured agent (human / pipeline completions) pass through.
   */
  private verifyReportedCompletion = async (task: Task, result?: string): Promise<CompletionDecision> => {
    const text = result || '';
    const agents = this.config.orchestration.agents || {};
    const agentId = typeof task.context?.agent === 'string' ? canonicalAgentId(this.config, task.context.agent) : undefined;

    // Results not attributable to a configured agent (human / pipeline
    // completions) skip the failure/fallback gate, but a QUESTION back to the
    // user is still parked so it isn't silently marked done.
    if (!agentId || !agents[agentId]) {
      const req = detectInputRequest(text, this.inputOpts());
      if (req.needsInput) {
        this.recordLesson(task.id, {
          kind: 'wait-input', agent: agentId || '', persona: this.resolvePersona(task) || agentId || '',
          attempt: (Number(task.context?.attempts) || 0) + 1, questions: req.questions, resultText: text
        });
        return { action: 'wait-input', questions: req.questions };
      }
      const bg = this.backgroundDecision(task, text);
      if (bg) return bg;
      const footer = parseStatusFooter(text);
      if (footer.status === 'BLOCKED') {
        this.recordLesson(task.id, {
          kind: 'blocked', agent: agentId || '', persona: this.resolvePersona(task) || agentId || '',
          attempt: (Number(task.context?.attempts) || 0) + 1, reason: footer.reason, resultText: text
        });
        return { action: 'complete', result: this.blockedResult(footer, text), context: this.footerContext(footer) };
      }
      return { action: 'complete', context: this.footerContext(footer, task, text) };
    }

    // Strict gate precedence:
    //   (1) hard/soft FAILURE (rate-limit/quota/empty) — decided first, so a soft
    //       failure is a handover, never a wait-input.
    //   (2) QUESTION back to the user — an otherwise-ok result that asks for input
    //       is parked on wait-input BEFORE the LLM gate. The LLM verifier is told
    //       to FAIL anything that "does not actually address the task", which a
    //       genuine question does; running it first would turn the question into a
    //       handover and strand it.
    //   (3) LLM quality gate — only a genuine deliverable is judged for completion.
    const detVerdict = this.deterministicVerdict({ ok: true, text });
    let verdict = detVerdict;
    // Conversational turns skip question-parking + the LLM gate (see execute()).
    if (verdict.ok && isConversational(task)) return { action: 'complete' };
    if (verdict.ok) {
      const req = detectInputRequest(text, this.inputOpts());
      if (req.needsInput) {
        this.recordLesson(task.id, {
          kind: 'wait-input', agent: agentId,
          persona: this.resolvePersona(task) || (typeof task.context?.personaName === 'string' ? task.context.personaName : '') || agentId,
          attempt: (Number(task.context?.attempts) || 0) + 1, questions: req.questions, resultText: text
        });
        console.log(`Dispatcher: reported result for task ${task.id} on ${agentId} is a QUESTION → wait-input (${req.matched || 'phrase'})`);
        return { action: 'wait-input', questions: req.questions };
      }
      const bg = this.backgroundDecision(task, text);
      if (bg) {
        console.log(`Dispatcher: reported result for task ${task.id} on ${agentId} is still WAITING on background work → defer (${bg.note || 'phrase'})`);
        return bg;
      }
      // (2.75) STATUS footer — BLOCKED fails the task without a handover (not a
      //        agent problem) and skips the LLM gate; other values are recorded.
      const footer = parseStatusFooter(text);
      if (footer.status === 'BLOCKED') {
        this.recordLesson(task.id, {
          kind: 'blocked', agent: agentId,
          persona: this.resolvePersona(task) || (typeof task.context?.personaName === 'string' ? task.context.personaName : '') || agentId,
          attempt: (Number(task.context?.attempts) || 0) + 1, reason: footer.reason, resultText: text
        });
        console.log(`Dispatcher: reported result for task ${task.id} on ${agentId} is STATUS: BLOCKED → failed, no handover (${(footer.reason || '').slice(0, 80)})`);
        return { action: 'complete', result: this.blockedResult(footer, text), context: this.footerContext(footer) };
      }
      verdict = await this.qualityGateVerdict(task, text, agentId, (Number(task.context?.attempts) || 0) + 1);
      if (verdict.ok) {
        return {
          action: 'complete',
          context: {
            ...this.footerContext(footer, task, text),
            ...(task.context?.specVerdict ? { specVerdict: task.context.specVerdict } : {})
          }
        };
      }
    }

    let failReason = verdict.reason || (result || '').slice(0, 300);
    if (/^\s*TIMEOUT\b/i.test(failReason) || /^\s*TIMEOUT\b/i.test(text)) {
      const progSummary = this.summarizeProgressLedger(task.id);
      if (progSummary) failReason = `${failReason} — captured ${progSummary}`;
    }
    const progText = (/^\s*TIMEOUT\b/i.test(failReason) || /^\s*TIMEOUT\b/i.test(text)) ? this.readProgressLedger(task.id) : null;
    const attempt = Number(task.context?.attempts) || 0;
    const persona = this.resolvePersona(task)
      || (typeof task.context?.personaName === 'string' ? task.context.personaName : '') || agentId;
    const division = typeof task.context?.division === 'string' ? task.context.division : undefined;
    const rateLimited = isCliRateLimitSignal({ gateFailed: !detVerdict.ok, gateReason: detVerdict.reason });
    this.recordFailedAgent(task.id, { agent: agentId, persona, attempt: attempt + 1, reason: failReason }, rateLimited);
    this.recordLesson(task.id, { kind: 'verify-fail', agent: agentId, persona, attempt: attempt + 1, reason: failReason, resultText: progText ? `${text}\n${progText}` : text });
    console.log(`Dispatcher: verifier REJECTED reported result for task ${task.id} on ${agentId} — ${failReason.slice(0, 80)}`);

    // A user-pinned agent (context.agent WITHOUT agentAuto) retries itself up to
    // inbox.maxRetries; a chain rung (agentAuto) advances to the next agent.
    const pinned = !task.context?.agentAuto;
    const chain = pinned ? [] : this.chainFor(persona, division, task.context);
    const bound = pinned ? this.config.inbox.maxRetries : chain.length;
    const nextAttempt = attempt + 1;

    if (nextAttempt < bound) {
      const t = this.store.getTask(task.id);
      if (t) {
        const nextAgent = pinned ? agentId : (chain[nextAttempt] || '?');
        t.status = 'pending';
        delete t.claimedAt;
        delete t.claimedBy;
        t.context = {
          ...(t.context || {}),
          attempts: nextAttempt,
          dispatched: false,
          remoteWaitSince: undefined,
          // chain rung: drop the auto agent pin so planFor selects the next rung;
          // user pin: keep the agent so the same one is retried.
          agent: pinned ? agentId : undefined,
          agentAuto: undefined
        };
        t.result = `attempt ${nextAttempt}/${bound} failed on ${agentId}${pinned ? ' — retrying' : ` — handing over to ${nextAgent}`}: ${failReason}`;
        this.store.saveTask(t);
        console.log(`Dispatcher: remote handover — task ${task.id} attempt ${nextAttempt} on ${agentId} failed, next → ${nextAgent}`);
      }
      return { action: 'handover' };
    }

    // Chain exhausted — complete as FAILED, summarising which agents were tried.
    const failed = Array.isArray(this.store.getTask(task.id)?.context?.failedAgents)
      ? this.store.getTask(task.id)!.context!.failedAgents as Array<{ agent: string; reason: string }>
      : [];
    const failedList = failed.map(f => `${f.agent} (${f.reason})`).join('; ');
    return {
      action: 'complete',
      result: `FAILED after ${bound} attempt(s) (chain exhausted). Agents that failed: ${failedList || agentId}. Last output: ${(result || '').slice(0, 800)}`
    };
  };

  private async execute(task: Task, plan: ExecPlan): Promise<void> {
    const orch = this.config.orchestration;
    const role = plan.persona;
    if (!this.workerId) return;

    const claimed = this.store.claimTask({ taskId: task.id, workerId: this.workerId, internal: true });
    if (!claimed) return;
    // Mark the claim as dispatcher-owned so startup handover can reclaim it
    // and stamp WHICH agent + thinking level this run uses, so the in-progress
    // card can show them while it runs (ranAgent is only written at completion,
    // and an auto-routed task has no context.agent / context.thinking of its own).
    claimed.context = {
      ...(claimed.context || {}), dispatched: true,
      liveAgent: plan.agentId || plan.label,
      liveThinking: this.thinkingFor(normalizeThinking(claimed.context?.thinking) || plan.thinking)
    };
    this.store.saveTask(claimed);

    // Surface the worker as its own active agent so the dashboard shows WHO
    // is working (e.g. hermes/engineer · local-cc-opus-5-5), not just the coordinator.
    const worker = this.store.registerWorker({
      platform: plan.platform,
      workerName: plan.label,
      sessionId: 'dispatcher-worker',
      capabilities: [role || plan.label],
      currentTask: task.title
    });
    this.store.updateHeartbeat({ workerId: worker.id, status: 'working', currentTask: task.title });

    this.running.set(task.id, { role: plan.label, startedAt: Date.now(), workerId: worker.id, agentId: plan.agentId });
    console.log(`Dispatcher: [${plan.label}/${plan.exec}:${plan.model || 'default'}@${this.thinkingFor(normalizeThinking(task.context?.thinking) || plan.thinking)}] running task ${task.id} — ${task.title}`);

    // Brief sharpener (PS-1) for tasks that skipped intake: cheap-agent pre-pass if
    // acceptance criteria are missing. Runs AFTER `running` is set so the task holds
    // its agent slot meanwhile, and merges only the sharpened fields into a fresh
    // read — never a stale snapshot over the claim.
    if (shouldSharpenTask(task, this.config)) {
      const work = structuredClone(task);
      await sharpenTask(work, { config: this.config, decisionsDir: this.config.paths?.decisions });
      const fresh = this.store.getTask(task.id);
      if (fresh) {
        mergeSharpenedContext(fresh, work);
        this.store.saveTask(fresh);
        task.context = fresh.context;
      }
    }

    // Persistent per-task artifacts dir (agents save files here → downloadable).
    const artDir = this.artifactsDir(task.id);
    const outDir = join(artDir, OUTPUTS_SUBDIR);
    try { mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
    // Attempt start (minus a little clock slack): the artifact gate only lints files
    // written during THIS attempt, so an earlier agent's leftovers can't fail it.
    const attemptStartedMs = Date.now() - 2000;

    // CODE tasks (see core/worktree.ts) run in their own git worktree so concurrent
    // agents don't clobber each other. Any failure falls back to the shared checkout.
    let agentCwd = artDir;
    let wtNote = '';
    if (plan.exec !== 'script') {
      try {
        const repo = codeTaskRepo(task);
        if (repo) {
          const wt = ensureWorktree(repo, task.id);
          task.worktree = { ...task.worktree, ...wt, pruned: false };
          const fresh = this.store.getTask(task.id);
          if (fresh) { fresh.worktree = task.worktree; this.store.saveTask(fresh); }
          agentCwd = wt.path;
        }
      } catch (e: any) {
        task.worktree = undefined;
        wtNote = `worktree creation failed (${String(e?.message || e).split('\n')[0]}) — falling back to the shared checkout\n`;
        console.warn(`Dispatcher: worktree creation failed for task ${task.id}; using shared checkout:`, e?.message || e);
      }
    }
    // G2: re-read right before building the prompt so a background intake
    // sharpen that landed after the claim is not missed.
    { const latest = this.store.getTask(task.id); if (latest?.context) task.context = { ...latest.context, ...(task.context?.dispatched ? { dispatched: true } : {}) }; }
    const prompt = this.buildPrompt(task, plan);
    // claude/agy run in stream-json mode here (and only here — probes and the
    // verifier keep plain text) so progress.log shows each tool call and message
    // as it happens instead of nothing until the final answer.
    const streaming = STREAMING_EXECS.has(plan.exec);
    // A task can opt out of the lean claude profile with context.claudeProfile='full'.
    const argv = [...this.buildArgv({ exec: plan.exec, model: plan.model, thinking: normalizeThinking(task.context?.thinking) || plan.thinking, command: plan.command }, prompt,
      `${task.title}\n${task.description || ''}`, task.context?.claudeProfile === 'full'), ...streamArgs(plan.exec)];
    const renderer = streaming ? createStreamRenderer(plan.exec) : null;
    // hermes writes its usage report to a file (-z only); metered like the streaming execs.
    const hermesUsageFile = plan.exec === 'hermes' && !plan.command ? join(tmpdir(), `cowork-hermes-usage-${task.id}-${plan.attempt}.json`) : null;
    if (hermesUsageFile) argv.push('--usage-file', hermesUsageFile);
    // A/B (plan phase 3): half of goal execution tasks run with auto-memory off.
    const memoryAB = this.config.orchestration.goals?.autoMemoryAB === true && plan.exec === 'claude'
      && task.context?.goalGenerated === true && task.context?.role === 'goal-achiever';
    const memoryOff = memoryAB && hashArm(task.id);

    // Live PROGRESS LOG: stream the agent's stdout/stderr to artifacts/<id>/progress.log
    // as it runs, so the dashboard can show a "what is it doing right now" window on
    // the in-progress card (served via GET /api/inbox/:id/progress → Store.readProgressLog).
    // Opened with the 'w' flag so each run starts a fresh log (a re-run isn't appended
    // to the prior attempt's output).
    let plog: WriteStream | null = null;
    try { plog = createWriteStream(join(artDir, 'progress.log'), { flags: 'w' }); } catch { plog = null; }
    // The open is async: if the task is deleted (its artifacts dir removed) before
    // it completes, the stream emits 'error' — unhandled, that crashes the server.
    plog?.on('error', () => { plog = null; });
    const logProgress = (s: string) => { try { plog?.write(s); } catch { /* best-effort */ } };
    logProgress(`[${new Date().toISOString()}] ▶ ${plan.label} (${plan.exec}:${plan.model || 'default'}) started\n   task: ${task.title}\n\n`);
    if (wtNote) logProgress(wtNote);
    else if (task.worktree) logProgress(`worktree: ${task.worktree.path} (branch ${task.worktree.branch})\n\n`);

    const output = await new Promise<{ ok: boolean; text: string; stderr?: string }>((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        // Run the agent INSIDE its artifacts dir. Without a cwd the child
        // inherits the server's — the repo itself — so anything an agent wrote
        // with a relative path (scratch scripts, generated images) landed in
        // server/ and dirtied the working tree. Rooted here, those files become
        // the task's artifacts instead. exec:script keeps the server cwd because
        // its configured command is a repo-relative path (./deploy/…).
        ...(plan.exec === 'script' ? {} : { cwd: agentCwd }),
        // Own process group (pgid = child pid) so cancel/timeout can kill the
        // agent's whole tree (tool shells, scripts) — not just the top process.
        // Not unref'd: the server still waits on it and reaps it.
        detached: true,
        env: {
          ...process.env,
          // exec:script pipelines read the task from these instead of a prompt.
          COWORK_TASK_ID: task.id,
          COWORK_TASK_TITLE: task.title,
          COWORK_TASK_DESCRIPTION: task.description,
          COWORK_TASK_CONTEXT: JSON.stringify(task.context || {}),
          COWORK_API: `http://localhost:${this.config.server.port}/api`,
          COWORK_ARTIFACTS_DIR: artDir,
          COWORK_OUTPUTS_DIR: outDir,
          ...(memoryOff ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
          // When the server runs https with a self-signed cert, node-based child
          // agents (claude CLI, exec:script pipelines) must trust it to reach
          // COWORK_API or remote endpoints — add the cert as an extra CA rather than
          // disabling verification. Harmless when tls is off.
          ...(this.config.server.tls ? { NODE_EXTRA_CA_CERTS: this.config.server.tls.certFile } : {}),
          // Children that call COWORK_API (orchestrator curls, scripts) send this
          // as "Authorization: Bearer $COWORK_API_KEY".
          ...(this.config.server.apiKey ? { COWORK_API_KEY: this.config.server.apiKey } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      // Streaming execs: `out` is the answer recovered from the JSON events (the
      // `result` event, else the assistant text so far) — the same text plain `-p`
      // would have printed — so verification below is unchanged.
      const answer = () => (renderer ? renderer.finalText() : out);
      this.children.set(task.id, child);
      // The task may have been deleted between claim and spawn.
      if (this.cancelled.has(task.id)) void killProcessTree(child.pid, { graceMs: orch.killGraceMs ?? 5000 });
      const timer = setTimeout(() => {
        void killProcessTree(child.pid, { graceMs: orch.killGraceMs ?? 5000 });
        resolve({ ok: false, text: `TIMEOUT after ${orch.taskTimeoutMs}ms\n${answer()}\n${err}`, stderr: err });
      }, orch.taskTimeoutMs);
      child.stdout.on('data', (d) => {
        const s = d.toString();
        if (renderer) logProgress(stripAnsi(renderer.feed(s)));
        else { out += s; logProgress(stripAnsi(s)); }
      });
      child.stderr.on('data', (d) => { const s = d.toString(); err += s; logProgress(stripAnsi(s)); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, text: `SPAWN ERROR: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (renderer) { logProgress(stripAnsi(renderer.flush())); out = renderer.finalText(); }
        this.recordRunUsage(task.id, plan.agentId, renderer?.usage() ?? this.readHermesUsage(hermesUsageFile), memoryAB ? (memoryOff ? 'memory-off' : 'memory-on') : undefined);
        // Strip ANSI/terminal control sequences some CLIs emit even to a pipe
        // (e.g. Ollama's streaming cursor redraws) so results are clean text.
        const clean = stripAnsi(out).trim();
        if (code === 0 && clean) resolve({ ok: true, text: clean, stderr: err });
        else resolve({ ok: code === 0, text: (clean || stripAnsi(err).trim() || `exit code ${code}`), stderr: err });
      });
    });

    logProgress(`\n[${new Date().toISOString()}] ■ finished — ${output.ok ? 'ok' : 'failed/empty'} (verifying result…)\n`);
    try { plog?.end(); } catch { /* best-effort */ }
    if (task.worktree) {
      try {
        writeWorktreeDiff(task.worktree, join(artDir, 'worktree.diff'));
        const fresh = this.store.getTask(task.id);
        if (fresh) { fresh.worktree = task.worktree; this.store.saveTask(fresh); }
      }
      catch (e) { console.warn(`Dispatcher: worktree.diff failed for task ${task.id}:`, e); }
    }

    this.running.delete(task.id);
    this.children.delete(task.id);
    this.store.removeWorker(worker.id);

    // Deleted mid-run: the agent was killed and nobody is waiting for this result.
    // Stop here — verifying / handing over would re-run a deleted task on the next
    // agent (or re-save its file).
    const wasCancelled = this.cancelled.delete(task.id);
    if (wasCancelled || !this.store.getTask(task.id)) {
      const paused = this.store.getTask(task.id)?.status === 'paused';
      console.log(`Dispatcher: task ${task.id} was ${paused ? 'paused' : 'deleted'} while running on ${plan.agentId} — run discarded`);
      return;
    }

    // Count this run: the local dispatcher ran the agent; attribute submission
    // to whoever created the task.
    this.store.countRun('local', plan.agentId);
    if (task.from?.agent) this.store.countSubmitted(task.from.agent, plan.agentId);
    if (plan.exec) {
      try { this.eventBus.emitAgentExecuted(plan.agentId, plan.exec, task.id); } catch { /* ignore */ }
    }

    // VERIFY the result in strict gate precedence:
    //   (1) hard/soft FAILURE — an agent that hit a rate limit (or refused, or
    //       returned nothing) can still exit 0 and masquerade as a clean success;
    //       the deterministic gate rejects those so the handover below advances to
    //       the next fallback agent instead of marking a non-result "done".
    //   (2) QUESTION for the user — an otherwise-ok result that asks for input is
    //       a SUCCESSFUL run awaiting the user, parked on wait-input below. It must
    //       be recognised BEFORE the LLM gate: that verifier is told to FAIL a
    //       result that "does not actually address the task", which a genuine
    //       question does — running it first would hand the question to the next
    //       agent and strand it, never asking the user.
    //   (2.5) BACKGROUND WAIT — an otherwise-ok, non-question result where the
    //       agent is still waiting on long background work it launched. It is a
    //       successful run that is NOT YET a deliverable: DEFER (re-arm on
    //       `scheduled`) below instead of marking it done and closing the session.
    //       Recognised BEFORE the LLM gate for the same reason a question is — that
    //       verifier would FAIL a "still waiting" result and hand it off wrongly.
    //   (3) LLM quality gate — only a genuine deliverable is judged for completion.
    const detVerdict = this.deterministicVerdict(output);
    // A CONVERSATIONAL turn (voice assistant / chat — context.conversational) is a
    // reply in a live dialogue: asking the user a question IS the deliverable, so
    // it must never be parked on wait-input (the orchestrator would auto-answer on
    // the user's behalf), deferred, linted or LLM-judged. Only the deterministic
    // failure gate (rate limit / empty) still applies, so handover keeps working.
    const conversational = isConversational(task);
    const inputReq: InputRequest = detVerdict.ok && !conversational ? detectInputRequest(output.text, this.inputOpts()) : { needsInput: false, questions: [] };
    const bgWait: BackgroundWait = detVerdict.ok && !inputReq.needsInput && !conversational
      ? detectBackgroundWait(output.text, this.backgroundOpts()) : { waiting: false };
    // Only defer while under the safety cap; past it, treat the result as final so a
    // never-finishing background job can't loop the task forever.
    const bgDefer = bgWait.waiting && this.backgroundDeferralCount(task) < this.maxBackgroundDeferrals();
    // (2.7) ARTIFACT gate — deterministic lint of the files this attempt wrote
    //       (core/artifact-lint.ts). Only for a would-be deliverable (not a
    //       question / background wait). CRITICAL defects reject the attempt like
    //       a soft failure — except on the LAST attempt of the chain, where they
    //       are downgraded to warnings so a real deliverable is never discarded
    //       outright (same fail-open stance as the LLM gate).
    //   (2.75) STATUS footer (P0-2) — BLOCKED is final: no LLM gate, no handover.
    const deliverable = detVerdict.ok && !inputReq.needsInput && !bgDefer && !conversational;
    const footer: StatusFooter | null = deliverable ? parseStatusFooter(output.text) : null;
    const blocked = footer?.status === 'BLOCKED';
    const lastAttempt = plan.attempt + 1 >= (plan.pinned ? this.config.inbox.maxRetries : plan.chainLen);
    const lint = deliverable && !blocked ? this.artifactVerdict(task, artDir, attemptStartedMs, lastAttempt) : null;
    const verdict: VerifyVerdict = !detVerdict.ok
      ? detVerdict
      : inputReq.needsInput || bgDefer || conversational || blocked
        ? { ok: true }                                 // question / bg-wait / blocked → skip the LLM gate, park below
        : lint && !lint.ok
          ? lint
          : await this.qualityGateVerdict(task, output.text, plan.agentId, plan.attempt + 1);
    if (output.ok && !verdict.ok) {
      console.log(`Dispatcher: verifier REJECTED task ${task.id} result on ${plan.agentId} — ${verdict.reason}`);
    }

    // Handover: on failure advance to the NEXT agent in the resolved chain
    // (or, for a pinned agent, retry it up to inbox.maxRetries).
    const bound = plan.pinned ? this.config.inbox.maxRetries : plan.chainLen;
    if (!verdict.ok) {
      // The `agy models` probe inside (≤60 s) runs after this task's slot was released
      // (running.delete above) and execute() is fire-and-forget, so it only delays
      // this task's own completion — never other tasks' dispatch or completion.
      const classified = await classifyCliFailure(
        { exec: plan.exec, model: plan.exec === 'agy' ? agyModelSlug(plan.model, this.thinkingFor(normalizeThinking(task.context?.thinking) || plan.thinking)) : plan.model, text: output.text, stderr: output.stderr, cwd: agentCwd, startedMs: attemptStartedMs },
        detVerdict, verdict.reason || output.text.slice(0, 300));
      let failReason = classified.failReason;
      if (classified.agyDiag) console.warn(`Dispatcher: ${plan.agentId} — ${classified.agyDiag}`);
      const isTimeout = /^\s*TIMEOUT\b/i.test(failReason) || /^\s*TIMEOUT\b/i.test(output.text);
      const progSummary = isTimeout ? this.summarizeProgressLedger(task.id) : null;
      const progText = isTimeout ? this.readProgressLedger(task.id) : null;
      if (progSummary) {
        failReason = `${failReason} — captured ${progSummary}`;
      }
      this.recordFailedAgent(task.id, { agent: plan.agentId, persona: plan.persona, attempt: plan.attempt + 1, reason: failReason }, classified.rateLimited);
      this.recordLesson(task.id, {
        kind: 'verify-fail',
        agent: plan.agentId,
        persona: plan.persona,
        attempt: plan.attempt + 1,
        reason: failReason,
        resultText: progText ? `${output.text}\n${progText}` : output.text
      });
      let partialArtifacts: string[] = [];
      try {
        partialArtifacts = readdirSync(artDir).filter(f => { try { return statSync(join(artDir, f)).isFile(); } catch { return false; } });
      } catch { /* ignore */ }
      const fresh = this.store.getTask(task.id);
      if (fresh) {
        if (partialArtifacts.length) (fresh as any).artifacts = partialArtifacts;
        const nextAttempt = plan.attempt + 1;
        if (nextAttempt < bound) {
          const nextAgent = plan.pinned ? plan.agentId : (this.chainFor(plan.persona, plan.division, fresh.context)[nextAttempt] || '?');
          fresh.status = 'pending';
          delete fresh.claimedAt;
          delete fresh.claimedBy;
          fresh.context = { ...(fresh.context || {}), attempts: nextAttempt, dispatched: false };
          fresh.result = `attempt ${plan.attempt + 1}/${bound} failed on ${plan.agentId}${plan.pinned ? ' — retrying' : ` — handing over to ${nextAgent}`}: ${failReason}`;
          this.store.saveTask(fresh);
          console.log(`Dispatcher: handover — task ${task.id} attempt ${plan.attempt + 1} failed on ${plan.agentId} (${failReason.slice(0, 80)}), next → ${nextAgent}`);
          return;
        }
      }
    }

    // Persist a markdown copy + collect any artifacts the agent produced.
    try { writeFileSync(join(artDir, 'result.md'), `# ${task.title}\n\n${output.text}\n`); } catch { /* ignore */ }
    // outputs/ (the final deliverables) is listed on its own as task.outputs, so
    // the artifacts scan skips it rather than showing those files twice. Both lists
    // are capped (TASK_ARTIFACT_LIST_MAX) and skip dependency dirs: a run that cloned
    // repos into its artifacts dir once stored 61k paths and froze the Tasks page.
    const artScan = listArtifactFiles(artDir, { skipTop: OUTPUTS_SUBDIR });
    const artifacts: string[] = artScan.files;
    const outScan = listArtifactFiles(outDir);
    const outputs: string[] = outScan.files;
    const stampLists = (t: Task) => {
      if (artifacts.length) (t as any).artifacts = artifacts;
      if (artScan.total > artifacts.length) t.artifactsTotal = artScan.total; else delete t.artifactsTotal;
      if (outputs.length) t.outputs = outputs;
    };

    // The result is a QUESTION back to the user (not a failure — verdict is ok —
    // and not a finished deliverable). Park the task on `wait-input` with the
    // questions as an interaction packet: the orchestrator neither marks it done
    // nor hands it to a fallback agent. Answering from the Inbox card releases it
    // back to `pending`, re-dispatched with the answers in context.humanInput.
    if (verdict.ok) {
      const req = inputReq;   // computed above (gate 2), before the LLM gate
      if (req.needsInput) {
        const t = this.store.getTask(task.id);
        if (t) {
          t.context = { ...(t.context || {}), ranPersona: plan.persona, ranDivision: plan.division, ranAgent: plan.agentId, isRoster: plan.isRoster };
          stampLists(t);
          this.store.saveTask(t);
        }
        this.recordLesson(task.id, { kind: 'wait-input', agent: plan.agentId, persona: plan.persona, attempt: plan.attempt + 1, questions: req.questions, resultText: output.text });
        this.store.parkForInput({ taskId: task.id, questions: req.questions, result: output.text.slice(0, 4000) });
        console.log(`Dispatcher: task ${task.id} paused on wait-input — agent asked ${req.questions.length} question(s) (${req.matched || 'phrase'})`);
        return;
      }
    }

    // The agent is still WAITING on long background work it launched (gate 2.5).
    // Do NOT mark the task done / close the session: re-arm it on `scheduled` a
    // short while out so a later run checks whether the background job finished
    // and only then delivers. Bounded by maxBackgroundDeferrals (checked into
    // bgDefer above) so a never-finishing job can't loop forever.
    if (verdict.ok && bgDefer) {
      const t = this.store.getTask(task.id);
      if (t) {
        t.context = { ...(t.context || {}), ranPersona: plan.persona, ranDivision: plan.division, ranAgent: plan.agentId, isRoster: plan.isRoster };
        stampLists(t);
        this.store.saveTask(t);
      }
      this.store.deferForBackground({ taskId: task.id, note: bgWait.note, result: output.text.slice(0, 4000), pollMs: this.backgroundPollMs() });
      const n = this.backgroundDeferralCount(this.store.getTask(task.id) || task);
      console.log(`Dispatcher: task ${task.id} DEFERRED (background wait #${n}/${this.maxBackgroundDeferrals()}) — re-runs in ${Math.round(this.backgroundPollMs() / 1000)}s (${bgWait.matched || 'phrase'})`);
      return;
    }

    // The whole fallback chain is exhausted here. Summarise which agents failed
    // (from context.failedAgents) so the CEO sees exactly what was tried.
    const failedAgents = Array.isArray(this.store.getTask(task.id)?.context?.failedAgents)
      ? this.store.getTask(task.id)!.context!.failedAgents as Array<{ agent: string; reason: string }>
      : [];
    const failedList = failedAgents.map(f => `${f.agent} (${f.reason})`).join('; ');
    if (blocked) {
      this.recordLesson(task.id, { kind: 'blocked', agent: plan.agentId, persona: plan.persona, attempt: plan.attempt + 1, reason: footer!.reason, resultText: output.text });
      console.log(`Dispatcher: task ${task.id} STATUS: BLOCKED on ${plan.agentId} → failed, no handover (${(footer!.reason || '').slice(0, 80)})`);
    }
    const result = blocked
      ? this.blockedResult(footer!, output.text)
      : verdict.ok
      ? output.text.length > 2000 ? output.text.slice(0, 2000) + `\n…(full output in artifacts/${task.id}/result.md)` : output.text
      : `FAILED after ${bound} attempt(s) (chain exhausted). Agents that failed: ${failedList || plan.agentId}. Last output: ${output.text.slice(0, 800)}`;

    // Record which persona/agent ran it on the task itself (item 5) + artifacts.
    const done = this.store.getTask(task.id);
    if (done) {
      done.context = { ...(done.context || {}), ...(verdict.ok && footer ? this.footerContext(footer, task, output.text) : {}), ranPersona: plan.persona, ranDivision: plan.division, ranAgent: plan.agentId, isRoster: plan.isRoster };
      if (verdict.ok) this.store.clearAgentRateLimited(plan.agentId);   // it works again
      stampLists(done);
      if (verdict.ok && !blocked) this.notePrUrls(done, output.text);
      this.store.saveTask(done);
    }
    // internal: the dispatcher already verified this run — skip the completion guard.
    await this.store.completeTask({ taskId: task.id, result, internal: true });
    console.log(`Dispatcher: task ${task.id} ${blocked ? 'FAILED (blocked)' : verdict.ok ? 'completed' : 'FAILED (chain exhausted)'} (${output.text.length} chars${artifacts.length ? ', ' + artifacts.length + ' artifact(s)' : ''})`);
  }
}

/**
 * Why a dispatched CLI run failed, and whether its agent should go on a
 * rate-limit cooldown — decided from the CLI's own signals only (exit/gate
 * verdict + stderr tail, see isCliRateLimitSignal), never the LLM verifier's text.
 * agy rejects valid models when its catalog fetch fails (503/429): tell that
 * transient outage (rate-limit class → auto re-run on reset) from a retired
 * model. Only agy's own short error output qualifies, not a deliverable quoting it.
 * dsh: when the run itself failed (deterministic gate), the reason is the last
 * turn/end error code from the progress plugin's stderr line or the dsh session
 * log (core/dsh-failure.ts), not the first line of stdout. A quality-gate
 * rejection of a clean dsh run keeps the verifier's reason.
 */
export async function classifyCliFailure(
  run: { exec?: string; model?: string; text: string; stderr?: string; cwd?: string; startedMs?: number },
  det: VerifyVerdict,
  reason: string,
  listModels: () => Promise<string[] | null> = listAgyModels,
  dshHome?: string,
): Promise<{ failReason: string; rateLimited: boolean; agyDiag?: string }> {
  let failReason = reason;
  let rateLimited = isCliRateLimitSignal({ gateFailed: !det.ok, gateReason: det.reason, stderr: run.stderr });
  let agyDiag: string | undefined;
  if (run.exec === 'dsh' && !det.ok) {
    const dsh = dshFailureReason(run, dshHome);
    if (dsh) failReason = dsh;
  }
  if (run.exec === 'agy' && isAgyModelRejection(run.text)) {
    const diag = diagnoseAgyModelFailure(run.model || '', run.text, await listModels());
    if (diag) {
      failReason = agyDiag = diag;
      rateLimited = rateLimited || isRateLimitFailure(diag);
    }
  }
  return { failReason, rateLimited, agyDiag };
}
