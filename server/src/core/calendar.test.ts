import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, MAX_FIRES_PER_SERIES } from './calendar.js';
import type { Task } from '../types.js';

/**
 * buildCalendar projects the store onto a time window for the Calendar page.
 * The future half MUST walk a recurring scheduler with the dispatcher's own
 * nextRunAt, so what the calendar shows is what will actually fire.
 */
function mk(t: Partial<Task>): Task {
  return {
    id: 'x', title: 't', description: 'd',
    from: { platform: 'p', agent: 'a' }, to: {},
    priority: 'normal', status: 'done', createdAt: '2026-10-01T00:00:00.000Z',
    ...t,
  } as Task;
}

const NOW = new Date('2026-10-13T12:00:00.000Z');
const FROM = new Date('2026-10-12T00:00:00.000Z');
const TO = new Date('2026-10-19T00:00:00.000Z');

test('one-shot scheduled task appears once, as the movable head', () => {
  const cal = buildCalendar([mk({ id: 'a', status: 'scheduled', scheduledAt: '2026-10-16T09:00:00.000Z' })], FROM, TO, NOW);
  assert.equal(cal.events.length, 1);
  assert.deepEqual(
    { id: cal.events[0].id, kind: cal.events[0].kind, status: cal.events[0].status, head: cal.events[0].head },
    { id: 'a', kind: 'planned', status: 'scheduled', head: true });
  assert.equal(cal.series[0].recurring, false);
  assert.equal(cal.series[0].cadence, 'once');
});

test('hourly cadence expands to every fire in the window, ids unique', () => {
  const cal = buildCalendar([mk({
    id: 'h', status: 'scheduled', scheduledAt: '2026-10-13T13:00:00.000Z',
    recurrence: { type: 'hours', interval: 24 },
  })], FROM, TO, NOW);
  // 13th..18th at 13:00Z = 6 fires before the 19th.
  assert.equal(cal.events.length, 6);
  assert.equal(new Set(cal.events.map(e => e.id)).size, 6);
  assert.equal(cal.events[0].head, true);
  assert.equal(cal.events[1].head, undefined);
  assert.equal(cal.events[5].start, '2026-10-18T13:00:00.000Z');
  assert.equal(cal.series[0].firesInWindow, 6);
});

test('fires before the window are skipped but the walk continues into it', () => {
  const cal = buildCalendar([mk({
    id: 'h', status: 'scheduled', scheduledAt: '2026-10-13T13:00:00.000Z',
    recurrence: { type: 'hours', interval: 24 },
  })], new Date('2026-10-16T00:00:00.000Z'), TO, NOW);
  assert.deepEqual(cal.events.map(e => e.start),
    ['2026-10-16T13:00:00.000Z', '2026-10-17T13:00:00.000Z', '2026-10-18T13:00:00.000Z']);
});

test('dense cadences are capped and reported truncated', () => {
  const cal = buildCalendar([mk({
    id: 'm', status: 'scheduled', scheduledAt: '2026-10-13T12:05:00.000Z',
    recurrence: { type: 'minutes', interval: 5 },
  })], FROM, TO, NOW);
  assert.equal(cal.events.length, MAX_FIRES_PER_SERIES);
  assert.equal(cal.series[0].truncated, true);
});

test('until cutoff ends the series', () => {
  const cal = buildCalendar([mk({
    id: 'u', status: 'scheduled', scheduledAt: '2026-10-13T13:00:00.000Z',
    recurrence: { type: 'hours', interval: 24, until: '2026-10-15T00:00:00.000Z' },
  })], FROM, TO, NOW);
  assert.equal(cal.events.length, 2);
});

test('a scheduled task past its launch time is flagged overdue, next fires resume after now', () => {
  const cal = buildCalendar([mk({
    id: 'o', status: 'scheduled', scheduledAt: '2026-10-12T06:00:00.000Z',
    recurrence: { type: 'hours', interval: 24 },
  })], FROM, TO, NOW);
  assert.equal(cal.events[0].status, 'overdue');
  assert.equal(cal.series[0].overdue, true);
  // Release at NOW re-arms phase-locked to 06:00Z, strictly after NOW.
  assert.equal(cal.events[1].start, '2026-10-14T06:00:00.000Z');
});

test('history: runs map to statuses, link to their series, feed lastRun', () => {
  const tasks = [
    mk({ id: 'p', status: 'scheduled', scheduledAt: '2026-10-14T00:00:00.000Z', recurrence: { type: 'hours', interval: 24 } }),
    mk({ id: 'r1', createdAt: '2026-10-12T00:00:00.000Z', completedAt: '2026-10-12T00:20:00.000Z', result: 'ok', context: { scheduledParentId: 'p' } }),
    mk({ id: 'r2', createdAt: '2026-10-13T00:00:00.000Z', completedAt: '2026-10-13T00:30:00.000Z', result: 'FAILED after 3 attempt(s)', context: { scheduledParentId: 'p' } }),
    mk({ id: 'q', status: 'in-progress', createdAt: '2026-10-13T11:00:00.000Z' }),
    mk({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T01:00:00.000Z' }),
  ];
  const cal = buildCalendar(tasks, FROM, TO, NOW);
  const byId = Object.fromEntries(cal.events.map(e => [e.id, e]));
  assert.equal(byId.r1.status, 'done');
  assert.equal(byId.r1.seriesId, 'p');
  assert.equal(byId.r1.end, '2026-10-12T00:20:00.000Z');
  assert.equal(byId.r2.status, 'failed');
  assert.equal(byId.q.status, 'running');
  assert.equal(byId.old, undefined, 'out-of-window history is dropped');
  assert.deepEqual(cal.series[0].lastRun, { taskId: 'r2', status: 'failed', at: '2026-10-13T00:00:00.000Z' });
});

test('a long run that started before the window still shows', () => {
  const cal = buildCalendar([mk({ id: 'l', createdAt: '2026-10-11T22:00:00.000Z', completedAt: '2026-10-12T02:00:00.000Z' })], FROM, TO, NOW);
  assert.equal(cal.events.length, 1);
});

test('garbled recurrence degrades to a one-shot instead of throwing', () => {
  const cal = buildCalendar([mk({ id: 'g', status: 'scheduled', scheduledAt: '2026-10-14T00:00:00.000Z', recurrence: { type: 'bogus' } as any })], FROM, TO, NOW);
  assert.equal(cal.events.length, 1);
  assert.equal(cal.series[0].recurring, false);
});
