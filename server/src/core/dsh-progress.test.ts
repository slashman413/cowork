import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ensureDshPatch } from './dispatcher.js';

test('ensureDshPatch creates and verifies the dsh progress patch overlay', () => {
  const patchPath = ensureDshPatch();
  assert.ok(patchPath, 'ensureDshPatch should return the patch path');
  assert.ok(existsSync(patchPath), 'Patch file must exist');

  const content = readFileSync(patchPath, 'utf8');
  assert.match(content, /id:\s*dsh-cowork-progress/);
  assert.match(content, /dsh-progress-plugin\.mjs/);
});

test('dsh-progress-plugin module exports required Cordis plugin structure', async () => {
  const pluginUrl = new URL('../../../deploy/dsh/dsh-progress-plugin.mjs', import.meta.url);
  const plugin = await import(pluginUrl.href);

  assert.equal(plugin.name, 'dsh-cowork-progress');
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.inject.includes('llm'));
  assert.equal(typeof plugin.apply, 'function');
});

test('dsh-progress-plugin handles session/event lifecycle for compaction and tool execution', async () => {
  const pluginUrl = new URL('../../../deploy/dsh/dsh-progress-plugin.mjs', import.meta.url);
  const plugin = await import(pluginUrl.href);

  const listeners: Record<string, ((session: any, event: any) => void)[]> = {};
  const mockCtx = {
    on(event: string, fn: any) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    llm: {
      stream: async function* (options: any) {
        yield { text: 'ok' };
      }
    }
  };

  const capturedStderr: string[] = [];
  const origStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    capturedStderr.push(String(chunk));
    return true;
  }) as any;

  try {
    plugin.apply(mockCtx);

    const emit = (ev: any) => {
      for (const fn of listeners['session/event'] || []) {
        fn({}, ev);
      }
    };

    // Compaction events
    emit({ type: 'compaction/start', data: { turn: 95 } });
    emit({ type: 'compaction/summary' });
    emit({ type: 'compaction/end' });

    // Step & tool events
    emit({ type: 'step/start', data: { step: 96 } });
    emit({ type: 'tool/call', data: { name: 'bash', arguments: { command: 'git status' } } });
    emit({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: 'On branch main' }] } } });

    // Assistant message and CONTEXT_WINDOW_EXCEEDED
    emit({ type: 'assistant/chunk', data: { chunk: { reason: { failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } } } } });
    emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Task continuing after compaction.' }] } } });

    const allOutput = capturedStderr.join('');
    assert.match(allOutput, /⚙ Context compaction initiated \(turn 95\)/);
    assert.match(allOutput, /⚙ Compaction summary generated/);
    assert.match(allOutput, /✔ Context compaction complete · context freed, resuming task/);
    assert.match(allOutput, /⚙ Step 96 started/);
    assert.match(allOutput, /🔧 bash: git status/);
    assert.match(allOutput, /↳ On branch main/);
    assert.match(allOutput, /⚠️ CONTEXT_WINDOW_EXCEEDED/);
    assert.match(allOutput, /💬 Task continuing after compaction\./);
  } finally {
    process.stderr.write = origStderrWrite;
  }
});

test('dsh-progress-plugin intercepts compaction LLM streams to report prefill and token generation', async () => {
  const pluginUrl = new URL('../../../deploy/dsh/dsh-progress-plugin.mjs', import.meta.url);
  const plugin = await import(pluginUrl.href);

  const mockCtx = {
    on: () => {},
    llm: {
      async *stream(options: any) {
        yield { text: 'Summary chunk 1. ' };
        yield { text: 'Summary chunk 2.' };
      }
    }
  };

  const capturedStderr: string[] = [];
  const origStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    capturedStderr.push(String(chunk));
    return true;
  }) as any;

  try {
    plugin.apply(mockCtx);

    const receivedChunks: any[] = [];
    for await (const chunk of mockCtx.llm.stream({
      purpose: 'compaction',
      messages: [{ role: 'user', content: 'test compaction input '.repeat(100) }]
    })) {
      receivedChunks.push(chunk);
    }

    assert.equal(receivedChunks.length, 2);
    const allOutput = capturedStderr.join('');
    assert.match(allOutput, /⏳ \[Compaction\] Context threshold crossed/);
    assert.match(allOutput, /Prefill finished/);
    assert.match(allOutput, /Summary generation finished/);
  } finally {
    process.stderr.write = origStderrWrite;
  }
});
