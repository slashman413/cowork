/**
 * PR shepherd (pstack opening-a-pr / babysit / shipping, report §5).
 * Everything here runs without a GitHub token: URL detection, the escalation
 * filter, the merge-policy decision and the pr-watch task spec. The steps that
 * need `gh` (status query, approve, merge) are executed by the pr-watch brain
 * and are gated by `mode`; in 'shadow' mode the brain only comments/reports.
 */
import type { PrAutomationConfig, Task } from '../types.js';

const PR_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
/** Forgejo/Gitea PR URLs use `/pulls/<n>` on any host. */
const FORGE_PR_RE = /(https?:\/\/[\w.-]+(?::\d+)?)\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)/g;

export interface PrRef {
  url: string; repo: string; number: number;
  /** Absent = GitHub. 'forgejo' = a self-hosted Forgejo/Gitea at `baseUrl`. */
  forge?: 'forgejo'; baseUrl?: string;
}

/** All distinct GitHub and Forgejo PR URLs in a result text. */
export function extractPrUrls(text: string): PrRef[] {
  const seen = new Map<string, PrRef>();
  for (const m of (text || '').matchAll(PR_RE)) {
    const url = `https://github.com/${m[1]}/pull/${m[2]}`;
    if (!seen.has(url)) seen.set(url, { url, repo: m[1], number: Number(m[2]) });
  }
  for (const m of (text || '').matchAll(FORGE_PR_RE)) {
    const url = `${m[1]}/${m[2]}/pulls/${m[3]}`;
    if (!seen.has(url)) seen.set(url, { url, repo: m[2], number: Number(m[3]), forge: 'forgejo', baseUrl: m[1] });
  }
  return [...seen.values()];
}

const normBase = (u: string) => u.replace(/\/+$/, '').toLowerCase();

/** The configured forge for a Forgejo PR ref (undefined if the host is not configured). */
export function forgeFor(ref: PrRef, cfg?: PrAutomationConfig) {
  if (ref.forge !== 'forgejo' || !ref.baseUrl) return undefined;
  return (cfg?.forges || []).find(f => normBase(f.baseUrl) === normBase(ref.baseUrl!));
}

/** Effective mode for a repo: repoModes override, else the global mode. */
export function modeFor(repo: string, cfg?: PrAutomationConfig): 'shadow' | 'approve' | 'merge' {
  return cfg?.repoModes?.[repo] || cfg?.mode || 'shadow';
}

/** PRs the result claims to have OPENED (a `PR_OPENED: <url>` line, or a line
 *  saying opened/created/raised). A PR URL that is merely quoted (e.g. from
 *  fetched content) must not spawn a watcher — prompt-injection guard. */
export function openedPrUrls(text: string): PrRef[] {
  const lines = (text || '').split('\n').filter(l => /PR_OPENED:|\b(opened|created|raised|submitted)\b/i.test(l));
  return extractPrUrls(lines.join('\n'));
}

/** Changed paths that must go to a human (auth, secrets, deploy, workflows…). */
export function escalationHits(files: string[], cfg?: PrAutomationConfig): string[] {
  const pats = (cfg?.escalatePaths || []).map(p => p.toLowerCase());
  return files.filter(f => pats.some(p => f.toLowerCase().includes(p)));
}

export type PrAction = 'wait' | 'comment' | 'approve' | 'merge' | 'escalate' | 'fix';

/** Merge policy (report §5c gating signals). Never merges in shadow mode, never
 *  on escalation paths, never without an independent PASS covering the head. */
export function decidePrAction(input: {
  cfg?: PrAutomationConfig;
  watch: 'READY' | 'BLOCKER' | 'WAITING' | 'TIMEOUT';
  verdict?: 'PASS' | 'PASS+NOTES' | 'FAIL';
  verifiedPatchId?: string;
  headPatchId?: string;
  files: string[];
  fixRounds?: number;
  /** Overrides cfg.mode (per-repo mode from {@link modeFor}). */
  mode?: 'shadow' | 'approve' | 'merge';
}): { action: PrAction; why: string } {
  const cfg = input.cfg || {};
  if (cfg.enabled === false) return { action: 'wait', why: 'prAutomation disabled' };
  const hits = escalationHits(input.files, cfg);
  if (hits.length) return { action: 'escalate', why: `escalation paths touched: ${hits.join(', ')}` };
  if (input.watch !== 'READY') return { action: 'wait', why: `watch-pr ${input.watch}` };
  if (!input.verdict) return { action: 'wait', why: 'no independent verdict yet' };
  if (input.verdict === 'FAIL') {
    return (input.fixRounds ?? 0) >= (cfg.maxFixRounds ?? 2)
      ? { action: 'escalate', why: 'verifier FAIL after max fix rounds' }
      : { action: 'fix', why: 'verifier FAIL — send findings back to the author brain' };
  }
  if (!input.verifiedPatchId || input.verifiedPatchId !== input.headPatchId) {
    return { action: 'wait', why: 'patch-id drift — re-verify the current head' };
  }
  const mode = input.mode || cfg.mode || 'shadow';
  if (mode === 'shadow') return { action: 'comment', why: 'shadow mode: post verdict only' };
  if (mode === 'approve') return { action: 'approve', why: 'PASS + READY; human merges' };
  return { action: 'merge', why: `PASS + READY; ${cfg.mergeMethod || 'squash'} merge` };
}

/** True when the PR's repo is in scope for automation. */
export function prInScope(ref: PrRef, cfg?: PrAutomationConfig): boolean {
  if (!cfg || cfg.enabled === false) return false;
  // A Forgejo URL is only in scope on a configured host — never call an arbitrary server.
  if (ref.forge === 'forgejo' && !forgeFor(ref, cfg)) return false;
  return !cfg.repos?.length || cfg.repos.includes(ref.repo);
}

/** Spec for the recurring pr-watch task created when a result opens a PR. */
export function prWatchTaskSpec(ref: PrRef, parent: Task, cfg?: PrAutomationConfig) {
  const mode = modeFor(ref.repo, cfg);
  if (ref.forge === 'forgejo') return forgejoWatchSpec(ref, parent, cfg, mode);
  return {
    title: `[pr-watch] ${ref.repo}#${ref.number}`,
    description: [
      `Shepherd ${ref.url} (opened by task ${parent.id}) per pstack babysit/shipping, mode=${mode}.`,
      `1. \`gh auth status\` — if it fails, report STATUS: BLOCKED with its output and stop. Then \`gh pr view ${ref.number} -R ${ref.repo} --json author,headRefName,labels\`: if the PR is not labelled \`${cfg?.label || 'cowork-auto'}\` or was not opened by task ${parent.id}'s branch, report and stop.`,
      `2. \`npx tsx vendor/pstack/skills/poteto-mode/scripts/watch-pr/cli.ts --pr ${ref.number} --repo ${ref.repo} --status-only\` (JSON).`,
      `3. Conflicts → report "rebase needed" (never auto-rebase). Threads → triage with poteto-mode/references/bugbot-triage.md. Failing CI → one rerun for a flake, else a fix task.`,
      `4. READY → run an independent review (interrogate) of \`gh pr diff ${ref.number}\`; record PASS/PASS+NOTES/FAIL and \`git patch-id\` of the head.`,
      `5. Escalate (NEEDS_INPUT) if the diff touches: ${(cfg?.escalatePaths || []).join(', ')}.`,
      mode === 'shadow'
        ? `6. SHADOW MODE: post the verdict as a PR comment only. Do NOT approve or merge.`
        : mode === 'approve'
        ? `6. On PASS with matching patch-id: \`gh pr review ${ref.number} --approve\`. Do NOT merge.`
        : `6. On PASS with matching patch-id: approve, then \`gh pr merge ${ref.number} --${cfg?.mergeMethod || 'squash'} --delete-branch\`; read back \`gh pr view ${ref.number} --json state,mergedAt\`.`,
      `Never bypass a required human review. Stop the recurrence once the PR is merged or closed.`,
    ].join('\n'),
    recurrence: { type: 'minutes' as const, interval: Math.max(5, cfg?.watchIntervalMin ?? 10) },
    context: { prUrl: ref.url, prRepo: ref.repo, prNumber: ref.number, prWatch: true, prMode: mode, prParent: parent.id, tier: 'mechanical' },
  };
}

/** Forgejo pr-watch: the brain only reviews; every forge write (comment,
 *  approve, merge) goes through the policy-enforcing pr-shepherd CLI. */
function forgejoWatchSpec(ref: PrRef, parent: Task, cfg: PrAutomationConfig | undefined, mode: string) {
  const cli = `npx tsx server/src/cli/pr-shepherd.ts --pr ${ref.url}`;
  return {
    title: `[pr-watch] ${ref.repo}#${ref.number}`,
    description: [
      `Shepherd ${ref.url} (Forgejo; opened by task ${parent.id}) per pstack babysit/shipping, mode=${mode}.`,
      `1. \`${cli} --status\` (JSON). If it reports BLOCKED (auth, label, author) or the PR is merged/closed, report it and stop the recurrence.`,
      `2. \`${cli} --diff\` prints \`HEAD <sha>\` then the diff at exactly that head. Review it independently with pstack interrogate; decide PASS / PASS+NOTES / FAIL.`,
      `3. \`${cli} --verdict <PASS|PASS+NOTES|FAIL> --verified-sha <the HEAD sha printed by --diff>\`. The CLI enforces the policy: escalation paths, head-sha drift, author ≠ bot, mode (${mode}).`,
      `Never call the Forgejo API directly to approve or merge. FAIL → report the findings as a fix task for the author.`,
    ].join('\n'),
    recurrence: { type: 'minutes' as const, interval: Math.max(5, cfg?.watchIntervalMin ?? 10) },
    context: { prUrl: ref.url, prRepo: ref.repo, prNumber: ref.number, prForge: 'forgejo', prWatch: true, prMode: mode, prParent: parent.id, tier: 'mechanical' },
  };
}
