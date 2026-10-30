import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  EVAL_RUBRIC, SANDBOX_FORBID, isReplayable, selectReplayTasks, buildReplayPrompt, sandboxEnv, writeGuardDir, readBlockedLog,
  blindPairs, buildJudgePrompt, parseJudgeScores, unblind, summarize, diffSnapshots, normalizeStatus, renderReport,
  firstRunnableBrain, brainArgv, sandboxClean, type JudgedTask, type SandboxCheck,
} from './eval-harness.js';
import { Workflows } from './workflows.js';
import type { Config, Task, BrainConfig } from '../types.js';

function task(id: string, over: Partial<Task> = {}, ctx: Record<string, any> = {}): Task {
  return {
    id, title: `Task ${id}`, description: 'Do a sufficiently long piece of engineering work for the eval.',
    from: { platform: 'cowork', agent: 'x' }, to: {}, priority: 'normal', status: 'done',
    createdAt: '2026-10-01T00:00:00Z', completedAt: `2026-10-${String(10 + Number(id.replace(/\D/g, '') || 0)).padStart(2, '0')}T00:00:00Z`,
    context: { division: 'engineering', ...ctx }, tags: [], ...over,
  } as Task;
}

test('isReplayable keeps family done tasks and drops eval/continue/input/short/other-family ones', () => {
  assert.equal(isReplayable(task('1'), 'engineering'), true);
  assert.equal(isReplayable(task('1', {}, { division: undefined, ranAgent: 'engineering-sre' }), 'engineering-sre'), true);
  assert.equal(isReplayable(task('1', { status: 'pending' as Task['status'] }), 'engineering'), false);
  assert.equal(isReplayable(task('1', {}, { division: 'marketing' }), 'engineering'), false);
  assert.equal(isReplayable(task('1', { title: 'Continue: something' }), 'engineering'), false);
  assert.equal(isReplayable(task('1', {}, { inputFiles: ['a.png'] }), 'engineering'), false);
  assert.equal(isReplayable(task('1', {}, { workflowId: 'eval-prompt-change' }), 'engineering'), false);
  assert.equal(isReplayable(task('1', { description: 'too short' }), 'engineering'), false);
});

test('selectReplayTasks is seeded-reproducible, dedupes recurring titles, returns n newest-first', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task(`t${i + 1}`));
  tasks.push(task('t13', { title: 'Task t12' }));   // duplicate title of t12, older → dropped
  const a = selectReplayTasks(tasks, 'engineering', 5, 'seed-1');
  const b = selectReplayTasks(tasks, 'engineering', 5, 'seed-1');
  assert.deepEqual(a.map(t => t.id), b.map(t => t.id));
  assert.equal(a.length, 5);
  assert.equal(new Set(a.map(t => t.title)).size, 5);
  const when = a.map(t => t.completedAt!);
  assert.deepEqual(when, [...when].sort().reverse());
  const c = selectReplayTasks(tasks, 'engineering', 5, 'seed-2');
  assert.notDeepEqual(a.map(t => t.id), c.map(t => t.id));
});

test('replay prompt: banner on top and bottom, variant rules, sandbox scope replaces the original, no variant label', () => {
  const p = buildReplayPrompt({
    rules: '# RULES-VARIANT-TEXT', persona: 'You are a backend architect.', agent: 'engineering-backend-architect',
    task: { title: 'Ship X', description: 'Build X and push it.', context: { acceptance: ['X works'], scope: { write: ['/orig-write-scope'] }, ranBrain: 'b', planItem: 'P9' } },
    sandboxDir: '/sb/1', timeboxMin: 12, depResults: [{ title: 'Prev step', result: 'prev result' }],
  });
  assert.ok(p.startsWith('# ⚠ SANDBOX REPLAY — do not perform outward actions'));
  assert.match(p, /REMINDER — SANDBOX REPLAY/);
  assert.ok(p.indexOf('# RULES-VARIANT-TEXT') < p.indexOf('You are a backend architect.'));
  assert.match(p, /# Task: Ship X/);
  assert.match(p, /- \[ \] X works/);
  assert.match(p, /Spend at most 12 min/);
  for (const f of SANDBOX_FORBID) assert.ok(p.includes(f), `forbid "${f}" rendered`);
  assert.ok(!p.includes('/orig-write-scope'), 'original write scope is replaced');
  assert.ok(!/"ranBrain"/.test(p), 'internal context stripped');
  assert.match(p, /"planItem": "P9"/);
  assert.match(p, /## Prev step\n\nprev result/);
  assert.ok(!/variant [AB]\b/i.test(p));
});

test('sandboxEnv strips credentials and hub access, and wires the guard', () => {
  const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/h', COWORK_API_KEY: 'k', COWORK_API: 'https://x', GH_TOKEN: 't', SSH_AUTH_SOCK: '/s', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', MY_SECRET: 's', DB_PASSWORD: 'p' }, '/g');
  for (const k of ['COWORK_API_KEY', 'COWORK_API', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'MY_SECRET', 'DB_PASSWORD']) assert.equal(env[k], undefined, k);
  assert.equal(env.HOME, '/h');
  assert.equal(env.PATH, '/g/bin:/usr/bin');
  assert.equal(env.GIT_CONFIG_VALUE_0, '/g/hooks');
  assert.equal(env.GIT_SSH_COMMAND, '/g/bin/ssh');
  assert.equal(env.COWORK_SANDBOX_REPLAY, '1');
});

test('guard dir really blocks: git commit and push refused + logged, gh refused, curl POST refused, curl GET passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-guard-'));
  const guard = path.join(dir, 'guard');
  const fakeCurl = path.join(dir, 'realcurl');
  fs.writeFileSync(fakeCurl, '#!/usr/bin/env bash\necho REAL-CURL "$@"\n', { mode: 0o755 });
  writeGuardDir(guard, fakeCurl, '/bin/true');
  const env = sandboxEnv({ PATH: process.env.PATH, HOME: process.env.HOME }, guard);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env: { ...env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' }, encoding: 'utf-8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  git('add', 'f');
  const commit = git('commit', '-qm', 'm');
  assert.notEqual(commit.status, 0, 'commit refused');
  assert.equal(spawnSync('git', ['log'], { cwd: repo, encoding: 'utf-8' }).status !== 0, true, 'no commit exists');
  assert.notEqual(spawnSync('gh', ['pr', 'create'], { env, encoding: 'utf-8' }).status, 0);
  const post = spawnSync('curl', ['-X', 'POST', 'https://example.com'], { env, encoding: 'utf-8' });
  assert.notEqual(post.status, 0);
  const data = spawnSync('curl', ['-s', '-d', 'a=1', 'https://example.com'], { env, encoding: 'utf-8' });
  assert.notEqual(data.status, 0);
  const get = spawnSync('curl', ['-s', 'https://example.com'], { env, encoding: 'utf-8' });
  assert.equal(get.status, 0);
  assert.match(get.stdout, /REAL-CURL -s https:\/\/example.com/);
  // read-only systemctl passes through to the real binary; mutating subcommands are refused
  assert.notEqual(spawnSync('systemctl', ['--user', 'restart', 'cowork-mcp'], { env, encoding: 'utf-8' }).status, 0);
  const ro = spawnSync('bash', ['-c', `grep -c 'is-active' ${JSON.stringify(path.join(guard, 'bin', 'systemctl'))}`], { encoding: 'utf-8' });
  assert.equal(ro.stdout.trim(), '1');
  const blocked = readBlockedLog(guard);
  assert.ok(blocked.some(l => l.includes('systemctl --user restart cowork-mcp')));
  assert.ok(blocked.some(l => l.includes('git pre-commit')));
  assert.ok(blocked.some(l => l.includes('gh pr create')));
  assert.equal(blocked.filter(l => l.includes('curl')).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('blindPairs shuffles labels per task reproducibly; unblind maps scores back to A/B', () => {
  const pairs = Array.from({ length: 8 }, (_, i) => ({ taskId: `id${i}`, title: `t${i}`, description: 'd', a: `A-out-${i}`, b: `B-out-${i}` }));
  const { items, key } = blindPairs(pairs, 'run-1');
  assert.deepEqual(blindPairs(pairs, 'run-1').key, key);
  const xs = Object.values(key).map(k => k.X);
  assert.ok(xs.includes('A') && xs.includes('B'), 'both orientations appear across 8 tasks');
  items.forEach((it, i) => assert.equal(it.X, key[it.alias].X === 'A' ? pairs[i].a : pairs[i].b));
  const hi = Object.fromEntries(EVAL_RUBRIC.map(r => [r.key, 5])) as any;
  const lo = Object.fromEntries(EVAL_RUBRIC.map(r => [r.key, 1])) as any;
  // Judge prefers whichever side holds the A output.
  const judged: JudgedTask[] = items.map(it => ({ task: it.alias, X: key[it.alias].X === 'A' ? hi : lo, Y: key[it.alias].X === 'A' ? lo : hi, note: '' }));
  const rows = unblind(judged, key, items);
  assert.ok(rows.every(r => r.totalA === 25 && r.totalB === 5 && r.xIs === key[r.alias].X));
  const s = summarize(rows);
  assert.equal(s.delta, 20);
  assert.equal(s.winsA, 8);
  assert.equal(s.perCriterion.evidence.delta, 4);
});

test('judge prompt hides variants and asks for strict JSON; parser validates every alias and criterion', () => {
  const { items } = blindPairs([{ taskId: 'x', title: 'T', description: 'D', a: 'aaa', b: 'bbb' }], 's');
  const p = buildJudgePrompt(items);
  assert.match(p, /T1 result X/);
  assert.ok(!/variant [AB]\b|CONVENTIONS/i.test(p));
  const good = `Here you go:\n\`\`\`json\n{"scores":[{"task":"T1","X":{"completion":4,"evidence":3,"honesty":5,"scope":4,"clarity":4},"Y":{"completion":"2","evidence":2,"honesty":3,"scope":4,"clarity":3},"note":"X shows evidence"}]}\n\`\`\``;
  const parsed = parseJudgeScores(good, ['T1']);
  assert.equal(parsed[0].Y.completion, 2);
  assert.throws(() => parseJudgeScores(good, ['T1', 'T2']), /no scores for T2/);
  assert.throws(() => parseJudgeScores(good.replace('"clarity":4}', '"clarity":9}'), ['T1']), /0-5/);
  assert.throws(() => parseJudgeScores('no json here', ['T1']), /no parseable JSON/);
});

test('long outputs are clipped head+tail for the judge', () => {
  const { items } = blindPairs([{ taskId: 'x', title: 'T', description: 'D', a: 'H'.repeat(5000) + 'TAIL-MARK', b: 'b' }], 's');
  const p = buildJudgePrompt(items, 1000);
  assert.match(p, /chars elided by the eval harness/);
  assert.match(p, /TAIL-MARK/);
});

test('diffSnapshots flags head/ref/status changes; runtime dirs are ignored in status', () => {
  assert.equal(normalizeStatus('?? artifacts/x/y\n M server/a.ts\n?? inbox/1.json'), ' M server/a.ts');
  const before = { '/r1': { head: 'aaaaaaa1', status: 's', refs: 'r' }, '/r2': { head: 'b', status: 's', refs: 'r' } };
  const after = { '/r1': { head: 'ccccccc1', status: 's', refs: 'r2' }, '/r2': { head: 'b', status: 's', refs: 'r' } };
  const d = diffSnapshots(before, after);
  assert.equal(d.length, 1);
  assert.equal(d[0].repo, '/r1');
  assert.match(d[0].changed.join(), /HEAD aaaaaaa→ccccccc/);
  assert.match(d[0].changed.join(), /refs/);
  assert.deepEqual(diffSnapshots(before, before), []);
});

test('firstRunnableBrain skips disabled/remote/script brains; brainArgv mirrors the dispatcher', () => {
  const brains: Record<string, BrainConfig> = {
    off: { description: '', location: 'local', exec: 'claude', disabled: true } as BrainConfig,
    rem: { description: '', location: 'remote', exec: 'claude' } as BrainConfig,
    scr: { description: '', location: 'local', exec: 'script', command: ['x'] } as BrainConfig,
    cc: { description: '', location: 'local', exec: 'claude', model: 'claude-opus-5-5' } as BrainConfig,
  };
  assert.equal(firstRunnableBrain(['off', 'rem', 'scr', 'cc'], brains), 'cc');
  assert.equal(firstRunnableBrain(['off'], brains), null);
  assert.deepEqual(brainArgv(brains.cc, 'P', 1000), ['claude', '-p', 'P', '--model', 'claude-opus-5-5', '--dangerously-skip-permissions']);
  assert.deepEqual(brainArgv({ exec: 'agy', model: 'gemini-4-argon-medium' }, 'P', 60000).slice(0, 4), ['agy', '-p', 'P', '--print-timeout']);
  assert.throws(() => brainArgv({ exec: 'script' }, 'P', 1), /cannot run/);
});

test('report carries delta, per-task rows, the n caveat, sandbox verdict and the commit citation', () => {
  const s5 = Object.fromEntries(EVAL_RUBRIC.map(r => [r.key, 4])) as any;
  const s3 = Object.fromEntries(EVAL_RUBRIC.map(r => [r.key, 3])) as any;
  const rows = [{ alias: 'T1', taskId: 'abcdef123', title: 'Some task', A: s5, B: s3, totalA: 20, totalB: 15, note: 'A cites evidence' }];
  const check: SandboxCheck = { label: 'A', startedAt: 's', finishedAt: 'f', repoChanges: [], tasksCreated: [], blockedAttempts: ['x gh pr create'] };
  assert.equal(sandboxClean(check), true);
  const md = renderReport({
    runId: 'run-9', family: 'engineering', createdAt: 'now',
    variantA: { path: 'CONVENTIONS.md', sha256: 'a'.repeat(64) }, variantB: { path: 'old.md', sha256: 'b'.repeat(64) },
    executor: 'local-cc-opus-5-5', judge: 'local-agy-gemini-4-argon-medium', executorFamily: 'claude', judgeFamily: 'gemini',
    rows, summary: summarize(rows), replayStatus: [{ taskId: 'abcdef123', A: 'ok', B: 'timeout' }],
    checks: [check, { ...check, label: 'B', blockedAttempts: [], repoChanges: [{ repo: '/r', changed: ['working tree changed'] }] }],
  });
  assert.match(md, /Δ\(A − B\) = \+5/);
  assert.match(md, /n = 1: this is a smoke signal/);
  assert.match(md, /\| T1 \| `abcdef12` Some task \| 20 \| 15 \| \+5 \|/);
  assert.match(md, /Variant A\*\* .*✅ clean/);
  assert.match(md, /Variant B\*\* .*CHANGES OBSERVED/);
  assert.match(md, /BLOCKED by the guard: 1/);
  assert.match(md, /eval-prompt-change run-9 Δ\(A−B\)=\+5 n=1/);
});

test('workflows/eval-prompt-change.json validates and pins every step to the eval script brain', () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
  const cfg = { paths: { workflows: path.join(repo, 'workflows') } } as unknown as Config;
  const wf = new Workflows(cfg, {} as any);
  const def = JSON.parse(fs.readFileSync(path.join(repo, 'workflows', 'eval-prompt-change.json'), 'utf-8'));
  assert.deepEqual(wf.validate(def), []);
  assert.deepEqual(def.params, ['family', 'variantA', 'variantB']);
  assert.deepEqual(def.steps.map((s: any) => s.key), ['select', 'replay-a', 'replay-b', 'judge']);
  for (const s of def.steps) {
    assert.equal(s.brain, 'local-script-eval-harness', s.key);
    const m = String(s.description).match(/^EVAL_ARGS:\s*(\{.*\})\s*$/m);
    assert.ok(m, `${s.key} has an EVAL_ARGS line`);
    JSON.parse(m![1].replace(/\{\{\w+\}\}/g, 'x'));
  }
  for (const k of ['replay-a', 'replay-b']) {
    const s = def.steps.find((x: any) => x.key === k);
    assert.ok(s.scope.forbid.length >= 5, `${k} carries a hard scope.forbid`);
    assert.match(s.description, /SANDBOX REPLAY — do not perform outward actions/);
  }
});

test('eval judge prompt + rubric v2 carry the three judging rules', async () => {
  const { JUDGE_COMPLIANCE_RULES, JUDGE_RULES_HEADING } = await import('./result-verifier.js');
  const { RUBRIC_VERSION } = await import('./eval-harness.js');
  const { items } = blindPairs([{ taskId: 'x', title: 'T', description: 'D', a: 'aaa', b: 'bbb' }], 's');
  const p = buildJudgePrompt(items);
  assert.equal(RUBRIC_VERSION, 'v2');
  assert.match(p, /# Rubric \(v2\)/);
  assert.ok(p.includes(JUDGE_RULES_HEADING));
  for (const r of JUDGE_COMPLIANCE_RULES) assert.ok(p.includes(r), r.slice(0, 40));
  const completion = EVAL_RUBRIC.find(r => r.key === 'completion')!.desc;
  assert.match(completion, /alternative path the brief allows counts in full/);
  assert.match(completion, /never deduct for missing non-public data/);
  assert.match(completion, /documented operational constraint/);
});
