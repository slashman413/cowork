import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForgejoClient, shepherdForgejoPr } from './forgejo-shepherd.js';
import { extractPrUrls, prInScope, prWatchTaskSpec, modeFor, openedPrUrls } from './pr-automation.js';
import { PS_DEFAULTS } from '../config.js';
import type { PrAutomationConfig } from '../types.js';
import { pstackHarness } from './pstack-test-harness.js';

const BASE = 'http://localhost:3001';
const cfg: PrAutomationConfig = {
  ...PS_DEFAULTS.prAutomation,
  repos: ['cowork/pr-sandbox'],
  repoModes: { 'cowork/pr-sandbox': 'merge' },
  forges: [{ kind: 'forgejo', baseUrl: BASE, tokenFile: '/dev/null', botUser: 'cowork-bot' }],
};
const ref = extractPrUrls(`PR_OPENED: ${BASE}/cowork/pr-sandbox/pulls/3`)[0];

/** In-memory Forgejo: records every write so tests can assert what the shepherd did. */
function fakeForge(pr: Record<string, any>, opts: { files?: string[]; ci?: { state: string; total_count: number }; reviews?: any[] } = {}) {
  const writes: string[] = [];
  const state = { merged: false, ...pr };
  const f = (async (url: string, init: any) => {
    const p = url.replace(`${BASE}/api/v1`, '').replace(/\?.*$/, '');
    const m = init?.method || 'GET';
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (m !== 'GET') writes.push(`${m} ${p}`);
    if (m === 'GET' && p === '/repos/cowork/pr-sandbox/pulls/3') return json({ state: 'open', mergeable: true, labels: [{ name: 'cowork-auto' }], user: { login: 'cowork-author' }, head: { sha: 'abc123' }, ...state });
    if (p.endsWith('/files')) {
      const page = Number(new URL(url).searchParams.get('page') || 1), lim = Number(new URL(url).searchParams.get('limit') || 50);
      const all = (opts.files || ['README.md']).map(f => f.includes('<-') ? { filename: f.split('<-')[0], previous_filename: f.split('<-')[1] } : { filename: f });
      return json(all.slice((page - 1) * lim, page * lim));
    }
    if (p.includes('/commits/')) return json(opts.ci || { state: '', total_count: 0 });
    if (m === 'GET' && p.endsWith('/reviews')) return json(opts.reviews || []);
    if (m === 'POST' && p.endsWith('/merge')) { state.merged = true; state.state = 'closed'; return new Response('', { status: 200 }); }
    if (m === 'POST') return json({ id: 1 }, 201);
    return json({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
  return { client: new ForgejoClient(BASE, 't', f), writes };
}

test('Forgejo PR URLs are detected; only configured hosts are in scope', () => {
  assert.deepEqual([ref.repo, ref.number, ref.forge, ref.baseUrl], ['cowork/pr-sandbox', 3, 'forgejo', BASE]);
  assert.equal(prInScope(ref, cfg), true);
  const evil = extractPrUrls('PR_OPENED: http://evil.example:3001/cowork/pr-sandbox/pulls/3')[0];
  assert.equal(prInScope(evil, cfg), false, 'unknown forge host must not be called');
  assert.equal(openedPrUrls(`see ${BASE}/cowork/pr-sandbox/pulls/3`).length, 0, 'quoted URL does not spawn a watcher');
  assert.equal(modeFor('cowork/pr-sandbox', cfg), 'merge');
  assert.equal(modeFor('slashman413/cowork', cfg), 'shadow');
});

test('Forgejo pr-watch spec routes all writes through the pr-shepherd CLI', () => {
  const spec = prWatchTaskSpec(ref, { id: 'T1' } as any, cfg);
  assert.match(spec.description, /server\/src\/cli\/pr-shepherd\.ts --pr http:\/\/localhost:3001\/cowork\/pr-sandbox\/pulls\/3/);
  assert.doesNotMatch(spec.description, /gh pr/);
  assert.equal(spec.context.prForge, 'forgejo');
  assert.equal(spec.context.prMode, 'merge');
});

test('status pass (no verdict) performs no writes', async () => {
  const { client, writes } = fakeForge({});
  const r = await shepherdForgejoPr({ ref, cfg, client });
  assert.equal(r.watch, 'READY');
  assert.equal(r.action, 'wait');
  assert.deepEqual(writes, []);
});

test('merge mode: PASS on the verified head → approve, squash-merge, read-back', async () => {
  const { client, writes } = fakeForge({});
  const r = await shepherdForgejoPr({ ref, cfg, client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.equal(r.status, 'DONE');
  assert.deepEqual(r.performed, ['approve', 'merge:squash', 'read-back:merged']);
  assert.deepEqual(writes, ['POST /repos/cowork/pr-sandbox/pulls/3/reviews', 'POST /repos/cowork/pr-sandbox/pulls/3/merge']);
});

test('head drift, escalation paths, bot-authored and unlabelled PRs never merge', async () => {
  let f = fakeForge({});
  let r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'PASS', verifiedSha: 'old999' });
  assert.equal(r.action, 'wait'); assert.deepEqual(f.writes, []);

  f = fakeForge({}, { files: ['deploy/run.sh'] });
  r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.equal(r.status, 'NEEDS_HUMAN'); assert.deepEqual(f.writes, ['POST /repos/cowork/pr-sandbox/issues/3/comments']);

  f = fakeForge({ user: { login: 'cowork-bot' } });
  r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.equal(r.status, 'BLOCKED'); assert.deepEqual(f.writes, []);

  f = fakeForge({ labels: [] });
  r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.equal(r.status, 'BLOCKED'); assert.deepEqual(f.writes, []);

  f = fakeForge({}, { ci: { state: 'failure', total_count: 1 } });
  r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.equal(r.watch, 'BLOCKER'); assert.deepEqual(f.writes, []);
});

test('shadow mode comments only; approve mode approves without merging; FAIL asks for a fix', async () => {
  const shadow = { ...cfg, repoModes: {} };
  let f = fakeForge({});
  let r = await shepherdForgejoPr({ ref, cfg: shadow, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.deepEqual(r.performed, ['comment']);

  f = fakeForge({});
  r = await shepherdForgejoPr({ ref, cfg: { ...cfg, repoModes: { 'cowork/pr-sandbox': 'approve' } }, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.deepEqual(r.performed, ['approve']);
  assert.ok(!f.writes.some(w => w.endsWith('/merge')));

  f = fakeForge({});
  r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'FAIL', verifiedSha: 'abc123' });
  assert.equal(r.action, 'fix'); assert.ok(!f.writes.some(w => w.endsWith('/merge') || w.endsWith('/reviews')));
});

test('an existing bot approval on the head is not duplicated', async () => {
  const { client, writes } = fakeForge({}, { reviews: [{ state: 'APPROVED', user: { login: 'cowork-bot' }, commit_id: 'abc123' }] });
  const r = await shepherdForgejoPr({ ref, cfg, client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.deepEqual(r.performed, ['merge:squash', 'read-back:merged']);
  assert.deepEqual(writes, ['POST /repos/cowork/pr-sandbox/pulls/3/merge']);
});

test('a non-official bot approval (made before branch protection) is re-issued', async () => {
  const { client, writes } = fakeForge({}, { reviews: [{ state: 'APPROVED', user: { login: 'cowork-bot' }, commit_id: 'abc123', official: false }] });
  const r = await shepherdForgejoPr({ ref, cfg, client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.deepEqual(r.performed, ['approve', 'merge:squash', 'read-back:merged']);
  assert.equal(writes.length, 2);
});

test('dispatcher hook: an opened Forgejo PR spawns one shepherd pr-watch; unknown hosts spawn none', () => {
  const h = pstackHarness({ prAutomation: cfg });
  const t = h.mk({ agent: 'engineer' });
  (h.dispatcher as any).notePrUrls(t, `PR_OPENED: ${BASE}/cowork/pr-sandbox/pulls/9\nSTATUS: DONE`);
  assert.equal(t.context!.prUrl, `${BASE}/cowork/pr-sandbox/pulls/9`);
  const watchers = () => h.store.listTasks({}).filter(x => x.context?.prWatch);
  assert.equal(watchers().length, 1);
  assert.equal(watchers()[0].context!.prForge, 'forgejo');
  assert.match(watchers()[0].description, /pr-shepherd\.ts/);
  const t2 = h.mk({});
  (h.dispatcher as any).notePrUrls(t2, 'PR_OPENED: http://evil.example/cowork/pr-sandbox/pulls/1');
  assert.equal(watchers().length, 1);
});

test('escalation sees every page of files and the old path of renames; a capped list fails closed', async () => {
  const many = Array.from({ length: 120 }, (_, i) => `src/f${i}.ts`).concat(['deploy/late.sh']);
  let f = fakeForge({}, { files: many });
  let r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.equal(r.status, 'NEEDS_HUMAN', 'file on page 3 must be seen');
  f = fakeForge({}, { files: ['docs/innocent.md<-deploy/run.sh'] });
  r = await shepherdForgejoPr({ ref, cfg, client: f.client, verdict: 'PASS', verifiedSha: 'abc123' });
  assert.equal(r.status, 'NEEDS_HUMAN', 'rename away from an escalation path');
  const listed = await fakeForge({}, { files: many }).client.files('cowork/pr-sandbox', 3, 50, 2);
  assert.equal(listed.complete, false);
});
