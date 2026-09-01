/**
 * Result verification — catches the case a raw exit-code check misses: a brain's
 * CLI exits 0 (so the spawn *looks* successful) but the "result" is really a soft
 * failure — a rate-limit / quota notice, an overloaded / try-again message, an
 * auth error, or an empty answer. Left unchecked these masquerade as completed
 * tasks with no errors. The dispatcher runs this verdict on every finished attempt
 * and, on a bad one, hands the task to the NEXT brain in the fallback chain
 * (recording which brain failed on the task — see Dispatcher.execute).
 *
 * Two independent gates:
 *   1. this module — cheap, deterministic pattern/emptiness check (always on).
 *   2. an optional LLM "verifier agent" the dispatcher runs on top (config-gated)
 *      that judges whether the output actually satisfies the task.
 */

export interface VerifyVerdict {
  ok: boolean;
  /** Set when ok === false: why the result was rejected (logged + stored on the task). */
  reason?: string;
}

export interface VerifyOptions {
  /** Extra case-insensitive substrings that mark a bad result. */
  failPatterns?: string[];
  /** Replace the built-in patterns entirely instead of merging the extras in. */
  replacePatterns?: boolean;
  /** A result whose trimmed length is below this is treated as empty / non-deliverable. */
  minLength?: number;
}

/**
 * High-signal phrases a model or CLI emits when it *couldn't* do the work but
 * still exited cleanly. Deliberately phrase-level (not the bare token "rate
 * limit") so a legitimate long deliverable that merely discusses rate limiting
 * or 429 handling isn't flagged. Matched case-insensitively as substrings.
 */
export const DEFAULT_FAIL_PATTERNS: string[] = [
  // rate limits / usage caps
  'rate limit reached',
  'rate limit exceeded',
  'rate-limited',
  'hit the rate limit',
  'hit your rate limit',
  "you've hit your",
  'you have hit your',
  "you've reached your",
  'you have reached your',
  'usage limit reached',
  'reached your usage limit',
  'reached your daily limit',
  'reached your monthly limit',
  'too many requests',
  // quota / credits / billing
  'quota exceeded',
  'exceeded your quota',
  'insufficient quota',
  'insufficient_quota',
  'out of credits',
  'credit balance is too low',
  'please upgrade your plan',
  'upgrade to continue',
  // capacity / availability
  'resource exhausted',
  'resource_exhausted',
  'model is overloaded',
  'currently overloaded',
  'overloaded_error',
  // context-window / compression overflow — the CLI ran out of room and could not
  // produce the deliverable, yet still exited 0 (observed on run-99b3d715's
  // analyze-plan: "Context length exceeded: max compression attempts (3) reached").
  'context length exceeded',
  'context window exceeded',
  'maximum context length',
  'exceeds the maximum context',
  'max compression attempts',
  'maximum compression attempts',
  'reached max compression',
  // HTTP status shapes
  'error 429',
  '429 too many requests',
  'http 429',
  'status code 429',
  'status: 429',
  // auth (exit-0 CLIs sometimes print these to stdout)
  'authentication_error',
  'invalid api key',
  'invalid x-api-key',
  'your credit balance',
  // transport / genuine API errors an exit-0 CLI can still print as its "answer".
  // Kept to unambiguous transport shapes so a deliverable that merely *discusses*
  // errors (a doc about HTTP status codes) is not flagged.
  'econnreset',
  'etimedout',
  'esockettimedout',
  'socket hang up',
  'connection reset by peer',
  'upstream connect error',
  '503 service unavailable',
  '504 gateway timeout',
  'bad gateway',
  'internal_server_error',
  'api_error',
];

/**
 * Deterministic verdict on one attempt's output. `spawnOk` is the raw exit-code
 * result (false = the process itself failed/timed out — already a failure).
 * Returns ok:false with a short reason when the output is empty or matches a
 * known soft-failure phrase.
 */
export function verifyOutput(text: string, spawnOk: boolean, opts: VerifyOptions = {}): VerifyVerdict {
  if (!spawnOk) return { ok: false, reason: firstLine(text) || 'process exited non-zero' };

  const clean = (text || '').trim();
  const minLength = opts.minLength ?? 1;
  if (clean.length < minLength) {
    return { ok: false, reason: `empty result (${clean.length} < ${minLength} chars)` };
  }

  const patterns = opts.replacePatterns
    ? (opts.failPatterns ?? [])
    : [...DEFAULT_FAIL_PATTERNS, ...(opts.failPatterns ?? [])];
  const hay = clean.toLowerCase();
  for (const p of patterns) {
    const needle = p.toLowerCase();
    if (needle && hay.includes(needle)) {
      return { ok: false, reason: `matched failure pattern "${p}"` };
    }
  }
  return { ok: true };
}

/** First non-empty line, trimmed and capped — a compact reason for logs/context. */
function firstLine(text: string): string {
  const line = (text || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  return line.slice(0, 200);
}

/**
 * Build the prompt for the optional LLM "verifier agent". It reads the task and
 * the produced result and answers PASS / FAIL — a quality gate stacked on top of
 * the deterministic check for cases a pattern can't catch (e.g. a fluent but
 * off-topic or refusal answer). Parse the reply with {@link parseLlmVerdict}.
 */
export function buildVerifierPrompt(task: { title: string; description: string }, result: string): string {
  return [
    `You are a strict RESULT VERIFIER in a multi-agent company. Judge ONLY whether the RESULT below is a genuine, on-topic completion of the TASK.`,
    `FAIL it if the result is a rate-limit / quota / overloaded notice, an error or refusal, empty, truncated mid-thought, or does not actually address the task.`,
    `PASS it if it is a real, on-topic deliverable (even if imperfect).`,
    ``,
    `TASK: ${task.title}`,
    (task.description || '').slice(0, 2000),
    ``,
    `RESULT:`,
    (result || '').slice(0, 6000),
    ``,
    `Answer with exactly one word on the first line: PASS or FAIL. On a second line, give a short reason.`,
  ].join('\n');
}

/**
 * Turn a verifier LLM reply into a verdict. Conservative: only an explicit,
 * unambiguous FAIL rejects the result — a blank/garbled reply from the verifier
 * brain must not discard a real deliverable (fail-open), so anything that isn't a
 * clear FAIL passes.
 */
export function parseLlmVerdict(reply: string): VerifyVerdict {
  const text = (reply || '').trim();
  if (!text) return { ok: true };
  const upper = text.toUpperCase();
  const firstPass = upper.indexOf('PASS');
  const firstFail = upper.indexOf('FAIL');
  const isFail = firstFail !== -1 && (firstPass === -1 || firstFail < firstPass);
  if (isFail) return { ok: false, reason: `verifier LLM: ${firstLine(text)}` };
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────────────────────
 * INPUT-REQUEST detection — the third outcome a raw "done" status hides. A brain
 * can exit 0 with a genuine, on-topic result that is NOT a deliverable but a
 * QUESTION back to the user ("which environment should I target?"). Marking that
 * "done" loses the question and strands the requester. When detected the
 * dispatcher parks the task on `wait-input` (never scheduled/handed-off) and turns
 * the questions into an interaction packet the user answers.
 *
 * Precedence (enforced by the dispatcher): a hard/soft FAILURE is decided first
 * (a rate-limit notice is a failure, not a question). Only an otherwise-ok result
 * is inspected for input requests.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface InputRequest {
  needsInput: boolean;
  /** The question(s) posed to the user — become the wait-input interaction fields. */
  questions: string[];
  /** The sentinel/phrase that triggered detection (for logs). */
  matched?: string;
}

export interface InputOptions {
  /** Extra case-insensitive phrases that also mark a result as an input request. */
  patterns?: string[];
  /** Replace the built-in phrases entirely instead of merging the extras in. */
  replacePatterns?: boolean;
  /** Turn detection off (trust the deliverable as complete). */
  disabled?: boolean;
}

/**
 * A DEFINITIVE marker an agent is told (via the executor prompt) to emit when it
 * cannot finish without the user: a line beginning `NEEDS_INPUT:` (also accepts
 * WAIT_INPUT / AWAITING_INPUT and a "Questions for the user" heading). Everything
 * after the marker — the inline remainder plus following lines — is the question.
 */
const INPUT_SENTINEL =
  /^\s*(?:#{1,6}\s*)?\**\s*(NEEDS[_ -]?INPUT|WAIT[_ -]?INPUT|AWAITING[_ -]?INPUT|QUESTIONS?\s+FOR\s+(?:THE\s+)?USER)\**\s*:?\s*(.*)$/i;

/**
 * Blocking phrases that signal the agent is stuck asking the user (not a polite
 * "let me know if you want changes" sign-off — those are deliberately excluded so
 * a finished deliverable is not parked). Matched case-insensitively as substrings.
 */
export const DEFAULT_QUESTION_PATTERNS: string[] = [
  'i need clarification',
  'need clarification on',
  'i need more information',
  'i need more details',
  'i need additional information',
  'i need you to clarify',
  'cannot proceed without',
  "can't proceed without",
  'cannot complete this task without',
  "can't complete this task without",
  'unable to proceed without',
  'i cannot continue without',
  "i can't continue without",
  'blocked pending your',
  'need your decision',
  'need a decision from you',
  'please clarify',
  'could you clarify',
  'could you please clarify',
  'please confirm which',
  'please confirm whether',
  'please specify which',
  'which of these would you like',
  'which approach would you prefer',
  'which option would you prefer',
  'do you want me to proceed with',
  'should i proceed with',
  'would you like me to proceed',
  // "I've stopped; you pick the next step" — a question-only result offering a menu
  // of options and asking the user to choose. Common when the brief was ambiguous,
  // so the agent produced no deliverable and handed the decision back. These stranded
  // real tasks as `done` before being added (see f8ec5d00 / 54f9ee5b regressions).
  // Kept specific enough to skip a finished deliverable's polite sign-off
  // ("let me know if you want changes").
  'how would you like to proceed',
  'how would you like me to proceed',
  'how should i proceed',
  'what would you like to do next',
  'what would you like me to do',
  'what should i do next',
  'please let me know which',
  'please let me know the next step',
  'please let me know how you',
  "let me know how you'd like to proceed",
  'let me know how you would like to proceed',
];

const GENERIC_QUESTION = 'The agent needs more information to proceed. Please provide guidance.';

/**
 * Decide whether a finished, otherwise-ok result is really a QUESTION back to the
 * user. Returns needsInput + the extracted question(s). A sentinel line is
 * authoritative; failing that, a blocking phrase (see DEFAULT_QUESTION_PATTERNS)
 * flags it and the `?`-terminated lines are lifted out as the questions.
 */
export function detectInputRequest(text: string, opts: InputOptions = {}): InputRequest {
  const none: InputRequest = { needsInput: false, questions: [] };
  if (opts.disabled) return none;
  const raw = (text || '').trim();
  if (!raw) return none;
  const lines = raw.split('\n');

  // 1. Authoritative sentinel.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(INPUT_SENTINEL);
    if (!m) continue;
    const questions: string[] = [];
    const inline = (m[2] || '').trim();
    if (inline) questions.push(inline);
    for (let j = i + 1; j < lines.length; j++) {
      const q = cleanQuestionLine(lines[j]);
      if (q) questions.push(q);
    }
    return { needsInput: true, questions: capQuestions(questions), matched: m[1].toUpperCase() };
  }

  // 2. Heuristic: a blocking phrase means the run is a request-for-input.
  const patterns = opts.replacePatterns
    ? (opts.patterns ?? [])
    : [...DEFAULT_QUESTION_PATTERNS, ...(opts.patterns ?? [])];
  const hay = raw.toLowerCase();
  let matched: string | undefined;
  for (const p of patterns) {
    const needle = p.toLowerCase();
    if (needle && hay.includes(needle)) { matched = p; break; }
  }
  if (!matched) return none;

  // Extract the actual question(s): `?`-terminated lines, else the sentence that
  // contains the matched phrase, else a generic prompt.
  let questions = lines.map(cleanQuestionLine).filter((l): l is string => !!l && l.endsWith('?'));
  if (!questions.length) {
    const sentence = raw.split(/(?<=[.!?])\s+/).find(s => s.toLowerCase().includes(matched!.toLowerCase()));
    if (sentence) questions = [sentence.trim()];
  }
  return { needsInput: true, questions: capQuestions(questions), matched };
}

/** Strip list markers / heading hashes so a question line reads as plain text. */
function cleanQuestionLine(line: string): string {
  return (line || '').trim().replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, '').trim();
}

/* ────────────────────────────────────────────────────────────────────────────
 * BACKGROUND-WAIT detection — the fourth outcome a raw "done" status hides. An
 * agent can exit 0 having KICKED OFF long-running background work (a background
 * shell, a spawned sub-agent, a CI/deploy/render job) that has NOT finished yet.
 * Its stdout is not a deliverable and not a question — it's "I'm still waiting."
 * Marking that "done" closes the task session while the real work is still in
 * flight, throwing away whatever the background job eventually produces. When
 * detected the dispatcher DEFERS the task (re-arms it on `scheduled` a short
 * while out) instead of completing it, so a later run checks whether the
 * background work finished and only then delivers.
 *
 * Precedence (enforced by the dispatcher): a hard/soft FAILURE and a QUESTION
 * for the user are both decided FIRST — a rate-limit notice is a failure, and a
 * genuine "I need a human decision" must reach the user, not silently loop on a
 * timer. Only an otherwise-ok, non-question result is inspected for a wait.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BackgroundWait {
  waiting: boolean;
  /** The sentinel/phrase that triggered detection (for logs). */
  matched?: string;
  /** A short human-readable line describing what is being waited on (for the card). */
  note?: string;
}

export interface BackgroundOptions {
  /** Extra case-insensitive phrases that also mark a result as a background wait. */
  patterns?: string[];
  /** Replace the built-in phrases entirely instead of merging the extras in. */
  replacePatterns?: boolean;
  /** Turn detection off (trust the result as complete). */
  disabled?: boolean;
}

/**
 * A DEFINITIVE marker an agent is told (via the executor prompt) to emit when it
 * has launched long background work that has not finished: a line beginning
 * `WAITING_ON_BACKGROUND:` (also accepts BACKGROUND_WAIT / WAITING_FOR_BACKGROUND
 * / AWAITING_BACKGROUND). Everything after the marker on that line is kept as the
 * note describing what is being waited on.
 */
const BACKGROUND_SENTINEL =
  /^\s*(?:#{1,6}\s*)?\**\s*(WAITING[_ -]?ON[_ -]?BACKGROUND|WAITING[_ -]?FOR[_ -]?BACKGROUND|BACKGROUND[_ -]?WAIT|AWAITING[_ -]?BACKGROUND)\**\s*:?\s*(.*)$/i;

/**
 * Phrases that signal the agent is blocked waiting on long-running background
 * work it already started (not a finished deliverable that merely mentions a
 * background job). Deliberately phrase-level and "still running / not finished"
 * shaped so a completed report that describes background processing isn't
 * flagged. Matched case-insensitively as substrings.
 */
export const DEFAULT_BACKGROUND_WAIT_PATTERNS: string[] = [
  'waiting for the background task',
  'waiting for background task',
  'waiting for the background tasks',
  'waiting for background tasks',
  'waiting for the background job',
  'waiting for background job',
  'waiting for the background process',
  'waiting for background process',
  'waiting for the background agent',
  'waiting for background agent',
  'waiting on the background task',
  'waiting on background task',
  'waiting on the long-running',
  'waiting for the long-running',
  'still running in the background',
  'background task is still running',
  'background tasks are still running',
  'background job is still running',
  'background jobs are still running',
  'background process is still running',
  'background agent is still running',
  'background task has not finished',
  'background task has not completed',
  'background task is not finished',
  'background task is not yet complete',
  'background task is not yet finished',
  'background task is still in progress',
  'background job has not finished',
  'background work is still in progress',
  'background work has not finished',
];

/**
 * Decide whether a finished, otherwise-ok, non-question result is really an agent
 * DEFERRING because long background work it launched has not finished. Returns
 * waiting + a short note. A sentinel line is authoritative; failing that, a
 * "still running / not finished" phrase (see DEFAULT_BACKGROUND_WAIT_PATTERNS)
 * flags it and a nearby line is lifted out as the note.
 */
export function detectBackgroundWait(text: string, opts: BackgroundOptions = {}): BackgroundWait {
  const none: BackgroundWait = { waiting: false };
  if (opts.disabled) return none;
  const raw = (text || '').trim();
  if (!raw) return none;
  const lines = raw.split('\n');

  // 1. Authoritative sentinel.
  for (const line of lines) {
    const m = line.match(BACKGROUND_SENTINEL);
    if (!m) continue;
    const note = (m[2] || '').trim() || undefined;
    return { waiting: true, matched: m[1].toUpperCase().replace(/[_ -]+/g, '_'), note };
  }

  // 2. Heuristic: a "still running / not finished" phrase means the run deferred.
  const patterns = opts.replacePatterns
    ? (opts.patterns ?? [])
    : [...DEFAULT_BACKGROUND_WAIT_PATTERNS, ...(opts.patterns ?? [])];
  const hay = raw.toLowerCase();
  let matched: string | undefined;
  for (const p of patterns) {
    const needle = p.toLowerCase();
    if (needle && hay.includes(needle)) { matched = p; break; }
  }
  if (!matched) return none;

  // Note = the sentence containing the matched phrase, capped.
  const sentence = raw.split(/(?<=[.!?])\s+/).find(s => s.toLowerCase().includes(matched!.toLowerCase()));
  const note = (sentence || matched).trim().slice(0, 300);
  return { waiting: true, matched, note };
}

/** Dedupe, drop empties, cap count (8) and each length (500), or a generic fallback. */
function capQuestions(questions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of questions) {
    const clean = (q || '').trim().slice(0, 500);
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= 8) break;
  }
  return out.length ? out : [GENERIC_QUESTION];
}
