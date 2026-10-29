import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, classifyCliFailure } from './dispatcher.js';
import { verifyOutput } from './result-verifier.js';
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
  const cooled: string[] = [];
  const store = {
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    getAgentPersona: () => null,
    brainCooldownUntil: () => undefined,
    noteBrainRateLimited: (b: string) => { cooled.push(b); return ''; },
    clearBrainRateLimited: () => {}
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
  return { guard, put, tasks, dispatcher, cooled };
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
  assert.deepEqual(decision, { action: 'complete' });
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
  assert.deepEqual(decision, { action: 'complete' }, 'guard must not touch non-brain completions');
});

test('verifier disabled → reported soft failures pass through untouched', async () => {
  const { guard, put } = harness(false);
  const task = put(chainRung('t7'));
  const decision = await guard(task, "You've hit your session limit");
  assert.deepEqual(decision, { action: 'complete' }, 'with the verifier off, exit-0 results are trusted');
});

test('a reported rate-limit refusal cools the brain; an LLM rejection that mentions rate limits does not', async () => {
  const { guard, put, dispatcher, cooled } = harness();
  await guard(put(chainRung('rl1')), "You've hit your usage limit · resets 5pm");
  assert.deepEqual(cooled, ['remote-examplehost-cc-opus'], 'CLI refusal → cooldown');

  // A real (long) deliverable the LLM verifier rejects, with rate-limit words in its free-text reason.
  (dispatcher as any).config.orchestration.verifier.llm = { enabled: true };
  (dispatcher as any).llmVerdict = async () => ({ ok: false, reason: 'verifier LLM: it only explains why the API said "too many requests"' });
  const decision = await guard(put(chainRung('rl2')), '# Postmortem\n\nThe upstream API was rate-limited (429 too many requests); here is the full fix and tests.' + '\n\nDetail. '.repeat(200));
  assert.equal(decision.action, 'handover');
  assert.deepEqual(cooled, ['remote-examplehost-cc-opus'], 'no second cooldown from free text');
});

test('classifyCliFailure: a timeout cools the brain only when the stderr tail is a rate limit', async () => {
  const timedOut = (stderr: string) => ({ text: `TIMEOUT after 600000ms\n\n${stderr}`, stderr });
  const early = ['retrying after 429 Too Many Requests', 'ok', 'tool call 1', 'tool call 2', 'tool call 3', 'tool call 4'].join('\n');
  for (const [stderr, expected] of [[early, false], [early + '\nError: 429 Too Many Requests', true], ['', false]] as const) {
    const run = { exec: 'claude', ...timedOut(stderr) };
    const det = verifyOutput(run.text, false);
    const r = await classifyCliFailure(run, det, det.reason!, async () => { throw new Error('agy probe must not run'); });
    assert.equal(r.rateLimited, expected, `stderr tail ${JSON.stringify(stderr.split('\n').at(-1))}`);
    assert.equal(r.failReason, 'TIMEOUT after 600000ms');
  }
});

test('classifyCliFailure: agy model rejection → transient outage cools, retired model does not', async () => {
  const text = 'Error: model "gemini-3-pro" is not recognized as a known model';
  const det = verifyOutput(text, false);
  const transient = await classifyCliFailure({ exec: 'agy', model: 'gemini-3-pro', text, stderr: '' }, det, det.reason!, async () => null);
  assert.equal(transient.rateLimited, true, 'catalog unavailable (503/429) → rate-limit class');
  assert.match(transient.failReason, /could not load its model catalog/);
  assert.equal(transient.agyDiag, transient.failReason);

  const retired = await classifyCliFailure({ exec: 'agy', model: 'gemini-3-pro', text, stderr: '' }, det, det.reason!, async () => ['gemini-3.5-pro']);
  assert.equal(retired.rateLimited, false, 'a retired model is a real failure, not a cooldown');
  assert.match(retired.failReason, /is retired/);

  // The same text from a non-agy brain, or quoted in a long deliverable, is not diagnosed.
  const other = await classifyCliFailure({ exec: 'claude', text, stderr: '' }, det, det.reason!, async () => null);
  assert.equal(other.agyDiag, undefined);
  const long = 'Report\n' + text + '\n' + 'detail\n'.repeat(20);
  const quoted = await classifyCliFailure({ exec: 'agy', model: 'gemini-3-pro', text: long, stderr: '' }, { ok: false, reason: 'LLM said no' }, 'LLM said no', async () => null);
  assert.deepEqual([quoted.agyDiag, quoted.rateLimited, quoted.failReason], [undefined, false, 'LLM said no']);
});

// ── Conversational turns (voice assistant) ────────────────────────────────────

test('a conversational turn that asks the user a question completes (never wait-input)', async () => {
  const { guard, put } = harness();
  const q = 'Could you clarify who the audience is? I recommend developers.';
  // Same text on a normal task is parked as a question…
  const normal = put(chainRung('c1'));
  assert.equal((await guard(normal, q)).action, 'wait-input');
  // …but a conversational turn's question IS its reply.
  const conv = put({ ...chainRung('c2'), context: { ...chainRung('c2').context, conversational: true } });
  assert.deepEqual(await guard(conv, q), { action: 'complete' });
});

test('a conversational turn still hands over on a rate-limit notice', async () => {
  const { guard, put } = harness();
  const conv = put({ ...chainRung('c3'), context: { ...chainRung('c3').context, conversational: true } });
  assert.equal((await guard(conv, "You've hit your session limit. Please try again later.")).action, 'handover');
});
