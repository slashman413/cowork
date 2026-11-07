import test from 'node:test';
import assert from 'node:assert/strict';
import { agyModelSlug, normalizeThinking, splitThinkingSuffix, thinkingArgs } from './thinking.js';

test('normalizeThinking accepts the five levels and drops everything else', () => {
  assert.equal(normalizeThinking(' HIGH '), 'high');
  assert.equal(normalizeThinking('xhigh'), 'xhigh');
  assert.equal(normalizeThinking('ultra'), undefined);
  assert.equal(normalizeThinking(''), undefined);
  assert.equal(normalizeThinking(3), undefined);
});

test('splitThinkingSuffix strips the id suffix, and leaves other ids alone', () => {
  assert.deepEqual(splitThinkingSuffix('local-agy-gemini-3.8-flash-high'), { base: 'local-agy-gemini-3.8-flash', level: 'high' });
  assert.deepEqual(splitThinkingSuffix('local-cc-opus-5-5'), { base: 'local-cc-opus-5-5' });
  assert.deepEqual(splitThinkingSuffix('local-x-xhigh'), { base: 'local-x-xhigh' });
});

test('agyModelSlug builds the catalog slug: default medium, clamp to high, single-level models', () => {
  assert.equal(agyModelSlug('gemini-3.8-flash'), 'gemini-3.8-flash-medium');
  assert.equal(agyModelSlug('gemini-3.8-flash', 'low'), 'gemini-3.8-flash-low');
  assert.equal(agyModelSlug('gemini-3.8-flash', 'max'), 'gemini-3.8-flash-high');
  assert.equal(agyModelSlug('gemini-3.8-flash-high'), 'gemini-3.8-flash-high', 'a raw slug keeps its level');
  assert.equal(agyModelSlug('gemini-3.8-flash-high', 'low'), 'gemini-3.8-flash-low', 'an explicit level wins');
  assert.equal(agyModelSlug('gpt-oss-120b', 'high'), 'gpt-oss-120b-medium');
  assert.equal(agyModelSlug(''), '');
});

test('thinkingArgs maps a level to each CLI, defaulting to medium where it can', () => {
  assert.deepEqual(thinkingArgs('claude'), ['--effort', 'medium']);
  assert.deepEqual(thinkingArgs('claude', 'max'), ['--effort', 'max']);
  assert.deepEqual(thinkingArgs('codex', 'max'), ['-c', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(thinkingArgs('hermes'), []);
  assert.deepEqual(thinkingArgs('hermes', 'xhigh'), ['--reasoning', 'high']);
  assert.deepEqual(thinkingArgs('dsh', 'high'), []);
});
