import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.js';
import type { Config, Task } from '../types.js';

test('buildPrompt caps large inputFiles to avoid E2BIG', () => {
  const store = {
    inputsPath: (id: string) => `/mock/inputs/${id}`,
    getPersona: () => null,
    getTask: () => null,
  };
  const config = {
    paths: { artifacts: '/mock/artifacts' },
    server: { port: 6868 },
    orchestration: { taskTimeoutMs: 3000000 },
  } as unknown as Config;

  const dispatcher = new Dispatcher(config, store as any, {} as any);
  const inputFiles = Array.from({ length: 500 }, (_, i) => `file_${i}.png`);
  const task: Task = {
    id: 'test-large-input-files',
    title: 'Test large inputs',
    description: 'Testing capping',
    status: 'pending',
    context: {
      inputFiles,
    },
  } as unknown as Task;

  const plan = {
    persona: 'generalist',
    isRoster: false,
    exec: 'agy',
    agentId: 'local-agy-gemini-3.8-flash',
  };

  const prompt: string = (dispatcher as any).buildPrompt(task, plan);
  assert.ok(prompt.includes('500 files total in /mock/inputs/test-large-input-files'));
  assert.ok(prompt.includes('... and 450 more files in directory: /mock/inputs/test-large-input-files'));
  assert.ok(prompt.length < 100000, `Expected prompt length < 100000, got ${prompt.length}`);
});

test('buildPrompt caps massive prompt text <= 100,000 chars to avoid E2BIG', () => {
  const store = {
    inputsPath: () => '/mock/inputs',
    getPersona: () => null,
    getTask: () => null,
  };
  const config = {
    paths: { artifacts: '/mock/artifacts' },
    server: { port: 6868 },
    orchestration: { taskTimeoutMs: 3000000 },
  } as unknown as Config;

  const dispatcher = new Dispatcher(config, store as any, {} as any);
  const task: Task = {
    id: 'test-massive-prompt',
    title: 'Test massive',
    description: 'x'.repeat(200000),
    status: 'pending',
    context: {},
  } as unknown as Task;

  const plan = {
    persona: 'generalist',
    isRoster: false,
    exec: 'agy',
    agentId: 'local-agy-gemini-3.8-flash',
  };

  const prompt: string = (dispatcher as any).buildPrompt(task, plan);
  assert.ok(prompt.length <= 100000, `Expected prompt length <= 100000, got ${prompt.length}`);
  assert.ok(prompt.includes('[... Remaining prompt truncated to stay within system command-line argument limits ...]'));
});
