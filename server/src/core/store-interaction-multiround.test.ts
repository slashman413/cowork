import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Regression: submitting answers to a wait-input task must RELEASE it to `pending`
 * AND preserve answers across multiple rounds. Before the fix, submitInteraction
 * rebuilt context.humanInput from only the current interaction packet, so when an
 * agent paused a second time (parkForInput installs a fresh packet) the earlier
 * round's answers were dropped — the re-dispatched agent lost the context it had
 * already been given, re-asked, and the task bounced straight back to wait-input,
 * looking like "the task doesn't run after I submit my answers".
 */
function makeStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ix-'));
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
  return new Store(config, new EventBus());
}

test('submitting answers releases a wait-input task back to pending', () => {
  const store = makeStore();
  const t = store.createTask({ title: 'Ship it', description: 'd', context: { persona: 'engineer' } });
  store.parkForInput({ taskId: t.id, questions: ['Which cloud provider?'] });
  assert.equal(store.getTask(t.id)!.status, 'wait-input');

  const released = store.submitInteraction({ taskId: t.id, responses: { q1: 'AWS' } })!;
  assert.equal(released.status, 'pending', 'answered task must be released for re-dispatch');
  assert.equal(released.interaction!.status, 'submitted');
  assert.equal(released.context!.humanInput!['Which cloud provider?'], 'AWS');
});

test('answers accumulate across multiple wait-input rounds', () => {
  const store = makeStore();
  const t = store.createTask({ title: 'Migrate the DB', description: 'd', context: { persona: 'engineer' } });

  // Round 1: agent asks for the repo path, user answers.
  store.parkForInput({ taskId: t.id, questions: ['What is your project path?'] });
  store.submitInteraction({ taskId: t.id, responses: { q1: '/home/me/app' } });

  // Round 2: agent re-runs and asks a DIFFERENT follow-up, user answers.
  store.parkForInput({ taskId: t.id, questions: ['Which database — postgres or mysql?'] });
  const after = store.submitInteraction({ taskId: t.id, responses: { q1: 'postgres' } })!;

  const hi = after.context!.humanInput!;
  assert.equal(hi['What is your project path?'], '/home/me/app', 'round-1 answer must survive round-2 submit');
  assert.equal(hi['Which database — postgres or mysql?'], 'postgres');
  assert.equal(after.status, 'pending');
});

test('re-answering the same question overwrites the prior value', () => {
  const store = makeStore();
  const t = store.createTask({ title: 'Fix it', description: 'd', context: { persona: 'engineer' } });
  store.parkForInput({ taskId: t.id, questions: ['API base URL?'] });
  store.submitInteraction({ taskId: t.id, responses: { q1: 'http://old' } });
  store.parkForInput({ taskId: t.id, questions: ['API base URL?'] });
  const after = store.submitInteraction({ taskId: t.id, responses: { q1: 'http://new' } })!;
  assert.equal(after.context!.humanInput!['API base URL?'], 'http://new');
});
