import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { selectSpecJudges, buildVerifierPrompt, JUDGE_COMPLIANCE_RULES, ARTIFACT_LISTING_RULE, JUDGE_RULES_HEADING } from './result-verifier.js';
import { parseLeadJudgment, applyBucketRules, buildLeadJudgmentPrompt, buildPanelReviewerPrompt, effectivePanelSize, LEAD_FILTERS_VERBATIM } from './review-panel.js';
import { computeQualityMetrics } from './quality-metrics.js';
import { Workflows } from './workflows.js';
import type { Config, Task, WorkflowDef } from '../types.js';
import type { Lesson } from './lessons.js';

const brains = {
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
  const out = selectSpecJudges('cc-sonnet', { brains, judges, panel: 2, panelPool: ['cc-opus', 'agy-gemini-flash', 'dsh-qwen', 'codex-off'] });
  assert.deepEqual(out, ['agy-gemini-argon', 'dsh-qwen']);
  // Gemini executor: claude judge first (CEO ruling), then qwen; never a second gemini.
  const g = selectSpecJudges('agy-gemini-flash', { brains, judges, panel: 3, panelPool: ['agy-gemini-argon', 'dsh-qwen', 'cc-sonnet'] });
  assert.deepEqual(g, ['cc-opus', 'dsh-qwen']);
});

test('selectSpecJudges: panel default 1 keeps the ordered single-family chain', () => {
  assert.deepEqual(selectSpecJudges('cc-sonnet', { brains, judges }), ['agy-gemini-argon', 'agy-gemini-flash']);
  assert.deepEqual(selectSpecJudges('cc-sonnet', { brains, judges, panel: 1, panelPool: ['dsh-qwen'] }), ['agy-gemini-argon', 'agy-gemini-flash']);
});

test('selectSpecJudges: panel skips cooling/disabled brains and may return fewer than asked', () => {
  const out = selectSpecJudges('cc-sonnet', { brains, judges, panel: 2, panelPool: ['codex-off'], isCooling: id => id === 'agy-gemini-argon' });
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
  const lead = buildLeadJudgmentPrompt({ title: 't', acceptance: ['x'], reviews: [{ family: 'gemini', brain: 'g', text: 'FAIL' }] });
  assert.ok(lead.includes(LEAD_FILTERS_VERBATIM));
  assert.ok(lead.includes('If a reviewer\'s findings are all nits and style preferences, the code is probably fine. Say so.'));
  assert.ok(lead.includes('A finding that amounts to "I prefer a different approach" is not a bug'));
});

// ── Gate integration ───────────────────────────────────────────────────────

class FakeStore {
  tasks: Task[] = [];
  createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    const task = { ...params, id: uuidv4(), status: 'pending', createdAt: new Date().toISOString() } as Task;
    this.tasks.push(task);
    return task;
  }
  listTasks(): Task[] { return this.tasks; }
  getTask(id: string): Task | null { return this.tasks.find(t => t.id === id) || null; }
  getAgentPersona(name: string): any { return { name, division: 'engineering' }; }
  saveTask(task: Task): void {
    const i = this.tasks.findIndex(t => t.id === task.id);
    if (i >= 0) this.tasks[i] = task; else this.tasks.push(task);
  }
  parkForInput(opts: { taskId: string; questions: string[]; result: string }): void {
    const t = this.getTask(opts.taskId);
    if (t) { t.status = 'wait-input'; t.result = opts.result; }
  }
}

const panelPipeline: WorkflowDef = {
  id: 'panel-pipeline',
  steps: [
    { key: 'build', title: 'Build it', description: 'Build the thing', acceptance: ['It builds', 'Tests pass'], tier: 'standard',
      gate: { reviewer: 'engineering-code-reviewer', maxRounds: 3, escalateBrainAt: 2, panel: 2 } },
    { key: 'ship', title: 'Ship it', dependsOn: ['build'] },
  ],
};

function harness(panelEnabled = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-panel-test-'));
  const dir = path.join(base, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'panel-pipeline.json'), JSON.stringify(panelPipeline));
  const config = {
    paths: { workflows: dir, artifacts: path.join(base, 'artifacts'), decisions: path.join(base, 'decisions') },
    orchestration: {
      defaultChain: ['cc-sonnet'],
      tiers: { mechanical: ['dsh-qwen'], standard: ['agy-gemini-argon', 'cc-sonnet'], judgment: ['cc-opus'] },
      brains,
      verifier: { spec: { judges }, panel: { enabled: panelEnabled, size: 2 } },
    },
  } as unknown as Config;
  const store = new FakeStore();
  const workflows = new Workflows(config, store as any);
  workflows.run('panel-pipeline');
  const step = store.tasks.find(t => t.context?.stepKey === 'build')!;
  step.status = 'done';
  step.result = 'Built.\nSTATUS: DONE\nEVIDENCE:\n- npm test → 12 passed';
  step.context = { ...(step.context || {}), ranBrain: 'cc-sonnet' };
  workflows.onTaskCompleted(step);
  const reviewers = () => store.tasks.filter(t => t.context?.gateReviewFor === step.id && t.context?.gatePanelRole === 'reviewer');
  const finish = (t: Task, result: string) => { t.status = 'done'; t.result = result; workflows.onTaskCompleted(t); };
  const lessons = (): Lesson[] => {
    const f = path.join(base, 'decisions', 'lessons.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').map(l => JSON.parse(l)) : [];
  };
  return { store, workflows, step, reviewers, finish, lessons };
}

test('gate panel: one pinned reviewer per distinct family, excluding the executor family', () => {
  const { reviewers } = harness();
  const rs = reviewers();
  assert.equal(rs.length, 2);
  assert.deepEqual(rs.map(r => r.context?.brain), ['agy-gemini-argon', 'dsh-qwen']);
  assert.deepEqual(rs.map(r => r.context?.judgeFamily), ['gemini', 'qwen']);
  assert.ok(rs.every(r => r.context?.tier === 'review' && r.context?.reviewOf === 'cc-sonnet'));
  assert.ok(rs[0].description.includes("Trace the path, don't flag hypotheticals"));
});

test('gate panel: config switch off falls back to a single reviewer', () => {
  const { store, step } = harness(false);
  const rs = store.tasks.filter(t => t.context?.gateReviewFor === step.id);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].context?.gatePanelRole, undefined);
});

test('gate panel: all reviewers approve → approved without a lead pass', () => {
  const { store, step, reviewers, finish, lessons } = harness();
  const [a, b] = reviewers();
  finish(a, '1. PASS — ok\n2. PASS — ok\nVERDICT: APPROVED');
  assert.equal(store.getTask(step.id)!.context?.gate?.status, 'reviewing', 'waits for the whole panel');
  finish(b, '1. PASS — ok\n2. PASS — ok\nVERDICT: APPROVED');
  assert.equal(store.getTask(step.id)!.context?.gate?.status, 'approved');
  assert.equal(store.tasks.filter(t => t.context?.gatePanelRole === 'lead').length, 0);
  assert.equal(lessons().filter(l => l.kind === 'gate-panel').length, 1);
});

test('gate panel: lead with only Consider/Dismissed findings approves (no fix round)', () => {
  const { store, step, reviewers, finish, lessons } = harness();
  const [a, b] = reviewers();
  finish(a, '1. FAIL — nit: rename foo\n2. PASS — ok\nVERDICT: CHANGES_REQUESTED');
  finish(b, '1. PASS — ok\n2. PASS — ok\nVERDICT: APPROVED');
  const lead = store.tasks.find(t => t.context?.gatePanelRole === 'lead')!;
  assert.ok(lead, 'lead judgment task spawned');
  assert.equal(lead.context?.tier, 'judgment');
  assert.equal(store.getTask(step.id)!.context?.gate?.activeReviewTaskId, lead.id);
  finish(lead, leadJson([{ bucket: 'dismissed', finding: 'rename foo', families: ['gemini'], rationale: 'nitpick gravity' }]));
  const s = store.getTask(step.id)!;
  assert.equal(s.context?.gate?.status, 'approved');
  assert.equal(s.status, 'done');
  const l = lessons().filter(x => x.kind === 'gate-panel');
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].panel?.buckets, { actOn: 0, consider: 0, noted: 0, dismissed: 1 });
});

test('gate panel: Act on with ≥2 families → BLOCKER finding and a fix round', () => {
  const { store, step, reviewers, finish, workflows } = harness();
  const [a, b] = reviewers();
  finish(a, '1. FAIL — critical: build script missing\nVERDICT: CHANGES_REQUESTED');
  finish(b, '1. FAIL — critical: no build script\nVERDICT: CHANGES_REQUESTED');
  const lead = store.tasks.find(t => t.context?.gatePanelRole === 'lead')!;
  finish(lead, leadJson([
    { bucket: 'act_on', finding: 'build script missing from package.json', families: ['gemini', 'qwen'] },
    { bucket: 'noted', finding: 'README typo', families: ['qwen'] },
  ]));
  const s = store.getTask(step.id)!;
  assert.equal(s.status, 'pending', 'gated step re-queued');
  assert.equal(s.context?.gate?.round, 2);
  assert.equal(s.context?.gateFindings.length, 1);
  assert.match(s.context?.gateFindings[0], /^BLOCKER: build script missing/);
  const rec = workflows.loadRecord(String(s.context?.workflowRunId))!;
  const r1 = rec.gates!['build'].rounds[0];
  assert.equal(r1.action, 'requeue');
  assert.deepEqual(r1.blockerFindings?.length, 1);
  assert.equal(r1.panel?.buckets?.actOn, 1);
  assert.equal(r1.panel?.reviewers.length, 2);
});

test('gate panel: unparseable lead falls back to the strict union of reviewer findings', () => {
  const { store, step, reviewers, finish } = harness();
  const [a, b] = reviewers();
  finish(a, '1. FAIL — missing test\nVERDICT: CHANGES_REQUESTED');
  finish(b, '1. PASS — ok\nVERDICT: APPROVED');
  const lead = store.tasks.find(t => t.context?.gatePanelRole === 'lead')!;
  finish(lead, 'Looks mostly fine I guess.');
  const s = store.getTask(step.id)!;
  assert.equal(s.status, 'pending');
  assert.ok(s.context?.gateFindings.some((f: string) => f.startsWith('[gemini]')));
});

// ── Metrics ────────────────────────────────────────────────────────────────

test('quality metrics: rounds per gate and Dismissed share from gate-panel lessons', () => {
  const at = '2026-10-20T05:00:00.000Z';
  const mk = (gate: string, round: number, b: any): Lesson => ({
    at, kind: 'gate-panel', task: gate, titleSlug: 't', agent: 'r', brain: 'cc', brainFamily: 'cc', attempt: round, reason: '', requiresGuess: [],
    panel: { gate, round, families: ['gemini', 'qwen'], buckets: b, verdict: 'APPROVED', leadParsed: true },
  });
  const m = computeQualityMetrics([
    mk('g1', 1, { actOn: 1, consider: 0, noted: 0, dismissed: 1 }),
    mk('g1', 2, { actOn: 0, consider: 0, noted: 0, dismissed: 2 }),
    mk('g2', 1, { actOn: 0, consider: 1, noted: 1, dismissed: 0 }),
  ], [], Date.parse('2026-10-19T00:00:00Z'), Date.parse('2026-10-21T00:00:00Z'));
  assert.equal(m.panel.rounds, 3);
  assert.equal(m.panel.gates, 2);
  assert.equal(m.panel.avgRoundsPerGate, 1.5);
  assert.deepEqual(m.panel.buckets, { actOn: 1, consider: 1, noted: 1, dismissed: 3 });
  assert.equal(m.panel.dismissedShare, 50);
});

test('buildPanelReviewerPrompt carries the judging rules exactly once (added when the base prompt lacks them)', () => {
  const bare = buildPanelReviewerPrompt('TASK: x\nRESULT: y');
  assert.ok(bare.includes(JUDGE_RULES_HEADING));
  for (const r of [...JUDGE_COMPLIANCE_RULES, ARTIFACT_LISTING_RULE]) assert.ok(bare.includes(r), r.slice(0, 40));
  assert.match(bare, /ALTERNATIVE DELIVERY PATHS/);
  assert.match(bare, /NON-PUBLIC DATA/);
  assert.match(bare, /DOCUMENTED OPERATIONAL CONSTRAINTS/);
  const full = buildPanelReviewerPrompt(buildVerifierPrompt({ title: 't' }, 'r', { acceptance: ['a'] }));
  assert.equal(full.split(JUDGE_RULES_HEADING).length, 2, 'not duplicated when buildVerifierPrompt already has them');
});

test('buildLeadJudgmentPrompt tells the lead to dismiss findings that break the judging rules', () => {
  const p = buildLeadJudgmentPrompt({ title: 't', acceptance: ['a'], reviews: [{ family: 'gemini', brain: 'g', text: '1. FAIL — no per-sticker downloads' }] });
  assert.match(p, /Dismiss any finding that breaks these judging rules/);
  for (const r of JUDGE_COMPLIANCE_RULES) assert.ok(p.includes(r));
});
