import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { Store } from '../core/store.js';
import { EventBus } from '../core/events.js';
import { createApiRouter } from './router.js';
import type { Config } from '../types.js';

// GET /tasks is the object-shaped alias of GET /inbox: same query filters, wrapped in {tasks}.
test('GET /tasks lists the same tasks as GET /inbox, wrapped, and honours the agent filter', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-tasks-alias-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'workflows', 'agencyAgents']) {
    paths[k] = path.join(root, k);
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const store = new Store({ paths, platforms: {}, orchestration: { agents: {} } } as unknown as Config, new EventBus());
  store.createTask({ title: 'one', description: 'x', to: { agent: 'local-cc-opus-5-5' } } as any);
  store.createTask({ title: 'two', description: 'y', to: { agent: 'local-cc-sonnet-5-5' } } as any);

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(store, new EventBus()));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = async (url: string) => (await fetch(base + url)).json() as Promise<any>;

  try {
    const inbox = await get('/inbox');
    const { tasks } = await get('/tasks');
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks.map((t: any) => t.id), inbox.map((t: any) => t.id));

    const filtered = await get('/tasks?agent=local-cc-opus-5-5');
    assert.deepEqual(filtered.tasks.map((t: any) => t.title), ['one']);
    assert.equal((await get('/tasks?limit=1')).tasks.length, 1);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
