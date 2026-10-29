/**
 * Role → brain tiers (P1-4, after superpowers' SDD model selection and pstack
 * setup-pstack).
 *
 * `orchestration.tiers` names ordered brain lists by the kind of work:
 *
 *   mechanical  cheap/local: formatting, file moves, scripted renders
 *   standard    most building and writing
 *   judgment    design, ambiguous briefs, final review (opus-class)
 *   review      NOT a list — resolved at runtime to a brain of a different
 *               model family than the executor (see reviewChain; used by P1-1)
 *
 * A task (context.tier) or workflow step (`tier`) may name a tier. When the task
 * has no pinned brain and its agent has no agentChains override, its chain is
 * the tier's list followed by the normal default chain, de-duplicated. No tier
 * → the chain is exactly what it was before. Disabled brains are stripped by
 * the caller (chainFor), so the config may list brains that are off today.
 */
import type { BrainConfig } from '../types.js';

export const TIER_NAMES = ['mechanical', 'standard', 'judgment', 'review'] as const;
export type TierName = typeof TIER_NAMES[number];

/** The tier a task context names, or undefined when absent / not a known tier. */
export function taskTier(ctx: Record<string, any> | undefined): TierName | undefined {
  const t = typeof ctx?.tier === 'string' ? ctx.tier.trim().toLowerCase() : '';
  return (TIER_NAMES as readonly string[]).includes(t) ? t as TierName : undefined;
}

/** Throws on a tier that is set but unknown (POST /api/inbox answers 400). */
export function assertTier(v: unknown, field = 'context.tier'): void {
  if (v === undefined || v === null || v === '') return;
  if (typeof v !== 'string' || !(TIER_NAMES as readonly string[]).includes(v.trim().toLowerCase())) {
    throw new Error(`${field} must be one of ${TIER_NAMES.join(', ')}`);
  }
}

/** Model family of a brain: claude / gemini / qwen / openai / deepseek / other. */
export function brainFamily(b: Pick<BrainConfig, 'exec' | 'model'> | undefined, id = ''): string {
  const s = `${b?.model || ''} ${id}`.toLowerCase();
  if (b?.exec === 'claude' || /(?:^|-)cc(?:-|$)|claude|opus|sonnet|haiku|fable/.test(s)) return 'claude';
  if (/gemini|argon/.test(s)) return 'gemini';
  if (/qwen/.test(s)) return 'qwen';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/gpt|codex/.test(s) || b?.exec === 'codex') return 'openai';
  return 'other';
}

/** Tier list followed by the base chain, first occurrence wins. */
export function mergeTierChain(tierList: string[] | undefined, base: string[]): string[] {
  const out: string[] = [];
  for (const id of [...(tierList || []), ...base]) if (id && !out.includes(id)) out.push(id);
  return out;
}

/**
 * The `review` tier for an executor brain, per the CEO's judge-family ruling
 * (2026-10-20): Gemini judges Claude output; an opus-class (judgment-tier
 * Claude) brain judges Gemini / qwen / anything else. Candidates come from the
 * configured tiers (judgment, standard, mechanical, in that order) and are
 * filtered to enabled brains of a different family than the executor.
 */
export function reviewChain(
  executorBrainId: string,
  tiers: Record<string, string[]> | undefined,
  brains: Record<string, BrainConfig>
): string[] {
  const execFamily = brainFamily(brains[executorBrainId], executorBrainId);
  const want = execFamily === 'claude' ? 'gemini' : 'claude';
  const pool = mergeTierChain([...(tiers?.judgment || []), ...(tiers?.standard || [])], tiers?.mechanical || []);
  const usable = pool.filter(id => brains[id] && !brains[id].disabled && id !== executorBrainId);
  const preferred = usable.filter(id => brainFamily(brains[id], id) === want);
  if (preferred.length) return preferred;
  return usable.filter(id => brainFamily(brains[id], id) !== execFamily);
}
