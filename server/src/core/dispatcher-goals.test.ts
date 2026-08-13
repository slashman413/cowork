import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Dispatcher } from './dispatcher.js';
import { Goals } from './goals.js';
import type { Config, Task, AchieverDecision } from '../types.js';

/**
 * Exercise the DISPATCHER's Goal driver (`driveGoals`) — the glue that turns
 * "the Achiever decides its next move" into real tasks — WITHOUT spawning any
 * LLM. `askExecutor` (the only place a brain is spawned) is stubbed with a
 * scripted queue of decisions, so the evaluate→plan→emit loop runs
 * deterministically: decide → materialise task(s) → complete → decide again.
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
}

function harness(decisions: (AchieverDecision | null)[]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-drv-'));
  const dir = path.join(base, 'goals');
  fs.mkdirSync(dir, { recursive: true });
  const config = {
    paths: { goals: dir },
    orchestration: { classifier: { timeoutMs: 1000 } }
  } as unknown as Config;
  const store = new FakeStore();
  const goals = new Goals(config, store as any);
  const dispatcher = new Dispatcher(config, store as any, {} as any, undefined, goals);
  // Stub the brain call: return the next scripted decision as a fenced JSON block
  // (so it also exercises parseAchieverDecision), or empty for a "no decision".
  const queue = [...decisions];
  (dispatcher as any).askExecutor = async () => {
    const d = queue.length ? queue.shift() : null;
    return d ? '```json\n' + JSON.stringify(d) + '\n```' : '';
  };
  return { goals, store, dispatcher };
}

const settle = () => new Promise(r => setTimeout(r, 5));
const drive = (d: any) => d.driveGoals();

function seedGoal(goals: Goals) {
  const g = goals.create({
    title: 'Ship the feature',
    successCriteria: 'Is the feature shipped?',
    phases: [{ key: 'build', title: 'Build it' }]
  });
  goals.activate(g.goalId);
  return g.goalId;
}

test('driver runs the Achiever emit move → generates the phase task automatically', async () => {
  const { goals, store, dispatcher } = harness([{ kind: 'emit', tasks: [{ title: 'Write the code' }] }]);
  const goalId = seedGoal(goals);
  drive(dispatcher);
  await settle();
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].context!.goalId, goalId);
  assert.equal(store.tasks[0].context!.phaseKey, 'build');
  assert.equal(store.tasks[0].context!.completesPhase, true);
});

test('driver waits for open generated work before taking the next turn', async () => {
  const { goals, store, dispatcher } = harness([
    { kind: 'emit', tasks: [{ title: 'A' }] },
    { kind: 'emit', tasks: [{ title: 'B' }] }
  ]);
  seedGoal(goals);
  drive(dispatcher); await settle();          // → task A (open)
  drive(dispatcher); await settle();          // A still open → no new turn
  assert.equal(store.tasks.length, 1, 'no second turn while work is open');
});

test('driver walks emit → phase-complete → Judger → evaluate(met) to achieved', async () => {
  const { goals, store, dispatcher } = harness([
    { kind: 'emit', tasks: [{ title: 'Build' }] },
    { kind: 'evaluate', met: true, reason: 'shipped' }
  ]);
  const goalId = seedGoal(goals);

  // Turn 1: emit the build task.
  drive(dispatcher); await settle();
  const build = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-achiever')!;

  // Worker finishes it → the taskCompleted subscriber wakes the Judger.
  build.status = 'done';
  goals.onTaskCompleted(store.getTask(build.id)!);
  const judger = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-judger')!;
  assert.ok(judger, 'Judger emitted on phase completion');

  // Judger finishes → phase audited, goal re-arms.
  judger.status = 'done';
  goals.onTaskCompleted(store.getTask(judger.id)!);
  assert.equal(goals.get(goalId)!.phases[0].status, 'audited');

  // Turn 2: evaluate says met → achieved.
  drive(dispatcher); await settle();
  assert.equal(goals.get(goalId)!.status, 'achieved');
});

test('driver abandons (honest reason) a goal that exhausts its step budget', async () => {
  // An Achiever that always emits one task and never declares success. We
  // complete each task's status (→ quiescent) WITHOUT auditing its phase, so the
  // phase stays workable and execution tasks accrue until the budget guard bites.
  const { goals, store, dispatcher } = harness([]);
  (dispatcher as any).askExecutor = async () =>
    '```json\n' + JSON.stringify({ kind: 'emit', tasks: [{ title: 'again' }] }) + '\n```';
  const g = goals.create({
    title: 'Endless', successCriteria: 'Never?', stepBudget: 2,
    phases: [{ key: 'p', title: 'P' }]
  });
  goals.activate(g.goalId);

  for (let i = 0; i < 8; i++) {
    drive(dispatcher);
    await settle();
    store.tasks.forEach(t => { if (t.status !== 'done') t.status = 'done'; });   // quiescent, phase stays 'active'
    if (goals.get(g.goalId)!.status !== 'active') break;
  }
  assert.equal(goals.get(g.goalId)!.status, 'abandoned');
  assert.match(goals.get(g.goalId)!.closedReason || '', /budget/);
});

test('driver abandons a goal whose Achiever never returns a usable decision', async () => {
  const { goals, dispatcher } = harness([]);
  (dispatcher as any).askExecutor = async () => 'sorry, I could not decide';   // unparseable every time
  const goalId = seedGoal(goals);
  for (let i = 0; i < Dispatcher.MAX_GOAL_FAILURES + 1; i++) {
    drive(dispatcher);
    await settle();
    if (goals.get(goalId)!.status !== 'active') break;
  }
  assert.equal(goals.get(goalId)!.status, 'abandoned');
  assert.match(goals.get(goalId)!.closedReason || '', /no usable progress/);
});

test('driver self-heals a dropped Judger event by re-emitting the Judger', async () => {
  const { goals, store, dispatcher } = harness([{ kind: 'emit', tasks: [{ title: 'work' }] }]);
  const goalId = seedGoal(goals);
  drive(dispatcher); await settle();
  const work = goals.generatedTasks(goalId)[0];
  work.status = 'done';
  goals.onTaskCompleted(store.getTask(work.id)!);
  // Drop the emitted Judger, then drive: the self-heal must re-emit it.
  const judger = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-judger')!;
  store.deleteTask(judger.id);
  drive(dispatcher); await settle();
  const revived = goals.generatedTasks(goalId).find(t => t.context!.role === 'goal-judger');
  assert.ok(revived, 'a fresh Judger task was re-emitted by the self-heal');
});
