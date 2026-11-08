import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { capThinking, guessWorkRole, resolveWorkRoles, workRoleContext, DEFAULT_WORK_ROLES } from './work-roles.js';
import type { Config, Task } from '../types.js';

/**
 * Work roles (setup-pstack port): the router names the kind of work, which sets
 * context.tier + context.thinking (capped by the budget) unless the task set them.
 */

test('budget is a ceiling, labels match setup-pstack', () => {
  assert.equal(capThinking('xhigh', 'large'), 'xhigh');
  assert.equal(capThinking('xhigh', 'medium'), 'high');
  assert.equal(capThinking('high', 'small'), 'medium');
  assert.equal(capThinking('low', 'unlimited'), 'low', 'a ceiling never raises a level');
  assert.equal(capThinking('max'), 'max');
});

test('role ids never collide with division ids (one reply carries both)', () => {
  const divisions = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../agency-agents/divisions.json'), 'utf8')).divisions;
  const ids = Array.isArray(divisions) ? divisions.map((d: any) => d.id || d) : Object.keys(divisions);
  for (const r of Object.keys(DEFAULT_WORK_ROLES)) assert.ok(!ids.includes(r), `${r} is also a division id`);
});

test('config overrides merge by id; incomplete new roles are ignored', () => {
  const roles = resolveWorkRoles({ enabled: true, roles: { research: { thinking: 'high' }, video: { tier: 'standard' } as any, bad: { tier: 'review' as any, thinking: 'low' } } });
  assert.equal(roles.research.thinking, 'high');
  assert.equal(roles.research.tier, 'standard');
  assert.equal(roles.video, undefined);
  assert.equal(roles.bad, undefined);
});

test('keyword fallback', () => {
  const r = DEFAULT_WORK_ROLES;
  assert.equal(guessWorkRole('Fix the 500 error on /store', r), 'bug-fix');
  assert.equal(guessWorkRole('Dashboard is slow, optimise it', r), 'perf-issue');
  assert.equal(guessWorkRole('Write a blog article about lofi', r), 'prose');
  assert.equal(guessWorkRole('Survey what the skill does', r), 'research');
  assert.equal(guessWorkRole('xyzzy', r), 'feature');
});

test('explicit tier / thinking / pinned agent win over the role', () => {
  const r = DEFAULT_WORK_ROLES;
  assert.deepEqual(workRoleContext('hardest', r, {}, 'large'), { workRole: 'hardest', tier: 'judgment', thinking: 'xhigh' });
  assert.deepEqual(workRoleContext('hardest', r, {}, 'medium'), { workRole: 'hardest', tier: 'judgment', thinking: 'high' });
  assert.deepEqual(workRoleContext('hardest', r, { tier: 'standard', thinking: 'low' }), { workRole: 'hardest' });
  assert.deepEqual(workRoleContext('mechanical', r, { agent: 'local-cc-opus-5-5' }), { workRole: 'mechanical', thinking: 'low' });
  assert.deepEqual(workRoleContext('nope', r, {}), {});
});

function harness(orch: Record<string, any>, reply: (prompt: string) => string) {
  const tasks = new Map<string, Task>();
  const store = {
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    divisionIds: () => ['engineering', 'marketing'],
    getDivisions: () => ({}),
    personasInDivision: (div: string) => div === 'engineering'
      ? [{ slug: 'engineering-backend-architect', name: 'Backend', description: '' }, { slug: 'engineering-sre', name: 'SRE', description: '' }]
      : [{ slug: 'marketing-seo', name: 'SEO', description: '' }],
  };
  const config = {
    paths: { status: fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-wr-')) },
    inbox: { maxRetries: 3 },
    orchestration: { agents: {}, roleChains: {}, defaultChain: [], classifier: { enabled: true, exec: 'agy', model: 'gemini-3.8-flash', fallbackRole: 'generalist', timeoutMs: 1000 }, ...orch },
  } as unknown as Config;
  const d = new Dispatcher(config, store as any, {} as any);
  const prompts: string[] = [];
  (d as any).askRouter = async (p: string) => { prompts.push(p); return reply(p); };
  const put = (title: string, context: Record<string, any> = {}) => {
    const t = { id: `t${tasks.size + 1}`, title, description: '', status: 'pending', context } as Task;
    tasks.set(t.id, t);
    return t;
  };
  const route = async (t: Task) => { (d as any).route(t); for (let i = 0; i < 20 && (d as any).classifying.has(t.id); i++) await new Promise(r => setTimeout(r, 5)); return tasks.get(t.id)!; };
  return { put, route, prompts };
}

test('router sets persona + tier + thinking from one reply', async () => {
  const h = harness({ workRoles: { enabled: true, budget: 'large' } },
    p => p.includes('Work roles') ? 'engineering hardest' : 'engineering-sre');
  const t = await h.route(h.put('Redesign the dispatcher'));
  assert.equal(t.context!.persona, 'engineering-sre');
  assert.equal(t.context!.division, 'engineering');
  assert.equal(t.context!.workRole, 'hardest');
  assert.equal(t.context!.tier, 'judgment');
  assert.equal(t.context!.thinking, 'xhigh');
});

test('a task-set thinking survives routing', async () => {
  const h = harness({ workRoles: { enabled: true, budget: 'large' } },
    p => p.includes('Work roles') ? 'engineering mechanical' : 'engineering-sre');
  const t = await h.route(h.put('Rename files', { thinking: 'high' }));
  assert.equal(t.context!.thinking, 'high');
  assert.equal(t.context!.tier, 'mechanical');
});

test('empty router reply → generalist (not divisions[0]), keyword role still applied', async () => {
  const h = harness({ workRoles: { enabled: true, budget: 'large' } }, () => '');
  const t = await h.route(h.put('Fix the broken checkout button'));
  assert.equal(t.context!.persona, 'generalist');
  assert.equal(t.context!.division, undefined);
  assert.equal(t.context!.workRole, 'bug-fix');
  assert.equal(t.context!.thinking, 'high');
});

test('workRoles disabled → prompt and context unchanged', async () => {
  const h = harness({}, p => p.includes('division') ? 'marketing' : 'marketing-seo');
  const t = await h.route(h.put('Fix SEO'));
  assert.equal(t.context!.persona, 'marketing-seo');
  assert.equal(t.context!.workRole, undefined);
  assert.equal(t.context!.thinking, undefined);
  assert.ok(!h.prompts[0].includes('Work roles'));
});
