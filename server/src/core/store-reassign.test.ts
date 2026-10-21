import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { Dispatcher } from './dispatcher.js';
import type { Config, BrainUsage } from '../types.js';

/**
 * Manual brain reassignment of not-yet-started tasks:
 *   - Store.brainCooldownUntil reads an exhausted usage window as a cooldown.
 *   - Store.reassignTask re-pins (or un-pins) a pending/scheduled task and resets
 *     its chain bookkeeping; refuses started/finished tasks and unknown brains.
 *   - the dispatcher HOLDS a task pinned to a cooling-down brain (with a pending
 *     reason) instead of running it into a rate-limit failure, and dispatches it
 *     once it is reassigned to a brain with room.
 */
function makeStore(): { store: Store; config: Config } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-reassign-'));
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
  const config = {
    paths, platforms: {}, inbox: { maxRetries: 3 },
    orchestration: {
      maxConcurrent: 4, pollIntervalMs: 60000,
      agents: { generalist: { description: '', brains: ['local-opus', 'local-qwen'] } },
      brains: {
        'local-opus': { location: 'local', exec: 'claude', model: 'opus' },
        'local-qwen': { location: 'local', exec: 'hermes', model: 'qwen' },
      },
    },
  } as unknown as Config;
  return { store: new Store(config, new EventBus()), config };
}

const exhausted = (resetsAt: string): BrainUsage => ({
  exec: 'claude', at: new Date().toISOString(),
  windows: [{ label: '5h', usedPct: 100, resetsAt }, { label: '7d', usedPct: 30 }],
});

function mkTask(store: Store, context?: Record<string, any>) {
  return store.createTask({
    title: 't', description: 't', from: { platform: 'p', agent: 'a' }, priority: 'normal', context,
  } as any);
}

test('brainCooldownUntil: exhausted future window → its reset; otherwise undefined', () => {
  const { store } = makeStore();
  const resetsAt = new Date(Date.now() + 3600e3).toISOString();
  assert.equal(store.brainCooldownUntil('local-opus'), undefined, 'no meter');
  store.setBrainUsage('local-opus', exhausted(resetsAt));
  assert.equal(store.brainCooldownUntil('local-opus'), resetsAt);
  store.setBrainUsage('local-opus', exhausted(new Date(Date.now() - 1000).toISOString()));
  assert.equal(store.brainCooldownUntil('local-opus'), undefined, 'window already reset');
  store.setBrainUsage('local-opus', { exec: 'claude', at: '', windows: [{ label: '5h', usedPct: 95, resetsAt }] });
  assert.equal(store.brainCooldownUntil('local-opus'), undefined, 'still has room');
});

test('reassignTask re-pins a pending task and resets chain bookkeeping', () => {
  const { store } = makeStore();
  const t = mkTask(store, { agent: 'generalist', brain: 'local-opus', attempts: 1, remoteWaitSince: 1, pendingReason: 'x' });
  const re = store.reassignTask(t.id, 'local-qwen')!;
  assert.equal(re.status, 'pending');
  assert.equal(re.context!.brain, 'local-qwen');
  assert.equal(re.context!.attempts, 0);
  assert.equal(re.context!.remoteWaitSince, undefined);
  assert.equal(re.context!.pendingReason, undefined);
  assert.equal(re.context!.agent, 'generalist', 'agent kept');

  const auto = store.reassignTask(t.id, '')!;
  assert.equal(auto.context!.brain, undefined, "'' clears the pin → chain routing");
});

test('reassignTask refuses unknown brains and started/finished tasks', () => {
  const { store } = makeStore();
  const t = mkTask(store, { agent: 'generalist' });
  assert.throws(() => store.reassignTask(t.id, 'nope'), /Unknown brain/);
  const live = store.getTask(t.id)!;
  live.status = 'in-progress';
  store.saveTask(live);
  assert.equal(store.reassignTask(t.id, 'local-qwen'), null);
  assert.equal(store.reassignTask('missing', 'local-qwen'), null);
});

test('dispatcher holds a task pinned to a cooling brain, runs it once reassigned', () => {
  const { store, config } = makeStore();
  const resetsAt = new Date(Date.now() + 3600e3).toISOString();
  store.setBrainUsage('local-opus', exhausted(resetsAt));
  const t = mkTask(store, { agent: 'generalist', brain: 'local-opus' });

  const d = new Dispatcher(config, store, new EventBus());
  const ran: string[] = [];
  (d as any).agentId = 'dispatcher';
  (d as any).execute = async (task: any, plan: any) => { ran.push(`${task.id}@${plan.brainId}`); };

  (d as any).tick();
  assert.deepEqual(ran, [], 'not run while its pinned brain cools down');
  const held = store.getTask(t.id)!;
  assert.match(String(held.context!.pendingReason), /^Rate-limited — brain `local-opus` is cooling down until/);

  store.reassignTask(t.id, 'local-qwen');
  (d as any).tick();
  assert.deepEqual(ran, [`${t.id}@local-qwen`], 'dispatched on the reassigned brain');
});

test('an observed rate-limit failure cools a brain even while its meter lags', () => {
  const { store } = makeStore();
  const resetsAt = new Date(Date.now() + 3600e3).toISOString();
  // Meter still reads 92% — below the ≥100% exhausted threshold.
  store.setBrainUsage('local-opus', { exec: 'claude', at: '', windows: [{ label: '5h', usedPct: 92, resetsAt }] });
  assert.equal(store.brainCooldownUntil('local-opus'), undefined);
  assert.equal(store.noteBrainRateLimited('local-opus'), resetsAt, 'cools until the near-exhausted window resets');
  assert.equal(store.brainCooldownUntil('local-opus'), resetsAt);
  store.clearBrainRateLimited('local-opus');
  assert.equal(store.brainCooldownUntil('local-opus'), undefined, 'cleared once it succeeds again');

  // Unmetered brain → short fixed hold that expires on its own.
  const until = Date.parse(store.noteBrainRateLimited('local-qwen', 60_000));
  assert.ok(until > Date.now() && until <= Date.now() + 60_000);
  store.noteBrainRateLimited('local-qwen', -1);
  assert.equal(store.brainCooldownUntil('local-qwen'), undefined, 'expired hold is dropped');
});

test('dispatcher: a rate-limit failure marks the brain cooling; chain routing skips it', () => {
  const { store, config } = makeStore();
  const d = new Dispatcher(config, store, new EventBus());
  const ran: string[] = [];
  (d as any).agentId = 'dispatcher';
  (d as any).execute = async (task: any, plan: any) => { ran.push(`${task.id}@${plan.brainId}`); };

  const failed = mkTask(store, { agent: 'generalist' });
  (d as any).recordFailedBrain(failed.id, { brain: 'local-opus', agent: 'generalist', attempt: 1, reason: "You've hit your usage limit · resets 5pm" });
  assert.ok(store.brainCooldownUntil('local-opus'), 'local-opus cooling after the refusal');
  (d as any).recordFailedBrain(failed.id, { brain: 'local-qwen', agent: 'generalist', attempt: 2, reason: 'empty result' });
  assert.equal(store.brainCooldownUntil('local-qwen'), undefined, 'non-rate-limit failures do not cool a brain');
  const s = store.getTask(failed.id)!; s.status = 'done'; store.saveTask(s);

  const t = mkTask(store, { agent: 'generalist' });   // unpinned: chain local-opus → local-qwen
  (d as any).tick();
  assert.deepEqual(ran, [`${t.id}@local-qwen`], 'routed past the cooling head rung');
});
