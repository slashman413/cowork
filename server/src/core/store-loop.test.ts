import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store, isClosedWithoutRunning } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Recurring (periodic) scheduled tasks. A recurring task is a persistent
 * SCHEDULER: it parks on `scheduled` and never runs its own body. Each time its
 * `scheduledAt` comes due, releaseDueScheduled spawns a one-shot RUN-CHILD (which
 * enters the pending pool, runs once, and becomes that cycle's `done` record with
 * its own inputs/artifacts) and re-arms the parent to the next fire time. The
 * run-child links back to its parent via context.scheduledParentId. The parent
 * runs its own body only on the FINAL slot (cadence exhausted / `until` reached),
 * turning into a `done` task directly like a plain one-shot.
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

test('a recurring task parks on `scheduled` — it is a scheduler, not a runner', () => {
  const { store } = makeStore();
  // Even created with a past/absent scheduledAt, a recurring task never enters the
  // pending pool: it parks on `scheduled` so the first due tick spawns its child.
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);
  assert.equal(t.status, 'scheduled', 'parked as a scheduler, never pending');
  assert.ok(t.scheduledAt, 'keeps a launch time so it is due on the next tick');
});

test('a due recurring task spawns a one-shot run-child and re-arms itself', () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);

  const released = store.releaseDueScheduled();
  assert.equal(released.length, 1, 'exactly one task entered the pool');

  const all = store.listTasks({});
  assert.equal(all.length, 2, 'the persistent scheduler and its run-child');
  const parent = store.getTask(t.id)!;
  assert.equal(parent.status, 'scheduled', 'the scheduler stays scheduled (re-armed)');
  assert.ok(Date.parse(parent.scheduledAt!) > Date.now(), 're-armed to a future slot');

  const child = all.find(x => x.id !== t.id)!;
  assert.equal(child.id, released[0].id, 'the child is what was released into the pool');
  assert.equal(child.status, 'pending', 'the run-child runs now (one-shot)');
  assert.equal(child.recurrence, undefined, 'the child carries NO recurrence — it never re-spawns');
  assert.equal(child.scheduledAt, undefined, 'the child is a plain "now" task');
  assert.equal(child.context?.scheduledParentId, t.id, 'the child links back to its scheduler');
});

test('the finished run-child holds its own artifacts and result, not the parent', async () => {
  const { store, paths } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);
  const [child] = store.releaseDueScheduled();

  // A brain produced an artifact for this cycle under the child's own dir.
  const artDir = path.join(paths.artifacts, child.id);
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'output.md'), '# hi');
  const claimed = store.getTask(child.id)!;
  (claimed as any).artifacts = ['output.md'];
  store.saveTask(claimed);

  await store.completeTask({ taskId: child.id, result: 'the deliverable', internal: true });

  const done = store.getTask(child.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.artifacts, ['output.md'], 'the run keeps its artifacts on its own card');
  assert.equal(done.result, 'the deliverable');
  assert.equal(isClosedWithoutRunning(done), false, 'a real run is never badged closed-without-running');
});

test('completing a run-child spawns nothing further (the parent drives the cadence)', async () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
  } as any);
  const [child] = store.releaseDueScheduled();
  await store.completeTask({ taskId: child.id, result: 'done', internal: true });

  assert.equal(store.listTasks({}).length, 2, 'still just the scheduler + this cycle — completion spawned nothing');
  assert.equal(store.getTask(t.id)!.status, 'scheduled', 'the scheduler is untouched by the child completing');
});

test('FIXED-RATE: re-arm is phased on the intended scheduledAt, not on now', () => {
  const { store } = makeStore();
  // The slot fired 5 minutes ago (execution << the 1h interval).
  const firedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const t = store.createTask({
    title: 'Hourly', from: { platform: 'p', agent: 'a' },
    scheduledAt: firedAt, recurrence: { type: 'hours', interval: 1 },
  } as any);
  store.releaseDueScheduled();

  const parent = store.getTask(t.id)!;
  const expected = Date.parse(firedAt) + 60 * 60 * 1000;   // phased on the INTENDED time
  assert.equal(Date.parse(parent.scheduledAt!), expected, 'next slot is anchored on the intended fire time');
  assert.ok(Date.parse(parent.scheduledAt!) < Date.now() + 60 * 60 * 1000, 'sooner than a fixed-delay reschedule');
});

test('per-run bookkeeping does not bleed into the run-child, but pins/agent survive', () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 24,
    context: { brain: 'local-x', agent: 'mentor', dispatched: true, inputFiles: ['a.txt'], attempts: 3 },
  } as any);
  const [child] = store.releaseDueScheduled();

  assert.equal(child.context?.dispatched, undefined, 'stale claim marker stripped');
  assert.equal(child.context?.inputFiles, undefined, 'per-run input filenames stripped');
  assert.equal(child.context?.attempts, undefined, 'attempt counter reset');
  assert.equal(child.context?.brain, 'local-x', 'a deliberate brain pin is preserved');
  assert.equal(child.context?.agent, 'mentor', 'the agent assignment is preserved');
});

test('legacy loopIntervalHours still recurs (normalized onto recurrence)', () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Legacy', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(), loopIntervalHours: 6,
  } as any);
  assert.deepEqual(store.getTask(t.id)!.recurrence, { type: 'hours', interval: 6 }, 'legacy field normalizes to recurrence');

  store.releaseDueScheduled();
  const parent = store.getTask(t.id)!;
  assert.equal(parent.status, 'scheduled', 'still a scheduler after firing');
  assert.equal(parent.loopIntervalHours, 6, 'legacy field stays mirrored for old dashboards');
});

test('the FINAL slot (until cutoff) runs the parent itself — done directly, no child', () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'Bounded', from: { platform: 'p', agent: 'a' },
    scheduledAt: due(),
    // The next minute slot would be in the future but past `until` → series ends,
    // so there is no future run to re-arm to.
    recurrence: { type: 'minutes', interval: 1, until: new Date(Date.now() - 1000).toISOString() },
  } as any);

  const released = store.releaseDueScheduled();
  assert.equal(store.listTasks({}).length, 1, 'no child spawned — only the task itself');
  assert.equal(released[0].id, t.id, 'the task itself was released');
  assert.equal(store.getTask(t.id)!.status, 'pending', 'it runs its own body, then becomes done directly');
});

test('run-now on a recurring task spawns an extra child, leaving the cadence intact', () => {
  const { store } = makeStore();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const t = store.createTask({
    title: 'Daily', from: { platform: 'p', agent: 'a' },
    scheduledAt: future, loopIntervalHours: 24,
  } as any);

  const child = store.runScheduledNow(t.id)!;
  assert.equal(child.status, 'pending', 'the extra run enters the pool now');
  assert.equal(child.context?.scheduledParentId, t.id, 'linked back to its scheduler');
  const parent = store.getTask(t.id)!;
  assert.equal(parent.status, 'scheduled', 'the regular cadence is untouched');
  assert.equal(parent.scheduledAt, future, 'the next scheduled slot still fires on its own time');
});

test('an invalid recurrence spec is rejected at creation', () => {
  const { store } = makeStore();
  assert.throws(() => store.createTask({
    title: 'Bad', from: { platform: 'p', agent: 'a' },
    recurrence: { type: 'weekly', weekdays: [9] },
  } as any), /0 \(Sun\)/);
});
