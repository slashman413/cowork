import { spawn } from 'child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import type { Config, RoleConfig, Task } from '../types.js';
import type { EventBus } from './events.js';
import type { Store, CompletionDecision } from './store.js';
import type { Workflows } from './workflows.js';
import { verifyOutput, buildVerifierPrompt, parseLlmVerdict, detectInputRequest, type VerifyVerdict, type InputOptions, type InputRequest } from './result-verifier.js';
import { buildLesson, appendLesson } from './lessons.js';

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

/** A fully-resolved execution plan for one attempt of one task. */
interface ExecPlan {
  agent: string;                // special agent name or roster agent slug
  division?: string;            // division for roster agents (chain + display)
  isRoster: boolean;            // true → run the roster .md persona
  brainId: string;             // brain used this attempt
  attempt: number;             // 0-based index into the resolved brain chain
  chainLen: number;            // length of the chain (0 if pinned)
  pinned: boolean;             // context.brain override (retry same brain)
  label: string;                // worker display + logs
  platform: string;             // active-agent platform bucket
  exec: 'claude' | 'hermes' | 'agy' | 'script' | 'codex' | 'ollama';
  model: string;
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
export class Dispatcher {
  /** Name of the always-on coordinator agent shown in Active Agents. */
  static readonly COORDINATOR_NAME = 'orchestrator';
  private config: Config;
  private store: Store;
  private eventBus: EventBus;
  private workflows?: Workflows;
  private running = new Map<string, { role: string; startedAt: number; workerAgentId?: string; brainId?: string }>();
  private agentId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private classifying = new Set<string>();
  private decidingRuns = new Set<string>();   // orchestrated runs mid-decision (re-entrancy guard)
  /** Consecutive unusable router answers per orchestrated run (timeout/garbled). */
  private decisionFailures = new Map<string, number>();
  /** Give up on an orchestrated run after this many consecutive bad decisions. */
  static readonly MAX_DECISION_FAILURES = 3;

  constructor(config: Config, store: Store, eventBus: EventBus, workflows?: Workflows) {
    this.config = config;
    this.store = store;
    this.eventBus = eventBus;
    this.workflows = workflows;
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
    for (const a of this.store.getActiveAgents()) {
      const isCoordinator = a.platform === 'cowork' && (a.agentName === Dispatcher.COORDINATOR_NAME || a.agentName === 'dispatcher');
      if (isCoordinator || a.sessionId === 'dispatcher-worker') {
        this.store.removeAgent(a.id);
      }
    }
    // Handover: reclaim tasks a previous dispatcher run claimed but never
    // finished (service restart / crash mid-execution). context.dispatched
    // marks dispatcher-owned claims, so live interactive agents' claims are
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
    const agentNames = Object.keys(this.specialAgents());
    const agent = this.store.registerAgent({
      platform: 'cowork',
      agentName: Dispatcher.COORDINATOR_NAME,
      capabilities: agentNames
    });
    this.agentId = agent.id;
    // Verify EXTERNALLY reported results too: a remote brain (e.g. a
    // remote-examplehost-cc-* client) can report a rate-limit / "session limit"
    // notice as its result and it would otherwise be marked done. The guard runs
    // the same verifier and hands such results to the next fallback brain.
    this.store.setCompletionGuard((t, r) => this.verifyReportedCompletion(t, r));
    this.timer = setInterval(() => this.tick(), orch.pollIntervalMs);
    const clsMsg = orch.classifier?.enabled ? `classifier ${orch.classifier.model}` : 'classifier off';
    console.log(`Dispatcher: started (agents: ${agentNames.join(', ')}; max ${orch.maxConcurrent} concurrent; ${clsMsg}; staleClaim ${orch.staleClaimMs ?? 0}ms)`);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  public getRunning(): { taskId: string; role: string; startedAt: number }[] {
    return Array.from(this.running.entries()).map(([taskId, r]) => ({ taskId, ...r }));
  }

  /** Special (non-roster) executor agents: orchestrator, generalist, video. */
  private specialAgents(): Record<string, { description: string; brains: string[] }> {
    return this.config.orchestration.agents || {};
  }
  private isSpecial(name: string): boolean {
    return !!this.specialAgents()[name];
  }

  /** Resolve the brain fallback chain for an agent. Precedence:
   *   special agent      → its own agents[name].brains
   *   roster agent       → its own agentChains[slug] override, else its
   *                        division's override, else the global default chain. */
  private chainFor(agent: string, division?: string): string[] {
    const orch = this.config.orchestration;
    if (this.isSpecial(agent)) return orch.agents[agent].brains || [];
    // A roster agent's own override wins over its division and the global default.
    const own = orch.agentChains && orch.agentChains[agent];
    if (own && own.length) return own;
    const div = division || '';
    return (orch.divisionChains && orch.divisionChains[div]) || orch.defaultChain || [];
  }

  /** The chosen agent for a task: a special agent name, or a roster agent slug. */
  private resolveAgent(task: Task): string | null {
    if (task.tags?.includes('manual')) return null;
    const ctx = task.context || {};
    const named = typeof ctx.agent === 'string' ? ctx.agent : typeof ctx.role === 'string' ? ctx.role : undefined;
    if (named && (this.isSpecial(named) || this.store.getAgentPersona(named))) return named;
    for (const tag of task.tags || []) if (this.isSpecial(tag) || this.store.getAgentPersona(tag)) return tag;
    if (task.skill && (this.isSpecial(task.skill) || this.store.getAgentPersona(task.skill))) return task.skill;
    return null;
  }

  /** How many local runs this ONE brain instance may serve at once. Per-brain
   *  {@link BrainConfig.maxConcurrent}, else orchestration.defaultBrainConcurrency,
   *  else 1. Never returns < 1. Remote brains are governed by their own client, so
   *  this only bounds locally-spawned runs. */
  private brainCap(brainId: string): number {
    const b = this.config.orchestration.brains?.[brainId];
    const cap = b?.maxConcurrent ?? this.config.orchestration.defaultBrainConcurrency ?? 1;
    return cap > 0 ? cap : 1;
  }

  /** How many locally-spawned runs are in flight on `brainId` right now. */
  private brainLoad(brainId: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.brainId === brainId) n++;
    return n;
  }

  /**
   * Pick which rung of a fallback chain to run for a FRESH (unpinned) dispatch,
   * with preference-preserving load balancing.
   *
   * The chain is an ordered PREFERENCE list (best brain first), so the preferred
   * rung `chain[attempt]` wins whenever it has spare capacity — under no contention
   * this returns `chain[attempt]` unchanged, exactly as before. Only when the
   * preferred rung is a LOCAL brain that is SATURATED (at its maxConcurrent) do we
   * scan the rest of the chain and hand the overflow to the local rung with the most
   * spare capacity. That is what stops one reliable workhorse brain (e.g.
   * `local-ha-deepseek-v4-pro`) from absorbing every concurrent task while its
   * peers sit idle.
   *
   * Remote rungs and unrunnable/missing brains are left to the caller's existing
   * index-based handling (the remote claim/grace protocol keys on `chain[attempt]`),
   * so this only ever redirects among LOCAL, runnable brains.
   */
  private selectRung(
    chain: string[], attempt: number,
    brains: Record<string, { location: string; exec?: string; maxConcurrent?: number }>
  ): { brainId: string; index: number } {
    const head = chain[attempt];
    const hb = brains[head];
    // Only load-balance a local, runnable preferred rung; anything else keeps the
    // index so remote/skip handling upstream is untouched.
    if (!hb || hb.location !== 'local' || !hb.exec) return { brainId: head, index: attempt };
    if (this.brainLoad(head) < this.brainCap(head)) return { brainId: head, index: attempt };
    // Preferred rung saturated → least-loaded local rung with room (ties: earliest).
    let bestIdx = -1, bestSlack = 0;
    for (let i = attempt; i < chain.length; i++) {
      const b = brains[chain[i]];
      if (!b || b.location !== 'local' || !b.exec) continue;
      const slack = this.brainCap(chain[i]) - this.brainLoad(chain[i]);
      if (slack > bestSlack) { bestSlack = slack; bestIdx = i; }
    }
    return bestIdx >= 0 ? { brainId: chain[bestIdx], index: bestIdx } : { brainId: head, index: attempt };
  }

  /** Persistent per-task artifacts dir (survives reboot — under the repo, gitignored). */
  private artifactsDir(taskId: string): string {
    return join(this.config.paths.artifacts, taskId);
  }

  /** True while a task still has an unanswered human-in-the-loop interaction
   *  packet (fields present and not yet `submitted`). Such a task is dispatchable
   *  only once a person has filled in the questions/checklist from the Inbox
   *  card, so their answers reach the executor via context.humanInput. */
  private awaitingHumanInput(task: Task): boolean {
    const ix = task.interaction;
    return !!ix && Array.isArray(ix.fields) && ix.fields.length > 0 && ix.status !== 'submitted';
  }

  private tick(): void {
    if (this.stopped || !this.agentId) return;
    const orch = this.config.orchestration;

    // heartbeat keeps the dispatcher and its live workers visible on the dashboard
    this.store.updateHeartbeat({
      agentId: this.agentId,
      status: this.running.size > 0 ? 'working' : 'idle',
      currentTask: Array.from(this.running.keys()).join(', ') || undefined
    });
    for (const r of this.running.values()) {
      if (r.workerAgentId) {
        this.store.updateHeartbeat({ agentId: r.workerAgentId, status: 'working' });
      }
    }

    // Rescue tasks orphaned by a crashed/exited agent (runs every tick, cheap).
    this.reclaimStaleClaims();

    // Launch scheduled tasks whose time has come: releaseDueScheduled flips each
    // due task into the pending pool (or onto wait-input if it still needs a
    // person's answers) BEFORE the pending scan below, so a just-due task is
    // dispatched on this very tick rather than the next one.
    for (const t of this.store.releaseDueScheduled()) {
      console.log(`Dispatcher: scheduled task ${t.id} is due (${t.scheduledAt}) — released to ${t.status} — ${t.title}`);
    }

    // Advance any orchestrated workflow runs: for each run awaiting a decision,
    // the orchestrator brain picks the next step (or finishes the run).
    this.driveWorkflows();

    if (this.running.size >= orch.maxConcurrent) return;

    // FIFO: listTasks sorts newest-first; dispatch oldest first so pipelines
    // (research -> synthesis) run in creation order.
    const pending = this.store.listTasks({ status: 'pending' }).reverse();
    for (const task of pending) {
      if (this.running.size >= orch.maxConcurrent) break;
      if (this.running.has(task.id)) continue;
      // Human-in-the-loop gate (defense-in-depth): a task awaiting a person's
      // answers is parked on the `wait-input` category, so it never appears in the
      // `pending` pool above and is thus never scheduled OR reassigned. This guard
      // stays as a backstop in case a task ever reaches `pending` with its
      // interaction still unanswered — running it now would leave context.humanInput
      // empty, defeating the "supply information in advance" purpose.
      if (this.awaitingHumanInput(task)) continue;
      const plan = this.planFor(task);
      switch (plan.action) {
        case 'skip': continue;               // manual, or unknown target
        case 'remote': this.handleRemoteRung(task, plan.exec); continue;
        case 'route': this.route(task); continue;
        case 'execute':
          if (!this.depsSatisfied(task)) continue;
          // Per-brain concurrency: if this brain is already at its capacity, skip
          // THIS task (don't break) so a task bound to a different, free brain can
          // still launch this tick. A brain with spare room runs the task
          // concurrently on the same instance. selectRung already steered fresh
          // dispatches toward free rungs; this backstops a pinned task or a fully
          // saturated chain.
          if (this.brainLoad(plan.exec.brainId) >= this.brainCap(plan.exec.brainId)) continue;
          this.execute(task, plan.exec).catch(e => console.error(`Dispatcher: task ${task.id} failed:`, e));
      }
    }
  }

  /** A remote brain in a chain is left pending for that machine's client to
   *  claim. We PUBLISH the target brain onto `context.brain` (flagged
   *  `brainAuto` so planFor doesn't treat it as a permanent user pin) — that is
   *  the field the remote-brain client filters on to discover its tasks. If no
   *  client claims it within remoteGraceMs, advance to the next brain so a
   *  clientless remote rung can't stall the task. A pinned remote brain waits
   *  indefinitely (the CEO asked for that exact brain). */
  private handleRemoteRung(task: Task, plan?: ExecPlan): void {
    if (!plan) return;
    this.stampPersona(task, plan);   // so the remote client runs the roster persona too
    if (plan.pinned) return;
    const grace = this.config.orchestration.remoteGraceMs ?? 0;
    const ctx = task.context || {};
    const since = Number(ctx.remoteWaitSince) || 0;
    const now = Date.now();
    // First offer: publish the target brain id so its client can find + claim it.
    if (!since || ctx.brain !== plan.brainId) {
      const t = this.store.getTask(task.id);
      if (t) {
        t.context = { ...(t.context || {}), brain: plan.brainId, brainAuto: true, remoteWaitSince: now };
        this.store.saveTask(t);
      }
      return;
    }
    // Unclaimed past the grace window → advance to the next brain in the chain.
    if (grace > 0 && now - since > grace) {
      const t = this.store.getTask(task.id);
      if (t) {
        const attempts = (Number(t.context?.attempts) || 0) + 1;
        t.context = { ...(t.context || {}), attempts, remoteWaitSince: undefined, brain: undefined, brainAuto: undefined };
        this.store.saveTask(t);
        console.log(`Dispatcher: remote rung ${plan.brainId} unclaimed ${grace}ms — advancing task ${task.id} to next brain`);
      }
    }
  }

  /** Persist the roster agent's full .md persona onto context.persona so a REMOTE
   *  client — which builds its own prompt from the task — runs the persona too,
   *  not just the task text. Local runs inject the persona directly (buildPrompt),
   *  so only remote rungs need this. Idempotent: skips if already current. */
  private stampPersona(task: Task, plan: ExecPlan): void {
    if (!plan.isRoster || !plan.agent) return;
    const persona = this.store.getAgentPersona(plan.agent)?.persona;
    if (!persona || task.context?.persona === persona) return;
    const t = this.store.getTask(task.id);
    if (t) {
      t.context = { ...(t.context || {}), persona, agentName: plan.agent, division: plan.division };
      this.store.saveTask(t);
      task.context = t.context;
    }
  }

  /**
   * Decide how a pending task should run.
   *   1. `manual` tag                 -> skip
   *   2. explicit `context.brain` pin -> run on exactly that brain (retries it)
   *   3. an agent (context.agent/role / tag / skill) -> run on the agent's brain
   *      CHAIN at index context.attempts; on failure the handover advances to
   *      the next brain in the list. Brains registry says local (spawn here) or
   *      remote (leave in inbox for that client).
   *   4. nothing -> classify (LLM assigns an agent)
   */
  private planFor(task: Task): { action: 'skip' } | { action: 'remote'; exec?: ExecPlan } | { action: 'route' } | { action: 'execute'; exec: ExecPlan } {
    if (task.tags?.includes('manual')) return { action: 'skip' };
    const brains = this.config.orchestration.brains || {};
    const agentName = this.resolveAgent(task) || '';
    const division = typeof task.context?.division === 'string' ? task.context.division
      : (agentName && !this.isSpecial(agentName) ? this.store.getAgentPersona(agentName)?.division : undefined);
    const attempt = Number(task.context?.attempts) || 0;

    // (2) explicit brain pin — overrides the chain, retries the same brain.
    //     `brainAuto` marks a brain the dispatcher itself published for a remote
    //     chain rung (see handleRemoteRung); that is NOT a user pin, so let it
    //     fall through to the chain logic below (which manages grace/handover).
    const ctxBrain = typeof task.context?.brain === 'string' ? task.context.brain : undefined;
    if (ctxBrain && brains[ctxBrain] && !task.context?.brainAuto) {
      return this.brainPlan(agentName, division, ctxBrain, brains[ctxBrain], { pinned: true, attempt, chainLen: 0 });
    }

    // (3) an agent (special or roster) → run on its resolved brain chain. The
    //     preferred rung is chain[attempt]; selectRung keeps it unless it is a
    //     saturated LOCAL brain, in which case the overflow is load-balanced onto
    //     the next local rung with spare capacity.
    if (agentName) {
      const chain = this.chainFor(agentName, division);
      if (!chain.length || attempt >= chain.length) return { action: 'skip' };  // exhausted / misconfigured
      const { brainId, index } = this.selectRung(chain, attempt, brains);
      const b = brains[brainId];
      if (!b) return { action: 'skip' };
      return this.brainPlan(agentName, division, brainId, b, { pinned: false, attempt: index, chainLen: chain.length });
    }

    // (4) unassigned → two-stage router picks division + roster agent.
    return { action: 'route' };
  }

  private brainPlan(
    agent: string, division: string | undefined, brainId: string,
    b: { location: string; exec?: string; model?: string; command?: string[] },
    meta: { pinned: boolean; attempt: number; chainLen: number }
  ): { action: 'remote'; exec?: ExecPlan } | { action: 'skip' } | { action: 'execute'; exec: ExecPlan } {
    const isRoster = !!agent && !this.isSpecial(agent);
    const label = isRoster ? `${division || '?'} / ${this.store.getAgentPersona(agent)?.name || agent} · ${brainId}` : `${agent || 'task'} · ${brainId}`;
    const exec: ExecPlan = {
      agent, division, isRoster, brainId, attempt: meta.attempt, chainLen: meta.chainLen, pinned: meta.pinned,
      label, platform: this.platformOf(b.exec || 'hermes'),
      exec: (b.exec || 'hermes') as ExecPlan['exec'], model: b.model || '', command: b.command
    };
    if (b.location === 'remote') return { action: 'remote', exec };   // that machine's client claims it
    if (!b.exec) return { action: 'skip' };
    return { action: 'execute', exec };
  }

  private platformOf(exec: string): string {
    const map: Record<string, string> = { claude: 'claude', agy: 'antigravity', script: 'pipeline', codex: 'codex', ollama: 'ollama', hermes: 'hermes' };
    return map[exec] || 'hermes';
  }

  /** Orchestrator-facing description of the brain registry. */
  private brainsPromptBlock(): string {
    const brains = this.config.orchestration.brains || {};
    const ids = Object.keys(brains);
    if (!ids.length) return '';
    const lines = ids.map(id => {
      const b = brains[id];
      return `  - ${id} [${b.location}]: ${b.description}`;
    });
    return `Optionally target a specific BRAIN (a model on a specific instance) by adding "brain":"<id>" to a subtask's context — e.g. {"role":"engineer","brain":"remote-aicodegen-cc-fable"}. LOCAL brains run here automatically; REMOTE brains are left in the inbox for that machine's client to claim. Available brains:\n${lines.join('\n')}`;
  }

  /**
   * Reclaim in-progress/claimed tasks that are no longer actually being worked.
   *
   * A local/remote brain CLIENT heartbeats continuously (keep-alive) whether or
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
    const active = new Map(this.store.getActiveAgents().map(a => [a.id, a]));
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

  /** The brain the router LLM runs on. Prefer the classifier config (a reliable
   *  local model dedicated to routing); otherwise the first LOCAL, runnable brain
   *  in the orchestrator/default chain. Never a remote brain (can't spawn here). */
  private routerModel(): { exec: string; model: string } {
    const orch = this.config.orchestration;
    const cls = orch.classifier;
    if (cls?.exec) return { exec: cls.exec, model: cls.model || '' };
    for (const id of [...(orch.agents.orchestrator?.brains || []), ...(orch.defaultChain || [])]) {
      const b = orch.brains?.[id];
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
   * Two-stage router: the orchestrator's brain picks a DIVISION from the roster,
   * then a specific AGENT within it. Writes context.agent (roster slug) +
   * context.division so the next tick executes it on the division's brain chain.
   * Falls back to the `generalist` special agent on any failure.
   */
  private route(task: Task): void {
    const cls = this.config.orchestration.classifier;
    if (cls && cls.enabled === false) { this.assignAgent(task, 'generalist', undefined); return; }
    if (this.classifying.has(task.id)) return;
    this.classifying.add(task.id);
    const timeout = cls?.timeoutMs || 300000;
    const divisions = this.store.divisionIds();
    const divMeta = this.store.getDivisions() || {};

    (async () => {
      try {
        if (!divisions.length) { this.assignAgent(task, 'generalist', undefined); return; }
        const divPrompt =
          `You route work in a multi-agent company. Pick the ONE best division for this task.\n\n` +
          `Task: ${task.title}\n${task.description}\n\n` +
          `Divisions:\n` + divisions.map(d => `- ${d}: ${divMeta[d]?.label || d}`).join('\n') +
          `\n\nReply with ONLY the division id.`;
        const divOut = await this.askRouter(divPrompt, timeout);
        const division = this.pickLast(divisions, divOut) || divisions[0];

        const agentsIn = this.store.agentsInDivision(division);
        if (!agentsIn.length) { this.assignAgent(task, 'generalist', undefined); return; }
        const agPrompt =
          `Pick the ONE best agent in the "${division}" division for this task.\n\n` +
          `Task: ${task.title}\n${task.description}\n\n` +
          `Agents (reply with the exact slug):\n` +
          agentsIn.map(a => `- ${a.slug}: ${a.name} — ${(a.description || '').slice(0, 120)}`).join('\n') +
          `\n\nReply with ONLY the slug.`;
        const agOut = await this.askRouter(agPrompt, timeout);
        const chosenSlug = this.pickLast(agentsIn.map(a => a.slug), agOut) || agentsIn[0].slug;
        this.assignAgent(task, chosenSlug, division);
      } catch {
        this.assignAgent(task, 'generalist', undefined);
      } finally {
        this.classifying.delete(task.id);
      }
    })();
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

  private assignAgent(task: Task, agent: string, division: string | undefined): void {
    const fresh = this.store.getTask(task.id);
    if (fresh && fresh.status === 'pending') {
      fresh.context = { ...(fresh.context || {}), agent, ...(division ? { division } : {}), routedBy: this.routerModel().model };
      this.store.saveTask(fresh);
      console.log(`Dispatcher: routed task ${task.id} -> ${division ? division + '/' : ''}${agent}`);
    }
  }

  /**
   * Drive orchestrated (adaptive) workflow runs. Unlike a DAG workflow — whose
   * whole graph is expanded up front — an orchestrated run holds a LIBRARY of
   * candidate steps and lets the orchestrator brain decide, after each step
   * finishes, which step to run next (or that the goal is met). This is that
   * decision loop: every tick, for each run awaiting a decision, we ask the
   * router brain to choose the next step key (or DONE) given the goal and the
   * results so far, then materialise that choice as an inbox task the normal
   * dispatch path executes. A per-run guard prevents overlapping decisions and
   * orchestration.maxWorkflowSteps caps a runaway loop.
   */
  private driveWorkflows(): void {
    if (!this.workflows) return;
    const cap = this.config.orchestration.maxWorkflowSteps ?? 12;
    let pending: ReturnType<Workflows['runsAwaitingDecision']>;
    try { pending = this.workflows.runsAwaitingDecision(); } catch { return; }

    for (const rec of pending) {
      if (this.decidingRuns.has(rec.runId)) continue;

      // Safety bound: too many steps dispatched → force-finish so a mis-behaving
      // orchestrator (never emitting DONE) can't spin forever.
      const dispatched = rec.history.filter(h => h.stepKey).length;
      if (dispatched >= cap) {
        this.workflows.applyDecision(rec.runId, { stepKey: null, reason: `reached step cap (${cap})` });
        continue;
      }

      const ctx = this.workflows.decisionContext(rec.runId);
      if (!ctx) continue;
      // No candidate steps left → the run has exhausted its library; finish it.
      if (!ctx.available.length) {
        this.workflows.applyDecision(rec.runId, { stepKey: null, reason: 'no candidate steps remain' });
        continue;
      }

      this.decidingRuns.add(rec.runId);
      const timeout = this.config.orchestration.classifier?.timeoutMs || 300000;
      const keys = ctx.available.map(s => s.key);
      const prompt = this.orchestratorPrompt(ctx);

      (async () => {
        try {
          const out = await this.askRouter(prompt, timeout);
          // The orchestrator answers with a step key or DONE; take the LAST match
          // so a trailing final answer wins over any earlier mention.
          const pick = this.pickLast([...keys, 'DONE'], out);
          const reason = (out.split('\n').map(l => l.trim()).filter(Boolean).pop() || '').slice(0, 200);
          if (pick === 'DONE') {
            this.decisionFailures.delete(rec.runId);
            this.workflows!.applyDecision(rec.runId, { stepKey: null, reason: reason || 'goal met' });
          } else if (pick) {
            this.decisionFailures.delete(rec.runId);
            this.workflows!.applyDecision(rec.runId, { stepKey: pick, reason });
          } else {
            // NO usable answer — the router timed out, crashed, or replied with
            // something unparseable. That is NOT "goal met": finishing here would
            // silently mark the run done having executed nothing. Leave the run
            // awaiting a decision so the next tick retries, and only give up (with
            // an honest reason) after several consecutive failures.
            const n = (this.decisionFailures.get(rec.runId) || 0) + 1;
            this.decisionFailures.set(rec.runId, n);
            console.error(`Dispatcher: orchestrated run ${rec.runId} — no usable decision from the router ` +
              `(attempt ${n}/${Dispatcher.MAX_DECISION_FAILURES}; ${out.trim() ? 'unparseable reply' : 'empty reply/timeout'})`);
            if (n >= Dispatcher.MAX_DECISION_FAILURES) {
              this.decisionFailures.delete(rec.runId);
              this.workflows!.applyDecision(rec.runId, {
                stepKey: null,
                reason: `orchestrator brain gave no usable answer after ${n} attempts (timeout or unparseable) — run abandoned, NOT completed`
              });
            }
          }
        } catch (e) {
          console.error(`Dispatcher: orchestrated run ${rec.runId} decision failed:`, e);
        } finally {
          this.decidingRuns.delete(rec.runId);
        }
      })();
    }
  }

  /** The prompt the orchestrator brain answers to pick the next step of an
   *  adaptive run: the goal, what's already been done (with results), and the
   *  remaining candidate steps. It replies with one step key, or DONE. */
  private orchestratorPrompt(ctx: NonNullable<ReturnType<Workflows['decisionContext']>>): string {
    const lines: string[] = [];
    lines.push(`You are the ORCHESTRATOR of an adaptive multi-agent workflow. Decide the single best NEXT step to run to advance the goal — or answer DONE if the goal is already met.`, '');
    if (ctx.goal) lines.push(`GOAL: ${ctx.goal}`, '');
    if (ctx.completed.length) {
      lines.push(`STEPS ALREADY DONE (with their results):`);
      for (const c of ctx.completed) {
        const res = (c.result || '').replace(/\s+/g, ' ').slice(0, 400);
        lines.push(`- ${c.key} [${c.status}]: ${c.title}${res ? `\n    → ${res}` : ''}`);
      }
      lines.push('');
    } else {
      lines.push(`No steps have run yet — pick the best first step.`, '');
    }
    lines.push(`CANDIDATE NEXT STEPS (reply with exactly one key):`);
    for (const s of ctx.available) lines.push(`- ${s.key}: ${s.title} — ${s.description.replace(/\s+/g, ' ').slice(0, 160)}`);
    lines.push('');
    lines.push(`Reply with ONLY the key of the next step to run, or DONE if the goal is met. Do not run redundant work — if the results above already satisfy the goal, answer DONE.`);
    return lines.join('\n');
  }

  /**
   * `context.dependsOn: ["<task-id>", …]` gates dispatch until every listed
   * task is done. The dependent task's prompt gets the dependencies' results
   * appended, so an integrator subtask actually sees its inputs.
   */
  private depsSatisfied(task: Task): boolean {
    const deps = task.context?.dependsOn;
    if (!Array.isArray(deps) || deps.length === 0) return true;
    return deps.every((id: string) => this.store.getTask(id)?.status === 'done');
  }

  /** The operating rules every executing agent must follow (CONVENTIONS.md at the
   *  repo root). Read once and cached — injected into every dispatched prompt so a
   *  brain cannot run without them. */
  private conventionsCache: string | null = null;
  private conventions(): string {
    if (this.conventionsCache !== null) return this.conventionsCache;
    const file = join(this.config.paths.artifacts, '..', 'CONVENTIONS.md');
    try { this.conventionsCache = readFileSync(file, 'utf-8').trim(); }
    catch { this.conventionsCache = ''; }
    return this.conventionsCache;
  }

  private buildPrompt(task: Task, plan: { agent: string; division?: string; isRoster: boolean }): string {
    const port = this.config.server.port;
    const role = plan.agent;
    const artifactsDir = this.artifactsDir(task.id);
    const lines: string[] = [];
    const rules = this.conventions();
    if (rules) lines.push(rules, ``, `---`, ``);
    if (plan.isRoster) {
      // Run the roster agent's full .md persona as the system prompt.
      const p = this.store.getAgentPersona(plan.agent);
      lines.push(p?.persona || `You are the "${plan.agent}" specialist.`, ``, `---`, ``);
      lines.push(`You have been assigned the following task. Work autonomously and produce your final deliverable as plain text (markdown allowed).`, ``);
    } else {
      lines.push(`You are the "${role}" agent in a multi-agent company. Work autonomously and produce your final deliverable as plain text output.`, ``);
    }
    lines.push(`# Task: ${task.title}`, ``, task.description, ``);
    const shownCtx = { ...(task.context || {}) } as Record<string, unknown>;
    // inputFiles is rendered as its own section with readable paths (below), and
    // humanInput as a dedicated "answers" section (below) — drop both from the raw
    // context dump so they aren't duplicated or lost as noise in the JSON blob.
    for (const k of ['persona', 'brainAuto', 'remoteWaitSince', 'dispatched', 'attempts', 'agentName', 'ranAgent', 'ranDivision', 'ranBrain', 'isRoster', 'inputFiles', 'humanInput', 'awaitingInput', 'inputQuestions']) delete shownCtx[k];
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
        `Decompose this request into concrete subtasks and dispatch them to the company via the Cowork REST API — one POST per subtask. Leave the agent UNASSIGNED and the company's router will pick the best specialist from its 250-agent roster automatically (or set context.division/context.agent yourself if you know exactly who should do it):`,
        '```bash',
        `curl -s -X POST http://localhost:${port}/api/inbox -H 'Content-Type: application/json' -d '{"title":"...","description":"...(full standalone instructions)...","from":{"platform":"claude","agent":"orchestrator"},"to":{},"priority":"normal"}'`,
        '```',
        `Each subtask description must be fully standalone — the executing specialist sees ONLY that description.`,
        `To make a subtask wait for others (e.g. a final synthesis step), add their task ids to its context: {"dependsOn":["<id1>","<id2>"]} — the API response to each POST gives the created task's id; dependencies' results are shown to the dependent agent.`,
        `After dispatching, output a summary of the plan. Check existing tasks first: curl -s http://localhost:${port}/api/inbox?limit=20`,
        ``
      );
    }
    lines.push(
      ``,
      `If you generate any files (documents, media, data), save them to the directory: ${artifactsDir} — they become downloadable from the dashboard when the task completes.`,
      `When done, your final output (stdout) becomes the task result visible to the CEO on the dashboard.`,
      `If you CANNOT finish without more information or a decision from the user, do NOT guess or invent an answer. End your output with a line beginning "NEEDS_INPUT:" followed by your question(s), one per line. The task will then pause and wait for the user to answer instead of being marked done.`
    );
    return lines.join('\n');
  }

  private buildArgv(roleCfg: RoleConfig, prompt: string): string[] {
    switch (roleCfg.exec) {
      case 'claude':
        return ['claude', '-p', prompt, '--model', roleCfg.model, '--dangerously-skip-permissions'];
      case 'hermes':
        return roleCfg.model
          ? ['hermes', '-m', roleCfg.model, '-z', prompt]
          : ['hermes', '-z', prompt];
      case 'agy':
        // agy (Antigravity CLI) print mode defaults to --print-timeout 5m0s and
        // self-aborts there — long before cowork's own taskTimeoutMs kill. That
        // 5-min cap silently truncated multi-step "build + push" tasks mid-run,
        // leaving planning narration with no deliverable (verifier then rejected
        // it). Pin agy's print timeout to cowork's task budget so the dispatcher's
        // SIGTERM at taskTimeoutMs stays the single authority.
        return ['agy', '-p', prompt, '--print-timeout', `${this.config.orchestration.taskTimeoutMs}ms`, '--dangerously-skip-permissions'];
      case 'codex':
        // OpenAI Codex CLI, non-interactive.
        //  --skip-git-repo-check: we spawn codex with cwd = the task's artifacts
        //    dir, which is NOT a git repo. Without this flag codex's pre-flight
        //    aborts with "Not inside a trusted directory and --skip-git-repo-check
        //    was not specified." before producing any output.
        //  --dangerously-bypass-approvals-and-sandbox: the codex parallel of the
        //    --dangerously-skip-permissions that the claude/agy brains use — runs
        //    fully autonomously (never prompts for approval) and lets codex write
        //    its artifacts. Cowork agents run with full permissions by design.
        //  `--` ends option parsing so a prompt starting with a dash isn't
        //    mistaken for a flag.
        return ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
          ...(roleCfg.model ? ['-m', roleCfg.model] : []), '--', prompt];
      case 'ollama':
        // Local Ollama chat model (model required).
        if (!roleCfg.model) throw new Error('exec:ollama needs a model');
        return ['ollama', 'run', roleCfg.model, prompt];
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
   * enabled, a verifier brain judges whether the output truly completes the task.
   * A bad verdict makes execute() hand the task to the next brain in the chain.
   *
   * NOTE on ordering: callers MUST run {@link detectInputRequest} on an
   * otherwise-ok result BEFORE the LLM gate (see execute / verifyReportedCompletion).
   * The LLM verifier is told to FAIL anything that "does not actually address the
   * task" — which is exactly what a genuine QUESTION back to the user looks like.
   * Letting it run first would turn a request-for-input into a brain handover and
   * strand the question, never parking it on wait-input. This method is the
   * composition of the two gates for callers that have already ruled out an input
   * request (or don't care).
   */
  private async verifyResult(task: Task, output: { ok: boolean; text: string }): Promise<VerifyVerdict> {
    const det = this.deterministicVerdict(output);
    if (!det.ok) return det;
    return this.llmVerdict(task, output.text);
  }

  /** Gate 1 — cheap, deterministic exit-code + pattern/emptiness check. Catches
   *  the rate-limit / quota / overloaded / empty reply that exits 0. */
  private deterministicVerdict(output: { ok: boolean; text: string }): VerifyVerdict {
    const cfg = this.config.orchestration.verifier;
    if (cfg?.enabled === false) return { ok: output.ok, reason: output.ok ? undefined : output.text.slice(0, 200) };
    return verifyOutput(output.text, output.ok, {
      failPatterns: cfg?.failPatterns,
      replacePatterns: cfg?.replacePatterns,
      minLength: cfg?.minLength
    });
  }

  /** Gate 2 (optional, config-gated) — an LLM verifier agent judges whether the
   *  output GENUINELY completes the task. Fails open ({ ok: true }) when disabled
   *  or on any error so a real deliverable is never discarded by a flaky verifier.
   *  Only run on a result that has passed the deterministic gate AND is not an
   *  input request (see the class doc + call sites). */
  private async llmVerdict(task: Task, text: string): Promise<VerifyVerdict> {
    const cfg = this.config.orchestration.verifier;
    if (!cfg?.llm?.enabled) return { ok: true };
    try {
      const argv = this.buildArgv({ exec: (cfg.llm.exec || 'hermes') as RoleConfig['exec'], model: cfg.llm.model || '' },
        buildVerifierPrompt(task, text));
      const reply = await new Promise<string>((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(out); }, cfg.llm!.timeoutMs || 120000);
        child.stdout.on('data', d => { out += d.toString(); });
        child.on('error', () => resolve(''));
        child.on('close', () => { clearTimeout(timer); resolve(stripAnsi(out)); });
      });
      return parseLlmVerdict(reply);
    } catch (e) {
      console.error(`Dispatcher: LLM verifier errored (failing open):`, e);
      return { ok: true };   // never discard a real deliverable because the verifier crashed
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

  /** Append a failed-brain record to the task's inbox entry so the fallback trail
   *  is visible on the dashboard: which brains failed, in order, and why. */
  private recordFailedBrain(taskId: string, entry: { brain: string; agent: string; attempt: number; reason: string }): void {
    const t = this.store.getTask(taskId);
    if (!t) return;
    const failedBrains = Array.isArray(t.context?.failedBrains) ? t.context!.failedBrains : [];
    failedBrains.push({ ...entry, at: new Date().toISOString() });
    t.context = { ...(t.context || {}), failedBrains };
    this.store.saveTask(t);
  }

  /**
   * WF-1: append one lesson to the cross-task ledger (`decisions/lessons.jsonl`).
   * Fired on verifier rejections and wait-input parkings — the two moments a task
   * teaches the network something. Best-effort and NEVER-THROW: capture failing
   * (full disk, permissions) MUST NOT affect the task lifecycle, so the whole body
   * is guarded and errors are swallowed after logging. Deterministic — no LLM.
   */
  private recordLesson(taskId: string, input: {
    kind: 'verify-fail' | 'wait-input';
    brain: string;
    agent: string;
    attempt: number;
    reason?: string;
    resultText?: string;
    questions?: string[];
  }): void {
    try {
      const t = this.store.getTask(taskId);
      if (!t) return;
      const lesson = buildLesson({
        kind: input.kind,
        task: taskId,
        title: t.title || '',
        agent: input.agent,
        brain: input.brain,
        attempt: input.attempt,
        reason: input.reason,
        resultText: input.resultText,
        questions: input.questions
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
   * Completion guard for EXTERNALLY reported results — a remote brain's client
   * calls complete_task / PATCH inbox with its output. That output can itself be
   * a soft failure ("you've hit your session limit", a rate-limit / quota notice,
   * a refusal, or nothing), which the raw complete path would mark done. This
   * verifies the reported result with the same gate as a local run and, on a bad
   * verdict, hands the task to the NEXT brain in the fallback chain (or retries a
   * user-pinned brain), recording the failed brain. Only when the chain is
   * exhausted does it allow completion — as a FAILED summary. Results not
   * attributable to a configured brain (human / pipeline completions) pass through.
   */
  private verifyReportedCompletion = async (task: Task, result?: string): Promise<CompletionDecision> => {
    const text = result || '';
    const brains = this.config.orchestration.brains || {};
    const brainId = typeof task.context?.brain === 'string' ? task.context.brain : undefined;

    // Results not attributable to a configured brain (human / pipeline
    // completions) skip the failure/fallback gate, but a QUESTION back to the
    // user is still parked so it isn't silently marked done.
    if (!brainId || !brains[brainId]) {
      const req = detectInputRequest(text, this.inputOpts());
      if (req.needsInput) {
        this.recordLesson(task.id, {
          kind: 'wait-input', brain: brainId || '', agent: this.resolveAgent(task) || brainId || '',
          attempt: (Number(task.context?.attempts) || 0) + 1, questions: req.questions, resultText: text
        });
        return { action: 'wait-input', questions: req.questions };
      }
      return { action: 'complete' };
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
    let verdict = this.deterministicVerdict({ ok: true, text });
    if (verdict.ok) {
      const req = detectInputRequest(text, this.inputOpts());
      if (req.needsInput) {
        this.recordLesson(task.id, {
          kind: 'wait-input', brain: brainId,
          agent: this.resolveAgent(task) || (typeof task.context?.agentName === 'string' ? task.context.agentName : '') || brainId,
          attempt: (Number(task.context?.attempts) || 0) + 1, questions: req.questions, resultText: text
        });
        console.log(`Dispatcher: reported result for task ${task.id} on ${brainId} is a QUESTION → wait-input (${req.matched || 'phrase'})`);
        return { action: 'wait-input', questions: req.questions };
      }
      verdict = await this.llmVerdict(task, text);
      if (verdict.ok) return { action: 'complete' };
    }

    const failReason = verdict.reason || (result || '').slice(0, 300);
    const attempt = Number(task.context?.attempts) || 0;
    const agent = this.resolveAgent(task)
      || (typeof task.context?.agentName === 'string' ? task.context.agentName : '') || brainId;
    const division = typeof task.context?.division === 'string' ? task.context.division : undefined;
    this.recordFailedBrain(task.id, { brain: brainId, agent, attempt: attempt + 1, reason: failReason });
    this.recordLesson(task.id, { kind: 'verify-fail', brain: brainId, agent, attempt: attempt + 1, reason: failReason, resultText: text });
    console.log(`Dispatcher: verifier REJECTED reported result for task ${task.id} on ${brainId} — ${failReason.slice(0, 80)}`);

    // A user-pinned brain (context.brain WITHOUT brainAuto) retries itself up to
    // inbox.maxRetries; a chain rung (brainAuto) advances to the next brain.
    const pinned = !task.context?.brainAuto;
    const chain = pinned ? [] : this.chainFor(agent, division);
    const bound = pinned ? this.config.inbox.maxRetries : chain.length;
    const nextAttempt = attempt + 1;

    if (nextAttempt < bound) {
      const t = this.store.getTask(task.id);
      if (t) {
        const nextBrain = pinned ? brainId : (chain[nextAttempt] || '?');
        t.status = 'pending';
        delete t.claimedAt;
        delete t.claimedBy;
        t.context = {
          ...(t.context || {}),
          attempts: nextAttempt,
          dispatched: false,
          remoteWaitSince: undefined,
          // chain rung: drop the auto brain pin so planFor selects the next rung;
          // user pin: keep the brain so the same one is retried.
          brain: pinned ? brainId : undefined,
          brainAuto: undefined
        };
        t.result = `attempt ${nextAttempt}/${bound} failed on ${brainId}${pinned ? ' — retrying' : ` — handing over to ${nextBrain}`}: ${failReason}`;
        this.store.saveTask(t);
        console.log(`Dispatcher: remote handover — task ${task.id} attempt ${nextAttempt} on ${brainId} failed, next → ${nextBrain}`);
      }
      return { action: 'handover' };
    }

    // Chain exhausted — complete as FAILED, summarising which brains were tried.
    const failed = Array.isArray(this.store.getTask(task.id)?.context?.failedBrains)
      ? this.store.getTask(task.id)!.context!.failedBrains as Array<{ brain: string; reason: string }>
      : [];
    const failedList = failed.map(f => `${f.brain} (${f.reason})`).join('; ');
    return {
      action: 'complete',
      result: `FAILED after ${bound} attempt(s) (chain exhausted). Brains that failed: ${failedList || brainId}. Last output: ${(result || '').slice(0, 800)}`
    };
  };

  private async execute(task: Task, plan: ExecPlan): Promise<void> {
    const orch = this.config.orchestration;
    const role = plan.agent;
    if (!this.agentId) return;

    const claimed = this.store.claimTask({ taskId: task.id, agentId: this.agentId, internal: true });
    if (!claimed) return;
    // Mark the claim as dispatcher-owned so startup handover can reclaim it
    claimed.context = { ...(claimed.context || {}), dispatched: true };
    this.store.saveTask(claimed);

    // Surface the worker as its own active agent so the dashboard shows WHO
    // is working (e.g. hermes/engineer · local-cc-opus), not just the coordinator.
    const worker = this.store.registerAgent({
      platform: plan.platform,
      agentName: plan.label,
      sessionId: 'dispatcher-worker',
      capabilities: [role || plan.label],
      currentTask: task.title
    });
    this.store.updateHeartbeat({ agentId: worker.id, status: 'working', currentTask: task.title });

    this.running.set(task.id, { role: plan.label, startedAt: Date.now(), workerAgentId: worker.id, brainId: plan.brainId });
    console.log(`Dispatcher: [${plan.label}/${plan.exec}:${plan.model || 'default'}] running task ${task.id} — ${task.title}`);

    // Persistent per-task artifacts dir (agents save files here → downloadable).
    const artDir = this.artifactsDir(task.id);
    try { mkdirSync(artDir, { recursive: true }); } catch { /* ignore */ }

    const prompt = this.buildPrompt(task, plan);
    const argv = this.buildArgv({ exec: plan.exec, model: plan.model, command: plan.command }, prompt);

    const output = await new Promise<{ ok: boolean; text: string }>((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        // Run the agent INSIDE its artifacts dir. Without a cwd the child
        // inherits the server's — the repo itself — so anything an agent wrote
        // with a relative path (scratch scripts, generated images) landed in
        // server/ and dirtied the working tree. Rooted here, those files become
        // the task's artifacts instead. exec:script keeps the server cwd because
        // its configured command is a repo-relative path (./deploy/…).
        ...(plan.exec === 'script' ? {} : { cwd: artDir }),
        env: {
          ...process.env,
          // exec:script pipelines read the task from these instead of a prompt.
          COWORK_TASK_ID: task.id,
          COWORK_TASK_TITLE: task.title,
          COWORK_TASK_DESCRIPTION: task.description,
          COWORK_TASK_CONTEXT: JSON.stringify(task.context || {}),
          COWORK_API: `http://localhost:${this.config.server.port}/api`,
          COWORK_ARTIFACTS_DIR: artDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ ok: false, text: `TIMEOUT after ${orch.taskTimeoutMs}ms\n${out}\n${err}` });
      }, orch.taskTimeoutMs);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, text: `SPAWN ERROR: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Strip ANSI/terminal control sequences some CLIs emit even to a pipe
        // (e.g. Ollama's streaming cursor redraws) so results are clean text.
        const clean = stripAnsi(out).trim();
        if (code === 0 && clean) resolve({ ok: true, text: clean });
        else resolve({ ok: code === 0, text: (clean || stripAnsi(err).trim() || `exit code ${code}`) });
      });
    });

    this.running.delete(task.id);
    this.store.removeAgent(worker.id);

    // Count this run: the local dispatcher ran the brain; attribute submission
    // to whoever created the task.
    this.store.countRun('local', plan.brainId);
    if (task.from?.agent) this.store.countSubmitted(task.from.agent, plan.brainId);

    // VERIFY the result in strict gate precedence:
    //   (1) hard/soft FAILURE — a brain that hit a rate limit (or refused, or
    //       returned nothing) can still exit 0 and masquerade as a clean success;
    //       the deterministic gate rejects those so the handover below advances to
    //       the next fallback brain instead of marking a non-result "done".
    //   (2) QUESTION for the user — an otherwise-ok result that asks for input is
    //       a SUCCESSFUL run awaiting the user, parked on wait-input below. It must
    //       be recognised BEFORE the LLM gate: that verifier is told to FAIL a
    //       result that "does not actually address the task", which a genuine
    //       question does — running it first would hand the question to the next
    //       brain and strand it, never asking the user.
    //   (3) LLM quality gate — only a genuine deliverable is judged for completion.
    const detVerdict = this.deterministicVerdict(output);
    const inputReq: InputRequest = detVerdict.ok ? detectInputRequest(output.text, this.inputOpts()) : { needsInput: false, questions: [] };
    const verdict: VerifyVerdict = !detVerdict.ok
      ? detVerdict
      : inputReq.needsInput
        ? { ok: true }                                 // question → skip the LLM gate, park below
        : await this.llmVerdict(task, output.text);
    if (output.ok && !verdict.ok) {
      console.log(`Dispatcher: verifier REJECTED task ${task.id} result on ${plan.brainId} — ${verdict.reason}`);
    }

    // Handover: on failure advance to the NEXT brain in the resolved chain
    // (or, for a pinned brain, retry it up to inbox.maxRetries).
    const bound = plan.pinned ? this.config.inbox.maxRetries : plan.chainLen;
    if (!verdict.ok) {
      const failReason = verdict.reason || output.text.slice(0, 300);
      this.recordFailedBrain(task.id, { brain: plan.brainId, agent: plan.agent, attempt: plan.attempt + 1, reason: failReason });
      this.recordLesson(task.id, { kind: 'verify-fail', brain: plan.brainId, agent: plan.agent, attempt: plan.attempt + 1, reason: failReason, resultText: output.text });
      const fresh = this.store.getTask(task.id);
      if (fresh) {
        const nextAttempt = plan.attempt + 1;
        if (nextAttempt < bound) {
          const nextBrain = plan.pinned ? plan.brainId : (this.chainFor(plan.agent, plan.division)[nextAttempt] || '?');
          fresh.status = 'pending';
          delete fresh.claimedAt;
          delete fresh.claimedBy;
          fresh.context = { ...(fresh.context || {}), attempts: nextAttempt, dispatched: false };
          fresh.result = `attempt ${plan.attempt + 1}/${bound} failed on ${plan.brainId}${plan.pinned ? ' — retrying' : ` — handing over to ${nextBrain}`}: ${failReason}`;
          this.store.saveTask(fresh);
          console.log(`Dispatcher: handover — task ${task.id} attempt ${plan.attempt + 1} failed on ${plan.brainId} (${failReason.slice(0, 80)}), next → ${nextBrain}`);
          return;
        }
      }
    }

    // Persist a markdown copy + collect any artifacts the agent produced.
    try { writeFileSync(join(artDir, 'result.md'), `# ${task.title}\n\n${output.text}\n`); } catch { /* ignore */ }
    let artifacts: string[] = [];
    try {
      artifacts = readdirSync(artDir).filter(f => { try { return statSync(join(artDir, f)).isFile(); } catch { return false; } });
    } catch { /* ignore */ }

    // The result is a QUESTION back to the user (not a failure — verdict is ok —
    // and not a finished deliverable). Park the task on `wait-input` with the
    // questions as an interaction packet: the orchestrator neither marks it done
    // nor hands it to a fallback brain. Answering from the Inbox card releases it
    // back to `pending`, re-dispatched with the answers in context.humanInput.
    if (verdict.ok) {
      const req = inputReq;   // computed above (gate 2), before the LLM gate
      if (req.needsInput) {
        const t = this.store.getTask(task.id);
        if (t) {
          t.context = { ...(t.context || {}), ranAgent: plan.agent, ranDivision: plan.division, ranBrain: plan.brainId, isRoster: plan.isRoster };
          if (artifacts.length) (t as any).artifacts = artifacts;
          this.store.saveTask(t);
        }
        this.recordLesson(task.id, { kind: 'wait-input', brain: plan.brainId, agent: plan.agent, attempt: plan.attempt + 1, questions: req.questions, resultText: output.text });
        this.store.parkForInput({ taskId: task.id, questions: req.questions, result: output.text.slice(0, 4000) });
        console.log(`Dispatcher: task ${task.id} paused on wait-input — agent asked ${req.questions.length} question(s) (${req.matched || 'phrase'})`);
        return;
      }
    }

    // The whole fallback chain is exhausted here. Summarise which brains failed
    // (from context.failedBrains) so the CEO sees exactly what was tried.
    const failedBrains = Array.isArray(this.store.getTask(task.id)?.context?.failedBrains)
      ? this.store.getTask(task.id)!.context!.failedBrains as Array<{ brain: string; reason: string }>
      : [];
    const failedList = failedBrains.map(f => `${f.brain} (${f.reason})`).join('; ');
    const result = verdict.ok
      ? output.text.length > 2000 ? output.text.slice(0, 2000) + `\n…(full output in artifacts/${task.id}/result.md)` : output.text
      : `FAILED after ${bound} attempt(s) (chain exhausted). Brains that failed: ${failedList || plan.brainId}. Last output: ${output.text.slice(0, 800)}`;

    // Record which agent/brain ran it on the task itself (item 5) + artifacts.
    const done = this.store.getTask(task.id);
    if (done) {
      done.context = { ...(done.context || {}), ranAgent: plan.agent, ranDivision: plan.division, ranBrain: plan.brainId, isRoster: plan.isRoster };
      if (artifacts.length) (done as any).artifacts = artifacts;
      this.store.saveTask(done);
    }
    // internal: the dispatcher already verified this run — skip the completion guard.
    await this.store.completeTask({ taskId: task.id, result, internal: true });
    console.log(`Dispatcher: task ${task.id} ${verdict.ok ? 'completed' : 'FAILED (chain exhausted)'} (${output.text.length} chars${artifacts.length ? ', ' + artifacts.length + ' artifact(s)' : ''})`);
  }
}
