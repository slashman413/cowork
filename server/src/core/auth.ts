import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * API-key resolution for /api and /mcp.
 *
 * A server bound to a non-loopback address must not run open: anyone who can
 * reach the port could create tasks that brains (full permissions) then claim
 * and run. So when the host is not loopback and no key is configured, a random
 * key is generated once, saved beside the config (mode 0600) and printed once.
 * Running open on a network address needs an explicit opt-out:
 * server.allowUnauthenticated: true or COWORK_ALLOW_NO_AUTH=1.
 *
 * Setting a key AND the opt-out is the migration ("soft") mode: a valid key is
 * accepted, a wrong key is rejected, and a request with no key still passes but
 * is recorded, so an operator can see which clients still need the key before
 * dropping the opt-out.
 */

export const AUTH_COOKIE = 'cowork_key';

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export interface ResolvedKey {
  key: string | null;
  /** Where the key came from: config/env, the key file, freshly generated, or none. */
  source: 'config' | 'file' | 'generated' | 'none';
  file?: string;
  /** No key on a network address because the operator opted out. */
  openOptOut?: boolean;
  /** Key set but keyless requests still allowed (migration mode). */
  soft?: boolean;
}

export function resolveApiKey(opts: {
  apiKey: string | null;
  host: string;
  allowUnauthenticated?: boolean;
  keyFile: string;
}): ResolvedKey {
  const optOut = !!opts.allowUnauthenticated || process.env.COWORK_ALLOW_NO_AUTH === '1';
  if (opts.apiKey) return { key: opts.apiKey, source: 'config', ...(optOut ? { soft: true } : {}) };
  if (isLoopbackHost(opts.host)) return { key: null, source: 'none' };
  if (optOut) {
    return { key: null, source: 'none', openOptOut: true };
  }
  try {
    const saved = fs.readFileSync(opts.keyFile, 'utf8').trim();
    if (saved) return { key: saved, source: 'file', file: opts.keyFile };
  } catch { /* no key file yet */ }
  const key = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(opts.keyFile), { recursive: true });
  fs.writeFileSync(opts.keyFile, key + '\n', { mode: 0o600 });
  return { key, source: 'generated', file: opts.keyFile };
}

/** Constant-time key check. Hashing first makes both buffers the same length,
 *  so a length mismatch doesn't leak through an early return. */
export function keyMatches(provided: unknown, key: string): boolean {
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export interface KeylessCaller {
  ip: string;
  userAgent: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastPath: string;
}

/** Soft-mode record of requests that arrived without a key, one row per
 *  (ip, user agent). onNew fires the first time a caller is seen. */
export class KeylessLog {
  private callers = new Map<string, KeylessCaller>();
  constructor(private onNew?: (c: KeylessCaller) => void, private max = 500) {}

  record(ip: string, userAgent: string, path: string, now = new Date()): void {
    const id = `${ip}|${userAgent}`;
    const ts = now.toISOString();
    const c = this.callers.get(id);
    if (c) {
      c.count++;
      c.lastSeen = ts;
      c.lastPath = path;
      return;
    }
    if (this.callers.size >= this.max) return;
    const row = { ip, userAgent, count: 1, firstSeen: ts, lastSeen: ts, lastPath: path };
    this.callers.set(id, row);
    this.onNew?.(row);
  }

  list(): KeylessCaller[] {
    return [...this.callers.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }
}
