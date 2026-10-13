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
 * Covers the rate-limit auto-re-run plumbing added for the Inbox task-status work:
 *   - completeTask classifies a chain-exhausted RATE-LIMIT failure (context.rateLimited)
 *     and records the soonest usage-window reset (context.rateLimitResetsAt).
 *   - a non-rate-limit failure is NOT flagged (and prior flags are cleared on re-fail).
 *   - auto re-run is DEFAULT-ON for a rate-limited failure (explicit opt-out kept,
 *     config switch restores opt-in); setAutoRerun toggles it.
 *   - Dispatcher.autoRerunRateLimited re-queues after reset + grace, capped.
 *   - readProgressLog tails artifacts/<id>/progress.log.
 */
function makeStore(orchestration: Record<string, any> = {}): { store: Store; root: string; config: Config } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ratelimit-'));
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
  const config = { paths, platforms: {}, inbox: { maxRetries: 3 }, orchestration: { brains: {}, ...orchestration } } as unknown as Config;
  return { store: new Store(config, new EventBus()), root, config };
}

function mkTask(store: Store, title: string, context?: Record<string, any>) {
  return store.createTask({
    title,
    description: title,
    from: { platform: 'p', agent: 'a' },
    priority: 'normal',
    context,
  } as any);
}

test('completeTask flags a rate-limit failure + records the window reset time', async () => {
  const { store } = makeStore();
  const resetsAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();   // 90 min out
  const usage: BrainUsage = { exec: 'claude', at: new Date().toISOString(), windows: [
    { label: '5h', usedPct: 100, resetsAt },
    { label: '7d', usedPct: 40, resetsAt: new Date(Date.now() + 5 * 864e5).toISOString() },
  ] };
  store.setBrainUsage('local-cc-opus', usage);

  const t = mkTask(store, 'rate limited', { failedBrains: [{ brain: 'local-cc-opus', reason: 'matched failure pattern "rate limit reached"' }] });
  await store.completeTask({ taskId: t.id, result: 'FAILED after 3 attempt(s) (chain exhausted). Brains that failed: local-cc-opus (rate limit reached).', internal: true });

  const done = store.getTask(t.id)!;
  assert.equal(done.failed, true);
  assert.equal(done.context!.rateLimited, true, 'flagged rate-limited');
  // The exhausted 5h window (used 100%) wins over the 7d window that still has room.
  assert.equal(done.context!.rateLimitResetsAt, resetsAt, 'records the exhausted window reset');
});

test('a non-rate-limit failure is not flagged rate-limited', async () => {
  const { store } = makeStore();
  const t = mkTask(store, 'auth failure', { failedBrains: [{ brain: 'b', reason: 'matched failure pattern "invalid api key"' }] });
  await store.completeTask({ taskId: t.id, result: 'FAILED after 2 attempt(s) (chain exhausted). Brains that failed: b (invalid api key).', internal: true });
  const done = store.getTask(t.id)!;
  assert.equal(done.failed, true);
  assert.notEqual(done.context?.rateLimited, true, 'auth error is not a rate limit');
});

test('setAutoRerun toggles the opt-in flag', () => {
  const { store } = makeStore();
  const t = mkTask(store, 'toggle me');
  store.setAutoRerun(t.id, true);
  assert.equal(store.getTask(t.id)!.context!.autoRerunOnReset, true);
  store.setAutoRerun(t.id, false);
  assert.equal(store.getTask(t.id)!.context?.autoRerunOnReset, false, 'explicit opt-out is stored');
  assert.equal(store.setAutoRerun('nope', true), null, 'missing task → null');
});

test('readProgressLog tails the per-task progress.log', () => {
  const { store, root } = makeStore();
  const t = mkTask(store, 'running');
  const bt = store.getTask(t.id)!;
  bt.status = 'in-progress';
  store.saveTask(bt);

  const dir = path.join(root, 'artifacts', t.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'progress.log'), 'line one\nline two\nline three\n');

  const p = store.readProgressLog(t.id);
  assert.equal(p.running, true);
  assert.equal(p.status, 'in-progress');
  assert.match(p.log, /line three/);
  assert.ok(p.updatedAt, 'reports a mtime');

  // No log on disk → empty string, never throws.
  const t2 = mkTask(store, 'no log');
  assert.equal(store.readProgressLog(t2.id).log, '');
});

const RL_RESULT = 'FAILED after 2 attempt(s) (chain exhausted). Brains that failed: cc (You\'ve hit your session limit · resets 2am (Asia/Taipei)).';
const rlFailed = (brain = 'cc') => ({ failedBrains: [{ brain, reason: "You've hit your session limit · resets 2am (Asia/Taipei)" }] });

test('a rate-limited failure is auto-re-run by DEFAULT (no toggle needed)', async () => {
  const { store } = makeStore();
  const t = mkTask(store, 'overnight', rlFailed());
  await store.completeTask({ taskId: t.id, result: RL_RESULT, internal: true });
  const done = store.getTask(t.id)!;
  assert.equal(done.context!.rateLimited, true);
  assert.equal(done.context!.autoRerunOnReset, true, 'default-on');
});

test('an explicit opt-out survives a later rate-limit failure', async () => {
  const { store } = makeStore();
  const t = mkTask(store, 'opted out', { ...rlFailed(), autoRerunOnReset: false });
  await store.completeTask({ taskId: t.id, result: RL_RESULT, internal: true });
  assert.equal(store.getTask(t.id)!.context!.autoRerunOnReset, false);
});

test('orchestration.autoRerunRateLimited.enabled=false restores the opt-in', async () => {
  const { store } = makeStore({ autoRerunRateLimited: { enabled: false } });
  const t = mkTask(store, 'opt-in mode', rlFailed());
  await store.completeTask({ taskId: t.id, result: RL_RESULT, internal: true });
  assert.equal(store.getTask(t.id)!.context!.rateLimited, true);
  assert.equal(store.getTask(t.id)!.context!.autoRerunOnReset, undefined);
});

/** Fail a task on a rate limit whose window reset `resetAgoMs` ago. */
async function failRateLimited(store: Store, title: string, resetAgoMs: number) {
  const t = mkTask(store, title, rlFailed());
  await store.completeTask({ taskId: t.id, result: RL_RESULT, internal: true });
  const ft = store.getTask(t.id)!;
  ft.context!.rateLimitResetsAt = new Date(Date.now() - resetAgoMs).toISOString();
  store.saveTask(ft);
  return t.id;
}

test('dispatcher re-queues a default-on rate-limited failure after reset + grace', async () => {
  const { store, config } = makeStore({ autoRerunRateLimited: { graceSeconds: 60 } });
  const d = new Dispatcher(config, store as any, {} as any);
  const due = await failRateLimited(store, 'due', 5 * 60 * 1000);       // reset 5 min ago
  const inGrace = await failRateLimited(store, 'in grace', 10 * 1000);  // reset 10 s ago
  (d as any).autoRerunRateLimited();

  const re = store.getTask(due)!;
  assert.equal(re.status, 'pending', 're-queued');
  assert.equal(re.failed, undefined);
  assert.equal(re.context!.autoRerunCount, 1, 'spent one auto re-run');
  assert.equal(re.context!.autoRerunOnReset, true, 'still armed for a repeat limit');
  assert.equal(store.getTask(inGrace)!.failed, true, 'waits out the grace period');
});

test('dispatcher stops auto re-running after maxAttempts; manual re-run resets the budget', async () => {
  const { store, config } = makeStore({ autoRerunRateLimited: { maxAttempts: 2, graceSeconds: 0 } });
  const d = new Dispatcher(config, store as any, {} as any);
  const id = await failRateLimited(store, 'stuck quota', 60 * 1000);
  const ft = store.getTask(id)!;
  ft.context!.autoRerunCount = 2;
  store.saveTask(ft);
  (d as any).autoRerunRateLimited();
  assert.equal(store.getTask(id)!.failed, true, 'budget exhausted → left failed');

  const manual = store.rerunTask(id)!;
  assert.equal(manual.context!.autoRerunCount, undefined, 'manual re-run starts a fresh budget');
});
