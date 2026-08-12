import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrainUsage, BrainUsageWindow, BrainConfig } from '../types.js';
import type { Store } from './store.js';

/**
 * Rate-limit usage prober for METERED brain execs, feeding the Connections
 * cards ("how much of this brain's quota is burned, and when does it reset").
 *
 * Strategy per exec — everything is best-effort and fails to `null` (no data →
 * the UI simply doesn't render a meter):
 *
 *   claude — Claude Code's own OAuth credential (~/.claude/.credentials.json)
 *            against the official usage endpoint. Returns per-window percent +
 *            resets_at (5h session, 7d caps when the plan has them).
 *   codex  — Codex CLI writes a `rate_limits` snapshot into every session
 *            rollout jsonl; read the newest one. No network call.
 *   agy    — Antigravity (Google's agentic CLI) has NO local quota snapshot
 *            file. Its quota lives behind the authenticated Code Assist RPC
 *            `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
 *            (the CLI's own UI renders it as "%.0f%% remaining"). Bearer token,
 *            in order: AGY_ACCESS_TOKEN env; a cached access token from
 *            AGY_TOKEN_FILE / Gemini CLI's ~/.gemini/oauth_creds.json (expiry
 *            checked); or one minted from a discovered refresh token
 *            (AGY_REFRESH_TOKEN, or Antigravity's own
 *            ~/.gemini/user_refresh.antigravity) via the standard Google OAuth
 *            refresh grant using the public Gemini-CLI installed-app client
 *            (override with AGY_CLIENT_ID / AGY_CLIENT_SECRET). NOTE: unlike
 *            claude/codex the quota is reported as REMAINING, so we invert to
 *            used = 100 - remaining.
 *   hermes / ollama / script — self-hosted, no external rate limit BY DESIGN;
 *            deliberately absent so those brains never show a meter.
 *
 * The same claude/codex/agy logic exists in plain-JS form in
 * deploy/remote-brain-client.mjs (zero-dep client, can't import this file);
 * keep the two in sync when changing normalization.
 */

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Antigravity's quota lives behind Code Assist's `retrieveUserQuotaSummary`. The
// consumer/Antigravity tier is served by the `daily-` host; the older paid
// gemini-cli path used the plain host — try both (daily first). The RPC is
// gated behind a client User-Agent that identifies as Antigravity: a generic
// UA (or node's default) returns 403 PERMISSION_DENIED, so we MUST send one
// containing "antigravity". This was why the meter silently never appeared.
const AGY_QUOTA_HOSTS = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'];
const AGY_USER_AGENT = 'antigravity-cli/1.0';

/** Clamp + round a percent into 0–100 with one decimal. */
function pct(n: unknown): number | null {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/**
 * Normalize the Anthropic OAuth usage payload into windows. The payload can
 * carry a given window in TWO places, and which one is populated varies by
 * plan: the structured `limits[]` array ({kind, percent, resets_at, is_active})
 * AND the per-window objects hanging off the payload root ({utilization,
 * resets_at} under five_hour / seven_day / seven_day_opus / …). A plan with
 * weekly caps, for instance, may list only the weekly limit in `limits[]` while
 * the 5h session lives solely at the top-level `five_hour` — so trusting
 * `limits[]` alone (the old behaviour) silently dropped the 5h meter for those
 * accounts. We therefore MERGE both sources, deduping by label with `limits[]`
 * authoritative (it carries is_active/severity), so the 5h AND weekly meters
 * both surface whenever the account exposes them anywhere. The weekly cap is
 * reported under several synonymous kinds (weekly, weekly_all, seven_day) — all
 * collapse to the one `7d` label so the same window never shows twice. Window keys are not
 * hard-coded — ANY `*_hour`/`seven_day*` style key with a utilization is picked
 * up, because the payload keeps growing variants (seven_day_opus,
 * seven_day_oauth_apps, …). Also appends the extra-usage credit spend (monthly
 * overflow credits) as a `credits` window when enabled. Windows are ordered
 * 5h → 7d → other weekly variants → the rest, credits last. Capped at 8 windows
 * — the heartbeat schema's limit. Exported for tests.
 */
/** True for payload-root keys that name a real rate-limit window (five_hour,
 *  any *_hour, seven_day, seven_day_*). The usage payload ALSO carries a rotating
 *  set of internal/experimental A/B buckets under codename keys (nimbus_quill,
 *  tangelo, cinder_cove, iguana_necktie, omelette_promotional, …) that sometimes
 *  expose a `utilization` — those are NOT user-facing quotas and must never
 *  become meter rows, so the top-level fallback is gated on this. */
function isWindowKey(key: string): boolean {
  return /_hour$/.test(key) || key === 'seven_day' || key.startsWith('seven_day_');
}

export function normalizeClaudeUsage(raw: any): BrainUsageWindow[] {
  const label = (kind: string) =>
    kind === 'session' || kind === 'five_hour' ? '5h'
      : kind === 'weekly' || kind === 'weekly_all' || kind === 'seven_day' || kind === 'seven_day_weekly_all' ? '7d'
      : kind.replace(/^seven_day_/, '7d-');
  const byLabel = new Map<string, BrainUsageWindow>();  // first writer wins → limits[] authoritative
  const add = (lbl: string, p: number | null, resetsAt: unknown) => {
    if (p == null || byLabel.has(lbl)) return;
    byLabel.set(lbl, { label: lbl, usedPct: p, resetsAt: (resetsAt as string) || undefined });
  };
  if (Array.isArray(raw?.limits)) {
    for (const l of raw.limits) {
      if (l?.is_active === false) continue;
      add(label(String(l.kind || l.group || '?')), pct(l?.percent), l?.resets_at);
    }
  }
  if (raw && typeof raw === 'object') {
    for (const [key, w] of Object.entries<any>(raw)) {
      if (key === 'limits' || key === 'extra_usage' || key === 'spend') continue;  // handled elsewhere
      if (!isWindowKey(key)) continue;  // ignore Anthropic's internal A/B buckets (nimbus_quill, tangelo, …)
      add(label(key), pct(w?.utilization), w?.resets_at);
    }
  }
  const rank = (l: string) => (l === '5h' ? 0 : l === '7d' ? 1 : l.startsWith('7d-') ? 2 : 3);
  const windows = [...byLabel.values()].sort((a, b) => rank(a.label) - rank(b.label));
  const extra = raw?.extra_usage;
  const extraPct = pct(extra?.utilization);
  if (extra?.is_enabled && extraPct != null) {
    windows.push({ label: 'credits', usedPct: extraPct, resetsAt: extra.resets_at || undefined });
  }
  return windows.slice(0, 8);
}

/** Read Claude Code's OAuth token from the standard credentials file. */
function claudeToken(): string | null {
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    return cred?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

async function probeClaude(): Promise<BrainUsageWindow[] | null> {
  const token = claudeToken();
  if (!token) return null;
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const windows = normalizeClaudeUsage(await res.json());
    return windows.length ? windows : null;
  } catch { return null; }
}

/**
 * Normalize one Codex `rate_limits` snapshot ({primary, secondary} with
 * used_percent / window_minutes / resets_in_seconds) into windows. `atMs` is
 * when the snapshot was recorded (resets_in_seconds is relative to it).
 * Exported for tests.
 */
export function normalizeCodexRateLimits(rl: any, atMs: number): BrainUsageWindow[] {
  const windows: BrainUsageWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl?.[key];
    const p = pct(w?.used_percent);
    if (p == null) continue;
    const mins = Number(w.window_minutes);
    const label = mins === 10080 ? '7d' : mins === 300 ? '5h'
      : Number.isFinite(mins) && mins > 0 ? (mins >= 1440 ? `${Math.round(mins / 1440)}d` : `${Math.round(mins / 60)}h`)
      : key;
    const resetSec = Number(w.resets_in_seconds);
    windows.push({
      label, usedPct: p,
      resetsAt: Number.isFinite(resetSec) ? new Date(atMs + resetSec * 1000).toISOString() : undefined
    });
  }
  return windows;
}

/**
 * Locate a Codex `rate_limits` snapshot anywhere within a parsed rollout event.
 * Codex's rollout schema has drifted across CLI versions — the snapshot has
 * lived at `payload.rate_limits`, at the event top level, and nested under
 * `payload.msg` (the older `Event { id, msg }` wrapper). Rather than hard-code
 * one path (and silently show no meter when it changes) we search for the first
 * `rate_limits`-keyed object that actually carries a primary/secondary window.
 * Depth-capped so a pathological line can't blow the stack. Exported for tests.
 */
export function findRateLimitsSnapshot(obj: any, depth = 0): any {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  const rl = obj.rate_limits;
  if (rl && typeof rl === 'object' && (rl.primary || rl.secondary)) return rl;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findRateLimitsSnapshot(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Newest-first list of Codex session rollout files (sessions/YYYY/MM/DD/*.jsonl). */
function codexSessionFiles(root = path.join(os.homedir(), '.codex', 'sessions')): string[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { out.push({ file: p, mtime: fs.statSync(p).mtimeMs }); } catch { /* raced away */ }
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).map(o => o.file);
}

/** Last rate_limits snapshot from the newest Codex session logs (checks a few
 *  recent files in case the newest session hasn't emitted a token_count yet). */
function probeCodex(): BrainUsageWindow[] | null {
  for (const file of codexSessionFiles().slice(0, 5)) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        const ev = JSON.parse(lines[i]);
        const rl = findRateLimitsSnapshot(ev);
        if (!rl) continue;
        const atMs = ev.timestamp ? new Date(ev.timestamp).getTime() : fs.statSync(file).mtimeMs;
        const windows = normalizeCodexRateLimits(rl, atMs);
        if (windows.length) return windows;
      }
    } catch { /* unreadable file → try the next one */ }
  }
  return null;
}

/** First finite number among the candidates, else null. */
function firstNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Short label for an Antigravity quota bucket — prefer a window duration,
 *  else a compact slug of the bucket's display name / id, else 'quota'. The
 *  duration is reported under several proto names across CLI versions
 *  (windowMinutes, minutesPerBucket, movingWindowSize/slidingWindow as a
 *  duration string like "604800s", or an explicit *Seconds field). */
function agyLabel(bucket: any, group: any): string {
  // Antigravity reports the window as a plain string ("weekly" / "5h") rather
  // than a duration; that field is authoritative when present.
  const winStr = String(bucket?.window ?? group?.window ?? '').toLowerCase().trim();
  if (winStr === 'weekly' || winStr === '7d') return '7d';
  if (winStr === '5h' || winStr === 'five_hour' || winStr === 'fivehour') return '5h';
  const mins = firstNum(
    bucket?.windowMinutes, bucket?.minutesPerBucket,
    group?.windowMinutes, group?.minutesPerBucket
  );
  const secs = firstNum(
    bucket?.windowSeconds, bucket?.windowDurationSeconds,
    durationToSeconds(bucket?.movingWindowSize ?? bucket?.slidingWindow ?? bucket?.window),
    durationToSeconds(group?.movingWindowSize ?? group?.slidingWindow),
    group?.windowSeconds
  );
  const m = mins ?? (secs != null ? secs / 60 : null);
  if (m != null && m > 0) {
    if (m === 10080) return '7d';
    if (m === 300) return '5h';
    return m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`;
  }
  const name = String(bucket?.displayName || bucket?.bucketName || bucket?.quotaId || bucket?.name
    || group?.displayName || group?.quotaId || '').trim();
  return name ? name.slice(0, 12) : 'quota';
}

/** Google protobuf durations serialize to JSON as a "<seconds>s" string (or a
 *  bare number of seconds). Parse either into seconds, else null. */
function durationToSeconds(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/^(\d+(?:\.\d+)?)s?$/);
  return m ? Number(m[1]) : null;
}

/** Group display name + member model names for the "Models within this group"
 *  line. Antigravity names the group under groupName/groupDescription/
 *  displayName and lists its models under one of a few repeated fields, each
 *  entry either a bare string or an object with a display name. */
function agyGroupInfo(group: any): { name?: string; models: string[] } {
  const name = String(
    group?.groupName || group?.groupDescription || group?.displayName
    || group?.tierDisplayName || group?.quotaId || ''
  ).trim() || undefined;
  const rawModels =
    group?.modelDisplayNames || group?.models || group?.modelNames
    || group?.modelIds || group?.allowedModels || [];
  const models = (Array.isArray(rawModels) ? rawModels : [])
    .map((m: any) => typeof m === 'string'
      ? m
      : String(m?.displayName || m?.modelDisplayName || m?.name || m?.modelId || '').trim())
    .filter((s: string) => s.length > 0);
  // Antigravity doesn't expose a structured model list — the members are named
  // inline in the group description ("Models within this group: A, B").
  if (!models.length && typeof group?.description === 'string') {
    const m = group.description.match(/Models within this group:\s*(.+)$/i);
    if (m) models.push(...m[1].split(',').map((s: string) => s.trim()).filter(Boolean));
  }
  return { name, models };
}

/**
 * Normalize an Antigravity `retrieveUserQuotaSummary` response into windows.
 * Antigravity's schema nests `QuotaSummaryBucket`s under one or more
 * `QuotaSummaryGroup`s (grouped by model family); we also accept a flat
 * `buckets[]`. Each bucket reports how much of the window is LEFT — most often
 * as `remainingFraction` (0–1), sometimes as an already-scaled percent
 * (`remaining`/`remainingPercent`/`percentRemaining`, 0–100). We keep BOTH the
 * remaining percent (what the Antigravity UI shows: "74% remaining") and the
 * inverted `usedPct = 100 - remaining` (so the shared meter colouring keeps
 * working). A bucket with no remaining value is kept only if it is explicitly
 * disabled (weekly cap hit → 5-hour window stops applying), carrying a
 * `disabledNote` instead of a bar. Each window is tagged with its group name +
 * member models so the UI can render the grouped Antigravity layout.
 * Best-effort and tolerant of field-name variants. Exported for tests.
 */
export function normalizeAgyQuota(raw: any): BrainUsageWindow[] {
  const asArray = (v: any, single: any) =>
    Array.isArray(v) ? v : (single != null ? [single] : []);
  const groups = asArray(
    raw?.quotaSummaryGroups || raw?.groups,
    raw?.quotaSummaryGroup
  );
  const pairs: { b: any; g: any }[] = [];
  for (const g of groups) {
    for (const b of asArray(g?.quotaSummaryBuckets || g?.buckets, g?.quotaSummaryBucket)) {
      pairs.push({ b, g });
    }
  }
  for (const b of asArray(raw?.quotaSummaryBuckets || raw?.buckets, null)) {
    pairs.push({ b, g: raw });
  }
  const windows: BrainUsageWindow[] = [];
  for (const { b, g } of pairs) {
    // A fraction (0–1) and an already-scaled percent (0–100) are reported under
    // different names; scale the fraction, trust the percent as-is.
    const frac = firstNum(b?.remainingFraction, b?.bucketInfo?.remainingFraction, b?.quotaInfo?.remainingFraction);
    const rawPct = firstNum(
      b?.remaining, b?.remainingPercent, b?.percentRemaining,
      b?.bucketInfo?.remaining, b?.quotaInfo?.remaining
    );
    const remaining = frac != null ? pct(frac * 100) : (rawPct != null ? pct(rawPct) : null);

    const disabled = b?.disabled === true || b?.enabled === false || b?.isEnabled === false;
    const disabledNote = disabled
      ? String(b?.disabledReason || b?.disabledMessage || b?.message || b?.description
          || 'Disabled — this limit does not currently apply.')
      : undefined;

    // Skip buckets that carry neither a usable remaining value nor a disabled note.
    if (remaining == null && !disabledNote) continue;

    const { name, models } = agyGroupInfo(g);
    const win: BrainUsageWindow = {
      label: agyLabel(b, g),
      usedPct: remaining != null ? pct(100 - remaining)! : 100,
      resetsAt: b?.resetTime || b?.resetsAt || b?.bucketInfo?.resetTime || g?.resetTime || undefined
    };
    // A disabled bucket (e.g. the 5-hour window once the weekly cap is hit) may
    // still report remainingFraction:1 — showing a green "100%" bar would be
    // misleading, so we render the disabled note instead of a bar for it.
    if (remaining != null && !disabled) win.remainingPct = remaining;
    if (disabledNote) win.disabledNote = disabledNote;
    if (name) win.group = name;
    if (models.length) win.groupModels = models;
    windows.push(win);
  }
  return windows;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Gemini CLI's Code Assist OAuth client, published in the open-source
// google-gemini/gemini-cli repo (an "installed app" client — Google documents
// its secret as non-confidential by design). Antigravity shares the ~/.gemini
// credential dir and the same cloudcode-pa quota RPC; if its refresh tokens
// turn out to be minted for a different client, the exchange fails soft (no
// meter) and AGY_CLIENT_ID / AGY_CLIENT_SECRET override these.
const AGY_DEFAULT_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const AGY_DEFAULT_CLIENT_SECRET = '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';

/** Find a Google OAuth refresh token for Antigravity/Gemini on this host:
 *  AGY_REFRESH_TOKEN, the AGY_TOKEN_FILE json, Antigravity's own
 *  `user_refresh.antigravity` (raw token or json), or Gemini CLI's
 *  `oauth_creds.json`. Exported for tests (home is injectable). */
export function discoverAgyRefreshToken(home = os.homedir()): string | null {
  const env = process.env.AGY_REFRESH_TOKEN?.trim();
  if (env) return env;
  const candidates = [
    process.env.AGY_TOKEN_FILE?.trim(),
    path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(home, '.gemini', 'user_refresh.antigravity'),
    path.join(home, '.gemini', 'oauth_creds.json')
  ].filter((f): f is string => !!f);
  for (const file of candidates) {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { continue; }
    try {
      const j = JSON.parse(raw);
      // The Antigravity CLI nests it under `token`; gemini-cli keeps it top-level.
      const tok = j?.token?.refresh_token || j?.refresh_token;
      if (typeof tok === 'string' && tok) return tok;
    } catch {
      // Not JSON — user_refresh.antigravity is the bare refresh token string.
      if (raw && !raw.includes('{') && !raw.includes('\n')) return raw;
    }
  }
  return null;
}

// Minted access token cache — refresh grants are rate-limited, don't re-mint
// on every 5-minute poll while the last token is still live.
let agyMinted: { token: string; expMs: number } | null = null;

/** Read a cached Antigravity/Gemini access token from a creds file, honouring
 *  its expiry. Handles the Antigravity CLI shape (`{token:{access_token,
 *  expiry:"<rfc3339>"}}`) and the Gemini-CLI shape (`{access_token/token,
 *  expiry_date:<epoch-ms>}`). Returns the token only when it has no expiry or is
 *  still valid (>1min of life). Exported for tests. */
export function readCachedAgyToken(file: string): string | null {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const nested = j?.token && typeof j.token === 'object' ? j.token : null;
  const tok = nested?.access_token
    || (typeof j?.access_token === 'string' ? j.access_token : null)
    || (typeof j?.token === 'string' ? j.token : null);
  if (typeof tok !== 'string' || !tok) return null;
  // Antigravity stamps an RFC3339 expiry string; gemini-cli an epoch-ms number.
  const expMs = nested?.expiry ? Date.parse(nested.expiry) : Number(j?.expiry_date);
  if (Number.isFinite(expMs) && expMs <= Date.now() + 60000) return null;  // expired / near-expiry
  return tok;
}

/** A ready-to-use Antigravity bearer access token: AGY_ACCESS_TOKEN, an
 *  AGY_TOKEN_FILE / Antigravity-CLI / Gemini-CLI cached access token that hasn't
 *  expired, or one minted from a discovered refresh token. */
async function agyAccessToken(): Promise<string | null> {
  const env = process.env.AGY_ACCESS_TOKEN?.trim();
  if (env) return env;
  const files = [
    process.env.AGY_TOKEN_FILE?.trim(),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(os.homedir(), '.gemini', 'oauth_creds.json')
  ].filter((f): f is string => !!f);
  for (const file of files) {
    const tok = readCachedAgyToken(file);
    if (tok) return tok;
  }
  if (agyMinted && agyMinted.expMs > Date.now() + 60000) return agyMinted.token;
  const refresh = discoverAgyRefreshToken();
  if (!refresh) return null;
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: process.env.AGY_CLIENT_ID?.trim() || AGY_DEFAULT_CLIENT_ID,
        client_secret: process.env.AGY_CLIENT_SECRET?.trim() || AGY_DEFAULT_CLIENT_SECRET
      }).toString(),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (typeof j?.access_token !== 'string' || !j.access_token) return null;
    agyMinted = { token: j.access_token, expMs: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return agyMinted.token;
  } catch { return null; }
}

async function probeAgy(): Promise<BrainUsageWindow[] | null> {
  const token = await agyAccessToken();
  if (!token) return null;
  for (const host of AGY_QUOTA_HOSTS) {
    try {
      const res = await fetch(`https://${host}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': AGY_USER_AGENT   // gates the RPC — see AGY_USER_AGENT note
        },
        body: '{}',
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) continue;  // 403 on the wrong host/tier → try the next
      const windows = normalizeAgyQuota(await res.json());
      if (windows.length) return windows;
    } catch { /* network/timeout → try the next host */ }
  }
  return null;
}

/** Execs we know how to meter on THIS host. */
const PROBES: Record<string, () => Promise<BrainUsageWindow[] | null> | BrainUsageWindow[] | null> = {
  claude: probeClaude,
  codex: probeCodex,
  agy: probeAgy
};

export function isMeteredExec(exec?: string): boolean { return !!exec && exec in PROBES; }

/**
 * Background poller: measures usage once per metered exec (all local claude
 * brains share one account → one HTTP call) and stamps the result onto every
 * LOCAL brain with that exec. Remote brains are NOT touched here — their own
 * client self-reports via heartbeat.
 */
export class UsagePoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private brains: () => Record<string, BrainConfig>,
    private intervalMs = 300000
  ) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async refresh(): Promise<void> {
    const byExec = new Map<string, string[]>();
    for (const [id, b] of Object.entries(this.brains())) {
      if (b.location !== 'local' || !isMeteredExec(b.exec)) continue;
      const ids = byExec.get(b.exec!) || [];
      ids.push(id);
      byExec.set(b.exec!, ids);
    }
    for (const [exec, ids] of byExec) {
      let windows: BrainUsageWindow[] | null = null;
      try { windows = await PROBES[exec](); } catch { /* fail-soft: keep last snapshot */ }
      if (!windows) continue;
      const usage: BrainUsage = { exec, windows, at: new Date().toISOString() };
      for (const id of ids) this.store.setBrainUsage(id, usage);
    }
  }
}
