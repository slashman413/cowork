/**
 * `correct` loop over the lessons ledger (plan P2-2) — WF-2's proposal drafting.
 *
 * Groups `decisions/lessons.jsonl` events into failure CLASSES (same normalised
 * signature, ≥2 occurrences) and drafts, per class, a human-gated proposal whose
 * remedy menu is ordered STRUCTURE FIRST:
 *
 *   router rule → brain cooldown → brain `env` requires-filter → verifier
 *   failPattern → workflow gate → acceptance criterion → CONVENTIONS.md note (last)
 *
 * A structural remedy is offered only when its check, replayed against the
 * class's own past events, would have caught ≥2 of them — those events are cited
 * as the proof. The prose note is always offered last and is the only option
 * when no structural check catches ≥2 events (flagged `unenforced`).
 *
 * Pure: takes already-loaded lessons, never writes and never applies anything.
 * Served as GET /api/lessons/classes?days=30; read by the monthly correct-loop task.
 */
import type { Lesson } from './lessons.js';
import { classifyRejection, classifyWaitInput, REPEAT_WINDOW_MS } from './quality-metrics.js';

export type RemedyId =
  | 'router-rule' | 'brain-cooldown' | 'env-requires' | 'verifier-pattern'
  | 'workflow-gate' | 'acceptance-criterion' | 'conventions-note';

/** The remedy menu, highest level (most mechanical) first. Order is the contract. */
export const REMEDY_ORDER: readonly RemedyId[] = [
  'router-rule', 'brain-cooldown', 'env-requires', 'verifier-pattern',
  'workflow-gate', 'acceptance-criterion', 'conventions-note',
] as const;

/** Where each remedy is applied (all human-gated; this module never writes). */
export const REMEDY_LEVER: Record<RemedyId, string> = {
  'router-rule': '~/.cowork/config.json orchestration.agentChains / divisionChains (drop or demote the brain family for this class)',
  'brain-cooldown': 'Store brain cooldown (Store.noteBrainRateLimited / brainCooldownUntil, decided from CLI signals) + ~/.cowork/config.json orchestration.autoRerunRateLimited',
  'env-requires': 'brain `env` manifest + task `requires` filter (WF-3; the router-side filter is not wired yet)',
  'verifier-pattern': '~/.cowork/config.json orchestration.verifier.failPatterns',
  'workflow-gate': 'workflows/*.json step `gate` (P1-2 review→fix gate)',
  'acceptance-criterion': 'task / workflow-step `acceptance` + `scope` (P0-3 brief contract)',
  'conventions-note': 'CONVENTIONS.md prose (prompt-injected; must go through eval-prompt-change, P2-1) — unenforced',
};

export const MIN_CLASS_SIZE = 2;
export const MIN_CITED = 2;

export interface CitedEvent { task: string; at: string; brain: string; kind: Lesson['kind']; reason: string; }

export interface LessonClass {
  signature: string;
  kind: Lesson['kind'];
  count: number;
  first: string;
  last: string;
  brainFamilies: Record<string, number>;
  events: Lesson[];
}

export interface RemedyOption {
  id: RemedyId;
  rank: number;              // 1 = highest level
  lever: string;
  check: string;             // the concrete check proposed, human-readable
  caught: CitedEvent[];      // past events the check would have caught (≥2, except conventions-note)
}

export interface Proposal {
  signature: string;
  kind: Lesson['kind'];
  count: number;
  first: string;
  last: string;
  recommended: RemedyId;
  unenforced: boolean;       // true when only the prose note is on the menu
  remedies: RemedyOption[];  // in REMEDY_ORDER
  evidence: CitedEvent[];    // ≥2 past events cited for the recommended remedy
}

const NORM_WORDS = 7;

/** Collapse ids, numbers, times and "resets …" tails so recurring failures match. */
export function normalizeReason(s: string): string {
  return (s || '')
    .toLowerCase()
    .split(/\s·\s|\bresets\b|\(asia\//)[0]
    .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d+/g, 'n')
    .replace(/[^a-z<>\s'"-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, NORM_WORDS)
    .join(' ');
}

/** Class key for one lesson: kind + normalised reason (or first question). */
export function lessonSignature(l: Lesson): string {
  let text = l.reason || '';
  if (!text.trim() && l.kind === 'wait-input') text = (l.questions && l.questions[0]) || '';
  const norm = normalizeReason(text);
  return `${l.kind}:${norm || (l.titleSlug || '').split('-').slice(0, 3).join('-') || '?'}`;
}

/** Group lessons into classes (≥ minCount occurrences), largest first. */
export function groupLessons(lessons: Lesson[], minCount = MIN_CLASS_SIZE): LessonClass[] {
  const by = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const sig = lessonSignature(l);
    const list = by.get(sig);
    if (list) list.push(l); else by.set(sig, [l]);
  }
  const out: LessonClass[] = [];
  for (const [signature, events] of by) {
    if (events.length < minCount) continue;
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const brainFamilies: Record<string, number> = {};
    for (const e of events) brainFamilies[e.brainFamily || '?'] = (brainFamilies[e.brainFamily || '?'] || 0) + 1;
    out.push({ signature, kind: events[0].kind, count: events.length, first: events[0].at, last: events[events.length - 1].at, brainFamilies, events });
  }
  return out.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

const cite = (l: Lesson): CitedEvent => ({ task: l.task, at: l.at, brain: l.brain, kind: l.kind, reason: (l.reason || (l.questions || [])[0] || '').slice(0, 160) });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** First ≤4 plain words (no digits / ids) of a raw reason, or '' when too short. */
export function literalPhrase(reason: string): string {
  const words = reason.toLowerCase().replace(/^(verifier llm|spec verifier)\s*:\s*/, '')
    .split(/\s+/).map(w => w.replace(/^[^a-z]+|[^a-z]+$/g, ''))
    .filter(w => w && /^[a-z][a-z'-]*$/.test(w)).slice(0, 4);
  const p = words.join(' ');
  return p.length >= 6 ? p : '';
}

/** Dominant brain family of a class when the failure concentrates on it (≥60%). */
function dominantFamily(c: LessonClass): string | null {
  const [fam, n] = Object.entries(c.brainFamilies).sort((a, b) => b[1] - a[1])[0] || [];
  if (!fam || fam === '?') return null;
  return n / c.count >= 0.6 ? fam : null;
}

/** Most common requiresGuess token shared by ≥2 events, if any. */
function sharedRequire(c: LessonClass): string | null {
  const n = new Map<string, number>();
  for (const e of c.events) for (const r of new Set(e.requiresGuess || [])) n.set(r, (n.get(r) || 0) + 1);
  const best = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= MIN_CITED ? best[0] : null;
}

/**
 * Replay each structural check over the class's past events. Returns the
 * options that would have caught ≥2 events, in {@link REMEDY_ORDER}, then the
 * prose note last.
 */
export function remedyMenu(c: LessonClass): RemedyOption[] {
  const opts: RemedyOption[] = [];
  const add = (id: RemedyId, check: string, caught: Lesson[]) => {
    if (caught.length >= MIN_CITED) opts.push({ id, rank: 0, lever: REMEDY_LEVER[id], check, caught: caught.map(cite) });
  };
  const sample = c.events.find(e => e.reason) || c.events[0];
  const isRateLimit = (e: Lesson) => e.kind === 'verify-fail' && classifyRejection(e.reason) === 'rateLimit';

  // 1. router rule — the failure concentrates on one brain family: route this
  //    class's work away from it. Would have caught every event on that family.
  //    Not for rate limits (transient → cooldown) or wait-inputs (the agent asked,
  //    the brain did not fail).
  const fam = dominantFamily(c);
  if (fam && c.kind !== 'wait-input' && !c.events.every(isRateLimit)) {
    add('router-rule', `stop routing "${c.signature}" work to brain family ${fam}-* (demote it in the matching agent/division chain)`,
      c.events.filter(e => e.brainFamily === fam));
  }

  // 2. brain cooldown — a rate-limit class: a second hit on the same brain within
  //    the breaker window would not have been dispatched at all.
  if (c.events.some(isRateLimit)) {
    const lastHit = new Map<string, number>();
    const repeats: Lesson[] = [];
    for (const e of c.events) {
      if (!isRateLimit(e)) continue;
      const t = Date.parse(e.at);
      const prev = lastHit.get(e.brain);
      if (prev !== undefined && t - prev <= REPEAT_WINDOW_MS) repeats.push(e);
      lastHit.set(e.brain, t);
    }
    add('brain-cooldown', `cool the brain down for ≥${REPEAT_WINDOW_MS / 60_000} min after a "${normalizeReason(sample.reason)}" notice (Store rate-limit cooldown; extend isRateLimitFailure / verifier.failPatterns if this text is not matched)`, repeats);
  }

  // 3. env requires-filter — events share a missing path/tool/secret.
  const req = sharedRequire(c);
  if (req) add('env-requires', `require \`${req}\` and only route to brains whose env manifest has it`, c.events.filter(e => (e.requiresGuess || []).includes(req)));

  // 4. verifier failPattern — only for failures a deterministic check did NOT
  //    catch (LLM/spec judge, shadow verdict, BLOCKED): a cheap literal pattern
  //    would have rejected them first. A verify-fail that is already a rate
  //    limit / timeout / exit code / failPattern match is enforced already.
  const lateCaught = (e: Lesson) => e.kind === 'quality-shadow' || e.kind === 'blocked'
    || (e.kind === 'verify-fail' && classifyRejection(e.reason) === 'quality');
  const phrase = literalPhrase(sample.reason || '');
  if (phrase) {
    const re = new RegExp(phrase.split(' ').map(escapeRe).join('\\W+'), 'i');
    add('verifier-pattern', `add failPattern /${re.source}/i (validate against the cited tasks' result.md before enabling)`,
      c.events.filter(e => lateCaught(e) && re.test(e.reason || '')));
  }

  // 5. workflow gate — quality-type failures a review→fix gate catches before ship.
  add('workflow-gate', 'add a review→fix `gate` on the workflow step that produces this output',
    c.events.filter(e => e.kind === 'quality-shadow' || (e.kind === 'verify-fail' && classifyRejection(e.reason) === 'quality')));

  // 6. acceptance criterion — missing acceptance, or a permission/choice question
  //    a brief with acceptance + scope would have answered up front.
  add('acceptance-criterion', 'state the decision in the brief\'s `acceptance` / `scope` so the agent never has to ask',
    c.events.filter(e => e.kind === 'brief-missing-acceptance' || (e.kind === 'wait-input' && classifyWaitInput(e.questions, e.reason) === 'permissionChoice')));

  // 7. prose note — always last; catches nothing mechanically.
  opts.push({ id: 'conventions-note', rank: 0, lever: REMEDY_LEVER['conventions-note'], check: 'add a sentence to CONVENTIONS.md (no mechanical check)', caught: c.events.slice(-MIN_CITED).map(cite) });

  opts.sort((a, b) => REMEDY_ORDER.indexOf(a.id) - REMEDY_ORDER.indexOf(b.id));
  opts.forEach((o, i) => { o.rank = i + 1; });
  return opts;
}

/** Draft the proposal for one class: recommend the highest-level remedy. */
export function draftProposal(c: LessonClass): Proposal {
  const remedies = remedyMenu(c);
  const top = remedies[0];
  return {
    signature: c.signature, kind: c.kind, count: c.count, first: c.first, last: c.last,
    recommended: top.id,
    unenforced: top.id === 'conventions-note',
    remedies,
    evidence: top.caught.slice(-Math.max(MIN_CITED, 3)),
  };
}

/** Every class in the window → its proposal. */
export function correctLoop(lessons: Lesson[], from: number, to: number, minCount = MIN_CLASS_SIZE) {
  const inWin = lessons.filter(l => { const t = Date.parse(l.at); return t >= from && t <= to; });
  const classes = groupLessons(inWin, minCount);
  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    lessons: inWin.length,
    classes: classes.length,
    unenforced: classes.filter(c => remedyMenu(c)[0].id === 'conventions-note').length,
    proposals: classes.map(draftProposal),
  };
}

/** Options for a WF-2 `select` interaction field, in menu order. */
export function remedySelectOptions(p: Proposal): string[] {
  return [...p.remedies.map(r => `${r.id}: ${r.check}`), 'dismiss'];
}
