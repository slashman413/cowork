/**
 * Goal decision trail (plan PS-7, port of pstack `show-me-your-work`).
 *
 * Every goal keeps one append-only TSV at `goals/<goalId>/decisions.tsv` with
 * pstack's columns — `ts phase decision why evidence result` — so the CEO can
 * skim what the Achiever chose, why, and what proves it. Rows come from:
 *   - the Achiever's moves (plan / emit / evaluate / block),
 *   - each phase task finishing, plus its `RULING:` lines (reused from P2-3's
 *     rulingRowsForTask, so footer rulings and auto-answers are copied in),
 *   - the Judger audit and the cross-family Attention review at phase close.
 *
 * Cells follow pstack's `log.sh` sanitising: tabs/newlines/CR become spaces so a
 * row is one line, and a cell whose first character a spreadsheet would read as a
 * formula (= + - @) is prefixed with `'`.
 *
 * Invariant — never break the goal loop: {@link appendGoalDecision} never throws.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../types.js';
import { AUTO_ANSWER_PREFIX, rulingRowsForTask } from './rulings.js';

export const GOAL_TRAIL_FILE = 'decisions.tsv';
export const GOAL_TRAIL_HEADER = 'ts\tphase\tdecision\twhy\tevidence\tresult';
const CELL_CAP = 600;

export interface GoalDecisionRow {
  ts: string; phase: string; decision: string; why: string; evidence: string; result: string;
}

/** pstack log.sh `clean()`: strip tabs/newlines/CR, then guard formula-leading cells. */
export function trailCell(v: unknown): string {
  const s = String(v ?? '').replace(/[\t\n\r]/g, ' ').slice(0, CELL_CAP);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** ISO-8601 to the second, as log.sh stamps it (`date -u +%Y-%m-%dT%H:%M:%SZ`). */
export const trailTs = (d: Date | string = new Date()) =>
  new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const goalTrailPath = (goalsDir: string, goalId: string) => join(goalsDir, goalId, GOAL_TRAIL_FILE);

/** Render one row as a TSV line (ts is stamped now when absent). */
export function trailLine(r: Partial<GoalDecisionRow>): string {
  return [r.ts || trailTs(), r.phase, r.decision, r.why, r.evidence, r.result].map(trailCell).join('\t');
}

/**
 * Append rows to the goal's trail (header on first write, like log.sh: `>>`
 * only, header when the file is missing or empty). Returns rows written; 0 on
 * any I/O error, after logging.
 */
export function appendGoalDecision(goalsDir: string, goalId: string, ...rows: Partial<GoalDecisionRow>[]): number {
  if (!rows.length || !goalsDir || !goalId) return 0;
  try {
    const file = goalTrailPath(goalsDir, goalId);
    mkdirSync(join(goalsDir, goalId), { recursive: true });
    let empty = true;
    try { empty = statSync(file).size === 0; } catch { /* missing */ }
    appendFileSync(file, (empty ? GOAL_TRAIL_HEADER + '\n' : '') + rows.map(trailLine).join('\n') + '\n');
    return rows.length;
  } catch (e: any) {
    console.error(`[goal-trail] append failed for ${goalId}: ${e?.message || e}`);
    return 0;
  }
}

/** Read the trail (optionally one phase), oldest first. Missing file → []. */
export function readGoalTrail(goalsDir: string, goalId: string, phase?: string): GoalDecisionRow[] {
  let raw = '';
  try { raw = readFileSync(goalTrailPath(goalsDir, goalId), 'utf-8'); } catch { return []; }
  const rows: GoalDecisionRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || line === GOAL_TRAIL_HEADER) continue;
    const [ts, ph = '', decision = '', why = '', evidence = '', ...rest] = line.split('\t');
    if (phase !== undefined && ph !== phase) continue;
    rows.push({ ts, phase: ph, decision, why, evidence, result: rest.join(' ') });
  }
  return rows;
}

/**
 * Rows a finished phase task contributes: one for the task itself, then one per
 * RULING / auto-answer (P2-3's rulingRowsForTask). A ruling's
 * `decision — why — cost if wrong` shape is split across the decision/why cells.
 */
export function taskTrailRows(task: Task, phase: string): GoalDecisionRow[] {
  const ctx = (task.context || {}) as Record<string, any>;
  const brain = String(ctx.ranBrain || ctx.brain || '');
  const evidence = `task ${task.id.slice(0, 8)}${brain ? ` (${brain})` : ''}`;
  const ts = trailTs(task.completedAt || new Date());
  const rows: GoalDecisionRow[] = [{
    ts, phase, decision: `task finished: ${task.title}`, why: 'phase work', evidence: `${evidence}; artifacts/${task.id}/`,
    result: task.status
  }];
  for (const r of rulingRowsForTask(task)) {
    const auto = r.ruling.startsWith(AUTO_ANSWER_PREFIX);
    const [decision, ...why] = (auto ? r.ruling : r.ruling.replace(/^RULING:\s*/i, '')).split(/\s+—\s+/);
    rows.push({ ts: trailTs(r.date), phase, decision: auto ? decision : `RULING: ${decision}`, why: why.join(' — '), evidence, result: 'logged' });
  }
  return rows;
}
