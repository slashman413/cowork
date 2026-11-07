import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Coverage for the two features added alongside file-input support:
 *   1. Task INPUT files — staged uploads materialized into inputs/<taskId>/ and
 *      mirrored onto context.inputFiles so the agent can read them.
 *   2. The FAILED category + confirm-gated re-run — completeTask flags a
 *      chain-exhausted result, and rerunTask resets such a task to pending.
 */
function makeStore(agents: Record<string, unknown> = {}): { store: Store; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-inputs-'));
  const paths = {
    inbox: path.join(root, 'inbox'),
    artifacts: path.join(root, 'artifacts'),
    inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'),
    decisions: path.join(root, 'decisions'),
    workflows: path.join(root, 'workflows'),
    agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
  const config = { paths, orchestration: { agents } } as unknown as Config;
  return { store: new Store(config, new EventBus()), root };
}

test('stageUpload + createTask materializes inputs into inputs/<taskId>/ and context.inputFiles', () => {
  const { store, root } = makeStore();
  const a = store.stageUpload('brief.md', Buffer.from('# hello'));
  const b = store.stageUpload('data.csv', Buffer.from('x,y\n1,2'));
  assert.equal(a.name, 'brief.md');
  assert.ok(a.token && b.token);

  const task = store.createTask(
    { title: 'read these', from: { platform: 'p', agent: 'a' } } as any,
    { inputs: [{ token: a.token, name: a.name }, { token: b.token, name: b.name }] }
  );

  assert.deepEqual(store.listInputs(task.id).sort(), ['brief.md', 'data.csv']);
  assert.deepEqual((task.context?.inputFiles as string[]).sort(), ['brief.md', 'data.csv']);
  const p = store.inputFilePath(task.id, 'brief.md');
  assert.ok(p && fs.readFileSync(p, 'utf8') === '# hello');
  assert.ok(store.inputsPath(task.id), 'inputsPath resolves once files exist');
  // Staging slots are consumed (moved), leaving an empty _staging area.
  const staging = path.join(root, 'inputs', '_staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.equal(leftovers.length, 0, 'staged files are moved, not copied');
});

test('inputFilePath blocks path traversal and unknown files', () => {
  const { store } = makeStore();
  const a = store.stageUpload('ok.txt', Buffer.from('ok'));
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any,
    { inputs: [{ token: a.token, name: a.name }] });
  assert.equal(store.inputFilePath(task.id, '../../etc/passwd'), null, 'basename() defeats traversal');
  assert.equal(store.inputFilePath(task.id, 'missing.txt'), null);
});

test('appendInputs unions new files onto an existing task', () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any);
  assert.deepEqual(store.listInputs(task.id), []);
  const a = store.stageUpload('one.txt', Buffer.from('1'));
  const updated = store.appendInputs(task.id, [{ token: a.token, name: a.name }]);
  assert.deepEqual(updated?.context?.inputFiles, ['one.txt']);
  const b = store.stageUpload('two.txt', Buffer.from('2'));
  const again = store.appendInputs(task.id, [{ token: b.token, name: b.name }]);
  assert.deepEqual((again?.context?.inputFiles as string[]).sort(), ['one.txt', 'two.txt']);
});

test('materialize collision-suffixes a duplicate filename instead of clobbering', () => {
  const { store } = makeStore();
  const a = store.stageUpload('report.md', Buffer.from('A'));
  const b = store.stageUpload('report.md', Buffer.from('B'));
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any,
    { inputs: [{ token: a.token, name: a.name }, { token: b.token, name: b.name }] });
  const names = store.listInputs(task.id).sort();
  assert.deepEqual(names, ['report-1.md', 'report.md'], 'second same-named file is suffixed');
});

test('empty upload and bad filename are rejected', () => {
  const { store } = makeStore();
  assert.throws(() => store.stageUpload('x.txt', Buffer.alloc(0)), /empty upload/);
  assert.throws(() => store.stageUpload('..', Buffer.from('x')), /invalid filename/);
});

test('completeTask flags a chain-exhausted FAILED result; a normal result is not flagged', async () => {
  const { store } = makeStore();
  const good = store.createTask({ title: 'ok', from: { platform: 'p', agent: 'a' } } as any);
  const okDone = await store.completeTask({ taskId: good.id, result: 'All done, here is the brief.', internal: true });
  assert.equal(okDone?.status, 'done');
  assert.equal(okDone?.failed, undefined, 'a successful result is never flagged failed');

  const bad = store.createTask({ title: 'nope', from: { platform: 'p', agent: 'a' } } as any);
  const failDone = await store.completeTask({
    taskId: bad.id,
    result: 'FAILED after 3 attempt(s) (chain exhausted). Agents that failed: x. Last output: you have hit your limit',
    internal: true
  });
  assert.equal(failDone?.status, 'done');
  assert.equal(failDone?.failed, true, 'chain-exhausted result is flagged for the red category');
});

test('rerunTask resets a failed task to pending, preserving inputs and dropping the auto agent pin', async () => {
  const { store } = makeStore();
  const up = store.stageUpload('spec.md', Buffer.from('spec'));
  const task = store.createTask(
    { title: 'do it', from: { platform: 'p', agent: 'a' }, context: { agent: 'writer' } } as any,
    { inputs: [{ token: up.token, name: up.name }] }
  );
  // Simulate a dispatcher-driven chain that failed on its last rung.
  const t = store.getTask(task.id)!;
  t.context = { ...t.context, agent: 'remote-x', agentAuto: true, attempts: 2, dispatched: true, failedAgents: [{ agent: 'remote-x', reason: 'limit' }] };
  store.saveTask(t);
  await store.completeTask({ taskId: task.id, result: 'FAILED after 3 attempt(s) (chain exhausted). Agents that failed: remote-x. Last output: limit', internal: true });
  assert.equal(store.getTask(task.id)?.failed, true);

  const rerun = store.rerunTask(task.id);
  assert.equal(rerun?.status, 'pending', 'reset to pending');
  assert.equal(rerun?.failed, undefined, 'failed flag cleared');
  assert.equal(rerun?.result, undefined, 'stale FAILED result cleared');
  assert.equal(rerun?.context?.attempts, 0, 'attempts reset to top of chain');
  assert.equal(rerun?.context?.dispatched, false);
  assert.equal(rerun?.context?.agent, undefined, 'dispatcher-published (auto) agent pin dropped');
  assert.equal(rerun?.context?.failedAgents, undefined, 'failed-agent trail cleared');
  assert.equal(rerun?.context?.persona, 'writer', 'agent assignment preserved');
  assert.deepEqual(rerun?.context?.inputFiles, ['spec.md'], 'attached inputs preserved');
  assert.deepEqual(store.listInputs(task.id), ['spec.md'], 'input files stay on disk');
});

test('rerunTask keeps a USER agent pin (no agentAuto) so the same agent is retried', async () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 'pinned', from: { platform: 'p', agent: 'a' }, context: { agent: 'remote-opus' } } as any);
  await store.completeTask({ taskId: task.id, result: 'FAILED after 2 attempt(s) (chain exhausted). Agents that failed: remote-opus. Last output: x', internal: true });
  const rerun = store.rerunTask(task.id);
  assert.equal(rerun?.context?.agent, 'remote-opus', 'a deliberate user pin survives the re-run');
});

test('rerunTask re-targets a failed task to a chosen (known) agent as a user pin', async () => {
  const { store } = makeStore({ 'remote-opus': {}, 'remote-sonnet': {} });
  const task = store.createTask({ title: 'retarget', from: { platform: 'p', agent: 'a' }, context: { agent: 'remote-opus', agentAuto: true, attempts: 3 } } as any);
  await store.completeTask({ taskId: task.id, result: 'FAILED after 3 attempt(s) (chain exhausted). Agents that failed: remote-opus. Last output: x', internal: true });
  const rerun = store.rerunTask(task.id, 'remote-sonnet');
  assert.equal(rerun?.context?.agent, 'remote-sonnet', 're-run pinned to the chosen agent');
  assert.equal(rerun?.context?.agentAuto, undefined, 'chosen agent is a user pin, not a transient auto pin');
  assert.equal(rerun?.context?.attempts, 0, 'attempts reset to the top of the chain');
});

test('rerunTask with a blank agent choice clears even a user pin so routing restarts at the chain', async () => {
  const { store } = makeStore({ 'remote-opus': {} });
  const task = store.createTask({ title: 'unpin', from: { platform: 'p', agent: 'a' }, context: { agent: 'remote-opus' } } as any);
  await store.completeTask({ taskId: task.id, result: 'FAILED after 2 attempt(s) (chain exhausted). Agents that failed: remote-opus. Last output: x', internal: true });
  const rerun = store.rerunTask(task.id, '');
  assert.equal(rerun?.context?.agent, undefined, 'blank choice = Auto → the user pin is dropped');
});

test('rerunTask rejects an unknown agent id', async () => {
  const { store } = makeStore({ 'remote-opus': {} });
  const task = store.createTask({ title: 'bad', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({ taskId: task.id, result: 'FAILED after 3 attempt(s) (chain exhausted). Agents that failed: x. Last output: y', internal: true });
  assert.throws(() => store.rerunTask(task.id, 'ghost-agent'), /Unknown agent/, 'unknown agent is refused');
});

test('rerunTask refuses a task that did not fail', async () => {
  const { store } = makeStore();
  const task = store.createTask({ title: 'ok', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({ taskId: task.id, result: 'Great success.', internal: true });
  assert.equal(store.rerunTask(task.id), null, 'a successful task is not re-runnable');
});

test('deleteTask removes the task inputs dir', () => {
  const { store, root } = makeStore();
  const up = store.stageUpload('f.txt', Buffer.from('f'));
  const task = store.createTask({ title: 't', from: { platform: 'p', agent: 'a' } } as any,
    { inputs: [{ token: up.token, name: up.name }] });
  const inDir = path.join(root, 'inputs', task.id);
  assert.ok(fs.existsSync(inDir));
  store.deleteTask(task.id);
  assert.equal(fs.existsSync(inDir), false, 'inputs dir is cleaned up with the task');
});
