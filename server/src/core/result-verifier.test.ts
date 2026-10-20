import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyOutput, parseLlmVerdict, buildVerifierPrompt, DEFAULT_FAIL_PATTERNS,
  detectInputRequest, DEFAULT_QUESTION_PATTERNS, detectBackgroundWait, DEFAULT_BACKGROUND_WAIT_PATTERNS,
  parseStatusFooter, truncateHeadTail, extractEvidenceBlock, parseSpecVerdict,
  selectSpecJudge, selectSpecJudges, isSmallSpecTask, DEFAULT_SPEC_JUDGES,
} from './result-verifier.js';

/**
 * The result verifier is the fix for "a rate-limit reply looked like a done
 * task": a brain that exits 0 but returned a soft failure must be REJECTED so the
 * dispatcher hands the task to the next fallback brain. These tests pin the
 * deterministic verdict and the LLM-reply parser.
 */

test('a genuine long deliverable passes', () => {
  const v = verifyOutput('# Report\n\nHere is a thorough answer to the task, complete with sections and detail.', true);
  assert.equal(v.ok, true);
});

test('rate-limit reply that exited 0 is rejected', () => {
  const v = verifyOutput('I\'m sorry, the rate limit reached for this model. Please try again later.', true);
  assert.equal(v.ok, false);
  assert.match(v.reason || '', /failure pattern/i);
});

test('claude-style usage limit notice is rejected', () => {
  const v = verifyOutput("You've reached your usage limit. Upgrade to continue.", true);
  assert.equal(v.ok, false);
});

test('HTTP 429 body is rejected', () => {
  assert.equal(verifyOutput('Error 429 Too Many Requests', true).ok, false);
});

test('overloaded / capacity notice is rejected', () => {
  assert.equal(verifyOutput('{"type":"overloaded_error","message":"the model is overloaded"}', true).ok, false);
});

test('quota / credits exhaustion is rejected', () => {
  assert.equal(verifyOutput('Your credit balance is too low to run this request.', true).ok, false);
  assert.equal(verifyOutput('quota exceeded for this key', true).ok, false);
});

test('context-length / compression overflow that exited 0 is rejected', () => {
  // The exact soft-failure run-99b3d715's analyze-plan step returned yet was
  // accepted as a real deliverable, silently corrupting the whole workflow.
  const v = verifyOutput('Context length exceeded: max compression attempts (3) reached.', true);
  assert.equal(v.ok, false);
  assert.match(v.reason || '', /failure pattern/i);
  assert.equal(verifyOutput('The maximum context length is 200000 tokens; this request exceeds it.', true).ok, false);
});

test('empty output is rejected even when the process exited 0', () => {
  const v = verifyOutput('   \n  ', true);
  assert.equal(v.ok, false);
  assert.match(v.reason || '', /empty/i);
});

test('minLength gate rejects a too-short answer', () => {
  assert.equal(verifyOutput('ok', true, { minLength: 50 }).ok, false);
});

test('a non-zero exit is a failure regardless of text', () => {
  const v = verifyOutput('partial work here', false);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'partial work here');
});

test('does NOT flag a legitimate article that merely discusses rate limiting', () => {
  const article = 'When designing an API you should implement throttling. '.repeat(40) +
    'Consider how clients handle a 429 response and back off gracefully. ' +
    'This section explains rate limiting concepts in depth for engineers.';
  // Phrase-level patterns ("rate limit reached", not bare "rate limit") avoid this false positive.
  assert.equal(verifyOutput(article, true).ok, true);
});

test('does NOT reject a long deliverable that reports on rate-limited tasks (5edef1d8)', () => {
  // A fix report for "auto re-run of rate-limited tasks" was rejected twice as a
  // rate limit — real committed work thrown away and re-queued.
  const report = '## Fix: auto re-run of rate-limited tasks\n\n' +
    'The dispatcher now re-queues rate-limited failures once the window resets. '.repeat(25) +
    "\nVerified: a task that hit \"You've hit your session limit\" is re-run after reset.";
  assert.ok(report.length > 1500);
  assert.equal(verifyOutput(report, true).ok, true);
});

test('a short rate-limit notice is still rejected; the scan length is configurable', () => {
  assert.equal(verifyOutput('Request was rate-limited, try again later.', true).ok, false);
  const long = 'x'.repeat(300) + ' rate-limited';
  assert.equal(verifyOutput(long, true).ok, false);
  assert.equal(verifyOutput(long, true, { maxPatternScanLength: 100 }).ok, true);
});

test('custom failPatterns merge with the built-ins', () => {
  assert.equal(verifyOutput('SPECIAL_SENTINEL_ERROR occurred', true, { failPatterns: ['special_sentinel_error'] }).ok, false);
  // built-ins still apply when merging
  assert.equal(verifyOutput('rate limit reached', true, { failPatterns: ['x'] }).ok, false);
});

test('replacePatterns swaps out the built-ins entirely', () => {
  // With replace, the built-in "rate limit reached" no longer trips it.
  assert.equal(verifyOutput('rate limit reached', true, { failPatterns: ['only-this'], replacePatterns: true }).ok, true);
  assert.equal(verifyOutput('only-this', true, { failPatterns: ['only-this'], replacePatterns: true }).ok, false);
});

test('DEFAULT_FAIL_PATTERNS is non-empty and lowercase-safe', () => {
  assert.ok(DEFAULT_FAIL_PATTERNS.length > 0);
  // matching is case-insensitive
  assert.equal(verifyOutput('RATE LIMIT REACHED', true).ok, false);
});

test('parseLlmVerdict: explicit FAIL rejects', () => {
  const v = parseLlmVerdict('FAIL\nThe result is just a rate-limit apology, not the deliverable.');
  assert.equal(v.ok, false);
  assert.match(v.reason || '', /verifier LLM/);
});

test('parseLlmVerdict: PASS accepts', () => {
  assert.equal(parseLlmVerdict('PASS\nlooks complete').ok, true);
});

test('parseLlmVerdict: fails open on a blank/garbled verifier reply', () => {
  assert.equal(parseLlmVerdict('').ok, true);
  assert.equal(parseLlmVerdict('   \n ').ok, true);
});

test('parseLlmVerdict: earliest of PASS/FAIL wins', () => {
  // "PASS" appears before "FAIL" -> pass; guards against a trailing "do not FAIL" note.
  assert.equal(parseLlmVerdict('PASS — this is fine, do not FAIL it').ok, true);
  assert.equal(parseLlmVerdict('FAIL — this is not a PASS').ok, false);
});

test('buildVerifierPrompt includes task + result and asks for PASS/FAIL', () => {
  const p = buildVerifierPrompt({ title: 'Write X', description: 'details' }, 'the deliverable');
  assert.match(p, /Write X/);
  assert.match(p, /the deliverable/);
  assert.match(p, /PASS\|FAIL\|UNVERIFIABLE/);
});

/* ── input-request detection (wait-input) ──────────────────────────────────── */

test('genuine transport error is flagged as a failure, not passed as done', () => {
  assert.equal(verifyOutput('Error: read ECONNRESET', true).ok, false);
  assert.equal(verifyOutput('upstream connect error or disconnect/reset before headers', true).ok, false);
  assert.equal(verifyOutput('503 Service Unavailable', true).ok, false);
});

test('NEEDS_INPUT sentinel makes it a request-for-input with the question captured', () => {
  const r = detectInputRequest('I made progress but must pause.\nNEEDS_INPUT: Which environment should I deploy to — staging or production?');
  assert.equal(r.needsInput, true);
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0], /staging or production/);
});

test('sentinel with question(s) on following lines collects each', () => {
  const r = detectInputRequest('NEEDS_INPUT:\n- What is the target repo?\n- Which branch should I push to?');
  assert.equal(r.needsInput, true);
  assert.deepEqual(r.questions, ['What is the target repo?', 'Which branch should I push to?']);
});

test('blocking phrase without a sentinel is detected and the ?-line lifted out', () => {
  const r = detectInputRequest('I cannot proceed without the API key.\nCould you provide the production API key?');
  assert.equal(r.needsInput, true);
  assert.ok(r.questions.some(q => /production API key/.test(q)));
});

test('a finished deliverable that merely signs off is NOT parked', () => {
  const r = detectInputRequest('# Report\n\nHere is the complete analysis with recommendations.\n\nLet me know if you want any changes!');
  assert.equal(r.needsInput, false);
});

test('a deliverable containing rhetorical questions is NOT parked', () => {
  const r = detectInputRequest('## FAQ\n\nWhat is caching? It is a technique to store results. Why use it? For speed.');
  assert.equal(r.needsInput, false);
});

test('a "how would you like to proceed" next-step menu is parked (real done-task regression)', () => {
  // Reproduces a task that was wrongly marked done: a question-only result with no
  // deliverable, offering the user a menu of next steps. See f8ec5d00.
  const r = detectInputRequest(
    'It looks like the AI Workflow Builder repo is already set up and all tests are passing. How would you like to proceed?\n\n' +
    '- Do you want to add a new feature or component?\n' +
    '- Would you like to adjust the design, UI, or API?\n' +
    '- Or do you need help deploying, documenting, or publishing the project?\n\n' +
    "Please let me know the next step you'd like to take.");
  assert.equal(r.needsInput, true);
  assert.ok(r.questions.some(q => /how would you like to proceed/i.test(q)));
});

test('a "what would you like to do next" prompt-menu is parked (real done-task regression)', () => {
  // Reproduces a second wrongly-done task: batch produced, then the agent asks the
  // user to choose what to do next. See 54f9ee5b.
  const r = detectInputRequest(
    'It looks like you have a batch of 239 Agent Cat image prompts stored in artifacts/x/prompts.json.\n\n' +
    'What would you like to do next with these prompts?\n\n' +
    '- (Recommended) Generate the images now via your ComfyUI + Flux pipeline.\n' +
    '- Review or edit the prompt list before generation.\n' +
    '- Export the prompts to another format.\n\n' +
    "Please let me know which action you'd like to take, or provide any additional details.");
  assert.equal(r.needsInput, true);
  assert.ok(r.questions.some(q => /what would you like to do next/i.test(q)));
});

test('a finished deliverable that offers a polite follow-up is NOT parked', () => {
  // Guard the new next-step patterns against a real deliverable that merely signs
  // off with an open offer — no menu, no "how would you like to proceed".
  const r = detectInputRequest(
    '# Migration Report\n\nAll 12 tables migrated successfully and verified.\n\n' +
    'Let me know if you want a rollback script as well.');
  assert.equal(r.needsInput, false);
});

test('detection can be disabled', () => {
  const r = detectInputRequest('NEEDS_INPUT: which one?', { disabled: true });
  assert.equal(r.needsInput, false);
});

test('empty extraction falls back to a generic question', () => {
  const r = detectInputRequest('NEEDS_INPUT:');
  assert.equal(r.needsInput, true);
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0], /needs more information/i);
});

test('custom inputPatterns merge with the built-ins', () => {
  assert.equal(detectInputRequest('PLEASE ADVISE on the schema', { patterns: ['please advise'] }).needsInput, true);
  // built-ins still apply when merging extras
  assert.equal(detectInputRequest('I need clarification on the scope', { patterns: ['x'] }).needsInput, true);
});

test('DEFAULT_QUESTION_PATTERNS is non-empty and matched case-insensitively', () => {
  assert.ok(DEFAULT_QUESTION_PATTERNS.length > 0);
  assert.equal(detectInputRequest('I NEED CLARIFICATION on the requirements').needsInput, true);
});

test('questions are capped at 8', () => {
  const many = 'NEEDS_INPUT:\n' + Array.from({ length: 15 }, (_, i) => `- Question ${i}?`).join('\n');
  assert.equal(detectInputRequest(many).questions.length, 8);
});

/**
 * Background-wait detection: an agent that KICKED OFF long background work which
 * hasn't finished must DEFER, not be marked done. These pin the sentinel, the
 * phrase heuristic, and that finished deliverables which merely mention
 * background jobs are NOT flagged.
 */
test('WAITING_ON_BACKGROUND sentinel is detected with its note', () => {
  const r = detectBackgroundWait('Started the render.\nWAITING_ON_BACKGROUND: the 4K render job is still encoding (job 7f3a).');
  assert.equal(r.waiting, true);
  assert.match(r.matched || '', /WAITING_ON_BACKGROUND/);
  assert.match(r.note || '', /render job/);
});

test('sentinel variants are accepted', () => {
  assert.equal(detectBackgroundWait('BACKGROUND_WAIT: still building').waiting, true);
  assert.equal(detectBackgroundWait('AWAITING_BACKGROUND: deploy in flight').waiting, true);
  assert.equal(detectBackgroundWait('WAITING_FOR_BACKGROUND: CI running').waiting, true);
});

test('a "still running in the background" phrase flags a wait', () => {
  const r = detectBackgroundWait('I launched the data export; the background task is still running. I will check back.');
  assert.equal(r.waiting, true);
  assert.match(r.note || '', /still running/i);
});

test('a finished deliverable that merely mentions background jobs is NOT flagged', () => {
  const r = detectBackgroundWait('# Report\n\nThis system offloads heavy work to a background job queue for speed. Done.');
  assert.equal(r.waiting, false);
});

test('a polite finished sign-off is NOT flagged as a background wait', () => {
  assert.equal(detectBackgroundWait('Here is the complete analysis. Let me know if you want changes!').waiting, false);
});

test('background-wait detection can be disabled', () => {
  assert.equal(detectBackgroundWait('WAITING_ON_BACKGROUND: x', { disabled: true }).waiting, false);
});

test('custom backgroundPatterns merge with the built-ins', () => {
  assert.equal(detectBackgroundWait('the transcode is still cooking', { patterns: ['still cooking'] }).waiting, true);
  // built-ins still apply when merging extras
  assert.equal(detectBackgroundWait('the background job is still running', { patterns: ['x'] }).waiting, true);
});

test('DEFAULT_BACKGROUND_WAIT_PATTERNS is non-empty and matched case-insensitively', () => {
  assert.ok(DEFAULT_BACKGROUND_WAIT_PATTERNS.length > 0);
  assert.equal(detectBackgroundWait('THE BACKGROUND TASK IS STILL RUNNING').waiting, true);
});

// ── STATUS / EVIDENCE footer + RULING lines (P0-2 / P0-4) ──────────────────────

test('parseStatusFooter: DONE with evidence', () => {
  const f = parseStatusFooter('work\nSTATUS: DONE\nEVIDENCE:\n- npm test → 12 passed');
  assert.equal(f.status, 'DONE');
  assert.equal(f.hasEvidence, true);
  assert.equal(f.reason, undefined);
  assert.equal(f.concerns, undefined);
});

test('parseStatusFooter: DONE_WITH_CONCERNS carries the CONCERNS block', () => {
  const f = parseStatusFooter('**STATUS:** DONE_WITH_CONCERNS\n**EVIDENCE:**\n- x → y\nCONCERNS: flaky test\n  retried twice');
  assert.equal(f.status, 'DONE_WITH_CONCERNS');
  assert.equal(f.concerns, 'flaky test\nretried twice');
  assert.equal(f.hasEvidence, true);
});

test('parseStatusFooter: BLOCKED reason — inline, else CONCERNS, else first line', () => {
  assert.equal(parseStatusFooter('STATUS: BLOCKED — no token').reason, 'no token');
  assert.equal(parseStatusFooter('STATUS: BLOCKED\nCONCERNS: repo is archived').reason, 'repo is archived');
  assert.equal(parseStatusFooter('Upload failed: 401\nSTATUS: BLOCKED').reason, 'Upload failed: 401');
});

test('parseStatusFooter: the LAST status line wins; an echoed template line is ignored', () => {
  assert.equal(parseStatusFooter('STATUS: BLOCKED — early\n…retried…\nSTATUS: DONE').status, 'DONE');
  assert.equal(parseStatusFooter('Rules say: STATUS: DONE | DONE_WITH_CONCERNS | BLOCKED').status, undefined);
  assert.equal(parseStatusFooter('STATUS: DONE | DONE_WITH_CONCERNS | BLOCKED\nSTATUS: DONE').status, 'DONE');
});

test('parseStatusFooter: no footer → no status, hasEvidence false; empty EVIDENCE is not evidence', () => {
  const f = parseStatusFooter('Just a plain report.');
  assert.equal(f.status, undefined);
  assert.equal(f.hasEvidence, false);
  assert.equal(parseStatusFooter('STATUS: DONE\nEVIDENCE:\n').hasEvidence, false);
});

test('parseStatusFooter: collects RULING lines (bulleted / bold), deduped', () => {
  const f = parseStatusFooter([
    'RULING: chose A — cheaper — redo in B',
    '- **RULING:** skip the backfill — no readers — one rerun',
    'RULING: chose A — cheaper — redo in B',
  ].join('\n'));
  assert.deepEqual(f.rulings, ['chose A — cheaper — redo in B', 'skip the backfill — no readers — one rerun']);
});

// ── P1-1: spec-compliance verifier prompt, parser, and cross-family judge selection ──

test('buildVerifierPrompt (spec mode): includes acceptance criteria, artifacts with byte sizes, EVIDENCE, head+tail result, and never says "PASS even if imperfect"', () => {
  const longBody = 'HEAD_MARKER '.repeat(500) + 'MIDDLE_NOISE '.repeat(500) + 'TAIL_MARKER '.repeat(500);
  const result = `${longBody}\nSTATUS: DONE\nEVIDENCE:\n- npm test → 42 passed\n- artifacts/report.md → 1280 bytes`;
  const prompt = buildVerifierPrompt(
    { title: 'Ship P1-1', description: 'Build spec verifier' },
    result,
    {
      acceptance: ['npm test passes', 'report.md is created and non-empty'],
      artifacts: [{ name: 'report.md', size: 1280 }, { name: 'empty.txt', size: 0 }],
    },
  );
  assert.doesNotMatch(prompt, /PASS even if imperfect/i);
  assert.match(prompt, /1\. npm test passes/);
  assert.match(prompt, /2\. report\.md is created and non-empty/);
  assert.match(prompt, /- report\.md \(1280 bytes\)/);
  assert.match(prompt, /- empty\.txt \(0 bytes\)/);
  assert.match(prompt, /npm test → 42 passed/);
  assert.match(prompt, /HEAD_MARKER/);
  assert.match(prompt, /TAIL_MARKER/);
  assert.match(prompt, /truncated \d+ chars/);
  assert.match(prompt, /VERDICT:\s*APPROVED/);
  assert.match(prompt, /VERDICT:\s*CHANGES_REQUESTED/);
});

test('extractEvidenceBlock extracts EVIDENCE lines until CONCERNS / STATUS / next heading', () => {
  const text = [
    'Summary here',
    'STATUS: DONE_WITH_CONCERNS',
    'EVIDENCE:',
    '- cmd 1 → ok',
    '- cmd 2 → 200',
    'CONCERNS: minor latency',
  ].join('\n');
  assert.equal(extractEvidenceBlock(text), 'cmd 1 → ok\ncmd 2 → 200');
  assert.equal(extractEvidenceBlock('No footer here'), '');
});

test('truncateHeadTail keeps short text intact and slices head + tail on long text', () => {
  assert.equal(truncateHeadTail('short text', 100), 'short text');
  const long = 'A'.repeat(6000) + 'B'.repeat(6000);
  const out = truncateHeadTail(long, 8000);
  assert.ok(out.startsWith('A'.repeat(4000)));
  assert.ok(out.endsWith('B'.repeat(4000)));
  assert.match(out, /truncated 4000 chars/);
});

test('parseSpecVerdict: parses criterion lines + VERDICT: APPROVED / CHANGES_REQUESTED', () => {
  const approvedReply = [
    '1. PASS — npm test output shows 42 passed',
    '2. PASS — report.md is 1280 bytes (> 0)',
    'VERDICT: APPROVED',
  ].join('\n');
  const v1 = parseSpecVerdict(approvedReply, ['tests pass', 'report.md non-empty']);
  assert.equal(v1.ok, true);
  assert.equal(v1.verdict, 'APPROVED');
  assert.equal(v1.criteria.length, 2);
  assert.deepEqual(v1.criteria[0], {
    criterion: 'tests pass',
    status: 'PASS',
    reason: 'npm test output shows 42 passed',
  });

  const rejectedReply = [
    '1. PASS — tests ran',
    '2. FAIL — report.md is 0 bytes (empty file)',
    'VERDICT: CHANGES_REQUESTED',
  ].join('\n');
  const v2 = parseSpecVerdict(rejectedReply, ['tests pass', 'report.md non-empty']);
  assert.equal(v2.ok, false);
  assert.equal(v2.verdict, 'CHANGES_REQUESTED');
  assert.equal(v2.criteria.length, 2);
  assert.equal(v2.criteria[1].status, 'FAIL');
  assert.match(v2.reason || '', /report\.md is 0 bytes/);
});

test('parseSpecVerdict: any FAIL line forces CHANGES_REQUESTED even if judge wrote APPROVED', () => {
  const inconsistent = [
    '1. PASS — build succeeded',
    '2. FAIL — missing migration file',
    'VERDICT: APPROVED',
  ].join('\n');
  const v = parseSpecVerdict(inconsistent);
  assert.equal(v.ok, false);
  assert.equal(v.verdict, 'CHANGES_REQUESTED');
  assert.match(v.reason || '', /missing migration file/);
});

test('parseSpecVerdict: all UNVERIFIABLE or crash/empty output returns UNVERIFIABLE and ok=true (fail-open)', () => {
  const unv = parseSpecVerdict('1. UNVERIFIABLE — cannot inspect external DB\nVERDICT: UNVERIFIABLE');
  assert.equal(unv.ok, true);
  assert.equal(unv.verdict, 'UNVERIFIABLE');

  const garbled = parseSpecVerdict('', ['c1'], true);
  assert.equal(garbled.ok, true);
  assert.equal(garbled.verdict, 'UNVERIFIABLE');
  assert.equal(garbled.crashed, true);
});

test('selectSpecJudge: cross-family judge selection matrix + cooldown/disabled skip + small-task fallback', () => {
  const brains: Record<string, any> = {
    'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' },
    'local-agy-claude-opus-5-5-medium': { location: 'local', exec: 'agy', model: 'claude-opus-5-5-medium' },
    'remote-ai-code-gen-cc-opus-5-5': { location: 'remote', exec: 'claude' },
    'local-agy-gemini-4-argon-medium': { location: 'local', exec: 'agy', model: 'gemini-4-argon-medium' },
    'local-agy-gemini-3.8-flash-high': { location: 'local', exec: 'agy', model: 'gemini-3.8-flash-high' },
    'local-dsh-qwen3-8-27b': { location: 'local', exec: 'dsh', model: 'qwen3.8-27b' },
    'local-hermes-qwen3.8-27b': { location: 'local', exec: 'hermes', model: 'qwen3.8-27b' },
    'remote-codex-gpt-5-4': { location: 'remote', exec: 'codex', model: 'gpt-5.4' },
  };
  const judges = DEFAULT_SPEC_JUDGES as any;

  // Claude executors (local-cc-*, local-agy-claude-*, remote-*-cc-*) -> Gemini Argon, then Flash
  assert.deepEqual(selectSpecJudges('local-cc-opus-5-5', { brains, judges }), [
    'local-agy-gemini-4-argon-medium',
    'local-agy-gemini-3.8-flash-high',
  ]);
  assert.equal(selectSpecJudge('local-agy-claude-opus-5-5-medium', { brains, judges }), 'local-agy-gemini-4-argon-medium');
  assert.equal(selectSpecJudge('remote-ai-code-gen-cc-opus-5-5', { brains, judges }), 'local-agy-gemini-4-argon-medium');

  // Gemini or qwen3.8-27b -> Claude Opus 5.5 medium (agy), then cc
  assert.deepEqual(selectSpecJudges('local-agy-gemini-4-argon-medium', { brains, judges }), [
    'local-agy-claude-opus-5-5-medium',
    'local-cc-opus-5-5',
  ]);
  assert.equal(selectSpecJudge('local-dsh-qwen3-8-27b', { brains, judges }), 'local-agy-claude-opus-5-5-medium');
  assert.equal(selectSpecJudge('local-hermes-qwen3.8-27b', { brains, judges }), 'local-agy-claude-opus-5-5-medium');

  // Anything else (codex / gpt-oss / deepseek) -> default (Opus 5.5)
  assert.equal(selectSpecJudge('remote-codex-gpt-5-4', { brains, judges }), 'local-agy-claude-opus-5-5-medium');

  // Small task (result < 2 KB and <= 2 criteria) tries cheaper fallback first
  assert.equal(isSmallSpecTask('short result', ['c1', 'c2']), true);
  assert.equal(isSmallSpecTask('x'.repeat(2500), ['c1']), false);
  assert.equal(isSmallSpecTask('short result', ['c1', 'c2', 'c3']), false);
  assert.equal(
    selectSpecJudge('local-cc-opus-5-5', { brains, judges, smallTask: true }),
    'local-agy-gemini-3.8-flash-high',
  );

  // Cooling judge is skipped -> falls back to second judge
  const cooling = new Set(['local-agy-gemini-4-argon-medium']);
  assert.equal(
    selectSpecJudge('local-cc-opus-5-5', { brains, judges, isCooling: id => cooling.has(id) }),
    'local-agy-gemini-3.8-flash-high',
  );

  // Disabled judge is skipped; if all judges are unavailable -> null
  const allCooling = new Set(['local-agy-gemini-4-argon-medium', 'local-agy-gemini-3.8-flash-high']);
  assert.equal(
    selectSpecJudge('local-cc-opus-5-5', { brains, judges, isCooling: id => allCooling.has(id) }),
    null,
  );
});

