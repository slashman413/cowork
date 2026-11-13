import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/** Pause / resume: a person moves a task into the `paused` queue and back without losing state. */
function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-pause-'));
  const paths: Record<string, string> = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'agencyAgents']) { paths[k] = path.join(root, k); fs.mkdirSync(paths[k], { recursive: true }); }
  const config = { paths, platforms: {}, inbox: { maxRetries: 3 }, orchestration: { roleChains: {}, agents: {}, defaultChain: [] } } as unknown as Config;
  const bus = new EventBus();
  const store = new Store(config, bus);
  store.initialize();
  return { store, bus };
}
const mk = (store: Store, extra: Record<string, any> = {}) =>
  store.createTask({ title: 'job', description: 'do it', from: { platform: 'p', agent: 'a' }, priority: 'normal', context: { attempts: 1, persona: 'x' }, ...extra } as any);

test('pause a pending task → paused queue; resume → pending with context intact', () => {
  const { store, bus } = makeStore();
  const seen: string[] = [];
  bus.on('taskPaused', (e: any) => seen.push(e.payload.from));
  const t = mk(store);
  const out = store.pauseTask(t.id, { by: 'tester' })!;
  assert.equal(out.from, 'pending');
  assert.equal(store.getTask(t.id)!.status, 'paused');
  assert.deepEqual(seen, ['pending']);
  assert.ok(store.listTasks({ status: 'paused' }).some(x => x.id === t.id));
  assert.ok(!store.listTasks({ status: 'pending' }).some(x => x.id === t.id), 'out of the pending pool');
  assert.equal(store.getDashboard().inboxSummary.paused, 1);
  assert.equal(store.pauseTask(t.id), null, 'already paused');

  const r = store.resumeTask(t.id)!;
  assert.equal(r.status, 'pending');
  assert.equal(r.context!.attempts, 1);
  assert.equal(r.context!.persona, 'x');
  assert.equal(r.context!.pausedFrom, undefined);
  assert.equal(store.resumeTask(t.id), null, 'not paused any more');
});

test('a scheduled task resumes onto its schedule', () => {
  const { store } = makeStore();
  const at = new Date(Date.now() + 3600e3).toISOString();
  const t = mk(store, { scheduledAt: at });
  assert.equal(t.status, 'scheduled');
  store.pauseTask(t.id);
  const r = store.resumeTask(t.id)!;
  assert.equal(r.status, 'scheduled');
  assert.equal(r.scheduledAt, at);
});

test('an in-progress task: stale writes from the dying run stay paused; resume re-queues it flagged', () => {
  const { store } = makeStore();
  const t = mk(store);
  const running = store.getTask(t.id)!;
  running.status = 'in-progress';
  running.claimedBy = 'worker-1';
  store.saveTask(running);
  store.pauseTask(t.id);
  // the run that was stopped saves its last view of the task
  store.saveTask({ ...running, status: 'in-progress' });
  assert.equal(store.getTask(t.id)!.status, 'paused');
  const r = store.resumeTask(t.id)!;
  assert.equal(r.status, 'pending');
  assert.equal(r.claimedBy, undefined);
  assert.equal(r.context!.resumedAfterInterrupt, true);
});

test('done tasks cannot be paused', () => {
  const { store } = makeStore();
  const t = mk(store);
  const d = store.getTask(t.id)!;
  d.status = 'done';
  store.saveTask(d);
  assert.equal(store.pauseTask(t.id), null);
});
