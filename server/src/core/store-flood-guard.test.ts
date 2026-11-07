import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store, isClosedWithoutRunning } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Recurring-task FLOOD GUARD. When agents are saturated or rate-limited, a
 * recurring scheduler used to spawn a new run-child every slot even while the
 * previous one was still queued, stacking duplicate pending tasks. Guards:
 *  1. coalesce — at most one run in flight per scheduler; a slot that fires
 *     while a run is outstanding is skipped (re-armed, counted).
 *  2. backlog — with >= maxPendingBacklog tasks pending, due schedulers are held
 *     (not dropped) until the queue drains.
 *  3. collapse — duplicates already queued are closed as SUPERSEDED.
 *  4. a failed run superseded by a newer cycle is reported as such (auto re-run skips it).
 */
function makeStore(scheduler?: any): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-flood-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'workflows', 'agencyAgents']) {
    paths[k] = path.join(root, k); fs.mkdirSync(paths[k], { recursive: true });
  }
  const config = { paths, platforms: {}, orchestration: { agents: {}, ...(scheduler ? { scheduler } : {}) } } as unknown as Config;
  return new Store(config, new EventBus());
}
const from = { platform: 'p', agent: 'a' };
const makeDue = (store: Store, id: string) => {
  const t = store.getTask(id)!; t.scheduledAt = new Date(Date.now() - 1000).toISOString(); store.saveTask(t);
};
const runsOf = (store: Store, pid: string) => store.listTasks().filter(t => t.context?.scheduledParentId === pid);

test('a slot that fires while the previous run is still pending is skipped, not duplicated', () => {
  const store = makeStore();
  const p = store.createTask({ title: 'Hourly', from, recurrence: { type: 'hours', interval: 1 } } as any);
  assert.equal(store.releaseDueScheduled().length, 1, 'first slot spawns its run');
  makeDue(store, p.id);                       // next slot fires; run #1 still pending
  assert.equal(store.releaseDueScheduled().length, 0, 'no second run while #1 is queued');
  assert.equal(runsOf(store, p.id).length, 1, 'still exactly one run-child');
  const parent = store.getTask(p.id)!;
  assert.equal(parent.status, 'scheduled');
  assert.ok(Date.parse(parent.scheduledAt!) > Date.now(), 're-armed to the next slot');
  assert.equal(parent.context?.skippedRuns, 1);
  assert.match(parent.context?.lastSkipReason, /still pending/);
});

test('in-progress and wait-input runs also block a new spawn; a finished run does not', async () => {
  const store = makeStore();
  const p = store.createTask({ title: 'Hourly', from, recurrence: { type: 'hours', interval: 1 } } as any);
  const [run] = store.releaseDueScheduled();
  store.claimTask({ taskId: run.id, workerId: 'x', internal: true });
  makeDue(store, p.id);
  assert.equal(store.releaseDueScheduled().length, 0, 'in-progress blocks');
  await store.completeTask({ taskId: run.id, result: 'ok', internal: true });
  makeDue(store, p.id);
  assert.equal(store.releaseDueScheduled().length, 1, 'done run frees the slot');
});

test('allowOverlappingRuns and coalesceRuns:false restore the old overlap', () => {
  for (const [store, ctx] of [[makeStore(), { allowOverlappingRuns: true }], [makeStore({ coalesceRuns: false }), {}]] as const) {
    const p = store.createTask({ title: 'Hourly', from, context: ctx, recurrence: { type: 'hours', interval: 1 } } as any);
    store.releaseDueScheduled();
    makeDue(store, p.id);
    assert.equal(store.releaseDueScheduled().length, 1, 'overlap allowed');
    assert.equal(runsOf(store, p.id).length, 2);
  }
});

test('a deep pending backlog HOLDS due schedulers, then releases one run when it drains', async () => {
  const store = makeStore({ maxPendingBacklog: 3 });
  const fillers = [1, 2, 3].map(i => store.createTask({ title: `f${i}`, from } as any));
  const p = store.createTask({ title: 'Daily', from, recurrence: { type: 'daily' } } as any);
  assert.equal(store.releaseDueScheduled().length, 0, 'held: 3 pending >= limit 3');
  let parent = store.getTask(p.id)!;
  assert.equal(parent.status, 'scheduled');
  assert.ok(Date.parse(parent.scheduledAt!) <= Date.now(), 'still due (held, not skipped)');
  assert.equal(parent.context?.heldForBacklog, true);
  assert.equal(store.releaseDueScheduled().length, 0, 'still held on the next tick');

  await store.completeTask({ taskId: fillers[0].id, result: 'ok', internal: true });
  const rel = store.releaseDueScheduled();
  assert.equal(rel.length, 1, 'one run once the queue drained');
  parent = store.getTask(p.id)!;
  assert.equal(parent.context?.heldForBacklog, undefined, 'hold flag cleared');
  assert.ok(Date.parse(parent.scheduledAt!) > Date.now(), 're-armed after spawning');
});

test('backlog counts children spawned in the same tick (no burst past the limit)', () => {
  const store = makeStore({ maxPendingBacklog: 2 });
  for (let i = 0; i < 4; i++) store.createTask({ title: `S${i}`, from, recurrence: { type: 'daily' } } as any);
  assert.equal(store.releaseDueScheduled().length, 2, 'only up to the limit');
});

test('maxPendingBacklog: 0 disables the hold', () => {
  const store = makeStore({ maxPendingBacklog: 0 });
  for (let i = 0; i < 40; i++) store.createTask({ title: `f${i}`, from } as any);
  store.createTask({ title: 'Daily', from, recurrence: { type: 'daily' } } as any);
  assert.equal(store.releaseDueScheduled().length, 1);
});

test('collapseDuplicateScheduledRuns keeps the newest queued copy and closes the rest as SUPERSEDED', () => {
  const store = makeStore({ coalesceRuns: false });   // reproduce the legacy flood
  const p = store.createTask({ title: 'Hourly', from, recurrence: { type: 'hours', interval: 1 } } as any);
  for (let i = 0; i < 3; i++) { makeDue(store, p.id); store.releaseDueScheduled(); }
  const before = runsOf(store, p.id);
  assert.equal(before.length, 3, 'three stacked duplicates');
  // newest = latest createdAt; nudge timestamps so ordering is deterministic
  before.forEach((t, i) => { t.createdAt = new Date(Date.now() - (i + 1) * 60_000).toISOString(); store.saveTask(t); });
  const newest = before[0].id;

  (store as any).config.orchestration.scheduler = {};   // guard back on
  const closed = store.collapseDuplicateScheduledRuns();
  assert.equal(closed.length, 2);
  const pending = runsOf(store, p.id).filter(t => t.status === 'pending');
  assert.deepEqual(pending.map(t => t.id), [newest], 'newest copy survives');
  for (const c of closed) {
    const t = store.getTask(c.id)!;
    assert.equal(t.status, 'done');
    assert.match(t.result!, /^SUPERSEDED:/);
    assert.equal(t.context?.supersededBy, newest);
    assert.ok(isClosedWithoutRunning(t), 'badged closed-unrun, not a real done');
    assert.ok(!t.failed);
  }
  assert.equal(store.collapseDuplicateScheduledRuns().length, 0, 'idempotent');
});

test('collapse keeps an in-flight run and closes every queued copy beside it', () => {
  const store = makeStore({ coalesceRuns: false });
  const p = store.createTask({ title: 'Hourly', from, recurrence: { type: 'hours', interval: 1 } } as any);
  const [first] = store.releaseDueScheduled();
  store.claimTask({ taskId: first.id, workerId: 'x', internal: true });
  makeDue(store, p.id); store.releaseDueScheduled();
  makeDue(store, p.id); store.releaseDueScheduled();
  (store as any).config.orchestration.scheduler = {};
  assert.equal(store.collapseDuplicateScheduledRuns().length, 2);
  assert.equal(store.getTask(first.id)!.status, 'in-progress', 'the running copy is untouched');
});

test('isSupersededScheduledRun: an old failed run is stale once a newer cycle exists', async () => {
  const store = makeStore();
  const p = store.createTask({ title: 'Hourly', from, recurrence: { type: 'hours', interval: 1 } } as any);
  const [old] = store.releaseDueScheduled();
  await store.completeTask({ taskId: old.id, result: 'FAILED after 3 attempt(s): rate limit', internal: true });
  assert.equal(store.isSupersededScheduledRun(store.getTask(old.id)!), false, 'no newer run yet → re-run is fine');
  const t = store.getTask(old.id)!; t.createdAt = new Date(Date.now() - 3600_000).toISOString(); store.saveTask(t);
  makeDue(store, p.id); store.releaseDueScheduled();
  assert.equal(store.isSupersededScheduledRun(store.getTask(old.id)!), true, 'newer cycle supersedes it');
  const plain = store.createTask({ title: 'one-shot', from } as any);
  assert.equal(store.isSupersededScheduledRun(plain), false, 'non-recurring tasks are never superseded');
});
