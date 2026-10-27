/**
 * `npm run integrate [-- <repo> [--install] [--force]] [--json]`
 *
 * Command-line interface for the Cowork Integrations subsystem (core/integrations.ts, ADR-014).
 * Turn any GitHub / open-source repository into a Cowork skill or portal web plugin.
 *
 * Commands:
 *   integrate <owner/repo or url> [--install] [--force]   Fetch, classify, audit (and install)
 *   integrate list                                        List all integrated repositories
 *   integrate install <id> [--force]                      Install detected skills / web portal plugin
 *   integrate update <id>                                 Pull latest commit, re-audit, refresh
 *   integrate rescan <id>                                 Re-audit without fetching (picks up wrappers)
 *   integrate uninstall <id> [--purge]                    Remove installed links/card (or delete clone)
 *   integrate audit                                       Audit all installed skill directories
 */
import { sharedIntegrations, defaultAuditTargets } from '../core/integrations.js';
import { auditPath, mergeReports, formatSummary } from '../core/skill-auditor.js';

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const install = args.includes('--install');
  const force = args.includes('--force');
  const purge = args.includes('--purge');
  const positional = args.filter(a => !a.startsWith('--'));

  const cmd = positional[0] || 'list';
  const int = sharedIntegrations();

  if (cmd === 'list') {
    const list = int.list();
    if (json) {
      console.log(JSON.stringify(list, null, 2));
    } else {
      console.log(`Integrated repositories (${list.length}):\n`);
      if (!list.length) {
        console.log('  No repositories integrated yet. Add one with:');
        console.log('    npm run integrate -- owner/repo [--install]');
      }
      for (const item of list) {
        const kinds = item.detected.kinds.join(', ');
        const badge = item.status === 'installed' ? '✔ INSTALLED'
          : item.status === 'quarantined' ? '✖ QUARANTINED'
          : '● FETCHED';
        console.log(`[${badge}] ${item.id} (${item.source})`);
        console.log(`    Kinds: ${kinds} | Audit: ${item.audit.verdict.toUpperCase()} (${item.audit.counts.critical} crit, ${item.audit.counts.high} high)`);
        if (item.installed.skills.length) {
          console.log(`    Skills: ${item.installed.skills.map(s => s.name).join(', ')}`);
        }
        if (item.installed.web) {
          console.log(`    Web Plugin: ${item.installed.web.url}`);
        }
        console.log('');
      }
    }
    return;
  }

  if (cmd === 'audit') {
    const targets = defaultAuditTargets();
    const r = mergeReports(targets.map(t => auditPath(t)), 'default targets');
    if (json) {
      console.log(JSON.stringify({ targets, ...r }, null, 2));
    } else {
      console.log(formatSummary(r));
    }
    process.exit(r.verdict === 'quarantine' ? 1 : 0);
  }

  if (cmd === 'install') {
    const id = positional[1];
    if (!id) throw new Error('Usage: npm run integrate -- install <id> [--force]');
    const res = int.install(id, { force });
    if (json) console.log(JSON.stringify(res, null, 2));
    else console.log(`Installed ${id}: ${res.status}`);
    return;
  }

  if (cmd === 'uninstall') {
    const id = positional[1];
    if (!id) throw new Error('Usage: npm run integrate -- uninstall <id> [--purge]');
    const res = int.uninstall(id, { purge });
    if (json) console.log(JSON.stringify(res || { id, purged: true }, null, 2));
    else console.log(purge ? `Purged ${id}` : `Uninstalled ${id}`);
    return;
  }

  if (cmd === 'update') {
    const id = positional[1];
    if (!id) throw new Error('Usage: npm run integrate -- update <id>');
    const res = await int.update(id);
    if (json) console.log(JSON.stringify(res, null, 2));
    else console.log(`Updated ${id}: ${res.status} (commit: ${res.commit || 'unknown'})`);
    return;
  }

  if (cmd === 'rescan') {
    const id = positional[1];
    if (!id) throw new Error('Usage: npm run integrate -- rescan <id>');
    const res = int.rescan(id);
    if (json) console.log(JSON.stringify(res, null, 2));
    else console.log(`Rescanned ${id}: ${res.status}`);
    return;
  }

  // Otherwise positional[0] is a repo spec / URL
  const repo = positional[0];
  console.log(`Fetching and auditing repository: ${repo}…`);
  const entry = await int.add(repo, { install, force });
  if (json) {
    console.log(JSON.stringify(entry, null, 2));
  } else {
    console.log(`\nRepository integrated: ${entry.id}`);
    console.log(`  Source: ${entry.source}`);
    console.log(`  Status: ${entry.status.toUpperCase()}`);
    console.log(`  Detected Kinds: ${entry.detected.kinds.join(', ')}`);
    if (entry.detected.language) console.log(`  Language: ${entry.detected.language}`);
    if (entry.detected.description) console.log(`  Description: ${entry.detected.description}`);
    console.log(`  Audit Verdict: ${entry.audit.verdict.toUpperCase()} (${entry.audit.counts.critical} critical, ${entry.audit.counts.high} high, ${entry.audit.counts.medium} medium)`);
    if (entry.installed.skills.length) {
      console.log(`  Installed Skills: ${entry.installed.skills.map(s => s.name).join(', ')}`);
    }
    if (entry.installed.web) {
      console.log(`  Installed Web Plugin: ${entry.installed.web.url}`);
    }
    if (entry.status === 'quarantined') {
      console.log('\n  ⚠️ Repository quarantined due to critical audit findings.');
      console.log('  Review findings on dashboard or re-run with --force to override.');
    }
  }
}

main().catch(err => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
