import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Agent renames must not strand anything that still uses a retired id
 * (AGENT_ID_ALIASES): an older on-disk config, a task pinned via context.agent,
 * or a client that keeps declaring its old ids. Pins: the load-time migration,
 * registration under the canonical id + clientId, and the client task view.
 */
function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-alias-'));
  process.env.COWORK_CONFIG = join(dir, 'config.json');
  return dir;
}

test('canonicalAgentId: resolves retired ids, leaves others, honours config aliases', async () => {
  const { canonicalAgentId } = await import('./config.js');
  assert.equal(canonicalAgentId(undefined, 'local-ha-qwen3-8-27b'), 'local-hermes-qwen3.8-27b');
  assert.equal(canonicalAgentId(undefined, 'local-ha-qwen38-27b'), 'local-hermes-qwen3.8-27b');
  assert.equal(canonicalAgentId(undefined, 'remote-codex-gpt-5-6-terra'), 'local-codex-gpt-5-6-terra');
  assert.equal(canonicalAgentId(undefined, 'remote-codex-gpt-6-luna'), 'local-codex-gpt-6-luna');
  assert.equal(canonicalAgentId(undefined, 'local-codex-default'), 'local-codex-default');   // no cycle back
  assert.equal(canonicalAgentId(undefined, 'remote-ai-code-gen-cc-opus'), 'remote-ai-code-gen-cc-opus-4-8');
  assert.equal(canonicalAgentId(undefined, 'local-cc-opus-5-5'), 'local-cc-opus-5-5');
  const cfg: any = { orchestration: { agentAliases: { 'a': 'b', 'b': 'c', 'x': 'y', 'y': 'x' } } };
  assert.equal(canonicalAgentId(cfg, 'a'), 'c');
  assert.ok(['x', 'y'].includes(canonicalAgentId(cfg, 'x')));   // a cycle terminates
});

test('no canonical alias target is denylisted', async () => {
  const { AGENT_ID_ALIASES, isDenylistedAgent } = await import('./config.js');
  for (const target of Object.values(AGENT_ID_ALIASES)) assert.equal(isDenylistedAgent(target), false, target);
});

test('loadConfig: migrates retired ids in the registry and every chain, and persists', async () => {
  const dir = makeConfig();
  try {
    writeFileSync(process.env.COWORK_CONFIG!, JSON.stringify({
      orchestration: {
        agents: {
          'local-ha-qwen3-8-27b': { description: 'q', location: 'local', exec: 'hermes', model: 'qwen3.8-27b' },
          'remote-ai-code-gen-cc-opus': { description: 'o', location: 'remote', exec: 'claude', dynamic: true, registeredBy: 'a1' }
        },
        defaultChain: ['local-ha-qwen3-8-27b', 'local-hermes-qwen3.8-27b', 'remote-ai-code-gen-cc-opus'],
        divisionChains: { engineering: ['remote-ai-code-gen-cc-opus'] },
        personaChains: { 'product-manager': ['local-ha-qwen38-27b'] },
        roleChains: { generalist: { description: 'g', agents: ['local-ha-qwen3-8-27b'] } }
      }
    }));
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    const o = config.orchestration;
    assert.equal(o.agents!['local-ha-qwen3-8-27b'], undefined);
    assert.equal(o.agents!['local-hermes-qwen3.8-27b'].model, 'qwen3.8-27b');
    assert.equal(o.agents!['local-hermes-qwen3.8-27b'].clientId, undefined);   // static: no client id
    assert.equal(o.agents!['remote-ai-code-gen-cc-opus-4-8'].clientId, 'remote-ai-code-gen-cc-opus');
    assert.deepEqual(o.defaultChain, ['local-hermes-qwen3.8-27b', 'remote-ai-code-gen-cc-opus-4-8']);
    assert.deepEqual(o.divisionChains!.engineering, ['remote-ai-code-gen-cc-opus-4-8']);
    assert.deepEqual(o.personaChains!['product-manager'], ['local-hermes-qwen3.8-27b']);
    assert.deepEqual(o.roleChains.generalist.agents, ['local-hermes-qwen3.8-27b']);
    const disk = JSON.parse(readFileSync(process.env.COWORK_CONFIG!, 'utf8'));
    assert.ok(disk.orchestration.agents['local-hermes-qwen3.8-27b']);
    assert.equal(disk.orchestration.agents['local-ha-qwen3-8-27b'], undefined);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerAgent: a client declaring a retired id lands on the canonical id; re-declaring canonical clears clientId', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, registerAgent, clientTaskView } = await import('./config.js');
    const config = loadConfig();
    const canon = registerAgent(config, 'remote-ai-code-gen-cc-fable', { description: 'f', location: 'remote', exec: 'claude', dynamic: true });
    assert.equal(canon, 'remote-ai-code-gen-cc-fable-5');
    assert.equal(config.orchestration.agents!['remote-ai-code-gen-cc-fable'], undefined);
    assert.equal(config.orchestration.agents![canon].clientId, 'remote-ai-code-gen-cc-fable');

    // The old client finds and claims its task under the id it declared…
    const task = { id: 't1', context: { agent: canon, persona: 'x' } };
    const view = clientTaskView(config, task);
    assert.equal(view.context.agent, 'remote-ai-code-gen-cc-fable');
    assert.equal(task.context.agent, canon);   // stored task untouched

    // …until it re-declares the canonical id.
    registerAgent(config, canon, { description: 'f', location: 'remote', exec: 'claude', dynamic: true });
    assert.equal(config.orchestration.agents![canon].clientId, undefined);
    assert.equal(clientTaskView(config, task), task);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreClientAgents: restores a retired capability under its canonical id', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, restoreClientAgents } = await import('./config.js');
    const config = loadConfig();
    delete config.orchestration.agents!['local-codex-default'];
    const restored = restoreClientAgents(config, [{ id: 'codex-1', platform: 'codex', capabilities: ['remote-codex-default'] }]);
    assert.deepEqual(restored, ['local-codex-default']);
    const b = config.orchestration.agents!['local-codex-default'];
    // local- names the host; the codex client still claims it, so location stays remote.
    assert.equal(b.location, 'remote');
    assert.equal(b.clientId, 'remote-codex-default');
    // A canonical local-codex-* capability is client-claimed too, never dispatcher-spawned.
    delete config.orchestration.agents!['local-codex-gpt-6-luna'];
    restoreClientAgents(config, [{ id: 'codex-1', platform: 'codex', capabilities: ['local-codex-gpt-6-luna'] }]);
    assert.equal(config.orchestration.agents!['local-codex-gpt-6-luna'].location, 'remote');
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: migrates the 2026-11-03 remote-codex-* → local-codex-* rename, keeping location remote', async () => {
  const dir = makeConfig();
  try {
    writeFileSync(process.env.COWORK_CONFIG!, JSON.stringify({
      orchestration: {
        agents: {
          'remote-codex-gpt-6-luna': { description: 'c', location: 'remote', exec: 'codex', model: 'gpt-6-luna', dynamic: true, registeredBy: 'c1' }
        },
        defaultChain: ['remote-codex-gpt-6-luna'],
        roleChains: {}
      }
    }));
    const { loadConfig, clientTaskView } = await import('./config.js');
    const config = loadConfig();
    const b = config.orchestration.agents!['local-codex-gpt-6-luna'];
    assert.equal(config.orchestration.agents!['remote-codex-gpt-6-luna'], undefined);
    assert.equal(b.location, 'remote');
    assert.equal(b.model, 'gpt-6-luna');
    assert.equal(b.clientId, 'remote-codex-gpt-6-luna');
    assert.deepEqual(config.orchestration.defaultChain, ['local-codex-gpt-6-luna']);

    // A task stored under the retired id reaches the client under whichever id it declares.
    const oldPin = { id: 't0', context: { agent: 'remote-codex-gpt-6-luna' } };
    assert.equal(clientTaskView(config, oldPin), oldPin);   // client still declares the old id
    delete b.clientId;                                       // client re-declared the canonical id
    assert.equal(clientTaskView(config, oldPin).context.agent, 'local-codex-gpt-6-luna');
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});
