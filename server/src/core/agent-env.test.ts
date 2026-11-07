import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * WF-3 / RC-1 regression: the register_agent schema is closed, so an `env`
 * manifest must be both declared in the zod schema AND forwarded by registerAgent
 * — otherwise it is silently stripped and the routing feature no-ops with no
 * error. This pins the persistence half: registerAgent keeps `env` on the record
 * and writes it through to the per-server config on disk.
 */
test('RC-1: registerAgent persists the env manifest (in-memory + on disk)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-cfg-'));
  const cfgPath = join(dir, 'config.json');
  process.env.COWORK_CONFIG = cfgPath;
  try {
    const { loadConfig, registerAgent } = await import('../config.js');
    const config = loadConfig();
    const env = { paths: ['/home/maxchang/workspace'], tools: ['git', 'ffmpeg'], secrets: ['gumroad'], traits: ['linux-x64'] };
    registerAgent(config, 'remote-h-cc-opus', {
      description: 'test agent', location: 'remote', exec: 'claude', model: 'claude-opus-4-8',
      dynamic: true, registeredBy: 'agent-1', env
    });

    // in-memory registry keeps it
    assert.deepEqual(config.orchestration.agents!['remote-h-cc-opus'].env, env);
    // and it round-trips to disk (persistRegistries wrote orchestration.agents)
    const disk = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.deepEqual(disk.orchestration.agents['remote-h-cc-opus'].env, env);
  } finally {
    delete process.env.COWORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});
