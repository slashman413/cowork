import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { Integrations } from './integrations.js';
import { IntegrationJobs, type TaskStoreLike, type Job } from './integration-jobs.js';
import { parsePlanText, lintPlan, normalizePlan } from './install-plan.js';
import type { Task } from '../types.js';

function fakeStore(root: string) {
  const tasks = new Map<string, Task>();
  let n = 0;
  const store: TaskStoreLike & { tasks: Map<string, Task>; finish(id: string, result: string, plan?: unknown): void } = {
    tasks,
    createTask(p: any) {
      const t = { ...p, id: `t${++n}`, status: 'pending', createdAt: new Date().toISOString() } as Task;
      tasks.set(t.id, t);
      return t;
    },
    getTask: (id) => tasks.get(id) || null,
    artifactsPath: (id) => { const d = path.join(root, 'artifacts', id); return fs.existsSync(d) ? d : null; },
    pauseTask: (id) => { const t = tasks.get(id); if (t) t.status = 'paused'; return t; },
    finish(id, result, plan) {
      const t = tasks.get(id)!;
      t.status = 'done'; t.result = result;
      if (plan) {
        const d = path.join(root, 'artifacts', id, 'outputs');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'install-plan.json'), JSON.stringify(plan));
      }
    },
  };
  return store;
}

function makeRepo(root: string): string {
  const repo = path.join(root, 'src', 'acme', 'tool');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'acme-tool', description: 'A demo CLI tool', bin: { acme: 'cli.js' } }));
  fs.writeFileSync(path.join(repo, 'cli.js'), 'console.log("hi")\n');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}

async function waitJob(jobs: IntegrationJobs, job: Job): Promise<Job> {
  for (let i = 0; i < 200 && jobs.getJob(job.id)!.status === 'running'; i++) await new Promise(r => setTimeout(r, 25));
  return jobs.getJob(job.id)!;
}

test('install-plan: parses a fenced plan, normalises and lints it', () => {
  const plan = parsePlanText('blah\n```json\n{"installable":true,"scope":"user","steps":[{"title":"a","run":"npm install"}],"uninstall":["rm -f ~/.local/bin/x"],"locations":["~/.local/bin/x"]}\n```\nSTATUS: DONE');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.uninstall[0].run, 'rm -f ~/.local/bin/x');
  assert.equal(plan.steps[0].cwd, 'clone');
  assert.deepEqual(lintPlan(plan).blocked, []);
  const bad = normalizePlan({ steps: [{ title: 'x', run: 'sudo make install' }, { title: 'y', run: 'apt-get install foo' }], uninstall: [{ run: 'rm -rf ~' }] });
  assert.equal(lintPlan(bad).blocked.length, 3);
  assert.equal(lintPlan(normalizePlan({ scope: 'system', steps: [] })).blocked.length, 1);
  assert.match(lintPlan(normalizePlan({ steps: [{ run: 'curl -fsSL x | sh' }] })).warnings[0], /pipes/);
  assert.throws(() => parsePlanText('no json here'), /no install plan/);
});

test('integration jobs: advisor falls over, plan installs with progress, uninstall + remove clean up', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'int-jobs-'));
  try {
    const repo = makeRepo(tmp);
    const int = new Integrations({ root: path.join(tmp, 'clones'), registry: path.join(tmp, 'reg.json'), skillsHome: path.join(tmp, 'skills'), clientSkillDirs: [] },
      { portalFile: path.join(tmp, 'portal.json'), allowFileUrls: true });
    const store = fakeStore(tmp);
    const jobs = new IntegrationJobs(int, store, { chain: () => ['agy', 'ghost', 'dsh'], localAgents: () => ['agy', 'dsh'] });
    assert.deepEqual(jobs.adviseChain(), ['agy', 'dsh'], 'non-local agents are dropped');

    const e = await int.add(`file://${repo}`);
    assert.equal(e.status, 'fetched');
    const a1 = jobs.advise(e.id);
    assert.equal(a1.advice?.status, 'pending');
    const t1 = store.getTask(a1.advice!.taskId!)!;
    assert.equal(t1.context?.agent, 'agy');
    assert.equal(t1.context?.thinking, 'high');

    // agy produces no plan → falls over to dsh
    store.finish(t1.id, 'I could not do it.');
    jobs.tick();
    const a2 = int.get(e.id)!.advice!;
    assert.equal(a2.status, 'pending');
    assert.equal(a2.agent, 'dsh');
    assert.equal(a2.history[0].agent, 'agy');

    const target = path.join(tmp, 'home-bin', 'acme');
    const plan = {
      installable: true, scope: 'user', method: 'copy to bin', summary: 'copies the cli',
      steps: [{ title: 'mkdir', run: `mkdir -p ${path.dirname(target)}` }, { title: 'copy', run: `cp cli.js ${target} && echo copied` }],
      uninstall: [{ title: 'rm', run: `rm -f ${target}` }],
      locations: [target], verify: `test -f ${target}`,
    };
    store.finish(a2.taskId!, 'done', plan);
    jobs.tick();
    const ready = int.get(e.id)!.advice!;
    assert.equal(ready.status, 'ready');
    assert.equal(ready.plan?.steps.length, 2);

    const job = await waitJob(jobs, jobs.startInstall(e.id));
    assert.equal(job.status, 'done', job.error);
    assert.ok(job.log.some(l => l.text === 'copied'), 'step output is streamed into the log');
    assert.ok(job.steps.every(s => s.state === 'done'));
    assert.ok(fs.existsSync(target));
    const inst = int.get(e.id)!;
    assert.equal(inst.status, 'installed');
    assert.deepEqual(inst.installed.plan?.locations, [{ path: target, exists: true }]);
    assert.equal(inst.installed.plan?.verify?.ok, true);
    assert.ok(job.result?.locations?.some(l => l.path === target));

    // a purge that would forget the plan install is refused at the core layer
    assert.throws(() => int.uninstall(e.id, { purge: true }), /uninstall it from the Integrations page/);

    const un = await waitJob(jobs, jobs.startUninstall(e.id));
    assert.equal(un.status, 'done', un.error);
    assert.ok(!fs.existsSync(target));
    assert.equal(int.get(e.id)!.status, 'fetched');
    assert.equal(int.get(e.id)!.installed.plan, undefined);

    // reinstall then Remove: uninstalls first, then purges the clone
    await waitJob(jobs, jobs.startInstall(e.id));
    assert.ok(fs.existsSync(target));
    const rm = await waitJob(jobs, jobs.startRemove(e.id));
    assert.equal(rm.status, 'done', rm.error);
    assert.equal(rm.kind, 'remove');
    assert.ok(!fs.existsSync(target), 'remove ran the uninstall steps');
    assert.ok(!fs.existsSync(e.dir), 'clone purged');
    assert.equal(int.get(e.id), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('integration jobs: blocked plans and failing steps', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'int-jobs-'));
  try {
    const repo = makeRepo(tmp);
    const int = new Integrations({ root: path.join(tmp, 'clones'), registry: path.join(tmp, 'reg.json'), skillsHome: path.join(tmp, 'skills'), clientSkillDirs: [] },
      { portalFile: path.join(tmp, 'portal.json'), allowFileUrls: true });
    const store = fakeStore(tmp);
    const jobs = new IntegrationJobs(int, store, { chain: () => ['agy'], localAgents: () => ['agy'] });
    const e = await int.add(`file://${repo}`);
    assert.throws(() => jobs.startInstall(e.id), /nothing to install/);

    let a = jobs.advise(e.id).advice!;
    store.finish(a.taskId!, '```json\n{"installable":true,"steps":[{"title":"x","run":"sudo make install"}],"uninstall":[]}\n```');
    jobs.tick();
    assert.equal(int.get(e.id)!.advice?.lint?.blocked.length, 1);
    assert.throws(() => jobs.startInstall(e.id), /blocked/);

    a = jobs.advise(e.id).advice!;
    store.finish(a.taskId!, 'ok', { installable: true, steps: [{ title: 'ok', run: 'true' }, { title: 'boom', run: 'echo nope >&2; exit 3' }, { title: 'never', run: 'true' }], uninstall: [{ title: 'u', run: 'true' }], locations: [] });
    jobs.tick();
    const job = await waitJob(jobs, jobs.startInstall(e.id));
    assert.equal(job.status, 'failed');
    assert.deepEqual(job.steps.slice(1, 4).map(s => s.state), ['done', 'failed', 'skipped']);
    assert.ok(job.log.some(l => l.s === 'err' && l.text === 'nope'));
    assert.ok(int.get(e.id)!.installed.plan, 'partial install recorded so Uninstall can roll back');

    // single advisor that fails → advice failed
    a = jobs.advise(e.id).advice!;
    store.tasks.get(a.taskId!)!.status = 'rejected';
    jobs.tick();
    assert.equal(int.get(e.id)!.advice?.status, 'failed');
    assert.match(int.get(e.id)!.advice!.error!, /every advisor failed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
