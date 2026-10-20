import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.js';
import type { Config, Task } from '../types.js';

/**
 * These tests exercise the completion GUARD — the fix for "a remote brain that
 * reported 'you've hit your session limit' got marked done". When a remote
 * brain's client reports its result, store.completeTask runs this guard; a soft
 * failure must be REJECTED so the task hands over to the next brain in the chain
 * instead of completing. No brain is spawned (the verifier's deterministic gate
 * runs inline). We call the guard directly with a fake store.
 */

const CHAIN = ['remote-examplehost-cc-opus', 'remote-examplehost-cc-fable', 'local-cc-opus'];

function harness(verifierEnabled = true) {
  const tasks = new Map<string, Task>();
  const store = {
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    getAgentPersona: () => null
  };
  const config = {
    inbox: { maxRetries: 3 },
    orchestration: {
      verifier: { enabled: verifierEnabled },
      agents: { engineer: { description: '', brains: CHAIN } },
      brains: {
        'remote-examplehost-cc-opus': { location: 'remote' },
        'remote-examplehost-cc-fable': { location: 'remote' },
        'local-cc-opus': { location: 'local' }
      }
    }
  } as unknown as Config;
  const dispatcher = new Dispatcher(config, store as any, {} as any);
  const guard = (t: Task, r?: string) => (dispatcher as any).verifyReportedCompletion(t, r);
  const put = (t: Partial<Task> & { id: string }) => { tasks.set(t.id, t as Task); return tasks.get(t.id)!; };
  return { guard, put, tasks };
}

function chainRung(id: string, attempt = 0): Partial<Task> & { id: string } {
  return { id, title: 'do it', description: '', status: 'in-progress',
    context: { agent: 'engineer', brain: CHAIN[attempt], brainAuto: true, attempts: attempt } };
}

test('a reported session-limit result hands over to the next brain (not done)', async () => {
  const { guard, put, tasks } = harness();
  const task = put(chainRung('t1'));
  const decision = await guard(task, "You've hit your session limit. Please try again later.");

  assert.equal(decision.action, 'handover');
  const t = tasks.get('t1')!;
  assert.equal(t.status, 'pending', 'task must be re-queued, not completed');
  assert.equal(t.context!.attempts, 1, 'attempt advanced to the next chain rung');
  assert.equal(t.context!.brain, undefined, 'auto brain pin cleared so planFor picks the next brain');
  const failed = t.context!.failedBrains as Array<{ brain: string; reason: string }>;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].brain, 'remote-examplehost-cc-opus');
  assert.match(failed[0].reason, /failure pattern/i);
});

test('a genuine reported deliverable is allowed to complete', async () => {
  const { guard, put } = harness();
  const task = put(chainRung('t2'));
  const decision = await guard(task, '# Implementation\n\nHere is the finished feature with full detail and tests.');
  assert.equal(decision.action, 'complete');
  assert.equal(decision.result, undefined, 'result not rewritten');
});

test('an empty reported result hands over', async () => {
  const { guard, put } = harness();
  const task = put(chainRung('t3'));
  const decision = await guard(task, '   ');
  assert.equal(decision.action, 'handover');
});

test('chain exhausted → completes as FAILED with the failed-brain summary', async () => {
  const { guard, put } = harness();
  // Last rung (index 2); a failure here has no next brain.
  const task = put(chainRung('t4', 2));
  const decision = await guard(task, 'rate limit reached, try again');
  assert.equal(decision.action, 'complete');
  assert.match(decision.result || '', /FAILED after 3 attempt/);
  assert.match(decision.result || '', /chain exhausted/);
  assert.match(decision.result || '', /local-cc-opus/);
});

test('a user-pinned brain retries itself (not the chain) up to maxRetries', async () => {
  const { guard, put, tasks } = harness();
  // brainAuto absent → user pin. Retries the same brain.
  const task = put({ id: 't5', title: 'x', description: '', status: 'in-progress',
    context: { agent: 'engineer', brain: 'remote-examplehost-cc-opus', attempts: 0 } });
  const decision = await guard(task, 'quota exceeded for this key');
  assert.equal(decision.action, 'handover');
  const t = tasks.get('t5')!;
  assert.equal(t.context!.brain, 'remote-examplehost-cc-opus', 'pinned brain kept for retry');
  assert.equal(t.context!.attempts, 1);
});

test('a completion not attributable to a brain passes straight through', async () => {
  const { guard, put } = harness();
  // No context.brain — e.g. a human agent or pipeline reporting completion.
  const task = put({ id: 't6', title: 'x', description: '', status: 'in-progress', context: {} });
  const decision = await guard(task, "You've hit your session limit");
  assert.equal(decision.action, 'complete', 'guard must not touch non-brain completions');
  assert.equal(decision.result, undefined);
});

test('verifier disabled → reported soft failures pass through untouched', async () => {
  const { guard, put } = harness(false);
  const task = put(chainRung('t7'));
  const decision = await guard(task, "You've hit your session limit");
  assert.equal(decision.action, 'complete', 'with the verifier off, exit-0 results are trusted');
  assert.equal(decision.result, undefined);
});
