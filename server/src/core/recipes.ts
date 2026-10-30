import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '../types.js';

/**
 * Recipes — reusable tasks. A task that came back with a good result is saved as
 * a Recipe: its brief with the variable parts pulled out as {{fields}}, plus what
 * made the run work (agent, brain, tier, acceptance, timebox, input files).
 * Running a recipe fills the fields and creates an ORDINARY task — no new
 * execution engine; dispatcher, verifier and handover treat it like any other.
 *
 * State is filesystem JSON under recipes/ (sibling of goals/), gitignored like
 * goals/ because briefs carry private context:
 *   recipes/<id>.json               current version
 *   recipes/<id>/versions/<n>.json  every earlier version (snapshot)
 *   recipes/<id>/inputs/            input files copied from the origin task
 *
 * Score is never stored — it is derived from the tasks that carry
 * context.recipe.id (see recipeStats), so a purged task simply stops counting.
 */

export type RecipeFieldType = 'text' | 'longtext' | 'number' | 'date' | 'choice';
export const FIELD_TYPES: readonly RecipeFieldType[] = ['text', 'longtext', 'number', 'date', 'choice'];

export interface RecipeField {
  key: string;
  label: string;
  type: RecipeFieldType;
  options?: string[];
  default?: string;
  required: boolean;
}

export interface RecipeCarry {
  agent?: string;
  division?: string;
  brain?: string;
  /** lock = always pin carry.brain; suggest = let the router pick (default) —
   *  the run sheet still offers carry.brain as a one-tap choice. */
  brainMode: 'lock' | 'suggest';
  tier?: string;
  acceptance?: string[];
  timeboxMin?: number;
  priority?: Task['priority'];
  tags?: string[];
  /** Filenames copied into recipes/<id>/inputs/. */
  inputs: string[];
}

export interface Recipe {
  id: string;
  name: string;
  icon: string;
  purpose: string;
  version: number;
  title: string;
  brief: string;
  fields: RecipeField[];
  carry: RecipeCarry;
  origin?: { taskId: string; title: string; resultExcerpt: string; savedAt: string };
  favourite?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeStats {
  runs: number;
  good: number;
  bad: number;
  running: number;
  lastRunAt?: string;
  medianMs?: number;
  /** Newest-first ratings of the last 10 finished runs: 1 good, 0 bad, null unrated. */
  recent: Array<1 | 0 | null>;
  /** The current version's own score (an edit starts a fresh one). */
  versionGood: number;
  versionBad: number;
}

export type RecipeRating = { good: boolean; note?: string; at: string };

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const MAX_PITFALLS = 5;

/** Placeholder keys used in a template, in order of first use. */
export function templateKeys(tpl: string): string[] {
  const out: string[] = [];
  for (const m of String(tpl || '').matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Fill {{key}} placeholders. A key with no value throws — a brief never ships a literal {{x}}. */
export function renderTemplate(tpl: string, values: Record<string, string>): string {
  return String(tpl).replace(VAR_RE, (_m, k) => {
    if (!Object.hasOwn(values, k)) throw new Error(`missing value for {{${k}}}`);
    return values[k];
  });
}

/** Validate + normalize a recipe definition (throws on a bad shape). */
export function normalizeRecipe(input: any, now = new Date().toISOString()): Recipe {
  if (!input || typeof input !== 'object') throw new Error('recipe must be an object');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('name is required');
  const brief = String(input.brief || '');
  if (!brief.trim()) throw new Error('brief is required');
  const title = String(input.title || name).trim();

  const fields: RecipeField[] = [];
  for (const f of Array.isArray(input.fields) ? input.fields : []) {
    const key = String(f?.key || '').trim();
    if (!KEY_RE.test(key)) throw new Error(`field key "${key}" must be lowercase letters, digits or _ (start with a letter)`);
    if (fields.some(x => x.key === key)) throw new Error(`duplicate field "${key}"`);
    const type: RecipeFieldType = FIELD_TYPES.includes(f?.type) ? f.type : 'text';
    const options = type === 'choice'
      ? (Array.isArray(f.options) ? f.options.map((o: any) => String(o).trim()).filter(Boolean) : [])
      : undefined;
    if (type === 'choice' && !options!.length) throw new Error(`choice field "${key}" needs options`);
    fields.push({
      key, type,
      label: String(f?.label || key).trim() || key,
      ...(options ? { options } : {}),
      ...(f?.default != null && String(f.default) !== '' ? { default: String(f.default) } : {}),
      required: f?.required !== false,
    });
  }
  const known = new Set(fields.map(f => f.key));
  for (const k of [...templateKeys(brief), ...templateKeys(title)]) {
    if (!known.has(k)) throw new Error(`{{${k}}} is used in the brief/title but is not a field`);
  }

  const c = input.carry && typeof input.carry === 'object' ? input.carry : {};
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const carry: RecipeCarry = {
    agent: str(c.agent), division: str(c.division), brain: str(c.brain),
    brainMode: c.brainMode === 'lock' ? 'lock' : 'suggest',
    tier: str(c.tier),
    acceptance: Array.isArray(c.acceptance) ? c.acceptance.map((s: any) => String(s).trim()).filter(Boolean) : undefined,
    timeboxMin: Number.isFinite(Number(c.timeboxMin)) && Number(c.timeboxMin) > 0 ? Math.round(Number(c.timeboxMin)) : undefined,
    priority: ['low', 'normal', 'high', 'urgent'].includes(c.priority) ? c.priority : undefined,
    tags: Array.isArray(c.tags) ? c.tags.map((s: any) => String(s).trim()).filter(Boolean) : undefined,
    inputs: Array.isArray(c.inputs) ? c.inputs.map((s: any) => path.basename(String(s))).filter(Boolean) : [],
  };
  for (const k of Object.keys(carry) as Array<keyof RecipeCarry>) if (carry[k] === undefined) delete carry[k];
  if (carry.acceptance && !carry.acceptance.length) delete carry.acceptance;
  if (carry.tags && !carry.tags.length) delete carry.tags;

  return {
    id: typeof input.id === 'string' && /^rcp-[a-z0-9]{8}$/.test(input.id) ? input.id : `rcp-${uuidv4().slice(0, 8)}`,
    name,
    icon: str(input.icon) && /^[a-z0-9-]{1,40}$/.test(input.icon.trim()) ? input.icon.trim() : 'chef-hat',
    purpose: String(input.purpose || '').trim(),
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    title, brief, fields, carry,
    ...(input.origin && typeof input.origin === 'object' ? { origin: input.origin } : {}),
    ...(input.favourite ? { favourite: true } : {}),
    ...(input.archived ? { archived: true } : {}),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now,
  };
}

/** Check run-time values against the recipe's fields; returns the full value map (defaults applied). */
export function resolveValues(recipe: Recipe, raw: Record<string, any> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of recipe.fields) {
    let v = raw[f.key] != null ? String(raw[f.key]).trim() : '';
    if (!v && f.default != null) v = f.default;
    if (!v) {
      if (f.required) throw new Error(`"${f.label}" is required`);
      out[f.key] = '';
      continue;
    }
    if (f.type === 'number' && !Number.isFinite(Number(v))) throw new Error(`"${f.label}" must be a number`);
    if (f.type === 'date' && !Number.isFinite(Date.parse(v))) throw new Error(`"${f.label}" must be a date`);
    if (f.type === 'choice' && !(f.options || []).includes(v)) throw new Error(`"${f.label}" must be one of: ${(f.options || []).join(', ')}`);
    out[f.key] = v;
  }
  return out;
}

export interface InstantiateOptions {
  values?: Record<string, any>;
  /** Extra instructions appended to the brief. */
  extra?: string;
  /** '' = auto-route, '<id>' = pin that brain, undefined = follow the recipe's brainMode. */
  brain?: string;
  /** 👎 notes from earlier runs, newest first — injected as "Known pitfalls". */
  pitfalls?: string[];
  scheduledAt?: string;
  recurrence?: any;
}

/** Build the createTask() params for one run of a recipe (pure; no I/O). */
export function instantiate(recipe: Recipe, opts: InstantiateOptions = {}): Omit<Task, 'id' | 'status' | 'createdAt'> {
  const values = resolveValues(recipe, opts.values);
  const c = recipe.carry;
  let description = renderTemplate(recipe.brief, values);
  const pitfalls = (opts.pitfalls || []).map(s => s.trim()).filter(Boolean).slice(0, MAX_PITFALLS);
  if (pitfalls.length) description += `\n\n## Known pitfalls (from earlier runs of this recipe)\n${pitfalls.map(p => `- ${p}`).join('\n')}`;
  if (opts.extra && opts.extra.trim()) description += `\n\n## Additional instructions\n${opts.extra.trim()}`;

  const brain = opts.brain !== undefined ? (opts.brain || undefined)
    : c.brainMode === 'lock' ? c.brain : undefined;
  const context: Record<string, any> = {
    recipe: { id: recipe.id, version: recipe.version, name: recipe.name, values },
  };
  if (c.division) context.division = c.division;
  if (brain) context.brain = brain;
  if (c.tier) context.tier = c.tier;
  if (c.acceptance?.length) context.acceptance = c.acceptance;
  if (c.timeboxMin) context.timeboxMin = c.timeboxMin;

  const out: Omit<Task, 'id' | 'status' | 'createdAt'> = {
    title: renderTemplate(recipe.title, values).slice(0, 200) || recipe.name,
    description,
    from: { platform: 'dashboard', agent: 'recipe' },
    to: c.agent ? { agent: c.agent } : {},
    priority: c.priority || 'normal',
    context,
    tags: [...new Set([...(c.tags || []), `recipe:${recipe.id}`])],
  };
  if (opts.scheduledAt) out.scheduledAt = opts.scheduledAt;
  if (opts.recurrence != null) out.recurrence = opts.recurrence;
  return out;
}

/** Turn a finished task into an editable recipe draft (nothing is saved). */
export function draftFromTask(task: Task): Recipe {
  const ctx = task.context || {};
  // A continued/recipe task embeds scaffolding after the user's brief — keep only the brief.
  const brief = String(task.description || '')
    .split(/\n---\nThis task CONTINUES a previous run/)[0]
    .split(/\n\n## Known pitfalls \(from earlier runs/)[0]
    .trim() || task.title;
  const fromRecipe = ctx.recipe && typeof ctx.recipe === 'object' ? ctx.recipe : null;
  return normalizeRecipe({
    name: String(fromRecipe?.name || task.title || 'Untitled recipe').slice(0, 80),
    purpose: '',
    title: String(task.title || '').replace(VAR_RE, '').slice(0, 200) || 'Recipe run',
    brief: brief.replace(VAR_RE, (m) => m.replace(/[{}]/g, '')),
    fields: [],
    carry: {
      agent: task.to?.agent, division: ctx.division,
      brain: ctx.ranBrain || ctx.brain, brainMode: 'suggest',
      tier: ctx.tier, acceptance: ctx.acceptance, timeboxMin: ctx.timeboxMin,
      priority: task.priority,
      tags: (task.tags || []).filter(t => !t.startsWith('recipe:')),
      inputs: Array.isArray(ctx.inputFiles) ? ctx.inputFiles : [],
    },
    origin: {
      taskId: task.id, title: task.title,
      resultExcerpt: String(task.result || '').slice(0, 2000),
      savedAt: new Date().toISOString(),
    },
  });
}

function isFailed(t: Task): boolean {
  return (t as any).failed === true || t.status === 'rejected'
    || (t.status === 'done' && typeof t.result === 'string' && /^FAILED\b/i.test(t.result.trim()));
}

/** Rating of one recipe-made task: explicit 👍/👎 wins; otherwise failed = bad, a DONE verdict = weak good. */
export function taskVerdict(t: Task): 1 | 0 | null {
  const r = t.context?.rating as RecipeRating | undefined;
  if (r && typeof r.good === 'boolean') return r.good ? 1 : 0;
  if (isFailed(t)) return 0;
  if (t.status === 'done') return /STATUS:\s*DONE\b(?!_)/.test(String(t.result || '')) ? 1 : null;
  return null;
}

/** Derive a recipe's score from the tasks it produced. */
export function recipeStats(recipe: Recipe, tasks: Task[]): RecipeStats {
  const runs = tasks.filter(t => t.context?.recipe?.id === recipe.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const finished = runs.filter(t => t.status === 'done' || t.status === 'rejected');
  const verdicts = finished.map(taskVerdict);
  const durations = finished
    .filter(t => !isFailed(t) && t.claimedAt && t.completedAt)
    .map(t => Date.parse(t.completedAt!) - Date.parse(t.claimedAt!))
    .filter(ms => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);
  const cur = finished.filter(t => t.context?.recipe?.version === recipe.version).map(taskVerdict);
  return {
    runs: runs.length,
    good: verdicts.filter(v => v === 1).length,
    bad: verdicts.filter(v => v === 0).length,
    running: runs.length - finished.length,
    lastRunAt: runs[0]?.createdAt,
    medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : undefined,
    recent: verdicts.slice(0, 10),
    versionGood: cur.filter(v => v === 1).length,
    versionBad: cur.filter(v => v === 0).length,
  };
}

/** 👎 notes left on runs of this recipe, newest first. */
export function recipePitfalls(recipe: Recipe, tasks: Task[]): string[] {
  return tasks
    .filter(t => t.context?.recipe?.id === recipe.id && t.context?.rating?.good === false && t.context.rating.note)
    .sort((a, b) => String(b.context!.rating.at).localeCompare(String(a.context!.rating.at)))
    .map(t => String(t.context!.rating.note))
    .slice(0, MAX_PITFALLS);
}

const BRIEF_KEYS: Array<keyof Recipe> = ['brief', 'title', 'fields', 'carry'];

/** Filesystem-backed recipe library. */
export class Recipes {
  constructor(private dir: string, private inputsRoot: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string) { return path.join(this.dir, `${path.basename(id)}.json`); }
  private extraDir(id: string) { return path.join(this.dir, path.basename(id)); }
  inputsDir(id: string) { return path.join(this.extraDir(id), 'inputs'); }

  private write(r: Recipe) {
    const f = this.file(r.id), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
    fs.renameSync(tmp, f);
  }

  list(opts: { includeArchived?: boolean } = {}): Recipe[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter(f => /^rcp-[a-z0-9]{8}\.json$/.test(f)); } catch { /* empty */ }
    const out: Recipe[] = [];
    for (const n of names) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'))); } catch { /* skip corrupt */ }
    }
    return out.filter(r => opts.includeArchived || !r.archived);
  }

  get(id: string): Recipe | null {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  versions(id: string): Recipe[] {
    const d = path.join(this.extraDir(id), 'versions');
    try {
      return fs.readdirSync(d).filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as Recipe)
        .sort((a, b) => b.version - a.version);
    } catch { return []; }
  }

  /** Save a new recipe; copies the origin task's input files (originInputsDir) into the recipe. */
  create(input: any, originInputsDir?: string | null): Recipe {
    const r = normalizeRecipe({ ...input, id: undefined, version: 1, createdAt: undefined });
    const kept: string[] = [];
    if (originInputsDir && r.carry.inputs.length) {
      fs.mkdirSync(this.inputsDir(r.id), { recursive: true });
      for (const name of r.carry.inputs) {
        const src = path.join(originInputsDir, path.basename(name));
        try { if (fs.statSync(src).isFile()) { fs.copyFileSync(src, path.join(this.inputsDir(r.id), path.basename(name))); kept.push(path.basename(name)); } } catch { /* gone */ }
      }
    }
    r.carry.inputs = kept;
    this.write(r);
    return r;
  }

  /** Edit; bumps the version (and snapshots the old one) when the brief/fields/carry change. */
  update(id: string, patch: any): Recipe {
    const prev = this.get(id);
    if (!prev) throw new Error('recipe not found');
    const merged = { ...prev, ...patch, id: prev.id, createdAt: prev.createdAt, origin: prev.origin, version: prev.version };
    // Input files can only be dropped here, never invented.
    if (merged.carry) merged.carry = { ...merged.carry, inputs: (merged.carry.inputs || []).filter((n: string) => prev.carry.inputs.includes(n)) };
    const next = normalizeRecipe(merged);
    if (BRIEF_KEYS.some(k => JSON.stringify(prev[k]) !== JSON.stringify(next[k]))) {
      const vd = path.join(this.extraDir(id), 'versions');
      fs.mkdirSync(vd, { recursive: true });
      fs.writeFileSync(path.join(vd, `${prev.version}.json`), JSON.stringify(prev, null, 2));
      next.version = prev.version + 1;
    }
    this.write(next);
    return next;
  }

  archive(id: string): Recipe {
    return this.update(id, { archived: true });
  }

  /** Stage the recipe's input files as upload tokens createTask() materializes. */
  stageInputs(r: Recipe): Array<{ token: string; name: string }> {
    const out: Array<{ token: string; name: string }> = [];
    for (const name of r.carry.inputs) {
      const src = path.join(this.inputsDir(r.id), name);
      if (!fs.existsSync(src)) continue;
      const token = `rcp${uuidv4().replace(/-/g, '')}`;
      const slot = path.join(this.inputsRoot, '_staging', token);
      fs.mkdirSync(slot, { recursive: true });
      fs.copyFileSync(src, path.join(slot, name));
      out.push({ token, name });
    }
    return out;
  }
}
