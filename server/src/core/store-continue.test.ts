import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Coverage for CONTINUE: a done, successful task spawns a follow-up task seeded
 * with the finished run's OUTPUTS (its result + every artifact) as INPUTS,
 * pinned to the same executor. Failed/unfinished tasks are refused (they use
 * rerunTask instead).
 */
function makeStore(brains: Record<string, unknown> = {}): { store: Store; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-continue-'));
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
  const config = { paths, orchestration: { brains } } as unknown as Config;
  return { store: new Store(config, new EventBus()), root };
}

/** Write files into a done task's artifacts dir (artifacts/<id>/), as the dispatcher would. */
function seedArtifacts(root: string, taskId: string, files: Record<string, string>): void {
  const dir = path.join(root, 'artifacts', taskId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
}

test('continueTask seeds the follow-up with the prior result + artifacts as inputs', async () => {
  const { store, root } = makeStore();
  const orig = store.createTask({
    title: 'Draft the architecture',
    description: 'Design the netcode.',
    from: { platform: 'p', agent: 'a' },
    priority: 'high',
    context: { ranAgent: 'software-architect', ranDivision: 'engineering', ranBrain: 'remote-opus' }
  } as any);
  seedArtifacts(root, orig.id, { 'architecture.md': '# arch\nlots of detail', 'diagram.svg': '<svg/>' });
  await store.completeTask({ taskId: orig.id, result: 'Here is the architecture blueprint.', internal: true });

  const next = store.continueTask(orig.id)!;
  assert.ok(next, 'a done success is continuable');
  assert.equal(next.status, 'pending');
  assert.notEqual(next.id, orig.id, 'a NEW task is created');
  assert.match(next.title, /^Continue: Draft the architecture$/);
  assert.equal(next.priority, 'high', 'priority carried over');

  // Executor pin follows what actually ran.
  assert.equal(next.context?.agent, 'software-architect');
  assert.equal(next.context?.division, 'engineering');
  assert.equal(next.context?.brain, 'remote-opus');
  assert.equal(next.context?.continuedFrom, orig.id);

  // Prior outputs land as inputs on disk + on context.inputFiles.
  const inputs = store.listInputs(next.id).sort();
  assert.deepEqual(inputs, ['architecture.md', 'diagram.svg', 'previous-result.md']);
  assert.deepEqual((next.context?.inputFiles as string[]).slice().sort(),
    ['architecture.md', 'diagram.svg', 'previous-result.md']);
  const rp = store.inputFilePath(next.id, 'previous-result.md');
  assert.ok(rp && /architecture blueprint/.test(fs.readFileSync(rp, 'utf8')), 'result body captured');
  const ap = store.inputFilePath(next.id, 'architecture.md');
  assert.ok(ap && fs.readFileSync(ap, 'utf8') === '# arch\nlots of detail', 'artifact copied verbatim');
});

test('continueTask works with no artifacts (result only) and does not double-prefix the title', async () => {
  const { store } = makeStore();
  const orig = store.createTask({ title: 'Continue: keep going', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({ taskId: orig.id, result: 'progress so far', internal: true });
  const next = store.continueTask(orig.id)!;
  assert.equal(next.title, 'Continue: keep going', 'existing Continue: prefix is not doubled');
  assert.deepEqual(store.listInputs(next.id), ['previous-result.md']);
});

test('continueTask stamps the ORIGINAL with context.continuedInto (so the UI disables its Continue button)', async () => {
  const { store } = makeStore();
  const orig = store.createTask({ title: 'Ship it', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({ taskId: orig.id, result: 'done', internal: true });

  // Before: not yet continued.
  assert.equal(store.getTask(orig.id)?.context?.continuedInto, undefined);

  const next = store.continueTask(orig.id)!;

  // After: the ORIGINAL points at the follow-up, durably persisted to disk.
  const reloaded = store.getTask(orig.id)!;
  assert.equal(reloaded.context?.continuedInto, next.id, 'original stamped with the new task id');
  // The stamp survives a fresh read (it is on disk, not just in memory).
  assert.equal(reloaded.status, 'done', 'stamping does not disturb the original status/result');
  assert.equal(reloaded.result, 'done');
  // The follow-up back-references the original (existing behavior, unchanged).
  assert.equal(next.context?.continuedFrom, orig.id);
});

test('continueTask refuses a failed (chain-exhausted) task — that path is rerun, not continue', async () => {
  const { store } = makeStore();
  const bad = store.createTask({ title: 'nope', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({
    taskId: bad.id,
    result: 'FAILED after 3 attempt(s) (chain exhausted). Brains that failed: x. Last output: limit',
    internal: true
  });
  assert.equal(store.continueTask(bad.id), null, 'a failed task is not continuable');
});

test('continueTask refuses an unfinished task and a missing task', () => {
  const { store } = makeStore();
  const pending = store.createTask({ title: 'still going', from: { platform: 'p', agent: 'a' } } as any);
  assert.equal(store.continueTask(pending.id), null, 'a pending task is not continuable');
  assert.equal(store.continueTask('does-not-exist'), null, 'a missing task returns null');
});

// ── Brain override: choose which brain claims the continuation ──────────────
test('continueTask pins the follow-up to a chosen (known) brain instead of the original one', async () => {
  const { store } = makeStore({ 'remote-opus': {}, 'remote-sonnet': {} });
  const orig = store.createTask({
    title: 'keep building', from: { platform: 'p', agent: 'a' },
    context: { ranAgent: 'software-architect', ranBrain: 'remote-opus' }
  } as any);
  await store.completeTask({ taskId: orig.id, result: 'phase 1 done', internal: true });

  const next = store.continueTask(orig.id, 'remote-sonnet')!;
  assert.equal(next.context?.brain, 'remote-sonnet', 'follow-up pinned to the chosen brain');
  assert.equal(next.context?.brainAuto, undefined, 'a chosen brain is a USER pin, not a transient auto pin');
  assert.equal(next.context?.agent, 'software-architect', 'agent assignment still carried over');
});

test('continueTask with a blank brain choice clears the pin so the agent chain routes it', async () => {
  const { store } = makeStore({ 'remote-opus': {} });
  const orig = store.createTask({
    title: 'route me', from: { platform: 'p', agent: 'a' },
    context: { ranAgent: 'software-architect', ranBrain: 'remote-opus' }
  } as any);
  await store.completeTask({ taskId: orig.id, result: 'ok', internal: true });

  const next = store.continueTask(orig.id, '')!;
  assert.equal(next.context?.brain, undefined, 'blank choice = Auto → no brain pin');
  assert.equal(next.context?.agent, 'software-architect', 'agent still set so the chain can route');
});

test('continueTask with no brain arg keeps the original brain (default, unchanged)', async () => {
  const { store } = makeStore({ 'remote-opus': {} });
  const orig = store.createTask({
    title: 'default', from: { platform: 'p', agent: 'a' }, context: { ranBrain: 'remote-opus' }
  } as any);
  await store.completeTask({ taskId: orig.id, result: 'ok', internal: true });
  assert.equal(store.continueTask(orig.id)!.context?.brain, 'remote-opus', 'same brain when no override given');
});

test('continueTask rejects an unknown brain id (surfaces as a 400 upstream)', async () => {
  const { store } = makeStore({ 'remote-opus': {} });
  const orig = store.createTask({ title: 'bad brain', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({ taskId: orig.id, result: 'ok', internal: true });
  assert.throws(() => store.continueTask(orig.id, 'ghost-brain'), /Unknown brain/, 'unknown brain is refused');
});

// --- Continue dialog extra steer: { prompt } and { inputs } ---------------

test('continueTask appends an operator prompt as its own "Additional instructions" section', async () => {
  const { store } = makeStore();
  const orig = store.createTask({
    title: 'Draft', description: 'Original brief.', from: { platform: 'p', agent: 'a' }
  } as any);
  await store.completeTask({ taskId: orig.id, result: 'ok', internal: true });

  const next = store.continueTask(orig.id, undefined, { prompt: '  Now add unit tests.  ' })!;
  assert.ok(next.description!.includes('Original brief.'), 'carries over the prior brief');
  assert.match(next.description!, /## Additional instructions for this continuation/, 'adds a dedicated section');
  assert.match(next.description!, /Now add unit tests\./, 'includes the operator prompt (trimmed)');
  assert.ok(!next.description!.includes('  Now add unit tests.  '), 'prompt is trimmed of surrounding whitespace');
});

test('continueTask with no/blank prompt omits the Additional-instructions section (back-compat)', async () => {
  const { store } = makeStore();
  const orig = store.createTask({ title: 'Draft', description: 'brief', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({ taskId: orig.id, result: 'ok', internal: true });

  assert.ok(!store.continueTask(orig.id)!.description!.includes('Additional instructions'),
    'no opts → no section');
  const orig2 = store.createTask({ title: 'Draft2', description: 'brief', from: { platform: 'p', agent: 'a' } } as any);
  await store.completeTask({ taskId: orig2.id, result: 'ok', internal: true });
  assert.ok(!store.continueTask(orig2.id, undefined, { prompt: '   ' })!.description!.includes('Additional instructions'),
    'whitespace-only prompt → no section');
});

test('continueTask folds extra staged uploads in alongside the prior run\'s outputs', async () => {
  const { store, root } = makeStore();
  const orig = store.createTask({ title: 'Draft', from: { platform: 'p', agent: 'a' } } as any);
  seedArtifacts(root, orig.id, { 'design.md': '# design' });
  await store.completeTask({ taskId: orig.id, result: 'done', internal: true });

  // Operator attaches two extra reference files in the Continue dialog; the UI
  // stages them via POST /api/uploads → stageUpload, then passes back the tokens.
  const a = store.stageUpload('spec.pdf', Buffer.from('SPEC'));
  const b = store.stageUpload('notes.txt', Buffer.from('NOTES'));

  const next = store.continueTask(orig.id, undefined, { inputs: [
    { token: a.token, name: a.name }, { token: b.token, name: b.name }
  ] })!;

  // Prior outputs AND the extras all land in inputs/<newId>/ and on context.inputFiles.
  const onDisk = store.listInputs(next.id).sort();
  assert.deepEqual(onDisk, ['design.md', 'notes.txt', 'previous-result.md', 'spec.pdf'],
    'seeded outputs + extras coexist in the inputs dir');
  assert.deepEqual((next.context?.inputFiles as string[]).slice().sort(),
    ['design.md', 'notes.txt', 'previous-result.md', 'spec.pdf'],
    'context.inputFiles is the union, no duplicates');
  const sp = store.inputFilePath(next.id, 'spec.pdf');
  assert.ok(sp && fs.readFileSync(sp, 'utf8') === 'SPEC', 'extra upload copied verbatim');
});

test('continueTask accepts prompt + inputs + brain together (the full dialog payload)', async () => {
  const { store } = makeStore({ 'remote-sonnet': {} });
  const orig = store.createTask({
    title: 'Draft', description: 'brief', from: { platform: 'p', agent: 'a' },
    context: { ranBrain: 'remote-opus' }
  } as any);
  await store.completeTask({ taskId: orig.id, result: 'ok', internal: true });

  const f = store.stageUpload('extra.md', Buffer.from('X'));
  const next = store.continueTask(orig.id, 'remote-sonnet',
    { prompt: 'Refine it.', inputs: [{ token: f.token, name: f.name }] })!;

  assert.equal(next.context?.brain, 'remote-sonnet', 'brain override applied');
  assert.match(next.description!, /Refine it\./, 'prompt applied');
  assert.ok((next.context?.inputFiles as string[]).includes('extra.md'), 'extra input applied');
});
