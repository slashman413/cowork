import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config } from '../types.js';

/**
 * listTasks ordering — "the latest task on top, by time".
 *
 * The list is sorted by `createdAt`, newest first. This locks in the two
 * robustness fixes that the plain `getTime() - getTime()` subtraction lacked:
 *  1. A missing/unparseable `createdAt` produced NaN, which the sort read as
 *     "equal" and scattered the task to a random slot. It now sinks to the
 *     bottom (it isn't "latest") without disturbing the healthy ordering.
 *  2. Tasks stamped in the same millisecond tied at 0 and reshuffled between
 *     reloads. A stable id tiebreaker makes the order deterministic.
 */
function makeStore(): { store: Store; inbox: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-sort-'));
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
  return { store: new Store(config, new EventBus()), inbox: paths.inbox };
}

/** Write a raw task file with a chosen id/createdAt (bypasses createTask's
 *  own "now" stamp so we can control the time axis precisely). */
function writeTask(inbox: string, id: string, createdAt: unknown) {
  const task = { id, title: id, status: 'pending', from: { platform: 'p', agent: 'a' }, createdAt };
  fs.writeFileSync(path.join(inbox, `${id}.json`), JSON.stringify(task));
}

test('newest createdAt is first', () => {
  const { store, inbox } = makeStore();
  writeTask(inbox, 'old', '2020-01-01T00:00:00.000Z');
  writeTask(inbox, 'new', '2026-01-01T00:00:00.000Z');
  writeTask(inbox, 'mid', '2023-01-01T00:00:00.000Z');
  const ids = store.listTasks().map(t => t.id);
  assert.deepEqual(ids, ['new', 'mid', 'old']);
});

test('a task with missing/unparseable createdAt sinks to the bottom, not scattered', () => {
  const { store, inbox } = makeStore();
  writeTask(inbox, 'newest', '2026-06-01T00:00:00.000Z');
  writeTask(inbox, 'older', '2024-06-01T00:00:00.000Z');
  writeTask(inbox, 'nodate', undefined);           // no createdAt
  writeTask(inbox, 'baddate', 'not-a-date');       // unparseable
  const ids = store.listTasks().map(t => t.id);
  // Healthy tasks keep newest-first order; the timeless ones land last.
  assert.deepEqual(ids.slice(0, 2), ['newest', 'older']);
  assert.deepEqual(ids.slice(2).sort(), ['baddate', 'nodate']);
});

test('same-millisecond tasks get a stable, deterministic order', () => {
  const { store, inbox } = makeStore();
  const ts = '2025-05-05T05:05:05.000Z';
  writeTask(inbox, 'aaa', ts);
  writeTask(inbox, 'bbb', ts);
  writeTask(inbox, 'ccc', ts);
  const first = store.listTasks().map(t => t.id);
  // Re-listing yields the identical order (no reshuffle between reloads).
  const second = store.listTasks().map(t => t.id);
  assert.deepEqual(first, second);
  // Tiebreak is by id descending, so the order is fully predictable.
  assert.deepEqual(first, ['ccc', 'bbb', 'aaa']);
});
