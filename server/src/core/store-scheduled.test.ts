import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Scheduled tasks. A task created with a FUTURE `scheduledAt` parks on the
 * `scheduled` status — held out of the pending pool (never claimable, never
 * dispatched) until the dispatcher's per-tick launch check
 * (releaseDueScheduled) flips it to `pending` at its time. Default is "now":
 * an absent or already-past scheduledAt leaves the task pending immediately.
 */
function makeStore(): { store: Store; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-scheduled-'));
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

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();

test('a future scheduledAt parks the task on `scheduled` and blocks claiming', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future(),
  } as any);

  assert.equal(task.status, 'scheduled', 'parked, not pending');
  assert.equal(store.claimTask({ taskId: task.id, agentId: 'w', internal: true }), null,
    'the dispatcher cannot claim a scheduled task');
  assert.equal(store.claimTask({ taskId: task.id, agentId: 'remote' }), null,
    'a remote client cannot claim it either');
  assert.equal(store.listTasks({ status: 'pending' }).length, 0, 'absent from the pending pool');
  assert.equal(store.listTasks({ status: 'scheduled' })[0]?.id, task.id, 'listed under the scheduled category');
});

test('default is "now": no scheduledAt or a past one → pending immediately', () => {
  const { store } = makeStore();
  const plain = store.createTask({ title: 'now', from: { platform: 'p', agent: 'a' } } as any);
  assert.equal(plain.status, 'pending');
  assert.equal(plain.scheduledAt, undefined);

  const dueAlready = store.createTask({
    title: 'past', from: { platform: 'p', agent: 'a' }, scheduledAt: past(),
  } as any);
  assert.equal(dueAlready.status, 'pending', 'a past launch time runs now, not never');
  assert.ok(dueAlready.scheduledAt, 'the requested time is still recorded');
});

test('an unparseable scheduledAt is rejected at creation', () => {
  const { store } = makeStore();
  assert.throws(
    () => store.createTask({ title: 'bad', from: { platform: 'p', agent: 'a' }, scheduledAt: 'tomorrow-ish' } as any),
    /Invalid scheduledAt/);
});

test('scheduledAt is normalized to UTC ISO form (offsets accepted)', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'tz', from: { platform: 'p', agent: 'a' }, scheduledAt: '2099-08-08T09:00:00+08:00',
  } as any);
  assert.equal(task.scheduledAt, '2099-08-08T01:00:00.000Z');
  assert.equal(task.status, 'scheduled');
});

test('releaseDueScheduled launches due tasks and leaves future ones parked', () => {
  const { store } = makeStore();
  const due = store.createTask({ title: 'due', from: { platform: 'p', agent: 'a' }, scheduledAt: future() } as any);
  const notYet = store.createTask({
    title: 'not yet', from: { platform: 'p', agent: 'a' },
    scheduledAt: new Date(Date.now() + 7_200_000).toISOString(),   // strictly after `due`
  } as any);

  assert.equal(store.releaseDueScheduled().length, 0, 'nothing due yet');

  // Simulate the dispatcher's tick arriving after `due`'s launch time.
  const dueAt = new Date(due.scheduledAt!).getTime();
  const released = store.releaseDueScheduled(dueAt);
  assert.deepEqual(released.map(t => t.id), [due.id], 'exactly the due task is released');
  assert.equal(store.getTask(due.id)?.status, 'pending', 'released into the pending pool');
  assert.equal(store.getTask(notYet.id)?.status, 'scheduled', 'the other stays parked');

  const claimed = store.claimTask({ taskId: due.id, agentId: 'w', internal: true });
  assert.equal(claimed?.status, 'in-progress', 'claimable once released');
});

test('a released task still awaiting human input lands on wait-input, then pending', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'scheduled + questions',
    from: { platform: 'p', agent: 'a' },
    scheduledAt: future(),
    interaction: { fields: [{ id: 'q1', label: 'Which env?', required: true }] },
  } as any);
  assert.equal(task.status, 'scheduled', 'the schedule wins over wait-input while parked');

  const [released] = store.releaseDueScheduled(new Date(task.scheduledAt!).getTime());
  assert.equal(released?.status, 'wait-input', 'due but unanswered → parked for the person, not dispatched');

  const answered = store.submitInteraction({ taskId: task.id, responses: { q1: 'staging' } });
  assert.equal(answered?.status, 'pending', 'answers release it into normal scheduling');
});

test('answers submitted while still scheduled do not jump the launch time', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'answer early',
    from: { platform: 'p', agent: 'a' },
    scheduledAt: future(),
    interaction: { fields: [{ id: 'q1', label: 'Which env?' }] },
  } as any);

  const answered = store.submitInteraction({ taskId: task.id, responses: { q1: 'prod' } });
  assert.equal(answered?.status, 'scheduled', 'stays parked until its time even with answers in');

  const [released] = store.releaseDueScheduled(new Date(task.scheduledAt!).getTime());
  assert.equal(released?.status, 'pending', 'answers already in → releases straight to pending');
  assert.equal(released?.context?.humanInput?.['Which env?'], 'prod');
});

test('a scheduled task with a garbled scheduledAt releases immediately (fail open)', () => {
  const { store, root } = makeStore();
  // Hand-edited/corrupt task file: status scheduled but the timestamp is garbage.
  const id = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(root, 'inbox', `${id}.json`), JSON.stringify({
    id, title: 'corrupt', from: { platform: 'p', agent: 'a' }, to: {},
    priority: 'normal', status: 'scheduled', scheduledAt: 'not-a-date',
    createdAt: new Date().toISOString(),
  }));
  const released = store.releaseDueScheduled();
  assert.deepEqual(released.map(t => t.id), [id], 'released rather than stranded forever');
  assert.equal(store.getTask(id)?.status, 'pending');
});

test('releasing a due `manual` task warns that the dispatcher will not auto-run it', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'scheduled + manual (contradiction)',
    from: { platform: 'p', agent: 'a' },
    scheduledAt: future(),
    tags: ['manual'],
  } as any);
  assert.equal(task.status, 'scheduled');

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    const [released] = store.releaseDueScheduled(new Date(task.scheduledAt!).getTime());
    assert.equal(released?.status, 'pending', 'still released to pending (behaviour unchanged)');
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1, 'exactly one warning about the silent-stall');
  assert.match(warnings[0], /manual/, 'names the offending tag');
  assert.match(warnings[0], new RegExp(task.id), 'names the task so it is diagnosable');
});

test('runScheduledNow releases a parked task immediately and clears scheduledAt', () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future() } as any);
  assert.equal(task.status, 'scheduled', 'parked to start with');

  const released = store.runScheduledNow(task.id);
  assert.equal(released?.status, 'pending', 'released straight into the pending pool');
  assert.equal(released?.scheduledAt, undefined, 'the future time is dropped so nothing re-parks it');

  const claimed = store.claimTask({ taskId: task.id, agentId: 'w', internal: true });
  assert.equal(claimed?.status, 'in-progress', 'claimable now, without waiting for its time');
});

test('runScheduledNow parks a task with an unanswered interaction on wait-input', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'scheduled + questions',
    from: { platform: 'p', agent: 'a' },
    scheduledAt: future(),
    interaction: { fields: [{ id: 'q1', label: 'Which env?', required: true }] },
  } as any);

  const released = store.runScheduledNow(task.id);
  assert.equal(released?.status, 'wait-input', 'released early but still needs answers before it runs');
  assert.equal(released?.scheduledAt, undefined, 'no longer time-gated — only input-gated');

  const answered = store.submitInteraction({ taskId: task.id, responses: { q1: 'staging' } });
  assert.equal(answered?.status, 'pending', 'answers release it into normal scheduling');
});

test('runScheduledNow is a no-op for a task that is not scheduled', () => {
  const { store } = makeStore();
  const pending = store.createTask({ title: 'now', from: { platform: 'p', agent: 'a' } } as any);
  assert.equal(store.runScheduledNow(pending.id), null, 'a pending task has nothing to release');
  assert.equal(store.runScheduledNow('no-such-id'), null, 'an unknown id returns null, not a throw');
  assert.equal(store.getTask(pending.id)?.status, 'pending', 'the pending task is untouched');
});

test('runScheduledNow on a due `manual` task warns that the dispatcher will not auto-run it', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'scheduled + manual (contradiction)',
    from: { platform: 'p', agent: 'a' },
    scheduledAt: future(),
    tags: ['manual'],
  } as any);

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    const released = store.runScheduledNow(task.id);
    assert.equal(released?.status, 'pending', 'still released to pending');
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1, 'exactly one warning about the silent-stall');
  assert.match(warnings[0], /manual/, 'names the offending tag');
});

test('getDashboard counts scheduled tasks in their own bucket', () => {
  const { store } = makeStore();
  store.createTask({ title: 'now', from: { platform: 'p', agent: 'a' } } as any);
  store.createTask({ title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future() } as any);
  const dash = store.getDashboard();
  assert.equal(dash.inboxSummary.pending, 1);
  assert.equal(dash.inboxSummary.scheduled, 1);
});
