// Shared test harness for the pstack gate tests (not a test file itself).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Dispatcher } from './dispatcher.js';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Config, Task } from '../types.js';

export const BRAINS: Record<string, any> = {
  'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' },
  'local-agy-gemini-4-argon-medium': { location: 'local', exec: 'agy', model: 'gemini-4-argon-medium' },
  'local-agy-gemini-3.8-flash-high': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-high' },
  'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh', model: 'qwen3.8-27b' },
};

export function pstackHarness(orchExtra: Record<string, any> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-pstack-'));
  const paths: Record<string, string> = {
    inbox: path.join(root, 'inbox'), artifacts: path.join(root, 'artifacts'), inputs: path.join(root, 'inputs'),
    status: path.join(root, 'status'), decisions: path.join(root, 'decisions'), agencyAgents: path.join(root, 'agency-agents'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
  const config = {
    server: { port: 6868, host: '127.0.0.1' }, paths, platforms: {}, inbox: { maxRetries: 3 },
    orchestration: {
      maxConcurrent: 2,
      verifier: { enabled: true, llm: { enabled: true }, spec: { enabled: false, judges: { default: ['local-agy-gemini-4-argon-medium'] } }, panel: { enabled: true, size: 2 } },
      tiers: { judgment: ['local-cc-opus-5-5'], standard: ['local-agy-gemini-4-argon-medium'], mechanical: ['local-dsh-qwen3-8-27b', 'local-agy-gemini-3.8-flash-high'] },
      agents: { engineer: { description: '', brains: ['local-cc-opus-5-5'] } },
      brains: BRAINS,
      ...orchExtra,
    },
  } as unknown as Config;
  const store = new Store(config, new EventBus());
  const dispatcher = new Dispatcher(config, store, new EventBus());
  const mk = (ctx: Record<string, any> = {}, title = 'Do the thing'): Task => {
    const t = store.createTask({ title, description: 'brief text', from: { platform: 'test', agent: 'tester' } } as any);
    t.context = { ...(t.context || {}), ...ctx };
    store.saveTask(t);
    return t;
  };
  return { root, paths, config, store, dispatcher, mk };
}
