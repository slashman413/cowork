import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Recipes, draftFromTask, instantiate, normalizeRecipe, recipePitfalls, recipeStats, renderTemplate, resolveValues,
} from './recipes.js';
import type { Task } from '../types.js';

const base = {
  name: 'Catalog audit',
  title: 'Catalog audit — {{month}}',
  brief: 'Audit the {{store}} catalog for {{month}}.',
  fields: [
    { key: 'store', label: 'Store', type: 'choice', options: ['gumroad', 'itch'], default: 'gumroad' },
    { key: 'month', label: 'Month', type: 'text' },
  ],
  carry: { agent: 'analyst', brain: 'local-cc-opus-5-5', brainMode: 'suggest', acceptance: ['table of products'], timeboxMin: 30, inputs: [] },
};

function task(p: Partial<Task>): Task {
  return { id: 't', title: 't', description: '', from: { platform: 'x', agent: 'y' }, to: {}, priority: 'normal',
    status: 'done', createdAt: '2026-10-01T00:00:00Z', ...p } as Task;
}

test('renderTemplate fills values and refuses a missing one', () => {
  assert.equal(renderTemplate('a {{ x }} b {{y}}', { x: '1', y: '2' }), 'a 1 b 2');
  assert.throws(() => renderTemplate('{{x}}', {}), /missing value for \{\{x\}\}/);
});

test('normalizeRecipe rejects a placeholder with no field and bad keys', () => {
  assert.throws(() => normalizeRecipe({ ...base, fields: [] }), /is not a field/);
  assert.throws(() => normalizeRecipe({ ...base, fields: [{ key: 'Bad Key' }] }), /lowercase/);
  assert.throws(() => normalizeRecipe({ ...base, fields: [{ key: 'c', type: 'choice' }], brief: '{{c}}', title: 'x' }), /needs options/);
  const r = normalizeRecipe(base);
  assert.match(r.id, /^rcp-[a-z0-9]{8}$/);
  assert.equal(r.version, 1);
  assert.equal(r.fields[1].required, true);
});

test('resolveValues applies defaults and type checks', () => {
  const r = normalizeRecipe(base);
  assert.deepEqual(resolveValues(r, { month: 'Oct' }), { store: 'gumroad', month: 'Oct' });
  assert.throws(() => resolveValues(r, {}), /"Month" is required/);
  assert.throws(() => resolveValues(r, { month: 'Oct', store: 'ebay' }), /must be one of/);
});

test('instantiate: suggest mode auto-routes, lock pins, override wins', () => {
  const r = normalizeRecipe(base);
  const t = instantiate(r, { values: { month: 'Oct' }, pitfalls: ['skip hidden products'], extra: 'Be brief.' });
  assert.equal(t.title, 'Catalog audit — Oct');
  assert.match(t.description, /^Audit the gumroad catalog for Oct\./);
  assert.match(t.description, /Known pitfalls[\s\S]*- skip hidden products/);
  assert.match(t.description, /Additional instructions\nBe brief\./);
  assert.equal(t.context!.brain, undefined);
  assert.deepEqual(t.context!.acceptance, ['table of products']);
  assert.equal(t.context!.timeboxMin, 30);
  assert.deepEqual(t.context!.recipe, { id: r.id, version: 1, name: 'Catalog audit', values: { store: 'gumroad', month: 'Oct' } });
  assert.equal(t.to.agent, 'analyst');
  assert.ok(t.tags!.includes(`recipe:${r.id}`));

  const locked = normalizeRecipe({ ...base, carry: { ...base.carry, brainMode: 'lock' } });
  assert.equal(instantiate(locked, { values: { month: 'Oct' } }).context!.brain, 'local-cc-opus-5-5');
  assert.equal(instantiate(locked, { values: { month: 'Oct' }, brain: '' }).context!.brain, undefined);
  assert.equal(instantiate(r, { values: { month: 'Oct' }, brain: 'b2' }).context!.brain, 'b2');
});

test('draftFromTask keeps the brief, strips continuation scaffolding and stray braces', () => {
  const d = draftFromTask(task({
    id: 'abc', title: 'Audit', description: 'Do {{x}} thing\n---\nThis task CONTINUES a previous run ("…")',
    result: 'ok', to: { agent: 'analyst' }, context: { ranBrain: 'b1', acceptance: ['a'], inputFiles: ['f.txt'] },
  }));
  assert.equal(d.brief, 'Do x thing');
  assert.equal(d.carry.brain, 'b1');
  assert.equal(d.carry.brainMode, 'suggest');
  assert.deepEqual(d.carry.inputs, ['f.txt']);
  assert.equal(d.origin!.taskId, 'abc');
});

test('recipeStats: explicit vote > failure > DONE footer; per-version score', () => {
  const r = { ...normalizeRecipe(base), version: 2 };
  const rc = (v: number, extra: Record<string, any> = {}) => ({ recipe: { id: r.id, version: v }, ...extra });
  const tasks = [
    task({ id: '1', createdAt: '2026-10-05T00:00:00Z', context: rc(2, { rating: { good: true, at: 'x' } }), result: 'FAILED: x' }),
    task({ id: '2', createdAt: '2026-10-04T00:00:00Z', context: rc(2), result: 'FAILED: boom' }),
    task({ id: '3', createdAt: '2026-10-03T00:00:00Z', context: rc(1), result: 'ok\nSTATUS: DONE', claimedAt: '2026-10-03T00:00:00Z', completedAt: '2026-10-03T00:10:00Z' }),
    task({ id: '4', createdAt: '2026-10-02T00:00:00Z', context: rc(1), result: 'STATUS: DONE_WITH_CONCERNS' }),
    task({ id: '5', createdAt: '2026-10-06T00:00:00Z', context: rc(2), status: 'pending' }),
    task({ id: '6', context: { recipe: { id: 'rcp-other000' } } }),
  ];
  const s = recipeStats(r, tasks);
  assert.equal(s.runs, 5);
  assert.equal(s.running, 1);
  assert.equal(s.good, 2);
  assert.equal(s.bad, 1);
  assert.deepEqual(s.recent, [1, 0, 1, null]);
  assert.equal(s.versionGood, 1);
  assert.equal(s.versionBad, 1);
  assert.equal(s.medianMs, 600000);
  assert.equal(s.lastRunAt, '2026-10-06T00:00:00Z');
});

test('recipePitfalls returns 👎 notes newest first', () => {
  const r = normalizeRecipe(base);
  const bad = (note: string, at: string) => task({ context: { recipe: { id: r.id }, rating: { good: false, note, at } } });
  assert.deepEqual(recipePitfalls(r, [bad('old', '2026-10-01'), bad('new', '2026-10-02'), task({ context: { recipe: { id: r.id }, rating: { good: true, note: 'nice', at: 'z' } } })]), ['new', 'old']);
});

test('Recipes store: create copies inputs, edit bumps version, run stages inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-'));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  fs.writeFileSync(path.join(origin, 'spec.md'), 'hello');
  const lib = new Recipes(path.join(root, 'recipes'), path.join(root, 'inputs'));
  const r = lib.create({ ...base, carry: { ...base.carry, inputs: ['spec.md', 'missing.txt'] } }, origin);
  assert.deepEqual(r.carry.inputs, ['spec.md']);
  assert.equal(lib.list().length, 1);

  assert.equal(lib.update(r.id, { purpose: 'monthly' }).version, 1, 'metadata edit keeps the version');
  const v2 = lib.update(r.id, { brief: 'Audit {{store}} for {{month}} again.' });
  assert.equal(v2.version, 2);
  assert.equal(lib.versions(r.id)[0].brief, base.brief);

  const staged = lib.stageInputs(v2);
  assert.equal(staged.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'inputs', '_staging', staged[0].token, 'spec.md'), 'utf8'), 'hello');

  lib.archive(r.id);
  assert.equal(lib.list().length, 0);
  assert.equal(lib.list({ includeArchived: true }).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
