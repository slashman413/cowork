/**
 * Recurrence — flexible cadences for periodic (looping) scheduled tasks.
 *
 * A task can recur by:
 *   - minutes / hours  → a fixed interval (every N minutes / N hours)
 *   - daily            → every N days at a wall-clock time
 *   - weekly           → every N weeks, on one or more weekdays, at a time
 *   - monthly          → every N months, on a day-of-month, at a time
 *   - cron             → a full 5-field cron expression ("by calendar")
 *
 * FIXED-RATE, NOT FIXED-DELAY. The next run is computed from the run's intended
 * fire time (the `anchor` — the completed task's `scheduledAt`), NOT from when it
 * finished. So if a run's execution takes less than the interval, the next run is
 * NOT pushed back by the execution time — the cadence keeps its original phase.
 * If a run overruns its interval (or the host was down), {@link nextRunAt} skips
 * whole intervals forward to the first slot still in the future, preventing a
 * burst of catch-up runs while preserving the cadence phase.
 *
 * Wall-clock fields (`atTime`, and every cron field) are interpreted in the
 * SERVER's local timezone — the same convention the rest of cowork's dashboards
 * use (the fleet runs on Taiwan time). `until` is an absolute ISO instant.
 *
 * This module is PURE: no I/O, no clock reads except the caller-supplied `now`.
 */

export type RecurrenceType = 'minutes' | 'hours' | 'daily' | 'weekly' | 'monthly' | 'cron';

export interface TaskRecurrence {
  type: RecurrenceType;
  /** Units between runs for minutes/hours/daily/weekly/monthly (integer >= 1).
   *  Ignored for `cron`. Defaults to 1 when omitted. */
  interval?: number;
  /** weekly: weekdays to fire on (0=Sunday .. 6=Saturday). Empty/absent means
   *  "the anchor's own weekday" (a plain weekly cadence). */
  weekdays?: number[];
  /** monthly: day of month 1..31, clamped to the target month's length (so 31
   *  lands on Feb 28/29). Absent means "the anchor's own day-of-month". */
  dayOfMonth?: number;
  /** daily/weekly/monthly: local wall-clock fire time "HH:MM" (24h). Absent means
   *  "the anchor's own wall-clock time". */
  atTime?: string;
  /** cron: standard 5-field expression "min hour dom mon dow" (local time).
   *  Supports wildcard, step (slash-n), range (a-b), list (a,b,c), and plain
   *  numbers per field. */
  expr?: string;
  /** Optional hard stop: no run is scheduled at or after this ISO instant. When
   *  the next computed occurrence would fall at/after `until`, the series ends. */
  until?: string;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Parse "HH:MM" → { hh, mm } (local wall-clock), or null when absent/blank. */
function parseAtTime(s: string | undefined): { hh: number; mm: number } | null {
  if (s == null || String(s).trim() === '') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Invalid atTime "${s}" — use 24-hour "HH:MM" (e.g. "09:30")`);
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`Invalid atTime "${s}" — hours 0-23, minutes 0-59`);
  return { hh, mm };
}

/** Days in a given local month (month is 0-based). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Validate + normalize a recurrence spec supplied by an API/UI caller. Returns
 * `undefined` for "no recurrence" (null / undefined / {type:'none'} / blank), a
 * clean spec otherwise. Throws Error with a human message on invalid input.
 */
export function normalizeRecurrence(input: any): TaskRecurrence | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object') throw new Error('recurrence must be an object');
  const type = String(input.type || '').trim();
  if (type === '' || type === 'none') return undefined;
  if (!['minutes', 'hours', 'daily', 'weekly', 'monthly', 'cron'].includes(type)) {
    throw new Error(`Invalid recurrence type "${type}" — one of minutes, hours, daily, weekly, monthly, cron`);
  }

  const out: TaskRecurrence = { type: type as RecurrenceType };

  if (type === 'cron') {
    const expr = String(input.expr || '').trim();
    if (!expr) throw new Error('cron recurrence needs an `expr` (5-field cron expression)');
    parseCron(expr);   // throws on a malformed expression
    out.expr = expr;
  } else {
    const interval = input.interval == null ? 1 : Number(input.interval);
    if (!Number.isFinite(interval) || interval < 1 || !Number.isInteger(interval)) {
      throw new Error(`recurrence interval must be a whole number >= 1 (got "${input.interval}")`);
    }
    out.interval = interval;

    const at = parseAtTime(input.atTime);
    if (at && (type === 'daily' || type === 'weekly' || type === 'monthly')) {
      out.atTime = `${String(at.hh).padStart(2, '0')}:${String(at.mm).padStart(2, '0')}`;
    }

    if (type === 'weekly' && input.weekdays != null) {
      if (!Array.isArray(input.weekdays)) throw new Error('recurrence.weekdays must be an array of 0-6');
      const days: number[] = Array.from(new Set(input.weekdays.map((d: any) => Number(d))) as Set<number>).sort((a, b) => a - b);
      for (const d of days) {
        if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error(`recurrence.weekdays entries must be 0 (Sun) .. 6 (Sat), got "${d}"`);
      }
      if (days.length) out.weekdays = days;
    }

    if (type === 'monthly' && input.dayOfMonth != null) {
      const dom = Number(input.dayOfMonth);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) throw new Error(`recurrence.dayOfMonth must be 1..31, got "${input.dayOfMonth}"`);
      out.dayOfMonth = dom;
    }
  }

  if (input.until != null && String(input.until).trim() !== '') {
    const at = Date.parse(String(input.until));
    if (!Number.isFinite(at)) throw new Error(`Invalid recurrence.until "${input.until}" — use an ISO 8601 date-time`);
    out.until = new Date(at).toISOString();
  }

  return out;
}

/** Bridge the legacy `loopIntervalHours` field to a recurrence spec. */
export function recurrenceFromLegacyHours(hours: number | undefined): TaskRecurrence | undefined {
  if (!hours || !(hours > 0)) return undefined;
  return { type: 'hours', interval: hours } as TaskRecurrence;
}

/**
 * Compute the next fire time for a recurrence, strictly AFTER `now` and phased on
 * `anchor` (the just-completed run's intended fire time). Returns a Date, or null
 * when the series has ended (its `until` cutoff has passed).
 *
 * @param anchor the reference fire time this cadence is phased on (usually the
 *   completed task's `scheduledAt`).
 * @param now    the current instant; the result is always > now so a returned run
 *   is genuinely in the future.
 */
export function nextRunAt(rec: TaskRecurrence, anchor: Date, now: Date = new Date()): Date | null {
  const nowMs = now.getTime();
  let next: Date | null;

  switch (rec.type) {
    case 'minutes': next = nextInterval(anchor, (rec.interval || 1) * MIN, nowMs); break;
    case 'hours':   next = nextInterval(anchor, (rec.interval || 1) * HOUR, nowMs); break;
    case 'daily':   next = nextDaily(rec, anchor, nowMs); break;
    case 'weekly':  next = nextWeekly(rec, anchor, nowMs); break;
    case 'monthly': next = nextMonthly(rec, anchor, nowMs); break;
    case 'cron':    next = nextCron(rec.expr!, Math.max(anchor.getTime(), nowMs)); break;
    default:        next = null;
  }

  if (!next) return null;
  if (rec.until && next.getTime() >= Date.parse(rec.until)) return null;
  return next;
}

/** Fixed-rate interval: anchor + k*step, smallest k>=1 giving a time > now. */
function nextInterval(anchor: Date, stepMs: number, nowMs: number): Date {
  const base = anchor.getTime();
  let t = base + stepMs;
  if (t <= nowMs) {
    // Skip whole intervals forward to the first future slot, preserving phase.
    const k = Math.floor((nowMs - base) / stepMs) + 1;
    t = base + k * stepMs;
    if (t <= nowMs) t += stepMs;   // guard against float edge at the boundary
  }
  return new Date(t);
}

/** Local wall-clock { hh, mm } to fire at — the spec's atTime, else the anchor's. */
function fireTime(rec: TaskRecurrence, anchor: Date): { hh: number; mm: number } {
  const at = parseAtTime(rec.atTime);
  return at || { hh: anchor.getHours(), mm: anchor.getMinutes() };
}

function nextDaily(rec: TaskRecurrence, anchor: Date, nowMs: number): Date {
  const step = rec.interval || 1;
  const { hh, mm } = fireTime(rec, anchor);
  // Phase origin: the anchor's local date at the fire time. n>=1 is the next run.
  let cand = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + step, hh, mm, 0, 0);
  while (cand.getTime() <= nowMs || cand.getTime() <= anchor.getTime()) {
    cand = new Date(cand.getFullYear(), cand.getMonth(), cand.getDate() + step, hh, mm, 0, 0);
  }
  return cand;
}

function nextWeekly(rec: TaskRecurrence, anchor: Date, nowMs: number): Date {
  const step = rec.interval || 1;
  const { hh, mm } = fireTime(rec, anchor);
  const weekdays = (rec.weekdays && rec.weekdays.length) ? rec.weekdays : [anchor.getDay()];
  // The week the anchor sits in, as a Sunday-based day index, is the phase origin.
  const anchorMidnight = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const weekStart0 = new Date(anchorMidnight.getFullYear(), anchorMidnight.getMonth(), anchorMidnight.getDate() - anchor.getDay());
  const DAY = 24 * HOUR;
  // Scan forward day-by-day from the day after the anchor; a bounded search of a
  // little over `interval` weeks always finds the next active weekday.
  const scanDays = 7 * step + 7;
  for (let i = 1; i <= scanDays + 7; i++) {
    const d = new Date(anchorMidnight.getFullYear(), anchorMidnight.getMonth(), anchorMidnight.getDate() + i, hh, mm, 0, 0);
    if (!weekdays.includes(d.getDay())) continue;
    const dMid = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const weekIndex = Math.round((dMid.getTime() - weekStart0.getTime()) / (7 * DAY));
    if (weekIndex % step !== 0) continue;   // not an active week for interval>1
    if (d.getTime() > nowMs && d.getTime() > anchor.getTime()) return d;
  }
  // Extremely defensive fallback (should never hit): jump a whole cycle.
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * step, hh, mm, 0, 0);
}

function nextMonthly(rec: TaskRecurrence, anchor: Date, nowMs: number): Date {
  const step = rec.interval || 1;
  const { hh, mm } = fireTime(rec, anchor);
  const dom = rec.dayOfMonth || anchor.getDate();
  const build = (year: number, month: number): Date => {
    const day = Math.min(dom, daysInMonth(year, month));
    return new Date(year, month, day, hh, mm, 0, 0);
  };
  for (let n = 1; n <= 1200; n++) {
    const cand = build(anchor.getFullYear(), anchor.getMonth() + step * n);
    if (cand.getTime() > nowMs && cand.getTime() > anchor.getTime()) return cand;
  }
  // Defensive fallback.
  return build(anchor.getFullYear(), anchor.getMonth() + step);
}

/* ------------------------------------------------------------------ cron --- */

interface CronSpec { minutes: Set<number>; hours: Set<number>; doms: Set<number>; months: Set<number>; dows: Set<number>; domRestricted: boolean; dowRestricted: boolean; }

/** Parse one cron field into the set of allowed values within [lo, hi]. */
function parseCronField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Invalid cron field "${field}"`);
    const [range, stepStr] = [m[1], m[2]];
    let start = lo, end = hi;
    if (range !== '*') {
      const bounds = range.split('-').map(Number);
      start = bounds[0];
      end = bounds.length > 1 ? bounds[1] : bounds[0];
    }
    const step = stepStr ? Number(stepStr) : 1;
    if (step < 1) throw new Error(`Invalid cron step in "${field}"`);
    if (start < lo || end > hi || start > end) throw new Error(`cron field "${field}" out of range ${lo}-${hi}`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression "min hour dom mon dow" (throws when invalid). */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression needs 5 fields "min hour dom mon dow", got ${fields.length} ("${expr}")`);
  return {
    minutes: parseCronField(fields[0], 0, 59),
    hours: parseCronField(fields[1], 0, 23),
    doms: parseCronField(fields[2], 1, 31),
    months: parseCronField(fields[3], 1, 12),
    dows: parseCronField(fields[4], 0, 6),
    domRestricted: fields[2].trim() !== '*',
    dowRestricted: fields[4].trim() !== '*',
  };
}

/**
 * Smallest cron-matching local time strictly after `afterMs`. Uses field-level
 * jumping (skip whole months/days/hours that cannot match) so the search is fast,
 * and caps at ~4 years to avoid an infinite loop on an unsatisfiable expression.
 */
export function nextCron(expr: string, afterMs: number): Date | null {
  const c = parseCron(expr);
  // Start at the next whole minute after `afterMs`.
  let d = new Date(Math.floor(afterMs / MIN) * MIN + MIN);
  const capMs = afterMs + 4 * 366 * 24 * HOUR;

  while (d.getTime() <= capMs) {
    if (!c.months.has(d.getMonth() + 1)) {
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);   // jump to next month
      continue;
    }
    // Day-of-month vs day-of-week: standard cron ORs them when BOTH are
    // restricted; ANDs (i.e. both must pass) when only one is restricted.
    const domOk = c.doms.has(d.getDate());
    const dowOk = c.dows.has(d.getDay());
    const dayOk = (c.domRestricted && c.dowRestricted) ? (domOk || dowOk)
      : (c.domRestricted ? domOk : (c.dowRestricted ? dowOk : true));
    if (!dayOk) {
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);   // next day
      continue;
    }
    if (!c.hours.has(d.getHours())) {
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0);   // next hour
      continue;
    }
    if (!c.minutes.has(d.getMinutes())) {
      d = new Date(d.getTime() + MIN);   // next minute
      continue;
    }
    return d;
  }
  return null;   // unsatisfiable within the horizon
}

/* --------------------------------------------------------------- describe --- */

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Short human label for a recurrence, for UI badges and dispatcher logs. */
export function describeRecurrence(rec: TaskRecurrence | undefined): string {
  if (!rec) return '';
  const n = rec.interval || 1;
  const every = (unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  switch (rec.type) {
    case 'minutes': return every('minute');
    case 'hours': return every('hour');
    case 'daily': return `${every('day')}${rec.atTime ? ` at ${rec.atTime}` : ''}`;
    case 'weekly': {
      const days = (rec.weekdays && rec.weekdays.length) ? rec.weekdays.map(d => WD[d]).join('/') : '';
      const base = n === 1 ? 'weekly' : `every ${n} weeks`;
      return `${base}${days ? ` on ${days}` : ''}${rec.atTime ? ` at ${rec.atTime}` : ''}`;
    }
    case 'monthly': {
      const base = n === 1 ? 'monthly' : `every ${n} months`;
      return `${base}${rec.dayOfMonth ? ` on day ${rec.dayOfMonth}` : ''}${rec.atTime ? ` at ${rec.atTime}` : ''}`;
    }
    case 'cron': return `cron "${rec.expr}"`;
    default: return '';
  }
}
