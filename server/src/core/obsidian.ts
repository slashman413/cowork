import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ObsidianConfig } from '../types.js';

/**
 * Read/search access to a shared Obsidian Vault, exposed to every brain as a
 * common knowledge base.
 *
 * WHY THIS LIVES IN THE SERVER: the vault is a plain folder of Markdown on the
 * server host. A LOCAL brain (same machine) could read it straight off disk at
 * `vaultPath`, but a REMOTE brain can't — so the server owns one read path and
 * offers it two ways over the network: the /api/obsidian/* REST endpoints and
 * the obsidian_* MCP tools (both back onto this class). Local brains may still
 * hit the filesystem directly; `root` is reported to them via obsidian_info so
 * they know where it is.
 *
 * READ-ONLY BY DESIGN: nothing here writes to the vault. It is a knowledge base
 * the brains consult, not a scratch space — task output belongs in the task's
 * artifacts dir (see Cowork Operating Rules §1).
 */

// Directories never worth scanning: VCS, Obsidian's own config/cache, trash,
// and dependency folders that occasionally end up inside a vault.
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.stfolder', '.smart-env']);
// Guardrails so a pathological vault can't wedge a request.
const MAX_FILES = 20000;          // ceiling on notes walked per request
const MAX_READ_BYTES = 2_000_000; // skip / truncate notes larger than ~2MB
const SNIPPET_RADIUS = 120;       // chars of context around a search hit

export interface ObsidianNote {
  /** Vault-relative POSIX path, e.g. "law/contracts/nda.md". */
  path: string;
  /** Note name without the .md extension. */
  title: string;
  size: number;
  mtime: string;
}

export interface ObsidianSearchHit {
  path: string;
  title: string;
  /** Higher = more/earlier matches (title matches weighted heaviest). */
  score: number;
  /** First matching line, trimmed to a window around the term. */
  snippet: string;
  /** 1-indexed line of the first match, or 0 for a title-only match. */
  line: number;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export class ObsidianVault {
  /** Absolute, resolved vault root. */
  readonly root: string;

  constructor(vaultPath: string) {
    this.root = path.resolve(expandHome(vaultPath));
  }

  /** True when the configured path exists and is a directory. */
  available(): boolean {
    try { return fs.statSync(this.root).isDirectory(); } catch { return false; }
  }

  /** Recursively collect vault-relative paths of every .md note (skipping
   *  SKIP_DIRS and hidden folders), capped at MAX_FILES. */
  private walk(): string[] {
    const out: string[] = [];
    const stack: string[] = [this.root];
    while (stack.length && out.length < MAX_FILES) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          stack.push(abs);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          out.push(path.relative(this.root, abs).split(path.sep).join('/'));
          if (out.length >= MAX_FILES) break;
        }
      }
    }
    return out.sort();
  }

  /** List notes, optionally restricted to a folder prefix (vault-relative). */
  list(folder?: string): ObsidianNote[] {
    const prefix = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';
    const notes: ObsidianNote[] = [];
    for (const rel of this.walk()) {
      if (prefix && !rel.startsWith(prefix)) continue;
      let size = 0, mtime = '';
      try {
        const st = fs.statSync(path.join(this.root, rel));
        size = st.size; mtime = st.mtime.toISOString();
      } catch { /* raced deletion — still list it */ }
      notes.push({ path: rel, title: path.basename(rel).replace(/\.md$/i, ''), size, mtime });
    }
    return notes;
  }

  /**
   * Resolve a caller-supplied note path to an absolute path INSIDE the vault, or
   * null if it escapes the root / doesn't exist. Accepts a path with or without
   * the .md extension (Obsidian links routinely omit it). This is the single
   * choke point that makes read() safe against path traversal.
   */
  private resolveNote(rel: string): string | null {
    if (!rel || typeof rel !== 'string') return null;
    const clean = rel.replace(/^\/+/, '');
    for (const candidate of [clean, clean.endsWith('.md') ? clean : `${clean}.md`]) {
      const abs = path.resolve(this.root, candidate);
      if (abs !== this.root && !abs.startsWith(this.root + path.sep)) continue; // escaped root
      try { if (fs.statSync(abs).isFile()) return abs; } catch { /* try next */ }
    }
    return null;
  }

  /** Read one note's full content. Returns null if it's missing or escapes the
   *  vault. Content larger than MAX_READ_BYTES is truncated with a marker. */
  read(rel: string): { path: string; title: string; content: string; truncated: boolean } | null {
    const abs = this.resolveNote(rel);
    if (!abs) return null;
    let content = fs.readFileSync(abs, 'utf-8');
    let truncated = false;
    if (content.length > MAX_READ_BYTES) {
      content = content.slice(0, MAX_READ_BYTES) + '\n\n…[truncated]';
      truncated = true;
    }
    const relOut = path.relative(this.root, abs).split(path.sep).join('/');
    return { path: relOut, title: path.basename(relOut).replace(/\.md$/i, ''), content, truncated };
  }

  /**
   * Case-insensitive full-text search across note titles and bodies. Scores a
   * title match heaviest, then each body occurrence, and returns the top `limit`
   * hits with a snippet around the first body match. Plain substring matching —
   * no index — which is fine at vault scale (hundreds–thousands of notes) and
   * keeps the feature dependency-free.
   */
  search(query: string, limit = 20): ObsidianSearchHit[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const hits: ObsidianSearchHit[] = [];
    for (const rel of this.walk()) {
      const title = path.basename(rel).replace(/\.md$/i, '');
      const titleMatch = title.toLowerCase().includes(q);
      let body = '';
      try {
        const abs = path.join(this.root, rel);
        if (fs.statSync(abs).size > MAX_READ_BYTES) continue;
        body = fs.readFileSync(abs, 'utf-8');
      } catch { continue; }
      const lower = body.toLowerCase();
      const first = lower.indexOf(q);
      if (!titleMatch && first < 0) continue;

      let occurrences = 0, idx = first;
      while (idx >= 0) { occurrences++; idx = lower.indexOf(q, idx + q.length); }

      let snippet = '', line = 0;
      if (first >= 0) {
        line = body.slice(0, first).split('\n').length;
        const start = Math.max(0, first - SNIPPET_RADIUS);
        const end = Math.min(body.length, first + q.length + SNIPPET_RADIUS);
        snippet = (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? '…' : '');
      } else {
        snippet = body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_RADIUS * 2);
      }

      hits.push({ path: rel, title, score: (titleMatch ? 1000 : 0) + occurrences, snippet, line });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(200, limit)));
  }

  /** Summary for status endpoints / the info MCP tool. */
  info(): { available: boolean; vaultPath: string; noteCount: number } {
    const available = this.available();
    return { available, vaultPath: this.root, noteCount: available ? this.walk().length : 0 };
  }
}

/** Build a vault handle from config, or null when Obsidian is unconfigured or
 *  disabled. Cheap (holds a path); callers construct per request. */
export function getObsidianVault(cfg: ObsidianConfig | undefined): ObsidianVault | null {
  if (!cfg || cfg.enabled === false || !cfg.vaultPath) return null;
  return new ObsidianVault(cfg.vaultPath);
}
