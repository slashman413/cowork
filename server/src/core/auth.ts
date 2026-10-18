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
}

export function resolveApiKey(opts: {
  apiKey: string | null;
  host: string;
  allowUnauthenticated?: boolean;
  keyFile: string;
}): ResolvedKey {
  if (opts.apiKey) return { key: opts.apiKey, source: 'config' };
  if (isLoopbackHost(opts.host)) return { key: null, source: 'none' };
  if (opts.allowUnauthenticated || process.env.COWORK_ALLOW_NO_AUTH === '1') {
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
