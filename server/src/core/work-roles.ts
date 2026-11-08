/**
 * Work roles: cowork's port of pstack `setup-pstack` (one model + reasoning
 * budget per role) onto the orchestrator's router.
 *
 * pstack maps a KIND of work (feature, bug-fix, judgment and prose, hardest
 * tasks, …) to a model at an effort level, under one `# budget` ceiling. Cowork
 * already has the two halves of that — `orchestration.tiers` (ordered agent
 * lists per kind of work) and `context.thinking` (the run's effort) — but the
 * router only picked a division + persona, so an unassigned task always ran on
 * the default chain at the default thinking level.
 *
 * With `orchestration.workRoles.enabled`, the router also names ONE work role
 * for the task. The role sets, only where the task did not set them itself:
 *   context.tier      → which agents try it first (core/tiers.ts)
 *   context.thinking  → the role's level, capped by the budget
 *   context.workRole  → provenance, shown on the card
 *
 * Budget labels match setup-pstack: small=medium, medium=high, large=xhigh,
 * unlimited=max. Unlike setup-pstack (which sets EVERY role to the budget
 * level) the budget is a CEILING here: a mechanical role stays `low` under
 * `large`, because cowork runs every task at the chosen level and a formatting
 * job does not need xhigh.
 */
import type { ThinkingLevel } from './thinking.js';
import { THINKING_LEVELS, normalizeThinking } from './thinking.js';
import type { TierName } from './tiers.js';
import { TIER_NAMES } from './tiers.js';

export interface WorkRole {
  tier: Exclude<TierName, 'review'>;
  thinking: ThinkingLevel;
  /** One line the router reads to pick the role. */
  description: string;
}

export const BUDGETS = { small: 'medium', medium: 'high', large: 'xhigh', unlimited: 'max' } as const;
export type Budget = keyof typeof BUDGETS;

export interface WorkRolesConfig {
  enabled: boolean;
  budget?: Budget;
  /** Overrides / additions, merged over DEFAULT_WORK_ROLES by role id. */
  roles?: Record<string, Partial<WorkRole>>;
}

/** Role ids are chosen not to collide with any division id, so one router reply
 *  can carry both (e.g. "engineering bug-fix"). Mirrors setup-pstack's roles:
 *  feature/refactoring, bug-fix, perf-issue, how/why (research), judgment and
 *  prose, hardest tasks; plus `mechanical`, cowork's cheap tier. */
export const DEFAULT_WORK_ROLES: Record<string, WorkRole> = {
  mechanical: { tier: 'mechanical', thinking: 'low', description: 'scripted or repetitive: run a script, format, move/rename files, fetch or convert data, post a prepared item' },
  feature: { tier: 'standard', thinking: 'high', description: 'build or change something: a feature, refactor, page, tool, script, config change' },
  'bug-fix': { tier: 'standard', thinking: 'high', description: 'something is broken, failing, erroring or wrong and must be diagnosed and fixed' },
  'perf-issue': { tier: 'standard', thinking: 'high', description: 'something is slow, heavy or costly and must be measured and improved' },
  research: { tier: 'standard', thinking: 'medium', description: 'find out how something works or why it happened; survey, compare, gather facts, summarise' },
  prose: { tier: 'judgment', thinking: 'high', description: 'judgment and writing: a plan, review, strategy, decision memo, article, copy, brief' },
  hardest: { tier: 'judgment', thinking: 'xhigh', description: 'hard, ambiguous or high-stakes: architecture, multi-system design, security, money, irreversible changes' },
};

/** Default role when neither the router nor the keyword guess names one. */
export const FALLBACK_WORK_ROLE = 'feature';

export function resolveWorkRoles(cfg?: WorkRolesConfig): Record<string, WorkRole> {
  const out: Record<string, WorkRole> = { ...DEFAULT_WORK_ROLES };
  for (const [id, r] of Object.entries(cfg?.roles || {})) {
    const base = out[id];
    const t = r?.tier as string | undefined;
    const tier = t && t !== 'review' && (TIER_NAMES as readonly string[]).includes(t) ? t as WorkRole['tier'] : base?.tier;
    const thinking = normalizeThinking(r?.thinking) || base?.thinking;
    if (!tier || !thinking) continue;   // an incomplete new role is ignored, not half-applied
    out[id] = { tier, thinking, description: r?.description || base?.description || id };
  }
  return out;
}

/** The role's level, capped by the budget (no budget → uncapped). */
export function capThinking(level: ThinkingLevel, budget?: Budget): ThinkingLevel {
  const cap = budget && BUDGETS[budget];
  if (!cap) return level;
  const i = THINKING_LEVELS.indexOf(level), c = THINKING_LEVELS.indexOf(cap);
  return THINKING_LEVELS[Math.min(i, c)];
}

/** Router prompt lines listing the roles. */
export function workRolesPromptBlock(roles: Record<string, WorkRole>): string {
  return Object.entries(roles).map(([id, r]) => `- ${id}: ${r.description}`).join('\n');
}

const KEYWORDS: Array<[string, RegExp]> = [
  ['bug-fix', /\b(bug|fix|broken|fails?|failing|error|crash|regression|500|404|doesn'?t work|not working)\b|修復|錯誤|壞/i],
  ['perf-issue', /\b(slow|latency|perf(ormance)?|optimi[sz]e|memory leak|cpu|oom|speed up)\b|效能|太慢/i],
  ['hardest', /\b(architecture|architect|redesign|security|migration|irreversible|threat model)\b|架構|資安/i],
  ['prose', /\b(plan|strategy|review|proposal|memo|article|blog|copy|write[- ]?up|decide|decision)\b|策略|計畫|文章|撰寫/i],
  ['research', /\b(research|survey|investigate|compare|analy[sz]e|summari[sz]e|find out|why|how does)\b|調查|研究|分析|比較/i],
  ['mechanical', /\b(rename|reformat|format|move files?|convert|upload|post|run (the )?script|daily|scheduled|cron)\b|上傳|轉檔/i],
  ['feature', /\b(build|implement|add|create|feature|refactor|page|tool|setup|set up|integrate)\b|新增|建立|實作/i],
];

/** Keyword guess when the router's reply names no role. First match wins, in
 *  the order above (a "fix the slow page" is a bug-fix before a perf-issue). */
export function guessWorkRole(text: string, roles: Record<string, WorkRole>): string {
  for (const [id, re] of KEYWORDS) if (roles[id] && re.test(text)) return id;
  return roles[FALLBACK_WORK_ROLE] ? FALLBACK_WORK_ROLE : Object.keys(roles)[0];
}

/**
 * The context fields a work role adds to a routed task. Never overrides what
 * the task set itself: an explicit context.tier / context.thinking wins, and a
 * pinned context.agent gets no tier (its chain is the pin).
 */
export function workRoleContext(
  roleId: string,
  roles: Record<string, WorkRole>,
  ctx: Record<string, any> | undefined,
  budget?: Budget
): Record<string, any> {
  const r = roles[roleId];
  if (!r) return {};
  const out: Record<string, any> = { workRole: roleId };
  if (!ctx?.tier && !ctx?.agent) out.tier = r.tier;
  if (!normalizeThinking(ctx?.thinking)) out.thinking = capThinking(r.thinking, budget);
  return out;
}
