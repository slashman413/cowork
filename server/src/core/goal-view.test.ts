import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Goals, runUnblockCheck, isPublicHttpsUrl, sanitizeCheck } from './goals.js';
import { coalesceHistory, deriveDisplayState, goalSummary, sortSummaries, classifyBlockReason, rollupTaskUsage } from './goal-view.js';
import { buildAchieverPrompt, estimateTokens, extractNextMove, goalDetails } from './achiever-prompt.js';
import type { Config, GoalRecord, Task } from '../types.js';

class FakeStore {
  tasks: Task[] = [];
  createTask(p: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    const t = { ...p, id: uuidv4(), status: 'pending', createdAt: new Date().toISOString() } as Task;
    this.tasks.push(t);
    return t;
  }
  listTasks(): Task[] { return this.tasks; }
  getTask(id: string): Task | null { return this.tasks.find(t => t.id === id) || null; }
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-view-'));
  const dir = path.join(base, 'goals');
  const artifacts = path.join(base, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  const config = { paths: { goals: dir, artifacts }, orchestration: {} } as unknown as Config;
  const store = new FakeStore();
  return { goals: new Goals(config, store as any), store, dir, artifacts };
}

const rec = (over: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: 'goal-1', title: 'T', description: '', successCriteria: 'C?', status: 'active',
  phases: [{ key: 'a', title: 'A', status: 'active', taskIds: [] }], history: [], minutes: [],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...over
});
const task = (over: Partial<Task> = {}): Task => ({
  id: uuidv4(), title: 'work', description: '', from: { platform: 'x', agent: 'y' }, to: {}, priority: 'normal',
  status: 'done', createdAt: '2026-11-01T00:00:00Z', context: { goalId: 'goal-1', goalGenerated: true, role: 'goal-achiever' }, ...over
} as Task);

const NOW = Date.parse('2026-11-06T00:00:00Z');

test('display state: a goal with only a future task reads as sleeping, with the time', () => {
  const d = deriveDisplayState(rec(), [task({ status: 'scheduled', scheduledAt: '2026-11-14T02:00:00Z', title: 'Measure revenue' })], { now: NOW });
  assert.equal(d.state, 'sleeping');
  assert.equal(d.nextAt, '2026-11-14T02:00:00Z');
});

test('display state: a pending task waiting on a scheduled one is still asleep', () => {
  const first = task({ status: 'scheduled', scheduledAt: '2026-11-14T02:00:00Z' });
  const second = task({ status: 'pending', context: { goalId: 'goal-1', goalGenerated: true, dependsOn: [first.id] } });
  assert.equal(deriveDisplayState(rec(), [first, second], { now: NOW }).state, 'sleeping');
});

test('display state table', () => {
  const cases: [string, Partial<GoalRecord>, Task[], string, string?][] = [
    ['draft', { status: 'draft' }, [], 'draft', 'activate'],
    ['paused', { status: 'paused' }, [], 'paused', 'activate'],
    ['achieved', { status: 'achieved', closedReason: 'done' }, [], 'achieved'],
    ['wait-input beats all', {}, [task({ status: 'wait-input', title: 'Pick' })], 'needs-you', 'open-task'],
    ['in progress', {}, [task({ status: 'in-progress' })], 'running'],
    ['judger open', { phases: [{ key: 'a', title: 'A', status: 'completing', taskIds: [] }] }, [], 'auditing'],
    ['idle active', {}, [], 'thinking'],
    ['budget', { status: 'blocked', blockCode: 'budget_exhausted', stepBudget: 0 }, [], 'needs-you', 'raise-budget'],
    ['rate limit', { status: 'blocked', blockCode: 'rate_limit', nextRetryAt: '2026-11-06T09:00:00Z' }, [], 'retrying', 'retry'],
    ['first failure', { status: 'blocked', blockCode: 'achiever_no_progress', blockCount: 1 }, [], 'retrying', 'retry'],
    ['repeat failure', { status: 'blocked', blockCode: 'achiever_no_progress', blockCount: 4 }, [], 'stuck', 'retry'],
    ['no phase left', { status: 'blocked', blockCode: 'achiever_no_progress', blockCount: 1, phases: [{ key: 'a', title: 'A', status: 'audited', taskIds: [] }] }, [], 'stuck', 'plan-phase'],
    ['human obstacle', { status: 'blocked', blockCode: 'achiever_declared', unblockCriteria: 'Log in to LINE' }, [], 'needs-you', 'retry'],
    ['hold', { achieverRetryAt: '2026-11-06T09:00:00Z' }, [], 'retrying', 'retry'],
  ];
  for (const [name, over, tasks, state, action] of cases) {
    const d = deriveDisplayState(rec(over), tasks, { now: NOW });
    assert.equal(d.state, state, name);
    if (action) assert.equal(d.action, action, name);
  }
});

test('old block records classify from their text', () => {
  assert.equal(classifyBlockReason('step budget exhausted (24 generated tasks)'), 'budget_exhausted');
  assert.equal(classifyBlockReason('Achiever made no usable progress after 5 turns (no usable decision)'), 'achiever_no_progress');
  assert.equal(classifyBlockReason("You've hit your weekly limit"), 'rate_limit');
  assert.equal(classifyBlockReason('LINE login expired'), 'achiever_declared');
});

test('sort puts what needs attention first, and sleeping goals by next event', () => {
  const mk = (id: string, over: Partial<GoalRecord>, tasks: Task[]) => goalSummary(rec({ goalId: id, ...over }), tasks, { now: NOW });
  const later = mk('later', {}, [task({ status: 'scheduled', scheduledAt: '2026-12-18T00:00:00Z' })]);
  const soon = mk('soon', {}, [task({ status: 'scheduled', scheduledAt: '2026-11-14T00:00:00Z' })]);
  const need = mk('need', { status: 'blocked', blockCode: 'budget_exhausted' }, []);
  const won = mk('won', { status: 'achieved' }, []);
  assert.deepEqual(sortSummaries([won, later, soon, need]).map(s => s.goalId), ['need', 'soon', 'later', 'won']);
});

test('coalesce merges same-cause block cycles and keeps the tail', () => {
  const rows: any[] = [];
  for (let i = 0; i < 14; i++) {
    rows.push({ kind: 'block', code: 'achiever_no_progress', at: `t${i}` }, { kind: 'resume', at: `r${i}` });
  }
  rows.pop();
  const out = coalesceHistory(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 14);
  assert.equal(out[0].firstAt, 't0');
  assert.equal(out[0].lastAt, 't13');
  // Different causes stay apart.
  assert.equal(coalesceHistory([{ kind: 'block', code: 'operator', reason: 'a', at: '1' }, { kind: 'block', code: 'operator', reason: 'b', at: '2' }]).length, 2);
  // Tail cap.
  assert.equal(coalesceHistory(Array.from({ length: 40 }, (_, i) => ({ kind: 'plan' as const, at: `${i}` }))).length, 20);
});

test('history: every event reaches the JSONL even when the record tail coalesces', () => {
  const { goals } = setup();
  const g = goals.create({ title: 'G', successCriteria: 'C?', phases: [{ key: 'a', title: 'A' }] });
  goals.activate(g.goalId);
  for (let i = 0; i < 6; i++) {
    goals.block(g.goalId, 'Achiever made no usable progress after 5 turns (x)', undefined, { code: 'achiever_no_progress' });
    goals.activate(g.goalId, { auto: true });
  }
  const rec = goals.get(g.goalId)!;
  const full = goals.fullHistory(g.goalId);
  assert.equal(full.filter(r => r.kind === 'block').length, 6);
  assert.equal(full.filter(r => r.kind === 'resume').length, 6);
  assert.ok(rec.history.length <= 2, 'the record keeps a coalesced tail');
  assert.equal(rec.history.find(r => r.kind === 'block')!.count, 6);
});

test('migration is idempotent, loses no event, moves Attention to its artifact and backs up', () => {
  const { goals, dir, artifacts } = setup();
  const history = [
    ...Array.from({ length: 10 }, (_, i) => ([
      { kind: 'block', reason: 'Achiever made no usable progress after 5 turns (x)', unblockCriteria: 'y'.repeat(400), at: `2026-10-21T0${i}:00:00Z` },
      { kind: 'resume', reason: 'auto-resumed', at: `2026-10-21T0${i}:30:00Z` }
    ])).flat(),
    { kind: 'plan', phaseKey: 'a', at: '2026-10-22T00:00:00Z' }
  ];
  const old: any = rec({ goalId: 'goal-old', history: history as any });
  old.phases[0].attention = '## Attention\nreviewed by x\n- a flag';
  old.phases[0].attentionArtifact = 'task1/attention-a.md';
  fs.writeFileSync(path.join(dir, 'goal-old.json'), JSON.stringify(old));

  // An unmigrated record still reads.
  assert.equal(goals.summaries()[0].goalId, 'goal-old');

  const first = goals.migrateAll();
  assert.deepEqual(first.migrated, ['goal-old']);
  assert.ok(fs.existsSync(path.join(first.backupDir!, 'goal-old.json')));
  const after = fs.readFileSync(path.join(dir, 'goal-old.json'), 'utf-8');
  const again = goals.migrateAll();
  assert.deepEqual(again.migrated, []);
  assert.equal(fs.readFileSync(path.join(dir, 'goal-old.json'), 'utf-8'), after, 'second run is byte-identical');

  const m = JSON.parse(after);
  assert.equal(m.phases[0].attention, undefined);
  assert.equal(m.phases[0].attentionFlags, 1);
  assert.match(fs.readFileSync(path.join(artifacts, 'task1/attention-a.md'), 'utf-8'), /a flag/);
  assert.deepEqual(goals.fullHistory('goal-old').map(r => r.at), history.map(r => r.at));
  assert.ok(m.history.length <= 3);
});

test('list payload stays under 3 KB for four goals, with long text', () => {
  const { goals, store } = setup();
  const long = 'x'.repeat(400);
  for (let n = 0; n < 4; n++) {
    const g = goals.create({ title: long, description: long, successCriteria: long, reportBrief: long, stepBudget: 200,
      phases: Array.from({ length: 12 }, (_, i) => ({ key: `phase-${i}`, title: long })) });
    goals.activate(g.goalId);
    store.tasks.push(task({ status: 'scheduled', scheduledAt: '2030-01-01T00:00:00Z', title: long, context: { goalId: g.goalId, goalGenerated: true } }));
  }
  const bytes = Buffer.byteLength(JSON.stringify(goals.summaries()));
  assert.ok(bytes <= 3000, `summaries are ${bytes} bytes`);
});

test('usage rollup: unmetered runs are counted apart, open tasks are not counted', () => {
  const r = rollupTaskUsage([
    task({ context: { usage: { input: 10, cacheRead: 100, cacheWrite: 5, output: 2 } } }),
    task({ context: { usage: { metered: false } } }),
    task({ context: {} }),
    task({ status: 'pending', context: {} })
  ]);
  assert.equal(r.metered, 1);
  assert.equal(r.unmetered, 2);
  assert.equal(r.total, 117);
});

// ── The Achiever prompt ────────────────────────────────────────────────────

const promptCtx = (over: any = {}) => ({
  record: rec({ description: 'Build it.\n\n/loop driver (pstack autonomous run):\n• Cadence: daily.\n• Each turn: do things\n• Rule one\n• Stop only when: it is live' }),
  successCriteria: 'Live?',
  phases: [
    { key: 'old', title: 'Old', status: 'audited', results: [{ title: 'ancient', status: 'done', result: 'ANCIENT-RESULT' }] },
    { key: 'last', title: 'Last', status: 'audited', results: [{ title: 'recent', status: 'done', result: 'Did it.\nSTATUS: DONE\nEVIDENCE:\n- curl -> 200\n' }] },
    { key: 'now', title: 'Now', status: 'active', results: [] }
  ],
  currentPhaseKey: 'now',
  budget: { used: 3, cap: 24 },
  ...over
});

test('prompt: inlines NEXT MOVE, shows old phases as one line, drops loop-driver rules', () => {
  const p = buildAchieverPrompt(promptCtx({ nextMove: 'Emit the deploy.' }));
  assert.match(p, /NEXT MOVE .*Emit the deploy\./);
  assert.doesNotMatch(p, /ANCIENT-RESULT/);
  assert.match(p, /curl -> 200/);
  assert.doesNotMatch(p, /Rule one/);
  assert.match(p, /Stop only when: it is live/);
  assert.match(p, /You have no tools/);
});

test('prompt: rejected move is fed back; no workable phase removes emit', () => {
  const p = buildAchieverPrompt(promptCtx({ record: rec({ lastRejected: { reason: 'emit: no workable phase', at: 'x' } }), currentPhaseKey: null }));
  assert.match(p, /LAST MOVE REJECTED: emit: no workable phase/);
  assert.match(p, /NO WORKABLE PHASE/);
  assert.doesNotMatch(p, /"kind":"emit"/);
  assert.match(buildAchieverPrompt(promptCtx()), /"kind":"emit"/);
});

test('prompt budget: a heavy goal stays at or under 3k tokens', () => {
  const big = 'word '.repeat(2000);
  const phases = Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, title: big, status: 'audited',
    results: Array.from({ length: 10 }, () => ({ title: big, status: 'done', result: `${big}\nSTATUS: DONE\nEVIDENCE:\n- ${big}` })) }));
  const p = buildAchieverPrompt({ record: rec({ title: big, description: big }), successCriteria: 'Is the thing live and verified?', phases, currentPhaseKey: null, nextMove: big.slice(0, 600), budget: { used: 3, cap: 24 } });
  assert.ok(estimateTokens(p) <= 3000, `prompt is ~${estimateTokens(p)} tokens`);
});

test('next move: takes the last section, capped', () => {
  assert.equal(extractNextMove('# Minutes\nThe next move was debated.\n\n## NEXT MOVE:\nEmit the deploy.\n'), 'Emit the deploy.');
  assert.equal(extractNextMove('nothing here'), '');
  assert.ok(extractNextMove(`NEXT MOVE: ${'x'.repeat(900)}`).length <= 600);
  assert.equal(goalDetails('plain text'), 'plain text');
});

// ── Moves and probes ───────────────────────────────────────────────────────

test('a rejected move records why, and real progress clears it', () => {
  const { goals } = setup();
  const g = goals.create({ title: 'G', successCriteria: 'C?', phases: [{ key: 'a', title: 'A' }] });
  goals.activate(g.goalId);
  const r = goals.applyAchieverDecision(g.goalId, { kind: 'plan', phase: { key: 'a', title: 'dup' } });
  assert.match(r.rejected!, /already exists/);
  assert.match(goals.get(g.goalId)!.lastRejected!.reason, /already exists/);
  goals.applyAchieverDecision(g.goalId, { kind: 'plan', phase: { key: 'b', title: 'B' } });
  assert.equal(goals.get(g.goalId)!.lastRejected, undefined);
});

test('emit carries tier and brief; both lists skip the sharpener and the brain pin', () => {
  const { goals, store } = setup();
  const g = goals.create({ title: 'G', successCriteria: 'C?', phases: [{ key: 'a', title: 'A' }], achieverBrainChain: ['opus'] });
  goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, { kind: 'emit', tasks: [
    { title: 'tiered', tier: 'mechanical', acceptance: ['file exists'], verify: ['ls file'] },
    { title: 'plain' }
  ] });
  const [tiered, plain] = store.tasks;
  assert.equal(tiered.context!.tier, 'mechanical');
  assert.equal(tiered.context!.sharpen, false);
  assert.equal(tiered.context!.brain, undefined);
  assert.equal(plain.context!.brain, 'opus');
  assert.equal(plain.context!.sharpen, undefined);
});

test('unblock checks run without an LLM and reject anything malformed', async () => {
  const deps = { brainAvailable: (id: string) => id === 'free', now: NOW };
  assert.equal(await runUnblockCheck({ type: 'after-time', value: '2026-11-05T00:00:00Z' }, deps), true);
  assert.equal(await runUnblockCheck({ type: 'after-time', value: '2026-11-07T00:00:00Z' }, deps), false);
  assert.equal(await runUnblockCheck({ type: 'brain-available', value: 'free' }, deps), true);
  assert.equal(await runUnblockCheck({ type: 'brain-available', value: 'busy' }, deps), false);
  assert.equal(await runUnblockCheck({ type: 'file-exists', value: '/definitely/not/here' }, deps), false);
  assert.equal(await runUnblockCheck({ type: 'http-200', value: 'https://example.com/x' }, { ...deps, fetchStatus: async () => 503 }), false);
  assert.equal(await runUnblockCheck({ type: 'http-200', value: 'https://example.com/x' }, { ...deps, fetchStatus: async () => 200 }), true);
  for (const bad of ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://box.tail1.ts.net/x', 'file:///etc/passwd']) {
    assert.equal(isPublicHttpsUrl(bad), false, bad);
  }
  assert.equal(sanitizeCheck({ type: 'shell', value: 'rm -rf /' }), undefined);
  assert.equal(sanitizeCheck('nope'), undefined);
  assert.deepEqual(sanitizeCheck({ type: 'after-time', value: ' 2030 ' }), { type: 'after-time', value: '2030' });
});

test('a failed probe advances the backoff with no history row', () => {
  const { goals } = setup();
  const g = goals.create({ title: 'G', successCriteria: 'C?', phases: [{ key: 'a', title: 'A' }] });
  goals.activate(g.goalId);
  goals.block(g.goalId, 'waiting', 'when ready', { code: 'achiever_declared', check: { type: 'after-time', value: '2030-01-01T00:00:00Z' } });
  const before = goals.fullHistory(g.goalId).length;
  const first = goals.get(g.goalId)!;
  goals.deferRetry(g.goalId);
  const second = goals.get(g.goalId)!;
  assert.equal(second.blockCount, first.blockCount! + 1);
  assert.ok(Date.parse(second.nextRetryAt!) > Date.parse(first.nextRetryAt!));
  assert.equal(goals.fullHistory(g.goalId).length, before);
});

// ── Review fixes, 11-06 ─────────────────────────────────────────────────────

test('coalesced blocks show the latest cause, not the first', () => {
  const rows = [
    { kind: 'block', code: 'achiever_no_progress', reason: 'old', at: '2026-11-01T00:00:00Z' },
    { kind: 'resume', at: '2026-11-01T01:00:00Z' },
    { kind: 'block', code: 'achiever_no_progress', reason: 'empty reply', at: '2026-11-01T02:00:00Z' }
  ] as any[];
  const [row] = coalesceHistory(rows);
  assert.equal(row.reason, 'empty reply');
  assert.equal(row.count, 2);
  assert.equal(coalesceHistory([row]).length, 1, 'coalescing a coalesced row changes nothing');
});

test('a raised budget stops asking the reader to raise it', () => {
  const blocked = (over: Partial<GoalRecord>) => rec({ status: 'blocked', blockCode: 'budget_exhausted', blockReason: 'x', ...over });
  const tasks = [task({ context: { goalGenerated: true, role: 'goal-achiever' } })];
  assert.equal(deriveDisplayState(blocked({ stepBudget: 1 }), tasks).state, 'needs-you');
  const raised = deriveDisplayState(blocked({ stepBudget: 2 }), tasks);
  assert.equal(raised.state, 'retrying');
  assert.equal(raised.line, 'Back under budget');
});

test('a timed check retries when it passes, not after the backoff', () => {
  const { goals } = setup();
  const g = goals.create({ title: 'T', successCriteria: 'C?', phases: [{ key: 'a', title: 'A' }] });
  goals.activate(g.goalId);
  const at = new Date(Date.now() + 60_000).toISOString();
  goals.block(g.goalId, 'waiting', 'later', { code: 'achiever_declared', check: { type: 'after-time', value: at } });
  for (let i = 0; i < 4; i++) goals.deferRetry(g.goalId);
  assert.equal(goals.get(g.goalId)!.nextRetryAt, at);
});

test('an accepted block clears the rejected-move note', () => {
  const { goals } = setup();
  const g = goals.create({ title: 'T', successCriteria: 'C?', phases: [] });
  goals.update(g.goalId, { phases: [{ key: 'a', title: 'A' }] });
  goals.activate(g.goalId);
  goals.applyAchieverDecision(g.goalId, { kind: 'plan', phase: { key: 'BAD KEY', title: 'x' }, reason: 'r' } as any);
  assert.ok(goals.get(g.goalId)!.lastRejected);
  goals.applyAchieverDecision(g.goalId, { kind: 'block', reason: 'stuck', unblockCriteria: 'later' } as any);
  assert.equal(goals.get(g.goalId)!.lastRejected, undefined);
});

test('Retry now clears a rate-limit hold on an active goal', () => {
  const { goals } = setup();
  const g = goals.create({ title: 'T', successCriteria: 'C?', phases: [{ key: 'a', title: 'A' }] });
  goals.activate(g.goalId);
  goals.holdForRateLimit(g.goalId, '2030-01-01T00:00:00.000Z');
  goals.activate(g.goalId, { auto: true });
  assert.ok(goals.get(g.goalId)!.achieverRetryAt, 'the drive loop does not clear it');
  goals.activate(g.goalId);
  assert.equal(goals.get(g.goalId)!.achieverRetryAt, undefined);
});

test('a block the server can check itself does not ask for the reader', () => {
  const r = rec({ status: 'blocked', blockCode: 'achiever_declared', unblockCriteria: 'Reset passes', unblockCheck: { type: 'after-time', value: '2030-01-01T00:00:00Z' } });
  const d = deriveDisplayState(r, [], { now: NOW });
  assert.equal(d.state, 'retrying');
  assert.match(d.line, /Reset passes/);
});

test('token-budget display follows the full count, Achiever turns included', () => {
  const r = rec({ status: 'blocked', blockCode: 'token_budget', blockReason: 'x', tokenBudget: 1000 });
  assert.equal(deriveDisplayState(r, [], { now: NOW, overTokens: true }).state, 'needs-you');
  assert.equal(deriveDisplayState(r, [], { now: NOW, overTokens: false }).state, 'retrying');
});

test('a resumed goal tells the Achiever what it was held on, until a move progresses', () => {
  const { goals } = setup();
  const g = goals.create({ title: 'T', successCriteria: 'C?', phases: [{ key: 'a', title: 'A' }] });
  goals.activate(g.goalId);
  goals.block(g.goalId, 'LINE login expired', 'Login works', { code: 'achiever_declared' });
  goals.activate(g.goalId, { auto: true });
  const ctx = goals.achieverContext(g.goalId)!;
  assert.match(buildAchieverPrompt(ctx as any), /RESUMED FROM A BLOCK: LINE login expired Resume condition: Login works/);
  goals.applyAchieverDecision(g.goalId, { kind: 'plan', phase: { key: 'next', title: 'N' }, reason: 'r' } as any);
  assert.equal(goals.get(g.goalId)!.lastBlock, undefined);
});
