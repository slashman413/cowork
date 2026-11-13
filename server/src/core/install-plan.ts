import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

/**
 * AI install plans for integrations (ADR-014 follow-up).
 *
 * After Fetch & audit, an advisor agent (default chain: local-agy-gemini-3.8-flash
 * → local-dsh-qwen3-8-27b, thinking high) reads the clone and writes an
 * `install-plan.json`: whether the repo can be installed into the user profile,
 * the exact commands, where things land, and how to undo it. Nothing in the plan
 * runs until a person presses Install and confirms the commands in the dialog.
 *
 * This module is pure: the schema, a tolerant parser (file or fenced JSON in the
 * agent's stdout), a linter that refuses sudo / system-wide writes, and the step
 * runner used by the install / uninstall jobs.
 */

export interface PlanStep {
  title: string;
  /** One shell command (bash -c). */
  run: string;
  /** Where it runs: the clone dir (default) or $HOME. */
  cwd?: 'clone' | 'home';
  why?: string;
}

export interface InstallPlan {
  /** False when the repo is not meant to be installed (docs, sample code…). */
  installable: boolean;
  summary: string;
  /** `user` = only $HOME (the only scope cowork executes); `system` needs root → manual only. */
  scope: 'user' | 'system' | 'none';
  /** Short method label, e.g. "skill copy", "npm global (user prefix)", "pipx", "uv tool", "cargo install". */
  method?: string;
  /** Tools that must already be on PATH (names only). */
  requires?: string[];
  steps: PlanStep[];
  /** Undo the steps above (run in order). */
  uninstall: PlanStep[];
  /** Files/dirs the install creates (absolute or ~/…). Checked after install. */
  locations: string[];
  /** One harmless command proving it works (e.g. `foo --version`). */
  verify?: string;
  /** How an agent uses it afterwards (CLI name, MCP snippet …). */
  usage?: string;
  warnings?: string[];
}

export interface PlanLint { blocked: string[]; warnings: string[] }

const MAX_STEPS = 20;
const str = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';

function normSteps(v: unknown): PlanStep[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_STEPS).map((s: any) => {
    if (typeof s === 'string') return { title: s.slice(0, 160), run: s.slice(0, 2000) };
    const run = str(s?.run ?? s?.command ?? s?.cmd, 2000);
    return {
      title: str(s?.title ?? s?.name, 160) || run.slice(0, 80),
      run,
      cwd: s?.cwd === 'home' ? 'home' as const : 'clone' as const,
      ...(str(s?.why, 400) ? { why: str(s?.why, 400) } : {}),
    };
  }).filter(s => s.run);
}

/** Coerce whatever the agent wrote into an InstallPlan; throws when it isn't one. */
export function normalizePlan(raw: any): InstallPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('install plan is not a JSON object');
  const scope = raw.scope === 'system' ? 'system' : raw.scope === 'none' ? 'none' : 'user';
  const plan: InstallPlan = {
    installable: raw.installable !== false,
    summary: str(raw.summary, 1200) || '(no summary)',
    scope,
    method: str(raw.method, 120) || undefined,
    requires: Array.isArray(raw.requires) ? raw.requires.map((r: unknown) => str(r, 80)).filter(Boolean).slice(0, 20) : [],
    steps: normSteps(raw.steps),
    uninstall: normSteps(raw.uninstall),
    locations: Array.isArray(raw.locations) ? raw.locations.map((l: unknown) => str(typeof l === 'object' && l ? (l as any).path : l, 400)).filter(Boolean).slice(0, 40) : [],
    verify: str(raw.verify, 500) || undefined,
    usage: str(raw.usage, 2000) || undefined,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map((w: unknown) => str(w, 400)).filter(Boolean).slice(0, 20) : [],
  };
  if (!plan.installable) { plan.steps = []; }
  return plan;
}

/** Find the plan: a JSON file, else the last ```json fenced block (or bare object) in text. */
export function parsePlanText(text: string): InstallPlan {
  const t = String(text || '');
  try { return normalizePlan(JSON.parse(t)); } catch { /* not bare JSON */ }
  const fences = [...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map(m => m[1]).reverse();
  for (const f of fences) {
    try { const j = JSON.parse(f); if (j && typeof j === 'object' && ('steps' in j || 'installable' in j)) return normalizePlan(j); } catch { /* next */ }
  }
  const first = t.indexOf('{'), last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return normalizePlan(JSON.parse(t.slice(first, last + 1))); } catch { /* fallthrough */ }
  }
  throw new Error('no install plan JSON found');
}

/** Read the plan an advisor task produced (outputs/ first, then the artifacts root, then its result). */
export function readPlanFromTask(artifactsDir: string | null, result: string | undefined): InstallPlan {
  const candidates = artifactsDir ? [path.join(artifactsDir, 'outputs', 'install-plan.json'), path.join(artifactsDir, 'install-plan.json')] : [];
  for (const f of candidates) {
    if (fs.existsSync(f)) return parsePlanText(fs.readFileSync(f, 'utf-8'));
  }
  if (result) return parsePlanText(result);
  throw new Error('the advisor produced no install-plan.json');
}

const BLOCK_RULES: Array<[RegExp, string]> = [
  [/(^|[;&|`(]\s*|\s)sudo(\s|$)/, 'uses sudo — cowork never runs root commands; do this by hand if you trust it'],
  [/(^|[;&|`(]\s*|\s)(su|doas|pkexec)\s/, 'switches user — not allowed'],
  [/\b(apt|apt-get|dnf|yum|pacman|zypper|apk|snap)\s+(install|remove|purge|upgrade)/, 'system package manager — needs root, not run by cowork'],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~\/?|\$HOME\/?)(\s|$|\*)/, 'recursive delete of / or $HOME'],
  [/>\s*\/(etc|usr|bin|sbin|lib|boot|opt|var)\//, 'writes into a system directory'],
  [/\b(systemctl)\s+(?!--user)/, 'system-level systemctl (only `systemctl --user` is allowed)'],
  [/\bmkfs|\bdd\s+if=|:\(\)\s*\{/, 'destructive command'],
];
const WARN_RULES: Array<[RegExp, string]> = [
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'pipes a downloaded script into a shell'],
  [/\bnpm\s+(i|install)\s+(-g|--global)\b/, 'global npm install (lands in the npm user prefix)'],
  [/\b(pip|pip3)\s+install\b(?!.*--user)(?!.*venv)/, 'pip install outside a venv / --user'],
  [/\bchmod\s+777\b/, 'chmod 777'],
  [/~\/\.(bashrc|zshrc|profile)|\$HOME\/\.(bashrc|zshrc|profile)/, 'edits a shell profile'],
];

/** Refuse plans cowork must not execute (root / system-wide / destructive). */
export function lintPlan(plan: InstallPlan): PlanLint {
  const blocked: string[] = [], warnings: string[] = [];
  if (plan.scope === 'system') blocked.push('plan scope is "system" — needs root; cowork only installs into the user profile');
  for (const [label, steps] of [['install', plan.steps], ['uninstall', plan.uninstall]] as const) {
    steps.forEach((s, i) => {
      for (const [re, why] of BLOCK_RULES) if (re.test(s.run)) blocked.push(`${label} step ${i + 1} (${s.title}): ${why}`);
      for (const [re, why] of WARN_RULES) if (re.test(s.run)) warnings.push(`${label} step ${i + 1} (${s.title}): ${why}`);
    });
  }
  return { blocked, warnings };
}

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir()).replace(/^\$HOME(?=$|\/)/, os.homedir());

export interface StepResult { code: number | null; signal?: string | null; timedOut?: boolean; ms: number }

/**
 * Run one plan step with bash (no stdin, no prompts), streaming output lines to
 * `onLine`. Timeout default 15 min per step.
 */
export function runStep(step: PlanStep, opts: { cloneDir: string; onLine: (stream: 'out' | 'err', line: string) => void; timeoutMs?: number; signal?: AbortSignal }): Promise<StepResult> {
  const t0 = Date.now();
  const cwd = step.cwd === 'home' ? os.homedir() : opts.cloneDir;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', step.run], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0', DEBIAN_FRONTEND: 'noninteractive',
        npm_config_yes: 'true', PIP_NO_INPUT: '1', COWORK_INTEGRATION_DIR: opts.cloneDir,
      },
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, opts.timeoutMs ?? 15 * 60_000);
    opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    const pipe = (stream: 'out' | 'err') => {
      let buf = '';
      return (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop() || '';
        for (const l of lines) opts.onLine(stream, l);
        if (buf.length > 4000) { opts.onLine(stream, buf); buf = ''; }
      };
    };
    child.stdout.on('data', pipe('out'));
    child.stderr.on('data', pipe('err'));
    child.on('error', (e) => opts.onLine('err', e.message));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ms: Date.now() - t0 });
    });
  });
}

/** The brief the advisor agent gets. */
export function buildAdvisePrompt(e: {
  id: string; source: string; dir: string; scanRoot: string; commit?: string;
  kinds: string[]; language?: string; license?: string; description?: string;
  mcp?: string; cli?: string; skills: string[]; personas?: number; web?: boolean;
  audit: { verdict: string; counts: Record<string, number>; top: string[] };
  skillsHome: string; clientSkillDirs: string[];
}): string {
  const builtin = [
    e.skills.length ? `- ${e.skills.length} agent skill(s) (${e.skills.slice(0, 12).join(', ')}${e.skills.length > 12 ? ', …' : ''}) — cowork copies them to \`${e.skillsHome}/<name>\` and symlinks them into ${e.clientSkillDirs.map(d => `\`${d}\``).join(', ') || 'the client skill dirs'} by itself. Do NOT add steps for that.` : '',
    e.personas ? `- a persona pack (${e.personas} personas) — cowork registers it for the Roster by itself.` : '',
    e.web ? `- a static web app — cowork serves it as a sandboxed portal plugin by itself.` : '',
  ].filter(Boolean);
  return [
    `# Install advice for ${e.source}`,
    ``,
    `You are the install advisor of the cowork Integrations page. A person fetched this repository and wants to know HOW to install it properly on this machine (Linux aarch64, DGX Spark, user \`${os.userInfo().username}\`). You do not install anything — you write a plan that the person reviews and then runs from the page.`,
    ``,
    `- Clone (read-only, shallow, commit ${e.commit || '?'}): \`${e.scanRoot}\``,
    `- Detected: ${e.kinds.join(', ')}${e.language ? ` · ${e.language}` : ''}${e.license ? ` · license ${e.license}` : ''}`,
    e.description ? `- Summary: ${e.description}` : null,
    e.mcp ? `- MCP: ${e.mcp}` : null,
    e.cli ? `- CLI: ${e.cli}` : null,
    `- Static audit: ${e.audit.verdict.toUpperCase()} (${e.audit.counts.critical || 0} critical / ${e.audit.counts.high || 0} high / ${e.audit.counts.medium || 0} medium)`,
    ...e.audit.top.map(t => `  ${t}`),
    builtin.length ? `\nAlready handled by cowork's built-in installer:\n${builtin.join('\n')}` : null,
    ``,
    `## Do this`,
    `1. Read the README, install docs, package.json / pyproject.toml / Cargo.toml / go.mod / Makefile / install scripts. Do NOT run the repo's code and do not install anything.`,
    `2. Decide whether it can (and should) be installed into the USER profile: \`~/.local/bin\`, \`~/.local/share\`, a venv or node_modules inside the clone dir, \`pipx\`/\`uv tool\` (user), \`npm\` with the existing user prefix, \`cargo install --root ~/.local\`, \`go install\` (GOBIN in ~/go/bin), \`systemctl --user\` units. NEVER sudo, apt, or anything outside $HOME. If it truly needs root, set scope "system", installable false, and explain the manual steps in "summary".`,
    `3. Each step is ONE non-interactive bash command (no prompts, no editors, no \`read\`). cwd is the clone dir unless you set "cwd": "home". Prefer idempotent commands. Pin to the fetched commit's files (they are already on disk) — don't re-clone.`,
    `4. Write the matching uninstall steps that remove EXACTLY what the install created (not the clone itself — cowork deletes that).`,
    `5. List every file/dir the install creates in "locations" (absolute or ~/ paths) so the page can show where it landed.`,
    `6. If cowork's built-in installer already covers it (pure skill / persona / web repo) and nothing else is needed, return "steps": [] and say so in "summary".`,
    ``,
    `## Output (required)`,
    `Write the plan to \`outputs/install-plan.json\` (relative to your working directory) AND print the same JSON in a \`\`\`json fenced block at the end of your reply. Schema:`,
    '```json',
    JSON.stringify({
      installable: true, scope: 'user', method: 'pipx (user)', summary: 'What it is, what gets installed and why this method.',
      requires: ['python3', 'pipx'],
      steps: [{ title: 'Install the CLI with pipx', run: 'pipx install .', cwd: 'clone', why: 'isolated venv, binary on ~/.local/bin' }],
      uninstall: [{ title: 'Remove the pipx app', run: 'pipx uninstall example', cwd: 'home' }],
      locations: ['~/.local/bin/example', '~/.local/share/pipx/venvs/example'],
      verify: 'example --version',
      usage: 'How an agent uses it afterwards (command, or the mcpServers JSON snippet).',
      warnings: ['anything the person should know before running it'],
    }, null, 2),
    '```',
  ].filter(l => l !== null).join('\n');
}
