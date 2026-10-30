import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REMEDY_ORDER, groupLessons, lessonSignature, normalizeReason, remedyMenu, draftProposal, correctLoop, remedySelectOptions, literalPhrase, MIN_CITED } from './correct-loop.js';
import type { Lesson } from './lessons.js';

/**
 * P2-2 correct loop: lessons → classes (≥2) → a structure-first remedy menu
 * whose every structural option cites ≥2 past events its check would catch.
 * Reason shapes are taken from the real decisions/lessons.jsonl.
 */

const T0 = Date.parse('2026-10-01T00:00:00Z');
let n = 0;
const L = (over: Partial<Lesson> & { min?: number }): Lesson => {
  const { min = n * 60, ...rest } = over;
  n++;
  return {
    at: new Date(T0 + min * 60_000).toISOString(), kind: 'verify-fail', task: `task-${n}`, titleSlug: 'some-task', agent: 'eng',
    brain: 'remote-host-cc-opus', brainFamily: 'remote-host-cc', attempt: 1, reason: '', requiresGuess: [], ...rest,
  };
};

test('the remedy menu order is structure first, prose note last', () => {
  assert.deepEqual([...REMEDY_ORDER], ['router-rule', 'brain-cooldown', 'env-requires', 'verifier-pattern', 'workflow-gate', 'acceptance-criterion', 'conventions-note']);
});

test('normalizeReason collapses reset times, ids and numbers so recurrences group', () => {
  const a = normalizeReason("You've hit your session limit · resets 3pm (Asia/Taipei)");
  const b = normalizeReason("You've hit your session limit · resets 11:30am (Asia/Taipei)");
  assert.equal(a, b);
  assert.equal(normalizeReason('timeout after 300000ms'), normalizeReason('timeout after 600000ms'));
  assert.equal(literalPhrase('verifier LLM: off-topic answer, ignores the brief 3x'), 'off-topic answer ignores the');
  assert.equal(literalPhrase('exit 1'), '');
});

test('groupLessons: ≥2 occurrences make a class; singletons are dropped', () => {
  const cls = groupLessons([L({ reason: 'timeout after 300000ms' }), L({ reason: 'timeout after 900000ms' }), L({ reason: 'exit code 1' })]);
  assert.equal(cls.length, 1);
  assert.equal(cls[0].count, 2);
  assert.equal(cls[0].signature, lessonSignature(L({ reason: 'timeout after 1ms' })));
});

test('rate-limit class → brain cooldown first, citing the repeat hits it would have prevented', () => {
  const evs = [
    L({ min: 0, reason: "You've hit your session limit · resets 3pm (Asia/Taipei)" }),
    L({ min: 5, reason: "You've hit your session limit · resets 3pm (Asia/Taipei)" }),
    L({ min: 10, reason: "You've hit your session limit · resets 3pm (Asia/Taipei)" }),
    L({ min: 500, reason: "You've hit your session limit · resets 9pm (Asia/Taipei)" }),
  ];
  const p = draftProposal(groupLessons(evs)[0]);
  assert.equal(p.recommended, 'brain-cooldown');
  assert.equal(p.unenforced, false);
  const cd = p.remedies[0];
  assert.deepEqual(cd.caught.map(c => c.task), [evs[1].task, evs[2].task]);   // the 500-min one was outside the window
  assert.ok(!p.remedies.some(r => r.id === 'router-rule'), 'a transient rate limit is not a routing problem');
  assert.equal(p.remedies[p.remedies.length - 1].id, 'conventions-note');
});

test('brain-specific failure → router rule first; menu stays in REMEDY_ORDER', () => {
  const evs = [
    L({ reason: 'Error: invalid model selection (--model "gemini-3.1-pro-high" --effort high)', brain: 'local-agy-gemini', brainFamily: 'local-agy', requiresGuess: ['tool:agy'] }),
    L({ reason: 'Error: invalid model selection (--model "gemini-3.1-pro-high" --effort low)', brain: 'local-agy-gemini', brainFamily: 'local-agy', requiresGuess: ['tool:agy'] }),
    L({ reason: 'Error: invalid model selection (--model "gemini-3.1-pro-high" --effort max)', brain: 'local-agy-gemini2', brainFamily: 'local-agy', requiresGuess: ['tool:agy'] }),
  ];
  const menu = remedyMenu(groupLessons(evs)[0]);
  assert.deepEqual(menu.map(r => r.id), ['router-rule', 'env-requires', 'conventions-note']);
  assert.deepEqual(menu.map(r => r.rank), [1, 2, 3]);
  assert.match(menu[0].check, /local-agy-\*/);
  for (const r of menu.filter(r => r.id !== 'conventions-note')) assert.ok(r.caught.length >= MIN_CITED, `${r.id} cites ≥2 events`);
});

test('LLM-judged quality failures → verifier failPattern before workflow gate', () => {
  const evs = [
    L({ reason: 'verifier LLM: placeholder output, no code changes', brainFamily: 'a' }),
    L({ reason: 'verifier LLM: placeholder output, no code changes', brainFamily: 'b' }),
    L({ reason: 'verifier LLM: placeholder output, no code changes', brainFamily: 'c' }),
  ];
  const menu = remedyMenu(groupLessons(evs)[0]);
  assert.deepEqual(menu.map(r => r.id), ['verifier-pattern', 'workflow-gate', 'conventions-note']);
  assert.match(menu[0].check, /placeholder\\W\+output/);
  assert.equal(menu[0].caught.length, 3);
});

test('permission-type wait-inputs → acceptance criterion', () => {
  const evs = [
    L({ kind: 'wait-input', questions: ['Should I re-enable the workflow now?'] }),
    L({ kind: 'wait-input', questions: ['Should I re-enable the workflow now?'] }),
  ];
  const p = draftProposal(groupLessons(evs)[0]);
  assert.equal(p.recommended, 'acceptance-criterion');
  assert.equal(p.evidence.length, 2);
});

test('no structural check catches ≥2 events → prose note only, flagged unenforced, still citing ≥2 events', () => {
  const evs = [L({ reason: 'timeout after 300000ms', brainFamily: 'x' }), L({ reason: 'timeout after 900000ms', brainFamily: 'y' })];
  const p = draftProposal(groupLessons(evs)[0]);
  assert.equal(p.recommended, 'conventions-note');
  assert.equal(p.unenforced, true);
  assert.equal(p.evidence.length, 2);
  assert.deepEqual(remedySelectOptions(p).slice(-1), ['dismiss']);
});

test('correctLoop windows the ledger and counts unenforced classes', () => {
  const evs = [
    L({ min: 0, reason: 'timeout after 1ms', brainFamily: 'x' }), L({ min: 1, reason: 'timeout after 2ms', brainFamily: 'y' }),
    L({ min: 60 * 24 * 60, reason: 'timeout after 3ms' }),   // 60 days later, outside the window
  ];
  const r = correctLoop(evs, T0, T0 + 30 * 86_400_000);
  assert.equal(r.lessons, 2);
  assert.equal(r.classes, 1);
  assert.equal(r.unenforced, 1);
  assert.equal(r.proposals[0].count, 2);
});
