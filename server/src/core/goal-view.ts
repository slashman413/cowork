/**
 * Goal views: one place that turns a stored goal and its tasks into what people
 * and agents read. The API, the MCP tools and the page all use these, so the
 * status words cannot drift apart.
 *
 * `displayState` answers "what needs me, and what happens next?" without anyone
 * having to reason across status, phases, open tasks and backoff fields.
 */
import fs from 'fs';
import path from 'path';
import type { GoalBlockCode, GoalDecision, GoalRecord, RunUsage, Task } from '../types.js';
import { isRateLimitFailure } from './result-verifier.js';

export type GoalState = 'needs-you' | 'running' | 'thinking' | 'auditing' | 'sleeping' | 'retrying' | 'stuck' | 'paused' | 'draft' | 'achieved';
export type GoalAction = 'raise-budget' | 'retry' | 'plan-phase' | 'open-task' | 'activate';

export interface DisplayState {
  state: GoalState;
  /** One line: what is happening, or what the reader must do. */
  line: string;
  /** ISO time of the next event, when one is known. */
  nextAt?: string;
  /** The one primary action, when the reader has one. */
  action?: GoalAction;
  /** The task an `open-task` action points to. */
  taskId?: string;
  /** When the running task started. */
  since?: string;
}

/** Page sort order: what needs attention first. */
export const STATE_ORDER: GoalState[] = ['needs-you', 'stuck', 'running', 'thinking', 'auditing', 'retrying', 'sleeping', 'draft', 'paused', 'achieved'];

const REVIEW_ROLES = new Set(['goal-judger', 'goal-attention']);
const OPEN = new Set(['pending', 'claimed', 'in-progress', 'scheduled', 'wait-input']);
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A failed-turn block after this many cycles stops reading as a blip. */
const STUCK_AFTER_BLOCKS = 3;

/** The cause of a block, from the stored code or, on an old record, its text. */
export function blockCodeOf(rec: Pick<GoalRecord, 'blockCode' | 'blockReason'>): GoalBlockCode {
  if (rec.blockCode) return rec.blockCode;
  return classifyBlockReason(rec.blockReason || '');
}

export function classifyBlockReason(reason: string): GoalBlockCode {
  if (/step budget exhausted/i.test(reason)) return 'budget_exhausted';
  if (/token budget/i.test(reason)) return 'token_budget';
  if (/Achiever made no usable progress/i.test(reason)) return isRateLimitFailure(reason) ? 'rate_limit' : 'achiever_no_progress';
  if (isRateLimitFailure(reason)) return 'rate_limit';
  if (/blocked by a human/i.test(reason)) return 'operator';
  return 'achiever_declared';
}

/** Standard wording for causes the system itself raises. */
export const BLOCK_TEXT: Partial<Record<GoalBlockCode, { reason: string; resume: string }>> = {
  rate_limit: { reason: 'Every Achiever brain is rate limited', resume: 'A brain in the chain has quota again.' },
  achiever_no_progress: { reason: 'Achiever turns made no usable progress', resume: 'The Achiever returns a usable move. Retries run on a backoff; if it keeps blocking, check the brain or edit the goal.' },
  budget_exhausted: { reason: 'Step budget used up before the criterion was met', resume: 'Raise the step budget or narrow the criterion. The goal then resumes on its next retry.' },
  token_budget: { reason: 'Token budget used up before the criterion was met', resume: 'Raise the token budget or narrow the criterion. The goal then resumes on its next retry.' }
};

export interface DisplayOpts {
  deciding?: boolean;
  now?: number;
  /** Includes Achiever turns, which the task list cannot show. Set by Goals for a token-budget block. */
  overTokens?: boolean;
}

export function deriveDisplayState(rec: GoalRecord, tasks: Task[], opts: DisplayOpts = {}): DisplayState {
  const now = opts.now ?? Date.now();
  if (rec.status === 'achieved') return { state: 'achieved', line: clip(rec.closedReason || 'Success criterion met', 90) };
  if (rec.status === 'draft') return { state: 'draft', line: 'Not started', action: 'activate' };
  if (rec.status === 'paused') return { state: 'paused', line: 'Paused by you', action: 'activate' };

  const waiting = tasks.find(t => t.status === 'wait-input');
  if (waiting) return { state: 'needs-you', line: clip(`Answer: ${waiting.title}`, 90), action: 'open-task', taskId: waiting.id };

  if (rec.status === 'blocked') {
    const code = blockCodeOf(rec);
    const noPhase = rec.phases.length > 0 && rec.phases.every(p => p.status === 'audited' || p.status === 'done');
    const retry = rec.nextRetryAt;
    // Once raised, the block clears on its next retry: nothing is left for the reader to do.
    const execUsed = tasks.filter(t => !REVIEW_ROLES.has(t.context?.role)).length;
    if (code === 'budget_exhausted') return execUsed < (rec.stepBudget ?? 24)
      ? { state: 'retrying', line: 'Back under budget', nextAt: retry, action: 'retry' }
      : { state: 'needs-you', line: 'Step budget used up. Raise it to continue.', nextAt: retry, action: 'raise-budget' };
    if (code === 'token_budget') return !(opts.overTokens ?? (!!rec.tokenBudget && rollupTaskUsage(tasks).total >= rec.tokenBudget))
      ? { state: 'retrying', line: 'Back under budget', nextAt: retry, action: 'retry' }
      : { state: 'needs-you', line: 'Token budget used up. Raise it to continue.', nextAt: retry, action: 'raise-budget' };
    if (code === 'rate_limit') return { state: 'retrying', line: 'Rate limited', nextAt: retry, action: 'retry' };
    if (code === 'achiever_no_progress') {
      if (noPhase) return { state: 'stuck', line: 'No phase left to work on', nextAt: retry, action: 'plan-phase' };
      if ((rec.blockCount || 0) >= STUCK_AFTER_BLOCKS) return { state: 'stuck', line: `Failed ${rec.blockCount} retries in a row`, nextAt: retry, action: 'retry' };
      return { state: 'retrying', line: 'Achiever turn failed', nextAt: retry, action: 'retry' };
    }
    // The server runs this check itself, so nobody has to act unless they want to.
    if (rec.unblockCheck) return { state: 'retrying', line: clip(`Waiting: ${rec.unblockCriteria || rec.blockReason || 'a check to pass'}`, 90), nextAt: retry, action: 'retry' };
    return { state: 'needs-you', line: clip(rec.unblockCriteria && code === 'achiever_declared' ? rec.unblockCriteria : rec.blockReason || 'Held', 90), nextAt: retry, action: 'retry' };
  }

  // active
  const open = tasks.filter(t => OPEN.has(t.status) && t.context?.role !== 'goal-attention');
  const phase = rec.phases.find(p => p.status === 'completing') || rec.phases.find(p => p.judgerTaskId && open.some(t => t.id === p.judgerTaskId));
  if (phase) return { state: 'auditing', line: clip(`Reviewing: ${phase.title || phase.key}`, 90) };

  const executing = open.find(t => t.status === 'claimed' || t.status === 'in-progress');
  if (executing) return { state: 'running', line: clip(`Running: ${executing.title}`, 90), taskId: executing.id, ...(executing.claimedAt ? { since: executing.claimedAt } : {}) };

  const isFuture = (t: Task) => !!t.scheduledAt && Date.parse(t.scheduledAt) > now;
  const future = open.filter(isFuture).sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
  const openIds = new Set(open.map(t => t.id));
  const dependsOnOpen = (t: Task) => Array.isArray(t.context?.dependsOn) && t.context!.dependsOn.some((id: string) => openIds.has(id));
  const runnable = open.filter(t => !isFuture(t) && !dependsOnOpen(t));
  if (runnable.length) return { state: 'running', line: clip(`Queued: ${runnable[0].title}`, 90), taskId: runnable[0].id };
  if (future.length) return { state: 'sleeping', line: clip(future[0].title, 90), nextAt: future[0].scheduledAt, taskId: future[0].id };

  if (rec.achieverRetryAt && Date.parse(rec.achieverRetryAt) > now) return { state: 'retrying', line: 'Rate limited', nextAt: rec.achieverRetryAt, action: 'retry' };
  return { state: 'thinking', line: opts.deciding ? 'Choosing the next move' : 'Next move due' };
}

/** Totals across the given runs; `unmetered` counts runs that reported nothing. */
export interface UsageRollup extends RunUsage {
  /** input + cacheRead + cacheWrite + output. */
  total: number;
  metered: number;
  unmetered: number;
}

export function emptyRollup(): UsageRollup {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, metered: 0, unmetered: 0 };
}

/** Add one task's context.usage (or its absence) to a rollup. */
function addUsage(r: UsageRollup, u: any): void {
  if (!u || u.metered === false || typeof u.input !== 'number') { r.unmetered++; return; }
  r.metered++;
  r.input += u.input; r.cacheRead += u.cacheRead || 0; r.cacheWrite += u.cacheWrite || 0; r.output += u.output || 0;
  r.total = r.input + r.cacheRead + r.cacheWrite + r.output;
  if (typeof u.costUsd === 'number') r.costUsd = (r.costUsd || 0) + u.costUsd;
}

/** Finished tasks only: an open task has no usage yet and is not "not metered". */
export function rollupTaskUsage(tasks: Task[]): UsageRollup {
  const r = emptyRollup();
  for (const t of tasks) if (!OPEN.has(t.status)) addUsage(r, t.context?.usage);
  return r;
}

const PHASE_LETTER: Record<string, string> = { planned: 'p', active: 'a', completing: 'c', done: 'd', audited: 'd' };

/** The list view: small on purpose (it is fetched on every page refresh). */
export interface GoalSummary {
  goalId: string;
  title: string;
  status: GoalRecord['status'];
  display: DisplayState;
  budget: { used: number; cap: number };
  tasks: { done: number; total: number };
  /** One letter per phase in order: p planned, a active, c completing, d done. */
  phases: string;
  updatedAt: string;
}

export function goalSummary(rec: GoalRecord, tasks: Task[], opts: DisplayOpts = {}): GoalSummary {
  const exec = tasks.filter(t => !REVIEW_ROLES.has(t.context?.role));
  return {
    goalId: rec.goalId,
    title: clip(rec.title, 80),
    status: rec.status,
    display: deriveDisplayState(rec, tasks, opts),
    budget: { used: exec.length, cap: rec.stepBudget ?? 24 },
    tasks: { done: exec.filter(t => t.status === 'done').length, total: exec.length },
    phases: rec.phases.map(p => PHASE_LETTER[p.status] || 'p').join(''),
    updatedAt: rec.updatedAt
  };
}

export function sortSummaries(list: GoalSummary[]): GoalSummary[] {
  const rank = (s: GoalSummary) => STATE_ORDER.indexOf(s.display.state);
  const next = (s: GoalSummary) => (s.display.nextAt ? Date.parse(s.display.nextAt) : Number.MAX_SAFE_INTEGER);
  return [...list].sort((a, b) => rank(a) - rank(b) || next(a) - next(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** The compact task row the detail view lists. */
export function taskRow(t: Task) {
  return {
    id: t.id, title: t.title, status: t.status, phaseKey: t.context?.phaseKey, role: t.context?.role,
    scheduledAt: t.scheduledAt, brain: t.context?.ranBrain || t.context?.brain, usage: t.context?.usage
  };
}

// ── History ────────────────────────────────────────────────────────────────

export const HISTORY_TAIL = 20;

/** Merge block→resume→block cycles of the same cause into one counted row, then
 *  keep the tail. Deterministic: the full record stays in history.jsonl. */
export function coalesceHistory(rows: GoalDecision[], tail = HISTORY_TAIL): GoalDecision[] {
  const out: GoalDecision[] = [];
  const key = (r: GoalDecision) => `${r.code || ''}|${r.code === 'achiever_declared' || r.code === 'operator' || !r.code ? r.reason || '' : ''}`;
  for (const row of rows) {
    if (row.kind === 'block') {
      const last = out[out.length - 1];
      const prior = last?.kind === 'resume' ? out[out.length - 2] : last;
      if (prior?.kind === 'block' && key(prior) === key(row)) {
        if (last.kind === 'resume') out.pop();
        prior.count = (prior.count || 1) + (row.count || 1);
        prior.firstAt = prior.firstAt || prior.at;
        prior.lastAt = row.lastAt || row.at;
        if (row.reason) prior.reason = row.reason;   // the latest cause, not the first
        prior.at = row.at;
        continue;
      }
    }
    out.push({ ...row });
  }
  return out.slice(-tail);
}

export function historyFile(dir: string, goalId: string): string {
  return path.join(dir, goalId, 'history.jsonl');
}

export function appendHistory(dir: string, goalId: string, ...rows: GoalDecision[]): void {
  if (!rows.length) return;
  try {
    fs.mkdirSync(path.join(dir, goalId), { recursive: true });
    fs.appendFileSync(historyFile(dir, goalId), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (e) { console.warn(`Goals: could not append history for ${goalId}:`, e); }
}

export function readHistory(dir: string, goalId: string): GoalDecision[] {
  try {
    return fs.readFileSync(historyFile(dir, goalId), 'utf-8').split('\n').filter(Boolean).flatMap(l => {
      try { return [JSON.parse(l) as GoalDecision]; } catch { return []; }
    });
  } catch { return []; }
}

// ── Achiever turn log ──────────────────────────────────────────────────────

export interface AchieverTurn {
  at: string;
  brain?: string;
  exec?: string;
  mode?: string;
  outcome: 'applied' | 'rejected' | 'unparseable' | 'rate-limited' | 'timeout' | 'error';
  kind?: string;
  reason?: string;
  usage?: RunUsage | null;
  durationMs?: number;
  /** The raw reply, kept only when it could not be used (capped). */
  raw?: string;
}

export function appendAchieverTurn(dir: string, goalId: string, turn: AchieverTurn): void {
  try {
    fs.mkdirSync(path.join(dir, goalId), { recursive: true });
    const row = turn.raw ? { ...turn, raw: turn.raw.slice(0, 4000) } : turn;
    fs.appendFileSync(path.join(dir, goalId, 'achiever-turns.jsonl'), JSON.stringify(row) + '\n');
  } catch (e) { console.warn(`Goals: could not log Achiever turn for ${goalId}:`, e); }
}

export function readAchieverTurns(dir: string, goalId: string): AchieverTurn[] {
  try {
    return fs.readFileSync(path.join(dir, goalId, 'achiever-turns.jsonl'), 'utf-8').split('\n').filter(Boolean).flatMap(l => {
      try { return [JSON.parse(l) as AchieverTurn]; } catch { return []; }
    });
  } catch { return []; }
}

export function rollupAchieverTurns(turns: AchieverTurn[]): UsageRollup {
  const r = emptyRollup();
  for (const t of turns) addUsage(r, t.usage ?? undefined);
  return r;
}

/** Bullet flags in an Attention section. */
export const flagsIn = (text: string): number => (text.match(/^\s*[-*]\s+\S/gm) || []).length;
