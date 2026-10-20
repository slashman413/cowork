import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { Store, isFailedTask } from './store.js';
import { EventBus } from './events.js';
import type { Config, Task } from '../types.js';

/**
 * P0-2 / P0-4: the STATUS / EVIDENCE footer and RULING lines, end to end through
 * a REAL Store's completeTask guard (the remote-brain completion path):
 *   DONE                → done
 *   DONE_WITH_CONCERNS  → done + context.qualityFlag = "concerns" + CONCERNS text
 *   BLOCKED             → failed with the reason, NOT handed to the next brain,
 *                         lessons.jsonl gets kind "blocked"
 *   no footer           → unchanged (done), context.hasEvidence = false
 * The LLM gate is stubbed to FAIL so a BLOCKED result provably skips it.
 */

const CHAIN = ['remote-examplehost-cc-opus', 'remote-examplehost-cc-fable', 'local-cc-opus'];

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-footer-'));
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
  return { store, rung, lessons, llm: () => llmCalls, failLlm: () => { (dispatcher as any).llmVerdict = async () => { llmCalls++; return { ok: false, reason: 'verifier LLM: off-topic' }; }; } };
}

test('STATUS: DONE → done, evidence recorded, rulings collected', async () => {
  const h = harness();
  const t = h.rung();
  const out = await h.store.completeTask({ taskId: t.id, result: [
    'Shipped the fix.',
    'RULING: used the existing parser — smaller diff — a second parser later if formats diverge',
    'STATUS: DONE',
    'EVIDENCE:',
    '- npm run build → exit 0',
  ].join('\n') });
  assert.equal(out!.status, 'done');
  assert.equal(isFailedTask(out!), false);
  assert.equal(out!.context!.hasEvidence, true);
  assert.equal(out!.context!.resultStatus, 'DONE');
  assert.equal(out!.context!.qualityFlag, undefined);
  assert.deepEqual(out!.context!.rulings, ['used the existing parser — smaller diff — a second parser later if formats diverge']);
});

test('STATUS: DONE_WITH_CONCERNS → done but flagged with the CONCERNS text', async () => {
  const h = harness();
  const t = h.rung();
  const out = await h.store.completeTask({ taskId: t.id, result: [
    'Deployed.',
    'STATUS: DONE_WITH_CONCERNS',
    'EVIDENCE:',
    '- curl -sI https://example.test → 200',
    'CONCERNS: the CDN still serves the old og.png for ~1h',
  ].join('\n') });
  assert.equal(out!.status, 'done');
  assert.equal(isFailedTask(out!), false);
  assert.equal(out!.context!.qualityFlag, 'concerns');
  assert.match(String(out!.context!.concerns), /CDN still serves/);
  assert.equal(out!.context!.hasEvidence, true);
});

test('STATUS: BLOCKED → failed with the reason, no handover, lesson kind "blocked", LLM gate skipped', async () => {
  const h = harness();
  h.failLlm();   // a FAILing LLM gate would hand over — BLOCKED must not reach it
  const t = h.rung();
  const out = await h.store.completeTask({ taskId: t.id, result: [
    'Could not upload.',
    'STATUS: BLOCKED — the Gumroad token in ~/.priv is expired',
    'EVIDENCE:',
    '- curl api.gumroad.com/v2/user → 401',
  ].join('\n') });
  assert.equal(out!.status, 'done', 'finalised, not re-queued');
  assert.equal(isFailedTask(out!), true, 'shows as failed');
  assert.match(out!.result!, /^FAILED \(blocked\): the Gumroad token in ~\/\.priv is expired/);
  assert.equal(out!.context!.attempts, 0, 'attempt counter not advanced — no handover');
  assert.equal(out!.context!.brain, CHAIN[0], 'brain pin untouched — no handover');
  assert.equal(out!.context!.failedBrains, undefined, 'not recorded as a brain failure');
  assert.equal(out!.context!.rateLimited, undefined);
  assert.equal(h.llm(), 0, 'LLM gate never consulted');
  const ls = h.lessons();
  assert.equal(ls.length, 1);
  assert.equal(ls[0].kind, 'blocked');
  assert.match(ls[0].reason, /token .* expired/);
});

test('no footer → unchanged behaviour (done, no rejection), hasEvidence=false', async () => {
  const h = harness();
  const t = h.rung();
  const out = await h.store.completeTask({ taskId: t.id, result: 'Here is the report you asked for. It covers everything.' });
  assert.equal(out!.status, 'done');
  assert.equal(isFailedTask(out!), false);
  assert.equal(out!.result, 'Here is the report you asked for. It covers everything.');
  assert.equal(out!.context!.hasEvidence, false);
  assert.equal(out!.context!.resultStatus, undefined);
  assert.equal(h.llm(), 1, 'LLM gate still runs as before');
});

test('NEEDS_INPUT still takes precedence over a STATUS: BLOCKED footer', async () => {
  const h = harness();
  const t = h.rung();
  const out = await h.store.completeTask({ taskId: t.id, result: 'STATUS: BLOCKED — need a decision\nNEEDS_INPUT: AWS or GCP?' });
  assert.equal(out!.status, 'wait-input');
});
