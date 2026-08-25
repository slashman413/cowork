import fs from 'fs';
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
// personal host/brain settings are never committed and the server's live edits don't
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
    agencyAgents: './agency-agents',
    inbox: './inbox',
    artifacts: './artifacts',
    inputs: './inputs',
    status: './.status',
    decisions: './decisions',
    workflows: './workflows',
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
    maxRetries: 3
  },
  orchestration: {
    enabled: false,
    maxConcurrent: 2,
    pollIntervalMs: 5000,
    taskTimeoutMs: 3000000,
    defaultRole: 'generalist',
    agents: {},
    roles: {},
    brains: {},
    classifier: {
      enabled: false,
      exec: 'hermes',
      model: 'nvidia/Qwen3.6-35B-A3B-NVFP4',
      fallbackRole: 'generalist',
      timeoutMs: 300000
    },
    staleClaimMs: 0,
    hardClaimMs: 0
  }
};

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
    obsidian: loadedConfig.obsidian
      ? { ...defaultConfig.obsidian!, ...loadedConfig.obsidian }
      : defaultConfig.obsidian,
    inbox: { ...defaultConfig.inbox, ...(loadedConfig.inbox || {}) },
    orchestration: {
      ...defaultConfig.orchestration,
      ...(loadedConfig.orchestration || {}),
      agents: loadedConfig.orchestration?.agents || {},
      roles: loadedConfig.orchestration?.roles || {},
      brains: loadedConfig.orchestration?.brains || {},
      defaultChain: loadedConfig.orchestration?.defaultChain || [],
      divisionChains: loadedConfig.orchestration?.divisionChains || {},
      agentChains: loadedConfig.orchestration?.agentChains || {},
      remoteGraceMs: loadedConfig.orchestration?.remoteGraceMs ?? 60000,
      classifier: {
        ...defaultConfig.orchestration.classifier!,
        ...(loadedConfig.orchestration?.classifier || {})
      }
    }
  };

  // COWORK_API_KEY env var overrides config (keeps the secret out of git)
  if (process.env.COWORK_API_KEY) {
    config.server.apiKey = process.env.COWORK_API_KEY;
  }
  if (process.env.COWORK_PORT) {
    const p = parseInt(process.env.COWORK_PORT, 10);
    if (Number.isFinite(p) && p > 0) config.server.port = p;
  }

  for (const key of Object.keys(config.paths) as (keyof Config['paths'])[]) {
    config.paths[key] = resolvePath(config.paths[key]);
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
 * Persist edits to the live agents/brains registries: mutate the in-memory
 * config (so the dispatcher sees changes on its next tick) AND write them back
 * to the per-server config's orchestration.agents/brains. Writes to
 * ~/.cowork/config.json (or COWORK_CONFIG) — never the repo template. Other
 * config fields are left exactly as they are on disk.
 */
export function persistRegistries(config: Config): void {
  const configPath = activeConfigPath();
  let disk: any = {};
  try { disk = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* start fresh */ }
  try { fs.mkdirSync(path.dirname(configPath), { recursive: true }); } catch { /* dir exists */ }
  disk.orchestration = disk.orchestration || {};
  disk.orchestration.agents = config.orchestration.agents;
  disk.orchestration.brains = config.orchestration.brains;
  disk.orchestration.defaultChain = config.orchestration.defaultChain;
  disk.orchestration.divisionChains = config.orchestration.divisionChains;
  disk.orchestration.agentChains = config.orchestration.agentChains;
  fs.writeFileSync(configPath, JSON.stringify(disk, null, 2));
}

/** Remove a brain from the registry AND scrub it from every agent's chain so no
 *  agent points at a brain that no longer exists. Returns #agents changed. */
export function removeBrainCascade(config: Config, id: string): number {
  const orch = config.orchestration;
  delete (orch.brains || {})[id];
  let scrubbed = 0;
  for (const a of Object.values(orch.agents || {})) {
    const before = a.brains.length;
    a.brains = a.brains.filter(b => b !== id);
    if (a.brains.length !== before) scrubbed++;
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
  for (const [agent, chain] of Object.entries(orch.agentChains || {})) {
    const before = chain.length;
    const next = chain.filter(b => b !== id);
    if (next.length !== before) {
      if (next.length) orch.agentChains![agent] = next;
      else delete orch.agentChains![agent];   // emptied → fall back to division/default
      scrubbed++;
    }
  }
  persistRegistries(config);
  return scrubbed;
}

/** Merge a client-declared brain into the registry (auto-registration). */
export function registerBrain(config: Config, id: string, brain: import('./types.js').BrainConfig): void {
  config.orchestration.brains = config.orchestration.brains || {};
  config.orchestration.brains[id] = brain;
  persistRegistries(config);
}

/** Client platforms whose capabilities are brain ids, and the exec each implies. */
const CLIENT_PLATFORM_EXEC: Record<string, NonNullable<import('./types.js').BrainConfig['exec']>> = {
  claude: 'claude',
  antigravity: 'agy',
  codex: 'codex',
  hermes: 'hermes',
  ollama: 'ollama'
};

/** Brain-shaped capability ids use the `local-*` / `remote-*` alias convention. */
const BRAIN_ID_RE = /^(local|remote)-/;

/**
 * Rebuild dynamic brains from the last known CLIENT declarations (the persisted
 * agent roster in .status/agents.json) whenever the registry lost them — a
 * full-config UI save, a template reseed, or a manual cleanup can wipe
 * auto-registered entries, and clients only re-declare their brains when THEY
 * restart, not when the server restarts. Client capabilities are the source of
 * truth for what a connected client can actually run, so a capability that is
 * missing from the registry must be restored or the UI shows the client with
 * its brains while the brain dropdown cannot select them.
 *
 * Idempotent and fail-soft: existing registry entries (static or dynamic) are
 * never overwritten; platforms without a known exec (dispatcher/orchestrator
 * internals) and non-brain capabilities are skipped. Returns the ids restored.
 */
export function restoreClientBrains(
  config: Config,
  agents: Array<{ id: string; platform: string; capabilities?: string[] }>
): string[] {
  const restored: string[] = [];
  config.orchestration.brains = config.orchestration.brains || {};
  for (const a of agents) {
    const exec = CLIENT_PLATFORM_EXEC[a.platform];
    if (!exec) continue;
    for (const cap of a.capabilities || []) {
      if (!BRAIN_ID_RE.test(cap)) continue;
      if (config.orchestration.brains[cap]) continue;
      config.orchestration.brains[cap] = {
        description: `${cap} (declared by client ${a.id.slice(0, 8)}; restored from persisted registration)`,
        location: cap.startsWith('local-') ? 'local' : 'remote',
        exec,
        dynamic: true,
        registeredBy: a.id
      };
      restored.push(cap);
    }
  }
  if (restored.length) persistRegistries(config);
  return restored;
}
