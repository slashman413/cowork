#!/usr/bin/env node
/**
 * eval-cli — the side-effecting half of the P2-1 eval harness (pure logic lives
 * in core/eval-harness.ts). Run by the `eval-prompt-change` workflow through the
 * exec:script brain `local-script-eval-harness` (`node dist/eval-cli.js step`),
 * or by hand:
 *
 *   node dist/eval-cli.js run --family engineering --a CONVENTIONS.md --b /tmp/old.md --out <dir>
 *   node dist/eval-cli.js select --family engineering --out <dir> [--n 5] [--seed <s>]
 *   node dist/eval-cli.js replay --selection <dir>/selection.json --variant <path> --label A --out <dir>
 *   node dist/eval-cli.js judge --a <replayDirA> --b <replayDirB> --out <dir>
 *
 * Common flags: --executor <brainId> --judge <brainId> --timebox <min> --concurrency <k>.
 * Progress goes to stderr; stdout is the step's result (the report, for judge/run).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { spawn, execFileSync } from 'child_process';
import { loadConfig } from './config.js';
import { Roster } from './core/roster.js';
import { brainFamily } from './core/tiers.js';
import { selectSpecJudges } from './core/result-verifier.js';
import {
  selectReplayTasks, buildReplayPrompt, sandboxEnv, writeGuardDir, readBlockedLog, brainArgv, firstRunnableBrain,
  blindPairs, buildJudgePrompt, parseJudgeScores, unblind, summarize, renderReport, normalizeStatus, diffSnapshots,
  sandboxClean, sha256, type Snapshot, type SandboxCheck, type ReplayOutput,
} from './core/eval-harness.js';
import type { Config, Task } from './types.js';

const log = (...a: unknown[]) => console.error('[eval]', ...a);

type Args = Record<string, string>;
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

function config(): Config {
  const orig = console.log;
  console.log = (...a: unknown[]) => console.error(...a);   // loadConfig chats on stdout
  try { return loadConfig(); } finally { console.log = orig; }
}

const repoRoot = (cfg: Config) => path.resolve(cfg.paths.artifacts, '..');
const resolveIn = (root: string, p: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));

// ── hub API (read-only) ──────────────────────────────────────────────────────

function getJson<T = any>(cfg: Config, pathname: string): Promise<T> {
  const base = process.env.COWORK_API || `${cfg.server.tls ? 'https' : 'http'}://localhost:${cfg.server.port}/api`;
  const url = new URL(base.replace(/\/$/, '') + pathname);
  const key = process.env.COWORK_API_KEY || cfg.server.apiKey;
  const lib = url.protocol === 'https:' ? https : http;
  const ca = cfg.server.tls?.certFile && fs.existsSync(cfg.server.tls.certFile) ? fs.readFileSync(cfg.server.tls.certFile) : undefined;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, ...(ca ? { ca } : {}) } as any, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) return reject(new Error(`GET ${pathname} → ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e: any) { reject(new Error(`GET ${pathname}: bad JSON (${e.message})`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`GET ${pathname} timed out`)));
  });
}

// ── brains ───────────────────────────────────────────────────────────────────

function resolveExecutor(cfg: Config, family: string, wanted?: string): string {
  const brains = cfg.orchestration.brains || {};
  if (wanted && wanted !== 'auto' && !/^\{\{/.test(wanted)) {
    if (!firstRunnableBrain([wanted], brains)) throw new Error(`executor "${wanted}" is not an enabled local brain the harness can run`);
    return wanted;
  }
  const o = cfg.orchestration;
  const chain = o.agentChains?.[family]?.length ? o.agentChains[family] : o.divisionChains?.[family]?.length ? o.divisionChains[family] : o.defaultChain || [];
  const id = firstRunnableBrain(chain, brains);
  if (!id) throw new Error(`no runnable local brain in the chain for "${family}"`);
  return id;
}

/** Judge = the P1-1 cross-family mapping for the executor, first available. */
function resolveJudge(cfg: Config, executor: string, wanted?: string): string {
  const brains = cfg.orchestration.brains || {};
  const exFam = brainFamily(brains[executor], executor);
  const pick = wanted && wanted !== 'auto' && !/^\{\{/.test(wanted)
    ? wanted
    : selectSpecJudges(executor, { brains, judges: cfg.orchestration.verifier?.spec?.judges }).find(id => firstRunnableBrain([id], brains));
  if (!pick || !firstRunnableBrain([pick], brains)) throw new Error(`no runnable judge brain for executor ${executor}`);
  const jFam = brainFamily(brains[pick], pick);
  if (jFam === exFam) throw new Error(`judge ${pick} is the same family (${jFam}) as executor ${executor} — the judge must be cross-family`);
  return pick;
}

function runBrain(cfg: Config, brainId: string, prompt: string, cwd: string, env: Record<string, string>, timeoutMs: number):
  Promise<{ status: 'ok' | 'error' | 'timeout'; text: string; ms: number }> {
  const b = (cfg.orchestration.brains || {})[brainId];
  const argv = brainArgv(b, prompt, timeoutMs);
  const t0 = Date.now();
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(timer); resolve({ status: 'error', text: `spawn failed: ${e.message}`, ms: Date.now() - t0 }); });
    child.on('close', code => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (timedOut) resolve({ status: 'timeout', text: `[REPLAY TIMED OUT after ${Math.round(timeoutMs / 60000)} min — partial output follows]\n${out}`, ms });
      else if (code === 0 && out.trim()) resolve({ status: 'ok', text: out, ms });
      else resolve({ status: 'error', text: `[exit ${code}]\n${out}\n${err.slice(-2000)}`, ms });
    });
  });
}

async function pool<T, R>(items: T[], k: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(k, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── outward-action check ─────────────────────────────────────────────────────

function repoRoots(cfg: Config): string[] {
  if (process.env.EVAL_REPO_ROOTS) return process.env.EVAL_REPO_ROOTS.split(':').filter(Boolean);
  const root = repoRoot(cfg);
  const parent = path.dirname(root);
  const out = new Set<string>([root]);
  for (const d of fs.readdirSync(parent)) {
    const p = path.join(parent, d);
    if (fs.existsSync(path.join(p, '.git'))) out.add(p);
  }
  const blog = path.join(os.homedir(), 'slashman413');
  if (fs.existsSync(path.join(blog, '.git'))) out.add(blog);
  return [...out].sort();
}

function snapshot(roots: string[]): Snapshot {
  const git = (cwd: string, args: string[]) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return '?'; }
  };
  const snap: Snapshot = {};
  for (const r of roots) {
    snap[r] = {
      head: git(r, ['rev-parse', 'HEAD']),
      status: sha256(normalizeStatus(git(r, ['status', '--porcelain']))),
      refs: sha256(git(r, ['for-each-ref', '--format=%(refname) %(objectname)'])),
    };
  }
  return snap;
}

async function tasksCreatedBetween(cfg: Config, start: string, end: string, ownRunId: string) {
  const all = await getJson<Task[]>(cfg, '/inbox');
  return all
    .filter(t => t.createdAt >= start && t.createdAt <= end && t.context?.workflowRunId !== ownRunId)
    .map(t => ({ id: t.id, title: t.title, from: `${t.from?.platform || '?'}/${t.from?.agent || '?'}` }));
}

// ── commands ─────────────────────────────────────────────────────────────────

interface Selection {
  runId: string; family: string; seed: string; createdAt: string;
  tasks: { id: string; title: string; description: string; context: Record<string, any>; agent: string; depResults: { title: string; result: string }[] }[];
}

async function cmdSelect(cfg: Config, a: Args): Promise<string> {
  const family = a.family; const out = a.out;
  if (!family || !out) throw new Error('select needs --family and --out');
  const n = Number(a.n) || 5;
  const runId = a.run || `eval-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const seed = a.seed || runId;
  const done = await getJson<Task[]>(cfg, '/inbox?status=done');
  const picked = selectReplayTasks(done, family, n, seed);
  if (picked.length < n) throw new Error(`only ${picked.length} replayable done tasks for family "${family}" (need ${n})`);
  const tasks: Selection['tasks'] = [];
  for (const t of picked) {
    const depResults: { title: string; result: string }[] = [];
    for (const id of Array.isArray(t.context?.dependsOn) ? t.context!.dependsOn as string[] : []) {
      try { const d = await getJson<Task>(cfg, `/inbox/${id}`); if (d.result) depResults.push({ title: d.title, result: d.result }); } catch { /* dep purged */ }
    }
    tasks.push({ id: t.id, title: t.title, description: t.description, context: t.context || {}, agent: String(t.context?.ranAgent || t.context?.agent || ''), depResults });
  }
  const sel: Selection = { runId, family, seed, createdAt: new Date().toISOString(), tasks };
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'selection.json');
  fs.writeFileSync(file, JSON.stringify(sel, null, 2));
  log(`selected ${tasks.length} ${family} tasks → ${file}`);
  return [`Selected ${tasks.length} historical done \`${family}\` tasks for eval run ${runId} (seed ${seed}):`, ...tasks.map(t => `- \`${t.id.slice(0, 8)}\` ${t.title}`), ``, `selection: ${file}`].join('\n');
}

interface Manifest {
  label: 'A' | 'B'; runId: string; selection: string; variantPath: string; variantSha256: string; executor: string;
  results: { taskId: string; status: string; ms: number; resultFile: string }[];
  check: SandboxCheck;
}

async function cmdReplay(cfg: Config, a: Args): Promise<string> {
  const label = (a.label || '').toUpperCase() as 'A' | 'B';
  if (!a.selection || !a.variant || !a.out || (label !== 'A' && label !== 'B')) throw new Error('replay needs --selection --variant --label A|B --out');
  const sel: Selection = JSON.parse(fs.readFileSync(a.selection, 'utf-8'));
  const root = repoRoot(cfg);
  const variantPath = resolveIn(root, a.variant);
  const rules = fs.readFileSync(variantPath, 'utf-8');
  const executor = resolveExecutor(cfg, sel.family, a.executor);
  const timebox = Number(a.timebox) || 12;
  const out = path.resolve(a.out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'variant.md'), rules);
  const guard = path.join(out, 'guard');
  const which = (b: string, d: string) => { try { return execFileSync('bash', ['-lc', `command -v ${b}`], { encoding: 'utf-8' }).trim() || d; } catch { return d; } };
  writeGuardDir(guard, which('curl', '/usr/bin/curl'), which('npm', '/usr/bin/npm'));
  const roster = new Roster(cfg.paths.agencyAgents);
  const roots = repoRoots(cfg);
  const before = snapshot(roots);
  const startedAt = new Date().toISOString();
  log(`replay ${label}: ${sel.tasks.length} tasks on ${executor}, timebox ${timebox} min, variant ${variantPath}`);
  const results = await pool(sel.tasks, Number(a.concurrency) || 3, async (t, i) => {
    const dir = path.join(out, 'replays', `${i + 1}-${t.id.slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    const persona = t.agent ? roster.getPersona(t.agent)?.persona : null;
    const prompt = buildReplayPrompt({ rules, persona, agent: t.agent, task: t, sandboxDir: dir, timeboxMin: timebox, depResults: t.depResults });
    fs.writeFileSync(path.join(dir, '..', `${i + 1}-${t.id.slice(0, 8)}.prompt.md`), prompt);
    const env = { ...sandboxEnv(process.env, guard), COWORK_ARTIFACTS_DIR: dir, COWORK_TASK_ID: `replay-${label}-${t.id}` };
    const r = await runBrain(cfg, executor, prompt, dir, env, (timebox + 3) * 60_000);
    const resultFile = path.join(out, 'replays', `${i + 1}-${t.id.slice(0, 8)}.result.md`);
    fs.writeFileSync(resultFile, r.text);
    log(`replay ${label} ${i + 1}/${sel.tasks.length} ${t.id.slice(0, 8)} → ${r.status} in ${Math.round(r.ms / 1000)}s`);
    return { taskId: t.id, status: r.status, ms: r.ms, resultFile };
  });
  const finishedAt = new Date().toISOString();
  const after = snapshot(roots);
  let tasksCreated: SandboxCheck['tasksCreated'] = [];
  try { tasksCreated = await tasksCreatedBetween(cfg, startedAt, finishedAt, sel.runId); }
  catch (e: any) { tasksCreated = [{ id: '????????', title: `could not list tasks: ${e.message}`, from: 'eval-harness' }]; }
  const check: SandboxCheck = { label, startedAt, finishedAt, repoChanges: diffSnapshots(before, after), tasksCreated, blockedAttempts: readBlockedLog(guard) };
  const manifest: Manifest = { label, runId: sel.runId, selection: path.resolve(a.selection), variantPath, variantSha256: sha256(rules), executor, results, check };
  fs.writeFileSync(path.join(out, 'replay-manifest.json'), JSON.stringify(manifest, null, 2));
  return [
    `Replayed ${results.length} tasks with variant ${label} (\`${variantPath}\`, sha256 ${manifest.variantSha256.slice(0, 12)}) on ${executor}:`,
    ...results.map(r => `- \`${r.taskId.slice(0, 8)}\` ${r.status} (${Math.round(r.ms / 1000)}s)`),
    `Sandbox check: ${sandboxClean(check) ? 'clean' : 'CHANGES OBSERVED'} — repo changes ${check.repoChanges.length}, tasks created ${check.tasksCreated.length}, blocked attempts ${check.blockedAttempts.length}`,
    `manifest: ${path.join(out, 'replay-manifest.json')}`,
  ].join('\n');
}

async function cmdJudge(cfg: Config, a: Args): Promise<string> {
  if (!a.a || !a.b || !a.out) throw new Error('judge needs --a <replayDirA> --b <replayDirB> --out');
  const mA: Manifest = JSON.parse(fs.readFileSync(path.join(a.a, 'replay-manifest.json'), 'utf-8'));
  const mB: Manifest = JSON.parse(fs.readFileSync(path.join(a.b, 'replay-manifest.json'), 'utf-8'));
  if (mA.label !== 'A' || mB.label !== 'B') throw new Error(`expected manifests labelled A and B, got ${mA.label}/${mB.label}`);
  if (mA.executor !== mB.executor) throw new Error(`A and B ran on different executors (${mA.executor} vs ${mB.executor}) — not comparable`);
  const sel: Selection = JSON.parse(fs.readFileSync(mA.selection, 'utf-8'));
  const judge = resolveJudge(cfg, mA.executor, a.judge);
  const read = (m: Manifest, id: string) => { const r = m.results.find(x => x.taskId === id); return r ? fs.readFileSync(r.resultFile, 'utf-8') : ''; };
  const pairs: ReplayOutput[] = sel.tasks.map(t => ({ taskId: t.id, title: t.title, description: t.description, a: read(mA, t.id), b: read(mB, t.id) }));
  const { items, key } = blindPairs(pairs, sel.runId);
  const prompt = buildJudgePrompt(items);
  const out = path.resolve(a.out);
  const jdir = path.join(out, 'judge');
  fs.mkdirSync(jdir, { recursive: true });
  fs.writeFileSync(path.join(jdir, 'judge-prompt.md'), prompt);
  const guard = path.join(jdir, 'guard');
  writeGuardDir(guard);
  const env = sandboxEnv(process.env, guard);
  log(`judge ${judge} scoring ${items.length} blinded pairs (${prompt.length} chars)`);
  let raw = ''; let judged = null as ReturnType<typeof parseJudgeScores> | null; let parseErr = '';
  for (let attempt = 1; attempt <= 2 && !judged; attempt++) {
    const p = attempt === 1 ? prompt : `${prompt}\n\nYour previous reply could not be parsed (${parseErr}). Reply with ONLY the JSON object.`;
    const r = await runBrain(cfg, judge, p, jdir, env, 15 * 60_000);
    raw = r.text;
    fs.writeFileSync(path.join(jdir, `judge-reply-${attempt}.txt`), raw);
    try { judged = parseJudgeScores(raw, items.map(i => i.alias)); }
    catch (e: any) { parseErr = e.message; log(`judge reply ${attempt} unparseable: ${parseErr}`); }
  }
  if (!judged) throw new Error(`judge ${judge} gave no parseable scores: ${parseErr}`);
  fs.writeFileSync(path.join(jdir, 'blind-key.json'), JSON.stringify(key, null, 2));   // written only after scoring
  const rows = unblind(judged, key, items);
  const summary = summarize(rows);
  const brains = cfg.orchestration.brains || {};
  const report = renderReport({
    runId: sel.runId, family: sel.family, createdAt: new Date().toISOString(),
    variantA: { path: mA.variantPath, sha256: mA.variantSha256 }, variantB: { path: mB.variantPath, sha256: mB.variantSha256 },
    executor: mA.executor, judge, executorFamily: brainFamily(brains[mA.executor], mA.executor), judgeFamily: brainFamily(brains[judge], judge),
    rows, summary,
    replayStatus: sel.tasks.map(t => ({ taskId: t.id, A: mA.results.find(r => r.taskId === t.id)?.status || '?', B: mB.results.find(r => r.taskId === t.id)?.status || '?' })),
    checks: [mA.check, mB.check],
  });
  fs.writeFileSync(path.join(out, 'eval-report.md'), report);
  fs.writeFileSync(path.join(out, 'scores.json'), JSON.stringify({ runId: sel.runId, summary, rows, judge, executor: mA.executor }, null, 2));
  const clean = sandboxClean(mA.check) && sandboxClean(mB.check);
  return [
    report,
    `STATUS: ${clean ? 'DONE' : 'DONE_WITH_CONCERNS'}`,
    `EVIDENCE:`,
    `- ${path.join(out, 'eval-report.md')} → Δ(A−B)=${summary.delta} n=${summary.n} (judge ${judge}, executor ${mA.executor})`,
    `- outward-action check → ${clean ? 'no repo changes, no tasks created' : 'changes observed, see report'}`,
    ...(clean ? [] : [`CONCERNS: side effects observed during the replay window — attribute them before trusting this run`]),
  ].join('\n');
}

async function cmdRun(cfg: Config, a: Args): Promise<string> {
  if (!a.family || !a.a || !a.b || !a.out) throw new Error('run needs --family --a --b --out');
  const out = path.resolve(a.out);
  log(await cmdSelect(cfg, { ...a, out: path.join(out, 'select') }));
  const selection = path.join(out, 'select', 'selection.json');
  const [ra, rb] = await Promise.all([
    cmdReplay(cfg, { ...a, selection, variant: a.a, label: 'A', out: path.join(out, 'replay-a') }),
    cmdReplay(cfg, { ...a, selection, variant: a.b, label: 'B', out: path.join(out, 'replay-b') }),
  ]);
  log(ra); log(rb);
  return cmdJudge(cfg, { ...a, a: path.join(out, 'replay-a'), b: path.join(out, 'replay-b'), out });
}

/** exec:script entry for the eval-prompt-change workflow. The step is chosen by
 *  context.stepKey; parameters come from the `EVAL_ARGS: {…}` line of the task
 *  description; inputs are found in the dependency tasks' artifact dirs. */
async function cmdStep(cfg: Config): Promise<string> {
  const ctx = JSON.parse(process.env.COWORK_TASK_CONTEXT || '{}');
  const desc = process.env.COWORK_TASK_DESCRIPTION || '';
  const out = process.env.COWORK_ARTIFACTS_DIR;
  if (!out) throw new Error('step mode needs COWORK_ARTIFACTS_DIR (run me through the exec:script brain)');
  const m = desc.match(/^EVAL_ARGS:\s*(\{.*\})\s*$/m);
  if (!m) throw new Error('task description has no "EVAL_ARGS: {…}" line');
  const args: Args = JSON.parse(m[1]);
  const deps: string[] = Array.isArray(ctx.dependsOn) ? ctx.dependsOn : [];
  const artRoot = path.dirname(path.resolve(out));
  const depFile = (name: string, pred: (p: string) => boolean = () => true) =>
    deps.map(id => path.join(artRoot, id, name)).find(p => fs.existsSync(p) && pred(p));
  const labelled = (l: string) => (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')).label === l;
  switch (ctx.stepKey) {
    case 'select':
      return cmdSelect(cfg, { ...args, out, run: ctx.workflowRunId });
    case 'replay-a':
    case 'replay-b': {
      const selection = depFile('selection.json');
      if (!selection) throw new Error('no selection.json in the dependency artifacts');
      const label = ctx.stepKey === 'replay-a' ? 'A' : 'B';
      return cmdReplay(cfg, { ...args, selection, label, variant: label === 'A' ? args.variantA : args.variantB, out });
    }
    case 'judge': {
      const ma = depFile('replay-manifest.json', labelled('A'));
      const mb = depFile('replay-manifest.json', labelled('B'));
      if (!ma || !mb) throw new Error('judge step needs replay manifests A and B in its dependencies');
      return cmdJudge(cfg, { ...args, a: path.dirname(ma), b: path.dirname(mb), out });
    }
    default:
      throw new Error(`unknown eval step "${ctx.stepKey}"`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const cfg = config();
  const cmds: Record<string, () => Promise<string>> = {
    select: () => cmdSelect(cfg, a), replay: () => cmdReplay(cfg, a), judge: () => cmdJudge(cfg, a),
    run: () => cmdRun(cfg, a), step: () => cmdStep(cfg),
  };
  if (!cmds[cmd]) { console.error('usage: eval-cli <select|replay|judge|run|step> [--flags]'); process.exit(2); }
  process.stdout.write((await cmds[cmd]()) + '\n');
}

main().catch(e => { console.error(`eval-cli failed: ${e?.stack || e}`); process.exit(1); });
