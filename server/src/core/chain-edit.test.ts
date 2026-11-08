import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setChain, chainOf, ChainEditError } from './chain-edit.js';

const orch = (): any => ({
  agents: { a: { location: 'local' }, b: { location: 'local' }, off: { location: 'local', disabled: true } },
  roleChains: { orchestrator: { description: 'Routes tasks', agents: ['a', 'off'] } },
  defaultChain: ['a'],
  divisionChains: {},
  personaChains: {},
  tiers: { judgment: ['a'] },
});

test('role chain: adding an agent keeps the role description', () => {
  const o = orch();
  assert.deepEqual(setChain(o, 'role', 'orchestrator', ['a', 'off', 'b']), ['a', 'off', 'b']);
  assert.equal(o.roleChains.orchestrator.description, 'Routes tasks');
});

test('a disabled agent already in a chain can be reordered and removed', () => {
  const o = orch();
  assert.deepEqual(setChain(o, 'role', 'orchestrator', ['off', 'a']), ['off', 'a']);
  assert.deepEqual(setChain(o, 'role', 'orchestrator', ['a']), ['a']);
});

test('a disabled agent cannot be newly added to any chain kind', () => {
  for (const [kind, key] of [['default', ''], ['division', 'eng'], ['persona', 'p'], ['tier', 'standard'], ['role', 'generalist']] as const) {
    assert.throws(() => setChain(orch(), kind, key, ['a', 'off']), ChainEditError, `${kind} accepted a disabled agent`);
  }
});

test('unknown ids are rejected and duplicates collapse', () => {
  assert.throws(() => setChain(orch(), 'default', '', ['nope']), /unknown agent/);
  assert.deepEqual(setChain(orch(), 'default', '', ['b', 'a', 'b']), ['b', 'a']);
});

test('empty division/persona clears the override; tiers must be editable names', () => {
  const o = orch();
  setChain(o, 'division', 'eng', ['b']);
  assert.deepEqual(chainOf(o, 'division', 'eng'), ['b']);
  setChain(o, 'division', 'eng', []);
  assert.equal('eng' in o.divisionChains, false);
  assert.deepEqual(setChain(o, 'tier', 'mechanical', ['b']), ['b']);
  assert.throws(() => setChain(o, 'tier', 'review', ['a']), /tier must be/);
});
