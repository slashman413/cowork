import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.js';
import type { ActiveWorker, Config, Task } from '../types.js';

/**
 * Exercises reclaimStaleClaims — the fix for "tasks stuck in-progress with no
 * agent actually working them". The original guard only reclaimed a task when
 * its claimer had VANISHED from the roster. A local/remote agent client, though,
 * heartbeats forever: when its child CLI dies without a complete_task the task is
 * stranded in-progress while the client sits `idle` on the roster, so the claim
 * was never rescued. These tests drive the private method directly against a fake
 * store (no timers, no spawning).
 */

const STALE = 600_000;      // 10 min
const HARD = 5_400_000;     // 90 min

function harness() {
  const tasks = new Map<string, Task>();
  const agents = new Map<string, ActiveWorker>();
  const store = {
    getActiveWorkers: () => Array.from(agents.values()),
    listTasks: (f?: { status?: string }) =>
      Array.from(tasks.values()).filter(t => !f?.status || t.status === f.status),
    saveTask: (t: Task) => { tasks.set(t.id, t); }
  };
  const config = {
    orchestration: { staleClaimMs: STALE, hardClaimMs: HARD }
  } as unknown as Config;
  const dispatcher = new Dispatcher(config, store as any, {} as any);
  const reclaim = () => (dispatcher as any).reclaimStaleClaims();
  const now = Date.now();
  const putTask = (id: string, ageMs: number, claimedBy?: string): Task => {
    const t: Task = {
      id, title: id, description: '', from: { platform: 'x', agent: 'y' }, to: {},
      priority: 'normal', status: 'in-progress',
      claimedAt: new Date(now - ageMs).toISOString(), claimedBy, createdAt: new Date(now - ageMs).toISOString()
    };
    tasks.set(id, t);
    return t;
  };
  const putAgent = (id: string, status: ActiveWorker['status']): void => {
    agents.set(id, {
      id, platform: 'hermes', workerName: 'local', status,
      registeredAt: new Date(now).toISOString(), lastHeartbeat: new Date(now).toISOString()
    });
  };
  return { tasks, reclaim, putTask, putAgent, dispatcher };
}

test('reclaims a task whose claimer is idle (the live-but-idle-client bug)', () => {
  const h = harness();
  h.putTask('t1', STALE + 60_000, 'client-A');   // 11 min old
  h.putAgent('client-A', 'idle');                // still on roster, but idle
  h.reclaim();
  const t = h.tasks.get('t1')!;
  assert.equal(t.status, 'pending', 'idle claimer → task re-queued');
  assert.equal(t.claimedBy, undefined);
  assert.equal(t.claimedAt, undefined);
  assert.equal(t.context!.dispatched, false);
});

test('reclaims a task whose claimer has vanished from the roster', () => {
  const h = harness();
  h.putTask('t2', STALE + 1, 'ghost');   // claimer not registered
  h.reclaim();
  assert.equal(h.tasks.get('t2')!.status, 'pending');
});

test('leaves a task owned by an actively-working claimer within the window', () => {
  const h = harness();
  h.putTask('t3', STALE + 60_000, 'client-B');
  h.putAgent('client-B', 'working');
  h.reclaim();
  assert.equal(h.tasks.get('t3')!.status, 'in-progress', 'working claimer keeps its claim');
});

test('hard ceiling reclaims even a claimer that still reports working', () => {
  const h = harness();
  h.putTask('t4', HARD + 1, 'client-C');   // wedged on a hung child
  h.putAgent('client-C', 'working');
  h.reclaim();
  assert.equal(h.tasks.get('t4')!.status, 'pending', 'past the ceiling → reclaimed regardless');
});

test('does not reclaim a fresh claim inside the grace window', () => {
  const h = harness();
  h.putTask('t5', STALE - 60_000, 'client-D');   // 9 min old
  h.putAgent('client-D', 'idle');
  h.reclaim();
  assert.equal(h.tasks.get('t5')!.status, 'in-progress', 'grace window not yet elapsed');
});

test('staleClaimMs = 0 disables reclaim entirely', () => {
  const h = harness();
  (h.dispatcher as any).config.orchestration.staleClaimMs = 0;
  h.putTask('t6', HARD * 2, 'ghost');
  h.reclaim();
  assert.equal(h.tasks.get('t6')!.status, 'in-progress', 'disabled → nothing reclaimed');
});
