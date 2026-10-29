/**
 * Decision trail (plan P2-3) — every judgment call an autonomous run made, in one
 * place the CEO can skim after a night of unattended work.
 *
 * Two sources are folded into `decisions/rulings.tsv` when a task completes:
 *   - `RULING:` lines from the result's STATUS footer (P0-2/P0-4), and review→fix
 *     gate residuals (P1-2) — both land on `task.context.rulings`;
 *   - orchestrator auto-answers of a `wait-input` (ADR-009), logged by the
 *     dispatcher on `task.context.autoAnswer.decisions` as they are submitted.
 *
 * Format: one header line, then `date \t task \t agent \t brain \t ruling` rows.
 * Auto-answer rows carry an `AUTO-ANSWER: ` prefix in the ruling column. Tabs and
 * newlines inside a field are flattened to spaces so a row is always one line.
 *
 * Invariant — never break completion: {@link appendRulings} never throws.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../types.js';

export const RULINGS_FILE = 'rulings.tsv';
export const RULINGS_HEADER = 'date\ttask\tagent\tbrain\truling';
export const AUTO_ANSWER_PREFIX = 'AUTO-ANSWER: ';
const RULING_CAP = 600;
const DECISIONS_CAP = 20;

export interface RulingRow { date: string; task: string; agent: string; brain: string; ruling: string; }

/** One orchestrator auto-answer, as logged on `context.autoAnswer.decisions`. */
export interface AutoAnswerDecision { at: string; answer: string; }

const cell = (s: unknown) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

/** Render an auto-answer as one line: `label → value; label → value`. */
export function describeAutoAnswer(
  fields: Array<{ id: string; label?: string }>,
  answers: Record<string, string | boolean>
): string {
  return fields
    .filter(f => Object.prototype.hasOwnProperty.call(answers, f.id))
    .map(f => `${cell(f.label || f.id)} → ${cell(answers[f.id])}`)
    .join('; ')
    .slice(0, RULING_CAP);
}

/** Append one decision to the capped log on `context.autoAnswer.decisions`. */
export function logAutoAnswer(prev: unknown, decision: AutoAnswerDecision): AutoAnswerDecision[] {
  const list = Array.isArray(prev) ? (prev as AutoAnswerDecision[]) : [];
  return [...list, decision].slice(-DECISIONS_CAP);
}

/**
 * The rows a completed task contributes. Auto-answers already written by an
 * earlier completion of the same task (a re-run) are skipped via
 * `context.rulingsLoggedAt`; footer rulings belong to this run's result, so they
 * are always written. A legacy auto-answered task (answered before the decision
 * log existed) falls back to its submitted interaction packet.
 */
export function rulingRowsForTask(task: Task): RulingRow[] {
  const ctx = (task.context || {}) as Record<string, any>;
  const date = task.completedAt || new Date().toISOString();
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const agent = cell(str(ctx.ranAgent) || str(ctx.agent) || str((task.to as any)?.agent) || str(task.to));
  const brain = cell(ctx.ranBrain || ctx.brain || '');
  const base = { task: task.id, agent, brain };
  const rows: RulingRow[] = [];

  for (const r of Array.isArray(ctx.rulings) ? ctx.rulings : []) {
    const text = cell(r).slice(0, RULING_CAP);
    if (text) rows.push({ date, ...base, ruling: text });
  }

  const since = Date.parse(ctx.rulingsLoggedAt || '') || 0;
  const decisions: AutoAnswerDecision[] = Array.isArray(ctx.autoAnswer?.decisions) ? ctx.autoAnswer.decisions : [];
  if (decisions.length) {
    for (const d of decisions) {
      if ((Date.parse(d.at) || 0) <= since || !cell(d.answer)) continue;
      rows.push({ date: d.at, ...base, ruling: AUTO_ANSWER_PREFIX + cell(d.answer).slice(0, RULING_CAP) });
    }
  } else if (!since && /auto-answer/i.test(task.interaction?.submittedBy || '')) {
    const ix = task.interaction!;
    const answers: Record<string, string | boolean> = {};
    for (const f of ix.fields || []) if (f.value !== undefined) answers[f.id] = f.value as string | boolean;
    const answer = describeAutoAnswer(ix.fields || [], answers);
    if (answer) rows.push({ date: ix.submittedAt || date, ...base, ruling: AUTO_ANSWER_PREFIX + answer });
  }
  return rows;
}

const toLine = (r: RulingRow) => [r.date, r.task, r.agent, r.brain, r.ruling].map(cell).join('\t');

/**
 * Append a completed task's rulings to `<decisionsDir>/rulings.tsv` (header on
 * first write). Returns the number of rows written; 0 on any I/O error, after
 * logging — the task lifecycle is never affected.
 */
export function appendRulings(decisionsDir: string, task: Task): number {
  try {
    const rows = rulingRowsForTask(task);
    if (!rows.length) return 0;
    mkdirSync(decisionsDir, { recursive: true });
    const file = join(decisionsDir, RULINGS_FILE);
    const head = existsSync(file) ? '' : RULINGS_HEADER + '\n';
    appendFileSync(file, head + rows.map(toLine).join('\n') + '\n');
    return rows.length;
  } catch (e: any) {
    console.error(`[rulings] append failed: ${e?.message || e}`);
    return 0;
  }
}

/** Read rows dated within [from, to] (ms), newest first. Missing file → []. */
export function readRulings(decisionsDir: string, from = 0, to = Number.MAX_SAFE_INTEGER): RulingRow[] {
  let raw = '';
  try { raw = readFileSync(join(decisionsDir, RULINGS_FILE), 'utf-8'); } catch { return []; }
  const rows: RulingRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || line === RULINGS_HEADER) continue;
    const [date, task, agent, brain, ...rest] = line.split('\t');
    const t = Date.parse(date);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    rows.push({ date, task, agent: agent || '', brain: brain || '', ruling: rest.join(' ') });
  }
  return rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
