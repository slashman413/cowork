import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PortalFile, ServiceConfig } from '../types.js';
import { UNIT_RE } from './service-probe.js';

/**
 * The Portal's launcher catalog lives in its own file — portal.json — instead
 * of being hard-coded in app.js / service-probe.ts. Same split as config.json:
 * the repo's portal.json is the default (this host's DGX Spark services) and
 * the live copy is ~/.cowork/portal.json (override with COWORK_PORTAL), seeded
 * from the default on first use.
 *
 * The file is re-read whenever its mtime changes, so editing it takes effect on
 * the next Portal refresh — no server restart (and no redeploy-from-a-task trap).
 * A file that fails to parse keeps serving the last good copy and reports the
 * error, so a typo never blanks the Portal.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/core and dist/core both sit two levels under server/ → ../../../ is the repo root.
export const PORTAL_TEMPLATE = path.resolve(__dirname, '../../../portal.json');

export function activePortalPath(): string {
  const p = process.env.COWORK_PORTAL;
  if (p) return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.join(os.homedir(), '.cowork', 'portal.json');
}

export interface PortalView {
  /** File the catalog was read from (shown in the UI so operators know what to edit). */
  path: string;
  accent: string;
  categories: string[];
  services: Record<string, ServiceConfig>;
  /** Parse / validation problems; non-empty does not mean the Portal is empty. */
  errors: string[];
}

const DEFAULT_ACCENT = '#2563EB';
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Absolute http(s) URL, or a same-origin path like "/obsidian.html". */
function isLaunchable(u: string): boolean {
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; }
  catch { return false; }
}

const str = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/**
 * Validate + normalise a parsed portal.json. Bad entries are dropped (or bad
 * fields ignored) with a message, never thrown — one broken card must not take
 * the rest down. Units are shape-checked here too, though service-control
 * re-checks before anything reaches systemctl.
 */
export function normalizePortal(raw: unknown, file: string): PortalView {
  const errors: string[] = [];
  const doc = (raw && typeof raw === 'object' ? raw : {}) as PortalFile;
  if (!raw || typeof raw !== 'object') errors.push('portal file must be a JSON object');

  let accent = DEFAULT_ACCENT;
  if (doc.accent !== undefined) {
    if (typeof doc.accent === 'string' && COLOR_RE.test(doc.accent)) accent = doc.accent;
    else errors.push(`accent "${String(doc.accent)}" is not a #hex colour`);
  }

  const categories = Array.isArray(doc.categories)
    ? doc.categories.map((c) => str(c, 60)).filter((c): c is string => !!c)
    : [];

  const services: Record<string, ServiceConfig> = {};
  for (const [key, v] of Object.entries(doc.services && typeof doc.services === 'object' ? doc.services : {})) {
    if (!KEY_RE.test(key)) { errors.push(`service key "${key}" must match ${KEY_RE}`); continue; }
    if (!v || typeof v !== 'object') { errors.push(`${key}: entry must be an object`); continue; }
    const url = str(v.url, 2000);
    if (!url) { errors.push(`${key}: missing "url"`); continue; }
    if (!isLaunchable(url)) { errors.push(`${key}: url "${url}" must be http(s)://… or a /path on this dashboard`); continue; }
    const svc: ServiceConfig = { url, enabled: v.enabled !== false };
    for (const f of ['label', 'description', 'category'] as const) {
      const s = str(v[f], f === 'description' ? 500 : 80);
      if (s) svc[f] = s;
    }
    if (v.icon !== undefined) {
      if (typeof v.icon === 'string' && ICON_RE.test(v.icon)) svc.icon = v.icon;
      else errors.push(`${key}: icon "${String(v.icon)}" is not a lucide icon name`);
    }
    if (v.accent !== undefined) {
      if (typeof v.accent === 'string' && COLOR_RE.test(v.accent)) svc.accent = v.accent;
      else errors.push(`${key}: accent "${String(v.accent)}" is not a #hex colour`);
    }
    if (typeof v.order === 'number' && Number.isFinite(v.order)) svc.order = v.order;
    if (v.probe === false) svc.probe = false;
    else if (str(v.probe, 2000)) svc.probe = str(v.probe, 2000);
    if (v.unit !== undefined) {
      if (typeof v.unit === 'string' && UNIT_RE.test(v.unit)) svc.unit = v.unit;
      else errors.push(`${key}: unit "${String(v.unit)}" is not a valid systemd unit name`);
    }
    if (v.controllable === true) svc.controllable = true;
    services[key] = svc;
  }
  return { path: file, accent, categories, services, errors };
}

/**
 * First run: copy the repo default into place. `legacy` is the pre-portal.json
 * config.services block — overlaid on the default so an existing install keeps
 * every card it already had (operator entries win, field by field).
 */
export function seedPortal(file: string, legacy?: Record<string, ServiceConfig>): void {
  if (fs.existsSync(file)) return;
  let doc: PortalFile = {};
  try { doc = JSON.parse(fs.readFileSync(PORTAL_TEMPLATE, 'utf-8')); } catch { /* no template */ }
  if (legacy && Object.keys(legacy).length) {
    const merged: Record<string, ServiceConfig> = { ...(doc.services || {}) };
    for (const [k, v] of Object.entries(legacy)) merged[k] = { ...(merged[k] || {}), ...v };
    doc.services = merged;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    console.log(`Seeded Portal catalog at ${file}`);
  } catch (e) {
    console.error(`Could not seed Portal catalog at ${file}:`, e);
  }
}

export class PortalStore {
  private cache: { mtimeMs: number; view: PortalView } | null = null;

  constructor(
    private readonly file: string = activePortalPath(),
    legacy?: Record<string, ServiceConfig>,
  ) {
    seedPortal(this.file, legacy);
  }

  get(): PortalView {
    let mtimeMs = -1;
    try { mtimeMs = fs.statSync(this.file).mtimeMs; } catch { /* missing */ }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.view;

    if (mtimeMs < 0) {
      const view = normalizePortal({}, this.file);
      view.errors.push(`portal file not found: ${this.file}`);
      this.cache = { mtimeMs, view };
      return view;
    }
    try {
      const view = normalizePortal(JSON.parse(fs.readFileSync(this.file, 'utf-8')), this.file);
      this.cache = { mtimeMs, view };
      return view;
    } catch (e: any) {
      // Keep serving the last good catalog; don't cache so the fix is picked up.
      const last = this.cache?.view || normalizePortal({}, this.file);
      return { ...last, errors: [`${path.basename(this.file)}: ${e.message}`] };
    }
  }
}
