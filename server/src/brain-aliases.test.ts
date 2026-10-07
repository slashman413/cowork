import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Brain renames must not strand anything that still uses a retired id
 * (BRAIN_ID_ALIASES): an older on-disk config, a task pinned via context.brain,
 * or a client that keeps declaring its old ids. Pins: the load-time migration,
 * registration under the canonical id + clientId, and the client task view.
 */
function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-alias-'));
  process.env.COWORK_CONFIG = join(dir, 'config.json');
  return dir;
}

test('canonicalBrainId: resolves retired ids, leaves others, honours config aliases', async () => {
  const { canonicalBrainId } = await import('./config.js');
  assert.equal(canonicalBrainId(undefined, 'local-ha-qwen3-8-27b'), 'local-hermes-qwen3.8-27b');
  assert.equal(canonicalBrainId(undefined, 'local-ha-qwen38-27b'), 'local-hermes-qwen3.8-27b');
  assert.equal(canonicalBrainId(undefined, 'local-codex-gpt-5-6-terra'), 'remote-codex-gpt-5-6-terra');
  assert.equal(canonicalBrainId(undefined, 'remote-ai-code-gen-cc-opus'), 'remote-ai-code-gen-cc-opus-4-8');
  assert.equal(canonicalBrainId(undefined, 'local-cc-opus-5-5'), 'local-cc-opus-5-5');
  const cfg: any = { orchestration: { brainAliases: { 'a': 'b', 'b': 'c', 'x': 'y', 'y': 'x' } } };
  assert.equal(canonicalBrainId(cfg, 'a'), 'c');
  assert.ok(['x', 'y'].includes(canonicalBrainId(cfg, 'x')));   // a cycle terminates
});

test('no canonical alias target is denylisted', async () => {
  const { BRAIN_ID_ALIASES, isDenylistedBrain } = await import('./config.js');
  for (const target of Object.values(BRAIN_ID_ALIASES)) assert.equal(isDenylistedBrain(target), false, target);
});

test('loadConfig: migrates retired ids in the registry and every chain, and persists', async () => {
  const dir = makeConfig();
  try {
    writeFileSync(process.env.COWORK_CONFIG!, JSON.stringify({
      orchestration: {
        brains: {
          'local-ha-qwen3-8-27b': { description: 'q', location: 'local', exec: 'hermes', model: 'qwen3.8-27b' },
          'remote-ai-code-gen-cc-opus': { description: 'o', location: 'remote', exec: 'claude', dynamic: true, registeredBy: 'a1' }
        },
        defaultChain: ['local-ha-qwen3-8-27b', 'local-hermes-qwen3.8-27b', 'remote-ai-code-gen-cc-opus'],
        divisionChains: { engineering: ['remote-ai-code-gen-cc-opus'] },
        agentChains: { 'product-manager': ['local-ha-qwen38-27b'] },
        agents: { generalist: { description: 'g', brains: ['local-ha-qwen3-8-27b'] } }
      }
    }));
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    const o = config.orchestration;
    assert.equal(o.brains!['local-ha-qwen3-8-27b'], undefined);
    assert.equal(o.brains!['local-hermes-qwen3.8-27b'].model, 'qwen3.8-27b');
    assert.equal(o.brains!['local-hermes-qwen3.8-27b'].clientId, undefined);   // static: no client id
    assert.equal(o.brains!['remote-ai-code-gen-cc-opus-4-8'].clientId, 'remote-ai-code-gen-cc-opus');
    assert.deepEqual(o.defaultChain, ['local-hermes-qwen3.8-27b', 'remote-ai-code-gen-cc-opus-4-8']);
    assert.deepEqual(o.divisionChains!.engineering, ['remote-ai-code-gen-cc-opus-4-8']);
    assert.deepEqual(o.agentChains!['product-manager'], ['local-hermes-qwen3.8-27b']);
    assert.deepEqual(o.agents.generalist.brains, ['local-hermes-qwen3.8-27b']);
    const disk = JSON.parse(readFileSync(process.env.COWORK_CONFIG!, 'utf8'));
    assert.ok(disk.orchestration.brains['local-hermes-qwen3.8-27b']);
    assert.equal(disk.orchestration.brains['local-ha-qwen3-8-27b'], undefined);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerBrain: a client declaring a retired id lands on the canonical id; re-declaring canonical clears clientId', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, registerBrain, clientTaskView } = await import('./config.js');
    const config = loadConfig();
    const canon = registerBrain(config, 'remote-ai-code-gen-cc-fable', { description: 'f', location: 'remote', exec: 'claude', dynamic: true });
    assert.equal(canon, 'remote-ai-code-gen-cc-fable-5');
    assert.equal(config.orchestration.brains!['remote-ai-code-gen-cc-fable'], undefined);
    assert.equal(config.orchestration.brains![canon].clientId, 'remote-ai-code-gen-cc-fable');

    // The old client finds and claims its task under the id it declared…
    const task = { id: 't1', context: { brain: canon, agent: 'x' } };
    const view = clientTaskView(config, task);
    assert.equal(view.context.brain, 'remote-ai-code-gen-cc-fable');
    assert.equal(task.context.brain, canon);   // stored task untouched

    // …until it re-declares the canonical id.
    registerBrain(config, canon, { description: 'f', location: 'remote', exec: 'claude', dynamic: true });
    assert.equal(config.orchestration.brains![canon].clientId, undefined);
    assert.equal(clientTaskView(config, task), task);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreClientBrains: restores a retired capability under its canonical id', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, restoreClientBrains } = await import('./config.js');
    const config = loadConfig();
    delete config.orchestration.brains!['remote-codex-default'];
    const restored = restoreClientBrains(config, [{ id: 'codex-1', platform: 'codex', capabilities: ['local-codex-default'] }]);
    assert.deepEqual(restored, ['remote-codex-default']);
    const b = config.orchestration.brains!['remote-codex-default'];
    assert.equal(b.location, 'remote');
    assert.equal(b.clientId, 'local-codex-default');
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});
