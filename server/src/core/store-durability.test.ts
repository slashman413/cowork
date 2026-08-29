import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * Store durability — the "my tasks disappeared" bug.
 *
 * Two guarantees are locked in here:
 *  1. Task writes are ATOMIC. A task file is never observed truncated/partial:
 *     every persisted file parses as complete JSON. Previously each write site
 *     did `writeFileSync(dest, …)` directly, truncating the live file before
 *     rewriting it — a crash mid-write left a broken JSON that readTaskFile then
 *     silently dropped, so the task vanished from the dashboard.
 *  2. A present-but-unparseable inbox file is TOLERATED (it doesn't break
 *     listTasks) but no longer swallows the whole listing — the healthy tasks
 *     around it still load.
 */
function makeStore(): { store: Store; root: string; inbox: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-dura-'));
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
    paths, platforms: {},
    orchestration: { brains: { 'local-x': { location: 'local', exec: 'hermes' } } },
  } as unknown as Config;
  return { store: new Store(config, new EventBus()), root, inbox: paths.inbox };
}

test('every persisted task file is complete, parseable JSON (atomic write)', () => {
  const { store, inbox } = makeStore();
  const t = store.createTask({ title: 'durable', from: { platform: 'p', agent: 'a' } } as any);
  // Mutate through several write paths.
  store.saveTask({ ...t, priority: 'high' } as any);
  const files = fs.readdirSync(inbox);
  // Only the canonical <id>.json survives — no leftover temp files visible.
  assert.deepEqual(files, [`${t.id}.json`]);
  const raw = fs.readFileSync(path.join(inbox, `${t.id}.json`), 'utf-8');
  const parsed = JSON.parse(raw);   // throws if truncated/partial
  assert.equal(parsed.id, t.id);
});

test('the atomic temp file is never left behind and is invisible to listTasks', () => {
  const { store, inbox } = makeStore();
  store.createTask({ title: 'a', from: { platform: 'p', agent: 'a' } } as any);
  store.createTask({ title: 'b', from: { platform: 'p', agent: 'a' } } as any);
  // No dot-prefixed / .tmp scratch files linger in the inbox.
  const stray = fs.readdirSync(inbox).filter(f => f.startsWith('.') || f.endsWith('.tmp'));
  assert.deepEqual(stray, []);
  assert.equal(store.listTasks().length, 2);
});

test('a present-but-unparseable inbox file is tolerated: healthy tasks still list', () => {
  const { store, inbox } = makeStore();
  const good = store.createTask({ title: 'healthy', from: { platform: 'p', agent: 'a' } } as any);
  // Drop a corrupt file next to it (mimics a truncated write / a mis-saved script).
  fs.writeFileSync(path.join(inbox, 'broken.json'), '{ "title": "oops"'); // invalid JSON
  const tasks = store.listTasks();
  const ids = tasks.map(t => t.id);
  assert.ok(ids.includes(good.id), 'the healthy task must still be listed');
  assert.ok(!ids.includes(undefined as any), 'the corrupt file is skipped, not surfaced as a null task');
});
