import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Workflows } from './workflows.js';
import type { Config, Task, WorkflowDef } from '../types.js';

/**
 * In-memory stand-in for Store: Workflows only ever touches createTask + listTasks.
 * Keeping it in memory makes the engine tests fast, deterministic, and free of the
 * filesystem/eventbus machinery the real Store carries.
 */
class FakeStore {
  tasks: Task[] = [];
  createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    const task = { ...params, id: uuidv4(), status: 'pending', createdAt: new Date().toISOString() } as Task;
    this.tasks.push(task);
    return task;
  }
  listTasks(): Task[] {
    return this.tasks;
  }
  getTask(id: string): Task | null {
    return this.tasks.find(t => t.id === id) || null;
  }
}

function makeWorkflows(templates: Record<string, WorkflowDef> = {}) {
  // Give each test its own base dir so the sibling workflow-runs/ (orchestrated
  // run records) is isolated too — no cross-test contamination.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  const dir = path.join(base, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, def] of Object.entries(templates)) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(def));
  }
  const config = { paths: { workflows: dir } } as unknown as Config;
  const store = new FakeStore();
  return { wf: new Workflows(config, store as any), store, dir };
}

const linear: WorkflowDef = {
  id: 'linear',
  params: ['topic'],
  steps: [
    { key: 'a', title: 'Research {{topic}}' },
    { key: 'b', title: 'Draft {{topic}}', dependsOn: ['a'] },
    { key: 'c', title: 'Review {{topic}}', dependsOn: ['b'] }
  ]
};

const diamond: WorkflowDef = {
  id: 'diamond',
  steps: [
    { key: 'root' },
    { key: 'left', dependsOn: ['root'] },
    { key: 'right', dependsOn: ['root'] },
    { key: 'join', dependsOn: ['left', 'right'] }
  ]
};

// ── validation ────────────────────────────────────────────────────────────

test('validate accepts a well-formed DAG', () => {
  const { wf } = makeWorkflows();
  assert.deepEqual(wf.validate(linear), []);
  assert.deepEqual(wf.validate(diamond), []);
});

test('validate rejects empty / missing steps', () => {
  const { wf } = makeWorkflows();
  assert.ok(wf.validate({ id: 'x', steps: [] } as any).some(e => /steps/.test(e)));
  assert.ok(wf.validate({ id: 'x' } as any).some(e => /steps/.test(e)));
});

test('validate rejects duplicate step keys', () => {
  const { wf } = makeWorkflows();
  const errs = wf.validate({ id: 'dup', steps: [{ key: 'a' }, { key: 'a' }] });
  assert.ok(errs.some(e => /duplicate step key "a"/.test(e)));
});

test('validate rejects a dependsOn on an unknown step', () => {
  const { wf } = makeWorkflows();
  const errs = wf.validate({ id: 'bad', steps: [{ key: 'a', dependsOn: ['ghost'] }] });
  assert.ok(errs.some(e => /unknown step "ghost"/.test(e)));
});

test('validate rejects a dependency cycle', () => {
  const { wf } = makeWorkflows();
  const errs = wf.validate({
    id: 'cycle',
    steps: [{ key: 'a', dependsOn: ['b'] }, { key: 'b', dependsOn: ['a'] }]
  });
  assert.ok(errs.some(e => /cycle/.test(e)), `expected a cycle error, got: ${errs.join('; ')}`);
});

// ── list / get (on-disk templates) ──────────────────────────────────────────

test('list loads valid templates and skips invalid ones', () => {
  const { wf } = makeWorkflows({
    linear,
    broken: { id: 'broken', steps: [{ key: 'a', dependsOn: ['nope'] }] }
  });
  const ids = wf.list().map(d => d.id);
  assert.deepEqual(ids, ['linear']); // 'broken' is skipped, not thrown
  assert.equal(wf.get('linear')?.id, 'linear');
  assert.equal(wf.get('broken'), null);
});

test('list defaults a missing id to the filename', () => {
  const { wf, dir } = makeWorkflows();
  fs.writeFileSync(path.join(dir, 'named-by-file.json'), JSON.stringify({ steps: [{ key: 'a' }] }));
  assert.equal(wf.get('named-by-file')?.id, 'named-by-file');
});

// ── dry run ─────────────────────────────────────────────────────────────────

test('dry run interpolates params and writes nothing', () => {
  const { wf, store } = makeWorkflows({ linear });
  const r = wf.run('linear', { topic: 'edge AI' }, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(store.tasks.length, 0);
  assert.equal(r.steps[0].title, 'Research edge AI');
  // topological: a precedes b precedes c
  assert.deepEqual(r.steps.map((s: any) => s.key), ['a', 'b', 'c']);
});

test('run rejects missing required params', () => {
  const { wf } = makeWorkflows({ linear });
  assert.throws(() => wf.run('linear', {}), /missing required param\(s\): topic/);
});

test('run throws on an unknown workflow', () => {
  const { wf } = makeWorkflows();
  assert.throws(() => wf.run('ghost', {}), /unknown workflow "ghost"/);
});

// ── real expansion → DAG wiring ───────────────────────────────────────────────

test('run creates tasks and wires dependsOn to real task ids', () => {
  const { wf, store } = makeWorkflows({ linear });
  const r = wf.run('linear', { topic: 'edge AI' });
  assert.equal(r.dryRun, false);
  assert.equal(store.tasks.length, 3);

  const byKey = new Map(store.tasks.map(t => [t.context!.stepKey, t]));
  // b depends on a's actual id; c on b's actual id; a on nothing.
  assert.equal(byKey.get('a')!.context!.dependsOn, undefined);
  assert.deepEqual(byKey.get('b')!.context!.dependsOn, [byKey.get('a')!.id]);
  assert.deepEqual(byKey.get('c')!.context!.dependsOn, [byKey.get('b')!.id]);

  // every task is stamped for the run-view grouping
  for (const t of store.tasks) {
    assert.equal(t.context!.workflowId, 'linear');
    assert.equal(t.context!.workflowRunId, r.runId);
    assert.ok(t.tags?.includes('workflow'));
  }
});

test('fan-in step depends on all of its upstream tasks', () => {
  const { wf, store } = makeWorkflows({ diamond });
  wf.run('diamond', {});
  const byKey = new Map(store.tasks.map(t => [t.context!.stepKey, t]));
  const joinDeps = byKey.get('join')!.context!.dependsOn as string[];
  assert.deepEqual(
    [...joinDeps].sort(),
    [byKey.get('left')!.id, byKey.get('right')!.id].sort()
  );
});

// ── run reconstruction from task context ─────────────────────────────────────

test('listRuns / getRun reconstruct a run and derive status', () => {
  const { wf, store } = makeWorkflows({ linear });
  const r = wf.run('linear', { topic: 'edge AI' });

  const runs = wf.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, r.runId);
  assert.equal(runs[0].status, 'running'); // all pending → running

  // all done → done
  store.tasks.forEach(t => { t.status = 'done'; });
  assert.equal(wf.getRun(r.runId)!.status, 'done');

  // any rejected → failed (takes precedence over done)
  store.tasks[0].status = 'rejected';
  assert.equal(wf.getRun(r.runId)!.status, 'failed');

  assert.equal(wf.getRun('run-does-not-exist'), null);
});

// ── orchestrated (adaptive) runs ─────────────────────────────────────────────

const adaptive: WorkflowDef = {
  id: 'adaptive',
  mode: 'orchestrated',
  params: ['topic'],
  goal: 'Ship a solid brief on {{topic}}',
  steps: [
    { key: 'research', title: 'Research {{topic}}', description: 'Gather sources on {{topic}}' },
    { key: 'draft', title: 'Draft {{topic}}', description: 'Write a draft', dependsOn: ['research'] },
    { key: 'review', title: 'Review {{topic}}', description: 'Critique the draft', dependsOn: ['draft'] }
  ]
};

test('orchestrated dry run echoes the step library + interpolated goal, writes nothing', () => {
  const { wf, store } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' }, { dryRun: true });
  assert.equal(r.mode, 'orchestrated');
  assert.equal(r.dryRun, true);
  assert.equal(r.goal, 'Ship a solid brief on edge AI');
  assert.equal(store.tasks.length, 0);
  assert.deepEqual(r.steps.map((s: any) => s.key), ['research', 'draft', 'review']);
  assert.equal(wf.loadRecord(r.runId), null); // nothing persisted on a dry run
});

test('orchestrated run persists a record and creates no tasks up front', () => {
  const { wf, store } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  assert.equal(r.mode, 'orchestrated');
  assert.equal(store.tasks.length, 0);
  const rec = wf.loadRecord(r.runId)!;
  assert.equal(rec.status, 'running');
  assert.equal(rec.goal, 'Ship a solid brief on edge AI');
  assert.deepEqual(rec.history, []);
});

test('a fresh orchestrated run awaits its first decision', () => {
  const { wf } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  const awaiting = wf.runsAwaitingDecision().map(x => x.runId);
  assert.deepEqual(awaiting, [r.runId]);
});

test('applyDecision materialises the chosen step as a task and logs it', () => {
  const { wf, store } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  const task = wf.applyDecision(r.runId, { stepKey: 'research', reason: 'need sources first' })!;
  assert.ok(task);
  assert.equal(task.title, 'Research edge AI');
  assert.equal(task.context!.workflowRunId, r.runId);
  assert.equal(task.context!.stepKey, 'research');
  assert.equal(task.context!.orchestrated, true);
  assert.ok(task.tags?.includes('orchestrated'));
  const rec = wf.loadRecord(r.runId)!;
  assert.equal(rec.history.length, 1);
  assert.equal(rec.history[0].stepKey, 'research');
  assert.equal(rec.history[0].taskId, task.id);
  assert.equal(store.tasks.length, 1);
});

test('a run with an open task does NOT await a decision until it finishes', () => {
  const { wf, store } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  const task = wf.applyDecision(r.runId, { stepKey: 'research' })!;
  // task is pending → not awaiting
  assert.deepEqual(wf.runsAwaitingDecision().map(x => x.runId), []);
  // once it completes → awaiting the next decision again
  store.getTask(task.id)!.status = 'done';
  assert.deepEqual(wf.runsAwaitingDecision().map(x => x.runId), [r.runId]);
});

test('applyDecision wires dependsOn to the already-completed upstream task', () => {
  const { wf, store } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  const research = wf.applyDecision(r.runId, { stepKey: 'research' })!;
  store.getTask(research.id)!.status = 'done';
  const draft = wf.applyDecision(r.runId, { stepKey: 'draft' })!;
  assert.deepEqual(draft.context!.dependsOn, [research.id]);
});

test('decisionContext filters used steps out of available and surfaces results', () => {
  const { wf, store } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  const research = wf.applyDecision(r.runId, { stepKey: 'research' })!;
  const t = store.getTask(research.id)!;
  t.status = 'done';
  t.result = 'Found 3 key sources.';
  const ctx = wf.decisionContext(r.runId)!;
  assert.deepEqual(ctx.available.map(s => s.key), ['draft', 'review']); // research removed
  assert.equal(ctx.completed.length, 1);
  assert.equal(ctx.completed[0].key, 'research');
  assert.equal(ctx.completed[0].result, 'Found 3 key sources.');
  assert.equal(ctx.goal, 'Ship a solid brief on edge AI');
});

test('applyDecision(null) finishes the run; it no longer awaits a decision', () => {
  const { wf } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  const out = wf.applyDecision(r.runId, { stepKey: null, reason: 'goal met' });
  assert.equal(out, null);
  assert.equal(wf.loadRecord(r.runId)!.status, 'done');
  assert.deepEqual(wf.runsAwaitingDecision().map(x => x.runId), []);
});

test('getRun / listRuns render an orchestrated run with mode, goal, and history', () => {
  const { wf, store } = makeWorkflows({ adaptive });
  const r = wf.run('adaptive', { topic: 'edge AI' });
  const research = wf.applyDecision(r.runId, { stepKey: 'research' })!;
  store.getTask(research.id)!.status = 'done';

  const run = wf.getRun(r.runId)!;
  assert.equal(run.mode, 'orchestrated');
  assert.equal(run.goal, 'Ship a solid brief on edge AI');
  assert.equal(run.history!.length, 1);
  assert.equal(run.tasks.length, 1);

  // listRuns emits it exactly once (from the record, not double-counted via tasks)
  const matches = wf.listRuns().filter(x => x.runId === r.runId);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].mode, 'orchestrated');
});

// ── create(): author a new template to disk at runtime ─────────────────────

test('create() validates + persists a new template that is then loadable + runnable', () => {
  const { wf, dir } = makeWorkflows();
  const def: WorkflowDef = {
    id: 'built',
    name: 'Built at runtime',
    params: ['topic'],
    steps: [
      { key: 'a', title: 'Research {{topic}}' },
      { key: 'b', title: 'Draft {{topic}}', dependsOn: ['a'] }
    ]
  };
  const stored = wf.create(def);
  assert.equal(stored.id, 'built');
  assert.ok(fs.existsSync(path.join(dir, 'built.json')));
  // Immediately visible through the normal load path and runnable.
  assert.equal(wf.get('built')?.name, 'Built at runtime');
  const run = wf.run('built', { topic: 'edge AI' }, { dryRun: true });
  assert.deepEqual(run.steps.map(s => s.key), ['a', 'b']);
});

test('create() rejects a structurally invalid template (unknown dependsOn)', () => {
  const { wf } = makeWorkflows();
  assert.throws(() => wf.create({ id: 'bad', steps: [{ key: 'a', dependsOn: ['ghost'] }] }),
    /unknown step "ghost"/);
});

test('create() rejects a cyclic template', () => {
  const { wf } = makeWorkflows();
  assert.throws(() => wf.create({ id: 'cyclic', steps: [
    { key: 'a', dependsOn: ['b'] }, { key: 'b', dependsOn: ['a'] }
  ] }), /cycle/);
});

test('create() enforces a safe kebab-case id (no path traversal)', () => {
  const { wf } = makeWorkflows();
  assert.throws(() => wf.create({ id: '../escape', steps: [{ key: 'a' }] }), /kebab-case/);
  assert.throws(() => wf.create({ id: 'Has Spaces', steps: [{ key: 'a' }] }), /kebab-case/);
});

test('create() refuses to clobber unless overwrite is set', () => {
  const { wf } = makeWorkflows();
  wf.create({ id: 'dup', steps: [{ key: 'a', title: 'v1' }] });
  assert.throws(() => wf.create({ id: 'dup', steps: [{ key: 'a', title: 'v2' }] }), /already exists/);
  const updated = wf.create({ id: 'dup', steps: [{ key: 'a', title: 'v2' }] }, { overwrite: true });
  assert.equal(updated.steps[0].title, 'v2');
  assert.equal(wf.get('dup')?.steps[0].title, 'v2');
});
