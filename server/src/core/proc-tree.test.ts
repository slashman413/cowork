import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree, descendants } from './proc-tree.js';
import { Dispatcher } from './dispatcher.js';
import { EventBus } from './events.js';
import { Store } from './store.js';
import type { Config } from '../types.js';

/**
 * Regression: deleting an in-progress task left its brain running (a dsh run kept
 * the local SGLang engine at ~96 % GPU). The fix spawns brains in their own process
 * group and kills the WHOLE tree — including tool processes that escaped into their
 * own session and ones that ignore SIGTERM.
 */

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return fn();
}

/** Spawn a "brain" tree like execute() does: detached shell → plain child,
 *  a child in its own session (setsid), and a child that ignores SIGTERM. */
function spawnTree(dir: string) {
  const script = `
    sleep 300 & echo $! > ${dir}/plain
    setsid sleep 300 & echo $! > ${dir}/escaped
    sh -c 'trap "" TERM; while :; do sleep 0.1; done' & echo $! > ${dir}/stubborn
    wait`;
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  return child;
}

async function treePids(dir: string) {
  await waitFor(() => ['plain', 'escaped', 'stubborn'].every(f => existsSync(join(dir, f)) && readFileSync(join(dir, f), 'utf8').trim() !== ''));
  return ['plain', 'escaped', 'stubborn'].map(f => Number(readFileSync(join(dir, f), 'utf8').trim()));
}

test('killProcessTree kills the root, its group, escaped sessions and SIGTERM-ignorers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proctree-'));
  try {
    const child = spawnTree(dir);
    const pids = await treePids(dir);
    assert.ok(pids.every(alive), 'tree is up');
    assert.ok(pids.every(p => descendants(child.pid!).has(p)), 'descendants() finds every child');

    await killProcessTree(child.pid, { graceMs: 300 });
    assert.ok(await waitFor(() => !alive(child.pid!) || child.exitCode !== null || child.signalCode !== null), 'root gone');
    assert.ok(await waitFor(() => pids.every(p => !alive(p))), `all descendants gone: ${pids.filter(alive)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a running task (taskDeleted event) kills its brain tree and marks the run cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proctree-'));
  try {
    const bus = new EventBus();
    const config = { orchestration: { killGraceMs: 300, brains: {}, agents: {} }, inbox: { maxRetries: 1 } } as unknown as Config;
    const d = new Dispatcher(config, {} as any, bus);
    const child = spawnTree(dir);
    const pids = await treePids(dir);
    (d as any).running.set('task-1', { role: 'x', startedAt: Date.now(), brainId: 'local-dsh-qwen3-8-27b' });
    (d as any).children.set('task-1', child);

    bus.emitTaskDeleted('some-other-task', 'in-progress');
    await sleep(100);
    assert.ok(pids.every(alive), 'an unrelated delete leaves this brain alone');

    bus.emitTaskDeleted('task-1', 'in-progress');
    assert.ok((d as any).cancelled.has('task-1'), 'run marked cancelled → execute() discards it');
    assert.ok(await waitFor(() => pids.every(p => !alive(p))), `brain tree killed: ${pids.filter(alive)}`);
    assert.equal(d.cancelTask('not-running'), false, 'cancelling a task this dispatcher is not running is a no-op');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Store.deleteTask emits taskDeleted with the full id (short-id delete included)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cowork-del-'));
  try {
    const paths: Record<string, string> = {};
    for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'workflows', 'goals', 'agencyAgents']) {
      paths[k] = join(root, k);
      mkdirSync(paths[k], { recursive: true });
    }
    const bus = new EventBus();
    const seen: any[] = [];
    bus.on('taskDeleted', (e: any) => seen.push(e.payload));
    const store = new Store({ paths, orchestration: { brains: {} } } as unknown as Config, bus);
    const task = store.createTask({ title: 'run me', from: { platform: 'p', agent: 'a' } } as any);
    assert.equal(store.deleteTask(task.id.slice(0, 8)).deleted, true);
    assert.deepEqual(seen, [{ taskId: task.id, status: 'pending' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
