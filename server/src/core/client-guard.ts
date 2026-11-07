import type express from 'express';

/**
 * Client denylist for /api, /mcp and everything else the hub serves.
 *
 * The API key cannot single out one client: every agent client shares the same
 * key (and in soft mode keyless calls pass anyway). This guard rejects a client
 * by WHO it is, independent of auth, configured in server.blockedClients:
 *
 *   ips   — source addresses (exact; IPv4-mapped IPv6 is normalised). Every
 *           request from them is rejected, on every path.
 *   names — case-insensitive substrings matched against the caller's declared
 *           identity: User-Agent, X-Cowork-Client, the MCP initialize
 *           clientInfo.name, and tool-call identity arguments (agent_name,
 *           agent_id of a blocked agent, capabilities[], agents[].id, agent).
 *           Free-text fields (task titles, descriptions, results) are NOT
 *           scanned, so a task that merely mentions a blocked name still works.
 *
 * Agents whose id matches a name, or that a blocked agent registered, are also
 * marked disabled so the dispatcher stops routing tasks to them
 * (see disableBlockedAgents).
 */

export interface BlockedClients {
  ips?: string[];
  names?: string[];
}

export interface GuardVerdict {
  blocked: boolean;
  reason?: string;
}

export function normalizeIp(ip: string | undefined): string {
  const s = (ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return s.startsWith('::ffff:') && s.includes('.') ? s.slice(7) : s;
}

export class ClientGuard {
  private ips: Set<string>;
  private names: string[];

  constructor(cfg: BlockedClients | undefined | null,
              private workerLookup: () => Array<{ id: string; workerName?: string; capabilities?: string[] }> = () => []) {
    this.ips = new Set((cfg?.ips || []).map(normalizeIp).filter(Boolean));
    this.names = (cfg?.names || []).map(n => n.trim().toLowerCase()).filter(Boolean);
  }

  get active(): boolean { return this.ips.size > 0 || this.names.length > 0; }

  /** The blocked name a string contains, if any. */
  matchName(s: unknown): string | undefined {
    if (typeof s !== 'string' || !s) return undefined;
    const l = s.toLowerCase();
    return this.names.find(n => l.includes(n));
  }

  ipBlocked(ip: string | undefined): boolean {
    return this.ips.has(normalizeIp(ip));
  }

  /** An agent id belongs to a blocked client when its name or any declared
   *  agent matches. Unknown ids are not blocked here (the IP/name checks on the
   *  register call already stopped a blocked client from obtaining one). */
  private workerBlocked(workerId: unknown, extraBlockedIds: Set<string>): string | undefined {
    if (typeof workerId !== 'string' || !workerId) return undefined;
    if (extraBlockedIds.has(workerId)) return `agent ${workerId}`;
    const a = this.workerLookup().find(x => x.id === workerId);
    if (!a) return undefined;
    const hit = this.matchName(a.workerName) || (a.capabilities || []).map(c => this.matchName(c)).find(Boolean);
    return hit ? `agent ${workerId} (${hit})` : undefined;
  }

  /** Inspect one JSON-RPC message sent to /mcp. */
  private checkRpc(msg: any, blockedWorkerIds: Set<string>): string | undefined {
    if (!msg || typeof msg !== 'object') return undefined;
    const p = msg.params || {};
    if (msg.method === 'initialize') {
      const hit = this.matchName(p.clientInfo?.name);
      if (hit) return `mcp clientInfo.name "${p.clientInfo.name}"`;
    }
    if (msg.method === 'tools/call') {
      const a = p.arguments || {};
      for (const k of ['agent_name', 'platform', 'agent', 'claimed_by', 'session_id']) {
        const hit = this.matchName(a[k]);
        if (hit) return `mcp ${p.name}.${k} "${a[k]}"`;
      }
      if (Array.isArray(a.capabilities)) {
        const c = a.capabilities.find((x: unknown) => this.matchName(x));
        if (c) return `mcp ${p.name}.capabilities "${c}"`;
      }
      if (Array.isArray(a.agents)) {
        const b = a.agents.find((x: any) => this.matchName(x?.id) || this.matchName(x?.host));
        if (b) return `mcp ${p.name}.agents "${b.id}"`;
      }
      if (a.usage && typeof a.usage === 'object') {
        const k = Object.keys(a.usage).find(x => this.matchName(x));
        if (k) return `mcp ${p.name}.usage "${k}"`;
      }
      for (const k of ['agent_id', 'workerId']) {
        const hit = this.workerBlocked(a[k], blockedWorkerIds);
        if (hit) return `mcp ${p.name}.${k} = ${hit}`;
      }
    }
    return undefined;
  }

  /** Decide on one request. `blockedWorkerIds` = agent ids that registered a
   *  blocked agent (from the agent registry's registeredBy). */
  check(req: { ip?: string; socketIp?: string; headers: Record<string, unknown>; path: string; body?: unknown },
        blockedWorkerIds: Set<string> = new Set()): GuardVerdict {
    if (!this.active) return { blocked: false };
    for (const ip of [req.ip, req.socketIp]) {
      if (ip && this.ipBlocked(ip)) return { blocked: true, reason: `ip ${normalizeIp(ip)}` };
    }
    for (const h of ['user-agent', 'x-cowork-client', 'x-cowork-agent']) {
      const v = req.headers[h];
      const hit = this.matchName(Array.isArray(v) ? v.join(' ') : v);
      if (hit) return { blocked: true, reason: `header ${h} "${String(v)}"` };
    }
    if (req.path === '/mcp' || req.path.startsWith('/mcp/')) {
      const msgs = Array.isArray(req.body) ? req.body : [req.body];
      for (const m of msgs) {
        const r = this.checkRpc(m, blockedWorkerIds);
        if (r) return { blocked: true, reason: r };
      }
    }
    return { blocked: false };
  }

  /** Express middleware. Must run after express.json() so /mcp bodies are parsed. */
  middleware(blockedWorkerIds: () => Set<string>, onBlock?: (reason: string, req: express.Request) => void): express.RequestHandler {
    return (req, res, next) => {
      const v = this.check({
        ip: req.ip, socketIp: req.socket?.remoteAddress, headers: req.headers as Record<string, unknown>,
        path: req.path, body: req.body
      }, blockedWorkerIds());
      if (!v.blocked) return next();
      onBlock?.(v.reason || 'blocked', req);
      if (req.path === '/mcp' || req.path.startsWith('/mcp/')) {
        const id = (req.body && !Array.isArray(req.body) && (req.body as any).id) ?? null;
        res.status(403).json({ jsonrpc: '2.0', error: { code: -32001, message: 'forbidden: client blocked by server policy' }, id });
        return;
      }
      res.status(403).json({ error: 'forbidden: client blocked by server policy' });
    };
  }

  /** Mark every agent that matches a blocked name, or that a blocked agent
   *  registered, as disabled. Returns the ids newly disabled. */
  disableBlockedAgents(agents: Record<string, { disabled?: boolean; registeredBy?: string; host?: string; clientId?: string }>): string[] {
    if (!this.names.length) return [];
    const changed: string[] = [];
    for (const [id, b] of Object.entries(agents)) {
      if (b.disabled) continue;
      if (this.matchName(id) || this.matchName(b.host) || this.matchName(b.clientId)) {
        b.disabled = true;
        changed.push(id);
      }
    }
    return changed;
  }

  /** Agent ids that registered a blocked agent (blocked agents = id/host matches). */
  blockedWorkerIds(agents: Record<string, { registeredBy?: string; host?: string; clientId?: string }>): Set<string> {
    const out = new Set<string>();
    if (!this.names.length) return out;
    for (const [id, b] of Object.entries(agents)) {
      if (b.registeredBy && (this.matchName(id) || this.matchName(b.host) || this.matchName(b.clientId))) out.add(b.registeredBy);
    }
    return out;
  }
}
