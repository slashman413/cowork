import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import type { Config, GoalRecord, GoalPhase, AchieverDecision, GoalTemplate, Task } from '../types.js';
import { GOAL_TEMPLATES } from './goal-templates.js';

/** The slice of Store that Goals touches. Keeping it structural lets the unit
 *  tests drive Goals with an in-memory fake exactly like workflows.test.ts. */
export interface GoalStore {
  createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>): Task;
  listTasks(filter?: any): Task[];
  getTask(id: string): Task | null;
  deleteTask?(id: string): unknown;
}

/** Statuses that mean a task is still OPEN (not finished). A goal is only
 *  "quiescent" — ready for the Achiever's next turn — when none of its
 *  generated tasks are in one of these. */
const OPEN_STATUSES = new Set(['pending', 'claimed', 'in-progress', 'scheduled', 'wait-input']);

/**
 * Goals — a long-lived, phase-tracked, self-terminating orchestration aggregate.
 *
 * A Goal drives toward a BINARY success criterion by repeatedly asking its
 * Achiever role to evaluate → plan → emit work, and its Judger role to audit each
 * completed phase (reports + meeting minutes). It reuses the platform's task /
 * brain / dispatcher machinery wholesale — the only genuinely new parts are this
 * aggregate + its reasoning-context builders (structurally mirroring workflows.ts)
 * and the dispatcher's driveGoals() tick + taskCompleted subscriber.
 *
 * State is filesystem JSON (goals/<goalId>.json), consistent with inbox/*.json
 * and workflow-runs/*.json (ADR-006). Every generated task carries goal lineage
 * on its free-form context (goalId, phaseKey, goalGenerated, completesPhase,
 * role) — zero task-schema change (ADR: §7.2).
 */
export class Goals {
  private config: Config;
  private store: GoalStore;

  /**
   * Auto-resume backoff for a blocked goal (ADR-008 — self-healing circuit
   * breaker). A blocked goal is retried automatically after RETRY_BASE_MS,
   * doubling on each consecutive re-block up to RETRY_CAP_MS. The point: a
   * transient fault (the exact thing that killed the first real goal) recovers in
   * ~10 minutes with NO human, while a goal that keeps re-blocking settles into a
   * cheap, capped heartbeat — still re-checking the world every few hours, so it
   * self-resumes the instant the obstacle actually clears, but never spinning.
   * This is what makes `blocked` genuinely different from the old terminal
   * `abandoned`: recovery does not depend on a person clicking Resume.
   */
  static readonly RETRY_BASE_MS = 10 * 60_000;         // 10 min — first retry
  static readonly RETRY_CAP_MS = 6 * 60 * 60_000;      // 6 h — steady-state ceiling

  constructor(config: Config, store: GoalStore) {
    this.config = config;
    this.store = store;
  }

  /** Exponential backoff (base·2^(n-1), capped) for the n-th consecutive block. */
  private backoffMs(blockCount: number): number {
    const n = Math.max(1, blockCount);
    return Math.min(Goals.RETRY_CAP_MS, Goals.RETRY_BASE_MS * 2 ** (n - 1));
  }

  /** Clear the circuit-breaker backoff state — called when a goal makes real
   *  forward progress or an operator manually resumes it (the breaker resets to
   *  CLOSED). */
  private clearBackoff(rec: GoalRecord): void {
    delete rec.blockedAt;
    delete rec.blockCount;
    delete rec.nextRetryAt;
  }

  private dir(): string {
    return this.config.paths.goals;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private save(rec: GoalRecord): GoalRecord {
    const dir = this.dir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    rec.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${rec.goalId}.json`), JSON.stringify(rec, null, 2));
    return rec;
  }

  load(goalId: string): GoalRecord | null {
    const p = path.join(this.dir(), `${goalId}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as GoalRecord; } catch { return null; }
  }

  /** Every goal on disk, newest first. Unreadable files are skipped so one bad
   *  file can't take down the list (same tolerance as Workflows.listRecords). */
  list(): GoalRecord[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    const out: GoalRecord[] = [];
    for (const file of globSync('*.json', { cwd: dir })) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as GoalRecord); } catch { /* skip */ }
    }
    return out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  get(goalId: string): GoalRecord | null { return this.load(goalId); }

  /**
   * The curated goal starter library — the "/goal" half of the goal+loop idiom
   * (ADR-010). One source of truth (`core/goal-templates.ts`) that the dashboard,
   * `GET /api/goals/templates`, and CLI/agents all read, so a starter can never
   * drift between the UI and the programmatic surfaces the way it did while the
   * list lived only inside `public/js/app.js`.
   */
  templates(): GoalTemplate[] { return GOAL_TEMPLATES; }

  // ── Authoring ────────────────────────────────────────────────────────────

  /**
   * Validate a goal's authoring discipline. [] = valid. The guardrails from the
   * spec's Good/Bad table are enforced HERE, at the boundary: a binary success
   * criterion and well-formed, unique kebab-case phase keys. Returned so the
   * create-goal form / API can show the reason instead of silently failing.
   */
  validate(rec: Pick<GoalRecord, 'title' | 'successCriteria' | 'phases'>): string[] {
    const errors: string[] = [];
    if (!rec.title || !String(rec.title).trim()) errors.push('title is required');
    if (!rec.successCriteria || !String(rec.successCriteria).trim()) {
      errors.push('successCriteria (the binary Yes/No question) is required — a goal with no criterion can never terminate');
    }
    const keys = new Set<string>();
    for (const p of rec.phases || []) {
      if (!p.key || !/^[a-z0-9][a-z0-9-]*$/.test(p.key)) {
        errors.push(`phase key "${p.key}" must be kebab-case (lowercase letters, digits, hyphens)`);
        continue;
      }
      if (keys.has(p.key)) errors.push(`duplicate phase key "${p.key}"`);
      keys.add(p.key);
      if (!p.title || !String(p.title).trim()) errors.push(`phase "${p.key}" needs a title`);
    }
    return errors;
  }

  /**
   * Create a goal in `draft`. It is NOT driven until activated (which enforces
   * the "good goal setup" guardrails: a binary criterion + ≥1 phase). Phases are
   * seeded here (user waypoints) and normalised to `planned`/empty task lists.
   */
  create(input: {
    title: string;
    description?: string;
    successCriteria: string;
    reportBrief?: string;
    phases?: { key: string; title: string }[];
    achieverBrainChain?: string[];
    judgerBrainChain?: string[];
    stepBudget?: number;
  }): GoalRecord {
    const phases: GoalPhase[] = (input.phases || []).map(p => ({
      key: String(p.key || '').trim().toLowerCase(),
      title: String(p.title || '').trim(),
      status: 'planned',
      taskIds: []
    }));
    const errors = this.validate({ title: input.title, successCriteria: input.successCriteria, phases });
    if (errors.length) throw new Error(errors.join('; '));
    const now = new Date().toISOString();
    const rec: GoalRecord = {
      goalId: 'goal-' + uuidv4().slice(0, 8),
      title: String(input.title).trim(),
      description: String(input.description || '').trim(),
      successCriteria: String(input.successCriteria).trim(),
      reportBrief: input.reportBrief ? String(input.reportBrief).trim() : undefined,
      status: 'draft',
      phases,
      achieverBrainChain: input.achieverBrainChain,
      judgerBrainChain: input.judgerBrainChain,
      history: [],
      minutes: [],
      stepBudget: typeof input.stepBudget === 'number' && input.stepBudget > 0 ? Math.floor(input.stepBudget) : 24,
      createdAt: now,
      updatedAt: now
    };
    this.save(rec);
    console.log(`Goals: created draft "${rec.goalId}" — ${rec.title}`);
    return rec;
  }

  /** Patch an editable goal (draft or active): criteria, description, brains,
   *  budget, and appended phases. Never mutates history or terminal goals. */
  update(goalId: string, patch: Partial<Pick<GoalRecord,
    'title' | 'description' | 'successCriteria' | 'reportBrief' | 'achieverBrainChain' | 'judgerBrainChain' | 'stepBudget'>>
    & { phases?: { key: string; title: string }[] }): GoalRecord {
    const rec = this.load(goalId);
    if (!rec) throw new Error('goal not found');
    // Only `achieved` is uneditable. A `blocked` goal is editable ON PURPOSE:
    // raising the budget or narrowing the criterion is often exactly what clears
    // the block before a resume.
    if (rec.status === 'achieved') throw new Error(`cannot edit an ${rec.status} goal`);
    if (patch.title !== undefined) rec.title = String(patch.title).trim();
    if (patch.description !== undefined) rec.description = String(patch.description).trim();
    if (patch.successCriteria !== undefined) rec.successCriteria = String(patch.successCriteria).trim();
    if (patch.reportBrief !== undefined) rec.reportBrief = String(patch.reportBrief).trim() || undefined;
    if (patch.achieverBrainChain !== undefined) rec.achieverBrainChain = patch.achieverBrainChain;
    if (patch.judgerBrainChain !== undefined) rec.judgerBrainChain = patch.judgerBrainChain;
    if (patch.stepBudget !== undefined && patch.stepBudget > 0) rec.stepBudget = Math.floor(patch.stepBudget);
    if (patch.phases !== undefined) {
      // Merge: keep existing phases' progress, append new keys, update titles.
      const byKey = new Map(rec.phases.map(p => [p.key, p]));
      for (const p of patch.phases) {
        const key = String(p.key || '').trim().toLowerCase();
        if (!key) continue;
        const existing = byKey.get(key);
        if (existing) existing.title = String(p.title || existing.title).trim();
        else rec.phases.push({ key, title: String(p.title || '').trim(), status: 'planned', taskIds: [] });
      }
    }
    const errors = this.validate(rec);
    if (errors.length) throw new Error(errors.join('; '));
    return this.save(rec);
  }

  /** draft/paused/blocked → active. Refuses a goal that violates the
   *  terminate-ability guardrails: it must carry a binary criterion AND at least
   *  one phase to work (ADR-003). Resuming from `blocked` clears the block
   *  contract (blockReason/unblockCriteria) — the circuit-breaker HALF-OPEN retry.
   *
   *  `opts.auto` distinguishes the two resume paths (ADR-008):
   *   - MANUAL (`auto` falsy — a human via the API/UI): asserts the obstacle is
   *     fixed, so the breaker RESETS — `blockCount` clears and the next block (if
   *     any) starts backoff from scratch.
   *   - AUTO (`auto:true` — the drive loop's scheduled retry): a HALF-OPEN probe.
   *     `blockCount` is KEPT so that if the probe re-blocks, the backoff keeps
   *     growing instead of restarting.
   *
   *  `achieved` is terminal and cannot be reactivated. */
  activate(goalId: string, opts: { auto?: boolean } = {}): GoalRecord {
    const rec = this.load(goalId);
    if (!rec) throw new Error('goal not found');
    if (rec.status === 'active') return rec;
    if (rec.status !== 'draft' && rec.status !== 'paused' && rec.status !== 'blocked') {
      throw new Error(`cannot activate an ${rec.status} goal`);
    }
    if (!rec.successCriteria.trim()) throw new Error('cannot activate: successCriteria (binary Yes/No) is required');
    if (!rec.phases.length) throw new Error('cannot activate: at least one phase (waypoint) is required');
    if (rec.status === 'blocked') {
      const how = opts.auto ? 'auto-resumed (circuit-breaker half-open probe)' : 'resumed by operator';
      rec.history.push({ kind: 'resume', reason: `${how} (was: ${rec.blockReason || 'blocked'})`, at: new Date().toISOString() });
      delete rec.blockReason;
      delete rec.unblockCriteria;
      delete rec.blockedAt;
      delete rec.nextRetryAt;
      if (!opts.auto) delete rec.blockCount;   // manual resume resets the breaker
    }
    rec.status = 'active';
    return this.save(rec);
  }

  pause(goalId: string): GoalRecord {
    const rec = this.load(goalId);
    if (!rec) throw new Error('goal not found');
    if (rec.status !== 'active') throw new Error(`cannot pause a ${rec.status} goal`);
    rec.status = 'paused';
    return this.save(rec);
  }

  resume(goalId: string): GoalRecord { return this.activate(goalId); }

  /**
   * Recoverable hold — the replacement for the old terminal `abandon` (ADR-007).
   * A blocked goal is NOT thrown away: it records the obstacle (`reason`) and the
   * specific, checkable condition that would let it continue (`unblockCriteria` —
   * the WOOP obstacle→plan contract). It stops consuming turns and budget (blocked
   * is excluded from the drive loop, like paused) and waits for a human to clear
   * the obstacle and `resume`, or to `delete` it if the objective is genuinely
   * dead. This is the circuit-breaker OPEN state: stop compounding, name the fault,
   * stay recoverable — never a silent "done" AND never a silent "gave up".
   *
   * A block is SELF-HEALING (ADR-008): it schedules an automatic HALF-OPEN retry
   * at `nextRetryAt` (exponential backoff on `blockCount`). The drive loop resumes
   * the goal on its own once that time passes, so a block never depends on a human
   * being present to recover — the fix for the old `blocked`, whose human-only
   * resume made it as terminal as `abandoned` on an unattended system.
   *
   * Idempotent: re-blocking an already-blocked goal advances the backoff (a
   * consecutive block, so the next retry is further out). An `achieved` goal is
   * terminal and is left untouched.
   */
  block(goalId: string, reason: string, unblockCriteria?: string): GoalRecord {
    const rec = this.load(goalId);
    if (!rec) throw new Error('goal not found');
    if (rec.status === 'achieved') return rec;
    rec.status = 'blocked';
    rec.blockReason = reason;
    rec.unblockCriteria = unblockCriteria && unblockCriteria.trim()
      ? unblockCriteria.trim()
      : 'Addressed automatically on the next scheduled retry, or by a human who resolves the reason above and resumes.';
    rec.blockCount = (rec.blockCount || 0) + 1;
    rec.blockedAt = new Date().toISOString();
    rec.nextRetryAt = new Date(Date.now() + this.backoffMs(rec.blockCount)).toISOString();
    rec.history.push({ kind: 'block', reason, unblockCriteria: rec.unblockCriteria, at: rec.blockedAt });
    console.log(`Goals: blocked ${goalId} — ${reason} | unblock when: ${rec.unblockCriteria} | auto-retry #${rec.blockCount} at ${rec.nextRetryAt}`);
    return this.save(rec);
  }

  /** Blocked goals whose scheduled auto-retry time has arrived — the population
   *  the dispatcher resumes for a single HALF-OPEN probe (ADR-008). A LEGACY
   *  blocked record with no `nextRetryAt` (blocked under ADR-007, before backoff
   *  existed) counts as due, so it self-migrates into the auto-resume loop on the
   *  first tick instead of staying stuck forever. `now` is injectable for tests. */
  blockedGoalsDueForRetry(now: number = Date.now()): GoalRecord[] {
    return this.list().filter(rec => {
      if (rec.status !== 'blocked') return false;
      if (typeof rec.nextRetryAt !== 'string') return true;   // legacy → due now
      return Date.parse(rec.nextRetryAt) <= now;
    });
  }

  /** Remove a goal, optionally deleting the tasks it generated too (mirrors
   *  Workflows.deleteRun). */
  delete(goalId: string, opts: { withTasks?: boolean } = {}): void {
    const p = path.join(this.dir(), `${goalId}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    if (opts.withTasks && this.store.deleteTask) {
      for (const t of this.generatedTasks(goalId)) this.store.deleteTask(t.id);
    }
    console.log(`Goals: deleted ${goalId}${opts.withTasks ? ' (+ generated tasks)' : ''}`);
  }

  // ── Lineage helpers ────────────────────────────────────────────────────────

  /** All tasks the goal generated (bottom-up lineage rides context.goalId). */
  generatedTasks(goalId: string): Task[] {
    return this.store.listTasks().filter(t => t.context?.goalId === goalId && t.context?.goalGenerated);
  }

  /** Count of EXECUTION tasks generated (excludes the read-mostly Judger) — the
   *  number the stepBudget caps. */
  private executionTaskCount(goalId: string): number {
    return this.generatedTasks(goalId).filter(t => t.context?.role !== 'goal-judger').length;
  }

  private isOpen(t: Task | null): boolean { return !!t && OPEN_STATUSES.has(t.status); }

  /**
   * Sanitise an Achiever-supplied checkpoint time into a `{ scheduledAt }` patch
   * for createTask, or null to run the task now.
   *
   * The value comes from an LLM, so it is untrusted: Store.createTask THROWS on an
   * unparseable date, and a throw mid-`emit` would leave the phase holding a
   * half-created, unchained batch. Dropping a bad date (the task simply runs now)
   * is strictly better than losing the turn — the Achiever still made progress,
   * and a checkpoint that fires early is visible and recoverable, whereas an
   * aborted emit counts against MAX_GOAL_FAILURES. A past time is dropped for the
   * same reason Store does: it means "now".
   */
  private checkpointTime(raw: unknown, goalId: string): { scheduledAt: string } | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
      console.warn(`Goals: ${goalId} ignoring unparseable scheduledAt "${raw}" — task will run now`);
      return null;
    }
    if (ms <= Date.now()) return null;
    return { scheduledAt: new Date(ms).toISOString() };
  }

  /** True when the goal has NO open generated task and no phase mid-audit — i.e.
   *  it is edge-triggered ready for the Achiever's next turn. The direct analogue
   *  of Workflows.runsAwaitingDecision. */
  private quiescent(rec: GoalRecord): boolean {
    if (this.generatedTasks(rec.goalId).some(t => this.isOpen(t))) return false;
    if (rec.phases.some(p => p.status === 'completing')) return false;
    return true;
  }

  // ── The Achiever drive surface (called by the dispatcher's driveGoals) ──────

  /** Every goal currently `active` — the population the dispatcher's self-heal
   *  pass scans (a completing phase makes a goal non-quiescent, so it would be
   *  invisible to goalsAwaitingAchiever). */
  activeGoals(): GoalRecord[] {
    return this.list().filter(rec => rec.status === 'active');
  }

  /** Active goals whose last work has finished — the ones the Achiever should
   *  take a turn on this tick. */
  goalsAwaitingAchiever(): GoalRecord[] {
    return this.activeGoals().filter(rec => this.quiescent(rec));
  }

  /** A goal that is stuck with a `completing` phase but no live Judger task — a
   *  self-heal target (dropped taskCompleted event). Returns the phase key to
   *  re-wake the Judger on, or null. */
  phaseNeedingJudger(goalId: string): string | null {
    const rec = this.load(goalId);
    if (!rec) return null;
    for (const ph of rec.phases) {
      if (ph.status !== 'completing') continue;
      const judger = ph.judgerTaskId ? this.store.getTask(ph.judgerTaskId) : null;
      if (!judger || !this.isOpen(judger)) return ph.key;
    }
    return null;
  }

  /** Whether the goal has already blown its execution-task budget. */
  overBudget(goalId: string): boolean {
    const rec = this.load(goalId);
    if (!rec) return false;
    return this.executionTaskCount(goalId) >= (rec.stepBudget ?? 24);
  }

  /** The current workable phase: the earliest one not yet done/audited. */
  private currentPhase(rec: GoalRecord): GoalPhase | null {
    return rec.phases.find(p => p.status !== 'audited' && p.status !== 'done') || null;
  }

  /**
   * The state the Achiever reasons over to choose its next move: the goal +
   * binary criterion, the phase list with status, each completed phase's task
   * results, and the Judger's latest minutes. Mirrors Workflows.decisionContext.
   */
  achieverContext(goalId: string): {
    record: GoalRecord;
    successCriteria: string;
    phases: { key: string; title: string; status: string; results: { title: string; status: string; result?: string }[] }[];
    currentPhaseKey: string | null;
    latestMinutes?: string;
    budget: { used: number; cap: number };
  } | null {
    const rec = this.load(goalId);
    if (!rec) return null;
    const phases = rec.phases.map(ph => ({
      key: ph.key,
      title: ph.title,
      status: ph.status,
      results: ph.taskIds.map(id => {
        const t = this.store.getTask(id);
        return { title: t?.title || id, status: t?.status || 'unknown', result: t?.result };
      })
    }));
    return {
      record: rec,
      successCriteria: rec.successCriteria,
      phases,
      currentPhaseKey: this.currentPhase(rec)?.key || null,
      latestMinutes: rec.minutes.length ? rec.minutes[rec.minutes.length - 1].artifact : undefined,
      budget: { used: this.executionTaskCount(goalId), cap: rec.stepBudget ?? 24 }
    };
  }

  /**
   * Apply the Achiever's structured decision (ADR-002). Exactly one move:
   *   evaluate → answer the binary gate; met:true ends the goal (→ achieved) and
   *             queues a closeout Judger report.
   *   plan     → append the next phase.
   *   emit     → generate a phase's worth of chained tasks (last flagged
   *             completesPhase), stamped with lineage.
   * Returns a small summary the dispatcher uses to manage idle/failure counters.
   */
  applyAchieverDecision(goalId: string, decision: AchieverDecision):
    { achieved?: boolean; planned?: boolean; emitted?: number; evaluated?: boolean; blocked?: boolean } {
    const rec = this.load(goalId);
    if (!rec || rec.status !== 'active') return {};
    const at = new Date().toISOString();

    if (decision.kind === 'block') {
      // The Achiever recognised a genuine obstacle it cannot clear itself and
      // named the recovery condition. Hold the goal honestly rather than spinning
      // turns until the failure ceiling kills it. This is the intended, graceful
      // stop — it counts as PROGRESS (the loop resolved), not a failure.
      this.block(goalId, decision.reason || 'Achiever declared the goal blocked', decision.unblockCriteria);
      return { blocked: true };
    }

    if (decision.kind === 'evaluate') {
      const met = decision.met === true;
      rec.history.push({ kind: 'evaluate', met, reason: decision.reason, at });
      if (met) {
        rec.status = 'achieved';
        this.clearBackoff(rec);
        rec.closedReason = decision.reason || 'success criteria met';
        rec.history.push({ kind: 'finish', reason: rec.closedReason, at });
        this.save(rec);
        console.log(`Goals: ${goalId} ACHIEVED — ${rec.closedReason}`);
        // Closeout audit — a final report over the whole goal.
        this.emitJudgerTask(goalId, 'closeout', { closeout: true });
        return { achieved: true, evaluated: true };
      }
      this.save(rec);
      return { evaluated: true };
    }

    if (decision.kind === 'plan') {
      const key = String(decision.phase?.key || '').trim().toLowerCase();
      const title = String(decision.phase?.title || '').trim();
      if (!key || !/^[a-z0-9][a-z0-9-]*$/.test(key)) { console.warn(`Goals: ${goalId} plan rejected — bad phase key "${key}"`); return {}; }
      if (rec.phases.some(p => p.key === key)) { console.warn(`Goals: ${goalId} plan rejected — phase "${key}" exists`); return {}; }
      rec.phases.push({ key, title: title || key, status: 'planned', taskIds: [] });
      rec.history.push({ kind: 'plan', phaseKey: key, reason: decision.reason, at });
      this.clearBackoff(rec);   // forward progress → breaker back to CLOSED
      this.save(rec);
      console.log(`Goals: ${goalId} planned phase "${key}"`);
      return { planned: true };
    }

    if (decision.kind === 'emit') {
      const phase = this.currentPhase(rec);
      if (!phase) { console.warn(`Goals: ${goalId} emit rejected — no workable phase (plan one first)`); return {}; }
      const specs = (decision.tasks || []).filter(t => t && t.title && String(t.title).trim());
      if (!specs.length) { console.warn(`Goals: ${goalId} emit rejected — no tasks`); return {}; }
      const created: string[] = [];
      let prevId: string | undefined;
      specs.forEach((spec, i) => {
        const isTerminal = i === specs.length - 1;
        const context: Record<string, any> = {
          goalId, phaseKey: phase.key, goalGenerated: true, role: 'goal-achiever'
        };
        const brain = spec.brain || rec.achieverBrainChain?.[0];
        if (brain) context.brain = brain;
        if (isTerminal) context.completesPhase = true;
        if (prevId) context.dependsOn = [prevId];   // chain in order → terminal runs last
        const task = this.store.createTask({
          title: String(spec.title).trim(),
          description: String(spec.description || spec.title).trim(),
          from: { platform: 'cowork', agent: 'goal-achiever' },
          to: {},
          priority: 'normal',
          context,
          tags: ['goal', goalId],
          ...(this.checkpointTime(spec.scheduledAt, goalId) ?? {})
        });
        created.push(task.id);
        prevId = task.id;
        rec.history.push({ kind: 'emit', phaseKey: phase.key, taskId: task.id, at });
      });
      phase.taskIds.push(...created);
      phase.status = 'active';
      this.clearBackoff(rec);   // forward progress → breaker back to CLOSED
      this.save(rec);
      console.log(`Goals: ${goalId} emitted ${created.length} task(s) for phase "${phase.key}"`);
      return { emitted: created.length };
    }

    return {};
  }

  // ── The Judger (event-triggered auditor) ────────────────────────────────────

  /**
   * Generate the Judger task for a completed phase. A normal inbox task with
   * role goal-judger, pinned to the goal's judger chain — so it rides the
   * verifier, artifacts dir, and fallback like any task. It is read-mostly
   * (ADR-005): its only side effects are a report + minutes artifact and the
   * phase→audited transition its completion drives.
   */
  emitJudgerTask(goalId: string, phaseKey: string, opts: { closeout?: boolean } = {}): Task | null {
    const rec = this.load(goalId);
    if (!rec) return null;
    const phase = rec.phases.find(p => p.key === phaseKey);
    const brain = rec.judgerBrainChain?.[0];
    const context: Record<string, any> = {
      goalId, phaseKey, goalGenerated: true, role: 'goal-judger'
    };
    if (brain) context.brain = brain;
    if (opts.closeout) context.closeout = true;

    const doneWork = phase
      ? phase.taskIds.map(id => this.store.getTask(id)).filter(Boolean).map(t => `- ${t!.title} [${t!.status}]`).join('\n')
      : rec.phases.flatMap(p => p.taskIds).map(id => this.store.getTask(id)).filter(Boolean).map(t => `- ${t!.title} [${t!.status}]`).join('\n');

    const description = [
      opts.closeout
        ? `You are the GOAL JUDGER writing the CLOSEOUT report for goal "${rec.title}".`
        : `You are the GOAL JUDGER auditing phase "${phase?.title || phaseKey}" of goal "${rec.title}".`,
      '',
      `Goal: ${rec.description || rec.title}`,
      `Success criteria (binary): ${rec.successCriteria}`,
      rec.reportBrief ? `Report focus: ${rec.reportBrief}` : '',
      '',
      'Work in scope:',
      doneWork || '(no completed tasks found)',
      '',
      'Produce TWO artifacts in your artifacts dir (relative paths):',
      `  1. report-${phaseKey}.md — a ${rec.reportBrief ? rec.reportBrief + ' style' : 'concise'} status report on what was achieved vs. the success criteria.`,
      `  2. minutes-${phaseKey}.md — meeting minutes of the Achiever↔Judger sync: what the phase accomplished, gaps, and the recommended next step for the Achiever.`,
      '',
      'You are read-mostly: do NOT create execution tasks. Report and recommend only.'
    ].filter(l => l !== '').join('\n');

    const task = this.store.createTask({
      title: opts.closeout ? `Goal closeout report — ${rec.title}` : `Judge phase "${phase?.title || phaseKey}" — ${rec.title}`,
      description,
      from: { platform: 'cowork', agent: 'goal-judger' },
      to: {},
      priority: 'normal',
      context,
      tags: ['goal', goalId, 'goal-judger']
    });
    if (phase) { phase.judgerTaskId = task.id; }
    rec.history.push({ kind: 'judge', phaseKey, taskId: task.id, at: new Date().toISOString() });
    this.save(rec);
    console.log(`Goals: ${goalId} → Judger task ${task.id} for phase "${phaseKey}"`);
    return task;
  }

  /**
   * The taskCompleted subscriber's core. Reacts to a goal-generated task
   * finishing — the two-hop, poll-free Achiever↔Judger cycle (§8.2):
   *   completesPhase execution task done  → phase `completing`, emit Judger.
   *   goal-judger task done               → record review, phase `audited`,
   *                                          minutes pointer; goal re-arms.
   * Ignores non-goal and non-terminal tasks. Idempotent per task.
   */
  onTaskCompleted(task: Task): void {
    const ctx = task.context || {};
    if (!ctx.goalGenerated || typeof ctx.goalId !== 'string') return;
    const rec = this.load(ctx.goalId);
    if (!rec) return;

    if (ctx.role === 'goal-judger') {
      const phaseKey = String(ctx.phaseKey || '');
      const phase = rec.phases.find(p => p.key === phaseKey);
      if (phase && phase.status !== 'audited') {
        phase.status = 'audited';
        phase.reportArtifact = `${task.id}/report-${phaseKey}.md`;
      }
      rec.minutes.push({ phaseKey, artifact: `${task.id}/minutes-${phaseKey}.md`, at: new Date().toISOString() });
      this.save(rec);
      console.log(`Goals: ${rec.goalId} phase "${phaseKey}" audited (task ${task.id})`);
      return;
    }

    if (ctx.completesPhase) {
      const phaseKey = String(ctx.phaseKey || '');
      const phase = rec.phases.find(p => p.key === phaseKey);
      if (phase && (phase.status === 'active' || phase.status === 'planned')) {
        phase.status = 'completing';
        this.save(rec);
        // Wake the Judger immediately — completing→judger-emitted is atomic so
        // `completing` is only ever seen by the self-heal after a dropped event.
        this.emitJudgerTask(rec.goalId, phaseKey);
      }
    }
  }
}
