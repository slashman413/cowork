import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseRepoRef, detectRepo, defaultWrapBrain, Integrations, dirSizeBytes } from './integrations.js';

test('integrations: parseRepoRef validates and extracts repo metadata', () => {
  // owner/repo
  const r1 = parseRepoRef('slashman413/cowork');
  assert.equal(r1.host, 'github.com');
  assert.equal(r1.owner, 'slashman413');
  assert.equal(r1.repo, 'cowork');
  assert.equal(r1.url, 'https://github.com/slashman413/cowork.git');
  assert.equal(r1.id, 'slashman413__cowork');

  // with ref
  const r2 = parseRepoRef('facebook/react#v18.2.0');
  assert.equal(r2.owner, 'facebook');
  assert.equal(r2.repo, 'react');
  assert.equal(r2.ref, 'v18.2.0');

  // git@ SCP format
  const rScp = parseRepoRef('git@github.com:slashman413/cowork.git');
  assert.equal(rScp.host, 'github.com');
  assert.equal(rScp.owner, 'slashman413');
  assert.equal(rScp.repo, 'cowork');
  assert.equal(rScp.url, 'https://github.com/slashman413/cowork.git');
  assert.equal(rScp.id, 'slashman413__cowork');

  // full github URL with tree and subpath
  const r3 = parseRepoRef('https://github.com/anthropics/skills/tree/main/skills/browser');
  assert.equal(r3.owner, 'anthropics');
  assert.equal(r3.repo, 'skills');
  assert.equal(r3.ref, 'main');
  assert.equal(r3.subpath, 'skills/browser');
  assert.equal(r3.id, 'anthropics__skills__browser');

  // rejects disallowed hosts
  assert.throws(() => parseRepoRef('https://malicious-site.com/evil/repo'), /integrations\.allowHosts/);

  // rejects credentials
  assert.throws(() => parseRepoRef('https://user:pass@github.com/foo/bar'), /credentials/);

  // file URLs allowed only when flag set
  assert.throws(() => parseRepoRef('file:///tmp/repo'), /only https:\/\/ repository URLs are supported/);
  const rFile = parseRepoRef('file:///tmp/local-repo.git', { allowFileUrls: true });
  assert.equal(rFile.host, 'local');
  assert.equal(rFile.repo, 'local-repo');
});

test('integrations: detectRepo classifies repo contents', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-repo-test-'));
  try {
    // 1. Skill detection
    fs.mkdirSync(path.join(tmp, 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'my-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: A test skill\n---\n# Test');

    // 2. Web detection
    fs.writeFileSync(path.join(tmp, 'index.html'), '<html><body>Hello</body></html>');

    // 3. MCP detection
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'test-pkg',
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0'
      }
    }));

    const det = detectRepo(tmp);
    assert.ok(det.kinds.includes('skill'));
    assert.ok(det.kinds.includes('web'));
    assert.ok(det.kinds.includes('mcp'));
    assert.equal(det.skills.length, 1);
    assert.equal(det.skills[0].name, 'test-skill');
    assert.equal(det.skills[0].description, 'A test skill');
    assert.equal(det.web?.entry, 'index.html');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('integrations: defaultWrapBrain picks a local brain', () => {
  const locals = ['remote-codex', 'local-hermes-qwen3.8-27b', 'local-cc-sonnet-5-5'];
  const picked = defaultWrapBrain(undefined, locals);
  assert.equal(picked, 'local-cc-sonnet-5-5');

  const configured = defaultWrapBrain('local-hermes-qwen3.8-27b', locals);
  assert.equal(configured, 'local-hermes-qwen3.8-27b');
});

test('integrations: buildWrapTask creates safe prompt for agent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integrations-hub-test-'));
  try {
    const hub = new Integrations({
      root: path.join(tmp, 'integrations'),
      registry: path.join(tmp, 'integrations.json'),
      skillsHome: path.join(tmp, 'skills'),
    });

    // Manually write an integration to registry
    const id = 'acme__tool';
    const fakeDir = path.join(tmp, 'integrations', id);
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'README.md'), '# Acme Tool\nA CLI tool');

    (hub as any).put({
      id,
      source: 'acme/tool',
      url: 'https://github.com/acme/tool.git',
      dir: fakeDir,
      addedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      status: 'fetched',
      detected: { kinds: ['cli'], skills: [], cli: 'acme-cli', description: 'Acme CLI tool' },
      audit: { verdict: 'pass', counts: { critical: 0, high: 0, medium: 0 }, scannedFiles: 1, findings: [], at: new Date().toISOString() },
      installed: { skills: [] },
    });

    const taskSpec = hub.buildWrapTask(id, { brain: 'local-hermes-qwen3.8-27b' });
    assert.ok(taskSpec.title.includes('acme/tool'));
    assert.equal(taskSpec.context.brain, 'local-hermes-qwen3.8-27b');
    assert.ok(taskSpec.description.includes('Write ONLY inside the wrapper dir'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('integrations: maxRepoMB defaults to 3072 MB (3 GB) and respects overrides', () => {
  const hubDefault = new Integrations({});
  assert.equal((hubDefault as any).cfg.maxRepoMB ?? 3072, 3072);

  const hubCustom = new Integrations({ maxRepoMB: 5120 });
  assert.equal((hubCustom as any).cfg.maxRepoMB ?? 3072, 5120);
});

test('integrations: dirSizeBytes calculates size and enforces cap', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-size-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'file1.txt'), Buffer.alloc(1024)); // 1 KB
    fs.writeFileSync(path.join(tmp, 'file2.txt'), Buffer.alloc(2048)); // 2 KB
    assert.equal(dirSizeBytes(tmp, 4096), 3072);
    // cap exceeded (cap = 2048 bytes) stops walk once over cap
    assert.ok(dirSizeBytes(tmp, 2048) > 2048);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

