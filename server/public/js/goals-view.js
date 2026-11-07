/**
 * Goals page (#goals). Answers "what needs me, and what happens next?" at a glance.
 *
 * Routes:  #goals            list (and, on a wide screen, an empty detail pane)
 *          #goals/new        create flow, on its own route so no refresh can touch it
 *          #goals/<id>/<tab> detail: overview, phases, decisions, files, settings
 *
 * Data:    GET /api/goals returns small summaries with a server-derived state
 *          (core/goal-view.ts), and the full record loads only when a goal opens.
 *
 * Refresh: events never rebuild the page. _goalsRefresh patches the rows that
 *          changed and leaves forms, dialogs, focus and scroll alone.
 *
 * Loaded after app.js; extends App.prototype.
 */
(() => {
  const STATES = {
    'needs-you': { label: 'Needs you', icon: 'circle-alert' },
    stuck: { label: 'Stuck', icon: 'octagon-alert' },
    running: { label: 'Running', icon: 'loader' },
    thinking: { label: 'Thinking', icon: 'bot' },
    auditing: { label: 'Auditing', icon: 'scale' },
    retrying: { label: 'Retrying', icon: 'refresh-cw' },
    sleeping: { label: 'Sleeping', icon: 'moon' },
    draft: { label: 'Draft', icon: 'file-pen' },
    paused: { label: 'Paused', icon: 'pause' },
    achieved: { label: 'Achieved', icon: 'circle-check' }
  };
  // Every state lands under some chip, so no goal is reachable only through All.
  const FILTERS = [['all', 'All'], ['needs-you', 'Needs you'], ['stuck', 'Stuck'], ['running', 'Running'], ['retrying', 'Retrying'], ['sleeping', 'Sleeping'], ['draft', 'Draft'], ['paused', 'Paused'], ['achieved', 'Achieved']];
  const FILTER_OF = { thinking: 'running', auditing: 'running' };
  const filterOf = (state) => FILTER_OF[state] || state;
  const TABS = [['overview', 'Overview'], ['phases', 'Phases'], ['decisions', 'Decisions'], ['files', 'Files'], ['settings', 'Settings']];
  const PHASE_LABEL = { planned: 'Planned', active: 'In progress', completing: 'Being audited', done: 'Done', audited: 'Audited' };
  const SEG = { p: 'Planned', a: 'In progress', c: 'Being audited', d: 'Done' };
  // Inverse of the server's compact letter (core/goal-view.ts PHASE_LETTER).
  const PHASE_LETTER_STATUS = { p: 'planned', a: 'active', c: 'completing', d: 'done' };
  const BLOCK_TEXT = {
    rate_limit: 'Every Achiever agent was rate limited',
    achiever_no_progress: 'Achiever turns made no usable progress',
    budget_exhausted: 'Step budget used up',
    token_budget: 'Token budget used up'
  };
  const STALE_MS = 90_000;

  const enc = encodeURIComponent;
  const icon = (name, cls = '') => `<i data-lucide="${name}" class="gv-icon ${cls}" aria-hidden="true"></i>`;
  const stripEmoji = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').trim();
  const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));

  // Relative up to a day away, then the date in the reader's zone.
  function fmtWhen(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.round((t - Date.now()) / 1000);
    const a = Math.abs(s);
    if (a < 86400) {
      const span = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : `${Math.round(a / 3600)}h`;
      return s >= 0 ? `in ${span}` : `${span} ago`;
    }
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const timeTag = (iso) => (iso ? `<time class="gv-time" datetime="${esc(iso)}" data-when="${esc(iso)}">${esc(fmtWhen(iso))}</time>` : '');

  const stateBadge = (state) => {
    const s = STATES[state] || STATES.draft;
    return `<span class="gv-state" data-state="${esc(state)}">${icon(s.icon)}<span>${s.label}</span></span>`;
  };

  // The next event, in words. Each state reads differently around the same time.
  function nextLine(d) {
    if (d.since) return `${esc(d.line)} · ${timeTag(d.since)}`;
    if (!d.nextAt) return esc(d.line);
    if (d.state === 'sleeping') return `Next check ${timeTag(d.nextAt)} · ${esc(d.line)}`;
    if (d.state === 'retrying' || d.state === 'stuck') return `${esc(d.line)}, retry ${timeTag(d.nextAt)}`;
    return `${esc(d.line)} · auto-retry ${timeTag(d.nextAt)}`;
  }

  const segments = (letters) => `<span class="gv-segs" aria-hidden="true">${
    [...(letters || '')].map(l => `<span class="gv-seg" data-s="${l}" title="${SEG[l] || ''}"></span>`).join('')
  }</span>`;

  function row(g, selected) {
    const done = [...(g.phases || '')].filter(l => l === 'd').length;
    const total = (g.phases || '').length;
    return `<li class="gv-li" data-id="${esc(g.goalId)}" data-state="${esc(g.display.state)}">
      <a class="gv-row${selected ? ' is-selected' : ''}" href="#goals/${enc(g.goalId)}" ${selected ? 'aria-current="true"' : ''}>
        <span class="gv-row-top">${stateBadge(g.display.state)}<span class="gv-budget">${g.budget.used}/${g.budget.cap} tasks</span></span>
        <span class="gv-row-title">${esc(g.title)}</span>
        <span class="gv-row-line">${nextLine(g.display)}</span>
        <span class="gv-row-foot">${segments(g.phases)}<span class="gv-phases-count">${done}/${total} phases</span></span>
      </a>
    </li>`;
  }

  /** Is this text a Yes/No question? A warning only: the server does not enforce it. */
  const looksYesNo = (s) => /\?\s*$/.test(s) && /^\s*(is|are|does|do|did|has|have|can|will|was|were|should)\b/i.test(s);

  function deriveKey(raw, idx, seen) {
    const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `phase-${idx + 1}`;
    let key = base; let n = 2;
    while (seen.has(key)) key = `${base}-${n++}`;
    seen.add(key);
    return key;
  }

  /** Phase lines are plain titles. A leading "key:" is honoured, never required. */
  function parsePhases(text) {
    const seen = new Set();
    return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map((line, idx) => {
      // One bare word before the colon, so a URL or a sentence stays whole.
      const m = /^([A-Za-z0-9][\w-]*)\s*:\s+(.+)$/.exec(line);
      return { key: deriveKey(m ? m[1] : line, idx, seen), title: m ? m[2] : line };
    });
  }
  const parseList = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

  const field = (id, label, control, hint = '') => `<div class="gv-field" data-field="${id}">
      <label for="${id}">${label}</label>
      ${control}
      ${hint ? `<p class="gv-hint" id="${id}-hint">${hint}</p>` : ''}
      <p class="gv-error" id="${id}-error" hidden></p>
    </div>`;

  function setFieldError(root, id, msg) {
    const input = root.querySelector(`#${id}`);
    const err = root.querySelector(`#${id}-error`);
    if (!input || !err) return;
    err.textContent = msg || '';
    err.hidden = !msg;
    if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `${id}-error`); }
    else { input.removeAttribute('aria-invalid'); if (root.querySelector(`#${id}-hint`)) input.setAttribute('aria-describedby', `${id}-hint`); else input.removeAttribute('aria-describedby'); }
  }

  /** Disable a button and show progress while `fn` runs. */
  async function busy(btn, fn, label = 'Working…') {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = label;
    try { return await fn(); }
    finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.innerHTML = html;
      createIcons();
    }
  }

  Object.assign(App.prototype, {
    /** The route after #goals/: [] | ['new'] | [id, tab?]. Set by navigate(). */
    _goalsParts() {
      const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
      return window.location.hash.replace(/^#/, '').split('/').slice(1).map(decode).filter(Boolean);
    },

    async renderGoals() {
      const parts = this._goalsParts();
      if (parts[0] === 'new') return this._renderGoalCreate();

      const st = (this._gv ||= { filter: 'all', list: [], rowHtml: new Map() });
      this._gvBindPopovers();
      st.selected = parts[0] || null;
      st.tab = TABS.some(t => t[0] === parts[1]) ? parts[1] : 'overview';

      const shell = this.contentEl.querySelector('.gv[data-page="list"]');
      if (!shell) {
        this.contentEl.innerHTML = `<div class="gv" data-page="list" data-mode="${st.selected ? 'detail' : 'list'}">
          <div class="gv-head">
            <div class="gv-filters" role="group" aria-label="Filter goals"></div>
            <div class="gv-head-right">
              <span class="gv-updated" id="gv-updated"></span>
              <details class="gv-help"><summary aria-label="What are goals?">${icon('circle-help')}</summary>
                <div class="gv-help-body">
                  <p>A goal runs until its Yes/No criterion becomes true. The <strong>Achiever</strong> plans phases and creates tasks. The <strong>Judger</strong> audits each phase and writes what to do next.</p>
                  <p>A blocked goal is a recoverable hold. It retries on its own, in minutes at first and later in hours. Only <strong>Needs you</strong> means it is waiting on a person.</p>
                </div>
              </details>
              <a class="btn btn-primary gv-new" href="#goals/new">${icon('plus')}<span>New goal</span></a>
            </div>
          </div>
          <div class="gv-strip" id="gv-strip" hidden></div>
          <div class="gv-split">
            <ul class="gv-list" id="gv-list" aria-label="Goals"></ul>
            <section class="gv-detail" id="gv-detail" aria-label="Goal detail"></section>
          </div>
          <div class="gv-sr" role="status" aria-live="polite" id="gv-status"></div>
        </div>`;
        st.rowHtml = new Map();
      }
      const root = this.contentEl.querySelector('.gv');
      const leavingDetail = root.dataset.mode === 'detail' && !st.selected;
      // Save before the list hides: hiding it shrinks the page and clamps the scroll.
      if (st.selected && root.dataset.mode === 'list') this._gvSaveScroll();
      root.dataset.mode = st.selected ? 'detail' : 'list';

      await this._goalsRefresh({ force: true });
      if (st.selected) {
        await this._gvLoadDetail({ focus: true });
      } else {
        root.querySelector('#gv-detail').innerHTML = `<div class="gv-empty-detail">${icon('target')}<p>Select a goal to see its state, phases and files.</p></div>`;
        if (leavingDetail) this._gvRestoreScroll();
      }

      createIcons();
      // A quiet stream still refreshes, and a failed fetch shows as stale until this works.
      this.addViewTimer(() => {
        this._gvTick();
        if (Date.now() - (st.fetchedAt || 0) > STALE_MS / 2) this._goalsRefresh().catch(() => {});
      }, 15000);
      this._gvTick();
    },

    /** Menus and help are <details>: they close on an outside click or Esc. Bound once. */
    _gvBindPopovers() {
      if (this._gvPopoversBound) return;
      this._gvPopoversBound = true;
      const openOnes = () => [...document.querySelectorAll('.gv details.gv-menu[open], .gv details.gv-help[open]')];
      document.addEventListener('click', (e) => {
        const inside = e.target.closest?.('details.gv-menu, details.gv-help');
        openOnes().forEach(d => { if (d !== inside) d.removeAttribute('open'); });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || document.querySelector('.gv-dialog[open]')) return;
        openOnes().forEach(d => { d.removeAttribute('open'); d.querySelector('summary')?.focus(); });
      });
    },

    _gvScroller() { return this.contentEl.closest('.content-area') || document.scrollingElement; },
    _gvSaveScroll() { const st = this._gv; const el = this._gvScroller(); if (st && el) st.listScroll = el.scrollTop; },
    _gvRestoreScroll() {
      const st = this._gv; const el = this._gvScroller();
      if (st?.listScroll !== undefined && el) el.scrollTop = st.listScroll;
      if (st) st.listScroll = undefined;
      const back = st?.lastSelected && this.contentEl.querySelector(`.gv-li[data-id="${CSS.escape(st.lastSelected)}"] .gv-row`);
      if (back) back.focus({ preventScroll: true });
    },

    /** Fetch summaries and patch only what changed. Safe to call on any event. */
    async _goalsRefresh({ force = false } = {}) {
      const st = this._gv;
      const root = this.contentEl.querySelector('.gv[data-page="list"]');
      if (!st || !root) return;
      let list;
      try { list = await this.api.get('/goals'); }
      catch (e) { st.fetchFailed = true; this._gvTick(); if (force) throw e; return; }
      if (!Array.isArray(list)) list = [];
      st.fetchFailed = false;
      st.fetchedAt = Date.now();

      // One atomic status line per real change, for screen readers.
      const before = new Map(st.list.map(g => [g.goalId, g]));
      const changes = list.filter(g => { const b = before.get(g.goalId); return b && b.display.state !== g.display.state; });
      if (changes.length) root.querySelector('#gv-status').textContent = changes.map(g => `${g.title}: ${STATES[g.display.state]?.label || g.display.state}`).join('. ');

      const updatedSelected = st.selected && before.get(st.selected)?.updatedAt !== list.find(g => g.goalId === st.selected)?.updatedAt;
      const stateChanged = st.selected && before.get(st.selected)?.display.state !== list.find(g => g.goalId === st.selected)?.display.state;
      st.list = list;
      this._gvPatchList(root);
      if (!force && (updatedSelected || stateChanged)) this._gvLoadDetail({ quiet: true }).catch(() => {});
      this._gvTick();
    },

    _gvPatchList(root) {
      const st = this._gv;
      const counts = { all: st.list.length };
      for (const g of st.list) { const k = filterOf(g.display.state); counts[k] = (counts[k] || 0) + 1; }

      // Rebuilt only on a change, so a refresh cannot take focus off a chip.
      const filters = root.querySelector('.gv-filters');
      // The chosen chip stays even at zero, or its empty view would have no visible cause.
      const chipHtml = FILTERS.filter(([k]) => k === 'all' || k === 'needs-you' || k === st.filter || counts[k]).map(([k, label]) =>
        `<button type="button" class="gv-chip" data-filter="${k}" aria-pressed="${st.filter === k}">${label} <span class="gv-count">${counts[k] || 0}</span></button>`).join('');
      if (st.chipHtml !== chipHtml || !filters.firstChild) {
        st.chipHtml = chipHtml;
        filters.innerHTML = chipHtml;
        filters.querySelectorAll('.gv-chip').forEach(b => b.addEventListener('click', () => {
          const key = b.dataset.filter;
          st.filter = key;
          this._gvPatchList(root);
          filters.querySelector(`[data-filter="${key}"]`)?.focus();
        }));
      }

      const urgent = st.list.filter(g => g.display.state === 'needs-you');
      const strip = root.querySelector('#gv-strip');
      strip.hidden = !urgent.length;
      strip.innerHTML = urgent.length ? `${icon('circle-alert')}<span><strong>${urgent.length} need${urgent.length === 1 ? 's' : ''} you:</strong> ${
        urgent.slice(0, 3).map(g => `<a href="#goals/${enc(g.goalId)}">${esc(g.title)}</a>`).join(', ')}</span>` : '';

      const visible = st.list.filter(g => st.filter === 'all' || filterOf(g.display.state) === st.filter);
      const ul = root.querySelector('#gv-list');
      const wanted = visible.map(g => g.goalId);
      if (!visible.length) {
        ul.innerHTML = `<li class="gv-none">${st.list.length ? 'No goals in this view.' : `No goals yet. <a href="#goals/new">Create the first one</a>.`}</li>`;
        st.rowHtml = new Map();
        return;
      }
      const rows = new Map([...ul.querySelectorAll('.gv-li')].map(li => [li.dataset.id, li]));
      for (const [id, li] of rows) if (!wanted.includes(id)) { li.remove(); st.rowHtml.delete(id); }
      ul.querySelector('.gv-none')?.remove();
      let cursor = null;
      for (const g of visible) {
        const selected = g.goalId === st.selected;
        const html = row(g, selected);
        let li = ul.querySelector(`.gv-li[data-id="${CSS.escape(g.goalId)}"]`);
        if (st.rowHtml.get(g.goalId) !== html) {
          const tpl = document.createElement('template');
          tpl.innerHTML = html.trim();
          const fresh = tpl.content.firstChild;
          const hadFocus = li && li.contains(document.activeElement);
          if (li) li.replaceWith(fresh); else ul.appendChild(fresh);
          li = fresh;
          if (hadFocus) li.querySelector('.gv-row')?.focus({ preventScroll: true });
          st.rowHtml.set(g.goalId, html);
          createIcons(li);
        }
        // Keep the server's order. Moving only misplaced nodes keeps focus on the rest.
        const expected = cursor ? cursor.nextElementSibling : ul.firstElementChild;
        if (li !== expected) ul.insertBefore(li, expected);
        cursor = li;
      }
    },

    /** Keep relative times and the freshness line current between events. */
    _gvTick() {
      const st = this._gv;
      const root = this.contentEl.querySelector('.gv');
      if (!st || !root) return;
      root.querySelectorAll('[data-when]').forEach(el => { el.textContent = fmtWhen(el.dataset.when); });
      const el = root.querySelector('#gv-updated');
      if (!el || !st.fetchedAt) return;
      const age = Date.now() - st.fetchedAt;
      const stale = st.fetchFailed || age > STALE_MS;
      el.classList.toggle('is-stale', stale);
      el.textContent = stale ? `Stale, updated ${Math.round(age / 1000)}s ago` : `Updated ${Math.max(0, Math.round(age / 1000))}s ago`;
    },

    async _gvLoadDetail({ focus = false, quiet = false } = {}) {
      const st = this._gv;
      const host = this.contentEl.querySelector('#gv-detail');
      if (!host || !st.selected) return;
      const id = st.selected;
      // A refresh must not disturb a dialog in use.
      if (quiet && this.contentEl.querySelector('dialog[open]')) return;
      let g;
      try { g = await this.api.get(`/goals/${enc(id)}`); }
      catch (e) {
        // A goal that has left the list was deleted: stale controls must not stay on screen.
        if (!quiet || !st.list.some(x => x.goalId === id)) host.innerHTML = `<div class="gv-empty-detail"><p>This goal could not be loaded: ${esc(e.message)}</p><a href="#goals">Back to goals</a></div>`;
        return;
      }
      if (st.selected !== id) return;
      // A page that outlived a server redeploy can hold the old API's shape: a
      // summary whose `phases` is the compact letter string instead of phase
      // objects, which reads as "g.phases.filter is not a function". Normalise
      // once here — every pane reads this object — so a skewed payload degrades
      // to empty phases instead of crashing the whole view.
      if (g && !Array.isArray(g.phases)) {
        g.phases = typeof g.phases === 'string'
          ? [...g.phases].map((l, i) => ({ key: String(i + 1), title: '', status: PHASE_LETTER_STATUS[l] || 'planned' }))
          : [];
        if (!g.progress) g.progress = g.tasks || { done: 0, total: 0 };
      }
      st.detail = g;
      st.lastSelected = id;
      // Settings is a form: a refresh updates the read-only facts and leaves the
      // fields, the focus and the "Saved" message alone.
      if (quiet && st.tab === 'settings' && host.querySelector('#gv-settings')) {
        const tpl = document.createElement('template');
        tpl.innerHTML = this._gvDetailHtml(g, st.tab);
        for (const sel of ['.gv-state-line', '.gv-facts']) host.querySelector(sel)?.replaceWith(tpl.content.querySelector(sel));
        createIcons(host);
        return;
      }
      const pane = host.querySelector('[data-pane]');
      const paneOpenPhases = pane ? [...pane.querySelectorAll('details[open][data-phase]')].map(d => d.dataset.phase) : [];
      host.innerHTML = this._gvDetailHtml(g, st.tab);
      for (const key of paneOpenPhases) host.querySelector(`details[data-phase="${CSS.escape(key)}"]`)?.setAttribute('open', '');
      this._gvBindDetail(host, g);
      createIcons(host);
      if (focus) host.querySelector('.gv-title')?.focus({ preventScroll: true });
    },

    _gvPrimary(g) {
      const a = g.display.action;
      if (a === 'raise-budget') return `<button type="button" class="btn btn-primary gv-primary" data-act="raise">Raise budget</button>`;
      if (a === 'retry') return `<button type="button" class="btn btn-primary gv-primary" data-act="retry">Retry now</button>`;
      if (a === 'plan-phase') return `<button type="button" class="btn btn-primary gv-primary" data-act="plan">Plan a phase</button>`;
      if (a === 'activate') return `<button type="button" class="btn btn-primary gv-primary" data-act="activate">${g.status === 'paused' ? 'Resume' : 'Activate'}</button>`;
      if (a === 'open-task') return `<a class="btn btn-primary gv-primary" href="#tasks/${enc(g.display.taskId)}">Answer the task</a>`;
      return '';
    },

    _gvDetailHtml(g, tab) {
      const d = g.display;
      const menu = [];
      if (g.status === 'active') menu.push(`<button type="button" data-act="pause">Pause</button>`);
      if (g.status !== 'achieved' && g.status !== 'blocked') menu.push(`<button type="button" data-act="block">Block…</button>`);
      menu.push(`<button type="button" data-act="delete" class="is-danger">Delete…</button>`);
      const tabs = TABS.map(([k, label]) => `<a role="tab" id="gv-tab-${k}" href="#goals/${enc(g.goalId)}/${k}" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" aria-controls="gv-pane">${label}</a>`).join('');
      const done = g.phases.filter(p => p.status === 'audited' || p.status === 'done').length;
      return `
        <a class="gv-back" href="#goals">${icon('arrow-left')}<span>All goals</span></a>
        <header class="gv-detail-head">
          <h2 class="gv-title" tabindex="-1">${esc(g.title)}</h2>
          <div class="gv-state-line">${stateBadge(d.state)}<span>${nextLine(d)}</span></div>
          <div class="gv-actions">
            ${this._gvPrimary(g)}
            <details class="gv-menu"><summary aria-label="More actions">${icon('ellipsis')}</summary><div class="gv-menu-body">${menu.join('')}</div></details>
          </div>
        </header>
        <div class="gv-facts">
          <p><span class="gv-k">Done when</span> ${esc(g.successCriteria)}</p>
          ${g.nextMove ? `<p><span class="gv-k">Latest brief</span> ${esc(g.nextMove)}</p>` : ''}
          <div class="gv-progress">${segments(g.phases.map(p => ({ planned: 'p', active: 'a', completing: 'c' })[p.status] || 'd').join(''))}
            <span>${done}/${g.phases.length} phases</span><span>${g.progress.done}/${g.progress.total} tasks done</span><span>${g.budget.used}/${g.budget.cap} budget</span></div>
        </div>
        <nav class="gv-tabs" role="tablist" aria-label="Goal sections">${tabs}</nav>
        <div class="gv-pane" id="gv-pane" role="tabpanel" aria-labelledby="gv-tab-${tab}" data-pane="${tab}">${this._gvPane(g, tab)}</div>`;
    },

    _gvPane(g, tab) {
      if (tab === 'phases') return this._gvPhases(g);
      if (tab === 'decisions') return this._gvDecisions(g);
      if (tab === 'files') return this._gvFiles(g);
      if (tab === 'settings') return this._gvSettings(g);
      return this._gvOverview(g);
    },

    _gvOverview(g) {
      const out = [];
      if (g.status === 'blocked') {
        out.push(`<div class="gv-block"><p><span class="gv-k">Held because</span> ${esc(g.blockReason || BLOCK_TEXT[g.blockCode] || 'Held')}</p>
          ${g.unblockCriteria ? `<p><span class="gv-k">Resumes when</span> ${esc(g.unblockCriteria)}</p>` : ''}
          ${g.nextRetryAt ? `<p><span class="gv-k">Auto-retry</span> ${timeTag(g.nextRetryAt)}${g.blockCount ? ` · attempt ${g.blockCount}` : ''}</p>` : ''}</div>`);
      }
      if (g.status === 'achieved' && g.closedReason) out.push(`<p><span class="gv-k">Closed</span> ${esc(g.closedReason)}</p>`);
      if (g.lastRejected) out.push(`<p><span class="gv-k">Last rejected move</span> ${esc(g.lastRejected.reason)}</p>`);
      if (g.description) out.push(`<details class="gv-more"><summary>Goal details</summary><p class="gv-pre">${esc(g.description)}</p></details>`);
      if (g.reportBrief) out.push(`<p><span class="gv-k">Report focus</span> ${esc(g.reportBrief)}</p>`);
      const open = (g.taskRows || []).filter(t => ['pending', 'claimed', 'in-progress', 'scheduled', 'wait-input'].includes(t.status));
      if (open.length) out.push(`<h3 class="gv-h">Open tasks</h3><ul class="gv-tasks">${open.map(t => this._gvTaskRow(t)).join('')}</ul>`);
      return out.join('') || '<p class="gv-muted">Nothing else to show yet.</p>';
    },

    _gvTaskRow(t) {
      return `<li><a href="#tasks/${enc(t.id)}">${esc(t.title)}</a>
        <span class="gv-muted">${esc(t.status)}${t.scheduledAt && t.status === 'scheduled' ? ` · ${esc(fmtWhen(t.scheduledAt))}` : ''}${t.usage?.input !== undefined ? ` · ${fmtNum((t.usage.input || 0) + (t.usage.cacheRead || 0) + (t.usage.cacheWrite || 0) + (t.usage.output || 0))} tokens` : ''}</span></li>`;
    },

    _gvDoc(artifact, label) {
      const cut = artifact.indexOf('/');
      return `<a class="md-artifact gv-doc" href="/api/artifacts/${esc(artifact)}" data-md-task="${esc(artifact.slice(0, cut))}" data-md-file="${esc(artifact.slice(cut + 1))}" data-md-kind="artifacts">${icon('file-text')}<span>${esc(label)}</span></a>`;
    },

    _gvPhases(g) {
      if (!g.phases.length) return '<p class="gv-muted">No phases yet.</p>';
      const rows = g.taskRows || [];
      const minutesFor = (key) => (g.minutes || []).filter(m => m.phaseKey === key).at(-1);
      return `<ol class="gv-stepper">${g.phases.map(p => {
        const tasks = rows.filter(t => t.phaseKey === p.key && t.role !== 'goal-judger' && t.role !== 'goal-attention');
        const m = minutesFor(p.key);
        const u = g.usage?.phases?.[p.key];
        const docs = [
          p.reportArtifact ? this._gvDoc(p.reportArtifact, 'Report') : '',
          m ? this._gvDoc(m.artifact, 'Minutes') : '',
          p.attentionArtifact ? this._gvDoc(p.attentionArtifact, `Attention${p.attentionFlags ? ` (${p.attentionFlags} flag${p.attentionFlags === 1 ? '' : 's'})` : ''}`) : ''
        ].filter(Boolean).join('');
        const isCurrent = p.status === 'active' || p.status === 'completing';
        return `<li class="gv-step" data-status="${esc(p.status)}">
          <details data-phase="${esc(p.key)}" ${isCurrent ? 'open' : ''}><summary><span class="gv-step-title">${esc(p.title || p.key)}</span>
            <span class="gv-muted">${esc(PHASE_LABEL[p.status] || p.status)} · ${tasks.length} task${tasks.length === 1 ? '' : 's'}${u?.total ? ` · ${fmtNum(u.total)} tokens` : ''}</span></summary>
            ${tasks.length ? `<ul class="gv-tasks">${tasks.map(t => this._gvTaskRow(t)).join('')}</ul>` : ''}
            ${docs ? `<div class="gv-docs">${docs}</div>` : ''}
          </details></li>`;
      }).join('')}</ol>`;
    },

    _gvDecisionRows(rows) {
      return rows.slice().reverse().map(h => {
        const text = h.kind === 'block' ? (h.reason || BLOCK_TEXT[h.code] || 'Held') : (h.reason || '');
        const label = { evaluate: h.met ? 'Criterion met' : 'Evaluated: not met', plan: 'Planned', emit: 'Created task', judge: 'Judger started', finish: 'Finished', block: 'Blocked', resume: 'Resumed' }[h.kind] || h.kind;
        const count = h.count > 1 ? ` <span class="gv-count">${h.count} times since ${esc(new Date(h.firstAt || h.at).toLocaleString())}</span>` : '';
        const task = h.taskId ? ` <a href="#tasks/${enc(h.taskId)}">task</a>` : '';
        return `<li><span class="gv-dec-kind">${esc(label)}</span>${h.phaseKey ? ` <span class="gv-muted">${esc(h.phaseKey)}</span>` : ''}${count}${task}
          <span class="gv-muted gv-dec-at">${esc(timeAgo(h.lastAt || h.at))}</span>${text ? `<div class="gv-dec-text">${esc(text)}</div>` : ''}</li>`;
      }).join('');
    },

    _gvDecisions(g) {
      if (!(g.history || []).length) return '<p class="gv-muted">No decisions yet.</p>';
      return `<ul class="gv-decisions" id="gv-decisions">${this._gvDecisionRows(g.history)}</ul>
        ${g.historyInJsonl ? `<button type="button" class="btn gv-load-history" data-act="history">Show full history</button>` : ''}`;
    },

    _gvFiles(g) {
      const docs = [
        ...(g.minutes || []).map(m => this._gvDoc(m.artifact, `Minutes: ${m.phaseKey}`)),
        ...g.phases.filter(p => p.reportArtifact).map(p => this._gvDoc(p.reportArtifact, `Report: ${p.key}`)),
        ...g.phases.filter(p => p.attentionArtifact).map(p => this._gvDoc(p.attentionArtifact, `Attention: ${p.key}`))
      ];
      return docs.length ? `<div class="gv-docs gv-docs-col">${docs.join('')}</div>` : '<p class="gv-muted">No reports or minutes yet. The Judger writes them when a phase completes.</p>';
    },

    _gvSettings(g) {
      const u = g.usage || {};
      const usageRow = (name, r) => (r ? `<tr><th scope="row">${name}</th><td>${r.metered ? fmtNum(r.total) : '-'}</td><td>${r.metered || 0}</td><td>${r.unmetered || 0}</td></tr>` : '');
      const disabled = g.status === 'achieved' ? 'disabled' : '';
      const when = g.nextRetryAt ? `Takes effect on the next retry, ${esc(fmtWhen(g.nextRetryAt))}.` : 'Takes effect on the next Achiever turn.';
      return `<form class="gv-form" id="gv-settings" novalidate>
          ${field('gs-title', 'Title', `<input id="gs-title" value="${esc(g.title)}" ${disabled}>`)}
          ${field('gs-criteria', 'Done when (Yes/No question)', `<input id="gs-criteria" value="${esc(g.successCriteria)}" ${disabled}>`)}
          <div class="gv-grid2">
            ${field('gs-budget', `Step budget (${g.budget.used} used)`, `<input id="gs-budget" type="number" min="1" value="${esc(g.budget.cap)}" ${disabled}>`, when)}
            ${field('gs-tokens', 'Token budget (optional)', `<input id="gs-tokens" type="number" min="0" value="${esc(g.tokenBudget || '')}" placeholder="No limit" ${disabled}>`, 'Counts metered tokens, cache reads included.')}
          </div>
          ${field('gs-achiever', 'Achiever agents', `<input id="gs-achiever" value="${esc((g.achieverAgentChain || []).join(', '))}" placeholder="Comma separated, blank means auto" ${disabled}>`)}
          ${field('gs-judger', 'Judger agents', `<input id="gs-judger" value="${esc((g.judgerAgentChain || []).join(', '))}" placeholder="Comma separated, blank means auto" ${disabled}>`)}
          <div class="gv-form-foot"><button type="submit" class="btn btn-primary" ${disabled}>Save</button><span class="gv-saved" id="gs-saved" role="status"></span></div>
        </form>
        <h3 class="gv-h">Token use</h3>
        <table class="gv-table"><thead><tr><th scope="col">Role</th><th scope="col">Tokens</th><th scope="col">Metered runs</th><th scope="col">Not metered</th></tr></thead>
          <tbody>${usageRow('Tasks', u.tasks)}${usageRow('Achiever turns', u.achiever)}</tbody></table>
        <p class="gv-hint">Runs from before telemetry, and agents that report nothing, show as not metered, never as zero. Id: <code>${esc(g.goalId)}</code></p>`;
    },

    _gvBindDetail(host, g) {
      const id = g.goalId;
      const post = (path) => this.api.post(`/goals/${enc(id)}/${path}`);
      const after = async (msg) => {
        this.contentEl.querySelector('#gv-status').textContent = msg;
        await this._goalsRefresh();
        await this._gvLoadDetail({ quiet: false });
      };
      const guarded = (btn, fn) => busy(btn, fn).catch(e => this.toast('action failed', e.message));

      host.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        btn.closest('details.gv-menu')?.removeAttribute('open');
        if (act === 'retry') return guarded(btn, async () => { await post('activate'); await after('Retrying now.'); });
        if (act === 'activate') return guarded(btn, async () => { await post('activate'); await after('Goal is active.'); });
        if (act === 'pause') return guarded(btn, async () => { await post('pause'); await after('Goal paused.'); });
        if (act === 'raise') { window.location.hash = `#goals/${enc(id)}/settings`; return null; }
        if (act === 'plan') return this._gvPlanDialog(g, after);
        if (act === 'block') return this._gvBlockDialog(g, after);
        if (act === 'delete') return this._gvDeleteDialog(g);
        if (act === 'history') {
          return guarded(btn, async () => {
            const rows = await this.api.get(`/goals/${enc(id)}/history`);
            host.querySelector('#gv-decisions').innerHTML = this._gvDecisionRows(rows);
            btn.remove();
          });
        }
        return null;
      }));

      // Tabs follow the ARIA pattern: arrow keys move between them.
      const tabs = [...host.querySelectorAll('[role="tab"]')];
      tabs.forEach((t, i) => t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        window.location.hash = next.getAttribute('href');
        setTimeout(() => this.contentEl.querySelector(`#${next.id}`)?.focus(), 150);
      }));

      const form = host.querySelector('#gv-settings');
      if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const val = (k) => form.querySelector(`#${k}`).value.trim();
        const errs = {};
        if (!val('gs-title')) errs['gs-title'] = 'Enter a title.';
        if (!val('gs-criteria')) errs['gs-criteria'] = 'Enter the Yes/No question that ends this goal.';
        const budget = parseInt(val('gs-budget'), 10);
        if (!(budget > 0)) errs['gs-budget'] = 'Enter a whole number of 1 or more.';
        const tokens = val('gs-tokens') === '' ? 0 : parseInt(val('gs-tokens'), 10);
        if (!(tokens >= 0)) errs['gs-tokens'] = 'Enter 0 or more, or leave blank for no limit.';
        ['gs-title', 'gs-criteria', 'gs-budget', 'gs-tokens'].forEach(k => setFieldError(form, k, errs[k]));
        const first = Object.keys(errs)[0];
        if (first) { form.querySelector(`#${first}`).focus(); return; }
        const saved = form.querySelector('#gs-saved');
        const btn = form.querySelector('button[type="submit"]');
        await busy(btn, async () => {
          try {
            await this.api.patch(`/goals/${enc(id)}`, {
              title: val('gs-title'), successCriteria: val('gs-criteria'), stepBudget: budget, tokenBudget: tokens,
              achieverAgentChain: parseList(val('gs-achiever')), judgerAgentChain: parseList(val('gs-judger'))
            });
            saved.textContent = g.nextRetryAt ? `Saved. Takes effect on the next retry, ${fmtWhen(g.nextRetryAt)}.` : 'Saved.';
            await this._goalsRefresh();
          } catch (err) { saved.textContent = `Could not save: ${err.message}`; }
        }, 'Saving…');
      });
    },

    /** A modal built on <dialog>, which traps focus and handles Esc itself. */
    _gvDialog({ title, body, submit, danger, onSubmit, init }) {
      const dlg = document.createElement('dialog');
      dlg.className = 'gv-dialog';
      dlg.innerHTML = `<form method="dialog" novalidate>
        <h3>${esc(title)}</h3>
        <div class="gv-dialog-body">${body}</div>
        <p class="gv-error" data-dialog-error role="alert" hidden></p>
        <div class="gv-dialog-foot">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="submit" class="btn ${danger ? 'gv-btn-danger' : 'btn-primary'}" data-ok>${esc(submit)}</button>
        </div></form>`;
      this.contentEl.querySelector('.gv')?.appendChild(dlg);
      dlg.addEventListener('close', () => dlg.remove());
      dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
      dlg.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = dlg.querySelector('[data-dialog-error]');
        errBox.hidden = true;
        const ok = dlg.querySelector('[data-ok]');
        try {
          const closeAfter = await busy(ok, () => onSubmit(dlg));
          if (closeAfter !== false) dlg.close();
        } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
      });
      init?.(dlg);
      dlg.showModal();
      return dlg;
    },

    _gvBlockDialog(g, after) {
      this._gvDialog({
        title: `Block "${g.title}"`,
        submit: 'Block goal',
        body: `${field('gb-reason', 'What is the obstacle?', '<input id="gb-reason">')}
          ${field('gb-resume', 'It can resume when…', '<input id="gb-resume">', 'A condition someone could check.')}
          <div class="gv-grid2">
            ${field('gb-type', 'Automatic check (optional)', `<select id="gb-type"><option value="">None</option><option value="after-time">After a time</option><option value="file-exists">A file exists</option><option value="http-200">A public URL returns 200</option><option value="agent-available">An agent has quota</option></select>`)}
            ${field('gb-value', 'Check value', '<input id="gb-value" placeholder="Time, path, URL or agent id">')}
          </div>`,
        onSubmit: async (dlg) => {
          const reason = dlg.querySelector('#gb-reason').value.trim();
          setFieldError(dlg, 'gb-reason', reason ? '' : 'Say what is stopping this goal.');
          if (!reason) { dlg.querySelector('#gb-reason').focus(); return false; }
          const type = dlg.querySelector('#gb-type').value;
          const value = dlg.querySelector('#gb-value').value.trim();
          setFieldError(dlg, 'gb-value', type && !value ? 'Enter what to check.' : '');
          if (type && !value) { dlg.querySelector('#gb-value').focus(); return false; }
          await this.api.post(`/goals/${enc(g.goalId)}/block`, {
            reason, unblockCriteria: dlg.querySelector('#gb-resume').value.trim() || undefined,
            ...(type ? { unblockCheck: { type, value } } : {})
          });
          await after('Goal blocked.');
          return true;
        }
      });
    },

    _gvPlanDialog(g, after) {
      this._gvDialog({
        title: 'Plan the next phase',
        submit: 'Add phase',
        body: `${field('gp-title', 'What should this phase do?', '<input id="gp-title">', 'Make it concrete work with a result the Judger can check.')}`,
        onSubmit: async (dlg) => {
          const title = dlg.querySelector('#gp-title').value.trim();
          setFieldError(dlg, 'gp-title', title ? '' : 'Describe the phase.');
          if (!title) { dlg.querySelector('#gp-title').focus(); return false; }
          const seen = new Set(g.phases.map(p => p.key));
          await this.api.patch(`/goals/${enc(g.goalId)}`, { phases: [{ key: deriveKey(title, g.phases.length, seen), title }] });
          if (g.status === 'blocked') await this.api.post(`/goals/${enc(g.goalId)}/activate`);
          await after('Phase added.');
          return true;
        }
      });
    },

    _gvDeleteDialog(g) {
      const n = (g.taskRows || []).length;
      this._gvDialog({
        title: `Delete "${g.title}"?`,
        submit: 'Delete goal',
        danger: true,
        body: `<p>This removes the goal${n ? ` and its ${n} task${n === 1 ? '' : 's'}` : ''} immediately. It cannot be undone.</p>
          ${n ? `<label class="gv-check"><input type="checkbox" id="gd-keep"> Keep the ${n} task${n === 1 ? '' : 's'}</label>` : ''}`,
        onSubmit: async (dlg) => {
          const keep = dlg.querySelector('#gd-keep')?.checked;
          await this.api.del(`/goals/${enc(g.goalId)}${keep ? '' : '?withTasks=1'}`);
          this.toast('goal deleted', g.title);
          dlg.close();
          window.location.hash = '#goals';
          return false;
        }
      });
    },

    // ── Create ───────────────────────────────────────────────────────────────

    async _renderGoalCreate() {
      if (this.contentEl.querySelector('.gv[data-page="new"]')) return;   // keep what is typed
      this.contentEl.innerHTML = `<div class="gv gv-create" data-page="new">
        <a class="gv-back gv-back-always" href="#goals">${icon('arrow-left')}<span>All goals</span></a>
        <h2 class="gv-title" tabindex="-1">New goal</h2>
        <form id="gv-create" novalidate class="gv-form">
          <fieldset class="gv-fieldset"><legend>1. Start from an example, or from blank</legend>
            <div class="gv-starters" id="gv-starters"><span class="gv-muted">Loading examples…</span></div>
          </fieldset>
          <fieldset class="gv-fieldset"><legend>2. What is done?</legend>
            ${field('gc-title', 'Title', '<input id="gc-title" placeholder="Ship a new single-page web tool">')}
            ${field('gc-criteria', 'Done when (a Yes/No question)', '<input id="gc-criteria" placeholder="Is the tool live on GitHub Pages with a working index.html?">',
              'Tie it to something you can point at. For a market number, ask whether a dated snapshot shows it, and give the goal a long budget.')}
            <p class="gv-warn" id="gc-warn" hidden>This does not read as a Yes/No question. A goal only ends when its answer can flip to Yes.</p>
          </fieldset>
          <fieldset class="gv-fieldset"><legend>3. Which phases?</legend>
            ${field('gc-phases', 'One checkpoint per line, in order', '<textarea id="gc-phases" rows="5" placeholder="Scope the tool&#10;Build it&#10;Deploy and verify it loads"></textarea>',
              'The Judger audits each phase before the next begins, so keep them concrete and sequential.')}
          </fieldset>
          <details class="gv-more"><summary>Advanced options</summary>
            ${field('gc-desc', 'Context for the agents doing the work', '<textarea id="gc-desc" rows="3"></textarea>')}
            ${field('gc-report', 'Report focus for the Judger', '<input id="gc-report" placeholder="Financial breakdown per phase">')}
            <div class="gv-grid2">
              ${field('gc-achiever', 'Achiever agents', '<input id="gc-achiever" placeholder="Comma separated, blank means auto">')}
              ${field('gc-judger', 'Judger agents', '<input id="gc-judger" placeholder="Comma separated, blank means auto">')}
              ${field('gc-budget', 'Step budget', '<input id="gc-budget" type="number" min="1" placeholder="24">')}
            </div>
          </details>
          <div class="gv-preview" id="gc-preview" role="status"></div>
          <div class="gv-form-foot">
            <button type="submit" class="btn btn-primary" data-activate="1">Create and activate</button>
            <button type="submit" class="btn" data-activate="">Save as draft</button>
            <span class="gv-saved" id="gc-saved" role="alert"></span>
          </div>
        </form>
      </div>`;
      createIcons();
      const root = this.contentEl.querySelector('.gv-create');
      root.querySelector('.gv-title').focus({ preventScroll: true });
      const q = (id) => root.querySelector(`#${id}`);

      let loop = '';
      const preview = () => {
        const phases = parsePhases(q('gc-phases').value);
        const crit = q('gc-criteria').value.trim();
        q('gc-warn').hidden = !crit || looksYesNo(crit);
        const budget = parseInt(q('gc-budget').value, 10) || 24;
        q('gc-preview').textContent = `Preview: ${phases.length} phase${phases.length === 1 ? '' : 's'}, budget of ${budget} tasks${loop ? `, ${loop} goal` : ''}. It keeps running until the answer is Yes.`;
      };
      root.addEventListener('input', preview);
      preview();

      // Starters load only here, so opening the list never pays for them.
      this.api.get('/goals/templates').then((templates) => {
        const host = q('gv-starters');
        if (!host) return;
        host.innerHTML = templates.map(t => `<button type="button" class="gv-chip" data-tpl="${esc(t.key)}">${esc(stripEmoji(t.label))}</button>`).join('');
        host.addEventListener('click', (e) => {
          const b = e.target.closest('[data-tpl]');
          const t = b && templates.find(x => x.key === b.dataset.tpl);
          if (!t) return;
          q('gc-title').value = t.title;
          q('gc-desc').value = t.description || '';
          q('gc-criteria').value = t.successCriteria;
          q('gc-report').value = t.reportBrief || '';
          q('gc-phases').value = Array.isArray(t.phases) ? t.phases.join('\n') : t.phases;
          q('gc-budget').value = t.budget || '';
          loop = t.family === 'outcome' ? 'long-running outcome' : 'deliverable';
          host.querySelectorAll('[data-tpl]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
          preview();
          q('gc-title').focus();
        });
      }).catch(() => { const host = q('gv-starters'); if (host) host.textContent = 'Examples are unavailable. You can still start from blank.'; });

      q('gv-create').addEventListener('submit', async (e) => {
        e.preventDefault();
        const activate = !!e.submitter?.dataset.activate;
        const phases = parsePhases(q('gc-phases').value);
        const errs = {
          'gc-title': q('gc-title').value.trim() ? '' : 'Enter a short title.',
          'gc-criteria': q('gc-criteria').value.trim() ? '' : 'Enter the Yes/No question that ends this goal.',
          'gc-phases': activate && !phases.length ? 'Add at least one phase before activating.' : ''
        };
        Object.entries(errs).forEach(([k, v]) => setFieldError(root, k, v));
        const first = Object.keys(errs).find(k => errs[k]);
        if (first) { q(first).focus(); return; }
        const budget = parseInt(q('gc-budget').value, 10);
        const body = {
          title: q('gc-title').value.trim(), description: q('gc-desc').value.trim(), successCriteria: q('gc-criteria').value.trim(),
          reportBrief: q('gc-report').value.trim() || undefined, phases,
          achieverAgentChain: parseList(q('gc-achiever').value), judgerAgentChain: parseList(q('gc-judger').value),
          stepBudget: budget > 0 ? budget : undefined
        };
        const saved = q('gc-saved');
        saved.textContent = '';
        await busy(e.submitter || q('gv-create').querySelector('button'), async () => {
          let id;
          try { id = (await this.api.post('/goals', body))?.goal?.goalId; }
          catch (err) { saved.textContent = `Could not create the goal: ${err.message}`; return; }
          if (activate && id) {
            // Activation is a second call and can fail alone: the draft does exist.
            try { await this.api.post(`/goals/${enc(id)}/activate`); this.toast('goal activated', body.title); }
            catch (err) { this.toast('saved as draft', `Created, but could not activate: ${err.message}`); }
          } else this.toast('goal created', `${body.title}, saved as a draft.`);
          window.location.hash = `#goals/${enc(id)}`;
        }, 'Creating…');
      });
    }
  });
})();
