import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSpecJudges } from './result-verifier.js';
import { parseLeadJudgment, applyBucketRules, buildLeadJudgmentPrompt, buildPanelReviewerPrompt, effectivePanelSize, LEAD_FILTERS_VERBATIM } from './review-panel.js';

const agents = {
  'cc-opus': { exec: 'claude', model: 'claude-opus-5-5' },
  'cc-sonnet': { exec: 'claude', model: 'claude-sonnet-5-5' },
  'agy-gemini-argon': { exec: 'agy', model: 'gemini-4-argon-medium' },
  'agy-gemini-flash': { exec: 'agy', model: 'gemini-3.8-flash-high' },
  'dsh-qwen': { exec: 'dsh', model: 'qwen3.8-27b' },
  'codex-off': { exec: 'codex', model: 'gpt-5.6', disabled: true },
} as any;
const judges = { claude: ['agy-gemini-argon', 'agy-gemini-flash'], gemini: ['cc-opus'], qwen: ['cc-opus'], default: ['cc-opus'] };

// ── Family-distinct selection ──────────────────────────────────────────────

test('selectSpecJudges: panel returns one judge per distinct family, never the executor family', () => {
  const out = selectSpecJudges('cc-sonnet', { agents, judges, panel: 2, panelPool: ['cc-opus', 'agy-gemini-flash', 'dsh-qwen', 'codex-off'] });
  assert.deepEqual(out, ['agy-gemini-argon', 'dsh-qwen']);
  // Gemini executor: claude judge first (CEO ruling), then qwen; never a second gemini.
  const g = selectSpecJudges('agy-gemini-flash', { agents, judges, panel: 3, panelPool: ['agy-gemini-argon', 'dsh-qwen', 'cc-sonnet'] });
  assert.deepEqual(g, ['cc-opus', 'dsh-qwen']);
});

test('selectSpecJudges: panel default 1 keeps the ordered single-family chain', () => {
  assert.deepEqual(selectSpecJudges('cc-sonnet', { agents, judges }), ['agy-gemini-argon', 'agy-gemini-flash']);
  assert.deepEqual(selectSpecJudges('cc-sonnet', { agents, judges, panel: 1, panelPool: ['dsh-qwen'] }), ['agy-gemini-argon', 'agy-gemini-flash']);
});

test('selectSpecJudges: panel skips cooling/disabled agents and may return fewer than asked', () => {
  const out = selectSpecJudges('cc-sonnet', { agents, judges, panel: 2, panelPool: ['codex-off'], isCooling: id => id === 'agy-gemini-argon' });
  assert.deepEqual(out, ['agy-gemini-flash']);
});

test('effectivePanelSize honours the config switch', () => {
  assert.equal(effectivePanelSize(2, { enabled: true }), 2);
  assert.equal(effectivePanelSize(2, { enabled: false }), 1);
  assert.equal(effectivePanelSize(undefined, { enabled: true }), 1);
  assert.equal(effectivePanelSize(2, undefined), 2);
});

// ── Bucket merge ───────────────────────────────────────────────────────────

const leadJson = (findings: any[]) => '```json\n' + JSON.stringify({ findings }) + '\n```';

test('parseLeadJudgment merges findings into the four buckets with families', () => {
  const lj = parseLeadJudgment(leadJson([
    { bucket: 'act_on', finding: 'SQL built by string concat in api/users.ts:42', families: ['Gemini'], rationale: 'traced input from req.query' },
    { bucket: 'consider', finding: 'retry loop has no jitter', families: ['qwen'] },
    { bucket: 'noted', finding: 'could cache the config read', families: ['gemini'] },
    { bucket: 'dismissed', finding: 'prefer a class over functions', families: ['qwen'], rationale: 'I would have done it differently' },
    { bucket: 'Dismissed', finding: 'what if input is null', families: ['gemini'] },
  ]));
  assert.equal(lj.parsed, true);
  assert.deepEqual(lj.counts, { actOn: 1, consider: 1, noted: 1, dismissed: 2 });
  assert.deepEqual(lj.findings[0].families, ['gemini']);
  assert.equal(lj.dismissedShare, 2 / 5);
});

test('a finding raised by ≥2 families becomes BLOCKER (Act on, and promoted from Consider)', () => {
  const lj = parseLeadJudgment(leadJson([
    { bucket: 'act_on', finding: 'migration missing for new column', families: ['gemini', 'qwen'] },
    { bucket: 'consider', finding: 'token logged in plaintext', families: ['gemini', 'qwen'] },
    { bucket: 'act_on', finding: 'off-by-one in pager', families: ['qwen'] },
    { bucket: 'dismissed', finding: 'rename variable', families: ['gemini', 'qwen'] },
  ]));
  assert.equal(lj.verdict, 'CHANGES_REQUESTED');
  assert.equal(lj.counts.actOn, 3);
  assert.equal(lj.blockers.length, 2);
  assert.ok(lj.blockers.every(b => b.startsWith('BLOCKER: ')));
  assert.ok(lj.actOn.some(f => f.startsWith('off-by-one')), 'single-family act-on is not a blocker');
  assert.equal(lj.counts.dismissed, 1, 'the lead\'s explicit Dismissed stays dismissed');
});

test('only Act on drives CHANGES_REQUESTED', () => {
  const lj = applyBucketRules([
    { bucket: 'consider', finding: 'a', families: ['gemini'] },
    { bucket: 'noted', finding: 'b', families: ['qwen'] },
    { bucket: 'dismissed', finding: 'c', families: ['gemini'] },
  ]);
  assert.equal(lj.verdict, 'APPROVED');
  assert.deepEqual(lj.actOn, []);
  assert.equal(parseLeadJudgment(leadJson([])).verdict, 'APPROVED');
});

test('parseLeadJudgment: markdown fallback and unparseable reply', () => {
  const md = parseLeadJudgment([
    '### Act On', '- broken auth check on /admin (families: gemini, qwen)',
    '### Consider', '- add an index',
    '### Dismissed', '- style nit (families: qwen)',
  ].join('\n'));
  assert.equal(md.parsed, true);
  assert.equal(md.blockers.length, 1);
  assert.equal(md.counts.consider, 1);
  const bad = parseLeadJudgment('I looked at it and it seems fine-ish.');
  assert.equal(bad.parsed, false);
});

test('prompts carry the rubric lenses and the verbatim lead filters', () => {
  const r = buildPanelReviewerPrompt('BASE PROMPT');
  for (const lens of ['Correctness', 'Root cause vs. symptom', 'Verification', 'Complexity budget', 'Security', "Trace the path, don't flag hypotheticals"]) {
    assert.ok(r.includes(lens), lens);
  }
  assert.ok(r.endsWith('BASE PROMPT'));
  const lead = buildLeadJudgmentPrompt({ title: 't', acceptance: ['x'], reviews: [{ family: 'gemini', agent: 'g', text: 'FAIL' }] });
  assert.ok(lead.includes(LEAD_FILTERS_VERBATIM));
  assert.ok(lead.includes('If a reviewer\'s findings are all nits and style preferences, the code is probably fine. Say so.'));
  assert.ok(lead.includes('A finding that amounts to "I prefer a different approach" is not a bug'));
});

