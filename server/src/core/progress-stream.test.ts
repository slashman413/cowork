import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatUsage, createStreamRenderer, streamArgs , lastAssistantText } from './progress-stream.js';

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

test('claude: compaction events render compaction notice', () => {
  const r = createStreamRenderer('claude');
  let log = '';
  log += r.feed(j({ type: 'system', subtype: 'compaction' }));
  log += r.feed(j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Resuming after compaction.' }] } }));
  assert.match(log, /⚙ Context compaction in progress…/);
  assert.match(log, /💬 Resuming after compaction\./);
});

test('agy: compaction lifecycle events render progress notices', () => {
  const r = createStreamRenderer('agy');
  let log = '';
  log += r.feed(j({ event: 'compaction_start' }));
  log += r.feed(j({ event: 'compaction_end' }));
  assert.match(log, /⚙ Context compaction in progress…/);
  assert.match(log, /✔ Context compaction complete/);
});

test('usage: claude result event is captured, including cache and cost', () => {
  const r = createStreamRenderer('claude');
  r.feed(JSON.stringify({ type: 'result', result: 'ok', num_turns: 3, total_cost_usd: 0.5,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 } }) + '\n');
  assert.deepEqual(r.usage(), { input: 10, cacheRead: 100, cacheWrite: 20, output: 5, turns: 3, costUsd: 0.5 });
});

test('usage: agy result event is captured; a run with none reports null', () => {
  const r = createStreamRenderer('agy');
  r.feed(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK', num_turns: 1,
    usage: { input_tokens: 22863, output_tokens: 107, thinking_tokens: 106, cache_read_tokens: 0 } } }) + '\n');
  assert.deepEqual(r.usage(), { input: 22863, cacheRead: 0, cacheWrite: 0, output: 213, turns: 1 });
  assert.equal(createStreamRenderer('claude').usage(), null);
});

test('usage: the hermes report shape maps to the same fields', () => {
  assert.deepEqual(flatUsage({ input_tokens: 28160, output_tokens: 39, cache_read_tokens: 1, cache_write_tokens: 2, reasoning_tokens: 3, estimated_cost_usd: 0 }),
    { input: 28160, cacheRead: 1, cacheWrite: 2, output: 42 });
});

test('lastAssistantText reads the final reply from a hermes session export', () => {
  const line = JSON.stringify({ id: 's', messages: [
    { role: 'user', content: 'q' }, { role: 'assistant', content: 'draft' }, { role: 'tool', content: 'r' },
    { role: 'assistant', content: 'final' }, { role: 'assistant', content: '  ' }, { role: 'assistant', content: null }] });
  assert.equal(lastAssistantText(`${line}\nnot json\n`), 'final');
  assert.equal(lastAssistantText(''), '');
});
