/* Cowork MCP Dashboard — Vercel-quality redesign with Lucide icons + theme toggle */

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function timeAgo(iso) {
  if (!iso) return '-';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Human label for a FUTURE instant (the goal auto-retry time). "in 8m" / "in 2h",
// or "now" once it is due (the next drive tick will pick it up).
function retryLabel(iso) {
  if (!iso) return '';
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.ceil(s / 3600)}h`;
  return `in ${Math.ceil(s / 86400)}d`;
}

// Countdown twin of timeAgo — "2h 10m", "3d 4h", "now" — for rate-limit resets.
function timeUntil(iso) {
  if (!iso) return '';
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `${Math.max(1, Math.ceil(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// "Refreshes in 45h 13m" style — hours never roll into days (matches how the
// Antigravity quota panel counts down, e.g. 102h rather than "4d 6h").
function resetsInHM(iso) {
  if (!iso) return '';
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// "4 days, 1 hour" / "3 hours, 5 minutes" — the long form agy /usage uses in
// its "will fully refresh in …" sentence.
function resetsInLong(iso) {
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (!(s > 0)) return 'a moment';
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? `${unit(d, 'day')}, ${unit(h, 'hour')}` : unit(d, 'day');
  if (h > 0) return m ? `${unit(h, 'hour')}, ${unit(m, 'minute')}` : unit(h, 'hour');
  return unit(Math.max(1, m), 'minute');
}

// "remote-ai-code-gen-cc-fable" → "cc-fable"; "local-cc-opus-5-5" → "cc-opus".
// Falls back to the raw id when no exec marker is present.
function shortAgent(id) {
  const m = String(id).match(/(cc|agy|codex|ollama|hermes|dsh|ha)-[^]*$/);
  return m ? m[0] : String(id);
}

// Usage meters for the metered agents among `agentIds` (rate-limit % + reset).
// Agents with no usage snapshot (hermes/ollama/script — no quota) simply don't
// appear. Agents sharing one account (e.g. all cc-* on a host) produce identical
// snapshots, so meters are grouped per exec instead of repeated per agent. The
// agent names themselves aren't repeated here — the card already lists them in
// its capabilities section, so the rate-limit block shows only the meters.
function usageMeters(agentIds, usage) {
  const byExec = new Map();
  for (const id of agentIds || []) {
    const u = usage?.[id];
    if (!u?.windows?.length) continue;
    const existing = byExec.get(u.exec);
    if (!existing) {
      byExec.set(u.exec, { u: { ...u, windows: [...(u.windows || [])] } });
    } else {
      for (const w of u.windows || []) {
        if (!existing.u.windows.some(ew => ew.label === w.label && ew.group === w.group && ew.title === w.title)) {
          existing.u.windows.push(w);
        }
      }
      if (u.at && (!existing.u.at || new Date(u.at).getTime() > new Date(existing.u.at).getTime())) {
        existing.u.at = u.at;
      }
    }
  }
  if (!byExec.size) return '';
  const blocks = [...byExec.entries()].map(([exec, { u }]) => {
    const stale = Date.now() - new Date(u.at).getTime() > 1800000;
    return `<div class="usage-agent">
      <div class="usage-agent-head">
        ${badge(exec, '#7C3AED')}
        <span class="usage-at"${stale ? ' style="color:#EAB308"' : ''} title="${esc(new Date(u.at).toLocaleString())}">measured ${timeAgo(u.at)}</span>
      </div>
      ${usageExecBody(exec, u)}
    </div>`;
  }).join('');
  return `<div class="usage-panel">${blocks}</div>`;
}

// Human titles for the local-host exec cards.
const EXEC_TITLES = { agy: 'Antigravity', claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', ollama: 'Ollama' };

// One full-width card per LOCAL metered exec (claude / codex / antigravity),
// stacked vertically. Agents sharing one account produce one snapshot, so they
// collapse to a single card listing all their agent names. Cards have flexible
// height so the grouped Antigravity quota renders in full.
function localAgentCards(localAgents, usage) {
  const byExec = new Map();
  for (const id of localAgents || []) {
    const u = usage?.[id];
    if (!u?.windows?.length) continue;
    const existing = byExec.get(u.exec);
    if (!existing) {
      byExec.set(u.exec, { u: { ...u, windows: [...(u.windows || [])] }, names: [shortAgent(id)] });
    } else {
      existing.names.push(shortAgent(id));
      for (const w of u.windows || []) {
        if (!existing.u.windows.some(ew => ew.label === w.label && ew.group === w.group && ew.title === w.title)) {
          existing.u.windows.push(w);
        }
      }
      if (u.at && (!existing.u.at || new Date(u.at).getTime() > new Date(existing.u.at).getTime())) {
        existing.u.at = u.at;
      }
    }
  }
  // Antigravity first (it's the richest card), then the rest alphabetically.
  const order = e => (e === 'agy' ? '0' : `1${e}`);
  return [...byExec.entries()].sort((a, b) => order(a[0]).localeCompare(order(b[0]))).map(([exec, { u, names }]) => {
    const stale = Date.now() - new Date(u.at).getTime() > 1800000;
    return `<div class="card agent-card conn-local-card">
      <div class="agent-header">
        <span class="agent-title">${esc(EXEC_TITLES[exec] || exec)} ${badge('local', '#0EA5E9')}</span>
        <span class="usage-at"${stale ? ' style="color:#EAB308"' : ''} title="${esc(new Date(u.at).toLocaleString())}">measured ${timeAgo(u.at)}</span>
      </div>
      <div class="conn-local-names">${names.slice().sort().map(n => `<div>${esc(n)}</div>`).join('')}</div>
      ${usageExecBody(exec, u)}
    </div>`;
  });
}

// Friendly names for the known rate-limit windows (falls back to the raw
// label for future variants like 7d-opus).
const WINDOW_NAMES = { '5h': '5-hour', '7d': 'weekly', credits: 'credits' };

// The meter body for one exec's snapshot. Antigravity (agy) reports its quota
// grouped by model family and as PERCENT-REMAINING, so it gets the grouped
// "Weekly / Five Hour Limit Remaining" layout; every other exec (claude/codex)
// keeps the compact used-percent rows.
function usageExecBody(exec, u) {
  if (exec === 'agy' && (u.windows || []).some(w => w.group || w.remainingPct != null || w.disabledNote)) {
    return agyGroupedBody(u);
  }
  return (u.windows || []).map(w => {
    const p = Math.round(w.usedPct);
    const color = p >= 80 ? '#EF4444' : p >= 50 ? '#EAB308' : '#22C55E';
    const long = WINDOW_NAMES[w.label] || (w.label.startsWith('7d-') ? `weekly ${w.label.slice(3)}` : w.label);
    const reset = w.resetsAt ? `resets in ${timeUntil(w.resetsAt)}` : 'reset time unknown';
    return `<div class="usage-row" title="${esc(long)} · ${w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString()}` : 'reset time unknown'}">
      <span class="usage-window">${esc(w.label)}</span>
      <div class="usage-track"><div class="usage-fill" style="width:${p}%;background:${color}"></div></div>
      <span class="usage-pct" style="color:${color}">${p}<span class="usage-pct-sign">%</span></span>
      <span class="usage-reset">${esc(reset)}</span>
    </div>`;
  }).join('');
}

// Long label for an Antigravity quota window ('7d' → "Weekly Limit Remaining").
function agyWindowLabel(label) {
  if (label === '7d') return 'Weekly Limit Remaining';
  if (label === '5h') return 'Five Hour Limit Remaining';
  if (label.startsWith('7d-')) return `Weekly ${label.slice(3)} Limit Remaining`;
  return `${label} Limit Remaining`;
}

// Order windows within a group: weekly (7d) first, then 5-hour, then the rest —
// matching the Antigravity panel's ordering.
function agyWindowRank(label) {
  if (label === '7d' || label.startsWith('7d-')) return 0;
  if (label === '5h') return 1;
  return 2;
}

// Grouped Antigravity quota body, laid out like `agy /usage`: one section per
// model-group (name, then its member models or the group's note), and per
// window its title, a "remaining" bar with a 2-decimal percent, and a status
// line — "Quota available" when full, "Refreshes in 97h 35m" otherwise — or
// "Disabled: …" when the window doesn't currently apply. `remainingPct`
// drives the bar (high remaining = green).
function agyGroupedBody(u) {
  const groups = new Map();
  for (const w of u.windows || []) {
    const key = w.group || 'Antigravity';
    if (!groups.has(key)) groups.set(key, { models: [], note: '', windows: [] });
    const entry = groups.get(key);
    if (!entry.models.length && w.groupModels?.length) entry.models = w.groupModels;
    if (!entry.note && w.groupNote) entry.note = w.groupNote;
    entry.windows.push(w);
  }
  return [...groups.entries()].map(([name, { models, note, windows }]) => {
    const weekly = windows.find(w => agyWindowRank(w.label) === 0 && w.resetsAt);
    const rows = windows.slice().sort((a, b) => agyWindowRank(a.label) - agyWindowRank(b.label)).map(w => {
      const label = w.title || agyWindowLabel(w.label);
      if (w.disabledNote != null && w.remainingPct == null) {
        // The API text may already carry a "Disabled:" prefix — don't double it.
        let text = String(w.disabledNote).replace(/^\s*Disabled\s*[:\u2014\u2013-]\s*/i, '');
        // agy /usage appends when the weekly cap lifts; add it if the API didn't.
        if (weekly && !/refresh/i.test(text)) {
          text = `${text.replace(/\s*$/, '').replace(/([^.!?])$/, '$1.')} Your weekly limit will fully refresh in ${resetsInLong(weekly.resetsAt)}.`;
        }
        return `<div class="agy-win">
          <div class="agy-win-label">${esc(label)}</div>
          <div class="agy-win-disabled">Disabled: ${esc(text)}</div>
        </div>`;
      }
      const rem = Math.max(0, Math.min(100, Number(w.remainingPct != null ? w.remainingPct : (100 - w.usedPct))));
      const color = rem >= 50 ? '#22C55E' : rem >= 20 ? '#EAB308' : '#EF4444';
      const status = rem >= 100 ? 'Quota available'
        : w.resetsAt ? `Refreshes in ${resetsInHM(w.resetsAt)}`
        : rem <= 0 ? 'Quota exhausted' : 'Refresh time unknown';
      return `<div class="agy-win" title="${esc(label)} · ${w.resetsAt ? `refreshes ${new Date(w.resetsAt).toLocaleString()}` : 'refresh time unknown'}">
        <div class="agy-win-label">${esc(label)}</div>
        <div class="agy-bar-row">
          <div class="agy-bar"><div class="agy-bar-fill" style="width:${rem}%;background:${color}"></div></div>
          <span class="agy-bar-pct" style="color:${color}">${rem.toFixed(2)}<span class="usage-pct-sign">%</span></span>
        </div>
        <div class="agy-win-meta">${esc(status)}</div>
      </div>`;
    }).join('');
    const subLine = models.length
      ? `<div class="agy-group-models">Models within this group: ${models.map(esc).join(', ')}</div>`
      : note ? `<div class="agy-group-models">${esc(note)}</div>` : '';
    return `<div class="agy-group">
      <div class="agy-group-name">${esc(name)}</div>
      ${subLine}
      ${rows}
    </div>`;
  }).join('');
}

// A task is "failed" when its whole fallback chain was exhausted. Prefer the
// explicit flag set by the server; fall back to the result text / rejected status
// so tasks that finished before the flag existed still categorize correctly.
// Filter-pill text: "done 12" etc. Counts come from /status's inboxSummary;
// the "done" pill excludes failed tasks, mirroring the server's done filter.
function inboxPillLabel(f, status) {
  const s = status?.inboxSummary;
  const counts = s ? {
    done: Math.max(0, (s.completed || 0) - (s.failed || 0)),
    'in-progress': s.inProgress || 0, pending: s.pending || 0,
    scheduled: s.scheduled || 0,
    'wait-input': s.waitingInput || 0, failed: s.failed || 0
  } : null;
  const n = counts && f ? counts[f] : null;
  return (f === '' ? 'All' : f) + (n !== null && n !== undefined ? ` ${n}` : '');
}

// Does task t belong under the Tasks status filter f? Mirrors store.listTasks.
function inboxFilterMatches(t, f) {
  if (!f) return true;
  if (f === 'failed') return isTaskFailed(t);
  if (f === 'done') return t.status === 'done' && !isTaskFailed(t);
  return t.status === f;
}

function isTaskFailed(t) {
  return t.failed === true
    || t.status === 'rejected'
    || (t.status === 'done' && typeof t.result === 'string' && /^FAILED\b/i.test(t.result.trim()));
}

// A `done` task CLOSED administratively without ever running an agent (a
// superseded scheduled duplicate, a pre-empted cancel). It has no artifacts dir
// and no result.md because it never entered the dispatcher's run path, so a
// plain green "done" card with an empty artifacts list looks like a silent
// failure. We badge it distinctly instead. MUST stay in lockstep with the
// server's isClosedWithoutRunning (store.ts): (1) result opens with an
// administrative-close marker, or (2) it was marked done at/before its own
// scheduledAt launch time — impossible for a task that actually executed.
function isTaskClosedNoRun(t) {
  if (t.status !== 'done' || isTaskFailed(t)) return false;
  const r = typeof t.result === 'string' ? t.result.trim() : '';
  if (/^(SUPERSEDED|CLOSED|SKIPPED|CANCELL?ED|DUPLICATE|WON'?T[\s-]?FIX|NO[\s-]?OP)\b/i.test(r)) return true;
  if (t.completedAt && t.scheduledAt) {
    const done = Date.parse(t.completedAt), launch = Date.parse(t.scheduledAt);
    if (Number.isFinite(done) && Number.isFinite(launch) && done <= launch) return true;
  }
  return false;
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// A task's parameters are editable only when it is NEITHER running NOR pending —
// i.e. scheduled / wait-input / done / rejected / failed. A pending/claimed/
// in-progress task is (about to be) executing, so editing it would race the
// dispatcher; the server enforces the same rule in Store.updateTask.
function isTaskEditable(t) {
  return t && !['pending', 'claimed', 'in-progress'].includes(t.status);
}

// Convert a stored UTC ISO instant to the local wall-clock string a
// <input type="datetime-local"> expects ("YYYY-MM-DDTHH:MM"), so editing a
// scheduled task shows the SAME local time the user originally picked.
function isoToLocalInput(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Recurrence editor — a compact "Repeat" widget shared by the New-task composer,
 * the Edit modal and the agent-dispatch schedule sheet. It renders a cadence
 * <select> (none / minutes / hours / daily / weekly / monthly / cron) plus the
 * fields each cadence needs, and reads back a `recurrence` object matching the
 * server's core/recurrence.ts schema. Wall-clock times are the browser's local
 * time, which the server interprets in its own (Taiwan) timezone.
 *
 * `p` is a unique id prefix so multiple editors can coexist on one page.
 */
const RECUR_TYPES = [
  ['', 'One-off — do not repeat'],
  ['minutes', 'Every N minutes'],
  ['hours', 'Every N hours'],
  ['daily', 'Daily (every N days)'],
  ['weekly', 'Weekly / specific weekdays'],
  ['monthly', 'Monthly (day of month)'],
  ['cron', 'Custom (cron expression)'],
];
const RECUR_WD = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];

function recurrenceEditorHTML(p, fieldStyle, labelStyle, rec) {
  rec = rec || {};
  const type = rec.type || '';
  const sel = (v) => (v === type ? ' selected' : '');
  const typeOpts = RECUR_TYPES.map(([v, l]) => `<option value="${v}"${sel(v)}>${esc(l)}</option>`).join('');
  const interval = rec.interval != null ? esc(String(rec.interval)) : '';
  const atTime = rec.atTime ? esc(rec.atTime) : '';
  const dom = rec.dayOfMonth != null ? esc(String(rec.dayOfMonth)) : '';
  const expr = rec.expr ? esc(rec.expr) : '';
  const wd = Array.isArray(rec.weekdays) ? rec.weekdays.map(Number) : [];
  const wdChips = RECUR_WD.map(([v, l]) =>
    `<label style="display:inline-flex;align-items:center;gap:4px;font-size:0.82rem;margin-right:8px">
       <input type="checkbox" class="${p}-wd" value="${v}"${wd.includes(Number(v)) ? ' checked' : ''}> ${l}</label>`).join('');
  const half = `${fieldStyle}; flex:1`;
  return `
    <label style="${labelStyle}">Repeat</label>
    <select id="${p}-type" style="${fieldStyle}; margin-bottom:10px">${typeOpts}</select>
    <div id="${p}-num" style="display:none; gap:8px; margin-bottom:10px; align-items:center">
      <span style="font-size:0.82rem;color:var(--text-muted)">every</span>
      <input id="${p}-interval" type="number" min="1" step="1" style="${fieldStyle}; width:90px" value="${interval}" placeholder="1">
      <span id="${p}-unit" style="font-size:0.82rem;color:var(--text-muted)"></span>
    </div>
    <div id="${p}-wdrow" style="display:none; margin-bottom:10px">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);margin-bottom:6px">On weekdays <span style="text-transform:none;letter-spacing:0">(none = the start day, weekly)</span></div>
      <div>${wdChips}</div>
    </div>
    <div id="${p}-domrow" style="display:none; gap:8px; margin-bottom:10px; align-items:center">
      <span style="font-size:0.82rem;color:var(--text-muted)">on day</span>
      <input id="${p}-dom" type="number" min="1" max="31" step="1" style="${fieldStyle}; width:90px" value="${dom}" placeholder="1-31">
      <span style="font-size:0.78rem;color:var(--text-muted)">(clamped to short months)</span>
    </div>
    <div id="${p}-timerow" style="display:none; gap:8px; margin-bottom:10px; align-items:center">
      <span style="font-size:0.82rem;color:var(--text-muted)">at time</span>
      <input id="${p}-at" type="time" style="${fieldStyle}; width:140px" value="${atTime}">
      <span style="font-size:0.78rem;color:var(--text-muted)">(blank = the start time)</span>
    </div>
    <div id="${p}-cronrow" style="display:none; margin-bottom:10px">
      <input id="${p}-expr" style="${fieldStyle}" value="${expr}" placeholder="min hour dom mon dow — e.g. 0 9 * * 1-5">
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">5-field cron in server local time. e.g. <code>*/15 9-17 * * *</code></div>
    </div>`;
}

/** Wire the cadence <select> so only the relevant fields show. Call after insert. */
function recurrenceEditorBind(content, p) {
  const typeEl = content.querySelector(`#${p}-type`);
  if (!typeEl) return;
  const show = (id, on, disp = 'flex') => { const el = content.querySelector(`#${p}-${id}`); if (el) el.style.display = on ? disp : 'none'; };
  const sync = () => {
    const t = typeEl.value;
    show('num', t === 'minutes' || t === 'hours' || t === 'daily' || t === 'weekly' || t === 'monthly');
    show('wdrow', t === 'weekly', 'block');
    show('domrow', t === 'monthly');
    show('timerow', t === 'daily' || t === 'weekly' || t === 'monthly');
    show('cronrow', t === 'cron', 'block');
    const unit = content.querySelector(`#${p}-unit`);
    if (unit) unit.textContent = { minutes: 'minute(s)', hours: 'hour(s)', daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)' }[t] || '';
  };
  typeEl.onchange = sync;
  sync();
}

/** Read the editor back into a `recurrence` object, or null for "one-off". */
function readRecurrence(content, p) {
  const typeEl = content.querySelector(`#${p}-type`);
  if (!typeEl || !typeEl.value) return null;
  const type = typeEl.value;
  if (type === 'cron') {
    const expr = (content.querySelector(`#${p}-expr`).value || '').trim();
    return expr ? { type, expr } : null;
  }
  const rec = { type };
  const iv = parseInt(content.querySelector(`#${p}-interval`).value, 10);
  rec.interval = Number.isFinite(iv) && iv >= 1 ? iv : 1;
  if (type === 'weekly') {
    const days = Array.from(content.querySelectorAll(`.${p}-wd`)).filter(c => c.checked).map(c => Number(c.value));
    if (days.length) rec.weekdays = days;
  }
  if (type === 'monthly') {
    const dom = parseInt(content.querySelector(`#${p}-dom`).value, 10);
    if (Number.isFinite(dom)) rec.dayOfMonth = dom;
  }
  if (type === 'daily' || type === 'weekly' || type === 'monthly') {
    const at = (content.querySelector(`#${p}-at`).value || '').trim();
    if (at) rec.atTime = at;
  }
  return rec;
}

/** One-line human label for a recurrence badge (mirrors describeRecurrence). */
function describeRecurrence(rec) {
  if (!rec || !rec.type) return '';
  const n = rec.interval || 1;
  const every = (u) => (n === 1 ? `every ${u}` : `every ${n} ${u}s`);
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (rec.type) {
    case 'minutes': return every('minute');
    case 'hours': return every('hour');
    case 'daily': return `${every('day')}${rec.atTime ? ` at ${rec.atTime}` : ''}`;
    case 'weekly': {
      const days = (rec.weekdays && rec.weekdays.length) ? rec.weekdays.map(d => WD[d]).join('/') : '';
      const base = n === 1 ? 'weekly' : `every ${n} weeks`;
      return `${base}${days ? ` on ${days}` : ''}${rec.atTime ? ` at ${rec.atTime}` : ''}`;
    }
    case 'monthly': {
      const base = n === 1 ? 'monthly' : `every ${n} months`;
      return `${base}${rec.dayOfMonth ? ` on day ${rec.dayOfMonth}` : ''}${rec.atTime ? ` at ${rec.atTime}` : ''}`;
    }
    case 'cron': return `cron "${rec.expr}"`;
    default: return '';
  }
}

const STATUS_COLORS = {
  'wait-input': '#A855F7', scheduled: '#6366F1', pending: '#EAB308', claimed: '#0EA5E9', 'in-progress': '#0EA5E9',
  done: '#22C55E', rejected: '#EF4444',
  idle: '#94A3B8', working: '#22C55E', blocked: '#EF4444'
};

function badge(text, color) {
  return `<span class="badge" style="background:${color}18; color:${color}; border:1px solid ${color}40">${esc(text)}</span>`;
}

function createIcons(root) {
  if (window.lucide) lucide.createIcons(root ? { root } : undefined);
}

// Sanitized markdown render (agent output is untrusted → DOMPurify).
function md(text) {
  const raw = String(text ?? '');
  try { return window.DOMPurify.sanitize(window.marked.parse(raw)); }
  catch { return `<pre>${esc(raw)}</pre>`; }
}
// A markdown block with a Raw/Rendered toggle (delegated click handler below).
let _mdSeq = 0;
function mdViewer(text, label, opts = {}) {
  const id = `md${++_mdSeq}`;
  // `big` bumps every size by ~2px for the cramped DESCRIPTION / RESULT blocks.
  const big = !!opts.big;
  const labelSize = big ? '0.845rem' : '0.72rem';
  const bodySize  = big ? '1rem'     : '0.87rem';
  const rawSize   = big ? '0.955rem' : '0.83rem';
  return `<div class="md-block" data-md="${id}">
    ${label ? `<div style="font-size:${labelSize};color:var(--text-muted);display:flex;justify-content:space-between;align-items:center">
      <span>${esc(label)}</span>
      <button class="btn md-toggle" data-md-target="${id}" style="font-size:0.68rem;padding:2px 6px">Raw</button></div>` : ''}
    <div class="md-body" data-md-body="${id}" style="font-size:${bodySize}; line-height:1.5">${md(text)}</div>
    <pre class="md-raw" data-md-raw="${id}" hidden style="white-space:pre-wrap; font-size:${rawSize}; background:var(--bg-tertiary); padding:10px; border-radius:8px; margin:4px 0">${esc(text)}</pre>
  </div>`;
}

// Media type detection for in-app viewers, keyed off the file extension. Images,
// video and audio all render inline in an <img>/<video>/<audio> element, which
// the browser honours regardless of the download route's Content-Disposition, so
// no server change is needed to preview them.
const MEDIA_KIND = [
  { type: 'image', icon: 'image', re: /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i },
  { type: 'video', icon: 'film',  re: /\.(mp4|webm|mov|m4v|ogv)$/i },
  { type: 'audio', icon: 'music', re: /\.(mp3|wav|ogg|oga|m4a|aac|flac)$/i },
];
function mediaKindFor(f) { return MEDIA_KIND.find(k => k.re.test(f)) || null; }

// Plain-text artifacts (.txt / .log) that open in the in-app viewer as raw text
// instead of downloading. They ride the same popup as markdown (openMarkdownModal
// with { plain: true }) but skip the markdown parse — a .log rendered as markdown
// would mangle its formatting.
const TEXT_RE = /\.(txt|log)$/i;

// One file chip for a task's OUTPUTS, ARTIFACTS or INPUTS list (`kind` picks the API
// route). Markdown files (.md / .markdown) open in the in-app markdown viewer,
// plain-text files (.txt / .log) open in the same viewer as raw text, and
// images / video / audio open in the in-app media viewer (buttons wired to
// App.openMarkdownModal / App.openMediaModal via the delegated .md-artifact /
// .text-artifact / .media-artifact handlers) so they can be read without leaving
// the dashboard; every other file type stays a plain download link. Shared by the
// Inbox file lists stay visually identical.
function artifactChip(taskId, f, fontSize = '0.9rem', kind = 'artifacts') {
  const base = `font-size:${fontSize};margin:0;display:inline-flex;align-items:center;gap:4px`;
  if (/\.(md|markdown)$/i.test(f)) {
    return `<button class="btn md-artifact" data-md-task="${esc(taskId)}" data-md-file="${esc(f)}" data-md-kind="${esc(kind)}" title="Open “${esc(f)}” in the markdown viewer" style="${base}"><i data-lucide="book-open" style="width:12px;height:12px"></i>${esc(f)}</button>`;
  }
  if (TEXT_RE.test(f)) {
    return `<button class="btn text-artifact" data-md-task="${esc(taskId)}" data-md-file="${esc(f)}" data-md-kind="${esc(kind)}" title="Open “${esc(f)}” in the text viewer" style="${base}"><i data-lucide="file-text" style="width:12px;height:12px"></i>${esc(f)}</button>`;
  }
  const media = mediaKindFor(f);
  if (media) {
    return `<button class="btn media-artifact" data-media-task="${esc(taskId)}" data-media-file="${esc(f)}" data-media-type="${media.type}" data-media-kind="${esc(kind)}" title="Preview “${esc(f)}” in the ${media.type} viewer" style="${base}"><i data-lucide="${media.icon}" style="width:12px;height:12px"></i>${esc(f)}</button>`;
  }
  const encodedPath = f.split('/').map(encodeURIComponent).join('/');
  const downloadName = f.split('/').pop() || f;
  return `<a href="/api/${kind}/${encodeURIComponent(taskId)}/${encodedPath}" download="${esc(downloadName)}" class="btn" style="${base}"><i data-lucide="download" style="width:12px;height:12px"></i>${esc(f)}</a>`;
}

/** Max file chips rendered per list on a card. Each chip is a button + Lucide
 *  SVG; a run with thousands of files (cloned repos) used to put ~300k nodes in
 *  the Tasks view and stall every refresh. The rest collapse into a "+N more" note
 *  (`total` = the server's real count when it capped the list: task.artifactsTotal). */
const CARD_CHIP_MAX = 40;
function artifactChips(taskId, files, fontSize = '0.9rem', kind = 'artifacts', total = 0) {
  const shown = files.slice(0, CARD_CHIP_MAX);
  const more = Math.max(files.length, total || 0) - shown.length;
  return shown.map(f => artifactChip(taskId, f, fontSize, kind)).join('')
    + (more > 0 ? `<span style="font-size:${fontSize}; color:var(--text-muted); padding:0 4px">+${more.toLocaleString()} more on disk</span>` : '');
}

/** Agent chip accent (translucent bg / border / text share one hue). */
const AGENT_COLOR = '#F97316';        // orange
const AGENT_BAD_COLOR = '#EF4444';    // unknown / deregistered agent

/**
 * Sorted agent ids that may be PICKED to run a task. Disabled agents are
 * excluded everywhere a task is dispatched or scheduled (new-task, continue/
 * re-run, edit-task) so a disabled agent can never be assigned — mirroring the
 * dispatcher, which strips disabled agents from every chain and pin. The Agents
 * management page still lists disabled agents (with the Enable toggle); it uses
 * the raw /api/agents map directly, not this helper.
 */
function agyWindowMatchesModel(modelOrAgentId, w) {
  if (!w?.group) return true;
  const target = (modelOrAgentId || '').toLowerCase();
  const group = (w.group || '').toLowerCase();
  const title = (w.title || '').toLowerCase();
  const note = (w.groupNote || '').toLowerCase();

  const isArgonModel = target.includes('argon');
  const isArgonWindow = group.includes('argon') || title.includes('argon') || note.includes('argon');
  if (isArgonModel) return isArgonWindow;
  if (isArgonWindow) return false;

  if (target.includes('gemini')) return group.includes('gemini');
  if (target.includes('claude')) return group.includes('claude');
  if (target.includes('gpt')) return group.includes('gpt');

  if (w.groupModels && w.groupModels.length > 0) {
    for (const gm of w.groupModels) {
      const words = gm.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length > 0 && words.every(word => target.includes(word))) return true;
    }
  }

  return group.includes(target) || target.includes(group);
}

/** Reset time (Date) of an agent's rate limit window — prefers an exhausted (≥100%)
 *  window that is actively cooling down, or falls back to the rate limit reset time
 *  for metered agents so rate limits remain visible in pickers — or null. */
function agentCooldownUntil(u, agentId) {
  let until = 0;
  let futureReset = 0;
  for (const w of (u && Array.isArray(u.windows)) ? u.windows : []) {
    if (agentId && u?.exec === 'agy' && !agyWindowMatchesModel(agentId, w)) continue;
    const used = typeof w.usedPct === 'number' ? w.usedPct : (typeof w.remainingPct === 'number' ? 100 - w.remainingPct : 0);
    const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (Number.isFinite(at) && at > Date.now()) {
      futureReset = Math.max(futureReset, at);
      if (used >= 100) until = Math.max(until, at);
    }
  }
  const chosen = until || futureReset;
  return chosen ? new Date(chosen) : null;
}

// Thinking level picker: a run parameter, separate from which agent runs.
// `inherit` names what an empty choice falls back to.
const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function thinkingOptions(current = '', inherit = 'agent default, else medium') {
  return [`<option value=""${current ? '' : ' selected'}>Default (${esc(inherit)})</option>`]
    .concat(THINKING_LEVELS.map(l => `<option value="${l}"${l === current ? ' selected' : ''}>${l}</option>`)).join('');
}

function selectableAgentIds(agents) {
  return Object.keys(agents || {}).filter(id => !agents[id]?.disabled).sort();
}

/**
 * Shared agent-chain editor — the ONE renderer for every fallback chain (Agents
 * default chain, Routing roles/tiers/divisions/personas), so all of them read the
 * same live agent registry the Agents page edits:
 *  - the "+ add" picker offers only ENABLED agents not already in the chain
 *    (selectableAgentIds), so it tracks Enable/Disable on the Agents page;
 *  - a chip whose agent is disabled is shown muted + struck through ("skipped"),
 *    a deregistered one in red, matching what the dispatcher actually does
 *    (it strips disabled rungs, server/src/core/dispatcher.ts chainFor).
 */
function chainAgentState(agents, id) {
  const a = agents?.[id];
  return !a ? 'unknown' : a.disabled ? 'disabled' : 'ok';
}

/** Enabled ids in `chain` — the rungs the dispatcher will really try. */
function effectiveChain(chain, agents) {
  return (chain || []).filter(id => chainAgentState(agents, id) === 'ok');
}

/** One rung: draggable, ✕ to remove. `editable:false` renders a read-only chip. */
function chainChip(agent, i, total, agents, editable = true) {
  const st = chainAgentState(agents, agent);
  const c = st === 'unknown' ? AGENT_BAD_COLOR : st === 'disabled' ? '#94A3B8' : AGENT_COLOR;
  const title = st === 'unknown' ? 'unknown agent (deregistered) — remove it'
    : st === 'disabled' ? 'disabled on the Agents page — skipped at dispatch'
    : editable ? `rung ${i + 1} of ${total} — drag to reorder` : `rung ${i + 1} of ${total}`;
  return `<span class="dchip"${editable ? ' draggable="true"' : ''} data-agent="${esc(agent)}" title="${esc(title)}"
    style="display:inline-flex;align-items:center;gap:6px;cursor:${editable ? 'grab' : 'default'};background:${c}18;border:1px ${editable ? 'solid' : 'dashed'} ${c}40;color:${c};padding:4px 9px;border-radius:8px;font-size:0.8rem;margin:3px">
    ${editable ? '<i data-lucide="grip-vertical" style="width:12px;height:12px;opacity:.5"></i>' : ''}
    <b style="opacity:.6">${i + 1}</b> <span${st === 'disabled' ? ' style="text-decoration:line-through"' : ''}>${esc(agent)}</span>${st === 'unknown' ? ' ⚠' : st === 'disabled' ? ' <span style="font-size:0.68rem">(disabled)</span>' : ''}
    ${editable ? `<a data-rm="${esc(agent)}" title="remove" aria-label="remove ${esc(agent)}" style="cursor:pointer">✕</a>` : ''}</span>`;
}

const CHAIN_SELECT_STYLE = 'padding:4px 6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.78rem';

/** "+ add" picker: enabled agents not yet in `chain`, plus a count of hidden disabled ones. */
function chainAddSelect(chain, agents, attrs, label = '+ add agent…') {
  const ids = selectableAgentIds(agents).filter(id => !(chain || []).includes(id));
  const off = Object.keys(agents || {}).filter(id => agents[id]?.disabled && !(chain || []).includes(id)).length;
  if (!ids.length) {
    return `<span style="font-size:0.75rem;color:var(--text-muted)">${(chain || []).length ? 'every enabled agent is in this chain' : 'no enabled agents — enable one on the Agents page'}</span>`;
  }
  return `<select ${attrs} style="${CHAIN_SELECT_STYLE}"><option value="">${esc(label)}</option>${ids.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}${off ? `<option value="" disabled>— ${off} disabled agent${off > 1 ? 's' : ''} hidden —</option>` : ''}</select>`;
}

/** Warning line when nothing in a chain can actually run. */
function chainWarning(chain, agents) {
  if (!(chain || []).length) return '';
  if (effectiveChain(chain, agents).length) return '';
  return `<div style="font-size:0.75rem;color:${AGENT_BAD_COLOR};margin:2px 0">⚠ every agent in this chain is disabled or unknown — tasks routed here will fail</div>`;
}

/** Editable chain: chips (drag/✕) + add picker. Wire with App#wireChainEditor. */
function chainEditor(chain, agents, ctx, { emptyText = 'none — add an agent →', addLabel } = {}) {
  const list = chain || [];
  return `<div class="chain-editor" data-ctx="${esc(ctx)}">
    <div class="chain-row" style="margin:4px 0;min-height:30px;display:flex;flex-wrap:wrap;align-items:center">${
      list.map((b, i) => chainChip(b, i, list.length, agents)).join('')
      || `<span style="color:var(--text-muted);font-size:0.8rem">${esc(emptyText)}</span>`}</div>
    ${chainWarning(list, agents)}
    ${chainAddSelect(list, agents, `data-chain-add="${esc(ctx)}"`, addLabel)}
  </div>`;
}

/** Read-only chain (inherited from a parent), shown dashed. */
function chainPreview(chain, agents) {
  const list = chain || [];
  return list.length
    ? `<div style="display:flex;flex-wrap:wrap;align-items:center;margin:4px 0">${list.map((b, i) => chainChip(b, i, list.length, agents, false)).join('')}</div>${chainWarning(list, agents)}`
    : '<div style="font-size:0.8rem;color:var(--text-muted);margin:4px 0">(empty)</div>';
}

/**
 * Portal — a launcher for the local self-hosted web services this host runs.
 * Nothing here is hard-coded: the whole catalog (cards, labels, icons,
 * categories + their order, accent colour, systemd units) comes from
 * portal.json via GET /api/portal — see server/src/core/portal-config.ts.
 * Each card is a plain link that opens the service in a new tab. Status dots are
 * probed server-side (GET /api/services) rather than from the browser, since a
 * cross-origin fetch to a service's localhost URL just trips CORS; the server
 * runs on the host, so it can reach the real loopback ports. See service-probe.ts.
 */

// Turn a service key like "vllm35b" into a readable "Vllm35b" fallback label.
function humanizeKey(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

class App {
  constructor() {
    this.currentView = '';
    this.api = window.api;
    this.sse = null;
    this.activity = [];
    this.inboxFilter = '';
    this.inboxSearch = '';     // Task Inbox title search (client-side, on top of the status filter)
    this.inboxLimit = 50;
    this.openTasks = new Set();  // retained (task cards no longer expand); harmless legacy state
    this.taskFilesOpen = new Set();  // inbox task ids whose RESULT / ARTIFACTS / INPUTS / INTERACTION block is expanded (collapsed by default)
    this.workers = new Map();   // worker UUID → { name, platform } for human-readable labels

    this.contentEl = document.getElementById('content');
    this.viewTitleEl = document.getElementById('view-title');
    this.toastContainer = document.getElementById('toast-container');

    this.initTheme();
    this.init();
    // Delegated Raw/Rendered toggle for markdown blocks.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.md-toggle');
      if (!btn) return;
      const id = btn.dataset.mdTarget;
      const body = document.querySelector(`[data-md-body="${id}"]`);
      const raw = document.querySelector(`[data-md-raw="${id}"]`);
      if (!body || !raw) return;
      const showRaw = body.style.display !== 'none';
      body.style.display = showRaw ? 'none' : '';
      raw.hidden = !showRaw;
      btn.textContent = showRaw ? 'Rendered' : 'Raw';
    });
    // Delegated: markdown artifacts open in the in-app popup viewer instead of
    // downloading. Works for the Inbox cards,
    // which re-render in place, so a document-level handler avoids stale listeners.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.md-artifact');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      this.openMarkdownModal(btn.dataset.mdTask, btn.dataset.mdFile, btn.dataset.mdKind || 'artifacts');
    });
    // Delegated: plain-text artifacts (.txt / .log) open in the same popup viewer
    // as raw text ({ plain: true } skips the markdown parse). Same document-level
    // rationale as the markdown handler above.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.text-artifact');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      this.openMarkdownModal(btn.dataset.mdTask, btn.dataset.mdFile, btn.dataset.mdKind || 'artifacts', { plain: true });
    });
    // Delegated: image / video / audio artifacts (and inputs) open in the in-app
    // media viewer instead of downloading. Same document-level rationale as the
    // markdown handler above — the Inbox cards re-render
    // in place, so a delegated handler avoids stale per-node listeners.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.media-artifact');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      this.openMediaModal(btn.dataset.mediaTask, btn.dataset.mediaFile, btn.dataset.mediaType, btn.dataset.mediaKind || 'artifacts');
    });
    // Delegated: tapping anywhere on an inbox task card toggles its RESULT /
    // ARTIFACTS / INPUTS / INTERACTION block, which is hidden by default — long
    // file lists used to bury the card. Taps on interactive controls (buttons,
    // links, inputs, copyable chips) are excluded so they keep their own behaviour.
    // Document-level like the handlers above, so in-place re-renders never lose
    // the listener.
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.task-card');
      if (!card || e.target.closest('button, a, input, label, select, textarea, .copyable, pre[data-progress]')) return;
      this.toggleTaskFiles(card.dataset.task);
    });
    // Keyboard access for the same toggle (the files head row carries
    // role="button" tabindex="0"): Enter / Space expand-collapse the block.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const head = e.target.closest ? e.target.closest('.task-files-head') : null;
      if (!head) return;
      const card = head.closest('.task-card');
      if (!card) return;
      e.preventDefault();
      this.toggleTaskFiles(card.dataset.task);
    });
  }

  initTheme() {
    const saved = localStorage.getItem('cowork-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    this._syncThemeToggle(saved);
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.toggleTheme());
    }
    createIcons();
  }

  // Keep the theme toggle's icon and its screen-reader state (aria-pressed +
  // label) in sync with the active theme so it announces correctly.
  _syncThemeToggle(theme) {
    const toggleIcon = document.querySelector('#theme-toggle [data-lucide]');
    if (toggleIcon) {
      toggleIcon.setAttribute('data-lucide', theme === 'dark' ? 'moon' : 'sun');
    }
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      toggleBtn.setAttribute('aria-label',
        theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('cowork-theme', next);
    this._syncThemeToggle(next);
    createIcons();
  }

  async init() {
    window.addEventListener('hashchange', () => this.navigate());
    this.setupSSE();
    await this.loadLayout();
    this.navigate();
  }

  // ── Layout (layout.json → nav sections, pages, dashboard widgets) ─────────

  /**
   * Fetch the dashboard layout (GET /api/layout, validated server-side by
   * core/layout-config.ts) and build the sidebar from it. If the server can't
   * serve it, fall back to a flat nav of the built-in pages so the app never
   * boots without navigation.
   */
  async loadLayout() {
    try {
      this.layout = await this.api.get('/layout');
    } catch (e) {
      // Mirrors the repo layout.json, so an older server without /api/layout
      // (or a failed fetch) still gets the familiar nav.
      const app = { tasks: ['Tasks', 'inbox'], recipes: ['Recipes', 'chef-hat'], calendar: ['Calendar', 'calendar-days'],
        goals: ['Goals', 'target'], routing: ['Routing', 'bot'], agents: ['Agents', 'cpu'], personas: ['Personas', 'users-round'],
        workers: ['Workers', 'plug'], config: ['Configuration', 'settings'] };
      const pages = {
        overview: { id: 'overview', type: 'dashboard', label: 'Overview', icon: 'layout-dashboard',
          rows: [{ widgets: [{ type: 'sysbar' }] }, { widgets: [{ type: 'stats' }] }, { widgets: [{ type: 'quality', days: 7 }] }, { widgets: [{ type: 'rulings', days: 7, limit: 15 }] },
                 { minWidth: 380, widgets: [{ type: 'dispatcher' }, { type: 'activity' }] }, { widgets: [{ type: 'platforms' }] }] },
        portal: { id: 'portal', type: 'portal', label: 'Portal', icon: 'layout-grid' },
      };
      for (const [id, [label, icon]] of Object.entries(app)) pages[id] = { id, type: id, label, icon };
      this.layout = { brand: { title: 'Cowork', icon: 'zap', footer: 'Cowork Server' }, defaultPage: 'overview', pages,
        sections: [{ label: 'Operations', pages: ['overview', 'portal', 'tasks', 'recipes', 'calendar', 'goals'] },
                   { label: 'AI Fleet', pages: ['routing', 'agents', 'personas'] },
                   { label: 'System', pages: ['workers', 'config'] }],
        errors: [], fallback: e.message };
      console.warn('layout.json unavailable, using built-in default:', e.message);
    }
    // The Chat page was retired 2026-10-30; a server that predates that still lists it.
    delete this.layout.pages?.chat;
    for (const s of this.layout.sections || []) s.pages = (s.pages || []).filter(id => id !== 'chat');
    this.layout.sections = (this.layout.sections || []).filter(s => s.pages.length);
    this.renderNav();
  }

  renderNav() {
    const { brand, sections, pages } = this.layout;
    document.title = brand.title;
    const logo = document.querySelector('.logo-area');
    if (logo) logo.innerHTML = `<i data-lucide="${esc(brand.icon)}"></i><h1 class="logo-text">${esc(brand.title)}</h1>`;
    const footer = document.querySelector('.sidebar-footer');
    if (footer) footer.textContent = brand.footer;
    const nav = document.querySelector('.nav-menu');
    if (nav) nav.innerHTML = sections.map((sec) => `
      <div class="nav-section" role="group"${sec.label ? ` aria-label="${esc(sec.label)}"` : ''}>
        ${sec.label ? `<span class="nav-section-label" aria-hidden="true">${esc(sec.label)}</span>` : ''}
        ${sec.pages.map((id) => {
          const p = pages[id];
          return `<a href="#${esc(id)}" class="nav-item" data-view="${esc(id)}" data-label="${esc(p.label)}">
            <i data-lucide="${esc(p.icon)}"></i><span class="nav-text">${esc(p.label)}</span></a>`;
        }).join('')}
      </div>`).join('');
    createIcons();
  }

  // layout.json problems, shown on dashboard/portal pages (never fatal).
  layoutErrorBox() {
    const errs = this.layout?.errors || [];
    return errs.length ? `
      <div class="card portal-errors">
        <strong><i data-lucide="triangle-alert"></i> ${esc(this.layout.path ? this.layout.path.split('/').pop() : 'layout.json')} has ${errs.length} problem${errs.length > 1 ? 's' : ''}</strong>
        <ul>${errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
      </div>` : '';
  }

  setupSSE() {
    this.sse = new window.SSEClient('/api/events', {
      onStatusChange: (status) => this.updateConnectionStatus(status),
      onMessage: (data) => this.handleSSEEvent(data)
    });
    this.sse.connect();
  }

  updateConnectionStatus(status) {
    const el = document.getElementById('connection-status');
    if (!el) return;
    const labels = { connected: 'Live', connecting: 'Connecting...', disconnected: 'Disconnected' };
    el.innerHTML = `<div class="dot ${status}"></div><span>${labels[status] || status}</span>`;
  }

  handleSSEEvent(data) {
    // Any inbound SSE frame means the stream is live — flip the badge to "Live"
    // immediately (more reliable than relying solely on EventSource.onopen).
    this.updateConnectionStatus('connected');
    if (!data.type || data.type === 'ping' || data.type === 'connected') return;
    // goalUpdated is a refresh hint for the Goals page, not activity to show anyone.
    if (data.type === 'goalUpdated') {
      if (this.currentPage?.type === 'goals') this._goalsSchedule();
      return;
    }
    this.activity.unshift(data);
    this.activity = this.activity.slice(0, 30);
    if (data.type !== 'heartbeat') {
      // Only toast events the operator actually acts on; claim/handover chatter
      // still lands in the Live Activity feed without stealing attention.
      if (['taskCreated', 'taskCompleted', 'reportFiled', 'workerRegistered'].includes(data.type)) {
        this.toast(data.type, this.describeEvent(data));
      }
      // A full re-render replaces the view's DOM, which would wipe whatever the
      // user is mid-way through typing (search box, form field) along with the caret.
      // Debounce so a burst of events causes one refresh, and re-check the
      // typing guard when the timer fires (not when the event arrived).
      // On the Tasks view only the named task's card is redrawn (patchInboxTasks);
      // events that name no task (agent joined, …) don't touch the task list.
      const taskId = data.payload?.task?.id || data.payload?.taskId;
      if (taskId) (this._inboxDirty ||= new Set()).add(taskId);
      clearTimeout(this._rerenderTimer);
      // The Goals page patches rows itself. It never rebuilds, so a form or dialog survives.
      if (this.currentPage?.type === 'goals') { this._goalsSchedule(); return; }
      this._rerenderTimer = setTimeout(() => {
        if (this.currentPage?.type === 'tasks' && this.contentEl.querySelector('#inbox-sticky')) {
          const ids = [...(this._inboxDirty || [])];
          this._inboxDirty = new Set();
          if (ids.length) this.patchInboxTasks(ids).catch(() => this.renderInbox());
          return;
        }
        this._inboxDirty = new Set();
        const el = document.activeElement;
        const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
        if (!typing) this.renderCurrentView();
      }, 800);
    }
  }

  /** Debounced: one summary fetch per burst of events. */
  _goalsSchedule() {
    clearTimeout(this._goalsTimer);
    this._goalsTimer = setTimeout(() => this._goalsRefresh?.().catch(() => {}), 800);
  }

  // Map an agent UUID to its human-readable name (falls back to a short id).
  workerLabel(id) {
    if (!id) return '';
    const a = this.workers.get(id);
    return a ? a.name : id.slice(0, 8);
  }

  // Refresh the UUID→name map from the full active-worker list (includes the
  // internal dispatcher/orchestrator, unlike /connections). Call before
  // rendering views that show agent ids: dashboard, inbox, connections.
  async refreshWorkers() {
    try {
      const workers = await this.api.get('/workers');
      (Array.isArray(workers) ? workers : []).forEach(a => this.workers.set(a.id, { name: a.workerName, platform: a.platform }));
    } catch { /* keep whatever we have */ }
  }

  describeEvent(e) {
    const p = e.payload || {};
    switch (e.type) {
      case 'workerRegistered':
        if (p.worker?.id) this.workers.set(p.worker.id, { name: p.worker.workerName, platform: p.worker.platform });
        return `${p.worker?.workerName} (${p.worker?.platform}) joined`;
      case 'taskCreated': return p.task?.title;
      case 'taskClaimed': return `claimed by ${this.workerLabel(p.task?.claimedBy || p.workerId)}: ${p.task?.title}`;
      case 'taskCompleted': return `done: ${p.task?.title}`;
      case 'reportFiled': return p.report?.title;
      case 'heartbeat': return `${this.workerLabel(p.workerId)} → ${p.status}`;
      default: return p.task?.title || p.worker?.workerName || humanizeKey(e.type);
    }
  }

  toast(title, message) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="toast-title">${esc(title)}</div><div class="toast-message">${esc(message || '')}</div>`;
    this.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  /**
   * Copy text to the clipboard, returning true on success. The async Clipboard
   * API (navigator.clipboard) only exists in secure contexts — HTTPS or
   * http://localhost — so on a plain-HTTP LAN dashboard it is undefined and
   * throws. Fall back to a hidden-textarea + execCommand('copy'), which works
   * over plain HTTP as long as the call is inside a user gesture (it is — this
   * runs from a click handler).
   */
  async copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch { /* fall through to legacy path */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      // Keep it off-screen but still focusable/selectable.
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);   // iOS needs an explicit range
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  /**
   * Toggle a task card's RESULT / ARTIFACTS / INPUTS / INTERACTION block in
   * place (flip the `hidden` attribute + caret + aria-expanded) without a full
   * re-render. Open state is kept in this.taskFilesOpen so SSE / poll
   * re-renders restore the user's per-card choice instead of collapsing
   * everything. The block also holds the task ID / folder row and acceptance
   * criteria, so every card has one.
   */
  toggleTaskFiles(taskId) {
    const wrap = document.querySelector(`[data-task-files="${CSS.escape(taskId)}"]`);
    if (!wrap) return;
    this.taskFilesOpen = this.taskFilesOpen || new Set();
    const open = this.taskFilesOpen.has(taskId);
    if (open) this.taskFilesOpen.delete(taskId); else this.taskFilesOpen.add(taskId);
    wrap.hidden = open;
    const caret = wrap.querySelector('.task-files-caret');
    if (caret) caret.textContent = open ? '▸' : '▾';
    const head = wrap.querySelector('.task-files-head');
    if (head) head.setAttribute('aria-expanded', open ? 'false' : 'true');
    // Opening a running card: jump its live log to the newest line (scrollTop
    // updates made while the block was hidden did nothing).
    const pre = !open && wrap.querySelector('[data-progress]');
    if (pre) pre.scrollTop = pre.scrollHeight;
  }

  /**
   * Open a task's markdown artifact in a popup viewer (rendered, with a Raw
   * toggle and a Download fallback) instead of downloading it. Reuses the shared
   * #modal-container. fetch() ignores the download route's Content-Disposition,
   * so we get the raw text back; agent output is untrusted → md() sanitizes it
   * (DOMPurify). With { plain: true } (used for .txt / .log via the text-artifact
   * handler) it shows the file as raw text and hides the meaningless Raw toggle;
   * every other case still renders markdown. Non-text artifacts never reach here —
   * they stay download links (see artifactChip). `kind` picks the ARTIFACTS vs
   * INPUTS API route.
   */
  async openMarkdownModal(taskId, file, kind = 'artifacts', opts = {}) {
    const plain = !!opts.plain;
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) return;
    const encodedPath = file.split('/').map(encodeURIComponent).join('/');
    const downloadName = file.split('/').pop() || file;
    const url = `/api/${kind}/${encodeURIComponent(taskId)}/${encodedPath}`;
    const barBtn = 'font-size:0.75rem;padding:3px 8px;display:inline-flex;align-items:center;gap:4px';
    content.classList.add('modal-md');
    content.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 12px">
        <h3 style="margin:0;font-size:1.02rem;display:flex;align-items:center;gap:6px;min-width:0">
          <i data-lucide="${plain ? 'file-text' : 'book-open'}" style="width:16px;height:16px;flex:0 0 auto"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(file)}</span>
        </h3>
        <div style="display:flex;gap:6px;flex:0 0 auto">
          ${plain ? '' : `<button class="btn mdm-toggle" title="Toggle raw / rendered" style="${barBtn}" disabled>Raw</button>`}
          <a class="btn" href="${url}" download="${esc(downloadName)}" title="Download this file" style="${barBtn}"><i data-lucide="download" style="width:13px;height:13px"></i></a>
          <button class="btn mdm-close" title="Close" style="${barBtn}"><i data-lucide="x" style="width:14px;height:14px"></i></button>
        </div>
      </div>
      <div class="md-body mdm-body" style="font-size:0.95rem;line-height:1.55;color:var(--text-muted)">Loading…</div>
      <pre class="mdm-raw" hidden style="white-space:pre-wrap;font-size:0.85rem;background:var(--bg-tertiary);padding:10px;border-radius:8px;margin:4px 0"></pre>`;
    container.classList.remove('hidden');
    createIcons();

    const close = () => {
      container.classList.add('hidden');
      content.classList.remove('modal-md');
      content.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    content.querySelector('.mdm-close').onclick = close;
    container.querySelector('.modal-backdrop').onclick = close;

    let raw = '';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.text();
    } catch (err) {
      const body = content.querySelector('.mdm-body');
      if (body) body.innerHTML = `<p style="color:#EF4444">Could not load <strong>${esc(file)}</strong>: ${esc(err.message)}. <a href="${url}" download>Download instead</a>.</p>`;
      return;
    }

    const body = content.querySelector('.mdm-body');
    if (!body) return;   // modal was closed while loading
    body.style.color = 'var(--text-primary)';
    if (plain) {
      // Plain text: show verbatim in a <pre>, no markdown parse and no Raw toggle
      // (rendered === raw). esc() keeps agent output from injecting markup.
      body.innerHTML = `<pre style="white-space:pre-wrap;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85rem;line-height:1.5">${esc(raw)}</pre>`;
      createIcons();
      return;
    }
    const rawEl = content.querySelector('.mdm-raw');
    const toggle = content.querySelector('.mdm-toggle');
    if (!rawEl || !toggle) return;   // modal was closed while loading
    body.innerHTML = md(raw);
    rawEl.textContent = raw;
    toggle.disabled = false;
    toggle.onclick = () => {
      const showRaw = body.style.display !== 'none';
      body.style.display = showRaw ? 'none' : '';
      rawEl.hidden = !showRaw;
      toggle.textContent = showRaw ? 'Rendered' : 'Raw';
    };
    createIcons();
  }

  /**
   * Open a task's image / video / audio file (from ARTIFACTS or INPUTS) in a
   * popup viewer with a Download fallback, instead of downloading it. Reuses the
   * shared #modal-container. The <img>/<video>/<audio> element loads the file
   * straight from the download route — the browser renders it inline regardless
   * of the route's Content-Disposition, so no server change is needed. `type` is
   * one of 'image' | 'video' | 'audio'; `kind` picks the ARTIFACTS vs INPUTS
   * route. Non-media files never reach here — they stay download links (see
   * artifactChip).
   */
  openMediaModal(taskId, file, type, kind = 'artifacts') {
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) return;
    const encodedPath = file.split('/').map(encodeURIComponent).join('/');
    const downloadName = file.split('/').pop() || file;
    const url = `/api/${kind}/${encodeURIComponent(taskId)}/${encodedPath}`;
    const barBtn = 'font-size:0.75rem;padding:3px 8px;display:inline-flex;align-items:center;gap:4px';
    const icon = (MEDIA_KIND.find(k => k.type === type) || {}).icon || 'file';
    // The media element itself. src is the (path-guarded) file route; a load
    // error swaps in a message + download link rather than a broken icon.
    let mediaEl;
    if (type === 'video') {
      mediaEl = `<video class="mdm-media" src="${url}" controls playsinline style="max-width:100%;max-height:72vh;display:block;margin:0 auto;border-radius:8px;background:#000"></video>`;
    } else if (type === 'audio') {
      mediaEl = `<audio class="mdm-media" src="${url}" controls style="width:100%;display:block;margin:12px 0"></audio>`;
    } else {
      mediaEl = `<img class="mdm-media" src="${url}" alt="${esc(file)}" style="max-width:100%;max-height:72vh;display:block;margin:0 auto;border-radius:8px;background:var(--bg-tertiary)">`;
    }
    content.classList.add('modal-md');
    content.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 12px">
        <h3 style="margin:0;font-size:1.02rem;display:flex;align-items:center;gap:6px;min-width:0">
          <i data-lucide="${icon}" style="width:16px;height:16px;flex:0 0 auto"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(file)}</span>
        </h3>
        <div style="display:flex;gap:6px;flex:0 0 auto">
          <a class="btn" href="${url}" download="${esc(downloadName)}" title="Download this file" style="${barBtn}"><i data-lucide="download" style="width:13px;height:13px"></i></a>
          <button class="btn mdm-close" title="Close" style="${barBtn}"><i data-lucide="x" style="width:14px;height:14px"></i></button>
        </div>
      </div>
      <div class="mdm-media-wrap" style="text-align:center">${mediaEl}</div>`;
    container.classList.remove('hidden');
    createIcons();

    const close = () => {
      container.classList.add('hidden');
      content.classList.remove('modal-md');
      content.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    content.querySelector('.mdm-close').onclick = close;
    container.querySelector('.modal-backdrop').onclick = close;

    const el = content.querySelector('.mdm-media');
    if (el) el.addEventListener('error', () => {
      const wrap = content.querySelector('.mdm-media-wrap');
      if (wrap) wrap.innerHTML = `<p style="color:#EF4444">Could not preview <strong>${esc(file)}</strong>. <a href="${url}" download>Download instead</a>.</p>`;
    });
  }

  /**
   * Confirm a continue/re-run AND let the user choose which agent claims the
   * task. Renders the shared #modal-container with an agent <select> (populated
   * from /api/agents, "Auto" = route via the role's agent chain). Resolves to
   * { agent, prompt, files } — agent '' meaning Auto — or null if the user
   * cancels. `defaultAgent` pre-selects the agent the task would otherwise use.
   *
   * With `withInputs: true` the dialog also offers an extra-prompt textarea and
   * a file-attach control (mirrors the New task composer): `prompt` is the typed
   * steer and `files` the staged File[] the caller uploads on confirm. Callers
   * that omit `withInputs` (e.g. re-run) get the same `{ agent }` as before —
   * `prompt` is '' and `files` is empty, so reading only `.agent` is safe.
   */
  async pickAgent({ title, body, defaultAgent = '', confirmLabel = 'Confirm', confirmColor = '#22C55E', withInputs = false, withSchedule = true }) {
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) {   // no modal markup → degrade to a plain confirm
      return window.confirm(`${title}\n\n${body.replace(/<[^>]+>/g, '')}`) ? { agent: defaultAgent, prompt: '', files: [], scheduledAt: '' } : null;
    }
    let agents = {}, usage = {};
    await Promise.all([
      this.api.get('/agents').then(r => { agents = r || {}; }).catch(() => { /* registry unreachable → Auto only */ }),
      this.api.get('/connections').then(r => { usage = r?.usage || {}; }).catch(() => { /* meters unavailable → no cooldown labels */ })
    ]);
    const ids = selectableAgentIds(agents);
    const opts = [`<option value="">🤖 Auto — route via the role's agent chain</option>`]
      .concat(ids.map(b => {
        const until = agentCooldownUntil(usage[b], agents[b]?.model || b);
        const note = until ? ` — ⏳ rate-limited until ${until.toLocaleString()}` : '';
        return `<option value="${esc(b)}"${b === defaultAgent ? ' selected' : ''}>${esc(b + note)}</option>`;
      })).join('');
    const fieldStyle = 'width:100%; padding:9px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:8px; color:inherit; font:inherit; font-size:0.9rem';
    const labelStyle = 'display:block; font-size:0.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); margin-bottom:6px';
    // Optional extra-steer block — appended to the follow-up's brief and inputs.
    const thinkingBlock = `
      <label style="${labelStyle}" for="agent-thinking">Thinking</label>
      <select id="agent-thinking" style="${fieldStyle}; margin-bottom:12px">${thinkingOptions()}</select>`;
    const inputsBlock = withInputs ? `
      <label style="${labelStyle}">Additional prompt <span style="text-transform:none; letter-spacing:0">(optional — extra instructions for this continuation)</span></label>
      <textarea id="agent-prompt" rows="4" style="${fieldStyle}; margin-bottom:16px; resize:vertical" placeholder="e.g. Now add unit tests and a migration guide."></textarea>
      <label style="${labelStyle}">Extra input files <span style="text-transform:none; letter-spacing:0">(optional — attached alongside the prior run's outputs)</span></label>
      <div id="agent-attachments" style="display:none; flex-wrap:wrap; gap:6px; margin-bottom:8px"></div>
      <input type="file" id="agent-files" multiple style="display:none">
      <button class="btn" id="agent-attach" type="button" style="font-size:0.8rem; margin:0 0 20px; display:inline-flex; align-items:center; gap:6px"><i data-lucide="paperclip" style="width:14px;height:14px"></i> Attach files</button>` : '';
    const scheduleBlock = withSchedule ? `
      <label style="${labelStyle}">Run scheduled <span style="text-transform:none; letter-spacing:0">(optional — leave blank to run now)</span></label>
      <input id="agent-when" type="datetime-local" style="${fieldStyle}; margin-bottom:12px">
      <label style="${labelStyle}">Loop interval <span style="text-transform:none; letter-spacing:0">(optional — hours to wait before recurring)</span></label>
      <input id="agent-loop" type="number" min="1" step="any" style="${fieldStyle}; margin-bottom:16px" placeholder="e.g. 1 for every hour">` : '';
    content.innerHTML = `
      <h3 style="margin:0 0 8px; font-size:1.05rem">${esc(title)}</h3>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin:0 0 16px; line-height:1.5">${body}</p>
      <label style="${labelStyle}">Agent to claim this task</label>
      <select id="agent-pick" style="${fieldStyle}; margin-bottom:${withInputs || withSchedule ? '16px' : '20px'}">${opts}</select>
      ${thinkingBlock}
      ${inputsBlock}
      ${scheduleBlock}
      <div style="display:flex; gap:8px; justify-content:flex-end">
        <button class="btn" id="agent-cancel" style="font-size:0.85rem">Cancel</button>
        <button class="btn" id="agent-ok" style="font-size:0.85rem; color:${confirmColor}; border-color:${confirmColor}66">${esc(confirmLabel)}</button>
      </div>`;
    container.classList.remove('hidden');
    if (withInputs) createIcons();
    content.querySelector('#agent-pick').focus();

    // Files stage client-side and upload only on confirm (mirrors createTaskModal),
    // so a cancelled dialog leaves no orphaned uploads.
    const staged = [];
    if (withInputs) {
      const attBox = content.querySelector('#agent-attachments');
      const fileEl = content.querySelector('#agent-files');
      const renderStaged = () => {
        if (!staged.length) { attBox.style.display = 'none'; attBox.innerHTML = ''; return; }
        attBox.style.display = 'flex';
        attBox.innerHTML = staged.map((f, i) => `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;border:1px solid var(--bg-tertiary);background:var(--bg-secondary);font-size:0.74rem">
            <i data-lucide="file" style="width:12px;height:12px"></i>
            <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
            <span style="color:var(--text-muted)">${fmtBytes(f.size)}</span>
            <span data-bp-rm="${i}" title="Remove" style="cursor:pointer;opacity:.6;font-weight:600">×</span>
          </span>`).join('');
        attBox.querySelectorAll('[data-bp-rm]').forEach(el => el.addEventListener('click', () => {
          staged.splice(Number(el.dataset.bpRm), 1);
          renderStaged();
        }));
        createIcons();
      };
      content.querySelector('#agent-attach').onclick = () => fileEl.click();
      fileEl.onchange = () => { staged.push(...Array.from(fileEl.files || [])); fileEl.value = ''; renderStaged(); };
    }

    return new Promise(resolve => {
      const close = (val) => {
        container.classList.add('hidden');
        content.innerHTML = '';
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (ev) => { if (ev.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      content.querySelector('#agent-ok').onclick = () => {
        let when = '';
        let loopHours = undefined;
        if (withSchedule) {
          const val = content.querySelector('#agent-when').value;
          if (val) when = new Date(val).toISOString();
          const loopVal = content.querySelector('#agent-loop').value;
          if (loopVal) loopHours = parseFloat(loopVal);
        }
        close({
          agent: content.querySelector('#agent-pick').value,
          thinking: content.querySelector('#agent-thinking').value,
          prompt: withInputs ? content.querySelector('#agent-prompt').value.trim() : '',
          files: staged.slice(),
          scheduledAt: when,
          loopIntervalHours: loopHours
        });
      };
      content.querySelector('#agent-cancel').onclick = () => close(null);
      container.querySelector('.modal-backdrop').onclick = () => close(null);
    });
  }

  /**
   * "＋ New task" modal — create and dispatch a task from the Inbox without the
   * Chat detour. Same POST /inbox contract as Chat: an agent pick from the
   * roster stamps context.agent (the dispatcher runs that persona on its
   * division's agent chain), attached files upload to task inputs the agent
   * reads, and agent pinning mirrors pickAgent ('' = auto-route via the chain).
   */
  // prefill.scheduledAt (ISO) pre-fills Run at — the Calendar opens this on an empty slot.
  async createTaskModal(prefill = {}) {
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) return;
    let agents = {};
    let divisions = {};
    let usage = {};
    let pstack = { playbooks: ['investigation', 'bug-fix', 'feature', 'research-report', 'content', 'ops-change',
      'technical-writing', 'perf-issue', 'refactoring', 'prototype', 'runtime-forensics', 'eval', 'opening-a-pr', 'babysit'], skills: [] };
    // Feeds are optional — missing registry/roster degrades to Auto.
    await Promise.all([
      this.api.get('/agents').then(r => { agents = r || {}; }).catch(() => {}),
      this.api.get('/roster-divisions').then(r => { divisions = r || {}; }).catch(() => {}),
      this.api.get('/connections').then(r => { usage = r?.usage || {}; }).catch(() => {}),
      this.api.get('/pstack').then(r => { pstack = r || pstack; }).catch(() => {})
    ]);
    // G9: Method (context.playbook) + pstack skill (context.skill) pickers.
    const methodOpts = [`<option value="">none</option>`]
      .concat((pstack.playbooks || []).map(k => `<option value="${esc(k)}">${esc(k)}</option>`)).join('');
    // A plain <select> like Method/Review (was a free-text datalist input that
    // rendered differently from every other picker in this dialog).
    const skillOpts = [`<option value="">${(pstack.skills || []).length ? 'none' : 'none (no skills under vendor/pstack/skills)'}</option>`]
      .concat((pstack.skills || []).map(k => `<option value="${esc(k)}">${esc(k)}</option>`)).join('');
    const opts = [`<option value="">🤖 Auto — route via the role's agent chain</option>`]
      .concat(selectableAgentIds(agents).map(b => {
        const until = agentCooldownUntil(usage[b], agents[b]?.model || b);
        const note = until ? ` — ⏳ rate-limited until ${until.toLocaleString()}` : '';
        return `<option value="${esc(b)}">${esc(b + note)}</option>`;
      })).join('');
    const divOpts = [`<option value="">🎭 Auto — let the router pick the persona</option>`]
      .concat(Object.entries(divisions).sort().map(([d, i]) => `<option value="${esc(d)}">${esc(i.label || d)} (${i.personas.length})</option>`)).join('');
    const fieldStyle = 'width:100%; padding:9px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:8px; color:inherit; font:inherit; font-size:0.9rem';
    const labelStyle = 'display:block; font-size:0.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); margin:0 0 6px';
    content.innerHTML = `
      <h3 style="margin:0 0 8px; font-size:1.05rem">New task</h3>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin:0 0 16px; line-height:1.5">The task is queued as pending and dispatched by the next tick — or parked as <em>scheduled</em> until its run time if you set one.</p>
      <label style="${labelStyle}" for="nt-title">Title <span style="color:#EF4444">*</span></label>
      <input id="nt-title" style="${fieldStyle}; margin-bottom:12px" placeholder="Short imperative title…" autocomplete="off">
      <label style="${labelStyle}" for="nt-desc">Brief (markdown) <span style="color:#EF4444">*</span></label>
      <textarea id="nt-desc" rows="6" style="${fieldStyle}; margin-bottom:12px; resize:vertical" placeholder="What should the agent do? Include acceptance criteria."></textarea>
      <label style="${labelStyle}">Persona <span style="text-transform:none; letter-spacing:0">(optional — pick a division, then the persona that studies the files & does the work)</span></label>
      <div class="modal-row" style="margin-bottom:12px">
        <div><select id="nt-div" style="${fieldStyle}">${divOpts}</select></div>
        <div><select id="nt-persona" style="${fieldStyle}" disabled><option value="">— none —</option></select></div>
      </div>
      <div class="modal-row" style="margin-bottom:12px">
        <div>
          <label style="${labelStyle}" for="nt-priority">Priority</label>
          <select id="nt-priority" style="${fieldStyle}">
            <option value="normal" selected>normal</option><option value="low">low</option>
            <option value="high">high</option><option value="urgent">urgent</option>
          </select>
        </div>
        <div>
          <label style="${labelStyle}" for="nt-when">Run at <span style="text-transform:none; letter-spacing:0">(empty = now)</span></label>
          <input id="nt-when" type="datetime-local" style="${fieldStyle}">
        </div>
      </div>
      ${recurrenceEditorHTML('nt-rec', fieldStyle, labelStyle, null)}
      <div class="modal-row" style="margin-bottom:12px">
        <div>
          <label style="${labelStyle}" for="nt-method">Method <span style="text-transform:none; letter-spacing:0">(pstack playbook)</span></label>
          <select id="nt-method" style="${fieldStyle}">${methodOpts}</select>
        </div>
        <div>
          <label style="${labelStyle}" for="nt-review">Review</label>
          <select id="nt-review" style="${fieldStyle}">
            <option value="" selected>none (default verifier)</option>
            <option value="llm">LLM reviewer</option>
            <option value="panel">panel (multi-family interrogate)</option>
            <option value="arena">arena (3 runners + judge)</option>
          </select>
        </div>
      </div>
      <label style="${labelStyle}" for="nt-skill" title="The executor reads vendor/pstack/skills/&lt;name&gt;/SKILL.md">pstack skill <span style="text-transform:none; letter-spacing:0">(optional)</span></label>
      <select id="nt-skill" style="${fieldStyle}; margin-bottom:12px" title="The executor reads vendor/pstack/skills/&lt;name&gt;/SKILL.md"${(pstack.skills || []).length ? '' : ' disabled'}>${skillOpts}</select>
      <label style="${labelStyle}" for="nt-agent">Agent to claim this task</label>
      <select id="nt-agent" style="${fieldStyle}; margin-bottom:12px">${opts}</select>
      <label style="${labelStyle}" for="nt-thinking">Thinking</label>
      <select id="nt-thinking" style="${fieldStyle}; margin-bottom:12px">${thinkingOptions()}</select>
      <label style="${labelStyle}">Input files <span style="text-transform:none; letter-spacing:0">(optional — attached for the persona/agent to study)</span></label>
      <div id="nt-attachments" style="display:none; flex-wrap:wrap; gap:6px; margin-bottom:8px"></div>
      <input type="file" id="nt-files" multiple style="display:none">
      <button class="btn" id="nt-attach" type="button" style="font-size:0.8rem; display:inline-flex; align-items:center; gap:6px"><i data-lucide="paperclip" style="width:14px;height:14px"></i> Attach files</button>
      <div class="modal-actions">
        <div class="modal-error" id="nt-error" role="alert"></div>
        <span class="modal-hint">Ctrl/⌘ + Enter to create</span>
        <button class="btn" id="nt-cancel" type="button" style="font-size:0.85rem">Cancel</button>
        <button class="btn" id="nt-ok" type="button" style="font-size:0.85rem; color:#22C55E; border-color:#22C55E66">＋ Create task</button>
      </div>`;
    container.classList.remove('hidden');
    createIcons();
    recurrenceEditorBind(content, 'nt-rec');
    if (prefill.scheduledAt) content.querySelector('#nt-when').value = isoToLocalInput(prefill.scheduledAt);
    content.querySelector('#nt-title').focus();
    let submitting = false;
    const close = () => {
      container.classList.add('hidden');
      content.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    };
    // A stray backdrop click or Esc while the create request is in flight would
    // hide the modal and leave the user unsure whether the task was made.
    const dismiss = () => { if (!submitting) close(); };
    const onKey = (ev) => {
      if (ev.key === 'Escape') dismiss();
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey);
    content.querySelector('#nt-cancel').onclick = dismiss;
    container.querySelector('.modal-backdrop').onclick = dismiss;

    // Inline error in the pinned action row. The Title/Brief fields sit at the
    // top of a scrolling modal, so a red border alone is usually off-screen and
    // the Create click looks like it did nothing.
    const errEl = content.querySelector('#nt-error');
    const showError = (msg, field) => {
      errEl.textContent = msg;
      if (field) {
        field.style.borderColor = '#EF4444';
        field.scrollIntoView({ block: 'center', behavior: 'smooth' });
        field.focus({ preventScroll: true });
      }
    };
    ['#nt-title', '#nt-desc'].forEach(sel => content.querySelector(sel).addEventListener('input', (ev) => {
      ev.target.style.borderColor = '';
      errEl.textContent = '';
    }));

    // Division → agent: the agent list is scoped to the chosen division, matching
    // the two-stage roster picker in Chat. Empty division = auto-route.
    const divEl = content.querySelector('#nt-div');
    const personaEl = content.querySelector('#nt-persona');
    divEl.onchange = () => {
      const info = divEl.value ? divisions[divEl.value] : null;
      const personaOpts = info ? info.personas.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(a => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join('') : '';
      personaEl.innerHTML = `<option value="">— any persona in this division —</option>${personaOpts}`;
      personaEl.disabled = !info;
    };

    // Files are staged client-side and uploaded on Create (mirrors the Chat
    // composer), so a cancelled modal leaves no orphaned uploads.
    const staged = [];
    const attBox = content.querySelector('#nt-attachments');
    const fileEl = content.querySelector('#nt-files');
    const renderStaged = () => {
      if (!staged.length) { attBox.style.display = 'none'; attBox.innerHTML = ''; return; }
      attBox.style.display = 'flex';
      attBox.innerHTML = staged.map((f, i) => `
        <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;border:1px solid var(--bg-tertiary);background:var(--bg-secondary);font-size:0.74rem">
          <i data-lucide="file" style="width:12px;height:12px"></i>
          <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
          <span style="color:var(--text-muted)">${fmtBytes(f.size)}</span>
          <span data-nt-rm="${i}" title="Remove" style="cursor:pointer;opacity:.6;font-weight:600">×</span>
        </span>`).join('');
      attBox.querySelectorAll('[data-nt-rm]').forEach(el => el.addEventListener('click', () => {
        staged.splice(Number(el.dataset.ntRm), 1);
        renderStaged();
      }));
      createIcons();
    };
    content.querySelector('#nt-attach').onclick = () => fileEl.click();
    fileEl.onchange = () => { staged.push(...Array.from(fileEl.files || [])); fileEl.value = ''; renderStaged(); };

    const submit = async () => {
      if (submitting) return;
      const titleEl = content.querySelector('#nt-title');
      const descEl = content.querySelector('#nt-desc');
      const title = titleEl.value.trim();
      const description = descEl.value.trim();
      if (!title) { showError('Title is required.', titleEl); return; }
      if (!description) { showError('Brief is required — tell the agent what to do.', descEl); return; }
      const agent = content.querySelector('#nt-agent').value;
      const thinking = content.querySelector('#nt-thinking').value;
      const division = divEl.value;
      const persona = personaEl.value;
      // datetime-local gives a LOCAL wall-clock string; toISOString converts it
      // to the UTC instant the server schedules on. Empty = run now (default).
      const when = content.querySelector('#nt-when').value;
      const recurrence = readRecurrence(content, 'nt-rec');
      // Context mirrors Chat: a named agent wins (dispatcher derives its division
      // + persona); otherwise a bare division scopes the router. Agent pins on top.
      const context = {};
      if (agent) context.agent = agent;
      if (thinking) context.thinking = thinking;
      if (persona) context.persona = persona; else if (division) context.division = division;
      // pstack triggers (G9): playbook card, review gate, explicit skill.
      const method = content.querySelector('#nt-method').value;
      const review = content.querySelector('#nt-review').value;
      const skill = content.querySelector('#nt-skill').value;
      if (method) context.playbook = method;
      if (review === 'llm' || review === 'panel') context.review = review;
      else if (review === 'arena') context.arena = { runners: 3 };
      if (skill) context.skill = skill;
      const okBtn = content.querySelector('#nt-ok');
      submitting = true;
      okBtn.disabled = true;
      errEl.textContent = '';
      okBtn.textContent = staged.length ? 'Uploading files…' : 'Creating…';
      try {
        // Upload staged files first so the created task carries them as inputs.
        const inputs = staged.length ? await this.uploadInputFiles(staged) : [];
        okBtn.textContent = 'Creating…';
        const body = {
          title, description,
          from: { platform: 'dashboard', agent: 'operator' },
          priority: content.querySelector('#nt-priority').value,
          context,
          ...(inputs.length ? { inputs } : {}),
          ...(when ? { scheduledAt: new Date(when).toISOString() } : {}),
          ...(recurrence ? { recurrence } : {})
        };
        await this.api.post('/inbox', body);
        submitting = false;
        close();
        const target = persona ? `persona ${persona}` : division ? `${divisions[division]?.label || division} division` : null;
        const routeNote = agent ? `pinned to ${agent}` : target ? `routed to ${target}` : 'auto-routed via the agent chain';
        const fileNote = inputs.length ? ` · ${inputs.length} file(s) attached` : '';
        this.toast('task created', `${when ? `Scheduled for ${new Date(when).toLocaleString()}` : 'Queued'} — ${routeNote}${fileNote}.`);
        if (this.currentView === 'tasks') this.renderInbox();
        if (this.currentView === 'calendar') this.renderCalendar();
      } catch (err) {
        submitting = false;
        okBtn.disabled = false;
        okBtn.textContent = '＋ Create task';
        showError(`Could not create the task: ${err.message}`);
      }
    };
    content.querySelector('#nt-ok').onclick = submit;
  }

  /**
   * "✎ Edit" modal — load an existing task's parameters into the same fields as
   * the New-task composer, let the user change its title, brief, routing, schedule
   * and loop interval, and save via POST /inbox/:id/edit. Only offered for tasks
   * that are not running or pending (see isTaskEditable); the server enforces the
   * same rule. Rescheduling a finished task (setting a future run time) re-arms it
   * to run again.
   */
  async editTaskModal(taskId) {
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) return;
    let task = null;
    try { task = await this.api.get(`/inbox/${encodeURIComponent(taskId)}`); }
    catch (err) { this.toast('error', err.message); return; }
    if (!task) { this.toast('error', 'Task not found'); return; }
    if (!isTaskEditable(task)) { this.toast('cannot edit', `Task is ${task.status} — only tasks that are not running or pending can be edited.`); return; }
    let agents = {}, divisions = {}, usage = {};
    await Promise.all([
      this.api.get('/agents').then(r => { agents = r || {}; }).catch(() => {}),
      this.api.get('/roster-divisions').then(r => { divisions = r || {}; }).catch(() => {}),
      this.api.get('/connections').then(r => { usage = r?.usage || {}; }).catch(() => {})
    ]);
    const ctx = task.context || {};
    const curAgent = ctx.agentAuto ? '' : (ctx.agent || '');
    const curDivision = ctx.division || '';
    const curPersona = ctx.persona || '';
    // A pin to a now-disabled agent resolves to Auto at dispatch (the dispatcher
    // treats a disabled pin as absent), so it's not offered here either.
    const curAgentSelectable = curAgent && !agents[curAgent]?.disabled;
    const agentOpts = [`<option value=""${curAgentSelectable ? '' : ' selected'}>🤖 Auto — route via the role's agent chain</option>`]
      .concat(selectableAgentIds(agents).map(b => {
        const until = agentCooldownUntil(usage[b], agents[b]?.model || b);
        const note = until ? ` — ⏳ rate-limited until ${until.toLocaleString()}` : '';
        return `<option value="${esc(b)}"${b === curAgent ? ' selected' : ''}>${esc(b + note)}</option>`;
      })).join('');
    const divOpts = [`<option value=""${curDivision ? '' : ' selected'}>🎭 Auto — let the router pick the persona</option>`]
      .concat(Object.entries(divisions).sort().map(([d, i]) => `<option value="${esc(d)}"${d === curDivision ? ' selected' : ''}>${esc(i.label || d)} (${i.personas.length})</option>`)).join('');
    const prioOpts = ['normal', 'low', 'high', 'urgent']
      .map(p => `<option value="${p}"${(task.priority || 'normal') === p ? ' selected' : ''}>${p}</option>`).join('');
    const fieldStyle = 'width:100%; padding:9px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:8px; color:inherit; font:inherit; font-size:0.9rem';
    const labelStyle = 'display:block; font-size:0.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); margin:0 0 6px';
    const finished = task.status === 'done' || task.status === 'rejected' || isTaskFailed(task);
    content.innerHTML = `
      <h3 style="margin:0 0 8px; font-size:1.05rem">Edit task <span style="font-size:0.8rem;color:var(--text-muted)">· ${esc(task.status)}</span></h3>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin:0 0 16px; line-height:1.5">${finished
        ? 'This task has finished. Setting a <strong>future</strong> run time below re-arms it to run again with your edits; leaving it blank just saves the changes.'
        : 'Change any parameters and save. A future run time keeps it <em>scheduled</em>; clearing the time releases it to run now.'}</p>
      <label style="${labelStyle}">Title</label>
      <input id="et-title" style="${fieldStyle}; margin-bottom:12px" value="${esc(task.title || '')}">
      <label style="${labelStyle}">Brief / requirements (markdown)</label>
      <textarea id="et-desc" rows="7" style="${fieldStyle}; margin-bottom:12px; resize:vertical">${esc(task.description || '')}</textarea>
      ${(ctx.acceptance && Array.isArray(ctx.acceptance)) ? `
      <label style="${labelStyle}">Acceptance criteria (one per line) ${ctx.acceptanceSource === 'sharpened' ? '<span class="badge" style="background:#0EA5E918; color:#0EA5E9; border:1px solid #0EA5E940; font-size:0.65rem; text-transform:none">sharpened</span>' : ''}</label>
      <textarea id="et-acceptance" rows="4" style="${fieldStyle}; margin-bottom:12px; resize:vertical">${esc(ctx.acceptance.join('\n'))}</textarea>` : ''}
      <label style="${labelStyle}">Persona <span style="text-transform:none; letter-spacing:0">(optional — division, then persona)</span></label>
      <div style="display:flex; gap:8px; margin-bottom:12px">
        <select id="et-div" style="${fieldStyle}; flex:1">${divOpts}</select>
        <select id="et-persona" style="${fieldStyle}; flex:1"><option value="">— none —</option></select>
      </div>
      <label style="${labelStyle}">Priority</label>
      <select id="et-priority" style="${fieldStyle}; margin-bottom:12px">${prioOpts}</select>
      <label style="${labelStyle}">Run at <span style="text-transform:none; letter-spacing:0">(optional — ${finished ? 'set a future time to re-run; ' : ''}leave empty to run now)</span></label>
      <input id="et-when" type="datetime-local" style="${fieldStyle}; margin-bottom:12px" value="${esc(isoToLocalInput(task.scheduledAt))}">
      ${recurrenceEditorHTML('et-rec', fieldStyle, labelStyle, task.recurrence || (task.loopIntervalHours ? { type: 'hours', interval: task.loopIntervalHours } : null))}
      <label style="${labelStyle}">Agent to claim this task</label>
      <select id="et-agent" style="${fieldStyle}; margin-bottom:12px">${agentOpts}</select>
      <label style="${labelStyle}" for="et-thinking">Thinking</label>
      <select id="et-thinking" style="${fieldStyle}; margin-bottom:20px">${thinkingOptions(ctx.thinking || '')}</select>
      <div style="display:flex; gap:8px; justify-content:flex-end">
        <button class="btn" id="et-cancel" style="font-size:0.85rem">Cancel</button>
        <button class="btn" id="et-ok" style="font-size:0.85rem; color:#0EA5E9; border-color:#0EA5E966">💾 Save</button>
      </div>`;
    container.classList.remove('hidden');
    createIcons();
    recurrenceEditorBind(content, 'et-rec');

    const close = () => {
      container.classList.add('hidden');
      content.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    content.querySelector('#et-cancel').onclick = close;
    container.querySelector('.modal-backdrop').onclick = close;

    // Division → agent (scoped list), pre-selecting the task's current agent.
    const divEl = content.querySelector('#et-div');
    const personaEl = content.querySelector('#et-persona');
    const fillPersonas = (selectSlug) => {
      const info = divEl.value ? divisions[divEl.value] : null;
      const personaOpts = info ? info.personas.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(a => `<option value="${esc(a.slug)}"${a.slug === selectSlug ? ' selected' : ''}>${esc(a.name)}</option>`).join('') : '';
      personaEl.innerHTML = `<option value="">— any persona in this division —</option>${personaOpts}`;
      personaEl.disabled = !info;
    };
    fillPersonas(curPersona);
    divEl.onchange = () => fillPersonas('');

    content.querySelector('#et-ok').onclick = async () => {
      const title = content.querySelector('#et-title').value.trim();
      const description = content.querySelector('#et-desc').value.trim();
      if (!title) { content.querySelector('#et-title').style.borderColor = '#EF4444'; return; }
      if (!description) { content.querySelector('#et-desc').style.borderColor = '#EF4444'; return; }
      const agent = content.querySelector('#et-agent').value;
      const thinking = content.querySelector('#et-thinking').value;
      const division = divEl.value;
      const persona = personaEl.value;
      const when = content.querySelector('#et-when').value;
      const recurrence = readRecurrence(content, 'et-rec');
      const accEl = content.querySelector('#et-acceptance');
      const acceptance = accEl ? accEl.value.split('\n').map(s => s.trim()).filter(Boolean) : undefined;
      const okBtn = content.querySelector('#et-ok');
      okBtn.disabled = true;
      // context mirrors createTask: a named agent wins (dispatcher derives its
      // division); otherwise a bare division scopes the router. '' clears a pin.
      const context = { agent, thinking, persona: persona || '', division: persona ? '' : division };
      const body = {
        title, description,
        priority: content.querySelector('#et-priority').value,
        context,
        ...(acceptance !== undefined ? { acceptance } : {}),
        // Always send the schedule keys so a cleared field clears the value.
        scheduledAt: when ? new Date(when).toISOString() : '',
        // null clears the cadence; a spec sets it. Send it every save so switching
        // back to "One-off" actually removes a previous recurrence.
        recurrence: recurrence || null
      };
      try {
        const updated = await this.api.post(`/inbox/${encodeURIComponent(taskId)}/edit`, body);
        close();
        const timing = updated.status === 'scheduled' && updated.scheduledAt
          ? `Scheduled for ${new Date(updated.scheduledAt).toLocaleString()}`
          : `Saved — now ${updated.status}`;
        this.toast('task updated', timing + '.');
        if (this.currentView === 'tasks') this.renderInbox();
        if (this.currentView === 'calendar') this.renderCalendar();
      } catch (err) {
        okBtn.disabled = false;
        this.toast('error', err.message);
      }
    };
  }

  navigate() {
    const pages = this.layout?.pages || {};
    const fallback = this.layout?.defaultPage || 'overview';
    const raw = window.location.hash.replace('#', '') || fallback;
    // A hash may carry a sub-path: `#tasks/<taskId>` deep-links to one task so a
    // task detail panel can open the exact task in a new tab.
    const [view, ...rest] = raw.split('/');
    // Old page ids — "#dashboard" (the Overview) and the app pages renamed so
    // each URL matches its label (#inbox → #tasks, …). Keep old bookmarks and
    // deep links working unless a layout defines a page with that id, and
    // rewrite the address bar to the canonical URL. Unknown ids land on the
    // default page rather than a blank view.
    const legacy = { dashboard: 'overview', inbox: 'tasks', team: 'routing', roster: 'personas', connections: 'workers' };
    if (Object.hasOwn(legacy, view) && !pages[view]) {
      history.replaceState(null, '', '#' + [legacy[view], ...rest].join('/'));
      return this.navigate();
    }
    let id = view;
    if (!pages[id]) id = fallback;
    this.currentView = id;
    this.currentPage = pages[id] || { id, type: 'dashboard', label: id, rows: [] };
    this.pendingTask = (this.currentView === 'tasks' && rest.length)
      ? decodeURIComponent(rest.join('/')) : null;
    if (this.pendingTask) this._focusRetried = false;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === this.currentView);
    });
    this.viewTitleEl.textContent = this.currentPage.label;
    this.renderCurrentView();
  }

  // Per-view polling timers. Cleared and re-established on every render so a
  // view's pollers stop the moment you navigate away (and SSE-driven re-renders
  // don't stack duplicate intervals).
  clearViewTimers() {
    (this._viewTimers || []).forEach((id) => clearInterval(id));
    this._viewTimers = [];
    // The inbox's live progress-log poller lives outside _viewTimers (it is
    // (re)created inside renderInbox, which runs on filter clicks too) — stop it
    // when navigating away so it doesn't keep polling a hidden view.
    clearInterval(this._progressPoll);
    this._progressPoll = null;
  }
  addViewTimer(fn, ms) {
    const id = setInterval(fn, ms);
    (this._viewTimers ||= []).push(id);
    return id;
  }

  async renderCurrentView() {
    this.clearViewTimers();
    if (!this.currentPage) return;  // SSE can fire before the layout has loaded
    try {
      // App pages keep id === type; dashboard/portal pages can have any id.
      switch (this.currentPage?.type) {
        case 'dashboard': await this.renderDashboard(this.currentPage); break;
        case 'portal': await this.renderPortal(this.currentPage); break;
        case 'workers': await this.renderConnections(); break;
        case 'tasks': await this.renderInbox(); break;
        case 'recipes': await this.renderRecipes(); break;
        case 'calendar': await this.renderCalendar(); break;
        case 'goals': await this.renderGoals(); break;
        case 'routing': await this.renderTeam(); break;
        case 'agents': await this.renderAgents(); break;
        case 'personas': await this.renderRoster(); break;
        case 'config': await this.renderConfig(); break;
        default: await this.renderDashboard(this.currentPage); break;
      }
      // A successful data fetch proves the server is reachable — mark the badge
      // Live even if the SSE stream is slow/blocked for any reason.
      this.updateConnectionStatus('connected');
    } catch (error) {
      this.contentEl.innerHTML = `<div class="empty-state"><p>Error loading view: ${esc(error.message)}</p>
        <button class="btn" id="view-retry" style="margin-top:10px">↻ Retry</button></div>`;
      this.contentEl.querySelector('#view-retry')?.addEventListener('click', () => this.renderCurrentView());
    }
    createIcons();
  }

  // ── Overview ───────────────────────────────────────────────────────────

  /**
   * A `dashboard` page from layout.json: rows of widgets. Each widget type
   * declares the data it needs, so a page only fetches (and polls) what it
   * shows — a page without a sysbar never polls /api/system.
   */
  async renderDashboard(page) {
    const widgets = (page.rows || []).flatMap(r => r.widgets);
    const has = (t) => widgets.some(w => w.type === t);
    const qw = widgets.find(w => w.type === 'quality');
    const rw = widgets.find(w => w.type === 'rulings');
    const [status, dispatcher, portal, , quality, rulings] = await Promise.all([
      (has('stats') || has('platforms')) ? this.api.get('/status') : null,
      has('dispatcher') ? this.api.get('/dispatcher').catch(() => null) : null,
      has('services') ? this.api.get('/portal').catch(() => null) : null,
      has('activity') ? this.refreshWorkers() : null,
      qw ? this.api.get(`/metrics/quality?days=${qw.days || 7}`).catch(() => null) : null,
      rw ? this.api.get(`/rulings?days=${rw.days || 7}`).catch(() => null) : null,
    ]);
    const ctx = { status, dispatcher, portal, quality, rulings };

    const rows = (page.rows || []).map((row) => {
      const cells = row.widgets.map((w) => {
        const span = w.span > 1 ? ` style="grid-column: span ${w.span}"` : '';
        return `<div class="layout-cell"${span}>${this.renderWidget(w, ctx)}</div>`;
      }).join('');
      const min = row.minWidth || (row.widgets.length > 1 ? 380 : 0);
      const cols = min ? `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` : '1fr';
      return `<div class="layout-row" style="grid-template-columns:${cols}">${cells}</div>`;
    }).join('');

    this.contentEl.innerHTML = `${this.layoutErrorBox()}${rows || `<div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="${esc(page.icon || 'layout-dashboard')}"></i></div>
        <h3>Empty page</h3>
        <p>Add widget rows to <code>pages.${esc(page.id)}.rows</code> in <code>${esc(this.layout?.path || 'layout.json')}</code>.</p>
      </div>`}`;

    this.contentEl.querySelectorAll('[data-sys-detail]').forEach((el) => {
      el.addEventListener('click', () => this.openSysDetail(el.dataset.sysDetail, el));
    });
    // Pollers live in _viewTimers, so clearViewTimers() stops them on nav.
    if (has('sysbar')) this.startSystemPolling();
    if (has('services')) {
      this.wireServiceControls(this.contentEl);
      if (this.svcStatus) this.applyServiceStatus(this.svcStatus);
      this.startServicePolling();
    }
  }

  // One widget's HTML. Options were validated server-side (layout-config.ts);
  // every string that reaches the DOM still goes through esc()/md().
  renderWidget(w, { status, dispatcher, portal, quality, rulings }) {
    const head = (icon, title, extra = '') => `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:var(--space-md)">
        <i data-lucide="${icon}" style="width:18px;height:18px;color:var(--text-muted)"></i>
        <h3 style="font-size:0.95rem">${esc(title)}</h3>${extra}
      </div>`;
    const dot = (ok) => `<span class="dot ${ok ? 'connected' : 'disconnected'}" style="display:inline-block; margin-left:6px"></span>`;

    switch (w.type) {
      case 'sysbar': return this.renderSysbar(w);

      case 'stats': {
        const s = status || { inboxSummary: {} };
        const sum = s.inboxSummary || {};
        const dur = (sec) => {
          const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
          return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
        };
        const defs = {
          workers: ['bot', s.activeWorkers, 'Active Workers'],
          openTasks: ['inbox', (sum.pending || 0) + (sum.inProgress || 0),
            `Open Tasks (${(sum.completed || 0) - (sum.failed || 0)} done${sum.failed ? `, ${sum.failed} failed` : ''}${sum.scheduled ? `, ${sum.scheduled} scheduled` : ''}${sum.waitingInput ? `, ${sum.waitingInput} wait input` : ''})`],
          personas: ['users', s.rosterCount, 'Personas'],
          failedTasks: ['circle-x', sum.failed || 0, 'Failed Tasks'],
          waitingInput: ['message-circle-question', sum.waitingInput || 0, 'Waiting for Input'],
          scheduled: ['calendar-clock', sum.scheduled || 0, 'Scheduled Tasks'],
          uptime: ['timer', s.uptime != null ? dur(s.uptime) : '—', 'Server Uptime'],
        };
        const items = w.items?.length ? w.items : ['workers', 'openTasks', 'personas'];
        return `${w.title ? `<h4 class="section-title">${esc(w.title)}</h4>` : ''}<div class="grid-4">${items.map((k) => {
          const [icon, value, label] = defs[k];
          return `<div class="card stat-card">
            <div class="stat-icon"><i data-lucide="${icon}"></i></div>
            <div><div class="stat-value">${esc(value ?? '—')}</div><div class="stat-label">${esc(label)}</div></div>
          </div>`;
        }).join('')}</div>`;
      }

      // Improvement-plan §5 quality metrics (GET /api/metrics/quality).
      case 'quality': {
        const q = quality;
        const p = (v) => v == null ? '—' : `${v}%`;
        const cards = q ? [
          ['shield-x', q.rejections.total, `Rejections (${q.rejections.byClass.rateLimit} rate-limit · ${q.rejections.byClass.timeout} timeout · ${q.rejections.byClass.quality} quality)`],
          ['repeat', p(q.repeatRateLimit.share), `Repeat rate-limit hits (${q.repeatRateLimit.repeats}/${q.repeatRateLimit.hits})`],
          ['message-circle-question', q.waitInput.total, `Wait-input (${q.waitInput.permissionChoice} permission · ${q.waitInput.humanOnly} human-only)`],
          ['badge-check', p(q.done.evidencePct), `Done with EVIDENCE (${q.done.count} done · ${q.done.doneWithConcerns} with concerns)`],
          ['list-checks', p(q.acceptance.pct), `Tasks with acceptance (${q.acceptance.withAcceptance}/${q.acceptance.tasks})`],
          ['timer-off', q.timeouts.perWeek ?? '—', 'Timeouts / week'],
        ] : [];
        return `${head('gauge', w.title || `Quality · last ${w.days || 7} days`)}${q ? `<div class="grid-4">${cards.map(([icon, value, label]) => `<div class="card stat-card">
            <div class="stat-icon"><i data-lucide="${icon}"></i></div>
            <div><div class="stat-value">${esc(value ?? '—')}</div><div class="stat-label">${esc(label)}</div></div>
          </div>`).join('')}</div>` : '<p style="color:var(--text-muted); font-size:0.85rem">Quality metrics unavailable</p>'}`;
      }

      // P2-3 decision trail (GET /api/rulings): RULING lines + auto-answers.
      case 'rulings': {
        const list = rulings?.rulings || [];
        const rows = list.slice(0, w.limit || 15).map(r => `<p style="margin:6px 0; font-size:0.85rem">
            ${badge(r.ruling.startsWith('AUTO-ANSWER: ') ? 'auto-answer' : 'ruling', r.ruling.startsWith('AUTO-ANSWER: ') ? '#F59E0B' : '#7C3AED')}
            ${esc(r.ruling.replace(/^AUTO-ANSWER: /, ''))}
            <span style="color:var(--text-muted)">${esc(r.task.slice(0, 8))} · ${esc(r.persona || '—')} · ${esc(r.agent || '—')} · ${timeAgo(r.date)}</span></p>`).join('');
        return `<div class="card">${head('gavel', w.title || `Rulings · last ${w.days || 7} days (${list.length})`)}<div style="max-height:340px; overflow-y:auto">${rows || '<p style="color:var(--text-muted); font-size:0.85rem">No rulings in this window</p>'}</div></div>`;
      }

      case 'dispatcher': {
        const roles = dispatcher
          ? Object.entries(dispatcher.roleChains || {}).map(([name, a]) =>
              `<tr><td style="padding:3px 12px 3px 0">${badge(name, '#7C3AED')}</td><td style="color:var(--text-secondary); font-size:0.85rem">${esc((a.agents || []).join(' → '))}</td></tr>`).join('')
          : '';
        const running = dispatcher?.running?.length
          ? dispatcher.running.map(r =>
              `<p style="margin:4px 0; font-size:0.85rem">${badge(r.role, '#22C55E')} <span style="color:var(--text-secondary)">${esc(r.taskId.slice(0, 8))} · ${timeAgo(new Date(r.startedAt).toISOString())}</span></p>`).join('')
          : '<p style="color:var(--text-muted); font-size:0.85rem">Idle</p>';
        return `<div class="card">
          ${head('zap', w.title || 'Dispatcher', dispatcher?.enabled ? badge('enabled', '#22C55E') : badge('disabled', '#EF4444'))}
          <div style="margin-top: var(--space-md)"><h4 class="section-title">Running Now</h4>${running}</div>
          <div style="margin-top: var(--space-md)"><h4 class="section-title">Role → Model</h4><table class="dispatcher-table">${roles}</table></div>
        </div>`;
      }

      case 'activity': {
        const list = this.activity.length
          ? this.activity.slice(0, w.limit || 12).map(e =>
              `<p style="margin:6px 0; font-size:0.85rem">${badge(e.type, '#0EA5E9')} ${esc(this.describeEvent(e))} <span style="color:var(--text-muted)">${timeAgo(e.timestamp)}</span></p>`).join('')
          : '<p style="color:var(--text-muted); font-size:0.875rem">Waiting for events…</p>';
        return `<div class="card">${head('activity', w.title || 'Live Activity')}<div style="max-height:340px; overflow-y:auto">${list}</div></div>`;
      }

      case 'platforms': {
        const rows = Object.entries(status?.platformStatus || {})
          .map(([id, on]) => `<p style="margin:6px 0; font-size:0.875rem">${esc(id)} ${dot(on)}</p>`).join('')
          || '<p style="color:var(--text-muted)">-</p>';
        return `<div class="card"><h3 style="font-size:0.95rem; margin-bottom:var(--space-md)">${esc(w.title || 'Platforms')}</h3><div>${rows}</div></div>`;
      }

      case 'services': {
        // Portal cards on a dashboard — same portal.json, same status polling.
        if (!portal) return `<div class="card">${head('layout-grid', w.title || 'Services')}<p style="color:var(--text-muted)">Portal catalog unavailable.</p></div>`;
        const svcs = this.portalServices(portal, w);
        const title = w.title || 'Services';
        if (!svcs.length) return `<div class="card">${head('layout-grid', title)}<p style="color:var(--text-muted); font-size:0.85rem">No portal.json services match this widget's filter.</p></div>`;
        if (!w.compact) return `<h4 class="section-title" style="margin-bottom:var(--space-md)">${esc(title)}</h4><div class="grid-3">${svcs.map(s => this.portalCard(s)).join('')}</div>`;
        return `<div class="card">${head('layout-grid', title)}<div class="svc-compact">${svcs.map(s =>
          `<a class="svc-compact-row" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(s.label)}">
            <i data-lucide="${esc(s.icon)}" style="color:${s.accent}"></i><span class="svc-compact-label">${esc(s.label)}</span>${this.svcStatusChip(s)}
          </a>`).join('')}</div></div>`;
      }

      case 'note':
        return `<div class="card layout-note">${w.title ? head('sticky-note', w.title) : ''}${md(w.text)}</div>`;

      default:
        return `<div class="card" style="color:var(--text-muted)">Unknown widget "${esc(w.type)}"</div>`;
    }
  }

  // ── System load bar (CPU / GPU / Memory / Temperature) ───────────────────

  // Pick a meter color band by how "hot" a 0–100 value is.
  sysBand(pct) {
    if (pct == null) return 'idle';
    if (pct >= 90) return 'crit';
    if (pct >= 70) return 'warn';
    return 'ok';
  }

  // Build the bar from the last known snapshot (this.sysMetrics) so SSE-driven
  // re-renders never flash back to placeholders. Live values then update in
  // place via applySysbar(). Only numbers + an escaped GPU name reach the DOM.
  // `opts.tiles` picks/orders tiles; `opts.hideUnavailable` hides a tile whose
  // metric the host can't report (no GPU, no thermal sensor).
  renderSysbar(opts = {}) {
    const s = this.sysMetrics || null;
    const TILES = {
      cpu:     ['cpu',  'cpu',          'CPU'],
      gpu:     ['gpu',  'gpu',          'GPU'],
      memory:  ['mem',  'memory-stick', 'Memory'],
      disk:    ['disk', 'hard-drive',   'Disk'],
      thermal: ['temp', 'thermometer',  'Core Temp'],
    };
    // Each tile is a button that opens its drill-down dialog (openSysDetail).
    const tile = (detail) => {
      const [id, icon, label] = TILES[detail];
      return `
      <button type="button" class="sysbar-tile" data-sys-detail="${detail}" data-sys-tile="${id}" aria-haspopup="dialog"
              ${opts.hideUnavailable ? 'data-hide-unavailable' : ''} title="Show ${label} details">
        <div class="sysbar-head">
          <i data-lucide="${icon}"></i><span class="sysbar-label">${label}</span>
          <span class="sysbar-val" data-sys="${id}-val">—</span>
        </div>
        <div class="meter"><div class="meter-fill" data-sys="${id}-bar" style="width:0%"></div></div>
        <div class="sysbar-sub" data-sys="${id}-sub">—</div>
        <i data-lucide="chevron-right" class="sysbar-more" aria-hidden="true"></i>
      </button>`;
    };
    const tiles = (opts.tiles?.length ? opts.tiles : Object.keys(TILES)).filter(t => TILES[t]);
    const html = `<div class="sysbar">${tiles.map(tile).join('')}</div>`;
    // If we already have a snapshot, apply it after this HTML lands in the DOM.
    if (s) queueMicrotask(() => this.applySysbar(s));
    return html;
  }

  // Update every sysbar tile in place from a snapshot (no full re-render).
  applySysbar(s) {
    if (!s) return;
    const all = (sel) => document.querySelectorAll(`[data-sys="${sel}"]`);
    const set = (id, val, pct, sub, available = true) => {
      all(`${id}-val`).forEach(v => { v.textContent = val; });
      all(`${id}-bar`).forEach(b => {
        b.style.width = `${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%`;
        b.className = `meter-fill ${this.sysBand(pct)}`;
      });
      all(`${id}-sub`).forEach(u => { u.textContent = sub; });
      document.querySelectorAll(`[data-sys-tile="${id}"][data-hide-unavailable]`)
        .forEach(t => { t.hidden = !available; });
    };
    const pct = (n) => (n == null ? '—' : `${n}%`);
    const mb = (n) => (n == null ? '—' : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
    const gb = (n) => (n == null ? '—' : n >= 1024 ? `${(n / 1024).toFixed(2)} TB` : `${Math.round(n)} GB`);

    // CPU
    const cpu = s.cpu || {};
    set('cpu', pct(cpu.usage), cpu.usage,
      `${cpu.cores || '—'} cores${cpu.load1 != null ? ` · load ${cpu.load1}` : ''}`);

    // GPU (aggregate over all cards)
    const g = s.gpu;
    if (g) {
      const memPct = (g.memoryUsedMb != null && g.memoryTotalMb) ? Math.round((g.memoryUsedMb / g.memoryTotalMb) * 100) : null;
      const name = (s.gpus && s.gpus.length === 1) ? s.gpus[0].name : (s.gpus && s.gpus.length > 1 ? `${s.gpus.length}× GPU` : '');
      // Unified-memory GPUs (GB10) report no memory total of their own.
      const gmem = g.memoryTotalMb == null ? 'unified mem' : `${mb(g.memoryUsedMb)}/${mb(g.memoryTotalMb)}`;
      set('gpu', pct(g.usage), g.usage,
        `${gmem}${g.temperature != null ? ` · ${g.temperature}°C` : ''}${name ? ` · ${name.slice(0, 22)}` : ''}`);
    } else {
      set('gpu', 'n/a', null, 'no GPU detected', false);
    }

    // Memory
    const m = s.memory || {};
    set('mem', pct(m.usage), m.usage, `${mb(m.usedMb)}/${mb(m.totalMb)}`);

    // Disk — root filesystem capacity.
    const dk = s.disk || {};
    set('disk', pct(dk.usage), dk.usage,
      dk.totalGb == null ? 'unavailable' : `${gb(dk.usedGb)}/${gb(dk.totalGb)} · ${dk.mount || '/'}`, dk.totalGb != null);

    // Core temperature — meter scaled against a 100°C ceiling.
    const t = cpu.temperature;
    set('temp', t == null ? '—' : `${t}°C`, t, t == null ? 'unavailable' : 'CPU package', t != null);
  }

  startSystemPolling() {
    const poll = async () => {
      try {
        const s = await this.api.get('/system');
        this.sysMetrics = s;
        this.applySysbar(s);
      } catch { /* transient — keep last known values */ }
    };
    poll();
    this.addViewTimer(poll, 3000);
  }

  // ── System detail dialogs (Overview tile drill-down) ───────────────────

  /**
   * Open the CPU / GPU / Memory / Temp drill-down for an Overview tile. Data
   * comes from GET /api/system/details/:kind (sampled on demand server-side) and
   * refreshes every 2.5s while the dialog is open; a self-rescheduling timeout
   * (not setInterval) means a slow sample never stacks requests. Closing — ✕,
   * backdrop, or Esc — stops the refresh and returns focus to the tile.
   */
  openSysDetail(kind, opener) {
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) return;
    const meta = {
      cpu:     { title: 'CPU',         icon: 'cpu' },
      gpu:     { title: 'GPU',         icon: 'gpu' },
      memory:  { title: 'Memory',      icon: 'memory-stick' },
      disk:    { title: 'Disk',        icon: 'hard-drive' },
      thermal: { title: 'Temperature', icon: 'thermometer' },
    }[kind];
    if (!meta) return;
    const barBtn = 'font-size:0.75rem;padding:3px 8px;display:inline-flex;align-items:center;gap:4px';
    content.classList.add('modal-md');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('aria-labelledby', 'sysd-title');
    content.innerHTML = `
      <div class="sysd-head">
        <h3 id="sysd-title"><i data-lucide="${meta.icon}"></i> ${meta.title} details</h3>
        <span class="sysd-live" title="Refreshing every 2.5s"><span class="svc-dot"></span><span class="sysd-at">loading…</span></span>
        <button class="btn sysd-close" title="Close (Esc)" aria-label="Close" style="${barBtn}"><i data-lucide="x" style="width:14px;height:14px"></i></button>
      </div>
      <div class="sysd-body" aria-live="polite"><p class="sysd-muted">Sampling…</p></div>`;
    container.classList.remove('hidden');
    createIcons();

    let timer = null, open = true;
    const close = () => {
      open = false;
      clearTimeout(timer);
      container.classList.add('hidden');
      content.classList.remove('modal-md');
      ['role', 'aria-modal', 'aria-labelledby'].forEach(a => content.removeAttribute(a));
      content.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    content.querySelector('.sysd-close').onclick = close;
    container.querySelector('.modal-backdrop').onclick = close;
    content.querySelector('.sysd-close').focus();

    const load = async () => {
      try {
        const d = await this.api.get(`/system/details/${kind}`);
        if (!open) return;
        const body = content.querySelector('.sysd-body');
        // Keep the scroll position of the body across refreshes.
        const top = content.scrollTop;
        body.innerHTML = this.renderSysDetail(kind, d);
        content.scrollTop = top;
        const at = content.querySelector('.sysd-at');
        if (at) at.textContent = `live · ${new Date(d.at).toLocaleTimeString()}`;
        content.querySelector('.sysd-live')?.classList.remove('stale');
        createIcons();
      } catch (e) {
        if (!open) return;
        content.querySelector('.sysd-live')?.classList.add('stale');
        const at = content.querySelector('.sysd-at');
        if (at) at.textContent = `error: ${e.message || 'request failed'}`;
      }
      if (open) timer = setTimeout(load, 2500);
    };
    load();
  }

  // Build a detail dialog body. Every string from the host (process names,
  // container names, GPU names, zone types) goes through esc().
  renderSysDetail(kind, d) {
    const mb = (n) => (n == null ? '—' : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
    const pct = (n) => (n == null ? '—' : `${n}%`);
    const meter = (p, band = this.sysBand(p)) =>
      `<div class="meter"><div class="meter-fill ${band}" style="width:${p == null ? 0 : Math.max(0, Math.min(100, p))}%"></div></div>`;
    const kv = (rows) => `<dl class="sysd-kv">${rows.filter(Boolean).map(([k, v]) =>
      `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
    const section = (title, html) => `<h4 class="section-title sysd-sec">${title}</h4>${html}`;
    const dur = (sec) => {
      const dd = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      return dd ? `${dd}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
    };
    const procTable = (rows, cols) => rows?.length ? `
      <div class="sysd-table-wrap"><table class="sysd-table">
        <thead><tr><th>PID</th><th>Process</th>${cols.map(c => `<th class="num">${c.h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td class="mono">${r.pid}</td>
          <td><span class="sysd-proc">${esc(r.name)}</span>${r.container ? ` <span class="sysd-ctr" title="docker container">${esc(r.container)}</span>` : ''}</td>
          ${cols.map(c => `<td class="num mono">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '<p class="sysd-muted">No processes to show.</p>';

    if (kind === 'cpu') {
      const usage = this.sysMetrics?.cpu?.usage;
      const models = (d.models || []).map(m => `${m.count}× ${esc(m.model)}`).join(' · ') || '—';
      const cores = (d.cores || []).map(c => `
        <div class="sysd-core" title="cpu${c.id}: ${pct(c.usage)}${c.mhz ? ` @ ${c.mhz} MHz` : ''}">
          <div class="sysd-core-head"><span>cpu${c.id}</span><b>${pct(c.usage)}</b></div>
          ${meter(c.usage)}
          <div class="sysd-core-sub">${c.mhz ? `${(c.mhz / 1000).toFixed(2)} GHz` : '&nbsp;'}</div>
        </div>`).join('');
      return kv([
        ['Usage', pct(usage)],
        ['Cores', `${(d.cores || []).length} · ${esc(d.arch || '')}`],
        ['Model', models],
        ['Load avg', `${d.load?.m1 ?? '—'} / ${d.load?.m5 ?? '—'} / ${d.load?.m15 ?? '—'} <span class="sysd-muted">(1 / 5 / 15 min)</span>`],
        ['Tasks', d.tasks?.total != null ? `${d.tasks.running} running / ${d.tasks.total} total` : '—'],
        ['Uptime', d.uptimeSec != null ? dur(d.uptimeSec) : '—'],
      ])
      + section('Per core', `<div class="sysd-cores">${cores}</div>`)
      + section('Top processes <span class="sysd-muted">by CPU now · 100% = one core</span>',
          procTable(d.processes, [{ h: 'CPU', f: r => pct(r.cpu) }, { h: 'RSS', f: r => mb(r.rssMb) }]));
    }

    if (kind === 'memory') {
      const t = d.totalMb || 0;
      const used = d.usedMb ?? 0, free = d.freeMb ?? 0;
      const cache = Math.max(0, t - used - free); // reclaimable: page cache + buffers
      const seg = (v, cls, label) => t ? `<div class="sysd-seg ${cls}" style="width:${(v / t) * 100}%" title="${label}: ${mb(v)}"></div>` : '';
      const swapUsed = d.swap?.totalMb != null && d.swap?.freeMb != null ? d.swap.totalMb - d.swap.freeMb : null;
      return `
        <div class="sysd-stack">${seg(used, 'used', 'Used')}${seg(cache, 'cache', 'Cache / buffers')}${seg(free, 'free', 'Free')}</div>
        <div class="sysd-legend"><span><i class="used"></i>Used ${mb(used)}</span><span><i class="cache"></i>Cache ${mb(cache)}</span><span><i class="free"></i>Free ${mb(free)}</span></div>`
      + kv([
        ['Total', mb(d.totalMb)],
        ['Used', `${mb(d.usedMb)} <span class="sysd-muted">(${t ? Math.round((used / t) * 100) : '—'}%)</span>`],
        ['Available', mb(d.availableMb)],
        ['Cached', mb(d.cachedMb)],
        ['Buffers', mb(d.buffersMb)],
        ['Shared (shmem)', mb(d.shmemMb)],
        ['Slab reclaimable', mb(d.reclaimableMb)],
        ['Dirty', mb(d.dirtyMb)],
        ['Committed', mb(d.committedMb)],
        ['Swap', d.swap?.totalMb ? `${mb(swapUsed)} / ${mb(d.swap.totalMb)}` : 'none'],
        d.hugePages?.total ? ['Huge pages', `${d.hugePages.total - d.hugePages.free} / ${d.hugePages.total} used`] : null,
        d.gpuAllocatedMb != null ? ['GPU allocations', `${mb(d.gpuAllocatedMb)} <span class="sysd-muted">(not in RSS)</span>`] : null,
      ])
      + section('Top processes <span class="sysd-muted">by resident memory</span>',
          procTable(d.processes, [{ h: 'RSS', f: r => mb(r.rssMb) }]));
    }

    if (kind === 'disk') {
      const gb = (n) => (n == null ? '—' : n >= 1024 ? `${(n / 1024).toFixed(2)} TB` : `${n} GB`);
      const mounts = (d.mounts || []).map(m => `
        <div class="sysd-therm" title="${esc(m.device)} · ${esc(m.fstype)}">
          <span class="mono">${esc(m.mount)} <span class="sysd-muted">${esc(m.device.replace('/dev/', ''))} · ${esc(m.fstype)}</span></span>
          ${meter(m.usage)}<b>${pct(m.usage)}</b>
        </div>
        <div class="sysd-legend"><span>Used ${gb(m.usedGb)}</span><span>Free ${gb(m.availGb)}</span><span>Total ${gb(m.totalGb)}</span></div>`).join('');
      const storage = (d.storage || []).length ? `
        <div class="sysd-table-wrap"><table class="sysd-table">
          <thead><tr><th>Dir</th><th>Path</th><th class="num">Size</th></tr></thead>
          <tbody>${d.storage.map(r => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(r.path)}</td>
            <td class="num mono">${r.sizeMb == null ? '<span class="sysd-muted">measuring…</span>' : mb(r.sizeMb)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="sysd-muted">No cowork data dirs found.</p>';
      return section('Filesystems', mounts || '<p class="sysd-muted">No block devices found.</p>')
        + section('Cowork data <span class="sysd-muted">sizes refresh every minute · finished scheduled runs auto-purge (Settings → Inbox)</span>', storage);
    }

    if (kind === 'gpu') {
      if (!d.gpus?.length) return `<p class="sysd-muted">No GPU detected${d.error ? ` (${esc(d.error)})` : ''}.</p>`;
      const sysMem = this.sysMetrics?.memory || {};
      const cards = d.gpus.map(g => {
        const memPct = g['memory.total'] ? Math.round((g['memory.used'] / g['memory.total']) * 100) : null;
        const memLine = g['memory.total'] != null
          ? `${mb(g['memory.used'])} / ${mb(g['memory.total'])} (${memPct}%)`
          : `Unified — shares system RAM <span class="sysd-muted">(${mb(sysMem.usedMb)} / ${mb(sysMem.totalMb)} in use)</span>`;
        const w = (v, unit) => (v == null ? '—' : `${v} ${unit}`);
        return `<div class="sysd-gpu">
          <div class="sysd-gpu-head"><b>#${g.index} ${esc(g.name || 'GPU')}</b><span>${pct(g['utilization.gpu'])}</span></div>
          ${meter(g['utilization.gpu'])}
          ${kv([
            ['Memory', memLine],
            ['Mem bandwidth util', pct(g['utilization.memory'])],
            ['Temperature', w(g['temperature.gpu'], '°C')],
            ['Power', g['power.draw'] != null ? `${g['power.draw']} W${g['power.limit'] != null ? ` / ${g['power.limit']} W` : ''}` : '—'],
            ['SM clock', g['clocks.sm'] != null ? `${g['clocks.sm']} MHz${g['clocks.max.sm'] != null ? ` / ${g['clocks.max.sm']} max` : ''}` : '—'],
            ['Mem clock', w(g['clocks.mem'], 'MHz')],
            ['Fan', pct(g['fan.speed'])],
            ['P-state', esc(g.pstate || '—')],
            ['Driver', esc(g.driver_version || '—')],
            ['Compute mode', esc(g.compute_mode || '—')],
            ['UUID', `<span class="mono">${esc(g.uuid || '—')}</span>`],
          ])}
        </div>`;
      }).join('');
      return cards
      + section('GPU processes <span class="sysd-muted">by GPU memory</span>',
          procTable(d.processes, [{ h: 'GPU mem', f: r => mb(r.gpuMemMb) }, { h: 'RSS', f: r => mb(r.rssMb) }]));
    }

    // thermal — meters scaled against a 100°C ceiling, like the tile.
    const row = (label, c) => `<div class="sysd-therm"><span>${label}</span>${meter(c)}<b>${c == null ? '—' : `${c}°C`}</b></div>`;
    return section('Thermal zones', (d.zones || []).length
        ? d.zones.map(z => row(`${esc(z.zone.replace('thermal_zone', 'zone '))} <span class="sysd-muted">${esc(z.type)}</span>`, z.celsius)).join('')
        : '<p class="sysd-muted">No thermal zones exposed by this host.</p>')
      + ((d.gpus || []).length ? section('GPU', d.gpus.map(g => row(`#${g.index} ${esc(g.name)}`, g.celsius)).join('')) : '');
  }

  // ── Active Agents ──────────────────────────────────────────────────────

  async renderConnections() {
    // One-shot render + a slow poll so the usage meters / reset countdowns and
    // heartbeat ages stay current while the view is open. The timer calls the
    // inner render (NOT renderConnections) so it never stacks new timers.
    const render = () => this.renderConnectionsInner();
    await render();
    this.addViewTimer(() => render().then(createIcons).catch(() => { /* transient */ }), 15000);
  }

  async renderConnectionsInner() {
    const { clients, counters, usage = {}, localAgents = [] } = await this.api.get('/connections');
    const clientCards = clients.map(a => `
      <div class="card agent-card conn-local-card">
        <div class="agent-header">
          <span class="agent-title">${esc(a.workerName)}</span>
          ${badge(a.live ? 'live' : 'stale', a.live ? '#22C55E' : '#94A3B8')}
        </div>
        <p style="margin:6px 0">${badge(a.platform, '#D97757')} ${badge(a.status, STATUS_COLORS[a.status] || '#94A3B8')}</p>
        ${a.capabilities?.length ? `<div class="agent-capabilities" style="font-size:0.78rem; color:var(--text-muted); margin-top:6px; display:flex; flex-direction:column; gap:2px;">${a.capabilities.slice().sort().map(c => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
        ${usageMeters(a.capabilities, usage)}
        <div class="agent-footer">
          <span><i data-lucide="heart" style="width:12px;height:12px;vertical-align:middle;margin-right:2px"></i> ${timeAgo(a.lastHeartbeat)}</span>
          <span>joined ${timeAgo(a.registeredAt)}</span>
        </div>
      </div>`);

    // The cowork host's own metered agents (local claude/codex/antigravity) don't
    // belong to any MCP client, but their quota matters just as much when picking
    // an agent. Give each exec its OWN full-width card, stacked vertically, so the
    // taller ones (Antigravity's grouped per-model quota) have room to breathe
    // instead of being crammed into a grid column.
    const localCards = localAgentCards(localAgents, usage);
    const localHtml = localCards.length ? `
      <div class="conn-section-label" style="display:flex;justify-content:space-between;align-items:center">
        <div>Local agents <span>· run by the dispatcher on this host</span></div>
        <button id="btn-refresh-usage" class="btn btn-sm" style="display:inline-flex;align-items:center;gap:4px;font-size:0.75rem;padding:2px 8px;cursor:pointer" title="Refresh rate limits">
          <i data-lucide="refresh-cw" style="width:12px;height:12px"></i> Refresh
        </button>
      </div>
      <div class="conn-local-stack">${localCards.join('')}</div>` : '';

    const clientsHtml = clientCards.length ? `<div class="conn-local-stack">${clientCards.join('')}</div>`
      : `<div class="empty-state"><div class="empty-state-icon"><i data-lucide="plug"></i></div><h3>No live MCP clients</h3><p>External clients appear here when they register + heartbeat.</p></div>`;
    const cardsHtml = `${localHtml}${localHtml && clientCards.length ? `<div class="conn-section-label" style="margin-top:var(--space-lg)">MCP clients <span>· external agents that register + heartbeat</span></div>` : ''}${clientsHtml}`;

    // Invocation counters: per client × per agent (ran / submitted)
    const clientsSet = new Set([...Object.keys(counters.ran || {}), ...Object.keys(counters.submitted || {})]);
    const counterRows = [...clientsSet].map(cl => {
      const ran = counters.ran?.[cl] || {}, sub = counters.submitted?.[cl] || {};
      const agents = [...new Set([...Object.keys(ran), ...Object.keys(sub)])];
      return agents.map(b => `<tr><td style="padding:2px 10px 2px 0">${esc(cl)}</td><td style="padding:2px 10px 2px 0">${badge(b, '#7C3AED')}</td><td style="text-align:right;padding-right:12px">${ran[b] || 0}</td><td style="text-align:right">${sub[b] || 0}</td></tr>`).join('');
    }).join('');

    this.contentEl.innerHTML = `
      ${cardsHtml}
      <div class="card" style="margin-top:var(--space-lg)">
        <h3 style="font-size:0.95rem; margin-bottom:8px">Agent invocations <span style="font-size:0.72rem;color:var(--text-muted);font-weight:400">(this session · resets on restart)</span></h3>
        ${counterRows ? `<table style="font-size:0.83rem"><thead><tr style="color:var(--text-muted);font-size:0.75rem"><th style="text-align:left">client</th><th style="text-align:left">agent</th><th style="text-align:right;padding-right:12px">ran</th><th style="text-align:right">submitted</th></tr></thead><tbody>${counterRows}</tbody></table>` : '<p style="color:var(--text-muted);font-size:0.85rem">No invocations yet.</p>'}
      </div>`;

    const btnRefresh = this.contentEl.querySelector('#btn-refresh-usage');
    if (btnRefresh) {
      btnRefresh.onclick = async () => {
        btnRefresh.disabled = true;
        btnRefresh.style.opacity = '0.6';
        const icon = btnRefresh.querySelector('i');
        if (icon) icon.classList.add('spin');
        try {
          await this.api.get('/connections?refresh=1');
          await this.renderConnectionsInner();
          createIcons();
        } finally {
          btnRefresh.disabled = false;
          btnRefresh.style.opacity = '1';
        }
      };
    }
  }

  // ── Inbox ──────────────────────────────────────────────────────────────

  /**
   * Make one chain container drag-sortable. `save(orderedAgentIds)` is called on
   * drop and on ✕ removal. Shared by the Agents default chain and every Agents
   * chain so reordering behaves identically everywhere.
   */
  wireChainDnd(container, save) {
    if (!container) return;
    const ids = () => [...container.querySelectorAll('.dchip')].map(c => c.dataset.agent);
    const before = ids().join('\n');
    let dragged = null;
    container.querySelectorAll('.dchip[draggable="true"]').forEach(c => {
      c.addEventListener('dragstart', () => { dragged = c; c.style.opacity = '.4'; });
      c.addEventListener('dragend', () => { c.style.opacity = ''; dragged = null; });
      c.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragged || dragged === c) return;
        const chips = [...container.querySelectorAll('.dchip')];
        if (chips.indexOf(dragged) < chips.indexOf(c)) c.after(dragged); else c.before(dragged);
      });
    });
    container.addEventListener('dragover', (e) => e.preventDefault());
    // Only this container's own chips reorder it; a drop from another chain, or a
    // drop that left the order unchanged, is not a save.
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      if (ids().join('\n') !== before) save(ids());
    });
    container.querySelectorAll('[data-rm]').forEach(a => a.addEventListener('click', (e) => {
      e.stopPropagation();
      save(ids().filter(b => b !== a.dataset.rm));
    }));
  }

  /**
   * Wire every `chainEditor()` under `root`: drag/✕ on its chips and its "+ add"
   * picker. `getChain(ctx)` returns the current list; `save(ctx, list)` persists.
   * Also wires bare `[data-chain-add]` pickers (e.g. "+ override with…" starters).
   */
  wireChainEditors(root, getChain, save) {
    root.querySelectorAll('.chain-editor').forEach(ed =>
      this.wireChainDnd(ed.querySelector('.chain-row'), (arr) => save(ed.dataset.ctx, arr)));
    root.querySelectorAll('[data-chain-add]').forEach(sel => sel.addEventListener('change', () => {
      const id = sel.value; if (!id) return;
      const ctx = sel.dataset.chainAdd;
      const arr = getChain(ctx);
      if (!arr.includes(id)) arr.push(id);
      sel.disabled = true;
      save(ctx, arr);
    }));
  }

  // ── Shared upload helper (task inputs) ─────────────────────────────────

  /** Upload staged File objects; returns [{token,name}] for a task's `inputs`.
   *  Raw fetch — the JSON-only APIClient can't send binary bodies. */
  async uploadInputFiles(files) {
    const out = [];
    for (const f of files) {
      const res = await fetch(`/api/uploads?name=${encodeURIComponent(f.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f
      });
      if (!res.ok) {
        let msg = `upload failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
        throw new Error(`${f.name}: ${msg}`);
      }
      const r = await res.json();
      out.push({ token: r.token, name: r.name });
    }
    return out;
  }

  /**
   * Human-in-the-loop block for a task card: renders the task's interaction
   * (questions / checklist) as a fillable form when still pending, or a read-only
   * summary of the submitted answers once a person has provided them. Returns ''
   * for tasks that carry no interaction.
   */
  interactionBlock(t) {
    const ix = t.interaction;
    if (!ix || !Array.isArray(ix.fields) || !ix.fields.length) return '';
    const submitted = ix.status === 'submitted';
    const inp = 'width:100%;padding:7px 10px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font:inherit;font-size:0.85rem';

    const fieldHtml = (f) => {
      const type = f.type || 'text';
      const req = f.required ? ' <span style="color:#EF4444">*</span>' : '';
      // Marks required non-checkbox controls so the submit handler can validate
      // them client-side (and match the server's required-field rule).
      const reqAttr = f.required ? ' data-required="1"' : '';
      // Read-only rendering once submitted.
      if (submitted) {
        const v = f.value;
        const shown = type === 'checkbox' ? (v ? '☑ yes' : '☐ no') : (v === undefined || v === '' ? '—' : String(v));
        return `<div style="margin:8px 0">
          <div style="font-size:0.78rem;color:var(--text-muted)">${esc(f.label)}</div>
          <div style="font-size:0.88rem;white-space:pre-wrap">${esc(shown)}</div>
        </div>`;
      }
      const control = type === 'textarea'
        ? `<textarea data-field="${esc(f.id)}" data-ftype="textarea"${reqAttr} rows="3" placeholder="${esc(f.placeholder || '')}" style="${inp};resize:vertical"></textarea>`
        : type === 'checkbox'
        ? `<label style="display:inline-flex;align-items:center;gap:8px;font-size:0.88rem;cursor:pointer"><input type="checkbox" data-field="${esc(f.id)}" data-ftype="checkbox"> ${esc(f.label)}${req}</label>`
        : type === 'select'
        ? `<select data-field="${esc(f.id)}" data-ftype="select"${reqAttr} style="${inp}"><option value="">— choose —</option>${(f.options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`
        : `<input type="text" data-field="${esc(f.id)}" data-ftype="text"${reqAttr} placeholder="${esc(f.placeholder || '')}" style="${inp}">`;
      // Checkbox carries its own inline label; others get a label above.
      return type === 'checkbox'
        ? `<div style="margin:10px 0">${control}</div>`
        : `<div style="margin:10px 0"><label style="display:block;font-size:0.8rem;color:var(--text-secondary);margin-bottom:4px">${esc(f.label)}${req}</label>${control}</div>`;
    };

    const headColor = submitted ? '#22C55E' : '#EAB308';
    const headText = submitted
      ? `Human input received${ix.submittedBy ? ' · ' + esc(ix.submittedBy) : ''}${ix.submittedAt ? ' · ' + timeAgo(ix.submittedAt) : ''}`
      : 'Provide information';
    return `<div class="task-interaction" data-interaction="${esc(t.id)}" style="margin-top:12px;padding:12px;border:1px solid ${headColor}40;border-radius:10px;background:${headColor}0d">
      <div style="display:flex;align-items:center;gap:6px;font-size:0.78rem;text-transform:uppercase;letter-spacing:.03em;color:${headColor};margin-bottom:6px">
        <i data-lucide="${submitted ? 'check-circle-2' : 'clipboard-list'}" style="width:14px;height:14px"></i> ${headText}
      </div>
      ${ix.prompt ? `<div style="font-size:0.83rem;color:var(--text-secondary);margin-bottom:8px">${esc(ix.prompt)}</div>` : ''}
      ${ix.fields.map(fieldHtml).join('')}
      ${submitted ? '' : `<div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <input data-ix-by placeholder="your name (optional)" style="${inp};max-width:200px">
        <button class="btn btn-primary interaction-submit" data-ix-task="${esc(t.id)}" style="font-size:0.8rem">Submit input</button>
      </div>`}
    </div>`;
  }

  // One task card's HTML. Shared by renderInbox (whole list) and patchInboxTasks
  // (SSE: redraw just the card an event names).
  taskCardHTML(t) {
    const c = t.context || {};
    // Which persona + agent ran it (item 5), or the requested assignment.
    const personaLabel = c.ranPersona ? (c.ranDivision ? `${c.ranDivision} / ${c.ranPersona}` : c.ranPersona)
      : (c.division ? `${c.division} / ${c.persona || '?'}` : (c.persona || c.role || ''));
    // While a task runs, ranAgent is not written yet (it lands at completion) and an
    // auto-routed task has no context.agent — so prefer the dispatcher's claim-time
    // stamp (liveAgent / liveThinking), then the pin, then the claiming worker.
    const isRunning = t.status === 'in-progress' || t.status === 'claimed';
    const agentLabel = (isRunning ? (c.liveAgent || c.agent || (t.claimedBy ? this.workerLabel(t.claimedBy) : '')) : '')
      || c.ranAgent || c.agent || '';
    const thinkingLabel = isRunning ? (c.liveThinking || c.thinking || '') : (c.thinking || '');
    // Running cards ALWAYS show both badges; unknown values get explicit fallbacks.
    const agentBadge = agentLabel ? badge(agentLabel, '#0EA5E9')
      : (isRunning ? `<span class="badge" title="No agent recorded for this run yet (routing, or claimed by a client that did not report one)" style="background:#94A3B818; color:#94A3B8; border:1px solid #94A3B840">agent: unassigned</span>` : '');
    const thinkingBadge = thinkingLabel ? badge(`thinking: ${thinkingLabel}`, '#64748B')
      : (isRunning ? `<span class="badge" title="No thinking level set on the task — the run uses the agent's default (else medium)" style="background:#64748B18; color:#64748B; border:1px solid #64748B40">thinking: default</span>` : '');
    // Fallback trail: agents that failed verification and were handed over.
    const failedAgents = Array.isArray(c.failedAgents) ? c.failedAgents : [];
    const failed = isTaskFailed(t);
    // done, but closed administratively without ever running (superseded copy,
    // pre-empted cancel) — badged distinctly so its empty artifacts list is not
    // mistaken for a silent failure.
    const closedNoRun = isTaskClosedNoRun(t);
    // The card no longer expands to show RESULT / DESCRIPTION inline. Instead the
    // run's RESULT is a first-class `result.md` chip in its own RESULT section
    // (first, above ARTIFACTS / INPUTS) and the brief is a `description.md` chip
    // under INPUTS — both open in the markdown viewer modal. The dispatcher writes
    // the real result.md for local runs; the server also serves both names
    // synthetically from task.result / task.description, so the chips work even
    // when no file is on disk (remote / older tasks).
    const artsRaw = Array.isArray(t.artifacts) ? t.artifacts : [];
    // result.md gets its own RESULT section — keep it out of the plain
    // ARTIFACTS list so the run's result is not buried in the artifacts.
    const resultOnDisk = artsRaw.includes('result.md');
    const hasResult = !closedNoRun && (!!t.result || resultOnDisk);
    const arts = artsRaw.filter(f => f !== 'result.md');
    // OUTPUTS: the final deliverables the run placed in artifacts/<id>/outputs/
    // ($COWORK_OUTPUTS_DIR) — their own section, right after RESULT.
    const outs = Array.isArray(t.outputs) ? t.outputs : [];
    const inputsRaw = Array.isArray(c.inputFiles) ? c.inputFiles : [];
    const inputs = (t.description && !inputsRaw.includes('description.md'))
      ? ['description.md', ...inputsRaw] : inputsRaw;
    // A recurring task is a persistent SCHEDULER: it stays `scheduled` and spawns a
    // one-shot run-child each cycle. Each run-child is its OWN `done` card holding
    // that cycle's artifacts/result, linked back to the scheduler via
    // context.scheduledParentId. We surface that ONE stable parent reference (no
    // run-to-run "previous/next" chain that made the list scroll up and down).
    const parentLink = c.scheduledParentId
      ? `<a href="#tasks/${encodeURIComponent(c.scheduledParentId)}" title="This run was produced by a recurring scheduled task — open it" style="display:inline-flex; align-items:center; gap:3px; color:#6366F1; text-decoration:none; font-family:inherit"><i data-lucide="repeat" style="width:11px;height:11px;vertical-align:-1px"></i>scheduled task</a>`
      : '';
    // Files can be attached while a task is still schedulable, or to a failed one
    // (attach context, then re-run).
    const canAttach = ['pending', 'wait-input', 'scheduled'].includes(t.status) || failed;
    // Vertical agent fallback chain — agents in the order they were tried, the
    // last one at the bottom. Failed rungs are red with their reason; the final
    // (running / successful) agent sits at the end.
    const chain = failedAgents.map(f => ({
      agent: f.agent, reason: f.reason || 'failed', ok: false
    }));
    const lastFailed = failedAgents.length ? failedAgents[failedAgents.length - 1].agent : null;
    if (agentLabel && agentLabel !== lastFailed) chain.push({ agent: agentLabel, ok: !failed, final: true });
    const chainHtml = chain.length ? `<div class="task-agent-chain" style="display:flex; flex-direction:column; gap:3px; padding:2px 0 6px">
      ${chain.map((r, i) => {
        const col = r.ok ? '#22C55E' : (r.final ? AGENT_COLOR : '#EF4444');
        const icon = r.ok ? '✓' : (r.final ? '●' : '✗');
        return `<div style="display:flex; align-items:center; gap:6px; font-size:0.8rem">
          <span style="width:14px; text-align:right; color:var(--text-muted); font-size:0.7rem">${i + 1}</span>
          <span class="badge" style="background:${col}18; color:${col}; border:1px solid ${col}40">${icon} ${esc(r.agent)}</span>
          ${r.reason ? `<span style="color:var(--text-muted); font-size:0.74rem">${esc(r.reason)}</span>` : ''}
        </div>`;
      }).join('')}
    </div>` : '';

    // (2) PENDING — why is this task still waiting? The dispatcher annotates each
    // pending task with context.pendingReason (free slot / agent at capacity /
    // routing / remote-unclaimed / deps / held-manual). Shown only while pending.
    const pendingReason = (t.status === 'pending' && c.pendingReason) ? String(c.pendingReason) : '';
    const pendingHtml = pendingReason ? `<div class="task-pending-why" style="display:flex; align-items:flex-start; gap:6px; margin:2px 0 6px; padding:6px 9px; border-radius:8px; background:#EAB30814; border:1px solid #EAB30833; color:var(--text-secondary); font-size:0.8rem">
      <i data-lucide="hourglass" style="width:13px;height:13px;margin-top:1px;color:#EAB308;flex-shrink:0"></i>
      <span>${esc(pendingReason)}${c.pendingReasonAt ? ` <span style="color:var(--text-muted)">· ${esc(timeAgo(c.pendingReasonAt))}</span>` : ''}</span>
    </div>` : '';

    // (1) IN-PROGRESS — a live progress-log window streaming what the agent is
    // doing right now. Filled + auto-scrolled by pollInboxProgress() polling
    // GET /inbox/:id/progress (the tail of artifacts/<id>/progress.log).
    // It rides INSIDE the collapsible block (hidden by default, tap the card to
    // show / hide) like RESULT / OUTPUTS; the poller keeps filling it while hidden.
    const progressHtml = isRunning ? `<div class="task-progress" style="margin:4px 0 8px; border:1px solid var(--border-hover); border-radius:10px; overflow:hidden; background:var(--bg-tertiary)">
      <div style="display:flex; align-items:center; gap:7px; padding:6px 10px; font-size:0.74rem; text-transform:uppercase; letter-spacing:.03em; color:#0EA5E9; border-bottom:1px solid var(--border-hover)">
        <span class="progress-pulse" data-progress-pulse="${esc(t.id)}" style="width:8px;height:8px;border-radius:50%;background:#0EA5E9;display:inline-block;animation:progressPulse 1.4s ease-in-out infinite"></span>
        <span data-progress-label="${esc(t.id)}">Live progress — what it's doing right now</span>
        <span data-progress-age="${esc(t.id)}" style="margin-left:auto; text-transform:none; letter-spacing:0; color:var(--text-muted)"></span>
      </div>
      <pre data-progress="${esc(t.id)}" style="margin:0; padding:9px 11px; max-height:320px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.74rem; line-height:1.45; color:var(--text-secondary)">Loading live output…</pre>
    </div>` : '';

    // (3) FAILED on a RATE LIMIT — a toggle to auto re-run once the window resets.
    // Shown only when the server classified the failure as rate-limited.
    const rlReset = c.rateLimitResetsAt ? new Date(c.rateLimitResetsAt) : null;
    const rlResetOk = rlReset && !isNaN(rlReset.getTime());
    const autoRerunHtml = (failed && c.rateLimited) ? `<div class="task-autorerun" style="margin:6px 0 2px; padding:8px 10px; border-radius:9px; background:#F9731614; border:1px solid #F9731633">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.82rem; color:var(--text-primary)">
        <input type="checkbox" data-autorerun="${esc(t.id)}" ${c.autoRerunOnReset !== false ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;accent-color:#F97316">
        <span><i data-lucide="refresh-cw" style="width:12px;height:12px;vertical-align:-1px;margin-right:3px"></i>Auto re-run when the rate limit resets${rlResetOk ? ` <span style="color:var(--text-muted)">(≈ ${esc(rlReset.toLocaleString())})</span>` : ''}</span>
      </label>
      <button class="btn" data-rerun-task="${esc(t.id)}" data-agent="" title="Don't wait for the cooldown — re-run now on another agent"
        style="font-size:0.72rem;margin:6px 0 0 23px;padding:2px 7px;color:#F97316;border-color:#F9731666">⇄ Assign to another agent now</button>
      <div style="font-size:0.72rem; color:var(--text-muted); margin-top:3px; padding-left:23px">Failed on a rate limit. On by default — Cowork re-queues this task automatically once the usage window resets${rlResetOk ? '' : ' (re-checked hourly until a reset time is known)'}. Untick to leave it failed.${c.autoRerunCount ? ` Auto re-runs so far: ${esc(String(c.autoRerunCount))}.` : ''}</div>
    </div>` : '';

    return `
    <div class="card task-card" style="margin-bottom: var(--space-md)${failed ? ';border-left:3px solid #EF4444' : ''}" data-task="${esc(t.id)}" data-created="${esc(t.createdAt || '')}" data-title="${esc((t.title || '').toLowerCase())}">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
        ${failed ? badge('failed', '#EF4444')
          : closedNoRun ? `<span class="badge" title="Done, but closed administratively without ever running an agent — so it has no artifacts and no result.md. The full explanation is in this task's result field below." style="background:#94A3B818; color:#94A3B8; border:1px solid #94A3B840">done · closed (never ran)</span>`
          : badge(t.status, STATUS_COLORS[t.status] || '#94A3B8')}
        ${!failed && c.qualityFlag === 'concerns' ? `<span class="badge" title="${esc('Done with concerns: ' + (c.concerns || '(no CONCERNS text)'))}" style="background:#F59E0B18; color:#F59E0B; border:1px solid #F59E0B40">⚠ concerns</span>` : ''}
        ${c.specVerdict && c.specVerdict.verdict ? (() => {
          const sv = c.specVerdict;
          const v = String(sv.verdict).toUpperCase();
          const col = v === 'APPROVED' ? '#22C55E' : v === 'CHANGES_REQUESTED' ? '#EF4444' : '#94A3B8';
          const icon = v === 'APPROVED' ? '✓' : v === 'CHANGES_REQUESTED' ? '✗' : '?';
          const lbl = v === 'APPROVED' ? 'spec: approved' : v === 'CHANGES_REQUESTED' ? 'spec: changes' : 'spec: unverifiable';
          const tip = `Spec verifier (${sv.mode || 'shadow'}, judge: ${sv.judgeAgent || 'none'}): ${sv.summary || v}`;
          return `<span class="badge" title="${esc(tip)}" style="background:${col}18; color:${col}; border:1px solid ${col}40">${icon} ${lbl}</span>`;
        })() : ''}
        ${t.status === 'scheduled' && t.scheduledAt ? badge(`⏰ ${new Date(t.scheduledAt).toLocaleString()}`, '#6366F1') : ''}
        ${t.recurrence ? badge(`🔁 ${describeRecurrence(t.recurrence)}`, '#3B82F6')
          : t.loopIntervalHours ? badge(`🔁 every ${t.loopIntervalHours}h`, '#3B82F6') : ''}
        ${personaLabel ? badge(personaLabel, '#7C3AED') : ''}${agentBadge}${thinkingBadge}
        ${t.interaction && t.interaction.status !== 'submitted' ? badge('⌛ awaiting input', '#EAB308') : ''}
        ${t.interaction && t.interaction.status === 'submitted' ? badge('✓ input received', '#22C55E') : ''}
        ${inputsRaw.length ? badge(`📎 ${inputsRaw.length}`, '#0EA5E9') : ''}
        ${t.priority && t.priority !== 'normal' ? badge(t.priority, t.priority === 'urgent' ? '#EF4444' : (t.priority === 'high' ? '#EAB308' : '#94A3B8')) : ''}
        ${(Array.isArray(t.tags) ? t.tags : []).filter(tag => tag !== 'chat').map(tag => badge('#' + tag, '#64748B')).join('')}
        <button class="btn-icon task-del" data-del-task="${esc(t.id)}" title="Delete this task, its reports and artifacts"
          style="margin-left:auto; padding:4px; background:none; border:none; cursor:pointer; line-height:0"><i data-lucide="trash-2" style="width:14px;height:14px;color:var(--text-muted)"></i></button>
      </div>
      <div style="margin:7px 0 3px"><strong style="font-size:1.02rem">${esc(t.title)}</strong></div>
      ${chainHtml}
      ${pendingHtml}
      ${autoRerunHtml}
      <div class="task-meta" style="display:block; margin:2px 0 4px">${esc(t.from?.platform || '?')}/${esc(t.from?.agent || '?')} · <span title="${esc(t.createdAt || '')}">${timeAgo(t.createdAt)}</span>
        ${failed ? `<button class="btn" data-rerun-task="${esc(t.id)}" data-agent="${esc(c.agentAuto ? '' : (c.agent || ''))}" title="Re-run this task — pick which agent claims it"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#EF4444;border-color:#EF444466">↻ Re-run</button>` : ''}
        ${t.status === 'pending' || t.status === 'scheduled' ? (() => {
          const cooling = /^Rate-limited\b/.test(pendingReason);
          const col = cooling ? '#F97316' : '#64748B';
          return `<button class="btn" data-reassign-task="${esc(t.id)}" data-agent="${esc(c.agentAuto ? '' : (c.agent || ''))}" title="Reassign — move this not-yet-started task to another agent"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:${col};border-color:${col}66">⇄ Reassign${cooling ? ' agent' : ''}</button>`;
        })() : ''}
        ${t.status === 'scheduled' ? `<button class="btn" data-run-now-task="${esc(t.id)}" title="Run now — release this scheduled task immediately instead of waiting for its run time"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#6366F1;border-color:#6366F166">▶ Run now</button>` : ''}
        ${t.status === 'done' && !failed ? (t.context?.continuedInto
          ? `<button class="btn" disabled title="Already continued — a follow-up task was spawned from this run"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#22C55E99;border-color:#22C55E33;opacity:.6;cursor:default">✓ Continued</button>`
          : `<button class="btn" data-continue-task="${esc(t.id)}" data-agent="${esc(agentLabel)}" title="Continue this task — spawn a follow-up seeded with this run's outputs; pick which agent claims it"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#22C55E;border-color:#22C55E66">▸ Continue</button>`) : ''}
        ${(t.worktree && !t.worktree.merged && !t.worktree.discarded) ? `<button class="btn" data-worktree-merge="${esc(t.id)}" title="Merge branch ${esc(t.worktree.branch)} into the main checkout's current branch (refused on conflicts or a dirty main checkout)"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#22C55E;border-color:#22C55E66">⑂ Merge</button>
        <button class="btn" data-worktree-discard="${esc(t.id)}" title="Discard this task's worktree and delete branch ${esc(t.worktree.branch)}"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#EF4444;border-color:#EF444466">🗑 Discard</button>` : ''}
        ${isTaskEditable(t) ? `<button class="btn" data-edit-task="${esc(t.id)}" title="Edit this task — change its title, brief, persona/agent, schedule and loop interval, then save"
          style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#0EA5E9;border-color:#0EA5E966">✎ Edit</button>` : ''}</div>
      ${this.recipeTaskCardHTML ? this.recipeTaskCardHTML(t, failed) : ''}
      ${parentLink ? `<div style="padding:4px 0 2px; font-size:0.72rem">${parentLink}</div>` : ''}
      ${(() => {
        // RESULT / OUTPUTS / ARTIFACTS / INPUTS live in one collapsible block, HIDDEN by
        // default — long file lists used to bury the card. Tapping anywhere on
        // the card toggles it (delegated .task-card handler in the constructor);
        // per-card open state is kept in this.taskFilesOpen so in-place
        // re-renders restore the user's choice instead of collapsing everything.
        // The human-in-the-loop interaction form rides in the SAME block, in the
        // LAST position (after INPUTS), so it is hidden by default with the same
        // tap-to-toggle behaviour; the card's "⌛ awaiting input" / "✓ input
        // received" badge above keeps it discoverable while collapsed.
        // The task ID / artifacts-folder row and the acceptance criteria ride at
        // the TOP of the same block — hidden by default, revealed on tap.
        const idsHtml = `<div class="task-ids" style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:4px 0 2px; font-size:0.72rem; color:var(--text-muted)">
          <span class="copyable" data-copy="${esc(t.id)}" title="Task ID — click to copy" style="cursor:pointer; font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
            <i data-lucide="hash" style="width:11px;height:11px;vertical-align:-1px"></i>${esc(t.id)}</span>
          <span class="copyable" data-copy="artifacts/${esc(t.id)}/" title="Artifacts directory — click to copy" style="cursor:pointer; font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
            <i data-lucide="folder" style="width:11px;height:11px;vertical-align:-1px"></i>artifacts/${esc(t.id)}/</span>
        </div>`;
        const hasAcceptance = Array.isArray(c.acceptance) && c.acceptance.length > 0;
        const acceptanceHtml = hasAcceptance ? `<div class="task-acceptance" style="margin:6px 0; padding:6px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:8px; font-size:0.8rem">
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px">
            <span style="font-weight:600; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); font-size:0.72rem">Acceptance criteria</span>
            ${c.acceptanceSource === 'sharpened' ? `<span class="badge" title="Generated by brief sharpener" style="background:#0EA5E918; color:#0EA5E9; border:1px solid #0EA5E940; font-size:0.68rem">sharpened</span>` : ''}
          </div>
          <ul style="margin:0; padding-left:16px; color:var(--text-secondary); line-height:1.4">
            ${c.acceptance.map(a => `<li>${esc(a)}</li>`).join('')}
          </ul>
        </div>` : '';
        const sectionStyle = 'display:flex; flex-wrap:wrap; align-items:center; gap:4px; padding:4px 0 2px';
        const sectionLabel = (text, size) => `<span style="font-size:${size}; color:var(--text-muted); margin-right:2px; text-transform:uppercase; letter-spacing:.03em">${text}</span>`;
        const resultHtml = hasResult ? `<div class="task-result" style="${sectionStyle}">${sectionLabel('Result', '0.85rem')}${artifactChip(t.id, 'result.md', '0.9rem')}</div>` : '';
        const outsHtml = outs.length ? `<div class="task-outputs" style="${sectionStyle}">${sectionLabel('Outputs', '0.85rem')}${artifactChips(t.id, outs, '0.9rem', 'outputs')}</div>` : '';
        const artsHtml = arts.length ? `<div class="task-artifacts" style="${sectionStyle}">${sectionLabel('Artifacts', '0.85rem')}${artifactChips(t.id, arts, '0.9rem', 'artifacts', t.artifactsTotal)}</div>` : '';
        const inputsHtml = (inputs.length || canAttach) ? `<div class="task-inputs" style="${sectionStyle}">${sectionLabel('Inputs', '0.72rem')}${inputs.map(f => artifactChip(t.id, f, '0.78rem', 'inputs')).join('')}${canAttach ? `<input type="file" data-attach-files="${esc(t.id)}" multiple style="display:none">
        <button class="btn" data-attach-input="${esc(t.id)}" title="Attach files for the agent to read" style="font-size:0.75rem;margin:0">＋ Attach files</button>` : ''}</div>` : '';
        // The interaction form (if any) is the LAST section inside the block.
        const interactionHtml = this.interactionBlock(t);
        const filesOpen = this.taskFilesOpen ? this.taskFilesOpen.has(t.id) : false;
        const nFiles = (hasResult ? 1 : 0) + outs.length + Math.max(arts.length, t.artifactsTotal || 0) + inputs.length;
        const headParts = [];
        if (progressHtml) headParts.push('live progress');
        if (nFiles) headParts.push(`${nFiles} file${nFiles === 1 ? '' : 's'}`);
        else if (!interactionHtml && !progressHtml) headParts.push('Details');
        if (hasAcceptance) headParts.push('acceptance');
        if (canAttach) headParts.push('＋ attach');
        if (interactionHtml) headParts.push('input');
        return `<div class="task-files" data-task-files="${esc(t.id)}"${filesOpen ? '' : ' hidden'} style="margin-top:2px">
          <div class="task-files-head" role="button" tabindex="0" aria-expanded="${filesOpen}" title="Tap the card to show / hide the live progress, task ID, acceptance criteria, files & input form" style="display:flex; align-items:center; gap:5px; padding:4px 0; cursor:pointer; user-select:none">
            <span class="task-files-caret" style="font-size:0.72rem; color:var(--text-muted)">${filesOpen ? '▾' : '▸'}</span>
            <span style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em">${headParts.join(' · ')}</span>
          </div>
          ${progressHtml}
          ${idsHtml}
          ${acceptanceHtml}
          ${resultHtml}
          ${outsHtml}
          ${artsHtml}
          ${inputsHtml}
          ${interactionHtml}
        </div>`;
      })()}
      ${t.claimedBy ? `<p style="font-size:0.8rem; color:var(--text-muted); margin-top:8px">Claimed by ${esc(this.workerLabel(t.claimedBy))}${t.completedAt ? ` · completed <span title="${esc(t.completedAt)}">${timeAgo(t.completedAt)}</span>` : ''}</p>` : ''}
    </div>`;
  }

  // Wire one task card's buttons (or every card, with root = the list). Called
  // on the full list by renderInbox and on a single fresh card by patchInboxTasks.
  bindTaskCards(root) {
    // Delete one task (+ its reports and artifacts).
    root.querySelectorAll('[data-del-task]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.delTask;
        const title = b.closest('[data-task]')?.dataset.title || id.slice(0, 8);
        if (!confirm(`Delete this task and its reports/artifacts?\n\n${title}`)) return;
        try {
          const r = await this.api.del(`/inbox/${encodeURIComponent(id)}`);
          this.toast('task deleted', `${r.reports} report(s)${r.artifacts ? ' + artifacts' : ''} removed`);
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); }
      }));

    // Re-run a failed task — pick which agent claims it, then reset to pending.
    root.querySelectorAll('[data-rerun-task]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.rerunTask;
        const title = b.closest('[data-task]')?.dataset.title || id.slice(0, 8);
        const choice = await this.pickAgent({
          title: 'Re-run this failed task',
          body: `<strong>${esc(title)}</strong> is reset to pending and dispatched again. Choose which agent should claim it — pick <em>Auto</em> to route from the top of the role's agent chain.`,
          defaultAgent: b.dataset.agent || '',
          confirmLabel: '↻ Re-run',
          confirmColor: '#EF4444'
        });
        if (!choice) return;
        b.disabled = true;
        try {
          const body = { agent: choice.agent };
          if (choice.thinking) body.thinking = choice.thinking;
          if (choice.scheduledAt) body.scheduledAt = choice.scheduledAt;
          await this.api.post(`/inbox/${encodeURIComponent(id)}/rerun`, body);
          const routeNote = choice.agent ? `pinned to ${choice.agent}` : 'auto-routed via the agent chain';
          this.toast('re-running', choice.scheduledAt ? `Scheduled for ${new Date(choice.scheduledAt).toLocaleString()} — ${routeNote}.` : `Reset to pending — ${routeNote}.`);
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); b.disabled = false; }
      }));

    // Reassign a pending/scheduled task (e.g. held on a rate-limited agent) to another agent.
    root.querySelectorAll('[data-reassign-task]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.reassignTask;
        const title = b.closest('[data-task]')?.dataset.title || id.slice(0, 8);
        const choice = await this.pickAgent({
          title: 'Reassign to another agent',
          body: `<strong>${esc(title)}</strong> hasn't started yet. Choose which agent should claim it instead — pick <em>Auto</em> to route from the top of the role's agent chain. Agents cooling down on a rate limit are marked ⏳.`,
          defaultAgent: '',
          confirmLabel: '⇄ Reassign',
          confirmColor: '#F97316',
          withSchedule: false
        });
        if (!choice) return;
        b.disabled = true;
        try {
          await this.api.post(`/inbox/${encodeURIComponent(id)}/reassign`, { agent: choice.agent, ...(choice.thinking ? { thinking: choice.thinking } : {}) });
          this.toast('reassigned', choice.agent ? `Pinned to ${choice.agent} — dispatched by the next tick.` : 'Auto-routed via the agent chain — dispatched by the next tick.');
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); b.disabled = false; }
      }));

    // Run now — release a scheduled task immediately instead of at its run time.
    root.querySelectorAll('[data-run-now-task]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.runNowTask;
        const title = b.closest('[data-task]')?.dataset.title || id.slice(0, 8);
        if (!confirm(`Run this scheduled task now?\n\n${title}`)) return;
        b.disabled = true;
        try {
          const t = await this.api.post(`/inbox/${encodeURIComponent(id)}/run-now`, {});
          this.toast('running now', t.status === 'wait-input'
            ? 'Released — parked for input; it dispatches once its questions are answered.'
            : 'Released to pending — dispatched by the next tick.');
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); b.disabled = false; }
      }));

    // Edit a task (not running / not pending) — load its params into a modal and save.
    root.querySelectorAll('[data-edit-task]').forEach(b =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editTaskModal(b.dataset.editTask);
      }));

    // Recipes: "★ Save as recipe" + 👍/👎 on recipe-made tasks (public/js/recipes.js).
    this.bindRecipeTaskCards?.(root);

    // Continue a done task — pick which agent claims the follow-up.
    root.querySelectorAll('[data-continue-task]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.continueTask;
        const title = b.closest('[data-task]')?.dataset.title || id.slice(0, 8);
        const choice = await this.pickAgent({
          title: 'Continue this task',
          body: `A follow-up to <strong>${esc(title)}</strong> is created with this run's output files and result attached as inputs. Add an optional prompt or extra files to steer it, then choose which agent claims it — <em>Auto</em> routes via the role's agent chain.`,
          defaultAgent: b.dataset.agent || '',
          confirmLabel: '▸ Continue',
          confirmColor: '#22C55E',
          withInputs: true
        });
        if (!choice) return;
        b.disabled = true;
        try {
          // Upload the staged extras first so the follow-up carries them as inputs.
          const inputs = choice.files?.length ? await this.uploadInputFiles(choice.files) : [];
          const body = { agent: choice.agent };
          if (choice.thinking) body.thinking = choice.thinking;
          if (choice.prompt) body.prompt = choice.prompt;
          if (inputs.length) body.inputs = inputs;
          if (choice.scheduledAt) body.scheduledAt = choice.scheduledAt;
          await this.api.post(`/inbox/${encodeURIComponent(id)}/continue`, body);
          const extras = [choice.prompt ? 'prompt' : null, inputs.length ? `${inputs.length} file(s)` : null].filter(Boolean).join(' + ');
          const routeNote = choice.agent ? `pinned to ${choice.agent}` : 'auto-routed via the agent chain';
          const timingNote = choice.scheduledAt ? `Scheduled for ${new Date(choice.scheduledAt).toLocaleString()}` : 'Follow-up queued';
          this.toast('continuing', `${timingNote} — ${routeNote}${extras ? ` · added ${extras}` : ''}.`);
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); b.disabled = false; }
      }));

    // Code-task worktree: merge its branch into main, or discard it.
    for (const [attr, key, verb, confirmMsg] of [
      ['[data-worktree-merge]', 'worktreeMerge', 'merge', 'Merge this task\'s branch into the main checkout\'s current branch?'],
      ['[data-worktree-discard]', 'worktreeDiscard', 'discard', 'Discard this task\'s worktree and DELETE its branch? Unmerged work is lost.']
    ]) {
      root.querySelectorAll(attr).forEach(b =>
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(confirmMsg)) return;
          b.disabled = true;
          try {
            const out = await this.api.post(`/inbox/${encodeURIComponent(b.dataset[key])}/worktree/${verb}`, {});
            this.toast(verb === 'merge' ? 'merged' : 'discarded', out?.message || 'done');
            this.renderInbox();
          } catch (err) { this.toast('error', err.message); b.disabled = false; }
        }));
    }

    // Attach input files to an existing task (upload → append to context.inputFiles).
    root.querySelectorAll('[data-attach-input]').forEach(b =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const inp = this.contentEl.querySelector(`[data-attach-files="${CSS.escape(b.dataset.attachInput)}"]`);
        if (inp) inp.click();
      }));
    root.querySelectorAll('[data-attach-files]').forEach(inp =>
      inp.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = inp.dataset.attachFiles;
        const files = Array.from(inp.files || []);
        if (!files.length) return;
        try {
          const attached = await this.uploadInputFiles(files);
          await this.api.post(`/inbox/${encodeURIComponent(id)}/inputs`, { inputs: attached });
          this.toast('files attached', `${attached.length} file(s) added — the agent will read them.`);
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); }
      }));

    // Submit human interaction (questions/checklist) from a task card.
    root.querySelectorAll('.interaction-submit').forEach(btn =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.ixTask;
        const box = btn.closest('.task-interaction');
        if (!box) return;
        const responses = {};
        box.querySelectorAll('[data-field]').forEach(el => {
          responses[el.dataset.field] = el.dataset.ftype === 'checkbox' ? el.checked : el.value;
        });
        // Catch blank required answers here so the user gets an inline pointer at
        // the offending field instead of an opaque server 400. Checkboxes are
        // never "required-empty" (mirrors the rule in store.submitInteraction).
        const missing = [...box.querySelectorAll('[data-field][data-required="1"]:not([data-ftype="checkbox"])')]
          .find(el => !String(el.value ?? '').trim());
        if (missing) {
          missing.focus();
          missing.style.borderColor = '#EF4444';
          this.toast('answer required', 'Please fill in the required field before submitting.');
          return;
        }
        const submittedBy = box.querySelector('[data-ix-by]')?.value.trim() || undefined;
        btn.disabled = true;
        try {
          await this.api.post(`/inbox/${encodeURIComponent(id)}/interaction`, { responses, submittedBy });
          this.toast('input submitted', 'The task now has your answers.');
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); btn.disabled = false; }
      }));

    // Click a task ID or artifacts path to copy it to the clipboard.
    root.querySelectorAll('[data-copy]').forEach(el =>
      el.addEventListener('click', async (e) => {
        e.stopPropagation();   // don't toggle the card
        const text = el.dataset.copy;
        if (await this.copyText(text)) this.toast('copied', text);
        else this.toast('copy failed', text);
      }));

    // Auto-rerun-on-reset toggle on a rate-limited failed task: persist the choice.
    root.querySelectorAll('[data-autorerun]').forEach(cb =>
      cb.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = cb.dataset.autorerun;
        const enabled = cb.checked;
        cb.disabled = true;
        try {
          await this.api.post(`/inbox/${encodeURIComponent(id)}/auto-rerun`, { enabled });
          this.toast('auto re-run', enabled
            ? 'On — Cowork will re-run this task automatically once the rate limit resets.'
            : 'Off — this task will not re-run automatically.');
        } catch (err) { this.toast('error', err.message); cb.checked = !enabled; }
        finally { cb.disabled = false; }
      }));
  }

  async renderInbox() {
    this.inboxLimit = this.inboxLimit || 50;
    // Filters + Purge collapse into a single toggle (the "+" New-task button
    // sits beside it, always visible) so the task list
    // stays reachable on small viewports. Default open on wide screens, collapsed
    // on narrow ones; the toggle then persists the choice for the session.
    if (this.inboxControlsOpen === undefined) this.inboxControlsOpen = window.innerWidth >= 640;
    const filter = this.inboxFilter;
    const fetchLimit = this.inboxLimit + 1;
    const q = filter ? `?status=${filter}&limit=${fetchLimit}` : `?limit=${fetchLimit}`;
    let [tasks, status] = await Promise.all([
      this.api.get(`/inbox${q}`),
      this.api.get('/status').catch(() => null),
      this.refreshWorkers()
    ]);

    let hasMore = false;
    if (tasks.length > this.inboxLimit) {
      hasMore = true;
      tasks = tasks.slice(0, this.inboxLimit);
    }

    // Per-status counts on the filter pills (from the dashboard summary; the
    // "done" pill excludes failed tasks, mirroring the server's done filter).
    const pills = ['', 'done', 'in-progress', 'pending', 'scheduled', 'wait-input', 'failed'].map(f => {
      const label = inboxPillLabel(f, status);
      const active = this.inboxFilter === f;
      const color = f === 'failed' ? '#EF4444' : (STATUS_COLORS[f] || '#94A3B8');
      let style = '';
      if (f === '') {
        style = active
          ? 'background:var(--bg-tertiary); border-color:var(--border-hover); color:var(--text-primary)'
          : '';
      } else {
        style = active
          ? `background:${color}18; border-color:${color}40; color:${color}`
          : `color:${color}`;
      }
      return `<button class="btn pill" data-filter="${f}" style="${style}">${esc(label)}</button>`;
    }).join(' ');

    const rows = tasks.length ? tasks.map(t => this.taskCardHTML(t)).join('')
      : `<div class="empty-state"><p>No tasks${this.inboxFilter ? ` with status "${esc(this.inboxFilter)}"` : ''}.</p></div>`;

    // #content is the scroll container — preserve the reading position across
    // SSE-driven re-renders instead of snapping back to the top.
    const scrollY = this.contentEl.scrollTop;
    const open = this.inboxControlsOpen;
    // Compact chip echoing the active status filter while controls are collapsed,
    // so the current view is still legible without expanding the panel.
    const activeChip = (!open && this.inboxFilter)
      ? `<span class="badge" style="background:var(--bg-tertiary); color:var(--text-muted); border:1px solid var(--border-hover)">${esc(this.inboxFilter)}</span>`
      : '';
    this.contentEl.innerHTML = `
      <div id="inbox-sticky">
      <div style="display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap">
        <button class="btn" id="inbox-controls-toggle" title="Show or hide the status filters and Purge controls"
          style="font-size:0.78rem; display:inline-flex; align-items:center; gap:6px">
          <i data-lucide="sliders-horizontal" style="width:14px;height:14px"></i>
          <span>Filters &amp; actions</span>
          <span class="ctrl-caret" style="color:var(--text-muted)">${open ? '▾' : '▸'}</span>
        </button>
        <button class="btn" id="new-task-btn" title="New task — create and dispatch a task" aria-label="New task"
          style="font-size:1rem; font-weight:600; line-height:1; padding:4px 10px; color:#22C55E; border-color:#22C55E66">+</button>
        ${activeChip}
      </div>
      <div id="inbox-controls" style="display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap;${open ? '' : ' display:none;'}">${pills}
        <span style="margin-left:auto; display:flex; gap:6px; align-items:center; flex-wrap:wrap">
          <span style="font-size:0.75rem;color:var(--text-muted)">purge done &gt;</span>
          <input id="purge-days" type="number" min="0" value="30" style="width:58px;padding:4px 6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.78rem">
          <span style="font-size:0.75rem;color:var(--text-muted)">days</span>
          <button class="btn" id="purge-btn" title="Delete finished tasks older than N days — including ones with artifacts. Only keep/important/pinned-tagged tasks are spared. You'll be asked to confirm." style="font-size:0.75rem">Purge…</button>
        </span>
      </div>
      <input id="inbox-search" type="search" placeholder="Search titles…" value="${esc(this.inboxSearch || '')}"
        style="width:100%; margin-bottom:0; padding:8px 12px; background:var(--bg-tertiary); border:1px solid var(--bg-tertiary); border-radius:10px; color:inherit; font:inherit; font-size:0.85rem">
      </div>
      <div id="inbox-nomatch" style="display:none; color:var(--text-muted); font-size:0.85rem; padding:8px 0">No task titles match your search.</div>
      ${rows}
      ${hasMore ? `<div id="inbox-load-more" style="text-align:center; margin-top:20px; margin-bottom:20px; color:var(--text-muted); font-size:0.85rem;">Loading more tasks...</div>` : ''}`;
    this.contentEl.scrollTop = scrollY;

    this.contentEl.querySelectorAll('[data-filter]').forEach(b =>
      b.addEventListener('click', () => { this.inboxLimit = 50; this.inboxFilter = b.dataset.filter; this.renderInbox(); }));

    // Collapse/expand the filters + actions panel (toggled in place, no refetch).
    const ctrlToggle = this.contentEl.querySelector('#inbox-controls-toggle');
    ctrlToggle?.addEventListener('click', () => {
      this.inboxControlsOpen = !this.inboxControlsOpen;
      const panel = this.contentEl.querySelector('#inbox-controls');
      if (panel) panel.style.display = this.inboxControlsOpen ? 'flex' : 'none';
      const caret = ctrlToggle.querySelector('.ctrl-caret');
      if (caret) caret.textContent = this.inboxControlsOpen ? '▾' : '▸';
    });
      
    const loadMoreEl = this.contentEl.querySelector('#inbox-load-more');
    if (loadMoreEl) {
      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          this.inboxLimit += 50;
          this.renderInbox();
        }
      });
      observer.observe(loadMoreEl);
    }

    // Live client-side title filter, layered on top of the status filter.
    const searchEl = this.contentEl.querySelector('#inbox-search');
    searchEl.addEventListener('input', () => { this.inboxSearch = searchEl.value; this.applyInboxSearch(); });

    this.bindTaskCards(this.contentEl);

    // Create + dispatch a new task straight from the Inbox (no Chat detour).
    this.contentEl.querySelector('#new-task-btn')?.addEventListener('click', () => this.createTaskModal());

    // Purge: always preview with a dry run, then ask before deleting.
    this.contentEl.querySelector('#purge-btn')?.addEventListener('click', async () => {
      const days = Number(this.contentEl.querySelector('#purge-days').value || 30);
      try {
        const preview = await this.api.post('/inbox/purge', { olderThanDays: days, dryRun: true });
        if (!preview.purged.length) { this.toast('nothing to purge', `no finished tasks older than ${days} days (kept ${preview.keptCount})`); return; }
        const sample = preview.purged.slice(0, 8).map(p => `• ${p.title}`).join('\n');
        const more = preview.purged.length > 8 ? `\n…and ${preview.purged.length - 8} more` : '';
        if (!confirm(`⚠ Purge ${preview.purged.length} finished task(s) older than ${days} days?\n\nEvery finished task past ${days} days is removed — INCLUDING ones that produced artifacts. Only ${preview.keptCount} kept (unfinished, recent, or tagged keep/important/pinned).\n\n${sample}${more}\n\nTheir reports and artifacts are permanently deleted. This cannot be undone.`)) return;
        const done = await this.api.post('/inbox/purge', { olderThanDays: days });
        this.toast('purged', `${done.purged.length} task(s), ${done.reportsDeleted} report(s) removed`);
        this.renderInbox();
      } catch (err) { this.toast('error', err.message); }
    });

    // Live progress log for in-progress cards: poll GET /inbox/:id/progress and
    // stream the tail into each card's <pre data-progress>. One shared interval,
    // cleared on re-render and on leaving the view (clearViewTimers).
    clearInterval(this._progressPoll);
    this._progressPoll = null;
    this.ensureInboxProgressPoll();

    // Task cards no longer expand on click — RESULT and DESCRIPTION now live as
    // result.md / description.md chips (opened in the markdown viewer), so there is
    // no detail panel to toggle.

    this.applyInboxSearch();
    if (this.pendingTask) this.focusInboxTask();

    // renderInbox() is called directly by the filter pills, delete/purge/search
    // and load-more handlers — NOT only through renderCurrentView() (which has its
    // own trailing createIcons()). Each of those re-renders innerHTML with fresh
    // `<i data-lucide>` placeholders, so we must re-hydrate the Lucide glyphs here
    // or every icon vanishes on filter click until a full page refresh.
    createIcons();
  }

  ensureInboxProgressPoll() {
    if (this._progressPoll || !this.contentEl.querySelector('[data-progress]')) return;
    this.pollInboxProgress();
    this._progressPoll = setInterval(() => this.pollInboxProgress(), 2500);
  }

  /**
   * SSE path for the Tasks view: redraw only the cards whose tasks changed
   * instead of re-fetching /inbox and rebuilding all ~50 cards (each with its
   * listeners and icons) on every event. Per id: GET /inbox/:id, then replace the
   * card in place, drop it (deleted / no longer matches the filter) or slot a new
   * one in by createdAt. Anything it can't place falls back to a full render.
   */
  async patchInboxTasks(ids) {
    const onInbox = () => this.currentPage?.type === 'tasks' && !!this.contentEl.querySelector('#inbox-sticky');
    const statusP = this.api.get('/status').catch(() => null);
    const fetched = await Promise.all(ids.map(id => this.api.get(`/inbox/${encodeURIComponent(id)}`)
      .then(t => ({ id, t }), err => ({ id, t: null, gone: /not found|404/i.test(err.message || '') }))));
    if (fetched.some(f => f.t?.claimedBy && !this.workers.has(f.t.claimedBy))) await this.refreshWorkers();
    if (!onInbox()) return;   // navigated away while fetching
    let full = false;
    for (const { id, t, gone } of fetched) {
      const card = this.contentEl.querySelector(`.task-card[data-task="${CSS.escape(id)}"]`);
      if (!t && !gone) { full = true; continue; }           // fetch error — let a full render sort it out
      if (!t || !inboxFilterMatches(t, this.inboxFilter)) { card?.remove(); continue; }
      // Don't wipe a half-typed answer in this card's input form; retry on the next event.
      const el = document.activeElement;
      if (card && card.contains(el) && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) {
        (this._inboxDirty ||= new Set()).add(id);
        continue;
      }
      const tpl = document.createElement('template');
      tpl.innerHTML = this.taskCardHTML(t).trim();
      const fresh = tpl.content.firstElementChild;
      this.bindTaskCards(fresh);
      createIcons(fresh);
      if (card) {
        // Carry the live log over so it doesn't blink back to "Loading live output…".
        const oldPre = card.querySelector('[data-progress]'), newPre = fresh.querySelector('[data-progress]');
        if (oldPre && newPre) newPre.textContent = oldPre.textContent;
        card.replaceWith(fresh);
        if (oldPre && newPre) newPre.scrollTop = oldPre.scrollTop;
        continue;
      }
      // New to this list: slot it in newest-first. Older than every card on the
      // page while more pages exist → it belongs to a later page, skip it.
      const ms = Date.parse(t.createdAt);
      const cards = [...this.contentEl.querySelectorAll('.task-card[data-task]')];
      if (!cards.length || Number.isNaN(ms)) { full = true; continue; }
      const next = cards.find(c => !(Date.parse(c.dataset.created) >= ms));
      if (next) next.before(fresh);
      else if (!this.contentEl.querySelector('#inbox-load-more')) cards[cards.length - 1].after(fresh);
    }
    if (full || !this.contentEl.querySelector('.task-card')) { await this.renderInbox(); return; }
    const status = await statusP;
    if (status && onInbox()) {
      this.contentEl.querySelectorAll('#inbox-controls [data-filter]').forEach(b => { b.textContent = inboxPillLabel(b.dataset.filter, status); });
    }
    this.applyInboxSearch();
    this.ensureInboxProgressPoll();
  }

  // Fetch the live progress tail for every in-progress card currently on screen and
  // stream it into the card's <pre data-progress>, auto-scrolling to the newest line.
  // Driven by a 2.5s interval set up at the end of renderInbox().
  async pollInboxProgress() {
    const els = Array.from(this.contentEl.querySelectorAll('[data-progress]'));
    if (!els.length) { clearInterval(this._progressPoll); this._progressPoll = null; return; }
    await Promise.all(els.map(async (el) => {
      const id = el.dataset.progress;
      try {
        const p = await this.api.get(`/inbox/${encodeURIComponent(id)}/progress`);
        // Keep the view pinned to the bottom only when the user is already there, so
        // scrolling up to read earlier output isn't yanked back down on each poll.
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        const txt = (p.log || '').replace(/\s+$/, '');
        el.textContent = txt || (p.running ? 'Running — no output captured yet…' : 'No live output captured for this run.');
        if (atBottom) el.scrollTop = el.scrollHeight;

        // Detect if task is currently under context compaction
        let isCompacting = false;
        let compactionStatus = '⏳ Compacting context…';
        if (p.running && txt) {
          const activeKeywords = [
            'Context threshold crossed',
            'Prefilling context',
            'Generating summary',
            'Context compaction initiated',
            'Context compaction in progress'
          ];
          const doneKeywords = [
            'Context compaction complete',
            'Summary generation finished'
          ];
          let lastActiveIdx = -1;
          for (const kw of activeKeywords) {
            const idx = txt.lastIndexOf(kw);
            if (idx > lastActiveIdx) lastActiveIdx = idx;
          }
          let lastDoneIdx = -1;
          for (const kw of doneKeywords) {
            const idx = txt.lastIndexOf(kw);
            if (idx > lastDoneIdx) lastDoneIdx = idx;
          }
          if (lastActiveIdx !== -1 && lastActiveIdx > lastDoneIdx) {
            isCompacting = true;
            const lines = txt.split('\n');
            const lastLine = [...lines].reverse().find(l => /\[Compaction\]|Context compaction/i.test(l)) || '';
            if (/Prefill/i.test(lastLine)) {
              compactionStatus = '⏳ Compacting context (prefilling)…';
            } else if (/Generating/i.test(lastLine)) {
              compactionStatus = '⏳ Compacting context (generating summary)…';
            }
          }
        }
        const labelEl = this.contentEl.querySelector(`[data-progress-label="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
        const pulseEl = this.contentEl.querySelector(`[data-progress-pulse="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
        if (labelEl) {
          if (isCompacting) {
            labelEl.textContent = `Live progress — ${compactionStatus}`;
            labelEl.style.color = '#F59E0B';
            if (pulseEl) pulseEl.style.background = '#F59E0B';
          } else {
            labelEl.textContent = "Live progress — what it's doing right now";
            labelEl.style.color = '';
            if (pulseEl) pulseEl.style.background = '#0EA5E9';
          }
        }
        // "last activity Ns ago" — makes a stalled run (no new output) obvious.
        const age = this.contentEl.querySelector(`[data-progress-age="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
        if (age && p.updatedAt) {
          const secs = Math.max(0, Math.round((Date.now() - Date.parse(p.updatedAt)) / 1000));
          age.textContent = `last activity ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`} ago`;
        }
      } catch { /* transient fetch error — keep the last text, retry next tick */ }
    }));
  }

  // Deep-link target from a task's OUTPUT panel (#tasks/<taskId>): scroll
  // that task into view and flash it. If it's not on the current page
  // (older than the loaded window, or hidden by a status filter), widen the net
  // once — clear the filter and raise the limit — then retry.
  focusInboxTask() {
    const id = this.pendingTask;
    if (!id) return;
    const card = this.contentEl.querySelector(`[data-task="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
    if (card) {
      this.pendingTask = null;
      this._focusRetried = false;
      card.style.display = '';                 // in case a stale search hid it
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('task-flash');
      setTimeout(() => card.classList.remove('task-flash'), 2200);
      createIcons();
    } else if (!this._focusRetried) {
      this._focusRetried = true;
      this.inboxFilter = '';
      this.inboxSearch = '';
      this.inboxLimit = 500;
      this.renderInbox();
    } else {
      this._focusRetried = false;
      this.pendingTask = null;
      this.toast('task not found', id.slice(0, 8) + '… may have been purged');
    }
  }

  // Show only task cards whose title contains the search text (case-insensitive).
  applyInboxSearch() {
    const q = (this.inboxSearch || '').trim().toLowerCase();
    const cards = this.contentEl.querySelectorAll('[data-task]');
    let shown = 0;
    cards.forEach(card => {
      const match = !q || (card.dataset.title || '').includes(q);
      card.style.display = match ? '' : 'none';
      if (match) shown++;
    });
    const note = this.contentEl.querySelector('#inbox-nomatch');
    if (note) note.style.display = (q && shown === 0 && cards.length) ? '' : 'none';
  }

  // Goals page: see goals-view.js (extends App.prototype).

  // ── Reports ────────────────────────────────────────────────────────────

  // ── Roster ─────────────────────────────────────────────────────────────

  async renderRoster() {
    const roster = await this.api.get('/roster');
    const byDivision = {};
    for (const a of roster) (byDivision[a.divisionLabel || a.division || 'other'] ||= []).push(a);

    this.contentEl.innerHTML = `
      <input id="roster-search" class="roster-search" placeholder="Search ${roster.length} personas…">
      <div id="roster-list"></div>`;

    const listEl = this.contentEl.querySelector('#roster-list');
    const render = (filter) => {
      const f = (filter || '').toLowerCase();
      listEl.innerHTML = Object.entries(byDivision).map(([div, personas]) => {
        const hits = f ? personas.filter(a =>
          a.name.toLowerCase().includes(f) || (a.description || '').toLowerCase().includes(f)) : personas;
        if (!hits.length) return '';
        return `<h3 style="margin: var(--space-lg) 0 var(--space-md); font-size:0.95rem">${esc(div)} <span style="color:var(--text-muted); font-size:0.8rem; font-weight:400">(${hits.length})</span></h3>
          <div class="grid-3">` + hits.map(a => `
          <div class="card agent-card">
            <div class="agent-header">
              <span class="agent-title">${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.name)}</span>
            </div>
            <p style="font-size:0.83rem; color:var(--text-secondary); margin-top:6px">${esc((a.description || '').slice(0, 140))}</p>
            ${a.vibe ? `<p style="font-size:0.8rem; font-style:italic; color:var(--text-muted); margin-top:6px">${esc(a.vibe)}</p>` : ''}
          </div>`).join('') + `</div>`;
      }).join('') || `<div class="empty-state"><p>No personas match.</p></div>`;
      createIcons();
    };
    render('');
    this.contentEl.querySelector('#roster-search').addEventListener('input', (e) => render(e.target.value));
  }

  // ── Agents: special executors + roster divisions (with agent chains) ───────

  async renderTeam() {
    const [special, agents, chains, divisions] = await Promise.all([
      this.api.get('/roles-config'), this.api.get('/agents'), this.api.get('/chains'), this.api.get('/roster-divisions')
    ]);
    const tiers = chains.tiers || {};
    const TIERS = [
      ['mechanical', 'Mechanical', 'Lookups, formatting, simple edits.'],
      ['standard', 'Standard', 'Most features, fixes and research.'],
      ['judgment', 'Judgment', 'Architecture, prose, hard calls; also prepended when a gated step escalates.'],
    ];
    const defaultChain = chains.defaultChain || [];
    const enabledCount = selectableAgentIds(agents).length;
    const totalCount = Object.keys(agents).length;
    const h3 = (title, hint) => `<h3 style="font-size:0.9rem;margin:var(--space-lg) 0 6px">${title}${hint ? ` <span style="font-size:0.72rem;color:var(--text-muted);font-weight:400">${hint}</span>` : ''}</h3>`;
    const card = (body, attrs = '') => `<div class="card" style="margin-bottom:var(--space-md)" ${attrs}>${body}</div>`;
    const head = (title, right) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>${title}</strong>${right || ''}</div>`;
    const muted = (t) => `<span style="font-size:0.75rem;color:var(--text-muted)">${t}</span>`;
    const link = (attr, label) => `<a ${attr} style="cursor:pointer;font-size:0.72rem;color:var(--text-muted)">${label}</a>`;

    // Ctx strings: "<kind>:<key>". Parsed once here; every save/lookup uses this.
    const parse = (ctx) => { const i = ctx.indexOf(':'); return i < 0 ? [ctx, ''] : [ctx.slice(0, i), ctx.slice(i + 1)]; };
    const chainOf = (ctx) => {
      const [kind, key] = parse(ctx);
      return ([...(kind === 'role' ? special[key]?.agents
        : kind === 'tier' ? tiers[key]
        : kind === 'default' ? defaultChain
        : kind === 'div' ? chains.divisionChains?.[key]
        : kind === 'persona' ? chains.personaChains?.[key] : null) || []]);
    };

    const roleCards = Object.entries(special).map(([n, a]) => card(
      head(esc(n), badge('role', '#0EA5E9'))
      + `<p style="font-size:0.8rem;color:var(--text-muted);margin:4px 0">${esc(a.description || '')}</p>`
      + chainEditor(a.agents, agents, 'role:' + n))).join('');

    const tierCards = TIERS.map(([t, label, hint]) => card(
      head(esc(label), badge('tier', '#8B5CF6'))
      + `<p style="font-size:0.8rem;color:var(--text-muted);margin:4px 0">${esc(hint)} Tried first, then the persona's normal chain.</p>`
      + chainEditor(tiers[t], agents, 'tier:' + t))).join('');

    const personaRow = (p, division) => {
      const own = chains.personaChains?.[p.slug];
      const parent = chains.divisionChains?.[division] ? 'division chain' : 'default chain';
      return `<div class="persona-row" data-name="${esc(((p.name || '') + ' ' + p.slug).toLowerCase())}" style="padding:6px 0;border-top:1px solid var(--bg-tertiary)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:0.82rem">${p.emoji ? esc(p.emoji) + ' ' : ''}${esc(p.name || p.slug)}</span>
          ${own ? `<span>${badge('own chain', AGENT_COLOR)} ${link(`data-reset="persona:${esc(p.slug)}"`, '↺ reset to ' + parent)}</span>`
            : `<span style="display:flex;gap:8px;align-items:center">${muted('inherits ' + parent)}${chainAddSelect([], agents, `data-chain-add="persona:${esc(p.slug)}"`, '+ override with…')}</span>`}
        </div>
        ${own ? chainEditor(own, agents, 'persona:' + p.slug) : ''}
      </div>`;
    };

    const divCards = Object.entries(divisions).sort(([a], [b]) => a.localeCompare(b)).map(([d, info]) => {
      const override = chains.divisionChains?.[d];
      const personas = info.personas || [];
      const nOwn = personas.filter(p => chains.personaChains?.[p.slug]).length;
      return card(
        head(esc(info.label || d), `<span style="display:flex;gap:6px;align-items:center">${muted(`${personas.length} personas${nOwn ? ` · ${nOwn} own chain${nOwn > 1 ? 's' : ''}` : ''}`)}${override ? badge('override', AGENT_COLOR) : badge('default chain', '#94A3B8')}</span>`)
        + (override
          ? chainEditor(override, agents, 'div:' + d) + link(`data-reset="div:${esc(d)}"`, '↺ reset to default chain')
          : `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Uses the default chain:</div>${chainPreview(defaultChain, agents)}`
            + chainAddSelect([], agents, `data-chain-add="div:${esc(d)}"`, '+ override with…'))
        + `<details data-div="${esc(d)}" style="margin-top:8px"><summary style="cursor:pointer;font-size:0.75rem;color:var(--text-muted)">Per-persona overrides (${nOwn}/${personas.length})</summary>
            ${personas.map(p => personaRow(p, d)).join('') || '<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0">no personas</div>'}
          </details>`,
        `data-div-card="${esc(d)}" data-name="${esc(((info.label || '') + ' ' + d).toLowerCase())}"`);
    }).join('');

    this.contentEl.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:6px">Each task runs on an <b>agent fallback chain</b>, tried in order until one succeeds. Which chain: a special <b>role</b> uses its own; otherwise a <b>persona</b> override wins over its <b>division</b>, then the <b>default</b>. A tier-tagged task tries its <b>tier</b> first. Changes save instantly.</p>
      <p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:var(--space-md)">${enabledCount} of ${totalCount} agents enabled — pickers list only enabled agents; disabled ones in a chain are shown struck through and skipped. Enable/disable on the <a href="#agents">Agents</a> page.</p>
      ${h3('Special roles', '— run directly, not via a persona')}${roleCards || muted('none configured')}
      ${h3('Default chain', '— same chain as on the Agents page')}${card(chainEditor(defaultChain, agents, 'default:', { emptyText: 'empty — tasks with no override have nowhere to run' }))}
      ${h3('Work-role tiers', '— the router picks a tier per task; <i>review</i> is derived from these at runtime')}${tierCards}
      ${h3('Divisions', '— chain override per division and per persona')}
      <input id="routing-filter" class="roster-search" placeholder="Filter divisions / personas…" style="margin-bottom:var(--space-md)">
      <div id="routing-divs">${divCards}</div>
      <div id="routing-nomatch" class="empty-state" style="display:none"><p>No division or persona matches.</p></div>`;

    const save = async (ctx, arr) => {
      const [kind, key] = parse(ctx);
      const k = encodeURIComponent(key);
      try {
        if (kind === 'role') await this.api.put(`/roles-config/${k}`, { description: special[key]?.description, agents: arr });
        else if (kind === 'tier') await this.api.put(`/chains/tier/${k}`, { agents: arr });
        else if (kind === 'default') await this.api.put('/chains/default', { agents: arr });
        else if (kind === 'div') await this.api.put(`/chains/division/${k}`, { agents: arr });
        else if (kind === 'persona') await this.api.put(`/chains/persona/${k}`, { agents: arr });
        else throw new Error(`unknown chain "${ctx}"`);
      } catch (e) { this.toast('chain not saved', e.message); }
      // Re-render but keep the user's place: scroll, open persona lists, filter.
      const scroll = this.contentEl.scrollTop;
      const open = [...this.contentEl.querySelectorAll('details[data-div][open]')].map(x => x.dataset.div);
      const filter = this.contentEl.querySelector('#routing-filter')?.value || '';
      await this.renderTeam();
      open.forEach(d => this.contentEl.querySelector(`details[data-div="${CSS.escape(d)}"]`)?.setAttribute('open', ''));
      const f = this.contentEl.querySelector('#routing-filter');
      if (f && filter) { f.value = filter; f.dispatchEvent(new Event('input')); }
      this.contentEl.scrollTop = scroll;
    };

    this.wireChainEditors(this.contentEl, chainOf, save);
    if (window.lucide) window.lucide.createIcons();
    this.contentEl.querySelectorAll('[data-reset]').forEach(a => a.addEventListener('click', () => save(a.dataset.reset, [])));

    // Filter: a division matches by name (shows all its personas) or via any persona.
    this.contentEl.querySelector('#routing-filter').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      let shown = 0;
      this.contentEl.querySelectorAll('[data-div-card]').forEach(c => {
        const divHit = !q || c.dataset.name.includes(q);
        let personaHit = false;
        c.querySelectorAll('.persona-row').forEach(r => {
          const hit = divHit || r.dataset.name.includes(q);
          r.style.display = hit ? '' : 'none';
          if (q && r.dataset.name.includes(q)) personaHit = true;
        });
        const vis = divHit || personaHit;
        c.style.display = vis ? '' : 'none';
        if (vis) shown++;
        const det = c.querySelector('details');
        if (q && personaHit && !divHit && det) det.open = true;
      });
      this.contentEl.querySelector('#routing-nomatch').style.display = shown ? 'none' : '';
    });
  }

  // ── Agents (model × platform × location registry) ──────────────────────

  async renderAgents() {
    const [agents, chains, dispatcherInfo] = await Promise.all([this.api.get('/agents'), this.api.get('/chains'), this.api.get('/dispatcher').catch(() => ({}))]);
    const defaultThinking = dispatcherInfo.defaultThinking || 'medium';
    // Default fallback chain — the shared chain editor (same one the Routing page uses).
    const defaultChainCard = `
      <div class="card" style="margin-bottom:var(--space-lg)">
        <div style="font-size:0.9rem;font-weight:600">Default fallback chain <span style="font-size:0.72rem;color:var(--text-muted);font-weight:400">— drag to reorder; used unless a division or persona overrides it (see <a href="#routing">Routing</a>)</span></div>
        ${chainEditor(chains.defaultChain, agents, 'default', { emptyText: 'empty — add an agent below', addLabel: '+ add to chain…' })}
      </div>`;
    const row = (id, b) => `
      <div class="card" style="margin-bottom:var(--space-md)${b.disabled ? ';opacity:0.55' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <strong>${esc(id)}</strong>
          ${badge(b.location, b.location === 'remote' ? '#EAB308' : '#22C55E')}
          ${b.dynamic ? badge('auto', '#0EA5E9') : ''}
          ${b.disabled ? badge('disabled', '#EF4444') : ''}
          <button class="btn" data-act="toggle-agent" data-id="${esc(id)}" data-disabled="${b.disabled ? '1' : ''}" style="font-size:0.75rem;margin-left:auto;${b.disabled ? 'color:#22C55E;border-color:#22C55E66' : 'color:#EAB308;border-color:#EAB30866'}">${b.disabled ? 'Enable' : 'Disable'}</button>
          <button class="btn" data-act="del-agent" data-id="${esc(id)}" style="font-size:0.75rem">Deregister</button>
        </div>
        <p style="font-size:0.82rem;color:var(--text-secondary);margin:4px 0">${esc(b.description || '')}</p>
        <div style="font-size:0.78rem;color:var(--text-muted)">${esc(b.exec || '')}${b.model ? ' · ' + esc(b.model) : ''}${b.host ? ' · host ' + esc(b.host) : ''}</div>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-muted);margin-top:6px">Thinking
          <select data-act="set-thinking" data-id="${esc(id)}" style="padding:3px 6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:6px;color:inherit;font-size:0.78rem">${thinkingOptions(b.thinking || '', defaultThinking)}</select>
        </label>
      </div>`;
    const fld = (id, ph) => `<input id="nb-${id}" placeholder="${ph}" style="padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem">`;
    this.contentEl.innerHTML = `
      <div class="card" style="margin-bottom:var(--space-lg)">
        <div style="font-size:0.85rem;font-weight:600;margin-bottom:6px">Register / update an agent</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px">
          ${fld('id', 'id (e.g. remote-laptop-cc-sonnet)')}
          <select id="nb-location" style="padding:6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem"><option value="local">local</option><option value="remote">remote</option></select>
          <select id="nb-exec" style="padding:6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem"><option value="claude">claude</option><option value="hermes">hermes</option><option value="agy">agy</option><option value="script">script</option></select>
          ${fld('model', 'model id')}
          <select id="nb-thinking" aria-label="Thinking" style="padding:6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem">${thinkingOptions('', defaultThinking)}</select>
          ${fld('host', 'host (remote only)')}
          ${fld('desc', 'description')}
        </div>
        <button class="btn btn-primary" id="nb-save" style="margin-top:8px;font-size:0.8rem">Save agent</button>
      </div>
      ${defaultChainCard}
      ${Object.entries(agents).map(([id, b]) => row(id, b)).join('') || '<div class="empty-state"><p>No agents registered.</p></div>'}`;

    if (window.lucide) window.lucide.createIcons();

    // ── Default chain: drag-to-reorder + add/remove, persisted on change ──────
    const saveDefault = async (_ctx, arr) => {
      try { await this.api.put('/chains/default', { agents: arr }); }
      catch (e) { this.toast('chain not saved', e.message); }
      const scroll = this.contentEl.scrollTop;
      await this.renderAgents();
      this.contentEl.scrollTop = scroll;
    };
    this.wireChainEditors(this.contentEl, () => [...(chains.defaultChain || [])], saveDefault);

    this.contentEl.querySelector('#nb-save').addEventListener('click', async () => {
      const g = id => this.contentEl.querySelector(`#nb-${id}`).value.trim();
      const id = g('id'); if (!id) { this.toast('error', 'agent id required'); return; }
      try {
        await this.api.put(`/agents/${encodeURIComponent(id)}`, {
          description: g('desc') || id, location: this.contentEl.querySelector('#nb-location').value,
          exec: this.contentEl.querySelector('#nb-exec').value, model: g('model'), host: g('host') || undefined,
          thinking: this.contentEl.querySelector('#nb-thinking').value || undefined
        });
        this.toast('agent saved', id); this.renderAgents();
      } catch (e) { this.toast('error', e.message); }
    });
    this.contentEl.querySelectorAll('[data-act="set-thinking"]').forEach(s => s.addEventListener('change', async () => {
      try {
        await this.api.patch(`/agents/${encodeURIComponent(s.dataset.id)}/thinking`, { thinking: s.value });
        this.toast('thinking updated', `${s.dataset.id}: ${s.value || `default (${defaultThinking})`}`);
      } catch (e) { this.toast('error', e.message); }
    }));
    this.contentEl.querySelectorAll('[data-act="del-agent"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      if (!confirm(`Deregister agent "${id}"? It will be removed from every chain.`)) return;
      const r = await this.api.del(`/agents/${encodeURIComponent(id)}`);
      this.toast('agent removed', `${id} (scrubbed from ${r.agents_scrubbed} chain(s))`);
      this.renderAgents();
    }));
    this.contentEl.querySelectorAll('[data-act="toggle-agent"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const isDisabled = b.dataset.disabled === '1';
      const action = isDisabled ? 'enable' : 'disable';
      try {
        await this.api.patch(`/agents/${encodeURIComponent(id)}/${action}`);
        this.toast(isDisabled ? 'agent enabled' : 'agent disabled', id);
        this.renderAgents();
      } catch (e) { this.toast('error', e.message); }
    }));
  }

  // ── Portal (launcher for local self-hosted web services) ────────────────

  async renderPortal(page = {}) {
    // { path, accent, categories, services, errors, controlEnabled } — the
    // server has already validated portal.json; errors are surfaced, not fatal.
    const portal = await this.api.get('/portal');
    // A layout portal page may narrow the catalog to some categories/keys, so one
    // portal.json can back several pages ("Models", "Dev tools", …).
    const filtered = !!(page.categories?.length || page.keys?.length);
    const services = this.portalServices(portal, page);

    // portal.json problems (bad JSON, invalid url/icon/unit) — shown above the
    // cards so a typo is visible instead of a card silently vanishing.
    const errorBox = (portal.errors || []).length ? `
      <div class="card portal-errors">
        <strong><i data-lucide="triangle-alert"></i> portal.json has ${portal.errors.length} problem${portal.errors.length > 1 ? 's' : ''}</strong>
        <ul>${portal.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
      </div>` : '';

    if (!services.length) {
      this.contentEl.innerHTML = `${this.layoutErrorBox()}${errorBox}<div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="layout-grid"></i></div>
        <h3>No services yet</h3>
        ${filtered
          ? `<p>This page only shows ${page.categories?.length ? `categories <code>${esc(page.categories.join(', '))}</code>` : ''}${page.categories?.length && page.keys?.length ? ' and ' : ''}${page.keys?.length ? `keys <code>${esc(page.keys.join(', '))}</code>` : ''}
             from <code>${esc(portal.path || 'portal.json')}</code>, and none match. Adjust the filter in <code>${esc(this.layout?.path || 'layout.json')}</code>.</p>`
          : `<p>Add entries to the <code>services</code> block of <code>${esc(portal.path || 'portal.json')}</code> — each entry
             <code>{ "url": "http://localhost:8081", "label": "Mautic", "icon": "megaphone", "category": "Marketing" }</code>
             shows up here as a launch card.</p>`}
      </div>`;
      return;
    }

    // Group by category, preserving portalServices()' category order.
    const groups = new Map();
    for (const s of services) {
      if (!groups.has(s.category)) groups.set(s.category, []);
      groups.get(s.category).push(s);
    }
    const sections = [...groups.keys()].map(cat => `
      <div class="portal-section">
        <h3 class="section-title" style="margin-bottom:var(--space-md)">${esc(cat)}
          <span style="color:var(--text-muted); font-weight:400">· ${groups.get(cat).length}</span>
        </h3>
        <div class="grid-3">${groups.get(cat).map(s => this.portalCard(s)).join('')}</div>
      </div>`).join('');

    const intro = page.intro
      ? `<div class="layout-intro">${md(page.intro)}</div>`
      : `<p style="color:var(--text-secondary); font-size:0.875rem; margin-bottom:var(--space-lg)">
        Quick-launch the local web services running on this host. Cards come from
        <code>${esc(portal.path || 'portal.json')}</code> — edit it and refresh, no restart needed.
        Status dots are probed from the server every 3s.
      </p>`;
    this.contentEl.innerHTML = `${intro}${this.layoutErrorBox()}${errorBox}${sections}`;

    this.wireServiceControls(this.contentEl);
    // Paint the last known statuses immediately (no flash on re-render), then
    // keep them fresh every 3s for as long as we're on the Portal.
    if (this.svcStatus) this.applyServiceStatus(this.svcStatus);
    this.startServicePolling();
  }

  /**
   * Normalise portal.json into card models, sorted by category order then
   * `order`/label, optionally narrowed by a layout `{ categories, keys }` filter
   * (Portal pages and the Overview `services` widget share this).
   */
  portalServices(portal, filter = {}) {
    const configured = portal.services || {};
    // Service control is opt-in (serviceControl.enabled). When on, cards backed
    // by a systemd --user unit gain Start/Stop/Restart buttons. Mutations also
    // need server.apiKey — if it's unset the server refuses with an actionable
    // error, which we surface via toast rather than hiding the buttons.
    const controlEnabled = !!portal.controlEnabled;
    const categoryOrder = portal.categories || [];

    // Services are configured with loopback URLs (localhost / 127.0.0.1)
    // because they run on this host. But the dashboard is usually opened from
    // another machine, where "localhost" points at the *viewer's* box — not
    // the server. Rewrite loopback hosts to whatever host the dashboard itself
    // was loaded from (window.location.hostname) so links resolve to this
    // server for remote viewers. Port, path and protocol are left untouched.
    const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
    const rehost = (u) => {
      try {
        const p = new URL(u);
        const here = window.location.hostname;
        if (here && LOOPBACK.has(p.hostname)) { p.hostname = here; return p.href; }
        return u;
      } catch { return u; }
    };

    // Only http(s) URLs are launchable — anything else (javascript:, data:, …)
    // is dropped so an escaped-but-malicious href can never reach the DOM. A
    // "/path" entry is served by this dashboard, so it resolves against our origin.
    const safeUrl = (u) => {
      try {
        const p = new URL(u, window.location.origin);
        return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : '';
      } catch { return ''; }
    };

    const cats = filter.categories?.length ? new Set(filter.categories) : null;
    const keys = filter.keys?.length ? new Set(filter.keys) : null;

    // Normalize each entry into a card model; unset presentation fields fall
    // back to neutral defaults so a bare { "url": … } still renders sensibly.
    const services = Object.entries(configured).map(([key, v]) => {
      return {
        key,
        url: safeUrl(rehost(v.url || '')),
        label: v.label || humanizeKey(key),
        description: v.description || '',
        icon: v.icon || 'globe',
        category: v.category || 'Other',
        accent: v.accent || portal.accent || '#2563EB',
        order: typeof v.order === 'number' ? v.order : null,
        enabled: v.enabled !== false,
        // systemd --user unit backing this card. Only cards with a configured
        // unit (and control turned on) render lifecycle buttons.
        unit: controlEnabled ? (v.unit || '') : '',
        controllable: controlEnabled && v.controllable === true,
      };
    }).filter(s => s.url && (!cats || cats.has(s.category)) && (!keys || keys.has(s.key)));

    // Categories in portal.json order (unlisted ones A→Z after); within one,
    // explicit `order` first (ascending), then by label.
    const catRank = (c) => { const i = categoryOrder.indexOf(c); return i === -1 ? 1e9 : i; };
    return services.sort((a, b) =>
      catRank(a.category) - catRank(b.category) || a.category.localeCompare(b.category)
      || (a.order ?? 1e9) - (b.order ?? 1e9) || a.label.localeCompare(b.label));
  }

  portalCard(s) {
    const c = s.accent;
    let host = s.url;
    try { host = new URL(s.url).host || s.url; } catch { /* keep raw */ }
    // Lifecycle control row (only when the card names a controllable unit).
    // The card is an <a>; the click handler preventDefault()s so buttons act
    // on the service instead of opening the tab.
    const controls = s.unit ? `
      <div class="portal-controls" data-svc-controls="${esc(s.key)}">
        <span class="unit-chip" data-unit-state="${esc(s.key)}" title="systemd unit state">…</span>
        <span class="portal-btns">
          <button class="btn-svc" data-svc-action="start"   data-key="${esc(s.key)}" title="Start unit">Start</button>
          <button class="btn-svc" data-svc-action="stop"    data-key="${esc(s.key)}" title="Stop unit">Stop</button>
          <button class="btn-svc" data-svc-action="restart" data-key="${esc(s.key)}" title="Restart unit">Restart</button>
          ${s.controllable ? `<button class="btn-svc" data-svc-action="__autostart" data-key="${esc(s.key)}" title="Toggle boot autostart">Autostart</button>` : ''}
        </span>
      </div>` : '';
    return `<a class="card portal-card" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"
        title="Open ${esc(s.label)} — ${esc(s.url)}">
      <div class="portal-top">
        <span class="portal-icon" style="background:${c}18; color:${c}; border:1px solid ${c}33">
          <i data-lucide="${esc(s.icon)}"></i>
        </span>
        ${this.svcStatusChip(s)}
        <span class="portal-open"><i data-lucide="external-link"></i></span>
      </div>
      <div class="portal-title">${esc(s.label)}${s.enabled ? '' : ` ${badge('disabled', '#94A3B8')}`}</div>
      ${s.description ? `<div class="portal-desc">${esc(s.description)}</div>` : ''}
      <div class="portal-url"><i data-lucide="link"></i> ${esc(host)}</div>
      ${controls}
    </a>`;
  }

  // Status dot + text, filled in by applyServiceStatus().
  svcStatusChip(s) {
    return `<span class="svc-status ${s.enabled ? 'checking' : 'disabled'}" data-svc="${esc(s.key)}"
              title="${s.enabled ? 'Checking…' : 'Monitoring disabled'}">
          <span class="svc-dot"></span><span class="svc-text">${s.enabled ? 'checking' : 'disabled'}</span>
        </span>`;
  }

  // Wire lifecycle buttons (only present when service control is enabled and a
  // card names a unit). The card is an <a>, so each button must swallow the
  // click so it acts on the service instead of navigating.
  wireServiceControls(root) {
    root.querySelectorAll('.btn-svc').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const key = btn.getAttribute('data-key');
        let action = btn.getAttribute('data-svc-action');
        if (action === '__autostart') {
          // Flip based on the current chip: if it reads "enabled", disable; else enable.
          const chip = root.querySelector(`[data-unit-state="${key}"]`);
          action = (chip && /\benabled\b/i.test(chip.textContent)) ? 'disable' : 'enable';
        }
        const row = btn.closest('.portal-controls');
        row.querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          await this.api.post(`/services/${encodeURIComponent(key)}/${action}`, {});
          this.toast('service', `${key}: ${action} ok`);
        } catch (e) {
          // api.request throws with the server's { error } message (403/423/502/…).
          this.toast('service action failed', e.message || 'request failed');
        } finally {
          row.querySelectorAll('button').forEach((b) => (b.disabled = false));
          // Immediate refresh of dots + unit chips for snappiness.
          this.startServicePolling();
        }
      });
    });
  }

  // Map a probe result to a UI state: online | offline | disabled | unprobed | unknown.
  svcState(st) {
    if (!st) return 'unknown';
    if (!st.enabled || st.reason === 'disabled') return 'disabled';
    if (st.reason === 'not probed') return 'unprobed';
    return st.online ? 'online' : 'offline';
  }

  // Update every Portal card's status dot in place from a { key → status } map.
  applyServiceStatus(map) {
    document.querySelectorAll('.svc-status[data-svc]').forEach((el) => {
      const key = el.getAttribute('data-svc');
      const st = map[key];
      const state = this.svcState(st);
      el.className = `svc-status ${state}`;
      const label = { online: 'online', offline: 'offline', disabled: 'disabled', unprobed: 'link', unknown: 'unknown' }[state];
      const txt = el.querySelector('.svc-text');
      if (txt) txt.textContent = label;
      const tip = {
        online: st ? `Online${st.code ? ` · HTTP ${st.code}` : ''}${st.ms != null ? ` · ${st.ms}ms` : ''}` : 'Online',
        offline: st ? `Offline${st.reason ? ` · ${st.reason}` : ''}` : 'Offline',
        disabled: 'Monitoring disabled in config',
        unknown: 'Status unknown (not in portal.json)',
        unprobed: 'Not health-checked (probe: false)',
      }[state];
      el.setAttribute('title', tip);
    });
    // Unit-state chips (only rendered on controllable cards). "Port answers" and
    // "unit active" are different facts, so this is shown separately from the dot.
    document.querySelectorAll('[data-unit-state]').forEach((chip) => {
      const st = map[chip.getAttribute('data-unit-state')];
      if (!st || !st.unit) { chip.textContent = ''; chip.className = 'unit-chip'; return; }
      const active = st.active || 'unknown';
      chip.textContent = st.controllable ? `${active} · ${st.autostart || 'unknown'}` : active;
      chip.className = `unit-chip ${active}`; // styled: .active / .inactive / .failed
      chip.setAttribute('title', `unit ${st.unit}: ${active}${st.autostart ? ` · autostart ${st.autostart}` : ''}`);
    });
  }

  startServicePolling() {
    const poll = async () => {
      try {
        const map = await this.api.get('/services');
        this.svcStatus = map;
        this.applyServiceStatus(map);
      } catch { /* transient — keep last known dots */ }
    };
    poll();
    this.addViewTimer(poll, 3000);
  }

  // renderConfig() lives in public/js/config.js (form editor for config.json).
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
