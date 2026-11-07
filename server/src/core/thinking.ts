/**
 * Thinking level: how hard an agent reasons on a run. It is a parameter of the run,
 * never part of an agent id — `local-agy-gemini-3.8-flash` + thinking "high", not
 * `local-agy-gemini-3.8-flash-high`.
 *
 * Precedence: task `context.thinking` → the agent's `thinking` →
 * `orchestration.defaultThinking` → "medium".
 */
export const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export const DEFAULT_THINKING: ThinkingLevel = 'medium';

/** The levels that used to be baked into agent ids and agy model slugs. */
const ID_SUFFIX_RE = /-(low|medium|high)$/;

/** A valid level, or undefined for anything else (blank, unknown, non-string). */
export function normalizeThinking(v: unknown): ThinkingLevel | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (THINKING_LEVELS as readonly string[]).includes(s) ? s as ThinkingLevel : undefined;
}

/** `x-high` → { base: 'x', level: 'high' }; an id with no suffix is returned as-is. */
export function splitThinkingSuffix(id: string): { base: string; level?: ThinkingLevel } {
  const m = ID_SUFFIX_RE.exec(id);
  return m ? { base: id.slice(0, m.index), level: m[1] as ThinkingLevel } : { base: id };
}

/** agy has no separate effort for its catalog: the level is the last part of the slug,
 *  and a slug only comes in low/medium/high. A few models ship a single level. */
const AGY_SINGLE_LEVEL: Array<[RegExp, ThinkingLevel]> = [[/^gpt-oss-/, 'medium']];
export function agyModelSlug(model: string, thinking?: ThinkingLevel): string {
  if (!model) return model;
  const { base, level } = splitThinkingSuffix(model);
  const single = AGY_SINGLE_LEVEL.find(([re]) => re.test(base));
  if (single) return `${base}-${single[1]}`;
  const want = thinking || level || DEFAULT_THINKING;
  return `${base}-${want === 'xhigh' || want === 'max' ? 'high' : want}`;
}

/** Extra CLI flags for a level. agy is handled through its model slug (agyModelSlug);
 *  dsh, ollama and script have no reasoning control. Hermes fronts a local model whose
 *  own config decides reasoning, so it only gets a flag when a level was asked for. */
export function thinkingArgs(exec: string, thinking?: ThinkingLevel): string[] {
  const level = thinking || DEFAULT_THINKING;
  switch (exec) {
    case 'claude': return ['--effort', level];
    case 'codex': return ['-c', `model_reasoning_effort="${level === 'max' ? 'xhigh' : level}"`];
    case 'hermes': return thinking ? ['--reasoning', thinking === 'xhigh' || thinking === 'max' ? 'high' : thinking] : [];
    default: return [];
  }
}
