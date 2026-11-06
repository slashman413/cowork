/**
 * The Achiever's per-turn prompt (toolless mode). Pure, so its size can be tested.
 *
 * Budget: at most about 3k tokens on real goals. The Achiever has no tools, so
 * everything it needs must be inline, and everything else stays out: results of
 * old phases collapse to one line, and the rules tail is deliberately short.
 */
import type { GoalRecord } from '../types.js';
import { extractEvidenceBlock } from './result-verifier.js';

export interface AchieverPromptContext {
  record: GoalRecord;
  successCriteria: string;
  phases: { key: string; title: string; status: string; results: { title: string; status: string; result?: string }[] }[];
  currentPhaseKey: string | null;
  nextMove?: string;
  budget: { used: number; cap: number };
}

const clip = (s: string, n: number) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The goal text without the template's loop-driver rules, which repeat the tail.
 *  Cadence and the stop condition are specific to the goal, so those two stay. */
export function goalDetails(description: string, cap = 1200): string {
  const at = description.indexOf('/loop driver');
  if (at < 0) return clip(description, cap);
  const head = description.slice(0, at).trim();
  const keep = description.slice(at).split('\n').filter(l => /^•\s*(Cadence|Stop only when):/.test(l)).join(' ');
  return clip(`${head} ${keep}`, cap);
}

/** A task's result reduced to its evidence block, else its opening. */
function resultDigest(result: string | undefined, cap: number): string {
  if (!result) return '';
  const ev = extractEvidenceBlock(result);
  return clip(ev || result, cap);
}

export const ACHIEVER_TAIL = [
  'Reply with one fenced JSON move.',
  '- met:true ends the goal. Use it only when a named task\'s evidence proves the criterion.',
  '- Treat vague criteria as predicates: first plan a phase that pins a number and its source.',
  '- Test the riskiest unknown first. Baseline before building.',
  '- Tasks do real work. Plans and reports are not progress. Follow execution with verification.',
  '- Follow NEXT MOVE unless evidence contradicts it; if so, say why.',
  '- To let time pass, emit the measurement with a future scheduledAt. That costs nothing.',
  '- If an approach underperformed, change it. An unmet criterion never means stop.',
  '- Block only on what you cannot clear yourself, with a checkable condition.',
  'You have no tools. To read or measure something, emit a task.'
].join('\n');

const EVALUATE = '{"kind":"evaluate","met":true|false,"reason":"evidence"}';
const PLAN = '{"kind":"plan","phase":{"key":"kebab-case","title":"..."},"reason":"..."}';
const EMIT = '{"kind":"emit","tasks":[{"title":"...","description":"standalone brief","tier":"mechanical|standard|judgment","acceptance":["checkable"],"verify":["command or check"],"scheduledAt":"ISO-8601, optional, future"}],"reason":"..."}';
const BLOCK = '{"kind":"block","reason":"obstacle","unblockCriteria":"checkable condition","unblockCheck":{"type":"brain-available|file-exists|http-200|after-time","value":"brain id|absolute path|https url|ISO time"}}  (unblockCheck is optional)';

export function buildAchieverPrompt(ctx: AchieverPromptContext): string {
  const rec = ctx.record;
  const lines: string[] = [
    'You are the GOAL ACHIEVER driving an objective toward a BINARY success criterion. Take exactly ONE move.',
    '',
    `GOAL: ${clip(rec.title, 200)}`
  ];
  if (rec.description) lines.push(`DETAILS: ${goalDetails(rec.description)}`);
  lines.push(`SUCCESS CRITERIA (strict Yes/No): ${ctx.successCriteria}`);
  lines.push(`BUDGET: ${ctx.budget.used}/${ctx.budget.cap} execution tasks used.`, '', 'PHASES:');

  // Results only for the phase in work and the one just audited. Everything older
  // is one line: its findings already reached the Achiever through the minutes.
  const audited = ctx.phases.filter(p => p.status === 'audited' || p.status === 'done');
  const lastAudited = audited[audited.length - 1]?.key;
  for (const ph of ctx.phases) {
    const detailed = ph.key === ctx.currentPhaseKey || ph.key === lastAudited;
    if (!detailed) {
      const done = ph.results.filter(r => r.status === 'done').length;
      lines.push(`- ${ph.key} [${ph.status}]: ${clip(ph.title, 90)}${ph.results.length ? ` (${done}/${ph.results.length} tasks done)` : ''}`);
      continue;
    }
    lines.push(`- ${ph.key} [${ph.status}]: ${clip(ph.title, 120)}`);
    // Newest results matter most, and a long phase must not eat the budget.
    for (const r of ph.results.slice(-5)) {
      const res = resultDigest(r.result, 400);
      lines.push(`    · ${clip(r.title, 90)} [${r.status}]${res ? ` → ${res}` : ''}`);
    }
    if (ph.results.length > 5) lines.push(`    · (${ph.results.length - 5} earlier tasks omitted)`);
  }

  if (ctx.nextMove) lines.push('', `NEXT MOVE (from the Judger's latest minutes): ${ctx.nextMove}`);
  if (rec.lastRejected) lines.push('', `LAST MOVE REJECTED: ${clip(rec.lastRejected.reason, 300)}`);

  const noPhase = !ctx.currentPhaseKey;
  lines.push('', noPhase
    ? 'NO WORKABLE PHASE: every phase is audited. Emit is not available. Plan the next phase, evaluate the criterion, or block.'
    : `Current workable phase: ${ctx.currentPhaseKey}. The last emitted task completes it and wakes the Judger.`, '');

  lines.push(ACHIEVER_TAIL, '', 'Moves:', EVALUATE, PLAN);
  if (!noPhase) lines.push(EMIT);
  lines.push(BLOCK);
  return lines.join('\n');
}

/** A token estimate good enough for a budget test: about 3.5 chars per token. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/** The "NEXT MOVE" section of a minutes file, capped. */
export function extractNextMove(minutes: string, cap = 600): string {
  // The LAST mention: the section ends the file, earlier ones are prose.
  const at = (minutes || '').toUpperCase().lastIndexOf('NEXT MOVE');
  if (at < 0) return '';
  const tail = minutes.slice(at + 'NEXT MOVE'.length).replace(/^[\s:*#_-]+/, '');
  return clip(tail, cap);
}
