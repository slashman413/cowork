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
