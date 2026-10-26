import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { globSync } from 'glob';
import type { AgentCard } from '../types.js';

/**
 * Parse an agent .md into { data, content }, tolerating frontmatter that isn't
 * strictly valid YAML. Upstream agent files sometimes contain an unquoted `": "`
 * inside a value (e.g. `description: … great DX: intuitive command design`),
 * which is a YAML syntax error — gray-matter throws and the agent would silently
 * vanish from the roster. The fallback reads the frontmatter block line by line,
 * splitting each on its FIRST colon, so such an agent still loads.
 */
function parseAgentFile(raw: string): { data: Record<string, any>; content: string } {
  const hasFrontmatter = /^---\r?\n/.test(raw);
  try {
    const p = matter(raw);
    // gray-matter caches a HALF-BUILT file object before a YAML error is thrown:
    // the first call throws, but every later call on the same content returns that
    // cached result — data:{} with content = the ENTIRE raw file (frontmatter and
    // all). Never trust the throw alone; a file that clearly has frontmatter yet
    // yielded no keys did not really parse, so fall through to the lenient reader.
    if (!hasFrontmatter || Object.keys(p.data || {}).length > 0) {
      return { data: p.data || {}, content: p.content };
    }
  } catch { /* fall through to the lenient reader below */ }
  {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!m) return { data: {}, content: raw };
    const data: Record<string, any> = {};
    for (const line of m[1].split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;  // skip blanks, comments, nested
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) data[key] = value;
    }
    return { data, content: m[2] };
  }
}

export class Roster {
  private repoPath: string;
  private agents: AgentCard[] = [];
  private divisions: any = {};
  private loadedAt = 0;
  // Lightweight cache: every roster query (dashboard, classifier, roster views)
  // calls loadAll, so we scan the agency-agents dir at most once per TTL instead
  // of on every call. A short TTL keeps near-live propagation — a newly added
  // agent or a submodule bump shows up within the window without a server
  // restart — while hot paths just return the in-memory array. Override with
  // COWORK_ROSTER_TTL_MS (0 = always rescan).
  private ttlMs = process.env.COWORK_ROSTER_TTL_MS !== undefined
    ? Math.max(0, Number(process.env.COWORK_ROSTER_TTL_MS) || 0)
    : 30_000;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  public loadAll(): AgentCard[] {
    if (this.loadedAt && Date.now() - this.loadedAt < this.ttlMs) return this.agents;
    return this.scan();
  }

  /** Rescan the agency-agents directory and refresh the cache. Builds into a
   *  local array so a mid-scan error never leaves a partial cache exposed. */
  private scan(): AgentCard[] {
    const agents: AgentCard[] = [];

    if (!fs.existsSync(this.repoPath)) {
      console.warn(`Agency agents repo not found at ${this.repoPath}`);
      this.agents = agents;
      this.loadedAt = Date.now();
      return agents;
    }

    const divisionsPath = path.join(this.repoPath, 'divisions.json');
    if (fs.existsSync(divisionsPath)) {
      try {
        this.divisions = JSON.parse(fs.readFileSync(divisionsPath, 'utf-8'));
      } catch (e) {
        console.error('Failed to parse divisions.json', e);
      }
    }

    // Agents live in division subdirectories; top-level *.md are repo docs
    // (README, SECURITY, CONTRIBUTING, …) and examples/ holds sample output.
    const agentFiles = globSync('*/**/*.md', {
      cwd: this.repoPath,
      ignore: ['docs/**', 'examples/**', 'scripts/**', '**/README.md']
    });

    for (const file of agentFiles) {
      const fullPath = path.join(this.repoPath, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = parseAgentFile(content);

        const slug = path.basename(file, '.md');
        const division = path.dirname(file).split(path.sep)[0] || 'unknown';
        const divisionMeta = this.divisions[division] || {};

        agents.push({
          slug: parsed.data.slug || slug,
          name: parsed.data.name || slug,
          description: parsed.data.description || '',
          emoji: parsed.data.emoji,
          color: parsed.data.color,
          vibe: parsed.data.vibe,
          division: division,
          divisionLabel: divisionMeta.label || division,
          divisionIcon: divisionMeta.icon,
          sourcePath: fullPath,
          platforms: parsed.data.platforms || []
        });
      } catch (e) {
        console.error(`Failed to parse agent file: ${file}`, e);
      }
    }

    this.agents = agents;
    this.loadedAt = Date.now();
    return this.agents;
  }

  public search(query: string): AgentCard[] {
    this.loadAll();
    const lowerQuery = query.toLowerCase();
    return this.agents.filter(a => 
      a.name.toLowerCase().includes(lowerQuery) || 
      a.description.toLowerCase().includes(lowerQuery)
    );
  }

  public getByDivision(division: string): AgentCard[] {
    this.loadAll();
    return this.agents.filter(a => a.division === division);
  }

  public getDivisions(): any {
    this.loadAll();
    return this.divisions;
  }

  /** List of division ids that actually have agents (for the two-stage router). */
  public divisionIds(): string[] {
    this.loadAll();
    return [...new Set(this.agents.map(a => a.division).filter((d): d is string => !!d))].sort();
  }

  /** Full persona (frontmatter + body) of a roster agent by slug, plus its
   *  division — injected as the system prompt when that agent runs a task. */
  public getPersona(slug: string): { name: string; division: string; persona: string; sourcePath: string } | null {
    this.loadAll();
    const card = this.agents.find(a => a.slug === slug);
    if (!card) return null;
    try {
      // Strip the YAML frontmatter — the markdown BODY is the actual persona/system
      // prompt. The raw `---` header would otherwise start the prompt and get parsed
      // as a CLI option (`unknown option '--- name: …'`) by positional-arg execs.
      const raw = fs.readFileSync(card.sourcePath, 'utf-8');
      const body = parseAgentFile(raw).content.trim();
      const persona = body || `You are ${card.name}. ${card.description}`.trim();
      return { name: card.name, division: card.division || 'unknown', persona, sourcePath: card.sourcePath };
    } catch {
      return null;
    }
  }

  /** Force an immediate rescan on the next query, bypassing the TTL. */
  public reload(): void {
    this.loadedAt = 0;
    this.loadAll();
  }
}
