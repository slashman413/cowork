import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VENDORED_SKILL_MAP,
  isMethodCardActive,
  loadMethodCard,
  renderMethodPrompt
} from './methods.js';
import { Dispatcher } from './dispatcher.js';
import type { Task, Config } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const methodsDir = path.join(repoRoot, 'methods');

const REQUIRED_CARDS = [
  'investigation',
  'bug-fix',
  'feature',
  'research-report',
  'content',
  'ops-change'
];

test('all 6 method cards exist in methods/ and are <= 1.2 KB (1200 bytes)', () => {
  for (const card of REQUIRED_CARDS) {
    const file = path.join(methodsDir, `${card}.md`);
    assert.ok(fs.existsSync(file), `methods/${card}.md must exist`);
    const content = fs.readFileSync(file, 'utf8');
    const bytes = Buffer.byteLength(content);
    assert.ok(bytes <= 1200, `methods/${card}.md is ${bytes} bytes, exceeds 1200 bytes`);
    assert.match(content, /## Steps/, `${card}.md must have ## Steps`);
    assert.match(content, /## Principles/, `${card}.md must have ## Principles`);
    assert.match(content, /## Evidence/, `${card}.md must have ## Evidence`);
  }
});

test('investigation card covers how / investigation steps and citations', () => {
  const content = fs.readFileSync(path.join(methodsDir, 'investigation.md'), 'utf8');
  assert.match(content, /file:line/);
  assert.match(content, /Overview/);
  assert.match(content, /Gotchas/);
});

test('ops-change card covers blast-radius checks and idempotency', () => {
  const content = fs.readFileSync(path.join(methodsDir, 'ops-change.md'), 'utf8');
  assert.match(content, /blast radius/i);
  assert.match(content, /safety fact/i);
  assert.match(content, /idempotent/i);
});

test('content card contains trimmed unslop list', () => {
  const content = fs.readFileSync(path.join(methodsDir, 'content.md'), 'utf8');
  assert.match(content, /## Unslop rules/);
  for (const id of ['3', '7', '13', '27']) {
    assert.match(content, new RegExp(`^- ${id}\\b`, 'm'));
  }
});

test('vendored pstack skills exist on disk for all cards', () => {
  for (const [key, relPath] of Object.entries(VENDORED_SKILL_MAP)) {
    const fullPath = path.join(repoRoot, relPath);
    assert.ok(fs.existsSync(fullPath), `vendored skill for ${key} must exist at ${relPath}`);
  }
});

test('isMethodCardActive: honors enabled flag and defaults cards to shadow', () => {
  assert.equal(isMethodCardActive(undefined, 'bug-fix'), false);
  assert.equal(isMethodCardActive({ enabled: false }, 'bug-fix'), false);
  assert.equal(isMethodCardActive({ enabled: true }, 'bug-fix'), false); // default is shadow
  assert.equal(isMethodCardActive({ enabled: true, cards: { 'bug-fix': 'shadow' } }, 'bug-fix'), false);
  assert.equal(isMethodCardActive({ enabled: true, cards: { 'bug-fix': 'on' } }, 'bug-fix'), true);
  assert.equal(isMethodCardActive({ enabled: false, cards: { 'bug-fix': 'on' } }, 'bug-fix'), false);
});

test('renderMethodPrompt: local brains get full vendored path; remote brains get only inline card', () => {
  const cfg = { enabled: true, cards: { 'bug-fix': 'on' } } as const;

  const localLines = renderMethodPrompt({
    repoRoot,
    methodsDir,
    playbook: 'bug-fix',
    isLocal: true,
    methodsCfg: cfg as any
  });
  const localText = localLines.join('\n');
  assert.match(localText, /^# Method\b/m);
  assert.match(localText, /## Steps/);
  assert.match(localText, /Optional reading \(full skill\): .*vendor\/pstack\/skills/);

  const remoteLines = renderMethodPrompt({
    repoRoot,
    methodsDir,
    playbook: 'bug-fix',
    isLocal: false,
    methodsCfg: cfg as any
  });
  const remoteText = remoteLines.join('\n');
  assert.match(remoteText, /^# Method\b/m);
  assert.match(remoteText, /## Steps/);
  assert.doesNotMatch(remoteText, /Optional reading \(full skill\)/);
});

test('buildPrompt integrates method card when turned on and omits when shadow', () => {
  const store = {
    getTask: () => null,
    getAgentPersona: () => null,
    inputsPath: () => '/tmp/inputs',
    getActiveAgents: () => []
  };

  const baseConfig: Config = {
    server: { port: 6868, allowUnauthenticated: true, corsOrigin: '*' },
    paths: {
      agencyAgents: '',
      inbox: '/tmp/inbox',
      artifacts: path.join(repoRoot, 'artifacts'),
      inputs: '/tmp/inputs',
      status: '/tmp/status',
      decisions: '/tmp/decisions',
      workflows: path.join(repoRoot, 'workflows')
    },
    orchestration: {
      enabled: true,
      maxConcurrent: 2,
      pollIntervalMs: 1000,
      taskTimeoutMs: 300000,
      defaultRole: 'generalist',
      agents: {},
      brains: {
        'local-test-brain': { location: 'local', description: 'test', exec: 'hermes' },
        'remote-test-brain': { location: 'remote', description: 'test' }
      },
      methods: {
        enabled: true,
        cards: {
          'feature': 'on',
          'bug-fix': 'shadow'
        }
      }
    }
  } as any;

  const dispatcher = new Dispatcher(baseConfig, store as any, {} as any);

  // 1. Task with 'feature' playbook ('on') on local brain
  const taskOn: Task = {
    id: 'test-task-1',
    title: 'Implement widget',
    description: 'Add widget feature',
    status: 'pending',
    context: { playbook: 'feature' }
  } as any;

  const promptOn = (dispatcher as any).buildPrompt(taskOn, {
    agent: 'engineer',
    isRoster: false,
    brainId: 'local-test-brain'
  });
  assert.match(promptOn, /# Method\n# Method: feature/);
  assert.match(promptOn, /Optional reading \(full skill\): .*vendor\/pstack\/skills/);

  // 2. Same task on remote brain ('on') -> no optional reading path
  const promptRemote = (dispatcher as any).buildPrompt(taskOn, {
    agent: 'engineer',
    isRoster: false,
    brainId: 'remote-test-brain'
  });
  assert.match(promptRemote, /# Method\n# Method: feature/);
  assert.doesNotMatch(promptRemote, /Optional reading \(full skill\)/);

  // 3. Task with 'bug-fix' playbook ('shadow') -> NOT injected
  const taskShadow: Task = {
    id: 'test-task-2',
    title: 'Fix widget',
    description: 'Fix crash',
    status: 'pending',
    context: { playbook: 'bug-fix' }
  } as any;

  const promptShadow = (dispatcher as any).buildPrompt(taskShadow, {
    agent: 'engineer',
    isRoster: false,
    brainId: 'local-test-brain'
  });
  assert.doesNotMatch(promptShadow, /# Method/);

  // 4. Task with no playbook -> NOT injected
  const taskNone: Task = {
    id: 'test-task-3',
    title: 'Misc task',
    description: 'Do something',
    status: 'pending',
    context: {}
  } as any;

  const promptNone = (dispatcher as any).buildPrompt(taskNone, {
    agent: 'engineer',
    isRoster: false,
    brainId: 'local-test-brain'
  });
  assert.doesNotMatch(promptNone, /# Method/);
});
