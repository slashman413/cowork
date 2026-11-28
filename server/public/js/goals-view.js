/**
 * Goals workspace (#goals) — DSH Web workspace interaction model.
 *
 * Persistent split-pane navigator with resizable divider, workspace switcher
 * (Tasks <-> Goals), collapsible grouping, pinning, hover quick actions,
 * in-place goal & tab switching without full-page reloads, inline New Goal
 * composer in the detail pane, and inline action drawers (zero modal dead ends).
 *
 * Routes:  #goals            workspace (auto-selects last/first goal on desktop)
 *          #goals/new        opens inline New Goal composer in detail pane
 *          #goals/<id>/<tab> detail: overview, phases, decisions, files, settings
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
  const FILTERS = [['all', 'All'], ['needs-you', 'Needs you'], ['stuck', 'Stuck'], ['running', 'Running'], ['retrying', 'Retrying'], ['sleeping', 'Sleeping'], ['draft', 'Draft'], ['paused', 'Paused'], ['achieved', 'Achieved']];
  const FILTER_OF = { thinking: 'running', auditing: 'running' };
  const filterOf = (state) => FILTER_OF[state] || state;
  const TABS = [['overview', 'Overview'], ['phases', 'Phases'], ['decisions', 'Decisions'], ['files', 'Files'], ['settings', 'Settings']];
  const PHASE_LABEL = { planned: 'Planned', active: 'In progress', completing: 'Being audited', done: 'Done', audited: 'Audited' };
  const SEG = { p: 'Planned', a: 'In progress', c: 'Being audited', d: 'Done' };
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

  function row(g, selected, pinned) {
    const done = [...(g.phases || '')].filter(l => l === 'd').length;
    const total = (g.phases || '').length;
    const st = g.display.state;
    let quickBtn = '';
    if (st === 'paused' || st === 'draft') {
      quickBtn = `<button type="button" class="dsh-row-act-btn" data-gv-quick-id="${esc(g.goalId)}" data-gv-quick-act="activate" title="${st === 'paused' ? 'Resume goal' : 'Activate goal'}" aria-label="Activate goal"><i data-lucide="play"></i></button>`;
    } else if (st === 'running' || st === 'thinking' || st === 'sleeping') {
      quickBtn = `<button type="button" class="dsh-row-act-btn" data-gv-quick-id="${esc(g.goalId)}" data-gv-quick-act="pause" title="Pause goal" aria-label="Pause goal"><i data-lucide="pause"></i></button>`;
    } else if (st === 'retrying' || st === 'stuck') {
      quickBtn = `<button type="button" class="dsh-row-act-btn" data-gv-quick-id="${esc(g.goalId)}" data-gv-quick-act="retry" title="Retry now" aria-label="Retry now"><i data-lucide="rotate-ccw"></i></button>`;
    }

    return `<li class="gv-li" data-id="${esc(g.goalId)}" data-state="${esc(st)}">
      <a class="gv-row${selected ? ' is-selected' : ''}" href="#goals/${enc(g.goalId)}" data-gv-select="${esc(g.goalId)}" ${selected ? 'aria-current="true"' : ''}>
        <span class="dsh-row-dot-wrap" aria-hidden="true"><span class="dsh-dot" data-state="${esc(st)}"></span></span>
        <span class="gv-row-body">
          <span class="gv-row-top">
            ${pinned ? `<span class="dsh-pin-dot" title="Pinned" aria-label="Pinned"><i data-lucide="pin"></i></span>` : ''}
            <span class="gv-row-title">${esc(g.title)}</span>
            <span class="dsh-row-right">
              <span class="gv-budget">${g.budget.used}/${g.budget.cap}</span>
              <span class="dsh-row-actions">
                ${quickBtn}
                <button type="button" class="dsh-row-act-btn${pinned ? ' is-pinned' : ''}" data-gv-pin="${esc(g.goalId)}" title="${pinned ? 'Unpin' : 'Pin to top'}" aria-label="${pinned ? 'Unpin' : 'Pin to top'}"><i data-lucide="pin"></i></button>
              </span>
            </span>
          </span>
          <span class="gv-row-line">${stateBadge(st)} <span class="dsh-meta-sep">·</span> ${nextLine(g.display)}</span>
          <span class="gv-row-foot">${segments(g.phases)}<span class="gv-phases-count">${done}/${total} phases</span></span>
        </span>
      </a>
    </li>`;
  }

  const looksYesNo = (s) => /\?\s*$/.test(s) && /^\s*(is|are|does|do|did|has|have|can|will|was|were|should)\b/i.test(s);

  function questionOptions(text) {
    const parts = String(text || '').split(/(?:^|\s)\(([a-f])\)\s+/);
    if (parts.length < 5) return [];
    const out = [];
    for (let i = 1; i < parts.length; i += 2) {
      let t = parts[i + 1] || '';
      if (i + 2 >= parts.length) t = t.split(/\s(?=(?:Note|Once you answer|After the answer)\b)/i)[0];
      t = t.replace(/\s*\b(or|and)\s*$/i, '').replace(/[;,]\s*$/, '').trim();
      if (t) out.push({ key: parts[i], text: t });
    }
    return out;
  }
  const questionLead = (text) => String(text || '').split(/(?:^|\s)\([a-f]\)\s+/)[0].trim();

  function deriveKey(raw, idx, seen) {
    const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `phase-${idx + 1}`;
    let key = base; let n = 2;
    while (seen.has(key)) key = `${base}-${n++}`;
    seen.add(key);
    return key;
  }

  function parsePhases(text) {
    const seen = new Set();
    return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map((line, idx) => {
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
    _goalsParts() {
      const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
      return window.location.hash.replace(/^#/, '').split('/').slice(1).map(decode).filter(Boolean);
    },

    _gvPrefs() {
      if (!this._gvWsPrefs) {
        this._gvWsPrefs = this._dshLoadPrefs('cowork-goals-ws', {
          filter: 'all',
          sort: 'default',
          groupBy: 'flat',
          pinned: [],
          collapsed: {},
          lastSelected: null,
          lastTab: 'overview'
        });
        if (!Array.isArray(this._gvWsPrefs.pinned)) this._gvWsPrefs.pinned = [];
        if (!this._gvWsPrefs.collapsed || typeof this._gvWsPrefs.collapsed !== 'object') this._gvWsPrefs.collapsed = {};
      }
      return this._gvWsPrefs;
    },

    _gvSavePrefs(patch) {
      const p = this._gvPrefs();
      Object.assign(p, patch);
      this._dshSavePrefs('cowork-goals-ws', p);
    },

    async renderGoals() {
      const parts = this._goalsParts();
      const prefs = this._gvPrefs();
      const st = (this._gv ||= {
        filter: prefs.filter || 'all',
        search: '',
        sort: prefs.sort || 'default',
        groupBy: prefs.groupBy || 'flat',
        list: [],
        rowHtml: new Map(),
        creating: false
      });
      this._gvBindPopovers();

      const wantNew = parts[0] === 'new';
      st.creating = wantNew;
      if (wantNew) {
        st.selected = null;
      } else if (parts[0]) {
        st.selected = parts[0];
        st.tab = TABS.some(t => t[0] === parts[1]) ? parts[1] : (prefs.lastTab || 'overview');
      } else {
        st.selected = prefs.lastSelected || null;
        st.tab = prefs.lastTab || 'overview';
      }

      const shell = this.contentEl.querySelector('.gv[data-page="list"]');
      if (!shell) {
        this.contentEl.innerHTML = `<div class="gv dsh-page" data-page="list" data-mode="${(st.selected || st.creating) ? 'detail' : 'list'}">
          <div class="dsh-list-pane">
            <div class="dsh-list-scroll" id="gv-list-scroll">
              <div class="dsh-list-inner">
                <div class="dsh-list-sticky">
                  <div class="dsh-page-heading">
                    ${this._dshWorkspaceSwitcherHTML('goals')}
                    <div class="dsh-heading-actions">
                      <span class="gv-updated" id="gv-updated"></span>
                      <details class="dsh-menu" id="gv-view-opts">
                        <summary aria-label="View options" title="Grouping & display options">${icon('sliders-horizontal')}</summary>
                        <div class="dsh-menu-body">
                          <div class="dsh-menu-label">Group by</div>
                          <button type="button" data-gv-group="flat" class="${st.groupBy === 'flat' ? 'is-selected-opt' : ''}">Flat list</button>
                          <button type="button" data-gv-group="state" class="${st.groupBy === 'state' ? 'is-selected-opt' : ''}">State</button>
                        </div>
                      </details>
                      <details class="gv-help"><summary aria-label="What are goals?">${icon('circle-help')}</summary>
                        <div class="gv-help-body">
                          <p>A goal runs until its Yes/No criterion becomes true. The <strong>Achiever</strong> plans phases and creates tasks. The <strong>Judger</strong> audits each phase and writes what to do next.</p>
                          <p>A blocked goal is a recoverable hold. It retries on its own, in minutes at first and later in hours. Only <strong>Needs you</strong> means it is waiting on a person.</p>
                        </div>
                      </details>
                      <a class="dsh-btn-primary gv-new" href="#goals/new" id="gv-new-btn" title="New goal (n)">${icon('plus')}<span>New goal</span></a>
                    </div>
                  </div>
                  <div class="gv-strip" id="gv-strip" hidden></div>
                  <div class="dsh-filters gv-filters" role="group" aria-label="Filter goals"></div>
                  <div class="dsh-toolbar">
                    <label class="dsh-search-wrap" aria-label="Search goals">
                      ${icon('search')}
                      <input id="gv-search" class="dsh-search-input" type="search" placeholder="Search goals… (/)" value="${esc(st.search || '')}">
                      <button type="button" class="dsh-search-clear" id="gv-search-clear" aria-label="Clear search" ${st.search ? '' : 'hidden'}>${icon('x')}</button>
                    </label>
                    <select id="gv-sort" class="dsh-sort-select" aria-label="Sort goals">
                      <option value="default"${st.sort === 'default' ? ' selected' : ''}>Priority</option>
                      <option value="updated"${st.sort === 'updated' ? ' selected' : ''}>Recently updated</option>
                      <option value="title"${st.sort === 'title' ? ' selected' : ''}>Title A–Z</option>
                    </select>
                  </div>
                </div>
                <ul class="gv-list" id="gv-list" aria-label="Goals"></ul>
              </div>
            </div>
          </div>
          <div class="dsh-split-handle" role="separator" aria-orientation="vertical" aria-label="Resize goals list" title="Drag to resize · Double-click to reset"></div>
          <section class="dsh-detail-pane gv-detail" id="gv-detail" aria-label="Goal detail"></section>
          <div class="gv-sr" role="status" aria-live="polite" id="gv-status"></div>
        </div>`;
        st.rowHtml = new Map();
        const rootEl = this.contentEl.querySelector('.gv[data-page="list"]');
        this._dshAttachSplitHandle(rootEl);

        const searchEl = rootEl.querySelector('#gv-search');
        const clearBtn = rootEl.querySelector('#gv-search-clear');
        searchEl?.addEventListener('input', () => {
          st.search = searchEl.value;
          if (clearBtn) clearBtn.hidden = !searchEl.value;
          this._gvPatchList(rootEl);
        });
        clearBtn?.addEventListener('click', () => {
          st.search = '';
          if (searchEl) { searchEl.value = ''; searchEl.focus(); }
          clearBtn.hidden = true;
          this._gvPatchList(rootEl);
        });
        const sortEl = rootEl.querySelector('#gv-sort');
        sortEl?.addEventListener('change', () => {
          st.sort = sortEl.value;
          this._gvSavePrefs({ sort: st.sort });
          this._gvPatchList(rootEl);
        });
        rootEl.querySelectorAll('[data-gv-group]').forEach(btn =>
          btn.addEventListener('click', () => {
            st.groupBy = btn.dataset.gvGroup;
            this._gvSavePrefs({ groupBy: st.groupBy });
            rootEl.querySelectorAll('[data-gv-group]').forEach(x => x.classList.toggle('is-selected-opt', x.dataset.gvGroup === st.groupBy));
            btn.closest('details.dsh-menu')?.removeAttribute('open');
            st.rowHtml = new Map();
            this._gvPatchList(rootEl);
          }));
        rootEl.querySelector('#gv-new-btn')?.addEventListener('click', (e) => {
          e.preventDefault();
          this._gvOpenCreateInline();
        });
        // Delegated list interactions: in-place goal selection, pin, quick actions, group toggle
        rootEl.querySelector('#gv-list')?.addEventListener('click', (e) => {
          const pinBtn = e.target.closest?.('[data-gv-pin]');
          if (pinBtn) {
            e.preventDefault();
            e.stopPropagation();
            this._gvTogglePin(pinBtn.dataset.gvPin);
            return;
          }
          const qBtn = e.target.closest?.('[data-gv-quick-act]');
          if (qBtn) {
            e.preventDefault();
            e.stopPropagation();
            this._gvQuickAction(qBtn.dataset.gvQuickId, qBtn.dataset.gvQuickAct);
            return;
          }
          const grpHead = e.target.closest?.('.dsh-group-head[data-ws="goals"]');
          if (grpHead) {
            e.preventDefault();
            this._gvToggleGroup(grpHead.dataset.group);
            return;
          }
          const link = e.target.closest?.('a[data-gv-select]');
          if (link) {
            e.preventDefault();
            this._gvSelectGoal(link.dataset.gvSelect, st.tab || 'overview');
          }
        });
        rootEl.querySelector('#gv-strip')?.addEventListener('click', (e) => {
          const link = e.target.closest?.('a[data-gv-select]');
          if (link) {
            e.preventDefault();
            this._gvSelectGoal(link.dataset.gvSelect, 'overview');
          }
        });
      }

      await this._goalsRefresh({ force: true });

      // Validate selection against loaded list; auto-select first on desktop
      if (!st.creating) {
        if (st.selected && !st.list.some(g => g.goalId === st.selected) && !parts[0]) {
          st.selected = null;
        }
        if (!st.selected && st.list.length && window.innerWidth > 960) {
          st.selected = st.list[0].goalId;
        }
      }

      if (st.creating) {
        this._gvOpenCreateInline({ fromHash: true });
      } else if (st.selected) {
        await this._gvSelectGoal(st.selected, st.tab, { focus: !!parts[0], skipHash: !parts[0] });
      } else {
        await this._gvSelectGoal(null);
      }

      createIcons();
      this.addViewTimer(() => {
        this._gvTick();
        if (Date.now() - (st.fetchedAt || 0) > STALE_MS / 2) this._goalsRefresh().catch(() => {});
      }, 15000);
      this._gvTick();
    },

    _gvTogglePin(id) {
      const p = this._gvPrefs();
      const set = new Set(p.pinned);
      if (set.has(id)) set.delete(id); else set.add(id);
      this._gvSavePrefs({ pinned: [...set] });
      const root = this.contentEl.querySelector('.gv[data-page="list"]');
      if (root) {
        this._gv.rowHtml = new Map();
        this._gvPatchList(root);
      }
    },

    _gvToggleGroup(key) {
      const p = this._gvPrefs();
      const collapsed = { ...p.collapsed, [key]: !p.collapsed[key] };
      this._gvSavePrefs({ collapsed });
      const grp = this.contentEl.querySelector(`.dsh-group[data-group="${CSS.escape(key)}"]`);
      if (grp) grp.dataset.collapsed = collapsed[key] ? 'true' : 'false';
    },

    async _gvQuickAction(id, act) {
      try {
        if (act === 'activate' || act === 'retry') {
          await this.api.post(`/goals/${enc(id)}/activate`);
          this.toast('goal active', act === 'retry' ? 'Retrying now.' : 'Goal activated.');
        } else if (act === 'pause') {
          await this.api.post(`/goals/${enc(id)}/pause`);
          this.toast('goal paused', 'Paused.');
        }
        await this._goalsRefresh();
        if (this._gv?.selected === id) await this._gvLoadDetail({ quiet: false });
      } catch (e) { this.toast('action failed', e.message); }
    },

    /** In-place goal & tab switching without full-page reloads or /goals refetch! */
    async _gvSelectGoal(id, tab = 'overview', { focus = false, skipHash = false } = {}) {
      const st = this._gv;
      const root = this.contentEl.querySelector('.gv[data-page="list"]');
      const detailHost = root?.querySelector('#gv-detail');
      if (!st || !root || !detailHost) return;

      const leavingDetail = root.dataset.mode === 'detail' && !id;
      if (id && root.dataset.mode === 'list') this._gvSaveScroll();

      const sameGoal = id && st.selected === id && !st.creating && st.detail?.goalId === id;
      st.creating = false;
      st.selected = id || null;
      st.tab = TABS.some(t => t[0] === tab) ? tab : 'overview';
      root.dataset.mode = st.selected ? 'detail' : 'list';

      this._gvSavePrefs({ lastSelected: st.selected, lastTab: st.tab });

      if (!skipHash && this.currentPage?.type === 'goals') {
        const nextHash = st.selected
          ? `#goals/${enc(st.selected)}${st.tab !== 'overview' ? `/${st.tab}` : ''}`
          : '#goals';
        if (window.location.hash !== nextHash) history.replaceState(null, '', nextHash);
      }

      // Highlight selected row in-place
      root.querySelectorAll('.gv-row[data-gv-select]').forEach(el => {
        const sel = el.dataset.gvSelect === st.selected;
        el.classList.toggle('is-selected', sel);
        if (sel) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
      });

      if (!st.selected) {
        detailHost.classList.add('is-empty');
        detailHost.innerHTML = `<div class="dsh-empty-detail">${icon('target')}<p>Select a goal to inspect its phases, decisions and files.</p><button type="button" class="dsh-btn-primary" id="gv-empty-new">${icon('plus')}<span>New goal</span></button></div>`;
        detailHost.querySelector('#gv-empty-new')?.addEventListener('click', () => this._gvOpenCreateInline());
        createIcons(detailHost);
        if (leavingDetail) this._gvRestoreScroll();
        return;
      }

      detailHost.classList.remove('is-empty');
      if (sameGoal) {
        // Instant zero-network tab switch!
        this._gvRenderDetailInto(detailHost, st.detail, st.tab);
      } else {
        await this._gvLoadDetail({ focus });
      }
    },

    _gvBindPopovers() {
      if (this._gvPopoversBound) return;
      this._gvPopoversBound = true;
      const openOnes = () => [...document.querySelectorAll('.gv details.gv-menu[open], .gv details.gv-help[open]')];
      document.addEventListener('click', (e) => {
        const inside = e.target.closest?.('details.gv-menu, details.gv-help');
        openOnes().forEach(d => { if (d !== inside) d.removeAttribute('open'); });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        openOnes().forEach(d => { d.removeAttribute('open'); d.querySelector('summary')?.focus(); });
      });
    },

    _gvScroller() { return this.contentEl.querySelector('#gv-list-scroll') || this.contentEl.closest('.content-area') || document.scrollingElement; },
    _gvSaveScroll() { const st = this._gv; const el = this._gvScroller(); if (st && el) st.listScroll = el.scrollTop; },
    _gvRestoreScroll() {
      const st = this._gv; const el = this._gvScroller();
      if (st?.listScroll !== undefined && el) el.scrollTop = st.listScroll;
      if (st) st.listScroll = undefined;
      const back = st?.lastSelected && this.contentEl.querySelector(`.gv-li[data-id="${CSS.escape(st.lastSelected)}"] .gv-row`);
      if (back) back.focus({ preventScroll: true });
    },

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

      const before = new Map(st.list.map(g => [g.goalId, g]));
      const changes = list.filter(g => { const b = before.get(g.goalId); return b && b.display.state !== g.display.state; });
      if (changes.length) root.querySelector('#gv-status').textContent = changes.map(g => `${g.title}: ${STATES[g.display.state]?.label || g.display.state}`).join('. ');

      const updatedSelected = st.selected && before.get(st.selected)?.updatedAt !== list.find(g => g.goalId === st.selected)?.updatedAt;
      const stateChanged = st.selected && before.get(st.selected)?.display.state !== list.find(g => g.goalId === st.selected)?.display.state;
      st.list = list;
      this._gvPatchList(root);
      if (!force && !st.creating && (updatedSelected || stateChanged)) this._gvLoadDetail({ quiet: true }).catch(() => {});
      this._gvTick();
    },

    _gvPatchList(root) {
      const st = this._gv;
      const prefs = this._gvPrefs();
      const pinnedSet = new Set(prefs.pinned);
      const counts = { all: st.list.length };
      for (const g of st.list) { const k = filterOf(g.display.state); counts[k] = (counts[k] || 0) + 1; }

      const filters = root.querySelector('.gv-filters');
      const chipHtml = FILTERS.filter(([k]) => k === 'all' || k === 'needs-you' || k === st.filter || counts[k]).map(([k, label]) =>
        `<button type="button" class="gv-chip" data-filter="${k}" aria-pressed="${st.filter === k}">${label} <span class="gv-count">${counts[k] || 0}</span></button>`).join('');
      if (st.chipHtml !== chipHtml || !filters.firstChild) {
        st.chipHtml = chipHtml;
        filters.innerHTML = chipHtml;
        filters.querySelectorAll('.gv-chip').forEach(b => b.addEventListener('click', () => {
          const key = b.dataset.filter;
          st.filter = key;
          this._gvSavePrefs({ filter: key });
          this._gvPatchList(root);
          filters.querySelector(`[data-filter="${key}"]`)?.focus();
        }));
      }

      const urgent = st.list.filter(g => g.display.state === 'needs-you');
      const strip = root.querySelector('#gv-strip');
      strip.hidden = !urgent.length;
      strip.innerHTML = urgent.length ? `${icon('circle-alert')}<span><strong>${urgent.length} need${urgent.length === 1 ? 's' : ''} you:</strong> ${
        urgent.slice(0, 3).map(g => `<a href="#goals/${enc(g.goalId)}" data-gv-select="${esc(g.goalId)}">${esc(g.title)}</a>`).join(', ')}</span>` : '';

      const q = (st.search || '').trim().toLowerCase();
      let visible = st.list.filter(g => (st.filter === 'all' || filterOf(g.display.state) === st.filter)
        && (!q || String(g.title || '').toLowerCase().includes(q)));

      visible = [...visible].sort((a, b) => {
        const pa = pinnedSet.has(a.goalId) ? 0 : 1;
        const pb = pinnedSet.has(b.goalId) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        if (st.sort === 'updated') return (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0);
        if (st.sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
        return 0;
      });

      const ul = root.querySelector('#gv-list');
      if (!visible.length) {
        ul.innerHTML = `<li class="gv-none">${st.list.length ? 'No goals match this filter.' : `No goals yet. <a href="#goals/new" id="gv-none-new">Create the first one</a>.`}</li>`;
        ul.querySelector('#gv-none-new')?.addEventListener('click', (e) => { e.preventDefault(); this._gvOpenCreateInline(); });
        st.rowHtml = new Map();
        return;
      }

      if (st.groupBy === 'state') {
        const groups = new Map();
        const addTo = (key, label, g) => {
          if (!groups.has(key)) groups.set(key, { key, label, items: [] });
          groups.get(key).items.push(g);
        };
        for (const g of visible) {
          if (pinnedSet.has(g.goalId)) addTo('pinned', 'Pinned', g);
          else {
            const k = g.display.state;
            addTo(`st:${k}`, STATES[k]?.label || k, g);
          }
        }
        ul.innerHTML = [...groups.values()].map(grp => {
          const isCollapsed = !!prefs.collapsed[grp.key];
          return `<li class="dsh-group" data-group="${esc(grp.key)}" data-collapsed="${isCollapsed}">
            <button type="button" class="dsh-group-head" data-ws="goals" data-group="${esc(grp.key)}" aria-expanded="${!isCollapsed}">
              <span class="dsh-group-chevron">${icon('chevron-down')}</span>
              <span class="dsh-group-title">${esc(grp.label)}</span>
              <span class="dsh-group-count">${grp.items.length}</span>
            </button>
            <ul class="gv-group-list dsh-group-items">${grp.items.map(g => row(g, g.goalId === st.selected && !st.creating, pinnedSet.has(g.goalId))).join('')}</ul>
          </li>`;
        }).join('');
        st.rowHtml = new Map();
        createIcons(ul);
        return;
      }

      // Flat list with minimal DOM patching
      const wanted = visible.map(g => g.goalId);
      if (ul.querySelector('.dsh-group')) ul.innerHTML = '';
      const rows = new Map([...ul.querySelectorAll('.gv-li')].map(li => [li.dataset.id, li]));
      for (const [id, li] of rows) if (!wanted.includes(id)) { li.remove(); st.rowHtml.delete(id); }
      ul.querySelector('.gv-none')?.remove();
      let cursor = null;
      for (const g of visible) {
        const selected = g.goalId === st.selected && !st.creating;
        const html = row(g, selected, pinnedSet.has(g.goalId));
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
        const expected = cursor ? cursor.nextElementSibling : ul.firstElementChild;
        if (li !== expected) ul.insertBefore(li, expected);
        cursor = li;
      }
    },

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
      if (!host || !st.selected || st.creating) return;
      const id = st.selected;
      // Don't disturb an active inline action drawer during quiet SSE refresh
      if (quiet && host.querySelector('#gv-inline-drawer:not([hidden])')) return;
      let g;
      try { g = await this.api.get(`/goals/${enc(id)}`); }
      catch (e) {
        if (!quiet || !st.list.some(x => x.goalId === id)) {
          host.innerHTML = `<div class="dsh-empty-detail"><p>This goal could not be loaded: ${esc(e.message)}</p><button type="button" class="dsh-btn-ghost" id="gv-err-back">Back to goals</button></div>`;
          host.querySelector('#gv-err-back')?.addEventListener('click', () => this._gvSelectGoal(null));
        }
        return;
      }
      if (st.selected !== id || st.creating) return;
      if (g && !Array.isArray(g.phases)) {
        g.phases = typeof g.phases === 'string'
          ? [...g.phases].map((l, i) => ({ key: String(i + 1), title: '', status: PHASE_LETTER_STATUS[l] || 'planned' }))
          : [];
        if (!g.progress) g.progress = g.tasks || { done: 0, total: 0 };
      }
      st.detail = g;
      st.lastSelected = id;
      if (quiet && st.tab === 'settings' && host.querySelector('#gv-settings')) {
        const tpl = document.createElement('template');
        tpl.innerHTML = this._gvDetailHtml(g, st.tab);
        for (const sel of ['.gv-state-line', '.gv-facts']) host.querySelector(sel)?.replaceWith(tpl.content.querySelector(sel));
        createIcons(host);
        return;
      }
      this._gvRenderDetailInto(host, g, st.tab, { focus });
    },

    _gvRenderDetailInto(host, g, tab, { focus = false } = {}) {
      const pane = host.querySelector('[data-pane]');
      const paneOpenPhases = pane ? [...pane.querySelectorAll('details[open][data-phase]')].map(d => d.dataset.phase) : [];
      host.innerHTML = this._gvDetailHtml(g, tab);
      for (const key of paneOpenPhases) host.querySelector(`details[data-phase="${CSS.escape(key)}"]`)?.setAttribute('open', '');
      this._gvBindDetail(host, g);
      createIcons(host);
      if (focus) host.querySelector('.gv-title')?.focus({ preventScroll: true });
    },

    _gvPrimary(g) {
      const a = g.display.action;
      if (a === 'raise-budget') return `<button type="button" class="dsh-btn-primary gv-primary" data-act="raise">Raise budget</button>`;
      if (a === 'answer') return `<button type="button" class="dsh-btn-primary gv-primary" data-act="answer">${icon('message-square-reply')}<span>Answer</span></button>`;
      if (a === 'retry') return `<button type="button" class="dsh-btn-primary gv-primary" data-act="retry">Retry now</button>`;
      if (a === 'plan-phase') return `<button type="button" class="dsh-btn-primary gv-primary" data-act="plan">Plan a phase</button>`;
      if (a === 'activate') return `<button type="button" class="dsh-btn-primary gv-primary" data-act="activate">${g.status === 'paused' ? 'Resume' : 'Activate'}</button>`;
      if (a === 'open-task') return `<a class="dsh-btn-primary gv-primary" href="#tasks/${enc(g.display.taskId)}" data-gv-task-link="${enc(g.goalId)}">Answer the task</a>`;
      return '';
    },

    _gvDetailHtml(g, tab) {
      const d = g.display;
      const pinned = this._gvPrefs().pinned.includes(g.goalId);
      const menu = [];
      if (g.status === 'active') menu.push(`<button type="button" data-act="pause">Pause</button>`);
      if (d.action === 'answer') menu.push(`<button type="button" data-act="retry">Retry without answering</button>`);
      if (g.status === 'active' || g.status === 'paused') menu.push(`<button type="button" data-act="note">Add a note for the Achiever…</button>`);
      menu.push(`<button type="button" data-act="plan">Plan a phase…</button>`);
      menu.push(`<button type="button" data-act="pin">${pinned ? 'Unpin goal' : 'Pin to top'}</button>`);
      if (g.status !== 'achieved' && g.status !== 'blocked') menu.push(`<button type="button" data-act="block">Block…</button>`);
      menu.push(`<button type="button" data-act="delete" class="is-danger">Delete…</button>`);
      const tabs = TABS.map(([k, label]) => `<a role="tab" id="gv-tab-${k}" href="#goals/${enc(g.goalId)}/${k}" data-gv-tab="${k}" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" aria-controls="gv-pane">${label}</a>`).join('');
      const done = g.phases.filter(p => p.status === 'audited' || p.status === 'done').length;
      return `
        <div class="gv-detail-tabsbar">
          <button type="button" class="dsh-back-btn" id="gv-detail-back">${icon('arrow-left')}<span>Goals</span></button>
          <nav class="gv-tabs" role="tablist" aria-label="Goal sections">${tabs}</nav>
          <div class="gv-actions">
            ${this._gvPrimary(g)}
            <details class="gv-menu"><summary aria-label="More actions">${icon('ellipsis')}</summary><div class="gv-menu-body">${menu.join('')}</div></details>
          </div>
        </div>
        <div id="gv-inline-drawer" class="dsh-inline-drawer" hidden></div>
        <div class="dsh-detail-scroll">
          <header class="gv-detail-head">
            <h2 class="gv-title" tabindex="-1">${esc(g.title)}</h2>
            <div class="gv-state-line">${stateBadge(d.state)}<span>${nextLine(d)}</span></div>
          </header>
          <div class="gv-facts">
            <p><span class="gv-k">Done when</span> ${esc(g.successCriteria)}</p>
            ${g.nextMove ? `<p><span class="gv-k">Latest brief</span> ${esc(g.nextMove)}</p>` : ''}
            <div class="gv-progress">${segments(g.phases.map(p => ({ planned: 'p', active: 'a', completing: 'c' })[p.status] || 'd').join(''))}
              <span>${done}/${g.phases.length} phases</span><span>${g.progress.done}/${g.progress.total} tasks done</span><span>${g.budget.used}/${g.budget.cap} budget</span></div>
          </div>
          <div class="gv-pane" id="gv-pane" role="tabpanel" aria-labelledby="gv-tab-${tab}" data-pane="${tab}">${this._gvPane(g, tab)}</div>
        </div>`;
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
      if (g.status === 'blocked' && g.display.action === 'answer') {
        const opts = questionOptions(g.blockReason);
        const lead = opts.length ? questionLead(g.blockReason) : (g.blockReason || 'Held');
        out.push(`<section class="gv-block gv-question" aria-labelledby="gv-q-h">
          <h3 class="gv-q-h" id="gv-q-h">${icon('circle-alert')}<span>The goal is waiting for your answer</span></h3>
          <p class="gv-pre">${esc(lead)}</p>
          ${opts.length ? `<ol class="gv-q-opts">${opts.map(o => `<li><button type="button" class="gv-opt" data-act="answer" data-opt="${esc(o.key)}"><span class="gv-opt-key">${esc(o.key)}</span><span>${esc(o.text)}</span></button></li>`).join('')}</ol>` : ''}
          ${g.unblockCriteria ? `<p><span class="gv-k">Resumes when</span> ${esc(g.unblockCriteria)}</p>` : ''}
          <div class="gv-q-foot"><button type="button" class="dsh-btn-primary" data-act="answer">${icon('message-square-reply')}<span>${opts.length ? 'Answer in my own words' : 'Answer'}</span></button>
            ${g.nextRetryAt ? `<span class="gv-muted">Without an answer it re-asks ${timeTag(g.nextRetryAt)}${g.blockCount ? ` (asked ${g.blockCount} time${g.blockCount === 1 ? '' : 's'})` : ''}</span>` : ''}</div>
        </section>`);
      } else if (g.status === 'blocked') {
        out.push(`<div class="gv-block"><p><span class="gv-k">Held because</span> ${esc(g.blockReason || BLOCK_TEXT[g.blockCode] || 'Held')}</p>
          ${g.unblockCriteria ? `<p><span class="gv-k">Resumes when</span> ${esc(g.unblockCriteria)}</p>` : ''}
          ${g.nextRetryAt ? `<p><span class="gv-k">Auto-retry</span> ${timeTag(g.nextRetryAt)}${g.blockCount ? ` · attempt ${g.blockCount}` : ''}</p>` : ''}</div>`);
      }
      const answers = (g.operatorAnswers || []).slice().reverse();
      if (answers.length) out.push(`<details class="gv-more"${g.status === 'blocked' ? '' : ' open'}><summary>Your answers (${answers.length})</summary><ul class="gv-decisions">${answers.map(a => `<li><span class="gv-muted gv-dec-at">${esc(timeAgo(a.at))}</span><div class="gv-pre">${esc(a.answer)}</div></li>`).join('')}</ul></details>`);
      if (g.status === 'achieved' && g.closedReason) out.push(`<p><span class="gv-k">Closed</span> ${esc(g.closedReason)}</p>`);
      if (g.lastRejected) out.push(`<p><span class="gv-k">Last rejected move</span> ${esc(g.lastRejected.reason)}</p>`);
      if (g.description) out.push(`<details class="gv-more"><summary>Goal details</summary><p class="gv-pre">${esc(g.description)}</p></details>`);
      if (g.reportBrief) out.push(`<p><span class="gv-k">Report focus</span> ${esc(g.reportBrief)}</p>`);
      const open = (g.taskRows || []).filter(t => ['pending', 'claimed', 'in-progress', 'scheduled', 'wait-input'].includes(t.status));
      if (open.length) out.push(`<h3 class="gv-h">Open tasks</h3><ul class="gv-tasks">${open.map(t => this._gvTaskRow(t, g.goalId)).join('')}</ul>`);
      return out.join('') || '<p class="gv-muted">Nothing else to show yet.</p>';
    },

    _gvTaskRow(t, goalId) {
      return `<li><a href="#tasks/${enc(t.id)}" data-gv-task-link="${esc(goalId || '')}">${esc(t.title)}</a>
        <span class="gv-muted">${esc(t.status)}${t.scheduledAt && t.status === 'scheduled' ? ` · ${esc(fmtWhen(t.scheduledAt))}` : ''}${t.usage?.input !== undefined ? ` · ${fmtNum((t.usage.input || 0) + (t.usage.cacheRead || 0) + (t.usage.cacheWrite || 0) + (t.usage.output || 0))} tokens` : ''}</span></li>`;
    },

    _gvDoc(artifact, label) {
      const cut = artifact.indexOf('/');
      return `<a class="md-artifact gv-doc" href="/api/artifacts/${esc(artifact)}" data-md-task="${esc(artifact.slice(0, cut))}" data-md-file="${esc(artifact.slice(cut + 1))}" data-md-kind="artifacts">${icon('file-text')}<span>${esc(label)}</span></a>`;
    },

    _gvPhases(g) {
      const addBtn = g.status !== 'achieved' ? `<div style="margin-bottom:10px"><button type="button" class="dsh-btn-ghost" data-act="plan">${icon('plus')}<span>Add phase</span></button></div>` : '';
      if (!g.phases.length) return `${addBtn}<p class="gv-muted">No phases yet.</p>`;
      const rows = g.taskRows || [];
      const minutesFor = (key) => (g.minutes || []).filter(m => m.phaseKey === key).at(-1);
      return `${addBtn}<ol class="gv-stepper">${g.phases.map(p => {
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
            ${tasks.length ? `<ul class="gv-tasks">${tasks.map(t => this._gvTaskRow(t, g.goalId)).join('')}</ul>` : ''}
            ${docs ? `<div class="gv-docs">${docs}</div>` : ''}
          </details></li>`;
      }).join('')}</ol>`;
    },

    _gvDecisionRows(rows, goalId) {
      return rows.slice().reverse().map(h => {
        const text = h.kind === 'block' ? (h.reason || BLOCK_TEXT[h.code] || 'Held') : (h.reason || '');
        const label = { evaluate: h.met ? 'Criterion met' : 'Evaluated: not met', plan: 'Planned', emit: 'Created task', judge: 'Judger started', finish: 'Finished', block: 'Blocked', resume: 'Resumed', answer: 'You answered' }[h.kind] || h.kind;
        const count = h.count > 1 ? ` <span class="gv-count">${h.count} times since ${esc(new Date(h.firstAt || h.at).toLocaleString())}</span>` : '';
        const task = h.taskId ? ` <a href="#tasks/${enc(h.taskId)}" data-gv-task-link="${esc(goalId || '')}">task</a>` : '';
        return `<li><span class="gv-dec-kind">${esc(label)}</span>${h.phaseKey ? ` <span class="gv-muted">${esc(h.phaseKey)}</span>` : ''}${count}${task}
          <span class="gv-muted gv-dec-at">${esc(timeAgo(h.lastAt || h.at))}</span>${text ? `<div class="gv-dec-text">${esc(text)}</div>` : ''}</li>`;
      }).join('');
    },

    _gvDecisions(g) {
      if (!(g.history || []).length) return '<p class="gv-muted">No decisions yet.</p>';
      return `<ul class="gv-decisions" id="gv-decisions">${this._gvDecisionRows(g.history, g.goalId)}</ul>
        ${g.historyInJsonl ? `<button type="button" class="dsh-btn-ghost gv-load-history" data-act="history">Show full history</button>` : ''}`;
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
          <div class="gv-form-foot"><button type="submit" class="dsh-btn-primary" ${disabled}>Save</button><span class="gv-saved" id="gs-saved" role="status"></span></div>
        </form>
        <h3 class="gv-h">Token use</h3>
        <table class="gv-table"><thead><tr><th scope="col">Role</th><th scope="col">Tokens</th><th scope="col">Metered runs</th><th scope="col">Not metered</th></tr></thead>
          <tbody>${usageRow('Tasks', u.tasks)}${usageRow('Achiever turns', u.achiever)}</tbody></table>
        <p class="gv-hint">Runs from before telemetry, and agents that report nothing, show as not metered, never as zero. Id: <code>${esc(g.goalId)}</code></p>`;
    },

    _gvCloseDrawer() {
      const drawer = this.contentEl.querySelector('#gv-inline-drawer');
      if (!drawer) return;
      drawer.hidden = true;
      drawer.classList.remove('is-danger');
      drawer.innerHTML = '';
    },

    _gvOpenDrawer({ title, body, submit, danger = false, onSubmit, init }) {
      const drawer = this.contentEl.querySelector('#gv-inline-drawer');
      if (!drawer) return;
      drawer.hidden = false;
      drawer.classList.toggle('is-danger', danger);
      drawer.innerHTML = `<form id="gv-drawer-form" novalidate style="display:flex;flex-direction:column;gap:10px">
        <div class="dsh-inline-drawer-head">
          <h4 class="dsh-inline-drawer-title">${esc(title)}</h4>
          <button type="button" class="dsh-icon-btn" data-gv-drawer-close aria-label="Close">${icon('x')}</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">${body}</div>
        <p class="gv-error" data-drawer-error role="alert" hidden></p>
        <div class="dsh-inline-drawer-foot">
          <button type="button" class="dsh-btn-ghost" data-gv-drawer-close>Cancel</button>
          <button type="submit" class="${danger ? 'dsh-btn-ghost is-danger' : 'dsh-btn-primary'}" data-ok>${esc(submit)}</button>
        </div>
      </form>`;
      createIcons(drawer);
      drawer.querySelectorAll('[data-gv-drawer-close]').forEach(b => b.addEventListener('click', () => this._gvCloseDrawer()));
      drawer.querySelector('#gv-drawer-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = drawer.querySelector('[data-drawer-error]');
        errBox.hidden = true;
        const ok = drawer.querySelector('[data-ok]');
        try {
          const closeAfter = await busy(ok, () => onSubmit(drawer));
          if (closeAfter !== false) this._gvCloseDrawer();
        } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
      });
      init?.(drawer);
      return drawer;
    },

    _gvBindDetail(host, g) {
      const id = g.goalId;
      const post = (path) => this.api.post(`/goals/${enc(id)}/${path}`);
      const after = async (msg) => {
        const stEl = this.contentEl.querySelector('#gv-status');
        if (stEl) stEl.textContent = msg;
        await this._goalsRefresh();
        await this._gvLoadDetail({ quiet: false });
      };
      const guarded = (btn, fn) => busy(btn, fn).catch(e => this.toast('action failed', e.message));

      host.querySelector('#gv-detail-back')?.addEventListener('click', () => this._gvSelectGoal(null));

      // In-place tab switching (zero hashchange reload, zero /goals refetch!)
      const tabs = [...host.querySelectorAll('[role="tab"][data-gv-tab]')];
      tabs.forEach((t, i) => {
        t.addEventListener('click', (e) => {
          e.preventDefault();
          this._gvSelectGoal(id, t.dataset.gvTab);
        });
        t.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          this._gvSelectGoal(id, next.dataset.gvTab);
          setTimeout(() => this.contentEl.querySelector(`#${next.id}`)?.focus(), 0);
        });
      });

      // Cross-workspace task links remember which goal you came from
      host.querySelectorAll('[data-gv-task-link]').forEach(a => a.addEventListener('click', () => {
        this._fromGoalId = id;
      }));

      host.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        btn.closest('details.gv-menu')?.removeAttribute('open');
        if (act === 'retry') return guarded(btn, async () => { await post('activate'); await after('Retrying now.'); });
        if (act === 'activate') return guarded(btn, async () => { await post('activate'); await after('Goal is active.'); });
        if (act === 'pause') return guarded(btn, async () => { await post('pause'); await after('Goal paused.'); });
        if (act === 'raise') { this._gvSelectGoal(id, 'settings'); return null; }
        if (act === 'pin') { this._gvTogglePin(id); this._gvRenderDetailInto(host, g, this._gv.tab); return null; }
        if (act === 'answer') return this._gvAnswerDrawer(g, after, btn.dataset.opt);
        if (act === 'note') return this._gvAnswerDrawer(g, after, undefined, true);
        if (act === 'plan') return this._gvPlanDrawer(g, after);
        if (act === 'block') return this._gvBlockDrawer(g, after);
        if (act === 'delete') return this._gvDeleteDrawer(g);
        if (act === 'history') {
          return guarded(btn, async () => {
            const rows = await this.api.get(`/goals/${enc(id)}/history`);
            host.querySelector('#gv-decisions').innerHTML = this._gvDecisionRows(rows, id);
            btn.remove();
          });
        }
        return null;
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

    _gvBlockDrawer(g, after) {
      this._gvOpenDrawer({
        title: `Block "${g.title}"`,
        submit: 'Block goal',
        body: `${field('gb-reason', 'What is the obstacle?', '<input id="gb-reason">')}
          ${field('gb-resume', 'It can resume when…', '<input id="gb-resume">', 'A condition someone could check.')}
          <div class="gv-grid2">
            ${field('gb-type', 'Automatic check (optional)', `<select id="gb-type"><option value="">None</option><option value="after-time">After a time</option><option value="file-exists">A file exists</option><option value="http-200">A public URL returns 200</option><option value="agent-available">An agent has quota</option></select>`)}
            ${field('gb-value', 'Check value', '<input id="gb-value" placeholder="Time, path, URL or agent id">')}
          </div>`,
        init: (d) => d.querySelector('#gb-reason')?.focus(),
        onSubmit: async (d) => {
          const reason = d.querySelector('#gb-reason').value.trim();
          setFieldError(d, 'gb-reason', reason ? '' : 'Say what is stopping this goal.');
          if (!reason) { d.querySelector('#gb-reason').focus(); return false; }
          const type = d.querySelector('#gb-type').value;
          const value = d.querySelector('#gb-value').value.trim();
          setFieldError(d, 'gb-value', type && !value ? 'Enter what to check.' : '');
          if (type && !value) { d.querySelector('#gb-value').focus(); return false; }
          await this.api.post(`/goals/${enc(g.goalId)}/block`, {
            reason, unblockCriteria: d.querySelector('#gb-resume').value.trim() || undefined,
            ...(type ? { unblockCheck: { type, value } } : {})
          });
          await after('Goal blocked.');
          return true;
        }
      });
    },

    _gvAnswerDrawer(g, after, pick, note = false) {
      const opts = note ? [] : questionOptions(g.blockReason);
      const chosen = opts.find(o => o.key === pick);
      const quick = !note && !opts.length
        ? [['yes', 'Yes, approved. Go ahead.'], ['no', 'No, not approved. Do not do it; find another way or reduce the scope.']]
        : [];
      const chips = [...opts.map(o => [o.key, `(${o.key}) ${o.text}`]), ...quick];
      this._gvOpenDrawer({
        title: note ? 'Note for the Achiever' : 'Answer the goal',
        submit: note ? 'Save note' : 'Send answer and resume',
        body: `${note ? '' : `<div class="gv-q-text gv-pre">${esc(g.blockReason || g.unblockCriteria || 'The goal is held.')}</div>`}
          ${chips.length ? `<div class="gv-opts" role="group" aria-label="Quick answers">${chips.map(([k, t]) =>
            `<button type="button" class="gv-opt" data-fill="${esc(t)}" aria-pressed="${chosen && k === chosen.key}"><span class="gv-opt-key">${esc(k)}</span><span>${esc(t.replace(/^\([a-f]\)\s*/, ''))}</span></button>`).join('')}</div>` : ''}
          ${field('ga-answer', note ? 'Your note' : 'Your answer', `<textarea id="ga-answer" rows="4" placeholder="${note ? 'e.g. Focus on Mastodon first.' : 'Pick a choice above and add details, or write your own answer.'}"></textarea>`,
            note ? 'The Achiever reads it on every turn from now on.' : 'The Achiever reads this on its next turn and keeps it as a standing decision. The goal resumes right away.')}`,
        init: (d) => {
          const ta = d.querySelector('#ga-answer');
          if (chosen) ta.value = `(${chosen.key}) ${chosen.text}`;
          d.querySelectorAll('[data-fill]').forEach(b => b.addEventListener('click', () => {
            d.querySelectorAll('[data-fill]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            ta.value = b.dataset.fill;
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          }));
          setTimeout(() => ta.focus(), 0);
        },
        onSubmit: async (d) => {
          const answer = d.querySelector('#ga-answer').value.trim();
          setFieldError(d, 'ga-answer', answer ? '' : (note ? 'Write the note.' : 'Pick a choice or write an answer.'));
          if (!answer) { d.querySelector('#ga-answer').focus(); return false; }
          await this.api.post(`/goals/${enc(g.goalId)}/answer`, { answer });
          await after(note ? 'Note saved.' : 'Answer sent. The goal is running again.');
          return true;
        }
      });
    },

    _gvPlanDrawer(g, after) {
      this._gvOpenDrawer({
        title: 'Plan the next phase',
        submit: 'Add phase',
        body: `${field('gp-title', 'What should this phase do?', '<input id="gp-title">', 'Make it concrete work with a result the Judger can check.')}`,
        init: (d) => d.querySelector('#gp-title')?.focus(),
        onSubmit: async (d) => {
          const title = d.querySelector('#gp-title').value.trim();
          setFieldError(d, 'gp-title', title ? '' : 'Describe the phase.');
          if (!title) { d.querySelector('#gp-title').focus(); return false; }
          const seen = new Set(g.phases.map(p => p.key));
          await this.api.patch(`/goals/${enc(g.goalId)}`, { phases: [{ key: deriveKey(title, g.phases.length, seen), title }] });
          if (g.status === 'blocked') await this.api.post(`/goals/${enc(g.goalId)}/activate`);
          await after('Phase added.');
          return true;
        }
      });
    },

    _gvDeleteDrawer(g) {
      const n = (g.taskRows || []).length;
      this._gvOpenDrawer({
        title: `Delete "${g.title}"?`,
        submit: 'Delete goal',
        danger: true,
        body: `<p style="margin:0;font-size:13px;color:var(--dsw-label-secondary)">This removes the goal${n ? ` and its ${n} task${n === 1 ? '' : 's'}` : ''} immediately. It cannot be undone.</p>
          ${n ? `<label class="gv-check"><input type="checkbox" id="gd-keep"> Keep the ${n} task${n === 1 ? '' : 's'}</label>` : ''}`,
        onSubmit: async (d) => {
          const keep = d.querySelector('#gd-keep')?.checked;
          await this.api.del(`/goals/${enc(g.goalId)}${keep ? '' : '?withTasks=1'}`);
          this.toast('goal deleted', g.title);
          this._gvCloseDrawer();
          await this._goalsRefresh();
          await this._gvSelectGoal(this._gv.list[0]?.goalId || null);
          return false;
        }
      });
    },

    // ── Inline Create inside #gv-detail (keeps Goals list visible on left!) ──

    _gvOpenCreateInline({ fromHash = false } = {}) {
      const st = this._gv;
      const root = this.contentEl.querySelector('.gv[data-page="list"]');
      const detailHost = root?.querySelector('#gv-detail');
      if (!st || !root || !detailHost) return;

      st.creating = true;
      root.dataset.mode = 'detail';
      detailHost.classList.remove('is-empty');
      root.querySelectorAll('.gv-row.is-selected').forEach(el => {
        el.classList.remove('is-selected');
        el.removeAttribute('aria-current');
      });
      if (!fromHash && window.location.hash !== '#goals/new') {
        history.replaceState(null, '', '#goals/new');
      }

      detailHost.innerHTML = `
        <div class="dsh-detail-bar">
          <div class="dsh-detail-bar-left">
            <button type="button" class="dsh-back-btn" id="gv-create-back">${icon('arrow-left')}<span>Goals</span></button>
            <span style="font-size:13.5px;font-weight:600;color:var(--dsw-label-primary)">New goal</span>
          </div>
          <div class="dsh-detail-bar-actions">
            <button type="button" class="dsh-btn-ghost" id="gv-create-cancel">Cancel</button>
          </div>
        </div>
        <div class="gv-create-wrap"><div class="gv-create">
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
              <button type="submit" class="dsh-btn-primary" data-activate="1">Create and activate</button>
              <button type="submit" class="dsh-btn-ghost" data-activate="">Save as draft</button>
              <span class="gv-saved" id="gc-saved" role="alert"></span>
            </div>
          </form>
        </div></div>`;
      createIcons(detailHost);

      const cancelCreate = () => {
        st.creating = false;
        const fallbackId = st.lastSelected && st.list.some(g => g.goalId === st.lastSelected)
          ? st.lastSelected
          : (window.innerWidth > 960 ? (st.list[0]?.goalId || null) : null);
        this._gvSelectGoal(fallbackId, st.tab || 'overview');
      };
      detailHost.querySelector('#gv-create-back')?.addEventListener('click', cancelCreate);
      detailHost.querySelector('#gv-create-cancel')?.addEventListener('click', cancelCreate);

      const cRoot = detailHost.querySelector('.gv-create');
      const q = (id) => cRoot.querySelector(`#${id}`);
      q('gc-title')?.focus();

      let loop = '';
      const preview = () => {
        const phases = parsePhases(q('gc-phases').value);
        const crit = q('gc-criteria').value.trim();
        q('gc-warn').hidden = !crit || looksYesNo(crit);
        const budget = parseInt(q('gc-budget').value, 10) || 24;
        q('gc-preview').textContent = `Preview: ${phases.length} phase${phases.length === 1 ? '' : 's'}, budget of ${budget} tasks${loop ? `, ${loop} goal` : ''}. It keeps running until the answer is Yes.`;
      };
      cRoot.addEventListener('input', preview);
      preview();

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
        Object.entries(errs).forEach(([k, v]) => setFieldError(cRoot, k, v));
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
            try { await this.api.post(`/goals/${enc(id)}/activate`); this.toast('goal activated', body.title); }
            catch (err) { this.toast('saved as draft', `Created, but could not activate: ${err.message}`); }
          } else this.toast('goal created', `${body.title}, saved as a draft.`);
          st.creating = false;
          await this._goalsRefresh();
          await this._gvSelectGoal(id, 'overview');
        }, 'Creating…');
      });
    }
  });
})();
