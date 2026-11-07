import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Regression: the UI, reports and chat all surface an 8-char SHORT task id
 * (first UUID segment). Before the fix, getTask/deleteTask did an EXACT filename
 * match, so any lookup by short id ("6e7fa48c") missed even though the task lived
 * on disk as "6e7fa48c-….json" — surfacing to the user as "6 ids not found".
 */
function makeStore(): { store: Store; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shortid-'));
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
  const config = { paths, orchestration: { agents: {} } } as unknown as Config;
  return { store: new Store(config, new EventBus()), root };
}

test('getTask resolves an 8-char short id to the full task', () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 'Find me', from: { platform: 'p', agent: 'a' } } as any);
  const shortId = task.id.slice(0, 8);

  assert.notEqual(task.id, shortId, 'sanity: full id is a UUID, not the short id');
  assert.equal(store.getTask(task.id)?.id, task.id, 'exact full-id lookup still works');
  assert.equal(store.getTask(shortId)?.id, task.id, 'short-id lookup resolves to the full task');
});

test('getTask returns null for an unknown short id', () => {
  const { store } = makeStore();
  store.createTask({ title: 'x', from: { platform: 'p', agent: 'a' } } as any);
  assert.equal(store.getTask('deadbeef'), null);
});

test('an ambiguous short-id prefix resolves to nothing rather than the wrong task', () => {
  const { store, root } = makeStore();
  // Two tasks whose filenames share a prefix; a lookup on that prefix is ambiguous.
  const inbox = path.join(root, 'inbox');
  fs.writeFileSync(path.join(inbox, 'abcd0000-1111-2222-3333-444444444444.json'), JSON.stringify({ id: 'abcd0000-1111-2222-3333-444444444444', title: 'one' }));
  fs.writeFileSync(path.join(inbox, 'abcd0000-9999-8888-7777-666666666666.json'), JSON.stringify({ id: 'abcd0000-9999-8888-7777-666666666666', title: 'two' }));
  assert.equal(store.getTask('abcd0000'), null, 'ambiguous prefix must not guess');
});

test('deleteTask by short id removes the underlying full-id task file', () => {
  const { store, root } = makeStore();
  const task = store.createTask({ title: 'delete me', from: { platform: 'p', agent: 'a' } } as any);
  const file = path.join(root, 'inbox', `${task.id}.json`);
  assert.ok(fs.existsSync(file));

  const out = store.deleteTask(task.id.slice(0, 8));
  assert.equal(out.deleted, true);
  assert.equal(fs.existsSync(file), false, 'task file is gone, not orphaned under the full id');
});

/**
 * Human-in-the-loop gate. A task shipped with an unanswered interaction packet
 * must NOT be claimable — otherwise the executor runs before a person supplies
 * the answers, so context.humanInput never reaches the prompt. Once the answers
 * are submitted the same task becomes claimable and carries humanInput.
 */
test('claimTask holds a task awaiting human input, then releases it once submitted', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'needs input',
    from: { platform: 'p', agent: 'a' },
    interaction: { fields: [{ id: 'q1', label: 'Which env?', required: true }] },
  } as any);

  assert.equal(task.interaction?.status, 'pending', 'starts awaiting input');
  assert.equal(task.status, 'wait-input', 'parked on wait-input, not pending, so it is never scheduled/reassigned');
  assert.equal(store.claimTask({ taskId: task.id, workerId: 'w', internal: true }), null,
    'dispatcher cannot claim while awaiting input');
  assert.equal(store.claimTask({ taskId: task.id, workerId: 'remote' }), null,
    'a remote client cannot claim while awaiting input either');
  assert.equal(store.getTask(task.id)?.status, 'wait-input', 'task stays on wait-input, not claimed');

  const answered = store.submitInteraction({ taskId: task.id, responses: { q1: 'staging' }, submittedBy: 'wayne' });
  assert.equal(answered?.interaction?.status, 'submitted');
  assert.equal(answered?.status, 'pending', 'released to pending for scheduling once answers are submitted');
  assert.equal(answered?.context?.humanInput?.['Which env?'], 'staging', 'answer mirrored into humanInput');

  const claimed = store.claimTask({ taskId: task.id, workerId: 'w', internal: true });
  assert.equal(claimed?.status, 'in-progress', 'now claimable once input is submitted');
});

test('claimTask is unaffected by an interaction packet with no fields', () => {
  const { store } = makeStore();
  const task = store.createTask({
    title: 'empty packet',
    from: { platform: 'p', agent: 'a' },
    interaction: { fields: [] },
  } as any);
  assert.equal(store.claimTask({ taskId: task.id, workerId: 'w', internal: true })?.status, 'in-progress',
    'an empty interaction never blocks claiming');
});
