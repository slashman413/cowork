import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { Store } from '../core/store.js';
import { EventBus } from '../core/events.js';
import { createMcpServer } from './server.js';
import type { Config } from '../types.js';

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-mcp-get-task-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'workflows', 'agencyAgents']) {
    paths[k] = path.join(root, k);
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const config = {
    server: { name: 'Cowork Test MCP', version: '1.0.0' },
    paths,
    platforms: {},
    orchestration: { agents: {} }
  } as unknown as Config;
  const eventBus = new EventBus();
  const store = new Store(config, eventBus);
  const mcp = createMcpServer(config, store, eventBus);

  const app = express();
  app.use(express.json());
  app.post('/mcp', mcp.handleRequest);
  const server = app.listen(0);
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    assert.equal(res.status, 200, `Expected HTTP 200 from /mcp, got ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('text/event-stream')) {
      const dataLines = text
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(Boolean);
      assert.ok(dataLines.length > 0, `Expected SSE data line in response: ${text}`);
      return JSON.parse(dataLines[dataLines.length - 1]);
    }
    return JSON.parse(text);
  }

  const cleanup = () => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  };

  return { config, store, rpc, cleanup };
}

test('MCP tools/list exposes get_task tool', async () => {
  const { rpc, cleanup } = createFixture();
  try {
    const resp = await rpc('tools/list');
    const tools = resp.result?.tools || [];
    const getTaskTool = tools.find((t: any) => t.name === 'get_task');
    assert.ok(getTaskTool, 'Expected get_task to be listed in tools/list');
    assert.ok(getTaskTool.inputSchema?.properties?.taskId, 'Expected taskId in get_task schema');
    assert.ok(getTaskTool.inputSchema?.properties?.task_id, 'Expected task_id alias in get_task schema');
  } finally {
    cleanup();
  }
});

test('get_task returns single-task status, result, logs, and artifacts directly without scanning listTasks', async () => {
  const { store, rpc, cleanup } = createFixture();
  try {
    const task = store.createTask({
      title: 'Verify O(1) lookup',
      description: 'Inspect single task directly by ID',
      from: { platform: 'cline', agent: 'cline-vscode' },
      to: { agent: 'local-cc-sonnet' },
      priority: 'high'
    } as any);

    const worker = store.registerWorker({ platform: 'local', workerName: 'runner-1' });
    store.claimTask({ taskId: task.id, workerId: worker.id });

    // Seed progress log, working artifact, and final output file
    const artDir = path.join(store['config'].paths.artifacts, task.id);
    fs.mkdirSync(path.join(artDir, 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(artDir, 'progress.log'), 'step 1: starting\nstep 2: tests green\n');
    fs.writeFileSync(path.join(artDir, 'notes.txt'), 'scratch notes\n');
    fs.writeFileSync(path.join(artDir, 'outputs', 'report.md'), '# Final Report\n');

    await store.completeTask({ taskId: task.id, result: 'All checks passed\nSTATUS: DONE' });

    // Guard: full-inbox scanning must NOT be called for a direct full-UUID lookup
    let listTasksCalled = 0;
    const origListTasks = store.listTasks.bind(store);
    (store as any).listTasks = (...args: any[]) => {
      listTasksCalled++;
      return origListTasks(...args);
    };

    const resp = await rpc('tools/call', {
      name: 'get_task',
      arguments: { taskId: task.id }
    });

    assert.equal(listTasksCalled, 0, 'get_task must not scan listTasks for full UUID lookups');
    assert.equal(resp.result?.isError, undefined);
    const payload = JSON.parse(resp.result.content[0].text);
    assert.equal(payload.id, task.id);
    assert.equal(payload.status, 'done');
    assert.equal(payload.title, 'Verify O(1) lookup');
    assert.match(payload.result, /All checks passed/);
    assert.match(payload.logs, /step 2: tests green/);
    assert.equal(payload.progress.status, 'done');
    assert.equal(payload.progress.running, false);
    assert.ok(payload.artifacts.includes('notes.txt'), `Expected notes.txt in artifacts: ${JSON.stringify(payload.artifacts)}`);
    assert.ok(payload.outputs.includes('report.md'), `Expected report.md in outputs: ${JSON.stringify(payload.outputs)}`);
  } finally {
    cleanup();
  }
});

test('get_task accepts task_id alias, short prefix, and include_logs=false', async () => {
  const { store, rpc, cleanup } = createFixture();
  try {
    const task = store.createTask({
      title: 'Short prefix check',
      description: 'Check task_id alias',
      from: { platform: 'claude', agent: 'claude-desktop' },
      to: {},
      priority: 'normal'
    } as any);

    const artDir = path.join(store['config'].paths.artifacts, task.id);
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, 'progress.log'), 'live line\n');

    const shortPrefix = task.id.slice(0, 8);
    const resp = await rpc('tools/call', {
      name: 'get_task',
      arguments: { task_id: shortPrefix, include_logs: false }
    });

    assert.equal(resp.result?.isError, undefined);
    const payload = JSON.parse(resp.result.content[0].text);
    assert.equal(payload.id, task.id);
    assert.equal(payload.status, 'pending');
    assert.equal(payload.logs, undefined);
    assert.equal(payload.progress, undefined);
  } finally {
    cleanup();
  }
});

test('get_task returns actionable isError responses for missing or unknown taskId', async () => {
  const { rpc, cleanup } = createFixture();
  try {
    const missing = await rpc('tools/call', {
      name: 'get_task',
      arguments: {}
    });
    assert.equal(missing.result?.isError, true);
    assert.match(missing.result.content[0].text, /taskId/i);

    const notFound = await rpc('tools/call', {
      name: 'get_task',
      arguments: { taskId: '00000000-0000-0000-0000-000000000000' }
    });
    assert.equal(notFound.result?.isError, true);
    const body = JSON.parse(notFound.result.content[0].text);
    assert.equal(body.error, 'Task not found');
    assert.equal(body.taskId, '00000000-0000-0000-0000-000000000000');
    assert.ok(body.hint);
  } finally {
    cleanup();
  }
});
