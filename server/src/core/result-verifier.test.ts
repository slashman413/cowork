import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOutput, parseLlmVerdict, buildVerifierPrompt, DEFAULT_FAIL_PATTERNS, detectInputRequest, DEFAULT_QUESTION_PATTERNS, detectBackgroundWait, DEFAULT_BACKGROUND_WAIT_PATTERNS } from './result-verifier.js';

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
  assert.match(p, /PASS or FAIL/);
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
