/**
 * `npm run audit-skills [-- <path> ...] [--json] [--allow rule[@path]]`
 *
 * Static security audit (core/skill-auditor.ts, ADR-011) of the skills and
 * personas cowork dispatches. With no paths it scans the defaults: the repo's
 * agency-agents/ and deploy/skills/, the integrations clones, and every live
 * client skills dir that exists (~/.agents/skills, ~/.claude/skills, …).
 *
 * Exit code: 0 = pass/warn, 1 = at least one CRITICAL finding (quarantine), so
 * it can gate CI and deploy/install-skill.sh.
 */
import path from 'path';
import { auditPath, mergeReports, formatSummary } from '../core/skill-auditor.js';
import { defaultAuditTargets } from '../core/integrations.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const allow: string[] = [];
const paths: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') continue;
  if (a === '--allow') { if (args[i + 1]) allow.push(args[++i]); continue; }
  paths.push(path.resolve(a));
}

const targets = paths.length ? paths : defaultAuditTargets();
const report = mergeReports(targets.map(t => auditPath(t, { allow })), targets.length === 1 ? targets[0] : 'default targets');

if (json) {
  console.log(JSON.stringify({ targets, ...report }, null, 2));
} else {
  console.log(`Skill audit — ${targets.length} target(s):`);
  for (const t of targets) console.log(`  · ${t}`);
  const show = report.findings.filter(f => f.severity !== 'medium');
  for (const f of show.slice(0, 200)) {
    console.log(`[${f.severity.toUpperCase()}] ${f.rule}  ${f.file}:${f.line}\n    ${f.excerpt}`);
  }
  if (show.length > 200) console.log(`… ${show.length - 200} more`);
  console.log(formatSummary(report));
}
process.exit(report.verdict === 'quarantine' ? 1 : 0);
