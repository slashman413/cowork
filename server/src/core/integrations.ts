import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import matter from 'gray-matter';
import { auditPath, type AuditFinding, type AuditVerdict, type Severity } from './skill-auditor.js';
import { activePortalPath } from './portal-config.js';
import type { IntegrationsConfig } from '../types.js';

/**
 * Integrations — turn a GitHub (or any allow-listed git host) repository into a
 * cowork capability in one step (ADR-014). Pipeline:
 *
 *   fetch (shallow clone, no code executed)
 *     → detect what the repo IS (agent skill(s) / static web app / MCP server / CLI / library)
 *     → audit it statically (core/skill-auditor.ts) — CRITICAL findings quarantine it
 *     → install by kind:
 *         skill  → copied to the shared skills home (~/.agents/skills/<name>) and
 *                  symlinked into every client skills dir that exists — the same
 *                  convention the `skills` CLI already uses on this host, so every
 *                  brain (claude / codex / agy / hermes) picks it up.
 *         web    → served sandboxed at /plugins/<id>/ and registered as a Portal card.
 *         mcp / cli / library → nothing runs automatically (installing deps executes
 *                  repo code); instead `buildWrapTask` drafts a cowork task asking an
 *                  engineering agent to wrap the tool as a skill in <id>.wrapper/,
 *                  which a rescan then installs like any other skill.
 *
 * State is one JSON registry (~/.cowork/integrations.json) plus the clones under
 * ~/.cowork/integrations/. Everything is reversible: uninstall removes exactly the
 * links/dirs/portal card this module created and nothing else.
 */

export type IntegrationKind = 'skill' | 'web' | 'mcp' | 'cli' | 'library';

export interface RepoRef {
  /** Clone URL (https://… or file://… in tests). */
  url: string;
  host: string;
  owner: string;
  repo: string;
  ref?: string;
  /** Sub-directory inside the repo to integrate (monorepos of skills). */
  subpath?: string;
  id: string;
}

export interface DetectedSkill { name: string; dir: string; description?: string; wrapper?: boolean }

export interface Detection {
  kinds: IntegrationKind[];
  skills: DetectedSkill[];
  web?: { root: string; entry: string };
  mcp?: string;
  cli?: string;
  description?: string;
  license?: string;
  language?: string;
}

export interface Integration {
  id: string;
  source: string;
  /** What the operator pasted (re-used verbatim by update()). */
  input?: string;
  url: string;
  ref?: string;
  subpath?: string;
  dir: string;
  commit?: string;
  addedAt: string;
  fetchedAt: string;
  status: 'fetched' | 'installed' | 'quarantined' | 'error';
  error?: string;
  detected: Detection;
  audit: { verdict: AuditVerdict; counts: Record<Severity, number>; scannedFiles: number; findings: AuditFinding[]; at: string; overridden?: boolean };
  installed: {
    skills: Array<{ name: string; target: string; links: string[] }>;
    web?: { portalKey: string; url: string };
  };
  notes?: string[];
}

interface RegistryFile { version: 1; integrations: Record<string, Integration> }

export const DEFAULT_ALLOWED_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org'];
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'vendor']);

const home = () => os.homedir();
const expand = (p: string) => p.startsWith('~') ? path.join(home(), p.slice(1)) : p;

/** Client skill dirs that brains on this host read from (only existing ones are linked). */
export function defaultClientSkillDirs(): string[] {
  return ['.claude/skills', '.codex/skills', '.gemini/config/skills', '.hermes/skills'].map(p => path.join(home(), p));
}

/** Brain for "wrap with an agent" tasks: the configured one if it is a local
 *  brain, else the first local coding brain present (Operating Rule 6 — the
 *  clone lives under the operator's home, remote brains can't reach it). */
export function defaultWrapBrain(configured: string | undefined, localBrains: string[]): string | undefined {
  if (configured && localBrains.includes(configured)) return configured;
  const preferred = ['local-cc-sonnet-5-5', 'local-cc-opus-5-5', 'local-agy-claude-sonnet-5-5-medium', 'local-hermes-qwen3.8-27b'];
  return preferred.find(b => localBrains.includes(b)) || localBrains[0];
}

/** What `npm run audit-skills` scans with no arguments. */
export function defaultAuditTargets(cfg: IntegrationsConfig = {}): string[] {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
  const candidates = [
    path.join(repo, 'agency-agents'),
    path.join(repo, 'deploy', 'skills'),
    expand(cfg.skillsHome || '~/.agents/skills'),
    ...(cfg.clientSkillDirs?.map(expand) || defaultClientSkillDirs()),
    expand(cfg.root || '~/.cowork/integrations'),
  ];
  const seen = new Set<string>();
  return candidates.filter(p => {
    let real: string;
    try { real = fs.realpathSync(p); } catch { return false; }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/**
 * Parse what a person pastes: `owner/repo`, `owner/repo#ref`,
 * `https://github.com/owner/repo(.git)`, `…/tree/<ref>/<sub/path>`, or the same on
 * any allow-listed host. Rejects anything that could smuggle git options or
 * escape the clone dir.
 */
export function parseRepoRef(input: string, opts: { allowHosts?: string[]; allowFileUrls?: boolean } = {}): RepoRef {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('repository is required');
  if (/\s/.test(raw) || raw.startsWith('-')) throw new Error('invalid repository reference');
  let ref: string | undefined;
  const hash = raw.indexOf('#');
  if (hash >= 0) { ref = raw.slice(hash + 1) || undefined; raw = raw.slice(0, hash); }

  const hosts = (opts.allowHosts && opts.allowHosts.length ? opts.allowHosts : DEFAULT_ALLOWED_HOSTS).map(h => h.toLowerCase());
  let host = 'github.com', owner: string, repo: string, subpath: string | undefined, url: string;

  const scp = raw.match(/^git@([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(\.git)?$/);

  if (opts.allowFileUrls && raw.startsWith('file://')) {
    const p = raw.slice('file://'.length).replace(/\/+$/, '');
    repo = path.basename(p).replace(/\.git$/, '');
    owner = path.basename(path.dirname(p)) || 'local';
    host = 'local';
    url = raw;
  } else if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) {
    [owner, repo] = raw.split('/');
    repo = repo.replace(/\.git$/, '');
    url = `https://github.com/${owner}/${repo}.git`;
  } else if (scp) {
    host = scp[1].toLowerCase();
    if (!hosts.includes(host)) {
      throw new Error(`host ${host} is not in integrations.allowHosts (${hosts.join(', ')})`);
    }
    owner = scp[2];
    repo = scp[3];
    url = `https://${host}/${owner}/${repo}.git`;
  } else {
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error(`not a repository URL or owner/repo: ${raw}`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only https:// repository URLs are supported');
    if (u.username || u.password) throw new Error('credentials in the URL are not allowed');
    host = u.host.toLowerCase();
    if (!hosts.includes(host) && !hosts.includes(u.hostname.toLowerCase())) {
      throw new Error(`host ${host} is not in integrations.allowHosts (${hosts.join(', ')})`);
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('URL must point at a repository (…/owner/repo)');
    owner = parts[0];
    repo = parts[1].replace(/\.git$/, '');
    // GitHub/GitLab/Forgejo browse URLs: …/tree/<ref>/<sub/path> (GitLab adds a "-" segment).
    const rest = parts.slice(2);
    if (rest[0] === '-') rest.shift();
    if ((rest[0] === 'tree' || rest[0] === 'src' || rest[0] === 'blob') && rest[1]) {
      if (rest[0] === 'src' && rest[1] === 'branch') rest.splice(1, 1);   // forgejo: /src/branch/<ref>
      ref = ref || rest[1];
      const sub = rest.slice(2).join('/');
      if (sub) subpath = rest[0] === 'blob' ? path.posix.dirname(sub) : sub;
      if (subpath === '.') subpath = undefined;
    }
    url = `${u.protocol}//${u.host}/${owner}/${repo}.git`;
  }

  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || owner.startsWith('.') || repo.startsWith('.')) {
    throw new Error('invalid owner/repo name');
  }
  if (ref !== undefined && (!/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) || ref.startsWith('-') || ref.includes('..'))) {
    throw new Error('invalid ref');
  }
  if (subpath !== undefined) {
    const norm = path.posix.normalize(subpath).replace(/^\/+|\/+$/g, '');
    if (!norm || norm.startsWith('..') || norm.split('/').some(s => s === '..' || s === '.git')) throw new Error('invalid sub-path');
    subpath = norm;
  }
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  let id = `${slug(owner)}__${slug(repo)}`;
  if (subpath) id += `__${slug(path.posix.basename(subpath))}`;
  id = id.slice(0, 64);
  return { url, host, owner, repo, ref, subpath, id };
}

/** Run git without a shell, with prompts disabled (a private repo must fail, not hang). */
function git(args: string[], cwd?: string, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_LFS_SKIP_SMUDGE: '1' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-3).join(' ').slice(0, 400)));
      else resolve(stdout.toString().trim());
    });
  });
}

export function dirSizeBytes(dir: string, cap: number): number {
  let total = 0;
  const walk = (d: string) => {
    if (total > cap) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
      if (total > cap) return;
    }
  };
  walk(dir);
  return total;
}

function readText(p: string, max = 256 * 1024): string | undefined {
  try { const st = fs.statSync(p); if (!st.isFile() || st.size > max) return undefined; return fs.readFileSync(p, 'utf-8'); }
  catch { return undefined; }
}

function readJson(p: string): any {
  const t = readText(p);
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/** First prose paragraph of a README (skips headings, badges, HTML, code). */
function readmeBlurb(text: string): string | undefined {
  const body = text.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, ' ');
  for (const para of body.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p || p.startsWith('#') || p.startsWith('[![') || p.startsWith('![') || p.startsWith('|') || p.startsWith('>')) continue;
    const clean = p.replace(/\s+/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    if (clean.length >= 20) return clean.slice(0, 300);
  }
  return undefined;
}

function findSkillFiles(root: string, maxDepth = 5, cap = 50): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (out.length >= cap || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) { out.push(path.join(d, 'SKILL.md')); return; }
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return out;
}

function skillFromFile(file: string, fallbackName: string, wrapper = false): DetectedSkill | null {
  const text = readText(file);
  if (text === undefined) return null;
  let data: Record<string, any> = {};
  try { data = matter(text).data || {}; } catch { /* malformed frontmatter */ }
  const rawName = String(data.name || fallbackName || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  if (!SKILL_NAME_RE.test(rawName)) return null;
  const description = typeof data.description === 'string' ? data.description.trim().slice(0, 300) : undefined;
  return { name: rawName, dir: path.dirname(file), description, ...(wrapper ? { wrapper: true } : {}) };
}

/** Classify a checked-out tree. Pure filesystem reads — never executes anything. */
export function detectRepo(root: string, wrapperDir?: string): Detection {
  const det: Detection = { kinds: [], skills: [] };
  const pkg = readJson(path.join(root, 'package.json'));
  const pyproject = readText(path.join(root, 'pyproject.toml')) || '';
  const readmeName = ['README.md', 'readme.md', 'README.MD', 'README', 'README.rst'].find(n => fs.existsSync(path.join(root, n)));
  const readme = readmeName ? readText(path.join(root, readmeName)) || '' : '';

  // Skills (repo's own SKILL.md files, then agent-written wrappers).
  const seen = new Set<string>();
  for (const f of findSkillFiles(root)) {
    const s = skillFromFile(f, path.basename(path.dirname(f)));
    if (s && !seen.has(s.name)) { seen.add(s.name); det.skills.push(s); }
  }
  if (wrapperDir && fs.existsSync(wrapperDir)) {
    for (const f of findSkillFiles(wrapperDir, 2)) {
      const s = skillFromFile(f, path.basename(path.dirname(f)), true);
      if (s && !seen.has(s.name)) { seen.add(s.name); det.skills.push(s); }
    }
  }
  if (det.skills.length) det.kinds.push('skill');

  // Static web app: a committed index.html in a conventional place.
  for (const sub of ['', 'dist', 'build', 'docs', 'public', 'site', 'www', 'demo', 'out']) {
    const entry = path.join(root, sub, 'index.html');
    if (fs.existsSync(entry)) { det.web = { root: sub, entry: 'index.html' }; break; }
  }
  if (det.web) det.kinds.push('web');

  // MCP server.
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (deps['@modelcontextprotocol/sdk'] || /(^|["'\s])(mcp|fastmcp)(\[|[<>=~ "']|$)/m.test(pyproject) || /"mcpServers"\s*:/.test(readme)) {
    det.mcp = pkg?.name ? `npm package "${pkg.name}" — see README for its mcpServers entry`
      : pyproject ? 'Python MCP server (pyproject) — see README for its launch command'
      : 'README documents an mcpServers entry';
    det.kinds.push('mcp');
  }

  // CLI tool.
  if (pkg?.bin) det.cli = `npm bin: ${typeof pkg.bin === 'string' ? pkg.name : Object.keys(pkg.bin).join(', ')}`;
  else if (/\[project\.scripts\]|\[tool\.poetry\.scripts\]/.test(pyproject)) det.cli = 'Python console script (pyproject [project.scripts])';
  else if (fs.existsSync(path.join(root, 'Cargo.toml')) && (fs.existsSync(path.join(root, 'src', 'main.rs')) || /\[\[bin\]\]/.test(readText(path.join(root, 'Cargo.toml')) || ''))) det.cli = 'Rust binary (cargo install --path .)';
  else if (fs.existsSync(path.join(root, 'go.mod')) && (fs.existsSync(path.join(root, 'main.go')) || fs.existsSync(path.join(root, 'cmd')))) det.cli = 'Go binary (go install ./...)';
  if (det.cli) det.kinds.push('cli');

  if (!det.kinds.length) det.kinds.push('library');

  det.language = pkg ? 'JavaScript/TypeScript' : pyproject || fs.existsSync(path.join(root, 'requirements.txt')) ? 'Python'
    : fs.existsSync(path.join(root, 'Cargo.toml')) ? 'Rust' : fs.existsSync(path.join(root, 'go.mod')) ? 'Go' : undefined;
  const pyDesc = pyproject.match(/^\s*description\s*=\s*"([^"]{5,300})"/m)?.[1];
  det.description = (typeof pkg?.description === 'string' && pkg.description.trim()) || pyDesc || readmeBlurb(readme)
    || det.skills[0]?.description;
  if (det.description) det.description = det.description.slice(0, 300);
  const licFile = fs.existsSync(root) ? fs.readdirSync(root).find(n => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(n)) : undefined;
  const licLine = licFile ? (readText(path.join(root, licFile)) || '').split('\n').map(l => l.trim()).find(Boolean) : undefined;
  det.license = (typeof pkg?.license === 'string' ? pkg.license : undefined) || licLine?.slice(0, 80);
  return det;
}

export interface AddOptions {
  /** Install right after fetching (skipped when quarantined unless force). */
  install?: boolean;
  /** Install even with CRITICAL audit findings (operator override, recorded). */
  force?: boolean;
}

/** One process-wide instance (the HTTP API and the per-request MCP servers share
 *  its in-flight guard, so two concurrent fetches of one repo can't interleave). */
let shared: Integrations | null = null;
let sharedCfg: IntegrationsConfig | undefined;
export function sharedIntegrations(cfg?: IntegrationsConfig): Integrations {
  if (!shared || sharedCfg !== cfg) { shared = new Integrations(cfg || {}); sharedCfg = cfg; }
  return shared;
}

export class Integrations {
  readonly root: string;
  readonly registryFile: string;
  readonly skillsHome: string;
  readonly clientSkillDirs: string[];
  readonly allowHosts: string[];
  readonly portalFile: string;
  private readonly allowFileUrls: boolean;
  private inflight = new Set<string>();

  constructor(readonly cfg: IntegrationsConfig = {}, opts: { portalFile?: string; allowFileUrls?: boolean } = {}) {
    this.root = expand(cfg.root || '~/.cowork/integrations');
    this.registryFile = expand(cfg.registry || '~/.cowork/integrations.json');
    this.skillsHome = expand(cfg.skillsHome || '~/.agents/skills');
    this.clientSkillDirs = (cfg.clientSkillDirs || defaultClientSkillDirs()).map(expand);
    this.allowHosts = cfg.allowHosts?.length ? cfg.allowHosts : DEFAULT_ALLOWED_HOSTS;
    this.portalFile = opts.portalFile || activePortalPath();
    this.allowFileUrls = !!opts.allowFileUrls;
  }

  // ── registry ──────────────────────────────────────────────────────────────
  private load(): RegistryFile {
    try {
      const doc = JSON.parse(fs.readFileSync(this.registryFile, 'utf-8'));
      if (doc && typeof doc === 'object' && doc.integrations) return doc;
    } catch { /* missing or corrupt → empty */ }
    return { version: 1, integrations: {} };
  }
  private save(doc: RegistryFile): void {
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
    const tmp = `${this.registryFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, this.registryFile);
  }
  private put(entry: Integration): Integration {
    const doc = this.load();
    doc.integrations[entry.id] = entry;
    this.save(doc);
    return entry;
  }

  list(): Integration[] {
    return Object.values(this.load().integrations).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }
  get(id: string): Integration | undefined { return this.load().integrations[id]; }

  parse(input: string): RepoRef {
    return parseRepoRef(input, { allowHosts: this.allowHosts, allowFileUrls: this.allowFileUrls });
  }

  /** Where the agent-written wrapper skill for a non-skill repo lives (survives updates). */
  wrapperDir(id: string): string { return path.join(this.root, `${id}.wrapper`); }
  /** Absolute dir of the integrated part of a clone (repo root or its sub-path). */
  scanRoot(entry: Pick<Integration, 'dir' | 'subpath'>): string {
    return entry.subpath ? path.join(entry.dir, entry.subpath) : entry.dir;
  }

  // ── fetch + detect + audit ───────────────────────────────────────────────
  /** Clone (or re-clone) a repo, classify and audit it. Never runs repo code. */
  async add(input: string, opts: AddOptions = {}): Promise<Integration> {
    const ref = this.parse(input);
    if (this.inflight.has(ref.id)) throw new Error(`${ref.id} is already being fetched`);
    this.inflight.add(ref.id);
    try {
      const prev = this.get(ref.id);
      const dir = path.join(this.root, ref.id);
      await this.clone(ref, dir);
      const entry = this.analyse({
        id: ref.id, source: ref.host === 'github.com' ? `${ref.owner}/${ref.repo}` : `${ref.host}/${ref.owner}/${ref.repo}`,
        input: input.trim(), url: ref.url, ref: ref.ref, subpath: ref.subpath, dir,
        addedAt: prev?.addedAt || new Date().toISOString(),
        installed: prev?.installed || { skills: [] },
      });
      entry.commit = await git(['rev-parse', '--short=12', 'HEAD'], dir).catch(() => undefined);
      this.put(entry);
      // An update of an installed integration refreshes the installed copies too,
      // but only if it still passes the audit (a poisoned update stays quarantined).
      const wasInstalled = !!(prev && (prev.installed.skills.length || prev.installed.web));
      if (opts.install || wasInstalled) {
        if (entry.status === 'quarantined' && !opts.force) return entry;
        // Keep a curated subset curated: refresh only the skills that were installed.
        const skills = !opts.install && prev?.installed.skills.length ? prev.installed.skills.map(s => s.name).filter(n => entry.detected.skills.some(d => d.name === n)) : undefined;
        return this.install(entry.id, { force: opts.force, skills });
      }
      return entry;
    } finally {
      this.inflight.delete(ref.id);
    }
  }

  private async clone(ref: RepoRef, dir: string): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${dir}.tmp-${Date.now()}`;
    const args = ['clone', '--depth', '1', '--single-branch', '--no-tags'];
    if (ref.ref) args.push('--branch', ref.ref);
    args.push('--', ref.url, tmp);
    try {
      await git(args);
      const capMB = this.cfg.maxRepoMB ?? 3072;
      if (dirSizeBytes(tmp, capMB * 1024 * 1024) > capMB * 1024 * 1024) throw new Error(`repository is larger than integrations.maxRepoMB (${capMB} MB)`);
      if (ref.subpath && !fs.existsSync(path.join(tmp, ref.subpath))) throw new Error(`sub-path "${ref.subpath}" not found in the repository`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  /** (Re-)detect and (re-)audit an entry from what is on disk now. */
  private analyse(base: Pick<Integration, 'id' | 'source' | 'input' | 'url' | 'ref' | 'subpath' | 'dir' | 'addedAt' | 'installed'>): Integration {
    const root = this.scanRoot(base);
    const detected = detectRepo(root, this.wrapperDir(base.id));
    const report = auditPath(root, { allow: this.cfg.auditAllow, maxFiles: 3000 });
    const wrap = fs.existsSync(this.wrapperDir(base.id)) ? auditPath(this.wrapperDir(base.id), { allow: this.cfg.auditAllow }) : null;
    const findings = [...report.findings, ...(wrap?.findings.map(f => ({ ...f, file: `<wrapper>/${f.file}` })) || [])];
    const counts = { critical: 0, high: 0, medium: 0 } as Record<Severity, number>;
    for (const f of findings) counts[f.severity]++;
    const verdict: AuditVerdict = counts.critical ? 'quarantine' : counts.high ? 'warn' : 'pass';
    const isInstalled = base.installed.skills.length > 0 || !!base.installed.web;
    return {
      ...base,
      fetchedAt: new Date().toISOString(),
      status: verdict === 'quarantine' ? 'quarantined' : isInstalled ? 'installed' : 'fetched',
      detected,
      audit: {
        verdict, counts, scannedFiles: report.scannedFiles + (wrap?.scannedFiles || 0),
        findings: findings.slice(0, 100), at: new Date().toISOString(),
      },
    };
  }

  /** Re-detect + re-audit without fetching (picks up an agent-written wrapper skill). */
  rescan(id: string): Integration {
    const e = this.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    const next = this.analyse(e);
    next.commit = e.commit;
    return this.put(next);
  }

  /** Pull the latest commit (same ref) and re-audit; refreshes installed copies. */
  async update(id: string): Promise<Integration> {
    const e = this.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    return this.add(e.input || e.url);
  }

  // ── install / uninstall ──────────────────────────────────────────────────
  /** `skills` limits a skill install to the named detected skills (curated subsets of big skill packs). */
  install(id: string, opts: { force?: boolean; kinds?: IntegrationKind[]; skills?: string[] } = {}): Integration {
    const e = this.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    const pick = opts.skills?.length ? new Set(opts.skills) : null;
    if (pick) {
      const unknown = [...pick].filter(n => !e.detected.skills.some(s => s.name === n));
      if (unknown.length) throw new Error(`${id} has no skill(s) named ${unknown.join(', ')} — detected: ${e.detected.skills.map(s => s.name).join(', ')}`);
    }
    if (e.audit.verdict === 'quarantine' && !opts.force) {
      throw new Error(`${id} is quarantined (${e.audit.counts.critical} critical audit finding(s)) — review the findings; installing requires force`);
    }
    const want = new Set(opts.kinds?.length ? opts.kinds : e.detected.kinds);
    const notes: string[] = [];
    const installed: Integration['installed'] = { skills: [...e.installed.skills], web: e.installed.web };

    if (want.has('skill')) {
      for (const s of e.detected.skills) {
        if (pick && !pick.has(s.name)) continue;
        const res = this.installSkill(e, s);
        if (typeof res === 'string') notes.push(res);
        else installed.skills = [...installed.skills.filter(x => x.name !== res.name), res];
      }
    }
    if (want.has('web') && e.detected.web) {
      installed.web = this.registerPortal(e);
    }
    if ((want.has('mcp') || want.has('cli') || want.has('library')) && !e.detected.skills.length) {
      notes.push('No SKILL.md yet — use "Wrap with an agent" to have an engineering agent write one, then Rescan.');
    }
    const next: Integration = {
      ...e, installed, notes,
      status: installed.skills.length || installed.web ? 'installed' : e.status === 'quarantined' ? 'quarantined' : 'fetched',
      audit: { ...e.audit, ...(e.audit.verdict === 'quarantine' ? { overridden: true } : {}) },
    };
    return this.put(next);
  }

  /** Copy one skill into the shared skills home and link it into each client dir. */
  private installSkill(e: Integration, s: DetectedSkill): { name: string; target: string; links: string[] } | string {
    const target = path.join(this.skillsHome, s.name);
    const ours = this.list().some(i => i.installed.skills.some(x => x.target === target));
    if (fs.existsSync(target) && !ours) {
      return `skill "${s.name}" already exists at ${target} (not installed by cowork integrations) — left untouched`;
    }
    fs.mkdirSync(this.skillsHome, { recursive: true });
    const tmp = `${target}.tmp-${Date.now()}`;
    fs.cpSync(s.dir, tmp, {
      recursive: true, dereference: false,
      filter: (src) => !SKIP_DIRS.has(path.basename(src)) && !path.basename(src).endsWith('.wrapper'),
    });
    // Provenance stamp so a human browsing ~/.agents/skills knows where it came from.
    fs.writeFileSync(path.join(tmp, '.cowork-integration.json'), JSON.stringify({ id: e.id, source: e.source, commit: e.commit, installedAt: new Date().toISOString() }, null, 2));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);

    const links: string[] = [];
    for (const dir of this.clientSkillDirs) {
      if (!fs.existsSync(dir)) continue;   // client not present on this host
      if (path.resolve(dir) === path.resolve(this.skillsHome)) continue;
      const link = path.join(dir, s.name);
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(link); } catch { /* absent */ }
      if (st) {
        if (st.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === target) { links.push(link); }
        continue;   // a real dir / foreign link with that name: never clobber
      }
      fs.symlinkSync(path.relative(dir, target), link);
      links.push(link);
    }
    return { name: s.name, target, links };
  }

  private registerPortal(e: Integration): { portalKey: string; url: string } {
    const portalKey = `plugin-${e.id}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    const url = `/plugins/${e.id}/`;
    let doc: any = {};
    try { doc = JSON.parse(fs.readFileSync(this.portalFile, 'utf-8')); } catch { /* new file */ }
    if (!doc || typeof doc !== 'object') doc = {};
    doc.services = doc.services && typeof doc.services === 'object' ? doc.services : {};
    doc.services[portalKey] = {
      ...(doc.services[portalKey] || {}),
      url, label: e.source.split('/').pop(), description: (e.detected.description || `Web plugin from ${e.source}`).slice(0, 500),
      icon: 'puzzle', category: 'Explore', enabled: true, probe: false,
    };
    if (Array.isArray(doc.categories) && !doc.categories.includes('Explore')) doc.categories.push('Explore');
    fs.mkdirSync(path.dirname(this.portalFile), { recursive: true });
    fs.writeFileSync(this.portalFile, JSON.stringify(doc, null, 2) + '\n');
    return { portalKey, url };
  }

  private unregisterPortal(portalKey: string): void {
    try {
      const doc = JSON.parse(fs.readFileSync(this.portalFile, 'utf-8'));
      if (doc?.services?.[portalKey]) {
        delete doc.services[portalKey];
        fs.writeFileSync(this.portalFile, JSON.stringify(doc, null, 2) + '\n');
      }
    } catch { /* nothing to remove */ }
  }

  /** Remove exactly what install() created. `purge` also deletes the clone + wrapper + registry entry. */
  uninstall(id: string, opts: { purge?: boolean } = {}): Integration | null {
    const e = this.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    for (const s of e.installed.skills) {
      for (const link of s.links) {
        try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* gone */ }
      }
      // Only delete a target we stamped.
      if (fs.existsSync(path.join(s.target, '.cowork-integration.json'))) fs.rmSync(s.target, { recursive: true, force: true });
    }
    if (e.installed.web) this.unregisterPortal(e.installed.web.portalKey);
    const doc = this.load();
    if (opts.purge) {
      fs.rmSync(e.dir, { recursive: true, force: true });
      fs.rmSync(this.wrapperDir(id), { recursive: true, force: true });
      delete doc.integrations[id];
      this.save(doc);
      return null;
    }
    const next: Integration = { ...e, installed: { skills: [] }, status: e.audit.verdict === 'quarantine' ? 'quarantined' : 'fetched', notes: [] };
    doc.integrations[id] = next;
    this.save(doc);
    return next;
  }

  /** Absolute web root to serve for /plugins/<id>/ (only once installed as web). */
  webRoot(id: string): string | null {
    const e = this.get(id);
    if (!e?.installed.web || !e.detected.web) return null;
    const root = path.join(this.scanRoot(e), e.detected.web.root);
    return fs.existsSync(root) ? root : null;
  }

  /**
   * Draft a cowork task asking an engineering agent to wrap a tool / MCP server /
   * library as an agent skill. The agent writes ONLY into the wrapper dir (and a
   * venv/node_modules inside the clone); a rescan then installs the wrapper.
   */
  buildWrapTask(id: string, opts: { brain?: string; notes?: string } = {}) {
    const e = this.get(id);
    if (!e) throw new Error(`unknown integration ${id}`);
    const name = e.id.split('__')[1] || e.id;
    const top = e.audit.findings.filter(f => f.severity !== 'medium').slice(0, 15)
      .map(f => `- [${f.severity}] ${f.rule} — ${f.file}:${f.line} \`${f.excerpt.replace(/`/g, "'")}\``);
    const description = [
      `# Integrate ${e.source} into cowork as an agent skill`,
      ``,
      `The repository is already cloned (shallow, read-only use) at \`${this.scanRoot(e)}\` (commit ${e.commit || '?'}).`,
      `Detected: ${e.detected.kinds.join(', ')}${e.detected.language ? ` · ${e.detected.language}` : ''}${e.detected.license ? ` · license: ${e.detected.license}` : ''}.`,
      e.detected.description ? `Summary: ${e.detected.description}` : '',
      e.detected.mcp ? `MCP: ${e.detected.mcp}` : '',
      e.detected.cli ? `CLI: ${e.detected.cli}` : '',
      ``,
      `## Static audit: ${e.audit.verdict.toUpperCase()} (${e.audit.counts.critical} critical / ${e.audit.counts.high} high / ${e.audit.counts.medium} medium)`,
      ...(top.length ? top : ['- no high/critical findings']),
      ``,
      `## What to deliver`,
      `1. Read the README and source. Decide the safest way to run it locally (prefer a venv / local node_modules INSIDE the clone dir; never \`sudo\`, never global installs, never run code the audit flagged as critical).`,
      `2. Install and smoke-test it with one real, harmless invocation. Record the exact commands.`,
      `3. Write an agent skill at \`${path.join(this.wrapperDir(e.id), name)}/SKILL.md\` with YAML frontmatter (\`name: ${name}\`, \`description: <when an agent should use it>\`) and a body that teaches any agent how to invoke the tool (absolute paths to the installed binary/venv, inputs, outputs, failure modes, credential requirements — names only, never secret values).`,
      e.detected.mcp ? `4. It is an MCP server: include in the skill the exact \`mcpServers\` JSON snippet (command + args) for Claude Code / Antigravity, but do NOT edit any client config yourself.` : `4. If it could be useful as a cowork MCP tool, say so in your report — do not modify the cowork server.`,
      `5. Write ONLY inside the wrapper dir \`${this.wrapperDir(e.id)}\`, the clone dir (for a venv / node_modules) and your artifacts dir. When done, call the cowork MCP tool \`integrations\` with action "rescan" then "install" for id \`${e.id}\` (or tell the operator to press Rescan → Install on the Integrations page). The install is re-audited; a CRITICAL finding keeps it quarantined for human review.`,
      `6. Report: what the tool does, install commands, the smoke-test output, and any risk you found.`,
      opts.notes ? `\n## Operator notes\n${opts.notes}` : '',
    ].filter(l => l !== '').join('\n');
    return {
      title: `🧩 Integrate ${e.source} as a cowork skill`,
      description,
      tags: ['integration', 'engineering'],
      context: { integrationId: e.id, ...(opts.brain ? { brain: opts.brain } : {}) },
    };
  }
}
