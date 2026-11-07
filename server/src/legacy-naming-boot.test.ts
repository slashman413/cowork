import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A hub that pulls the agent rename without the one-off cutover must heal on start.
 * It used to read its role chains as the agent registry, so every task sat on
 * "No eligible agent" (ai-code-gen, 2026-11-07).
 */
function legacyHub(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-legacy-boot-'));
  const configPath = join(dir, 'config.json');
  mkdirSync(join(dir, 'inbox'));
  writeFileSync(join(dir, 'inbox', 't1.json'), JSON.stringify({
    id: 't1', status: 'done', context: { brain: 'local-cc-opus-high', agent: 'academic-statistician' }
  }));
  writeFileSync(configPath, JSON.stringify({
    paths: { inbox: join(dir, 'inbox') },
    orchestration: {
      // What a new server writes back after running on the old shape for a while.
      roleChains: {},
      personaChains: {},
      agents: {
        generalist: { description: 'Fallback', brains: ['local-dsh-qwen3-8-27b', 'local-cc-sonnet-medium'] },
        ...extra
      },
      brains: {
        'local-cc-opus': { location: 'local', exec: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        'local-cc-sonnet': { location: 'local', exec: 'claude', model: 'claude-sonnet-5' },
        'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh', model: 'qwen3.8-27b' }
      },
      agentChains: { 'engineering-code-reviewer': ['local-cc-opus'] },
      defaultChain: ['local-dsh-qwen3-8-27b', 'local-cc-opus'],
      defaultBrainConcurrency: 1
    }
  }));
  return { dir, configPath };
}

test('old-shape config: start migrates it, its tasks, and keeps a backup', async () => {
  const { migrateLegacyNamingOnBoot, loadConfig } = await import('./config.js');
  const { dir, configPath } = legacyHub();
  process.env.COWORK_CONFIG = configPath;

  assert.equal(migrateLegacyNamingOnBoot(configPath), true);

  const orch = loadConfig().orchestration as any;
  assert.deepEqual(Object.keys(orch.agents).sort(), ['local-cc-opus', 'local-cc-sonnet', 'local-dsh-qwen3-8-27b']);
  assert.equal(orch.agents['local-cc-opus'].thinking, 'high');
  assert.deepEqual(orch.roleChains.generalist.agents, ['local-dsh-qwen3-8-27b', 'local-cc-sonnet']);
  assert.deepEqual(orch.personaChains, { 'engineering-code-reviewer': ['local-cc-opus'] });
  assert.equal(orch.defaultAgentConcurrency, 1);
  for (const key of ['brains', 'agentChains', 'defaultBrainConcurrency']) assert.equal(key in orch, false, key);

  const task = JSON.parse(readFileSync(join(dir, 'inbox', 't1.json'), 'utf-8'));
  assert.deepEqual(
    { agent: task.context.agent, persona: task.context.persona, thinking: task.context.thinking },
    { agent: 'local-cc-opus', persona: 'academic-statistician', thinking: 'high' }
  );

  const backups = readdirSync(join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^agent-naming-boot-.*\.tar\.gz$/);
});

test('a second start changes nothing', async () => {
  const { migrateLegacyNamingOnBoot } = await import('./config.js');
  const { dir, configPath } = legacyHub();
  assert.equal(migrateLegacyNamingOnBoot(configPath), true);
  const after = readFileSync(configPath, 'utf-8');
  assert.equal(migrateLegacyNamingOnBoot(configPath), false);
  assert.equal(readFileSync(configPath, 'utf-8'), after);
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
});

test('agents a client registered among the role chains stay agents', async () => {
  const { migrateLegacyNamingOnBoot } = await import('./config.js');
  const { configPath } = legacyHub({ 'local-agy-gemini-3.8-flash': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash', dynamic: true } });
  migrateLegacyNamingOnBoot(configPath);
  const orch = JSON.parse(readFileSync(configPath, 'utf-8')).orchestration;
  assert.equal(orch.agents['local-agy-gemini-3.8-flash'].exec, 'agy');
  assert.equal('local-agy-gemini-3.8-flash' in orch.roleChains, false);
});

test('a current config, a missing one and a broken one are left alone', async () => {
  const { migrateLegacyNamingOnBoot } = await import('./config.js');
  const dir = mkdtempSync(join(tmpdir(), 'cowork-legacy-boot-'));
  const current = join(dir, 'current.json');
  const text = JSON.stringify({ orchestration: { agents: { 'local-cc-opus': { exec: 'claude' } }, roleChains: { generalist: { agents: ['local-cc-opus'] } } } });
  writeFileSync(current, text);
  assert.equal(migrateLegacyNamingOnBoot(current), false);
  assert.equal(readFileSync(current, 'utf-8'), text);
  assert.equal(migrateLegacyNamingOnBoot(join(dir, 'missing.json')), false);
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{not json');
  assert.equal(migrateLegacyNamingOnBoot(broken), false);
});
