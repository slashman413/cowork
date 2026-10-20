import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { BrainCooldowns, parseRateLimitReset } from './brain-cooldown.js';
import type { Config, Task } from '../types.js';

/**
 * Brain-level rate-limit circuit breaker (plan item P0-1): a brain that answers
 * with a rate/session-limit notice cools until its window resets; the chain
 * planner skips cooling rungs like disabled ones, and a task whose remaining
 * rungs are ALL cooling stays pending (no attempt burned) until one recovers.
 */

// ── reset-time parsing (shapes from decisions/lessons.jsonl) ────────────────

// 2026-10-20 03:00 UTC = 11:00 Asia/Taipei (UTC+8, no DST).
const NOW = Date.parse('2026-10-20T03:00:00Z');

test('parses "resets 9pm (Asia/Taipei)" as the next 21:00 Taipei', () => {
  const t = parseRateLimitReset("You've hit your session limit · resets 9pm (Asia/Taipei)", NOW);
  assert.equal(new Date(t!).toISOString(), '2026-10-20T13:00:00.000Z');
});

test('parses "resets 6:10am (Asia/Taipei)" as tomorrow when already past', () => {
  const t = parseRateLimitReset("You've hit your session limit · resets 6:10am (Asia/Taipei)", NOW);
  assert.equal(new Date(t!).toISOString(), '2026-10-20T22:10:00.000Z');   // 06:10 on the 21st, Taipei
});

test('parses "resets 12:30pm" / "12am" edge hours', () => {
  assert.equal(new Date(parseRateLimitReset('resets 12:30pm (Asia/Taipei)', NOW)!).toISOString(), '2026-10-20T04:30:00.000Z');
  assert.equal(new Date(parseRateLimitReset('resets 12am (Asia/Taipei)', NOW)!).toISOString(), '2026-10-20T16:00:00.000Z');
});

test('parses a dated weekly reset "resets Oct 23, 5pm (Asia/Taipei)"', () => {
  const t = parseRateLimitReset("You've hit your weekly limit · resets Oct 23, 5pm (Asia/Taipei)", NOW);
  assert.equal(new Date(t!).toISOString(), '2026-10-23T09:00:00.000Z');
});

test('parses relative "Resets in 2h46m24s." and "try again in 2h" / "in a minute"', () => {
  const quota = 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h46m24s.';
  assert.equal(parseRateLimitReset(quota, NOW), NOW + (2 * 3600 + 46 * 60 + 24) * 1000);
  assert.equal(parseRateLimitReset('rate limit reached, try again in 2h', NOW), NOW + 2 * 3600e3);
  assert.equal(parseRateLimitReset('high traffic right now, please try again in a minute.', NOW), NOW + 60e3);
});

test('parses retry-after seconds and an ISO reset', () => {
  assert.equal(parseRateLimitReset('HTTP 429 Too Many Requests; Retry-After: 120', NOW), NOW + 120e3);
  assert.equal(parseRateLimitReset('quota exceeded, resets at 2026-10-20T06:10:00Z', NOW), Date.parse('2026-10-20T06:10:00Z'));
});

test('no reset time → undefined (caller applies the default cooldown)', () => {
  assert.equal(parseRateLimitReset('rate limit reached', NOW), undefined);
  assert.equal(parseRateLimitReset('API Error: 529 Overloaded — try again in a moment.', NOW), undefined);
  assert.equal(parseRateLimitReset('resets Mar 1, 5pm (Asia/Taipei)', NOW), undefined, 'months away is implausible');
});

// ── BrainCooldowns registry ────────────────────────────────────────────────

test('cooldowns persist across instances and expire', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cd-')), 'brain-cooldowns.json');
  const now = Date.now();
  const a = new BrainCooldowns(file);
  a.set('b1', now + 60_000, 'rate limit reached', now);
  a.set('b2', now + 10, 'rate limit reached', now);
  const b = new BrainCooldowns(file);            // "restart"
  assert.equal(b.until('b1'), now + 60_000, 'survives a restart');
  assert.equal(b.until('b2', now + 20), undefined, 'expired → re-enabled');
  assert.deepEqual(Object.keys(b.snapshot(now + 20)), ['b1']);
  // never shortened by a later, earlier-resetting notice
  b.set('b1', now + 5_000, 'x', now);
  assert.equal(b.until('b1'), now + 60_000);
});

// ── dispatcher integration ─────────────────────────────────────────────────

const CHAIN = ['remote-h-cc-opus', 'local-cc-opus', 'local-hermes'];

function harness(orch: Record<string, any> = {}) {
  const tasks = new Map<string, Task>();
  const store = {
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    getAgentPersona: () => null,
  };
  const status = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cd-status-'));
  const config = {
    paths: { status },
    inbox: { maxRetries: 3 },
    orchestration: {
      verifier: { enabled: true },
      agents: { engineer: { description: '', brains: CHAIN } },
      brains: {
        'remote-h-cc-opus': { location: 'remote', exec: 'claude' },
        'local-cc-opus': { location: 'local', exec: 'claude', model: 'opus' },
        'local-hermes': { location: 'local', exec: 'hermes' },
      },
      ...orch,
    },
  } as unknown as Config;
  const d = new Dispatcher(config, store as any, {} as any);
  const put = (t: Partial<Task> & { id: string }) => { tasks.set(t.id, { title: 't', description: '', status: 'pending', ...t } as Task); return tasks.get(t.id)!; };
  const plan = (t: Task) => (d as any).planFor(t);
  const guard = (t: Task, r?: string) => (d as any).verifyReportedCompletion(t, r);
  return { d, put, plan, guard, tasks, status, config };
}

test('a reported rate-limit cools the brain until the parsed reset; GET snapshot shows it', async () => {
  const { d, put, guard, status } = harness();
  const t = put({ id: 'r1', status: 'in-progress', context: { agent: 'engineer', brain: CHAIN[0], brainAuto: true, attempts: 0 } });
  const res = await guard(t, "You've hit your session limit · resets 9pm (Asia/Taipei)");
  assert.equal(res.action, 'handover');
  const cd = d.getBrainCooldowns()[CHAIN[0]];
  assert.ok(cd, 'cooldown recorded for the rate-limited brain');
  assert.ok(Date.parse(cd.until) > Date.now() && Date.parse(cd.until) <= Date.now() + 24 * 3600e3, 'until next 9pm Taipei');
  assert.ok(fs.existsSync(path.join(status, 'brain-cooldowns.json')), 'persisted under .status');
});

test('a rate-limit without a reset time cools for brainCooldown.defaultMs (default 30 min)', () => {
  const { d } = harness();
  const before = Date.now();
  (d as any).noteRateLimit('local-cc-opus', 'matched failure pattern "rate limit reached"', 'rate limit reached', true);
  const until = Date.parse(d.getBrainCooldowns()['local-cc-opus'].until);
  assert.ok(until >= before + 1_800_000 && until <= Date.now() + 1_800_000);
});

test('a non-rate-limit failure, or a long deliverable failing the LLM gate, does not cool', () => {
  const { d } = harness();
  (d as any).noteRateLimit('local-cc-opus', 'empty result (0 < 1 chars)', '', true);
  (d as any).noteRateLimit('local-hermes', 'verifier LLM: FAIL incomplete', 'Report on how we handle rate limit reached errors…', false);
  assert.deepEqual(d.getBrainCooldowns(), {});
});

test('a cooling brain is not dispatched to again: the chain planner skips it', () => {
  const { d, put, plan } = harness();
  (d as any).noteRateLimit(CHAIN[0], 'rate limit reached', 'rate limit reached · try again in 1h', true);
  const p = plan(put({ id: 'p1', context: { agent: 'engineer', attempts: 0 } }));
  assert.equal(p.action, 'execute');
  assert.equal(p.exec.brainId, 'local-cc-opus', 'skips the cooling rung');
  assert.equal(p.exec.attempt, 1, 'plan index is the rung actually used, so a handover advances past it');
});

test('every remaining rung cooling → task stays pending (cooling), no attempt burned', () => {
  const { d, put, plan, tasks } = harness();
  const now = Date.now();
  (d as any).cooldowns.set('local-cc-opus', now + 3600e3, 'rate limit reached', now);
  (d as any).cooldowns.set('local-hermes', now + 600e3, 'rate limit reached', now);
  const p = plan(put({ id: 'p2', context: { agent: 'engineer', attempts: 1 } }));
  assert.equal(p.action, 'cooling');
  assert.equal(p.until, now + 600e3, 'waits for the earliest cooldown');
  assert.deepEqual(p.brains, ['local-cc-opus', 'local-hermes']);
  assert.equal(tasks.get('p2')!.context!.attempts, 1, 'attempts unchanged');
});

test('a pinned brain that is cooling waits instead of retrying', () => {
  const { d, put, plan } = harness();
  (d as any).noteRateLimit('local-cc-opus', 'rate limit reached', 'rate limit reached', true);
  const p = plan(put({ id: 'p3', context: { agent: 'engineer', brain: 'local-cc-opus' } }));
  assert.equal(p.action, 'cooling');
});

test('cooldown expiry re-enables the brain', () => {
  const { d, put, plan } = harness();
  const now = Date.now();
  (d as any).cooldowns.set(CHAIN[0], now - 1, 'rate limit reached', now - 1000);
  const p = plan(put({ id: 'p4', context: { agent: 'engineer', attempts: 0 } }));
  assert.equal(p.action, 'remote');
  assert.equal(p.exec.brainId, CHAIN[0]);
  assert.deepEqual(d.getBrainCooldowns(), {});
});

test('brainCooldown.enabled=false: nothing recorded, nothing skipped', () => {
  const { d, put, plan } = harness({ brainCooldown: { enabled: false } });
  (d as any).noteRateLimit(CHAIN[0], 'rate limit reached', 'rate limit reached', true);
  assert.deepEqual(d.getBrainCooldowns(), {});
  assert.equal(plan(put({ id: 'p5', context: { agent: 'engineer', attempts: 0 } })).exec.brainId, CHAIN[0]);
});

test('tick leaves an all-cooling task pending with a cooldown reason', () => {
  const { d, put, tasks } = harness({ maxConcurrent: 2 });
  const store = (d as any).store;
  Object.assign(store, {
    updateHeartbeat: () => {}, releaseDueScheduled: () => [], getActiveAgents: () => [],
    listTasks: ({ status }: { status?: string } = {}) => [...tasks.values()].filter(t => !status || t.status === status),
  });
  (d as any).agentId = 'orch';
  const now = Date.now();
  for (const b of CHAIN) (d as any).cooldowns.set(b, now + 3600e3, 'rate limit reached', now);
  put({ id: 'p6', context: { agent: 'engineer', attempts: 0 } });
  let executed = false;
  (d as any).execute = async () => { executed = true; };
  (d as any).tick();
  const t = tasks.get('p6')!;
  assert.equal(executed, false, 'never dispatched to a cooling brain');
  assert.equal(t.status, 'pending');
  assert.match(String(t.context!.pendingReason), /cooling down after a rate limit/);
});
