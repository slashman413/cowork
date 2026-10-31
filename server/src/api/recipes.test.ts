import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { Store } from '../core/store.js';
import { EventBus } from '../core/events.js';
import { Recipes } from '../core/recipes.js';
import { createRecipeRouter } from './recipes.js';
import type { Config } from '../types.js';

/**
 * End-to-end over HTTP with a real Store: a finished task → draft → saved recipe
 * (inputs copied) → run (an ordinary pending task with the rendered brief, the
 * recipe's inputs and carry) → 👎 with a note → stats + pitfall on the next run.
 */
test('recipe API: capture a done task, run it, rate it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-recipes-api-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'workflows', 'agencyAgents']) {
    paths[k] = path.join(root, k);
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const store = new Store({ paths, platforms: {}, orchestration: { brains: {} } } as unknown as Config, new EventBus());
  const recipes = new Recipes(path.join(root, 'recipes'), paths.inputs);
  const app = express();
  app.use(express.json());
  app.use('/api', createRecipeRouter(recipes, store));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, url: string, body?: any) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() as any };
  };

  try {
    // A good finished task with one attached input file.
    const slot = path.join(paths.inputs, '_staging', 'tok1');
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, 'skus.csv'), 'sku\nA1\n');
    const origin = store.createTask({
      title: 'Audit the Gumroad catalog', description: 'Audit the gumroad catalog for October.',
      from: { platform: 'dashboard', agent: 'ceo' }, to: { agent: 'analyst' }, priority: 'normal',
      context: { acceptance: ['table of products'], timeboxMin: 30 },
    }, { inputs: [{ token: 'tok1', name: 'skus.csv' }] });
    origin.status = 'done';
    origin.result = 'All good.\nSTATUS: DONE';
    store.saveTask(origin);

    const draft = await call('POST', `/recipes/draft-from-task/${origin.id}`);
    assert.equal(draft.status, 200);
    assert.deepEqual(draft.json.carry.inputs, ['skus.csv']);
    assert.equal(draft.json.carry.agent, 'analyst');

    // The user turns "October" into a field in the editor, then saves.
    const saved = await call('POST', '/recipes', {
      ...draft.json, name: 'Catalog audit', title: 'Catalog audit — {{month}}',
      brief: 'Audit the gumroad catalog for {{month}}.',
      fields: [{ key: 'month', label: 'Month', type: 'text', default: 'October' }],
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    const id = saved.json.id;
    assert.ok(fs.existsSync(path.join(root, 'recipes', id, 'inputs', 'skus.csv')));

    const bad = await call('POST', `/recipes/${id}/run`, { values: { month: '' } });
    assert.equal(bad.status, 201, 'empty value falls back to the default');

    const run = await call('POST', `/recipes/${id}/run`, { values: { month: 'November' } });
    assert.equal(run.status, 201);
    const t = store.getTask(run.json.id)!;
    assert.equal(t.status, 'pending');
    assert.equal(t.title, 'Catalog audit — November');
    assert.match(t.description, /^Audit the gumroad catalog for November\./);
    assert.deepEqual(t.context?.inputFiles, ['skus.csv']);
    assert.deepEqual(t.context?.acceptance, ['table of products']);
    assert.equal(t.context?.recipe?.id, id);
    assert.ok(t.tags?.includes(`recipe:${id}`));
    assert.equal(t.to?.agent, 'analyst');
    assert.equal(t.context?.brain, undefined, 'suggest mode leaves routing to the router');

    // Finish + 👎 with a note → stats, and the note rides along on the next run.
    t.status = 'done'; t.result = 'meh\nSTATUS: DONE';
    store.saveTask(t);
    const rated = await call('POST', `/inbox/${t.id}/rating`, { good: false, note: 'missed the hidden products' });
    assert.equal(rated.status, 200);
    const detail = await call('GET', `/recipes/${id}`);
    assert.equal(detail.json.stats.runs, 2);
    assert.equal(detail.json.stats.bad, 1);
    const next = await call('POST', `/recipes/${id}/run`, { values: { month: 'December' } });
    assert.match(store.getTask(next.json.id)!.description, /Known pitfalls[\s\S]*missed the hidden products/);

    // Editing the brief bumps the version; archive hides it from the library.
    const edited = await call('PUT', `/recipes/${id}`, { brief: 'Audit the gumroad + itch catalog for {{month}}.' });
    assert.equal(edited.json.version, 2);
    assert.equal((await call('DELETE', `/recipes/${id}`)).status, 200);
    assert.equal((await call('GET', '/recipes')).json.length, 0);
    assert.equal((await call('POST', `/recipes/${id}/run`, { values: { month: 'x' } })).status, 404);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recipe independence: runs successfully even after origin task is deleted with all its files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-recipes-deleted-task-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'workflows', 'agencyAgents']) {
    paths[k] = path.join(root, k);
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const store = new Store({ paths, platforms: {}, orchestration: { brains: {} } } as unknown as Config, new EventBus());
  const recipes = new Recipes(path.join(root, 'recipes'), paths.inputs);
  const app = express();
  app.use(express.json());
  app.use('/api', createRecipeRouter(recipes, store));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, url: string, body?: any) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() as any };
  };

  try {
    // 1. Create a task with inputs and output artifacts
    const slot = path.join(paths.inputs, '_staging', 'tok-ind');
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, 'dataset.csv'), 'id,name\n1,Alpha\n');
    const origin = store.createTask({
      title: 'Generate monthly brief', description: 'Analyze {{dataset}} and output report',
      from: { platform: 'dashboard', agent: 'ceo' }, to: { agent: 'analyst' }, priority: 'normal',
      context: { acceptance: ['summary generated'] },
    }, { inputs: [{ token: 'tok-ind', name: 'dataset.csv' }] });
    origin.status = 'done';
    origin.result = 'Report ready in artifacts.\nSTATUS: DONE';
    store.saveTask(origin);

    // Create task artifacts (including intermediates)
    const taskArtDir = path.join(paths.artifacts, origin.id);
    fs.mkdirSync(path.join(taskArtDir, 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(taskArtDir, 'progress.log'), 'streaming runtime logs...');
    fs.writeFileSync(path.join(taskArtDir, 'progress.md'), '- [x] step 1');
    fs.writeFileSync(path.join(taskArtDir, 'result.md'), '# Full result markdown');
    fs.writeFileSync(path.join(taskArtDir, 'changes.patch'), 'diff --git a/b');
    fs.writeFileSync(path.join(taskArtDir, 'analysis.py'), 'print("analyzing")');
    fs.writeFileSync(path.join(taskArtDir, 'outputs', 'brief.pdf'), 'binary-brief-content');

    // 2. Draft recipe from task
    const draft = await call('POST', `/recipes/draft-from-task/${origin.id}`);
    assert.equal(draft.status, 200);
    const draftInputs = draft.json.carry.inputs.sort();
    assert.ok(draftInputs.includes('dataset.csv'));
    assert.ok(draftInputs.includes('analysis.py'));
    assert.ok(draftInputs.includes('brief.pdf'));
    assert.ok(!draftInputs.includes('progress.log'));
    assert.ok(!draftInputs.includes('progress.md'));
    assert.ok(!draftInputs.includes('result.md'));

    // 3. Save recipe
    const saved = await call('POST', '/recipes', {
      ...draft.json,
      name: 'Monthly brief generator',
      title: 'Monthly brief — {{month}}',
      brief: 'Run analysis on {{month}} data.',
      fields: [{ key: 'month', label: 'Month', type: 'text', default: 'January' }],
    });
    assert.equal(saved.status, 201);
    const recipeId = saved.json.id;

    // Verify inputs were copied into recipes/<id>/inputs/
    assert.ok(fs.existsSync(path.join(root, 'recipes', recipeId, 'inputs', 'dataset.csv')));
    assert.ok(fs.existsSync(path.join(root, 'recipes', recipeId, 'inputs', 'analysis.py')));
    assert.ok(fs.existsSync(path.join(root, 'recipes', recipeId, 'inputs', 'brief.pdf')));

    assert.ok(!fs.existsSync(path.join(root, 'recipes', recipeId, 'inputs', 'progress.log')));

    // A forged origin ("..") must not turn the repo root into a copy source.
    const forged = await call('POST', '/recipes', { ...draft.json, name: 'Forged', origin: { taskId: '..' } });
    assert.equal(forged.status, 201);
    assert.deepEqual(forged.json.carry.inputs, []);

    // 4. DELETE origin task from system
    const delRes = store.deleteTask(origin.id);
    assert.equal(delRes.deleted, true);
    assert.equal(store.getTask(origin.id), null);
    assert.ok(!fs.existsSync(taskArtDir), 'origin task artifacts dir must be deleted');
    assert.ok(!fs.existsSync(path.join(paths.inputs, origin.id)), 'origin task inputs dir must be deleted');

    // 5. Recipe detail still works and reflects that origin task is gone
    const detail = await call('GET', `/recipes/${recipeId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.originTaskExists, false);
    assert.equal(detail.json.origin.taskId, origin.id);
    assert.match(detail.json.origin.resultExcerpt, /Report ready in artifacts/);

    // 6. Run the recipe without any files from origin task
    const runRes = await call('POST', `/recipes/${recipeId}/run`, { values: { month: 'February' } });
    assert.equal(runRes.status, 201);
    const newTaskId = runRes.json.id;
    const newTask = store.getTask(newTaskId)!;
    assert.equal(newTask.status, 'pending');
    assert.equal(newTask.title, 'Monthly brief — February');

    // Verify the new task received all input files staged from recipe path
    const newTaskInputsDir = store.inputsPath(newTaskId)!;
    assert.ok(newTaskInputsDir && fs.existsSync(newTaskInputsDir));
    const stagedFiles = fs.readdirSync(newTaskInputsDir).sort();
    assert.ok(stagedFiles.includes('analysis.py'));
    assert.ok(stagedFiles.includes('brief.pdf'));
    assert.ok(stagedFiles.includes('dataset.csv'));
    assert.deepEqual(newTask.context?.inputFiles?.sort(), stagedFiles);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
