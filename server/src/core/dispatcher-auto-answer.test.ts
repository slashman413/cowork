import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.js';
import type { Config, Task } from '../types.js';

/**
 * ADR-009: autonomous human-input handling. When orchestration.autoAnswer.enabled
 * is on, the orchestrator answers a task's `wait-input` questions on the CEO's
 * behalf and releases the task — so a paused task resumes without a person. Truly
 * human-only decisions are escalated honestly and left parked (never fabricated),
 * and a per-task attempt ceiling leaves an undecidable task for a real human.
 *
 * askExecutor is stubbed so no CLI is spawned; the async answer turn is flushed
 * with a setImmediate tick before asserting.
 */

const flush = () => new Promise<void>(r => setImmediate(r));

function harness(opts: { answer: string; autoAnswer?: any }) {
  const tasks = new Map<string, Task>();
  const store = {
    listTasks: (f?: { status?: string }) =>
      Array.from(tasks.values()).filter(t => !f?.status || t.status === f.status),
    getTask: (id: string) => tasks.get(id) || null,
    saveTask: (t: Task) => { tasks.set(t.id, t); },
    submitInteraction: (p: { taskId: string; responses: Record<string, any>; submittedBy?: string }) => {
      const t = tasks.get(p.taskId);
      if (!t || !t.interaction) return null;
      for (const field of t.interaction.fields) {
        if (Object.prototype.hasOwnProperty.call(p.responses, field.id)) field.value = p.responses[field.id];
      }
      t.interaction.status = 'submitted';
      t.interaction.submittedBy = p.submittedBy;
      t.status = 'pending';
      tasks.set(t.id, t);
      return t;
    },
    getAgentPersona: () => null
  };
  const config = {
    inbox: { maxRetries: 3 },
    orchestration: {
      agents: { orchestrator: { description: '', brains: ['local-cc-opus'] } },
      brains: { 'local-cc-opus': { location: 'local', exec: 'claude' } },
      classifier: { timeoutMs: 1000 },
      autoAnswer: { enabled: true, maxAttempts: 3, ...(opts.autoAnswer || {}) }
    }
  } as unknown as Config;
  const dispatcher = new Dispatcher(config, store as any, {} as any);
  (dispatcher as any).askExecutor = async () => opts.answer;
  const drive = () => (dispatcher as any).driveWaitInput();
  const put = (t: Partial<Task> & { id: string }) => { tasks.set(t.id, t as Task); return tasks.get(t.id)!; };
  return { drive, put, tasks };
}

function parked(id: string, extra: Partial<Task> = {}): Partial<Task> & { id: string } {
  return {
    id, title: 'ship the thing', description: 'do it', status: 'wait-input',
    context: {},
    interaction: {
      prompt: 'need input', status: 'pending',
      fields: [{ id: 'q1', label: 'Which cloud provider?', type: 'textarea', required: true }]
    },
    ...extra
  } as Partial<Task> & { id: string };
}

test('auto-answer fills the questions on the CEO behalf and releases the task', async () => {
  const { drive, put, tasks } = harness({ answer: '```json\n{ "answers": { "q1": "Use AWS." } }\n```' });
  put(parked('t1'));
  drive();
  await flush();
  const t = tasks.get('t1')!;
  assert.equal(t.status, 'pending', 'released back into the pending pool');
  assert.equal(t.interaction!.status, 'submitted');
  assert.equal(t.interaction!.submittedBy, 'orchestrator (auto-answer)');
  assert.equal(t.interaction!.fields[0].value, 'Use AWS.');
  assert.equal((t.context!.autoAnswer as any).count, 1);
});

test('a human-only decision is escalated, not fabricated — task stays parked', async () => {
  const { drive, put, tasks } = harness({
    answer: '```json\n{ "escalate": true, "reason": "needs a browser OAuth re-auth" }\n```'
  });
  put(parked('t2'));
  drive();
  await flush();
  const t = tasks.get('t2')!;
  assert.equal(t.status, 'wait-input', 'escalated task must NOT be released');
  assert.equal(t.interaction!.status, 'pending');
  assert.equal((t.context!.autoAnswer as any).escalated, true);
  assert.match((t.context!.autoAnswer as any).escalateReason, /oauth/i);
});

test('a task at the attempt ceiling is left for a real human', async () => {
  const { drive, put, tasks } = harness({ answer: '```json\n{ "answers": { "q1": "x" } }\n```' });
  put(parked('t3', { context: { autoAnswer: { count: 3 } } }));
  drive();
  await flush();
  const t = tasks.get('t3')!;
  assert.equal(t.status, 'wait-input', 'ceiling reached — not auto-answered');
  assert.equal(t.interaction!.status, 'pending');
});

test('a human-only tagged task is never auto-answered', async () => {
  const { drive, put, tasks } = harness({ answer: '```json\n{ "answers": { "q1": "x" } }\n```' });
  put(parked('t4', { tags: ['human-only'] }));
  drive();
  await flush();
  assert.equal(tasks.get('t4')!.status, 'wait-input');
});

test('auto-answer is a no-op when disabled', async () => {
  const { drive, put, tasks } = harness({
    answer: '```json\n{ "answers": { "q1": "x" } }\n```',
    autoAnswer: { enabled: false }
  });
  put(parked('t5'));
  drive();
  await flush();
  assert.equal(tasks.get('t5')!.status, 'wait-input');
});

test('an unparseable orchestrator reply does not bump the counter or release', async () => {
  const { drive, put, tasks } = harness({ answer: 'sorry, timed out' });
  put(parked('t6'));
  drive();
  await flush();
  const t = tasks.get('t6')!;
  assert.equal(t.status, 'wait-input');
  assert.equal(t.context!.autoAnswer, undefined, 'no counter written on an infra blip');
});
