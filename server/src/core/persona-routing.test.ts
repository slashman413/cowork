import test from 'node:test';
import assert from 'node:assert/strict';
import { modelParamsB, wantsPersonaRouting } from './persona-routing.js';
import { Dispatcher } from './dispatcher.js';

test('modelParamsB reads the parameter count from a model id', () => {
  assert.equal(modelParamsB('qwen3.8-27b'), 27);
  assert.equal(modelParamsB('gpt-oss-120b'), 120);
  assert.equal(modelParamsB('llama3.1:8b'), 8);
  assert.equal(modelParamsB('claude-opus-5-5'), null);
  assert.equal(modelParamsB('gemini-3.8-flash'), null);
  assert.equal(modelParamsB(''), null);
});

test('wantsPersonaRouting: small models yes, large/unknown no, override wins', () => {
  assert.equal(wantsPersonaRouting({ model: 'qwen3.8-27b' }), true);
  assert.equal(wantsPersonaRouting({ model: 'gpt-oss-120b' }), false);
  assert.equal(wantsPersonaRouting({ model: 'claude-sonnet-5-5' }), false);
  assert.equal(wantsPersonaRouting({ model: 'claude-sonnet-5-5', personaRouting: 'always' }), true);
  assert.equal(wantsPersonaRouting({ model: 'qwen3.8-27b', personaRouting: 'never' }), false);
  assert.equal(wantsPersonaRouting(undefined), false);
});

/** planFor only reads config + store lookups, so a bare instance with stubs is enough. */
function planner(agents: Record<string, any>, personas: Record<string, any> = {}) {
  const d = Object.create(Dispatcher.prototype) as any;
  d.config = { orchestration: { agents, roleChains: {}, defaultChain: [], tiers: {} } };
  d.store = { getPersona: (s: string) => personas[s] || null };
  return d;
}
const t = (context: Record<string, any>) => ({ id: 'x', title: 't', description: 'd', tags: [], context }) as any;

test('a task pinned to a small model with no persona is routed first', () => {
  const d = planner({ 'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh', model: 'qwen3.8-27b' } });
  assert.deepEqual(d.planFor(t({ agent: 'local-dsh-qwen3-8-27b' })), { action: 'route' });
});

test('once routed, the small-model pin runs with the persona', () => {
  const d = planner({ 'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh', model: 'qwen3.8-27b' } },
    { 'engineering-backend-architect': { division: 'engineering', name: 'Backend Architect' } });
  const plan = d.planFor(t({ agent: 'local-dsh-qwen3-8-27b', persona: 'engineering-backend-architect' }));
  assert.equal(plan.action, 'execute');
  assert.equal(plan.exec.agentId, 'local-dsh-qwen3-8-27b');
  assert.equal(plan.exec.persona, 'engineering-backend-architect');
  assert.equal(plan.exec.pinned, true);
});

test('a task pinned to a frontier model still runs straight away', () => {
  const d = planner({ 'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' } });
  const plan = d.planFor(t({ agent: 'local-cc-opus-5-5' }));
  assert.equal(plan.action, 'execute');
  assert.equal(plan.exec.persona, '');
});
