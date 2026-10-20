import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { Workflows } from './workflows.js';
import { assertTier, brainFamily, mergeTierChain, reviewChain, taskTier } from './tiers.js';
import type { Config, Task } from '../types.js';

/**
 * Role → brain tiers (plan item P1-4): a task tagged context.tier runs on the
 * tier's brains first, then its normal chain (dedup); an untagged task's chain
 * is unchanged; `review` picks a different model family than the executor.
 */

const BRAINS = {
  'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' },
  'remote-x-cc-opus-5-5': { location: 'remote', exec: 'claude', model: 'claude-opus-5-5' },
  'local-agy-claude-opus-5-5-medium': { location: 'local', exec: 'agy', model: 'claude-opus-5-5-medium' },
  'local-agy-gemini-4-argon-medium': { location: 'local', exec: 'agy', model: 'gemini-4-argon-medium' },
  'local-agy-gemini-3.8-flash-high': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-high' },
  'local-agy-gemini-3.8-flash-low': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-low', disabled: true },
  'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh', model: 'qwen3.8-27b' },
} as Record<string, any>;
const DEFAULT = ['local-cc-opus-5-5', 'local-agy-claude-opus-5-5-medium', 'local-agy-gemini-3.8-flash-high', 'local-dsh-qwen3-8-27b'];
const TIERS = {
  mechanical: ['local-dsh-qwen3-8-27b', 'local-agy-gemini-3.8-flash-low', 'local-agy-gemini-3.8-flash-high'],
  standard: ['local-agy-gemini-4-argon-medium', 'local-agy-claude-opus-5-5-medium'],
  judgment: ['local-cc-opus-5-5', 'remote-x-cc-opus-5-5'],
};

function harness(orch: Record<string, any> = {}) {
  const tasks = new Map<string, Task>();
  const store = {
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    getAgentPersona: (slug: string) => (slug === 'backend' ? { slug, name: 'Backend', division: 'engineering' } : null),
  };
  const config = {
    paths: { status: fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-tier-')) },
    inbox: { maxRetries: 3 },
    orchestration: { agents: {}, brains: BRAINS, defaultChain: DEFAULT, tiers: TIERS, ...orch },
  } as unknown as Config;
  const d = new Dispatcher(config, store as any, {} as any);
  let n = 0;
  const put = (context: Record<string, any>) => {
    const t = { id: `t${++n}`, title: 't', description: '', status: 'pending', context } as Task;
    tasks.set(t.id, t);
    return t;
  };
  const chain = (t: Task) => (d as any).chainFor('backend', 'engineering', t.context) as string[];
  const plan = (t: Task) => (d as any).planFor(t);
  return { d, put, chain, plan };
}

test('a tier-tagged task gets the tier chain, then the default chain, dedup, disabled stripped', () => {
  const { put, chain, plan } = harness();
  const t = put({ agent: 'backend', tier: 'mechanical' });
  assert.deepEqual(chain(t), [
    'local-dsh-qwen3-8-27b', 'local-agy-gemini-3.8-flash-high',      // tier list (flash-low disabled)
    'local-cc-opus-5-5', 'local-agy-claude-opus-5-5-medium',          // then the default chain, minus repeats
  ]);
  const p = plan(t);
  assert.equal(p.action, 'execute');
  assert.equal(p.exec.brainId, 'local-dsh-qwen3-8-27b', 'first attempt runs on the mechanical tier, not opus');
});

test('standard and judgment tiers lead with their own lists', () => {
  const { put, chain } = harness();
  assert.deepEqual(chain(put({ agent: 'backend', tier: 'standard' })).slice(0, 3),
    ['local-agy-gemini-4-argon-medium', 'local-agy-claude-opus-5-5-medium', 'local-cc-opus-5-5']);
  assert.deepEqual(chain(put({ agent: 'backend', tier: 'judgment' })).slice(0, 2),
    ['local-cc-opus-5-5', 'remote-x-cc-opus-5-5']);
});

test('an untagged task keeps exactly the old chain', () => {
  const { put, chain, plan } = harness();
  const t = put({ agent: 'backend' });
  assert.deepEqual(chain(t), DEFAULT);
  assert.equal(plan(t).exec.brainId, 'local-cc-opus-5-5');
  assert.deepEqual(chain(put({ agent: 'backend', tier: 'bogus' })), DEFAULT, 'unknown tier is ignored at dispatch');
});

test('a tier does not override a pinned brain or an agentChains override', () => {
  const { put, plan, chain } = harness({ agentChains: { backend: ['local-cc-opus-5-5'] } });
  assert.deepEqual(chain(put({ agent: 'backend', tier: 'mechanical' })), ['local-cc-opus-5-5']);
  const p = plan(put({ agent: 'backend', tier: 'mechanical', brain: 'local-agy-gemini-4-argon-medium' }));
  assert.equal(p.exec.brainId, 'local-agy-gemini-4-argon-medium');
});

test('no tiers configured → a tagged task falls back to its normal chain', () => {
  const { put, chain } = harness({ tiers: undefined });
  assert.deepEqual(chain(put({ agent: 'backend', tier: 'judgment' })), DEFAULT);
});

test('review tier: Gemini judges Claude, opus-class judges Gemini/qwen', () => {
  assert.deepEqual(reviewChain('local-cc-opus-5-5', TIERS, BRAINS),
    ['local-agy-gemini-4-argon-medium', 'local-agy-gemini-3.8-flash-high']);
  assert.deepEqual(reviewChain('local-agy-gemini-4-argon-medium', TIERS, BRAINS).slice(0, 2),
    ['local-cc-opus-5-5', 'remote-x-cc-opus-5-5']);
  assert.ok(reviewChain('local-dsh-qwen3-8-27b', TIERS, BRAINS).every(id => brainFamily(BRAINS[id], id) === 'claude'));
  const { put, chain } = harness();
  assert.equal(chain(put({ agent: 'backend', tier: 'review', reviewOf: 'local-cc-opus-5-5' }))[0], 'local-agy-gemini-4-argon-medium');
  assert.equal(chain(put({ agent: 'backend', tier: 'review' }))[0], 'local-cc-opus-5-5', 'no reviewOf → judgment list');
});

test('helpers: taskTier / assertTier / mergeTierChain / brainFamily', () => {
  assert.equal(taskTier({ tier: ' Mechanical ' }), 'mechanical');
  assert.equal(taskTier({ tier: 'nope' }), undefined);
  assert.equal(taskTier(undefined), undefined);
  assert.throws(() => assertTier('fast'), /must be one of/);
  assert.doesNotThrow(() => assertTier(undefined));
  assert.deepEqual(mergeTierChain(['a', 'b'], ['b', 'c', 'a']), ['a', 'b', 'c']);
  assert.equal(brainFamily(BRAINS['local-agy-claude-opus-5-5-medium']), 'claude');
  assert.equal(brainFamily(BRAINS['local-dsh-qwen3-8-27b']), 'qwen');
  assert.equal(brainFamily(BRAINS['local-agy-gemini-4-argon-medium']), 'gemini');
});

test('a workflow step tier is copied into the task context and validated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-tier-wf-'));
  const dir = path.join(root, 'workflows');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'tiered.json'), JSON.stringify({
    id: 'tiered', name: 'tiered', steps: [{ key: 'a', title: 'A', tier: 'mechanical' }, { key: 'b', title: 'B', dependsOn: ['a'] }]
  }));
  const created: any[] = [];
  const store = { createTask: (t: any) => { const task = { ...t, id: `id-${created.length}` }; created.push(task); return task; } };
  const wf = new Workflows({ paths: { workflows: dir, workflowRuns: path.join(root, 'runs') } } as unknown as Config, store as any);
  wf.run('tiered');
  assert.equal(created[0].context.tier, 'mechanical');
  assert.equal(created[1].context.tier, undefined, 'untagged step stays untagged');
  assert.ok(wf.validate({ id: 'x', steps: [{ key: 'a', tier: 'fast' }] } as any).some(e => /tier/.test(e)));
});
