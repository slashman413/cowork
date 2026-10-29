/**
 * PS-2 — interrogate-style multi-family review panel + lead judgment.
 *
 * Port of pstack `interrogate` steps 3–5 (pinned 0c3333f):
 * `skills/interrogate/references/rubric.md` (lenses, condensed) and
 * `skills/interrogate/references/lead-judgment.md` (filters, verbatim).
 *
 * Flow: N reviewers, one per distinct model family (none from the executor's
 * family), each get `buildVerifierPrompt()` + {@link PANEL_RUBRIC}. A lead on
 * the `judgment` tier merges their findings into Act on / Consider / Noted /
 * Dismissed with the families that raised each. Only Act on drives
 * CHANGES_REQUESTED; a finding raised by ≥2 families is a `BLOCKER:`.
 *
 * Pure functions only — the workflow gate and the dispatcher's spec verifier
 * own the I/O.
 */

import { JUDGE_COMPLIANCE_RULES, ARTIFACT_LISTING_RULE, JUDGE_RULES_HEADING } from './result-verifier.js';

export type PanelBucket = 'act_on' | 'consider' | 'noted' | 'dismissed';

export interface PanelFinding {
  bucket: PanelBucket;
  finding: string;
  families: string[];
  rationale?: string;
  /** Set when the finding drives CHANGES_REQUESTED as a ship-stopper. */
  blocker?: boolean;
}

export interface PanelReview {
  family: string;
  brain: string;
  /** Raw reviewer reply (empty when the reviewer crashed). */
  text: string;
  failed?: boolean;
}

export interface PanelBucketCounts { actOn: number; consider: number; noted: number; dismissed: number }

export interface LeadJudgment {
  /** False when the lead's reply had no parseable bucket list. */
  parsed: boolean;
  findings: PanelFinding[];
  counts: PanelBucketCounts;
  /** Act-on findings formatted for the gate (`BLOCKER:` prefixed when blocker). */
  actOn: string[];
  blockers: string[];
  verdict: 'APPROVED' | 'CHANGES_REQUESTED';
  /** Dismissed / all findings, null when there were none. */
  dismissedShare: number | null;
}

/** Rubric lenses applied to every panel reviewer (rubric.md, condensed). */
export const PANEL_RUBRIC = [
  `## Review lenses (apply only those relevant to this step)`,
  `- **Correctness** — does the deliverable do what the task says? Edge cases, error handling, both the happy and the sad path, idempotency if it runs twice.`,
  `- **Root cause vs. symptom** — is the actual problem fixed, or papered over (guard clauses masking an invariant, retries hiding a broken contract, a "don't do X" note where a check would make X impossible)?`,
  `- **Verification** — can you tell it works from the evidence? Real artifacts and command output, not self-reports or proxies.`,
  `- **Complexity budget** — is the complexity justified? Abstractions with one call site, configuration for cases that don't exist, dead code. Simpler is better unless simpler is wrong.`,
  `- **Security** — untrusted input reaching shell/SQL/eval/HTML sinks, auth gaps, secrets in code, logs or results.`,
  ``,
  `**Trace the path, don't flag hypotheticals.** "What if X is null?" is only a finding if you can show the call chain or input that makes it null. A finding that amounts to "I would have done it differently" is not a finding.`,
  `For every FAIL, tag the severity in the reason: \`critical\`, \`warning\` or \`nit\`.`,
].join('\n');

/** Reviewer prompt = the existing verifier prompt + the rubric lenses. The
 *  judging rules ride in buildVerifierPrompt; they are added here only when the
 *  base prompt lacks them (e.g. a workflow gate's own prompt), never twice. */
export function buildPanelReviewerPrompt(basePrompt: string): string {
  const rules = basePrompt.includes(JUDGE_RULES_HEADING)
    ? ''
    : `${JUDGE_RULES_HEADING}\n${[...JUDGE_COMPLIANCE_RULES, ARTIFACT_LISTING_RULE].join('\n')}\n\n`;
  return `${PANEL_RUBRIC}\n\n${rules}${basePrompt}`;
}

/** lead-judgment.md "Nitpick Gravity" + "I Would Have Done It Differently", verbatim. */
export const LEAD_FILTERS_VERBATIM = [
  `### Nitpick Gravity`,
  ``,
  `Reviewers, especially adversarial ones, tend to fill their review. If they don't find critical issues, they'll inflate nits to fill the space. If a reviewer's findings are all nits and style preferences, the code is probably fine. Say so.`,
  ``,
  `### "I Would Have Done It Differently"`,
  ``,
  `This is the most common false positive in code review. A finding that amounts to "I prefer a different approach" is not a bug, not a design flaw, and not actionable unless the reviewer shows a concrete problem with the current approach. Dismiss these, and say why.`,
].join('\n');

/** Build the lead-judgment prompt over the panel's raw reviews. */
export function buildLeadJudgmentPrompt(input: {
  title: string;
  description?: string;
  acceptance: string[];
  reviews: PanelReview[];
  priorFindings?: string[];
}): string {
  const reviews = input.reviews.filter(r => !r.failed && r.text.trim());
  return [
    `You are the LEAD REVIEWER, a pragmatic senior engineer, not a neutral aggregator. ${reviews.length} reviewers from different model families reviewed the same deliverable. Merge their findings and judge them.`,
    ``,
    `TASK: ${input.title}`,
    (input.description || '').slice(0, 1500),
    ``,
    `ACCEPTANCE CRITERIA:`,
    ...(input.acceptance.length ? input.acceptance.map((c, i) => `${i + 1}. ${c}`) : ['1. Deliverable genuinely and completely addresses the task']),
    ...(input.priorFindings?.length ? [``, `PRIOR ROUND'S ACT-ON FINDINGS (check whether each is resolved):`, ...input.priorFindings.map((f, i) => `${i + 1}. ${f}`)] : []),
    ``,
    ...reviews.flatMap(r => [`## Reviewer — family: ${r.family} (brain ${r.brain})`, r.text.slice(0, 6000), ``]),
    `## How to judge`,
    `Merge findings that describe the same issue differently and list every family that raised it. Findings two or more families raised independently are the highest signal. Read a lone family's finding, but weight it accordingly. Be especially careful about dismissing security findings and correctness bugs.`,
    ``,
    LEAD_FILTERS_VERBATIM,
    ``,
    `Dismiss any finding that breaks these judging rules, and say which rule:`,
    ...JUDGE_COMPLIANCE_RULES,
    ``,
    `Put every finding in exactly one bucket:`,
    `- act_on — real issues affecting correctness, security, or maintainability given the actual goals. They would block a real PR.`,
    `- consider — legitimate, but not clearly worth another fix round now.`,
    `- noted — technically valid but not actionable (context-dependent, premature, low impact).`,
    `- dismissed — wrong, nitpicky, hypothetical, or missing context, with a brief reason.`,
    ``,
    `Reply with ONLY a JSON object in a \`\`\`json fence:`,
    '```json',
    `{"findings":[{"bucket":"act_on|consider|noted|dismissed","finding":"<concrete issue + fix>","families":["<family>",...],"rationale":"<one line>"}]}`,
    '```',
    `An empty findings list is valid when the reviewers found nothing real.`,
  ].join('\n');
}

const BUCKET_ALIASES: Record<string, PanelBucket> = {
  act_on: 'act_on', 'act-on': 'act_on', 'act on': 'act_on', acton: 'act_on',
  consider: 'consider', noted: 'noted', note: 'noted', dismissed: 'dismissed', dismiss: 'dismissed',
};

function normBucket(v: unknown): PanelBucket | null {
  const k = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return BUCKET_ALIASES[k] || BUCKET_ALIASES[k.replace(/[ -]/g, '_')] || null;
}

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c || !c.trim()) continue;
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

/** Markdown fallback: `### Act On` headings with `- finding (families: a, b)` bullets. */
function parseMarkdownBuckets(text: string): PanelFinding[] | null {
  const out: PanelFinding[] = [];
  let bucket: PanelBucket | null = null;
  let sawHeading = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s*(act on|act-on|consider|noted|dismissed)\b/i);
    if (h) { bucket = normBucket(h[1]); sawHeading = true; continue; }
    if (/^#{1,6}\s/.test(line)) { bucket = null; continue; }
    const b = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bucket && b) {
      const fm = b[1].match(/\((?:families|raised by|models?)\s*:\s*([^)]+)\)/i);
      const families = fm ? fm[1].split(/[,/&]|\band\b/).map(s => s.trim().toLowerCase()).filter(Boolean) : [];
      out.push({ bucket, finding: b[1].replace(/\s*\((?:families|raised by|models?)\s*:[^)]*\)/i, '').trim(), families });
    }
  }
  return sawHeading ? out : null;
}

const uniqLower = (xs: unknown): string[] =>
  Array.isArray(xs) ? Array.from(new Set(xs.map(x => String(x || '').trim().toLowerCase()).filter(Boolean))) : [];

/**
 * Turn a merged finding list into the gate decision:
 *   - a finding raised by ≥2 families in Act on, or in Consider, is promoted to
 *     Act on as a `BLOCKER:` (consensus signal); Noted / Dismissed are the
 *     lead's explicit call and stay put;
 *   - only Act on findings produce CHANGES_REQUESTED.
 */
export function applyBucketRules(findings: PanelFinding[], parsed = true): LeadJudgment {
  const out: PanelFinding[] = findings.map(f => {
    const consensus = f.families.length >= 2;
    if (consensus && (f.bucket === 'act_on' || f.bucket === 'consider')) return { ...f, bucket: 'act_on', blocker: true };
    return { ...f, blocker: f.blocker && f.bucket === 'act_on' ? true : undefined };
  });
  const counts: PanelBucketCounts = { actOn: 0, consider: 0, noted: 0, dismissed: 0 };
  for (const f of out) {
    if (f.bucket === 'act_on') counts.actOn++;
    else if (f.bucket === 'consider') counts.consider++;
    else if (f.bucket === 'noted') counts.noted++;
    else counts.dismissed++;
  }
  const fmt = (f: PanelFinding) => {
    const fams = f.families.length ? ` [families: ${f.families.join(', ')}]` : '';
    const body = f.finding.replace(/^BLOCKER\s*:\s*/i, '');
    return f.blocker ? `BLOCKER: ${body}${fams}` : `${body}${fams}`;
  };
  const act = out.filter(f => f.bucket === 'act_on');
  const actOn = act.map(fmt);
  const blockers = act.filter(f => f.blocker).map(fmt);
  return {
    parsed,
    findings: out,
    counts,
    actOn,
    blockers,
    verdict: act.length ? 'CHANGES_REQUESTED' : 'APPROVED',
    dismissedShare: out.length ? counts.dismissed / out.length : null,
  };
}

/** Parse the lead's reply (JSON, else markdown buckets). `parsed:false` when neither matched. */
export function parseLeadJudgment(text: string): LeadJudgment {
  const t = (text || '').trim();
  const json = t ? extractJson(t) : null;
  const list = Array.isArray(json?.findings) ? json.findings : Array.isArray(json) ? json : null;
  if (list) {
    const findings: PanelFinding[] = [];
    for (const f of list) {
      const bucket = normBucket(f?.bucket);
      const finding = String(f?.finding || f?.description || '').trim();
      if (!bucket || !finding) continue;
      findings.push({
        bucket,
        finding,
        families: uniqLower(f?.families ?? f?.raisedBy),
        ...(f?.rationale ? { rationale: String(f.rationale).slice(0, 300) } : {}),
        ...(/^BLOCKER\s*:/i.test(finding) ? { blocker: true } : {}),
      });
    }
    return applyBucketRules(findings, true);
  }
  const md = t ? parseMarkdownBuckets(t) : null;
  if (md) return applyBucketRules(md, true);
  return { ...applyBucketRules([], false), verdict: 'CHANGES_REQUESTED' };
}

/** Panel size from `gate.panel` and the `orchestration.verifier.panel` flag. */
export function effectivePanelSize(stepPanel: unknown, cfg?: { enabled?: boolean; size?: number }): number {
  const n = Number(stepPanel);
  if (!Number.isInteger(n) || n < 2) return 1;
  if (cfg && cfg.enabled === false) return 1;
  return n;
}
