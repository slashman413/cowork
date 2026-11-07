import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractRequires, deriveAgentFamily, titleSlug, buildLesson, appendLesson } from './lessons.js';

/**
 * WF-1 lesson ledger. These pin the deterministic capture layer: the requires
 * extractor, the family/slug derivations, and the never-break-dispatch append.
 * (Test IDs map to the spec's WF-1 test table.)
 */

test('deriveAgentFamily strips the trailing model segment (WF-1 schema)', () => {
  assert.equal(deriveAgentFamily('remote-ai-code-gen-cc-fable'), 'remote-ai-code-gen-cc');
  assert.equal(deriveAgentFamily('remote-ai-code-gen-cc-opus'), 'remote-ai-code-gen-cc');
  assert.equal(deriveAgentFamily('solo'), 'solo');
  assert.equal(deriveAgentFamily(''), '');
});

test('titleSlug kebabs the first 6 words', () => {
  assert.equal(titleSlug('AI Workflow Builder git-init misrouted again and again'),
    'ai-workflow-builder-git-init-misrouted-again');
});

test('1-03: extractRequires pulls path + tool from a failure text', () => {
  const text = 'Tried to open /home/wayne but got: No such file or directory.\nxurl: command not found';
  assert.deepEqual(extractRequires(text), ['path:/home/wayne', 'tool:xurl']);
});

test('extractRequires ignores absolute paths with no missing-context', () => {
  // A path that is merely mentioned (not reported absent) is not a requirement.
  assert.deepEqual(extractRequires('wrote output to /home/maxchang/artifacts/report.md successfully'), []);
});

test('extractRequires does not mistake and/or or TCP/IP for paths', () => {
  assert.deepEqual(extractRequires('the file was not found and/or unreadable over TCP/IP'), []);
});

test('extractRequires detects ~/.priv credential-store names as secrets', () => {
  assert.deepEqual(extractRequires('needs the token in ~/.priv/gumroad which is absent'),
    ['secret:gumroad']);
});

test('extractRequires caps at 10 entries', () => {
  const many = Array.from({ length: 20 }, (_, i) => `/home/h${i}: not found`).join('\n');
  assert.ok(extractRequires(many).length <= 10);
});

test('buildLesson caps reason to 500 chars and derives fields', () => {
  const l = buildLesson({
    at: '2026-08-04T00:00:00.000Z', kind: 'verify-fail', task: 't1',
    title: 'Deploy Blog Batch', persona: 'workflow-architect',
    agent: 'remote-ai-code-gen-cc-opus', attempt: 1,
    reason: 'x'.repeat(900), resultText: '/home/wayne: No such file'
  });
  assert.equal(l.reason.length, 500);
  assert.equal(l.agentFamily, 'remote-ai-code-gen-cc');
  assert.equal(l.titleSlug, 'deploy-blog-batch');
  assert.deepEqual(l.requiresGuess, ['path:/home/wayne']);
});

test('1-01/1-05: appendLesson writes one valid JSONL line, newlines escaped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
  try {
    const l = buildLesson({
      kind: 'wait-input', task: 't2', title: 'Which env?', persona: 'a',
      agent: 'remote-h-cc-opus', attempt: 0,
      reason: 'line one\nline two', questions: ['Which host?']
    });
    assert.equal(appendLesson(dir, l), true);
    const raw = readFileSync(join(dir, 'lessons.jsonl'), 'utf-8');
    assert.equal(raw.split('\n').filter(Boolean).length, 1);   // exactly one line
    const parsed = JSON.parse(raw.trim());                     // valid JSON
    assert.equal(parsed.kind, 'wait-input');
    assert.deepEqual(parsed.questions, ['Which host?']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1-04: appendLesson never throws on an unwritable dir (best-effort)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-ro-'));
  try {
    chmodSync(dir, 0o500);   // read+execute only — append should fail silently
    const l = buildLesson({ kind: 'verify-fail', task: 't3', title: 't', persona: 'a', agent: 'b', attempt: 1 });
    // Must return false, must NOT throw (dispatch lifecycle is protected).
    let threw = false;
    let ok = true;
    try { ok = appendLesson(join(dir, 'nested'), l); } catch { threw = true; }
    assert.equal(threw, false);
    // On most CI the write fails (false); if the runner is root it may succeed —
    // the contract we assert is "no throw", so accept either boolean.
    assert.equal(typeof ok, 'boolean');
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
    void existsSync;
  }
});
