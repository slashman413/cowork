import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyRejection, classifyWaitInput, computeQualityMetrics, metricsWindow, readLessons } from './quality-metrics.js';
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
  assert.deepEqual(m.acceptance, { tasks: 3, withAcceptance: 1, pct: 33.3 });
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
