import fs from 'fs';
import { execFileSync } from 'child_process';
import { splitThinkingSuffix } from './core/thinking.js';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { Config } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/ and dist/ both sit one level under server/, so ../../ is the repo root
// (relative paths in config resolve against it) from either runtime.
const rootDir = path.resolve(__dirname, '../../');

// The repo's config.json is a sanitized TEMPLATE only. The real per-server config
// lives outside the repo at ~/.cowork/config.json (override with COWORK_CONFIG), so
// personal host/agent settings are never committed and the server's live edits don't
// churn the repo. On first run we seed the user config from the repo template.
const REPO_TEMPLATE = path.resolve(rootDir, 'config.json');
export function activeConfigPath(): string {
  if (process.env.COWORK_CONFIG) return expandHome(process.env.COWORK_CONFIG);
  return path.join(os.homedir(), '.cowork', 'config.json');
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~')) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

function resolvePath(filepath: string): string {
  const expanded = expandHome(filepath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(rootDir, expanded);
}

const defaultConfig: Config = {
  server: {
    port: 6868,
    host: '127.0.0.1',
    name: 'cowork-mcp',
    version: '1.0.0',
    apiKey: null,
    corsOrigin: '*',
    tls: null
  },
  paths: {
    inbox: './inbox',
    artifacts: './artifacts',
    inputs: './inputs',
    status: './.status',
    decisions: './decisions',
    goals: './goals'
  },
  platforms: {},
  services: {},
  obsidian: {
    vaultPath: '~/Documents/Obsidian Vault',
    enabled: true
  },
  inbox: {
    autoArchiveDays: 30,
    purgeScheduledRunsAfterDays: 3,
    maxRetries: 3
  },
  orchestration: {
    enabled: false,
    maxConcurrent: 2,
    pollIntervalMs: 5000,
    taskTimeoutMs: 3000000,
    defaultRole: 'generalist',
    roleChains: {},
    defaultThinking: 'medium',
    roles: {},
    agents: {},
    classifier: {
      enabled: false,
      exec: 'hermes',
      model: 'qwen3.8-27b',
      fallbackRole: 'generalist',
      timeoutMs: 300000
    },
    staleClaimMs: 0,
    hardClaimMs: 0,
    autoAnswer: {
      enabled: false,
      maxAttempts: 3
    },
    sharpener: {
      enabled: true,
      mode: 'shadow',
      agent: 'local-agy-gemini-3.8-flash'
    }
  }
};

/**
 * G1: pstack (PS-*) feature defaults. A live config written before PS-1..PS-8
 * landed lacks these keys; loadConfig deep-merges them so the features run
 * without anyone hand-editing ~/.cowork/config.json. Live keys always win.
 */
export const PS_DEFAULTS = {
  methods: {
    enabled: true,
    cards: {
      'investigation': 'shadow', 'bug-fix': 'shadow', 'feature': 'shadow',
      'research-report': 'on', 'content': 'shadow', 'ops-change': 'shadow',
      'technical-writing': 'shadow', 'perf-issue': 'shadow', 'refactoring': 'shadow',
      'prototype': 'shadow', 'runtime-forensics': 'shadow', 'eval': 'shadow',
      'opening-a-pr': 'shadow', 'babysit': 'shadow'
    } as Record<string, 'shadow' | 'on'>
  },
  tiers: {
    mechanical: ['local-dsh-qwen3-8-27b', 'local-agy-gemini-3.8-flash', 'local-agy-gemini-3.8-flash'],
    standard: ['local-agy-gemini-4-argon', 'local-agy-claude-opus-5-5'],
    judgment: ['local-cc-opus-5-5', 'remote-ai-code-gen-cc-opus-5-5']
  } as Record<string, string[]>,
  spec: {
    enabled: true,
    mode: 'shadow' as const,
    maxFalseRejectRate: 0.1,
    minDecisiveVerdicts: 30,
    timeoutMs: 300000,
    judges: {
      claude: ['local-agy-gemini-4-argon', 'local-agy-gemini-3.8-flash'],
      gemini: ['local-agy-claude-opus-5-5', 'local-cc-opus-5-5'],
      qwen: ['local-agy-claude-opus-5-5', 'local-cc-opus-5-5'],
      default: ['local-agy-claude-opus-5-5', 'local-cc-opus-5-5']
    }
  },
  panel: { enabled: true, size: 2, judgmentTier: false },
  prAutomation: {
    enabled: true,
    mode: 'shadow' as const,
    repos: [], // no default target repo; set orchestration.prAutomation.repos per install
    label: 'cowork-auto',
    escalatePaths: [
      'auth', 'secret', '.priv', 'deploy/', '.github/workflows/', 'config.json',
      'migration', 'billing', '.env'
    ],
    mergeMethod: 'squash' as const,
    maxFixRounds: 2,
    watchIntervalMin: 10
  }
};

/** Deep-merge the PS_DEFAULTS into an orchestration block (live values win). */
export function applyPsDefaults(orch: Config['orchestration']): string[] {
  const filled: string[] = [];
  if (!orch.methods) { orch.methods = structuredClone(PS_DEFAULTS.methods); filled.push('methods'); }
  else orch.methods = { ...PS_DEFAULTS.methods, ...orch.methods, cards: { ...PS_DEFAULTS.methods.cards, ...(orch.methods.cards || {}) } };
  if (!orch.tiers || !Object.keys(orch.tiers).length) { orch.tiers = structuredClone(PS_DEFAULTS.tiers); filled.push('tiers'); }
  orch.verifier = orch.verifier || { enabled: true };
  if (!orch.verifier.spec) { orch.verifier.spec = structuredClone(PS_DEFAULTS.spec); filled.push('verifier.spec'); }
  if (!orch.verifier.panel) { orch.verifier.panel = { ...PS_DEFAULTS.panel }; filled.push('verifier.panel'); }
  if (!orch.prAutomation) { orch.prAutomation = structuredClone(PS_DEFAULTS.prAutomation); filled.push('prAutomation'); }
  else orch.prAutomation = { ...structuredClone(PS_DEFAULTS.prAutomation), ...orch.prAutomation };
  return filled;
}

/** A config still in the pre-2026-11 `brain` shape, where `orchestration.agents` meant role chains. */
function hasLegacyNaming(raw: any): boolean {
  const o = raw?.orchestration;
  if (!o) return false;
  return !!(o.brains || o.agentChains || Object.values(o.agents || {}).some((a: any) => Array.isArray(a?.brains)));
}

/**
 * Bring a hub on the old naming to the agent naming, once, before anything reads its
 * state. A new server on an old config reads the role chains as the agent registry and
 * ignores the real one, so no task can ever run. Call this before loadConfig, which
 * would write that misread back to disk, and only from the server process: the
 * migration needs the server stopped. A failure aborts the start rather than boot a hub
 * that cannot run anything.
 */
export function migrateLegacyNamingOnBoot(configPath: string = activeConfigPath()): boolean {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return false; }
  if (!hasLegacyNaming(raw)) return false;

  const stateRoot = path.dirname(resolvePath(raw.paths?.inbox || defaultConfig.paths.inbox));
  const stateDirs = ['inbox', 'goals', 'recipes', '.status', 'decisions'].filter(d => fs.existsSync(path.join(stateRoot, d)));
  const backupDir = path.join(path.dirname(configPath), 'backups');
  const backup = path.join(backupDir, `agent-naming-boot-${new Date().toISOString().replace(/[-:.]/g, '')}.tar.gz`);
  fs.mkdirSync(backupDir, { recursive: true });
  execFileSync('tar', ['-czf', backup, '-C', path.dirname(configPath), path.basename(configPath), '-C', stateRoot, ...stateDirs], { stdio: 'pipe' });

  const script = path.resolve(rootDir, 'scripts/migrate-agent-naming.mjs');
  const out = execFileSync(process.execPath, [script, '--repo', stateRoot, '--config', configPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`Migrated ${configPath} and its state to the agent naming (backup: ${backup}): ${out.replace(/\s+/g, ' ')}`);
  return true;
}

export function loadConfig(): Config {
  const configPath = activeConfigPath();

  // First run: seed the per-server config from the repo template.
  if (!fs.existsSync(configPath)) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      if (fs.existsSync(REPO_TEMPLATE)) {
        fs.copyFileSync(REPO_TEMPLATE, configPath);
        console.log(`Seeded per-server config at ${configPath} from repo template.`);
      }
    } catch (e) {
      console.error(`Could not seed config at ${configPath}:`, e);
    }
  }

  let loadedConfig: Partial<Config> = {};
  if (fs.existsSync(configPath)) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      loadedConfig = JSON.parse(fileContent);
    } catch (error) {
      console.error(`Error parsing config at ${configPath}:`, error);
    }
  } else {
    console.warn(`Config file not found at ${configPath}, using defaults.`);
  }
  console.log(`Loaded config from ${configPath}`);

  const config: Config = {
    server: { ...defaultConfig.server, ...(loadedConfig.server || {}) },
    paths: { ...defaultConfig.paths, ...(loadedConfig.paths || {}) },
    platforms: loadedConfig.platforms || {},
    services: loadedConfig.services || {},
    serviceControl: loadedConfig.serviceControl || undefined,
    obsidian: loadedConfig.obsidian
      ? { ...defaultConfig.obsidian!, ...loadedConfig.obsidian }
      : defaultConfig.obsidian,
    inbox: { ...defaultConfig.inbox, ...(loadedConfig.inbox || {}) },
    integrations: loadedConfig.integrations,
    orchestration: {
      ...defaultConfig.orchestration,
      ...(loadedConfig.orchestration || {}),
      roleChains: loadedConfig.orchestration?.roleChains || {},
      roles: loadedConfig.orchestration?.roles || {},
      agents: loadedConfig.orchestration?.agents || {},
      defaultChain: loadedConfig.orchestration?.defaultChain || [],
      divisionChains: loadedConfig.orchestration?.divisionChains || {},
      personaChains: loadedConfig.orchestration?.personaChains || {},
      remoteGraceMs: loadedConfig.orchestration?.remoteGraceMs ?? 60000,
      classifier: {
        ...defaultConfig.orchestration.classifier!,
        ...(loadedConfig.orchestration?.classifier || {})
      },
      autoAnswer: {
        ...defaultConfig.orchestration.autoAnswer!,
        ...(loadedConfig.orchestration?.autoAnswer || {})
      },
      sharpener: loadedConfig.orchestration?.sharpener || {
        enabled: true,
        mode: 'shadow',
        agent: 'local-agy-gemini-3.8-flash'
      }
    }
  };

  // Scrub any denylisted (retired) agents that lingered in the on-disk registry
  // or its chains — the disk config may have been written before the agent was
  // retired, or by an older server that lacked the denylist. Doing it at load
  // time guarantees a retired agent can never come back across a restart, not
  // just be blocked from new registration.
  const psFilled = applyPsDefaults(config.orchestration);
  const om = config.orchestration;
  console.log(`[pstack] sharpener=${om.sharpener?.enabled ? om.sharpener.mode : 'off'} methods=${om.methods?.enabled ? 'on' : 'off'} spec=${om.verifier?.spec?.enabled ? om.verifier.spec.mode : 'off'} panel=${om.verifier?.panel?.enabled ? 'on' : 'off'} prAutomation=${om.prAutomation?.enabled ? om.prAutomation.mode : 'off'}` + (psFilled.length ? ` (defaults filled: ${psFilled.join(', ')})` : ''));

  scrubDenylistedAgents(config);

  // Rename agents that still carry a retired id (AGENT_ID_ALIASES) — registry
  // keys and every chain — and write the result back once so the on-disk config
  // converges on the canonical ids. Idempotent: a clean config changes nothing.
  if (migrateAgentAliases(config).length) persistRegistries(config);

  // COWORK_API_KEY env var overrides config (keeps the secret out of git)
  if (process.env.COWORK_API_KEY) {
    config.server.apiKey = process.env.COWORK_API_KEY;
  }
  if (process.env.COWORK_PORT) {
    const p = parseInt(process.env.COWORK_PORT, 10);
    if (Number.isFinite(p) && p > 0) config.server.port = p;
  }
  // COWORK_HOST lets a container bind 0.0.0.0 without editing the seeded config.
  if (process.env.COWORK_HOST) {
    config.server.host = process.env.COWORK_HOST;
  }

  for (const key of Object.keys(config.paths) as (keyof Config['paths'])[]) {
    const v = config.paths[key];
    if (v) (config.paths as Record<string, string | undefined>)[key] = resolvePath(v);
  }

  // Resolve TLS cert/key like the other paths so `~` and repo-relative forms work.
  if (config.server.tls?.certFile && config.server.tls?.keyFile) {
    config.server.tls = {
      certFile: resolvePath(config.server.tls.certFile),
      keyFile: resolvePath(config.server.tls.keyFile)
    };
  } else {
    config.server.tls = null;
  }

  return config;
}

/**
 * Persist edits to the live roles/agents registries: mutate the in-memory
 * config (so the dispatcher sees changes on its next tick) AND write them back
 * to the per-server config's orchestration.roleChains/agents. Writes to
 * ~/.cowork/config.json (or COWORK_CONFIG) — never the repo template. Other
 * config fields are left exactly as they are on disk.
 */
export function persistRegistries(config: Config): void {
  const configPath = activeConfigPath();
  let disk: any = {};
  try { disk = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* start fresh */ }
  try { fs.mkdirSync(path.dirname(configPath), { recursive: true }); } catch { /* dir exists */ }
  disk.orchestration = disk.orchestration || {};
  disk.orchestration.roleChains = config.orchestration.roleChains;
  disk.orchestration.agents = config.orchestration.agents;
  disk.orchestration.defaultChain = config.orchestration.defaultChain;
  disk.orchestration.divisionChains = config.orchestration.divisionChains;
  disk.orchestration.personaChains = config.orchestration.personaChains;
  if (config.orchestration.tiers) disk.orchestration.tiers = config.orchestration.tiers;
  fs.writeFileSync(configPath, JSON.stringify(disk, null, 2));
}

/** Remove an agent from the registry AND scrub it from every chain so no
 *  agent points at an agent that no longer exists. Returns #agents changed. */
export function removeAgentCascade(config: Config, id: string): number {
  const orch = config.orchestration;
  delete (orch.agents || {})[id];
  let scrubbed = 0;
  for (const a of Object.values(orch.roleChains || {})) {
    const before = a.agents.length;
    a.agents = a.agents.filter(b => b !== id);
    if (a.agents.length !== before) scrubbed++;
  }
  // Also scrub the global default chain and any division overrides.
  if (Array.isArray(orch.defaultChain)) {
    const before = orch.defaultChain.length;
    orch.defaultChain = orch.defaultChain.filter(b => b !== id);
    if (orch.defaultChain.length !== before) scrubbed++;
  }
  for (const [div, chain] of Object.entries(orch.divisionChains || {})) {
    const before = chain.length;
    const next = chain.filter(b => b !== id);
    if (next.length !== before) { orch.divisionChains![div] = next; scrubbed++; }
  }
  // And every per-roster-agent override.
  for (const [agent, chain] of Object.entries(orch.personaChains || {})) {
    const before = chain.length;
    const next = chain.filter(b => b !== id);
    if (next.length !== before) {
      if (next.length) orch.personaChains![agent] = next;
      else delete orch.personaChains![agent];   // emptied → fall back to division/default
      scrubbed++;
    }
  }
  // And the work-role tiers, so a deregistered agent is not left in mechanical/standard/judgment.
  for (const [tier, chain] of Object.entries(orch.tiers || {})) {
    const next = chain.filter(b => b !== id);
    if (next.length !== chain.length) { orch.tiers![tier] = next; scrubbed++; }
  }
  persistRegistries(config);
  return scrubbed;
}

/**
 * Agent ids that are permanently retired: the server refuses to (re)register
 * them and never restores them from a client's persisted capabilities, so a
 * client that still declares one is simply ignored rather than resurrecting a
 * decommissioned model. Matched against the agent id (case-insensitive).
 * DeepSeek was pulled from the fleet — see removeAgentCascade callers.
 */
export const DENYLISTED_AGENT_RE = /deepseek/i;

/** True when an agent id must never enter (or re-enter) the registry. */
export function isDenylistedAgent(id: string): boolean {
  return DENYLISTED_AGENT_RE.test(id);
}

/**
 * Strip every denylisted agent from an in-memory config: the registry itself and
 * every chain that references one (defaultChain, division/role chains, each
 * role's agents list). Mutates in place and returns the ids removed. Used at
 * load time so a retired agent can't survive a restart via the on-disk config.
 */
export function scrubDenylistedAgents(config: Config): string[] {
  const orch = config.orchestration;
  const agents = orch.agents || {};
  const removed = Object.keys(agents).filter(isDenylistedAgent);
  if (!removed.length) return [];
  for (const id of removed) delete agents[id];
  const clean = (arr?: string[]) => (arr || []).filter(id => !isDenylistedAgent(id));
  if (Array.isArray(orch.defaultChain)) orch.defaultChain = clean(orch.defaultChain);
  for (const div of Object.keys(orch.divisionChains || {})) orch.divisionChains![div] = clean(orch.divisionChains![div]);
  for (const agent of Object.keys(orch.personaChains || {})) {
    const next = clean(orch.personaChains![agent]);
    if (next.length) orch.personaChains![agent] = next; else delete orch.personaChains![agent];
  }
  for (const a of Object.values(orch.roleChains || {})) a.agents = clean(a.agents);
  return removed;
}

/**
 * Retired agent id → canonical agent id. A renamed agent keeps resolving under
 * its old id everywhere an id enters the server: task pins (context.agent),
 * client registration, restored client capabilities, and chains in an older
 * on-disk config. Extend per server via orchestration.agentAliases.
 * Never alias to an id containing "deepseek" — DENYLISTED_AGENT_RE drops it.
 */
export const AGENT_ID_ALIASES: Readonly<Record<string, string>> = {
  // The id prefix names the MACHINE an agent runs on (local- = this host), not
  // its `location`. Codex runs on this host, so local-codex-*, even though the
  // codex client claims its tasks (location "remote"). Reverses the 2026-10-07
  // local-codex-* → remote-codex-* rename (2026-11-03).
  'remote-codex-default': 'local-codex-default',
  'remote-codex-gpt-5-6-terra': 'local-codex-gpt-5-6-terra',
  'remote-codex-gpt-5-6-luna': 'local-codex-gpt-5-6-luna',
  'remote-codex-gpt-6-luna': 'local-codex-gpt-6-luna',
  // ids carry the model version.
  'remote-ai-code-gen-cc-opus': 'remote-ai-code-gen-cc-opus-4-8',
  'remote-ai-code-gen-cc-sonnet': 'remote-ai-code-gen-cc-sonnet-5',
  'remote-ai-code-gen-cc-fable': 'remote-ai-code-gen-cc-fable-5',
  // one canonical id for the Hermes qwen3.8 agent ("ha" read as Home Assistant).
  'local-ha-qwen3-8-27b': 'local-hermes-qwen3.8-27b',
  'local-ha-qwen38-27b': 'local-hermes-qwen3.8-27b',
  'local-ha-qwen3.8-27b': 'local-hermes-qwen3.8-27b',
  // agy models retired upstream (no longer in `agy models`) → nearest live slug,
  // so old task pins and stale client registrations don't fail "not recognized".
  'local-agy-gemini-3.1-pro-high': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.1-pro-low': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.5-flash-high': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.5-flash-medium': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.5-flash-low': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.6-flash-high': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.6-flash-medium': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.6-flash-low': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.7-flash-high': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.7-flash-medium': 'local-agy-gemini-3.8-flash',
  'local-agy-gemini-3.7-flash-low': 'local-agy-gemini-3.8-flash',
  'local-agy-claude-sonnet-4-6': 'local-agy-claude-sonnet-5-5',
  'local-agy-claude-opus-4-6-thinking': 'local-agy-claude-opus-5-5'
};

/** Resolve a (possibly retired) agent id to its canonical id. Follows chained
 *  aliases with a hop limit so a misconfigured cycle cannot hang. */
export function canonicalAgentId(config: Config | undefined, id: string): string {
  const aliases = { ...AGENT_ID_ALIASES, ...(config?.orchestration?.agentAliases || {}) };
  const follow = (start: string) => {
    let cur = start;
    for (let hop = 0; hop < 8 && aliases[cur] && aliases[cur] !== cur; hop++) cur = aliases[cur];
    return cur;
  };
  // A thinking level is not part of an id: `x-high` is agent `x` (see core/thinking.ts).
  return follow(splitThinkingSuffix(follow(id)).base);
}

/**
 * The task as an agent CLIENT should see it: when the pinned agent is held under
 * a canonical id but its owning client still declared a retired one
 * (`clientId`), report context.agent as that declared id — a client only claims
 * tasks whose context.agent is one of its own ids. Returns a shallow copy and
 * never touches the stored task; unaffected tasks are returned as-is.
 */
export function clientTaskView<T extends { context?: Record<string, any> }>(config: Config, task: T): T {
  const id = task?.context?.agent;
  if (typeof id !== 'string') return task;
  // A task stored before a rename may still carry the retired id: resolve it, so
  // the client that now declares the canonical id still finds it.
  const canon = canonicalAgentId(config, id);
  const want = config.orchestration.agents?.[canon]?.clientId || canon;
  if (want === id) return task;
  return { ...task, context: { ...task.context, agent: want } };
}

/**
 * Rename every retired agent id in an in-memory config to its canonical id: the
 * registry keys and every chain (defaultChain, division/role chains, each
 * special role's agents), de-duplicating chains where old and new both appear.
 * A dynamic agent moved this way remembers the id its client declared
 * (`clientId`) until that client re-registers. Mutates in place; returns the
 * retired ids that were rewritten.
 */
export function migrateAgentAliases(config: Config): string[] {
  const orch = config.orchestration;
  const agents = orch.agents || {};
  const renamed = new Set<string>();
  for (const id of Object.keys(agents)) {
    const canon = canonicalAgentId(config, id);
    if (canon === id) continue;
    if (!agents[canon]) {
      agents[canon] = { ...agents[id], ...(agents[id].dynamic ? { clientId: agents[id].clientId || id } : {}) };
      // An agy agent id IS its model slug — a renamed (retired) one must not
      // keep forwarding the old `--model` agy no longer recognises.
      if (agents[canon].exec === 'agy' && canon.startsWith('local-agy-')) agents[canon].model = canon.slice('local-agy-'.length);
    }
    delete agents[id];
    renamed.add(id);
  }
  const fix = (arr: string[] | undefined): string[] | undefined => {
    if (!Array.isArray(arr)) return arr;
    const out: string[] = [];
    for (const id of arr) {
      const canon = canonicalAgentId(config, id);
      if (canon !== id) renamed.add(id);
      if (!out.includes(canon)) out.push(canon);
    }
    return out;
  };
  if (Array.isArray(orch.defaultChain)) orch.defaultChain = fix(orch.defaultChain);
  for (const div of Object.keys(orch.divisionChains || {})) orch.divisionChains![div] = fix(orch.divisionChains![div])!;
  for (const agent of Object.keys(orch.personaChains || {})) orch.personaChains![agent] = fix(orch.personaChains![agent])!;
  for (const a of Object.values(orch.roleChains || {})) a.agents = fix(a.agents) || [];
  return [...renamed];
}

/**
 * Merge a client-declared agent into the registry (auto-registration).
 *
 * Two invariants are enforced here because this is the single choke point every
 * register_agent handshake flows through:
 *  1. Denylisted ids (DeepSeek) are dropped — a reconnecting client can never
 *     resurrect a retired agent.
 *  2. The server-owned `disabled` flag is PRESERVED across re-registration. A
 *     client re-declares its agents verbatim every time it reconnects; without
 *     this merge that handshake would silently clear a manual disable and the
 *     agent would start taking tasks again ("disabled agents re-enable
 *     themselves"). Disabling is a server-side decision and outlives the client.
 */
export function registerAgent(config: Config, id: string, agent: import('./types.js').AgentConfig): string {
  const canon = canonicalAgentId(config, id);
  if (isDenylistedAgent(id) || isDenylistedAgent(canon)) return canon;
  config.orchestration.agents = config.orchestration.agents || {};
  const prev = config.orchestration.agents[canon];
  const { clientId: _stale, ...rest } = agent;
  config.orchestration.agents[canon] = {
    ...rest,
    ...(prev?.disabled ? { disabled: true } : {}),
    // A client still declaring a retired id is registered under the canonical
    // id; remember what it calls the agent so its task views can be translated.
    ...(canon !== id ? { clientId: id } : {})
  };
  persistRegistries(config);
  return canon;
}

/** Client platforms whose capabilities are agent ids, and the exec each implies. */
const CLIENT_PLATFORM_EXEC: Record<string, NonNullable<import('./types.js').AgentConfig['exec']>> = {
  claude: 'claude',
  antigravity: 'agy',
  codex: 'codex',
  hermes: 'hermes',
  ollama: 'ollama'
};

/** Agent-shaped capability ids use the `local-*` / `remote-*` alias convention. */
const AGENT_ID_RE = /^(local|remote)-/;

/** Client platforms whose agents are always claimed by the client (location
 *  "remote") whatever the id prefix says — e.g. local-codex-* runs on this host
 *  but the dispatcher must never spawn it itself. */
const CLIENT_CLAIMED_PLATFORMS = new Set(['codex']);

/**
 * Rebuild dynamic agents from the last known CLIENT declarations (the persisted
 * agent roster in .status/workers.json) whenever the registry lost them — a
 * full-config UI save, a template reseed, or a manual cleanup can wipe
 * auto-registered entries, and clients only re-declare their agents when THEY
 * restart, not when the server restarts. Client capabilities are the source of
 * truth for what a connected client can actually run, so a capability that is
 * missing from the registry must be restored or the UI shows the client with
 * its agents while the agent dropdown cannot select them.
 *
 * Idempotent and fail-soft: existing registry entries (static or dynamic) are
 * never overwritten; platforms without a known exec (dispatcher/orchestrator
 * internals) and non-agent capabilities are skipped. Returns the ids restored.
 */
export function restoreClientAgents(
  config: Config,
  workers: Array<{ id: string; platform: string; capabilities?: string[] }>
): string[] {
  const restored: string[] = [];
  config.orchestration.agents = config.orchestration.agents || {};
  for (const a of workers) {
    const exec = CLIENT_PLATFORM_EXEC[a.platform];
    if (!exec) continue;
    for (const cap of a.capabilities || []) {
      if (!AGENT_ID_RE.test(cap)) continue;
      const id = canonicalAgentId(config, cap);
      if (isDenylistedAgent(cap) || isDenylistedAgent(id)) continue;   // retired agent — never restore
      if (config.orchestration.agents[id]) continue;
      config.orchestration.agents[id] = {
        description: `${id} (declared by client ${a.id.slice(0, 8)}; restored from persisted registration)`,
        location: id.startsWith('local-') && !CLIENT_CLAIMED_PLATFORMS.has(a.platform) ? 'local' : 'remote',
        exec,
        dynamic: true,
        registeredBy: a.id,
        ...(id !== cap ? { clientId: cap } : {})
      };
      restored.push(id);
    }
  }
  if (restored.length) persistRegistries(config);
  return restored;
}
