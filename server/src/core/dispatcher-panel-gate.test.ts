import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewMode } from './pstack-gates.js';
import { pstackHarness } from './pstack-test-harness.js';

/** G5: the interrogate panel re-homed as a task-level gate (context.review). */
test('reviewMode resolves context.review, judgment tier and PR tasks', () => {
  const t = (ctx: any) => ({ id: 'x', title: 't', context: ctx } as any);
  assert.equal(reviewMode(t({ review: 'none' })), 'none');
  assert.equal(reviewMode(t({ review: 'llm' })), 'llm');
  assert.equal(reviewMode(t({ review: 'panel' })), 'panel');
  assert.equal(reviewMode(t({ review: 'panel' }), { enabled: false }), 'default', 'panel master switch off');
  assert.equal(reviewMode(t({ tier: 'judgment' })), 'default', 'judgment tier needs judgmentTier flag');
  assert.equal(reviewMode(t({ tier: 'judgment' }), { judgmentTier: true }), 'panel');
  assert.equal(reviewMode(t({ prUrl: 'https://github.com/a/b/pull/1' }), { judgmentTier: true }), 'panel');
  assert.equal(reviewMode(t({})), 'default');
});

function wired() {
  const h = pstackHarness();
  const calls = { llm: 0, judges: [] as string[], prompts: [] as string[] };
  (h.dispatcher as any).llmVerdict = async () => { calls.llm++; return { ok: true }; };
  (h.dispatcher as any).runSpecJudge = async (id: string, prompt: string) => {
    calls.judges.push(id); calls.prompts.push(prompt);
    return { ok: true, text: '1. PASS — fine\nVERDICT: APPROVED' };
  };
  return { h, calls };
}

test('context.review="none" skips every quality gate', async () => {
  const { h, calls } = wired();
  const t = h.mk({ review: 'none', acceptance: ['x'] });
  const v = await (h.dispatcher as any).qualityGateVerdict(t, 'done', 'local-cc-opus-5-5', 1);
  assert.equal(v.ok, true); assert.equal(calls.llm, 0); assert.equal(calls.judges.length, 0);
});

test('context.review="llm" forces the LLM verifier', async () => {
  const { h, calls } = wired();
  const t = h.mk({ review: 'llm', acceptance: ['x'] });
  await (h.dispatcher as any).qualityGateVerdict(t, 'done', 'local-cc-opus-5-5', 1);
  assert.equal(calls.llm, 1); assert.equal(calls.judges.length, 0);
});

test('context.review="panel" runs a multi-family panel even without acceptance or spec enabled', async () => {
  const { h, calls } = wired();
  const t = h.mk({ review: 'panel' });
  const v = await (h.dispatcher as any).qualityGateVerdict(t, 'STATUS: DONE', 'local-cc-opus-5-5', 1);
  assert.equal(v.ok, true);
  assert.ok(calls.judges.length >= 2, `panel ran ${calls.judges.length} judges`);
  assert.ok(!calls.judges.includes('local-cc-opus-5-5'), 'executor family excluded');
  const fams = new Set(calls.judges.map(id => id.split('-')[1]));
  assert.ok(fams.size >= 2, 'judges come from distinct families');
  const rec = h.store.getTask(t.id)!.context!.specVerdict as any;
  assert.equal(rec?.mode, 'enforce', 'explicit panel request enforces');
});

test('context.review="panel": CHANGES_REQUESTED from the panel rejects when no lead is available', async () => {
  const { h } = wired();
  (h.dispatcher as any).runSpecJudge = async () => ({ ok: true, text: '1. FAIL — missing the report\nVERDICT: CHANGES_REQUESTED' });
  const t = h.mk({ review: 'panel' });
  const v = await (h.dispatcher as any).qualityGateVerdict(t, 'STATUS: DONE', 'local-cc-opus-5-5', 1);
  assert.equal(v.ok, false);
});
