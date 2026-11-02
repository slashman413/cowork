/**
 * `npx tsx server/src/cli/pr-shepherd.ts --pr <forgejo PR url> [--status | --diff]
 *    [--verdict PASS|PASS+NOTES|FAIL --verified-sha <sha>] [--fix-rounds N] [--notes "..."]`
 * `npx tsx server/src/cli/pr-shepherd.ts --protect <owner/repo> [--branch main] [--forge <baseUrl>]`
 *
 * Policy-enforcing forge writer for pr-watch tasks (core/forgejo-shepherd.ts).
 * Prints one JSON object. Exit: 0 ok/done, 2 needs a human, 3 blocked, 1 error.
 */
import { loadConfig } from '../config.js';
import { extractPrUrls, forgeFor } from '../core/pr-automation.js';
import { ForgejoClient, pinnedDiff, shepherdForgejoPr, type Verdict } from '../core/forgejo-shepherd.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const log = console.log; console.log = (...a: unknown[]) => console.error(...a);   // keep stdout pure JSON
  const cfg = loadConfig().orchestration.prAutomation || {};
  console.log = log;
  const protect = opt('--protect');
  if (protect) {
    const forge = (cfg.forges || []).find(f => !opt('--forge') || f.baseUrl.startsWith(opt('--forge')!)) ;
    if (!forge) throw new Error('no forge configured in orchestration.prAutomation.forges');
    const client = ForgejoClient.fromConfig(forge);
    const rule = await client.protectBranch(protect, opt('--branch') || 'main', forge.botUser);
    console.log(JSON.stringify({ status: 'OK', protected: protect, rule }, null, 2));
    return 0;
  }
  const ref = extractPrUrls(opt('--pr') || '')[0];
  if (!ref || !forgeFor(ref, cfg)) throw new Error(`--pr must be a PR URL on a configured forge (${(cfg.forges || []).map(f => f.baseUrl).join(', ') || 'none'})`);
  if (!cfg.repos?.includes(ref.repo) && cfg.repos?.length) throw new Error(`${ref.repo} is not in prAutomation.repos`);
  if (args.includes('--diff')) {            // review input, pinned to the head it was read at
    const { headSha, diff } = await pinnedDiff(ForgejoClient.fromConfig(forgeFor(ref, cfg)!), ref);
    process.stdout.write(`HEAD ${headSha}\n${diff}`);
    return 0;
  }
  const verdict = opt('--verdict') as Verdict | undefined;
  if (verdict && !['PASS', 'PASS+NOTES', 'FAIL'].includes(verdict)) throw new Error(`bad --verdict ${verdict}`);
  const r = await shepherdForgejoPr({
    ref, cfg, verdict: args.includes('--status') ? undefined : verdict,
    verifiedSha: opt('--verified-sha'), fixRounds: Number(opt('--fix-rounds') || 0), notes: opt('--notes'),
  });
  console.log(JSON.stringify(r, null, 2));
  return r.status === 'NEEDS_HUMAN' ? 2 : r.status === 'BLOCKED' ? 3 : 0;
}

main().then(c => process.exit(c), e => { console.log(JSON.stringify({ status: 'ERROR', error: String(e?.message || e) })); process.exit(1); });
