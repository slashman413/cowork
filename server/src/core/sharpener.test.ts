import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHARPEN_CORE_PARAGRAPH,
  buildSharpenerPrompt,
  parseSharpenOutput,
  shouldSharpenTask,
  isGateOrReviewOrVerifierOrEvalTask,
  selectSharpenerBrain,
  sharpenTask,
  sharpenInBackground,
} from './sharpener.js';
import type { Config, Task } from '../types.js';

function mkTask(p: Partial<Task> = {}): Task {
  return {
    id: 'test-task-1',
    title: 'Write a blog post about edge AI',
    description: 'Create an engaging 1000-word post about edge computing and AI.',
    from: { platform: 'web', agent: 'ceo' },
    to: {},
    priority: 'normal',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...p,
  };
}

function mkConfig(p: Partial<Config['orchestration']> = {}): Config {
  return {
    server: { port: 6868, host: '127.0.0.1' },
    paths: {
      inbox: './inbox',
      artifacts: './artifacts',
      inputs: './inputs',
      status: './.status',
      decisions: './decisions',
    },
    orchestration: {
      enabled: true,
      sharpener: {
        enabled: true,
        mode: 'shadow',
        brain: 'local-agy-gemini-3.8-flash-high',
      },
      tiers: {
        mechanical: ['local-dsh-qwen3-8-27b', 'local-agy-gemini-3.8-flash-high'],
      },
      brains: {
        'local-agy-gemini-3.8-flash-high': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-high' },
        'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh' },
        'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' },
      },
      ...p,
    },
  } as unknown as Config;
}

test('buildSharpenerPrompt contains verbatim pstack core paragraph and guards', () => {
  const task = mkTask({ title: 'Deploy redis', description: 'Deploy a redis replica' });
  const prompt = buildSharpenerPrompt(task);

  assert.ok(prompt.includes(SHARPEN_CORE_PARAGRAPH), 'must contain verbatim sharpen paragraph');
  assert.ok(prompt.includes('Better, not bigger'), 'must contain Better, not bigger guard');
  assert.ok(prompt.includes('openChoices'), 'must contain openChoices guard');
  assert.ok(prompt.includes('outside check'), 'must contain outside check guard');
  assert.ok(prompt.includes('Deploy redis'), 'must include task title');
  assert.ok(prompt.includes('Deploy a redis replica'), 'must include task description');
});

test('parseSharpenOutput accepts valid JSON and enforces 2-5 criteria, 1-3 verify, 1 outsideCheck', () => {
  const valid = JSON.stringify({
    acceptance: ['Artifact blog.md exists and is >= 1000 words', 'No broken links'],
    verify: ['wc -w blog.md', 'markdown-link-check blog.md'],
    outsideCheck: 'curl -s https://example.com/blog | grep -q "Edge AI"',
    deliverable: 'blog.md',
    playbook: 'content',
    openChoices: ['Tone: technical vs executive'],
  });

  const parsed = parseSharpenOutput(valid);
  assert.ok(parsed);
  assert.deepEqual(parsed.acceptance, ['Artifact blog.md exists and is >= 1000 words', 'No broken links']);
  assert.deepEqual(parsed.verify, ['wc -w blog.md', 'markdown-link-check blog.md']);
  assert.equal(parsed.outsideCheck, 'curl -s https://example.com/blog | grep -q "Edge AI"');
  assert.equal(parsed.deliverable, 'blog.md');
  assert.equal(parsed.playbook, 'content');
  assert.deepEqual(parsed.openChoices, ['Tone: technical vs executive']);
});

test('parseSharpenOutput strips markdown fences', () => {
  const fenced = "```json\n" + JSON.stringify({
    acceptance: ['Criterion 1', 'Criterion 2'],
    verify: ['test-cmd'],
    outsideCheck: 'outside-check-cmd',
  }) + "\n```";

  const parsed = parseSharpenOutput(fenced);
  assert.ok(parsed);
  assert.equal(parsed.acceptance.length, 2);
  assert.equal(parsed.outsideCheck, 'outside-check-cmd');
});

test('parseSharpenOutput rejects bad shapes and invalid bounds', () => {
  // Fewer than 2 acceptance criteria
  assert.equal(parseSharpenOutput(JSON.stringify({
    acceptance: ['only one'],
    verify: ['check'],
    outsideCheck: 'outside',
  })), null);

  // More than 5 acceptance criteria
  assert.equal(parseSharpenOutput(JSON.stringify({
    acceptance: ['1', '2', '3', '4', '5', '6'],
    verify: ['check'],
    outsideCheck: 'outside',
  })), null);

  // No verify checks
  assert.equal(parseSharpenOutput(JSON.stringify({
    acceptance: ['1', '2'],
    verify: [],
    outsideCheck: 'outside',
  })), null);

  // More than 3 verify checks
  assert.equal(parseSharpenOutput(JSON.stringify({
    acceptance: ['1', '2'],
    verify: ['1', '2', '3', '4'],
    outsideCheck: 'outside',
  })), null);

  // Missing outsideCheck
  assert.equal(parseSharpenOutput(JSON.stringify({
    acceptance: ['1', '2'],
    verify: ['1'],
  })), null);

  // Malformed JSON
  assert.equal(parseSharpenOutput('not json at all'), null);
});

test('skip rules: identifies tasks that should NOT be sharpened', () => {
  const cfg = mkConfig();

  // Already has acceptance criteria
  assert.equal(shouldSharpenTask(mkTask({ context: { acceptance: ['already has it'] } }), cfg), false);

  // Mechanical tier
  assert.equal(shouldSharpenTask(mkTask({ context: { tier: 'mechanical' } }), cfg), false);

  // Opt-out via context.sharpen === false
  assert.equal(shouldSharpenTask(mkTask({ context: { sharpen: false } }), cfg), false);

  // Gate review task
  assert.equal(shouldSharpenTask(mkTask({ context: { gateReviewFor: 'parent-123' } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ context: { gateStepKey: 'build' } }), cfg), false);

  // Review task
  assert.equal(shouldSharpenTask(mkTask({ context: { tier: 'review' } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ context: { reviewOf: 'local-cc-opus-5-5' } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ from: { platform: 'cowork', agent: 'engineering-code-reviewer' } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ title: 'Review PR 42 for security bugs' }), cfg), false);

  // Verifier task
  assert.equal(shouldSharpenTask(mkTask({ context: { verifier: true } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ from: { platform: 'cowork', agent: 'spec-verifier' } }), cfg), false);

  // Eval task
  assert.equal(shouldSharpenTask(mkTask({ context: { brain: 'local-script-eval-harness' } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ context: { workflowId: 'eval-prompt-change' } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ from: { platform: 'cowork', agent: 'eval-harness' } }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ tags: ['eval'] }), cfg), false);
  assert.equal(shouldSharpenTask(mkTask({ title: 'Eval engineering: pick 5 done tasks' }), cfg), false);

  // Config master switch disabled
  const disabledCfg = mkConfig({ sharpener: { enabled: false } });
  assert.equal(shouldSharpenTask(mkTask(), disabledCfg), false);

  // Standard task without acceptance -> SHOULD be sharpened
  assert.equal(shouldSharpenTask(mkTask(), cfg), true);
  assert.equal(shouldSharpenTask(mkTask({ context: { tier: 'judgment' } }), cfg), true);
  assert.equal(shouldSharpenTask(mkTask({ context: { tier: 'standard' } }), cfg), true);
});

test('selectSharpenerBrain selects configured brain or mechanical tier', () => {
  const cfg = mkConfig();
  const selected = selectSharpenerBrain(cfg);
  assert.ok(selected);
  assert.equal(selected.brainId, 'local-agy-gemini-3.8-flash-high');

  // When sharpener.brain is absent, uses first enabled mechanical brain
  const cfgNoBrain = mkConfig({ sharpener: { enabled: true, mode: 'shadow' } });
  const selectedMech = selectSharpenerBrain(cfgNoBrain);
  assert.ok(selectedMech);
  assert.equal(selectedMech.brainId, 'local-dsh-qwen3-8-27b');
});

test('sharpenTask: successful sharpening sets context fields and acceptanceSource="sharpened"', async () => {
  const cfg = mkConfig();
  const task = mkTask();

  const runner = async () => ({
    ok: true,
    text: JSON.stringify({
      acceptance: ['File blog.md created', 'Word count >= 1000'],
      verify: ['test -f blog.md', 'wc -w blog.md'],
      outsideCheck: 'curl -s https://example.com/blog | grep -q "Edge AI"',
      deliverable: 'blog.md',
      playbook: 'content',
      openChoices: ['Audience tone'],
    }),
  });

  const res = await sharpenTask(task, { config: cfg, runner });
  assert.equal(res.sharpened, true);
  assert.ok(res.result);
  assert.equal(task.context?.acceptanceSource, 'sharpened');
  assert.deepEqual(task.context?.acceptance, ['File blog.md created', 'Word count >= 1000']);
  assert.deepEqual(task.context?.verify, ['test -f blog.md', 'wc -w blog.md']);
  assert.equal(task.context?.outsideCheck, 'curl -s https://example.com/blog | grep -q "Edge AI"');
  assert.equal(task.context?.deliverable, 'blog.md');
  assert.equal(task.context?.playbook, 'content');
  assert.deepEqual(task.context?.openChoices, ['Audience tone']);
});

test('sharpenTask: fail-open on bad JSON, logs sharpen-failed to lessons.jsonl', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-sharpener-test-'));
  const cfg = mkConfig();
  const task = mkTask({ id: 'task-bad-json' });

  const runner = async () => ({
    ok: true,
    text: 'I cannot output JSON today, sorry!',
  });

  const res = await sharpenTask(task, { config: cfg, decisionsDir: tmpDir, runner });
  assert.equal(res.sharpened, false);
  assert.ok(res.error);
  // Task context must remain unsharpened
  assert.equal(task.context?.acceptance, undefined);
  assert.equal(task.context?.acceptanceSource, undefined);

  // Must log kind: sharpen-failed to lessons.jsonl
  const lessonsFile = path.join(tmpDir, 'lessons.jsonl');
  assert.ok(fs.existsSync(lessonsFile));
  const raw = fs.readFileSync(lessonsFile, 'utf-8');
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.kind, 'sharpen-failed');
  assert.equal(entry.task, 'task-bad-json');
});

test('sharpenTask: fail-open on brain execution error, logs sharpen-failed to lessons.jsonl', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-sharpener-test-'));
  const cfg = mkConfig();
  const task = mkTask({ id: 'task-runner-err' });

  const runner = async () => ({
    ok: false,
    text: 'SPAWN ERROR: command not found: agy',
  });

  const res = await sharpenTask(task, { config: cfg, decisionsDir: tmpDir, runner });
  assert.equal(res.sharpened, false);
  assert.ok(res.error);
  assert.equal(task.context?.acceptance, undefined);

  const lessonsFile = path.join(tmpDir, 'lessons.jsonl');
  assert.ok(fs.existsSync(lessonsFile));
  const raw = fs.readFileSync(lessonsFile, 'utf-8');
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.kind, 'sharpen-failed');
  assert.equal(entry.task, 'task-runner-err');
});

test('sharpenInBackground: never overwrites a claim made while the brain runs (double-dispatch regression)', async () => {
  const cfg = mkConfig();
  const disk = new Map<string, Task>([['t1', mkTask({ id: 't1' })]]);
  const store = {
    getTask: (id: string) => (disk.has(id) ? structuredClone(disk.get(id)!) : null),
    saveTask: (t: Task) => { disk.set(t.id, structuredClone(t)); },
  };
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const runner = async () => {
    await gate;
    return { ok: true, text: JSON.stringify({ acceptance: ['a ok', 'b ok'], verify: ['true'], outsideCheck: 'curl -s x' }) };
  };
  const done = sharpenInBackground(store, 't1', { config: cfg, runner });

  // Stamped synchronously, so the dispatcher skips its own pass.
  assert.ok(disk.get('t1')!.context?.sharpenStartedAt);
  assert.equal(shouldSharpenTask(disk.get('t1')!, cfg), false);

  // The dispatcher claims the task while the sharpener is still running.
  const claimed = store.getTask('t1')!;
  claimed.status = 'in-progress';
  claimed.claimedBy = 'dispatcher';
  claimed.context = { ...claimed.context, dispatched: true };
  store.saveTask(claimed);

  release();
  await done;
  const after = disk.get('t1')!;
  assert.equal(after.status, 'in-progress');
  assert.equal(after.claimedBy, 'dispatcher');
  assert.equal(after.context?.dispatched, true);
  assert.equal(after.context?.acceptanceSource, 'sharpened');
  assert.deepEqual(after.context?.acceptance, ['a ok', 'b ok']);
});
