import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { assertTier, agentFamily, mergeTierChain, reviewChain, taskTier } from './tiers.js';
import type { Config, Task } from '../types.js';

/**
 * Role → agent tiers (plan item P1-4): a task tagged context.tier runs on the
 * tier's agents first, then its normal chain (dedup); an untagged task's chain
 * is unchanged; `review` picks a different model family than the executor.
 */

const AGENTS = {
  'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' },
  'remote-x-cc-opus-5-5': { location: 'remote', exec: 'claude', model: 'claude-opus-5-5' },
  'local-agy-claude-opus-5-5': { location: 'local', exec: 'agy', model: 'claude-opus-5-5' },
  'local-agy-gemini-4-argon': { location: 'local', exec: 'agy', model: 'gemini-4-argon' },
  'local-agy-gemini-3.8-flash': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash' },
  'local-agy-gemini-3.8-flash-lite': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-lite', disabled: true },
  'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh', model: 'qwen3.8-27b' },
} as Record<string, any>;
const DEFAULT = ['local-cc-opus-5-5', 'local-agy-claude-opus-5-5', 'local-agy-gemini-3.8-flash', 'local-dsh-qwen3-8-27b'];
const TIERS = {
  mechanical: ['local-dsh-qwen3-8-27b', 'local-agy-gemini-3.8-flash-lite', 'local-agy-gemini-3.8-flash'],
  standard: ['local-agy-gemini-4-argon', 'local-agy-claude-opus-5-5'],
  judgment: ['local-cc-opus-5-5', 'remote-x-cc-opus-5-5'],
};

function harness(orch: Record<string, any> = {}) {
  const tasks = new Map<string, Task>();
  const store = {
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    getPersona: (slug: string) => (slug === 'backend' ? { slug, name: 'Backend', division: 'engineering' } : null),
    agentCooldownUntil: (_id: string) => undefined,
  };
  const config = {
    paths: { status: fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-tier-')) },
    inbox: { maxRetries: 3 },
    orchestration: { agents: {}, agents: AGENTS, defaultChain: DEFAULT, tiers: TIERS, ...orch },
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
  const t = put({ persona: 'backend', tier: 'mechanical' });
  assert.deepEqual(chain(t), [
    'local-dsh-qwen3-8-27b', 'local-agy-gemini-3.8-flash',      // tier list (flash-lite disabled)
    'local-cc-opus-5-5', 'local-agy-claude-opus-5-5',          // then the default chain, minus repeats
  ]);
  const p = plan(t);
  assert.equal(p.action, 'execute');
  assert.equal(p.exec.agentId, 'local-dsh-qwen3-8-27b', 'first attempt runs on the mechanical tier, not opus');
});

test('standard and judgment tiers lead with their own lists', () => {
  const { put, chain } = harness();
  assert.deepEqual(chain(put({ persona: 'backend', tier: 'standard' })).slice(0, 3),
    ['local-agy-gemini-4-argon', 'local-agy-claude-opus-5-5', 'local-cc-opus-5-5']);
  assert.deepEqual(chain(put({ persona: 'backend', tier: 'judgment' })).slice(0, 2),
    ['local-cc-opus-5-5', 'remote-x-cc-opus-5-5']);
});

test('an untagged task keeps exactly the old chain', () => {
  const { put, chain, plan } = harness();
  const t = put({ persona: 'backend' });
  assert.deepEqual(chain(t), DEFAULT);
  assert.equal(plan(t).exec.agentId, 'local-cc-opus-5-5');
  assert.deepEqual(chain(put({ persona: 'backend', tier: 'bogus' })), DEFAULT, 'unknown tier is ignored at dispatch');
});

test('a tier does not override a pinned agent or an personaChains override', () => {
  const { put, plan, chain } = harness({ personaChains: { backend: ['local-cc-opus-5-5'] } });
  assert.deepEqual(chain(put({ persona: 'backend', tier: 'mechanical' })), ['local-cc-opus-5-5']);
  const p = plan(put({ persona: 'backend', tier: 'mechanical', agent: 'local-agy-gemini-4-argon' }));
  assert.equal(p.exec.agentId, 'local-agy-gemini-4-argon');
});

test('no tiers configured → a tagged task falls back to its normal chain', () => {
  const { put, chain } = harness({ tiers: undefined });
  assert.deepEqual(chain(put({ persona: 'backend', tier: 'judgment' })), DEFAULT);
});

test('review tier: Gemini judges Claude, opus-class judges Gemini/qwen', () => {
  assert.deepEqual(reviewChain('local-cc-opus-5-5', TIERS, AGENTS),
    ['local-agy-gemini-4-argon', 'local-agy-gemini-3.8-flash']);
  assert.deepEqual(reviewChain('local-agy-gemini-4-argon', TIERS, AGENTS).slice(0, 2),
    ['local-cc-opus-5-5', 'remote-x-cc-opus-5-5']);
  assert.ok(reviewChain('local-dsh-qwen3-8-27b', TIERS, AGENTS).every(id => agentFamily(AGENTS[id], id) === 'claude'));
  const { put, chain } = harness();
  assert.equal(chain(put({ persona: 'backend', tier: 'review', reviewOf: 'local-cc-opus-5-5' }))[0], 'local-agy-gemini-4-argon');
  assert.equal(chain(put({ persona: 'backend', tier: 'review' }))[0], 'local-cc-opus-5-5', 'no reviewOf → judgment list');
});

test('helpers: taskTier / assertTier / mergeTierChain / agentFamily', () => {
  assert.equal(taskTier({ tier: ' Mechanical ' }), 'mechanical');
  assert.equal(taskTier({ tier: 'nope' }), undefined);
  assert.equal(taskTier(undefined), undefined);
  assert.throws(() => assertTier('fast'), /must be one of/);
  assert.doesNotThrow(() => assertTier(undefined));
  assert.deepEqual(mergeTierChain(['a', 'b'], ['b', 'c', 'a']), ['a', 'b', 'c']);
  assert.equal(agentFamily(AGENTS['local-agy-claude-opus-5-5']), 'claude');
  assert.equal(agentFamily(AGENTS['local-dsh-qwen3-8-27b']), 'qwen');
  assert.equal(agentFamily(AGENTS['local-agy-gemini-4-argon']), 'gemini');
});
