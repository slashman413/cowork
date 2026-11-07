import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LEGACY_REGISTER_KEY, legacyWireMiddleware, normalizeTaskContext, withLegacyPin } from './legacy-wire.js';

// The retired names live in the alias table, the same place the code reads them from.
const OLD: string = JSON.parse(fs.readFileSync(new URL('../legacy-aliases.json', import.meta.url), 'utf-8')).contextKey;

test('a current context passes through untouched', () => {
  const ctx = { agent: 'local-cc-opus-5-5', persona: 'engineering-x', thinking: 'high' };
  assert.deepEqual(normalizeTaskContext(ctx), ctx);
});

test('an old context: the pin moves to agent, and the old agent was the persona', () => {
  const out = normalizeTaskContext({ [OLD]: 'local-cc-opus-5-5', agent: 'engineering-x' });
  assert.deepEqual(out, { agent: 'local-cc-opus-5-5', persona: 'engineering-x' });
});

test('a bare persona slug in agent moves to persona; a known id or prefixed id stays', () => {
  assert.deepEqual(normalizeTaskContext({ agent: 'engineering-x' }), { persona: 'engineering-x' });
  assert.deepEqual(normalizeTaskContext({ agent: 'remote-box-cc' }), { agent: 'remote-box-cc' });
  assert.deepEqual(normalizeTaskContext({ agent: 'mine' }, id => id === 'mine'), { agent: 'mine' });
});

test('a level in the id becomes thinking, and an explicit level wins', () => {
  assert.deepEqual(normalizeTaskContext({ agent: 'local-agy-g-high' }), { agent: 'local-agy-g', thinking: 'high' });
  assert.deepEqual(normalizeTaskContext({ agent: 'local-agy-g-high', thinking: 'low' }), { agent: 'local-agy-g', thinking: 'low' });
  assert.deepEqual(normalizeTaskContext({ thinking: 'nonsense' }), {});
});

test('the middleware rewrites retired routes and body keys', () => {
  const req: any = { url: '/api/' + OLD + 's/x/disable', body: { [OLD]: 'local-a' } };
  legacyWireMiddleware(req, {} as any, () => {});
  assert.equal(req.url, '/api/agents/x/disable');
  assert.deepEqual(req.body, { agent: 'local-a' });
});

test('old clients still see their pin key, and the register key is the retired name', () => {
  assert.equal(withLegacyPin({ context: { agent: 'a' } }).context![OLD], 'a');
  assert.equal(LEGACY_REGISTER_KEY, OLD + 's');
});
