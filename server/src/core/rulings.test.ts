import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { appendRulings, readRulings, rulingRowsForTask, describeAutoAnswer, logAutoAnswer, RULINGS_HEADER, RULINGS_FILE } from './rulings.js';
import type { Config, Task } from '../types.js';

/**
 * P2-3 decision trail: RULING lines (P0-4 context.rulings) and orchestrator
 * auto-answers (ADR-009 context.autoAnswer.decisions) aggregate into
 * decisions/rulings.tsv when a task completes.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rulings-'));
const task = (over: Partial<Task> = {}): Task => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 't', status: 'done', createdAt: '2026-10-20T00:00:00Z',
  completedAt: '2026-10-20T02:00:00.000Z', from: { platform: 'p', agent: 'a' },
  context: { ranAgent: 'engineering-backend-architect', ranBrain: 'local-cc-opus' },
  ...over,
} as Task);

test('footer rulings become one row each, with agent and brain', () => {
  const rows = rulingRowsForTask(task({ context: { ranAgent: 'eng', ranBrain: 'b1', rulings: ['use X — cheaper — redo later', 'skip Y\tbecause\nZ'] } }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: '2026-10-20T02:00:00.000Z', task: 'aaaaaaaa-1111-2222-3333-444444444444', agent: 'eng', brain: 'b1', ruling: 'use X — cheaper — redo later' });
  assert.equal(rows[1].ruling, 'skip Y because Z');   // tabs/newlines flattened
});

test('auto-answer decisions are logged with an AUTO-ANSWER prefix and not re-logged after the watermark', () => {
  const decisions = logAutoAnswer(undefined, { at: '2026-10-20T01:00:00.000Z', answer: describeAutoAnswer([{ id: 'q1', label: 'May I re-enable the cron?' }], { q1: 'yes' }) });
  const t = task({ context: { ranAgent: 'eng', ranBrain: 'b1', autoAnswer: { count: 1, decisions } } });
  const rows = rulingRowsForTask(t);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ruling, 'AUTO-ANSWER: May I re-enable the cron? → yes');
  assert.equal(rows[0].date, '2026-10-20T01:00:00.000Z');
  // A re-run of the same task: the earlier auto-answer is behind the watermark.
  t.context!.rulingsLoggedAt = '2026-10-20T02:00:00.000Z';
  assert.equal(rulingRowsForTask(t).length, 0);
});

test('legacy auto-answered task falls back to its submitted interaction packet', () => {
  const t = task({ interaction: { status: 'submitted', submittedBy: 'orchestrator (auto-answer)', submittedAt: '2026-10-19T09:00:00.000Z',
    fields: [{ id: 'f1', type: 'text', label: 'Which account?', value: 'slashman413' }] } as any });
  const rows = rulingRowsForTask(t);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ruling, 'AUTO-ANSWER: Which account? → slashman413');
  // A human answer is not a ruling.
  t.interaction!.submittedBy = 'wayne';
  assert.equal(rulingRowsForTask(t).length, 0);
});

test('agent falls back to task.to.agent, never an object string', () => {
  const rows = rulingRowsForTask(task({ to: { platform: 'claude', agent: 'cowork-orchestrator' } as any, context: { rulings: ['r'] } }));
  assert.equal(rows[0].agent, 'cowork-orchestrator');
});

test('logAutoAnswer keeps only the last 20 decisions', () => {
  let log: any;
  for (let i = 0; i < 25; i++) log = logAutoAnswer(log, { at: `2026-10-20T00:00:${String(i).padStart(2, '0')}Z`, answer: `a${i}` });
  assert.equal(log.length, 20);
  assert.equal(log[0].answer, 'a5');
});

test('appendRulings writes a header once, readRulings filters by window newest-first', () => {
  const dir = tmp();
  assert.equal(appendRulings(dir, task({ context: { rulings: ['first'] } })), 1);
  assert.equal(appendRulings(dir, task({ completedAt: '2026-10-10T00:00:00.000Z', context: { rulings: ['old'] } })), 1);
  assert.equal(appendRulings(dir, task({ context: {} })), 0);   // nothing to log → no write
  const lines = fs.readFileSync(path.join(dir, RULINGS_FILE), 'utf8').trim().split('\n');
  assert.equal(lines[0], RULINGS_HEADER);
  assert.equal(lines.length, 3);
  assert.deepEqual(readRulings(dir).map(r => r.ruling), ['first', 'old']);
  assert.deepEqual(readRulings(dir, Date.parse('2026-10-15T00:00:00Z')).map(r => r.ruling), ['first']);
  assert.deepEqual(readRulings(path.join(dir, 'missing')), []);
});

test('appendRulings never throws on an unwritable decisions dir', () => {
  const dir = tmp();
  const file = path.join(dir, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.equal(appendRulings(path.join(file, 'decisions'), task({ context: { rulings: ['x'] } })), 0);
});

test('Store.completeTask appends the task\'s rulings to decisions/rulings.tsv and sets the watermark', async () => {
  const root = tmp();
  const paths = {
    inbox: path.join(root, 'inbox'), artifacts: path.join(root, 'artifacts'), inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'), decisions: path.join(root, 'decisions'),
    workflows: path.join(root, 'workflows'), agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
  const store = new Store({ paths, platforms: {}, inbox: { maxRetries: 3 }, orchestration: {} } as unknown as Config, new EventBus());
  const t = store.createTask({ title: 'decide things', from: { platform: 'p', agent: 'a' } } as any);
  t.context = { ...(t.context || {}), ranAgent: 'eng', ranBrain: 'local-cc-opus', rulings: ['picked plan B — reversible — one revert'] };
  store.saveTask(t);
  const done = await store.completeTask({ taskId: t.id, result: 'ok', internal: true });
  const rows = readRulings(paths.decisions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task, t.id);
  assert.equal(rows[0].agent, 'eng');
  assert.equal(rows[0].brain, 'local-cc-opus');
  assert.equal(rows[0].ruling, 'picked plan B — reversible — one revert');
  assert.equal(done!.context!.rulingsLoggedAt, done!.completedAt);
});
