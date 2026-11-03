import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTONOMOUS_RUN, FORGE_LANDING, GOAL_TEMPLATES, withLoopDriver } from './goal-templates.js';
import { Goals } from './goals.js';
import type { Config, Task } from '../types.js';

/** Minimal Store stand-in — Goals.templates()/create() only need createTask. */
class FakeStore {
  tasks: Task[] = [];
  createTask(p: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    const t = { ...p, id: 'task-' + this.tasks.length, status: 'pending', createdAt: new Date().toISOString() } as Task;
    this.tasks.push(t); return t;
  }
  listTasks(): Task[] { return this.tasks; }
  getTask(id: string): Task | null { return this.tasks.find(t => t.id === id) || null; }
}

function makeGoals() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goal-tpl-')), 'goals');
  fs.mkdirSync(dir, { recursive: true });
  return new Goals({ paths: { goals: dir } } as unknown as Config, new FakeStore() as any);
}

test('every template has a unique kebab-case key', () => {
  const seen = new Set<string>();
  for (const t of GOAL_TEMPLATES) {
    assert.match(t.key, /^[a-z0-9][a-z0-9-]*$/, `bad key "${t.key}"`);
    assert.ok(!seen.has(t.key), `duplicate key "${t.key}"`);
    seen.add(t.key);
  }
  assert.ok(GOAL_TEMPLATES.length >= 5);
});

test('every template passes the engine\'s own authoring validation — i.e. it is activatable', () => {
  const goals = makeGoals();
  for (const t of GOAL_TEMPLATES) {
    const errors = goals.validate({
      title: t.title,
      successCriteria: t.successCriteria,
      phases: t.phases.map((title, i) => ({ key: `p${i}`, title, status: 'planned' as const, taskIds: [] }))
    });
    assert.deepEqual(errors, [], `template "${t.key}" is not a valid goal: ${errors.join('; ')}`);
    // A criterion the Achiever can settle is a yes/no question, not a bare label.
    assert.ok(t.successCriteria.trim().endsWith('?'), `template "${t.key}" criterion must be a Yes/No question`);
    assert.ok(t.phases.length >= 2, `template "${t.key}" needs a phase loop`);
  }
});

test('outcome goals carry a horizon-sized budget and a checkpoint loop; shipping goals do not need one', () => {
  for (const t of GOAL_TEMPLATES) {
    if (t.family === 'outcome') {
      assert.ok((t.budget ?? 0) >= 100, `outcome template "${t.key}" needs a horizon budget (got ${t.budget})`);
      assert.match(t.phases.join('\n'), /checkpoint|snapshot|schedule/i, `outcome "${t.key}" must schedule a checkpoint`);
      assert.match(t.loop.cadence, /checkpoint/i, `outcome "${t.key}" loop must be checkpoint-driven`);
    } else {
      assert.equal(t.family, 'shipping');
    }
  }
});

test('every template carries a copy-pasteable /loop driver contract that stops on the criterion, not a timer', () => {
  for (const t of GOAL_TEMPLATES) {
    assert.ok(t.loop && t.loop.cadence.trim() && t.loop.prompt.trim() && t.loop.stopWhen.trim(),
      `template "${t.key}" is missing a loop contract`);
    // The loop must end on the goal being met — never merely on elapsed time.
    assert.match(t.loop.stopWhen, /met|criterion|snapshot|live|published|for sale|deployed|green/i,
      `template "${t.key}" stopWhen must reference the success criterion`);
  }
});

test('Goals.templates() serves the library with each /loop driver folded into the description', () => {
  const goals = makeGoals();
  const served = goals.templates();
  assert.deepEqual(served, GOAL_TEMPLATES.map(withLoopDriver));
  assert.deepEqual(served.map(t => t.key), GOAL_TEMPLATES.map(t => t.key));
  for (const t of served) {
    // The Achiever reads only the description, so the driver must live there.
    assert.ok(t.description.includes(t.loop.prompt), `"${t.key}" description lacks its /loop prompt`);
    assert.ok(t.description.includes(t.loop.stopWhen), `"${t.key}" description lacks its stop condition`);
    for (const rule of AUTONOMOUS_RUN) assert.ok(t.description.includes(rule), `"${t.key}" lacks pstack rule: ${rule}`);
  }
});

test('the library is not mutated by serving it', () => {
  const before = GOAL_TEMPLATES.map(t => t.description);
  makeGoals().templates();
  assert.deepEqual(GOAL_TEMPLATES.map(t => t.description), before);
});

test('code-producing shipping goals land through a verified local Forgejo PR, never gh', () => {
  for (const key of ['web-tool', 'api', 'automation', 'fix-until-green']) {
    const t = GOAL_TEMPLATES.find(x => x.key === key);
    assert.ok(t, `missing template "${key}"`);
    assert.ok(t.description.includes(FORGE_LANDING), `"${key}" must carry the Forgejo landing rule`);
    assert.ok(t.phases.some(p => /Forgejo PR/.test(p)), `"${key}" needs a Forgejo landing phase`);
  }
  assert.match(FORGE_LANDING, /PASS verdict on the current head SHA from an agent that did not write the code/);
  assert.match(FORGE_LANDING, /every remote/);
  for (const t of GOAL_TEMPLATES) {
    const text = [t.description, ...t.phases, t.loop.prompt].join('\n');
    assert.doesNotMatch(text.replace(/never `gh`/g, ''), /\bgh\b/, `"${t.key}" tells the loop to use gh`);
  }
});
