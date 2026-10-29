import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyRejection, classifyWaitInput, computeQualityMetrics, metricsWindow, readLessons, unverifiableCause } from './quality-metrics.js';
import type { Lesson } from './lessons.js';
import type { Task } from '../types.js';

/**
 * Quality metrics (improvement plan §5): the §2 baseline table recomputed from
 * the lessons ledger + task store. Reason shapes are taken from the real ledger.
 */

const T0 = Date.parse('2026-10-13T00:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const lesson = (p: Partial<Lesson>): Lesson => ({
  at: at(0), kind: 'verify-fail', task: 't', titleSlug: '', agent: '', brain: 'b1', brainFamily: 'b', attempt: 1, reason: '', requiresGuess: [], ...p,
} as Lesson);

test('classifyRejection buckets the ledger reason shapes', () => {
  assert.equal(classifyRejection("You've hit your session limit · resets 9pm (Asia/Taipei)"), 'rateLimit');
  assert.equal(classifyRejection('Error: Individual quota reached. Please upgrade your subscription'), 'rateLimit');
  assert.equal(classifyRejection('matched failure pattern "too many requests"'), 'rateLimit');
  assert.equal(classifyRejection('TIMEOUT after 3000000ms'), 'timeout');
  assert.equal(classifyRejection('Error: timeout waiting for response'), 'timeout');
  assert.equal(classifyRejection('exit code 1'), 'exitCode');
  assert.equal(classifyRejection('exit code null'), 'exitCode');
  assert.equal(classifyRejection('verifier LLM: FAIL — no artifact'), 'quality');
  assert.equal(classifyRejection('dsh: TRANSPORT: Connection error.'), 'other');
});

test('classifyWaitInput: human-only wins over a permission phrasing', () => {
  assert.equal(classifyWaitInput(['Please log in to Pinterest in Profile 2, then reply done']), 'humanOnly');
  assert.equal(classifyWaitInput(['May I re-enable the workflow after you sign in?']), 'humanOnly');
  assert.equal(classifyWaitInput(['May I re-enable the daily-promo workflow?']), 'permissionChoice');
  assert.equal(classifyWaitInput(['Should I use option A or option B for the cover?']), 'permissionChoice');
  assert.equal(classifyWaitInput(['下一步是否要我執行移除 crontab？']), 'permissionChoice');
  assert.equal(classifyWaitInput(['What is the release name?']), 'other');
  assert.equal(classifyWaitInput([]), 'other');
});

test('computeQualityMetrics: classes, repeat rate-limit share, wait-input mix, timeouts/week', () => {
  const lessons = [
    lesson({ at: at(0), reason: "You've hit your session limit · resets 6:10am (Asia/Taipei)" }),
    lesson({ at: at(1), reason: "You've hit your session limit · resets 6:10am (Asia/Taipei)" }),   // repeat <30m, same brain
    lesson({ at: at(2), brain: 'b2', reason: 'rate limit reached' }),                                  // other brain → not a repeat
    lesson({ at: at(60), reason: 'rate limit reached' }),                                              // >30m after → not a repeat
    lesson({ at: at(70), reason: 'TIMEOUT after 3000000ms' }),
    lesson({ at: at(80), reason: 'exit code 1' }),
    lesson({ at: at(90), kind: 'wait-input', questions: ['Please click the verification link in your email'] }),
    lesson({ at: at(91), kind: 'wait-input', questions: ['Should I publish it now?'] }),
    lesson({ at: at(95), kind: 'blocked', reason: 'no token' }),
    lesson({ at: new Date(T0 - 30 * 86_400_000).toISOString(), reason: 'TIMEOUT after 1ms' }),        // outside window
  ];
  const tasks = [
    { id: 'a', status: 'done', createdAt: at(0), completedAt: at(5), context: { dispatched: true, hasEvidence: true, acceptance: ['x'] } },
    { id: 'b', status: 'done', createdAt: at(0), completedAt: at(6), context: { dispatched: true, hasEvidence: false, resultStatus: 'DONE_WITH_CONCERNS' } },
    { id: 'c', status: 'pending', createdAt: at(0), context: { dispatched: true, tier: 'mechanical', ranBrain: 'local-cc-opus-5-5', failedBrains: [{ brain: 'local-dsh-qwen3-8-27b' }] } },
    { id: 'd', status: 'scheduled', createdAt: at(0), context: {} },                                        // never dispatched → not in acceptance %
  ] as unknown as Task[];
  const m = computeQualityMetrics(lessons, tasks, T0 - 60_000, T0 + 7 * 86_400_000);
  assert.equal(m.rejections.total, 6);
  assert.deepEqual(m.rejections.byClass, { rateLimit: 4, timeout: 1, exitCode: 1, quality: 0, other: 0 });
  assert.deepEqual({ hits: m.repeatRateLimit.hits, repeats: m.repeatRateLimit.repeats, share: m.repeatRateLimit.share }, { hits: 4, repeats: 1, share: 25 });
  assert.deepEqual(m.waitInput, { total: 2, permissionChoice: 1, humanOnly: 1, other: 0 });
  assert.equal(m.blocked, 1);
  assert.deepEqual(m.done, { count: 2, withEvidence: 1, evidencePct: 50, doneWithConcerns: 1 });
  assert.deepEqual(m.acceptance, {
    tasks: 3,
    withAcceptance: 1,
    pct: 33.3,
    bySource: {
      human: { withAcceptance: 1, pct: 33.3 },
      sharpened: { withAcceptance: 0, pct: 0 }
    }
  });
  assert.deepEqual(m.specVerdicts, {
    total: 0,
    bySource: {
      human: { total: 0, judged: 0, approved: 0, changesRequested: 0, unverifiable: 0 },
      sharpened: { total: 0, judged: 0, approved: 0, changesRequested: 0, unverifiable: 0 }
    },
    unverifiableByCause: { 'no-judge': 0, 'judge-crashed': 0, 'judge-unverifiable': 0 },
    shadowGate: {
      decisive: 0, approved: 0, changesRequested: 0, unverifiable: 0, minDecisive: 10, volumeMet: false, maxFalseRejectRate: 0.1,
      rule: 'enforce only when decisive (APPROVED + CHANGES_REQUESTED) ≥ 10 AND sampled falseRejectRate ≤ 0.1; UNVERIFIABLE never counts'
    }
  });
  assert.equal(m.timeouts.count, 1);
  assert.ok(Math.abs(m.timeouts.perWeek! - 1) < 0.05);
  assert.deepEqual({ tagged: m.tiers.tagged, att: m.tiers.mechanicalAttempts, opus: m.tiers.mechanicalOpusAttempts }, { tagged: 1, att: 2, opus: 1 });
});

test('a rate-limit hit just before the window seeds repeat detection', () => {
  const lessons = [lesson({ at: at(-5), reason: 'rate limit reached' }), lesson({ at: at(5), reason: 'rate limit reached' })];
  const m = computeQualityMetrics(lessons, [], T0, T0 + 86_400_000);
  assert.equal(m.repeatRateLimit.hits, 1);
  assert.equal(m.repeatRateLimit.repeats, 1);
});

test('readLessons skips NUL-padded / torn lines; metricsWindow parses days / from', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-qm-'));
  fs.writeFileSync(path.join(dir, 'lessons.jsonl'),
    JSON.stringify(lesson({})) + '\n' + '\u0000'.repeat(40) + '\n{"at":"x","kind"\n' + JSON.stringify(lesson({ kind: 'wait-input' })) + '\n');
  const r = readLessons(dir);
  assert.equal(r.lessons.length, 2);
  assert.equal(r.skipped, 1);
  assert.deepEqual(readLessons(path.join(dir, 'missing')), { lessons: [], skipped: 0 });
  const now = Date.parse('2026-10-20T00:00:00Z');
  assert.deepEqual(metricsWindow({}, now), { from: now - 7 * 86_400_000, to: now });
  assert.deepEqual(metricsWindow({ days: '30' }, now), { from: now - 30 * 86_400_000, to: now });
  assert.equal(metricsWindow({ from: '2026-08-04T00:00:00+08:00' }, now).from, Date.parse('2026-08-03T16:00:00Z'));
});

test('computeQualityMetrics: splits acceptance and spec-verdicts by acceptanceSource', () => {
  const tasks = [
    {
      id: 'h1', status: 'done', createdAt: at(0), completedAt: at(5),
      context: {
        dispatched: true, acceptance: ['criterion 1'],
        specVerdict: { verdict: 'APPROVED', at: at(5) }
      }
    },
    {
      id: 's1', status: 'done', createdAt: at(10), completedAt: at(15),
      context: {
        dispatched: true, acceptance: ['sharpened 1', 'sharpened 2'], acceptanceSource: 'sharpened',
        specVerdict: { verdict: 'CHANGES_REQUESTED', at: at(15) }
      }
    },
    {
      id: 's2', status: 'done', createdAt: at(20), completedAt: at(25),
      context: {
        dispatched: true, acceptance: ['sharpened 3'], acceptanceSource: 'sharpened',
        specVerdict: { verdict: 'UNVERIFIABLE', at: at(25) }
      }
    },
    {
      id: 'n1', status: 'done', createdAt: at(30), completedAt: at(35),
      context: { dispatched: true }
    }
  ] as unknown as Task[];

  const m = computeQualityMetrics([], tasks, T0, T0 + 86_400_000);
  assert.equal(m.acceptance.tasks, 4);
  assert.equal(m.acceptance.withAcceptance, 3);
  assert.equal(m.acceptance.pct, 75);
  assert.deepEqual(m.acceptance.bySource, {
    human: { withAcceptance: 1, pct: 25 },
    sharpened: { withAcceptance: 2, pct: 50 }
  });

  assert.equal(m.specVerdicts.total, 3);
  assert.deepEqual(m.specVerdicts.bySource.human, {
    total: 1, judged: 1, approved: 1, changesRequested: 0, unverifiable: 0
  });
  assert.deepEqual(m.specVerdicts.bySource.sharpened, {
    total: 2, judged: 1, approved: 0, changesRequested: 1, unverifiable: 1
  });
});

// ── P1-1 shadow→enforce gate: only DECISIVE verdicts count ────────────────────

test('shadow gate counts only APPROVED + CHANGES_REQUESTED; UNVERIFIABLE never reaches the threshold', () => {
  const T0 = Date.parse('2026-10-30T00:00:00.000Z');
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const sv = (id: string, verdict: string, min: number, extra: Record<string, unknown> = {}) =>
    ({ id, status: 'done', createdAt: at(min), completedAt: at(min), context: { specVerdict: { verdict, at: at(min), ...extra } } });
  const tasks = [
    // 9 UNVERIFIABLE (the 2026-10-20 window had 8/14) …
    ...Array.from({ length: 7 }, (_, i) => sv(`nj${i}`, 'UNVERIFIABLE', i, { summary: 'UNVERIFIABLE — no judge brain available (disabled or cooling)' })),
    sv('cr0', 'UNVERIFIABLE', 10, { crashed: true, summary: 'UNVERIFIABLE — judge crashed or timed out (fail-open)' }),
    sv('ju0', 'UNVERIFIABLE', 11, { cause: 'judge-unverifiable', summary: 'all criteria unverifiable' }),
    // … and only 5 decisive verdicts.
    sv('a0', 'APPROVED', 20), sv('a1', 'APPROVED', 21), sv('a2', 'APPROVED', 22), sv('a3', 'APPROVED', 23),
    sv('c0', 'CHANGES_REQUESTED', 24),
  ] as unknown as Task[];

  const m = computeQualityMetrics([], tasks, T0, T0 + 86_400_000);
  assert.equal(m.specVerdicts.total, 14, 'all 14 are still reported');
  assert.deepEqual(m.specVerdicts.unverifiableByCause, { 'no-judge': 7, 'judge-crashed': 1, 'judge-unverifiable': 1 });
  const g = m.specVerdicts.shadowGate;
  assert.equal(g.decisive, 5);
  assert.equal(g.approved, 4);
  assert.equal(g.changesRequested, 1);
  assert.equal(g.unverifiable, 9);
  assert.equal(g.volumeMet, false, '14 total but only 5 decisive must NOT meet the ≥10 gate');

  const more = [...tasks, ...Array.from({ length: 5 }, (_, i) => sv(`b${i}`, 'APPROVED', 30 + i))] as unknown as Task[];
  const m2 = computeQualityMetrics([], more, T0, T0 + 86_400_000);
  assert.equal(m2.specVerdicts.shadowGate.decisive, 10);
  assert.equal(m2.specVerdicts.shadowGate.volumeMet, true);
});

test('shadow gate honours minDecisive / maxFalseRejectRate overrides and the window start (post-deploy verdicts only)', () => {
  const T0 = Date.parse('2026-10-30T00:00:00.000Z');
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const tasks = [-60, 5, 6, 7].map((min, i) => ({
    id: `t${i}`, status: 'done', createdAt: at(min), completedAt: at(min),
    context: { specVerdict: { verdict: 'APPROVED', at: at(min) } },
  })) as unknown as Task[];
  const m = computeQualityMetrics([], tasks, T0, T0 + 86_400_000, { minDecisive: 3, maxFalseRejectRate: 0.05 });
  assert.equal(m.specVerdicts.shadowGate.decisive, 3, 'the verdict before the window start (deploy) is excluded');
  assert.equal(m.specVerdicts.shadowGate.volumeMet, true);
  assert.equal(m.specVerdicts.shadowGate.maxFalseRejectRate, 0.05);
});

test('unverifiableCause: explicit cause wins; legacy records classified from summary / crashed', () => {
  assert.equal(unverifiableCause({ cause: 'judge-crashed' }), 'judge-crashed');
  assert.equal(unverifiableCause({ summary: 'UNVERIFIABLE — no judge brain available (disabled or cooling)' }), 'no-judge');
  assert.equal(unverifiableCause({ crashed: true, summary: 'judge crashed' }), 'judge-crashed');
  assert.equal(unverifiableCause({ summary: 'criteria could not be checked' }), 'judge-unverifiable');
});
