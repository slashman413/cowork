import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecurrence,
  recurrenceFromLegacyHours,
  nextRunAt,
  nextCron,
  parseCron,
  describeRecurrence,
  type TaskRecurrence,
} from './recurrence.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/* ------------------------------------------------------------- normalize --- */

test('normalizeRecurrence returns undefined for absent / none', () => {
  assert.equal(normalizeRecurrence(undefined), undefined);
  assert.equal(normalizeRecurrence(null), undefined);
  assert.equal(normalizeRecurrence({ type: '' }), undefined);
  assert.equal(normalizeRecurrence({ type: 'none' }), undefined);
});

test('normalizeRecurrence defaults interval to 1 and validates it', () => {
  assert.deepEqual(normalizeRecurrence({ type: 'hours' }), { type: 'hours', interval: 1 });
  assert.throws(() => normalizeRecurrence({ type: 'hours', interval: 0 }), /whole number >= 1/);
  assert.throws(() => normalizeRecurrence({ type: 'hours', interval: 1.5 }), /whole number >= 1/);
  assert.throws(() => normalizeRecurrence({ type: 'bogus' }), /Invalid recurrence type/);
});

test('normalizeRecurrence validates weekly weekdays and monthly dayOfMonth', () => {
  assert.deepEqual(
    normalizeRecurrence({ type: 'weekly', weekdays: [5, 1, 1, 3], atTime: '9:05' }),
    { type: 'weekly', interval: 1, atTime: '09:05', weekdays: [1, 3, 5] });
  assert.throws(() => normalizeRecurrence({ type: 'weekly', weekdays: [7] }), /0 \(Sun\)/);
  assert.throws(() => normalizeRecurrence({ type: 'monthly', dayOfMonth: 32 }), /1\.\.31/);
  assert.throws(() => normalizeRecurrence({ type: 'daily', atTime: '25:00' }), /hours 0-23/);
});

test('normalizeRecurrence requires and validates a cron expr', () => {
  assert.deepEqual(normalizeRecurrence({ type: 'cron', expr: '0 9 * * 1-5' }), { type: 'cron', expr: '0 9 * * 1-5' });
  assert.throws(() => normalizeRecurrence({ type: 'cron' }), /needs an `expr`/);
  assert.throws(() => normalizeRecurrence({ type: 'cron', expr: '0 9 * *' }), /5 fields/);
});

test('recurrenceFromLegacyHours bridges loopIntervalHours', () => {
  assert.deepEqual(recurrenceFromLegacyHours(24), { type: 'hours', interval: 24 });
  assert.equal(recurrenceFromLegacyHours(0), undefined);
  assert.equal(recurrenceFromLegacyHours(undefined), undefined);
});

/* --------------------------------------------------- fixed-rate intervals --- */

test('minute/hour intervals are FIXED-RATE — not delayed by execution time', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');
  // The run fired at 09:00 and took 20 min; "now" is 09:20 when it completes.
  const now = new Date(anchor.getTime() + 20 * MIN);
  // Every 60 min → next is 10:00, NOT 10:20 (execution time did not push it).
  const next = nextRunAt({ type: 'minutes', interval: 60 }, anchor, now)!;
  assert.equal(next.getTime(), anchor.getTime() + 60 * MIN);
});

test('interval catches up past now when a run overruns its interval', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');
  // Every 5 min, but the run took 12 min → now is 09:12; next future slot is 09:15.
  const now = new Date(anchor.getTime() + 12 * MIN);
  const next = nextRunAt({ type: 'minutes', interval: 5 }, anchor, now)!;
  assert.equal(next.getTime(), anchor.getTime() + 15 * MIN, 'skips whole intervals, preserves phase');
  assert.ok(next.getTime() > now.getTime());
});

test('hour interval preserves phase across a fast run', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');
  const now = new Date(anchor.getTime() + 3 * MIN);
  const next = nextRunAt({ type: 'hours', interval: 2 }, anchor, now)!;
  assert.equal(next.getTime(), anchor.getTime() + 2 * HOUR);
});

/* ---------------------------------------------------------- daily/weekly --- */

test('daily at a fixed wall-clock time, skipping today if already past', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');   // 09:00 local
  const now = new Date('2026-08-26T09:05:00+08:00');
  const next = nextRunAt({ type: 'daily', interval: 1, atTime: '09:00' }, anchor, now)!;
  assert.equal(next.getTime(), new Date('2026-08-27T09:00:00+08:00').getTime());
});

test('every-3-days keeps its phase off the anchor date', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');
  const now = new Date('2026-08-26T09:05:00+08:00');
  const next = nextRunAt({ type: 'daily', interval: 3, atTime: '09:00' }, anchor, now)!;
  assert.equal(next.getTime(), new Date('2026-08-29T09:00:00+08:00').getTime());
});

test('weekly on specific weekdays fires on the next listed day', () => {
  // 2026-08-26 is a Wednesday (3). Fire Mon/Wed/Fri at 09:00.
  const anchor = new Date('2026-08-26T09:00:00+08:00');
  const now = new Date('2026-08-26T09:05:00+08:00');
  const next = nextRunAt({ type: 'weekly', interval: 1, weekdays: [1, 3, 5], atTime: '09:00' }, anchor, now)!;
  assert.equal(next.getDay(), 5, 'next is Friday');
  assert.equal(next.getTime(), new Date('2026-08-28T09:00:00+08:00').getTime());
});

test('plain weekly (no weekdays) repeats on the anchor weekday a week later', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');   // Wednesday
  const now = new Date('2026-08-26T09:05:00+08:00');
  const next = nextRunAt({ type: 'weekly', interval: 1, atTime: '09:00' }, anchor, now)!;
  assert.equal(next.getTime(), new Date('2026-09-02T09:00:00+08:00').getTime());
});

test('every-2-weeks only fires in active weeks', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');   // Wednesday, week 0
  const now = new Date('2026-08-26T09:05:00+08:00');
  const next = nextRunAt({ type: 'weekly', interval: 2, weekdays: [3], atTime: '09:00' }, anchor, now)!;
  // Skips the next Wednesday (week 1); fires 2 weeks out.
  assert.equal(next.getTime(), new Date('2026-09-09T09:00:00+08:00').getTime());
});

/* --------------------------------------------------------------- monthly --- */

test('monthly on a day-of-month, clamped to short months', () => {
  const anchor = new Date('2026-01-31T09:00:00+08:00');
  const now = new Date('2026-01-31T09:05:00+08:00');
  const next = nextRunAt({ type: 'monthly', interval: 1, dayOfMonth: 31, atTime: '09:00' }, anchor, now)!;
  // February 2026 has 28 days → clamps to Feb 28.
  assert.equal(next.getTime(), new Date('2026-02-28T09:00:00+08:00').getTime());
});

test('every-2-months keeps its month phase', () => {
  const anchor = new Date('2026-03-15T09:00:00+08:00');
  const now = new Date('2026-03-15T09:05:00+08:00');
  const next = nextRunAt({ type: 'monthly', interval: 2, dayOfMonth: 15, atTime: '09:00' }, anchor, now)!;
  assert.equal(next.getTime(), new Date('2026-05-15T09:00:00+08:00').getTime());
});

/* ------------------------------------------------------------------ cron --- */

test('cron parse rejects malformed and out-of-range expressions', () => {
  assert.throws(() => parseCron('0 9 * *'), /5 fields/);
  assert.throws(() => parseCron('99 9 * * *'), /out of range/);
  assert.doesNotThrow(() => parseCron('*/15 9-17 * * 1-5'));
});

test('cron: weekdays at 09:00 ("by calendar")', () => {
  // Fri 2026-08-28 09:05 → next weekday 09:00 is Mon 2026-08-31.
  const after = new Date('2026-08-28T09:05:00+08:00').getTime();
  const next = nextCron('0 9 * * 1-5', after)!;
  assert.equal(next.getTime(), new Date('2026-08-31T09:00:00+08:00').getTime());
});

test('cron: every 15 minutes within business hours', () => {
  const after = new Date('2026-08-26T09:07:00+08:00').getTime();
  const next = nextCron('*/15 9-17 * * *', after)!;
  assert.equal(next.getTime(), new Date('2026-08-26T09:15:00+08:00').getTime());
});

test('cron on a specific calendar date', () => {
  const after = new Date('2026-08-01T00:00:00+08:00').getTime();
  const next = nextCron('30 8 25 12 *', after)!;   // 25 Dec 08:30
  assert.equal(next.getTime(), new Date('2026-12-25T08:30:00+08:00').getTime());
});

test('cron via nextRunAt respects now and the until cutoff', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');
  const rec: TaskRecurrence = { type: 'cron', expr: '0 9 * * *', until: '2026-08-27T00:00:00+08:00' };
  // Next 09:00 after now is 2026-08-27 09:00, which is past `until` → series ends.
  assert.equal(nextRunAt(rec, anchor, new Date('2026-08-26T09:05:00+08:00')), null);
});

/* ---------------------------------------------------------------- until --- */

test('until ends the series once the next slot would fall at/after it', () => {
  const anchor = new Date('2026-08-26T09:00:00+08:00');
  const rec: TaskRecurrence = { type: 'daily', interval: 1, atTime: '09:00', until: '2026-08-28T00:00:00+08:00' };
  const day1 = nextRunAt(rec, anchor, new Date('2026-08-26T09:05:00+08:00'))!;
  assert.equal(day1.getTime(), new Date('2026-08-27T09:00:00+08:00').getTime());
  // From the 27th, the next would be the 28th 09:00 ≥ until → null.
  const day2 = nextRunAt(rec, day1, new Date('2026-08-27T09:05:00+08:00'));
  assert.equal(day2, null);
});

/* ------------------------------------------------------------- describe --- */

test('describeRecurrence gives readable labels', () => {
  assert.equal(describeRecurrence({ type: 'minutes', interval: 1 }), 'every minute');
  assert.equal(describeRecurrence({ type: 'hours', interval: 6 }), 'every 6 hours');
  assert.equal(describeRecurrence({ type: 'daily', interval: 1, atTime: '09:00' }), 'every day at 09:00');
  assert.equal(describeRecurrence({ type: 'weekly', interval: 1, weekdays: [1, 3, 5], atTime: '09:00' }), 'weekly on Mon/Wed/Fri at 09:00');
  assert.equal(describeRecurrence({ type: 'monthly', interval: 2, dayOfMonth: 15 }), 'every 2 months on day 15');
  assert.equal(describeRecurrence({ type: 'cron', expr: '0 9 * * 1-5' }), 'cron "0 9 * * 1-5"');
});
