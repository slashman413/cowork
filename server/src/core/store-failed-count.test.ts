import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Regression: the dashboard "failed" count MUST match how the UI (app.js
 * isTaskFailed) and rerunTask (looksFailed) categorise a failed task, i.e.
 *   failed === true
 *   || status === 'rejected'
 *   || (status === 'done' && /^FAILED\b/.test(result))
 *
 * The old getDashboard used a stricter predicate (status==='done' && failed===true),
 * so a rejected task, or a done task whose result starts with "FAILED" but whose
 * `failed` flag was never set, showed a red "failed" card yet the summary counted
 * 0 failed. This test pins the count to the canonical predicate.
 */
function makeStore(): { store: Store; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-failedcount-'));
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
  const config = { paths, platforms: {}, orchestration: { agents: {} } } as unknown as Config;
  return { store: new Store(config, new EventBus()), root };
}

function mkTask(store: Store, title: string) {
  return store.createTask({
    title,
    description: title,
    from: { platform: 'p', agent: 'a' },
    priority: 'normal',
  } as any);
}

test('dashboard failed count matches the UI/rerun canonical predicate', async () => {
  const { store } = makeStore();

  // (A) done + flagged: the "FAILED after N attempt(s)" chain-exhausted path.
  const a = mkTask(store, 'chain exhausted flagged');
  await store.completeTask({ taskId: a.id, result: 'FAILED after 2 attempt(s) (chain exhausted). Agents: x.', internal: true });
  assert.equal(store.getTask(a.id)!.failed, true, 'A is flagged failed');

  // (B) rejected status, no flag — UI shows it failed, old count ignored it.
  const b = mkTask(store, 'rejected');
  const bt = store.getTask(b.id)!;
  bt.status = 'rejected';
  store.saveTask(bt);

  // (C) done + result starts with FAILED but flag NOT set (result doesn't match
  //     the strict "FAILED after \d+ attempt" flag regex). UI: /^FAILED\b/ => failed.
  const c = mkTask(store, 'done failed unflagged');
  await store.completeTask({ taskId: c.id, result: 'FAILED (codex pre-flight aborted).', internal: true });
  assert.notEqual(store.getTask(c.id)!.failed, true, 'C is NOT flagged (reproduces the gap)');

  // (D) genuine success — must NOT count as failed.
  const d = mkTask(store, 'success');
  await store.completeTask({ taskId: d.id, result: 'All done, here is the deliverable.', internal: true });

  const dash = store.getDashboard();
  assert.equal(dash.inboxSummary.failed, 3, 'A, B, C are failed; D is not');
});
