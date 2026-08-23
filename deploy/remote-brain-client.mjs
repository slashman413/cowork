#!/usr/bin/env node
// remote-brain-client — a zero-dependency Cowork MCP client that turns a machine
// into one or more "remote brains". It connects to the Cowork MCP server,
// registers (declaring the brains it can run, which the server auto-adds to its
// registry), then polls the shared inbox for tasks addressed to ANY of its
// brains, claims them, runs the matching local model, and reports results back.
//
// Zero-config by default: run `COWORK_URL=http://<host>:6868 node remote-brain-client.mjs`
// and the client AUTO-DETECTS the model CLIs installed here (claude/hermes/agy) and
// declares the matching brains in its registration handshake — no brain env needed.
// Override the auto default with any of (first that is set wins):
//
//   Preset — one flag, standard model set for a platform:
//     PRESET=claude  HOST=aicodegen          # → deploy/presets/claude.json:
//       remote-aicodegen-cc-opus (claude-opus-4-8), -cc-sonnet (claude-sonnet-5),
//       -cc-fable (claude-fable-5), -cc-default (account default)
//     PRESET=hermes  HOST=box2               # → qwen35b / qwen27b / deepseek
//     (BRAINS_FILE=/path/to/list.json also works; {HOST} is substituted.)
//
//   Multiple explicit — one client, several models:
//     BRAINS='[{"id":"remote-aicodegen-cc-opus","model":"claude-opus-4-8"},
//              {"id":"remote-aicodegen-cc-sonnet","model":"claude-sonnet-5"},
//              {"id":"remote-aicodegen-cc-fable","model":"claude-fable-5"}]'
//     EXEC=claude            # default exec for brains that don't set their own
//     HOST=aicodegen         # default host label
//
//   Single (simplest):
//     BRAIN_ID=remote-aicodegen-cc-fable  EXEC=claude  MODEL=claude-fable-5
//
//   COWORK_URL       cowork server base, e.g. http://<cowork-host>:6868   (required)
//   COWORK_API_KEY   bearer token if the server sets server.apiKey       (optional)
//   POLL_MS          inbox poll interval                                 (default 5000)
//   MAX_CONCURRENT   tasks in parallel across all brains                 (default 1)
//   TASK_TIMEOUT_MS  per-task wall clock                                 (default 3000000)
//   AGENT_NAME       display name in Active Agents                       (default HOST/host)
//
// Node 18+ (global fetch). No npm install. Run: `node remote-brain-client.mjs`.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// Operating rules every executing brain must follow (repo root CONVENTIONS.md).
// Prepended to every prompt so a remote brain runs under the same rules as a local one.
let CONVENTIONS = '';
try { CONVENTIONS = readFileSync(join(HERE, '..', 'CONVENTIONS.md'), 'utf8').trim(); } catch { /* optional */ }

const URL_BASE = need('COWORK_URL').replace(/\/$/, '');
const API_KEY = process.env.COWORK_API_KEY || '';
const EXEC_DEFAULT = process.env.EXEC || 'claude';
const HOST = process.env.HOST || os.hostname();
const POLL_MS = +(process.env.POLL_MS || 5000);
const MAX_CONCURRENT = +(process.env.MAX_CONCURRENT || 1);
const TASK_TIMEOUT_MS = +(process.env.TASK_TIMEOUT_MS || 3000000);

// Resolve the brain list. Precedence:
//   PRESET → BRAINS_FILE → BRAINS → BRAIN_ID → AUTO-DETECT (default).
// AUTO-DETECT means you can just run `COWORK_URL=… node remote-brain-client.mjs`:
// the client looks for installed model CLIs (claude / hermes / agy) and declares
// the matching preset for each — so it propagates its own capabilities on connect
// with zero config. Env vars only override the auto default. {HOST} is substituted.
const PRESET_DIR = join(HERE, 'presets');
function loadJsonWithHost(raw) { return JSON.parse(raw.split('{HOST}').join(HOST)); }
function preset(name) { return loadJsonWithHost(readFileSync(join(PRESET_DIR, `${name}.json`), 'utf8')); }
function hasCli(cli) { return spawnSync('sh', ['-c', `command -v ${cli}`], { stdio: 'ignore' }).status === 0; }

// WF-3: auto-detect this host's environment CAPABILITIES so the router can avoid
// landing tasks where they can't run. Facts only, never values — `secrets` holds
// credential file NAMES under ~/.priv/, not their contents. Fast (each probe is a
// cheap sync spawn/stat) and fail-soft: any probe that errors is simply skipped, so
// a partial manifest still ships. Override/extend via ENV_TOOLS / ENV_PATHS.
function detectEnv() {
  const tools = [], paths = [], secrets = [], traits = [];
  const TOOL_LIST = ['git', 'gh', 'node', 'python3', 'ffmpeg', 'xurl', 'docker', 'rsync', 'sops', 'age', 'jq',
    ...(process.env.ENV_TOOLS ? process.env.ENV_TOOLS.split(',').map(s => s.trim()).filter(Boolean) : [])];
  for (const t of TOOL_LIST) { try { if (hasCli(t) && !tools.includes(t)) tools.push(t); } catch { /* skip */ } }

  const PATH_LIST = (process.env.ENV_PATHS || `${os.homedir()}/workspace:${os.homedir()}/.priv`)
    .split(':').map(s => s.trim()).filter(Boolean);
  for (const p of PATH_LIST) {
    try { if (statSync(p).isDirectory()) paths.push(p); } catch { /* absent → skip */ }
  }

  // Credential NAMES only (never contents): the file basenames under ~/.priv/.
  try {
    for (const f of readdirSync(join(os.homedir(), '.priv'))) {
      const name = f.replace(/\.(json|txt|env|key|pem|age)$/i, '');
      if (name && !secrets.includes(name)) secrets.push(name);
    }
  } catch { /* no ~/.priv → no secrets declared */ }

  traits.push(`${os.platform()}-${os.arch()}`);
  return { paths, tools, secrets, traits };
}
const ENV_FACTS = detectEnv();
console.log(`[env] detected ${ENV_FACTS.tools.length} tool(s), ${ENV_FACTS.paths.length} path(s), ${ENV_FACTS.secrets.length} secret-name(s)`);

let BRAINS;
if (process.env.PRESET) {
  BRAINS = preset(process.env.PRESET);
} else if (process.env.BRAINS_FILE) {
  BRAINS = loadJsonWithHost(readFileSync(process.env.BRAINS_FILE, 'utf8'));
} else if (process.env.BRAINS) {
  BRAINS = loadJsonWithHost(process.env.BRAINS);
} else if (process.env.BRAIN_ID) {
  BRAINS = [{ id: process.env.BRAIN_ID, exec: EXEC_DEFAULT, model: process.env.MODEL || '' }];
} else {
  // Auto-detect: declare a preset for every model CLI on PATH.
  BRAINS = [];
  for (const [cli, name] of [['claude', 'claude'], ['hermes', 'hermes'], ['agy', 'agy'], ['codex', 'codex']]) {
    if (hasCli(cli)) BRAINS.push(...preset(name));
  }
  // Ollama has no fixed model set — enumerate the pulled CHAT models (skip embedders).
  if (hasCli('ollama')) {
    const out = spawnSync('ollama', ['list'], { encoding: 'utf8' }).stdout || '';
    for (const line of out.split('\n').slice(1)) {
      const name = line.split(/\s+/)[0];
      if (!name || /embed/i.test(name)) continue;   // skip embedding-only models
      BRAINS.push({ id: `remote-{HOST}-ollama-${name.replace(/[:/]/g, '-')}`.split('{HOST}').join(HOST), exec: 'ollama', model: name });
    }
  }
  if (!BRAINS.length) {
    console.error('Auto-detect found no usable model CLI (claude/hermes/agy/codex, or an Ollama chat model) on PATH.\n' +
      'Install one, or declare brains explicitly: PRESET=<name> | BRAINS_FILE=path | BRAINS=<json> | BRAIN_ID=<id>.');
    process.exit(2);
  }
  console.log(`[auto-detect] declaring brains for: ${[...new Set(BRAINS.map(b => b.exec))].join(', ')}`);
}
const BRAIN = Object.fromEntries(BRAINS.map(b => [b.id, {
  id: b.id, exec: b.exec || EXEC_DEFAULT, model: b.model || '',
  // Optional codex profile (~/.codex/config.toml) — pins model + custom model_provider
  // so a brain can target a local vLLM endpoint or a non-default cloud provider.
  profile: b.profile || '',
  location: b.location || 'remote', host: b.host || HOST
}]));
const MY_IDS = new Set(Object.keys(BRAIN));
const AGENT_NAME = process.env.AGENT_NAME || `remote-${HOST}`;
// Registration platform reflects the declared brains (a box may be claude-only,
// hermes-only, or mixed). Derive from the first brain's exec.
const execToPlatform = e => e === 'claude' ? 'claude' : e === 'agy' ? 'antigravity' : e === 'codex' ? 'codex' : e === 'ollama' ? 'ollama' : 'hermes';
const PLATFORM = execToPlatform(Object.values(BRAIN)[0]?.exec || EXEC_DEFAULT);

function need(k) { const v = process.env[k]; if (!v) { console.error(`Missing required env ${k}`); process.exit(2); } return v; }
const OSC_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
// Ollama's CLI redraws wrapped words even to a pipe as `<chars>ESC[<N>DESC[K`;
// that sequence means "delete the previous N chars", so apply it, then drop any
// remaining escape sequences and carriage returns.
function stripAnsi(s) {
  return s.replace(/(.{0,200}?)\x1b\[(\d+)D\x1b\[K/gs, (_m, pre, n) => pre.slice(0, Math.max(0, pre.length - Number(n))))
          .replace(OSC_CSI_RE, '').replace(/\r/g, '');
}

let sessionId = null, rpcId = 0;
const running = new Set();

// ── Rate-limit usage self-report (Connections cards' brain meters) ──────────
// Probes THIS host's metered CLIs and ships the snapshot with every heartbeat
// as usage[brainId] = {exec, windows:[{label, usedPct, resetsAt}], at}. Only
// claude/codex/agy have a queryable quota; hermes/ollama/script brains have
// none by design and report nothing (the dashboard hides them). agy reports
// REMAINING (inverted to used) and needs a supplied bearer token — see
// probeAgyUsage. Mirror of the server's TS probes in
// server/src/core/usage-probe.ts — keep in sync.
const USAGE_MS = +(process.env.USAGE_MS || 300000);
let USAGE = {};   // brainId → snapshot; {} until the first successful probe
const clampPct = n => Number.isFinite(+n) ? Math.max(0, Math.min(100, Math.round(+n * 10) / 10)) : null;

async function probeClaudeUsage() {
  let token;
  try { token = JSON.parse(readFileSync(join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))?.claudeAiOauth?.accessToken; }
  catch { return null; }
  if (!token) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const raw = await res.json();
    const label = k => k === 'session' || k === 'five_hour' ? '5h' : k === 'weekly' || k === 'weekly_all' || k === 'seven_day' || k === 'seven_day_weekly_all' ? '7d' : String(k).replace(/^seven_day_/, '7d-');
    // MERGE both sources the payload can carry a window in — the structured
    // limits[] array (authoritative: is_active/severity) AND the per-window
    // objects hanging off the root (five_hour, seven_day, seven_day_opus, …).
    // Which source populates a given window varies by plan: a plan with weekly
    // caps may list only the weekly limit in limits[] while the 5h session lives
    // solely at top-level five_hour, so trusting limits[] alone dropped the 5h
    // meter for those accounts. Dedup by label, first writer (limits[]) wins.
    const byLabel = new Map();
    const add = (lbl, p, resetsAt) => {
      if (p == null || byLabel.has(lbl)) return;
      byLabel.set(lbl, { label: lbl, usedPct: p, ...(resetsAt ? { resetsAt } : {}) });
    };
    for (const l of Array.isArray(raw?.limits) ? raw.limits : []) {
      if (l?.is_active === false) continue;
      add(label(l.kind || l.group || '?'), clampPct(l?.percent), l?.resets_at);
    }
    // Gate on real window keys (five_hour, *_hour, seven_day*) — the payload also
    // carries rotating internal A/B buckets under codename keys (nimbus_quill,
    // tangelo, cinder_cove, …) that sometimes expose a utilization but are NOT
    // user-facing quotas and must never become meter rows.
    const isWindowKey = k => /_hour$/.test(k) || k === 'seven_day' || String(k).startsWith('seven_day_');
    if (raw && typeof raw === 'object') for (const [k, w] of Object.entries(raw)) {
      if (k === 'limits' || k === 'extra_usage' || k === 'spend' || !isWindowKey(k)) continue;
      add(label(k), clampPct(w?.utilization), w?.resets_at);
    }
    const rank = l => (l === '5h' ? 0 : l === '7d' ? 1 : l.startsWith('7d-') ? 2 : 3);
    const windows = [...byLabel.values()].sort((a, b) => rank(a.label) - rank(b.label));
    // Extra-usage credits (monthly overflow spend) as its own row.
    const xp = clampPct(raw?.extra_usage?.utilization);
    if (raw?.extra_usage?.is_enabled && xp != null) {
      windows.push({ label: 'credits', usedPct: xp, ...(raw.extra_usage.resets_at ? { resetsAt: raw.extra_usage.resets_at } : {}) });
    }
    return windows.length ? windows.slice(0, 8) : null;   // heartbeat schema caps at 8
  } catch { return null; }
}

// Locate a Codex rate_limits snapshot anywhere in a parsed rollout event.
// Codex's rollout schema has drifted across versions (payload.rate_limits, the
// event top level, or nested under payload.msg), so we search rather than
// assume one path. Depth-capped. Mirror of findRateLimitsSnapshot in
// server/src/core/usage-probe.ts.
function findRateLimits(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  const rl = obj.rate_limits;
  if (rl && typeof rl === 'object' && (rl.primary || rl.secondary)) return rl;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const f = findRateLimits(v, depth + 1); if (f) return f; }
  }
  return null;
}

function probeCodexUsage() {
  // Codex CLI stamps a rate_limits snapshot into its session rollout jsonl;
  // read the newest one (no network, no credentials).
  const rootDir = join(os.homedir(), '.codex', 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) { try { files.push({ p, m: statSync(p).mtimeMs }); } catch { /* raced */ } }
    }
  };
  walk(rootDir, 0);
  for (const { p, m } of files.sort((a, b) => b.m - a.m).slice(0, 5)) {
    try {
      const lines = readFileSync(p, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        const ev = JSON.parse(lines[i]);
        const rl = findRateLimits(ev);
        if (!rl) continue;
        const atMs = ev.timestamp ? new Date(ev.timestamp).getTime() : m;
        const windows = [];
        for (const key of ['primary', 'secondary']) {
          const w = rl[key], pctUsed = clampPct(w?.used_percent);
          if (pctUsed == null) continue;
          const mins = +w.window_minutes;
          const lbl = mins === 10080 ? '7d' : mins === 300 ? '5h' : mins > 0 ? (mins >= 1440 ? `${Math.round(mins / 1440)}d` : `${Math.round(mins / 60)}h`) : key;
          windows.push({ label: lbl, usedPct: pctUsed, ...(Number.isFinite(+w.resets_in_seconds) ? { resetsAt: new Date(atMs + w.resets_in_seconds * 1000).toISOString() } : {}) });
        }
        if (windows.length) return windows;
      }
    } catch { /* unreadable → next file */ }
  }
  return null;
}

// Gemini CLI's Code Assist OAuth client, published in the open-source
// google-gemini/gemini-cli repo (an "installed app" client — its secret is
// non-confidential by design). Antigravity shares the ~/.gemini credential dir
// and the same cloudcode-pa quota RPC; if its refresh tokens are minted for a
// different client the exchange fails soft (no meter). Override with
// AGY_CLIENT_ID / AGY_CLIENT_SECRET. Mirror of server/src/core/usage-probe.ts.
const AGY_DEFAULT_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const AGY_DEFAULT_CLIENT_SECRET = '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';
let agyMinted = null;   // {token, expMs} — don't re-mint while the last one is live

function discoverAgyRefreshToken() {
  const env = process.env.AGY_REFRESH_TOKEN?.trim();
  if (env) return env;
  const candidates = [
    process.env.AGY_TOKEN_FILE?.trim(),
    join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    join(os.homedir(), '.gemini', 'user_refresh.antigravity'),
    join(os.homedir(), '.gemini', 'oauth_creds.json')
  ].filter(Boolean);
  for (const file of candidates) {
    let raw;
    try { raw = readFileSync(file, 'utf8').trim(); } catch { continue; }
    try {
      const j = JSON.parse(raw);
      // Antigravity CLI nests it under `token`; gemini-cli keeps it top-level.
      const tok = j?.token?.refresh_token || j?.refresh_token;
      if (typeof tok === 'string' && tok) return tok;
    } catch {
      // Not JSON — user_refresh.antigravity is the bare refresh token string.
      if (raw && !raw.includes('{') && !raw.includes('\n')) return raw;
    }
  }
  return null;
}

async function agyAccessToken() {
  // In order: AGY_ACCESS_TOKEN; a non-expired cached access token from
  // AGY_TOKEN_FILE / Gemini CLI's oauth_creds.json; else mint one from a
  // discovered refresh token via the standard Google OAuth refresh grant.
  const env = process.env.AGY_ACCESS_TOKEN?.trim();
  if (env) return env;
  const cached = (file) => {
    let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    const nested = j?.token && typeof j.token === 'object' ? j.token : null;   // Antigravity CLI shape
    const tok = nested?.access_token || (typeof j?.access_token === 'string' ? j.access_token : null) || (typeof j?.token === 'string' ? j.token : null);
    if (typeof tok !== 'string' || !tok) return null;
    const expMs = nested?.expiry ? Date.parse(nested.expiry) : Number(j?.expiry_date);   // rfc3339 str | epoch-ms
    if (Number.isFinite(expMs) && expMs <= Date.now() + 60000) return null;
    return tok;
  };
  for (const file of [process.env.AGY_TOKEN_FILE?.trim(), join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), join(os.homedir(), '.gemini', 'oauth_creds.json')].filter(Boolean)) {
    const tok = cached(file);
    if (tok) return tok;
  }
  if (agyMinted && agyMinted.expMs > Date.now() + 60000) return agyMinted.token;
  const refresh = discoverAgyRefreshToken();
  if (!refresh) return null;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refresh,
        client_id: process.env.AGY_CLIENT_ID?.trim() || AGY_DEFAULT_CLIENT_ID,
        client_secret: process.env.AGY_CLIENT_SECRET?.trim() || AGY_DEFAULT_CLIENT_SECRET
      }).toString(),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (typeof j?.access_token !== 'string' || !j.access_token) return null;
    agyMinted = { token: j.access_token, expMs: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return agyMinted.token;
  } catch { return null; }
}

async function probeAgyUsage() {
  // Antigravity has NO local quota file. Its quota lives behind the Code Assist
  // RPC cloudcode-pa/v1internal:retrieveUserQuotaSummary and the CLI renders it
  // as "% remaining" — so we INVERT to used = 100 - remaining.
  const token = await agyAccessToken();
  if (!token) return null;
  const num = (...vs) => { for (const v of vs) { if (v == null) continue; const n = +v; if (Number.isFinite(n)) return n; } return null; };
  const dur = (v) => { if (v == null) return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; const m = String(v).match(/^(\d+(?:\.\d+)?)s?$/); return m ? +m[1] : null; };
  const agyLabel = (b, g) => {
    const winStr = String(b?.window ?? g?.window ?? '').toLowerCase().trim();   // Antigravity: "weekly"/"5h"
    if (winStr === 'weekly' || winStr === '7d') return '7d';
    if (winStr === '5h' || winStr === 'five_hour' || winStr === 'fivehour') return '5h';
    const mins = num(b?.windowMinutes, b?.minutesPerBucket, g?.windowMinutes, g?.minutesPerBucket);
    const secs = num(b?.windowSeconds, b?.windowDurationSeconds, dur(b?.movingWindowSize ?? b?.slidingWindow ?? b?.window), dur(g?.movingWindowSize ?? g?.slidingWindow), g?.windowSeconds);
    const m = mins ?? (secs != null ? secs / 60 : null);
    if (m != null && m > 0) return m === 10080 ? '7d' : m === 300 ? '5h' : (m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`);
    const name = String(b?.displayName || b?.bucketName || b?.quotaId || b?.name || g?.displayName || g?.quotaId || '').trim();
    return name ? name.slice(0, 12) : 'quota';
  };
  const groupInfo = (g) => {
    const name = String(g?.groupName || g?.groupDescription || g?.displayName || g?.tierDisplayName || g?.quotaId || '').trim() || null;
    const raw = g?.modelDisplayNames || g?.models || g?.modelNames || g?.modelIds || g?.allowedModels || [];
    const models = (Array.isArray(raw) ? raw : [])
      .map((m) => typeof m === 'string' ? m : String(m?.displayName || m?.modelDisplayName || m?.name || m?.modelId || '').trim())
      .filter((s) => s.length > 0);
    // Antigravity names members inline in the group description, not a field.
    if (!models.length && typeof g?.description === 'string') {
      const mm = g.description.match(/Models within this group:\s*(.+)$/i);
      if (mm) models.push(...mm[1].split(',').map((s) => s.trim()).filter(Boolean));
    }
    return { name, models };
  };
  // The consumer/Antigravity tier is on the `daily-` host; the RPC is gated
  // behind a User-Agent containing "antigravity" (else 403). Try both hosts.
  const hosts = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'];
  for (const host of hosts) {
   try {
    const res = await fetch(`https://${host}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST', body: '{}',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity-cli/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) continue;
    const raw = await res.json();
    const arr = (v, s) => Array.isArray(v) ? v : (s != null ? [s] : []);
    const pairs = [];
    for (const g of arr(raw?.quotaSummaryGroups || raw?.groups, raw?.quotaSummaryGroup))
      for (const b of arr(g?.quotaSummaryBuckets || g?.buckets, g?.quotaSummaryBucket)) pairs.push([b, g]);
    for (const b of arr(raw?.quotaSummaryBuckets || raw?.buckets, null)) pairs.push([b, raw]);
    const windows = [];
    for (const [b, g] of pairs) {
      const frac = num(b?.remainingFraction, b?.bucketInfo?.remainingFraction, b?.quotaInfo?.remainingFraction);
      const rawPct = num(b?.remaining, b?.remainingPercent, b?.percentRemaining, b?.bucketInfo?.remaining, b?.quotaInfo?.remaining);
      const remaining = frac != null ? clampPct(frac * 100) : (rawPct != null ? clampPct(rawPct) : null);
      const disabled = b?.disabled === true || b?.enabled === false || b?.isEnabled === false;
      const disabledNote = disabled ? String(b?.disabledReason || b?.disabledMessage || b?.message || b?.description || 'Disabled — this limit does not currently apply.') : null;
      if (remaining == null && !disabledNote) continue;
      const resetsAt = b?.resetTime || b?.resetsAt || b?.bucketInfo?.resetTime || g?.resetTime || null;
      const { name, models } = groupInfo(g);
      windows.push({
        label: agyLabel(b, g),
        usedPct: remaining != null ? clampPct(100 - remaining) : 100,
        ...(resetsAt ? { resetsAt } : {}),
        // A disabled bucket may still report 100% remaining — show the note, not a bar.
        ...(remaining != null && !disabled ? { remainingPct: remaining } : {}),
        ...(disabledNote ? { disabledNote } : {}),
        ...(name ? { group: name } : {}),
        ...(models.length ? { groupModels: models } : {})
      });
    }
    if (windows.length) return windows;
   } catch { /* network/timeout → try the next host */ }
  }
  return null;
}

async function refreshUsage() {
  const byExec = {};
  for (const b of Object.values(BRAIN)) (byExec[b.exec] ||= []).push(b.id);
  const next = {};
  for (const [exec, ids] of Object.entries(byExec)) {
    let windows = null;
    try { windows = exec === 'claude' ? await probeClaudeUsage() : exec === 'codex' ? probeCodexUsage() : exec === 'agy' ? await probeAgyUsage() : null; }
    catch { /* fail-soft */ }
    if (!windows) continue;
    const snap = { exec, windows, at: new Date().toISOString() };
    for (const id of ids) next[id] = snap;
  }
  // Keep the last good snapshot if this round failed entirely (transient net).
  if (Object.keys(next).length || !Object.keys(USAGE).length) USAGE = next;
}

// ── Minimal MCP client over the streamable-HTTP transport ────────────────────
async function rpc(method, params) {
  const headers = {
    'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
  };
  const res = await fetch(`${URL_BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const sid = res.headers.get('mcp-session-id'); if (sid) sessionId = sid;
  const text = await res.text();
  if (method === 'notifications/initialized') return null;
  const line = text.split('\n').find(l => l.startsWith('data:')) || text;
  const payload = JSON.parse(line.replace(/^data:\s*/, ''));
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}
async function tool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = r?.content?.[0]?.text; if (t == null) return r;
  try { return JSON.parse(t); } catch { return t; }
}
async function connect() {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: `remote-brain:${AGENT_NAME}`, version: '1.0' } });
  await rpc('notifications/initialized');
}

// ── Task execution ───────────────────────────────────────────────────────────
function buildPrompt(task, artDir, inputInfo) {
  const ctx = task.context || {};
  const persona = ctx.persona;   // roster agent's full .md persona (stamped by the dispatcher)
  const role = ctx.agent || ctx.role || 'agent';
  const lines = persona
    ? [...(CONVENTIONS ? [CONVENTIONS, ``, `---`, ``] : []), persona, ``, `---`, ``, `You have been assigned the following task. Work autonomously and produce your final deliverable as plain text (markdown allowed).`, ``,
       `# Task: ${task.title}`, ``, task.description, ``]
    : [...(CONVENTIONS ? [CONVENTIONS, ``, `---`, ``] : []), `You are the "${role}" agent (brain: ${ctx.brain}) in a multi-agent company. Work autonomously and produce your final deliverable as plain-text output.`,
       ``, `# Task: ${task.title}`, ``, task.description, ``];
  // Surface user-supplied context, minus the persona + dispatcher bookkeeping (avoid noise/dupes).
  // inputFiles is rendered as its own section with local paths (below).
  const shown = { ...ctx };
  for (const k of ['persona', 'brainAuto', 'remoteWaitSince', 'dispatched', 'attempts', 'agentName', 'ranAgent', 'ranDivision', 'ranBrain', 'isRoster', 'inputFiles']) delete shown[k];
  if (Object.keys(shown).length) lines.push('# Context', '```json', JSON.stringify(shown, null, 2), '```', '');
  if (inputInfo && inputInfo.files.length) {
    lines.push('# Attached input files',
      'The requester attached these files for you to read (downloaded to your machine):',
      ...inputInfo.files.map(f => `- ${join(inputInfo.dir, f)}`), '');
  }
  lines.push(
    `If you generate any files (reports, media, data), save them to the directory: ${artDir} (also in $COWORK_ARTIFACTS_DIR) — they are uploaded to the dashboard as downloadable artifacts when the task completes.`,
    'Your final stdout becomes the task result shown on the dashboard.');
  return lines.join('\n');
}
function runModel(brain, prompt, artDir) {
  const argv = brain.exec === 'claude' ? ['claude', '-p', prompt, ...(brain.model ? ['--model', brain.model] : []), '--dangerously-skip-permissions']
    : brain.exec === 'hermes' ? ['hermes', ...(brain.model ? ['-m', brain.model] : []), '-z', prompt]
    : brain.exec === 'agy' ? ['agy', '-p', prompt]
    : brain.exec === 'codex' ? ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(brain.profile ? ['--profile', brain.profile] : []), ...(brain.model ? ['-m', brain.model] : []), prompt]
    : brain.exec === 'ollama' ? (brain.model ? ['ollama', 'run', brain.model, prompt] : null)
    : null;
  if (!argv) return Promise.resolve({ ok: false, text: `unknown/misconfigured exec ${brain.exec}` });
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COWORK_ARTIFACTS_DIR: artDir } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ ok: false, text: `TIMEOUT\n${out}\n${err}` }); }, TASK_TIMEOUT_MS);
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: `SPAWN ERROR: ${e.message}` }); });
    child.on('close', code => {
      clearTimeout(timer);
      const clean = stripAnsi(out).trim();
      resolve({ ok: code === 0 && !!clean, text: clean || stripAnsi(err).trim() || `exit ${code}` });
    });
  });
}
// Upload every file the model dropped in artDir to the server's per-task
// artifacts dir (raw binary POST), so the web UI can serve them for download.
async function uploadArtifacts(taskId, artDir) {
  let files = [];
  try { files = readdirSync(artDir).filter(f => { try { return statSync(join(artDir, f)).isFile(); } catch { return false; } }); }
  catch { return 0; }
  let n = 0;
  for (const f of files) {
    try {
      const res = await fetch(`${URL_BASE}/api/artifacts/${encodeURIComponent(taskId)}/${encodeURIComponent(f)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
        body: readFileSync(join(artDir, f))
      });
      if (res.ok) { n++; } else { console.error(`[${AGENT_NAME}] artifact ${f} upload → HTTP ${res.status}`); }
    } catch (e) { console.error(`[${AGENT_NAME}] artifact ${f} upload failed:`, e.message); }
  }
  return n;
}
// Download the task's attached input files (files a person uploaded for the brain
// to read) into a dedicated dir — kept OUT of artDir so they aren't re-uploaded as
// output artifacts. Returns { dir, files } for buildPrompt to point the model at.
async function downloadInputs(taskId) {
  const dir = join(os.tmpdir(), 'cowork-inputs', taskId);
  let names = [];
  try {
    const res = await fetch(`${URL_BASE}/api/inputs/${encodeURIComponent(taskId)}`, {
      headers: { ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) }
    });
    if (res.ok) names = await res.json();
  } catch { return { dir, files: [] }; }
  if (!Array.isArray(names) || !names.length) return { dir, files: [] };
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const f of names) {
    try {
      const r = await fetch(`${URL_BASE}/api/inputs/${encodeURIComponent(taskId)}/${encodeURIComponent(f)}`, {
        headers: { ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) }
      });
      if (!r.ok) { console.error(`[${AGENT_NAME}] input ${f} download → HTTP ${r.status}`); continue; }
      writeFileSync(join(dir, f), Buffer.from(await r.arrayBuffer()));
      files.push(f);
    } catch (e) { console.error(`[${AGENT_NAME}] input ${f} download failed:`, e.message); }
  }
  return { dir, files };
}
async function handle(task, agentId) {
  const brain = BRAIN[task.context.brain];
  running.add(task.id);
  const artDir = join(os.tmpdir(), 'cowork-artifacts', task.id);
  const inputDir = join(os.tmpdir(), 'cowork-inputs', task.id);
  mkdirSync(artDir, { recursive: true });
  console.log(`[${AGENT_NAME}] claimed ${task.id} on ${brain.id} — ${task.title}`);
  try {
    await tool('heartbeat', { agent_id: agentId, status: 'working', current_task: task.title });
    const inputInfo = await downloadInputs(task.id);
    if (inputInfo.files.length) console.log(`[${AGENT_NAME}] downloaded ${inputInfo.files.length} input file(s) for ${task.id}`);
    const { ok, text } = await runModel(brain, buildPrompt(task, artDir, inputInfo), artDir);
    // Persist the FULL transcript as result.md so it survives as a downloadable
    // artifact — the task result itself is truncated to a summary. (The local
    // dispatcher does the same; without this a long remote answer would be lost.)
    try { writeFileSync(join(artDir, 'result.md'), `# ${task.title}\n\n${text}\n`); } catch { /* ignore */ }
    const uploaded = await uploadArtifacts(task.id, artDir);
    if (uploaded) console.log(`[${AGENT_NAME}] uploaded ${uploaded} artifact(s) for ${task.id}`);
    const result = ok
      ? (text.length > 2000 ? text.slice(0, 2000) + `\n…(full output in artifacts/${task.id}/result.md)` : text)
      : `FAILED on ${brain.id}: ${text.slice(0, 1000)}`;
    await tool('complete_task', { task_id: task.id, result });
    console.log(`[${AGENT_NAME}] ${ok ? 'completed' : 'FAILED'} ${task.id}`);
  } catch (e) {
    console.error(`[${AGENT_NAME}] error on ${task.id}:`, e.message);
  } finally {
    running.delete(task.id);
    try { rmSync(artDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    try { rmSync(inputDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    await tool('heartbeat', { agent_id: agentId, status: running.size ? 'working' : 'idle' }).catch(() => {});
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  await connect();
  const me = await tool('register_agent', {
    platform: PLATFORM, agent_name: AGENT_NAME, capabilities: [...MY_IDS],
    brains: Object.values(BRAIN).map(b => ({ id: b.id, location: b.location, exec: b.exec, model: b.model, host: b.host, env: ENV_FACTS }))
  });
  const agentId = me.id;
  console.log(`[${AGENT_NAME}] registered as ${agentId} → ${URL_BASE}; serving brains: ${[...MY_IDS].join(', ')} (concurrency ${MAX_CONCURRENT})`);

  // Measure quota usage now and on a slow timer; each heartbeat carries the
  // cached snapshot (probing is too heavy to run per-heartbeat).
  await refreshUsage().catch(() => {});
  setInterval(() => refreshUsage().catch(() => {}), USAGE_MS).unref?.();

  for (;;) {
    try {
      await tool('heartbeat', {
        agent_id: agentId, status: running.size ? 'working' : 'idle',
        ...(Object.keys(USAGE).length ? { usage: USAGE } : {})
      });
      if (running.size < MAX_CONCURRENT) {
        const inbox = await tool('list_inbox', { status: 'pending', limit: 50 });
        const mine = (Array.isArray(inbox) ? inbox : []).filter(t => MY_IDS.has(t?.context?.brain) && !running.has(t.id));
        for (const task of mine.reverse()) {
          if (running.size >= MAX_CONCURRENT) break;
          const claimed = await tool('claim_task', { task_id: task.id, agent_id: agentId }).catch(() => null);
          if (claimed && claimed.status === 'in-progress' && claimed.claimedBy === agentId) handle(claimed, agentId);
        }
      }
    } catch (e) {
      console.error(`[${AGENT_NAME}] loop error:`, e.message);
      sessionId = null; try { await connect(); } catch { /* retry next tick */ }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
