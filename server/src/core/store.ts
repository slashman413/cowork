import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { v4 as uuidv4 } from 'uuid';
import { globSync } from 'glob';
import type { Config, ActiveAgent, Task, DashboardData, AgentCard, InteractionField, BrainUsage } from '../types.js';
import type { EventBus } from './events.js';
import { Roster } from './roster.js';
import { normalizeRecurrence, recurrenceFromLegacyHours, nextRunAt, type TaskRecurrence } from './recurrence.js';

/**
 * A veto the Dispatcher registers on the store so EXTERNAL task completions
 * (a remote brain's client calling complete_task / PATCH inbox) pass through the
 * same result verification as local runs. `handover` means the guard has already
 * re-queued the task for the next fallback brain — do NOT mark it done. `complete`
 * lets completion proceed, optionally rewriting the stored result (e.g. a
 * "chain exhausted" FAILED summary). `wait-input` means the result is really a
 * QUESTION back to the user: park the task on `wait-input` with the questions as
 * an interaction packet instead of marking it done or handing it off.
 */
export type CompletionDecision =
  | { action: 'complete'; result?: string }
  | { action: 'handover' }
  | { action: 'wait-input'; questions?: string[] }
  /** The agent is still waiting on long background work it launched — DEFER the
   *  task (re-arm on `scheduled` a short while out) instead of marking it done,
   *  so a later run checks whether the background job finished. */
  | { action: 'defer-background'; note?: string; pollMs?: number };
export type CompletionGuard = (task: Task, result?: string) => Promise<CompletionDecision>;

/**
 * Canonical "did this task fail?" predicate — the SINGLE source of truth for the
 * failed/red category, used by both the dashboard counter ({@link Store.getDashboard})
 * and the re-run gate ({@link Store.rerunTask}). It MUST stay in lockstep with the
 * frontend's `isTaskFailed` (server/public/js/app.js): a task is failed when the
 * server flagged it, when it was explicitly rejected, or when it finished with a
 * "FAILED…" summary even if the flag predates that task. Previously getDashboard
 * used a stricter check (done && failed===true), so a rejected task — or a done
 * task whose result starts with "FAILED" but was never flagged — rendered as a red
 * "failed" card while the summary counted 0 failed.
 */
export function isFailedTask(task: Task): boolean {
  return task.failed === true
    || task.status === 'rejected'
    || (task.status === 'done' && typeof task.result === 'string' && /^FAILED\b/i.test(task.result.trim()));
}

/**
 * A `done` task that was CLOSED ADMINISTRATIVELY without ever running a brain —
 * e.g. a scheduled duplicate that a sibling attempt superseded, or a task
 * cancelled before its launch time. Its status/result were set directly, so it
 * never entered the dispatcher's execution path: no `artifacts/<id>/` dir and no
 * `result.md` are created (those are written only by dispatcher.mkdirSync/
 * writeFileSync when a brain actually runs). On the dashboard such a task looks
 * identical to a real "done (ran)" card yet has an empty artifacts list, which
 * reads like a silent failure. This classifier lets the UI badge it distinctly.
 *
 * Detection (either signal suffices, both grounded in the task record):
 *  1. The result opens with an administrative-close marker an agent wrote when
 *     it closed the copy (SUPERSEDED / CLOSED / SKIPPED / CANCELLED / DUPLICATE /
 *     WON'T FIX / NO-OP) — mirrors the `FAILED\b` result-prefix convention.
 *  2. Structural: the task was marked `done` AT OR BEFORE its own `scheduledAt`
 *     launch time. A task cannot have executed before the dispatcher released it,
 *     so `completedAt <= scheduledAt` can only mean it was closed un-run.
 *
 * `failed` takes precedence — a chain-exhausted task is failed, not "closed".
 * MUST stay in lockstep with the frontend's `isTaskClosedNoRun` (app.js).
 */
export function isClosedWithoutRunning(task: Task): boolean {
  if (task.status !== 'done' || isFailedTask(task)) return false;
  const result = typeof task.result === 'string' ? task.result.trim() : '';
  if (/^(SUPERSEDED|CLOSED|SKIPPED|CANCELL?ED|DUPLICATE|WON'?T[\s-]?FIX|NO[\s-]?OP)\b/i.test(result)) {
    return true;
  }
  if (task.completedAt && task.scheduledAt) {
    const done = Date.parse(task.completedAt);
    const launch = Date.parse(task.scheduledAt);
    if (Number.isFinite(done) && Number.isFinite(launch) && done <= launch) return true;
  }
  return false;
}

export class Store {
  private config: Config;
  private eventBus: EventBus;
  private roster: Roster;
  private activeAgents = new Map<string, ActiveAgent>();
  private startTime = Date.now();
  private completionGuard?: CompletionGuard;

  constructor(config: Config, eventBus: EventBus) {
    this.config = config;
    this.eventBus = eventBus;
    this.roster = new Roster(config.paths.agencyAgents);
  }

  public initialize(): void {
    const dirs = [
      this.config.paths.inbox,
      this.config.paths.artifacts,
      this.config.paths.inputs,
      this.config.paths.status,
      this.config.paths.decisions,
      this.config.paths.workflows
    ];

    // Skip unset paths — a config predating a newer path key would otherwise
    // crash startup on mkdirSync(undefined).
    for (const dir of dirs) {
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.roster.loadAll();
    this.loadActiveAgents();
    this.reportHiddenTasks();
  }

  /**
   * One-shot startup audit: count inbox JSON files that are present on disk but
   * cannot be parsed, i.e. tasks that are silently HIDDEN from every listing and
   * the dashboard. Emits a single summary line naming the offending files so a
   * "my tasks disappeared" report is immediately diagnosable at boot instead of
   * requiring a byte-level dig through the inbox. Purely informational — a
   * malformed file is still tolerated at read time (see readTaskFile).
   */
  private reportHiddenTasks(): void {
    let files: string[];
    try { files = fs.readdirSync(this.config.paths.inbox).filter(f => f.endsWith('.json')); }
    catch { return; }
    const hidden: string[] = [];
    for (const f of files) {
      try { JSON.parse(fs.readFileSync(path.join(this.config.paths.inbox, f), 'utf-8')); }
      catch { hidden.push(f); }
    }
    if (hidden.length) {
      console.error(
        `Store: ${hidden.length} of ${files.length} inbox file(s) are UNPARSEABLE and ` +
        `therefore hidden from the dashboard: ${hidden.join(', ')}. ` +
        `Fix or remove them to restore visibility (inbox/*.json is gitignored — not recoverable from git).`
      );
    }
  }

  private loadActiveAgents(): void {
    const agentsFile = path.join(this.config.paths.status, 'agents.json');
    if (fs.existsSync(agentsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));
        if (Array.isArray(data)) {
          for (const agent of data) {
            this.activeAgents.set(agent.id, agent);
          }
        }
      } catch (e) {
        console.error('Failed to load active agents', e);
      }
    }
  }

  private saveActiveAgents(): void {
    const agentsFile = path.join(this.config.paths.status, 'agents.json');
    const data = Array.from(this.activeAgents.values());
    fs.writeFileSync(agentsFile, JSON.stringify(data, null, 2));
  }

  public registerAgent(params: { platform: string; agentName: string; sessionId?: string; capabilities?: string[]; currentTask?: string }): ActiveAgent {
    const id = uuidv4();
    const now = new Date().toISOString();
    const agent: ActiveAgent = {
      id,
      platform: params.platform,
      agentName: params.agentName,
      sessionId: params.sessionId,
      capabilities: params.capabilities || [],
      currentTask: params.currentTask,
      status: 'idle',
      registeredAt: now,
      lastHeartbeat: now
    };
    
    this.activeAgents.set(id, agent);
    this.saveActiveAgents();
    this.eventBus.emitAgentRegistered(agent);
    
    return agent;
  }

  public updateHeartbeat(params: { agentId: string; status?: 'idle' | 'working' | 'blocked'; currentTask?: string }): ActiveAgent | null {
    const agent = this.activeAgents.get(params.agentId);
    if (!agent) return null;
    
    agent.lastHeartbeat = new Date().toISOString();
    if (params.status) agent.status = params.status;
    if (params.currentTask !== undefined) agent.currentTask = params.currentTask;
    
    this.saveActiveAgents();
    this.eventBus.emitHeartbeat(agent.id, agent.status, agent.currentTask);
    
    return agent;
  }

  public getActiveAgents(filters?: { platform?: string; status?: string }): ActiveAgent[] {
    let agents = Array.from(this.activeAgents.values());
    if (filters?.platform) {
      agents = agents.filter(a => a.platform === filters.platform);
    }
    if (filters?.status) {
      agents = agents.filter(a => a.status === filters.status);
    }
    return agents;
  }

  // ── Per-client × per-brain invocation counters (in-memory, non-persistent;
  //    reset on service restart and when a client re-registers). ──────────────
  private counters = { ran: new Map<string, Map<string, number>>(), submitted: new Map<string, Map<string, number>>() };
  private bump(m: Map<string, Map<string, number>>, client: string, brain: string): void {
    if (!m.has(client)) m.set(client, new Map());
    const b = m.get(client)!;
    b.set(brain, (b.get(brain) || 0) + 1);
  }
  public countRun(client: string, brain: string): void { this.bump(this.counters.ran, client, brain); }
  public countSubmitted(client: string, brain: string): void { this.bump(this.counters.submitted, client, brain); }
  public resetCounters(client: string): void { this.counters.ran.delete(client); this.counters.submitted.delete(client); }
  public getCounters(): { ran: Record<string, Record<string, number>>; submitted: Record<string, Record<string, number>> } {
    const toObj = (m: Map<string, Map<string, number>>) => Object.fromEntries([...m].map(([k, v]) => [k, Object.fromEntries(v)]));
    return { ran: toObj(this.counters.ran), submitted: toObj(this.counters.submitted) };
  }

  // ── Per-brain rate-limit usage snapshots (in-memory, non-persistent; refilled
  //    by the local UsagePoller and by remote clients' heartbeats within one
  //    cycle after a restart). Only METERED brains (claude/codex/…) ever get an
  //    entry — hermes/ollama/script brains have no quota and stay absent. ──────
  private brainUsage = new Map<string, BrainUsage>();
  public setBrainUsage(brainId: string, usage: BrainUsage): void {
    this.brainUsage.set(brainId, usage);
  }
  public getBrainUsage(): Record<string, BrainUsage> {
    return Object.fromEntries(this.brainUsage);
  }

  public removeAgent(id: string): boolean {
    const existed = this.activeAgents.delete(id);
    if (existed) this.saveActiveAgents();
    return existed;
  }

  public removeStaleAgents(timeoutMs: number): void {
    const now = Date.now();
    let changed = false;
    for (const [id, agent] of this.activeAgents.entries()) {
      if (now - new Date(agent.lastHeartbeat).getTime() > timeoutMs) {
        this.activeAgents.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.saveActiveAgents();
    }
  }

  // ── Task input files (attached by a person for the brain to read) ──────────
  // Layout mirrors artifacts/: <repo>/inputs/<taskId>/<file> for a task's inputs,
  // plus <repo>/inputs/_staging/<token>/<file> for uploads that arrive BEFORE
  // their task exists (chat composer). Gitignored. Materializing staged uploads
  // into the task dir at creation time keeps create-with-inputs race-free — the
  // task is only visible as `pending` (claimable) once its inputs are present.

  /** Repo-level inputs root. */
  private inputsRoot(): string {
    return this.config.paths.inputs;
  }
  private inputsDir(taskId: string): string {
    return path.join(this.inputsRoot(), path.basename(taskId));
  }

  /** Best-effort GC of staging slots older than an hour (never-claimed uploads). */
  private gcStaging(): void {
    const staging = path.join(this.inputsRoot(), '_staging');
    if (!fs.existsSync(staging)) return;
    const cutoff = Date.now() - 3_600_000;
    for (const slot of fs.readdirSync(staging)) {
      const p = path.join(staging, slot);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Persist an uploaded file to a staging slot and return a `token` the caller
   * passes back when it creates the task (createTask) or attaches to an existing
   * one (appendInputs). Path-guarded; rejects empty uploads.
   */
  public stageUpload(name: string, data: Buffer): { token: string; name: string; bytes: number } {
    const fileName = path.basename(String(name || '')).trim();
    if (!fileName || fileName === '.' || fileName === '..') throw new Error('invalid filename');
    if (!data || !data.length) throw new Error('empty upload');
    this.gcStaging();
    const token = uuidv4();
    const dir = path.join(this.inputsRoot(), '_staging', token);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), data);
    return { token, name: fileName, bytes: data.length };
  }

  /** Move staged uploads (by token) into the task's inputs dir; returns the
   *  stored filenames. Skips tokens whose slot is gone; collision-suffixes names. */
  private materializeInputs(taskId: string, inputs: Array<{ token?: string; name?: string }>): string[] {
    const dir = this.inputsDir(taskId);
    const stored: string[] = [];
    for (const it of inputs) {
      const token = String(it?.token || '');
      if (!token || /[\\/]/.test(token)) continue;
      const slot = path.join(this.inputsRoot(), '_staging', path.basename(token));
      if (!fs.existsSync(slot)) continue;
      let src: string | undefined;
      try { src = fs.readdirSync(slot).find(f => { try { return fs.statSync(path.join(slot, f)).isFile(); } catch { return false; } }); } catch { continue; }
      if (!src) continue;
      fs.mkdirSync(dir, { recursive: true });
      const original = path.basename(it?.name || src);
      let name = original, dest = path.join(dir, name);
      for (let n = 1; fs.existsSync(dest); n++) {
        const ext = path.extname(original);
        name = `${path.basename(original, ext)}-${n}${ext}`;
        dest = path.join(dir, name);
      }
      try { fs.renameSync(path.join(slot, src), dest); }
      catch { try { fs.copyFileSync(path.join(slot, src), dest); } catch { continue; } }
      try { fs.rmSync(slot, { recursive: true, force: true }); } catch { /* ignore */ }
      stored.push(name);
    }
    return stored;
  }

  /** Attach more input files to an existing task (union onto context.inputFiles). */
  public appendInputs(taskId: string, inputs: Array<{ token?: string; name?: string }>): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const names = this.materializeInputs(task.id, Array.isArray(inputs) ? inputs : []);
    if (names.length) {
      const existing = Array.isArray(task.context?.inputFiles) ? task.context!.inputFiles as string[] : [];
      task.context = { ...(task.context || {}), inputFiles: [...new Set([...existing, ...names])] };
      this.saveTask(task);
    }
    return task;
  }

  /** Filenames of a task's attached input files (downloadable). */
  public listInputs(taskId: string): string[] {
    const task = this.getTask(taskId);
    const dir = this.inputsDir(task?.id || taskId);
    if (!fs.existsSync(dir)) return [];
    try { return fs.readdirSync(dir).filter(f => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } }); }
    catch { return []; }
  }

  /** Absolute path of one input file (path-guarded), or null if absent. */
  public inputFilePath(taskId: string, file: string): string | null {
    const task = this.getTask(taskId);
    const dir = this.inputsDir(task?.id || taskId);
    const p = path.join(dir, path.basename(file));
    if (!p.startsWith(dir + path.sep) || !fs.existsSync(p)) return null;
    return p;
  }

  /** Absolute path of a task's inputs DIR (for the local dispatcher to point the
   *  agent at), or null when the task has no attached inputs. */
  public inputsPath(taskId: string): string | null {
    const task = this.getTask(taskId);
    const dir = this.inputsDir(task?.id || taskId);
    return fs.existsSync(dir) ? dir : null;
  }

  public createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>, opts?: { inputs?: Array<{ token?: string; name?: string }> }): Task {
    const id = uuidv4();
    const task: Task = {
      ...params,
      id,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    // Materialize any staged input uploads into inputs/<id>/ and record the stored
    // filenames on context.inputFiles BEFORE the task is written/emitted, so it is
    // never visible as `pending` (claimable) without its inputs already present.
    if (opts?.inputs && opts.inputs.length) {
      const names = this.materializeInputs(id, opts.inputs);
      if (names.length) {
        const existing = Array.isArray(task.context?.inputFiles) ? task.context!.inputFiles as string[] : [];
        task.context = { ...(task.context || {}), inputFiles: [...new Set([...existing, ...names])] };
      }
    }
    // A task shipped with an unanswered interaction packet is parked on the
    // `wait-input` category — held OUT of the pending pool so the dispatcher never
    // schedules or reassigns it. submitInteraction() releases it to `pending`.
    if (task.interaction && Array.isArray(task.interaction.fields) && task.interaction.fields.length) {
      task.interaction.status ||= 'pending';
      if (task.interaction.status !== 'submitted') task.status = 'wait-input';
    }
    // Scheduled launch. Default is "now": an absent or already-past scheduledAt
    // leaves the task in the pool immediately. A FUTURE time parks it on the
    // `scheduled` status — held out of the pending pool (never claimable or
    // dispatched) until the dispatcher releases it (releaseDueScheduled). This
    // deliberately overrides the wait-input parking above: a person can answer
    // the interaction while the task waits, and the release decides which of
    // pending/wait-input it lands on based on whether the answers arrived.
    if (task.scheduledAt !== undefined) {
      const at = Date.parse(String(task.scheduledAt));
      if (!Number.isFinite(at)) {
        throw new Error(`Invalid scheduledAt "${task.scheduledAt}" — use an ISO 8601 date-time (e.g. 2026-08-08T09:00:00+08:00)`);
      }
      task.scheduledAt = new Date(at).toISOString();
      if (at > Date.now()) task.status = 'scheduled';
    }

    // Flexible periodic cadence. A caller may pass `recurrence` directly, or the
    // legacy `loopIntervalHours`; normalize whichever is present onto `recurrence`
    // (throwing on an invalid spec) and keep loopIntervalHours mirrored so older
    // dashboards/clients still read the interval.
    if (task.recurrence !== undefined) {
      task.recurrence = normalizeRecurrence(task.recurrence);
    } else if (task.loopIntervalHours) {
      task.recurrence = recurrenceFromLegacyHours(task.loopIntervalHours);
    }
    if (task.recurrence === undefined) delete task.recurrence;
    this.syncLegacyLoopField(task);

    // A recurring task is a SCHEDULER, never a runner. It parks on `scheduled` and
    // each due tick spawns a one-shot run-child that becomes the `done` record for
    // that cycle (see releaseDueScheduled / spawnScheduledRun), keeping ONE stable
    // parent identity across the whole series. So force it onto `scheduled` even
    // when its scheduledAt is absent/past (or it carried an interaction): an
    // immediate cadence releases — and spawns its first child — on the next tick.
    // Only the FINAL slot (recurrence exhausted) ever runs the task's own body.
    if (task.recurrence) {
      if (task.scheduledAt === undefined) task.scheduledAt = new Date().toISOString();
      task.status = 'scheduled';
    }

    this.writeTaskFile(`${id}.json`, task);

    this.eventBus.emitTaskCreated(task);
    return task;
  }

  /**
   * Release due SCHEDULED tasks into normal scheduling — the launch check the
   * dispatcher runs every tick. A task parked on `scheduled` whose scheduledAt
   * has arrived flips to `pending` (entering the dispatch pool that same tick),
   * or to `wait-input` when it still carries an unanswered interaction packet so
   * a person's answers are collected before it runs. A missing/garbled
   * scheduledAt on a scheduled task releases immediately (fail open) rather than
   * stranding the task forever. Returns the released tasks for logging.
   */
  public releaseDueScheduled(now: number = Date.now()): Task[] {
    const released: Task[] = [];
    for (const task of this.listTasks({ status: 'scheduled' })) {
      const at = Date.parse(String(task.scheduledAt ?? ''));
      if (Number.isFinite(at) && at > now) continue;   // not due yet

      // A recurring task never runs its own body — when due it spawns a one-shot
      // run-child (the `done` record for this cycle, linked back to this stable
      // parent) and RE-ARMS itself to the next slot, staying `scheduled`. The only
      // exception is the FINAL slot: when the cadence has no future run left
      // (interval exhausted / `until` cutoff reached), there is nothing to re-arm
      // to, so the task falls through and runs itself — turning into a `done` task
      // directly, exactly like a plain one-shot scheduled task.
      const recurrence = task.recurrence ? normalizeRecurrence(task.recurrence)
        : recurrenceFromLegacyHours(task.loopIntervalHours);
      if (recurrence) {
        const anchor = task.scheduledAt ? new Date(task.scheduledAt) : new Date(now);
        const next = nextRunAt(recurrence, anchor, new Date(now));
        if (next) {
          const child = this.spawnScheduledRun(task);
          task.scheduledAt = next.toISOString();
          this.saveTask(task);
          this.eventBus.emitTaskCreated(task);   // nudge dashboards: parent re-armed
          released.push(child);                   // the child is what entered the pool
          continue;
        }
        // no future run → fall through and run the parent itself (done directly)
      }

      const awaiting = task.interaction && Array.isArray(task.interaction.fields)
        && task.interaction.fields.length > 0 && task.interaction.status !== 'submitted';
      task.status = awaiting ? 'wait-input' : 'pending';
      // A `manual`-tagged task is skipped by the dispatcher forever (planFor
      // returns 'skip'). Combined with a scheduledAt that's now due, it releases
      // into `pending` and then silently rots there — never dispatched, never
      // visible as stuck. That contradiction (schedule = "run it automatically"
      // vs manual = "never auto-run") is almost always a mistake at task
      // creation; warn loudly so the stall is diagnosable instead of invisible.
      if (task.tags?.includes('manual') && !awaiting) {
        console.warn(`Store: released scheduled task ${task.id} is tagged \`manual\` — the dispatcher will NOT auto-run it; it will sit in \`pending\`. Remove the manual tag to let it dispatch, or trigger it by hand. — ${task.title}`);
      }
      this.saveTask(task);
      this.eventBus.emitTaskCreated(task);   // nudge live dashboards to refresh
      released.push(task);
    }
    return released;
  }

  /**
   * Run a SCHEDULED task NOW instead of waiting for its `scheduledAt`. This is
   * the manual counterpart to releaseDueScheduled: a person hits "Run now" on a
   * scheduled card and the task is released this instant. It flips `scheduled` →
   * `pending` (so the dispatcher claims it next tick), or → `wait-input` when it
   * still carries an unanswered interaction packet (its answers must land in
   * context.humanInput before it runs — same gate the timed release honours).
   * The `scheduledAt` is cleared so the task reads as an ordinary "now" task and
   * won't be re-parked by any later launch check. Returns null when the task is
   * absent or not in `scheduled` state (nothing to release).
   */
  public runScheduledNow(taskId: string): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'scheduled') return null;   // only a parked task can be released

    // A recurring task doesn't run its own body — "run now" spawns an extra
    // one-shot run-child immediately (the `done` record for this ad-hoc run,
    // linked back to the parent) while leaving the regular cadence untouched, so
    // the next scheduled iteration still fires on its own time.
    const recurrence = task.recurrence ? normalizeRecurrence(task.recurrence)
      : recurrenceFromLegacyHours(task.loopIntervalHours);
    if (recurrence) return this.spawnScheduledRun(task);

    const awaiting = task.interaction && Array.isArray(task.interaction.fields)
      && task.interaction.fields.length > 0 && task.interaction.status !== 'submitted';
    task.status = awaiting ? 'wait-input' : 'pending';
    delete task.scheduledAt;   // it's "now" — drop the future time so nothing re-parks it
    // Mirror releaseDueScheduled's contradiction warning: a `manual`-tagged task
    // won't be auto-dispatched even once pending, so the button appears to do
    // nothing. Surface it so the no-op is diagnosable rather than silent.
    if (task.tags?.includes('manual') && !awaiting) {
      console.warn(`Store: run-now released task ${task.id} is tagged \`manual\` — the dispatcher will NOT auto-run it; it will sit in \`pending\`. Remove the manual tag to let it dispatch, or trigger it by hand. — ${task.title}`);
    }
    this.saveTask(task);
    this.eventBus.emitTaskCreated(task);   // nudge live dashboards to refresh
    return task;
  }

  public claimTask(params: { taskId: string; agentId: string; internal?: boolean }): Task | null {
    const task = this.getTask(params.taskId);
    if (!task) return null;
    // Human-in-the-loop hold: a task with an unanswered interaction packet is not
    // claimable by anyone (dispatcher or a remote client polling directly) until a
    // person submits the questions/checklist from the Inbox card. Otherwise the
    // executor would run before the human input lands in context.humanInput.
    if (task.interaction && Array.isArray(task.interaction.fields)
        && task.interaction.fields.length > 0 && task.interaction.status !== 'submitted') {
      return null;
    }
    // A LOCAL-brain task is the dispatcher's to run (it spawns the CLI directly and
    // injects the roster persona). External clients must not claim it — otherwise a
    // client that registered a local brain races the dispatcher and runs the task
    // WITHOUT the persona/ran-labels. Only internal (dispatcher) claims are allowed.
    if (!params.internal) {
      const brainId = task.context?.brain;
      const brain = brainId ? this.config.orchestration.brains?.[brainId] : undefined;
      if (brain && brain.location === 'local') return null;
    }
    // Atomic compare-and-set: only a pending task can be claimed. The server is
    // single-process, so claimTask runs to completion without interleaving —
    // this makes concurrent claims (many remote clients on one brain) safe:
    // the first wins, the rest get null. Re-claim by the same agent is allowed.
    if (task.status !== 'pending' && task.claimedBy !== params.agentId) return null;

    task.status = 'in-progress';
    task.claimedAt = new Date().toISOString();
    task.claimedBy = params.agentId;
    
    const taskFile = this.resolveTaskFile(task.id) || `${task.id}.json`;
    this.writeTaskFile(taskFile, task);

    this.eventBus.emitTaskClaimed(task, params.agentId);
    return task;
  }

  /** Register the Dispatcher's completion guard (see {@link CompletionGuard}). */
  public setCompletionGuard(fn: CompletionGuard): void { this.completionGuard = fn; }


  public async completeTask(params: { taskId: string; result?: string; internal?: boolean }): Promise<Task | null> {
    const task = this.getTask(params.taskId);
    if (!task) return null;

    // External completions (a remote brain reporting its result) pass through the
    // guard: a soft failure reported as a result — a rate-limit / "you've hit your
    // session limit" notice, a refusal, or an empty answer — is rejected and
    // handed to the next fallback brain instead of being marked done. The
    // dispatcher's own completions are already verified, so they pass internal:true.
    let result = params.result;
    if (!params.internal && this.completionGuard && task.status !== 'done') {
      const decision = await this.completionGuard(task, params.result);
      if (decision.action === 'handover') return this.getTask(params.taskId);
      if (decision.action === 'wait-input') {
        return this.parkForInput({ taskId: task.id, questions: decision.questions || [], result: params.result });
      }
      if (decision.action === 'defer-background') {
        return this.deferForBackground({ taskId: task.id, note: decision.note, result: params.result, pollMs: decision.pollMs });
      }
      if (decision.result !== undefined) result = decision.result;
    }

    task.status = 'done';
    task.completedAt = new Date().toISOString();
    if (result) task.result = result;
    // Flag a chain-exhausted failure (every fallback brain failed verification) so
    // the UI groups it into the red "failed" category with a confirm-gated re-run,
    // rather than listing it as a green success. Covers BOTH completion paths — the
    // dispatcher's own internal completion and a remote brain's guarded completion
    // — because both finalise here with the same "FAILED after N attempt(s)…" text.
    task.failed = (typeof result === 'string' && /^FAILED after \d+ attempt/i.test(result.trim())) || undefined;

    const taskFile = this.resolveTaskFile(task.id) || `${task.id}.json`;
    this.writeTaskFile(taskFile, task);

    this.eventBus.emitTaskCompleted(task);

    // NOTE: completion no longer spawns the next iteration. A recurring task is now
    // a persistent SCHEDULER (see createTask + releaseDueScheduled): it stays on the
    // `scheduled` status and spawns a one-shot run-child every cycle, so the thing
    // that finishes HERE is either that run-child (which links back to its parent
    // scheduler and just becomes `done`) or a plain one-shot task. Either way this
    // run's own artifacts/result stay on its own card — nothing further to schedule.
    return task;
  }

  /**
   * Spawn a one-shot RUN-CHILD from a recurring parent (its scheduler). The child
   * inherits the parent's brief, routing, brain pin, tags and interaction, but NOT
   * its recurrence or schedule — it enters the pending pool immediately, runs once,
   * and becomes the `done` record for this cycle (carrying that run's own inputs and
   * results on its own card). It links back to the parent via
   * `context.scheduledParentId` so a finished run points at the scheduled task that
   * produced it. Per-run bookkeeping from the parent's context is stripped so it
   * cannot bleed into the child.
   */
  private spawnScheduledRun(parent: Task): Task {
    const ctx = { ...(parent.context || {}) };
    delete ctx.failedBrains;
    const pin = ctx.brainAuto ? undefined : ctx.brain;
    if (pin) ctx.brain = pin; else delete ctx.brain;
    delete ctx.brainAuto;
    delete ctx.claimCount; delete ctx.lastClaimAt; delete ctx.failedCount;
    delete ctx.remoteWaitSince;
    delete ctx.ranAgent; delete ctx.ranDivision; delete ctx.ranBrain; delete ctx.isRoster;
    delete ctx.dispatched; delete ctx.inputFiles;
    delete ctx.humanInput; delete ctx.awaitingInput; delete ctx.inputQuestions;
    delete ctx.attempts; delete ctx.continuedFrom; delete ctx.continuedInto;
    delete ctx.periodicPrevId; delete ctx.periodicNextId;
    ctx.scheduledParentId = parent.id;   // a finished run links back to its scheduler

    return this.createTask({
      title: parent.title,
      description: parent.description,
      from: parent.from,
      to: parent.to,
      priority: parent.priority,
      skill: parent.skill,
      context: ctx,
      tags: parent.tags,
      interaction: parent.interaction,
      // no recurrence, no scheduledAt → a one-shot that runs now (pending)
    });
  }

  /**
   * Re-queue a FAILED (chain-exhausted) or rejected task for another run. Resets
   * it to `pending` from the TOP of its chain: clears the failed flag, the prior
   * result/claim/completion, and the scheduling bookkeeping (attempts / dispatched /
   * failedBrains / dispatcher-published brain pin), while preserving the brief, the
   * agent / division / user brain pin, and any attached input files. The UI gates
   * this behind an explicit confirmation. Returns null if the task is gone or is
   * not in a re-runnable (finished-failed) state.
   */
  public rerunTask(taskId: string, brainOverride?: string, opts?: { scheduledAt?: string }): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (!isFailedTask(task)) return null;

    const ctx: Record<string, any> = { ...(task.context || {}) };
    delete ctx.failedBrains;
    // Which brain claims the re-run. Default preserves a deliberate USER pin
    // (context.brain set WITHOUT brainAuto) and drops a dispatcher-published
    // chain pin (brainAuto, transient). The caller may override that default:
    // '' clears the pin (route via chain), '<id>' pins that known brain.
    const existingPin = ctx.brainAuto ? undefined
      : (typeof ctx.brain === 'string' ? ctx.brain : undefined);
    const targetBrain = this.resolveBrainOverride(brainOverride, existingPin);
    delete ctx.brainAuto;
    if (targetBrain) ctx.brain = targetBrain; else delete ctx.brain;
    ctx.attempts = 0;
    ctx.dispatched = false;
    delete ctx.remoteWaitSince;
    delete ctx.ranAgent; delete ctx.ranDivision; delete ctx.ranBrain; delete ctx.isRoster;

    task.context = ctx;
    task.status = 'pending';
    if (opts?.scheduledAt !== undefined) {
      const at = Date.parse(String(opts.scheduledAt));
      if (!Number.isFinite(at)) {
        throw new Error(`Invalid scheduledAt "${opts.scheduledAt}" — use an ISO 8601 date-time (e.g. 2026-08-08T09:00:00+08:00)`);
      }
      task.scheduledAt = new Date(at).toISOString();
      if (at > Date.now()) task.status = 'scheduled';
    } else {
      delete task.scheduledAt;
    }
    delete task.failed;
    delete task.result;
    delete task.claimedAt;
    delete task.claimedBy;
    delete task.completedAt;
    this.saveTask(task);
    this.eventBus.emitTaskCreated(task);   // nudge live dashboards to refresh
    return task;
  }

  /**
   * EDIT a task's parameters in place — the counterpart to the New-task composer,
   * but with the existing task's fields loaded and saved back. Only a task that is
   * NEITHER running NOR pending is editable: a `pending`/`claimed`/`in-progress`
   * task is (or is about to be) executing, so mutating its brief mid-flight would
   * race the dispatcher. Editable states are therefore `scheduled`, `wait-input`,
   * `done`, `rejected`, and chain-exhausted `failed`.
   *
   * Every field in `patch` is optional; only provided keys are touched. Scheduling
   * follows the same rules as {@link createTask}: a FUTURE `scheduledAt` parks the
   * task on `scheduled`; an empty/past one releases it into the pending pool (or
   * `wait-input` when it still carries unanswered questions). Re-arming a FINISHED
   * task (giving a done/rejected/failed task a fresh run time, or a past time to
   * "run now") clears its previous result/claim/completion and resets the chain
   * bookkeeping so it re-dispatches cleanly from the top — matching the "edit it
   * like a new task and save" intent. Returns null when the task is gone; throws
   * when it is running/pending or the patch is invalid.
   */
  public updateTask(taskId: string, patch: {
    title?: string;
    description?: string;
    priority?: Task['priority'];
    tags?: string[];
    agent?: string | null;
    division?: string | null;
    brain?: string | null;
    scheduledAt?: string | null;
    loopIntervalHours?: number | null;
    /** A flexible recurrence spec (see core/recurrence.ts), or null/'none' to
     *  clear the cadence. Takes precedence over `loopIntervalHours` when both are
     *  supplied. Invalid specs throw. */
    recurrence?: TaskRecurrence | { type?: string } | null;
  }): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (task.status === 'pending' || task.status === 'in-progress' || task.status === 'claimed') {
      throw new Error(`Task is ${task.status} — only tasks that are not running or pending can be edited`);
    }

    if (typeof patch.title === 'string') {
      if (!patch.title.trim()) throw new Error('title cannot be empty');
      task.title = patch.title;
    }
    if (typeof patch.description === 'string') task.description = patch.description;
    if (patch.priority && ['low', 'normal', 'high', 'urgent'].includes(patch.priority)) {
      task.priority = patch.priority;
    }
    if (Array.isArray(patch.tags)) task.tags = patch.tags;

    // Routing context — agent / division / brain pin. An empty string clears the
    // key (back to Auto), a non-empty value sets it, undefined leaves it as-is.
    const ctx: Record<string, any> = { ...(task.context || {}) };
    const setCtx = (key: string, val: string | null | undefined) => {
      if (val === undefined) return;
      if (val === null || val === '') delete ctx[key]; else ctx[key] = val;
    };
    setCtx('agent', patch.agent);
    setCtx('division', patch.division);
    if (patch.brain !== undefined) {
      // A pinned brain must exist in the registry (mirrors resolveBrainOverride),
      // else the task would target a brain that can never claim it.
      if (patch.brain && patch.brain.trim()) {
        const brains = this.config.orchestration?.brains || {};
        if (!brains[patch.brain]) throw new Error(`Unknown brain "${patch.brain}" — not in the registry`);
        ctx.brain = patch.brain;
        delete ctx.brainAuto;   // an explicit edit is a USER pin, not a dispatcher-published one
      } else {
        delete ctx.brain;
        delete ctx.brainAuto;
      }
    }
    task.context = ctx;

    // Cadence. A `recurrence` patch wins over the legacy hour interval; either
    // key, when present, fully (re)defines the task's periodicity. null / 'none' /
    // a zero interval clears it. loopIntervalHours is kept mirrored via
    // syncLegacyLoopField so old cards keep showing an hour-based loop's value.
    if (patch.recurrence !== undefined) {
      task.recurrence = patch.recurrence == null ? undefined : normalizeRecurrence(patch.recurrence);
      if (task.recurrence === undefined) delete task.recurrence;
      this.syncLegacyLoopField(task);
    } else if (patch.loopIntervalHours !== undefined) {
      task.recurrence = recurrenceFromLegacyHours(
        patch.loopIntervalHours && patch.loopIntervalHours > 0 ? patch.loopIntervalHours : undefined);
      if (task.recurrence === undefined) delete task.recurrence;
      this.syncLegacyLoopField(task);
    }

    // Scheduling. Only touched when the caller included the `scheduledAt` key.
    if (patch.scheduledAt !== undefined) {
      const finished = task.status === 'done' || task.status === 'rejected' || isFailedTask(task);
      // Clear a finished run's completion + chain bookkeeping so a re-armed task
      // dispatches fresh from the top of its chain (shared by both branches below).
      const rearmFinished = () => {
        const c: Record<string, any> = { ...(task.context || {}) };
        c.attempts = 0;
        c.dispatched = false;
        delete c.failedBrains;
        delete c.brainAuto;
        delete c.remoteWaitSince;
        delete c.ranAgent; delete c.ranDivision; delete c.ranBrain; delete c.isRoster;
        task.context = c;
        delete task.failed;
        delete task.result;
        delete task.claimedAt;
        delete task.claimedBy;
        delete task.completedAt;
      };
      const awaiting = task.interaction && Array.isArray(task.interaction.fields)
        && task.interaction.fields.length > 0 && task.interaction.status !== 'submitted';

      if (patch.scheduledAt === null || patch.scheduledAt === '') {
        // Cleared: drop the launch time. A parked `scheduled` task releases into the
        // pending pool now (or wait-input if unanswered). A finished task keeps its
        // finished status — clearing the schedule is a metadata edit, not a re-run.
        delete task.scheduledAt;
        if (task.status === 'scheduled') task.status = awaiting ? 'wait-input' : 'pending';
      } else {
        const at = Date.parse(String(patch.scheduledAt));
        if (!Number.isFinite(at)) {
          throw new Error(`Invalid scheduledAt "${patch.scheduledAt}" — use an ISO 8601 date-time (e.g. 2026-08-08T09:00:00+08:00)`);
        }
        task.scheduledAt = new Date(at).toISOString();
        if (finished) rearmFinished();
        if (at > Date.now()) {
          task.status = 'scheduled';
        } else {
          // A past/now time means "run now": release it (finished tasks were just
          // re-armed above, so this re-runs them).
          task.status = awaiting ? 'wait-input' : 'pending';
        }
      }
    }

    // Keep a recurring task a SCHEDULER (mirrors createTask): if an edit left it
    // with a recurrence but sitting in the runnable pool, park it back on
    // `scheduled` so it spawns run-children rather than running its own body. A
    // finished task is untouched unless the scheduledAt edit above already re-armed
    // it into the pool, in which case it too becomes a scheduler again.
    if (task.recurrence && (task.status === 'pending' || task.status === 'wait-input')) {
      if (task.scheduledAt === undefined) task.scheduledAt = new Date().toISOString();
      task.status = 'scheduled';
    }

    this.saveTask(task);
    this.eventBus.emitTaskCreated(task);   // nudge live dashboards to refresh
    return task;
  }

  /** Persistent per-task artifacts dir. */
  private artifactsDir(taskId: string): string {
    return path.join(this.config.paths.artifacts, path.basename(taskId));
  }

  /**
   * Copy a FINISHED task's outputs into a fresh task's inputs dir so a
   * continuation run reads exactly what the prior run produced: its RESULT
   * (written as previous-result.md) plus every OUTPUT ARTIFACT file
   * (artifacts/<prevId>/*). Names collide-suffix like {@link materializeInputs}.
   * Returns the stored input filenames (for context.inputFiles).
   */
  private seedContinuationInputs(newTaskId: string, prev: Task): string[] {
    const dir = this.inputsDir(newTaskId);
    const stored: string[] = [];
    const place = (name: string, write: (dest: string) => void): void => {
      fs.mkdirSync(dir, { recursive: true });
      const original = path.basename(name);
      let out = original, dest = path.join(dir, out);
      for (let n = 1; fs.existsSync(dest); n++) {
        const ext = path.extname(original);
        out = `${path.basename(original, ext)}-${n}${ext}`;
        dest = path.join(dir, out);
      }
      try { write(dest); stored.push(out); } catch { /* ignore */ }
    };

    // 1) The prior result as a readable markdown file the brain can open.
    if (typeof prev.result === 'string' && prev.result.trim()) {
      place('previous-result.md', dest =>
        fs.writeFileSync(dest, `# Result of "${prev.title || prev.id}"\n\n${prev.result}\n`));
    }
    // 2) Every output artifact the prior run produced.
    const artDir = this.artifactsDir(prev.id);
    let artFiles: string[] = [];
    try {
      artFiles = fs.readdirSync(artDir).filter(f => { try { return fs.statSync(path.join(artDir, f)).isFile(); } catch { return false; } });
    } catch { /* no artifacts */ }
    for (const f of artFiles) {
      if (/[\\/]/.test(f)) continue;
      place(f, dest => fs.copyFileSync(path.join(artDir, f), dest));
    }
    return stored;
  }

  /**
   * CONTINUE a successfully-finished task: spawn a NEW `pending` task that
   * resumes the work, seeded with the finished run's OUTPUTS as its inputs — the
   * prior result plus every artifact it produced land under inputs/<newId>/ and
   * on context.inputFiles, so the executor picks up exactly where it left off.
   * The continuation is pinned to the same executor that ran the original
   * (agent / division / brain), and records context.continuedFrom = <prevId>.
   *
   * Only a DONE, non-failed task is continuable — a chain-exhausted failure uses
   * {@link rerunTask} instead. Inputs are materialized BEFORE the task is written
   * or emitted (mirrors createTask), so it is never claimable without them.
   * Returns null when the task is gone or not in a continuable state.
   *
   * `opts` carries the extra steer the operator adds in the Continue dialog:
   *   - `prompt`  additional instructions appended to the follow-up's brief, so
   *               the operator can redirect the next run instead of merely
   *               replaying the same task with fresh inputs.
   *   - `inputs`  extra staged uploads (from POST /api/uploads) materialized into
   *               the SAME inputs/<newId>/ dir alongside the seeded outputs and
   *               unioned onto context.inputFiles — reference material for the
   *               continuation, on equal footing with the prior run's outputs.
   */
  public continueTask(
    taskId: string,
    brainOverride?: string,
    opts: { prompt?: string; inputs?: Array<{ token?: string; name?: string }>; scheduledAt?: string } = {}
  ): Task | null {
    const prev = this.getTask(taskId);
    if (!prev) return null;
    const isFailed = prev.failed === true
      || (typeof prev.result === 'string' && /^FAILED\b/i.test(prev.result.trim()));
    if (prev.status !== 'done' || isFailed) return null;

    const id = uuidv4();
    const prevCtx = prev.context || {};
    // Pin to the same executor that ran the original so the follow-up resumes on
    // the same brain/agent, not a fresh routing decision. ranAgent/ranBrain are
    // what actually ran; fall back to the original assignment when unset.
    const ctx: Record<string, any> = { continuedFrom: prev.id };
    const agent = prevCtx.ranAgent || prevCtx.agent || prevCtx.role;
    const division = prevCtx.ranDivision || prevCtx.division;
    const sameBrain = prevCtx.ranBrain || prevCtx.brain;
    if (agent) ctx.agent = agent;
    if (division) ctx.division = division;
    // Which brain claims the follow-up. The caller may override the same-brain
    // default (see resolveBrainOverride): undefined keeps the original's brain,
    // '' routes via the agent's chain ("Auto"), '<id>' pins that known brain.
    const targetBrain = this.resolveBrainOverride(brainOverride, sameBrain);
    if (targetBrain) ctx.brain = targetBrain;   // else: no pin → chain routes it

    const title = /^continue\b/i.test(prev.title || '') ? prev.title : `Continue: ${prev.title || 'task'}`;
    // Operator's added steer for THIS continuation — surfaced as its own section
    // so the brain treats it as the current directive over the carried-over brief.
    const extraPrompt = typeof opts.prompt === 'string' ? opts.prompt.trim() : '';
    const description = [
      prev.description || '',
      '',
      '---',
      `This task CONTINUES a previous run ("${prev.title || prev.id}") that finished successfully.`,
      'Its result and every output file it produced are attached as input files (under inputs/, mirrored on context.inputFiles) — read them first, then carry the work forward from where it left off.',
      ...(extraPrompt ? ['', '## Additional instructions for this continuation', extraPrompt] : [])
    ].join('\n');

    const task: Task = {
      id,
      title,
      description,
      from: prev.from,
      to: prev.to || {},
      priority: prev.priority || 'normal',
      status: 'pending',
      context: ctx,
      createdAt: new Date().toISOString(),
      ...(prev.skill ? { skill: prev.skill } : {}),
      ...(Array.isArray(prev.tags) ? { tags: [...prev.tags] } : {})
    };

    if (opts?.scheduledAt !== undefined) {
      const at = Date.parse(String(opts.scheduledAt));
      if (!Number.isFinite(at)) {
        throw new Error(`Invalid scheduledAt "${opts.scheduledAt}" — use an ISO 8601 date-time (e.g. 2026-08-08T09:00:00+08:00)`);
      }
      task.scheduledAt = new Date(at).toISOString();
      if (at > Date.now()) task.status = 'scheduled';
    }

    // Seed inputs from the prior run's outputs BEFORE the task is visible/pending,
    // then fold in any extra files the operator attached in the Continue dialog.
    // Both land in inputs/<newId>/ and collide-suffix independently; the union
    // keeps context.inputFiles a faithful listing of that dir.
    const seeded = this.seedContinuationInputs(id, prev);
    const extra = Array.isArray(opts.inputs) && opts.inputs.length
      ? this.materializeInputs(id, opts.inputs) : [];
    const inputFiles = [...new Set([...seeded, ...extra])];
    if (inputFiles.length) ctx.inputFiles = inputFiles;

    this.writeTaskFile(`${id}.json`, task);

    // Durably stamp the ORIGINAL as continued (→ the new task's id) so the
    // dashboard can disable its "Continue" button after a re-render. Without
    // this the button returns enabled on every refresh and a user can spawn
    // unlimited duplicate follow-ups from one done card.
    prev.context = { ...(prev.context || {}), continuedInto: id };
    this.saveTask(prev);

    this.eventBus.emitTaskCreated(task);
    return task;
  }

  /**
   * Resolve a caller-supplied brain choice for a continue/re-run into the brain
   * id to pin (or undefined for "no pin — route via the agent's chain"):
   *   - `undefined`  → no explicit choice; keep `fallback` (same-brain default)
   *   - `''` (blank) → explicit "Auto"; return undefined so the chain routes it
   *   - `'<id>'`     → pin to exactly that brain; MUST exist in the registry
   * Throws on an unknown brain id so the API surfaces a 400 rather than pinning
   * a task to a brain that can never claim it.
   */
  private resolveBrainOverride(override: string | undefined, fallback: string | undefined): string | undefined {
    if (override === undefined) return fallback;
    const v = override.trim();
    if (!v) return undefined;
    const brains = this.config.orchestration?.brains || {};
    if (!brains[v]) throw new Error(`Unknown brain "${v}" — not in the registry`);
    return v;
  }

  /**
   * Delete a task and everything filed under it: its inbox JSON, its artifacts
   * dir, and its input files.
   */
  public deleteTask(id: string): { deleted: boolean; artifacts: boolean } {
    const task = this.getTask(id);
    if (!task) return { deleted: false, artifacts: false };
    // getTask resolves short ids by prefix, so `id` may be an 8-char short id.
    // Everything below keys off the canonical full UUID so a short-id delete
    // can't orphan the task file / artifacts / inputs.
    const fullId = task.id;

    const artDir = path.join(this.config.paths.artifacts, fullId);
    let artifacts = false;
    if (fs.existsSync(artDir)) {
      try { fs.rmSync(artDir, { recursive: true, force: true }); artifacts = true; } catch { /* ignore */ }
    }

    const inDir = path.join(this.config.paths.inputs, fullId);
    if (fs.existsSync(inDir)) {
      try { fs.rmSync(inDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    const taskFile = this.resolveTaskFile(fullId) || `${fullId}.json`;
    fs.rmSync(path.join(this.config.paths.inbox, taskFile), { force: true });
    return { deleted: true, artifacts };
  }

  /**
   * Bulk-purge finished tasks that are no longer worth keeping. A task is KEPT
   * when any of these hold:
   *   • not finished (pending/claimed/in-progress)
   *   • finished more recently than `olderThanDays`
   *   • it is tagged `keep`/`important`/`pinned` (explicit "this is meaningful")
   * NOTE: having artifacts no longer protects a task — an old finished task is
   * purged whether or not it produced files (its artifacts are deleted with it).
   * The dashboard therefore warns before deleting. Pass dryRun to preview
   * exactly what would go.
   */
  public purgeTasks(opts: { olderThanDays?: number; dryRun?: boolean } = {}): {
    purged: Array<{ id: string; title: string; completedAt?: string }>;
    keptCount: number; dryRun: boolean;
  } {
    const days = opts.olderThanDays ?? 30;
    const cutoff = Date.now() - days * 86400000;
    const keepTags = new Set(['keep', 'important', 'pinned']);
    const purged: Array<{ id: string; title: string; completedAt?: string }> = [];
    let keptCount = 0;

    for (const task of this.listTasks({})) {
      const finished = task.status === 'done' || task.status === 'rejected';
      const when = new Date(task.completedAt || task.createdAt).getTime();
      const tagged = (task.tags || []).some(t => keepTags.has(String(t).toLowerCase()));
      // Artifacts no longer keep a task alive — old finished tasks go regardless.
      if (!finished || when >= cutoff || tagged) { keptCount++; continue; }

      purged.push({ id: task.id, title: task.title, completedAt: task.completedAt });
      if (!opts.dryRun) this.deleteTask(task.id);
    }
    return { purged, keptCount, dryRun: !!opts.dryRun };
  }

  /** Persist arbitrary task mutations (handover, retries). */
  public saveTask(task: Task): void {
    const file = this.resolveTaskFile(task.id) || `${task.id}.json`;
    this.writeTaskFile(file, task);
  }

  /**
   * Atomically persist a task's JSON to `inbox/<file>`. Writes to a unique temp
   * file in the SAME directory, fsyncs it, then renameSync()s it into place — an
   * all-or-nothing swap on POSIX.
   *
   * This closes a silent data-loss window that could make tasks "disappear": the
   * previous write sites did `fs.writeFileSync(dest, …)` directly, which truncates
   * the live task file to zero bytes BEFORE rewriting it. A crash / SIGKILL mid-
   * write — and the server is redeployed/restarted often — left a truncated or
   * empty JSON on disk. `readTaskFile` then swallowed the parse error and returned
   * null, so the task vanished from every listing and the dashboard with no trace.
   * Because `inbox/*.json` is gitignored, such a loss is unrecoverable. A rename is
   * atomic: a reader (this process re-scanning, or an external client) sees either
   * the old complete file or the new complete file, never a half-written one.
   *
   * The temp name is dot-prefixed and ends in `.tmp` so it is invisible to both
   * `listTasks` (readdir → `endsWith('.json')`) and `resolveTaskFile`'s
   * `<id>*.json` glob; a temp leaked by a crash between open and rename is inert
   * and cleaned up by the next write to the same file.
   */
  private writeTaskFile(file: string, task: Task): void {
    const dest = path.join(this.config.paths.inbox, file);
    const tmp = path.join(this.config.paths.inbox, `.${file}.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(task, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Keep the legacy `loopIntervalHours` field consistent with `recurrence` so
   * older dashboards/clients that only understand the hour interval still show a
   * meaningful value: an hour-based recurrence mirrors its interval onto the
   * legacy field; any other cadence (minutes/daily/weekly/monthly/cron) or no
   * recurrence at all drops it (it can't express those and would mislead).
   */
  private syncLegacyLoopField(task: Task): void {
    if (task.recurrence && task.recurrence.type === 'hours' && task.recurrence.interval) {
      task.loopIntervalHours = task.recurrence.interval;
    } else {
      delete task.loopIntervalHours;
    }
  }

  /**
   * Record a person's answers to a task's interaction (its questions/checklist).
   * Writes each answer onto its field's `value`, flips the packet to `submitted`,
   * and mirrors a clean `{label: value}` map into `context.humanInput` so the
   * answers show up in the executing agent's prompt (buildPrompt dumps context).
   * Returns the updated task, or null if the task has no interaction.
   */
  public submitInteraction(params: {
    taskId: string;
    responses: Record<string, string | boolean>;
    submittedBy?: string;
  }): Task | null {
    const task = this.getTask(params.taskId);
    if (!task || !task.interaction) return null;

    // Accumulate across rounds: an agent that pauses again (parkForInput) gets a
    // FRESH interaction packet, but the answers it already received must not be
    // dropped — otherwise every follow-up loses the earlier context and the agent
    // re-asks the same things, so the task never progresses past wait-input. Seed
    // from any prior humanInput and let this round's answers overwrite by label.
    const prior = (task.context?.humanInput as Record<string, string | boolean>) || {};
    const humanInput: Record<string, string | boolean> = { ...prior };
    for (const field of task.interaction.fields) {
      if (Object.prototype.hasOwnProperty.call(params.responses, field.id)) {
        let val = params.responses[field.id];
        if (field.type === 'checkbox') val = !!val;
        field.value = val;
      }
      // Require required fields to have a non-empty answer.
      if (field.required) {
        const v = field.value;
        const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
        if (empty && field.type !== 'checkbox') {
          throw new Error(`Field "${field.label}" is required`);
        }
      }
      if (field.value !== undefined) humanInput[field.label] = field.value;
    }

    task.interaction.status = 'submitted';
    task.interaction.submittedAt = new Date().toISOString();
    if (params.submittedBy) task.interaction.submittedBy = params.submittedBy;
    task.context = { ...(task.context || {}), humanInput };
    // Release the task into normal scheduling now that the answers are in. Only a
    // task still parked on `wait-input` is promoted — one already claimed/running
    // (e.g. answers edited mid-flight) keeps its live status untouched.
    if (task.status === 'wait-input') task.status = 'pending';

    this.saveTask(task);
    return task;
  }

  /**
   * Park a task on `wait-input` because its produced result ASKED THE USER a
   * question rather than delivering — so the orchestrator neither marks it done
   * nor hands it to a fallback brain. The questions become an interaction packet
   * the user answers from the Inbox card; submitInteraction() then releases it
   * back to `pending` (re-dispatched with the answers in context.humanInput). The
   * partial output is preserved on task.result so the user sees what was asked.
   */
  public parkForInput(params: { taskId: string; questions: string[]; result?: string }): Task | null {
    const task = this.getTask(params.taskId);
    if (!task) return null;
    const qs = (params.questions || []).map(q => (q || '').trim()).filter(Boolean).slice(0, 8);
    const labels = qs.length ? qs : ['The agent needs more information to proceed. Please provide guidance.'];
    const fields: InteractionField[] = labels.map((label, i) => ({
      id: `q${i + 1}`,
      label,
      type: 'textarea',
      // First question required so the packet can't be submitted empty; the rest optional.
      required: i === 0
    }));
    task.interaction = {
      prompt: 'The assigned agent paused and needs your input before it can finish this task.',
      fields,
      status: 'pending'
    };
    task.status = 'wait-input';
    delete task.claimedAt;
    delete task.claimedBy;
    if (params.result) task.result = params.result;
    // Reset scheduling flags so the resubmitted task re-dispatches cleanly from the
    // top of its chain — the previous run succeeded in producing a question, not a
    // failure, so it must not count against the fallback attempts.
    task.context = {
      ...(task.context || {}),
      dispatched: false,
      attempts: 0,
      remoteWaitSince: undefined,
      awaitingInput: true,
      inputQuestions: qs
    };
    this.saveTask(task);
    return task;
  }

  /**
   * DEFER a task whose agent is still waiting on long background work it launched
   * (a background shell, a spawned sub-agent, a CI/deploy/render job). Instead of
   * marking it `done` and closing the session, re-arm it on `scheduled` a short
   * while out so a later run checks whether the background job finished and only
   * then delivers. The partial output is preserved on task.result + carried into
   * context.backgroundWait so the next run's prompt knows what it was waiting on.
   * A bounded deferral count (context.backgroundWait.count) prevents an infinite
   * loop when a background job never finishes — the caller enforces the cap.
   */
  public deferForBackground(params: { taskId: string; note?: string; result?: string; pollMs?: number }): Task | null {
    const task = this.getTask(params.taskId);
    if (!task) return null;
    const pollMs = Number.isFinite(params.pollMs) && (params.pollMs as number) > 0 ? (params.pollMs as number) : 120000;
    const prev = (task.context?.backgroundWait as { count?: number } | undefined) || {};
    const count = (Number(prev.count) || 0) + 1;
    task.status = 'scheduled';
    task.scheduledAt = new Date(Date.now() + pollMs).toISOString();
    delete task.claimedAt;
    delete task.claimedBy;
    if (params.result) task.result = params.result;
    // Reset scheduling flags so the re-armed task re-dispatches cleanly from the
    // top of its chain — the previous run produced a wait, not a failure, so it
    // must not count against the fallback attempts.
    task.context = {
      ...(task.context || {}),
      dispatched: false,
      attempts: 0,
      remoteWaitSince: undefined,
      backgroundWait: { count, note: params.note || prev['note' as keyof typeof prev] || undefined, at: new Date().toISOString() }
    };
    this.saveTask(task);
    this.eventBus.emitTaskCreated(task);   // nudge live dashboards to refresh
    return task;
  }

  // ── Parsed-task read-through cache (keyed on mtime+size) ───────────────────
  // The store is one JSON file per task. The dispatcher re-scans the WHOLE inbox
  // up to three times per 5s tick (releaseDueScheduled, reclaimStaleClaims, and
  // the pending scan) and every dashboard poll re-reads it too — so a few hundred
  // mostly-`done` task files get read + JSON.parsed over and over even though they
  // never change. This cache re-reads a file only when its mtime OR byte size has
  // changed, so callers still observe exact on-disk state (any write busts the
  // entry — a status flip always changes the file's size/mtime) while an unchanged
  // file costs a single stat. Callers mutate the tasks they receive (claim/save),
  // so every read returns a structuredClone; the cached copy is never aliased.
  private taskCache = new Map<string, { key: string; task: Task | null }>();

  private readTaskFile(file: string): Task | null {
    const fullPath = path.join(this.config.paths.inbox, file);
    let st: fs.Stats;
    try { st = fs.statSync(fullPath); }
    catch { this.taskCache.delete(file); return null; }   // gone → drop any stale entry
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = this.taskCache.get(file);
    // A cached entry (including a negative one — task:null for unparseable bytes)
    // is trusted until the file's mtime/size changes, so a persistently malformed
    // file isn't re-read on every tick.
    if (hit && hit.key === key) return hit.task ? structuredClone(hit.task) : null;
    let task: Task | null = null;
    try { task = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as Task; }
    catch (e) {
      // A present-but-unparseable task file used to be dropped SILENTLY here, so a
      // corrupted/truncated task simply vanished from every listing and the
      // dashboard with no trace — indistinguishable from "my task disappeared".
      // We still tolerate the bad file (return null so one broken record can't
      // break listTasks), but we now LOG it loudly. The parse is only reached on a
      // cache miss (new mtime+size), so this warns once per change, not every tick.
      console.error(
        `Store: inbox/${file} is present but UNPARSEABLE — this task is HIDDEN from ` +
        `every listing and the dashboard until it is fixed or removed ` +
        `(${(e as Error).message}). Note: inbox/*.json is gitignored, so it cannot ` +
        `be recovered from git.`
      );
      task = null;
    }
    this.taskCache.set(file, { key, task });
    return task ? structuredClone(task) : null;
  }

  public getTask(id: string): Task | null {
    if (!id) return null;
    // Fast path: exact filename match (full UUID, the canonical stored form).
    const direct = this.readTaskFile(`${id}.json`);
    if (direct) return direct;
    // Slow path: the UI and chat both surface an 8-char SHORT id
    // (first UUID segment, e.g. "6e7fa48c"). When a caller looks a task up by
    // that short id the exact match above misses, even though the task exists
    // on disk as "6e7fa48c-….json". Resolve the short id by prefix.
    const shortId = this.resolveTaskFile(id);
    if (shortId) return this.readTaskFile(shortId);
    return null;
  }

  /**
   * Resolve a task id (full UUID *or* an 8-char short id / any unambiguous
   * prefix) to its on-disk filename. Returns null when nothing matches, or when
   * a short id is ambiguous (matches more than one task) so callers never act on
   * the wrong task. Guards against path separators so an id can't escape inbox.
   */
  private resolveTaskFile(id: string): string | null {
    if (!id || /[\\/]/.test(id)) return null;

    // Fast path: exact canonical filename
    if (fs.existsSync(path.join(this.config.paths.inbox, `${id}.json`))) {
      return `${id}.json`;
    }

    // Only treat plausible id fragments as prefixes (hex + dashes).
    if (/^[0-9a-fA-F-]+$/.test(id)) {
      const matches = globSync(`${id}*.json`, { cwd: this.config.paths.inbox });
      if (matches.length === 1) return matches[0];
    }

    // Fallback: if the filename doesn't match the ID (e.g. manually created test files),
    // we must scan the tasks to find which file holds this ID.
    // Calling listTasks() ensures the cache is hot.
    this.listTasks();
    let shortIdMatch: string | null = null;
    let shortIdMatches = 0;
    
    for (const [file, hit] of this.taskCache.entries()) {
      if (hit.task?.id === id) return file;
      // Guard the .startsWith on a cached task whose `id` is undefined (a
      // malformed / hand-created inbox file): `hit.task?.id.startsWith` only
      // short-circuits on a null task, not a null id, so an id-less cached task
      // would throw here and abort whatever lookup is in flight (observed failing
      // a live dispatch). `?.startsWith` makes the miss a clean no-match instead.
      if (hit.task?.id?.startsWith(id)) {
        shortIdMatch = file;
        shortIdMatches++;
      }
    }
    
    return shortIdMatches === 1 ? shortIdMatch : null;
  }

  public listTasks(filters?: { status?: string; platform?: string; agent?: string; limit?: number }): Task[] {
    // Flat directory of <id>.json files — a plain readdir is ~5x cheaper than a
    // glob here and yields the same set (dotfiles can't be task ids).
    let taskFiles: string[];
    try { taskFiles = fs.readdirSync(this.config.paths.inbox).filter(f => f.endsWith('.json')); }
    catch { taskFiles = []; }
    // Evict cache entries for files that no longer exist (deleted/purged tasks)
    // so the parse cache stays bounded to the live inbox.
    if (this.taskCache.size) {
      const present = new Set(taskFiles);
      for (const f of this.taskCache.keys()) if (!present.has(f)) this.taskCache.delete(f);
    }
    let tasks: Task[] = [];

    for (const file of taskFiles) {
      const task = this.readTaskFile(file);   // mtime+size cached; skips re-parsing unchanged files
      if (task) tasks.push(task);
    }

    // Newest first, by creation time. Robust on two fronts the plain
    // `getTime() - getTime()` subtraction got wrong:
    //  1. A missing/unparseable `createdAt` (malformed or hand-created inbox
    //     files — see readTaskFile) yields NaN; `NaN - x` is NaN, which the
    //     sort reads as "equal", scattering that task to a random slot instead
    //     of the top. We sink such tasks to the bottom (they aren't "latest").
    //  2. Tasks stamped in the same millisecond (batch creation) tied at 0 and
    //     reshuffled between reloads. A stable id tiebreaker pins their order.
    const createdMs = (t: Task): number => {
      const ms = Date.parse(t.createdAt);
      return Number.isNaN(ms) ? -Infinity : ms;
    };
    tasks.sort((a, b) => {
      const ta = createdMs(a), tb = createdMs(b);
      if (ta !== tb) return tb > ta ? 1 : -1;   // newer createdAt on top
      return (b.id || '').localeCompare(a.id || '');
    });
    
    if (filters?.status) {
      if (filters.status === 'failed') {
        tasks = tasks.filter(t => t.failed === true || t.status === 'rejected' || (t.status === 'done' && typeof t.result === 'string' && /^FAILED\b/i.test(t.result.trim())));
      } else if (filters.status === 'done') {
        tasks = tasks.filter(t => t.status === 'done' && !(t.failed === true || (typeof t.result === 'string' && /^FAILED\b/i.test(t.result.trim()))));
      } else {
        tasks = tasks.filter(t => t.status === filters.status);
      }
    }
    // Guard t.to / t.from — task files are plain JSON on disk and may be malformed
    if (filters?.platform) tasks = tasks.filter(t => t.to?.platform === filters.platform || (!t.to?.platform && t.from?.platform === filters.platform));
    if (filters?.agent) tasks = tasks.filter(t => t.to?.agent === filters.agent || t.claimedBy === filters.agent);
    
    if (filters?.limit && filters.limit > 0) {
      tasks = tasks.slice(0, filters.limit);
    }
    
    return tasks;
  }




  public getRoster(filters?: { search?: string; division?: string }): AgentCard[] {
    if (filters?.search) {
      return this.roster.search(filters.search);
    }
    if (filters?.division) {
      return this.roster.getByDivision(filters.division);
    }
    return this.roster.loadAll();
  }

  public getDivisions(): any {
    return this.roster.getDivisions();
  }

  public divisionIds(): string[] {
    return this.roster.divisionIds();
  }

  public getAgentPersona(slug: string): { name: string; division: string; persona: string } | null {
    return this.roster.getPersona(slug);
  }

  public agentsInDivision(division: string): AgentCard[] {
    return this.roster.getByDivision(division);
  }

  public getDashboard(): DashboardData {
    const activeAgents = this.activeAgents.size;
    const tasks = this.listTasks();
    // Single pass over the task list instead of six full .filter() scans.
    let pending = 0, scheduled = 0, waitingInput = 0, inProgress = 0, failed = 0, completed = 0;
    for (const t of tasks) {
      switch (t.status) {
        case 'pending': pending++; break;
        case 'scheduled': scheduled++; break;
        case 'wait-input': waitingInput++; break;
        case 'in-progress': case 'claimed': inProgress++; break;
      }
      // "completed" is every finished task (done or rejected); the UI derives the
      // green "done" pill as completed - failed, so failed must be a subset here.
      if (t.status === 'done' || t.status === 'rejected') completed++;
      if (isFailedTask(t)) failed++;
    }

    const platformStatus: Record<string, boolean> = {};
    for (const [id, p] of Object.entries(this.config.platforms)) {
      platformStatus[id] = p.enabled;
    }

    return {
      activeAgents,
      inboxSummary: {
        pending,
        scheduled,
        waitingInput,
        inProgress,
        completed,
        failed
      },
      platformStatus,
      rosterCount: this.roster.loadAll().length,
      uptime: Math.floor((Date.now() - this.startTime) / 1000)
    };
  }
}
