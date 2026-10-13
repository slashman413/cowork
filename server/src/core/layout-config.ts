import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The dashboard's page/nav/widget composition lives in layout.json instead of
 * being hard-coded in index.html + app.js — the same split portal.json already
 * gives the Portal's service catalog:
 *
 *   portal.json  = WHAT runs on this host (services, probes, systemd units)
 *   layout.json  = HOW the dashboard presents it (nav sections, pages, widgets)
 *
 * Unlike portal.json the live file is NOT seeded: when ~/.cowork/layout.json
 * (override with COWORK_LAYOUT) is absent the repo default is served directly,
 * so improvements to the default layout reach installs that never customised
 * it. Copy the repo file there to customise. Either file is re-read whenever its
 * mtime changes (no restart), and a file that fails to parse keeps serving the
 * last good layout with the error reported — a typo never blanks the sidebar.
 *
 * Built-in "app" pages (Tasks, Config, …) are singletons with fixed ids because
 * other code deep-links to them (#inbox/<taskId>). One a custom layout doesn't
 * mention is appended to a "More" nav section rather than silently vanishing —
 * so a page added in a later release is never invisible on an old layout. Set
 * `hidden: true` to drop it from the nav on purpose (its route still works).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/core and dist/core both sit two levels under server/ → ../../../ is the repo root.
export const LAYOUT_TEMPLATE = path.resolve(__dirname, '../../../layout.json');

export function activeLayoutPath(): string {
  const p = process.env.COWORK_LAYOUT;
  if (p) return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.join(os.homedir(), '.cowork', 'layout.json');
}

/** Singleton app pages: id === type, at most one each, rendered by app.js. */
export const APP_PAGES = ['chat', 'inbox', 'calendar', 'workflows', 'goals', 'team', 'brains', 'roster', 'connections', 'config'] as const;
/** Composable page types: any number, any id. */
export const COMPOSABLE_PAGES = ['dashboard', 'portal'] as const;
const PAGE_TYPES = new Set<string>([...APP_PAGES, ...COMPOSABLE_PAGES]);

/** Fallback label/icon for an app page the layout doesn't describe. */
const APP_PAGE_DEFAULTS: Record<string, { label: string; icon: string }> = {
  chat: { label: 'Chat', icon: 'message-square' },
  inbox: { label: 'Tasks', icon: 'inbox' },
  calendar: { label: 'Calendar', icon: 'calendar-days' },
  workflows: { label: 'Workflows', icon: 'workflow' },
  goals: { label: 'Goals', icon: 'target' },
  team: { label: 'Routing', icon: 'bot' },
  brains: { label: 'Brains', icon: 'cpu' },
  roster: { label: 'Personas', icon: 'users-round' },
  connections: { label: 'Workers', icon: 'plug' },
  config: { label: 'Configuration', icon: 'settings' },
};

export const SYS_TILES = ['cpu', 'gpu', 'memory', 'thermal'] as const;
export const STAT_ITEMS = ['workers', 'openTasks', 'personas', 'failedTasks', 'waitingInput', 'scheduled', 'uptime'] as const;
/** Widget type → allowed option keys (anything else is reported and dropped). */
const WIDGETS: Record<string, readonly string[]> = {
  sysbar: ['tiles', 'hideUnavailable'],
  stats: ['items'],
  dispatcher: [],
  activity: ['limit'],
  platforms: [],
  services: ['keys', 'categories', 'compact'],
  note: ['text'],
};

export interface LayoutWidget {
  type: string;
  title?: string;
  /** Grid columns this widget spans inside its row (1–4); default 1. */
  span?: number;
  [opt: string]: unknown;
}
export interface LayoutRow {
  /** Minimum column width in px before the row wraps (auto-fit grid). */
  minWidth?: number;
  widgets: LayoutWidget[];
}
export interface LayoutPage {
  id: string;
  type: string;
  label: string;
  icon: string;
  hidden?: boolean;
  /** dashboard pages */
  rows?: LayoutRow[];
  /** portal pages */
  intro?: string;
  categories?: string[];
  keys?: string[];
}
export interface LayoutSection { label: string; pages: string[] }
export interface LayoutView {
  path: string;
  /** "live" = the operator's file, "default" = the repo template. */
  source: 'live' | 'default';
  brand: { title: string; icon: string; footer: string };
  defaultPage: string;
  sections: LayoutSection[];
  pages: Record<string, LayoutPage>;
  errors: string[];
}

const ICON_RE = /^[a-z0-9-]{1,40}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

const str = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const strList = (v: unknown, re?: RegExp, max = 80): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x && (!re || re.test(x))) : undefined;

function normalizeWidget(raw: any, where: string, errors: string[]): LayoutWidget | null {
  if (!raw || typeof raw !== 'object') { errors.push(`${where}: widget must be an object`); return null; }
  const allowed = WIDGETS[raw.type];
  if (!allowed) { errors.push(`${where}: unknown widget type "${String(raw.type)}" (known: ${Object.keys(WIDGETS).join(', ')})`); return null; }
  const w: LayoutWidget = { type: raw.type };
  const title = str(raw.title, 80);
  if (title) w.title = title;
  if (raw.span !== undefined) {
    if (Number.isInteger(raw.span) && raw.span >= 1 && raw.span <= 4) w.span = raw.span;
    else errors.push(`${where}: span must be an integer 1–4`);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'type' || k === 'title' || k === 'span' || k.startsWith('$')) continue;
    if (!allowed.includes(k)) { errors.push(`${where}: ${raw.type} has no option "${k}"`); continue; }
    w[k] = v;
  }
  // Per-type option checks — a bad option is stripped, the widget still renders.
  const enumList = (k: string, set: readonly string[]) => {
    if (w[k] === undefined) return;
    const list = strList(w[k]) || [];
    const bad = list.filter((x) => !set.includes(x));
    if (bad.length || !Array.isArray(w[k])) errors.push(`${where}: ${k} must be a list of ${set.join(' | ')}${bad.length ? ` (got ${bad.join(', ')})` : ''}`);
    w[k] = list.filter((x) => set.includes(x));
  };
  if (w.type === 'sysbar') enumList('tiles', SYS_TILES);
  if (w.type === 'stats') enumList('items', STAT_ITEMS);
  if (w.type === 'activity' && w.limit !== undefined) {
    if (!(Number.isInteger(w.limit) && (w.limit as number) >= 1 && (w.limit as number) <= 30)) {
      errors.push(`${where}: activity.limit must be 1–30`); delete w.limit;
    }
  }
  if (w.type === 'services') {
    if (w.keys !== undefined) w.keys = strList(w.keys, KEY_RE, 64) || [];
    if (w.categories !== undefined) w.categories = strList(w.categories) || [];
  }
  if (w.type === 'note') {
    const text = str(w.text, 4000);
    if (!text) { errors.push(`${where}: note needs "text"`); return null; }
    w.text = text;
  }
  for (const k of ['hideUnavailable', 'compact']) if (w[k] !== undefined) w[k] = w[k] === true;
  return w;
}

/**
 * Validate + normalise a parsed layout.json. Never throws: a bad page/widget is
 * dropped (or a bad field ignored) with a message, so one typo can't take the
 * rest of the dashboard down.
 */
export function normalizeLayout(raw: unknown, file: string, source: LayoutView['source'] = 'live'): LayoutView {
  const errors: string[] = [];
  const doc = (raw && typeof raw === 'object' ? raw : {}) as any;
  if (!raw || typeof raw !== 'object') errors.push('layout file must be a JSON object');

  const b = doc.brand && typeof doc.brand === 'object' ? doc.brand : {};
  const brand = {
    title: str(b.title, 40) || 'Cowork',
    icon: typeof b.icon === 'string' && ICON_RE.test(b.icon) ? b.icon : 'zap',
    footer: str(b.footer, 80) ?? 'Cowork Server',
  };

  const pages: Record<string, LayoutPage> = {};
  for (const [id, p] of Object.entries(doc.pages && typeof doc.pages === 'object' ? doc.pages : {}) as [string, any][]) {
    if (!ID_RE.test(id)) { errors.push(`page id "${id}" must match ${ID_RE}`); continue; }
    if (!p || typeof p !== 'object') { errors.push(`page ${id}: must be an object`); continue; }
    const type = str(p.type, 40) || (PAGE_TYPES.has(id) ? id : '');
    if (!PAGE_TYPES.has(type)) { errors.push(`page ${id}: unknown type "${type}" (known: ${[...PAGE_TYPES].join(', ')})`); continue; }
    if ((APP_PAGES as readonly string[]).includes(type) && id !== type) {
      errors.push(`page ${id}: app page "${type}" must use the id "${type}" (other links point at #${type})`); continue;
    }
    const icon = typeof p.icon === 'string' && ICON_RE.test(p.icon) ? p.icon : undefined;
    if (p.icon !== undefined && !icon) errors.push(`page ${id}: icon "${String(p.icon)}" is not a lucide icon name`);
    const page: LayoutPage = {
      id, type,
      label: str(p.label, 40) || APP_PAGE_DEFAULTS[type]?.label || id,
      icon: icon || APP_PAGE_DEFAULTS[type]?.icon || (type === 'portal' ? 'layout-grid' : 'layout-dashboard'),
    };
    if (p.hidden === true) page.hidden = true;
    if (type === 'dashboard') {
      page.rows = [];
      (Array.isArray(p.rows) ? p.rows : []).forEach((r: any, ri: number) => {
        // A row may be written as a bare widget list or as { minWidth, widgets }.
        const list = Array.isArray(r) ? r : r?.widgets;
        if (!Array.isArray(list)) { errors.push(`page ${id} row ${ri + 1}: expected a list of widgets`); return; }
        const widgets = list
          .map((w: any, wi: number) => normalizeWidget(w, `page ${id} row ${ri + 1} widget ${wi + 1}`, errors))
          .filter((w): w is LayoutWidget => !!w);
        if (!widgets.length) return;
        const row: LayoutRow = { widgets };
        if (!Array.isArray(r) && r.minWidth !== undefined) {
          if (Number.isInteger(r.minWidth) && r.minWidth >= 120 && r.minWidth <= 1200) row.minWidth = r.minWidth;
          else errors.push(`page ${id} row ${ri + 1}: minWidth must be 120–1200`);
        }
        page.rows!.push(row);
      });
      if (!Array.isArray(p.rows)) errors.push(`page ${id}: dashboard page needs "rows"`);
    }
    if (type === 'portal') {
      const intro = str(p.intro, 1000);
      if (intro) page.intro = intro;
      const cats = strList(p.categories);
      if (cats?.length) page.categories = cats;
      const keys = strList(p.keys, KEY_RE, 64);
      if (keys?.length) page.keys = keys;
    }
    pages[id] = page;
  }

  // App pages need no entry under "pages" — a section may just name them.
  for (const t of APP_PAGES) if (!pages[t]) pages[t] = { id: t, type: t, ...APP_PAGE_DEFAULTS[t] };

  // Nav sections — every visible page appears at most once.
  const placed = new Set<string>();
  const sections: LayoutSection[] = [];
  (Array.isArray(doc.sections) ? doc.sections : []).forEach((s: any, si: number) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.pages)) { errors.push(`section ${si + 1}: needs a "pages" list`); return; }
    const ids: string[] = [];
    for (const pid of s.pages) {
      if (typeof pid !== 'string' || !pages[pid]) { errors.push(`section ${si + 1}: unknown page "${String(pid)}"`); continue; }
      if (placed.has(pid)) { errors.push(`section ${si + 1}: page "${pid}" is already in another section`); continue; }
      if (pages[pid].hidden) continue;
      placed.add(pid); ids.push(pid);
    }
    if (ids.length) sections.push({ label: str(s.label, 40) || '', pages: ids });
  });

  // Defined-but-unplaced pages and app pages the layout never mentions both
  // land in "More" — a page must never become unreachable by omission.
  const more = Object.values(pages).filter((p) => !p.hidden && !placed.has(p.id)).map((p) => p.id);
  if (more.length) sections.push({ label: 'More', pages: more });

  let defaultPage = str(doc.defaultPage, 40) || '';
  if (defaultPage && !pages[defaultPage]) { errors.push(`defaultPage "${defaultPage}" is not a defined page`); defaultPage = ''; }
  if (!defaultPage) defaultPage = sections[0]?.pages[0] || 'inbox';

  return { path: file, source, brand, defaultPage, sections, pages, errors };
}

export class LayoutStore {
  private cache: { key: string; view: LayoutView } | null = null;

  constructor(
    private readonly file: string = activeLayoutPath(),
    private readonly template: string = LAYOUT_TEMPLATE,
  ) {}

  get(): LayoutView {
    const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return -1; } };
    const liveMtime = mtime(this.file);
    const source: LayoutView['source'] = liveMtime >= 0 ? 'live' : 'default';
    const file = source === 'live' ? this.file : this.template;
    const key = `${file}@${source === 'live' ? liveMtime : mtime(this.template)}`;
    if (this.cache && this.cache.key === key) return this.cache.view;

    try {
      const view = normalizeLayout(JSON.parse(fs.readFileSync(file, 'utf-8')), file, source);
      this.cache = { key, view };
      return view;
    } catch (e: any) {
      // Keep serving the last good layout; don't cache so the fix is picked up.
      const last = this.cache?.view || normalizeLayout({}, file, source);
      return { ...last, errors: [`${path.basename(file)}: ${e.message}`] };
    }
  }
}
