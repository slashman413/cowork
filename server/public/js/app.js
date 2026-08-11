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

// Countdown twin of timeAgo — "2h 10m", "3d 4h", "now" — for rate-limit resets.
function timeUntil(iso) {
  if (!iso) return '';
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `${Math.max(1, Math.ceil(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// "remote-ai-code-gen-cc-fable" → "cc-fable"; "local-cc-opus" → "cc-opus".
// Falls back to the raw id when no exec marker is present.
function shortBrain(id) {
  const m = String(id).match(/(cc|agy|codex|ollama|ha)-[^]*$/);
  return m ? m[0] : String(id);
}

// Usage meters for the metered brains among `brainIds` (rate-limit % + reset).
// Brains with no usage snapshot (hermes/ollama/script — no quota) simply don't
// appear. Brains sharing one account (e.g. all cc-* on a host) produce identical
// snapshots, so meters are grouped per exec instead of repeated per brain.
function usageMeters(brainIds, usage) {
  const byExec = new Map();
  for (const id of brainIds || []) {
    const u = usage?.[id];
    if (!u?.windows?.length) continue;
    if (!byExec.has(u.exec)) byExec.set(u.exec, { u, names: [] });
    byExec.get(u.exec).names.push(shortBrain(id));
  }
  if (!byExec.size) return '';
  // Friendly names for the known rate-limit windows (falls back to the raw
  // label for future variants like 7d-opus).
  const WINDOW_NAMES = { '5h': '5-hour', '7d': 'weekly', credits: 'credits' };
  const blocks = [...byExec.entries()].map(([exec, { u, names }]) => {
    const stale = Date.now() - new Date(u.at).getTime() > 1800000;
    const rows = u.windows.map(w => {
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
    return `<div class="usage-brain">
      <div class="usage-brain-head">${badge(exec, '#7C3AED')} <span class="usage-names">${names.map(esc).join(' · ')}</span>
        <span class="usage-at"${stale ? ' style="color:#EAB308"' : ''} title="${esc(new Date(u.at).toLocaleString())}">measured ${timeAgo(u.at)}</span></div>
      ${rows}
    </div>`;
  }).join('');
  return `<div class="usage-panel">${blocks}</div>`;
}

// A task is "failed" when its whole fallback chain was exhausted. Prefer the
// explicit flag set by the server; fall back to the result text / rejected status
// so tasks that finished before the flag existed still categorize correctly.
function isTaskFailed(t) {
  return t.failed === true
    || t.status === 'rejected'
    || (t.status === 'done' && typeof t.result === 'string' && /^FAILED\b/i.test(t.result.trim()));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const STATUS_COLORS = {
  'wait-input': '#A855F7', scheduled: '#6366F1', pending: '#EAB308', claimed: '#0EA5E9', 'in-progress': '#0EA5E9',
  done: '#22C55E', rejected: '#EF4444',
  idle: '#94A3B8', working: '#22C55E', blocked: '#EF4444'
};

function badge(text, color) {
  return `<span class="badge" style="background:${color}18; color:${color}; border:1px solid ${color}40">${esc(text)}</span>`;
}

function createIcons() {
  if (window.lucide) lucide.createIcons();
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

/** Brain chip accent (translucent bg / border / text share one hue). */
const BRAIN_COLOR = '#F97316';        // orange
const BRAIN_BAD_COLOR = '#EF4444';    // unknown / deregistered brain

/**
 * One rung of a brain fallback chain: draggable, in the translucent chip style.
 * Used by both the Brains default chain and every Agents chain so reordering
 * looks and behaves the same everywhere.
 */
function chainChip(brain, i, total, known) {
  const c = known ? BRAIN_COLOR : BRAIN_BAD_COLOR;
  return `<span class="dchip" draggable="true" data-brain="${esc(brain)}"
    title="${known ? `rung ${i + 1} of ${total} — drag to reorder` : 'unknown brain (deregistered)'}"
    style="display:inline-flex;align-items:center;gap:6px;cursor:grab;background:${c}18;border:1px solid ${c}40;color:${c};padding:4px 9px;border-radius:8px;font-size:0.8rem;margin:3px">
    <i data-lucide="grip-vertical" style="width:12px;height:12px;opacity:.5"></i>
    <b style="opacity:.6">${i + 1}</b> ${esc(brain)}${known ? '' : ' ⚠'}
    <a data-rm="${esc(brain)}" title="remove" style="cursor:pointer">✕</a></span>`;
}

/**
 * Portal — a launcher for the local self-hosted web services this host runs
 * (Mautic, Filebrowser, …). Cards are built by merging two sources:
 *   1. PORTAL_DEFAULTS — a curated catalog shown out of the box.
 *   2. config.services from /api/config — the operator's own list; entries are
 *      matched to the catalog by key so a bare { url, enabled } gets a nice
 *      label/icon/description for free, and unknown keys still render sensibly.
 * Each card is a plain link that opens the service in a new tab. Status dots are
 * probed server-side (GET /api/services) rather than from the browser, since a
 * cross-origin fetch to a service's localhost URL just trips CORS; the server
 * runs on the host, so it can reach the real loopback ports. See service-probe.ts.
 */
const PORTAL_CATALOG = {
  mautic:      { label: 'Mautic',      icon: 'megaphone',   category: 'Marketing', description: 'Open-source marketing automation — campaigns, email, contacts.' },
  filebrowser: { label: 'Filebrowser', icon: 'folder',      category: 'Files',     description: 'Web file manager — browse, upload and share host files.' },
  forgejo:     { label: 'Forgejo',     icon: 'git-fork',    category: 'Dev',       description: 'Self-hosted Git server — repos, issues and pull requests.' },
  firecrawl:   { label: 'Firecrawl',   icon: 'flame',       category: 'APIs & MCP', description: 'Web scraping / crawling API for LLM pipelines.' },
  vllm35b:     { label: 'vLLM 35B',    icon: 'cpu',         category: 'APIs & MCP', description: 'Local vLLM OpenAI-compatible inference server (35B).' },
  vllm27b:     { label: 'vLLM 27B',    icon: 'cpu',         category: 'APIs & MCP', description: 'Local vLLM OpenAI-compatible inference server (27B).' },
  grafana:     { label: 'Grafana',     icon: 'gauge',       category: 'Ops',       description: 'Metrics dashboards and observability.' },
  portainer:   { label: 'Portainer',   icon: 'container',   category: 'Ops',       description: 'Docker / container management UI.' },
  n8n:         { label: 'n8n',         icon: 'workflow',    category: 'Automation', description: 'Workflow automation and integrations.' },
};

// Always-present launcher tiles so the Portal is useful before any service is
// configured. Operator config.services entries override these by key.
const PORTAL_DEFAULTS = {
  mautic:      { url: 'http://localhost:8081' },
  filebrowser: { url: 'http://localhost:8082' },
};

const PORTAL_CATEGORY_ORDER = ['Marketing', 'Files', 'Dev', 'Automation', 'Ops', 'APIs & MCP', 'Other'];
const PORTAL_ACCENT = '#2563EB';

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
    this.openTasks = new Set();  // ids of expanded task cards — survives SSE-driven re-renders
    this.agents = new Map();   // agent UUID → { name, platform } for human-readable labels
    this.chatMessages = [];    // Chat view conversation state (persists across nav within a session)
    this.chatSel = { brain: '', division: '', agent: '' };
    this.chatBusyBrains = new Set();  // brain keys ('' selection → 'auto') with a chat in flight — the composer locks per brain, not globally
    this.chatAttachments = [];  // File[] staged in the composer, sent as task inputs
    this.chatSessions = this.loadChatSessions();  // persisted recent chat sessions (newest first)
    this.chatSessionId = null;                    // id of the session currently open in the composer

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
    // Delegated open/delete for the Chat view's recent-sessions strip (the chips
    // are re-rendered in place, so a document-level handler avoids stale listeners).
    document.addEventListener('click', (e) => {
      const del = e.target.closest('[data-chat-del]');
      if (del) { e.preventDefault(); e.stopPropagation(); this.deleteChatSession(del.dataset.chatDel); return; }
      const open = e.target.closest('[data-chat-open]');
      if (open) this.openChatSession(open.dataset.chatOpen);
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

  init() {
    window.addEventListener('hashchange', () => this.navigate());
    this.setupSSE();
    this.navigate();
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
    this.activity.unshift(data);
    this.activity = this.activity.slice(0, 30);
    if (data.type !== 'heartbeat') {
      // Only toast events the operator actually acts on; claim/handover chatter
      // still lands in the Live Activity feed without stealing attention.
      if (['taskCreated', 'taskCompleted', 'reportFiled', 'agentRegistered'].includes(data.type)) {
        this.toast(data.type, this.describeEvent(data));
      }
      // A full re-render replaces the view's DOM, which would wipe whatever the
      // user is mid-way through typing (chat message, search box) along with the
      // caret. Never auto-re-render Chat — it drives its own updates via
      // renderChatMessages, which only touches the transcript, not the composer.
      // Debounce so a burst of events causes one refresh, and re-check the
      // typing guard when the timer fires (not when the event arrived).
      clearTimeout(this._rerenderTimer);
      this._rerenderTimer = setTimeout(() => {
        const el = document.activeElement;
        const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
        if (this.currentView !== 'chat' && !typing) this.renderCurrentView();
      }, 800);
    }
  }

  // Map an agent UUID to its human-readable name (falls back to a short id).
  agentLabel(id) {
    if (!id) return '';
    const a = this.agents.get(id);
    return a ? a.name : id.slice(0, 8);
  }

  // Refresh the UUID→name map from the full active-agent list (includes the
  // internal dispatcher/orchestrator, unlike /connections). Call before
  // rendering views that show agent ids: dashboard, inbox, connections.
  async refreshAgents() {
    try {
      const agents = await this.api.get('/agents');
      (Array.isArray(agents) ? agents : []).forEach(a => this.agents.set(a.id, { name: a.agentName, platform: a.platform }));
    } catch { /* keep whatever we have */ }
  }

  describeEvent(e) {
    const p = e.payload || {};
    switch (e.type) {
      case 'agentRegistered':
        if (p.agent?.id) this.agents.set(p.agent.id, { name: p.agent.agentName, platform: p.agent.platform });
        return `${p.agent?.agentName} (${p.agent?.platform}) joined`;
      case 'taskCreated': return p.task?.title;
      case 'taskClaimed': return `claimed by ${this.agentLabel(p.task?.claimedBy || p.agentId)}: ${p.task?.title}`;
      case 'taskCompleted': return `done: ${p.task?.title}`;
      case 'reportFiled': return p.report?.title;
      case 'heartbeat': return `${this.agentLabel(p.agentId)} → ${p.status}`;
      default: return p.task?.title || p.agent?.agentName || humanizeKey(e.type);
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
   * Confirm a continue/re-run AND let the user choose which brain claims the
   * task. Renders the shared #modal-container with a brain <select> (populated
   * from /api/brains, "Auto" = route via the agent's chain). Resolves to
   * { brain, prompt, files } — brain '' meaning Auto — or null if the user
   * cancels. `defaultBrain` pre-selects the brain the task would otherwise use.
   *
   * With `withInputs: true` the dialog also offers an extra-prompt textarea and
   * a file-attach control (mirrors the New task composer): `prompt` is the typed
   * steer and `files` the staged File[] the caller uploads on confirm. Callers
   * that omit `withInputs` (e.g. re-run) get the same `{ brain }` as before —
   * `prompt` is '' and `files` is empty, so reading only `.brain` is safe.
   */
  async pickBrain({ title, body, defaultBrain = '', confirmLabel = 'Confirm', confirmColor = '#22C55E', withInputs = false }) {
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) {   // no modal markup → degrade to a plain confirm
      return window.confirm(`${title}\n\n${body.replace(/<[^>]+>/g, '')}`) ? { brain: defaultBrain, prompt: '', files: [] } : null;
    }
    let brains = {};
    try { brains = await this.api.get('/brains'); } catch { /* registry unreachable → Auto only */ }
    const ids = Object.keys(brains).sort();
    const opts = [`<option value="">🧠 Auto — route via the agent's brain chain</option>`]
      .concat(ids.map(b => `<option value="${esc(b)}"${b === defaultBrain ? ' selected' : ''}>${esc(b)}</option>`)).join('');
    const fieldStyle = 'width:100%; padding:9px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:8px; color:inherit; font:inherit; font-size:0.9rem';
    const labelStyle = 'display:block; font-size:0.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); margin-bottom:6px';
    // Optional extra-steer block — appended to the follow-up's brief and inputs.
    const inputsBlock = withInputs ? `
      <label style="${labelStyle}">Additional prompt <span style="text-transform:none; letter-spacing:0">(optional — extra instructions for this continuation)</span></label>
      <textarea id="brain-prompt" rows="4" style="${fieldStyle}; margin-bottom:16px; resize:vertical" placeholder="e.g. Now add unit tests and a migration guide."></textarea>
      <label style="${labelStyle}">Extra input files <span style="text-transform:none; letter-spacing:0">(optional — attached alongside the prior run's outputs)</span></label>
      <div id="brain-attachments" style="display:none; flex-wrap:wrap; gap:6px; margin-bottom:8px"></div>
      <input type="file" id="brain-files" multiple style="display:none">
      <button class="btn" id="brain-attach" type="button" style="font-size:0.8rem; margin:0 0 20px; display:inline-flex; align-items:center; gap:6px"><i data-lucide="paperclip" style="width:14px;height:14px"></i> Attach files</button>` : '';
    content.innerHTML = `
      <h3 style="margin:0 0 8px; font-size:1.05rem">${esc(title)}</h3>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin:0 0 16px; line-height:1.5">${body}</p>
      <label style="${labelStyle}">Brain to claim this task</label>
      <select id="brain-pick" style="${fieldStyle}; margin-bottom:${withInputs ? '16px' : '20px'}">${opts}</select>
      ${inputsBlock}
      <div style="display:flex; gap:8px; justify-content:flex-end">
        <button class="btn" id="brain-cancel" style="font-size:0.85rem">Cancel</button>
        <button class="btn" id="brain-ok" style="font-size:0.85rem; color:${confirmColor}; border-color:${confirmColor}66">${esc(confirmLabel)}</button>
      </div>`;
    container.classList.remove('hidden');
    if (withInputs) createIcons();
    content.querySelector('#brain-pick').focus();

    // Files stage client-side and upload only on confirm (mirrors createTaskModal),
    // so a cancelled dialog leaves no orphaned uploads.
    const staged = [];
    if (withInputs) {
      const attBox = content.querySelector('#brain-attachments');
      const fileEl = content.querySelector('#brain-files');
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
      content.querySelector('#brain-attach').onclick = () => fileEl.click();
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
      content.querySelector('#brain-ok').onclick = () => close({
        brain: content.querySelector('#brain-pick').value,
        prompt: withInputs ? content.querySelector('#brain-prompt').value.trim() : '',
        files: staged.slice()
      });
      content.querySelector('#brain-cancel').onclick = () => close(null);
      container.querySelector('.modal-backdrop').onclick = () => close(null);
    });
  }

  /**
   * "＋ New task" modal — create and dispatch a task from the Inbox without the
   * Chat detour. Same POST /inbox contract as Chat: an agent pick from the
   * roster stamps context.agent (the dispatcher runs that persona on its
   * division's brain chain), attached files upload to task inputs the brain
   * reads, and brain pinning mirrors pickBrain ('' = auto-route via the chain).
   */
  async createTaskModal() {
    const container = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    if (!container || !content) return;
    let brains = {};
    let divisions = {};
    // Both feeds are optional — a missing registry/roster degrades to Auto.
    try { brains = await this.api.get('/brains'); } catch { /* registry unreachable → Auto only */ }
    try { divisions = await this.api.get('/roster-divisions'); } catch { /* roster unreachable → no agent picker options */ }
    const opts = [`<option value="">🧠 Auto — route via the agent's brain chain</option>`]
      .concat(Object.keys(brains).sort().map(b => `<option value="${esc(b)}">${esc(b)}</option>`)).join('');
    const divOpts = [`<option value="">🤖 Auto — let the router pick the agent</option>`]
      .concat(Object.entries(divisions).sort().map(([d, i]) => `<option value="${esc(d)}">${esc(i.label || d)} (${i.agents.length})</option>`)).join('');
    const fieldStyle = 'width:100%; padding:9px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:8px; color:inherit; font:inherit; font-size:0.9rem';
    const labelStyle = 'display:block; font-size:0.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); margin:0 0 6px';
    content.innerHTML = `
      <h3 style="margin:0 0 8px; font-size:1.05rem">New task</h3>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin:0 0 16px; line-height:1.5">The task is queued as pending and dispatched by the next tick — or parked as <em>scheduled</em> until its run time if you set one.</p>
      <label style="${labelStyle}">Title</label>
      <input id="nt-title" style="${fieldStyle}; margin-bottom:12px" placeholder="Short imperative title…">
      <label style="${labelStyle}">Brief (markdown)</label>
      <textarea id="nt-desc" rows="6" style="${fieldStyle}; margin-bottom:12px; resize:vertical" placeholder="What should the agent do? Include acceptance criteria."></textarea>
      <label style="${labelStyle}">Agent <span style="text-transform:none; letter-spacing:0">(optional — pick a division, then the roster agent that studies the files & does the work)</span></label>
      <div style="display:flex; gap:8px; margin-bottom:12px">
        <select id="nt-div" style="${fieldStyle}; flex:1">${divOpts}</select>
        <select id="nt-agent" style="${fieldStyle}; flex:1" disabled><option value="">— none —</option></select>
      </div>
      <label style="${labelStyle}">Priority</label>
      <select id="nt-priority" style="${fieldStyle}; margin-bottom:12px">
        <option value="normal" selected>normal</option><option value="low">low</option>
        <option value="high">high</option><option value="urgent">urgent</option>
      </select>
      <label style="${labelStyle}">Run at <span style="text-transform:none; letter-spacing:0">(optional — leave empty to run now)</span></label>
      <input id="nt-when" type="datetime-local" style="${fieldStyle}; margin-bottom:12px">
      <label style="${labelStyle}">Brain to claim this task</label>
      <select id="nt-brain" style="${fieldStyle}; margin-bottom:12px">${opts}</select>
      <label style="${labelStyle}">Input files <span style="text-transform:none; letter-spacing:0">(optional — attached for the agent/brain to study)</span></label>
      <div id="nt-attachments" style="display:none; flex-wrap:wrap; gap:6px; margin-bottom:8px"></div>
      <input type="file" id="nt-files" multiple style="display:none">
      <button class="btn" id="nt-attach" type="button" style="font-size:0.8rem; margin:0 0 20px; display:inline-flex; align-items:center; gap:6px"><i data-lucide="paperclip" style="width:14px;height:14px"></i> Attach files</button>
      <div style="display:flex; gap:8px; justify-content:flex-end">
        <button class="btn" id="nt-cancel" style="font-size:0.85rem">Cancel</button>
        <button class="btn" id="nt-ok" style="font-size:0.85rem; color:#22C55E; border-color:#22C55E66">＋ Create task</button>
      </div>`;
    container.classList.remove('hidden');
    createIcons();
    content.querySelector('#nt-title').focus();
    const close = () => {
      container.classList.add('hidden');
      content.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    content.querySelector('#nt-cancel').onclick = close;
    container.querySelector('.modal-backdrop').onclick = close;

    // Division → agent: the agent list is scoped to the chosen division, matching
    // the two-stage roster picker in Chat. Empty division = auto-route.
    const divEl = content.querySelector('#nt-div');
    const agentEl = content.querySelector('#nt-agent');
    divEl.onchange = () => {
      const info = divEl.value ? divisions[divEl.value] : null;
      const agentOpts = info ? info.agents.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(a => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join('') : '';
      agentEl.innerHTML = `<option value="">— any agent in this division —</option>${agentOpts}`;
      agentEl.disabled = !info;
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

    content.querySelector('#nt-ok').onclick = async () => {
      const title = content.querySelector('#nt-title').value.trim();
      const description = content.querySelector('#nt-desc').value.trim();
      if (!title) { content.querySelector('#nt-title').style.borderColor = '#EF4444'; return; }
      if (!description) { content.querySelector('#nt-desc').style.borderColor = '#EF4444'; return; }
      const brain = content.querySelector('#nt-brain').value;
      const division = divEl.value;
      const agent = agentEl.value;
      // datetime-local gives a LOCAL wall-clock string; toISOString converts it
      // to the UTC instant the server schedules on. Empty = run now (default).
      const when = content.querySelector('#nt-when').value;
      // Context mirrors Chat: a named agent wins (dispatcher derives its division
      // + persona); otherwise a bare division scopes the router. Brain pins on top.
      const context = {};
      if (brain) context.brain = brain;
      if (agent) context.agent = agent; else if (division) context.division = division;
      const okBtn = content.querySelector('#nt-ok');
      okBtn.disabled = true;
      try {
        // Upload staged files first so the created task carries them as inputs.
        const inputs = staged.length ? await this.uploadInputFiles(staged) : [];
        const body = {
          title, description,
          from: { platform: 'dashboard', agent: 'operator' },
          priority: content.querySelector('#nt-priority').value,
          context,
          ...(inputs.length ? { inputs } : {}),
          ...(when ? { scheduledAt: new Date(when).toISOString() } : {})
        };
        await this.api.post('/inbox', body);
        close();
        const target = agent ? `agent ${agent}` : division ? `${divisions[division]?.label || division} division` : null;
        const routeNote = brain ? `pinned to ${brain}` : target ? `routed to ${target}` : 'auto-routed via the brain chain';
        const fileNote = inputs.length ? ` · ${inputs.length} file(s) attached` : '';
        this.toast('task created', `${when ? `Scheduled for ${new Date(when).toLocaleString()}` : 'Queued'} — ${routeNote}${fileNote}.`);
        if (this.currentView === 'inbox') this.renderInbox();
      } catch (err) {
        okBtn.disabled = false;
        this.toast('error', err.message);
      }
    };
  }

  navigate() {
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    this.currentView = hash;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === hash);
    });
    const titles = {
      dashboard: 'Dashboard', chat: 'Chat', portal: 'Portal', connections: 'Connections', inbox: 'Task Inbox',
      workflows: 'Workflows', team: 'Agents', brains: 'Brains', roster: 'Agent Roster', config: 'Configuration'
    };
    this.viewTitleEl.textContent = titles[hash] || 'Dashboard';
    this.renderCurrentView();
  }

  // Per-view polling timers. Cleared and re-established on every render so a
  // view's pollers stop the moment you navigate away (and SSE-driven re-renders
  // don't stack duplicate intervals).
  clearViewTimers() {
    (this._viewTimers || []).forEach((id) => clearInterval(id));
    this._viewTimers = [];
  }
  addViewTimer(fn, ms) {
    const id = setInterval(fn, ms);
    (this._viewTimers ||= []).push(id);
    return id;
  }

  async renderCurrentView() {
    this.clearViewTimers();
    try {
      switch (this.currentView) {
        case 'chat': await this.renderChat(); break;
        case 'portal': await this.renderPortal(); break;
        case 'connections': await this.renderConnections(); break;
        case 'inbox': await this.renderInbox(); break;
        case 'workflows': await this.renderWorkflows(); break;
        case 'team': await this.renderTeam(); break;
        case 'brains': await this.renderBrains(); break;
        case 'roster': await this.renderRoster(); break;
        case 'config': await this.renderConfig(); break;
        default: await this.renderDashboard(); break;
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

  // ── Dashboard ──────────────────────────────────────────────────────────

  async renderDashboard() {
    const [status, dispatcher] = await Promise.all([
      this.api.get('/status'),
      this.api.get('/dispatcher').catch(() => null),
      this.refreshAgents()
    ]);
    const stat = (iconName, value, label) => `
      <div class="card stat-card">
        <div class="stat-icon"><i data-lucide="${iconName}"></i></div>
        <div>
          <div class="stat-value">${value}</div>
          <div class="stat-label">${label}</div>
        </div>
      </div>`;
    const dot = (ok) => `<span class="dot ${ok ? 'connected' : 'disconnected'}" style="display:inline-block; margin-left:6px"></span>`;

    const platforms = Object.entries(status.platformStatus || {})
      .map(([id, on]) => `<p style="margin:6px 0; font-size:0.875rem">${esc(id)} ${dot(on)}</p>`).join('') || '<p style="color:var(--text-muted)">-</p>';

    const roles = dispatcher
      ? Object.entries(dispatcher.agents || {}).map(([name, a]) =>
          `<tr><td style="padding:3px 12px 3px 0">${badge(name, '#7C3AED')}</td><td style="color:var(--text-secondary); font-size:0.85rem">${esc((a.brains || []).join(' → '))}</td></tr>`).join('')
      : '';
    const running = dispatcher?.running?.length
      ? dispatcher.running.map(r =>
          `<p style="margin:4px 0; font-size:0.85rem">${badge(r.role, '#22C55E')} <span style="color:var(--text-secondary)">${esc(r.taskId.slice(0, 8))} · ${timeAgo(new Date(r.startedAt).toISOString())}</span></p>`).join('')
      : '<p style="color:var(--text-muted); font-size:0.85rem">Idle</p>';

    const activity = this.activity.length
      ? this.activity.slice(0, 12).map(e =>
          `<p style="margin:6px 0; font-size:0.85rem">${badge(e.type, '#0EA5E9')} ${esc(this.describeEvent(e))} <span style="color:var(--text-muted)">${timeAgo(e.timestamp)}</span></p>`).join('')
      : '<p style="color:var(--text-muted); font-size:0.875rem">Waiting for events…</p>';

    this.contentEl.innerHTML = `
      ${this.renderSysbar()}
      <div class="grid-4" style="margin-bottom: var(--space-xl)">
        ${stat('bot', status.activeAgents, 'Active Agents')}
        ${stat('inbox', status.inboxSummary.pending + status.inboxSummary.inProgress,
               `Open Tasks (${status.inboxSummary.completed - (status.inboxSummary.failed || 0)} done${status.inboxSummary.failed ? `, ${status.inboxSummary.failed} failed` : ''}${status.inboxSummary.scheduled ? `, ${status.inboxSummary.scheduled} scheduled` : ''}${status.inboxSummary.waitingInput ? `, ${status.inboxSummary.waitingInput} wait input` : ''})`)}
        ${stat('users', status.rosterCount, 'Agent Roster')}
      </div>
      <div class="grid-2" style="margin-bottom: var(--space-xl)">
        <div class="card">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:var(--space-md)">
            <i data-lucide="zap" style="width:18px;height:18px;color:var(--text-muted)"></i>
            <h3 style="font-size:0.95rem">Dispatcher</h3>
            ${dispatcher?.enabled ? badge('enabled', '#22C55E') : badge('disabled', '#EF4444')}
          </div>
          <div style="margin-top: var(--space-md)">
            <h4 class="section-title">Running Now</h4>
            ${running}
          </div>
          <div style="margin-top: var(--space-md)">
            <h4 class="section-title">Role → Model</h4>
            <table class="dispatcher-table">${roles}</table>
          </div>
        </div>
        <div class="card">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:var(--space-md)">
            <i data-lucide="activity" style="width:18px;height:18px;color:var(--text-muted)"></i>
            <h3 style="font-size:0.95rem">Live Activity</h3>
          </div>
          <div style="max-height:340px; overflow-y:auto">${activity}</div>
        </div>
      </div>
      <div class="card">
        <h3 style="font-size:0.95rem; margin-bottom:var(--space-md)">Platforms</h3>
        <div>${platforms}</div>
      </div>`;

    // Kick off (and keep) the 3s system-load polling for as long as we're on
    // the dashboard. clearViewTimers() (in renderCurrentView) stops it on nav.
    this.startSystemPolling();
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
  renderSysbar() {
    const s = this.sysMetrics || null;
    const tile = (id, icon, label) => `
      <div class="sysbar-tile">
        <div class="sysbar-head">
          <i data-lucide="${icon}"></i><span class="sysbar-label">${label}</span>
          <span class="sysbar-val" id="sys-${id}-val">—</span>
        </div>
        <div class="meter"><div class="meter-fill" id="sys-${id}-bar" style="width:0%"></div></div>
        <div class="sysbar-sub" id="sys-${id}-sub">—</div>
      </div>`;
    const html = `
      <div class="sysbar" id="sysbar">
        ${tile('cpu', 'cpu', 'CPU')}
        ${tile('gpu', 'gpu', 'GPU')}
        ${tile('mem', 'memory-stick', 'Memory')}
        ${tile('temp', 'thermometer', 'Core Temp')}
      </div>`;
    // If we already have a snapshot, apply it after this HTML lands in the DOM.
    if (s) queueMicrotask(() => this.applySysbar(s));
    return html;
  }

  // Update the bar's tiles in place from a snapshot (no full re-render).
  applySysbar(s) {
    if (!s) return;
    const set = (id, val, pct, sub) => {
      const v = document.getElementById(`sys-${id}-val`);
      const b = document.getElementById(`sys-${id}-bar`);
      const u = document.getElementById(`sys-${id}-sub`);
      if (v) v.textContent = val;
      if (b) {
        b.style.width = `${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%`;
        b.className = `meter-fill ${this.sysBand(pct)}`;
      }
      if (u) u.textContent = sub;
    };
    const pct = (n) => (n == null ? '—' : `${n}%`);
    const mb = (n) => (n == null ? '—' : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);

    // CPU
    const cpu = s.cpu || {};
    set('cpu', pct(cpu.usage), cpu.usage,
      `${cpu.cores || '—'} cores${cpu.load1 != null ? ` · load ${cpu.load1}` : ''}`);

    // GPU (aggregate over all cards)
    const g = s.gpu;
    if (g) {
      const memPct = (g.memoryUsedMb != null && g.memoryTotalMb) ? Math.round((g.memoryUsedMb / g.memoryTotalMb) * 100) : null;
      const name = (s.gpus && s.gpus.length === 1) ? s.gpus[0].name : (s.gpus && s.gpus.length > 1 ? `${s.gpus.length}× GPU` : '');
      set('gpu', pct(g.usage), g.usage,
        `${mb(g.memoryUsedMb)}/${mb(g.memoryTotalMb)}${g.temperature != null ? ` · ${g.temperature}°C` : ''}${name ? ` · ${name.slice(0, 22)}` : ''}`);
    } else {
      set('gpu', 'n/a', null, 'no GPU detected');
    }

    // Memory
    const m = s.memory || {};
    set('mem', pct(m.usage), m.usage, `${mb(m.usedMb)}/${mb(m.totalMb)}`);

    // Core temperature — meter scaled against a 100°C ceiling.
    const t = cpu.temperature;
    set('temp', t == null ? '—' : `${t}°C`, t, t == null ? 'unavailable' : 'CPU package');
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

  // ── Active Agents ──────────────────────────────────────────────────────

  async renderConnections() {
    // One-shot render + a slow poll so the usage meters / reset countdowns and
    // heartbeat ages stay current while the view is open. The timer calls the
    // inner render (NOT renderConnections) so it never stacks new timers.
    const render = () => this.renderConnectionsInner();
    await render();
    this.addViewTimer(() => render().then(createIcons).catch(() => { /* transient */ }), 60000);
  }

  async renderConnectionsInner() {
    const { clients, counters, usage = {}, localBrains = [] } = await this.api.get('/connections');
    const clientCards = clients.map(a => `
      <div class="card agent-card">
        <div class="agent-header">
          <span class="agent-title">${esc(a.agentName)}</span>
          ${badge(a.live ? 'live' : 'stale', a.live ? '#22C55E' : '#94A3B8')}
        </div>
        <p style="margin:6px 0">${badge(a.platform, '#D97757')} ${badge(a.status, STATUS_COLORS[a.status] || '#94A3B8')}</p>
        ${a.capabilities?.length ? `<p style="font-size:0.78rem; color:var(--text-muted); margin-top:6px">${a.capabilities.map(c => esc(c)).join(' · ')}</p>` : ''}
        ${usageMeters(a.capabilities, usage)}
        <div class="agent-footer">
          <span><i data-lucide="heart" style="width:12px;height:12px;vertical-align:middle;margin-right:2px"></i> ${timeAgo(a.lastHeartbeat)}</span>
          <span>joined ${timeAgo(a.registeredAt)}</span>
        </div>
      </div>`);

    // The cowork host's own metered brains (local claude/codex) get one card of
    // their own — they belong to no MCP client but their quota matters just as
    // much when picking a brain.
    const hostMeters = usageMeters(localBrains, usage);
    if (hostMeters) clientCards.unshift(`
      <div class="card agent-card">
        <div class="agent-header">
          <span class="agent-title">cowork host</span>
          ${badge('local', '#0EA5E9')}
        </div>
        <p style="margin:6px 0; font-size:0.78rem; color:var(--text-muted)">Brains the dispatcher runs on this machine.</p>
        ${hostMeters}
      </div>`);

    const cardsHtml = clientCards.length ? `<div class="grid-3">${clientCards.join('')}</div>`
      : `<div class="empty-state"><div class="empty-state-icon"><i data-lucide="plug"></i></div><h3>No live MCP clients</h3><p>External clients appear here when they register + heartbeat.</p></div>`;

    // Invocation counters: per client × per brain (ran / submitted)
    const clientsSet = new Set([...Object.keys(counters.ran || {}), ...Object.keys(counters.submitted || {})]);
    const counterRows = [...clientsSet].map(cl => {
      const ran = counters.ran?.[cl] || {}, sub = counters.submitted?.[cl] || {};
      const brains = [...new Set([...Object.keys(ran), ...Object.keys(sub)])];
      return brains.map(b => `<tr><td style="padding:2px 10px 2px 0">${esc(cl)}</td><td style="padding:2px 10px 2px 0">${badge(b, '#7C3AED')}</td><td style="text-align:right;padding-right:12px">${ran[b] || 0}</td><td style="text-align:right">${sub[b] || 0}</td></tr>`).join('');
    }).join('');

    this.contentEl.innerHTML = `
      ${cardsHtml}
      <div class="card" style="margin-top:var(--space-lg)">
        <h3 style="font-size:0.95rem; margin-bottom:8px">Brain invocations <span style="font-size:0.72rem;color:var(--text-muted);font-weight:400">(this session · resets on restart)</span></h3>
        ${counterRows ? `<table style="font-size:0.83rem"><thead><tr style="color:var(--text-muted);font-size:0.75rem"><th style="text-align:left">client</th><th style="text-align:left">brain</th><th style="text-align:right;padding-right:12px">ran</th><th style="text-align:right">submitted</th></tr></thead><tbody>${counterRows}</tbody></table>` : '<p style="color:var(--text-muted);font-size:0.85rem">No invocations yet.</p>'}
      </div>`;
  }

  // ── Inbox ──────────────────────────────────────────────────────────────

  /**
   * Make one chain container drag-sortable. `save(orderedBrainIds)` is called on
   * drop and on ✕ removal. Shared by the Brains default chain and every Agents
   * chain so reordering behaves identically everywhere.
   */
  wireChainDnd(container, save) {
    if (!container) return;
    const ids = () => [...container.querySelectorAll('.dchip')].map(c => c.dataset.brain);
    let dragged = null;
    container.querySelectorAll('.dchip').forEach(c => {
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
    container.addEventListener('drop', (e) => { e.preventDefault(); save(ids()); });
    container.querySelectorAll('[data-rm]').forEach(a => a.addEventListener('click', (e) => {
      e.stopPropagation();
      save(ids().filter(b => b !== a.dataset.rm));
    }));
  }

  // ── Chat (dispatch a task to a brain/agent and stream back its result) ─────

  async renderChat() {
    const [brains, divisions] = await Promise.all([this.api.get('/brains'), this.api.get('/roster-divisions')]);
    this._chatDivisions = divisions;
    const sel = 'padding:6px 10px;background:transparent;border:none;border-radius:12px;color:var(--text-secondary);font-size:0.8rem;cursor:pointer;outline:none;font-weight:500;transition:background 0.2s;';
    const brainOpts = ['<option value="">🧠 Auto (route via chain)</option>']
      .concat(Object.keys(brains).sort().map(b => `<option value="${esc(b)}">${esc(b)}</option>`)).join('');
    const divOpts = ['<option value="">— any division —</option>']
      .concat(Object.entries(divisions).sort().map(([d, i]) => `<option value="${esc(d)}">${esc(i.label || d)} (${i.agents.length})</option>`)).join('');

    this.contentEl.innerHTML = `
      <div style="display:flex;flex-direction:column;height:calc(100vh - 130px);min-height:420px;position:relative">
        ${this.chatRecentBar()}
        
        <div id="chat-msgs" class="chat-messages-area"></div>
        
        <div class="chat-input-container">
          <div class="chat-input-toolbar-top">
            <select id="chat-brain" style="${sel}">${brainOpts}</select>
            <select id="chat-div" style="${sel}">${divOpts}</select>
            <select id="chat-agent" style="${sel}"><option value="">— none (chat brain directly) —</option></select>
            <button id="chat-new" class="icon-btn-ghost" style="margin-left:auto;font-size:0.78rem;padding:6px 10px;border-radius:12px;width:auto;height:auto">＋ New chat</button>
          </div>
          
          <div id="chat-attachments" class="chat-attachments"></div>
          
          <textarea id="chat-input" rows="1" placeholder="Ask anything..." class="chat-input-textarea"></textarea>
          
          <div class="chat-input-toolbar-bottom">
            <input type="file" id="chat-files" multiple style="display:none">
            <button id="chat-attach" class="icon-btn-ghost" title="Attach files" aria-label="Attach files"><i data-lucide="paperclip"></i></button>
            <button id="chat-mic" class="icon-btn-ghost" title="Voice input" aria-label="Voice input"><i data-lucide="mic"></i></button>
            <div style="flex:1"></div>
            <button id="chat-send" class="icon-btn-primary" aria-label="Send"><i data-lucide="send"></i></button>
          </div>
        </div>
      </div>`;

    const brainEl = this.contentEl.querySelector('#chat-brain');
    const divEl = this.contentEl.querySelector('#chat-div');
    const agentEl = this.contentEl.querySelector('#chat-agent');
    brainEl.value = this.chatSel.brain || '';
    divEl.value = this.chatSel.division || '';
    this.populateChatAgents(this.chatSel.division);
    agentEl.value = this.chatSel.agent || '';

    brainEl.addEventListener('change', () => { this.chatSel.brain = brainEl.value; });
    divEl.addEventListener('change', () => { this.chatSel.division = divEl.value; this.chatSel.agent = ''; this.populateChatAgents(divEl.value); });
    agentEl.addEventListener('change', () => { this.chatSel.agent = agentEl.value; });

    const input = this.contentEl.querySelector('#chat-input');
    
    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });

    // Send even with no text if files are attached (e.g. "here, read these").
    const doSend = () => {
      const t = input.value.trim();
      if (!t && !this.chatAttachments.length) return;
      const busyKey = this.chatSel.brain || 'auto';
      if (this.chatBusyBrains.has(busyKey)) {
        this.toast('brain busy', `${busyKey === 'auto' ? 'Auto-routed chat' : busyKey} is still working — pick another brain or wait for its reply.`);
        return;
      }
      input.value = ''; input.style.height = 'auto'; this.sendChat(t);
    };
    this.contentEl.querySelector('#chat-send').addEventListener('click', doSend);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    this.contentEl.querySelector('#chat-new').addEventListener('click', () => this.startNewChat());

    // Mic Support (Web Speech API)
    const micBtn = this.contentEl.querySelector('#chat-mic');
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      let isRecording = false;

      recognition.onresult = (event) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        if (finalTranscript) {
          const startPos = input.selectionStart;
          const endPos = input.selectionEnd;
          input.value = input.value.substring(0, startPos) + finalTranscript + ' ' + input.value.substring(endPos, input.value.length);
          input.selectionStart = input.selectionEnd = startPos + finalTranscript.length + 1;
          input.dispatchEvent(new Event('input')); // trigger auto-resize
        }
      };
      
      recognition.onstart = () => {
        isRecording = true;
        micBtn.style.color = '#EF4444';
        micBtn.classList.add('recording-pulse');
      };
      
      recognition.onend = () => {
        isRecording = false;
        micBtn.style.color = '';
        micBtn.classList.remove('recording-pulse');
      };

      micBtn.addEventListener('click', () => {
        if (isRecording) {
          recognition.stop();
        } else {
          recognition.start();
        }
      });
    } else {
      micBtn.style.display = 'none'; // hide if not supported
    }

    // File attachments (staged client-side; uploaded as task inputs on send).
    const fileEl = this.contentEl.querySelector('#chat-files');
    this.contentEl.querySelector('#chat-attach').addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', () => {
      this.chatAttachments.push(...Array.from(fileEl.files || []));
      fileEl.value = '';
      this.renderChatAttachments();
    });

    this.renderChatMessages();
    this.renderChatAttachments();
    input.focus();
  }

  // ── Recent chat sessions (persisted client-side; 5 newest shown atop the view) ──

  loadChatSessions() {
    try { const v = JSON.parse(localStorage.getItem('cowork.chatSessions') || '[]'); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }

  saveChatSessions() {
    // Cap what we persist so history can't grow unbounded; best-effort (a disabled
    // or full localStorage must never break the chat).
    try { localStorage.setItem('cowork.chatSessions', JSON.stringify(this.chatSessions.slice(0, 30))); }
    catch { /* storage unavailable — recent list is a nicety, not required */ }
  }

  /** Snapshot the open conversation into the session list (newest first). No-op
   *  until there's at least one completed message worth remembering. */
  persistCurrentChat() {
    const msgs = this.chatMessages.filter(m => !m.pending && (m.content || '').trim());
    if (!msgs.length) return;
    const firstUser = msgs.find(m => m.role === 'user');
    const title = (firstUser?.content || 'chat').replace(/\s+/g, ' ').trim().slice(0, 48) || 'chat';
    if (!this.chatSessionId) this.chatSessionId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const rec = {
      id: this.chatSessionId,
      title,
      sel: { ...this.chatSel },
      messages: msgs.map(m => ({ role: m.role, content: m.content, meta: m.meta || null })),
      updatedAt: new Date().toISOString()
    };
    this.chatSessions = [rec, ...this.chatSessions.filter(s => s.id !== rec.id)];
    this.saveChatSessions();
  }

  startNewChat() {
    this.persistCurrentChat();      // keep the conversation being left behind
    this.chatMessages = [];
    this.chatSessionId = null;
    this.chatAttachments = [];
    this.renderChatMessages();
    this.renderChatAttachments();
    this.renderChatRecent();
  }

  openChatSession(id) {
    const rec = this.chatSessions.find(s => s.id === id);
    if (!rec) return;
    this.persistCurrentChat();      // save whatever's open before switching away
    this.chatSessionId = rec.id;
    this.chatAttachments = [];       // drop composer attachments when switching sessions
    this.chatSel = { brain: '', division: '', agent: '', ...(rec.sel || {}) };
    this.chatMessages = (rec.messages || []).map(m => ({ ...m }));
    this.renderChat();              // rebuild selects + transcript from the restored state
  }

  deleteChatSession(id) {
    this.chatSessions = this.chatSessions.filter(s => s.id !== id);
    this.saveChatSessions();
    if (this.chatSessionId === id) { this.chatMessages = []; this.chatSessionId = null; this.renderChatMessages(); }
    this.renderChatRecent();
  }

  /** The recent-sessions list shown above the brain/agent select row. Takes the
   *  5 most-recent sessions and lays them out vertically, sorted by time with the
   *  OLDEST at the top and the LATEST at the bottom of the list.
   *  Always emits the #chat-recent container (hidden when empty) so it can be
   *  refreshed in place. Every interpolated value is esc()'d (no raw HTML). */
  chatRecentBar() {
    // chatSessions is kept newest-first; take the 5 newest, then order them
    // ascending by updatedAt so the display reads oldest (top) → latest (bottom).
    const recent = this.chatSessions.slice(0, 5)
      .sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));
    const inner = recent.map(s => {
      const active = s.id === this.chatSessionId;
      const target = s.sel?.agent || s.sel?.brain || (s.sel?.division ? 'division:' + s.sel.division : 'auto');
      return `<span class="chat-recent-chip" data-chat-open="${esc(s.id)}" title="${esc(s.title)}"
        style="display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:5px 9px;border-radius:999px;border:1px solid var(--bg-tertiary);background:${active ? 'var(--bg-tertiary)' : 'var(--bg-secondary)'};font-size:0.74rem;cursor:pointer">
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px">${esc(s.title || 'chat')}</span>
        <span style="color:var(--text-muted);white-space:nowrap">${esc(target)} · ${timeAgo(s.updatedAt)}</span>
        <span data-chat-del="${esc(s.id)}" title="Delete" style="opacity:.55;padding:0 2px;font-weight:600">×</span>
      </span>`;
    }).join('');
    return `<div id="chat-recent" style="display:${recent.length ? 'flex' : 'none'};flex-direction:column;gap:6px;align-items:stretch;margin-bottom:8px">
      <span style="font-size:0.7rem;color:var(--text-muted)">Recent</span>${inner}
    </div>`;
  }

  renderChatRecent() {
    const el = this.contentEl.querySelector('#chat-recent');
    if (el) el.outerHTML = this.chatRecentBar();
  }

  populateChatAgents(division) {
    const el = this.contentEl.querySelector('#chat-agent');
    if (!el) return;
    const info = division && this._chatDivisions ? this._chatDivisions[division] : null;
    const opts = info ? info.agents.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map(a => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join('') : '';
    el.innerHTML = '<option value="">— none (chat brain directly) —</option>' + opts;
    el.disabled = !info;
  }

  chatBubble(m) {
    const user = m.role === 'user';
    const body = user ? esc(m.content).replace(/\n/g, '<br>')
      : (m.pending ? '<span style="opacity:.6">▋ thinking…</span>' : md(m.content || '(no output)'));
    const meta = m.meta ? `<div style="font-size:0.66rem;opacity:.6;margin-bottom:3px">${esc(m.meta)}</div>` : '';
    return `<div style="display:flex;justify-content:${user ? 'flex-end' : 'flex-start'};margin:8px 0">
      <div class="md-block" style="max-width:80%;padding:9px 12px;border-radius:12px;overflow-x:auto;font-size:0.88rem;line-height:1.5;background:${user ? '#7C3AED' : 'var(--bg-secondary)'};color:${user ? '#fff' : 'inherit'}">${meta}${body}</div>
    </div>`;
  }

  renderChatMessages() {
    const box = this.contentEl.querySelector('#chat-msgs');
    if (!box) return;
    box.innerHTML = this.chatMessages.length
      ? this.chatMessages.map(m => this.chatBubble(m)).join('')
      : '<div style="color:var(--text-muted);text-align:center;margin-top:40px;font-size:0.85rem">Start a conversation — your message is dispatched to the selected brain/agent and the reply is the task result.</div>';
    box.scrollTop = box.scrollHeight;
  }

  // The strip of staged file chips above the composer (hidden when empty).
  renderChatAttachments() {
    const box = this.contentEl.querySelector('#chat-attachments');
    if (!box) return;
    if (!this.chatAttachments.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'flex';
    box.innerHTML = this.chatAttachments.map((f, i) => `
      <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;border:1px solid var(--bg-tertiary);background:var(--bg-secondary);font-size:0.74rem">
        <i data-lucide="file" style="width:12px;height:12px"></i>
        <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
        <span style="color:var(--text-muted)">${fmtBytes(f.size)}</span>
        <span data-att-rm="${i}" title="Remove" style="cursor:pointer;opacity:.6;font-weight:600">×</span>
      </span>`).join('');
    box.querySelectorAll('[data-att-rm]').forEach(el => el.addEventListener('click', () => {
      this.chatAttachments.splice(Number(el.dataset.attRm), 1);
      this.renderChatAttachments();
    }));
    createIcons();
  }

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

  buildChatDescription() {
    const done = this.chatMessages.filter(m => !m.pending);
    if (done.length <= 1) return done[done.length - 1]?.content || '';
    return done.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  }

  async sendChat(text) {
    const { brain, division, agent } = this.chatSel;
    // Lock only THIS brain (or the auto-route lane) while its task runs; the
    // user can switch the selector and chat with any other brain in parallel.
    const busyKey = brain || 'auto';
    this.chatBusyBrains.add(busyKey);
    const context = {};
    if (brain) context.brain = brain;
    if (agent) context.agent = agent; else if (division) context.division = division;
    const target = agent || (division ? `division:${division}` : (brain || 'auto'));
    // Take (and clear) the staged attachments for this send.
    const attachments = this.chatAttachments;
    this.chatAttachments = [];
    this.renderChatAttachments();
    const attachNote = attachments.length ? `📎 ${attachments.map(f => f.name).join(', ')}` : '';
    const userContent = [text, attachNote].filter(Boolean).join('\n');
    this.chatMessages.push({ role: 'user', content: userContent });
    const ph = { role: 'assistant', content: '', pending: true, meta: `↳ ${target}${brain && agent ? ' · ' + brain : ''}` };
    this.chatMessages.push(ph);
    this.renderChatMessages();
    try {
      // Upload attachments first so the created task carries them as inputs.
      const inputs = attachments.length ? await this.uploadInputFiles(attachments) : [];
      const body = {
        title: text.slice(0, 60) || (attachments.length ? `Review ${attachments.length} file(s)` : 'chat'),
        description: this.buildChatDescription(),
        from: { platform: 'chat', agent: 'dashboard' },
        context, tags: ['chat']
      };
      if (inputs.length) body.inputs = inputs;
      const task = await this.api.post('/inbox', body);
      const done = await this.pollChatTask(task.id);
      const c = done.context || {};
      const ranAgent = c.ranAgent ? (c.ranDivision ? `${c.ranDivision}/${c.ranAgent}` : c.ranAgent) : '';
      const ranBrain = c.ranBrain || c.brain || brain || '';
      ph.pending = false;
      ph.content = done.status === 'done'
        ? (done.failed ? `⚠️ ${done.result || 'Task failed.'}` : (done.result || '(no output)'))
        : `⚠️ task ${done.status}${done.result ? ': ' + done.result : ''}`;
      ph.meta = [ranAgent, ranBrain].filter(Boolean).join(' · ') || null;
    } catch (e) {
      ph.pending = false; ph.content = `⚠️ ${e.message}`;
    } finally {
      this.chatBusyBrains.delete(busyKey);
      this.renderChatMessages();
      this.persistCurrentChat();   // snapshot this exchange into the recent list
      this.renderChatRecent();
    }
  }

  async pollChatTask(id, timeoutMs = 1500000) {
    const start = Date.now();
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      let t;
      try { t = await this.api.get(`/inbox/${encodeURIComponent(id)}`); } catch { t = null; }
      if (t && (t.status === 'done' || t.status === 'rejected')) return t;
      if (Date.now() - start > timeoutMs) return { status: 'timed-out', result: '(no response within 25 min)', context: {} };
    }
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

  async renderInbox() {
    this.inboxLimit = this.inboxLimit || 50;
    const filter = this.inboxFilter;
    const fetchLimit = this.inboxLimit + 1;
    const q = filter ? `?status=${filter}&limit=${fetchLimit}` : `?limit=${fetchLimit}`;
    let [tasks, status] = await Promise.all([
      this.api.get(`/inbox${q}`),
      this.api.get('/status').catch(() => null),
      this.refreshAgents()
    ]);

    let hasMore = false;
    if (tasks.length > this.inboxLimit) {
      hasMore = true;
      tasks = tasks.slice(0, this.inboxLimit);
    }

    // Per-status counts on the filter pills (from the dashboard summary; the
    // "done" pill excludes failed tasks, mirroring the server's done filter).
    const s = status?.inboxSummary;
    const counts = s ? {
      done: Math.max(0, (s.completed || 0) - (s.failed || 0)),
      'in-progress': s.inProgress || 0, pending: s.pending || 0,
      scheduled: s.scheduled || 0,
      'wait-input': s.waitingInput || 0, failed: s.failed || 0
    } : null;
    const pills = ['', 'done', 'in-progress', 'pending', 'scheduled', 'wait-input', 'failed'].map(f => {
      const n = counts && f ? counts[f] : null;
      const label = (f === '' ? 'All' : f) + (n !== null && n !== undefined ? ` ${n}` : '');
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

    const rows = tasks.length ? tasks.map(t => {
      const c = t.context || {};
      // Which agent + brain ran it (item 5), or the requested assignment.
      const agentLabel = c.ranAgent ? (c.ranDivision ? `${c.ranDivision} / ${c.ranAgent}` : c.ranAgent)
        : (c.division ? `${c.division} / ${c.agent || '?'}` : (c.agent || c.role || ''));
      const brainLabel = c.ranBrain || c.brain || '';
      // Fallback trail: brains that failed verification and were handed over.
      const failedBrains = Array.isArray(c.failedBrains) ? c.failedBrains : [];
      const arts = Array.isArray(t.artifacts) ? t.artifacts : [];
      const inputs = Array.isArray(c.inputFiles) ? c.inputFiles : [];
      const failed = isTaskFailed(t);
      // Files can be attached while a task is still schedulable, or to a failed one
      // (attach context, then re-run).
      const canAttach = ['pending', 'wait-input', 'scheduled'].includes(t.status) || failed;
      // Vertical brain fallback chain — brains in the order they were tried, the
      // last one at the bottom. Failed rungs are red with their reason; the final
      // (running / successful) brain sits at the end.
      const chain = failedBrains.map(f => ({
        brain: f.brain, reason: f.reason || 'failed', ok: false
      }));
      const lastFailed = failedBrains.length ? failedBrains[failedBrains.length - 1].brain : null;
      if (brainLabel && brainLabel !== lastFailed) chain.push({ brain: brainLabel, ok: !failed, final: true });
      const chainHtml = chain.length ? `<div class="task-brain-chain" style="display:flex; flex-direction:column; gap:3px; padding:2px 0 6px">
        ${chain.map((r, i) => {
          const col = r.ok ? '#22C55E' : (r.final ? BRAIN_COLOR : '#EF4444');
          const icon = r.ok ? '✓' : (r.final ? '●' : '✗');
          return `<div style="display:flex; align-items:center; gap:6px; font-size:0.8rem">
            <span style="width:14px; text-align:right; color:var(--text-muted); font-size:0.7rem">${i + 1}</span>
            <span class="badge" style="background:${col}18; color:${col}; border:1px solid ${col}40">${icon} ${esc(r.brain)}</span>
            ${r.reason ? `<span style="color:var(--text-muted); font-size:0.74rem">${esc(r.reason)}</span>` : ''}
          </div>`;
        }).join('')}
      </div>` : '';
      return `
      <div class="card task-card" style="margin-bottom: var(--space-md)${failed ? ';border-left:3px solid #EF4444' : ''}" data-task="${esc(t.id)}" data-title="${esc((t.title || '').toLowerCase())}">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
          ${failed ? badge('failed', '#EF4444') : badge(t.status, STATUS_COLORS[t.status] || '#94A3B8')}
          ${t.status === 'scheduled' && t.scheduledAt ? badge(`⏰ ${new Date(t.scheduledAt).toLocaleString()}`, '#6366F1') : ''}
          ${agentLabel ? badge(agentLabel, '#7C3AED') : ''}
          ${t.interaction && t.interaction.status !== 'submitted' ? badge('⌛ awaiting input', '#EAB308') : ''}
          ${t.interaction && t.interaction.status === 'submitted' ? badge('✓ input received', '#22C55E') : ''}
          ${inputs.length ? badge(`📎 ${inputs.length}`, '#0EA5E9') : ''}
          ${t.priority && t.priority !== 'normal' ? badge(t.priority, t.priority === 'urgent' ? '#EF4444' : (t.priority === 'high' ? '#EAB308' : '#94A3B8')) : ''}
          ${(Array.isArray(t.tags) ? t.tags : []).filter(tag => tag !== 'chat').map(tag => badge('#' + tag, '#64748B')).join('')}
          <span class="task-caret" style="margin-left:auto; color:var(--text-muted); font-size:0.72rem; user-select:none">${this.openTasks.has(t.id) ? '▾' : '▸'}</span>
        </div>
        <div style="margin:7px 0 3px"><strong style="font-size:1.02rem">${esc(t.title)}</strong></div>
        ${chainHtml}
        <div class="task-meta" style="display:block; margin:2px 0 4px">${esc(t.from?.platform || '?')}/${esc(t.from?.agent || '?')} · <span title="${esc(t.createdAt || '')}">${timeAgo(t.createdAt)}</span>
          ${failed ? `<button class="btn" data-rerun-task="${esc(t.id)}" data-brain="${esc(c.brainAuto ? '' : (c.brain || ''))}" title="Re-run this task — pick which brain claims it"
            style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#EF4444;border-color:#EF444466">↻ Re-run</button>` : ''}
          ${t.status === 'done' && !failed ? (t.context?.continuedInto
            ? `<button class="btn" disabled title="Already continued — a follow-up task was spawned from this run"
            style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#22C55E99;border-color:#22C55E33;opacity:.6;cursor:default">✓ Continued</button>`
            : `<button class="btn" data-continue-task="${esc(t.id)}" data-brain="${esc(brainLabel)}" title="Continue this task — spawn a follow-up seeded with this run's outputs; pick which brain claims it"
            style="font-size:0.72rem;margin-left:8px;padding:2px 7px;color:#22C55E;border-color:#22C55E66">▸ Continue</button>`) : ''}
          <button class="btn" data-del-task="${esc(t.id)}" title="Delete this task, its reports and artifacts"
            style="font-size:0.72rem;margin-left:6px;padding:2px 7px">✕</button></div>
        <div class="task-ids" style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:4px 0 2px; font-size:0.72rem; color:var(--text-muted)">
          <span class="copyable" data-copy="${esc(t.id)}" title="Task ID — click to copy" style="cursor:pointer; font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
            <i data-lucide="hash" style="width:11px;height:11px;vertical-align:-1px"></i>${esc(t.id)}</span>
          <span class="copyable" data-copy="artifacts/${esc(t.id)}/" title="Artifacts directory — click to copy" style="cursor:pointer; font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
            <i data-lucide="folder" style="width:11px;height:11px;vertical-align:-1px"></i>artifacts/${esc(t.id)}/</span>
        </div>
        ${arts.length ? `<div class="task-artifacts" style="display:flex; flex-wrap:wrap; align-items:center; gap:4px; padding:6px 0 2px">
          <span style="font-size:0.85rem; color:var(--text-muted); margin-right:2px; text-transform:uppercase; letter-spacing:.03em">Artifacts</span>
          ${arts.map(f => `<a href="/api/artifacts/${encodeURIComponent(t.id)}/${encodeURIComponent(f)}" download class="btn" style="font-size:0.9rem;margin:0;display:inline-flex;align-items:center;gap:4px"><i data-lucide="download" style="width:12px;height:12px"></i>${esc(f)}</a>`).join('')}</div>` : ''}
        ${(inputs.length || canAttach) ? `<div class="task-inputs" style="display:flex; flex-wrap:wrap; align-items:center; gap:4px; padding:6px 0 2px">
          <span style="font-size:0.72rem; color:var(--text-muted); margin-right:2px; text-transform:uppercase; letter-spacing:.03em">Inputs</span>
          ${inputs.map(f => `<a href="/api/inputs/${encodeURIComponent(t.id)}/${encodeURIComponent(f)}" download class="btn" style="font-size:0.78rem;margin:0;display:inline-flex;align-items:center;gap:4px"><i data-lucide="paperclip" style="width:12px;height:12px"></i>${esc(f)}</a>`).join('')}
          ${canAttach ? `<input type="file" data-attach-files="${esc(t.id)}" multiple style="display:none">
          <button class="btn" data-attach-input="${esc(t.id)}" title="Attach files for the brain to read" style="font-size:0.75rem;margin:0">＋ Attach files</button>` : ''}</div>` : ''}
        <div class="task-detail"${this.openTasks.has(t.id) ? ' style="display:block"' : ''}>
          ${mdViewer(t.description, 'DESCRIPTION', { big: true })}
          ${this.interactionBlock(t)}
          ${t.result ? `<div style="margin-top:12px">${mdViewer(t.result, 'RESULT', { big: true })}</div>` : ''}
          ${t.claimedBy ? `<p style="font-size:0.8rem; color:var(--text-muted); margin-top:8px">Claimed by ${esc(this.agentLabel(t.claimedBy))}${t.completedAt ? ` · completed <span title="${esc(t.completedAt)}">${timeAgo(t.completedAt)}</span>` : ''}</p>` : ''}
        </div>
      </div>`;
    }).join('') : `<div class="empty-state"><p>No tasks${this.inboxFilter ? ` with status "${esc(this.inboxFilter)}"` : ''}.</p></div>`;

    // #content is the scroll container — preserve the reading position across
    // SSE-driven re-renders instead of snapping back to the top.
    const scrollY = this.contentEl.scrollTop;
    this.contentEl.innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap">${pills}
        <span style="margin-left:auto; display:flex; gap:6px; align-items:center">
          <button class="btn" id="new-task-btn" title="Create and dispatch a new task" style="font-size:0.78rem; color:#22C55E; border-color:#22C55E66">＋ New task</button>
          <span style="font-size:0.75rem;color:var(--text-muted)">purge done &gt;</span>
          <input id="purge-days" type="number" min="0" value="30" style="width:58px;padding:4px 6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.78rem">
          <span style="font-size:0.75rem;color:var(--text-muted)">days</span>
          <button class="btn" id="purge-btn" title="Delete finished tasks older than N days — including ones with artifacts. Only keep/important/pinned-tagged tasks are spared. You'll be asked to confirm." style="font-size:0.75rem">Purge…</button>
        </span>
      </div>
      <input id="inbox-search" type="search" placeholder="Search titles…" value="${esc(this.inboxSearch || '')}"
        style="width:100%; margin-bottom: var(--space-lg); padding:8px 12px; background:var(--bg-tertiary); border:1px solid var(--bg-tertiary); border-radius:10px; color:inherit; font:inherit; font-size:0.85rem">
      <div id="inbox-nomatch" style="display:none; color:var(--text-muted); font-size:0.85rem; padding:8px 0">No task titles match your search.</div>
      ${rows}
      ${hasMore ? `<div id="inbox-load-more" style="text-align:center; margin-top:20px; margin-bottom:20px; color:var(--text-muted); font-size:0.85rem;">Loading more tasks...</div>` : ''}`;
    this.contentEl.scrollTop = scrollY;

    this.contentEl.querySelectorAll('[data-filter]').forEach(b =>
      b.addEventListener('click', () => { this.inboxLimit = 50; this.inboxFilter = b.dataset.filter; this.renderInbox(); }));
      
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

    // Delete one task (+ its reports and artifacts).
    this.contentEl.querySelectorAll('[data-del-task]').forEach(b =>
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

    // Re-run a failed task — pick which brain claims it, then reset to pending.
    this.contentEl.querySelectorAll('[data-rerun-task]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.rerunTask;
        const title = b.closest('[data-task]')?.dataset.title || id.slice(0, 8);
        const choice = await this.pickBrain({
          title: 'Re-run this failed task',
          body: `<strong>${esc(title)}</strong> is reset to pending and dispatched again. Choose which brain should claim it — pick <em>Auto</em> to route from the top of the agent's brain chain.`,
          defaultBrain: b.dataset.brain || '',
          confirmLabel: '↻ Re-run',
          confirmColor: '#EF4444'
        });
        if (!choice) return;
        b.disabled = true;
        try {
          await this.api.post(`/inbox/${encodeURIComponent(id)}/rerun`, { brain: choice.brain });
          this.toast('re-running', choice.brain ? `Reset to pending — pinned to ${choice.brain}.` : 'Reset to pending — auto-routed via the brain chain.');
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); b.disabled = false; }
      }));

    // Continue a done task — pick which brain claims the follow-up.
    this.contentEl.querySelectorAll('[data-continue-task]').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.continueTask;
        const title = b.closest('[data-task]')?.dataset.title || id.slice(0, 8);
        const choice = await this.pickBrain({
          title: 'Continue this task',
          body: `A follow-up to <strong>${esc(title)}</strong> is created with this run's output files and result attached as inputs. Add an optional prompt or extra files to steer it, then choose which brain claims it — <em>Auto</em> routes via the agent's brain chain.`,
          defaultBrain: b.dataset.brain || '',
          confirmLabel: '▸ Continue',
          confirmColor: '#22C55E',
          withInputs: true
        });
        if (!choice) return;
        b.disabled = true;
        try {
          // Upload the staged extras first so the follow-up carries them as inputs.
          const inputs = choice.files?.length ? await this.uploadInputFiles(choice.files) : [];
          const body = { brain: choice.brain };
          if (choice.prompt) body.prompt = choice.prompt;
          if (inputs.length) body.inputs = inputs;
          await this.api.post(`/inbox/${encodeURIComponent(id)}/continue`, body);
          const extras = [choice.prompt ? 'prompt' : null, inputs.length ? `${inputs.length} file(s)` : null].filter(Boolean).join(' + ');
          const routeNote = choice.brain ? `pinned to ${choice.brain}` : 'auto-routed via the brain chain';
          this.toast('continuing', `Follow-up queued — ${routeNote}${extras ? ` · added ${extras}` : ''}.`);
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); b.disabled = false; }
      }));

    // Attach input files to an existing task (upload → append to context.inputFiles).
    this.contentEl.querySelectorAll('[data-attach-input]').forEach(b =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const inp = this.contentEl.querySelector(`[data-attach-files="${CSS.escape(b.dataset.attachInput)}"]`);
        if (inp) inp.click();
      }));
    this.contentEl.querySelectorAll('[data-attach-files]').forEach(inp =>
      inp.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = inp.dataset.attachFiles;
        const files = Array.from(inp.files || []);
        if (!files.length) return;
        try {
          const attached = await this.uploadInputFiles(files);
          await this.api.post(`/inbox/${encodeURIComponent(id)}/inputs`, { inputs: attached });
          this.toast('files attached', `${attached.length} file(s) added — the brain will read them.`);
          this.renderInbox();
        } catch (err) { this.toast('error', err.message); }
      }));

    // Submit human interaction (questions/checklist) from a task card.
    this.contentEl.querySelectorAll('.interaction-submit').forEach(btn =>
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

    // Click a task ID or artifacts path to copy it to the clipboard.
    this.contentEl.querySelectorAll('[data-copy]').forEach(el =>
      el.addEventListener('click', async (e) => {
        e.stopPropagation();   // don't toggle the card
        const text = el.dataset.copy;
        if (await this.copyText(text)) this.toast('copied', text);
        else this.toast('copy failed', text);
      }));

    this.contentEl.querySelectorAll('[data-task]').forEach(card =>
      card.addEventListener('click', (e) => {
        if (e.target.closest('pre, .md-block, a, button, input, textarea, select, label, .task-interaction, .copyable')) return;   // don't toggle when interacting with content
        const d = card.querySelector('.task-detail');
        const open = !(d.style.display === 'block');
        d.style.display = open ? 'block' : 'none';
        // Remember which cards are open so SSE-driven re-renders don't collapse them.
        if (open) this.openTasks.add(card.dataset.task); else this.openTasks.delete(card.dataset.task);
        const caret = card.querySelector('.task-caret');
        if (caret) caret.textContent = open ? '▾' : '▸';
        createIcons();
      }));

    this.applyInboxSearch();
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

  // ── Workflows (declarative DAG templates + live runs) ──────────────────

  // Group nodes into topological layers so the DAG renders top→bottom with each
  // node below everything it depends on. Nodes: {key, dependsOn:[key,…]}.
  _dagLayers(nodes) {
    const byKey = new Map(nodes.map(n => [n.key, n]));
    const depth = new Map();
    const visit = (k, stack) => {
      if (depth.has(k)) return depth.get(k);
      if (stack.has(k)) return 0;                 // cycle guard (server rejects these)
      stack.add(k);
      const deps = (byKey.get(k)?.dependsOn || []).filter(d => byKey.has(d));
      const v = deps.length ? 1 + Math.max(...deps.map(d => visit(d, stack))) : 0;
      stack.delete(k);
      depth.set(k, v);
      return v;
    };
    nodes.forEach(n => visit(n.key, new Set()));
    const layers = [];
    nodes.forEach(n => { const l = depth.get(n.key) || 0; (layers[l] ||= []).push(n); });
    return layers;
  }

  _dagNode(n) {
    const color = n.status ? (STATUS_COLORS[n.status] || '#94A3B8') : '#7C3AED';
    return `<div class="wf-node"${n.taskId ? ` data-wf-task="${esc(n.taskId)}" style="cursor:pointer;border-color:${color}66"` : ` style="border-color:${color}66"`}>
      <div class="wf-node-top"><span class="wf-dot" style="background:${color}"></span><strong>${esc(n.label)}</strong>${n.status ? badge(n.status, color) : ''}</div>
      ${n.sub ? `<div class="wf-node-sub">${esc(n.sub)}</div>` : ''}
    </div>`;
  }

  _dagHtml(nodes) {
    return this._dagLayers(nodes).map((layer, i) =>
      `${i > 0 ? '<div class="wf-arrow"><i data-lucide="chevron-down"></i></div>' : ''}<div class="wf-layer">${layer.map(n => this._dagNode(n)).join('')}</div>`
    ).join('');
  }

  // Orchestrated templates have no fixed graph — the steps are a LIBRARY the
  // orchestrator picks from at runtime. Render them as an unconnected candidate
  // pool so it's visually clear the path isn't predetermined.
  _stepLibraryHtml(nodes) {
    return `<div class="wf-layer" style="justify-content:flex-start">${nodes.map(n => this._dagNode(n)).join('')}</div>`;
  }

  // An orchestrated run's decision log: the ordered steps the orchestrator chose
  // (each with its rationale + the task's status), then a terminal node — either
  // "goal met", or a live "deciding…" pulse while the orchestrator is thinking.
  _orchestratedRunHtml(r) {
    const byId = {};
    r.tasks.forEach(t => { byId[t.id] = t; });
    const picks = (r.history || []).filter(h => h.stepKey);
    const doneEntry = (r.history || []).find(h => h.stepKey === null);
    const openTask = r.tasks.some(t => t.status !== 'done' && t.status !== 'rejected');

    const rows = picks.map((h, i) => {
      const t = h.taskId ? byId[h.taskId] : null;
      const status = t?.status || 'pending';
      const color = STATUS_COLORS[status] || '#94A3B8';
      return `${i > 0 ? '<div class="wf-arrow"><i data-lucide="chevron-down"></i></div>' : ''}
        <div class="wf-node"${t ? ` data-wf-task="${esc(t.id)}" style="cursor:pointer;border-color:${color}66"` : ` style="border-color:${color}66"`}>
          <div class="wf-node-top"><span class="wf-dot" style="background:${color}"></span><strong>${i + 1}. ${esc(h.stepKey)}</strong>${badge(status, color)}</div>
          ${t?.title ? `<div class="wf-node-sub">${esc(t.title)}</div>` : ''}
          ${h.reason ? `<div class="wf-node-sub" style="font-style:italic;opacity:.75">🧠 ${esc(h.reason)}</div>` : ''}
        </div>`;
    }).join('');

    let terminal = '';
    if (doneEntry) {
      const ok = r.status !== 'failed';
      terminal = `<div class="wf-arrow"><i data-lucide="chevron-down"></i></div>
        <div class="wf-node" style="border-color:${ok ? '#22C55E' : '#EF4444'}66">
          <div class="wf-node-top"><span class="wf-dot" style="background:${ok ? '#22C55E' : '#EF4444'}"></span><strong>${ok ? '✓ goal met' : '✕ run failed'}</strong></div>
          ${doneEntry.reason ? `<div class="wf-node-sub" style="font-style:italic;opacity:.75">🧠 ${esc(doneEntry.reason)}</div>` : ''}
        </div>`;
    } else if (r.status === 'running' && !openTask) {
      terminal = `<div class="wf-arrow"><i data-lucide="chevron-down"></i></div>
        <div class="wf-node wf-deciding" style="border-color:#0EA5E966">
          <div class="wf-node-top"><span class="wf-dot" style="background:#0EA5E9"></span><strong>🧠 orchestrator deciding next step…</strong></div>
        </div>`;
    }
    return `<div class="wf-dag">${rows || '<div style="font-size:0.8rem;color:var(--text-muted)">Waiting for the orchestrator to pick the first step…</div>'}${terminal}</div>`;
  }

  async renderWorkflows() {
    const [defs, runs, invalid] = await Promise.all([
      this.api.get('/workflows'), this.api.get('/workflow-runs'),
      this.api.get('/workflows-invalid').catch(() => [])
    ]);
    const inp = 'padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem';

    // Surface templates that failed to load so an author gets the reason instead
    // of a silently-missing card.
    const invalidCard = (invalid && invalid.length) ? `<div class="card" style="border-color:#EF444466;margin-bottom:var(--space-lg)">
      <div style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#EF4444"><i data-lucide="alert-triangle" style="width:15px;height:15px"></i><strong>${invalid.length} template${invalid.length > 1 ? 's' : ''} failed to load</strong></div>
      ${invalid.map(iv => `<div style="font-size:0.78rem;margin-top:6px"><code>${esc(iv.file)}</code><ul style="margin:2px 0 0 16px;color:var(--text-secondary)">${iv.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`).join('')}
    </div>` : '';

    const modeBadge = (m) => m === 'orchestrated'
      ? badge('adaptive · orchestrator-driven', '#0EA5E9')
      : badge('DAG · static', '#7C3AED');

    // Pin the workflow-builder to the top — it's the entry point authors reach for
    // most, so it should lead the list regardless of load order.
    const orderedDefs = [...defs].sort((a, b) =>
      (a.id === 'workflow-builder' ? -1 : 0) - (b.id === 'workflow-builder' ? -1 : 0));

    const tplCards = orderedDefs.length ? orderedDefs.map(def => {
      const orchestrated = def.mode === 'orchestrated';
      const nodes = def.steps.map(s => ({
        key: s.key, label: s.title || s.key, dependsOn: s.dependsOn || [],
        sub: [s.agent && ('@' + s.agent), s.division && ('#' + s.division), s.brain && ('🧠 ' + s.brain)].filter(Boolean).join(' · ')
      }));
      const params = (def.params || []).map(p => `<textarea data-param="${esc(p)}" placeholder="${esc(p)}…" style="${inp}; flex: 1 1 100%; width: 100%; box-sizing: border-box; resize: vertical; min-height: 120px; height: 15vh; max-height: 70vh; font-family: inherit; line-height: 1.5;" rows="4"></textarea>`).join('');
      const graph = orchestrated
        ? `<div style="font-size:0.72rem;color:var(--text-muted);margin:6px 0 4px">Step library — the orchestrator picks from these at runtime (order not fixed):</div>${this._stepLibraryHtml(nodes)}`
        : `<div class="wf-dag">${this._dagHtml(nodes)}</div>`;
      // Collapsed by default: the header is a clickable title row; the details,
      // graph and param inputs live in .wf-body and reveal on click.
      return `<div class="card wf-card wf-collapsed" data-wf="${esc(def.id)}" style="margin-bottom:var(--space-lg)">
        <div class="wf-head" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><i data-lucide="chevron-right" class="wf-chevron" style="width:16px;height:16px;flex-shrink:0"></i><strong>${esc(def.name || def.id)}</strong> ${badge(def.id, '#7C3AED')} ${modeBadge(def.mode)}</div>
          <span style="font-size:0.75rem;color:var(--text-muted)">${def.steps.length} steps</span>
        </div>
        <div class="wf-body" style="display:none">
          ${def.description ? `<p style="font-size:0.83rem;color:var(--text-secondary);margin:6px 0">${esc(def.description)}</p>` : ''}
          ${orchestrated && def.goal ? `<p style="font-size:0.8rem;margin:6px 0"><span style="color:var(--text-muted)">🎯 Goal:</span> ${esc(def.goal)}</p>` : ''}
          ${graph}
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:12px">
            ${params || '<span style="font-size:0.78rem;color:var(--text-muted)">no params</span>'}
            <button class="btn wf-dry" style="font-size:0.78rem;margin-left:auto">Dry run</button>
            <button class="btn btn-primary wf-run" style="font-size:0.78rem">Run ▶</button>
          </div>
          <div class="wf-dry-out" style="display:none;margin-top:10px"></div>
        </div>
      </div>`;
    }).join('') : `<div class="empty-state"><div class="empty-state-icon"><i data-lucide="workflow"></i></div><h3>No workflow templates</h3><p>Drop a <code>workflows/*.json</code> template on the server to see it here.</p></div>`;

    const runCards = runs.length ? runs.map(r => {
      const orchestrated = r.mode === 'orchestrated';
      const color = r.status === 'done' ? '#22C55E' : r.status === 'failed' ? '#EF4444' : '#0EA5E9';
      const done = r.tasks.filter(t => t.status === 'done').length;
      let body;
      if (orchestrated) {
        body = this._orchestratedRunHtml(r);
      } else {
        const idToStep = {};
        r.tasks.forEach(t => { idToStep[t.id] = t.context?.stepKey || t.id.slice(0, 6); });
        const nodes = r.tasks.map(t => ({
          key: t.context?.stepKey || t.id, label: t.context?.stepKey || t.title, sub: esc(t.title), status: t.status, taskId: t.id,
          dependsOn: (t.context?.dependsOn || []).map(id => idToStep[id]).filter(Boolean)
        }));
        body = `<div class="wf-dag">${this._dagHtml(nodes)}</div>`;
      }
      const count = orchestrated ? `${(r.history || []).filter(h => h.stepKey).length} steps chosen` : `${done}/${r.tasks.length} done`;
      return `<div class="card" style="margin-bottom:var(--space-md)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div>${badge(r.workflowId, '#7C3AED')} ${modeBadge(r.mode)} ${badge(r.status, color)}</div>
          <span style="font-size:0.75rem;color:var(--text-muted)">${esc(r.runId)} · ${count} · ${timeAgo(r.createdAt)}</span>
        </div>
        ${orchestrated && r.goal ? `<p style="font-size:0.8rem;margin:6px 0"><span style="color:var(--text-muted)">🎯 Goal:</span> ${esc(r.goal)}</p>` : ''}
        ${body}
        <div class="wf-run-detail" style="display:none;margin-top:10px"></div>
      </div>`;
    }).join('') : '<div style="color:var(--text-muted);font-size:0.85rem">No runs yet — run a template above and its nodes will light up as tasks complete.</div>';

    this.contentEl.innerHTML = `
      <div class="card" style="margin-bottom:var(--space-md);background:var(--bg-secondary)">
        <div style="font-size:0.85rem;color:var(--text-secondary);line-height:1.6">
          <div style="margin-bottom:4px">Two ways to run a multi-step pipeline across the agent company:</div>
          <div style="margin:3px 0">${badge('DAG · static', '#7C3AED')} steps are wired by <code>dependsOn</code> and the whole graph is expanded up front — the dispatcher walks it in dependency order. Deterministic and reusable, no LLM re-planning.</div>
          <div style="margin:3px 0">${badge('adaptive · orchestrator-driven', '#0EA5E9')} steps are a <em>library</em>; nothing is planned up front. After each step, the <strong>orchestrator decides the next step automatically</strong> from the goal + results so far — or answers DONE. The path adapts to what comes back.</div>
        </div>
      </div>
      ${invalidCard}
      <h3 style="font-size:0.9rem;margin:var(--space-md) 0 6px">Templates</h3>${tplCards}
      <h3 style="font-size:0.9rem;margin:var(--space-xl) 0 6px">Runs <span style="font-size:0.72rem;color:var(--text-muted);font-weight:400">(click a node to see its output)</span></h3>${runCards}`;

    this.contentEl.querySelectorAll('.wf-card').forEach(card => {
      const id = card.dataset.wf;
      // Toggle the collapsed body when the title row is clicked. The chevron
      // rotation + body visibility are driven by the .wf-collapsed class.
      card.querySelector('.wf-head')?.addEventListener('click', () => {
        const collapsed = card.classList.toggle('wf-collapsed');
        const body = card.querySelector('.wf-body');
        if (body) body.style.display = collapsed ? 'none' : 'block';
      });
      const readParams = () => { const p = {}; card.querySelectorAll('[data-param]').forEach(i => { p[i.dataset.param] = i.value.trim(); }); return p; };
      card.querySelector('.wf-run')?.addEventListener('click', async () => {
        try {
          const r = await this.api.post(`/workflows/${encodeURIComponent(id)}/run`, { params: readParams() });
          // Only a DAG run returns `tasks` (the whole graph is queued up front).
          // An ORCHESTRATED run has no fixed plan — the orchestrator picks each
          // next step as results come in — so report the run, not a task count.
          this.toast('workflow started', r.mode === 'orchestrated'
            ? `${id} · orchestrated (${r.runId}) — the orchestrator picks each next step`
            : `${id} · ${(r.tasks || []).length} tasks queued`);
          this.renderWorkflows();
        } catch (e) { this.toast('error', e.message); }
      });
      card.querySelector('.wf-dry')?.addEventListener('click', async () => {
        const out = card.querySelector('.wf-dry-out');
        try {
          const r = await this.api.post(`/workflows/${encodeURIComponent(id)}/run`, { params: readParams(), dryRun: true });
          const nodes = (r.steps || []).map(s => ({ key: s.key, label: s.title || s.key, dependsOn: s.dependsOn || [], sub: [s.agent && ('@' + s.agent), s.division && ('#' + s.division)].filter(Boolean).join(' · ') }));
          out.innerHTML = `<div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:6px">Dry run — nothing was created. Resolved plan (${nodes.length} steps):</div><div class="wf-dag">${this._dagHtml(nodes)}</div>`;
          out.style.display = 'block'; createIcons();
        } catch (e) { out.innerHTML = `<span style="color:#EF4444;font-size:0.8rem">${esc(e.message)}</span>`; out.style.display = 'block'; }
      });
    });

    this.contentEl.querySelectorAll('[data-wf-task]').forEach(node => node.addEventListener('click', async () => {
      const detail = node.closest('.card').querySelector('.wf-run-detail');
      if (!detail) return;
      detail.style.display = 'block';
      detail.innerHTML = '<span style="opacity:.6;font-size:0.82rem">loading…</span>';
      try {
        const t = await this.api.get(`/inbox/${encodeURIComponent(node.dataset.wfTask)}`);
        detail.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:4px">${badge(t.status, STATUS_COLORS[t.status] || '#94A3B8')} <strong>${esc(t.title)}</strong></div>${mdViewer(t.result || t.description || '(no output yet)', 'OUTPUT')}`;
        createIcons();
      } catch (e) { detail.innerHTML = `<span style="color:#EF4444;font-size:0.8rem">${esc(e.message)}</span>`; }
    }));
  }

  // ── Reports ────────────────────────────────────────────────────────────

  // ── Roster ─────────────────────────────────────────────────────────────

  async renderRoster() {
    const roster = await this.api.get('/roster');
    const byDivision = {};
    for (const a of roster) (byDivision[a.divisionLabel || a.division || 'other'] ||= []).push(a);

    this.contentEl.innerHTML = `
      <input id="roster-search" class="roster-search" placeholder="Search ${roster.length} agents…">
      <div id="roster-list"></div>`;

    const listEl = this.contentEl.querySelector('#roster-list');
    const render = (filter) => {
      const f = (filter || '').toLowerCase();
      listEl.innerHTML = Object.entries(byDivision).map(([div, agents]) => {
        const hits = f ? agents.filter(a =>
          a.name.toLowerCase().includes(f) || (a.description || '').toLowerCase().includes(f)) : agents;
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
      }).join('') || `<div class="empty-state"><p>No agents match.</p></div>`;
      createIcons();
    };
    render('');
    this.contentEl.querySelector('#roster-search').addEventListener('input', (e) => render(e.target.value));
  }

  // ── Agents: special executors + roster divisions (with brain chains) ───────

  async renderTeam() {
    const [special, brains, chains, divisions] = await Promise.all([
      this.api.get('/agents-config'), this.api.get('/brains'), this.api.get('/chains'), this.api.get('/roster-divisions')
    ]);
    const opts = Object.keys(brains).map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
    // Same drag-to-reorder chain UI as the Brains view's default chain.
    const chainRow = (arr, ctx) => {
      const list = arr || [];
      return `<div class="chain-row" data-ctx="${ctx}" style="margin:4px 0;min-height:30px">${
        list.map((b, i) => chainChip(b, i, list.length, !!brains[b])).join('')
        || '<span style="color:var(--text-muted);font-size:0.8rem">none — add a brain →</span>'}</div>
      <select data-add="${ctx}" style="padding:4px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.78rem"><option value="">+ add brain…</option>${opts}</select>`;
    };

    const specialCards = Object.entries(special).map(([n, a]) => `
      <div class="card" style="margin-bottom:var(--space-md)">
        <div style="display:flex;justify-content:space-between;align-items:center"><strong>${esc(n)}</strong>${badge('special', '#0EA5E9')}</div>
        <p style="font-size:0.8rem;color:var(--text-muted);margin:4px 0">${esc(a.description || '')}</p>
        ${chainRow(a.brains, 'agent:' + n)}
      </div>`).join('');

    // One roster agent's row: an explicit per-agent chain override wins over the
    // division chain and the global default. With no override the agent inherits
    // (shown muted) and offers a one-click "+ override with…" starter.
    const agentRow = (a) => {
      const own = chains.agentChains?.[a.slug];
      const inherits = (chains.divisionChains?.[a.division] && 'division chain') || 'default chain';
      return `<div style="padding:6px 0;border-top:1px solid var(--bg-tertiary)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:0.82rem">${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.name || a.slug)}</span>
          <span style="font-size:0.7rem;color:var(--text-muted)">${own ? 'own chain' : 'inherits ' + inherits}</span>
        </div>
        ${own ? chainRow(own, 'roster:' + a.slug) + `<a data-reset-agent="${esc(a.slug)}" style="cursor:pointer;font-size:0.72rem;color:var(--text-muted)">↺ reset to inherited</a>`
          : `<select data-add="roster:${esc(a.slug)}" style="margin-top:4px;padding:4px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.78rem"><option value="">+ override with…</option>${opts}</select>`}
      </div>`;
    };

    const divCards = Object.entries(divisions).sort().map(([d, info]) => {
      const override = chains.divisionChains?.[d];
      const agentList = (info.agents || []).map(a => agentRow({ ...a, division: d })).join('');
      return `<div class="card" style="margin-bottom:var(--space-md)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <strong>${esc(info.label || d)}</strong>
          <span style="font-size:0.75rem;color:var(--text-muted)">${info.agents.length} agents${override ? '' : ' · uses default chain'}</span>
        </div>
        ${override ? chainRow(override, 'div:' + d) + `<a data-reset="${esc(d)}" style="cursor:pointer;font-size:0.72rem;color:var(--text-muted)">↺ reset to default</a>`
          : `<div style="margin:4px 0;font-size:0.8rem;color:var(--text-muted)">${(chains.defaultChain || []).join(' → ') || '(no default)'}</div>
             <select data-add="div:${esc(d)}" style="padding:4px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.78rem"><option value="">+ override with…</option>${opts}</select>`}
        <details style="margin-top:8px"><summary style="cursor:pointer;font-size:0.75rem;color:var(--text-muted)">Per-agent overrides (${info.agents.length})</summary>
          ${agentList || '<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0">no agents</div>'}
        </details>
      </div>`;
    }).join('');

    this.contentEl.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:var(--space-md)">The orchestrator routes each task to a specialist in one of these divisions; the specialist runs on its division's chain (or the global default). Special executors run directly. Changes save instantly.</p>
      <h3 style="font-size:0.9rem;margin:var(--space-md) 0 6px">Special executors</h3>${specialCards}
      <h3 style="font-size:0.9rem;margin:var(--space-lg) 0 6px">Divisions <span style="font-size:0.72rem;color:var(--text-muted);font-weight:400">(brain chain override per division)</span></h3>${divCards}`;

    const save = async (ctx, arr) => {
      if (ctx.startsWith('agent:')) { const n = ctx.slice(6); await this.api.put(`/agents-config/${encodeURIComponent(n)}`, { description: special[n].description, brains: arr }); }
      else if (ctx.startsWith('roster:')) { const s = ctx.slice(7); await this.api.put(`/chains/agent/${encodeURIComponent(s)}`, { brains: arr }); }
      else { const dv = ctx.slice(4); await this.api.put(`/chains/division/${encodeURIComponent(dv)}`, { brains: arr }); }
      await this.renderTeam();
    };
    const chainOf = (ctx) => ctx.startsWith('agent:') ? (special[ctx.slice(6)].brains || []).slice()
      : ctx.startsWith('roster:') ? (chains.agentChains?.[ctx.slice(7)] || []).slice()
      : (chains.divisionChains?.[ctx.slice(4)] || []).slice();

    // Drag to reorder / ✕ to remove — identical to the Brains default chain.
    this.contentEl.querySelectorAll('.chain-row').forEach(row =>
      this.wireChainDnd(row, (arr) => save(row.dataset.ctx, arr)));
    if (window.lucide) window.lucide.createIcons();
    this.contentEl.querySelectorAll('[data-add]').forEach(sel => sel.addEventListener('change', (e) => {
      const ctx = e.target.dataset.add; const b = e.target.value; if (!b) return;
      const arr = chainOf(ctx); if (!arr.includes(b)) arr.push(b);
      save(ctx, arr);
    }));
    this.contentEl.querySelectorAll('[data-reset]').forEach(a => a.addEventListener('click', () => save('div:' + a.dataset.reset, [])));
    this.contentEl.querySelectorAll('[data-reset-agent]').forEach(a => a.addEventListener('click', () => save('roster:' + a.dataset.resetAgent, [])));
  }

  // ── Brains (model × platform × location registry) ──────────────────────

  async renderBrains() {
    const [brains, chains] = await Promise.all([this.api.get('/brains'), this.api.get('/chains')]);
    // Default fallback chain — drag to reorder; saves on drop.
    const dchain = chains.defaultChain || [];
    const chainChips = dchain.map((b, i) => chainChip(b, i, dchain.length, !!brains[b])).join('')
      || '<span style="color:var(--text-muted);font-size:0.8rem">empty — add a brain below</span>';
    const notInChain = Object.keys(brains).filter(b => !(chains.defaultChain || []).includes(b));
    const defaultChainCard = `
      <div class="card" style="margin-bottom:var(--space-lg)">
        <div style="font-size:0.9rem;font-weight:600">Default fallback chain <span style="font-size:0.72rem;color:var(--text-muted);font-weight:400">— drag to reorder; roster agents use this unless their division overrides it</span></div>
        <div id="dchain" style="margin:8px 0;min-height:34px">${chainChips}</div>
        <select id="dchain-add" style="padding:5px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem"><option value="">+ add to chain…</option>${notInChain.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}</select>
      </div>`;
    const row = (id, b) => `
      <div class="card" style="margin-bottom:var(--space-md)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <strong>${esc(id)}</strong>
          ${badge(b.location, b.location === 'remote' ? '#EAB308' : '#22C55E')}
          ${b.dynamic ? badge('auto', '#0EA5E9') : ''}
          <button class="btn" data-act="del-brain" data-id="${esc(id)}" style="font-size:0.75rem;margin-left:auto">Deregister</button>
        </div>
        <p style="font-size:0.82rem;color:var(--text-secondary);margin:4px 0">${esc(b.description || '')}</p>
        <div style="font-size:0.78rem;color:var(--text-muted)">${esc(b.exec || '')}${b.model ? ' · ' + esc(b.model) : ''}${b.host ? ' · host ' + esc(b.host) : ''}</div>
      </div>`;
    const fld = (id, ph) => `<input id="nb-${id}" placeholder="${ph}" style="padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem">`;
    this.contentEl.innerHTML = `
      <div class="card" style="margin-bottom:var(--space-lg)">
        <div style="font-size:0.85rem;font-weight:600;margin-bottom:6px">Register / update a brain</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px">
          ${fld('id', 'id (e.g. remote-laptop-cc-sonnet)')}
          <select id="nb-location" style="padding:6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem"><option value="local">local</option><option value="remote">remote</option></select>
          <select id="nb-exec" style="padding:6px;background:var(--bg-tertiary);border:1px solid var(--bg-tertiary);border-radius:8px;color:inherit;font-size:0.8rem"><option value="claude">claude</option><option value="hermes">hermes</option><option value="agy">agy</option><option value="script">script</option></select>
          ${fld('model', 'model id')}
          ${fld('host', 'host (remote only)')}
          ${fld('desc', 'description')}
        </div>
        <button class="btn btn-primary" id="nb-save" style="margin-top:8px;font-size:0.8rem">Save brain</button>
      </div>
      ${defaultChainCard}
      ${Object.entries(brains).map(([id, b]) => row(id, b)).join('') || '<div class="empty-state"><p>No brains registered.</p></div>'}`;

    if (window.lucide) window.lucide.createIcons();

    // ── Default chain: drag-to-reorder + add/remove, persisted on change ──────
    const saveDefault = async (arr) => {
      try { await this.api.put('/chains/default', { brains: arr }); this.renderBrains(); }
      catch (e) { this.toast('error', e.message); }
    };
    this.wireChainDnd(this.contentEl.querySelector('#dchain'), saveDefault);
    this.contentEl.querySelector('#dchain-add')?.addEventListener('change', (e) => {
      const b = e.target.value; if (!b) return;
      saveDefault([...(chains.defaultChain || []), b]);
    });

    this.contentEl.querySelector('#nb-save').addEventListener('click', async () => {
      const g = id => this.contentEl.querySelector(`#nb-${id}`).value.trim();
      const id = g('id'); if (!id) { this.toast('error', 'brain id required'); return; }
      try {
        await this.api.put(`/brains/${encodeURIComponent(id)}`, {
          description: g('desc') || id, location: this.contentEl.querySelector('#nb-location').value,
          exec: this.contentEl.querySelector('#nb-exec').value, model: g('model'), host: g('host') || undefined
        });
        this.toast('brain saved', id); this.renderBrains();
      } catch (e) { this.toast('error', e.message); }
    });
    this.contentEl.querySelectorAll('[data-act="del-brain"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      if (!confirm(`Deregister brain "${id}"? It will be removed from every agent's chain.`)) return;
      const r = await this.api.del(`/brains/${encodeURIComponent(id)}`);
      this.toast('brain removed', `${id} (scrubbed from ${r.agents_scrubbed} agent chain(s))`);
      this.renderBrains();
    }));
  }

  // ── Config ─────────────────────────────────────────────────────────────

  // ── Portal (launcher for local self-hosted web services) ────────────────

  async renderPortal() {
    const config = await this.api.get('/config').catch(() => ({}));
    const configured = (config && config.services) || {};

    // Merge curated defaults with the operator's config.services (config wins).
    const merged = {};
    for (const [key, v] of Object.entries(PORTAL_DEFAULTS)) merged[key] = { ...v };
    for (const [key, v] of Object.entries(configured)) merged[key] = { ...(merged[key] || {}), ...v };

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
    // is dropped so an escaped-but-malicious href can never reach the DOM.
    const safeUrl = (u) => {
      try { const p = new URL(u); return (p.protocol === 'http:' || p.protocol === 'https:') ? u : ''; }
      catch { return ''; }
    };

    // Normalize each entry into a card model, enriched from the catalog.
    const services = Object.entries(merged).map(([key, v]) => {
      const meta = PORTAL_CATALOG[key] || {};
      return {
        key,
        url: safeUrl(rehost(v.url || '')),
        label: v.label || meta.label || humanizeKey(key),
        description: v.description || meta.description || '',
        icon: v.icon || meta.icon || 'globe',
        category: v.category || meta.category || 'Other',
        // undefined enabled (curated defaults) => treat as available; only an
        // explicit enabled:false marks a service the operator has turned off.
        enabled: v.enabled !== false,
      };
    }).filter(s => s.url);

    if (!services.length) {
      this.contentEl.innerHTML = `<div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="layout-grid"></i></div>
        <h3>No services yet</h3>
        <p>Add a <code>services</code> block to your <code>~/.cowork/config.json</code> — each entry
        <code>{ "url": "http://localhost:8081", "label": "Mautic", "icon": "megaphone", "category": "Marketing" }</code>
        shows up here as a launch card.</p>
      </div>`;
      return;
    }

    // Group by category, in a stable, human-friendly order.
    const groups = new Map();
    for (const s of services) {
      if (!groups.has(s.category)) groups.set(s.category, []);
      groups.get(s.category).push(s);
    }
    const orderedCats = [...groups.keys()].sort((a, b) => {
      const ia = PORTAL_CATEGORY_ORDER.indexOf(a), ib = PORTAL_CATEGORY_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });

    const card = (s) => {
      const c = PORTAL_ACCENT;
      let host = s.url;
      try { host = new URL(s.url).host || s.url; } catch { /* keep raw */ }
      return `<a class="card portal-card" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"
          title="Open ${esc(s.label)} — ${esc(s.url)}">
        <div class="portal-top">
          <span class="portal-icon" style="background:${c}18; color:${c}; border:1px solid ${c}33">
            <i data-lucide="${esc(s.icon)}"></i>
          </span>
          <span class="svc-status ${s.enabled ? 'checking' : 'disabled'}" data-svc="${esc(s.key)}"
                title="${s.enabled ? 'Checking…' : 'Monitoring disabled'}">
            <span class="svc-dot"></span><span class="svc-text">${s.enabled ? 'checking' : 'disabled'}</span>
          </span>
          <span class="portal-open"><i data-lucide="external-link"></i></span>
        </div>
        <div class="portal-title">${esc(s.label)}${s.enabled ? '' : ` ${badge('disabled', '#94A3B8')}`}</div>
        ${s.description ? `<div class="portal-desc">${esc(s.description)}</div>` : ''}
        <div class="portal-url"><i data-lucide="link"></i> ${esc(host)}</div>
      </a>`;
    };

    const sections = orderedCats.map(cat => `
      <div class="portal-section">
        <h3 class="section-title" style="margin-bottom:var(--space-md)">${esc(cat)}
          <span style="color:var(--text-muted); font-weight:400">· ${groups.get(cat).length}</span>
        </h3>
        <div class="grid-3">${groups.get(cat).map(card).join('')}</div>
      </div>`).join('');

    this.contentEl.innerHTML = `
      <p style="color:var(--text-secondary); font-size:0.875rem; margin-bottom:var(--space-lg)">
        Quick-launch the local web services running on this host. Cards come from your
        <code>config.json</code> <code>services</code> block, enriched with built-in defaults.
        Status dots are probed from the server every 3s.
      </p>
      ${sections}`;

    // Paint the last known statuses immediately (no flash on re-render), then
    // keep them fresh every 3s for as long as we're on the Portal.
    if (this.svcStatus) this.applyServiceStatus(this.svcStatus);
    this.startServicePolling();
  }

  // Map a probe result to a UI state: online | offline | disabled | unknown.
  svcState(st) {
    if (!st) return 'unknown';
    if (!st.enabled || st.reason === 'disabled') return 'disabled';
    return st.online ? 'online' : 'offline';
  }

  // Update every Portal card's status dot in place from a { key → status } map.
  applyServiceStatus(map) {
    document.querySelectorAll('.svc-status[data-svc]').forEach((el) => {
      const key = el.getAttribute('data-svc');
      const st = map[key];
      const state = this.svcState(st);
      el.className = `svc-status ${state}`;
      const label = { online: 'online', offline: 'offline', disabled: 'disabled', unknown: 'unknown' }[state];
      const txt = el.querySelector('.svc-text');
      if (txt) txt.textContent = label;
      const tip = {
        online: st ? `Online${st.code ? ` · HTTP ${st.code}` : ''}${st.ms != null ? ` · ${st.ms}ms` : ''}` : 'Online',
        offline: st ? `Offline${st.reason ? ` · ${st.reason}` : ''}` : 'Offline',
        disabled: 'Monitoring disabled in config',
        unknown: 'Status unknown (not in config.services)',
      }[state];
      el.setAttribute('title', tip);
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

  async renderConfig() {
    const config = await this.api.get('/config');
    this.contentEl.innerHTML = `
      <div class="card">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:var(--space-md)">
          <i data-lucide="settings" style="width:18px;height:18px;color:var(--text-muted)"></i>
          <h3 style="font-size:0.95rem">Configuration</h3>
          <span style="font-size:0.75rem; color:var(--text-muted); font-weight:400">(config.json — API keys masked)</span>
        </div>
        <pre style="white-space:pre-wrap; font-size:0.83rem; max-height:70vh; overflow-y:auto">${esc(JSON.stringify(config, null, 2))}</pre>
      </div>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
