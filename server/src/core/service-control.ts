import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ServiceConfig } from '../types.js';
import { UNIT_RE } from './service-probe.js';

const pexecFile = promisify(execFile);

export const CONTROL_ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable'] as const);
export type ControlAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable';

/**
 * Units the Portal must never touch — controlling them from the very UI the
 * server hosts self-kills the request handler (the same class of trap as an
 * in-task redeploy). Refused server-side regardless of config, as a backstop to
 * the client not rendering their buttons.
 */
const PROTECTED_UNITS = new Set(['cowork-mcp.service']);
const PROTECTED_PREFIXES = ['cowork-local-brain@'];

function isProtected(unit: string): boolean {
  if (PROTECTED_UNITS.has(unit)) return true;
  return PROTECTED_PREFIXES.some((p) => unit.startsWith(p));
}

export interface ControlOutcome {
  status: number; // HTTP status to return
  body: Record<string, unknown>;
}

/**
 * Resolve + validate + execute a systemd --user lifecycle action.
 *
 * The `unit` is ALWAYS taken from server config keyed by `key`; the caller only
 * supplies `key` + `action`, so no request-supplied string ever reaches
 * systemctl. `execFile` with an argv array means no shell parses anything, so
 * command injection is structurally impossible. Guards run in a fixed order and
 * each returns before systemctl is ever invoked.
 */
export async function controlService(
  key: string,
  action: string,
  cfg: {
    controlEnabled: boolean;
    apiKeySet: boolean;
    services: Record<string, ServiceConfig>;
  },
): Promise<ControlOutcome> {
  if (!cfg.controlEnabled)
    return { status: 403, body: { ok: false, error: 'service control disabled (set serviceControl.enabled)' } };
  if (!CONTROL_ACTIONS.has(action as ControlAction))
    return { status: 400, body: { ok: false, error: `invalid action "${action}"` } };
  if (!cfg.apiKeySet)
    return { status: 403, body: { ok: false, error: 'set server.apiKey before enabling service mutations' } };

  const svc = cfg.services?.[key];
  if (!svc?.unit) return { status: 404, body: { ok: false, error: `no controllable unit for "${key}"` } };
  if (!UNIT_RE.test(svc.unit)) return { status: 400, body: { ok: false, error: 'invalid unit name in config' } };
  if ((action === 'enable' || action === 'disable') && svc.controllable !== true)
    return { status: 403, body: { ok: false, error: 'autostart not controllable for this service' } };
  if (isProtected(svc.unit))
    return { status: 423, body: { ok: false, error: `unit "${svc.unit}" is protected` } };

  // start/restart may pull images (compose units) → longer budget than stop.
  const timeout = action === 'stop' || action === 'disable' ? 8000 : 15000;
  try {
    await pexecFile('systemctl', ['--user', action, svc.unit], { timeout });
    return { status: 200, body: { ok: true, key, unit: svc.unit, action } };
  } catch (e: any) {
    const timedOut = e?.killed || e?.signal === 'SIGTERM';
    return {
      status: timedOut ? 504 : 502,
      body: {
        ok: false,
        key,
        unit: svc.unit,
        action,
        error: timedOut ? 'systemctl timed out' : 'systemctl failed',
        stderr: String(e?.stderr || e?.message || '').trim().slice(0, 500),
      },
    };
  }
}
