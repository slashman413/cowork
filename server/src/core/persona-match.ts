import type { PersonaCard } from '../types.js';

/**
 * Deterministic persona picker — the orchestrator's fallback when the LLM router
 * is unavailable, silent, or names no valid division/slug. Scores every installed
 * persona against the task brief by weighted token overlap:
 *
 *   name / slug tokens ×3 · description + vibe tokens ×1 · exact multi-word
 *   name phrase in the brief +6
 *
 * and returns the best one only when it clears MIN_SCORE (a weak match is worse
 * than the generalist: the persona becomes the agent's system prompt).
 */

const STOP = new Set(('a an and are as at be by for from has have in into is it its of on or that the this to was were will with ' +
  'you your we our i me my task tasks please make build use using need want should can could would do does done get ' +
  'new add create update fix all any each more most some such than then them they their there these those via per ' +
  'not no yes also just like only very via over under about after before when where which who why how what ' +
  'expert specialist specializing specialized agent agents engineer developer manager strategist analyst').split(/\s+/));

export function tokens(text: string): string[] {
  return (String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) || [])
    .map(t => t.replace(/\.+$/, ''))
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** Tiny suffix stemmer — enough to match "tests"/"testing", "designs"/"designer". */
function stem(t: string): string {
  if (t.length > 5) {
    for (const suf of ['ization', 'ations', 'ation', 'ings', 'ing', 'ers', 'er', 'ies', 'es', 's']) {
      if (t.endsWith(suf) && t.length - suf.length >= 4) return suf === 'ies' ? t.slice(0, -3) + 'y' : t.slice(0, -suf.length);
    }
  } else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export const MIN_SCORE = 4;

export interface PersonaMatch { slug: string; division?: string; name: string; score: number }

export function scorePersona(briefTokens: Set<string>, briefText: string, p: PersonaCard): number {
  let score = 0;
  const strong = new Set([...tokens(p.name), ...tokens(p.slug.replace(/-/g, ' '))]);
  const weak = new Set([...tokens(p.description || ''), ...tokens(p.vibe || '')]);
  for (const t of strong) if (briefTokens.has(t)) score += 3;
  for (const t of weak) if (!strong.has(t) && briefTokens.has(t)) score += 1;
  const phrase = String(p.name || '').toLowerCase().trim();
  if (phrase.includes(' ') && briefText.includes(phrase)) score += 6;
  return score;
}

export function matchPersona(brief: string, personas: PersonaCard[], minScore = MIN_SCORE): PersonaMatch | null {
  if (!personas?.length) return null;
  const text = String(brief || '').toLowerCase();
  const bt = new Set(tokens(text));
  if (!bt.size) return null;
  let best: PersonaMatch | null = null;
  for (const p of personas) {
    const score = scorePersona(bt, text, p);
    if (score > (best?.score ?? 0)) best = { slug: p.slug, division: p.division, name: p.name, score };
  }
  return best && best.score >= minScore ? best : null;
}
