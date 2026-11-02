/**
 * Forgejo/Gitea PR shepherd — the server-side executor for report §5c on a
 * self-hosted forge. The pr-watch brain reviews; this module is the only code
 * that writes to the forge, and it enforces the merge policy itself
 * (decidePrAction + label + author ≠ bot + head-sha pin) instead of trusting
 * the brain's prompt.
 */
import fs from 'fs';
import os from 'os';
import type { ForgeConfig, PrAutomationConfig } from '../types.js';
import { decidePrAction, forgeFor, modeFor, type PrAction, type PrRef } from './pr-automation.js';

type Fetch = typeof fetch;

export class ForgejoClient {
  constructor(readonly baseUrl: string, private token: string, private fetchImpl: Fetch = fetch) {}

  static fromConfig(forge: ForgeConfig, fetchImpl?: Fetch): ForgejoClient {
    const file = forge.tokenFile.replace(/^~(?=\/)/, os.homedir());
    const token = fs.readFileSync(file, 'utf-8').trim();
    if (!token) throw new Error(`empty token file ${forge.tokenFile}`);
    return new ForgejoClient(forge.baseUrl.replace(/\/+$/, ''), token, fetchImpl);
  }

  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: { Authorization: `token ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Forgejo ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  whoami() { return this.api<{ login: string }>('GET', '/user'); }
  pr(repo: string, n: number) { return this.api<any>('GET', `/repos/${repo}/pulls/${n}`); }
  /** Every changed path (all pages; renames contribute their old path too).
   *  `complete:false` when the page cap is hit — callers must fail closed. */
  async files(repo: string, n: number, pageSize = 50, maxPages = 20): Promise<{ paths: string[]; complete: boolean }> {
    const paths: string[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.api<Array<{ filename: string; previous_filename?: string }>>('GET', `/repos/${repo}/pulls/${n}/files?limit=${pageSize}&page=${page}`);
      for (const f of batch || []) { paths.push(f.filename); if (f.previous_filename) paths.push(f.previous_filename); }
      if (!batch || batch.length === 0) return { paths, complete: true };   // stop only on an empty page: the server may cap page size below `limit`
    }
    return { paths, complete: false };
  }
  async diff(repo: string, n: number): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/repos/${repo}/pulls/${n}.diff`, { headers: { Authorization: `token ${this.token}` } });
    if (!res.ok) throw new Error(`Forgejo GET pulls/${n}.diff → HTTP ${res.status}`);
    return res.text();
  }
  status(repo: string, sha: string) { return this.api<{ state: string; total_count: number }>('GET', `/repos/${repo}/commits/${sha}/status`); }
  reviews(repo: string, n: number) { return this.api<Array<{ state: string; user: { login: string }; commit_id: string; stale?: boolean; dismissed?: boolean; official?: boolean }>>('GET', `/repos/${repo}/pulls/${n}/reviews`); }
  comment(repo: string, n: number, body: string) { return this.api('POST', `/repos/${repo}/issues/${n}/comments`, { body }); }
  approve(repo: string, n: number, sha: string, body: string) {
    return this.api('POST', `/repos/${repo}/pulls/${n}/reviews`, { event: 'APPROVED', body, commit_id: sha });
  }
  merge(repo: string, n: number, method: string, sha: string) {
    return this.api('POST', `/repos/${repo}/pulls/${n}/merge`, { Do: method, head_commit_id: sha, delete_branch_after_merge: true });
  }
  /** Idempotent branch protection: one approval from a non-author writer (Forgejo
   *  refuses self-approval), merge only by the bot, stale approvals dismissed.
   *  No approvals whitelist: Forgejo drops org-owner usernames from it, which
   *  makes every approval uncounted ("Does not have enough approvals"). */
  async protectBranch(repo: string, branch: string, bot: string) {
    const rule = {
      rule_name: branch, required_approvals: 1, enable_approvals_whitelist: false,
      enable_merge_whitelist: true, merge_whitelist_usernames: [bot], block_on_rejected_reviews: true,
      block_on_outdated_branch: false, dismiss_stale_approvals: true, enable_push: false,
    };
    const existing = await this.api<Array<{ rule_name: string }>>('GET', `/repos/${repo}/branch_protections`);
    return existing.some(r => r.rule_name === branch)
      ? this.api('PATCH', `/repos/${repo}/branch_protections/${encodeURIComponent(branch)}`, rule)
      : this.api('POST', `/repos/${repo}/branch_protections`, rule);
  }
}

export type Verdict = 'PASS' | 'PASS+NOTES' | 'FAIL';

export interface ShepherdResult {
  status: 'OK' | 'BLOCKED' | 'NEEDS_HUMAN' | 'DONE';
  action: PrAction | 'none';
  why: string;
  pr: { url: string; state: string; merged: boolean; author: string; headSha: string; mergeable: boolean; labels: string[] };
  watch: 'READY' | 'BLOCKER' | 'WAITING' | 'TIMEOUT';
  files: string[];
  performed: string[];
}

/** One shepherd pass. Without a verdict it only reports status (no writes). */
export async function shepherdForgejoPr(opts: {
  ref: PrRef; cfg: PrAutomationConfig; client?: ForgejoClient; fetchImpl?: Fetch;
  verdict?: Verdict; verifiedSha?: string; fixRounds?: number; notes?: string;
}): Promise<ShepherdResult> {
  const { ref, cfg } = opts;
  const forge = forgeFor(ref, cfg);
  if (!forge) throw new Error(`no configured forge for ${ref.url}`);
  const client = opts.client || ForgejoClient.fromConfig(forge, opts.fetchImpl);
  const raw = await client.pr(ref.repo, ref.number);
  const pr = {
    url: ref.url, state: raw.state, merged: !!raw.merged, author: raw.user?.login || '',
    headSha: raw.head?.sha || '', mergeable: !!raw.mergeable, labels: (raw.labels || []).map((l: any) => l.name),
  };
  const base = { pr, files: [] as string[], performed: [] as string[] };
  if (pr.merged || pr.state === 'closed') {
    return { ...base, status: 'DONE', action: 'none', watch: 'READY', why: pr.merged ? 'already merged — stop the recurrence' : 'closed — stop the recurrence' };
  }
  const label = cfg.label || 'cowork-auto';
  if (!pr.labels.includes(label)) return { ...base, status: 'BLOCKED', action: 'none', watch: 'WAITING', why: `PR lacks opt-in label "${label}"` };
  if (pr.author.toLowerCase() === forge.botUser.toLowerCase()) {
    return { ...base, status: 'BLOCKED', action: 'none', watch: 'WAITING', why: `PR author is the bot (${forge.botUser}); self-approval is not allowed` };
  }
  const listed = await client.files(ref.repo, ref.number);
  const files = listed.complete ? listed.paths : [...listed.paths, '<file list truncated — escalate>'];
  const ci = pr.headSha ? await client.status(ref.repo, pr.headSha) : { state: '', total_count: 0 };
  const watch: ShepherdResult['watch'] = !pr.mergeable ? 'BLOCKER'
    : !ci.total_count ? 'READY'
    : ci.state === 'success' ? 'READY'
    : ci.state === 'pending' ? 'WAITING' : 'BLOCKER';
  const mode = modeFor(ref.repo, cfg);
  const d0 = decidePrAction({ cfg, mode, watch, verdict: opts.verdict, verifiedPatchId: opts.verifiedSha, headPatchId: pr.headSha, files, fixRounds: opts.fixRounds });
  // Fail closed: an incomplete file list can hide an escalation path.
  const d = listed.complete ? d0 : { action: 'escalate' as const, why: 'changed-file list exceeds the page cap; a human must review' };
  const out: ShepherdResult = { ...base, files, watch, action: d.action, why: d.why, status: 'OK' };
  const tag = `<!-- cowork-pr-shepherd sha=${pr.headSha} -->`;
  const verdictLine = opts.verdict ? `**cowork verdict: ${opts.verdict}** on \`${pr.headSha.slice(0, 12)}\` (mode=${mode})${opts.notes ? `\n\n${opts.notes}` : ''}` : '';

  switch (d.action) {
    case 'wait':
      return out;
    case 'comment':
      await client.comment(ref.repo, ref.number, `${verdictLine}\n\nShadow mode: no approval or merge.\n${tag}`);
      out.performed.push('comment');
      return out;
    case 'fix':
      await client.comment(ref.repo, ref.number, `${verdictLine}\n\nSent back to the author for a fix (round ${(opts.fixRounds ?? 0) + 1}).\n${tag}`);
      out.performed.push('comment');
      return out;
    case 'escalate':
      await client.comment(ref.repo, ref.number, `**cowork: escalated to a human** — ${d.why}\n${tag}`);
      out.performed.push('comment');
      return { ...out, status: 'NEEDS_HUMAN' };
    case 'approve':
    case 'merge': {
      const reviews = await client.reviews(ref.repo, ref.number);
      const approved = reviews.some(r => r.state === 'APPROVED' && r.user?.login === forge.botUser && r.commit_id === pr.headSha && !r.stale && !r.dismissed
        && r.official !== false);   // an approval made before protection existed does not count toward required_approvals
      if (!approved) {
        await client.approve(ref.repo, ref.number, pr.headSha, `${verdictLine}\n${tag}`);
        out.performed.push('approve');
      }
      if (d.action === 'approve') return out;
      await client.merge(ref.repo, ref.number, cfg.mergeMethod || 'squash', pr.headSha);
      out.performed.push(`merge:${cfg.mergeMethod || 'squash'}`);
      const back = await client.pr(ref.repo, ref.number);   // read-back: never claim a merge we did not observe
      out.pr = { ...out.pr, state: back.state, merged: !!back.merged };
      if (!back.merged) return { ...out, status: 'BLOCKED', why: 'merge call returned but read-back shows not merged' };
      out.performed.push('read-back:merged');
      return { ...out, status: 'DONE' };
    }
  }
  return out;
}

/** The PR diff bound to a head SHA: fetched between two reads of the PR, and
 *  returned only if the head did not move — so the SHA a reviewer passes to
 *  `--verified-sha` is the content it actually reviewed. */
export async function pinnedDiff(client: ForgejoClient, ref: PrRef): Promise<{ headSha: string; diff: string }> {
  const before = (await client.pr(ref.repo, ref.number)).head?.sha;
  const diff = await client.diff(ref.repo, ref.number);
  const after = (await client.pr(ref.repo, ref.number)).head?.sha;
  if (!before || before !== after) throw new Error(`head moved during diff fetch (${before} → ${after}); retry`);
  return { headSha: before, diff };
}
