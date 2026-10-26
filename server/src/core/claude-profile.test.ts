import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeProfile, needsFullProfile, selectMcpServers } from './claude-profile.js';

const servers = {
  cowork: { type: 'http', url: 'https://localhost:6868/mcp', headers: { 'X-Api-Key': 'k' } },
  firecrawl: { type: 'http', url: 'http://localhost:3000/mcp' },
  twstock: { command: 'uv' },
  rea: { command: 'rea' },
  'notebooklm-mcp': { command: 'notebooklm-mcp' },
};

function fakeHome(withClaudeJson = true): string {
  const home = mkdtempSync(join(tmpdir(), 'cp-'));
  mkdirSync(join(home, '.claude', 'skills', 'graphify'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    env: { NODE_EXTRA_CA_CERTS: '/c.pem' }, effortLevel: 'high', model: 'm', theme: 'dark', permissions: { allow: [] },
  }));
  if (withClaudeJson) writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers, history: [] }));
  return home;
}

test('task runs get cowork + firecrawl, plus on-demand servers the task text matches', () => {
  assert.deepEqual(Object.keys(selectMcpServers(servers, 'write a blog post')), ['cowork', 'firecrawl']);
  assert.deepEqual(Object.keys(selectMcpServers(servers, 'Analyse 2330 on TWSE')), ['cowork', 'firecrawl', 'twstock']);
  assert.deepEqual(Object.keys(selectMcpServers(servers, 'decompile this APK')), ['cowork', 'firecrawl', 'rea']);
  assert.deepEqual(Object.keys(selectMcpServers(servers, 'summarise my NotebookLM notebook')), ['cowork', 'firecrawl', 'notebooklm-mcp']);
});

test('internal reasoning calls (taskText null) get no MCP servers', () => {
  assert.deepEqual(selectMcpServers(servers, null), {});
});

test('config overrides the defaults and unknown server names are ignored', () => {
  const got = selectMcpServers(servers, 'anything', { always: ['cowork', 'missing'], onDemand: { rea: 'anything' } });
  assert.deepEqual(Object.keys(got), ['cowork', 'rea']);
});

test('a task that asks for skills, subagents, or an installed /skill needs the full profile', () => {
  assert.ok(needsFullProfile('Install these skills', []));
  assert.ok(needsFullProfile('use a subagent to review', []));
  assert.ok(needsFullProfile('run /graphify on the repo', ['graphify']));
  assert.ok(!needsFullProfile('save it to /home/wayne/graphify/out', ['graphify']));
  assert.ok(!needsFullProfile('write a blog post', ['graphify']));
});

test('args: lean flags with 0600 files carrying env/model/effort and the chosen servers', () => {
  const home = fakeHome();
  const p = new ClaudeProfile({ home });
  const args = p.args('write a blog post');
  assert.deepEqual(args.filter(a => a.startsWith('--')), ['--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config']);
  assert.equal(args[1], 'project,local');
  const settings = JSON.parse(readFileSync(args[3], 'utf8'));
  assert.deepEqual(settings, { env: { NODE_EXTRA_CA_CERTS: '/c.pem' }, model: 'm', effortLevel: 'high' });
  const mcp = JSON.parse(readFileSync(args[6], 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['cowork', 'firecrawl']);
  assert.equal(statSync(args[6]).mode & 0o777, 0o600);
  // Internal calls: lean, but an empty MCP set.
  const internal = p.args(null);
  assert.deepEqual(JSON.parse(readFileSync(internal[6], 'utf8')), { mcpServers: {} });
});

test('args: full profile ([]) when the task needs skills or ~/.claude.json is unreadable', () => {
  assert.deepEqual(new ClaudeProfile({ home: fakeHome() }).args('run /graphify here'), []);
  assert.deepEqual(new ClaudeProfile({ home: fakeHome(false) }).args('write a post'), []);
});
