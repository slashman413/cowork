import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { Dispatcher } from './dispatcher.js';
import type { Config, AgentUsage } from '../types.js';

/**
 * Manual agent reassignment of not-yet-started tasks:
 *   - Store.agentCooldownUntil reads an exhausted usage window as a cooldown.
 *   - Store.reassignTask re-pins (or un-pins) a pending/scheduled task and resets
 *     its chain bookkeeping; refuses started/finished tasks and unknown agents.
 *   - the dispatcher HOLDS a task pinned to a cooling-down agent (with a pending
 *     reason) instead of running it into a rate-limit failure, and dispatches it
 *     once it is reassigned to an agent with room.
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
      roleChains: { generalist: { description: '', agents: ['local-opus', 'local-qwen'] } },
      agents: {
        'local-opus': { location: 'local', exec: 'claude', model: 'opus' },
        'local-qwen': { location: 'local', exec: 'hermes', model: 'qwen' },
      },
    },
  } as unknown as Config;
  return { store: new Store(config, new EventBus()), config };
}

const exhausted = (resetsAt: string): AgentUsage => ({
  exec: 'claude', at: new Date().toISOString(),
  windows: [{ label: '5h', usedPct: 100, resetsAt }, { label: '7d', usedPct: 30 }],
});

function mkTask(store: Store, context?: Record<string, any>) {
  return store.createTask({
    title: 't', description: 't', from: { platform: 'p', agent: 'a' }, priority: 'normal', context,
  } as any);
}

test('agentCooldownUntil: exhausted future window → its reset; otherwise undefined', () => {
  const { store } = makeStore();
  const resetsAt = new Date(Date.now() + 3600e3).toISOString();
  assert.equal(store.agentCooldownUntil('local-opus'), undefined, 'no meter');
  store.setAgentUsage('local-opus', exhausted(resetsAt));
  assert.equal(store.agentCooldownUntil('local-opus'), resetsAt);
  store.setAgentUsage('local-opus', exhausted(new Date(Date.now() - 1000).toISOString()));
  assert.equal(store.agentCooldownUntil('local-opus'), undefined, 'window already reset');
  store.setAgentUsage('local-opus', { exec: 'claude', at: '', windows: [{ label: '5h', usedPct: 95, resetsAt }] });
  assert.equal(store.agentCooldownUntil('local-opus'), undefined, 'still has room');
});

test('reassignTask re-pins a pending task and resets chain bookkeeping', () => {
  const { store } = makeStore();
  const t = mkTask(store, {
    persona: 'generalist', agent: 'local-opus', attempts: 1, remoteWaitSince: 1,
    pendingReason: 'x', rateLimited: true, rateLimitResetsAt: '2026-10-25T00:00:00Z', autoRerunOnReset: true
  });
  const re = store.reassignTask(t.id, 'local-qwen')!;
  assert.equal(re.status, 'pending');
  assert.equal(re.context!.agent, 'local-qwen');
  assert.equal(re.context!.attempts, 0);
  assert.equal(re.context!.remoteWaitSince, undefined);
  assert.equal(re.context!.pendingReason, undefined);
  assert.equal(re.context!.rateLimited, undefined, 'rateLimited cleared');
  assert.equal(re.context!.rateLimitResetsAt, undefined, 'rateLimitResetsAt cleared');
  assert.equal(re.context!.autoRerunOnReset, undefined, 'autoRerunOnReset cleared');
  assert.equal(re.context!.persona, 'generalist', 'persona kept');

  const auto = store.reassignTask(t.id, '')!;
  assert.equal(auto.context!.agent, undefined, "'' clears the pin → chain routing");
});

test('reassignTask refuses unknown agents and started/finished tasks', () => {
  const { store } = makeStore();
  const t = mkTask(store, { persona: 'generalist' });
  assert.throws(() => store.reassignTask(t.id, 'nope'), /Unknown agent/);
  const live = store.getTask(t.id)!;
  live.status = 'in-progress';
  store.saveTask(live);
  assert.equal(store.reassignTask(t.id, 'local-qwen'), null);
  assert.equal(store.reassignTask('missing', 'local-qwen'), null);
});

test('dispatcher holds a task pinned to a cooling agent, runs it once reassigned', () => {
  const { store, config } = makeStore();
  const resetsAt = new Date(Date.now() + 3600e3).toISOString();
  store.setAgentUsage('local-opus', exhausted(resetsAt));
  const t = mkTask(store, { persona: 'generalist', agent: 'local-opus' });

  const d = new Dispatcher(config, store, new EventBus());
  const ran: string[] = [];
  (d as any).workerId = 'dispatcher';
  (d as any).execute = async (task: any, plan: any) => { ran.push(`${task.id}@${plan.agentId}`); };

  (d as any).tick();
  assert.deepEqual(ran, [], 'not run while its pinned agent cools down');
  const held = store.getTask(t.id)!;
  assert.match(String(held.context!.pendingReason), /^Rate-limited — agent `local-opus` is cooling down until/);

  store.reassignTask(t.id, 'local-qwen');
  (d as any).tick();
  assert.deepEqual(ran, [`${t.id}@local-qwen`], 'dispatched on the reassigned agent');
});

test('an observed rate-limit failure cools an agent even while its meter lags', () => {
  const { store } = makeStore();
  const resetsAt = new Date(Date.now() + 3600e3).toISOString();
  // Meter still reads 92% — below the ≥100% exhausted threshold.
  store.setAgentUsage('local-opus', { exec: 'claude', at: '', windows: [{ label: '5h', usedPct: 92, resetsAt }] });
  assert.equal(store.agentCooldownUntil('local-opus'), undefined);
  assert.equal(store.noteAgentRateLimited('local-opus'), resetsAt, 'cools until the near-exhausted window resets');
  assert.equal(store.agentCooldownUntil('local-opus'), resetsAt);
  store.clearAgentRateLimited('local-opus');
  assert.equal(store.agentCooldownUntil('local-opus'), undefined, 'cleared once it succeeds again');

  // Unmetered agent → short fixed hold that expires on its own.
  const until = Date.parse(store.noteAgentRateLimited('local-qwen', 60_000));
  assert.ok(until > Date.now() && until <= Date.now() + 60_000);
  store.noteAgentRateLimited('local-qwen', -1);
  assert.equal(store.agentCooldownUntil('local-qwen'), undefined, 'expired hold is dropped');
});

test('dispatcher: a rate-limit failure marks the agent cooling; chain routing skips it', () => {
  const { store, config } = makeStore();
  const d = new Dispatcher(config, store, new EventBus());
  const ran: string[] = [];
  (d as any).workerId = 'dispatcher';
  (d as any).execute = async (task: any, plan: any) => { ran.push(`${task.id}@${plan.agentId}`); };

  const failed = mkTask(store, { persona: 'generalist' });
  (d as any).recordFailedAgent(failed.id, { agent: 'local-opus', persona: 'generalist', attempt: 1, reason: "You've hit your usage limit · resets 5pm" }, true);
  assert.ok(store.agentCooldownUntil('local-opus'), 'local-opus cooling after the refusal');
  (d as any).recordFailedAgent(failed.id, { agent: 'local-qwen', persona: 'generalist', attempt: 2, reason: 'empty result' });
  assert.equal(store.agentCooldownUntil('local-qwen'), undefined, 'non-rate-limit failures do not cool an agent');
  (d as any).recordFailedAgent(failed.id, { agent: 'local-qwen', persona: 'generalist', attempt: 3, reason: 'verifier LLM: report only says the API returned too many requests' }, false);
  assert.equal(store.agentCooldownUntil('local-qwen'), undefined, 'rate-limit words in the reason alone do not cool an agent');
  const s = store.getTask(failed.id)!; s.status = 'done'; store.saveTask(s);

  const t = mkTask(store, { persona: 'generalist' });   // unpinned: chain local-opus → local-qwen
  (d as any).tick();
  assert.deepEqual(ran, [`${t.id}@local-qwen`], 'routed past the cooling head rung');
});

test('agentCooldownUntil & classifyRateLimit: Antigravity quota groups only affect their matching agents', async () => {
  const { store, config } = makeStore();
  (config.orchestration.agents as any)['local-agy-gemini-3.8-flash'] = { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-high' };
  (config.orchestration.agents as any)['local-agy-claude-opus-5-5'] = { location: 'local', exec: 'agy', model: 'claude-opus-5-5-high' };
  (config.orchestration.agents as any)['local-agy-gemini-4-argon'] = { location: 'local', exec: 'agy', model: 'gemini-4-argon-high' };

  const geminiReset = new Date(Date.now() + 1800e3).toISOString();
  const claudeReset = new Date(Date.now() + 86400e3).toISOString();
  const argonReset = new Date(Date.now() + 43200e3).toISOString();

  // Snapshot has Gemini at 10% used, but Claude and Argon exhausted (100%)
  const multiGroupUsage: AgentUsage = {
    exec: 'agy',
    at: new Date().toISOString(),
    windows: [
      { label: '5h', usedPct: 10, resetsAt: geminiReset, group: 'Gemini Models', groupModels: ['Gemini Flash', 'Gemini Pro'], title: 'Five Hour Limit Remaining' },
      { label: '7d', usedPct: 100, resetsAt: claudeReset, group: 'Claude and GPT models', groupModels: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'], title: 'Weekly Limit Remaining' },
      { label: '7d', usedPct: 100, resetsAt: argonReset, group: 'Gemini 4 Argon', title: 'Gemini 4 Argon Weekly Limit', groupNote: 'Argon quota is separate' }
    ]
  };

  store.setAgentUsage('local-agy-gemini-3.8-flash', multiGroupUsage);
  store.setAgentUsage('local-agy-claude-opus-5-5', multiGroupUsage);
  store.setAgentUsage('local-agy-gemini-4-argon', multiGroupUsage);

  // Store.setAgentUsage partitions windows so gemini only receives Gemini windows
  assert.equal(store.getAgentUsage()['local-agy-gemini-3.8-flash'].windows.length, 1);
  assert.equal(store.getAgentUsage()['local-agy-gemini-3.8-flash'].windows[0].group, 'Gemini Models');

  // Gemini 3.8 Flash MUST NOT be considered cooling down just because Claude or Argon is exhausted
  assert.equal(store.agentCooldownUntil('local-agy-gemini-3.8-flash'), undefined, 'gemini 3.8 is not cooling down');
  // Claude must cool down until claudeReset
  assert.equal(store.agentCooldownUntil('local-agy-claude-opus-5-5'), claudeReset, 'claude cools down until claudeReset');
  // Argon must cool down until argonReset
  assert.equal(store.agentCooldownUntil('local-agy-gemini-4-argon'), argonReset, 'argon cools down until argonReset');

  // If Gemini itself fails on a rate limit when its 5h window is 90% full, classifyRateLimit uses geminiReset, not claudeReset
  const geminiNearExhausted: AgentUsage = {
    exec: 'agy',
    at: new Date().toISOString(),
    windows: [
      { label: '5h', usedPct: 90, resetsAt: geminiReset, group: 'Gemini Models', groupModels: ['Gemini Flash', 'Gemini Pro'], title: 'Five Hour Limit Remaining' },
      { label: '7d', usedPct: 100, resetsAt: claudeReset, group: 'Claude and GPT models', groupModels: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'], title: 'Weekly Limit Remaining' }
    ]
  };
  store.setAgentUsage('local-agy-gemini-3.8-flash', geminiNearExhausted);
  const failedTask = mkTask(store, {
    agent: 'local-agy-gemini-3.8-flash',
    failedAgents: [{ agent: 'local-agy-gemini-3.8-flash', reason: 'You have exhausted your rate limit for this model' }]
  });
  await store.completeTask({ taskId: failedTask.id, result: 'FAILED after 1 attempt(s) (chain exhausted). rate limit exceeded', internal: true });
  const completed = store.getTask(failedTask.id)!;
  assert.equal(completed.context?.rateLimited, true);
  assert.equal(completed.context?.rateLimitResetsAt, geminiReset, 'rateLimitResetsAt matches Gemini window, NOT Claude');
});

test('agy-neon and agy-hydrogen: quota matching, cooldown recovery on refreshed quota, and dispatch eligibility', () => {
  const { store, config } = makeStore();
  (config.orchestration.agents as any)['agy-neon'] = { location: 'local', exec: 'agy', model: 'gemini-4-neon' };
  (config.orchestration.agents as any)['agy-hydrogen'] = { location: 'local', exec: 'agy', model: 'gemini-4-hydrogen' };
  (config.orchestration.agents as any)['local-agy-gemini-4-neon'] = { location: 'local', exec: 'agy', model: 'gemini-4-neon' };
  (config.orchestration.agents as any)['local-agy-gemini-4-hydrogen'] = { location: 'local', exec: 'agy', model: 'gemini-4-hydrogen' };
  (config.orchestration.roleChains as any).generalist.agents = ['agy-neon', 'agy-hydrogen', 'local-qwen'];

  const geminiReset = new Date(Date.now() + 1800e3).toISOString();
  const claudeReset = new Date(Date.now() + 86400e3).toISOString();
  const argonReset = new Date(Date.now() + 43200e3).toISOString();

  // 1. When Gemini Models has remaining quota (16% used / 84% remaining), agy-neon and agy-hydrogen
  //    must not cool down even if Claude/GPT and Argon windows are 100% exhausted.
  const availableGeminiUsage: AgentUsage = {
    exec: 'agy',
    at: new Date().toISOString(),
    windows: [
      { label: '7d', usedPct: 16, remainingPct: 84, resetsAt: geminiReset, group: 'Gemini Models', groupModels: ['Gemini 4 Neon', 'Gemini 4 Hydrogen', 'Gemini 3.8 Flash'], title: 'Weekly Limit Remaining' },
      { label: '5h', usedPct: 2.4, remainingPct: 97.62, resetsAt: geminiReset, group: 'Gemini Models', groupModels: ['Gemini 4 Neon', 'Gemini 4 Hydrogen', 'Gemini 3.8 Flash'], title: 'Five Hour Limit Remaining' },
      { label: '7d', usedPct: 100, remainingPct: 0, resetsAt: claudeReset, group: 'Claude and GPT models', groupModels: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B'], title: 'Weekly Limit Remaining' },
      { label: '7d', usedPct: 100, remainingPct: 0, resetsAt: argonReset, group: 'Gemini 4 Argon', title: 'Gemini 4 Argon Weekly Limit', groupNote: 'Argon quota is separate' }
    ]
  };

  for (const id of ['agy-neon', 'agy-hydrogen', 'local-agy-gemini-4-neon', 'local-agy-gemini-4-hydrogen']) {
    store.setAgentUsage(id, availableGeminiUsage);
    assert.equal(store.getAgentUsage()[id].windows.length, 2, `${id} keeps only Gemini Models windows`);
    assert.equal(store.agentCooldownUntil(id), undefined, `${id} has no cooldown while Gemini quota is available`);
  }

  // 2. When their own Gemini Models window is exhausted (100% used), they report cooldown until geminiReset,
  //    and even if noteAgentRateLimited latches that cooldown in memory, a subsequent quota refresh/upgrade
  //    (setAgentUsage with available quota) clears the stale cooldown so tasks dispatch immediately.
  const exhaustedGeminiUsage: AgentUsage = {
    exec: 'agy',
    at: new Date(Date.now() + 1000).toISOString(),
    windows: [
      { label: '7d', usedPct: 100, remainingPct: 0, resetsAt: geminiReset, group: 'Gemini Models', groupModels: ['Gemini 4 Neon', 'Gemini 4 Hydrogen', 'Gemini 3.8 Flash'], title: 'Weekly Limit Remaining' },
      { label: '7d', usedPct: 100, remainingPct: 0, resetsAt: claudeReset, group: 'Claude and GPT models', title: 'Weekly Limit Remaining' }
    ]
  };

  for (const id of ['agy-neon', 'agy-hydrogen', 'local-agy-gemini-4-neon', 'local-agy-gemini-4-hydrogen']) {
    store.setAgentUsage(id, exhaustedGeminiUsage);
    assert.equal(store.agentCooldownUntil(id), geminiReset, `${id} cools down when its own Gemini window is exhausted`);
    assert.equal(store.noteAgentRateLimited(id), geminiReset);
    assert.equal(store.agentCooldownUntil(id), geminiReset);
  }

  // Refresh quota (e.g. window reset or plan upgrade) → cooldown clears automatically
  const refreshedGeminiUsage: AgentUsage = {
    ...availableGeminiUsage,
    at: new Date(Date.now() + 2000).toISOString()
  };
  for (const id of ['agy-neon', 'agy-hydrogen', 'local-agy-gemini-4-neon', 'local-agy-gemini-4-hydrogen']) {
    store.setAgentUsage(id, refreshedGeminiUsage);
    assert.equal(store.agentCooldownUntil(id), undefined, `${id} cooldown clears once meter reports available quota`);
  }

  // 3. Tasks pinned or routed to agy-neon and agy-hydrogen resolve to canonical local-agy-gemini-4-*
  //    and dispatch instead of pending due to rate limit.
  const d = new Dispatcher(config, store, new EventBus());
  const ran: string[] = [];
  (d as any).workerId = 'dispatcher';
  (d as any).execute = async (task: any, plan: any) => { ran.push(`${task.id}@${plan.agentId}`); };

  const pinnedNeon = mkTask(store, { persona: 'generalist', agent: 'agy-neon' });
  const pinnedHydrogen = mkTask(store, { persona: 'generalist', agent: 'agy-hydrogen' });
  const routedNeon = mkTask(store, { persona: 'generalist' }); // chain head is agy-neon → canonical local-agy-gemini-4-neon

  (d as any).tick();
  assert.deepEqual(ran.sort(), [
    `${pinnedNeon.id}@local-agy-gemini-4-neon`,
    `${pinnedHydrogen.id}@local-agy-gemini-4-hydrogen`,
    `${routedNeon.id}@local-agy-gemini-4-neon`
  ].sort());
  assert.equal(store.getTask(pinnedNeon.id)!.context?.pendingReason, undefined);
  assert.equal(store.getTask(pinnedHydrogen.id)!.context?.pendingReason, undefined);
});
