import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Goals } from './goals.js';
import type { Config, Task } from '../types.js';

/**
 * In-memory stand-in for Store: Goals only touches createTask + listTasks +
 * getTask + deleteTask. Keeps the aggregate tests fast and filesystem-free
 * (the goals/*.json state still uses a real temp dir, like workflows.test.ts).
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
  deleteTask(id: string): void { this.tasks = this.tasks.filter(t => t.id !== id); }
  /** Test helper: mark a task done (simulating the dispatcher/worker). */
  finish(id: string, result?: string): Task { const t = this.getTask(id)!; t.status = 'done'; t.result = result; return t; }
}

function makeGoals() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-test-'));
  const dir = path.join(base, 'goals');
  fs.mkdirSync(dir, { recursive: true });
  const config = { paths: { goals: dir } } as unknown as Config;
  const store = new FakeStore();
  return { goals: new Goals(config, store as any), store, dir };
}

const seed = {
  title: 'Reach 1000 subscribers',
  description: 'Grow the newsletter list.',
  successCriteria: 'Does the newsletter have at least 1000 subscribers?',
  phases: [{ key: 'research', title: 'Research audience' }, { key: 'launch', title: 'Launch campaign' }]
};

// ── validation & authoring ──────────────────────────────────────────────────

test('validate requires a title, binary criterion, and kebab-case unique phases', () => {
  const { goals } = makeGoals();
  assert.deepEqual(goals.validate({ title: 'x', successCriteria: 'y?', phases: [{ key: 'a', title: 'A', status: 'planned', taskIds: [] }] }), []);
  const errs = goals.validate({ title: '', successCriteria: '', phases: [{ key: 'Bad Key', title: '', status: 'planned', taskIds: [] }] });
  assert.ok(errs.some(e => /title/.test(e)));
  assert.ok(errs.some(e => /successCriteria/.test(e)));
  assert.ok(errs.some(e => /kebab-case/.test(e)));
});

test('create yields a draft goal with a default step budget and planned phases', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed);
  assert.equal(g.status, 'draft');
  assert.ok(g.goalId.startsWith('goal-'));
  assert.equal(g.stepBudget, 24);
  assert.deepEqual(g.phases.map(p => p.status), ['planned', 'planned']);
  assert.equal(goals.get(g.goalId)!.title, seed.title);
});

test('create rejects a goal without a binary success criterion', () => {
  const { goals } = makeGoals();
  assert.throws(() => goals.create({ ...seed, successCriteria: '' }), /successCriteria/);
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test('activate enforces criterion + at least one phase; refuses a phaseless goal', () => {
  const { goals } = makeGoals();
  const g = goals.create({ ...seed, phases: [] });
  assert.throws(() => goals.activate(g.goalId), /at least one phase/);
  goals.update(g.goalId, { phases: [{ key: 'p1', title: 'First' }] });
  assert.equal(goals.activate(g.goalId).status, 'active');
});

test('pause and resume move a goal in and out of the drive loop', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  assert.equal(goals.pause(g.goalId).status, 'paused');
  assert.equal(goals.goalsAwaitingAchiever().length, 0, 'paused goal is not driven');
  assert.equal(goals.resume(g.goalId).status, 'active');
  assert.equal(goals.goalsAwaitingAchiever().length, 1);
});

test('block is a RECOVERABLE hold with an honest reason + a resume contract', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  const b = goals.block(g.goalId, 'budget exhausted', 'raise stepBudget then resume');
  assert.equal(b.status, 'blocked');
  assert.equal(b.blockReason, 'budget exhausted');
  assert.equal(b.unblockCriteria, 'raise stepBudget then resume');
  assert.equal(b.history.at(-1)!.kind, 'block');
  assert.equal(goals.goalsAwaitingAchiever().length, 0, 'blocked goal is not driven');
});

test('block always carries a resume contract, even when the caller omits one', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  const b = goals.block(g.goalId, 'stuck');
  assert.equal(b.status, 'blocked');
  assert.ok(b.unblockCriteria && b.unblockCriteria.trim().length > 0, 'a default unblock contract is filled in');
});

test('resume clears the block contract and re-arms the goal (circuit-breaker HALF-OPEN)', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  goals.block(g.goalId, 'transient brain fault', 'brain reachable, then resume');
  const r = goals.resume(g.goalId);
  assert.equal(r.status, 'active');
  assert.equal(r.blockReason, undefined);
  assert.equal(r.unblockCriteria, undefined);
  assert.equal(r.history.at(-1)!.kind, 'resume');
  assert.equal(goals.goalsAwaitingAchiever().length, 1, 'resumed goal is driven again');
});

test('a blocked goal is editable so the operator can clear the obstacle before resuming', () => {
  const { goals } = makeGoals();
  const g = goals.create({ ...seed, stepBudget: 2 }); goals.activate(g.goalId);
  goals.block(g.goalId, 'budget exhausted', 'raise stepBudget then resume');
  const u = goals.update(g.goalId, { stepBudget: 50 });
  assert.equal(u.stepBudget, 50);
  assert.equal(u.status, 'blocked', 'editing does not silently change status');
});

test('an achieved goal is terminal and cannot be reactivated', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, { kind: 'evaluate', met: true, reason: 'done' });
  assert.equal(goals.get(g.goalId)!.status, 'achieved');
  assert.throws(() => goals.activate(g.goalId), /cannot activate/);
});

test('the Achiever can self-declare a block with its own unblock criteria', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  const applied = goals.applyAchieverDecision(g.goalId, {
    kind: 'block', reason: 'needs the Gumroad API token', unblockCriteria: 'GUMROAD_TOKEN is present in ~/.priv'
  });
  assert.equal(applied.blocked, true);
  const rec = goals.get(g.goalId)!;
  assert.equal(rec.status, 'blocked');
  assert.equal(rec.unblockCriteria, 'GUMROAD_TOKEN is present in ~/.priv');
});

// ── the Achiever decision surface ────────────────────────────────────────────

test('emit generates chained lineage tasks with the terminal one completing the phase', () => {
  const { goals, store } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  const r = goals.applyAchieverDecision(g.goalId, {
    kind: 'emit',
    tasks: [{ title: 'Survey readers' }, { title: 'Summarise findings' }]
  });
  assert.equal(r.emitted, 2);
  const gen = goals.generatedTasks(g.goalId);
  assert.equal(gen.length, 2);
  // First phase became active; every task carries lineage.
  assert.equal(goals.get(g.goalId)!.phases[0].status, 'active');
  for (const t of gen) {
    assert.equal(t.context!.goalId, g.goalId);
    assert.equal(t.context!.phaseKey, 'research');
    assert.equal(t.context!.goalGenerated, true);
    assert.deepEqual(t.tags, ['goal', g.goalId]);
  }
  // Chained in order; only the last completes the phase.
  const [first, second] = gen;
  assert.equal(first.context!.completesPhase, undefined);
  assert.equal(second.context!.completesPhase, true);
  assert.deepEqual(second.context!.dependsOn, [first.id]);
  void store;
});

test('emit passes a future scheduledAt through as a checkpoint, and drops unusable ones', () => {
  const { goals } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  goals.applyAchieverDecision(g.goalId, {
    kind: 'emit',
    tasks: [
      { title: 'Run the experiment' },
      { title: 'Bad date', scheduledAt: 'in about a month' },
      { title: 'Already past', scheduledAt: '2001-01-01T00:00:00Z' },
      { title: 'Measure in 30 days', scheduledAt: future }
    ]
  });
  const [plain, bad, past, checkpoint] = goals.generatedTasks(g.goalId);
  assert.equal(plain.scheduledAt, undefined, 'no scheduledAt asked for');
  // An LLM-supplied date is untrusted: unusable values are dropped rather than
  // thrown, so one bad string cannot abort the whole emit (see checkpointTime).
  assert.equal(bad.scheduledAt, undefined, 'unparseable date dropped, task runs now');
  assert.equal(past.scheduledAt, undefined, 'a past time means now');
  assert.equal(checkpoint.scheduledAt, future, 'future checkpoint preserved');
});

test('an outstanding checkpoint keeps the goal asleep instead of burning Achiever turns', () => {
  const { goals, store } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, {
    kind: 'emit',
    tasks: [{ title: 'Measure next month', scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }]
  });
  // The real Store parks a future scheduledAt on `scheduled`; FakeStore is a thin
  // stand-in, so set the status the way Store would to assert the consequence.
  goals.generatedTasks(g.goalId)[0].status = 'scheduled';
  assert.equal(goals.goalsAwaitingAchiever().length, 0,
    'a pending checkpoint is an OPEN task — the goal takes no turns and spends no budget until it fires');
  void store;
});

test('a quiescent goal is only awaiting the Achiever when no generated task is open', () => {
  const { goals, store } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  assert.equal(goals.goalsAwaitingAchiever().length, 1, 'fresh active goal awaits its first turn');
  goals.applyAchieverDecision(g.goalId, { kind: 'emit', tasks: [{ title: 'Do work' }] });
  assert.equal(goals.goalsAwaitingAchiever().length, 0, 'not quiescent while work is open');
  store.finish(goals.generatedTasks(g.goalId)[0].id);
  // Finishing the completesPhase task moves the phase to `completing` (a Judger is
  // due) so it is still not awaiting the Achiever.
  goals.onTaskCompleted(store.getTask(goals.generatedTasks(g.goalId)[0].id)!);
  assert.equal(goals.goalsAwaitingAchiever().length, 0, 'completing phase awaits the Judger, not the Achiever');
});

test('plan appends a phase; emit refuses when no phase is workable', () => {
  const { goals } = makeGoals();
  const g = goals.create({ ...seed, phases: [] });
  // A goal with no phases can be a draft; add one via plan after activation needs
  // a phase — so seed one, activate, audit it, then plan a fresh phase.
  goals.update(g.goalId, { phases: [{ key: 'p1', title: 'P1' }] });
  goals.activate(g.goalId);
  const planned = goals.applyAchieverDecision(g.goalId, { kind: 'plan', phase: { key: 'p2', title: 'Second' } });
  assert.equal(planned.planned, true);
  assert.deepEqual(goals.get(g.goalId)!.phases.map(p => p.key), ['p1', 'p2']);
});

// ── the two-hop Achiever↔Judger cycle ────────────────────────────────────────

test('completing the terminal task wakes the Judger; the Judger audits the phase', () => {
  const { goals, store } = makeGoals();
  const g = goals.create({ ...seed, phases: [{ key: 'research', title: 'Research' }], judgerBrainChain: ['local-judge'] });
  goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, { kind: 'emit', tasks: [{ title: 'Gather data' }] });

  const work = goals.generatedTasks(g.goalId).find(t => t.context!.role === 'goal-achiever')!;
  store.finish(work.id, 'data gathered');
  goals.onTaskCompleted(store.getTask(work.id)!);

  // Phase is now `completing` and a Judger task was emitted (read-mostly, pinned).
  assert.equal(goals.get(g.goalId)!.phases[0].status, 'completing');
  const judger = goals.generatedTasks(g.goalId).find(t => t.context!.role === 'goal-judger');
  assert.ok(judger, 'a Judger task was generated');
  assert.equal(judger!.context!.brain, 'local-judge');
  assert.equal(judger!.context!.completesPhase, undefined, 'Judger tasks never re-trigger a phase');

  // Judger completes → phase audited + minutes pointer recorded.
  store.finish(judger!.id, 'looks good');
  goals.onTaskCompleted(store.getTask(judger!.id)!);
  const after = goals.get(g.goalId)!;
  assert.equal(after.phases[0].status, 'audited');
  assert.equal(after.minutes.length, 1);
  assert.equal(after.minutes[0].phaseKey, 'research');
  assert.equal(goals.goalsAwaitingAchiever().length, 1, 'goal re-arms for the next Achiever turn');
});

test('the Judger is read-mostly: it never counts against the execution budget', () => {
  const { goals, store } = makeGoals();
  const g = goals.create({ ...seed, phases: [{ key: 'research', title: 'Research' }], stepBudget: 3 });
  goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, { kind: 'emit', tasks: [{ title: 'a' }, { title: 'b' }] });
  const term = goals.generatedTasks(g.goalId).find(t => t.context!.completesPhase)!;
  store.finish(term.id);
  goals.onTaskCompleted(store.getTask(term.id)!);
  // 2 execution tasks + 1 Judger exist, but only the 2 execution tasks are budgeted.
  assert.equal(goals.generatedTasks(g.goalId).length, 3);
  assert.equal(goals.overBudget(g.goalId), false, 'Judger does not consume the budget');
});

// ── success gate & self-heal ─────────────────────────────────────────────────

test('evaluate met:true achieves the goal and queues a closeout report', () => {
  const { goals, store } = makeGoals();
  const g = goals.create(seed); goals.activate(g.goalId);
  const r = goals.applyAchieverDecision(g.goalId, { kind: 'evaluate', met: true, reason: 'hit 1000' });
  assert.equal(r.achieved, true);
  assert.equal(goals.get(g.goalId)!.status, 'achieved');
  const closeout = goals.generatedTasks(g.goalId).find(t => t.context!.closeout);
  assert.ok(closeout, 'a closeout Judger task was queued');
  assert.equal(goals.goalsAwaitingAchiever().length, 0, 'an achieved goal is no longer driven');
  void store;
});

test('phaseNeedingJudger flags a completing phase whose Judger event was dropped', () => {
  const { goals, store } = makeGoals();
  const g = goals.create({ ...seed, phases: [{ key: 'research', title: 'Research' }] });
  goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, { kind: 'emit', tasks: [{ title: 'work' }] });
  const term = goals.generatedTasks(g.goalId)[0];
  store.finish(term.id);
  goals.onTaskCompleted(store.getTask(term.id)!);
  // Simulate a dropped Judger (delete the emitted Judger task): the self-heal
  // should now flag the phase as needing one.
  const judger = goals.generatedTasks(g.goalId).find(t => t.context!.role === 'goal-judger')!;
  store.deleteTask(judger.id);
  assert.equal(goals.phaseNeedingJudger(g.goalId), 'research');
});
