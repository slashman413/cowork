import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { VoiceAssistant, parseVoiceReply, normalizePlan, looksLikeApproval, loadGrillingSkill } from './voice-assistant.js';
import { Goals } from './goals.js';
import { isConversational } from './dispatcher.js';
import type { Config, Task } from '../types.js';

/** In-memory Store stand-in: tasks + a controllable rate-limit cooldown map. */
class FakeStore {
  tasks: Task[] = [];
  cooling = new Map<string, string>();
  agents: Array<{ capabilities?: string[]; lastHeartbeat: string }> = [];
  createTask(params: any): Task {
    const t = { ...params, id: uuidv4(), status: 'pending', createdAt: new Date().toISOString() } as Task;
    this.tasks.push(t);
    return t;
  }
  getTask(id: string) { return this.tasks.find(t => t.id === id) || null; }
  saveTask(t: Task) { const i = this.tasks.findIndex(x => x.id === t.id); if (i >= 0) this.tasks[i] = t; }
  deleteTask(id: string) { this.tasks = this.tasks.filter(t => t.id !== id); }
  listTasks() { return this.tasks; }
  brainCooldownUntil(id: string) { return this.cooling.get(id); }
  getActiveAgents() { return this.agents; }
  finish(id: string, result: string, extra: Partial<Task> = {}) { Object.assign(this.getTask(id)!, { status: 'done', result, ...extra }); }
}

const BRAINS = {
  'local-dsh': { location: 'local', exec: 'dsh', model: 'qwen', description: '' },
  'local-opus': { location: 'local', exec: 'claude', model: 'claude-opus-5-5', description: '' },
  'local-sonnet': { location: 'local', exec: 'claude', model: 'claude-sonnet-5', description: '' },
  'local-off': { location: 'local', exec: 'claude', model: 'x', disabled: true, description: '' },
  'remote-x': { location: 'remote', exec: 'claude', model: 'x', description: '' },
  'script-y': { location: 'local', exec: 'script', model: '', description: '' },
};

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  const config = {
    paths: { goals: path.join(base, 'goals') },
    orchestration: { brains: BRAINS, defaultChain: ['local-opus', 'local-dsh'] },
  } as unknown as Config;
  fs.mkdirSync(config.paths.goals, { recursive: true });
  const store = new FakeStore();
  const goals = new Goals(config, store as any);
  let kicks = 0;
  const va = new VoiceAssistant(config, store as any, goals, () => { kicks++; }, base);
  return { va, store, goals, base, kicks: () => kicks };
}

const PLAN = { title: 'Landing page', summary: 'Ship it.', deliverable: 'index.html', successCriteria: 'Is the page live?', phases: [{ key: 'build', title: 'Build page' }, { key: 'Deploy It!', title: 'Deploy' }] };
const reply = (speech: string, state: object) => `${speech}\n\n\`\`\`voice-state\n${JSON.stringify(state)}\n\`\`\``;

test('parseVoiceReply splits speech from the voice-state block', () => {
  const r = parseVoiceReply(reply('Who is it for? I recommend developers.', { phase: 'grilling', ambiguities: ['audience'], plan: null, userApproved: false }));
  assert.equal(r.speech, 'Who is it for? I recommend developers.');
  assert.equal(r.state?.phase, 'grilling');
  assert.deepEqual(r.state?.ambiguities, ['audience']);
  // No block → all speech, null state; bare trailing JSON is accepted too.
  assert.deepEqual(parseVoiceReply('Just talking.'), { speech: 'Just talking.', state: null });
  assert.equal(parseVoiceReply('Hi.\n{"phase":"grilling","ambiguities":[]}').state?.phase, 'grilling');
  // Malformed JSON → state null, speech kept.
  assert.equal(parseVoiceReply('Hey.\n```voice-state\n{"phase": nope}\n```').speech, 'Hey.');
});

test('normalizePlan enforces criterion + kebab-case unique phase keys', () => {
  const p = normalizePlan(PLAN)!;
  assert.deepEqual(p.phases.map(x => x.key), ['build', 'deploy-it']);
  assert.equal(normalizePlan({ ...PLAN, successCriteria: '' }), null);
  assert.equal(normalizePlan({ ...PLAN, phases: [] }), null);
  assert.deepEqual(normalizePlan({ ...PLAN, phases: [{ title: 'A' }, { title: 'a' }] })!.phases.map(x => x.key), ['a', 'a-x']);
});

test('looksLikeApproval accepts go-aheads and rejects hedges (EN + ZH)', () => {
  for (const t of ['Yes, go ahead', 'sounds good', 'do it', 'approved', '好，開始吧', '可以']) assert.ok(looksLikeApproval(t), t);
  for (const t of ['no', 'wait, change phase 2', 'yes but use React', 'not yet', '等等', '不要']) assert.ok(!looksLikeApproval(t), t);
});

test('grill-me skill text is loaded from the installed skill, else a built-in copy', () => {
  const { base } = setup();
  assert.match(loadGrillingSkill(base), /one at a time/);
  const dir = path.join(base, '.claude', 'skills', 'grilling');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: grilling\n---\nCUSTOM GRILL TEXT');
  assert.equal(loadGrillingSkill(base), 'CUSTOM GRILL TEXT');
});

test('availableBrains: skips disabled, script, offline remote and cooling; ranks by capability', () => {
  const { va, store } = setup();
  assert.deepEqual(va.availableBrains().available.map(b => b.id), ['local-opus', 'local-sonnet', 'local-dsh']);
  store.cooling.set('local-opus', new Date(Date.now() + 60_000).toISOString());
  store.agents.push({ capabilities: ['remote-x'], lastHeartbeat: new Date().toISOString() });
  const r = va.availableBrains();
  assert.deepEqual(r.available.map(b => b.id), ['local-sonnet', 'remote-x', 'local-dsh']);
  assert.deepEqual(r.cooling.map(c => c.id), ['local-opus']);
});

test('a turn is a conversational task pinned to the best brain, and the prompt embeds grill-me', () => {
  const { va, store, kicks } = setup();
  const s = va.create();
  const after = va.turn(s.id, 'I want to build a habit tracker');
  assert.equal(after.title, 'I want to build a habit tracker');
  const t = store.tasks[0];
  assert.equal(t.context?.brain, 'local-opus');
  assert.equal(t.context?.conversational, true);
  assert.ok(isConversational(t));
  assert.deepEqual(t.tags, ['chat', 'voice']);
  assert.match(t.description, /grill-me/);
  assert.match(t.description, /I want to build a habit tracker/);
  assert.match(t.description, /voice-state/);
  assert.equal(kicks(), 1);
  // A second message while thinking is refused (409).
  assert.throws(() => va.turn(s.id, 'hello?'), (e: any) => e.status === 409);
});

test('full flow: grill → plan-ready → spoken approval starts a Goal → progress → done', () => {
  const { va, store, goals } = setup();
  const s = va.create();
  va.turn(s.id, 'Landing page for my app');
  store.finish(store.tasks[0].id, reply('Who is it for? I recommend developers.', { phase: 'grilling', ambiguities: ['audience'], plan: null, userApproved: false }));
  let g = va.get(s.id)!;
  assert.equal(g.phase, 'grilling');
  assert.equal(g.messages.at(-1)!.content, 'Who is it for? I recommend developers.');
  assert.equal(g.pending, undefined);

  // Brain claims userApproved while still grilling → must NOT execute (no plan was on the table).
  va.turn(s.id, 'Developers. yes go');
  store.finish(store.tasks[1].id, reply('Here is the plan. Go ahead?', { phase: 'plan-ready', ambiguities: [], plan: PLAN, userApproved: true }));
  g = va.get(s.id)!;
  assert.equal(g.phase, 'plan-ready');
  assert.equal(g.goalId, undefined);
  assert.equal(g.plan?.phases.length, 2);

  // Spoken approval while plan-ready → Goal created + activated.
  va.turn(s.id, 'Yes, go ahead');
  assert.match(store.tasks[2].description, /phase: plan-ready/);
  store.finish(store.tasks[2].id, reply('Starting now.', { phase: 'plan-ready', ambiguities: [], plan: null, userApproved: true }));
  g = va.get(s.id)!;
  assert.equal(g.phase, 'executing');
  assert.ok(g.goalId);
  const goal = goals.get(g.goalId!)!;
  assert.equal(goal.status, 'active');
  assert.equal(goal.successCriteria, 'Is the page live?');
  assert.deepEqual(goal.phases.map(p => p.key), ['build', 'deploy-it']);
  assert.deepEqual(goal.achieverBrainChain, ['local-opus', 'local-sonnet', 'local-dsh']);
  assert.match(goal.description, /Think deeply and thoroughly/);
  assert.match(goal.description, /Landing page for my app/);
  assert.equal(g.goal?.status, 'active');

  // Goal progress is announced once per change, and achievement ends the session.
  const rec = JSON.parse(fs.readFileSync(path.join(path.dirname((va as any).config.paths.goals), 'goals', `${g.goalId}.json`), 'utf8'));
  rec.phases[0].status = 'audited'; rec.status = 'achieved'; rec.closedReason = 'Page is live.';
  fs.writeFileSync(path.join((va as any).config.paths.goals, `${g.goalId}.json`), JSON.stringify(rec));
  const n0 = va.get(s.id)!.messages.length;
  g = va.get(s.id)!;
  assert.equal(g.phase, 'done');
  assert.equal(g.messages.length, n0);   // no duplicate announcement on re-read
  assert.ok(g.messages.some(m => /Build page" is complete/.test(m.content)));
  assert.ok(g.messages.some(m => /goal is achieved/.test(m.content)));
});

test('approval with a hedge ("yes but …") does not execute even if the brain says approved', () => {
  const { va, store } = setup();
  const s = va.create();
  va.turn(s.id, 'idea');
  store.finish(store.tasks[0].id, reply('Plan?', { phase: 'plan-ready', ambiguities: [], plan: PLAN, userApproved: false }));
  va.get(s.id);
  va.turn(s.id, 'yes but make phase 2 a blog');
  store.finish(store.tasks[1].id, reply('Ok.', { phase: 'plan-ready', ambiguities: [], plan: PLAN, userApproved: true }));
  assert.equal(va.get(s.id)!.goalId, undefined);
});

test('execute(): Approve button needs a plan; then creates exactly one goal', () => {
  const { va, store } = setup();
  const s = va.create();
  assert.throws(() => va.execute(s.id), /no agreed plan/);
  va.turn(s.id, 'idea');
  store.finish(store.tasks[0].id, reply('Plan ready.', { phase: 'plan-ready', ambiguities: [], plan: PLAN, userApproved: false }));
  const r = va.execute(s.id);
  assert.equal(r.phase, 'executing');
  assert.throws(() => va.execute(s.id), /already executing/);
});

test('a rate-limited turn fails over to the next available brain', () => {
  const { va, store } = setup();
  const s = va.create();
  va.turn(s.id, 'idea');
  // (a) pinned brain starts cooling before it runs → turn moves to the next brain.
  store.cooling.set('local-opus', new Date(Date.now() + 60_000).toISOString());
  let g = va.get(s.id)!;
  assert.equal(store.tasks[0].context?.brain, 'local-sonnet');
  assert.deepEqual(g.pending?.tried, ['local-opus', 'local-sonnet']);
  // (b) the run itself fails (chain exhausted) → retried on a fresh task, next brain.
  store.finish(store.tasks[0].id, 'rate limit reached', { failed: true } as any);
  store.cooling.set('local-sonnet', new Date(Date.now() + 60_000).toISOString());
  g = va.get(s.id)!;
  assert.equal(store.tasks.length, 2);
  assert.equal(store.tasks[1].context?.brain, 'local-dsh');
  // (c) last allowed brain fails too → honest error, no more retries.
  store.finish(store.tasks[1].id, 'boom', { failed: true } as any);
  g = va.get(s.id)!;
  assert.equal(g.pending, undefined);
  assert.match(g.messages.at(-1)!.content, /couldn't answer/);
});

test('no available brain → a system message instead of a stuck turn', () => {
  const { va, store } = setup();
  for (const id of ['local-opus', 'local-sonnet', 'local-dsh']) store.cooling.set(id, new Date(Date.now() + 60_000).toISOString());
  const s = va.create();
  const r = va.turn(s.id, 'idea');
  assert.equal(r.pending, undefined);
  assert.match(r.messages.at(-1)!.content, /No brain is available/);
});

test('list / delete; delete cancels the in-flight turn; ids are validated', () => {
  const { va, store } = setup();
  const s = va.create('My idea');
  va.turn(s.id, 'x');
  assert.equal(va.list().length, 1);
  va.delete(s.id);
  assert.equal(va.list().length, 0);
  assert.equal(store.tasks.length, 0);
  assert.equal(va.get('../../etc/passwd'), null);   // traversal ids never touch disk
  assert.throws(() => va.turn('../x', 'hi'), /not found/);
});
