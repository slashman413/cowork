import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { parseBrief, renderBriefSections } from './brief.js';
import type { Config } from '../types.js';

/**
 * P0-3 brief contract: context.acceptance / verify / timeboxMin / scope survive
 * a store round-trip and render as their own prompt sections.
 */

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-brief-'));
  const paths = {
    inbox: path.join(root, 'inbox'), artifacts: path.join(root, 'artifacts'), inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'), decisions: path.join(root, 'decisions'),
    agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
  const config = {
    paths, platforms: {}, server: { port: 6868 },
    inbox: { maxRetries: 3 },
    orchestration: { agents: {}, brains: {} }
  } as unknown as Config;
  const store = new Store(config, new EventBus());
  const dispatcher = new Dispatcher(config, store, new EventBus());
  return { root, paths, config, store, dispatcher };
}

const BRIEF = {
  acceptance: ['report.md exists in the artifacts dir', 'npm test exits 0'],
  verify: ['test -s report.md', 'cd server && npm test'],
  timeboxMin: 30,
  scope: { write: ['server/src/core/'], forbid: ['~/.cowork/config.json'] }
};

test('brief fields round-trip through the store (on disk) and are normalized', () => {
  const { store } = harness();
  const t = store.createTask({
    title: 't', description: 'd', from: { platform: 'p', agent: 'a' }, to: {}, priority: 'normal',
    context: { ...BRIEF, acceptance: [...BRIEF.acceptance, '  '], other: 1 }
  });
  const back = new Store((store as any).config, new EventBus()).getTask(t.id)!;
  assert.deepEqual(back.context?.acceptance, BRIEF.acceptance);   // blank entry dropped
  assert.deepEqual(back.context?.verify, BRIEF.verify);
  assert.equal(back.context?.timeboxMin, 30);
  assert.deepEqual(back.context?.scope, BRIEF.scope);
  assert.equal(back.context?.other, 1);
  // A lone string is accepted where a list is expected.
  const one = store.createTask({ title: 't', description: 'd', from: { platform: 'p', agent: 'a' }, to: {}, priority: 'normal', context: { verify: 'npm test' } });
  assert.deepEqual(one.context?.verify, ['npm test']);
});

test('a malformed brief is rejected at creation', () => {
  const { store } = harness();
  const mk = (context: Record<string, any>) => () => store.createTask({ title: 't', description: 'd', from: { platform: 'p', agent: 'a' }, to: {}, priority: 'normal', context });
  assert.throws(mk({ acceptance: [1, 2] }), /context\.acceptance must be an array of strings/);
  assert.throws(mk({ timeboxMin: -5 }), /timeboxMin/);
  assert.throws(mk({ scope: ['x'] }), /scope must be an object/);
});

test('buildPrompt renders acceptance / verify / timebox / scope as their own sections, not in the context JSON', () => {
  const { store, dispatcher } = harness();
  const t = store.createTask({ title: 'ship it', description: 'do the thing', from: { platform: 'p', agent: 'a' }, to: {}, priority: 'normal', context: { ...BRIEF, note: 'keep-me' } });
  const prompt: string = (dispatcher as any).buildPrompt(t, { agent: 'engineer', isRoster: false });
  for (const h of ['# Acceptance criteria', '# How to verify', '# Timebox', '# Scope']) assert.ok(prompt.includes(h), `missing ${h}`);
  assert.ok(prompt.includes('- [ ] report.md exists in the artifacts dir'));
  assert.ok(prompt.includes('- cd server && npm test'));
  assert.ok(prompt.includes('at most 30 min'));
  assert.ok(prompt.includes('- ~/.cowork/config.json'));
  // Sections come after the task text and before the context dump, which no longer carries the brief.
  assert.ok(prompt.indexOf('do the thing') < prompt.indexOf('# Acceptance criteria'));
  const ctxJson = prompt.slice(prompt.indexOf('# Context'));
  assert.ok(ctxJson.includes('keep-me'));
  assert.ok(!ctxJson.includes('"acceptance"') && !ctxJson.includes('"timeboxMin"'));
});

test('a task without a brief gets no acceptance/verify/scope sections, but buildPrompt renders the default timebox (taskTimeoutMs/60000 - 5)', () => {
  const { store, dispatcher } = harness();
  const t = store.createTask({ title: 'x', description: 'y', from: { platform: 'p', agent: 'a' }, to: {}, priority: 'normal' });
  const prompt: string = (dispatcher as any).buildPrompt(t, { agent: 'engineer', isRoster: false });
  assert.ok(!prompt.includes('# Acceptance criteria') && !prompt.includes('# How to verify') && !prompt.includes('# Scope'));
  assert.ok(prompt.includes('# Timebox'));
  assert.ok(prompt.includes('Spend at most 45 min on this task.'));
  assert.ok(prompt.includes('At T-5 min: write `progress.md` and return partial results with WAITING_ON_BACKGROUND or STATUS: BLOCKED'));
  assert.deepEqual(renderBriefSections(undefined), []);
});

test('P1-3 progress.md: absent on first run, injected on re-run/handover under "# Prior progress — resume, do not redo", capped to last 4 KB', () => {
  const { store, dispatcher, paths } = harness();
  const t = store.createTask({ title: 'render video', description: 'render 10 songs', from: { platform: 'p', agent: 'a' }, to: {}, priority: 'normal' });

  // 1) First run — no progress.md on disk → section absent.
  const firstPrompt: string = (dispatcher as any).buildPrompt(t, { agent: 'engineer', isRoster: false });
  assert.ok(!firstPrompt.includes('# Prior progress — resume, do not redo'));

  // 2) Brain writes artifacts/<id>/progress.md, then task is re-run / handed over.
  const artDir = path.join(paths.artifacts, t.id);
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'progress.md'), [
    '- [x] step 1: generated 5 songs — songs/01..05.wav (42 MB)',
    '- [x] step 2: generated covers — covers/01..05.png',
    '- [ ] step 3: ffmpeg assembly'
  ].join('\n'));

  const rerunPrompt: string = (dispatcher as any).buildPrompt(t, { agent: 'engineer', isRoster: false });
  assert.ok(rerunPrompt.includes('# Prior progress — resume, do not redo'));
  assert.ok(rerunPrompt.includes('- [x] step 1: generated 5 songs — songs/01..05.wav (42 MB)'));
  assert.ok(rerunPrompt.includes('- [ ] step 3: ffmpeg assembly'));

  // 3) Size cap — a 10 KB progress.md is truncated to the last 4 KB (4096 bytes), keeping recent steps.
  const earlyMarker = '- [x] step 0: very old step that should be dropped\n';
  const filler = Array.from({ length: 120 }, (_, i) => `- [x] filler step ${i} — artifact_${i}.bin (1024B)`).join('\n');
  const recentMarker = '\n- [x] step 99: final completed checkpoint — output_99.mp4 (88MB)';
  const bigProgress = earlyMarker + filler + recentMarker;
  assert.ok(Buffer.byteLength(bigProgress, 'utf-8') > 6000);
  fs.writeFileSync(path.join(artDir, 'progress.md'), bigProgress);

  const cappedLedger: string = (dispatcher as any).readProgressLedger(t.id);
  assert.ok(Buffer.byteLength(cappedLedger, 'utf-8') <= Dispatcher.PROGRESS_LEDGER_MAX_BYTES);
  assert.ok(!cappedLedger.includes('step 0: very old step'));
  assert.ok(cappedLedger.includes('step 99: final completed checkpoint — output_99.mp4 (88MB)'));

  const cappedPrompt: string = (dispatcher as any).buildPrompt(t, { agent: 'engineer', isRoster: false });
  assert.ok(cappedPrompt.includes('# Prior progress — resume, do not redo'));
  assert.ok(!cappedPrompt.includes('step 0: very old step'));
  assert.ok(cappedPrompt.includes('step 99: final completed checkpoint — output_99.mp4 (88MB)'));
});

test('P1-3 timeout captures progress.md and mentions it in the lessons.jsonl event', async () => {
  const { store, paths } = harness();
  const config: Config = {
    ...(store as any).config,
    orchestration: {
      enabled: true,
      maxConcurrent: 1,
      pollIntervalMs: 1000,
      taskTimeoutMs: 3000000,
      defaultRole: 'generalist',
      verifier: { enabled: true },
      agents: { engineer: { description: '', brains: ['b1', 'b2'] } },
      brains: {
        b1: { description: '', location: 'remote' },
        b2: { description: '', location: 'remote' }
      }
    }
  };
  const dispatcher = new Dispatcher(config, store, new EventBus());
  const t = store.createTask({
    title: 'Daily NLM Gumroad Products Promotion Videos',
    description: 'render promos',
    from: { platform: 'p', agent: 'a' },
    to: {},
    priority: 'normal',
    context: { agent: 'engineer', brain: 'b1', brainAuto: true, attempts: 0 }
  });
  const artDir = path.join(paths.artifacts, t.id);
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'progress.md'), '- [x] rendered video 1 — promo1.mp4 (22MB)\n- [x] rendered video 2 — promo2.mp4 (31MB)\n');

  const decision = await (dispatcher as any).verifyReportedCompletion(t, 'TIMEOUT after 3000000ms\npartial stdout');
  assert.equal(decision.action, 'handover');

  const ledger = path.join(paths.decisions, 'lessons.jsonl');
  const lessons = fs.readFileSync(ledger, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const timeoutLesson = lessons.find(l => l.task === t.id && l.kind === 'verify-fail');
  assert.ok(timeoutLesson, 'expected verify-fail lesson on timeout');
  assert.match(timeoutLesson.reason, /TIMEOUT after 3000000ms/);
  assert.match(timeoutLesson.reason, /progress\.md/);
  assert.match(timeoutLesson.reason, /2 step\(s\) done/);
});

test('orchestrator prompt demands acceptance + verify on every subtask POST', () => {
  const { store, dispatcher } = harness();
  const t = store.createTask({ title: 'plan', description: 'big job', from: { platform: 'p', agent: 'a' }, to: {}, priority: 'normal' });
  const prompt: string = (dispatcher as any).buildPrompt(t, { agent: 'orchestrator', isRoster: false });
  assert.ok(prompt.includes('"context":{"acceptance":['));
  assert.ok(prompt.includes('A subtask you cannot write acceptance for is not scoped yet'));
});

test('orchestrator-created task without acceptance is logged as a brief-missing-acceptance lesson (not rejected)', () => {
  const { store, paths } = harness();
  const ledger = path.join(paths.decisions, 'lessons.jsonl');
  const bare = store.createTask({ title: 'sub', description: 'd', from: { platform: 'claude', agent: 'orchestrator' }, to: {}, priority: 'normal' });
  assert.equal(bare.status, 'pending');
  store.createTask({ title: 'sub2', description: 'd', from: { platform: 'claude', agent: 'orchestrator' }, to: {}, priority: 'normal', context: { acceptance: ['x'] } });
  store.createTask({ title: 'human', description: 'd', from: { platform: 'web', agent: 'ceo' }, to: {}, priority: 'normal' });
  const lessons = fs.readFileSync(ledger, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].kind, 'brief-missing-acceptance');
  assert.equal(lessons[0].task, bare.id);
});

