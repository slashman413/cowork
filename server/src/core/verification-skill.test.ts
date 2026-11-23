import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderVerificationSkillPrompt } from './verification-skill.js';
import { pstackHarness } from './pstack-test-harness.js';

function fakeHome(withSkill = true): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  if (withSkill) {
    const dir = path.join(home, '.agents', 'skills', 'verification-before-completion');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Verification Before Completion\n');
  }
  return home;
}

const on = { enabled: true };
const verifyCtx = { verify: ['npm test'] };

test('S1: off by default and when the flag is false', () => {
  const home = fakeHome();
  assert.deepEqual(renderVerificationSkillPrompt({ context: verifyCtx, isLocal: true, home }), []);
  assert.deepEqual(renderVerificationSkillPrompt({ context: verifyCtx, isLocal: true, home, cfg: { enabled: false } }), []);
});

test('S1: local agent with context.verify gets one pointer line to the installed SKILL.md', () => {
  const home = fakeHome();
  const lines = renderVerificationSkillPrompt({ context: verifyCtx, isLocal: true, home, cfg: on });
  assert.equal(lines[0], '# Before you claim completion');
  assert.ok(lines[1].includes(path.join(home, '.agents/skills/verification-before-completion/SKILL.md')));
  assert.equal(lines.length, 3);
});

test('S1: remote agent gets the Iron Law inline, no local path', () => {
  const lines = renderVerificationSkillPrompt({ context: verifyCtx, isLocal: false, home: fakeHome(false), cfg: on });
  const body = lines.join('\n');
  assert.match(body, /NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE/);
  assert.ok(!body.includes('.agents/skills'));
});

test('S1: nothing without a verify list, with the overlapping pstack card, or (local) with the skill missing', () => {
  const home = fakeHome();
  assert.deepEqual(renderVerificationSkillPrompt({ context: {}, isLocal: true, home, cfg: on }), []);
  assert.deepEqual(renderVerificationSkillPrompt({ context: { verify: ['  '] }, isLocal: true, home, cfg: on }), []);
  assert.deepEqual(renderVerificationSkillPrompt({ context: { ...verifyCtx, skill: 'principle-prove-it-works' }, isLocal: true, home, cfg: on }), []);
  assert.deepEqual(renderVerificationSkillPrompt({ context: verifyCtx, isLocal: true, home: fakeHome(false), cfg: on }), []);
});

test('S1: a custom path with ~ expands against home', () => {
  const home = fakeHome();
  fs.writeFileSync(path.join(home, 'v.md'), 'x');
  const lines = renderVerificationSkillPrompt({ context: verifyCtx, isLocal: true, home, cfg: { enabled: true, path: '~/v.md' } });
  assert.ok(lines[1].includes(path.join(home, 'v.md')));
});

test('S1 buildPrompt: the section reaches a verify task only when enabled', () => {
  const skill = path.join(fakeHome(), '.agents/skills/verification-before-completion/SKILL.md');
  const plan = { persona: 'engineer', isRoster: false, exec: 'claude', agentId: 'local-cc-opus-5-5' };
  const offH = pstackHarness();
  assert.doesNotMatch((offH.dispatcher as any).buildPrompt(offH.mk(verifyCtx), plan), /# Before you claim completion/);
  const h = pstackHarness({ verificationSkill: { enabled: true, path: skill } });
  const withVerify = (h.dispatcher as any).buildPrompt(h.mk(verifyCtx), plan);
  assert.match(withVerify, /# How to verify[\s\S]*# Before you claim completion/);
  assert.ok(withVerify.includes(skill));
  assert.doesNotMatch((h.dispatcher as any).buildPrompt(h.mk({}), plan), /# Before you claim completion/);
});
