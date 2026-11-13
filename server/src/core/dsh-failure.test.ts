import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { dshErrorFromStderr, dshErrorFromSessionJsonl, dshSessionKey, dshFailureReason, formatDshError } from './dsh-failure.js';
import { classifyCliFailure } from './dispatcher.js';

const CTX_MSG = '400: {"object":"error","message":"Requested token count exceeds the model\'s maximum context length of 131072 tokens. You requested a total of 132177 tokens: 99409 tokens from the input messages and 32768 tokens for the completion. Please reduce the number of tokens.","code":400}';
const turnEnd = (reason: unknown) => JSON.stringify({ type: 'turn/end', seq: 1, data: { turn: 1, reason } });
const ctxErr = { kind: 'error', error: { message: CTX_MSG, code: 'CONTEXT_WINDOW_EXCEEDED' } };

test('dshSessionKey matches dsh\'s sessions/<cwd-key> layout', () => {
  assert.equal(dshSessionKey('/tmp'), '--tmp--');
  assert.equal(dshSessionKey('/home/wayne/x/artifacts/8a5c'), '--home-wayne-x-artifacts-8a5c--');
});

test('stderr: takes the LAST plugin turn/end error line', () => {
  const s = '[08:24:36] ⚙ Step 1 started\n[09:00:01] ✗ dsh turn/end error code=PROVIDER_ERROR: boom\n…\n[09:40:00] ✗ dsh turn/end error code=CONTEXT_WINDOW_EXCEEDED: 400: too long\n';
  assert.deepEqual(dshErrorFromStderr(s), { code: 'CONTEXT_WINDOW_EXCEEDED', message: '400: too long' });
  assert.equal(dshErrorFromStderr('[08:24:36] ⚙ Step 1 started'), null);
});

test('session jsonl: last turn/end decides; a clean final turn means no error', () => {
  assert.equal(dshErrorFromSessionJsonl([turnEnd(ctxErr), turnEnd({ kind: 'done' })].join('\n')), null);
  const e = dshErrorFromSessionJsonl([turnEnd({ kind: 'done' }), '{"type":"tool/call"}', turnEnd(ctxErr), ''].join('\n'));
  assert.equal(e?.code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(formatDshError(e!), 'dsh CONTEXT_WINDOW_EXCEEDED: 99409 input + 32768 output > 131072 tokens');
});

test('dshFailureReason falls back to the newest zstd session for the cwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'dshhome-'));
  try {
    const cwd = '/work/artifacts/t1';
    const dir = join(home, 'sessions', dshSessionKey(cwd), 'session-abc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(turnEnd(ctxErr) + '\n')));
    assert.equal(dshFailureReason({ cwd, startedMs: 0 }, home), 'dsh CONTEXT_WINDOW_EXCEEDED: 99409 input + 32768 output > 131072 tokens');
    // a session older than this attempt is ignored
    assert.equal(dshFailureReason({ cwd, startedMs: Date.now() + 60_000 }, home), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('classifyCliFailure: dsh run failure shows the turn/end code, not firstLine(stdout)', async () => {
  const det = { ok: false, reason: '[08:24:36] ⚙ Step 1 started' };
  const stderr = '[09:40:00] ✗ dsh turn/end error code=CONTEXT_WINDOW_EXCEEDED: ' + CTX_MSG + '\n';
  const r = await classifyCliFailure({ exec: 'dsh', text: '[08:24:36] ⚙ Step 1 started', stderr }, det, det.reason, async () => null, '/nonexistent');
  assert.equal(r.failReason, 'dsh CONTEXT_WINDOW_EXCEEDED: 99409 input + 32768 output > 131072 tokens');
  // no turn error anywhere → keep the old reason
  const none = await classifyCliFailure({ exec: 'dsh', text: 'x', stderr: '', cwd: '/nowhere' }, det, det.reason, async () => null, '/nonexistent');
  assert.equal(none.failReason, det.reason);
  // a clean dsh run the quality gate rejected keeps the verifier's reason
  const gated = await classifyCliFailure({ exec: 'dsh', text: 'x', stderr }, { ok: true }, 'LLM said no', async () => null, '/nonexistent');
  assert.equal(gated.failReason, 'LLM said no');
  // other execs are untouched
  const claude = await classifyCliFailure({ exec: 'claude', text: 'x', stderr }, det, det.reason, async () => null, '/nonexistent');
  assert.equal(claude.failReason, det.reason);
});
