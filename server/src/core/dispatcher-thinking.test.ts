import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.js';

/** buildArgv only reads config, so a bare instance is enough. */
function argvFor(cfg: Record<string, any>, orchestration: Record<string, any> = {}): string[] {
  const d = Object.create(Dispatcher.prototype) as any;
  d.config = { orchestration: { taskTimeoutMs: 1000, claudeProfile: 'full', ...orchestration } };
  return d.buildArgv(cfg, 'prompt', null, true);
}
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

test('a run with no level uses medium on every CLI that has a control', () => {
  assert.equal(flag(argvFor({ exec: 'claude', model: 'claude-opus-5-5' }), '--effort'), 'medium');
  assert.equal(flag(argvFor({ exec: 'agy', model: 'gemini-3.8-flash' }), '--model'), 'gemini-3.8-flash-medium');
  assert.equal(flag(argvFor({ exec: 'codex', model: 'gpt-6-luna' }), '-c'), 'model_reasoning_effort="medium"');
});

test('an explicit level reaches each CLI', () => {
  assert.equal(flag(argvFor({ exec: 'claude', model: 'm', thinking: 'max' }), '--effort'), 'max');
  assert.equal(flag(argvFor({ exec: 'agy', model: 'gemini-3.8-flash', thinking: 'high' }), '--model'), 'gemini-3.8-flash-high');
  assert.equal(flag(argvFor({ exec: 'codex', model: 'm', thinking: 'low' }), '-c'), 'model_reasoning_effort="low"');
  assert.equal(flag(argvFor({ exec: 'hermes', model: 'm', thinking: 'high' }), '--reasoning'), 'high');
});

test('hermes gets no flag by default, and a raw agy slug keeps its own level', () => {
  assert.ok(!argvFor({ exec: 'hermes', model: 'm' }).includes('--reasoning'));
  assert.equal(flag(argvFor({ exec: 'agy', model: 'gemini-3.8-flash-low' }), '--model'), 'gemini-3.8-flash-low');
});

test('orchestration.defaultThinking replaces medium as the default', () => {
  assert.equal(flag(argvFor({ exec: 'claude', model: 'm' }, { defaultThinking: 'high' }), '--effort'), 'high');
  assert.equal(flag(argvFor({ exec: 'agy', model: 'gemini-3.8-flash' }, { defaultThinking: 'low' }), '--model'), 'gemini-3.8-flash-low');
});
