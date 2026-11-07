import express from 'express';
import { legacyWireMiddleware, legacyWireUses } from './legacy-wire.js';
import { DEFAULT_THINKING, normalizeThinking, THINKING_LEVELS } from './core/thinking.js';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { createMultiplexedServer } from './core/server-listener.js';
import { createCompression } from './core/compression.js';
import { activeConfigPath, loadConfig, persistRegistries, removeAgentCascade, restoreClientAgents } from './config.js';
import { EventBus } from './core/events.js';
import { Store } from './core/store.js';
import { Dispatcher } from './core/dispatcher.js';
import { computeQualityMetrics, metricsWindow, readLessons } from './core/quality-metrics.js';
import { correctLoop } from './core/correct-loop.js';
import { readRulings } from './core/rulings.js';
import { createMcpServer } from './mcp/server.js';
import { createApiRouter } from './api/router.js';
import { createGoalRouter } from './api/goals.js';
import { createRecipeRouter } from './api/recipes.js';
import { Recipes } from './core/recipes.js';
import { createSSEHandler } from './api/sse.js';
import { Goals } from './core/goals.js';
import { SystemMetrics } from './core/system-metrics.js';
import { UsagePoller, isMeteredExec } from './core/usage-probe.js';
import { probeServices, unitState } from './core/service-probe.js';
import { PortalStore } from './core/portal-config.js';
import { LayoutStore } from './core/layout-config.js';
import { systemDetails, DETAIL_KINDS, type DetailKind } from './core/system-details.js';
import { controlService } from './core/service-control.js';
import { getObsidianVault } from './core/obsidian.js';
import { VideoStudio, VIDEO_STUDIO_TAG, ASPECTS } from './core/video-studio.js';
import { AudioOverview, AUDIO_OVERVIEW_TAG, AUDIO_OVERVIEW_FILE, readTaskSourceFile } from './core/audio-overview.js';
import { normalizeRecurrence, nextRunAt } from './core/recurrence.js';
import { Shotcraft, SHOTCRAFT_TAG, GALLERY_URL, ASPECTS as SHOTCRAFT_ASPECTS, LENGTHS as SHOTCRAFT_LENGTHS } from './core/shotcraft.js';
import { OUTPUTS_SUBDIR } from './core/artifact-lint.js';
import { sharedIntegrations, defaultAuditTargets, defaultWrapAgent } from './core/integrations.js';
import { auditPath, mergeReports } from './core/skill-auditor.js';
import { AUTH_COOKIE, KeylessLog, keyMatches, readCookie, resolveApiKey } from './core/auth.js';
import { ClientGuard } from './core/client-guard.js';

async function main() {
  const config = loadConfig();
  const eventBus = new EventBus();
  const store = new Store(config, eventBus);

  store.initialize();

  // Self-heal the agent registry from the last known CLIENT declarations: a
  // client-declared agent (e.g. every `local-agy-*` the Antigravity client
  // registers) must always be selectable, but a full-config UI save or a
  // template reseed can wipe the persisted dynamic entries — and clients only
  // re-declare their agents when THEY restart, not when the server does.
  // Restore anything the persisted roster still declares before the dispatcher
  // and UI come up. Idempotent; existing static defs are never overwritten.
  try {
    const restored = restoreClientAgents(config, store.getActiveWorkers());
    if (restored.length) {
      console.log(`Restored ${restored.length} client-declared agent(s) into the registry: ${restored.join(', ')}`);
    }
  } catch (e) {
    console.error('restoreClientAgents failed:', e);
  }

  // Host system-load sampler feeding the dashboard's top metrics bar.
  const sysMetrics = new SystemMetrics();
  sysMetrics.start();

  // Rate-limit usage sampler for LOCAL metered agents (claude/codex on this
  // host). Remote agents self-report through their heartbeat instead.
  const usagePoller = new UsagePoller(store, () => config.orchestration.agents || {});
  usagePoller.start();

  const app = express();
  // Client denylist pre-check (IP + headers) ahead of body parsing, so a blocked
  // client gets 403 even for a malformed body. The /mcp body check runs below.
  const clientGuard = new ClientGuard(config.server.blockedClients, () => store.getActiveWorkers());
  const guardSeen = new Map<string, number>();
  const logGuardBlock = (reason: string, req: express.Request) => {
    const key = `${req.ip}|${reason}`;
    if (Date.now() - (guardSeen.get(key) || 0) < 10 * 60_000) return;   // one line per caller+reason per 10 min
    if (guardSeen.size > 1000) guardSeen.clear();
    guardSeen.set(key, Date.now());
    console.warn(`client-guard: rejected ${req.method} ${req.originalUrl.split('?')[0]} from ${req.ip} (${reason})`);
  };
  if (clientGuard.active) {
    app.use((req, res, next) => {
      const v = clientGuard.check({ ip: req.ip, socketIp: req.socket?.remoteAddress, headers: req.headers as Record<string, unknown>, path: '' });
      if (!v.blocked) return next();
      logGuardBlock(v.reason || 'blocked', req);
      res.status(403).json({ error: 'forbidden: client blocked by server policy' });
    });
  }
  // gzip JSON + static assets; SSE (/api/events) and /mcp stay unbuffered. See core/compression.ts.
  app.use(createCompression());
  app.use(express.json());
  app.use(legacyWireMiddleware);

  // Client denylist (server.blockedClients): rejects a named client (by source IP
  // or declared identity) on every path with 403, independent of the API key —
  // all agent clients share one key, so the key can't single one out. Its agents
  // are disabled so the dispatcher stops routing tasks there. See core/client-guard.ts.
  if (clientGuard.active) {
    const enforceAgents = () => {
      const agents = config.orchestration.agents || {};
      const off = clientGuard.disableBlockedAgents(agents);
      if (off.length) console.warn(`client-guard: disabled blocked agent(s): ${off.join(', ')}`);
    };
    enforceAgents();
    setInterval(enforceAgents, 60_000).unref();
    app.use(clientGuard.middleware(
      () => clientGuard.blockedWorkerIds(config.orchestration.agents || {}), logGuardBlock));
    console.log(`Client guard: blocking ips=[${(config.server.blockedClients?.ips || []).join(', ')}] ` +
      `names=[${(config.server.blockedClients?.names || []).join(', ')}]`);
  }

  // Host allowlist (anti DNS-rebinding): a page on any site can re-point its own
  // hostname at 127.0.0.1 and then talk to us same-origin. Enforced when bound to
  // loopback or when COWORK_ALLOWED_HOSTS (comma-separated hostnames) is set; a
  // 0.0.0.0 deployment without the env var is left as before.
  const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(config.server.host);
  const extraHosts = (process.env.COWORK_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (loopbackBind || extraHosts.length) {
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...extraHosts]);
    app.use((req, res, next) => {
      const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (allowedHosts.has(host)) return next();
      res.status(421).json({ error: 'host not allowed' });
    });
    console.log(`Host allowlist: ${[...allowedHosts].join(', ')}`);
  }

  // API-key auth on /api and /mcp. Required whenever the server listens on a
  // non-loopback address: with no server.apiKey a key is generated once and
  // saved beside the config (see core/auth.ts). Accepts "Authorization: Bearer
  // <key>", "X-API-Key: <key>", "?apiKey=<key>" (browser EventSource can't set
  // headers) or the dashboard cookie set by opening /?apiKey=<key> once.
  const auth = resolveApiKey({
    apiKey: config.server.apiKey,
    host: config.server.host,
    allowUnauthenticated: config.server.allowUnauthenticated,
    keyFile: path.join(path.dirname(activeConfigPath()), 'api-key')
  });
  config.server.apiKey = auth.key;
  if (auth.key) {
    const apiKey = auth.key;
    // Soft (migration) mode: keyless requests pass but are recorded; see
    // GET /api/auth/keyless for which clients still need the key.
    const authSince = new Date().toISOString();
    const keyless = auth.soft
      ? new KeylessLog((c) => console.warn(`auth(soft): keyless request from ${c.ip} "${c.userAgent}" ${c.lastPath}`))
      : null;
    const requireKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      const provided = bearer || (req.headers['x-api-key'] as string) || (req.query.apiKey as string)
        || readCookie(req.headers.cookie, AUTH_COOKIE);
      if (keyless && !provided) {
        keyless.record(req.ip || req.socket.remoteAddress || '?', String(req.headers['user-agent'] || ''),
          req.originalUrl.split('?')[0]);
        next();
        return;
      }
      if (!keyMatches(provided, apiKey)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    };
    app.use('/api', requireKey);
    app.use('/mcp', requireKey);
    if (keyless) {
      // Key required to read the list itself (a keyless caller just gets recorded).
      app.get('/api/auth/keyless', (req, res) => {
        const header = req.headers.authorization;
        const provided = (header?.startsWith('Bearer ') ? header.slice(7) : undefined)
          || (req.headers['x-api-key'] as string) || readCookie(req.headers.cookie, AUTH_COOKIE);
        if (!keyMatches(provided, apiKey)) { res.status(401).json({ error: 'unauthorized' }); return; }
        res.json({ mode: 'soft', since: authSince, callers: keyless.list() });
      });
    }
    // Dashboard login: /?apiKey=<key> stores the key in a same-site cookie and
    // redirects to the clean URL, so every same-origin fetch, EventSource and
    // download link carries it without the page handling the key.
    app.get('/', (req, res, next) => {
      if (typeof req.query.apiKey !== 'string') return next();
      if (!keyMatches(req.query.apiKey, apiKey)) { res.status(401).send('unauthorized'); return; }
      res.cookie(AUTH_COOKIE, req.query.apiKey, {
        httpOnly: true, sameSite: 'strict', secure: !!config.server.tls, maxAge: 365 * 24 * 3600 * 1000
      });
      res.redirect('/');
    });
    if (auth.source === 'generated') {
      console.log('='.repeat(72));
      console.log(` No server.apiKey set and host ${config.server.host} is not loopback.`);
      console.log(` Generated an API key (saved to ${auth.file}, shown only this once):`);
      console.log(`\n   ${apiKey}\n`);
      console.log(' Clients: "Authorization: Bearer <key>" (or COWORK_API_KEY for the agent client).');
      console.log(' Dashboard: open /?apiKey=<key> once.');
      console.log('='.repeat(72));
    } else if (auth.soft) {
      console.warn('API key auth: SOFT (migration) mode: a valid key is accepted, keyless requests still pass ' +
        'and are listed at /api/auth/keyless. Drop allowUnauthenticated to enforce.');
    } else {
      console.log(`API key auth: enabled${auth.source === 'file' ? ` (key in ${auth.file})` : ''}`);
    }
  } else if (auth.openOptOut) {
    console.warn(`WARNING: listening on ${config.server.host} with NO API key (allowUnauthenticated). ` +
      'Anyone who can reach this port can create tasks for your agents.');
  }

  // SSE
  app.get('/api/events', createSSEHandler(eventBus));

  // REST API
  const apiRouter = createApiRouter(store, eventBus);
  app.use('/api', apiRouter);

  // Goals: long-lived, phase-tracked objectives. State lives in
  // paths.goals (goals/*.json). The Achiever half is driven by the dispatcher's
  // tick; the Judger half is event-driven — Goals.onTaskCompleted rides the store's
  // existing taskCompleted event (no new transport) to audit each finished phase.
  if (!fs.existsSync(config.paths.goals)) {
    try { fs.mkdirSync(config.paths.goals, { recursive: true }); } catch { /* ignore */ }
  }
  const goals = new Goals(config, store);
  goals.onChange = goalId => eventBus.emitEvent('goalUpdated', { goalId });
  // One-way upgrade to the compact record shape. Done here because no goal is being
  // written yet; it is a no-op once every record is upgraded.
  try {
    const m = goals.migrateAll();
    if (m.migrated.length) console.log(`Goals: migrated ${m.migrated.length} record(s); originals in ${m.backupDir}`);
  } catch (e) { console.error('Goals: migration failed, old records still read fine:', e); }
  app.use('/api', createGoalRouter(goals));

  // Recipes: reusable tasks saved from good runs (core/recipes.ts). State lives in
  // recipes/ next to goals/; a run creates an ordinary task.
  const recipes = new Recipes(path.join(path.dirname(path.resolve(config.paths.goals)), 'recipes'), config.paths.inputs);
  app.use('/api', createRecipeRouter(recipes, store));
  eventBus.on('taskCompleted', (evt: any) => {
    try { goals.onTaskCompleted(evt.payload.task); }
    catch (e) { console.error('Goals: taskCompleted handler failed:', e); }

    try {
      const task = evt?.payload?.task;
      const agentId = task?.context?.ranAgent || task?.context?.agent;
      if (agentId) {
        const agent = config.orchestration.agents?.[agentId];
        if (agent?.location === 'local' && agent.exec && isMeteredExec(agent.exec)) {
          void usagePoller.refreshExec(agent.exec);
        }
      }
    } catch (e) { console.error('UsagePoller: taskCompleted refresh failed:', e); }
  });

  eventBus.on('agentExecuted', (evt: any) => {
    try {
      const exec = evt?.payload?.exec;
      if (exec && isMeteredExec(exec)) {
        void usagePoller.refreshExec(exec);
      }
    } catch (e) { console.error('UsagePoller: agentExecuted refresh failed:', e); }
  });

  // MCP Server
  const mcpServer = createMcpServer(config, store, eventBus, goals);

  const mcpHandler = async (req: express.Request, res: express.Response) => {
    try {
      await mcpServer.handleRequest(req, res);
    } catch (e) {
      console.error('MCP Server error:', e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  };
  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);

  // Serve static files — resolve relative to this file so the working
  // directory doesn't matter (systemd, cron, etc.)
  const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  } else {
    console.warn(`Public dir ${publicDir} not found, skipping static file serving.`);
  }

  // Multiplexed listener: supports both HTTPS (with signed TLS certificate & SNI)
  // and plain HTTP (for localhost secure context & automatic redirect from IP to trusted domain).
  let trustedDomainName: string | null = null;
  const onListen = () => {
    console.log(`=========================================`);
    console.log(` Multi-Agent Cowork MCP Server Started`);
    if (trustedDomainName) {
      console.log(` Trusted HTTPS : https://${trustedDomainName}:${config.server.port}/`);
      console.log(` Local HTTP    : http://localhost:${config.server.port}/`);
      console.log(` MCP Endpoint  : https://${trustedDomainName}:${config.server.port}/mcp`);
      console.log(` SSE Stream    : https://${trustedDomainName}:${config.server.port}/api/events`);
    } else {
      console.log(` HTTP API: ${config.server.tls ? 'https' : 'http'}://${config.server.host}:${config.server.port}/api`);
      console.log(` MCP Endpoint: ${config.server.tls ? 'https' : 'http'}://${config.server.host}:${config.server.port}/mcp`);
      console.log(` SSE Stream: ${config.server.tls ? 'https' : 'http'}://${config.server.host}:${config.server.port}/api/events`);
    }
    console.log(`=========================================`);
  };

  const listenerResult = createMultiplexedServer(app, config, onListen);
  trustedDomainName = listenerResult.trustedDomain;
  const server = listenerResult.server;

  // Stale agent cleanup every 5 minutes, ~3 min timeout (200000ms)
  const cleanup = setInterval(() => {
    store.removeStaleWorkers(200000);
  }, 300000);


  // Dispatcher: executes role-tagged inbox tasks by spawning platform CLIs.
  const dispatcher = new Dispatcher(config, store, eventBus, goals);
  dispatcher.start();

  app.get('/api/dispatcher', (_req, res) => {
    res.json({
      enabled: config.orchestration.enabled,
      roleChains: config.orchestration.roleChains || {},
      agents: config.orchestration.agents || {},
      defaultThinking: config.orchestration.defaultThinking || DEFAULT_THINKING,
      defaultChain: config.orchestration.defaultChain || [],
      divisionChains: config.orchestration.divisionChains || {},
      running: dispatcher.getRunning()
    });
  });

  // ── Agent fallback chains (global default + per-division + per-agent) ───────
  app.get('/api/chains', (_req, res) => res.json({
    defaultChain: config.orchestration.defaultChain || [],
    divisionChains: config.orchestration.divisionChains || {},
    personaChains: config.orchestration.personaChains || {},
    tiers: config.orchestration.tiers || {}
  }));

  // ── Quality metrics (improvement plan §5): rejections by class, repeat
  //    rate-limit share, wait-input mix, EVIDENCE / acceptance coverage. ─────
  app.get('/api/metrics/quality', (req, res) => {
    const { from, to } = metricsWindow(req.query as Record<string, unknown>);
    const { lessons, skipped } = readLessons(config.paths.decisions);
    const spec = config.orchestration.verifier?.spec;
    res.json(computeQualityMetrics(lessons, store.listTasks(), from, to, {
      lessonsSkipped: skipped, minDecisive: spec?.minDecisiveVerdicts, maxFalseRejectRate: spec?.maxFalseRejectRate,
    }));
  });

  // ── P2-2 correct loop: lessons grouped into classes (≥2) with a structure-first
  //    remedy menu, each option citing the past events its check would catch. ──
  app.get('/api/lessons/classes', (req, res) => {
    const q = req.query as Record<string, unknown>;
    const { from, to } = metricsWindow({ days: q.days ?? 30, from: q.from, to: q.to });
    res.json(correctLoop(readLessons(config.paths.decisions).lessons, from, to));
  });

  // ── P2-3 decision trail: RULING lines + orchestrator auto-answers (rulings.tsv). ─
  app.get('/api/rulings', (req, res) => {
    const q = req.query as Record<string, unknown>;
    const { from, to } = metricsWindow({ days: q.days ?? 7, from: q.from, to: q.to });
    const rows = readRulings(config.paths.decisions, from, to);
    res.json({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), count: rows.length, rulings: rows });
  });

  const validChain = (agents: any): string[] => {
    if (!Array.isArray(agents)) throw new Error('agents (string[]) required');
    const reg = config.orchestration.agents || {};
    const bad = agents.filter((b: string) => !reg[b]);
    if (bad.length) throw new Error(`unknown agent(s): ${bad.join(', ')}`);
    return agents;
  };
  app.put('/api/chains/default', (req, res) => {
    try {
      config.orchestration.defaultChain = validChain(req.body?.agents);
      persistRegistries(config);
      res.json({ ok: true, defaultChain: config.orchestration.defaultChain });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/chains/division/:division', (req, res) => {
    try {
      config.orchestration.divisionChains = config.orchestration.divisionChains || {};
      const agents = validChain(req.body?.agents);
      if (agents.length) config.orchestration.divisionChains[req.params.division] = agents;
      else delete config.orchestration.divisionChains[req.params.division];   // empty = use default
      persistRegistries(config);
      res.json({ ok: true, division: req.params.division, agents });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  // Per-roster-agent override. Empty agents[] clears it (agent falls back to its
  // division's chain, then the global default).
  app.put('/api/chains/persona/:persona', (req, res) => {
    try {
      config.orchestration.personaChains = config.orchestration.personaChains || {};
      const agents = validChain(req.body?.agents);
      if (agents.length) config.orchestration.personaChains[req.params.persona] = agents;
      else delete config.orchestration.personaChains[req.params.persona];
      persistRegistries(config);
      res.json({ ok: true, persona: req.params.persona, agents });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Roster grouped by division (for the Agents view) ───────────────────────
  app.get('/api/roster-divisions', (_req, res) => {
    const roster = store.getRoster();
    const meta = store.getDivisions() || {};
    const byDiv: Record<string, any> = {};
    for (const a of roster) {
      const d = a.division || 'other';
      (byDiv[d] ||= { label: meta[d]?.label || d, icon: meta[d]?.icon, color: meta[d]?.color, personas: [] }).personas.push({ slug: a.slug, name: a.name, description: a.description, emoji: a.emoji });
    }
    res.json(byDiv);
  });

  // ── Host system load (CPU/GPU/memory/temperature) for the dashboard bar ────
  // Cached snapshot refreshed on a background timer, so this is O(1) and safe to
  // poll every few seconds from the UI.
  app.get('/api/system', (_req, res) => res.json(sysMetrics.get()));
  // Drill-down for the Overview tile dialogs (per-core, top processes, GPU apps,
  // meminfo breakdown, thermal zones). Sampled on demand — only polled while a
  // dialog is open — so it can afford a ~0.4s CPU sample window.
  app.get('/api/system/details/:kind', async (req, res) => {
    const kind = req.params.kind as DetailKind;
    if (!DETAIL_KINDS.has(kind)) return res.status(400).json({ error: `unknown kind "${kind}"` });
    try { res.json(await systemDetails(kind)); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Portal catalog (portal.json, hot-reloaded on change) ───────────────────
  // config.services is only read once, to migrate a pre-portal.json install
  // into the freshly seeded file.
  const portal = new PortalStore(undefined, config.services);
  app.get('/api/portal', (_req, res) => {
    res.json({ ...portal.get(), controlEnabled: config.serviceControl?.enabled === true });
  });

  // ── Dashboard layout (layout.json: nav sections, pages, Overview widgets) ──
  // Hot-reloaded like portal.json; served from the repo template until the
  // operator drops a ~/.cowork/layout.json. See core/layout-config.ts.
  const layout = new LayoutStore();
  app.get('/api/layout', (_req, res) => res.json(layout.get()));

  // ── Service reachability for the Portal (probed from the host) ─────────────
  app.get('/api/services', async (_req, res) => {
    try {
      const services = portal.get().services;
      const status = await probeServices(services);
      // The Obsidian card (portal.json key "obsidian") is served by THIS server,
      // not a separate port, so its "online" is simply whether the configured
      // vault exists on disk — fold a synthetic status in instead of an HTTP probe.
      if (status.obsidian?.enabled) {
        const vault = getObsidianVault(config.obsidian);
        const ok = !!vault?.available();
        status.obsidian = { key: 'obsidian', enabled: !!vault, online: ok, code: null, ms: null,
          ...(ok ? {} : { reason: vault ? 'vault not found' : 'disabled' }) };
      }
      // Decorate entries whose config names a systemd --user unit with its
      // runtime + autostart state, so the Portal can show a unit-state chip
      // alongside the reachability dot. "Port answers" and "unit active" are
      // different facts and can disagree, so both are surfaced. This adds ~2
      // systemctl calls per controllable unit per poll — cheap for a handful.
      await Promise.all(Object.entries(services).map(async ([key, svc]) => {
        if (!svc?.unit || !status[key]) return;
        const st = await unitState(svc.unit);
        Object.assign(status[key], {
          unit: svc.unit,
          controllable: svc.controllable === true,
          active: st.active,
          autostart: st.autostart,
        });
      }));
      res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Portal service control: systemctl --user start/stop/restart/enable/disable ──
  // Opt-in (serviceControl.enabled) and, for mutations, gated on server.apiKey.
  // The unit is resolved from config server-side; the request only carries key +
  // action. Sits under /api, so the existing apiKey middleware already guards it
  // when a key is set. See core/service-control.ts for the guard order.
  app.post('/api/services/:key/:action', async (req, res) => {
    try {
      const out = await controlService(req.params.key, req.params.action, {
        controlEnabled: config.serviceControl?.enabled === true,
        apiKeySet: !!config.server.apiKey,
        services: portal.get().services,
      });
      res.status(out.status).json(out.body);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Obsidian Vault: shared knowledge base (read-only) ──────────────────────
  // Every agent queries the vault here; local agents may also read config.obsidian
  // .vaultPath off disk directly (reported by GET /api/obsidian). All reads are
  // path-guarded to the vault root inside ObsidianVault.
  app.get('/api/obsidian', (_req, res) => {
    const vault = getObsidianVault(config.obsidian);
    if (!vault) return res.json({ available: false, enabled: false });
    res.json({ enabled: true, ...vault.info() });
  });
  app.get('/api/obsidian/notes', (req, res) => {
    const vault = getObsidianVault(config.obsidian);
    if (!vault || !vault.available()) return res.status(404).json({ error: 'obsidian vault unavailable' });
    res.json(vault.list(typeof req.query.folder === 'string' ? req.query.folder : undefined));
  });
  app.get('/api/obsidian/search', (req, res) => {
    const vault = getObsidianVault(config.obsidian);
    if (!vault || !vault.available()) return res.status(404).json({ error: 'obsidian vault unavailable' });
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
    res.json(vault.search(q, Number.isFinite(limit) ? limit : 20));
  });
  app.get('/api/obsidian/note', (req, res) => {
    const vault = getObsidianVault(config.obsidian);
    if (!vault || !vault.available()) return res.status(404).json({ error: 'obsidian vault unavailable' });
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    const note = vault.read(p);
    if (!note) return res.status(404).json({ error: 'note not found' });
    res.json(note);
  });

  // ── Video Studio: lemo-opuscar style catalog + film briefs ─────────────────
  // The page (/video-studio.html) lists the styles, posts a brief, and watches
  // tasks tagged "video-studio". A film is a normal task; see core/video-studio.ts.
  const studio = new VideoStudio(config.videoStudio);
  app.get('/api/video-studio', (_req, res) => {
    res.json({
      available: studio.available(), libDir: studio.cfg.libDir, libVersion: studio.libVersion(),
      defaultAgent: studio.cfg.defaultAgent, agents: studio.cfg.agents, aspects: ASPECTS, tag: VIDEO_STUDIO_TAG,
    });
  });
  app.get('/api/video-studio/styles', (_req, res) => {
    if (!studio.available()) return res.status(404).json({ error: `style library not found at ${studio.cfg.libDir}` });
    res.json(studio.styles());
  });
  app.get('/api/video-studio/frames/:slug', (req, res) => {
    const file = studio.posterFile(path.basename(req.params.slug).replace(/\.jpg$/, ''));
    if (!file) return res.status(404).json({ error: 'not found' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  });
  app.post('/api/video-studio/films', (req, res) => {
    try {
      if (!studio.available()) throw new Error(`style library not found at ${studio.cfg.libDir}`);
      const brief = studio.parseBrief(req.body);
      const inputs = Array.isArray(req.body?.inputs) ? req.body.inputs : undefined;
      const spec = studio.buildTask(brief, (inputs || []).map((i: any) => String(i?.name || '')).filter(Boolean));
      const task = store.createTask({
        ...spec,
        from: { platform: 'dashboard', agent: 'video-studio' },
        to: {},
        priority: 'normal',
      }, { inputs });
      res.status(201).json(task);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Audio Overview 語音導讀: source → narration script → edge-tts mp3 ──────
  // The page (/audio-overview.html) posts a source + options and watches tasks
  // tagged "audio-overview"; the audio is a normal task, see core/audio-overview.ts.
  const audioOverview = new AudioOverview({ defaultAgent: studio.cfg.defaultAgent, agents: studio.cfg.agents });
  app.get('/api/audio-overview', (_req, res) => {
    const vault = getObsidianVault(config.obsidian);
    res.json({
      tag: AUDIO_OVERVIEW_TAG, file: AUDIO_OVERVIEW_FILE, defaultAgent: audioOverview.defaultAgent, agents: audioOverview.agents,
      obsidian: !!vault && vault.available(),
    });
  });
  app.post('/api/audio-overview/tasks', (req, res) => {
    try {
      const brief = audioOverview.parseBrief(req.body);
      let text = '', label = 'pasted text';
      const src = brief.source;
      if (src.kind === 'text') text = src.text;
      else if (src.kind === 'task') {
        text = readTaskSourceFile(config.paths.artifacts, src.taskId, src.file);
        label = `task ${src.taskId} · ${src.file}`;
      } else {
        const vault = getObsidianVault(config.obsidian);
        const note = vault && vault.available() ? vault.read(src.path) : null;
        if (!note) throw new Error('obsidian note not found');
        text = note.content; label = `Obsidian · ${note.path}`;
      }
      if (text.trim().length < 20) throw new Error('source has no usable text');
      const spec = audioOverview.buildTask(brief, text, label);
      const task = store.createTask({
        ...spec,
        from: { platform: 'dashboard', agent: 'audio-overview' },
        to: {},
        priority: 'normal',
      });
      res.status(201).json(task);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Shotcraft: shortcut for the video-shotcraft agent skill ────────────────
  // The page (/shotcraft.html) picks shot cards + settings and creates a task,
  // recurring task, goal or workflow template from one brief; see core/shotcraft.ts.
  const shotcraft = new Shotcraft(config.shotcraft);
  app.get('/api/shotcraft', (_req, res) => {
    res.json({
      available: shotcraft.available(), skillDir: shotcraft.cfg.skillDir, version: shotcraft.version(),
      defaultAgent: shotcraft.cfg.defaultAgent, agents: shotcraft.cfg.agents, aspects: SHOTCRAFT_ASPECTS,
      lengths: SHOTCRAFT_LENGTHS, bgm: shotcraft.bgm(), tag: SHOTCRAFT_TAG, galleryUrl: GALLERY_URL,
    });
  });
  app.get('/api/shotcraft/shots', (_req, res) => {
    if (!shotcraft.available()) return res.status(404).json({ error: `video-shotcraft skill not found at ${shotcraft.cfg.skillDir}` });
    res.json(shotcraft.catalog());
  });
  app.get('/api/shotcraft/bgm/:name', (req, res) => {
    const file = shotcraft.bgmFile(req.params.name);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // The skill lives under ~/.agents — send refuses dot-dirs unless told otherwise.
    res.sendFile(file, { dotfiles: 'allow' });
  });
  app.post('/api/shotcraft/create', (req, res) => {
    try {
      if (!shotcraft.available()) throw new Error(`video-shotcraft skill not found at ${shotcraft.cfg.skillDir}`);
      const body = req.body || {};
      const kind = ['task', 'recurring', 'goal'].includes(body.kind) ? body.kind : 'task';
      const brief = shotcraft.parseBrief(body);
      const inputs = Array.isArray(body.inputs) ? body.inputs : undefined;
      const inputNames = (inputs || []).map((i: any) => String(i?.name || '')).filter(Boolean);
      const from = { platform: 'dashboard', agent: 'shotcraft' };
      // Preview: the exact brief the agent will get, nothing created.
      if (body.dryRun === true) {
        const preview = kind === 'goal' ? shotcraft.buildGoal(brief).description
          : shotcraft.buildTask(brief, inputNames).description;
        return res.json({ kind, brief, preview });
      }

      if (kind === 'task' || kind === 'recurring') {
        if (kind === 'recurring' && (brief.mode === 'guided' || brief.mode === 'ask')) {
          throw new Error('recurring films run unattended — pick autonomous, template or single-shot mode');
        }
        const recurrence = kind === 'recurring' ? normalizeRecurrence(body.recurrence || { type: 'weekly' }) : undefined;
        // A schedule's first film waits for its first slot unless asked to start now.
        const scheduledAt = typeof body.scheduledAt === 'string' && body.scheduledAt ? body.scheduledAt
          : recurrence && body.firstNow !== true ? nextRunAt(recurrence, new Date())?.toISOString() : undefined;
        const task = store.createTask({
          ...shotcraft.buildTask(brief, inputNames), from, to: {}, priority: 'normal',
          ...(recurrence ? { recurrence } : {}), ...(scheduledAt ? { scheduledAt } : {}),
        }, { inputs });
        return res.status(201).json({ kind, task });
      }
      if (inputs?.length) throw new Error('attachments only work for a task — use a URL/path source for goals');
      const goal = goals.create(shotcraft.buildGoal(brief));
      const active = body.activate === false ? goal : goals.activate(goal.goalId);
      return res.status(201).json({ kind, goal: active });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Integrations: GitHub / open-source repo → skill / portal web plugin ────
  // (ADR-014, core/integrations.ts; page /integrations.html, MCP tool
  // `integrations`). Fetch never runs repo code; every install is gated by the
  // static skill audit (core/skill-auditor.ts).
  const integrations = sharedIntegrations(config.integrations);
  const intEnabled = () => config.integrations?.enabled !== false;
  const localAgents = () => Object.entries(config.orchestration.agents || {})
    .filter(([, b]) => b.location === 'local').map(([id]) => id);
  const wrapAgentDefault = () => defaultWrapAgent(config.integrations?.wrapAgent, localAgents());
  app.use('/api/integrations', (_req, res, next) => {
    if (!intEnabled()) return res.status(404).json({ error: 'integrations are disabled (config integrations.enabled=false)' });
    next();
  });
  app.get('/api/integrations', (_req, res) => {
    res.json({
      root: integrations.root, skillsHome: integrations.skillsHome,
      clientSkillDirs: integrations.clientSkillDirs.filter(d => fs.existsSync(d)),
      allowHosts: integrations.allowHosts, wrapAgent: wrapAgentDefault(), agents: localAgents(),
      integrations: integrations.list(),
    });
  });
  app.post('/api/integrations', async (req, res) => {
    try {
      const body = req.body || {};
      res.status(201).json(await integrations.add(String(body.repo || ''), { install: body.install === true, force: body.force === true }));
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/integrations/audit', (req, res) => {
    try {
      const targets = defaultAuditTargets(config.integrations || {});
      const report = mergeReports(targets.map(t => auditPath(t, { allow: config.integrations?.auditAllow })), 'default targets');
      res.json({ targets, ...report, findings: report.findings.filter(f => req.body?.all === true || f.severity !== 'medium').slice(0, 500) });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/integrations/:id/:action', async (req, res) => {
    const id = path.basename(req.params.id);
    const body = req.body || {};
    try {
      switch (req.params.action) {
        case 'install': return res.json(integrations.install(id, { force: body.force === true, kinds: Array.isArray(body.kinds) ? body.kinds : undefined, skills: Array.isArray(body.skills) ? body.skills.map(String) : undefined }));
        case 'uninstall': return res.json(integrations.uninstall(id, { purge: body.purge === true }) || { id, purged: true });
        case 'update': return res.json(await integrations.update(id));
        case 'rescan': return res.json(integrations.rescan(id));
        case 'wrap': {
          // Rule 6: the clone lives under the operator's home, so the wrap task is
          // always pinned to a LOCAL agent.
          const agent = localAgents().includes(String(body.agent)) ? String(body.agent) : wrapAgentDefault();
          if (!agent) throw new Error('no local agent configured to run the wrap task');
          const spec = integrations.buildWrapTask(id, { agent, notes: typeof body.notes === 'string' ? body.notes.slice(0, 4000) : undefined });
          const task = store.createTask({
            ...spec, context: { ...spec.context, persona: 'engineering-developer-tooling-engineer' },
            from: { platform: 'dashboard', agent: 'integrations' }, to: {}, priority: 'normal',
          });
          return res.status(201).json({ task });
        }
        default: return res.status(404).json({ error: `unknown action ${req.params.action}` });
      }
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  // Installed web plugins, sandboxed: an opaque-origin CSP sandbox means plugin JS
  // can't read the dashboard's cookie-authenticated /api or its storage.
  app.use('/plugins/:id', (req, res, next) => {
    if (!intEnabled()) return res.status(404).send('not found');
    const root = integrations.webRoot(path.basename(req.params.id));
    if (!root) return res.status(404).send('plugin not installed');
    if (req.originalUrl.split('?')[0] === `/plugins/${req.params.id}`) {
      const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return res.redirect(301, `/plugins/${req.params.id}/${q}`);
    }
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Sandboxed docs have an opaque (null) origin, and <script type="module"> /
    // fonts are fetched in CORS mode — allow them (static, credential-less files).
    res.setHeader('Access-Control-Allow-Origin', '*');
    express.static(root, { dotfiles: 'deny', index: ['index.html'], fallthrough: false })(req, res, next);
  });

  // ── Connections: external MCP clients (heartbeat-live) + invocation counters ─
  app.get('/api/connections', async (req, res) => {
    if (req.query.refresh === '1' || req.query.refresh === 'true') {
      await usagePoller.refresh();
    }
    const now = Date.now();
    const clients = store.getActiveWorkers()
      .filter(a => a.sessionId !== 'dispatcher-worker' && !(a.platform === 'cowork' && a.workerName === 'orchestrator'))
      .map(a => ({
        id: a.id, workerName: a.workerName, platform: a.platform, status: a.status,
        capabilities: a.capabilities || [], registeredAt: a.registeredAt, lastHeartbeat: a.lastHeartbeat,
        live: now - new Date(a.lastHeartbeat).getTime() < 600000
      }));
    // usage: per-agent rate-limit snapshots (local poller + remote heartbeats);
    // localAgents: which of those live on THIS host, so the UI can render them
    // as a separate "cowork host" card instead of mis-filing them under a client.
    const localAgents = Object.entries(config.orchestration.agents || {})
      .filter(([, b]) => b.location === 'local' && isMeteredExec(b.exec))
      .map(([id]) => id);
    res.json({ clients, counters: store.getCounters(), usage: store.getAgentUsage(), localAgents });
  });

  // ── Task artifacts (persistent per-task dir; downloadable) ─────────────────
  const artifactsRoot = config.paths.artifacts;

  // `skipTop` names top-level entries to leave out (the artifacts listing skips
  // outputs/, which is served on its own by the /api/outputs routes).
  function listFilesRecursive(dir: string, base = '', skipTop: string[] = []): string[] {
    let results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
        if (!base && skipTop.includes(entry.name)) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          results.push(...listFilesRecursive(path.join(dir, entry.name), rel));
        } else if (entry.isFile()) {
          results.push(rel);
        }
      }
    } catch {}
    return results.sort();
  }

  app.get('/api/artifacts/:taskId', (req, res) => {
    const dir = path.join(artifactsRoot, path.basename(req.params.taskId));
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(listFilesRecursive(dir, '', [OUTPUTS_SUBDIR]));
  });
  app.get('/api/artifacts/:taskId/*file', (req, res) => {
    const taskId = path.basename(req.params.taskId);
    const rawFile = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
    const taskDir = path.resolve(artifactsRoot, taskId);
    const file = path.resolve(taskDir, rawFile);

    // Path traversal guard: must be strictly inside taskDir
    if (!file.startsWith(taskDir + path.sep)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // The dashboard opens a task's RESULT in the markdown viewer via the artifacts
    // route with the synthetic name "result.md". The local dispatcher writes a real
    // result.md to the artifacts dir, so prefer that on disk; but for tasks with no
    // file (remote agents, older runs) fall back to the task record's result text
    // rather than 404ing the chip.
    if (rawFile === 'result.md' && !fs.existsSync(file)) {
      const task = store.getTask(taskId);
      if (task && task.result) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="result.md"');
        return res.send(`# ${task.title || task.id}\n\n${task.result}\n`);
      }
    }
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });

    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

    // ?inline=1 serves without Content-Disposition: attachment, so <video>/<img>
    // on the Video Studio page play in place (send() handles Range for seeking).
    if (req.query.inline === '1') return res.sendFile(file);
    res.download(file, path.basename(file), (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'download failed' });
      }
    });
  });
  // Upload — a REMOTE agent client pushes each file it produced into the task's
  // artifacts dir (the local dispatcher collects them from disk instead). Raw
  // binary body so any size/type streams; path-guarded; stamps task.artifacts so
  // the inbox card lists it, and /api/artifacts/:taskId already serves it live.
  app.post('/api/artifacts/:taskId/*file', express.raw({ type: '*/*', limit: '256mb' }), (req, res) => {
    try {
      const taskId = path.basename(req.params.taskId);
      const rawFile = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
      if (!rawFile || rawFile === '.' || rawFile === '..') throw new Error('invalid filename');
      const taskDir = path.resolve(artifactsRoot, taskId);
      const dest = path.resolve(taskDir, rawFile);
      if (!dest.startsWith(taskDir + path.sep)) throw new Error('path escape');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!body.length) throw new Error('empty body');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      const task = store.getTask(taskId);
      if (task) {
        task.artifacts = [...new Set([...(task.artifacts || []), rawFile])];
        store.saveTask(task);
      }
      res.json({ ok: true, taskId, file: rawFile, bytes: body.length });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Task OUTPUTS (final deliverables in artifacts/<id>/outputs/) ───────────
  // Same layout + guards as the artifacts routes; the dashboard lists these in
  // their own OUTPUTS section, after RESULT and before the working ARTIFACTS.
  const outputsDir = (taskId: string) => path.resolve(artifactsRoot, path.basename(taskId), OUTPUTS_SUBDIR);
  app.get('/api/outputs/:taskId', (req, res) => {
    const dir = outputsDir(req.params.taskId);
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(listFilesRecursive(dir));
  });
  app.get('/api/outputs/:taskId/*file', (req, res) => {
    const dir = outputsDir(req.params.taskId);
    const rawFile = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
    const file = path.resolve(dir, rawFile);
    if (!file.startsWith(dir + path.sep)) return res.status(403).json({ error: 'forbidden' });
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return res.status(404).json({ error: 'not found' }); }
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
    if (req.query.inline === '1') return res.sendFile(file);
    res.download(file, path.basename(file), (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: 'download failed' });
    });
  });
  // Upload — a REMOTE agent client pushes each file from its outputs/ folder.
  app.post('/api/outputs/:taskId/*file', express.raw({ type: '*/*', limit: '256mb' }), (req, res) => {
    try {
      const taskId = path.basename(req.params.taskId);
      const rawFile = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
      if (!rawFile || rawFile === '.' || rawFile === '..') throw new Error('invalid filename');
      const dir = outputsDir(taskId);
      const dest = path.resolve(dir, rawFile);
      if (!dest.startsWith(dir + path.sep)) throw new Error('path escape');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!body.length) throw new Error('empty body');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      const task = store.getTask(taskId);
      if (task) {
        task.outputs = [...new Set([...(task.outputs || []), rawFile])];
        store.saveTask(task);
      }
      res.json({ ok: true, taskId, file: rawFile, bytes: body.length });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Task INPUT files (a person attaches files for the agent to read) ───────
  // Staging upload: raw binary body, filename via ?name= (or X-Upload-Filename).
  // Returns a token the client passes to POST /api/inbox ({inputs:[{token,name}]})
  // or POST /api/inbox/:id/inputs. Staged before the task exists so the chat
  // create-with-inputs flow is race-free.
  app.post('/api/uploads', express.raw({ type: '*/*', limit: '256mb' }), (req, res) => {
    try {
      const name = (req.query.name as string) || (req.headers['x-upload-filename'] as string) || 'file';
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const out = store.stageUpload(decodeURIComponent(name), body);
      res.status(201).json(out);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  // List / download a task's attached input files (path-guarded in the store).
  app.get('/api/inputs/:taskId', (req, res) => res.json(store.listInputs(req.params.taskId)));
  app.get('/api/inputs/:taskId/*file', (req, res) => {
    const rawFile = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
    // The dashboard opens a task's own brief in the markdown viewer via the
    // inputs route with the synthetic name "description.md" — serve it straight
    // from the task record rather than requiring a real file on disk.
    if (rawFile === 'description.md') {
      const task = store.getTask(req.params.taskId);
      if (task && task.description) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="description.md"');
        return res.send(task.description);
      }
    }
    const file = store.inputFilePath(req.params.taskId, rawFile);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.download(file, path.basename(file), (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'download failed' });
      }
    });
  });

  // ── Agents registry (worker profiles with an ordered agent chain) ──────────
  app.get('/api/roles-config', (_req, res) => res.json(config.orchestration.roleChains || {}));

  app.put('/api/roles-config/:name', (req, res) => {
    try {
      const name = req.params.name;
      const { description, agents } = req.body || {};
      if (!Array.isArray(agents)) throw new Error('agents (string[]) is required');
      const registry = config.orchestration.agents || {};
      const bad = agents.filter((b: string) => !registry[b]);
      if (bad.length) throw new Error(`unknown agent(s): ${bad.join(', ')}`);
      config.orchestration.roleChains = config.orchestration.roleChains || {};
      config.orchestration.roleChains[name] = { description: String(description || name), agents };
      persistRegistries(config);
      res.json({ ok: true, name, agent: config.orchestration.roleChains[name] });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/roles-config/:name', (req, res) => {
    delete (config.orchestration.roleChains || {})[req.params.name];
    persistRegistries(config);
    res.json({ ok: true });
  });

  // ── Agent registry (model × platform × location) ───────────────────────────
  // How often old-contract clients still show up; zero for a while means legacy-wire can go.
  app.get('/api/legacy-wire', (_req, res) => res.json(legacyWireUses()));

  app.get('/api/agents', (_req, res) => res.json(config.orchestration.agents || {}));

  app.put('/api/agents/:id', (req, res) => {
    try {
      const id = req.params.id;
      const { description, location, exec, model, command, host, thinking } = req.body || {};
      if (location !== 'local' && location !== 'remote') throw new Error('location must be local|remote');
      config.orchestration.agents = config.orchestration.agents || {};
      // Preserve the disabled flag through a PUT update — an agent stays disabled
      // (or enabled) unless the caller explicitly changes it.
      const prev = config.orchestration.agents[id];
      config.orchestration.agents[id] = {
        description: String(description || id), location,
        ...(exec ? { exec } : {}), ...(model !== undefined ? { model } : {}),
        ...(Array.isArray(command) ? { command } : {}), ...(host ? { host } : {}),
        ...(normalizeThinking(thinking) ? { thinking: normalizeThinking(thinking) } : {}),
        ...(prev?.disabled ? { disabled: true } : {})
      };
      persistRegistries(config);
      res.json({ ok: true, id, agent: config.orchestration.agents[id] });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // Set an agent's default thinking level ('' clears it back to the global default).
  app.patch('/api/agents/:id/thinking', (req, res) => {
    const agent = config.orchestration.agents?.[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const raw = req.body?.thinking;
    if (raw === '' || raw === null) delete agent.thinking;
    else {
      const level = normalizeThinking(raw);
      if (!level) return res.status(400).json({ error: `thinking must be one of ${THINKING_LEVELS.join(', ')}` });
      agent.thinking = level;
    }
    persistRegistries(config);
    res.json({ ok: true, id: req.params.id, thinking: agent.thinking ?? null });
  });

  // Disable an agent — it stays in the registry but is excluded from dispatch,
  // chain resolution, and the agent picker until re-enabled.
  app.patch('/api/agents/:id/disable', (req, res) => {
    const id = req.params.id;
    const agent = (config.orchestration.agents || {})[id];
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    agent.disabled = true;
    persistRegistries(config);
    res.json({ ok: true, id, disabled: true });
  });

  // Re-enable a previously disabled agent.
  app.patch('/api/agents/:id/enable', (req, res) => {
    const id = req.params.id;
    const agent = (config.orchestration.agents || {})[id];
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    delete agent.disabled;
    persistRegistries(config);
    res.json({ ok: true, id, disabled: false });
  });

  // Deregister an agent — and CASCADE: strip it from every chain so no
  // agent is left pointing at an agent that no longer exists.
  app.delete('/api/agents/:id', (req, res) => {
    const scrubbed = removeAgentCascade(config, req.params.id);
    res.json({ ok: true, id: req.params.id, agents_scrubbed: scrubbed });
  });

  // Graceful shutdown for systemd (SIGTERM) and Ctrl-C (SIGINT)
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    clearInterval(cleanup);
    sysMetrics.stop();
    usagePoller.stop();
    dispatcher.stop();
    server.close(() => process.exit(0));
    // Open SSE connections keep the server alive — force-exit after 3s
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
