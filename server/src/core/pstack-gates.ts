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

/** G10: render `# Skill` lines for `context.skill: "<pstack skill name>"`.
 *  Local agents are told to read the full vendored SKILL.md; remote agents,
 *  which cannot see this filesystem, get its first 1.2 KB inline. */
export function renderSkillPrompt(opts: { repoRoot: string; skill: unknown; isLocal: boolean }): string[] {
  const name = typeof opts.skill === 'string' ? opts.skill.trim() : '';
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return [];
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
