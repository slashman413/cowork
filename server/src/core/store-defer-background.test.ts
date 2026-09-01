import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Background-wait deferral. When an agent reports a result that is really "I'm
 * still waiting on long background work I launched", the task must NOT be marked
 * `done` (which closes the session and throws away the eventual result). Instead
 * it is DEFERRED — re-armed on `scheduled` a short while out so a later run
 * checks whether the background job finished. These pin that behaviour at the
 * store layer (deferForBackground + the completeTask guard path + release).
 */
function makeStore(): { store: Store; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-defer-bg-'));
  const paths = {
    inbox: path.join(root, 'inbox'),
    artifacts: path.join(root, 'artifacts'),
    inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'),
    decisions: path.join(root, 'decisions'),
    workflows: path.join(root, 'workflows'),
    agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
  const config = { paths, platforms: {}, orchestration: { brains: {} } } as unknown as Config;
  return { store: new Store(config, new EventBus()), root };
}

test('deferForBackground re-arms on `scheduled` instead of `done` and preserves the partial result', () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any);
  assert.equal(task.status, 'pending');

  const out = store.deferForBackground({ taskId: task.id, note: 'render job 7f3a still encoding', result: 'partial…', pollMs: 60000 });
  assert.ok(out);
  assert.equal(out!.status, 'scheduled', 'deferred → scheduled, NOT done');
  assert.notEqual(out!.status, 'done');
  assert.equal(out!.result, 'partial…', 'partial output preserved on the card');
  assert.equal((out!.context!.backgroundWait as any).count, 1, 'first deferral');
  assert.match(String((out!.context!.backgroundWait as any).note), /render job/);
  assert.ok(Date.parse(out!.scheduledAt!) > Date.now(), 'scheduled into the future');
  // Held out of the pending pool until due.
  assert.equal(store.listTasks({ status: 'pending' }).length, 0);
  assert.equal(store.claimTask({ taskId: task.id, agentId: 'w', internal: true }), null);
});

test('repeated deferrals increment the bounded count', () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any);
  store.deferForBackground({ taskId: task.id, pollMs: 1 });
  store.deferForBackground({ taskId: task.id, pollMs: 1 });
  const t = store.deferForBackground({ taskId: task.id, pollMs: 1 });
  assert.equal((t!.context!.backgroundWait as any).count, 3);
});

test('a deferred task is released back to pending once its poll time is due', () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any);
  store.deferForBackground({ taskId: task.id, pollMs: 1 });
  assert.equal(store.getTask(task.id)!.status, 'scheduled');
  // Its scheduledAt is ~1ms out; release with a `now` comfortably past it.
  const released = store.releaseDueScheduled(Date.now() + 1000);
  assert.ok(released.some(r => r.id === task.id), 'the due deferred task was released');
  assert.equal(store.getTask(task.id)!.status, 'pending', 'back in the pending pool for a re-check');
});

test('completeTask via the guard DEFERS instead of marking done', async () => {
  const { store } = makeStore();
  store.setCompletionGuard(async () => ({ action: 'defer-background', note: 'CI still running', pollMs: 60000 }));
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any);

  const res = await store.completeTask({ taskId: task.id, result: 'the background task is still running' });
  assert.equal(res!.status, 'scheduled', 'guard deferred it — not done');
  assert.notEqual(res!.status, 'done');
  assert.equal((res!.context!.backgroundWait as any).count, 1);

  // An INTERNAL completion (dispatcher already verified) still finalises normally.
  const res2 = await store.completeTask({ taskId: task.id, result: 'final deliverable', internal: true });
  assert.equal(res2!.status, 'done');
});
