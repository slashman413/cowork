import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { Store } from '../core/store.js';
import { EventBus } from '../core/events.js';
import { Workspaces } from '../core/workspaces.js';
import { createApiRouter } from './router.js';
import { createWorkspaceRouter } from './workspaces.js';
import type { Config } from '../types.js';

test('Workspaces REST API supports CRUD, workspace-scoped tasks, and continuous sessions with auto pstack skills', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ws-api-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'goals', 'workspaces', 'agencyAgents']) {
    paths[k] = path.join(root, k);
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const eventBus = new EventBus();
  const store = new Store({ paths, platforms: {}, orchestration: { agents: {} } } as unknown as Config, eventBus);
  store.initialize();
  const workspaces = new Workspaces(paths.workspaces, store, eventBus);
  workspaces.attachToEventBus();

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(store, eventBus));
  app.use('/api', createWorkspaceRouter(workspaces));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const req = async (method: string, url: string, body?: any) => {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() as any };
  };

  try {
    // 1. Create & list workspaces
    const created = await req('POST', '/workspaces', { name: 'test-ws', description: 'API test workspace' });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, 'test-ws');
    const wsId = created.data.id;

    const other = await req('POST', '/workspaces', { name: 'other-ws' });
    assert.equal(other.status, 201);

    const list = await req('GET', '/workspaces');
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 2);

    // 2. Scoped task creation & querying via both /workspaces/:id/tasks and /inbox?workspaceId=
    const t1 = await req('POST', `/workspaces/${wsId}/tasks`, {
      title: 'Build feature',
      description: 'Implement responsive mobile layout in CSS and verify it',
    });
    assert.equal(t1.status, 201);
    assert.equal(t1.data.workspaceId, wsId);
    assert.ok(Array.isArray(t1.data.context?.pstackSkills) && t1.data.context.pstackSkills.length > 0);

    const t2 = await req('POST', `/workspaces/${other.data.id}/tasks`, {
      title: 'Other task',
      description: 'Belongs to other-ws',
    });
    assert.equal(t2.status, 201);

    const wsTasks = await req('GET', `/workspaces/${wsId}/tasks`);
    assert.equal(wsTasks.status, 200);
    assert.deepEqual(wsTasks.data.tasks.map((t: any) => t.id), [t1.data.id]);

    const inboxScoped = await req('GET', `/inbox?workspaceId=${wsId}`);
    assert.equal(inboxScoped.status, 200);
    assert.deepEqual(inboxScoped.data.map((t: any) => t.id), [t1.data.id]);

    const tasksAliasScoped = await req('GET', `/tasks?workspaceId=${wsId}`);
    assert.equal(tasksAliasScoped.status, 200);
    assert.deepEqual(tasksAliasScoped.data.tasks.map((t: any) => t.id), [t1.data.id]);

    // 3. Continuous session creation, messaging (auto pstack), pause, resume, fork
    const sessCreate = await req('POST', `/workspaces/${wsId}/sessions`, { title: 'Refactor session' });
    assert.equal(sessCreate.status, 201);
    const sessId = sessCreate.data.session.id;

    const msg = await req('POST', `/sessions/${sessId}/messages`, {
      prompt: 'Interrogate our API design and check TypeScript types',
    });
    assert.equal(msg.status, 201);
    assert.equal(msg.data.turn.index, 1);
    assert.ok(msg.data.turn.pstackSkills.includes('interrogate'));
    assert.equal(msg.data.task.workspaceId, wsId);
    assert.equal(msg.data.task.sessionId, sessId);

    const sessScoped = await req('GET', `/sessions?workspaceId=${wsId}`);
    assert.equal(sessScoped.status, 200);
    assert.equal(sessScoped.data.sessions.length, 1);

    const paused = await req('POST', `/sessions/${sessId}/pause`, {});
    assert.equal(paused.status, 200);
    assert.equal(paused.data.session.status, 'paused');

    const resumed = await req('POST', `/sessions/${sessId}/resume`, {});
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.session.status, 'working');

    const forked = await req('POST', `/sessions/${sessId}/fork`, { title: 'Forked session' });
    assert.equal(forked.status, 201);
    assert.equal(forked.data.workspaceId, wsId);
    assert.equal(forked.data.title, 'Forked session');

    // 4. Update & Delete workspace
    const patched = await req('PATCH', `/workspaces/${wsId}`, { name: 'test-ws-renamed' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.name, 'test-ws-renamed');

    const deleted = await req('DELETE', `/workspaces/${wsId}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.ok, true);

    const missing = await req('GET', `/workspaces/${wsId}`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
