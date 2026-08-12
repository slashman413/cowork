import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import type { Config, WorkflowDef, WorkflowStep, WorkflowRun, WorkflowRunRecord, WorkflowDecision, Task } from '../types.js';
import type { Store } from './store.js';

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

  constructor(config: Config, store: Store) {
    this.config = config;
    this.store = store;
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
    return {
      title, description,
      agent: s.agent, division: s.division, brain: s.brain,
      priority: s.priority || 'normal',
      dependsOnKeys: s.dependsOn || []
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
        return { key: s.key, title: c.title, description: c.description, agent: c.agent, division: c.division, brain: c.brain, dependsOn: c.dependsOnKeys };
      });
      return { runId, workflowId: def.id, mode: 'dag', dryRun: true, steps };
    }

    // Real run: create bottom-up so each step's dependency task ids already exist.
    const keyToTaskId = new Map<string, string>();
    const tasks: Task[] = [];
    for (const s of order) {
      const c = this.compileStep(def, s, params);
      const context: Record<string, any> = { workflowId: def.id, workflowRunId: runId, stepKey: s.key };
      if (c.agent) context.agent = c.agent;
      if (c.division) context.division = c.division;
      if (c.brain) context.brain = c.brain;
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
    }
    console.log(`Workflows: expanded "${def.id}" → run ${runId} (${tasks.length} tasks)`);
    return { runId, workflowId: def.id, mode: 'dag', dryRun: false, steps: order.map(s => ({ key: s.key })), tasks };
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
      if (rec.status !== 'running') return false;
      const openTaskIds = rec.history.map(h => h.taskId).filter(Boolean) as string[];
      return openTaskIds.every(id => {
        const t = this.store.getTask(id);
        return !t || t.status === 'done' || t.status === 'rejected';
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
    const context: Record<string, any> = { workflowId: def.id, workflowRunId: runId, stepKey: step.key, orchestrated: true };
    if (c.agent) context.agent = c.agent;
    if (c.division) context.division = c.division;
    if (c.brain) context.brain = c.brain;
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
    record.history.push({ stepKey: step.key, reason: choice.reason, taskId: task.id, decidedAt: at });
    this.saveRecord(record);
    console.log(`Workflows: orchestrated run ${runId} → step "${step.key}" (task ${task.id})`);
    return task;
  }

  /** All runs currently on disk, newest first. Orchestrated runs come from their
   *  persisted records (goal + decision log); DAG runs are reconstructed from
   *  task context. A runId with a record is always rendered as orchestrated. */
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
      if (records.has(runId)) continue;   // already emitted as an orchestrated run
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

  private runFromTasks(runId: string, tasks: Task[]): WorkflowRun {
    const failed = tasks.some(t => t.status === 'rejected');
    const allDone = tasks.every(t => t.status === 'done');
    const status: WorkflowRun['status'] = failed ? 'failed' : allDone ? 'done' : 'running';
    return {
      runId,
      workflowId: String(tasks[0]?.context?.workflowId || '?'),
      createdAt: tasks[0]?.createdAt || new Date().toISOString(),
      tasks,
      status,
      mode: 'dag'
    };
  }

  /** Build the UI run view for an orchestrated run: the record's own status +
   *  goal + decision history, ordered by the run's own tasks. */
  private runFromRecord(rec: WorkflowRunRecord, tasks: Task[]): WorkflowRun {
    tasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return {
      runId: rec.runId,
      workflowId: rec.workflowId,
      createdAt: rec.createdAt,
      tasks,
      status: rec.status,
      mode: 'orchestrated',
      goal: rec.goal,
      history: rec.history
    };
  }
}

/** Short, url-safe run id. Kept here so workflows.ts owns its own id scheme. */
function cryptoRandomId(): string {
  return 'run-' + uuidv4().slice(0, 8);
}
