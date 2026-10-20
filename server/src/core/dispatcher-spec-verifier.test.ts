import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { Store, isFailedTask } from './store.js';
import { EventBus } from './events.js';
import type { Config, SpecVerdictMode, Task } from '../types.js';

/**
 * P1-1: Spec-compliance verifier (cross-family judge, 7-day shadow, then enforce).
 * Covers:
 *  1. Shadow mode records context.specVerdict + lessons.jsonl kind="quality-shadow" and NEVER rejects.
 *  2. Enforce mode rejects CHANGES_REQUESTED, hands over to next brain, and appends failing criteria to brief.
 *  3. Judge crash / timeout fails open (UNVERIFIABLE, crashed=true) even in enforce mode.
 *  4. All judges cooling / unavailable records UNVERIFIABLE and does not reject.
 *  5. Legacy tasks (without acceptance criteria) are untouched and use legacy llmVerdict.
 */

const CHAIN = ['remote-examplehost-cc-opus', 'remote-examplehost-cc-fable', 'local-cc-opus-5-5'];

function harness(mode: SpecVerdictMode = 'shadow') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-spec-verifier-'));
  const paths = {
    inbox: path.join(root, 'inbox'),
    artifacts: path.join(root, 'artifacts'),
    inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'),
    decisions: path.join(root, 'decisions'),
    workflows: path.join(root, 'workflows'),
    agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });

  const brains: Record<string, any> = {
    'remote-examplehost-cc-opus': { location: 'remote', exec: 'claude', model: 'claude-opus-5-5' },
    'remote-examplehost-cc-fable': { location: 'remote', exec: 'claude', model: 'claude-fable-5-5' },
    'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' },
    'local-agy-gemini-4-argon-medium': { location: 'local', exec: 'agy', model: 'gemini-4-argon-medium' },
    'local-agy-gemini-3.8-flash-high': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-high' },
    'local-agy-claude-opus-5-5-medium': { location: 'local', exec: 'agy', model: 'claude-opus-5-5-medium' },
  };

  const config = {
    paths,
    platforms: {},
    inbox: { maxRetries: 3 },
    orchestration: {
      verifier: {
        enabled: true,
        llm: { enabled: true },
        spec: {
          enabled: true,
          mode,
          enforceAfter: '2026-10-27T02:00:00.000Z',
          maxFalseRejectRate: 0.10,
          judges: {
            claude: ['local-agy-gemini-4-argon-medium', 'local-agy-gemini-3.8-flash-high'],
            gemini: ['local-agy-claude-opus-5-5-medium', 'local-cc-opus-5-5'],
            qwen: ['local-agy-claude-opus-5-5-medium', 'local-cc-opus-5-5'],
            default: ['local-agy-claude-opus-5-5-medium', 'local-cc-opus-5-5'],
          },
        },
      },
      agents: { engineer: { description: '', brains: CHAIN } },
      brains,
    },
  } as unknown as Config;

  const store = new Store(config, new EventBus());
  const dispatcher = new Dispatcher(config, store, new EventBus());

  let legacyLlmCalls = 0;
  (dispatcher as any).llmVerdict = async () => {
    legacyLlmCalls++;
    return { ok: true };
  };

  const specCalls: Array<{ judgeId: string; prompt: string }> = [];
  let specJudgeStub: (judgeId: string, prompt: string) => Promise<{ ok: boolean; text: string }> = async (judgeId, prompt) => {
    specCalls.push({ judgeId, prompt });
    return {
      ok: true,
      text: '1. PASS — criterion satisfied\nVERDICT: APPROVED',
    };
  };
  (dispatcher as any).runSpecJudge = (judgeId: string, prompt: string) => specJudgeStub(judgeId, prompt);

  store.setCompletionGuard((t, r) => (dispatcher as any).verifyReportedCompletion(t, r));

  const createInProgress = (opts: { acceptance?: string[]; description?: string; acceptanceSource?: 'human' | 'sharpened' } = {}): Task => {
    const t = store.createTask({
      title: 'Implement feature X',
      description: opts.description ?? 'Build feature X and write report.md.',
      acceptance: opts.acceptance,
      from: { platform: 'test', agent: 'tester' },
    } as any);
    t.status = 'in-progress';
    t.context = {
      ...(t.context || {}),
      agent: 'engineer',
      brain: CHAIN[0],
      brainAuto: true,
      attempts: 0,
      ...(opts.acceptance ? { acceptance: opts.acceptance } : {}),
      ...(opts.acceptanceSource ? { acceptanceSource: opts.acceptanceSource } : {}),
    };
    store.saveTask(t);
    return t;
  };

  const lessons = () => {
    const f = path.join(paths.decisions, 'lessons.jsonl');
    return fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
  };

  return {
    config,
    store,
    dispatcher,
    paths,
    createInProgress,
    lessons,
    legacyLlmCalls: () => legacyLlmCalls,
    specCalls,
    setSpecJudge: (fn: (judgeId: string, prompt: string) => Promise<{ ok: boolean; text: string }>) => {
      specJudgeStub = async (judgeId, prompt) => {
        specCalls.push({ judgeId, prompt });
        return fn(judgeId, prompt);
      };
    },
  };
}

test('shadow mode: stores context.specVerdict + lessons.jsonl kind="quality-shadow" and NEVER rejects CHANGES_REQUESTED', async () => {
  const h = harness('shadow');
  h.setSpecJudge(async () => ({
    ok: true,
    text: [
      '1. PASS — tests executed',
      '2. FAIL — report.md was not created in artifacts/',
      'VERDICT: CHANGES_REQUESTED',
    ].join('\n'),
  }));

  const t = h.createInProgress({
    acceptance: ['Unit tests pass', 'report.md is created in artifacts/'],
  });
  // Create a 3000-byte result so it is not classified as a small task -> uses primary Gemini Argon judge
  const resultText = 'Detailed work report. '.repeat(140) + '\nSTATUS: DONE\nEVIDENCE:\n- npm test → 10 passed';
  const out = await h.store.completeTask({ taskId: t.id, result: resultText });

  assert.equal(out!.status, 'done', 'shadow mode must never reject');
  assert.equal(isFailedTask(out!), false);
  assert.equal(h.legacyLlmCalls(), 0, 'legacy llmVerdict is not called when acceptance is present');
  assert.equal(h.specCalls.length, 1);
  assert.equal(h.specCalls[0].judgeId, 'local-agy-gemini-4-argon-medium', 'claude executor is judged by Gemini Argon');

  const sv = out!.context!.specVerdict;
  assert.ok(sv, 'context.specVerdict is recorded');
  assert.equal(sv!.verdict, 'CHANGES_REQUESTED');
  assert.equal(sv!.mode, 'shadow');
  assert.equal(sv!.judgeBrain, 'local-agy-gemini-4-argon-medium');
  assert.equal(sv!.criteria.length, 2);
  assert.equal(sv!.criteria[1].status, 'FAIL');

  const ls = h.lessons();
  assert.equal(ls.length, 1);
  assert.equal(ls[0].kind, 'quality-shadow');
  assert.equal(ls[0].brain, CHAIN[0]);
  assert.match(ls[0].reason, /report\.md was not created/);
});

test('enforce mode: CHANGES_REQUESTED rejects, hands over to next brain, and appends failing criteria to brief', async () => {
  const h = harness('enforce');
  h.setSpecJudge(async () => ({
    ok: true,
    text: [
      '1. PASS — build passed',
      '2. FAIL — missing migration file 002_init.sql',
      'VERDICT: CHANGES_REQUESTED',
    ].join('\n'),
  }));

  const t = h.createInProgress({
    description: 'Create migration and run build.',
    acceptance: ['npm run build exits 0', 'migration 002_init.sql exists'],
  });
  const artDir = path.join(h.paths.artifacts, t.id);
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'build.log'), 'Build succeeded\n');

  const out = await h.store.completeTask({
    taskId: t.id,
    result: 'Finished build.\nSTATUS: DONE\nEVIDENCE:\n- npm run build → 0',
  });

  // Handed over to next brain in CHAIN
  assert.equal(out!.status, 'pending', 'rejected deliverable is re-queued for next brain');
  assert.equal(out!.context!.attempts, 1, 'attempt counter advanced for next brain');
  const nextPlan = (h.dispatcher as any).planFor(out!);
  assert.equal(nextPlan.brain || nextPlan.exec?.brainId, CHAIN[1], 'next rung in chain is selected');
  assert.equal(out!.context!.failedBrains?.length, 1);
  assert.equal(out!.context!.failedBrains?.[0].brain, CHAIN[0]);
  assert.equal(out!.context!.specVerdict?.verdict, 'CHANGES_REQUESTED');
  assert.equal(out!.context!.specVerdict?.mode, 'enforce');

  // Failing criteria appended to task.description
  assert.match(out!.description, /# Spec verifier findings \(attempt 1 rejected by/);
  assert.match(out!.description, /- migration 002_init\.sql exists — missing migration file 002_init\.sql/);

  // Prompt included artifact byte size
  assert.match(h.specCalls[0].prompt, /build\.log \(16 bytes\)/);

  // Recorded as verify-fail in lessons.jsonl
  const ls = h.lessons();
  assert.ok(ls.some(l => l.kind === 'verify-fail' && /missing migration file/.test(l.reason)));
});

test('judge crash or timeout fails open (UNVERIFIABLE, crashed=true) even in enforce mode', async () => {
  const h = harness('enforce');
  h.setSpecJudge(async () => ({
    ok: false,
    text: 'Command timed out after 300000ms',
  }));

  const t = h.createInProgress({
    acceptance: ['Tests pass'],
  });
  const out = await h.store.completeTask({
    taskId: t.id,
    result: 'All tests pass.\nSTATUS: DONE\nEVIDENCE:\n- npm test → pass',
  });

  assert.equal(out!.status, 'done', 'judge crash/timeout must fail open and not reject');
  assert.equal(isFailedTask(out!), false);
  assert.equal(out!.context!.specVerdict?.verdict, 'UNVERIFIABLE');
  assert.equal(out!.context!.specVerdict?.crashed, true);
});

test('all cross-family judges cooling/unavailable records UNVERIFIABLE and does not reject', async () => {
  const h = harness('enforce');
  // Put both Gemini judges into cooldown
  (h.dispatcher as any).noteRateLimit('local-agy-gemini-4-argon-medium', 'rate limit reached', 'rate limit reached', true);
  (h.dispatcher as any).noteRateLimit('local-agy-gemini-3.8-flash-high', 'rate limit reached', 'rate limit reached', true);

  const t = h.createInProgress({
    acceptance: ['Tests pass'],
  });
  const out = await h.store.completeTask({
    taskId: t.id,
    result: 'All tests pass.\nSTATUS: DONE\nEVIDENCE:\n- npm test → pass',
  });

  assert.equal(out!.status, 'done', 'no available judge must fail open');
  assert.equal(h.specCalls.length, 0, 'no judge invoked when all are cooling');
  assert.equal(out!.context!.specVerdict?.verdict, 'UNVERIFIABLE');
  assert.equal(out!.context!.specVerdict?.judgeBrain, null);
});

test('legacy task without acceptance criteria is untouched by spec verifier and uses legacy llmVerdict', async () => {
  const h = harness('enforce');
  const t = h.createInProgress(); // no acceptance

  const out = await h.store.completeTask({
    taskId: t.id,
    result: 'Completed legacy task.\nSTATUS: DONE\nEVIDENCE:\n- ls → ok',
  });

  assert.equal(out!.status, 'done');
  assert.equal(out!.context!.specVerdict, undefined, 'specVerdict not set on legacy tasks');
  assert.equal(h.specCalls.length, 0, 'spec judge not called on legacy tasks');
  assert.equal(h.legacyLlmCalls(), 1, 'legacy llmVerdict still runs');
});

test('sharpened criteria are judged in shadow even when spec verifier mode is enforce (PS-1 shadow override)', async () => {
  const h = harness('enforce');
  h.setSpecJudge(async () => ({
    ok: true,
    text: [
      '1. FAIL — Missing tests',
      'VERDICT: CHANGES_REQUESTED',
    ].join('\n'),
  }));

  const t = h.createInProgress({
    acceptance: ['Tests pass with 100% coverage'],
    acceptanceSource: 'sharpened',
  });

  const out = await h.store.completeTask({
    taskId: t.id,
    result: 'Detailed work report. '.repeat(140) + '\nSTATUS: DONE\nEVIDENCE:\n- npm test → pass',
  });

  // Must NOT reject because sharpened criteria run in shadow mode even under enforce
  assert.equal(out!.status, 'done', 'sharpened criteria must not reject under spec.mode=enforce when sharpener.mode=shadow');
  assert.equal(out!.context!.specVerdict?.mode, 'shadow');
  assert.equal(out!.context!.specVerdict?.verdict, 'CHANGES_REQUESTED');

  // Verify that quality-shadow was recorded in lessons
  const lessons = h.lessons();
  const shadowLesson = lessons.find(l => l.kind === 'quality-shadow');
  assert.ok(shadowLesson, 'must record quality-shadow lesson');
  assert.equal(shadowLesson!.task, t.id);
});

test('sharpened criteria enforce when orchestration.sharpener.mode is explicitly enforce', async () => {
  const h = harness('enforce');
  (h.config.orchestration as any).sharpener = { enabled: true, mode: 'enforce' };

  h.setSpecJudge(async () => ({
    ok: true,
    text: [
      '1. FAIL — Missing tests',
      'VERDICT: CHANGES_REQUESTED',
    ].join('\n'),
  }));

  const t = h.createInProgress({
    acceptance: ['Tests pass with 100% coverage'],
    acceptanceSource: 'sharpened',
  });

  const out = await h.store.completeTask({
    taskId: t.id,
    result: 'Detailed work report. '.repeat(140) + '\nSTATUS: DONE\nEVIDENCE:\n- npm test → pass',
  });

  // When sharpener.mode === 'enforce', CHANGES_REQUESTED rejects and hands over
  assert.equal(out!.status, 'pending', 'rejected task re-enters pending pool for next brain');
  assert.equal(out!.context!.attempts, 1, 'attempt counter advanced');
  assert.equal(out!.context!.specVerdict?.mode, 'enforce');
  assert.equal(out!.context!.specVerdict?.verdict, 'CHANGES_REQUESTED');
});
