/**
 * Lean `claude -p` profile for cowork runs.
 *
 * A bare `claude -p` loads the owner's whole interactive environment: ~270
 * user subagent types (~13k tokens in the Agent tool description), ~114 user
 * skills, user rules, and every user MCP server's deferred tool names and
 * instructions (rea, twstock, notebooklm, …). Measured on 2026-10-27 that is
 * ~45.7k prompt tokens before the task says anything; this profile cuts it to
 * ~33k. Over the previous 30 days, 1,309 cowork sessions made 0 Skill calls,
 * ~4 used a subagent, and used only the cowork + firecrawl MCP servers (1
 * twstock call) — so the dropped parts were almost pure overhead.
 *
 * How: `--setting-sources project,local` skips user-level agents/skills/rules
 * and user MCP config; we carry forward the few user settings that change
 * behaviour (env, model, effort), and re-add the MCP servers the task can use
 * via `--strict-mcp-config --mcp-config <file>`. Project CLAUDE.md files and
 * auto-memory still load. Both files hold the cowork API key / env values, so
 * they are written 0600 under ~/.cowork/run, never passed inline on argv.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeMcpConfig {
  /** MCP servers (names from ~/.claude.json) every task run gets. */
  always?: string[];
  /** Servers added only when the task text matches the regex (case-insensitive). */
  onDemand?: Record<string, string>;
}

export const DEFAULT_MCP: Required<ClaudeMcpConfig> = {
  always: ['cowork', 'firecrawl'],
  onDemand: {
    twstock: String.raw`twse|tpex|twstock|台股|股票|上市|上櫃|\betf\b|\bstocks?\b`,
    'notebooklm-mcp': String.raw`notebooklm|\bnlm\b`,
    rea: String.raw`reverse[- ]?engineer|decompil|disassembl|\brea\b|\.apk\b|firmware`,
  },
};

/** User settings that change how a run behaves; everything else (permissions,
 *  theme, plugins, UI flags) is irrelevant to a headless run. */
const CARRIED_SETTINGS = ['env', 'model', 'effortLevel', 'alwaysThinkingEnabled'];

/** Pick the MCP servers for a run. `taskText` null = no MCP at all (internal
 *  reasoning calls: router, verifier, achiever). */
export function selectMcpServers(
  all: Record<string, unknown>, taskText: string | null, cfg: ClaudeMcpConfig = {},
): Record<string, unknown> {
  if (taskText === null) return {};
  const always = cfg.always ?? DEFAULT_MCP.always;
  const onDemand = cfg.onDemand ?? DEFAULT_MCP.onDemand;
  const out: Record<string, unknown> = {};
  for (const name of always) if (all[name]) out[name] = all[name];
  for (const [name, re] of Object.entries(onDemand)) {
    if (!all[name] || out[name]) continue;
    try { if (new RegExp(re, 'i').test(taskText)) out[name] = all[name]; } catch { /* bad regex: skip */ }
  }
  return out;
}

/** True when the task explicitly needs the owner's skills or subagents, which
 *  only the full profile loads: it says "skill"/"subagent", or names an
 *  installed skill as `/name`. */
export function needsFullProfile(taskText: string, skillNames: string[]): boolean {
  if (/\b(skills?|sub-?agents?)\b/i.test(taskText)) return true;
  return skillNames.some(n => new RegExp(`(^|[\\s(\`"'])/${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/.-])`, 'i').test(taskText));
}

export interface ClaudeProfilePaths {
  home?: string;      // defaults to os.homedir()
  runDir?: string;    // where the 0600 settings/mcp files go
}

export class ClaudeProfile {
  private home: string;
  private runDir: string;
  private userCache: { mtime: number; mcp: Record<string, unknown> } | null = null;
  private skillCache: { at: number; names: string[] } | null = null;

  constructor(paths: ClaudeProfilePaths = {}) {
    this.home = paths.home ?? homedir();
    this.runDir = paths.runDir ?? join(this.home, '.cowork', 'run', 'claude-profile');
  }

  /** User-scope MCP servers from ~/.claude.json, or null when unreadable. */
  private userMcp(): Record<string, unknown> | null {
    const f = join(this.home, '.claude.json');
    try {
      const mtime = statSync(f).mtimeMs;
      if (this.userCache?.mtime !== mtime) {
        const servers = JSON.parse(readFileSync(f, 'utf8')).mcpServers;
        this.userCache = { mtime, mcp: servers && typeof servers === 'object' ? servers : {} };
      }
      return this.userCache.mcp;
    } catch { return null; }
  }

  skillNames(): string[] {
    if (this.skillCache && Date.now() - this.skillCache.at < 60_000) return this.skillCache.names;
    let names: string[] = [];
    try { names = readdirSync(join(this.home, '.claude', 'skills')); } catch { /* none */ }
    this.skillCache = { at: Date.now(), names };
    return names;
  }

  private carriedSettings(): Record<string, unknown> {
    try {
      const s = JSON.parse(readFileSync(join(this.home, '.claude', 'settings.json'), 'utf8'));
      return Object.fromEntries(CARRIED_SETTINGS.filter(k => s[k] !== undefined).map(k => [k, s[k]]));
    } catch { return {}; }
  }

  /** Write `data` as JSON to runDir/<prefix>-<hash>.json (0600, atomic) and return the path. */
  private writeRunFile(prefix: string, data: unknown): string {
    const body = JSON.stringify(data);
    const file = join(this.runDir, `${prefix}-${createHash('sha1').update(body).digest('hex').slice(0, 12)}.json`);
    if (!existsSync(file)) {
      mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, file);
    }
    return file;
  }

  /** Extra argv for a lean run, or [] to run with the full user profile.
   *  `taskText` = the task's own title/description (MCP + full-profile checks);
   *  null for internal reasoning calls, which get no MCP servers. */
  args(taskText: string | null, mcpCfg?: ClaudeMcpConfig): string[] {
    if (taskText !== null && needsFullProfile(taskText, this.skillNames())) return [];
    const all = this.userMcp();
    // Without the user MCP list we cannot re-add cowork/firecrawl, and
    // --setting-sources project,local would silently drop them: stay full.
    if (all === null) return [];
    try {
      const settings = this.writeRunFile('settings', this.carriedSettings());
      const mcp = this.writeRunFile('mcp', { mcpServers: selectMcpServers(all, taskText, mcpCfg) });
      return ['--setting-sources', 'project,local', '--settings', settings, '--strict-mcp-config', '--mcp-config', mcp];
    } catch { return []; }
  }
}
