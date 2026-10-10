import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ServiceConfig } from '../types.js';

const pexecFile = promisify(execFile);

/**
 * Server-side reachability probe for the Portal's self-hosted services.
 *
 * The dashboard is usually opened from another machine, so the browser can't
 * reliably reach a service's loopback URL and cross-origin checks just trip
 * CORS. The server, however, runs ON the host — so it probes each service's
 * real (localhost) URL here and reports up/down to the UI. Any HTTP response
 * (even 401/403/404) means the port is open and something is listening, so the
 * service counts as online; only a connection error or timeout is offline.
 *
 * Per ServiceConfig semantics, a service with `enabled: false` is listed but
 * never probed — it's reported as disabled rather than offline. `probe` may
 * point the check at a different URL, or turn it off (reason "not probed").
 */

export interface ServiceStatus {
  key: string;
  /** Whether the operator monitors this service (config `enabled`). */
  enabled: boolean;
  /** True when the port answered; false when unreachable OR not probed. */
  online: boolean;
  /** HTTP status code if we got a response, else null. */
  code: number | null;
  /** Round-trip in ms, or null when not probed. */
  ms: number | null;
  /** Short reason when not online (timeout / unreachable / disabled / no url). */
  reason?: string;
  /** systemd --user unit backing this service, when one is configured. Presence
   *  is what tells the UI to render Start/Stop/Restart controls for the card. */
  unit?: string;
  /** Whether boot-autostart Enable/Disable is exposed for this unit. */
  controllable?: boolean;
  /** Runtime unit state: active | inactive | failed | activating | unknown. */
  active?: string;
  /** Boot-autostart state: enabled | disabled | static | masked | unknown. */
  autostart?: string;
}

export async function probeServices(
  services: Record<string, ServiceConfig> | undefined,
  timeoutMs = 2500
): Promise<Record<string, ServiceStatus>> {
  // services comes from portal.json (core/portal-config.ts) — the same catalog
  // the Portal renders, so every card has a matching probe result.
  const entries = Object.entries(services || {});
  const results = await Promise.all(entries.map(([key, svc]) => probeOne(key, svc, timeoutMs)));
  const out: Record<string, ServiceStatus> = {};
  for (const r of results) out[r.key] = r;
  return out;
}

/**
 * Unit-name shape guard. Units come from config, never from a request, so this
 * is defense-in-depth: it keeps a malformed config entry from ever reaching
 * systemctl and bounds what the reachability decorator will query.
 */
export const UNIT_RE = /^[A-Za-z0-9@._:-]+\.(service|socket|timer|target)$/;

/**
 * `systemctl --user <subcmd> <unit>` state for one unit. is-active / is-enabled
 * signal state via EXIT CODE (non-zero = inactive/disabled/failed), so a
 * rejection is normal here, not an error — we read the trimmed stdout regardless
 * and only fall back to "unknown" when there is nothing to read.
 */
async function systemctlQuery(subcmd: 'is-active' | 'is-enabled', unit: string): Promise<string> {
  try {
    const { stdout } = await pexecFile('systemctl', ['--user', subcmd, unit], { timeout: 4000 });
    return stdout.trim() || 'unknown';
  } catch (e: any) {
    const s = String(e?.stdout || '').trim();
    return s || 'unknown'; // "inactive" / "failed" / "disabled" / "static" arrive here
  }
}

/** Read runtime (active) and boot-autostart (enabled) state for a --user unit. */
export async function unitState(unit: string): Promise<{ active: string; autostart: string }> {
  if (!UNIT_RE.test(unit)) return { active: 'unknown', autostart: 'unknown' };
  const [active, autostart] = await Promise.all([
    systemctlQuery('is-active', unit),
    systemctlQuery('is-enabled', unit),
  ]);
  return { active, autostart };
}

async function probeOne(key: string, svc: ServiceConfig, timeoutMs: number): Promise<ServiceStatus> {
  const enabled = svc?.enabled !== false;
  if (!svc?.url) return { key, enabled, online: false, code: null, ms: null, reason: 'no url' };
  if (!enabled) return { key, enabled, online: false, code: null, ms: null, reason: 'disabled' };
  // probe:false opts out; a relative url (e.g. "/obsidian.html") is served by
  // this dashboard itself and has no host to probe.
  const url = svc.probe === false ? '' : (svc.probe || svc.url);
  if (!/^https?:\/\//i.test(url)) return { key, enabled, online: false, code: null, ms: null, reason: 'not probed' };

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // redirect:'manual' so a login redirect still counts as "up" without an
    // extra hop; we never read the body — the status line is all we need.
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { key, enabled, online: true, code: res.status || null, ms: Date.now() - started };
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.code || 'unreachable');
    return { key, enabled, online: false, code: null, ms: Date.now() - started, reason: String(reason) };
  } finally {
    clearTimeout(timer);
  }
}
