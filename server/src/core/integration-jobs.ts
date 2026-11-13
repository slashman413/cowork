import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { hasInstall, type Integrations, type Integration, type AdviceState, type PlanInstallRecord } from './integrations.js';
import { buildAdvisePrompt, expandHome, lintPlan, readPlanFromTask, runStep, type InstallPlan, type PlanStep } from './install-plan.js';
import { isFailedTask } from './store.js';
import type { Task } from '../types.js';

/**
 * The install advisor + install/uninstall jobs behind /integrations.html.
 *
 *  advise(id)   → a cowork task pinned to the first advisor agent (thinking high)
 *                 that writes outputs/install-plan.json. tick() watches it and
 *                 falls over to the next agent of the chain when the task fails,
 *                 a run of it fails (rate limit …), it stalls, or its plan is
 *                 unreadable.
 *  startInstall / startUninstall(remove?) → an in-memory job with a step list and a
 *                 streamed log the page polls (GET /api/integrations/jobs/:id).
 */

export const DEFAULT_ADVISE_CHAIN = ['local-agy-gemini-3.8-flash', 'local-dsh-qwen3-8-27b'];
export const DEFAULT_ADVISE_THINKING = 'high';
const PENDING_STALL_MS = 10 * 60_000;
const RUNNING_STALL_MS = 30 * 60_000;

/** The slice of Store this module needs (keeps tests free of a real store). */
export interface TaskStoreLike {
  createTask(params: any): Task;
  getTask(id: string): Task | null;
  artifactsPath(id: string): string | null;
  pauseTask(id: string, opts?: { by?: string; reason?: string }): unknown;
}

export type JobKind = 'install' | 'uninstall' | 'remove';
export interface JobStep { title: string; run?: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; ms?: number; note?: string }
export interface JobLine { i: number; t: string; s: 'info' | 'cmd' | 'out' | 'err' | 'ok' | 'warn'; text: string }
export interface Job {
  id: string; integrationId: string; source: string; kind: JobKind;
  status: 'running' | 'done' | 'failed';
  startedAt: string; endedAt?: string;
  steps: JobStep[];
  log: JobLine[];
  error?: string;
  /** install: where things landed; uninstall: what was removed. */
  result?: { locations?: Array<{ label: string; path: string; exists?: boolean }>; removed?: string[]; usage?: string };
}
const MAX_LOG = 6000;
const MAX_JOBS = 40;

export class IntegrationJobs {
  private jobs = new Map<string, Job>();
  private active = new Map<string, string>();   // integrationId → running jobId

  constructor(
    private readonly int: Integrations,
    private readonly store: TaskStoreLike,
    private readonly opts: { chain: () => string[]; thinking?: () => string | undefined; localAgents: () => string[] },
  ) {}

  // ── advisor ──────────────────────────────────────────────────────────────
  adviseChain(): string[] {
    const local = new Set(this.opts.localAgents());
    return this.opts.chain().filter(a => local.has(a));
  }

  /** Ask the advisor chain for an install plan (restarts from the first agent). */
  advise(id: string, opts: { notes?: string } = {}): Integration {
    const e = this.int.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    if (e.advice?.status === 'pending' && e.advice.taskId) this.dropTask(e.advice.taskId, 're-requested');
    const chain = this.adviseChain();
    const now = new Date().toISOString();
    if (!chain.length) {
      return this.int.patch(id, x => { x.advice = { status: 'failed', chain: [], attempt: 0, requestedAt: now, updatedAt: now, history: [], error: `no advisor agent available — configure integrations.adviseChain (default ${DEFAULT_ADVISE_CHAIN.join(' → ')}) with local agents` }; });
    }
    const advice: AdviceState = { status: 'pending', chain, attempt: 0, requestedAt: now, updatedAt: now, history: [], thinking: this.opts.thinking?.() || DEFAULT_ADVISE_THINKING };
    this.dispatch(e, advice, opts.notes);
    return this.int.patch(id, x => { x.advice = advice; });
  }

  private dispatch(e: Integration, advice: AdviceState, notes?: string): void {
    const agent = advice.chain[advice.attempt];
    const top = e.audit.findings.filter(f => f.severity !== 'medium').slice(0, 12)
      .map(f => `- [${f.severity}] ${f.rule} — ${f.file}:${f.line}`);
    let description = buildAdvisePrompt({
      id: e.id, source: e.source, dir: e.dir, scanRoot: this.int.scanRoot(e), commit: e.commit,
      kinds: e.detected.kinds, language: e.detected.language, license: e.detected.license, description: e.detected.description,
      mcp: e.detected.mcp, cli: e.detected.cli, skills: e.detected.skills.map(s => s.name), personas: e.detected.personas?.count, web: !!e.detected.web,
      audit: { verdict: e.audit.verdict, counts: e.audit.counts, top },
      skillsHome: this.int.skillsHome, clientSkillDirs: this.int.clientSkillDirs.filter(d => fs.existsSync(d)),
    });
    if (notes) description += `\n\n## Operator notes\n${notes.slice(0, 2000)}`;
    const task = this.store.createTask({
      title: `🧭 Install advice: ${e.source}`,
      description,
      tags: ['integration', 'install-advice'],
      context: { agent, thinking: advice.thinking, integrationId: e.id, integrationAdvice: true, timeboxMin: 15 },
      from: { platform: 'dashboard', agent: 'integrations' }, to: {}, priority: 'normal',
    });
    advice.agent = agent;
    advice.taskId = task.id;
    advice.status = 'pending';
    advice.updatedAt = new Date().toISOString();
  }

  private dropTask(taskId: string, reason: string): void {
    try { this.store.pauseTask(taskId, { by: 'integrations', reason: `install advice: ${reason}` }); } catch { /* finished / gone */ }
  }

  /** Advance every pending advice (call periodically and on GET). */
  tick(): void {
    for (const e of this.int.list()) {
      const a = e.advice;
      if (!a || a.status !== 'pending' || !a.taskId) continue;
      try { this.step(e, a); } catch (err: any) { console.error(`Integrations advice ${e.id}:`, err?.message || err); }
    }
  }

  private step(e: Integration, a: AdviceState): void {
    const t = this.store.getTask(a.taskId!);
    const now = Date.now();
    let outcome: string | null = null;
    let plan: InstallPlan | null = null;
    if (!t) outcome = 'task disappeared';
    else if (isFailedTask(t)) outcome = `task failed: ${(t.result || '').slice(0, 200)}`;
    else if (t.status === 'done' || t.status === 'wait-input') {
      try { plan = readPlanFromTask(this.store.artifactsPath(t.id), t.result); }
      catch (err: any) { outcome = `no usable plan: ${err.message}`; if (t.status === 'wait-input') this.dropTask(t.id, 'asked a question instead of planning'); }
    } else if (Array.isArray(t.context?.failedAgents) && t.context!.failedAgents.some((f: any) => f?.agent === a.agent)) {
      outcome = `run failed on ${a.agent}: ${String(t.context!.failedAgents.at(-1)?.reason || '').slice(0, 200)}`;
      this.dropTask(t.id, `falling over from ${a.agent}`);
    } else if (t.status === 'pending' && now - Date.parse(t.createdAt) > PENDING_STALL_MS) {
      outcome = `not started after ${PENDING_STALL_MS / 60_000} min (agent busy / cooling down)`;
      this.dropTask(t.id, `stalled on ${a.agent}`);
    } else if (t.status === 'in-progress' && now - Date.parse(t.claimedAt || t.createdAt) > RUNNING_STALL_MS) {
      outcome = `still running after ${RUNNING_STALL_MS / 60_000} min`;
      this.dropTask(t.id, `timed out on ${a.agent}`);
    } else if (t.status === 'paused' || t.status === 'rejected') outcome = `task ${t.status}`;
    else return;   // still working

    this.int.patch(e.id, x => {
      const adv = x.advice;
      if (!adv || adv.taskId !== a.taskId) return;
      const at = new Date().toISOString();
      if (plan) {
        adv.history.push({ agent: adv.agent!, taskId: adv.taskId!, outcome: 'plan ready', at });
        adv.plan = plan; adv.lint = lintPlan(plan); adv.status = 'ready'; adv.error = undefined; adv.updatedAt = at;
        return;
      }
      adv.history.push({ agent: adv.agent!, taskId: adv.taskId!, outcome: outcome!, at });
      if (adv.attempt + 1 < adv.chain.length) {
        adv.attempt++;
        this.dispatch(x, adv);
      } else {
        adv.status = 'failed'; adv.updatedAt = at;
        adv.error = `every advisor failed (${adv.chain.join(' → ')}): ${outcome}`;
      }
    });
  }

  // ── jobs ────────────────────────────────────────────────────────────────
  getJob(id: string): Job | undefined { return this.jobs.get(id); }
  activeJob(integrationId: string): Job | undefined {
    const j = this.active.get(integrationId);
    return j ? this.jobs.get(j) : undefined;
  }

  private newJob(e: Integration, kind: JobKind, steps: JobStep[]): Job {
    if (this.active.has(e.id)) throw new Error(`${e.source} already has a ${this.jobs.get(this.active.get(e.id)!)?.kind} job running`);
    const job: Job = { id: randomUUID(), integrationId: e.id, source: e.source, kind, status: 'running', startedAt: new Date().toISOString(), steps, log: [] };
    this.jobs.set(job.id, job);
    this.active.set(e.id, job.id);
    if (this.jobs.size > MAX_JOBS) {
      for (const [k, j] of this.jobs) { if (j.status !== 'running') { this.jobs.delete(k); break; } }
    }
    return job;
  }
  private line(job: Job, s: JobLine['s'], text: string): void {
    if (job.log.length >= MAX_LOG) { if (job.log.length === MAX_LOG) job.log.push({ i: MAX_LOG, t: new Date().toISOString(), s: 'warn', text: '… log truncated' }); return; }
    job.log.push({ i: job.log.length, t: new Date().toISOString(), s, text: text.slice(0, 4000) });
  }
  private finish(job: Job, err?: string): void {
    job.status = err ? 'failed' : 'done';
    job.error = err;
    job.endedAt = new Date().toISOString();
    this.active.delete(job.integrationId);
    this.line(job, err ? 'err' : 'ok', err ? `✗ ${err}` : '✓ finished');
  }
  private async runPlanSteps(job: Job, e: Integration, steps: PlanStep[], offset: number, opts: { continueOnError?: boolean }): Promise<number> {
    let failed = 0;
    for (let i = 0; i < steps.length; i++) {
      const st = job.steps[offset + i];
      st.state = 'running';
      this.line(job, 'info', `▶ ${st.title}`);
      this.line(job, 'cmd', `$ ${steps[i].run}${steps[i].cwd === 'home' ? '   (in ~)' : ''}`);
      const r = await runStep(steps[i], { cloneDir: this.int.scanRoot(e), onLine: (s, l) => this.line(job, s === 'out' ? 'out' : 'err', l) });
      st.ms = r.ms;
      if (r.code === 0) { st.state = 'done'; this.line(job, 'ok', `  exit 0 (${(r.ms / 1000).toFixed(1)}s)`); continue; }
      st.state = 'failed'; failed++;
      st.note = r.timedOut ? 'timed out' : `exit ${r.code ?? r.signal}`;
      this.line(job, opts.continueOnError ? 'warn' : 'err', `  ${st.note}`);
      if (!opts.continueOnError) {
        for (let k = i + 1; k < steps.length; k++) job.steps[offset + k].state = 'skipped';
        return failed;
      }
    }
    return failed;
  }

  /** Install: built-in (skills / persona pack / web plugin) + the AI plan's steps. */
  startInstall(id: string, opts: { force?: boolean; usePlan?: boolean; skills?: string[] } = {}): Job {
    const e = this.int.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    if (e.audit.verdict === 'quarantine' && !opts.force) throw new Error(`${id} is quarantined — review the findings; installing requires force`);
    const plan = opts.usePlan !== false && e.advice?.status === 'ready' && e.advice.plan?.installable ? e.advice.plan : undefined;
    const lint = plan ? lintPlan(plan) : undefined;
    if (plan && lint!.blocked.length) throw new Error(`the install plan is blocked: ${lint!.blocked[0]}${lint!.blocked.length > 1 ? ` (+${lint!.blocked.length - 1} more)` : ''}`);
    const builtin = e.detected.skills.length > 0 || !!e.detected.personas || !!e.detected.web;
    if (!builtin && !plan?.steps.length) throw new Error('nothing to install yet — get install advice first (or wrap it with an agent)');

    const steps: JobStep[] = [{ title: 'Pre-flight: audit verdict, plan lint, required tools', state: 'pending' }];
    if (builtin) steps.push({ title: `Built-in install (${[e.detected.skills.length ? `${opts.skills?.length || e.detected.skills.length} skill(s)` : '', e.detected.personas ? 'persona pack' : '', e.detected.web ? 'portal plugin' : ''].filter(Boolean).join(', ')})`, state: 'pending' });
    const planOffset = steps.length;
    for (const s of plan?.steps || []) steps.push({ title: s.title, run: s.run, state: 'pending' });
    if (plan?.verify) steps.push({ title: 'Verify', run: plan.verify, state: 'pending' });
    steps.push({ title: 'Record where it was installed', state: 'pending' });
    const job = this.newJob(e, 'install', steps);

    (async () => {
      let idx = 0;
      const begin = () => { job.steps[idx].state = 'running'; this.line(job, 'info', `▶ ${job.steps[idx].title}`); };
      const done = () => { job.steps[idx].state = 'done'; idx++; };
      try {
        begin();
        this.line(job, e.audit.verdict === 'pass' ? 'ok' : 'warn', `  audit ${e.audit.verdict} — ${e.audit.counts.critical} critical / ${e.audit.counts.high} high / ${e.audit.counts.medium} medium${opts.force && e.audit.verdict === 'quarantine' ? ' (OVERRIDE by operator)' : ''}`);
        if (plan) {
          this.line(job, 'info', `  plan by ${e.advice?.agent}: ${plan.method || plan.scope} — ${plan.steps.length} step(s)`);
          for (const w of [...lint!.warnings, ...(plan.warnings || [])]) this.line(job, 'warn', `  ⚠ ${w}`);
          for (const tool of plan.requires || []) {
            const bin = tool.split(/[\s<>=@]/)[0];
            if (!/^[A-Za-z0-9._+-]+$/.test(bin)) continue;
            let found = '';
            try { found = execFileSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf-8' }).trim(); } catch { /* missing */ }
            this.line(job, found ? 'ok' : 'warn', found ? `  ✓ ${bin} → ${found}` : `  ⚠ ${bin} not found on PATH — a step may fail`);
          }
        } else this.line(job, 'info', '  no AI plan steps — built-in install only');
        done();

        if (builtin) {
          begin();
          const after = this.int.install(id, { force: opts.force, skills: opts.skills });
          for (const s of after.installed.skills) this.line(job, 'ok', `  skill ${s.name} → ${s.target}${s.links.length ? `  (linked: ${s.links.join(', ')})` : ''}`);
          if (after.installed.personas) this.line(job, 'ok', `  persona pack (${after.installed.personas.count}) → ${after.installed.personas.root}`);
          if (after.installed.web) this.line(job, 'ok', `  portal plugin → ${after.installed.web.url}`);
          for (const n of after.notes || []) this.line(job, 'warn', `  ℹ ${n}`);
          done();
        }

        let failed = 0;
        if (plan?.steps.length) {
          failed = await this.runPlanSteps(job, e, plan.steps, planOffset, {});
          idx = planOffset + plan.steps.length;
        }
        let verifyOk: boolean | undefined;
        if (plan?.verify) {
          if (failed) { job.steps[idx].state = 'skipped'; idx++; }
          else {
            const vf = await this.runPlanSteps(job, e, [{ title: 'Verify', run: plan.verify }], idx, { continueOnError: true });
            verifyOk = vf === 0; idx++;
          }
        }

        begin();
        const locations: NonNullable<Job['result']>['locations'] = [];
        const cur = this.int.get(id)!;
        for (const s of cur.installed.skills) {
          locations.push({ label: `skill ${s.name}`, path: s.target, exists: fs.existsSync(s.target) });
          for (const l of s.links) locations.push({ label: `  ↳ link`, path: l, exists: fs.existsSync(l) });
        }
        if (cur.installed.personas) locations.push({ label: 'persona pack', path: cur.installed.personas.root, exists: true });
        if (cur.installed.web) locations.push({ label: 'portal plugin', path: cur.installed.web.url });
        if (plan && plan.steps.length) {
          const rec: PlanInstallRecord = {
            at: new Date().toISOString(), agent: e.advice?.agent, method: plan.method, scope: plan.scope,
            steps: plan.steps, uninstall: plan.uninstall,
            locations: plan.locations.map(p => ({ path: p, exists: fs.existsSync(expandHome(p)) })),
            ...(plan.verify ? { verify: { run: plan.verify, ok: !!verifyOk } } : {}),
            usage: plan.usage,
          };
          for (const l of rec.locations) locations.push({ label: 'installed', path: l.path, exists: l.exists });
          // Record even a partial run so Uninstall can clean up what did land.
          this.int.patch(id, x => { x.installed.plan = rec; x.status = 'installed'; });
        }
        for (const l of locations) this.line(job, l.exists === false ? 'warn' : 'ok', `  ${l.label}: ${l.path}${l.exists === false ? '  (not found)' : ''}`);
        job.result = { locations, usage: plan?.usage };
        done();
        if (failed) return this.finish(job, `${failed} install step(s) failed — fix and retry, or press Uninstall to roll back what landed`);
        if (verifyOk === false) this.line(job, 'warn', 'verify command failed — the install may be incomplete');
        this.finish(job);
      } catch (err: any) {
        if (job.steps[idx]) job.steps[idx].state = 'failed';
        this.finish(job, err?.message || String(err));
      }
    })();
    return job;
  }

  /** Uninstall (AI-plan undo steps + built-in removal); `remove` then purges the clone. */
  startUninstall(id: string, opts: { remove?: boolean } = {}): Job {
    const e = this.int.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    const undo = e.installed.plan?.uninstall || [];
    const installed = hasInstall(e);
    const steps: JobStep[] = [];
    for (const s of undo) steps.push({ title: s.title, run: s.run, state: 'pending' });
    if (installed) steps.push({ title: 'Remove skills, links, portal card, persona registration', state: 'pending' });
    if (opts.remove) steps.push({ title: `Purge clone ${e.dir}`, state: 'pending' });
    if (!steps.length) throw new Error(`${e.source} is not installed`);
    const job = this.newJob(e, opts.remove ? 'remove' : 'uninstall', steps);

    (async () => {
      let idx = 0;
      const removed: string[] = [];
      try {
        if (undo.length) {
          this.line(job, 'info', `Undoing ${undo.length} user-profile install step(s) (${e.installed.plan?.method || 'AI plan'})`);
          const f = await this.runPlanSteps(job, e, undo, 0, { continueOnError: true });
          if (f) this.line(job, 'warn', `${f} uninstall step(s) failed — check the paths below by hand`);
          for (const l of e.installed.plan?.locations || []) {
            const still = fs.existsSync(expandHome(l.path));
            this.line(job, still ? 'warn' : 'ok', `  ${l.path}: ${still ? 'STILL PRESENT' : 'removed'}`);
            if (!still) removed.push(l.path);
          }
          idx = undo.length;
        }
        if (installed) {
          job.steps[idx].state = 'running';
          this.line(job, 'info', `▶ ${job.steps[idx].title}`);
          for (const s of e.installed.skills) { removed.push(s.target, ...s.links); this.line(job, 'ok', `  skill ${s.name}: ${s.target}${s.links.length ? ` + ${s.links.length} link(s)` : ''}`); }
          if (e.installed.web) { removed.push(e.installed.web.url); this.line(job, 'ok', `  portal card ${e.installed.web.portalKey}`); }
          if (e.installed.personas) this.line(job, 'ok', `  persona source ${e.installed.personas.root} unregistered`);
          this.int.uninstall(id, { planUndone: true });
          job.steps[idx].state = 'done'; idx++;
        }
        if (opts.remove) {
          job.steps[idx].state = 'running';
          this.line(job, 'info', `▶ ${job.steps[idx].title}`);
          this.int.uninstall(id, { purge: true, planUndone: true });
          const wrapper = this.int.wrapperDir(id);
          removed.push(e.dir);
          this.line(job, 'ok', `  deleted ${e.dir}${fs.existsSync(wrapper) ? '' : ` and ${path.basename(wrapper)}`} + registry entry`);
          job.steps[idx].state = 'done'; idx++;
        }
        job.result = { removed };
        this.finish(job);
      } catch (err: any) {
        if (job.steps[idx]) job.steps[idx].state = 'failed';
        this.finish(job, err?.message || String(err));
      }
    })();
    return job;
  }

  /** Remove: uninstall first when anything is installed, then purge. */
  startRemove(id: string): Job {
    const e = this.int.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    if (e.advice?.status === 'pending' && e.advice.taskId) this.dropTask(e.advice.taskId, 'integration removed');
    return this.startUninstall(id, { remove: true });
  }
}
