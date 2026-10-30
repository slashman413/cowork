import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * Deterministic artifact quality gate (ADR-013, inspired by Nutlope/hallmark and
 * pbakaus/impeccable): zero-LLM checks on the FILES a brain produced, not just its
 * stdout. The result verifier only ever saw stdout, so a run that printed a fine
 * summary but left an empty report.md, a broken data.json or a page of
 * "Lorem ipsum" passed as done.
 *
 * Two tiers, deliberately asymmetric:
 *   critical  unambiguous non-deliverables — the attempt is rejected (in 'enforce'
 *             mode) and handed to the next brain:
 *               · empty / whitespace-only text deliverable
 *               · .json that does not parse
 *               · "lorem ipsum" or unresolved {{template_tags}} in prose
 *   warning   probably-unfinished signals, recorded on the task for the reviewer:
 *               · TODO / TBD / [Insert …] placeholders in prose
 *               · relative markdown links to files that don't exist
 *               · html with many href="#" dead anchors
 *               · csv with a header and no rows
 *
 * Prose checks ignore fenced and inline code, so a deliverable that DOCUMENTS
 * placeholders (like this module's own docs) is not flagged.
 */

export interface LintIssue {
  file: string;
  severity: 'critical' | 'warning';
  rule: string;
  message: string;
}

export interface LintReport {
  files: string[];
  critical: LintIssue[];
  warnings: LintIssue[];
}

export interface LintOptions {
  /** Only lint files modified at/after this epoch-ms (the attempt's start), so a
   *  defect left by an earlier attempt can't fail every later brain. */
  sinceMs?: number;
  /** Files never linted (runtime-owned). */
  ignore?: string[];
  /** Per-file size cap (default 2 MiB). */
  maxBytes?: number;
  /** The task brief. When it itself asks for filler or templates (mentions
   *  "lorem" / "{{" / "template"), those rules downgrade to warnings. */
  brief?: string;
  /** Path to Hallmark's sloplint.mjs. When set, outputs/*.html deliverables are
   *  also run through it and summarised as ONE warning per page (never critical). */
  sloplint?: string;
}

const TEXT_DELIVERABLE = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.json', '.csv', '.yaml', '.yml']);
const PROSE = new Set(['.md', '.markdown', '.txt']);
export const LINT_IGNORE = ['result.md', 'progress.log', 'changes.patch'];
/** Subfolder of artifacts/<id>/ holding the task's FINAL deliverables
 *  ($COWORK_OUTPUTS_DIR) — shown as OUTPUTS, apart from working artifacts. */
export const OUTPUTS_SUBDIR = 'outputs';

/** Remove fenced code blocks, inline code, HTML comments and quoted rule mentions from markdown/plain text. */
export function stripCode(text: string): string {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/["'\u201c\u2018]lorem ipsum["'\u201d\u2019]/gi, '');
}

const TEMPLATE_TAG = /\{\{\s*[A-Za-z_][\w.]*\s*\}\}/;
const LOREM = /\blorem ipsum\b/i;
const LOREM_META = /\b(?:rule|defect|linter|linting|gate|detect|detects|flag|flagging|reject|rejects|check|checks|verify|verifies|placeholder|filler|prose|template)\b[^\n]*\blorem ipsum\b|\blorem ipsum\b[^\n]*\b(?:rule|defect|linter|linting|gate|detect|detects|flag|flagging|reject|rejects|check|checks|verify|verifies|placeholder|filler|prose|template)\b/i;
const PLACEHOLDER = /\[(?:TODO|TBD|insert [^\]]{1,60}|placeholder[^\]]{0,40}|your [^\]]{1,40} here)\]|\bTODO:|\bTBD\b|\bFIXME\b/i;

/** Lint the content of one file. `exists` resolves a relative link target. */
export function lintContent(file: string, text: string, exists: (rel: string) => boolean): LintIssue[] {
  const ext = path.extname(file).toLowerCase();
  const issues: LintIssue[] = [];
  const add = (severity: LintIssue['severity'], rule: string, message: string) => issues.push({ file, severity, rule, message });

  if (!text.trim()) { add('critical', 'empty-file', 'deliverable is empty'); return issues; }

  if (ext === '.json') {
    try { JSON.parse(text); } catch (e: any) { add('critical', 'invalid-json', `JSON does not parse: ${String(e.message).slice(0, 120)}`); }
    return issues;
  }

  if (ext === '.csv') {
    const rows = text.split(/\r?\n/).filter(l => l.trim());
    if (rows.length === 1) add('warning', 'empty-table', 'CSV has a header but no data rows');
    return issues;
  }

  if (ext === '.html' || ext === '.htm') {
    const dead = (text.match(/href\s*=\s*["']#["']/gi) || []).length;
    if (dead >= 5) add('warning', 'dead-anchors', `${dead} placeholder links (href="#")`);
    const visible = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
    const hasHtmlLorem = visible.split('\n').some(l => LOREM.test(l) && !LOREM_META.test(l));
    if (hasHtmlLorem) add('critical', 'lorem-ipsum', 'contains "lorem ipsum" filler text');
    return issues;
  }

  if (PROSE.has(ext)) {
    const prose = stripCode(text);
    const hasLorem = prose.split('\n').some(l => LOREM.test(l) && !LOREM_META.test(l));
    if (hasLorem) add('critical', 'lorem-ipsum', 'contains "lorem ipsum" filler text');
    const tag = prose.match(TEMPLATE_TAG);
    if (tag) add('critical', 'unresolved-template', `unresolved template tag ${tag[0]}`);
    const ph = prose.match(PLACEHOLDER);
    if (ph) add('warning', 'placeholder', `placeholder text "${ph[0]}"`);
    if (ext !== '.txt') {
      const missing = new Set<string>();
      for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const target = m[1];
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/|~)/i.test(target)) continue;   // URL, anchor, absolute
        const rel = decodeURIComponent(target.split('#')[0].split('?')[0]);
        if (rel && !exists(rel)) missing.add(rel);
      }
      if (missing.size) add('warning', 'broken-link', `links to missing file(s): ${[...missing].slice(0, 5).join(', ')}`);
    }
  }
  return issues;
}

/** Lint every top-level text deliverable in an artifacts dir, plus those in its
 *  outputs/ subfolder (reported as "outputs/<name>"). */
export function lintArtifacts(dir: string, opts: LintOptions = {}): LintReport {
  const ignore = new Set([...(opts.ignore || []), ...LINT_IGNORE]);
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const report: LintReport = { files: [], critical: [], warnings: [] };
  const brief = (opts.brief || '').toLowerCase();
  const tolerated = new Set<string>([
    ...(brief.includes('lorem') ? ['lorem-ipsum'] : []),
    ...(brief.includes('{{') || brief.includes('template') ? ['unresolved-template'] : []),
  ]);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return report; }
  try { names.push(...fs.readdirSync(path.join(dir, OUTPUTS_SUBDIR)).map(f => `${OUTPUTS_SUBDIR}/${f}`)); } catch { /* no outputs */ }
  for (const name of names) {
    if (ignore.has(name) || path.basename(name).startsWith('.')) continue;
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || !TEXT_DELIVERABLE.has(path.extname(name).toLowerCase())) continue;
    if (opts.sinceMs !== undefined && st.mtimeMs < opts.sinceMs) continue;
    if (st.size > maxBytes) continue;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    report.files.push(name);
    const base = path.dirname(abs);
    for (const issue of lintContent(name, text, rel => fs.existsSync(path.resolve(base, rel)))) {
      if (issue.severity === 'critical' && tolerated.has(issue.rule)) issue.severity = 'warning';
      (issue.severity === 'critical' ? report.critical : report.warnings).push(issue);
    }
    if (opts.sloplint && name.startsWith(`${OUTPUTS_SUBDIR}/`) && /\.html?$/i.test(name)) {
      const issue = sloplintFile(opts.sloplint, abs, name);
      if (issue) report.warnings.push(issue);
    }
  }
  return report;
}

/** Hallmark's sloplint.mjs if the hallmark skill is installed (shared skills home). */
export function resolveSloplint(skillsHome = path.join(os.homedir(), '.agents', 'skills')): string | undefined {
  const p = path.join(skillsHome, 'hallmark', 'scripts', 'sloplint.mjs');
  return fs.existsSync(p) ? p : undefined;
}

/** Gate 20 only checks for Hallmark's own CSS stamp, which non-Hallmark pages never carry. */
const SLOPLINT_SKIP_GATES = new Set(['20']);

/** Summarise sloplint findings for one page from its --json report. */
export function summariseSloplint(file: string, json: string): LintIssue | null {
  let out: { findings?: Array<{ gate: string; grade: string; evidence: string }> };
  try { out = JSON.parse(json); } catch { return null; }
  const hits = (out.findings || []).filter(f => (f.grade === 'FAIL' || f.grade === 'REFLEX') && !SLOPLINT_SKIP_GATES.has(String(f.gate)));
  if (!hits.length) return null;
  const top = hits.slice(0, 3).map(f => `#${f.gate} ${f.evidence}`).join('; ');
  return { file, severity: 'warning', rule: 'sloplint', message: `Hallmark sloplint: ${hits.length} design tell(s) — ${top}`.slice(0, 400) };
}

/** Run sloplint (static checks only) on one page. Fails open: any error → no finding. */
function sloplintFile(script: string, abs: string, name: string): LintIssue | null {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [script, abs, '--json'], { encoding: 'utf-8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e: any) {
    stdout = typeof e?.stdout === 'string' ? e.stdout : '';   // exit 1 = findings, still JSON
  }
  return stdout ? summariseSloplint(name, stdout) : null;
}

/** Compact one-line reason for a rejected attempt. */
export function lintReason(r: LintReport): string {
  return 'ARTIFACT_QUALITY_GATE_FAILED: ' + r.critical.slice(0, 3).map(i => `${i.file}: ${i.message}`).join('; ');
}
