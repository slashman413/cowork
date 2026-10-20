/**
 * Lesson ledger (WF-1) — the cross-task memory layer.
 *
 * Every time a task teaches the network something (a verifier rejection, or a
 * brain parking on `wait-input`), the dispatcher appends ONE structured JSON
 * line here. This is pure event capture: deterministic, no LLM, no scheduler —
 * nothing in this module decides or applies anything. A recurrence detector
 * (WF-2) reads the ledger to draft *human-gated* proposals; the ledger itself
 * only remembers.
 *
 * Design: `self-improvement-and-env-sharing-design.md` §A1 +
 * `workflow-specs-self-improvement-env-sharing.md` §WF-1.
 *
 * Invariant — never break dispatch: a full/unwritable disk MUST NOT throw into
 * the task lifecycle. Capture is best-effort observability. All I/O here is
 * wrapped so a caller can treat it as fire-and-forget.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** One append-only record. Kept small (see caps in {@link buildLesson}) so a
 *  single line stays well under PIPE_BUF (4096B) and appendFileSync is atomic
 *  on the single-process server. */
export interface Lesson {
  at: string;                       // ISO-8601
  kind: 'verify-fail' | 'wait-input' | 'blocked' | 'brief-missing-acceptance' | 'quality-shadow' | 'sharpen-failed';  // blocked = agent's STATUS: BLOCKED (P0-2); brief-missing-acceptance = orchestrator subtask without acceptance (P0-3); quality-shadow = P1-1 shadow spec verdict; sharpen-failed = PS-1 sharpener failure
  task: string;                     // task id
  titleSlug: string;                // kebab of the title, first 6 words
  agent: string;                    // roster slug (best-effort)
  brain: string;                    // brain id
  brainFamily: string;              // brain id with the final -segment dropped
  attempt: number;
  reason: string;                   // truncated to 500 chars
  requiresGuess: string[];          // deterministic extract, ≤10 entries
  questions?: string[];             // for kind:"wait-input"
}

const REASON_CAP = 500;
const REQUIRES_CAP = 10;
const LEDGER_FILE = 'lessons.jsonl';

/**
 * Derive a brain "family" by stripping the trailing model segment so sibling
 * brains on the same host collapse together for recurrence counting:
 *   remote-ai-code-gen-cc-fable → remote-ai-code-gen-cc
 * A brain id with no `-` is returned unchanged. Deterministic.
 */
export function deriveBrainFamily(brainId: string): string {
  const id = (brainId || '').trim();
  const i = id.lastIndexOf('-');
  return i > 0 ? id.slice(0, i) : id;
}

/** Kebab-case the first 6 words of a title — a stable, greppable slug that
 *  groups a family of similarly-titled tasks (e.g. every "AI Workflow Builder
 *  git-init …" task) without keying on the exact wording. */
export function titleSlug(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
}

// Root dirs an absolute path can start with. Anchoring here (rather than "any
// token starting with /") avoids false positives like "and/or" or "TCP/IP".
const PATH_RE = /\/(?:home|root|opt|usr|var|etc|data|mnt|srv|tmp|Users)\/[A-Za-z0-9._/-]+/g;
// A path is only a *requirement* when it shows up in a "it's not here" context.
const MISSING_RE = /no such file|enoent|does not exist|not found|absent|permission denied|cannot access|is missing|\bmissing\b/i;

/**
 * Deterministic extraction of the environment facts a failure implies, as
 * `path:<abs> | tool:<name> | secret:<name>` tokens. Pure string work, no model
 * call. A miss returns `[]` — not an error (WF-2 falls back to titleSlug
 * matching). Order is stable: paths, then tools, then secrets.
 */
export function extractRequires(text: string): string[] {
  const t = text || '';
  const paths: string[] = [];
  const tools: string[] = [];
  const secrets: string[] = [];

  // Paths — only those appearing in a segment that also signals absence.
  for (const seg of t.split(/\n|(?<=[.!?])\s+/)) {
    if (!MISSING_RE.test(seg)) continue;
    for (const m of seg.matchAll(PATH_RE)) {
      const p = m[0].replace(/[.,;:)\]}'"]+$/, ''); // strip trailing punctuation
      if (p) paths.push(`path:${p}`);
    }
  }

  // Tools — "command not found: X" | "X: command not found" | "X: not found".
  const toolRe = /command not found:\s*([A-Za-z0-9._-]+)|\b([A-Za-z0-9._-]+):\s*(?:command\s+)?not found/gi;
  for (const m of t.matchAll(toolRe)) {
    const name = m[1] || m[2];
    if (name) tools.push(`tool:${name}`);
  }

  // Secrets — credential-store names (never values): ~/.priv/<name>,
  // "credentials for <svc>". Conservative on purpose (a bare "token" mention is
  // too noisy to key on).
  for (const m of t.matchAll(/~\/\.priv\/([A-Za-z0-9._-]+)/g)) secrets.push(`secret:${m[1]}`);
  for (const m of t.matchAll(/credentials?\s+for\s+([A-Za-z0-9._-]+)/gi)) secrets.push(`secret:${m[1]}`);

  const out: string[] = [];
  for (const v of [...paths, ...tools, ...secrets]) {
    if (!out.includes(v)) out.push(v);
    if (out.length >= REQUIRES_CAP) break;
  }
  return out;
}

/** Build a capped {@link Lesson} from raw dispatch state. `at` is injected so
 *  callers/tests can supply a fixed clock; defaults to now. */
export function buildLesson(input: {
  at?: string;
  kind: Lesson['kind'];
  task: string;
  title: string;
  agent: string;
  brain: string;
  attempt: number;
  reason?: string;
  resultText?: string;
  questions?: string[];
}): Lesson {
  const reason = (input.reason || '').slice(0, REASON_CAP);
  const requiresGuess = extractRequires(`${input.resultText || ''}\n${input.reason || ''}`);
  return {
    at: input.at || new Date().toISOString(),
    kind: input.kind,
    task: input.task,
    titleSlug: titleSlug(input.title),
    agent: input.agent || '',
    brain: input.brain || '',
    brainFamily: deriveBrainFamily(input.brain || ''),
    attempt: input.attempt,
    reason,
    requiresGuess,
    ...(input.questions && input.questions.length ? { questions: input.questions.slice(0, 8) } : {})
  };
}

/**
 * Append one lesson to `<decisionsDir>/lessons.jsonl`. Best-effort and
 * NEVER-THROW: on any filesystem error it returns false after logging, so the
 * caller's task lifecycle is unaffected. JSON.stringify escapes newlines, so a
 * multi-line reason still serialises to a single valid JSONL line.
 */
export function appendLesson(decisionsDir: string, lesson: Lesson): boolean {
  try {
    mkdirSync(decisionsDir, { recursive: true });
    appendFileSync(join(decisionsDir, LEDGER_FILE), JSON.stringify(lesson) + '\n');
    return true;
  } catch (e: any) {
    console.error(`[lessons] append failed: ${e?.message || e}`);
    return false;
  }
}
