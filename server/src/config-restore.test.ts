import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression: client-declared brains (e.g. every `local-agy-*` the Antigravity
 * client registers) must stay SELECTABLE in the registry even after a
 * full-config write wiped the persisted dynamic entries. Clients only
 * re-declare their brains when they restart, so the server rebuilds the
 * registry from the persisted agent roster at boot. These tests pin
 * restoreClientBrains: idempotent, exec/location derived from platform + id,
 * static defs never overwritten, non-brain capabilities skipped.
 *
 * NOTE: loadConfig seeds the per-server config from the repo template, which
 * already declares the local-ha and local-cc families — tests therefore use
 * brain ids that are NOT in the template so the restore path is exercised.
 */
function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-restore-'));
  process.env.COWORK_CONFIG = join(dir, 'config.json');
  return dir;
}

test('restoreClientBrains: rebuilds missing client-declared brains and persists them', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, restoreClientBrains } = await import('./config.js');
    const config = loadConfig();

    const restored = restoreClientBrains(config, [
      { id: 'agy-agent-1', platform: 'antigravity', capabilities: ['local-agy-gemini-3.6-flash-high', 'local-agy-claude-opus-4-6-thinking', 'not-a-brain'] },
      { id: 'cc-agent-2', platform: 'claude', capabilities: ['local-cc-nova'] }
    ]);

    assert.deepEqual(restored.sort(), ['local-agy-claude-opus-4-6-thinking', 'local-agy-gemini-3.6-flash-high', 'local-cc-nova']);
    const b = config.orchestration.brains!;
    assert.equal(b['local-agy-gemini-3.6-flash-high'].exec, 'agy');
    assert.equal(b['local-agy-gemini-3.6-flash-high'].location, 'local');
    assert.equal(b['local-agy-gemini-3.6-flash-high'].registeredBy, 'agy-agent-1');
    assert.equal(b['local-cc-nova'].exec, 'claude');
    assert.equal(b['not-a-brain'], undefined);

    // round-trips to disk (the durable registry the UI dropdown reads)
    const disk = JSON.parse(readFileSync(process.env.COWORK_CONFIG!, 'utf-8'));
    assert.equal(disk.orchestration.brains['local-agy-gemini-3.6-flash-high'].exec, 'agy');
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreClientBrains: never overwrites existing registry entries (static or dynamic)', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, restoreClientBrains } = await import('./config.js');
    const config = loadConfig();
    config.orchestration.brains = {
      'local-cc-opus': { description: 'hand-configured', location: 'local', exec: 'claude', model: 'claude-opus-4-8' }
    };

    const restored = restoreClientBrains(config, [
      { id: 'cc-agent-2', platform: 'claude', capabilities: ['local-cc-opus', 'local-cc-nova'] }
    ]);

    assert.deepEqual(restored, ['local-cc-nova']);
    assert.equal(config.orchestration.brains!['local-cc-opus'].description, 'hand-configured');  // untouched
    assert.equal(config.orchestration.brains!['local-cc-opus'].dynamic, undefined);
    assert.equal(config.orchestration.brains!['local-cc-nova'].registeredBy, 'cc-agent-2');
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerBrain: preserves a server-side disable across client re-registration', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, registerBrain } = await import('./config.js');
    const config = loadConfig();

    // Client declares the brain, operator disables it, client reconnects and
    // re-declares it verbatim. The disable must survive — this is the "disabled
    // brains re-enable themselves after a while" bug.
    registerBrain(config, 'remote-box-cc-opus', { description: 'v1', location: 'remote', exec: 'claude', dynamic: true, registeredBy: 'a1' });
    config.orchestration.brains!['remote-box-cc-opus'].disabled = true;
    registerBrain(config, 'remote-box-cc-opus', { description: 'v2', location: 'remote', exec: 'claude', dynamic: true, registeredBy: 'a1' });

    assert.equal(config.orchestration.brains!['remote-box-cc-opus'].disabled, true);
    const disk = JSON.parse(readFileSync(process.env.COWORK_CONFIG!, 'utf-8'));
    assert.equal(disk.orchestration.brains['remote-box-cc-opus'].disabled, true);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerBrain: refuses denylisted (deepseek) brains', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, registerBrain, isDenylistedBrain } = await import('./config.js');
    const config = loadConfig();

    registerBrain(config, 'local-ha-deepseek-v4-pro', { description: 'x', location: 'local', exec: 'hermes', dynamic: true });
    registerBrain(config, 'remote-box-ha-deepseek', { description: 'x', location: 'remote', exec: 'hermes', dynamic: true });

    assert.equal(isDenylistedBrain('local-ha-deepseek-v4-pro'), true);
    assert.equal(isDenylistedBrain('local-ha-qwen35b'), false);
    assert.equal(config.orchestration.brains!['local-ha-deepseek-v4-pro'], undefined);
    assert.equal(config.orchestration.brains!['remote-box-ha-deepseek'], undefined);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: scrubs a denylisted brain that lingered in the on-disk config', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig } = await import('./config.js');
    // Seed the on-disk config with a deepseek brain + chain references, as an
    // older server (pre-denylist) would have persisted.
    writeFileSync(process.env.COWORK_CONFIG!, JSON.stringify({
      orchestration: {
        brains: {
          'local-ha-qwen35b': { description: 'q', location: 'local', exec: 'hermes' },
          'local-ha-deepseek-v4-pro': { description: 'd', location: 'local', exec: 'hermes' }
        },
        defaultChain: ['local-ha-deepseek-v4-pro', 'local-ha-qwen35b'],
        agents: { orchestrator: { description: 'o', brains: ['local-ha-deepseek-v4-pro', 'local-ha-qwen35b'] } }
      }
    }));

    const config = loadConfig();
    assert.equal(config.orchestration.brains!['local-ha-deepseek-v4-pro'], undefined);
    assert.equal(config.orchestration.brains!['local-ha-qwen35b'].exec, 'hermes');
    assert.deepEqual(config.orchestration.defaultChain, ['local-ha-qwen35b']);
    assert.deepEqual(config.orchestration.agents!.orchestrator.brains, ['local-ha-qwen35b']);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreClientBrains: never restores a denylisted (deepseek) brain', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, restoreClientBrains } = await import('./config.js');
    const config = loadConfig();

    const restored = restoreClientBrains(config, [
      { id: 'ha-agent', platform: 'hermes', capabilities: ['local-ha-deepseek-v4-pro', 'local-ha-nova'] }
    ]);

    assert.deepEqual(restored, ['local-ha-nova']);
    assert.equal(config.orchestration.brains!['local-ha-deepseek-v4-pro'], undefined);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreClientBrains: skips unknown platforms and remote-located ids', async () => {
  const dir = makeConfig();
  try {
    const { loadConfig, restoreClientBrains } = await import('./config.js');
    const config = loadConfig();

    const restored = restoreClientBrains(config, [
      { id: 'orchestrator', platform: 'cowork', capabilities: ['local-ha-internal-probe'] },      // internal agent
      { id: 'remote-box', platform: 'claude', capabilities: ['remote-aicodegen-cc-opus'] }        // remote-located
    ]);

    assert.deepEqual(restored, ['remote-aicodegen-cc-opus']);
    assert.equal(config.orchestration.brains!['local-ha-internal-probe'], undefined);
    assert.equal(config.orchestration.brains!['remote-aicodegen-cc-opus'].location, 'remote');
    assert.equal(config.orchestration.brains!['remote-aicodegen-cc-opus'].exec, 'claude');
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});
