import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyModels, diagnoseAgyModelFailure, AGY_MODEL_REJECTED_RE, isAgyModelRejection } from './agy-models.js';
import { isRateLimitFailure } from './result-verifier.js';
import { canonicalBrainId, migrateBrainAliases } from '../config.js';

const REJECTED = 'invalid model selection (--model "gemini-3.8-flash-high" --effort ""): model gemini-3.8-flash-high is not recognized as a known model or custom model in settings';

test('parseAgyModels: reads slugs from `agy models`, skipping the banner', () => {
  const out = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\n';
  assert.deepEqual(parseAgyModels(out), ['gemini-3.8-flash-high', 'claude-opus-5-5-medium']);
  assert.deepEqual(parseAgyModels(''), []);
});

test('diagnoseAgyModelFailure: catalog outage on a valid model is a rate-limit-class failure', () => {
  assert.ok(AGY_MODEL_REJECTED_RE.test(REJECTED));
  for (const models of [null, ['gemini-3.8-flash-high']]) {
    const d = diagnoseAgyModelFailure('gemini-3.8-flash-high', REJECTED, models)!;
    assert.match(d, /transient/);
    assert.equal(isRateLimitFailure(d), true, 'must route to auto re-run on reset');
  }
});

test('diagnoseAgyModelFailure: a slug missing from a loaded catalog is reported retired', () => {
  const d = diagnoseAgyModelFailure('gemini-3.1-pro-high', REJECTED, ['gemini-3.8-flash-high'])!;
  assert.match(d, /retired/);
  assert.equal(isRateLimitFailure(d), false, 'retired model must not be auto re-run');
  assert.equal(diagnoseAgyModelFailure('x', 'some other error', null), null);
});

test('retired agy brain ids alias to live ones and the renamed brain forwards the live model', () => {
  assert.equal(canonicalBrainId(undefined, 'local-agy-gemini-3.1-pro-high'), 'local-agy-gemini-3.8-flash-high');
  assert.equal(canonicalBrainId(undefined, 'local-agy-claude-opus-4-6-thinking'), 'local-agy-claude-opus-5-5-high');
  const config: any = { orchestration: { brains: {
    'local-agy-gemini-3.6-flash-low': { description: 'x', location: 'local', exec: 'agy', model: 'gemini-3.6-flash-low' }
  }, agents: { a: { brains: ['local-agy-gemini-3.6-flash-low'] } } } };
  migrateBrainAliases(config);
  assert.equal(config.orchestration.brains['local-agy-gemini-3.8-flash-low'].model, 'gemini-3.8-flash-low');
  assert.equal(config.orchestration.brains['local-agy-gemini-3.6-flash-low'], undefined);
  assert.deepEqual(config.orchestration.agents.a.brains, ['local-agy-gemini-3.8-flash-low']);
});

test('isAgyModelRejection: agy\'s own short error matches, a report quoting it does not', () => {
  assert.equal(isAgyModelRejection(REJECTED), true);
  assert.equal(isAgyModelRejection(`Fetching available models...\nError: ${REJECTED}\n`), true);
  const report = [
    '# Daily GitHub review 2026-10-15',
    '',
    '## Findings',
    '- cowork 64ef47e: agy now diagnoses failures like:',
    `  > ${REJECTED}`,
    '- saas-starter: postcss override landed (#24)',
    '- twse-backtests: daily-update.yml still duplicated on ckw19810413',
    '',
    '## Action items',
    '1. Restrict the matcher so a review that quotes the agy error is not treated as a rate-limit.',
  ].join('\n');
  assert.equal(isAgyModelRejection(report), false);
  assert.equal(diagnoseAgyModelFailure('gemini-3.8-flash-high', report, null), null,
    'a deliverable quoting the error must keep its genuine verify-fail reason');
  // Short but the quote is buried after other content → still not agy's own error.
  assert.equal(isAgyModelRejection(`Summary: done.\nNotes:\n- a\n- b\nQuoted: ${REJECTED}`), false);
  assert.equal(isAgyModelRejection(''), false);
});
