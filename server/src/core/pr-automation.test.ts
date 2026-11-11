import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrUrls, openedPrUrls, escalationHits, decidePrAction, prInScope, prWatchTaskSpec } from './pr-automation.js';
import { PS_DEFAULTS } from '../config.js';
import { pstackHarness } from './pstack-test-harness.js';
import { normalizeRecurrence } from './recurrence.js';

const cfg = { ...PS_DEFAULTS.prAutomation, repos: ['acme/widget'] };

test('extractPrUrls finds distinct GitHub PR URLs', () => {
  const refs = extractPrUrls('opened https://github.com/acme/widget/pull/42 and again https://github.com/acme/widget/pull/42, also https://github.com/o/r/pull/7.');
  assert.deepEqual(refs.map(r => [r.repo, r.number]), [['acme/widget', 42], ['o/r', 7]]);
  assert.deepEqual(extractPrUrls('no pr here https://github.com/o/r/issues/3'), []);
});

test('escalation filter: auth, secrets, deploy, workflows, config.json always go to a human', () => {
  const hits = escalationHits(['server/src/core/auth.ts', 'README.md', '.github/workflows/ci.yml', 'deploy/x.sh', 'config.json', 'src/a.ts'], cfg);
  assert.deepEqual(hits, ['server/src/core/auth.ts', '.github/workflows/ci.yml', 'deploy/x.sh', 'config.json']);
  assert.deepEqual(escalationHits(['src/a.ts', 'docs/b.md'], cfg), []);
});

test('decidePrAction: shadow never approves or merges', () => {
  const base = { cfg, watch: 'READY' as const, verdict: 'PASS' as const, verifiedPatchId: 'p1', headPatchId: 'p1', files: ['src/a.ts'] };
  assert.equal(decidePrAction(base).action, 'comment');
  assert.equal(decidePrAction({ ...base, cfg: { ...cfg, mode: 'approve' } }).action, 'approve');
  assert.equal(decidePrAction({ ...base, cfg: { ...cfg, mode: 'merge' } }).action, 'merge');
  assert.equal(decidePrAction({ ...base, cfg: { ...cfg, mode: 'merge' }, files: ['deploy/x'] }).action, 'escalate');
  assert.equal(decidePrAction({ ...base, cfg: { ...cfg, mode: 'merge' }, headPatchId: 'p2' }).action, 'wait', 'patch-id drift');
  assert.equal(decidePrAction({ ...base, watch: 'BLOCKER' }).action, 'wait');
  assert.equal(decidePrAction({ ...base, verdict: 'FAIL' }).action, 'fix');
  assert.equal(decidePrAction({ ...base, verdict: 'FAIL', fixRounds: 2 }).action, 'escalate');
  assert.equal(decidePrAction({ ...base, verdict: undefined }).action, 'wait');
});

test('prInScope + prWatchTaskSpec: recurring, shadow-mode instructions, valid recurrence', () => {
  const ref = extractPrUrls('https://github.com/acme/widget/pull/5')[0];
  assert.equal(prInScope(ref, cfg), true);
  assert.equal(prInScope({ ...ref, repo: 'other/repo' }, cfg), false);
  assert.equal(prInScope(ref, { ...cfg, enabled: false }), false);
  const spec = prWatchTaskSpec(ref, { id: 'parent1' } as any, cfg);
  assert.equal(spec.context.prUrl, ref.url);
  assert.match(spec.description, /SHADOW MODE[^\n]*Do NOT approve or merge/);
  assert.match(spec.description, /gh auth status/);
  assert.deepEqual(normalizeRecurrence(spec.recurrence), { type: 'minutes', interval: 10 });
});

test('dispatcher hook: a result with a PR URL sets context.prUrl and spawns one pr-watch task', () => {
  const h = pstackHarness({ prAutomation: cfg });
  const t = h.mk({ persona: 'engineer' });
  const fresh = h.store.getTask(t.id)!;
  (h.dispatcher as any).notePrUrls(fresh, 'Opened https://github.com/acme/widget/pull/77\nSTATUS: DONE');
  h.store.saveTask(fresh);
  assert.equal(h.store.getTask(t.id)!.context!.prUrl, 'https://github.com/acme/widget/pull/77');
  const watchers = () => h.store.listTasks({}).filter(x => x.context?.prWatch);
  assert.equal(watchers().length, 1);
  assert.equal(watchers()[0].recurrence?.type, 'minutes');
  (h.dispatcher as any).notePrUrls(h.store.getTask(t.id)!, 'again https://github.com/acme/widget/pull/77');
  assert.equal(watchers().length, 1, 'no duplicate watcher');
  // out-of-scope repo: prUrl recorded, no watcher
  const t2 = h.mk({});
  (h.dispatcher as any).notePrUrls(t2, 'https://github.com/someone/else/pull/1');
  assert.equal(t2.context!.prUrl, 'https://github.com/someone/else/pull/1');
  assert.equal(watchers().length, 1);
});

test('openedPrUrls: a merely quoted PR URL never spawns a watcher (injection guard)', () => {
  assert.equal(openedPrUrls('see https://github.com/acme/widget/pull/9 for context').length, 0);
  assert.equal(openedPrUrls('PR_OPENED: https://github.com/acme/widget/pull/9').length, 1);
  assert.equal(openedPrUrls('Opened https://github.com/acme/widget/pull/9').length, 1);
  const h = pstackHarness({ prAutomation: cfg });
  const t = h.mk({});
  (h.dispatcher as any).notePrUrls(t, 'Reviewed https://github.com/acme/widget/pull/11 as asked');
  assert.equal(t.context!.prUrl, 'https://github.com/acme/widget/pull/11', 'prUrl still recorded');
  assert.equal(h.store.listTasks({}).filter(x => x.context?.prWatch).length, 0);
});
