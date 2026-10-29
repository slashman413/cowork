import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { appendGoalDecision, readGoalTrail, taskTrailRows, trailCell, trailLine, goalTrailPath, GOAL_TRAIL_HEADER } from './goal-trail.js';
import { Goals, FIGURE_IT_OUT_RULES, extractAttention } from './goals.js';
import type { Config, Task } from '../types.js';

/**
 * PS-7: goals/<id>/decisions.tsv (pstack show-me-your-work columns + log.sh
 * sanitising) and the cross-family Attention review at goal phase close.
 */

class FakeStore {
  tasks: Task[] = [];
  createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    const task = { ...params, id: uuidv4(), status: 'pending', createdAt: new Date().toISOString() } as Task;
    this.tasks.push(task);
    return task;
  }
  listTasks(): Task[] { return this.tasks; }
  getTask(id: string): Task | null { return this.tasks.find(t => t.id === id) || null; }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-goal-trail-'));

function makeGoals(orchestration: Record<string, any> = {}) {
  const base = tmp();
  const config = {
    paths: { goals: path.join(base, 'goals'), artifacts: path.join(base, 'artifacts') },
    orchestration: {
      brains: {
        'remote-cc-opus': { location: 'remote', exec: 'claude', model: 'claude-opus-5-5' },
        'local-gemini': { location: 'local', exec: 'agy', model: 'gemini-3-pro' },
        'local-hermes-qwen3.8-27b': { location: 'local', exec: 'hermes', model: 'qwen3.8-27b' }
      },
      tiers: { judgment: ['remote-cc-opus', 'local-gemini'] },
      ...orchestration
    }
  } as unknown as Config;
  fs.mkdirSync(config.paths.goals, { recursive: true });
  const store = new FakeStore();
  return { goals: new Goals(config, store as any), store, config };
}

// ── sanitising (pstack log.sh clean()) ───────────────────────────────────────

test('trailCell strips tabs/newlines/CR and quotes formula-leading cells', () => {
  assert.equal(trailCell('a\tb\nc\rd'), 'a b c d');
  for (const lead of ['=', '+', '-', '@']) assert.equal(trailCell(`${lead}SUM(A1)`), `'${lead}SUM(A1)`);
  assert.equal(trailCell('plain = fine'), 'plain = fine');
  assert.equal(trailCell(undefined), '');
  // a newline that would expose a formula on the next line is flattened, not quoted mid-cell
  assert.equal(trailCell('ok\n=cmd'), 'ok =cmd');
  assert.equal(trailLine({ ts: '2026-10-20T00:00:00Z', phase: 'p', decision: '=HYPERLINK("x")', why: 'w\tx', evidence: '@me', result: '-1' }),
    `2026-10-20T00:00:00Z\tp\t'=HYPERLINK("x")\tw x\t'@me\t'-1`);
});

test('appendGoalDecision writes the pstack header once and one line per row', () => {
  const dir = tmp();
  assert.equal(appendGoalDecision(dir, 'goal-1', { phase: 'a', decision: 'd1\nmore', why: 'w', evidence: 'e', result: 'r' }), 1);
  assert.equal(appendGoalDecision(dir, 'goal-1', { phase: 'b', decision: 'd2' }), 1);
  const lines = fs.readFileSync(goalTrailPath(dir, 'goal-1'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines[0], GOAL_TRAIL_HEADER);
  assert.equal(lines[0], 'ts\tphase\tdecision\twhy\tevidence\tresult');
  assert.equal(lines.length, 3);
  for (const l of lines.slice(1)) assert.equal(l.split('\t').length, 6);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\ta\td1 more\tw\te\tr$/);
  assert.deepEqual(readGoalTrail(dir, 'goal-1', 'b').map(r => r.decision), ['d2']);
  assert.deepEqual(readGoalTrail(dir, 'missing'), []);
});

test('appendGoalDecision never throws on an unwritable goals dir', () => {
  const file = path.join(tmp(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.equal(appendGoalDecision(file, 'goal-1', { decision: 'x' }), 0);
});

test('taskTrailRows copies RULING lines in, split into decision / why', () => {
  const t = {
    id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'Build it', status: 'done', completedAt: '2026-10-20T02:00:00.000Z',
    from: { platform: 'cowork' }, to: {}, priority: 'normal', createdAt: '2026-10-20T01:00:00.000Z',
    context: { ranBrain: 'local-hermes-qwen3.8-27b', rulings: ['used plan B — reversible — one revert'] }
  } as unknown as Task;
  const rows = taskTrailRows(t, 'build');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decision, 'task finished: Build it');
  assert.equal(rows[0].result, 'done');
  assert.equal(rows[1].phase, 'build');
  assert.equal(rows[1].decision, 'RULING: used plan B');
  assert.equal(rows[1].why, 'reversible — one revert');
  assert.match(rows[1].evidence, /aaaaaaaa \(local-hermes-qwen3\.8-27b\)/);
});

// ── goal lifecycle → trail + Attention ───────────────────────────────────────

function runPhase(goals: Goals, store: FakeStore, ranBrain: string) {
  const g = goals.create({ title: 'Ship X', successCriteria: 'Does GET /x return 200?', phases: [{ key: 'baseline', title: 'Baseline' }] });
  goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, { kind: 'emit', tasks: [{ title: 'measure', description: 'measure now' }], reason: 'need a baseline' });
  const t = goals.generatedTasks(g.goalId)[0];
  t.status = 'done';
  t.completedAt = new Date().toISOString();
  t.result = 'measured 404\nRULING: measured prod not staging — it is what users see — staging may differ';
  t.context = { ...t.context, ranBrain, rulings: ['measured prod not staging — it is what users see — staging may differ'] };
  goals.onTaskCompleted(t);
  return g.goalId;
}

test('phase close logs the trail and creates a different-family Attention review', () => {
  const { goals, store, config } = makeGoals();
  const goalId = runPhase(goals, store, 'local-hermes-qwen3.8-27b');

  const rows = goals.decisionTrail(goalId);
  const decisions = rows.map(r => r.decision);
  assert.ok(decisions.some(d => d.startsWith('emitted 1 task(s): measure')));
  assert.ok(decisions.includes('task finished: measure'));
  assert.ok(decisions.includes('RULING: measured prod not staging'));
  assert.ok(decisions.includes('requested cross-family Attention review'));
  assert.ok(rows.every(r => r.phase === 'baseline'));

  const attention = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-attention')!;
  assert.ok(attention, 'attention task created');
  // qwen executor → an opus-class Claude reviewer (CEO judge-family ruling)
  assert.equal(attention.context!.brain, 'remote-cc-opus');
  assert.match(attention.description, /RULING: measured prod not staging/);
  assert.match(attention.description, /## Attention/);
  assert.match(attention.description, /No flags/);
  assert.ok(goals.generatedTasks(goalId).some(t => t.context!.role === 'goal-judger'));
  // review tasks do not consume the step budget
  assert.equal(goals.overBudget(goalId), false);

  // Judger finishes first, then Attention: the section is merged into the report once.
  const judger = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-judger')!;
  fs.mkdirSync(path.join(config.paths.artifacts, judger.id), { recursive: true });
  const report = path.join(config.paths.artifacts, judger.id, 'report-baseline.md');
  fs.writeFileSync(report, '# Report\nbaseline is 404\n');
  judger.status = 'done';
  goals.onTaskCompleted(judger);

  attention.status = 'done';
  attention.result = 'Done.\n## Attention\nreviewed by claude-opus-5-5\n- "measured 404" has no command output behind it\n\nSTATUS: DONE';
  goals.onTaskCompleted(attention);
  const merged = fs.readFileSync(report, 'utf8');
  assert.match(merged, /## Attention\nreviewed by claude-opus-5-5\n- "measured 404"/);
  goals.onTaskCompleted(attention);   // idempotent
  assert.equal(fs.readFileSync(report, 'utf8').match(/## Attention/g)!.length, 1);

  const phase = goals.get(goalId)!.phases[0];
  assert.equal(phase.attentionArtifact, `${attention.id}/attention-baseline.md`);
  assert.equal(goals.decisionTrail(goalId).find(r => r.decision === 'cross-family Attention review')!.result, '1 flag(s)');
});

test('Claude-executed phase is reviewed by Gemini; Attention file before report merges when the Judger lands', () => {
  const { goals, store, config } = makeGoals();
  const goalId = runPhase(goals, store, 'remote-cc-opus');
  const attention = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-attention')!;
  assert.equal(attention.context!.brain, 'local-gemini');

  fs.mkdirSync(path.join(config.paths.artifacts, attention.id), { recursive: true });
  fs.writeFileSync(path.join(config.paths.artifacts, attention.id, 'attention-baseline.md'), '## Attention\nreviewed by gemini-3-pro\nNo flags\n');
  attention.status = 'done';
  goals.onTaskCompleted(attention);
  assert.equal(goals.decisionTrail(goalId).find(r => r.decision === 'cross-family Attention review')!.result, 'no flags');

  const judger = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-judger')!;
  fs.mkdirSync(path.join(config.paths.artifacts, judger.id), { recursive: true });
  const report = path.join(config.paths.artifacts, judger.id, 'report-baseline.md');
  fs.writeFileSync(report, '# Report');
  judger.status = 'done';
  goals.onTaskCompleted(judger);
  assert.match(fs.readFileSync(report, 'utf8'), /# Report\n\n## Attention\nreviewed by gemini-3-pro\nNo flags/);
});

test('orchestration.goalAttention:false skips the review but keeps the trail', () => {
  const { goals, store } = makeGoals({ goalAttention: false });
  const goalId = runPhase(goals, store, 'remote-cc-opus');
  assert.equal(goals.generatedTasks(goalId).filter(t => t.context!.role === 'goal-attention').length, 0);
  assert.ok(goals.decisionTrail(goalId).some(r => r.decision === 'task finished: measure'));
});

test('extractAttention finds the section and returns empty when absent', () => {
  assert.equal(extractAttention('x\n### Attention\nNo flags'), '### Attention\nNo flags');
  assert.equal(extractAttention('nothing here'), '');
});

test('planner rules: falsifiable criterion, riskiest unknown first, baseline before features', () => {
  assert.match(FIGURE_IT_OUT_RULES, /FALSIFIABLE/);
  assert.match(FIGURE_IT_OUT_RULES, /RISKIEST UNKNOWN FIRST/);
  assert.match(FIGURE_IT_OUT_RULES, /BASELINE BEFORE FEATURES/);
});
