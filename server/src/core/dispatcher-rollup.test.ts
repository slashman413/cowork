import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { Store, isFailedTask } from './store.js';
import { EventBus } from './events.js';
import type { Config, Task } from '../types.js';

const CHAIN = ['remote-examplehost-cc-opus', 'remote-examplehost-cc-fable', 'local-cc-opus'];

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rollup-'));
  const paths = {
    inbox: path.join(root, 'inbox'), artifacts: path.join(root, 'artifacts'), inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'), decisions: path.join(root, 'decisions'),
    workflows: path.join(root, 'workflows'), agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
  const config = {
    paths, platforms: {},
    inbox: { maxRetries: 3 },
    orchestration: {
      verifier: { enabled: true, llm: { enabled: true } },
      agents: { engineer: { description: '', brains: CHAIN } },
      brains: Object.fromEntries(CHAIN.map(b => [b, { location: b.startsWith('local') ? 'local' : 'remote' }]))
    }
  } as unknown as Config;
  const store = new Store(config, new EventBus());
  const dispatcher = new Dispatcher(config, store, new EventBus());
  let llmCalls = 0;
  (dispatcher as any).llmVerdict = async () => { llmCalls++; return { ok: true }; };
  store.setCompletionGuard((t, r) => (dispatcher as any).verifyReportedCompletion(t, r));
  const rung = (): Task => {
    const t = store.createTask({ title: 'ship it', from: { platform: 'p', agent: 'a' } } as any);
    t.status = 'in-progress';
    t.context = { ...(t.context || {}), agent: 'engineer', brain: CHAIN[0], brainAuto: true, attempts: 0 };
    store.saveTask(t);
    return t;
  };
  const lessons = () => {
    const f = path.join(paths.decisions, 'lessons.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  };
  return { store, dispatcher, rung, lessons };
}

/**
 * PS-5 rollup rule, server side: failed tasks finish as status 'done' with a
 * FAILED result, so depsSatisfied() lets their dependents (a synthesis step)
 * run. A STATUS: DONE from such a dependent is forced to DONE_WITH_CONCERNS
 * unless its result names the failed dependency (8-char id prefix is enough).
 */
function withDeps(h: ReturnType<typeof harness>) {
  const ok = h.store.createTask({ title: 'child ok', from: { platform: 'p', agent: 'a' } } as any);
  ok.status = 'done'; ok.result = 'did it'; h.store.saveTask(ok);
  const bad = h.store.createTask({ title: 'child bad', from: { platform: 'p', agent: 'a' } } as any);
  bad.status = 'done'; bad.result = 'FAILED after 3 attempt(s) (chain exhausted).'; h.store.saveTask(bad);
  const syn = h.rung();
  syn.context = { ...(syn.context || {}), dependsOn: [ok.id, bad.id] };
  h.store.saveTask(syn);
  return { ok, bad, syn };
}

test('PS-5: dependent of a failed task can run today (depsSatisfied sees status done)', () => {
  const h = harness();
  const { syn } = withDeps(h);
  assert.equal((h.dispatcher as any).depsSatisfied(syn), true);
});

test('PS-5: STATUS: DONE that omits the failed child → DONE_WITH_CONCERNS', async () => {
  const h = harness();
  const { ok, bad, syn } = withDeps(h);
  const out = await h.store.completeTask({ taskId: syn.id, result: [
    `Synthesis: ${ok.id.slice(0, 8)} PASS.`, 'STATUS: DONE', 'EVIDENCE:', '- read child results → ok',
  ].join('\n') });
  assert.equal(out!.status, 'done');
  assert.equal(isFailedTask(out!), false);
  assert.equal(out!.context!.resultStatus, 'DONE_WITH_CONCERNS');
  assert.equal(out!.context!.qualityFlag, 'concerns');
  assert.deepEqual(out!.context!.unaccountedFailedDeps, [bad.id]);
  assert.match(String(out!.context!.concerns), new RegExp(bad.id.slice(0, 8)));
  assert.match(String(out!.context!.concerns), /gap is not a pass/);
});

test('PS-5: STATUS: DONE that names the failed child (8-char prefix) stays DONE', async () => {
  const h = harness();
  const { ok, bad, syn } = withDeps(h);
  const out = await h.store.completeTask({ taskId: syn.id, result: [
    `${ok.id.slice(0, 8)} PASS; ${bad.id.slice(0, 8)} BLOCKED (failed, chain exhausted).`,
    'STATUS: DONE', 'EVIDENCE:', '- read child results → ok',
  ].join('\n') });
  assert.equal(out!.context!.resultStatus, 'DONE');
  assert.equal(out!.context!.qualityFlag, undefined);
  assert.equal(out!.context!.unaccountedFailedDeps, undefined);
});
