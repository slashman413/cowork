import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { PLAYBOOK_KEYS, parsePstackCommand, applyPstackCommand, DEFAULT_PSTACK_SKILLS_DIR } from './playbooks.js';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { createApiRouter } from '../api/router.js';
import type { Config } from '../types.js';

function fakeSkills(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-skills-'));
  fs.mkdirSync(path.join(dir, 'interrogate'));
  fs.writeFileSync(path.join(dir, 'interrogate', 'SKILL.md'), '# interrogate');
  fs.mkdirSync(path.join(dir, 'no-skill-md'));
  return dir;
}

test('PLAYBOOK_KEYS lists the 14 method playbooks', () => {
  assert.equal(PLAYBOOK_KEYS.length, 14);
  for (const k of ['technical-writing', 'perf-issue', 'refactoring', 'prototype', 'runtime-forensics', 'eval', 'opening-a-pr', 'babysit']) {
    assert.ok((PLAYBOOK_KEYS as readonly string[]).includes(k), k);
  }
});

test('parsePstackCommand: playbook key sets playbook', () => {
  const r = parsePstackCommand('/pstack bug-fix fix the flaky login test', fakeSkills());
  assert.deepEqual(r, { ok: true, playbook: 'bug-fix', text: 'fix the flaky login test' });
});

test('parsePstackCommand: vendored skill sets skill; multi-line text kept', () => {
  const r = parsePstackCommand('/pstack interrogate review\nthe auth diff', fakeSkills());
  assert.deepEqual(r, { ok: true, skill: 'interrogate', text: 'review\nthe auth diff' });
});

test('parsePstackCommand: unknown name and dir without SKILL.md are errors', () => {
  const dir = fakeSkills();
  const a = parsePstackCommand('/pstack nope do things', dir);
  assert.equal(a?.ok, false);
  assert.match((a as any).error, /unknown pstack/);
  assert.equal(parsePstackCommand('/pstack no-skill-md do things', dir)?.ok, false);
  assert.equal(parsePstackCommand('/pstack ../etc do things', dir)?.ok, false);
});

test('parsePstackCommand: missing text / missing name are usage errors', () => {
  const dir = fakeSkills();
  assert.match((parsePstackCommand('/pstack bug-fix', dir) as any).error, /missing/);
  assert.match((parsePstackCommand('/pstack', dir) as any).error, /usage/);
});

test('parsePstackCommand: non-commands return null', () => {
  assert.equal(parsePstackCommand('just a brief', fakeSkills()), null);
  assert.equal(parsePstackCommand('/pstackish x y', fakeSkills()), null);
});

test('applyPstackCommand: strips the command and merges context', () => {
  const out = applyPstackCommand({ title: 'T', description: '/pstack interrogate check it', context: { brain: 'b' } }, fakeSkills());
  assert.equal(out.description, 'check it');
  assert.deepEqual(out.context, { brain: 'b', skill: 'interrogate' });
  const t = applyPstackCommand({ title: '/pstack feature add a button', description: '' }, fakeSkills());
  assert.equal(t.title, 'add a button');
  assert.equal(t.description, 'add a button');
  assert.equal(t.context?.playbook, 'feature');
  assert.throws(() => applyPstackCommand({ title: 'T', description: '/pstack nope x' }, fakeSkills()), /unknown/);
});

test('POST /api/inbox: /pstack sets context.playbook/skill; GET /api/pstack lists vocab', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-pstack-api-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'workflows', 'agencyAgents', 'goals']) {
    paths[k] = path.join(root, k);
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const store = new Store({ paths, platforms: {}, orchestration: { brains: {} } } as unknown as Config, new EventBus());
  (store as any).getConfig = undefined; // no background sharpen in this test
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(store, new EventBus()));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = async (body: any) => {
    const r = await fetch(base + '/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const from = { platform: 'dashboard', agent: 'operator' };
  try {
    const a = await post({ title: 'Fix', description: '/pstack bug-fix fix the flaky test', from });
    assert.equal(a.status, 201);
    assert.equal(a.json.context.playbook, 'bug-fix');
    assert.equal(a.json.description, 'fix the flaky test');

    // A real vendored skill (interrogate ships in vendor/pstack).
    if (fs.existsSync(path.join(DEFAULT_PSTACK_SKILLS_DIR, 'interrogate', 'SKILL.md'))) {
      const b = await post({ title: 'Review', description: '/pstack interrogate review the diff', from, context: { review: 'panel' } });
      assert.equal(b.status, 201);
      assert.equal(b.json.context.skill, 'interrogate');
      assert.equal(b.json.context.review, 'panel');
    }

    // Dashboard Create form path: explicit context fields pass through untouched.
    const c = await post({ title: 'X', description: 'plain', from, context: { playbook: 'eval', arena: { runners: 3 }, skill: 'why' } });
    assert.equal(c.status, 201);
    assert.equal(c.json.context.playbook, 'eval');
    assert.deepEqual(c.json.context.arena, { runners: 3 });
    assert.equal(c.json.context.skill, 'why');

    const bad = await post({ title: 'Y', description: '/pstack not-a-skill do it', from });
    assert.equal(bad.status, 400);

    const v = await (await fetch(base + '/pstack')).json() as any;
    assert.equal(v.playbooks.length, 14);
    assert.ok(Array.isArray(v.skills));
  } finally {
    server.close();
  }
});
