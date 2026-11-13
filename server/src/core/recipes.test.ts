import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Recipes, draftFromTask, instantiate, normalizeRecipe, recipePitfalls, recipeStats, renderTemplate, resolveValues,
  isIntermediateArtifact, collectTaskArtifacts, carryFiles, carryInputNames,
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
  carry: { persona: 'analyst', agent: 'local-cc-opus-5-5', agentMode: 'suggest', acceptance: ['table of products'], timeboxMin: 30, inputs: [] },
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
  assert.equal(t.context!.agent, undefined);
  assert.deepEqual(t.context!.acceptance, ['table of products']);
  assert.equal(t.context!.timeboxMin, 30);
  assert.deepEqual(t.context!.recipe, { id: r.id, version: 1, name: 'Catalog audit', values: { store: 'gumroad', month: 'Oct' } });
  // The persona is never pinned by a recipe — the orchestrator picks it per run.
  assert.equal(t.to.agent, undefined);
  assert.equal(t.context!.division, undefined);
  assert.equal(t.context!.thinking, undefined);
  assert.ok(t.tags!.includes(`recipe:${r.id}`));

  const locked = normalizeRecipe({ ...base, carry: { ...base.carry, agentMode: 'lock' } });
  assert.equal(instantiate(locked, { values: { month: 'Oct' } }).context!.agent, 'local-cc-opus-5-5');
  assert.equal(instantiate(locked, { values: { month: 'Oct' }, agent: '' }).context!.agent, undefined);
  assert.equal(instantiate(r, { values: { month: 'Oct' }, agent: 'b2' }).context!.agent, 'b2');
});

test('draftFromTask keeps the brief, strips continuation scaffolding and stray braces', () => {
  const d = draftFromTask(task({
    id: 'abc', title: 'Audit', description: 'Do {{x}} thing\n---\nThis task CONTINUES a previous run ("…")',
    result: 'ok', to: { agent: 'analyst' }, context: { ranAgent: 'b1', acceptance: ['a'], inputFiles: ['f.txt'] },
  }));
  assert.equal(d.brief, 'Do x thing');
  assert.equal(d.carry.agent, 'b1');
  assert.equal(d.carry.agentMode, 'suggest');
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
  const r = lib.create({ ...base, carry: { ...base.carry, inputs: ['spec.md', 'missing.txt'] } }, { inputsDir: origin });
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

test('isIntermediateArtifact flags runner noise and keeps deliverables', () => {
  assert.equal(isIntermediateArtifact('progress.log'), true);
  assert.equal(isIntermediateArtifact('progress.md'), true);
  assert.equal(isIntermediateArtifact('result.md'), true);
  assert.equal(isIntermediateArtifact('changes.patch'), true);
  assert.equal(isIntermediateArtifact('.git'), true);
  assert.equal(isIntermediateArtifact('.DS_Store'), true);
  assert.equal(isIntermediateArtifact('temp.tmp'), true);
  assert.equal(isIntermediateArtifact('__pycache__'), true);
  assert.equal(isIntermediateArtifact('node_modules'), true);
  assert.equal(isIntermediateArtifact('run.log'), true);
  assert.equal(isIntermediateArtifact('mod.pyc'), true);

  assert.equal(isIntermediateArtifact('report.md'), false);
  assert.equal(isIntermediateArtifact('outputs/deck.pdf'), false);
  assert.equal(isIntermediateArtifact('data.csv'), false);
  assert.equal(isIntermediateArtifact('script.py'), false);
});

test('collectTaskArtifacts skips intermediates and collects nested artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-test-'));
  fs.mkdirSync(path.join(root, 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'progress.log'), 'log data');
  fs.writeFileSync(path.join(root, 'progress.md'), 'ledger');
  fs.writeFileSync(path.join(root, 'result.md'), 'result markdown');
  fs.writeFileSync(path.join(root, 'changes.patch'), 'patch');
  fs.writeFileSync(path.join(root, 'temp.tmp'), 'temp');
  fs.writeFileSync(path.join(root, 'report.md'), 'my report');
  fs.writeFileSync(path.join(root, 'outputs', 'deck.pdf'), 'binary data');

  const collected = collectTaskArtifacts(root);
  assert.deepEqual(collected, ['outputs/deck.pdf', 'report.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('draftFromTask and Recipes.create copy task code (folders kept) and inputs, not results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-art-'));
  const originArt = path.join(root, 'task-artifacts');
  const originIn = path.join(root, 'task-inputs');
  fs.mkdirSync(path.join(originArt, 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(originArt, 'src'), { recursive: true });
  fs.mkdirSync(originIn, { recursive: true });

  fs.writeFileSync(path.join(originIn, 'seed.csv'), 'sku,price\n1,10\n');
  fs.writeFileSync(path.join(originArt, 'progress.log'), 'streamed log');
  fs.writeFileSync(path.join(originArt, 'result.md'), 'done');
  fs.writeFileSync(path.join(originArt, 'summary.json'), '{"ok":true}');
  fs.writeFileSync(path.join(originArt, 'config.yaml'), 'k: v');
  fs.writeFileSync(path.join(originArt, 'src', 'lib.py'), 'X = 1');
  fs.writeFileSync(path.join(originArt, 'outputs', 'chart.png'), 'png-bytes');

  const d = draftFromTask(task({
    id: 't-123',
    title: 'Process data',
    description: 'Process {{dataset}} for report',
    context: { inputFiles: ['seed.csv'] },
  }), { inputsDir: originIn, artifactsDir: originArt });

  assert.deepEqual(d.carry.inputs, ['seed.csv', 'config.yaml', 'src/lib.py']);
  assert.deepEqual(d.carrySkipped, ['summary.json', 'outputs/chart.png']);

  const lib = new Recipes(path.join(root, 'recipes'), path.join(root, 'inputs'));
  const r = lib.create(d, { inputNames: ['seed.csv'], inputsDir: originIn, artifactsDir: originArt });

  // Carried files are copied once, into recipes/<id>/inputs/, layout kept
  assert.ok(fs.existsSync(path.join(root, 'recipes', r.id, 'inputs', 'seed.csv')));
  assert.ok(fs.existsSync(path.join(root, 'recipes', r.id, 'inputs', 'config.yaml')));
  assert.ok(fs.existsSync(path.join(root, 'recipes', r.id, 'inputs', 'src', 'lib.py')));
  assert.ok(!fs.existsSync(path.join(root, 'recipes', r.id, 'inputs', 'summary.json')));
  assert.ok(!fs.existsSync(path.join(root, 'recipes', r.id, 'inputs', 'progress.log')));
  assert.ok(!fs.existsSync(path.join(root, 'recipes', r.id, 'artifacts')), 'no second copy');

  const staged = lib.stageInputs(r);
  assert.deepEqual(staged.map(s => s.name).sort(), ['config.yaml', 'seed.csv', 'src/lib.py']);

  fs.rmSync(root, { recursive: true, force: true });
});

test('Recipes.create respects a cleared input list — artifacts are not re-added', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-none-'));
  const art = path.join(root, 'art');
  fs.mkdirSync(art);
  fs.writeFileSync(path.join(art, 'summary.json'), '{}');
  const lib = new Recipes(path.join(root, 'recipes'), path.join(root, 'inputs'));
  const r = lib.create({ ...base, carry: { ...base.carry, inputs: [] } }, { artifactsDir: art });
  assert.deepEqual(r.carry.inputs, []);
  assert.ok(!fs.existsSync(path.join(root, 'recipes', r.id)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('carryFiles: keeps folders, suffixes clashes in place, drops copies, scratch and results, limits omit the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-'));
  const inp = path.join(root, 'in'), art = path.join(root, 'art');
  fs.mkdirSync(inp);
  fs.mkdirSync(path.join(art, 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(art, 'src'), { recursive: true });
  fs.mkdirSync(path.join(art, 'work', 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(art, 'temp_pipeline'), { recursive: true });
  fs.writeFileSync(path.join(inp, 'run.py'), 'input');
  fs.writeFileSync(path.join(art, 'run.py'), 'root');                  // clashes with the input
  fs.writeFileSync(path.join(art, 'outputs', 'run.py'), 'root');       // byte copy of art/run.py
  fs.writeFileSync(path.join(art, 'src', 'pipeline.py'), 'x'.repeat(50));
  fs.writeFileSync(path.join(art, 'upload_summary.json'), '{"done":true}');
  fs.writeFileSync(path.join(art, 'outputs', 'video.mp4'), 'mp4');
  fs.writeFileSync(path.join(art, 'work', 'step.py'), 'scratch');
  fs.writeFileSync(path.join(art, 'temp_pipeline', 'a.py'), 'scratch');
  fs.writeFileSync(path.join(art, 'work', 'node_modules', 'x', 'index.js'), '');

  const all = carryFiles({ inputNames: ['run.py'], inputsDir: inp, artifactsDir: art });
  assert.deepEqual(all.files.map(f => [f.name, path.relative(root, f.src!)]), [
    ['run.py', 'in/run.py'],
    ['run-1.py', 'art/run.py'],
    ['src/pipeline.py', 'art/src/pipeline.py'],
  ]);
  assert.deepEqual(all.omitted, []);
  assert.deepEqual(all.skipped, ['upload_summary.json', 'outputs/video.mp4']);

  const capped = carryFiles({ inputNames: ['run.py'], inputsDir: inp, artifactsDir: art }, { maxFiles: 10, maxBytes: 40 });
  assert.deepEqual(capped.files.map(f => f.name), ['run.py', 'run-1.py']);
  assert.deepEqual(capped.omitted, ['src/pipeline.py']);
  assert.deepEqual(carryFiles({ artifactsDir: art }, { maxFiles: 1, maxBytes: 1e9 }).omitted, ['src/pipeline.py']);

  // create() copies under the same names the draft showed; a ".." name never escapes
  const lib = new Recipes(path.join(root, 'recipes'), path.join(root, 'inputs'));
  const r = lib.create({ ...base, carry: { ...base.carry, inputs: ['src/pipeline.py', 'run.py', '../run-1.py'] } },
    { inputNames: ['run.py'], inputsDir: inp, artifactsDir: art });
  assert.deepEqual(r.carry.inputs, ['run.py', 'src/pipeline.py']);
  assert.equal(fs.readFileSync(path.join(lib.inputsDir(r.id), 'src', 'pipeline.py'), 'utf8'), 'x'.repeat(50));
  fs.rmSync(root, { recursive: true, force: true });
});

test('carryInputNames drops the runner noise a continuation seeded as inputs', () => {
  const inputFiles = ['previous-result.md', 'progress.log', 'result.md', 'result-1.md', 'progress-1.md', 'report-2024.pdf', 'outputs.md'];
  assert.deepEqual(carryInputNames(task({ context: { continuedFrom: 'prev', inputFiles } })), ['report-2024.pdf', 'outputs.md']);
  // A user's own attachments on an ordinary task are carried as-is.
  assert.deepEqual(carryInputNames(task({ context: { inputFiles: ['result.md'] } })), ['result.md']);
});

test('recipe thinking: carried level applies, a run override wins, junk is dropped', () => {
  const r = normalizeRecipe({ ...base, carry: { ...base.carry, thinking: 'HIGH' } });
  assert.equal(r.carry.thinking, 'high');
  assert.equal(instantiate(r, { values: { month: 'Oct' } }).context!.thinking, 'high');
  assert.equal(instantiate(r, { values: { month: 'Oct' }, thinking: 'max' }).context!.thinking, 'max');
  assert.equal(instantiate(r, { values: { month: 'Oct' }, thinking: '' }).context!.thinking, undefined);
  assert.equal(normalizeRecipe({ ...base, carry: { ...base.carry, thinking: 'turbo' } }).carry.thinking, undefined);
});

test('a hand-written recipe (no origin task) normalizes and runs', () => {
  const r = normalizeRecipe({ name: 'Weekly digest', brief: 'Summarise {{topic}} news.', title: 'Digest: {{topic}}',
    fields: [{ key: 'topic', label: 'Topic', type: 'text' }], carry: { agentMode: 'suggest', inputs: [] } });
  assert.equal(r.origin, undefined);
  const t = instantiate(r, { values: { topic: 'AI' } });
  assert.equal(t.title, 'Digest: AI');
  assert.equal(t.description, 'Summarise AI news.');
});

test('draftFromTask carries the thinking level but no persona', () => {
  const d = draftFromTask(task({ id: 'th', title: 'x', description: 'y', to: { agent: 'analyst' },
    context: { thinking: 'xhigh', persona: 'engineering-backend', division: 'engineering' } }));
  assert.equal(d.carry.thinking, 'xhigh');
  assert.equal(d.carry.persona, undefined);
  assert.equal(d.carry.division, undefined);
});
