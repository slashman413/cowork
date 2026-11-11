import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/** inbox.purgeScheduledRunsAfterDays: done runs of scheduled tasks auto-purge (default 3d). */
function makeStore(inbox: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-purge-sched-'));
  const paths: Record<string, string> = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'goals', 'agencyAgents']) {
    paths[k] = path.join(root, k); fs.mkdirSync(paths[k], { recursive: true });
  }
  const config = { paths, inbox, orchestration: { agents: {} } } as unknown as Config;
  return new Store(config, new EventBus());
}

function task(store: Store, title: string, daysAgo: number, status: string, context: Record<string, unknown> = {}, tags: string[] = []) {
  const t0 = store.createTask({ title, from: { platform: 'p', agent: 'a' }, context, tags } as any);
  const when = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const t = store.getTask(t0.id)!;
  Object.assign(t, { status, createdAt: when, completedAt: when });
  store.saveTask(t);
  return t;
}

test('purgeScheduledRuns drops only done scheduled runs older than the default 3 days', () => {
  const store = makeStore();
  const oldRun = task(store, 'daily run (old)', 4, 'done', { scheduledParentId: 'parent-1' });
  const freshRun = task(store, 'daily run (fresh)', 1, 'done', { scheduledParentId: 'parent-1' });
  const failedRun = task(store, 'daily run (rejected)', 10, 'rejected', { scheduledParentId: 'parent-1' });
  const keptRun = task(store, 'daily run (kept)', 10, 'done', { scheduledParentId: 'parent-1' }, ['keep']);
  const oneOff = task(store, 'one-off', 10, 'done');

  const out = store.purgeScheduledRuns();

  assert.deepEqual(out.purged.map(p => p.id), [oldRun.id]);
  for (const t of [freshRun, failedRun, keptRun, oneOff]) assert.ok(store.getTask(t.id), t.title);
});

test('purgeScheduledRuns honours the configured days and 0 = disabled', () => {
  const s10 = makeStore({ purgeScheduledRunsAfterDays: 10 });
  const r = task(s10, 'run', 5, 'done', { scheduledParentId: 'p' });
  assert.equal(s10.purgeScheduledRuns().purged.length, 0);
  assert.ok(s10.getTask(r.id));

  const off = makeStore({ purgeScheduledRunsAfterDays: 0 });
  task(off, 'run', 50, 'done', { scheduledParentId: 'p' });
  const out = off.purgeScheduledRuns();
  assert.equal(out.disabled, true);
  assert.equal(out.purged.length, 0);
});
