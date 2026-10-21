import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.js';
import type { Config, Task } from '../types.js';

/**
 * Regression: a result that is a genuine QUESTION back to the user must be parked
 * on `wait-input`, NOT handed to the next brain — EVEN when the optional LLM
 * quality verifier is enabled.
 *
 * The LLM verifier is contractually told to FAIL any result that "does not
 * actually address the task" (see buildVerifierPrompt), which is exactly what a
 * request-for-input looks like. Before the fix, verifyReportedCompletion ran the
 * full verifier (deterministic + LLM) and only inspected the result for an input
 * request when the verdict was ok — so an enabled LLM gate turned every question
 * into a handover and stranded it. The fix gives input-request detection
 * precedence over the LLM gate (but still after the deterministic failure gate).
 *
 * We stub `llmVerdict` to force a FAIL so the test is deterministic and does not
 * spawn a real verifier CLI.
 */

const CHAIN = ['remote-examplehost-cc-opus', 'remote-examplehost-cc-fable', 'local-cc-opus'];

function harness(stubLlmFail: boolean) {
  const tasks = new Map<string, Task>();
  const store = {
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    getAgentPersona: () => null,
    brainCooldownUntil: () => undefined,
    noteBrainRateLimited: () => '',
    clearBrainRateLimited: () => {}
  };
  const config = {
    inbox: { maxRetries: 3 },
    orchestration: {
      // LLM gate "enabled" — but we stub the method so no process is spawned.
      verifier: { enabled: true, llm: { enabled: true } },
      agents: { engineer: { description: '', brains: CHAIN } },
      brains: {
        'remote-examplehost-cc-opus': { location: 'remote' },
        'remote-examplehost-cc-fable': { location: 'remote' },
        'local-cc-opus': { location: 'local' }
      }
    }
  } as unknown as Config;
  const dispatcher = new Dispatcher(config, store as any, {} as any);
  // Force the LLM gate to REJECT everything, simulating a verifier that (correctly
  // for its own purpose) judges a bare question as "does not address the task".
  if (stubLlmFail) {
    (dispatcher as any).llmVerdict = async () => ({ ok: false, reason: 'verifier LLM: off-topic' });
  }
  const guard = (t: Task, r?: string) => (dispatcher as any).verifyReportedCompletion(t, r);
  const put = (t: Partial<Task> & { id: string }) => { tasks.set(t.id, t as Task); return tasks.get(t.id)!; };
  return { guard, put, tasks };
}

function chainRung(id: string, attempt = 0): Partial<Task> & { id: string } {
  return { id, title: 'ship it', description: '', status: 'in-progress',
    context: { agent: 'engineer', brain: CHAIN[attempt], brainAuto: true, attempts: attempt } };
}

test('a reported NEEDS_INPUT question parks on wait-input even when the LLM verifier would fail it', async () => {
  const { guard, put } = harness(true);
  const task = put(chainRung('q1'));
  const decision = await guard(
    task,
    'I started but cannot finish.\nNEEDS_INPUT: Which cloud provider should I target — AWS or GCP?'
  );

  assert.equal(decision.action, 'wait-input', 'a question must NOT be handed to the next brain');
  assert.ok(Array.isArray(decision.questions) && decision.questions.length >= 1);
  assert.match(decision.questions[0], /cloud provider/i);
});

test('a heuristic-phrase question parks on wait-input ahead of the LLM gate', async () => {
  const { guard, put } = harness(true);
  const task = put(chainRung('q2'));
  const decision = await guard(task, 'I cannot proceed without the production API key. Could you provide it?');
  assert.equal(decision.action, 'wait-input');
});

test('a real deliverable still reaches the LLM gate and is rejected as a failure (handover)', async () => {
  // Guards the precedence the other way: a NON-question result the LLM rejects
  // must still hand over — the input-request bypass must not swallow real fails.
  const { guard, put, tasks } = harness(true);
  const task = put(chainRung('d1'));
  const decision = await guard(task, 'Here is the finished report. Everything is complete and shipped.');
  assert.equal(decision.action, 'handover', 'a non-question the LLM fails must hand over, not complete');
  assert.equal(tasks.get('d1')!.context!.attempts, 1);
});

test('a soft failure is decided before input detection (rate-limit is a handover, not a question)', async () => {
  const { guard, put } = harness(false);
  const task = put(chainRung('f1'));
  // Contains a question mark, but the deterministic failure gate must win.
  const decision = await guard(task, 'rate limit reached. want me to retry?');
  assert.equal(decision.action, 'handover');
});
