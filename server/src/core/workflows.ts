import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import type {
  Config,
  WorkflowDef,
  WorkflowStep,
  WorkflowStepGate,
  WorkflowGateRecord,
  WorkflowGateRoundRecord,
  WorkflowRun,
  WorkflowRunRecord,
  WorkflowDecision,
  Task,
  TaskBrief
} from '../types.js';
import { isFailedTask, type Store } from './store.js';
import type { EventBus } from './events.js';
import { parseBrief } from './brief.js';
import { assertTier, brainFamily, reviewChain } from './tiers.js';
import { buildPanelReviewerPrompt, buildLeadJudgmentPrompt, parseLeadJudgment, effectivePanelSize, type PanelReview, type LeadJudgment } from './review-panel.js';
import { buildLesson, appendLesson, type LessonPanel } from './lessons.js';
import {
  buildVerifierPrompt,
  parseSpecVerdict,
  selectSpecJudges,
  extractEvidenceBlock,
  DEFAULT_SPEC_JUDGES,
  type VerifierArtifact,
  type ParsedSpecVerdict
} from './result-verifier.js';

/** Fill {{param}} placeholders from the run params (missing → left as-is). */
function interpolate(tpl: string, params: Record<string, string>): string {
  return String(tpl).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/**
 * Workflows — the declarative pipeline layer that sits on top of the dispatcher's
 * dependsOn DAG. A template (workflows/<id>.json) is validated on load and, on
 * demand, COMPILED into N inbox tasks whose context.dependsOn edges are wired to
 * the real task ids just created. No new execution engine: once expanded, the
 * existing dispatcher walks the DAG exactly as it does for hand-built tasks.
 *
 * Every task a run creates carries three context fields so the UI can group and
 * trace it (zero on-disk schema change — context is already free-form):
 *   workflowId    — which template
 *   workflowRunId — this expansion (one per run)
 *   stepKey       — which node of the template
 */
export class Workflows {
  private config: Config;
  private store: Store;
  private eventBus?: EventBus;

  constructor(config: Config, store: Store, eventBus?: EventBus) {
    this.config = config;
    this.store = store;
    const bus = eventBus || (store as any)?.eventBus as EventBus | undefined;
    if (bus && typeof bus.on === 'function') {
      this.eventBus = bus;
      bus.on('taskCompleted', (evt: any) => {
        try {
          if (evt?.payload?.task) this.onTaskCompleted(evt.payload.task);
        } catch (e) {
          console.error('Workflows: taskCompleted handler failed:', e);
        }
      });
    }
  }

  private dir(): string {
    return this.config.paths.workflows;
  }

  /** Where orchestrated-run state lives — a sibling of the templates dir so it
   *  needs no config change. DAG runs are reconstructed from tasks and write
   *  nothing here; only adaptive runs (goal + decision log) are persisted. */
  private runsDir(): string {
    return path.join(path.dirname(this.dir()), 'workflow-runs');
  }

  /** Read + parse + validate every template on disk. Invalid ones are skipped
   *  (with the reason) so one bad file can't take down the whole list. */
  list(): WorkflowDef[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    const out: WorkflowDef[] = [];
    for (const file of globSync('*.json', { cwd: dir })) {
      try {
        const def = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as WorkflowDef;
        if (!def.id) def.id = path.basename(file, '.json');
        const errors = this.validate(def);
        if (errors.length) { console.warn(`Workflows: skipping ${file} — ${errors.join('; ')}`); continue; }
        out.push(def);
      } catch (e: any) {
        console.warn(`Workflows: skipping ${file} — ${e.message}`);
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): WorkflowDef | null {
    return this.list().find(w => w.id === id) || null;
  }

  /**
   * Author a NEW workflow template to disk (workflows/<id>.json) at runtime, so
   * pipelines can be created from the dashboard / an agent / the workflow-builder
   * workflow — not only hand-committed. The id is sanitized into a safe filename
   * (kebab-case, no path traversal), the def is validated exactly as list() would,
   * and an existing template is NOT clobbered unless opts.overwrite. Returns the
   * stored definition so the caller can immediately run it.
   */
  create(def: WorkflowDef, opts: { overwrite?: boolean } = {}): WorkflowDef {
    if (!def || typeof def !== 'object') throw new Error('workflow definition (object) is required');
    const id = String(def.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error('id must be kebab-case: lowercase letters, digits and hyphens, starting alphanumeric');
    }
    const stored: WorkflowDef = { ...def, id };
    const errors = this.validate(stored);
    if (errors.length) throw new Error(errors.join('; '));
    const dir = this.dir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    const existed = fs.existsSync(file);
    if (existed && !opts.overwrite) throw new Error(`workflow "${id}" already exists — set overwrite to replace it`);
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));
    console.log(`Workflows: ${existed ? 'updated' : 'created'} template "${id}"`);
    return stored;
  }

  /**
   * The templates on disk that FAILED to load, with the reason — the mirror of
   * list(). Without this an author who drops malformed JSON just sees it vanish;
   * the dashboard renders these so the fix is one glance away.
   */
  listInvalid(): { file: string; id?: string; errors: string[] }[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    const out: { file: string; id?: string; errors: string[] }[] = [];
    for (const file of globSync('*.json', { cwd: dir })) {
      try {
        const def = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as WorkflowDef;
        if (!def.id) def.id = path.basename(file, '.json');
        const errors = this.validate(def);
        if (errors.length) out.push({ file, id: def.id, errors });
      } catch (e: any) {
        out.push({ file, errors: [`invalid JSON: ${e.message}`] });
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }

  /**
   * Structural validation. Returns a list of human-readable errors ([] = valid):
   * required fields, unique step keys, dependsOn references an existing key, and
   * — critically — the graph is acyclic (a cycle would deadlock depsSatisfied
   * forever, since a task can never reach `done` while it waits on itself).
   */
  validate(def: WorkflowDef): string[] {
    const errors: string[] = [];
    if (!def.id || typeof def.id !== 'string') errors.push('id (string) is required');
    if (!Array.isArray(def.steps) || def.steps.length === 0) { errors.push('steps (non-empty array) is required'); return errors; }
    const keys = new Set<string>();
    for (const s of def.steps) {
      if (!s.key || typeof s.key !== 'string') { errors.push('every step needs a string key'); continue; }
      if (keys.has(s.key)) errors.push(`duplicate step key "${s.key}"`);
      keys.add(s.key);
      errors.push(...parseBrief(s as Record<string, any>, `step "${s.key}" `).errors);
      try { assertTier(s.tier, `step "${s.key}" tier`); } catch (e: any) { errors.push(e.message); }
      if (s.gate !== undefined) {
        if (!s.gate || typeof s.gate !== 'object') {
          errors.push(`step "${s.key}" gate must be an object`);
        } else {
          if (!s.gate.reviewer || typeof s.gate.reviewer !== 'string' || !s.gate.reviewer.trim()) {
            errors.push(`step "${s.key}" gate.reviewer (non-empty string) is required`);
          }
          if (s.gate.maxRounds !== undefined && (!Number.isInteger(s.gate.maxRounds) || s.gate.maxRounds < 1)) {
            errors.push(`step "${s.key}" gate.maxRounds must be a positive integer`);
          }
          if (s.gate.escalateBrainAt !== undefined && (!Number.isInteger(s.gate.escalateBrainAt) || s.gate.escalateBrainAt < 1)) {
            errors.push(`step "${s.key}" gate.escalateBrainAt must be a positive integer`);
          }
          if (s.gate.panel !== undefined && (!Number.isInteger(s.gate.panel) || s.gate.panel < 1)) {
            errors.push(`step "${s.key}" gate.panel must be a positive integer`);
          }
        }
      }
    }
    for (const s of def.steps) {
      for (const d of s.dependsOn || []) {
        if (!keys.has(d)) errors.push(`step "${s.key}" dependsOn unknown step "${d}"`);
      }
    }
    if (!errors.length) {
      try { this.topoOrder(def.steps); } catch (e: any) { errors.push(e.message); }
    }
    return errors;
  }

  /** Kahn's algorithm → steps in an order where deps precede dependents. Throws
   *  on a cycle. Used both to validate and to create tasks bottom-up so a step's
   *  dependency task ids already exist when we wire its context.dependsOn. */
  private topoOrder(steps: WorkflowStep[]): WorkflowStep[] {
    const byKey = new Map(steps.map(s => [s.key, s]));
    const indeg = new Map(steps.map(s => [s.key, 0]));
    const dependents = new Map<string, string[]>(steps.map(s => [s.key, []]));
    for (const s of steps) {
      for (const d of s.dependsOn || []) {
        indeg.set(s.key, (indeg.get(s.key) || 0) + 1);
        dependents.get(d)!.push(s.key);
      }
    }
    const queue = steps.filter(s => (indeg.get(s.key) || 0) === 0).map(s => s.key);
    const order: WorkflowStep[] = [];
    while (queue.length) {
      const k = queue.shift()!;
      order.push(byKey.get(k)!);
      for (const dep of dependents.get(k)!) {
        indeg.set(dep, indeg.get(dep)! - 1);
        if (indeg.get(dep) === 0) queue.push(dep);
      }
    }
    if (order.length !== steps.length) {
      const stuck = steps.filter(s => !order.includes(s)).map(s => s.key);
      throw new Error(`workflow has a dependency cycle among: ${stuck.join(', ')}`);
    }
    return order;
  }

  /** Resolve a step into the task body that createTask expects (deps still as
   *  step keys — the caller swaps them for real ids). */
  private compileStep(def: WorkflowDef, s: WorkflowStep, params: Record<string, string>) {
    const title = interpolate(s.title || s.key, params);
    const description = interpolate(s.description || s.title || s.key, params);
    const gate: Required<WorkflowStepGate> | undefined = s.gate
      ? {
          reviewer: s.gate.reviewer.trim(),
          maxRounds: s.gate.maxRounds ?? 3,
          escalateBrainAt: s.gate.escalateBrainAt ?? 2,
          panel: s.gate.panel ?? 1
        }
      : undefined;
    return {
      title, description,
      agent: s.agent, division: s.division, brain: s.brain, tier: s.tier,
      priority: s.priority || 'normal',
      dependsOnKeys: s.dependsOn || [],
      gate,
      // Brief contract (P0-3), {{param}}-filled like the title/description.
      brief: interpolateBrief(parseBrief(s as Record<string, any>).brief, params)
    };
  }

  /**
   * Start a run. For a `dag` template this expands the whole graph into inbox
   * tasks up front (or, for dryRun, just the resolved plan). For an
   * `orchestrated` template it writes a run record and creates NOTHING — the
   * dispatcher's orchestrator loop decides the first step on its next tick.
   * Missing required params are rejected up front. runId ties the run together.
   */
  run(id: string, params: Record<string, string> = {}, opts: { dryRun?: boolean; runId?: string } = {}):
    { runId: string; workflowId: string; mode: 'dag' | 'orchestrated'; dryRun: boolean; steps: any[]; goal?: string; tasks?: Task[] } {
    const def = this.get(id);
    if (!def) throw new Error(`unknown workflow "${id}"`);
    const missing = (def.params || []).filter(p => !(p in params) || params[p] === '');
    if (missing.length) throw new Error(`missing required param(s): ${missing.join(', ')}`);

    if (def.mode === 'orchestrated') return this.runOrchestrated(def, params, opts);

    const order = this.topoOrder(def.steps);
    const runId = opts.runId || cryptoRandomId();

    // Dry run: show the resolved, ordered plan (deps stay as step keys) — no writes.
    if (opts.dryRun) {
      const steps = order.map(s => {
        const c = this.compileStep(def, s, params);
        return {
          key: s.key,
          title: c.title,
          description: c.description,
          agent: c.agent,
          division: c.division,
          brain: c.brain,
          tier: c.tier,
          dependsOn: c.dependsOnKeys,
          ...(c.gate ? { gate: c.gate } : {}),
          ...c.brief
        };
      });
      return { runId, workflowId: def.id, mode: 'dag', dryRun: true, steps };
    }

    // Real run: create bottom-up so each step's dependency task ids already exist.
    const keyToTaskId = new Map<string, string>();
    const tasks: Task[] = [];
    const gates: Record<string, WorkflowGateRecord> = {};
    for (const s of order) {
      const c = this.compileStep(def, s, params);
      const context: Record<string, any> = { workflowId: def.id, workflowRunId: runId, stepKey: s.key, ...c.brief };
      if (c.agent) context.agent = c.agent;
      if (c.division) context.division = c.division;
      if (c.brain) context.brain = c.brain;
      if (c.tier) context.tier = c.tier;
      if (c.gate) {
        context.gate = {
          reviewer: c.gate.reviewer,
          maxRounds: c.gate.maxRounds,
          escalateBrainAt: c.gate.escalateBrainAt,
          ...(c.gate.panel > 1 ? { panel: c.gate.panel } : {}),
          round: 1,
          status: 'pending',
          originalDescription: c.description,
          originalTier: c.tier
        };
      }
      const deps = c.dependsOnKeys.map(k => keyToTaskId.get(k)).filter(Boolean) as string[];
      if (deps.length) context.dependsOn = deps;
      const task = this.store.createTask({
        title: c.title,
        description: c.description,
        from: { platform: 'cowork', agent: 'workflow' },
        to: {},
        priority: c.priority as Task['priority'],
        context,
        tags: ['workflow', def.id]
      });
      keyToTaskId.set(s.key, task.id);
      tasks.push(task);
      if (c.gate) {
        gates[s.key] = {
          stepKey: s.key,
          taskId: task.id,
          reviewer: c.gate.reviewer,
          maxRounds: c.gate.maxRounds,
          escalateBrainAt: c.gate.escalateBrainAt,
          currentRound: 1,
          status: 'pending',
          rounds: []
        };
      }
    }
    if (Object.keys(gates).length > 0) {
      const now = new Date().toISOString();
      this.saveRecord({
        runId,
        workflowId: def.id,
        mode: 'dag',
        params,
        status: 'running',
        history: [],
        gates,
        rulings: [],
        createdAt: now,
        updatedAt: now
      });
    }
    console.log(`Workflows: expanded "${def.id}" → run ${runId} (${tasks.length} tasks)`);
    return { runId, workflowId: def.id, mode: 'dag', dryRun: false, steps: order.map(s => ({ key: s.key, ...(s.gate ? { gate: { reviewer: s.gate.reviewer, maxRounds: s.gate.maxRounds ?? 3, escalateBrainAt: s.gate.escalateBrainAt ?? 2, ...(s.gate.panel && s.gate.panel > 1 ? { panel: s.gate.panel } : {}) } } : {}) })), tasks };
  }

  // ── Orchestrated (adaptive) runs ──────────────────────────────────────────

  /** Start an adaptive run: write the run record (goal + empty decision log) and
   *  create no tasks. The dispatcher's orchestrator loop makes the first decision
   *  on its next tick. dryRun just echoes the candidate step library. */
  private runOrchestrated(def: WorkflowDef, params: Record<string, string>, opts: { dryRun?: boolean; runId?: string }):
    { runId: string; workflowId: string; mode: 'orchestrated'; dryRun: boolean; steps: any[]; goal?: string } {
    const runId = opts.runId || cryptoRandomId();
    const goal = def.goal ? interpolate(def.goal, params) : undefined;
    const steps = def.steps.map(s => ({ key: s.key, title: interpolate(s.title || s.key, params), description: interpolate(s.description || s.title || s.key, params), agent: s.agent, division: s.division, brain: s.brain }));
    if (opts.dryRun) return { runId, workflowId: def.id, mode: 'orchestrated', dryRun: true, steps, goal };

    const now = new Date().toISOString();
    const record: WorkflowRunRecord = { runId, workflowId: def.id, mode: 'orchestrated', goal, params, status: 'running', history: [], createdAt: now, updatedAt: now };
    this.saveRecord(record);
    console.log(`Workflows: started orchestrated run "${def.id}" → ${runId} (goal: ${goal || '—'})`);
    return { runId, workflowId: def.id, mode: 'orchestrated', dryRun: false, steps, goal };
  }

  private saveRecord(rec: WorkflowRunRecord): void {
    const dir = this.runsDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    rec.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${rec.runId}.json`), JSON.stringify(rec, null, 2));
  }

  loadRecord(runId: string): WorkflowRunRecord | null {
    const p = path.join(this.runsDir(), `${runId}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as WorkflowRunRecord; } catch { return null; }
  }

  listRecords(): WorkflowRunRecord[] {
    const dir = this.runsDir();
    if (!fs.existsSync(dir)) return [];
    const out: WorkflowRunRecord[] = [];
    for (const file of globSync('*.json', { cwd: dir })) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as WorkflowRunRecord); } catch { /* skip */ }
    }
    return out;
  }

  /**
   * Orchestrated runs that are waiting for the orchestrator to pick the next
   * step: status `running`, and NO task they created is still open (all are
   * done/rejected). An empty history means the very first decision is due.
   * These are what the dispatcher's driver acts on each tick.
   */
  runsAwaitingDecision(): WorkflowRunRecord[] {
    return this.listRecords().filter(rec => {
      if (rec.mode !== 'orchestrated' || rec.status !== 'running') return false;
      const openTaskIds = rec.history.map(h => h.taskId).filter(Boolean) as string[];
      return openTaskIds.every(id => {
        const t = this.store.getTask(id);
        if (!t) return true;
        if (t.status === 'rejected') return true;
        if (t.status !== 'done') return false;
        const gate = t.context?.gate as { status?: string } | undefined;
        if (gate && gate.status !== 'approved' && gate.status !== 'ruled') return false;
        return true;
      });
    });
  }

  /**
   * The state the orchestrator reasons over to choose the next step: the goal,
   * every completed step with its result, and the steps still available to run.
   * A step already dispatched (in history) is filtered out of `available` so the
   * orchestrator doesn't repeat itself (its work is instead shown in `completed`).
   */
  decisionContext(runId: string): { def: WorkflowDef; record: WorkflowRunRecord; goal?: string; completed: { key: string; title: string; status: string; result?: string }[]; available: { key: string; title: string; description: string }[] } | null {
    const record = this.loadRecord(runId);
    if (!record) return null;
    const def = this.get(record.workflowId);
    if (!def) return null;
    const usedKeys = new Set(record.history.map(h => h.stepKey).filter(Boolean) as string[]);
    const completed = (record.history.filter(h => h.stepKey && h.taskId) as Required<WorkflowDecision>[]).map(h => {
      const t = this.store.getTask(h.taskId);
      return { key: h.stepKey!, title: t?.title || h.stepKey!, status: t?.status || 'unknown', result: t?.result };
    });
    const available = def.steps.filter(s => !usedKeys.has(s.key)).map(s => ({
      key: s.key,
      title: interpolate(s.title || s.key, record.params),
      description: interpolate(s.description || s.title || s.key, record.params)
    }));
    return { def, record, goal: record.goal, completed, available };
  }

  /**
   * Apply the orchestrator's decision. `stepKey: null` → the run is complete.
   * Otherwise create that step's inbox task (wiring context.dependsOn to the
   * already-completed tasks of any dependsOn keys) and log the decision. Returns
   * the created task, or null when the run finished / the key was unknown.
   */
  applyDecision(runId: string, choice: { stepKey: string | null; reason?: string; status?: 'done' | 'failed' }): Task | null {
    const record = this.loadRecord(runId);
    if (!record || record.status !== 'running') return null;
    const def = this.get(record.workflowId);
    if (!def) return null;
    const at = new Date().toISOString();

    if (!choice.stepKey) {
      record.status = choice.status === 'failed' ? 'failed' : 'done';
      record.history.push({ stepKey: null, reason: choice.reason, decidedAt: at });
      this.saveRecord(record);
      console.log(`Workflows: orchestrated run ${runId} finished (${record.status})`);
      return null;
    }

    const step = def.steps.find(s => s.key === choice.stepKey);
    if (!step) { console.warn(`Workflows: run ${runId} decision names unknown step "${choice.stepKey}"`); return null; }

    const c = this.compileStep(def, step, record.params);
    const context: Record<string, any> = { workflowId: def.id, workflowRunId: runId, stepKey: step.key, orchestrated: true, ...c.brief };
    if (c.agent) context.agent = c.agent;
    if (c.division) context.division = c.division;
    if (c.brain) context.brain = c.brain;
    if (c.tier) context.tier = c.tier;
    if (c.gate) {
      context.gate = {
        reviewer: c.gate.reviewer,
        maxRounds: c.gate.maxRounds,
        escalateBrainAt: c.gate.escalateBrainAt,
        ...(c.gate.panel > 1 ? { panel: c.gate.panel } : {}),
        round: 1,
        status: 'pending',
        originalDescription: c.description,
        originalTier: c.tier
      };
    }
    // Wire deps to the tasks that already ran those steps (only completed ones).
    const doneByKey = new Map(record.history.filter(h => h.stepKey && h.taskId).map(h => [h.stepKey!, h.taskId!]));
    const deps = (step.dependsOn || []).map(k => doneByKey.get(k)).filter(Boolean) as string[];
    if (deps.length) context.dependsOn = deps;

    const task = this.store.createTask({
      title: c.title,
      description: c.description,
      from: { platform: 'cowork', agent: 'orchestrator' },
      to: {},
      priority: c.priority as Task['priority'],
      context,
      tags: ['workflow', def.id, 'orchestrated']
    });
    if (c.gate) {
      record.gates = record.gates || {};
      record.gates[step.key] = {
        stepKey: step.key,
        taskId: task.id,
        reviewer: c.gate.reviewer,
        maxRounds: c.gate.maxRounds,
        escalateBrainAt: c.gate.escalateBrainAt,
        currentRound: 1,
        status: 'pending',
        rounds: []
      };
    }
    record.history.push({ stepKey: step.key, reason: choice.reason, taskId: task.id, decidedAt: at });
    this.saveRecord(record);
    console.log(`Workflows: orchestrated run ${runId} → step "${step.key}" (task ${task.id})`);
    return task;
  }

  /** All runs currently on disk, newest first. Orchestrated runs come from their
   *  persisted records (goal + decision log); DAG runs are reconstructed from
   *  task context (plus any persisted gate record). */
  listRuns(): WorkflowRun[] {
    const records = new Map(this.listRecords().map(r => [r.runId, r]));
    const byRun = new Map<string, Task[]>();
    for (const t of this.store.listTasks()) {
      const rid = t.context?.workflowRunId;
      if (typeof rid === 'string') (byRun.get(rid) || byRun.set(rid, []).get(rid)!).push(t);
    }
    const runs: WorkflowRun[] = [];
    for (const [runId, rec] of records) {
      runs.push(this.runFromRecord(rec, byRun.get(runId) || []));
    }
    for (const [runId, tasks] of byRun) {
      if (records.has(runId)) continue;   // already emitted from its run record
      tasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      runs.push(this.runFromTasks(runId, tasks));
    }
    return runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getRun(runId: string): WorkflowRun | null {
    const tasks = this.store.listTasks().filter(t => t.context?.workflowRunId === runId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const rec = this.loadRecord(runId);
    if (rec) return this.runFromRecord(rec, tasks);
    return tasks.length ? this.runFromTasks(runId, tasks) : null;
  }

  deleteRun(runId: string): void {
    const p = path.join(this.runsDir(), `${runId}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const tasks = this.store.listTasks().filter(t => t.context?.workflowRunId === runId);
    for (const t of tasks) {
      this.store.deleteTask(t.id);
    }
    console.log(`Workflows: deleted run ${runId} (${tasks.length} tasks removed)`);
  }

  deleteAllRuns(): void {
    const dir = this.runsDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
      }
    }
    const tasks = this.store.listTasks().filter(t => typeof t.context?.workflowRunId === 'string');
    for (const t of tasks) {
      this.store.deleteTask(t.id);
    }
    console.log(`Workflows: deleted all runs (${tasks.length} tasks removed)`);
  }

  private deriveDagStatus(tasks: Task[], rec?: WorkflowRunRecord): WorkflowRun['status'] {
    if (rec?.status === 'wait-input' || tasks.some(t => t.status === 'wait-input')) return 'wait-input';
    if (rec?.status === 'failed' || tasks.some(t => t.status === 'rejected' || isFailedTask(t))) return 'failed';
    const gatesReady = !rec?.gates || Object.values(rec.gates).every(g => g.status === 'approved' || g.status === 'ruled');
    const allDone = tasks.length > 0 && tasks.every(t => t.status === 'done') && gatesReady;
    return allDone ? 'done' : 'running';
  }

  private runFromTasks(runId: string, tasks: Task[]): WorkflowRun {
    const status = this.deriveDagStatus(tasks);
    return {
      runId,
      workflowId: String(tasks[0]?.context?.workflowId || '?'),
      createdAt: tasks[0]?.createdAt || new Date().toISOString(),
      tasks,
      status,
      mode: 'dag'
    };
  }

  /** Build the UI run view for a persisted run record (orchestrated or gated DAG). */
  private runFromRecord(rec: WorkflowRunRecord, tasks: Task[]): WorkflowRun {
    tasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    if (rec.mode === 'dag') {
      const status = this.deriveDagStatus(tasks, rec);
      return {
        runId: rec.runId,
        workflowId: rec.workflowId,
        createdAt: rec.createdAt,
        tasks,
        status,
        mode: 'dag',
        ...(rec.gates ? { gates: rec.gates } : {}),
        ...(rec.rulings && rec.rulings.length ? { rulings: rec.rulings } : {})
      };
    }
    return {
      runId: rec.runId,
      workflowId: rec.workflowId,
      createdAt: rec.createdAt,
      tasks,
      status: rec.status,
      mode: 'orchestrated',
      goal: rec.goal,
      history: rec.history,
      ...(rec.gates ? { gates: rec.gates } : {}),
      ...(rec.rulings && rec.rulings.length ? { rulings: rec.rulings } : {})
    };
  }

  // ── Review→fix gate primitive (P1-2) ──────────────────────────────────────

  /**
   * Event-driven review→fix gate handler. Called whenever any inbox task finishes
   * (`taskCompleted` event from Store). Idempotent so duplicate deliveries or
   * direct calls from tests / Dispatcher are safe.
   *
   * Handles two task shapes:
   *  1. A gated workflow step (`task.context.gate` present, not a review task):
   *     spawns a review task assigned to `gate.reviewer` on the `review` tier
   *     (cross-family judge per P1-1) with a brief built from the step's
   *     `acceptance` + `result` + `artifacts` (and scoped to prior findings on
   *     round > 1).
   *  2. A gate review task (`task.context.gateReviewFor` present):
   *     parses the reviewer's output using P1-1's `parseSpecVerdict`.
   *     - `APPROVED` (or `UNVERIFIABLE` crash fail-open): marks the gate approved,
   *       records the round in `workflow-runs/<runId>.json`, unblocking dependents.
   *     - `CHANGES_REQUESTED` with `round < maxRounds`: increments round, attaches
   *       findings + scoped re-review instructions to the gated step, escalates the
   *       gated step to `tier: 'judgment'` when `nextRound >= escalateBrainAt`, and
   *       re-queues the gated step (`status = 'pending'`).
   *     - `CHANGES_REQUESTED` at cap (`round >= maxRounds`):
   *       - if any finding is marked `BLOCKER`, parks the gated step and run on
   *         `wait-input`;
   *       - otherwise records residual non-blocker findings as `RULING` lines on
   *         the task and run record (`gate.status = 'ruled'`) and lets the run
   *         continue.
   */
  onTaskCompleted(task: Task): void {
    if (!task || !task.context) return;
    if (typeof task.context.gateReviewFor === 'string') {
      this.handleGateReviewCompleted(task);
      return;
    }
    if (task.context.gate && typeof task.context.gate === 'object') {
      this.handleGatedStepCompleted(task);
    }
  }

  /** Collect artifacts for a completed gated step (from disk if available, else task.artifacts). */
  private collectStepArtifacts(stepTask: Task): VerifierArtifact[] {
    const seen = new Map<string, number>();
    const artRoot = this.config.paths?.artifacts;
    if (artRoot && stepTask.id) {
      const dir = path.join(artRoot, stepTask.id);
      try {
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            if (f === 'progress.log' || f === 'result.md') continue;
            const st = fs.statSync(path.join(dir, f));
            if (st.isFile()) seen.set(f, st.size);
          }
        }
      } catch { /* ignore */ }
    }
    for (const f of (stepTask as any).artifacts || []) {
      if (typeof f === 'string' && f !== 'progress.log' && f !== 'result.md' && !seen.has(f)) {
        seen.set(f, 0);
      }
    }
    return Array.from(seen.entries()).map(([name, size]) => ({ name, size }));
  }

  /** Ensure a `WorkflowRunRecord` exists for `runId` so gate rounds and verdicts are persisted in `workflow-runs/<runId>.json`. */
  private ensureRunRecord(stepTask: Task): WorkflowRunRecord {
    const runId = String(stepTask.context?.workflowRunId || `run-${stepTask.id.slice(0, 8)}`);
    const workflowId = String(stepTask.context?.workflowId || 'custom');
    const existing = this.loadRecord(runId);
    if (existing) {
      existing.gates = existing.gates || {};
      existing.rulings = existing.rulings || [];
      return existing;
    }
    const now = new Date().toISOString();
    const rec: WorkflowRunRecord = {
      runId,
      workflowId,
      mode: stepTask.context?.orchestrated ? 'orchestrated' : 'dag',
      params: {},
      status: 'running',
      history: [],
      gates: {},
      rulings: [],
      createdAt: stepTask.createdAt || now,
      updatedAt: now
    };
    return rec;
  }

  /** Resolve the cross-family judge brain and family for a completed gated step per P1-1. */
  private selectGateJudge(executorBrainId: string): { judgeFamily: string; judgeBrain?: string; judgeChain: string[] } {
    const orch = this.config.orchestration || ({} as Config['orchestration']);
    const brains = orch.brains || {};
    const execFam = brainFamily(brains[executorBrainId], executorBrainId);
    // P1-1 mapping: claude -> gemini, gemini -> claude, qwen/other -> claude
    const judgeFamily = execFam === 'claude' ? 'gemini' : 'claude';
    const configuredJudges = orch.verifier?.spec?.judges
      ? { ...DEFAULT_SPEC_JUDGES, ...orch.verifier.spec.judges }
      : DEFAULT_SPEC_JUDGES;
    const specChain = selectSpecJudges(executorBrainId, { judges: configuredJudges, brains });
    const tierRev = executorBrainId ? reviewChain(executorBrainId, orch.tiers, brains) : [];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const id of [...specChain, ...tierRev]) {
      if (id && !seen.has(id) && !brains[id]?.disabled) {
        seen.add(id);
        merged.push(id);
      }
    }
    return { judgeFamily, judgeBrain: merged[0], judgeChain: merged };
  }

  /** Build the prompt/description for a gate review task. */
  private buildGateReviewBrief(
    stepTask: Task,
    round: number,
    maxRounds: number,
    priorFindings: string[],
    artifacts: VerifierArtifact[],
    panel = false
  ): string {
    const acceptance = Array.isArray(stepTask.context?.acceptance)
      ? (stepTask.context!.acceptance as string[]).map(s => String(s || '').trim()).filter(Boolean)
      : [];
    const criteria = acceptance.length > 0
      ? acceptance
      : [`Deliverable satisfies step "${stepTask.title}" without blockers`];
    const resultText = stepTask.result || '';
    const evidenceBlock = extractEvidenceBlock(resultText);

    const basePrompt = buildVerifierPrompt(
      {
        title: stepTask.title,
        description: String(stepTask.context?.gate?.originalDescription || stepTask.description || ''),
        acceptance: criteria,
      },
      resultText,
      { acceptance: criteria, artifacts, evidence: evidenceBlock }
    );

    const lines: string[] = [
      `# Workflow Review Gate — Round ${round}/${maxRounds} for step "${stepTask.context?.stepKey || stepTask.title}"`,
      ``
    ];
    if (round > 1 && priorFindings.length > 0) {
      lines.push(
        `## Scoped Re-Review (Round ${round} of ${maxRounds})`,
        `Previous review round (${round - 1}) returned \`CHANGES_REQUESTED\` with the following findings:`,
        ...priorFindings.map((f, i) => `${i + 1}. ${f}`),
        ``,
        `Verify specifically whether each prior finding above has been resolved in the updated result and artifacts, and check that no new regressions or blockers were introduced.`,
        ``
      );
    }
    lines.push(
      `## Severity Tagging for Findings`,
      `If you return \`"verdict": "CHANGES_REQUESTED"\`, prefix any critical, ship-stopping criterion reason with \`BLOCKER:\` (for example: \`"reason": "BLOCKER: missing migration breaks startup"\`). Non-blocker findings should state the concrete fix without the \`BLOCKER:\` prefix.`,
      ``,
      panel ? buildPanelReviewerPrompt(basePrompt) : basePrompt
    );
    return lines.join('\n');
  }

  private handleGatedStepCompleted(stepTask: Task): void {
    const fresh = this.store.getTask(stepTask.id) || stepTask;
    if (fresh.status !== 'done' || isFailedTask(fresh)) return;
    const gateCtx = fresh.context?.gate as Record<string, any> | undefined;
    if (!gateCtx || typeof gateCtx !== 'object') return;
    // Idempotency: only spawn a review task when the gate is waiting to review this round.
    if (gateCtx.status === 'reviewing' || gateCtx.status === 'approved' || gateCtx.status === 'ruled' || gateCtx.status === 'wait-input') {
      return;
    }

    const stepKey = String(fresh.context?.stepKey || fresh.title || fresh.id);
    const runId = String(fresh.context?.workflowRunId || `run-${fresh.id.slice(0, 8)}`);
    const workflowId = String(fresh.context?.workflowId || 'custom');
    const reviewer = String(gateCtx.reviewer || 'code-reviewer').trim();
    const maxRounds = Number(gateCtx.maxRounds) || 3;
    const escalateBrainAt = Number(gateCtx.escalateBrainAt) || 2;
    const round = Number(gateCtx.round) || 1;
    const priorFindings = Array.isArray(fresh.context?.gateFindings) ? (fresh.context!.gateFindings as string[]) : [];
    const executorBrainId = String(fresh.context?.ranBrain || fresh.context?.brain || '');
    // PS-2: multi-family panel when the step asks for one and the flag allows it.
    const panelSize = effectivePanelSize(gateCtx.panel, this.config.orchestration?.verifier?.panel);
    if (panelSize >= 2) {
      const judges = this.selectPanelJudges(executorBrainId, panelSize);
      if (judges.length >= 2) {
        this.spawnPanelReviews(fresh, gateCtx, judges, { stepKey, runId, workflowId, reviewer, maxRounds, escalateBrainAt, round, priorFindings, executorBrainId });
        return;
      }
      console.log(`Workflows: gate panel for step "${stepKey}" found ${judges.length} family(ies) — falling back to a single reviewer`);
    }
    const { judgeFamily, judgeBrain } = this.selectGateJudge(executorBrainId);
    const artifacts = this.collectStepArtifacts(fresh);
    const reviewDescription = this.buildGateReviewBrief(fresh, round, maxRounds, priorFindings, artifacts);

    const reviewContext: Record<string, any> = {
      workflowId,
      workflowRunId: runId,
      stepKey: `${stepKey}:review:${round}`,
      gateReviewFor: fresh.id,
      gateStepKey: stepKey,
      gateRound: round,
      gateMaxRounds: maxRounds,
      agent: reviewer,
      tier: 'review',
      ...(executorBrainId ? { reviewOf: executorBrainId } : {}),
      judgeFamily,
      ...(judgeBrain ? { judgeBrain } : {}),
      dependsOn: [fresh.id]
    };

    const reviewTask = this.store.createTask({
      title: `Review (${round}/${maxRounds}): ${fresh.title}`,
      description: reviewDescription,
      from: { platform: 'cowork', agent: 'workflow-gate' },
      to: {},
      priority: fresh.priority || 'normal',
      context: reviewContext,
      tags: ['workflow', workflowId, 'gate-review']
    });

    fresh.context = {
      ...(fresh.context || {}),
      gate: {
        ...gateCtx,
        reviewer,
        maxRounds,
        escalateBrainAt,
        round,
        status: 'reviewing',
        activeReviewTaskId: reviewTask.id,
        judgeFamily,
        ...(judgeBrain ? { judgeBrain } : {})
      }
    };
    this.store.saveTask(fresh);

    const rec = this.ensureRunRecord(fresh);
    const gateRec: WorkflowGateRecord = rec.gates![stepKey] || {
      stepKey,
      taskId: fresh.id,
      reviewer,
      maxRounds,
      escalateBrainAt,
      currentRound: round,
      status: 'reviewing',
      rounds: []
    };
    gateRec.taskId = fresh.id;
    gateRec.currentRound = round;
    gateRec.status = 'reviewing';
    rec.gates![stepKey] = gateRec;
    this.saveRecord(rec);
    console.log(`Workflows: gate review spawned for step "${stepKey}" round ${round}/${maxRounds} → task ${reviewTask.id} (reviewer=${reviewer}, judgeFamily=${judgeFamily})`);
  }

  // ── Multi-family review panel (PS-2) ──────────────────────────────────────

  /** One judge per distinct family (none from the executor's), configured judge chains first, then the tiers. */
  private selectPanelJudges(executorBrainId: string, size: number): string[] {
    const orch = this.config.orchestration || ({} as Config['orchestration']);
    const judges = orch.verifier?.spec?.judges
      ? { ...DEFAULT_SPEC_JUDGES, ...orch.verifier.spec.judges }
      : DEFAULT_SPEC_JUDGES;
    const pool = [...(orch.tiers?.judgment || []), ...(orch.tiers?.standard || []), ...(orch.tiers?.mechanical || [])];
    return selectSpecJudges(executorBrainId, { judges, brains: orch.brains || {}, panel: size, panelPool: pool });
  }

  /** Spawn one pinned review task per panel judge for this round. */
  private spawnPanelReviews(
    fresh: Task,
    gateCtx: Record<string, any>,
    judges: string[],
    m: { stepKey: string; runId: string; workflowId: string; reviewer: string; maxRounds: number; escalateBrainAt: number; round: number; priorFindings: string[]; executorBrainId: string }
  ): void {
    const brains = this.config.orchestration?.brains || {};
    const artifacts = this.collectStepArtifacts(fresh);
    const description = this.buildGateReviewBrief(fresh, m.round, m.maxRounds, m.priorFindings, artifacts, true);
    const members: Array<{ taskId: string; brain: string; family: string }> = [];
    for (const brain of judges) {
      const family = brainFamily(brains[brain], brain);
      const t = this.store.createTask({
        title: `Review (${m.round}/${m.maxRounds}) [panel: ${family}]: ${fresh.title}`,
        description,
        from: { platform: 'cowork', agent: 'workflow-gate' },
        to: {},
        priority: fresh.priority || 'normal',
        context: {
          workflowId: m.workflowId,
          workflowRunId: m.runId,
          stepKey: `${m.stepKey}:review:${m.round}:${family}`,
          gateReviewFor: fresh.id,
          gateStepKey: m.stepKey,
          gateRound: m.round,
          gateMaxRounds: m.maxRounds,
          gatePanelRole: 'reviewer',
          agent: m.reviewer,
          tier: 'review',
          ...(m.executorBrainId ? { reviewOf: m.executorBrainId } : {}),
          judgeFamily: family,
          judgeBrain: brain,
          brain,
          dependsOn: [fresh.id]
        },
        tags: ['workflow', m.workflowId, 'gate-review', 'gate-panel']
      });
      members.push({ taskId: t.id, brain, family });
    }
    const judgeFamily = members.map(x => x.family).join('+');
    const nextGate: Record<string, any> = {
      ...gateCtx,
      reviewer: m.reviewer,
      maxRounds: m.maxRounds,
      escalateBrainAt: m.escalateBrainAt,
      round: m.round,
      status: 'reviewing',
      panelPhase: 'reviewers',
      panelMembers: members,
      panelReviews: {},
      judgeFamily
    };
    delete nextGate.activeReviewTaskId;
    fresh.context = { ...(fresh.context || {}), gate: nextGate };
    this.store.saveTask(fresh);

    const rec = this.ensureRunRecord(fresh);
    const gateRec: WorkflowGateRecord = rec.gates![m.stepKey] || {
      stepKey: m.stepKey, taskId: fresh.id, reviewer: m.reviewer, maxRounds: m.maxRounds,
      escalateBrainAt: m.escalateBrainAt, currentRound: m.round, status: 'reviewing', rounds: []
    };
    gateRec.taskId = fresh.id;
    gateRec.currentRound = m.round;
    gateRec.status = 'reviewing';
    rec.gates![m.stepKey] = gateRec;
    this.saveRecord(rec);
    console.log(`Workflows: gate panel spawned for step "${m.stepKey}" round ${m.round}/${m.maxRounds} → ${members.map(x => `${x.family}:${x.taskId.slice(0, 8)}`).join(', ')}`);
  }

  private stepAcceptance(stepTask: Task): string[] {
    return Array.isArray(stepTask.context?.acceptance)
      ? (stepTask.context!.acceptance as string[]).map(s => String(s || '').trim()).filter(Boolean)
      : [];
  }

  /** Collect one panel reviewer's reply; once all are in, approve directly or spawn the lead. */
  private handlePanelReviewerCompleted(review: Task, stepTask: Task, gateCtx: Record<string, any>): void {
    const members: Array<{ taskId: string; brain: string; family: string }> = Array.isArray(gateCtx.panelMembers) ? gateCtx.panelMembers : [];
    if (gateCtx.panelPhase !== 'reviewers' || !members.some(x => x.taskId === review.id)) return;
    const reviews: Record<string, { failed: boolean; verdict: string; text: string }> = { ...(gateCtx.panelReviews || {}) };
    if (reviews[review.id]) return;

    const acceptance = this.stepAcceptance(stepTask);
    const failed = isFailedTask(review);
    const parsed = failed ? null : parseSpecVerdict(review.result || '', acceptance);
    reviews[review.id] = {
      failed: failed || !!parsed?.crashed,
      verdict: !parsed || parsed.crashed ? 'UNVERIFIABLE' : parsed.verdict,
      text: (review.result || '').slice(0, 8000)
    };
    let ctx: Record<string, any> = { ...gateCtx, panelReviews: reviews };
    stepTask.context = { ...(stepTask.context || {}), gate: ctx };
    this.store.saveTask(stepTask);
    if (members.some(x => !reviews[x.taskId])) return; // wait for the rest of the panel

    const round = Number(gateCtx.round) || 1;
    const maxRounds = Number(gateCtx.maxRounds) || 3;
    const stepKey = String(stepTask.context?.stepKey || stepTask.title || stepTask.id);
    const reviewers = members.map(x => ({ ...x, verdict: reviews[x.taskId].verdict }));
    const usable = members.filter(x => !reviews[x.taskId].failed);
    const changes = usable.filter(x => reviews[x.taskId].verdict === 'CHANGES_REQUESTED');

    if (changes.length === 0) {
      // Nothing to judge: every working reviewer approved (fail-open when all crashed).
      const allCrashed = usable.length === 0;
      const record = { reviewers, leadParsed: true, buckets: { actOn: 0, consider: 0, noted: 0, dismissed: 0 }, findings: [] };
      const parsedOk: ParsedSpecVerdict = {
        ok: true,
        verdict: allCrashed ? 'UNVERIFIABLE' : 'APPROVED',
        criteria: acceptance.map(c => ({ criterion: c, status: allCrashed ? 'UNVERIFIABLE' : 'PASS', reason: allCrashed ? 'every panel reviewer failed (fail-open)' : 'no panel reviewer requested changes' })),
        failedCriteria: [],
        summary: allCrashed ? 'UNVERIFIABLE — every panel reviewer failed (fail-open)' : `APPROVED by panel (${usable.map(x => x.family).join(', ')})`,
        ...(allCrashed ? { crashed: true } : {})
      };
      this.recordPanelLesson(stepTask, gateCtx, round, record, parsedOk.verdict);
      this.decideGate(stepTask, review, ctx, parsedOk, '', { findings: [], blockers: [], record });
      return;
    }

    const lead = this.store.createTask({
      title: `Lead judgment (${round}/${maxRounds}): ${stepTask.title}`,
      description: buildLeadJudgmentPrompt({
        title: stepTask.title,
        description: String(gateCtx.originalDescription || stepTask.description || ''),
        acceptance,
        reviews: members.map(x => ({ family: x.family, brain: x.brain, text: reviews[x.taskId].text, failed: reviews[x.taskId].failed })),
        priorFindings: Array.isArray(stepTask.context?.gateFindings) ? stepTask.context!.gateFindings as string[] : []
      }),
      from: { platform: 'cowork', agent: 'workflow-gate' },
      to: {},
      priority: stepTask.priority || 'normal',
      context: {
        workflowId: String(stepTask.context?.workflowId || 'custom'),
        workflowRunId: String(stepTask.context?.workflowRunId || `run-${stepTask.id.slice(0, 8)}`),
        stepKey: `${stepKey}:lead:${round}`,
        gateReviewFor: stepTask.id,
        gateStepKey: stepKey,
        gateRound: round,
        gateMaxRounds: maxRounds,
        gatePanelRole: 'lead',
        agent: String(gateCtx.reviewer || 'engineering-code-reviewer'),
        tier: 'judgment',
        dependsOn: [stepTask.id]
      },
      tags: ['workflow', String(stepTask.context?.workflowId || 'custom'), 'gate-review', 'gate-panel']
    });
    ctx = { ...ctx, panelPhase: 'lead', activeReviewTaskId: lead.id };
    stepTask.context = { ...(stepTask.context || {}), gate: ctx };
    this.store.saveTask(stepTask);
    console.log(`Workflows: gate panel for step "${stepKey}" round ${round}: ${changes.length}/${members.length} reviewer(s) requested changes → lead judgment ${lead.id}`);
  }

  /** Turn the lead's buckets into the gate decision (only Act on requests changes). */
  private handlePanelLeadCompleted(lead: Task, stepTask: Task, gateCtx: Record<string, any>): void {
    const members: Array<{ taskId: string; brain: string; family: string }> = Array.isArray(gateCtx.panelMembers) ? gateCtx.panelMembers : [];
    const reviews: Record<string, { failed: boolean; verdict: string; text: string }> = gateCtx.panelReviews || {};
    const acceptance = this.stepAcceptance(stepTask);
    const round = Number(lead.context?.gateRound || gateCtx.round) || 1;
    const lj: LeadJudgment | null = isFailedTask(lead) ? null : parseLeadJudgment(lead.result || '');
    const record: NonNullable<WorkflowGateRoundRecord['panel']> = {
      reviewers: members.map(x => ({ ...x, verdict: reviews[x.taskId]?.verdict })),
      leadTaskId: lead.id,
      leadParsed: !!lj?.parsed,
      ...(lj?.parsed ? { buckets: lj.counts, findings: lj.findings.slice(0, 40) } : {})
    };

    let parsed: ParsedSpecVerdict;
    let findings: string[] = [];
    let blockers: string[] = [];
    if (!lj || !lj.parsed) {
      // Lead unavailable: keep today's single-judge strictness (union of reviewer findings).
      for (const x of members) {
        const r = reviews[x.taskId];
        if (!r || r.failed || r.verdict !== 'CHANGES_REQUESTED') continue;
        const fb = this.extractGateFindings(parseSpecVerdict(r.text, acceptance), r.text);
        findings.push(...fb.findings.map(f => `[${x.family}] ${f}`));
        blockers.push(...fb.blockers.map(f => `[${x.family}] ${f}`));
      }
      parsed = {
        ok: false, verdict: 'CHANGES_REQUESTED', criteria: [], failedCriteria: findings,
        summary: `lead judgment unavailable — strict union of panel findings: ${findings.join('; ').slice(0, 400)}`
      };
    } else if (lj.verdict === 'APPROVED') {
      parsed = {
        ok: true, verdict: 'APPROVED',
        criteria: acceptance.map(c => ({ criterion: c, status: 'PASS', reason: 'panel lead: no Act-on findings' })),
        failedCriteria: [],
        summary: `APPROVED by lead — act on 0, consider ${lj.counts.consider}, noted ${lj.counts.noted}, dismissed ${lj.counts.dismissed}`
      };
    } else {
      findings = lj.actOn;
      blockers = lj.blockers;
      parsed = {
        ok: false, verdict: 'CHANGES_REQUESTED',
        criteria: lj.actOn.map(f => ({ criterion: 'Act on', status: 'FAIL', reason: f })),
        failedCriteria: lj.actOn,
        summary: `CHANGES_REQUESTED by lead — act on ${lj.counts.actOn} (${lj.blockers.length} blocker), consider ${lj.counts.consider}, noted ${lj.counts.noted}, dismissed ${lj.counts.dismissed}`
      };
    }
    this.recordPanelLesson(stepTask, gateCtx, round, record, parsed.verdict);
    this.decideGate(stepTask, lead, gateCtx, parsed, lead.result || '', { findings, blockers, record });
  }

  /** PS-2 metric: one `gate-panel` lesson per panel round (rounds/gate, bucket counts). */
  private recordPanelLesson(stepTask: Task, gateCtx: Record<string, any>, round: number, record: NonNullable<WorkflowGateRoundRecord['panel']>, verdict: string): void {
    const decisions = this.config.paths?.decisions;
    if (!decisions) return;
    const buckets = record.buckets || { actOn: 0, consider: 0, noted: 0, dismissed: 0 };
    const panel: LessonPanel = {
      gate: stepTask.id,
      round,
      families: record.reviewers.map(r => r.family),
      buckets,
      verdict,
      leadParsed: record.leadParsed !== false
    };
    appendLesson(decisions, buildLesson({
      kind: 'gate-panel',
      task: stepTask.id,
      title: stepTask.title,
      agent: String(gateCtx.reviewer || ''),
      brain: String(stepTask.context?.ranBrain || stepTask.context?.brain || ''),
      attempt: round,
      reason: `${verdict} round ${round} [${panel.families.join('+')}]: act_on=${buckets.actOn} consider=${buckets.consider} noted=${buckets.noted} dismissed=${buckets.dismissed}${panel.leadParsed ? '' : ' (lead unavailable)'}`,
      panel
    }));
  }

  /** Inspect a `CHANGES_REQUESTED` verdict and raw reviewer text for any `BLOCKER` finding. */
  private extractGateFindings(verdict: ParsedSpecVerdict, rawText: string): { findings: string[]; blockers: string[] } {
    const findings: string[] = [];
    const blockers: string[] = [];
    const isBlockerReason = (text: string): boolean => {
      if (!text) return false;
      // Ignore explicit negations like "no blockers", "0 blockers", "non-blocker", "without blockers", "blocker: none".
      const cleaned = text
        .replace(/\bno\s+blockers?\b/gi, '')
        .replace(/\b0\s+blockers?\b/gi, '')
        .replace(/\bnon[-\s]?blockers?\b/gi, '')
        .replace(/\bwithout\s+(?:any\s+)?blockers?\b/gi, '')
        .replace(/\bblockers?\s*:\s*(?:none|0|n\/a|nil)\b/gi, '');
      return /\bBLOCKERS?\b/i.test(cleaned);
    };

    for (const c of verdict.criteria) {
      if (c.status === 'PASS') continue;
      const formatted = c.reason ? `${c.criterion} — ${c.reason}` : c.criterion;
      findings.push(formatted);
      // Inspect the reviewer's reason (not the static acceptance criterion text, which may mention the word "blocker").
      if (isBlockerReason(c.reason || '')) {
        blockers.push(formatted);
      }
    }

    // Also scan raw reviewer lines for explicit `BLOCKER:` or `[BLOCKER]` markers outside criteria reasons.
    for (const rawLine of (rawText || '').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^(?:[-*•]\s*)?(?:\[BLOCKER\]|BLOCKER\s*:)/i.test(line) && isBlockerReason(line)) {
        if (!blockers.includes(line)) blockers.push(line);
        if (!findings.includes(line)) findings.push(line);
      }
    }

    if (findings.length === 0) {
      const fallback = (rawText || '').trim().slice(0, 300) || 'Reviewer requested changes without structured criteria.';
      findings.push(fallback);
      if (isBlockerReason(fallback)) blockers.push(fallback);
    }

    return { findings, blockers };
  }

  /** Pick the first enabled brain in the `judgment` tier for round escalation. */
  private pickJudgmentBrain(): string | undefined {
    const orch = this.config.orchestration;
    const brains = orch?.brains || {};
    for (const id of orch?.tiers?.judgment || []) {
      if (id && !brains[id]?.disabled) return id;
    }
    return undefined;
  }

  private handleGateReviewCompleted(reviewTask: Task): void {
    const freshReview = this.store.getTask(reviewTask.id) || reviewTask;
    if (freshReview.status !== 'done') return;

    const gatedTaskId = String(freshReview.context?.gateReviewFor || '');
    if (!gatedTaskId) return;
    const stepTask = this.store.getTask(gatedTaskId);
    if (!stepTask) return;

    const gateCtx = (stepTask.context?.gate || {}) as Record<string, any>;
    // PS-2: a panel reviewer only reports into the panel; the lead decides.
    if (freshReview.context?.gatePanelRole === 'reviewer') {
      this.handlePanelReviewerCompleted(freshReview, stepTask, gateCtx);
      return;
    }
    // Idempotency: ignore if this review task was already processed.
    if (gateCtx.lastProcessedReviewTaskId === freshReview.id) return;
    if (gateCtx.activeReviewTaskId && gateCtx.activeReviewTaskId !== freshReview.id) return;
    if (freshReview.context?.gatePanelRole === 'lead') {
      this.handlePanelLeadCompleted(freshReview, stepTask, gateCtx);
      return;
    }

    const rawText = freshReview.result || '';
    const reviewerFailed = isFailedTask(freshReview);
    const acceptance = Array.isArray(stepTask.context?.acceptance)
      ? (stepTask.context!.acceptance as string[]).map(s => String(s || '').trim()).filter(Boolean)
      : [];
    const parsed: ParsedSpecVerdict = reviewerFailed
      ? {
          verdict: 'UNVERIFIABLE',
          ok: true,
          criteria: acceptance.map(c => ({ criterion: c, status: 'UNVERIFIABLE', reason: 'review task failed or exhausted its brain chain (fail-open)' })),
          failedCriteria: [],
          summary: 'UNVERIFIABLE — review task failed or exhausted its brain chain (fail-open)',
          crashed: true,
        }
      : parseSpecVerdict(rawText, acceptance);
    this.decideGate(stepTask, freshReview, gateCtx, parsed, rawText);
  }

  /**
   * Apply a review verdict to the gated step: approve, re-queue a fix round,
   * park on a BLOCKER at the cap, or record residual RULINGs. `panelOutcome`
   * (PS-2) supplies the lead's Act-on findings/blockers instead of
   * re-deriving them from the reviewer text.
   */
  private decideGate(
    stepTask: Task,
    freshReview: Task,
    gateCtx: Record<string, any>,
    parsed: ParsedSpecVerdict,
    rawText: string,
    panelOutcome?: { findings: string[]; blockers: string[]; record: NonNullable<WorkflowGateRoundRecord['panel']> }
  ): void {
    const stepKey = String(stepTask.context?.stepKey || freshReview.context?.gateStepKey || stepTask.title || stepTask.id);
    const round = Number(freshReview.context?.gateRound || gateCtx.round) || 1;
    const maxRounds = Number(gateCtx.maxRounds || freshReview.context?.gateMaxRounds) || 3;
    const escalateBrainAt = Number(gateCtx.escalateBrainAt) || 2;
    const reviewer = String(gateCtx.reviewer || freshReview.context?.agent || 'code-reviewer');
    const executorBrain = String(stepTask.context?.ranBrain || stepTask.context?.brain || '');
    const reviewerBrain = panelOutcome
      ? panelOutcome.record.reviewers.map(r => r.brain).join('+')
      : String(freshReview.context?.ranBrain || freshReview.context?.brain || freshReview.context?.judgeBrain || '');
    const judgeFamily = panelOutcome
      ? panelOutcome.record.reviewers.map(r => r.family).join('+')
      : String(freshReview.context?.judgeFamily || gateCtx.judgeFamily || '');
    const panelField = panelOutcome ? { panel: panelOutcome.record } : {};

    const rec = this.ensureRunRecord(stepTask);
    const gateRec: WorkflowGateRecord = rec.gates![stepKey] || {
      stepKey,
      taskId: stepTask.id,
      reviewer,
      maxRounds,
      escalateBrainAt,
      currentRound: round,
      status: 'reviewing',
      rounds: []
    };
    // Guard against duplicate round entries in the persisted record.
    if (gateRec.rounds.some(r => r.reviewTaskId === freshReview.id)) return;

    const now = new Date().toISOString();

    // Case 1: APPROVED (or UNVERIFIABLE fail-open on reviewer crash)
    if (parsed.ok) {
      const roundRec: WorkflowGateRoundRecord = {
        round,
        taskId: stepTask.id,
        reviewTaskId: freshReview.id,
        reviewer,
        ...(reviewerBrain ? { reviewerBrain } : {}),
        ...(reviewerBrain ? { judgeBrain: reviewerBrain } : {}),
        ...(judgeFamily ? { judgeFamily } : {}),
        ...(executorBrain ? { executorBrain } : {}),
        verdict: parsed.verdict,
        criteria: parsed.criteria,
        failedCriteria: [],
        findings: [],
        summary: parsed.summary,
        escalated: !!stepTask.context?.escalated,
        action: 'approved',
        ...panelField,
        at: now
      };
      gateRec.rounds.push(roundRec);
      gateRec.currentRound = round;
      gateRec.status = 'approved';
      rec.gates![stepKey] = gateRec;

      stepTask.context = {
        ...(stepTask.context || {}),
        specVerdict: {
          verdict: parsed.verdict,
          judgeBrain: reviewerBrain || reviewer,
          judgeFamily,
          executorBrain,
          criteria: parsed.criteria,
          failedCriteria: [],
          at: now
        },
        gate: {
          ...gateCtx,
          round,
          status: 'approved',
          lastProcessedReviewTaskId: freshReview.id,
          lastVerdict: parsed.verdict,
          decidedAt: now
        }
      };
      this.store.saveTask(stepTask);
      this.saveRecord(rec);
      console.log(`Workflows: gate APPROVED for step "${stepKey}" in round ${round}/${maxRounds}`);
      return;
    }

    // CHANGES_REQUESTED
    const { findings, blockers } = panelOutcome
      ? { findings: panelOutcome.findings, blockers: panelOutcome.blockers }
      : this.extractGateFindings(parsed, rawText);

    // Case 2: Under the round cap (`round < maxRounds`) → re-queue gated step for a fix round.
    if (round < maxRounds) {
      const nextRound = round + 1;
      const shouldEscalate = nextRound >= escalateBrainAt;
      const escalatedBrain = shouldEscalate ? this.pickJudgmentBrain() : undefined;

      const roundRec: WorkflowGateRoundRecord = {
        round,
        taskId: stepTask.id,
        reviewTaskId: freshReview.id,
        reviewer,
        ...(reviewerBrain ? { reviewerBrain } : {}),
        ...(reviewerBrain ? { judgeBrain: reviewerBrain } : {}),
        ...(judgeFamily ? { judgeFamily } : {}),
        ...(executorBrain ? { executorBrain } : {}),
        verdict: 'CHANGES_REQUESTED',
        criteria: parsed.criteria,
        failedCriteria: parsed.failedCriteria,
        findings,
        summary: parsed.summary,
        ...(blockers.length ? { blockerFindings: blockers } : {}),
        escalated: shouldEscalate,
        action: 'requeue',
        ...panelField,
        at: now
      };
      gateRec.rounds.push(roundRec);
      gateRec.currentRound = nextRound;
      gateRec.status = 'fixing';
      if (shouldEscalate && !gateRec.escalatedAtRound) {
        gateRec.escalatedAtRound = nextRound;
        if (escalatedBrain) gateRec.escalatedBrain = escalatedBrain;
      }
      rec.gates![stepKey] = gateRec;

      const baseDescription = String(gateCtx.originalDescription || stepTask.description || '');
      const fixSection = [
        ``,
        `# Review Gate Findings (Round ${round}/${maxRounds} → Fix Round ${nextRound}/${maxRounds})`,
        `The reviewer (${reviewer}) returned \`CHANGES_REQUESTED\`. Address every finding below and update the artifacts/deliverable so the scoped re-review passes:`,
        ...findings.map((f, i) => `${i + 1}. ${f}`),
        ``,
        `Focus on fixing the findings above without breaking already-passing acceptance criteria.`
      ].join('\n');

      stepTask.description = `${baseDescription}\n${fixSection}`;
      stepTask.status = 'pending';
      delete stepTask.claimedAt;
      delete stepTask.claimedBy;
      delete stepTask.completedAt;

      const nextContext: Record<string, any> = {
        ...(stepTask.context || {}),
        attempts: 0,
        dispatched: false,
        remoteWaitSince: undefined,
        brainAuto: undefined,
        gateFindings: findings,
        specFindings: findings,
        specVerdict: {
          verdict: 'CHANGES_REQUESTED',
          judgeBrain: reviewerBrain || reviewer,
          judgeFamily,
          executorBrain,
          criteria: parsed.criteria,
          failedCriteria: findings,
          at: now
        },
        gate: {
          ...gateCtx,
          round: nextRound,
          status: 'fixing',
          lastProcessedReviewTaskId: freshReview.id,
          lastVerdict: 'CHANGES_REQUESTED',
          findings,
          ...(shouldEscalate ? { escalated: true, escalatedAtRound: gateCtx.escalatedAtRound || nextRound } : {})
        }
      };

      if (shouldEscalate) {
        nextContext.tier = 'judgment';
        nextContext.escalated = true;
        nextContext.escalatedAtRound = gateCtx.escalatedAtRound || nextRound;
        if (escalatedBrain) nextContext.escalatedBrain = escalatedBrain;
        // Clear any auto brain pin so planFor selects from the escalated judgment tier.
        delete nextContext.brain;
      }

      stepTask.context = nextContext;
      this.store.saveTask(stepTask);
      this.saveRecord(rec);
      console.log(`Workflows: gate CHANGES_REQUESTED for step "${stepKey}" (round ${round}/${maxRounds}) → re-queued for round ${nextRound}${shouldEscalate ? ' [escalated to judgment tier]' : ''}`);
      return;
    }

    // Case 3: Cap reached (`round >= maxRounds`)
    if (blockers.length > 0) {
      // Any BLOCKER finding at the cap parks the gated step and run on wait-input.
      const roundRec: WorkflowGateRoundRecord = {
        round,
        taskId: stepTask.id,
        reviewTaskId: freshReview.id,
        reviewer,
        ...(reviewerBrain ? { reviewerBrain } : {}),
        ...(reviewerBrain ? { judgeBrain: reviewerBrain } : {}),
        ...(judgeFamily ? { judgeFamily } : {}),
        ...(executorBrain ? { executorBrain } : {}),
        verdict: 'CHANGES_REQUESTED',
        criteria: parsed.criteria,
        failedCriteria: parsed.failedCriteria,
        findings,
        summary: parsed.summary,
        blockerFindings: blockers,
        escalated: !!stepTask.context?.escalated,
        action: 'wait-input',
        ...panelField,
        at: now
      };
      gateRec.rounds.push(roundRec);
      gateRec.currentRound = round;
      gateRec.status = 'wait-input';
      gateRec.blockerFindings = blockers;
      rec.gates![stepKey] = gateRec;
      rec.status = 'wait-input';

      const questions = blockers.map(b => `Gate "${stepKey}" hit maxRounds (${maxRounds}) with unresolved BLOCKER: ${b}. How should we proceed?`);
      stepTask.context = {
        ...(stepTask.context || {}),
        gateFindings: findings,
        specFindings: findings,
        gate: {
          ...gateCtx,
          round,
          status: 'wait-input',
          lastProcessedReviewTaskId: freshReview.id,
          lastVerdict: 'CHANGES_REQUESTED',
          findings,
          blockers,
          decidedAt: now
        }
      };
      this.store.saveTask(stepTask);
      if (typeof (this.store as any).parkForInput === 'function') {
        (this.store as any).parkForInput({
          taskId: stepTask.id,
          questions,
          result: stepTask.result || `Parked on wait-input after ${maxRounds} review rounds due to BLOCKER: ${blockers.join('; ')}`
        });
      } else {
        stepTask.status = 'wait-input';
        stepTask.context = { ...(stepTask.context || {}), awaitingInput: true, inputQuestions: questions };
        this.store.saveTask(stepTask);
      }
      this.saveRecord(rec);
      console.log(`Workflows: gate BLOCKER at cap (${round}/${maxRounds}) for step "${stepKey}" → parked on wait-input`);
      return;
    }

    // Residual non-blocker findings at cap → record as RULING lines and continue the run.
    const rulings = findings.map(
      f => `Accept residual review finding on step "${stepKey}" after ${maxRounds}/${maxRounds} rounds (${f}) — non-blocker finding at gate cap — follow-up cleanup if needed`
    );
    const rulingLines = rulings.map(r => `RULING: ${r}`);

    const roundRec: WorkflowGateRoundRecord = {
      round,
      taskId: stepTask.id,
      reviewTaskId: freshReview.id,
      reviewer,
      ...(reviewerBrain ? { reviewerBrain } : {}),
      ...(reviewerBrain ? { judgeBrain: reviewerBrain } : {}),
      ...(judgeFamily ? { judgeFamily } : {}),
      ...(executorBrain ? { executorBrain } : {}),
      verdict: 'CHANGES_REQUESTED',
      criteria: parsed.criteria,
      failedCriteria: parsed.failedCriteria,
      findings,
      summary: parsed.summary,
      rulings,
      escalated: !!stepTask.context?.escalated,
      action: 'rulings',
      ...panelField,
      at: now
    };
    gateRec.rounds.push(roundRec);
    gateRec.currentRound = round;
    gateRec.status = 'ruled';
    gateRec.rulings = rulings;
    rec.gates![stepKey] = gateRec;
    rec.rulings = [...(rec.rulings || []), ...rulings];

    const existingRulings = Array.isArray(stepTask.context?.rulings) ? (stepTask.context!.rulings as string[]) : [];
    const mergedRulings = [...existingRulings, ...rulings];
    stepTask.result = [stepTask.result || '', '', ...rulingLines].join('\n').trim();
    stepTask.context = {
      ...(stepTask.context || {}),
      rulings: mergedRulings,
      gateFindings: findings,
      gate: {
        ...gateCtx,
        round,
        status: 'ruled',
        lastProcessedReviewTaskId: freshReview.id,
        lastVerdict: 'CHANGES_REQUESTED',
        findings,
        rulings,
        decidedAt: now
      }
    };
    this.store.saveTask(stepTask);
    this.saveRecord(rec);
    console.log(`Workflows: gate cap reached (${round}/${maxRounds}) for step "${stepKey}" with ${rulings.length} non-blocker finding(s) → recorded RULINGs and continuing`);
  }
}

/** Fill {{param}} placeholders inside every string of a brief. */
function interpolateBrief(brief: TaskBrief, params: Record<string, string>): TaskBrief {
  const list = (xs?: string[]) => xs?.map(x => interpolate(x, params));
  const out: TaskBrief = {};
  if (brief.acceptance) out.acceptance = list(brief.acceptance);
  if (brief.verify) out.verify = list(brief.verify);
  if (brief.timeboxMin) out.timeboxMin = brief.timeboxMin;
  if (brief.scope) out.scope = { ...(brief.scope.write ? { write: list(brief.scope.write) } : {}), ...(brief.scope.forbid ? { forbid: list(brief.scope.forbid) } : {}) };
  return out;
}

/** Short, url-safe run id. Kept here so workflows.ts owns its own id scheme. */
function cryptoRandomId(): string {
  return 'run-' + uuidv4().slice(0, 8);
}
