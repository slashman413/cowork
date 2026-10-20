import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Brain-level rate-limit circuit breaker (plan item P0-1).
 *
 * When a brain answers with a rate-limit / session-limit notice, the dispatcher
 * records a COOLDOWN for that brain until its usage window resets (parsed from
 * the notice when it carries one, else a fixed default). Cooling brains are
 * skipped by the chain planner exactly like disabled rungs, so a capped brain
 * is not hit again seconds later by the next task (64% of measured rate-limit
 * rejections were such repeat hits). Cooldowns are persisted so a redeploy
 * doesn't forget a capped brain.
 */

export interface BrainCooldown {
  /** ISO time the brain becomes dispatchable again. */
  until: string;
  /** ISO time the cooldown was recorded. */
  since: string;
  /** Short reason (the rate-limit notice that tripped the breaker). */
  reason: string;
}

/** Parsed reset times further out than this are treated as unparseable (a
 *  weekly limit is the longest window seen; anything beyond is a misparse). */
const MAX_RESET_AHEAD_MS = 8 * 24 * 3600 * 1000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Wall-clock fields of `instant` in time zone `tz` (undefined = server local). */
function wallParts(instant: number, tz?: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(instant))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** UTC epoch ms of a wall-clock time in `tz` (handles DST via a second pass). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const w = wallParts(t, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return utc;
}

function validTz(tz?: string): string | undefined {
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}

const UNIT_MS: Record<string, number> = { d: 86400e3, h: 3600e3, m: 60e3, s: 1e3 };

/** "2h46m24s", "2 hours 5 minutes", "30m", "a minute" → ms (undefined if none). */
function parseDuration(s: string): number | undefined {
  const t = s.trim().toLowerCase();
  if (/^an? (minute|min)\b/.test(t)) return 60e3;
  if (/^an? (hour|hr)\b/.test(t)) return 3600e3;
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m(?!s)|seconds?|secs?|s)(?![a-z])/g;
  let total = 0, any = false, m: RegExpExecArray | null;
  while ((m = re.exec(t))) { total += Number(m[1]) * UNIT_MS[m[2][0]]; any = true; }
  return any ? total : undefined;
}

/**
 * Parse when a rate-limit window resets from a provider's notice. Shapes seen
 * in decisions/lessons.jsonl (plus common HTTP-style ones):
 *   - "You've hit your session limit · resets 9pm (Asia/Taipei)"
 *   - "You've hit your session limit · resets 6:10am (Asia/Taipei)"
 *   - "You've hit your weekly limit · resets Aug 6, 5pm (Asia/Taipei)"
 *   - "Individual quota reached. … Resets in 2h46m24s."
 *   - "try again in 2h" / "try again in a minute" / "retry-after: 120"
 *   - "resets at 2026-10-20T06:10:00Z"
 * A wall-clock time without a date is the NEXT occurrence of it in the given
 * zone (server local when absent). Returns epoch ms, or undefined when no
 * plausible future reset (≤ 8 days out) is found.
 */
export function parseRateLimitReset(text: string, now = Date.now()): number | undefined {
  const s = text || '';
  const plausible = (t: number) => Number.isFinite(t) && t > now && t - now <= MAX_RESET_AHEAD_MS ? t : undefined;

  // ISO timestamp after "reset(s) (at)".
  const iso = /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(s);
  if (iso) { const t = plausible(Date.parse(iso[1])); if (t) return t; }

  // Relative: "resets in 2h46m24s", "try again in 2 hours", "retry in 30m".
  const rel = /(?:resets?|try again|retry)\s+in\s+((?:an?\s+(?:minute|min|hour|hr)\b)|(?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(s);
  if (rel) { const d = parseDuration(rel[1]); if (d !== undefined) { const t = plausible(now + d); if (t) return t; } }

  // HTTP Retry-After (seconds).
  const ra = /retry[- ]after["']?\s*[:=]?\s*(\d+)\s*(s|sec|secs|seconds)?\b/i.exec(s);
  if (ra) { const t = plausible(now + Number(ra[1]) * 1000); if (t) return t; }

  // Wall clock: "resets [at] [Aug 6, ]5pm|6:10am|17:00 [(Area/City)]".
  const wc = /resets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\))?/i.exec(s);
  if (wc && (wc[5] || wc[4])) {
    const tz = validTz(wc[6]);
    let h = Number(wc[3]);
    const mi = wc[4] ? Number(wc[4]) : 0;
    const ap = (wc[5] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || mi > 59) return undefined;
    const today = wallParts(now, tz);
    if (wc[1] && wc[2]) {
      const mo = MONTHS.indexOf(wc[1].toLowerCase()) + 1;
      if (mo < 1) return undefined;
      let t = zonedToUtc(today.y, mo, Number(wc[2]), h, mi, tz);
      if (t < now - 86400e3) t = zonedToUtc(today.y + 1, mo, Number(wc[2]), h, mi, tz);
      return plausible(t);
    }
    let t = zonedToUtc(today.y, today.mo, today.d, h, mi, tz);
    if (t <= now) t = zonedToUtc(today.y, today.mo, today.d + 1, h, mi, tz);
    return plausible(t);
  }
  return undefined;
}

/** Per-brain cooldown registry, persisted to a small JSON file (optional). */
export class BrainCooldowns {
  private map = new Map<string, BrainCooldown>();

  constructor(private file?: string) {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      for (const [id, c] of Object.entries(data || {})) {
        const cd = c as BrainCooldown;
        if (cd && typeof cd.until === 'string' && Number.isFinite(Date.parse(cd.until))) this.map.set(id, cd);
      }
      this.prune();
    } catch { /* no file yet */ }
  }

  /** Trip the breaker for `brainId` until `untilMs`. Never shortens an active cooldown. */
  set(brainId: string, untilMs: number, reason: string, now = Date.now()): BrainCooldown {
    const prev = this.map.get(brainId);
    if (prev && Date.parse(prev.until) >= untilMs) return prev;
    const cd: BrainCooldown = { until: new Date(untilMs).toISOString(), since: new Date(now).toISOString(), reason: reason.slice(0, 200) };
    this.map.set(brainId, cd);
    this.save();
    return cd;
  }

  /** Epoch ms the brain cools until, or undefined when it is dispatchable. */
  until(brainId: string, now = Date.now()): number | undefined {
    const cd = this.map.get(brainId);
    if (!cd) return undefined;
    const t = Date.parse(cd.until);
    if (t > now) return t;
    this.map.delete(brainId);   // expired → re-enabled
    this.save();
    return undefined;
  }

  clear(brainId: string): void {
    if (this.map.delete(brainId)) this.save();
  }

  /** Active cooldowns only. */
  snapshot(now = Date.now()): Record<string, BrainCooldown> {
    this.prune(now);
    return Object.fromEntries(this.map);
  }

  private prune(now = Date.now()): void {
    let changed = false;
    for (const [id, cd] of this.map) if (Date.parse(cd.until) <= now) { this.map.delete(id); changed = true; }
    if (changed) this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch { /* best-effort; an in-memory cooldown still applies */ }
  }
}
