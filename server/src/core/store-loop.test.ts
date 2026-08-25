import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store, isClosedWithoutRunning } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Periodic (looping) scheduled tasks. On completion, a task with
 * `loopIntervalHours` spawns a FRESH scheduled iteration. The finished run keeps
 * its own artifacts/result on its own card; the two are cross-linked
 * (context.periodicPrevId / periodicNextId) so the recurring series is walkable
 * and each cycle's artifacts stay reachable from the dashboard.
 */
function makeStore(): { store: Store; root: string; paths: any } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-loop-'));
  const paths = {
    inbox: path.join(root, 'inbox'),
    artifacts: path.join(root, 'artifacts'),
    inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'),
    decisions: path.join(root, 'decisions'),
    workflows: path.join(root, 'workflows'),
    agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p as string, { recursive: true });
  const config = { paths, platforms: {}, orchestration: { brains: {} } } as unknown as Config;
  return { store: new Store(config, new EventBus()), root, paths };
}

const due = () => new Date(Date.now() - 1000).toISOString();

test('completing a looping task spawns a fresh scheduled iteration', async () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);
  await store.completeTask({ taskId: t.id, result: 'done', internal: true });

  const all = store.listTasks({});
  assert.equal(all.length, 2, 'the done run and its next iteration both exist');
  const next = all.find(x => x.id !== t.id)!;
  assert.equal(next.status, 'scheduled');
  assert.equal(next.loopIntervalHours, 24);
  assert.ok(Date.parse(next.scheduledAt!) > Date.now(), 'next iteration is scheduled in the future');
});

test('the finished run keeps its artifacts and is not mistaken for closed-without-running', async () => {
  const { store, paths } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);
  // A brain produced an artifact for this cycle.
  const artDir = path.join(paths.artifacts, t.id);
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'output.md'), '# hi');
  const claimed = store.getTask(t.id)!;
  (claimed as any).artifacts = ['output.md'];
  store.saveTask(claimed);

  await store.completeTask({ taskId: t.id, result: 'the deliverable', internal: true });

  const done = store.getTask(t.id)!;
  assert.deepEqual(done.artifacts, ['output.md'], 'the run keeps its artifacts on its own card');
  assert.equal(isClosedWithoutRunning(done), false, 'a real periodic run is never badged closed-without-running');
});

test('a periodic run is cross-linked to the iteration it spawns (both directions)', async () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);
  await store.completeTask({ taskId: t.id, result: 'done', internal: true });

  const done = store.getTask(t.id)!;
  const next = store.listTasks({}).find(x => x.id !== t.id)!;
  assert.equal(done.context?.periodicNextId, next.id, 'finished run points forward to its next iteration');
  assert.equal(next.context?.periodicPrevId, t.id, 'next iteration points back to the run that spawned it');
});

test('per-run bookkeeping does not bleed into the next iteration', async () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
    context: { brain: 'local-x', agent: 'mentor', dispatched: true, inputFiles: ['a.txt'], attempts: 3 },
  } as any);
  await store.completeTask({ taskId: t.id, result: 'done', internal: true });

  const next = store.listTasks({}).find(x => x.id !== t.id)!;
  assert.equal(next.context?.dispatched, undefined, 'stale claim marker stripped');
  assert.equal(next.context?.inputFiles, undefined, 'per-run input filenames stripped (files were not carried forward)');
  assert.equal(next.context?.attempts, undefined, 'attempt counter reset');
  assert.equal(next.context?.brain, 'local-x', 'a deliberate brain pin is preserved');
  assert.equal(next.context?.agent, 'mentor', 'the agent assignment is preserved');
});

test('cross-links do not leak the grand-parent id across cycles', async () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);
  await store.completeTask({ taskId: t.id, result: 'cycle 1', internal: true });
  const gen2 = store.listTasks({}).find(x => x.id !== t.id)!;

  // Release + complete the second cycle.
  const g2 = store.getTask(gen2.id)!;
  g2.status = 'pending';
  store.saveTask(g2);
  await store.completeTask({ taskId: gen2.id, result: 'cycle 2', internal: true });

  const gen3 = store.listTasks({}).find(x => x.id !== t.id && x.id !== gen2.id)!;
  assert.equal(gen3.context?.periodicPrevId, gen2.id, 'gen3 links to gen2, not the original');
  assert.equal(gen3.context?.periodicNextId, undefined, 'a brand-new iteration has no forward link yet');
});
