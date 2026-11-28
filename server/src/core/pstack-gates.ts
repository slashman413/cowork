/**
 * Task-level pstack gates that replace what the Workflows subsystem used to do
 * (removed in 54e8595): sharpen-race deferral (G2), `context.skill` (G10),
 * `context.review` panel gate (G5) and `context.arena` fan-out (G6).
 * Pure helpers — the dispatcher wires them in.
 */
import fs from 'fs';
import path from 'path';
import type { Task } from '../types.js';

/** G2: how long the dispatcher waits for a background intake sharpen to land. */
export const SHARPEN_WAIT_MS = 60_000;

/** G2: true while an intake sharpen started < SHARPEN_WAIT_MS ago has not yet
 *  written acceptance criteria. The dispatcher defers such a task one tick so
 *  the executor sees the sharpened brief instead of racing it. */
export function sharpenPending(task: Task, nowMs = Date.now(), waitMs = SHARPEN_WAIT_MS): boolean {
  const ctx = task.context || {};
  if (Array.isArray(ctx.acceptance) && ctx.acceptance.length > 0) return false;
  if (ctx.sharpenDoneAt) return false;
  const started = typeof ctx.sharpenStartedAt === 'string' ? Date.parse(ctx.sharpenStartedAt) : NaN;
  if (!Number.isFinite(started)) return false;
  return nowMs - started < waitMs;
}

/** Remote agents get at most this much of a skill inline. */
export const REMOTE_SKILL_INLINE_BYTES = 1200;

export interface VendoredPstackSkill {
  name: string;
  description: string;
  filePath: string;
}

export interface ResolvedPstackSkill {
  name: string;
  filePath: string;
  source: 'explicit' | 'pinned' | 'auto';
  reason: string;
}

export interface ResolveWorkspacePstackOptions {
  repoRoot: string;
  prompt: string;
  title?: string;
  turnIndex?: number;
  isResume?: boolean;
  workspacePath?: string;
  explicitSkill?: unknown;
  pinnedSkills?: readonly string[];
  autoSkills?: boolean;
  maxAutoSkills?: number;
}

const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

interface SkillCatalogCacheEntry {
  dirMtimeMs: number;
  skills: VendoredPstackSkill[];
}
const skillCatalogCache = new Map<string, SkillCatalogCacheEntry>();

function parseFrontmatterDescription(content: string): string {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return '';
  const fm = m[1];
  const line = /^description:\s*(.+)$/m.exec(fm);
  if (!line) return '';
  let val = line[1].trim();
  if (val === '>-' || val === '|' || val === '>') {
    const idx = fm.indexOf(line[0]) + line[0].length;
    const rest = fm.slice(idx).split('\n');
    const collected: string[] = [];
    for (const r of rest) {
      if (!r.trim()) { if (collected.length) break; continue; }
      if (/^\s+/.test(r)) collected.push(r.trim());
      else break;
    }
    val = collected.join(' ');
  }
  return val.replace(/^["']|["']$/g, '').trim();
}

/**
 * Enumerate vendored pstack skills from `<repoRoot>/vendor/pstack/skills/<name>/SKILL.md`.
 * Cached per skills dir + directory mtime so repeated resolutions stay cheap.
 */
export function listVendoredPstackSkills(repoRoot: string): VendoredPstackSkill[] {
  const skillsDir = path.join(repoRoot, 'vendor', 'pstack', 'skills');
  let dirMtimeMs = 0;
  try {
    dirMtimeMs = fs.statSync(skillsDir).mtimeMs;
  } catch {
    return [];
  }
  const cached = skillCatalogCache.get(skillsDir);
  if (cached && cached.dirMtimeMs === dirMtimeMs) return cached.skills;

  const skills: VendoredPstackSkill[] = [];
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !VALID_SKILL_NAME.test(entry.name)) continue;
      const filePath = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(filePath)) continue;
      let description = '';
      try {
        description = parseFrontmatterDescription(fs.readFileSync(filePath, 'utf8').slice(0, 2048));
      } catch { /* ignore unreadable skill */ }
      skills.push({ name: entry.name, description, filePath });
    }
  } catch {
    return [];
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  skillCatalogCache.set(skillsDir, { dirMtimeMs, skills });
  return skills;
}

interface AutoSkillRule {
  skill: string;
  pattern: RegExp;
  reason: string;
  priority: number;
}

/**
 * Curated intent-to-skill routing rules for workspace sessions.
 * Only activates skills that actually exist in `vendor/pstack/skills/<skill>/SKILL.md`.
 */
const WORKSPACE_SKILL_RULES: readonly AutoSkillRule[] = [
  { skill: 'architect', pattern: /\b(architect|architecture|system design|design (this|a|the)|module structure|data model|schema design|api design|plan the|blueprint|refactor architecture)\b/i, reason: 'architecture & design intent detected', priority: 95 },
  { skill: 'blast-radius', pattern: /\b(blast radius|what could (this )?break|impact analysis|downstream impact|side effects|risky change|safe to ship)\b/i, reason: 'change impact / blast-radius check requested', priority: 94 },
  { skill: 'interrogate', pattern: /\b(interrogate|adversarial review|stress test|find blind spots|challenge this|security review|code review|audit (this|the)|critique|review (this|the) (pr|diff|design|code))\b/i, reason: 'adversarial review / audit intent detected', priority: 92 },
  { skill: 'tdd', pattern: /\b(tdd|test-driven|write (unit |integration )?tests?|failing test|regression test|test coverage)\b/i, reason: 'testing / TDD workflow detected', priority: 90 },
  { skill: 'typescript-best-practices', pattern: /(\btypescript\b|\btsconfig\b|\btypecheck\b|\btype error\b|\.(ts|tsx)\b|\btype safety\b)/i, reason: 'TypeScript editing or typing work detected', priority: 88 },
  { skill: 'principle-fix-root-causes', pattern: /\b(bug|debug|fix|broken|crash|error|exception|failing|failure|regression|investigate|root cause|diagnose)\b/i, reason: 'debugging / root-cause fix workflow detected', priority: 86 },
  { skill: 'how', pattern: /\b(how does|walkthrough|walk me through|trace (the|how)|explain (the )?(code|flow|subsystem|architecture)|where should this live)\b/i, reason: 'subsystem walkthrough / code explanation detected', priority: 84 },
  { skill: 'why', pattern: /\b(why (does|did|do|was|is)|design rationale|postmortem|trade-?offs?)\b/i, reason: 'design rationale / history inquiry detected', priority: 82 },
  { skill: 'technical-writing', pattern: /\b(readme|rfc|documentation|docs|technical writing|write (a |the )?(guide|spec|doc|changelog|pr description))\b/i, reason: 'technical documentation intent detected', priority: 80 },
  { skill: 'benchmark-checklist', pattern: /\b(benchmark|latency|throughput|speedup|perf(ormance)? (test|regression|profile)|profiling)\b/i, reason: 'performance / benchmark measurement detected', priority: 79 },
  { skill: 'statechart', pattern: /\b(state machine|statechart|state transition|tla\+|deadlock|race condition|protocol state)\b/i, reason: 'state machine / concurrency modeling detected', priority: 78 },
  { skill: 'recall', pattern: /\b(recall|where did (i|we) leave off|catch me up|resume|prior context|continue (our|the|from))\b/i, reason: 'session continuation / context recall detected', priority: 77 },
  { skill: 'ketchup', pattern: /\b(ketchup|what changed|summarize progress|waiting decisions|status catch-?up)\b/i, reason: 'progress summary / catch-up requested', priority: 76 },
  { skill: 'sharpen', pattern: /\b(sharpen|clarify requirements|refine (the )?(brief|prompt|spec)|tighten scope)\b/i, reason: 'brief sharpening intent detected', priority: 75 },
  { skill: 'figure-it-out', pattern: /\b(figure it out|large migration|multi-part|end-to-end plan|autonomous investigation|greenfield)\b/i, reason: 'open-ended multi-phase planning detected', priority: 74 },
  { skill: 'show-me-your-work', pattern: /\b(decision trail|audit log|long-running|multi-phase|show me your work)\b/i, reason: 'auditable decision trail requested', priority: 73 },
  { skill: 'correct', pattern: /\b(keeps? happening|repeated mistake|prevent regression|add a lint|make .* impossible)\b/i, reason: 'structural mistake-prevention requested', priority: 72 },
  { skill: 'unslop', pattern: /\b(unslop|cut ai tells|polish prose|tighten copy|rewrite cleanly|de-?slop)\b/i, reason: 'prose tightening / unslop requested', priority: 71 },
  { skill: 'principle-model-the-domain', pattern: /\b(domain model|stateful|workflow|lifecycle|entity|invariant)\b/i, reason: 'stateful domain modeling detected', priority: 66 },
  { skill: 'principle-test-behavior-not-implementation', pattern: /\b(unit test|integration test|e2e|playwright|assert|verify behavior)\b/i, reason: 'behavioral test design detected', priority: 64 },
  { skill: 'principle-type-system-discipline', pattern: /\b(interface|schema|validate|validation|zod|types?\.ts|brand(ed)? type)\b/i, reason: 'type & boundary discipline detected', priority: 62 },
  { skill: 'principle-prove-it-works', pattern: /\b(implement|build|add|create|ship|verify|check|deploy|fix|update|feature|endpoint|ui|layout|mobile)\b/i, reason: 'verification-first delivery discipline', priority: 55 },
];

/**
 * Automatically resolve applicable vendored pstack skills for a workspace session turn
 * (or workspace-scoped task) without requiring manual `context.skill` flags.
 */
export function resolveWorkspaceSessionPstackSkills(opts: ResolveWorkspacePstackOptions): ResolvedPstackSkill[] {
  const catalog = listVendoredPstackSkills(opts.repoRoot);
  if (catalog.length === 0) return [];
  const byName = new Map(catalog.map(s => [s.name, s]));
  const picked: ResolvedPstackSkill[] = [];
  const seen = new Set<string>();

  const add = (name: string, source: ResolvedPstackSkill['source'], reason: string): boolean => {
    const clean = name.trim();
    if (!clean || seen.has(clean)) return false;
    const item = byName.get(clean);
    if (!item) return false;
    seen.add(clean);
    picked.push({ name: item.name, filePath: item.filePath, source, reason });
    return true;
  };

  if (typeof opts.explicitSkill === 'string' && opts.explicitSkill.trim()) {
    add(opts.explicitSkill.trim(), 'explicit', 'explicitly requested via context.skill');
  }

  if (Array.isArray(opts.pinnedSkills)) {
    for (const s of opts.pinnedSkills) {
      if (typeof s === 'string') add(s, 'pinned', 'pinned on workspace/session');
    }
  }

  if (opts.autoSkills === false) return picked;

  const maxAuto = Math.max(1, Math.min(5, Math.floor(opts.maxAutoSkills ?? 3)));
  let autoAdded = 0;
  const addAuto = (name: string, reason: string) => {
    if (autoAdded >= maxAuto) return false;
    if (add(name, 'auto', reason)) {
      autoAdded++;
      return true;
    }
    return false;
  };

  const haystack = `${opts.title || ''}\n${opts.prompt || ''}`.trim();

  if (opts.isResume) {
    addAuto('recall', 'resuming an active workspace session');
  }

  const slashMentions = haystack.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]*)\b/gi);
  for (const m of slashMentions) {
    const candidate = m[1].toLowerCase();
    if (byName.has(candidate)) {
      addAuto(candidate, `referenced /${candidate} in session prompt`);
    }
  }

  const matchedRules = WORKSPACE_SKILL_RULES
    .filter(r => byName.has(r.skill) && r.pattern.test(haystack))
    .sort((a, b) => b.priority - a.priority);

  for (const rule of matchedRules) {
    if (autoAdded >= maxAuto) break;
    addAuto(rule.skill, rule.reason);
  }

  if (autoAdded === 0) {
    if ((opts.turnIndex ?? 1) > 1) {
      addAuto('recall', 'multi-turn session continuity');
    }
    addAuto('principle-prove-it-works', 'default workspace session verification discipline');
    if (autoAdded === 0 && catalog[0]) {
      addAuto(catalog[0].name, 'vendored pstack workflow default');
    }
  }

  return picked;
}

/**
 * Render prompt lines injecting resolved vendored pstack skills for a workspace
 * session turn. Local agents get direct SKILL.md paths; remote agents get bounded
 * inline excerpts.
 */
export function renderWorkspaceSessionSkillsPrompt(opts: {
  repoRoot: string;
  skills: readonly ResolvedPstackSkill[];
  isLocal: boolean;
}): string[] {
  if (!opts.skills || opts.skills.length === 0) return [];
  const valid = opts.skills.filter(s => s && VALID_SKILL_NAME.test(s.name) && fs.existsSync(s.filePath));
  if (valid.length === 0) return [];

  if (opts.isLocal) {
    const lines = [
      `# Pstack Skills (Workspace Session Auto-Workflow)`,
      `Apply these vendored pstack skills to this workspace session turn before acting:`,
    ];
    for (const s of valid) {
      lines.push(`- \`${s.name}\` (${s.source}: ${s.reason}) — read and follow \`${s.filePath}\``);
    }
    lines.push(``);
    return lines;
  }

  const perSkillBudget = Math.max(400, Math.floor((REMOTE_SKILL_INLINE_BYTES * 2) / valid.length));
  const lines = [
    `# Pstack Skills (Workspace Session Auto-Workflow)`,
    `Apply these vendored pstack skills (excerpts):`,
  ];
  for (const s of valid) {
    let body = '';
    try { body = fs.readFileSync(s.filePath, 'utf8'); } catch { continue; }
    if (Buffer.byteLength(body) > perSkillBudget) {
      body = Buffer.from(body).subarray(0, perSkillBudget).toString('utf8').replace(/\uFFFD+$/, '') + '\n…(truncated)';
    }
    lines.push(`## Skill: ${s.name} (${s.source}: ${s.reason})`, body.trim(), ``);
  }
  return lines;
}

/** G10: render `# Skill` lines for `context.skill: "<pstack skill name>"`.
 *  Local agents are told to read the full vendored SKILL.md; remote agents,
 *  which cannot see this filesystem, get its first 1.2 KB inline. */
export function renderSkillPrompt(opts: { repoRoot: string; skill: unknown; isLocal: boolean }): string[] {
  const name = typeof opts.skill === 'string' ? opts.skill.trim() : '';
  if (!name || !VALID_SKILL_NAME.test(name)) return [];
  const file = path.join(opts.repoRoot, 'vendor', 'pstack', 'skills', name, 'SKILL.md');
  if (!fs.existsSync(file)) return [];
  if (opts.isLocal) {
    return [`# Skill`, `Read and follow \`${file}\` (pstack skill \`${name}\`) before you start; apply it to this task.`, ``];
  }
  let body = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(body) > REMOTE_SKILL_INLINE_BYTES) {
    body = Buffer.from(body).subarray(0, REMOTE_SKILL_INLINE_BYTES).toString('utf8').replace(/�+$/, '') + '\n…(truncated)';
  }
  return [`# Skill`, `Apply pstack skill \`${name}\` (excerpt):`, body.trim(), ``];
}

export type ReviewMode = 'default' | 'none' | 'llm' | 'panel';

/** G5: resolve the review gate a task asked for. `context.review` wins;
 *  otherwise judgment-tier tasks and PR tasks get the panel when
 *  `verifier.panel.judgmentTier` is on; everything else keeps the default gate. */
export function reviewMode(task: Task, panelCfg?: { enabled?: boolean; judgmentTier?: boolean }): ReviewMode {
  const r = task.context?.review;
  if (r === 'none' || r === 'llm') return r;
  if (r === 'panel' || r === 'arena') return panelCfg?.enabled === false ? 'default' : 'panel';
  if (panelCfg?.enabled !== false && panelCfg?.judgmentTier && (task.context?.tier === 'judgment' || task.context?.prUrl)) return 'panel';
  return 'default';
}

/** G5: acceptance used when the panel runs on a brief without explicit criteria. */
export function panelFallbackAcceptance(task: Task): string[] {
  return [`The result fully and correctly completes the brief: ${task.title}`];
}

export interface ArenaSpec { runners: number; rubric: string }

/** G6: normalise `context.arena` (true | number | {runners, rubric}). */
export function parseArena(v: unknown): ArenaSpec | null {
  if (v === undefined || v === null || v === false) return null;
  let runners = 3; let rubric = '';
  if (typeof v === 'number') runners = v;
  else if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.runners === 'number') runners = o.runners;
    if (typeof o.rubric === 'string') rubric = o.rubric;
  } else if (v !== true) return null;
  runners = Math.max(2, Math.min(5, Math.floor(runners)));
  return { runners, rubric: rubric || 'correctness, completeness against the brief, evidence quality, clarity' };
}

/** G6: pick up to n runner agents from distinct model families (tier order). */
export function pickArenaAgents(
  n: number,
  tiers: Record<string, string[]> | undefined,
  agents: Record<string, { location?: string; disabled?: boolean; exec?: string; model?: string }> | undefined,
  family: (id: string) => string
): string[] {
  const pool = [...(tiers?.judgment || []), ...(tiers?.standard || []), ...(tiers?.mechanical || [])];
  const out: string[] = []; const fams = new Set<string>();
  for (const id of pool) {
    const b = agents?.[id];
    if (!b || b.disabled) continue;
    const f = family(id);
    if (fams.has(f)) continue;
    fams.add(f); out.push(id);
    if (out.length >= n) return out;
  }
  for (const id of pool) {            // not enough families: fill with any remaining agent
    if (out.length >= n) break;
    if (agents?.[id] && !agents[id].disabled && !out.includes(id)) out.push(id);
  }
  return out;
}

/** G6: build the child task specs for an arena run: N runners + one judge. */
export function arenaPlan(task: Task, spec: ArenaSpec, runnerAgents: string[]) {
  const baseCtx = { ...(task.context || {}) } as Record<string, unknown>;
  for (const k of ['arena', 'arenaChildren', 'dependsOn', 'agent', 'agentAuto', 'review', 'prUrl']) delete baseCtx[k];
  const runners = runnerAgents.map((agent, i) => ({
    title: `[arena ${i + 1}/${runnerAgents.length}] ${task.title}`,
    description: task.description || task.title,
    context: { ...baseCtx, agent, arenaParent: task.id, arenaRole: 'runner' },
  }));
  const judge = {
    title: `[arena judge] ${task.title}`,
    description: [
      `Judge the ${runnerAgents.length} independent attempts at this brief (their results are attached as dependency results).`,
      `Rubric: ${spec.rubric}.`,
      `Score each attempt 1-10 per rubric item, name the winner by task id, and list what the synthesis must take from the others.`,
      ``, `Brief:`, task.description || task.title,
    ].join('\n'),
    context: { arenaParent: task.id, arenaRole: 'judge', tier: 'judgment' },
  };
  return { runners, judge };
}
