import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Store.updateTask — edit an existing task's parameters (the counterpart to the
 * New-task composer). Editable only when the task is NEITHER running NOR pending
 * (scheduled / wait-input / done / rejected / failed). Scheduling follows the same
 * rules as createTask; re-arming a finished task clears its completion so it runs
 * again.
 */
function makeStore(): { store: Store; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-edit-'));
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
  const config = {
    paths, platforms: {},
    orchestration: { brains: { 'local-x': { location: 'local', exec: 'hermes' } } },
  } as unknown as Config;
  return { store: new Store(config, new EventBus()), root };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

test('a pending task is not editable', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'now', from: { platform: 'p', agent: 'a' } } as any);
  assert.equal(t.status, 'pending');
  assert.throws(() => store.updateTask(t.id, { title: 'new' }), /not running or pending/);
});

test('an in-progress task is not editable', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'now', from: { platform: 'p', agent: 'a' } } as any);
  store.claimTask({ taskId: t.id, agentId: 'w', internal: true });
  assert.throws(() => store.updateTask(t.id, { title: 'new' }), /not running or pending/);
});

test('editing a scheduled task updates fields and keeps it scheduled', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future() } as any);
  assert.equal(t.status, 'scheduled');
  const newWhen = new Date(Date.now() + 7_200_000).toISOString();
  const u = store.updateTask(t.id, {
    title: 'edited title', description: 'edited brief', priority: 'high',
    brain: 'local-x', scheduledAt: newWhen,
  })!;
  assert.equal(u.status, 'scheduled', 'still parked');
  assert.equal(u.title, 'edited title');
  assert.equal(u.description, 'edited brief');
  assert.equal(u.priority, 'high');
  assert.equal(u.context?.brain, 'local-x');
  assert.equal(u.scheduledAt, newWhen);
});

test('clearing a scheduled task\'s run time releases it to pending', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future() } as any);
  const u = store.updateTask(t.id, { scheduledAt: '' })!;
  assert.equal(u.status, 'pending');
  assert.equal(u.scheduledAt, undefined);
});

test('a cleared schedule on a scheduled task with unanswered questions lands on wait-input', () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'later + q', from: { platform: 'p', agent: 'a' }, scheduledAt: future(),
    interaction: { fields: [{ id: 'q1', label: 'Which env?', required: true }] },
  } as any);
  assert.equal(t.status, 'scheduled');
  const u = store.updateTask(t.id, { scheduledAt: '' })!;
  assert.equal(u.status, 'wait-input', 'still needs answers before it can run');
});

test('re-arming a finished task with a future time clears its completion and re-schedules', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'done one', from: { platform: 'p', agent: 'a' } } as any);
  store.claimTask({ taskId: t.id, agentId: 'w', internal: true });
  // complete it (internal skips the guard)
  return store.completeTask({ taskId: t.id, result: 'all good', internal: true }).then(() => {
    const done = store.getTask(t.id)!;
    assert.equal(done.status, 'done');
    const when = future();
    const u = store.updateTask(t.id, { scheduledAt: when, description: 'do it again' })!;
    assert.equal(u.status, 'scheduled', 're-armed');
    assert.equal(u.scheduledAt, when);
    assert.equal(u.description, 'do it again');
    assert.equal(u.result, undefined, 'prior result cleared');
    assert.equal(u.completedAt, undefined, 'completion cleared');
    assert.equal(u.claimedBy, undefined, 'claim cleared');
    assert.equal(u.context?.attempts, 0, 'chain bookkeeping reset');
    assert.equal(u.context?.dispatched, false);
  });
});

test('editing a finished task without a schedule keeps it finished (metadata-only)', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'done two', from: { platform: 'p', agent: 'a' } } as any);
  store.claimTask({ taskId: t.id, agentId: 'w', internal: true });
  return store.completeTask({ taskId: t.id, result: 'ok', internal: true }).then(() => {
    const u = store.updateTask(t.id, { title: 'renamed', scheduledAt: '' })!;
    assert.equal(u.status, 'done', 'stays done — clearing the schedule is a metadata edit, not a re-run');
    assert.equal(u.title, 'renamed');
    assert.equal(u.result, 'ok', 'result preserved');
  });
});

test('an unknown brain pin is rejected', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future() } as any);
  assert.throws(() => store.updateTask(t.id, { brain: 'does-not-exist' }), /Unknown brain/);
});

test('an invalid scheduledAt is rejected', () => {
  const { store } = makeStore();
  const t = store.createTask({ title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future() } as any);
  assert.throws(() => store.updateTask(t.id, { scheduledAt: 'whenever' }), /Invalid scheduledAt/);
});

test('setting brain to empty clears the pin', () => {
  const { store } = makeStore();
  const t = store.createTask({
    title: 'later', from: { platform: 'p', agent: 'a' }, scheduledAt: future(),
    context: { brain: 'local-x' },
  } as any);
  assert.equal(t.context?.brain, 'local-x');
  const u = store.updateTask(t.id, { brain: '' })!;
  assert.equal(u.context?.brain, undefined, 'pin cleared → routes via Auto');
});
