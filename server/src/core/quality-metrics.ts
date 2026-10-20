/**
 * Quality metrics (plan §5) — the baseline table of the cowork improvement plan,
 * recomputed from `decisions/lessons.jsonl` plus the task store so every claim
 * about P0/P1 is checked against numbers rather than impressions.
 *
 * Pure aggregation: `computeQualityMetrics()` takes already-loaded lessons and
 * tasks and a window; `readLessons()` is the only I/O and tolerates a damaged
 * ledger (NUL-padded or truncated lines are skipped, never thrown).
 *
 * Served as GET /api/metrics/quality?days=7 (or ?from=&to=).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../types.js';
import type { Lesson } from './lessons.js';
import { isRateLimitFailure } from './result-verifier.js';
import { taskTier } from './tiers.js';

export type RejectionClass = 'rateLimit' | 'timeout' | 'exitCode' | 'quality' | 'other';
export type WaitInputClass = 'humanOnly' | 'permissionChoice' | 'other';

/** A rate-limit hit counts as a "repeat" when the same brain hit one this recently. */
export const REPEAT_WINDOW_MS = 30 * 60_000;

const RATE_LIMIT_RE = /session limit|weekly limit|usage limit|quota|rate[- ]?limit|too many requests|out of credits|overloaded|high traffic|you('ve| have) (hit|reached) your|\b429\b/i;
const TIMEOUT_RE = /\btime(d)?[ -]?out\b|timeout/i;
const EXIT_CODE_RE = /^\s*exit code\b|process exited|spawn .*(failed|error)/i;
const QUALITY_RE = /^\s*verifier LLM:|spec verifier|CHANGES_REQUESTED|quality/i;

/** Bucket one verifier rejection reason. Order matters: a timeout message that
 *  mentions a quota is still a rate limit (that is what the breaker acts on). */
export function classifyRejection(reason: string): RejectionClass {
  const r = reason || '';
  if (isRateLimitFailure(r) || RATE_LIMIT_RE.test(r)) return 'rateLimit';
  if (TIMEOUT_RE.test(r)) return 'timeout';
  if (EXIT_CODE_RE.test(r)) return 'exitCode';
  if (QUALITY_RE.test(r)) return 'quality';
  return 'other';
}

// Things only the owner can do: sign in, click a mailed link, upload, pay, an
// owner-only toggle. Checked first — a "May I…?" that needs a login is human-only.
const HUMAN_ONLY_RE = /log ?in|sign ?in|re-?auth|oauth|password|passcode|2fa|otp|captcha|verification (link|code|email)|verify (your|the) (email|account)|click (the|a)? ?(link|button)|browser|upload|attach|scan|qr|credit card|payment|pay |purchase|billing|token|api key|credential|cookie|登入|登錄|驗證|上傳|付款|授權|密碼/i;
// Permission / choice questions an autonomous delegate can rule on (ADR-009, P0-4).
const PERMISSION_CHOICE_RE = /^\s*(may i|can i|shall i|should i|do you want|would you like|want me to|ok to|okay to|is it ok|proceed\??|which\b|choose|pick|prefer|option [a-z0-9])|\b(should i|shall i|may i|or should|which (one|option)|do you want me|would you prefer|go ahead)\b|是否|要不要|要我|請選擇|選哪|可以.*嗎|還是/i;

/** Bucket one wait-input parking by its questions (keyword heuristic). */
export function classifyWaitInput(questions: string[] | undefined, reason = ''): WaitInputClass {
  const text = [...(questions || []), reason].join('\n');
  if (!text.trim()) return 'other';
  if (HUMAN_ONLY_RE.test(text)) return 'humanOnly';
  if (PERMISSION_CHOICE_RE.test(text)) return 'permissionChoice';
  return 'other';
}

/** Read the ledger; unparseable lines are skipped (counted in `skipped`). */
export function readLessons(decisionsDir: string): { lessons: Lesson[]; skipped: number } {
  let raw = '';
  try { raw = readFileSync(join(decisionsDir, 'lessons.jsonl'), 'utf-8'); } catch { return { lessons: [], skipped: 0 }; }
  const lessons: Lesson[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const l = line.replace(/\u0000/g, '').trim();
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (e && typeof e.at === 'string' && typeof e.kind === 'string') lessons.push(e); else skipped++;
    } catch { skipped++; }
  }
  return { lessons, skipped };
}

const pct = (n: number, d: number) => d ? Math.round((n / d) * 1000) / 10 : null;
const ms = (s?: string) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : NaN; };
const inWin = (t: number, from: number, to: number) => t >= from && t <= to;

export interface AcceptanceBySource {
  human: { withAcceptance: number; pct: number | null };
  sharpened: { withAcceptance: number; pct: number | null };
}

export interface SpecVerdictSourceInputs {
  total: number;
  judged: number;
  approved: number;
  changesRequested: number;
  unverifiable: number;
}

export interface SpecVerdictMetrics {
  total: number;
  bySource: {
    human: SpecVerdictSourceInputs;
    sharpened: SpecVerdictSourceInputs;
  };
}

export interface QualityMetrics {
  window: { from: string; to: string; days: number; weeks: number };
  rejections: { total: number; byClass: Record<RejectionClass, number>; byClassPct: Record<RejectionClass, number | null> };
  repeatRateLimit: { hits: number; repeats: number; share: number | null; windowMin: number };
  waitInput: { total: number; permissionChoice: number; humanOnly: number; other: number };
  blocked: number;
  done: { count: number; withEvidence: number; evidencePct: number | null; doneWithConcerns: number };
  acceptance: { tasks: number; withAcceptance: number; pct: number | null; bySource: AcceptanceBySource };
  specVerdicts: SpecVerdictMetrics;
  timeouts: { count: number; perWeek: number | null };
  tiers: { tagged: number; byTier: Record<string, number>; mechanicalAttempts: number; mechanicalOpusAttempts: number; mechanicalOpusShare: number | null };
  sources: { lessons: number; lessonsSkipped: number; tasks: number };
}

/**
 * Compute the plan §2 table for [from, to]. Lessons are bucketed by `at`;
 * done tasks by completedAt (fallback createdAt); acceptance coverage by
 * createdAt over tasks that were dispatched to a brain (scheduled templates and
 * human-only cards excluded).
 */
export function computeQualityMetrics(
  lessons: Lesson[], tasks: Task[], from: number, to: number, opts: { lessonsSkipped?: number } = {}
): QualityMetrics {
  const days = Math.max(0, (to - from) / 86_400_000);
  const weeks = days / 7;
  const inRange = lessons.filter(l => inWin(ms(l.at), from, to)).sort((a, b) => ms(a.at) - ms(b.at));

  const byClass: Record<RejectionClass, number> = { rateLimit: 0, timeout: 0, exitCode: 0, quality: 0, other: 0 };
  const lastRateLimit = new Map<string, number>();
  // Seed the breaker memory with hits just before the window so the first in-window
  // repeat is still recognised.
  for (const l of lessons) {
    const t = ms(l.at);
    if (l.kind === 'verify-fail' && t < from && t >= from - REPEAT_WINDOW_MS && classifyRejection(l.reason) === 'rateLimit') {
      lastRateLimit.set(l.brain, Math.max(lastRateLimit.get(l.brain) ?? 0, t));
    }
  }
  let hits = 0, repeats = 0, rejections = 0, blocked = 0;
  const wait = { total: 0, permissionChoice: 0, humanOnly: 0, other: 0 };
  for (const l of inRange) {
    if (l.kind === 'verify-fail') {
      rejections++;
      const c = classifyRejection(l.reason);
      byClass[c]++;
      if (c === 'rateLimit') {
        hits++;
        const t = ms(l.at), prev = lastRateLimit.get(l.brain);
        if (prev !== undefined && t - prev < REPEAT_WINDOW_MS) repeats++;
        lastRateLimit.set(l.brain, t);
      }
    } else if (l.kind === 'wait-input') {
      wait.total++;
      wait[classifyWaitInput(l.questions, l.reason)]++;
    } else if (l.kind === 'blocked') blocked++;
  }
  const byClassPct = Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, pct(v, rejections)])) as Record<RejectionClass, number | null>;

  let doneCount = 0, withEvidence = 0, concerns = 0;
  let created = 0, withAcceptance = 0;
  let humanWithAcceptance = 0, sharpenedWithAcceptance = 0;
  const specVerdicts: SpecVerdictMetrics = {
    total: 0,
    bySource: {
      human: { total: 0, judged: 0, approved: 0, changesRequested: 0, unverifiable: 0 },
      sharpened: { total: 0, judged: 0, approved: 0, changesRequested: 0, unverifiable: 0 },
    }
  };
  const byTier: Record<string, number> = {};
  let tagged = 0, mechAttempts = 0, mechOpus = 0;
  for (const t of tasks) {
    const ctx = (t.context || {}) as Record<string, any>;
    if (t.status === 'done' && inWin(ms(t.completedAt) || ms(t.createdAt), from, to)) {
      doneCount++;
      if (ctx.hasEvidence === true) withEvidence++;
      if (ctx.resultStatus === 'DONE_WITH_CONCERNS' || ctx.qualityFlag === 'concerns') concerns++;
    }
    if (inWin(ms(t.createdAt), from, to)) {
      if (ctx.dispatched || ctx.ranBrain || ctx.attempts) {
        created++;
        if (Array.isArray(ctx.acceptance) && ctx.acceptance.length) {
          withAcceptance++;
          if (ctx.acceptanceSource === 'sharpened') sharpenedWithAcceptance++;
          else humanWithAcceptance++;
        }
      }
      const tier = taskTier(ctx);
      if (tier) {
        tagged++;
        byTier[tier] = (byTier[tier] || 0) + 1;
        if (tier === 'mechanical') {
          const tried = [
            ...(Array.isArray(ctx.failedBrains) ? ctx.failedBrains.map((f: any) => (typeof f === 'string' ? f : f?.brain) || '') : []),
            ...(typeof ctx.ranBrain === 'string' ? [ctx.ranBrain] : [])
          ].filter(Boolean);
          mechAttempts += tried.length;
          mechOpus += tried.filter((b: string) => /opus/i.test(b)).length;
        }
      }
    }
    if (ctx.specVerdict) {
      const svAt = ms(ctx.specVerdict.at) || ms(t.completedAt) || ms(t.createdAt);
      if (inWin(svAt, from, to)) {
        const srcKey = ctx.acceptanceSource === 'sharpened' ? 'sharpened' : 'human';
        specVerdicts.total++;
        specVerdicts.bySource[srcKey].total++;
        const v = String(ctx.specVerdict.verdict || '').toUpperCase();
        if (v === 'APPROVED') {
          specVerdicts.bySource[srcKey].approved++;
          specVerdicts.bySource[srcKey].judged++;
        } else if (v === 'CHANGES_REQUESTED') {
          specVerdicts.bySource[srcKey].changesRequested++;
          specVerdicts.bySource[srcKey].judged++;
        } else if (v === 'UNVERIFIABLE') {
          specVerdicts.bySource[srcKey].unverifiable++;
        }
      }
    }
  }

  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: Math.round(days * 10) / 10, weeks: Math.round(weeks * 100) / 100 },
    rejections: { total: rejections, byClass, byClassPct },
    repeatRateLimit: { hits, repeats, share: pct(repeats, hits), windowMin: REPEAT_WINDOW_MS / 60_000 },
    waitInput: wait,
    blocked,
    done: { count: doneCount, withEvidence, evidencePct: pct(withEvidence, doneCount), doneWithConcerns: concerns },
    acceptance: {
      tasks: created,
      withAcceptance,
      pct: pct(withAcceptance, created),
      bySource: {
        human: { withAcceptance: humanWithAcceptance, pct: pct(humanWithAcceptance, created) },
        sharpened: { withAcceptance: sharpenedWithAcceptance, pct: pct(sharpenedWithAcceptance, created) },
      }
    },
    specVerdicts,
    timeouts: { count: byClass.timeout, perWeek: weeks > 0 ? Math.round((byClass.timeout / weeks) * 10) / 10 : null },
    tiers: { tagged, byTier, mechanicalAttempts: mechAttempts, mechanicalOpusAttempts: mechOpus, mechanicalOpusShare: pct(mechOpus, mechAttempts) },
    sources: { lessons: inRange.length, lessonsSkipped: opts.lessonsSkipped ?? 0, tasks: tasks.length }
  };
}

/** Parse ?days= / ?from= / ?to= into an epoch window. Default: last 7 days. */
export function metricsWindow(q: { days?: unknown; from?: unknown; to?: unknown }, now = Date.now()): { from: number; to: number } {
  const to = typeof q.to === 'string' && Number.isFinite(Date.parse(q.to)) ? Date.parse(q.to) : now;
  if (typeof q.from === 'string' && Number.isFinite(Date.parse(q.from))) return { from: Date.parse(q.from), to };
  const d = Number(q.days);
  const days = Number.isFinite(d) && d > 0 ? Math.min(d, 3650) : 7;
  return { from: to - days * 86_400_000, to };
}
