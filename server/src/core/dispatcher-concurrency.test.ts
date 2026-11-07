import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.js';
import type { Config, Task } from '../types.js';

/**
 * Per-agent concurrency + preference-preserving load balancing.
 *
 * Historically the dispatcher ran one task at a time per agent and always picked
 * chain[attempt], so a reliable workhorse agent (e.g. local-ha-qwen35b)
 * absorbed every concurrent task while its peers sat idle. These tests drive the
 * private selection helpers directly against a fake store — no timers, no spawn —
 * and simulate in-flight load by seeding the dispatcher's `running` map.
 */

const CHAIN = ['local-a', 'local-b', 'local-c', 'remote-z'];

function harness() {
  const store = {
    getTask: () => null,
    saveTask: () => {},
    getPersona: () => null,
    agentCooldownUntil: () => undefined,
    noteAgentRateLimited: () => '',
    clearAgentRateLimited: () => {}
  };
  const config = {
    inbox: { maxRetries: 3 },
    orchestration: {
      defaultAgentConcurrency: 1,
      roleChains: { engineer: { description: '', agents: CHAIN } },
      agents: {
        'local-a': { location: 'local', exec: 'hermes', maxConcurrent: 2 },
        'local-b': { location: 'local', exec: 'hermes', maxConcurrent: 3 },
        'local-c': { location: 'local', exec: 'claude' },              // no cap → default 1
        'remote-z': { location: 'remote', exec: 'claude' }
      }
    }
  } as unknown as Config;
  const d = new Dispatcher(config, store as any, {} as any);
  const load = (agentId: string, n: number) => {
    for (let i = 0; i < n; i++) (d as any).running.set(`${agentId}#${i}`, { role: 'x', startedAt: 0, agentId });
  };
  const task = (attempt = 0): Task => ({
    id: 't', title: 'do it', description: '', from: { platform: 'x', agent: 'y' }, to: {},
    priority: 'normal', status: 'pending', createdAt: new Date().toISOString(),
    context: { persona: 'engineer', attempts: attempt }
  } as Task);
  return {
    d,
    load,
    task,
    cap: (b: string) => (d as any).agentCap(b) as number,
    agentLoad: (b: string) => (d as any).agentLoad(b) as number,
    selectRung: (attempt = 0) => (d as any).selectRung(CHAIN, attempt, config.orchestration.agents) as { agentId: string; index: number },
    planFor: (t: Task) => (d as any).planFor(t)
  };
}

test('agentCap honours per-agent maxConcurrent, then the default, then 1', () => {
  const h = harness();
  assert.equal(h.cap('local-a'), 2, 'explicit maxConcurrent');
  assert.equal(h.cap('local-b'), 3, 'explicit maxConcurrent');
  assert.equal(h.cap('local-c'), 1, 'falls back to defaultAgentConcurrency (1)');
  assert.equal(h.cap('unknown'), 1, 'unknown agent → 1');
});

test('agentLoad counts only in-flight runs on that agent', () => {
  const h = harness();
  h.load('local-a', 2);
  h.load('local-b', 1);
  assert.equal(h.agentLoad('local-a'), 2);
  assert.equal(h.agentLoad('local-b'), 1);
  assert.equal(h.agentLoad('local-c'), 0);
});

test('under no contention the preferred rung (chain[attempt]) is kept', () => {
  const h = harness();
  assert.deepEqual(h.selectRung(0), { agentId: 'local-a', index: 0 });
});

test('a saturated preferred rung spreads overflow to the freest local rung', () => {
  const h = harness();
  h.load('local-a', 2);           // local-a full (cap 2)
  // local-b cap 3 load 0 → slack 3; local-c cap 1 load 0 → slack 1. Pick local-b.
  assert.deepEqual(h.selectRung(0), { agentId: 'local-b', index: 1 });
});

test('when every local rung is saturated we keep the preferred rung (it waits)', () => {
  const h = harness();
  h.load('local-a', 2);
  h.load('local-b', 3);
  h.load('local-c', 1);
  assert.deepEqual(h.selectRung(0), { agentId: 'local-a', index: 0 }, 'no room anywhere → preferred rung, gated later');
});

test('a remote preferred rung is never load-balanced away', () => {
  const h = harness();
  // attempt 3 → chain[3] is remote-z; must be returned untouched so the remote
  // claim/grace protocol still owns it.
  assert.deepEqual(h.selectRung(3), { agentId: 'remote-z', index: 3 });
});

test('planFor routes a fresh task to the preferred agent, then to overflow when it is full', () => {
  const h = harness();
  const p1 = h.planFor(h.task(0));
  assert.equal(p1.action, 'execute');
  assert.equal(p1.exec.agentId, 'local-a');
  assert.equal(p1.exec.attempt, 0);

  h.load('local-a', 2);                        // saturate the preferred agent
  const p2 = h.planFor(h.task(0));
  assert.equal(p2.action, 'execute');
  assert.equal(p2.exec.agentId, 'local-b', 'overflow steered to the freest local rung');
  assert.equal(p2.exec.attempt, 1, 'attempt tracks the rung actually chosen (handover stays coherent)');
});
