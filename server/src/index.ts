import express from 'express';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { loadConfig, persistRegistries, removeBrainCascade, restoreClientBrains } from './config.js';
import { EventBus } from './core/events.js';
import { Store } from './core/store.js';
import { Dispatcher } from './core/dispatcher.js';
import { createMcpServer } from './mcp/server.js';
import { createApiRouter } from './api/router.js';
import { createWorkflowRouter } from './api/workflows.js';
import { createGoalRouter } from './api/goals.js';
import { createSSEHandler } from './api/sse.js';
import { Workflows } from './core/workflows.js';
import { Goals } from './core/goals.js';
import { SystemMetrics } from './core/system-metrics.js';
import { UsagePoller, isMeteredExec } from './core/usage-probe.js';
import { probeServices, unitState } from './core/service-probe.js';
import { controlService } from './core/service-control.js';
import { getObsidianVault } from './core/obsidian.js';

async function main() {
  const config = loadConfig();
  const eventBus = new EventBus();
  const store = new Store(config, eventBus);

  store.initialize();

  // Self-heal the brain registry from the last known CLIENT declarations: a
  // client-declared brain (e.g. every `local-agy-*` the Antigravity client
  // registers) must always be selectable, but a full-config UI save or a
  // template reseed can wipe the persisted dynamic entries — and clients only
  // re-declare their brains when THEY restart, not when the server does.
  // Restore anything the persisted roster still declares before the dispatcher
  // and UI come up. Idempotent; existing static defs are never overwritten.
  try {
    const restored = restoreClientBrains(config, store.getActiveAgents());
    if (restored.length) {
      console.log(`Restored ${restored.length} client-declared brain(s) into the registry: ${restored.join(', ')}`);
    }
  } catch (e) {
    console.error('restoreClientBrains failed:', e);
  }

  // Host system-load sampler feeding the dashboard's top metrics bar.
  const sysMetrics = new SystemMetrics();
  sysMetrics.start();

  // Rate-limit usage sampler for LOCAL metered brains (claude/codex on this
  // host). Remote brains self-report through their heartbeat instead.
  const usagePoller = new UsagePoller(store, () => config.orchestration.brains || {});
  usagePoller.start();

  const app = express();
  app.use(express.json());

  // Optional API-key auth: guards /api and /mcp when server.apiKey is set.
  // Accepts "Authorization: Bearer <key>", "X-API-Key: <key>", or "?apiKey=<key>"
  // (query form exists for browser EventSource, which can't set headers).
  if (config.server.apiKey) {
    const requireKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      const provided = bearer || (req.headers['x-api-key'] as string) || (req.query.apiKey as string);
      if (provided !== config.server.apiKey) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    };
    app.use('/api', requireKey);
    app.use('/mcp', requireKey);
    console.log('API key auth: enabled');
  }

  // SSE
  app.get('/api/events', createSSEHandler(eventBus));

  // REST API
  const apiRouter = createApiRouter(store, eventBus);
  app.use('/api', apiRouter);

  // Declarative workflows: templates in paths.workflows compiled into DAG tasks.
  if (!fs.existsSync(config.paths.workflows)) {
    try { fs.mkdirSync(config.paths.workflows, { recursive: true }); } catch { /* ignore */ }
  }
  const workflows = new Workflows(config, store);
  app.use('/api', createWorkflowRouter(workflows));

  // Goals: long-lived, phase-tracked objectives beneath Workflows. State lives in
  // paths.goals (goals/*.json). The Achiever half is driven by the dispatcher's
  // tick; the Judger half is event-driven — Goals.onTaskCompleted rides the store's
  // existing taskCompleted event (no new transport) to audit each finished phase.
  if (!fs.existsSync(config.paths.goals)) {
    try { fs.mkdirSync(config.paths.goals, { recursive: true }); } catch { /* ignore */ }
  }
  const goals = new Goals(config, store);
  app.use('/api', createGoalRouter(goals));
  eventBus.on('taskCompleted', (evt: any) => {
    try { goals.onTaskCompleted(evt.payload.task); }
    catch (e) { console.error('Goals: taskCompleted handler failed:', e); }
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

  // Serve over HTTPS when server.tls is configured and the cert/key are present.
  // A secure context (https:// or localhost) is what unlocks the browser mic API,
  // so the New-task Dictate button only works over http:// on localhost — on a
  // LAN/Tailscale IP it needs this. Falls back to plain http:// otherwise.
  let scheme = 'http';
  const tls = config.server.tls;
  if (tls) {
    if (fs.existsSync(tls.certFile) && fs.existsSync(tls.keyFile)) {
      scheme = 'https';
    } else {
      console.warn(
        `server.tls is set but the cert/key were not found ` +
        `(${tls.certFile}, ${tls.keyFile}); falling back to http:// — the New-task ` +
        `Dictate button will only work on localhost.`
      );
    }
  }

  const onListen = () => {
    console.log(`=========================================`);
    console.log(` Multi-Agent Cowork MCP Server Started`);
    console.log(` HTTP API: ${scheme}://${config.server.host}:${config.server.port}/api`);
    console.log(` MCP Endpoint: ${scheme}://${config.server.host}:${config.server.port}/mcp`);
    console.log(` SSE Stream: ${scheme}://${config.server.host}:${config.server.port}/api/events`);
    console.log(`=========================================`);
  };

  const httpServer = scheme === 'https'
    ? https.createServer(
        { cert: fs.readFileSync(tls!.certFile), key: fs.readFileSync(tls!.keyFile) },
        app
      ).listen(config.server.port, config.server.host, onListen)
    : http.createServer(app).listen(config.server.port, config.server.host, onListen);

  // Stale agent cleanup every 5 minutes, ~3 min timeout (200000ms)
  const cleanup = setInterval(() => {
    store.removeStaleAgents(200000);
  }, 300000);


  // Dispatcher: executes role-tagged inbox tasks by spawning platform CLIs, and
  // drives orchestrated workflow runs (decides each next step via the router brain).
  const dispatcher = new Dispatcher(config, store, eventBus, workflows, goals);
  dispatcher.start();
  app.get('/api/dispatcher', (_req, res) => {
    res.json({
      enabled: config.orchestration.enabled,
      agents: config.orchestration.agents || {},
      brains: config.orchestration.brains || {},
      defaultChain: config.orchestration.defaultChain || [],
      divisionChains: config.orchestration.divisionChains || {},
      running: dispatcher.getRunning()
    });
  });

  // ── Brain fallback chains (global default + per-division + per-agent) ───────
  app.get('/api/chains', (_req, res) => res.json({
    defaultChain: config.orchestration.defaultChain || [],
    divisionChains: config.orchestration.divisionChains || {},
    agentChains: config.orchestration.agentChains || {}
  }));

  const validChain = (brains: any): string[] => {
    if (!Array.isArray(brains)) throw new Error('brains (string[]) required');
    const reg = config.orchestration.brains || {};
    const bad = brains.filter((b: string) => !reg[b]);
    if (bad.length) throw new Error(`unknown brain(s): ${bad.join(', ')}`);
    return brains;
  };
  app.put('/api/chains/default', (req, res) => {
    try {
      config.orchestration.defaultChain = validChain(req.body?.brains);
      persistRegistries(config);
      res.json({ ok: true, defaultChain: config.orchestration.defaultChain });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/chains/division/:division', (req, res) => {
    try {
      config.orchestration.divisionChains = config.orchestration.divisionChains || {};
      const brains = validChain(req.body?.brains);
      if (brains.length) config.orchestration.divisionChains[req.params.division] = brains;
      else delete config.orchestration.divisionChains[req.params.division];   // empty = use default
      persistRegistries(config);
      res.json({ ok: true, division: req.params.division, brains });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  // Per-roster-agent override. Empty brains[] clears it (agent falls back to its
  // division's chain, then the global default).
  app.put('/api/chains/agent/:agent', (req, res) => {
    try {
      config.orchestration.agentChains = config.orchestration.agentChains || {};
      const brains = validChain(req.body?.brains);
      if (brains.length) config.orchestration.agentChains[req.params.agent] = brains;
      else delete config.orchestration.agentChains[req.params.agent];
      persistRegistries(config);
      res.json({ ok: true, agent: req.params.agent, brains });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Roster grouped by division (for the Agents view) ───────────────────────
  app.get('/api/roster-divisions', (_req, res) => {
    const roster = store.getRoster();
    const meta = store.getDivisions() || {};
    const byDiv: Record<string, any> = {};
    for (const a of roster) {
      const d = a.division || 'other';
      (byDiv[d] ||= { label: meta[d]?.label || d, icon: meta[d]?.icon, color: meta[d]?.color, agents: [] }).agents.push({ slug: a.slug, name: a.name, description: a.description, emoji: a.emoji });
    }
    res.json(byDiv);
  });

  // ── Host system load (CPU/GPU/memory/temperature) for the dashboard bar ────
  // Cached snapshot refreshed on a background timer, so this is O(1) and safe to
  // poll every few seconds from the UI.
  app.get('/api/system', (_req, res) => res.json(sysMetrics.get()));

  // ── Service reachability for the Portal (probed from the host) ─────────────
  app.get('/api/services', async (_req, res) => {
    try {
      const status = await probeServices(config.services);
      // The Obsidian card is served by THIS server (not a separate port), so its
      // "online" is simply whether the configured vault exists on disk — fold a
      // synthetic status in so the Portal dot reflects reality without an HTTP probe.
      const vault = getObsidianVault(config.obsidian);
      if (vault) {
        const ok = vault.available();
        status.obsidian = { key: 'obsidian', enabled: true, online: ok, code: null, ms: null, ...(ok ? {} : { reason: 'vault not found' }) };
      }
      // Decorate entries whose config names a systemd --user unit with its
      // runtime + autostart state, so the Portal can show a unit-state chip
      // alongside the reachability dot. "Port answers" and "unit active" are
      // different facts and can disagree, so both are surfaced. This adds ~2
      // systemctl calls per controllable unit per poll — cheap for a handful.
      const svcCfg = config.services || {};
      await Promise.all(Object.entries(svcCfg).map(async ([key, svc]) => {
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
        services: config.services || {},
      });
      res.status(out.status).json(out.body);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Obsidian Vault: shared knowledge base (read-only) ──────────────────────
  // Every brain queries the vault here; local brains may also read config.obsidian
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

  // ── Connections: external MCP clients (heartbeat-live) + invocation counters ─
  app.get('/api/connections', (_req, res) => {
    const now = Date.now();
    const clients = store.getActiveAgents()
      .filter(a => a.sessionId !== 'dispatcher-worker' && !(a.platform === 'cowork' && a.agentName === 'orchestrator'))
      .map(a => ({
        id: a.id, agentName: a.agentName, platform: a.platform, status: a.status,
        capabilities: a.capabilities || [], registeredAt: a.registeredAt, lastHeartbeat: a.lastHeartbeat,
        live: now - new Date(a.lastHeartbeat).getTime() < 600000
      }));
    // usage: per-brain rate-limit snapshots (local poller + remote heartbeats);
    // localBrains: which of those live on THIS host, so the UI can render them
    // as a separate "cowork host" card instead of mis-filing them under a client.
    const localBrains = Object.entries(config.orchestration.brains || {})
      .filter(([, b]) => b.location === 'local' && isMeteredExec(b.exec))
      .map(([id]) => id);
    res.json({ clients, counters: store.getCounters(), usage: store.getBrainUsage(), localBrains });
  });

  // ── Task artifacts (persistent per-task dir; downloadable) ─────────────────
  const artifactsRoot = config.paths.artifacts;
  app.get('/api/artifacts/:taskId', (req, res) => {
    const dir = path.join(artifactsRoot, path.basename(req.params.taskId));
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(fs.readdirSync(dir).filter(f => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } }));
  });
  app.get('/api/artifacts/:taskId/:file', (req, res) => {
    // basename() on both segments blocks path traversal.
    const file = path.join(artifactsRoot, path.basename(req.params.taskId), path.basename(req.params.file));
    // The dashboard opens a task's RESULT in the markdown viewer via the artifacts
    // route with the synthetic name "result.md". The local dispatcher writes a real
    // result.md to the artifacts dir, so prefer that on disk; but for tasks with no
    // file (remote brains, older runs) fall back to the task record's result text
    // rather than 404ing the chip.
    if (req.params.file === 'result.md' && !fs.existsSync(file)) {
      const task = store.getTask(path.basename(req.params.taskId));
      if (task && task.result) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="result.md"');
        return res.send(`# ${task.title || task.id}\n\n${task.result}\n`);
      }
    }
    if (!file.startsWith(artifactsRoot) || !fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    res.download(file);
  });
  // Upload — a REMOTE brain client pushes each file it produced into the task's
  // artifacts dir (the local dispatcher collects them from disk instead). Raw
  // binary body so any size/type streams; path-guarded; stamps task.artifacts so
  // the inbox card lists it, and /api/artifacts/:taskId already serves it live.
  app.post('/api/artifacts/:taskId/:file', express.raw({ type: '*/*', limit: '256mb' }), (req, res) => {
    try {
      const taskId = path.basename(req.params.taskId);
      const fileName = path.basename(req.params.file);
      if (!fileName || fileName === '.' || fileName === '..') throw new Error('invalid filename');
      const dir = path.join(artifactsRoot, taskId);
      const dest = path.join(dir, fileName);
      if (!dest.startsWith(artifactsRoot + path.sep)) throw new Error('path escape');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!body.length) throw new Error('empty body');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, body);
      const task = store.getTask(taskId);
      if (task) {
        task.artifacts = [...new Set([...(task.artifacts || []), fileName])];
        store.saveTask(task);
      }
      res.json({ ok: true, taskId, file: fileName, bytes: body.length });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Task INPUT files (a person attaches files for the brain to read) ───────
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
  app.get('/api/inputs/:taskId/:file', (req, res) => {
    // The dashboard opens a task's own brief in the markdown viewer via the
    // inputs route with the synthetic name "description.md" — serve it straight
    // from the task record rather than requiring a real file on disk.
    if (req.params.file === 'description.md') {
      const task = store.getTask(req.params.taskId);
      if (task && task.description) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="description.md"');
        return res.send(task.description);
      }
    }
    const file = store.inputFilePath(req.params.taskId, req.params.file);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.download(file);
  });

  // ── Agents registry (worker profiles with an ordered brain chain) ──────────
  app.get('/api/agents-config', (_req, res) => res.json(config.orchestration.agents || {}));

  app.put('/api/agents-config/:name', (req, res) => {
    try {
      const name = req.params.name;
      const { description, brains } = req.body || {};
      if (!Array.isArray(brains)) throw new Error('brains (string[]) is required');
      const registry = config.orchestration.brains || {};
      const bad = brains.filter((b: string) => !registry[b]);
      if (bad.length) throw new Error(`unknown brain(s): ${bad.join(', ')}`);
      config.orchestration.agents = config.orchestration.agents || {};
      config.orchestration.agents[name] = { description: String(description || name), brains };
      persistRegistries(config);
      res.json({ ok: true, name, agent: config.orchestration.agents[name] });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/agents-config/:name', (req, res) => {
    delete (config.orchestration.agents || {})[req.params.name];
    persistRegistries(config);
    res.json({ ok: true });
  });

  // ── Brain registry (model × platform × location) ───────────────────────────
  app.get('/api/brains', (_req, res) => res.json(config.orchestration.brains || {}));

  app.put('/api/brains/:id', (req, res) => {
    try {
      const id = req.params.id;
      const { description, location, exec, model, command, host } = req.body || {};
      if (location !== 'local' && location !== 'remote') throw new Error('location must be local|remote');
      config.orchestration.brains = config.orchestration.brains || {};
      config.orchestration.brains[id] = {
        description: String(description || id), location,
        ...(exec ? { exec } : {}), ...(model !== undefined ? { model } : {}),
        ...(Array.isArray(command) ? { command } : {}), ...(host ? { host } : {})
      };
      persistRegistries(config);
      res.json({ ok: true, id, brain: config.orchestration.brains[id] });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // Deregister a brain — and CASCADE: strip it from every agent's chain so no
  // agent is left pointing at a brain that no longer exists.
  app.delete('/api/brains/:id', (req, res) => {
    const scrubbed = removeBrainCascade(config, req.params.id);
    res.json({ ok: true, id: req.params.id, agents_scrubbed: scrubbed });
  });

  // Graceful shutdown for systemd (SIGTERM) and Ctrl-C (SIGINT)
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    clearInterval(cleanup);
    sysMetrics.stop();
    usagePoller.stop();
    dispatcher.stop();
    httpServer.close(() => process.exit(0));
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
