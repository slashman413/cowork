import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamRenderer, streamArgs } from './progress-stream.js';

const j = (o: unknown) => `${JSON.stringify(o)}\n`;

test('streamArgs: only claude/agy switch to stream-json', () => {
  assert.deepEqual(streamArgs('claude'), ['--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(streamArgs('agy'), ['--output-format', 'stream-json']);
  assert.deepEqual(streamArgs('codex'), []);
});

test('claude: tool calls, tool output and messages become progress lines; result is the answer', () => {
  const r = createStreamRenderer('claude');
  const stream =
    j({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }) +
    j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }) +
    j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } }) +
    j({ type: 'user', message: { content: [{ type: 'tool_result', content: '12 passed\n0 failed', is_error: false }] } }) +
    j({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 }) +
    j({ type: 'assistant', message: { content: [{ type: 'text', text: 'All green.' }] } }) +
    j({ type: 'result', subtype: 'success', is_error: false, result: 'FINAL ANSWER', duration_ms: 4200, num_turns: 3, total_cost_usd: 0.1234 });
  // Feed in awkward chunk boundaries — the renderer must line-buffer.
  let log = '';
  for (let i = 0; i < stream.length; i += 37) log += r.feed(stream.slice(i, i + 37));
  log += r.flush();
  assert.match(log, /⚙ session started · model claude-opus-5-5/);
  assert.match(log, /🔧 Bash: npm test {2}# Run tests/);
  assert.match(log, /↳ 12 passed\n {5}0 failed/);
  assert.match(log, /💬 All green\./);
  assert.match(log, /✔ agent finished · 4s · 3 turns · \$0\.123/);
  assert.doesNotMatch(log, /thinking_tokens/);
  assert.equal(r.finalText(), 'FINAL ANSWER');
});

test('claude: no result event (killed) falls back to assistant text + plain output', () => {
  const r = createStreamRenderer('claude');
  r.feed('Error: something exploded before streaming\n');
  r.feed(j({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial work' }] } }));
  assert.equal(r.finalText(), 'partial work\nError: something exploded before streaming');
});

test('claude: rate-limited result text is preserved for the verifier', () => {
  const r = createStreamRenderer('claude');
  r.feed(j({ type: 'result', is_error: true, result: "You've hit your limit · resets 5pm" }));
  assert.equal(r.finalText(), "You've hit your limit · resets 5pm");
});

test('agy: tool steps and streamed text deltas render; result.response is the answer', () => {
  const r = createStreamRenderer('agy');
  let log = '';
  log += r.feed(j({ event: 'init', init: { cwd: '/tmp' } }));
  log += r.feed(j({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls /tmp' } } } }));
  log += r.feed(j({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: 'a\r\nb' } } }));
  log += r.feed(j({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Done! ' } }));
  log += r.feed(j({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Listed.' } }));
  log += r.feed(j({ event: 'result', result: { status: 'SUCCESS', response: 'Done! Listed.', duration_seconds: 11.3 } }));
  assert.match(log, /🔧 run_command: ls \/tmp/);
  assert.match(log, /↳ a\n {5}b/);
  assert.match(log, /💬 Done! Listed\.\n/);
  assert.match(log, /✔ agent finished · 11s/);
  assert.equal(r.finalText(), 'Done! Listed.');
});
