import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ClientGuard, normalizeIp } from './client-guard.js';

const CFG = { ips: ['100.117.16.77', 'fd7a:115c:a1e0::4936:104d'], names: ['ai-code-gen'] };
const req = (over: Partial<{ ip: string; headers: Record<string, unknown>; path: string; body: unknown }> = {}) =>
  ({ ip: '100.80.243.33', headers: { 'user-agent': 'node' }, path: '/api/tasks', ...over });

test('normalizeIp strips IPv4-mapped prefix and brackets', () => {
  assert.equal(normalizeIp('::ffff:100.117.16.77'), '100.117.16.77');
  assert.equal(normalizeIp('[FD7A:115C:A1E0::4936:104D]'), 'fd7a:115c:a1e0::4936:104d');
});

test('inactive guard blocks nothing', () => {
  const g = new ClientGuard(undefined);
  assert.equal(g.active, false);
  assert.equal(g.check(req({ ip: '100.117.16.77' })).blocked, false);
});

test('blocks by source ip (v4, mapped v4, v6) on any path', () => {
  const g = new ClientGuard(CFG);
  assert.equal(g.check(req({ ip: '100.117.16.77', path: '/' })).blocked, true);
  assert.equal(g.check(req({ ip: '::ffff:100.117.16.77' })).blocked, true);
  assert.equal(g.check(req({ ip: 'fd7a:115c:a1e0::4936:104d' })).blocked, true);
  assert.equal(g.check(req()).blocked, false);
});

test('blocks by identity headers', () => {
  const g = new ClientGuard(CFG);
  assert.equal(g.check(req({ headers: { 'user-agent': 'remote-brain AI-Code-Gen/1.0' } })).blocked, true);
  assert.equal(g.check(req({ headers: { 'x-cowork-client': 'ai-code-gen' } })).blocked, true);
});

test('blocks MCP initialize from a blocked clientInfo name', () => {
  const g = new ClientGuard(CFG);
  const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'remote-brain:ai-code-gen' } } };
  assert.equal(g.check(req({ path: '/mcp', body })).blocked, true);
  const ok = { ...body, params: { clientInfo: { name: 'remote-brain:aitopatom' } } };
  assert.equal(g.check(req({ path: '/mcp', body: ok })).blocked, false);
});

test('blocks MCP register_agent declaring a blocked agent name or brain', () => {
  const g = new ClientGuard(CFG);
  const call = (args: unknown) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'register_agent', arguments: args } });
  assert.equal(g.check(req({ path: '/mcp', body: call({ platform: 'claude', agent_name: 'ai-code-gen' }) })).blocked, true);
  assert.equal(g.check(req({ path: '/mcp', body: call({ platform: 'claude', agent_name: 'x', brains: [{ id: 'remote-ai-code-gen-cc-opus-5-5' }] }) })).blocked, true);
  assert.equal(g.check(req({ path: '/mcp', body: call({ platform: 'claude', agent_name: 'x', capabilities: ['remote-ai-code-gen-cc-fable-5-1'] }) })).blocked, true);
  assert.equal(g.check(req({ path: '/mcp', body: [call({ platform: 'claude', agent_name: 'ok' }), call({ platform: 'claude', agent_name: 'ai-code-gen' })] })).blocked, true);
  assert.equal(g.check(req({ path: '/mcp', body: call({ platform: 'claude', agent_name: 'aitopatom' }) })).blocked, false);
});

test('blocks tool calls carrying a blocked agent_id (live roster or registry owner)', () => {
  const g = new ClientGuard(CFG, () => [{ id: 'a1', agentName: 'ai-code-gen' }, { id: 'a2', agentName: 'ok', capabilities: ['local-x'] }]);
  const call = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(g.check(req({ path: '/mcp', body: call('heartbeat', { agent_id: 'a1' }) })).blocked, true);
  assert.equal(g.check(req({ path: '/mcp', body: call('claim_task', { task_id: 't', agent_id: 'a2' }) })).blocked, false);
  // An agent no longer on the roster but recorded as owner of a blocked brain.
  const owners = g.blockedAgentIds({ 'remote-ai-code-gen-cc-opus-5-5': { registeredBy: 'gone' }, 'local-x': { registeredBy: 'a2' } });
  assert.deepEqual([...owners], ['gone']);
  assert.equal(g.check(req({ path: '/mcp', body: call('complete_task', { task_id: 't', agent_id: 'gone' }) }), owners).blocked, true);
});

test('free-text task fields that mention the name are NOT blocked', () => {
  const g = new ClientGuard(CFG);
  const body = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'reject all ai-code-gen requests', description: 'ai-code-gen' } } };
  assert.equal(g.check(req({ path: '/mcp', body })).blocked, false);
  assert.equal(g.check(req({ path: '/api/tasks', body: { title: 'ai-code-gen' } })).blocked, false);
});

test('disableBlockedBrains marks matching brains disabled only', () => {
  const g = new ClientGuard(CFG);
  const brains: Record<string, { disabled?: boolean; host?: string }> = {
    'remote-ai-code-gen-cc-opus-5-5': {}, 'remote-x': { host: 'ai-code-gen' }, 'local-cc-opus-5-5': {}
  };
  assert.deepEqual(g.disableBlockedBrains(brains).sort(), ['remote-ai-code-gen-cc-opus-5-5', 'remote-x']);
  assert.equal(brains['local-cc-opus-5-5'].disabled, undefined);
  assert.deepEqual(g.disableBlockedBrains(brains), []);
});

test('middleware returns 403 (JSON-RPC error on /mcp) and passes others', async () => {
  const g = new ClientGuard({ names: ['ai-code-gen'] });
  const app = express();
  app.use(express.json());
  app.use(g.middleware(() => new Set()));
  app.post('/mcp', (_q, r) => { r.json({ ok: true }); });
  app.get('/api/x', (_q, r) => { r.json({ ok: true }); });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const init = (name: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { clientInfo: { name } } }) });
    const bad = await init('remote-brain:ai-code-gen');
    assert.equal(bad.status, 403);
    const j = await bad.json();
    assert.equal(j.id, 7);
    assert.equal(j.error.code, -32001);
    assert.equal((await init('claude-code')).status, 200);
    assert.equal((await fetch(`${base}/api/x`, { headers: { 'user-agent': 'ai-code-gen' } })).status, 403);
    assert.equal((await fetch(`${base}/api/x`)).status, 200);
  } finally { srv.close(); }
});
