import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharpenPending, SHARPEN_WAIT_MS } from './pstack-gates.js';
import { pstackHarness } from './pstack-test-harness.js';

/** G2: the executor must not race a background intake sharpen. */
test('sharpenPending: defers only while a fresh sharpen has not written acceptance', () => {
  const now = Date.parse('2026-11-03T00:01:00Z');
  const t = (ctx: any) => ({ id: 'x', title: 't', context: ctx } as any);
  assert.equal(sharpenPending(t({}), now), false, 'never sharpened');
  assert.equal(sharpenPending(t({ sharpenStartedAt: '2026-11-03T00:00:30Z' }), now), true, '30 s old, no acceptance');
  assert.equal(sharpenPending(t({ sharpenStartedAt: '2026-11-03T00:00:30Z', acceptance: ['a'] }), now), false, 'acceptance landed');
  assert.equal(sharpenPending(t({ sharpenStartedAt: new Date(now - SHARPEN_WAIT_MS - 1).toISOString() }), now), false, 'timed out');
  assert.equal(sharpenPending(t({ sharpenStartedAt: '2026-11-03T00:00:30Z', sharpenDoneAt: 'x' }), now), false, 'sharpen finished without criteria');
});

test('dispatcher tick: a task mid-sharpen is held pending with a reason, not executed', async () => {
  const h = pstackHarness({ enabled: true });
  const t = h.mk({ agent: 'engineer', sharpenStartedAt: new Date().toISOString() });
  let executed = 0;
  (h.dispatcher as any).execute = async () => { executed++; };
  (h.dispatcher as any).agentId = 'disp';
  await (h.dispatcher as any).tick();
  const after = h.store.getTask(t.id)!;
  assert.equal(executed, 0);
  assert.equal(after.status, 'pending');
  assert.match(JSON.stringify(after), /brief sharpener/);
});

test('buildPrompt sees acceptance written after the claim (re-read before prompt)', () => {
  const h = pstackHarness();
  const t = h.mk({ agent: 'engineer' });
  const stale = structuredClone(t);
  const fresh = h.store.getTask(t.id)!;
  fresh.context = { ...fresh.context, acceptance: ['sharpened criterion ZZQ'], acceptanceSource: 'sharpened' };
  h.store.saveTask(fresh);
  // execute() re-reads the task right before buildPrompt; emulate that step.
  const latest = h.store.getTask(stale.id)!;
  stale.context = { ...latest.context };
  const prompt = (h.dispatcher as any).buildPrompt(stale, { agent: 'engineer', isRoster: false, exec: 'claude', brainId: 'local-cc-opus-5-5' });
  assert.match(prompt, /sharpened criterion ZZQ/);
});
