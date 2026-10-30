/**
 * Configuration page (#config) — a form editor for config.json, no raw JSON typing.
 *
 * Data: GET /api/config (apiKey masked as "***"), PUT /api/config (writes the live
 * config, then the server exits so systemd restarts it on the new file).
 *
 * The form is derived from the config's own shape, so new keys show up without
 * code changes:
 *   boolean → switch · number → number field (…Ms keys get a "= 30 min" hint)
 *   "#rrggbb" → colour picker · brain id → brain picker · list of brain ids →
 *   drag-to-reorder chain · other lists → chip editor · objects → collapsible
 *   groups · map-like objects (brains, services, …) → cards with "Add" / "Remove"
 *   · `_comment` keys → help text.
 * Edits go to a working copy; a sticky bar counts changes and opens a review of
 * every changed path before saving. Raw JSON stays reachable under "Advanced".
 *
 * Loaded after app.js; overrides App.prototype.renderConfig.
 */
(function () {
  const SECTION_META = {
    server: ['server', 'Server', 'Port, TLS, auth and CORS for the hub itself.'],
    paths: ['folder-tree', 'Paths', 'Where tasks, artifacts, inputs, workflows and goals live on disk.'],
    platforms: ['layers', 'Platforms', 'Agent platforms whose skills/agents are imported into the roster.'],
    services: ['layout-grid', 'Services', 'Self-hosted web services shown on the Portal page.'],
    obsidian: ['notebook', 'Obsidian', 'Vault integration.'],
    inbox: ['inbox', 'Inbox', 'Task retention and retry policy.'],
    orchestration: ['bot', 'Orchestration', 'Dispatcher, brains, routing chains, verifier and quality gates.'],
  };
  // Map-like objects: every child is an entry of the same shape (add/remove entries).
  const MAP_PATHS = new Set(['platforms', 'services', 'orchestration.brains', 'orchestration.agents',
    'orchestration.roles', 'orchestration.divisionChains', 'orchestration.agentChains', 'orchestration.tiers',
    'orchestration.methods.cards', 'orchestration.verifier.spec.judges']);
  const ACRONYMS = { url: 'URL', api: 'API', tls: 'TLS', cors: 'CORS', id: 'ID', llm: 'LLM', ms: 'ms', mcp: 'MCP', cpu: 'CPU', gpu: 'GPU' };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const pathKey = (parts) => parts.join('.');
  const getAt = (o, parts) => parts.reduce((a, k) => (a == null ? undefined : a[k]), o);
  function setAt(o, parts, v) {
    let cur = o;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = v;
  }
  function deleteAt(o, parts) {
    const parent = getAt(o, parts.slice(0, -1));
    if (Array.isArray(parent)) parent.splice(Number(parts[parts.length - 1]), 1);
    else if (parent) delete parent[parts[parts.length - 1]];
  }
  function humanize(key) {
    if (/^\d+$/.test(key)) return `#${Number(key) + 1}`;
    const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().split(/\s+/);
    const out = words.map((w) => ACRONYMS[w.toLowerCase()] || w.toLowerCase());
    if (out[out.length - 1] === 'ms') out.pop();
    const s = out.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function durationHint(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${+s.toFixed(1)} s`;
    if (s < 3600) return `${+(s / 60).toFixed(1)} min`;
    if (s < 86400) return `${+(s / 3600).toFixed(1)} h`;
    return `${+(s / 86400).toFixed(1)} d`;
  }
  const fmtVal = (v) => (v === undefined ? '∅ (removed)' : typeof v === 'string' ? v : JSON.stringify(v));

  /** Flat path → value list of leaves (arrays count as one leaf) — used for diffing. */
  function leaves(o, parts = [], out = new Map()) {
    if (isObj(o) && Object.keys(o).length) { for (const k of Object.keys(o)) leaves(o[k], [...parts, k], out); }
    else out.set(pathKey(parts), o);
    return out;
  }
  function diff(a, b) {
    const la = leaves(a), lb = leaves(b), keys = new Set([...la.keys(), ...lb.keys()]), out = [];
    for (const k of keys) {
      const x = la.get(k), y = lb.get(k);
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: k, from: x, to: y });
    }
    return out;
  }

  Object.assign(App.prototype, {
    async renderConfig() {
      let config;
      try { config = await this.api.get('/config'); } catch (e) {
        this.contentEl.innerHTML = `<div class="card">Could not load config: ${esc(e.message)}</div>`;
        return;
      }
      // Keep unsaved edits across SSE-driven re-renders of this view.
      const st = this._cfg;
      if (!st || !st.dirty) this._cfg = { orig: config, work: clone(config), section: st?.section || 'orchestration', query: st?.query || '', open: st?.open || new Set(), dirty: false };
      const s = this._cfg;
      if (!(s.section in s.work)) s.section = Object.keys(s.work)[0];
      this._cfgIndexValues();

      this.contentEl.innerHTML = `
        <div class="cfg">
          <aside class="cfg-nav">
            <label class="cfg-search">
              <i data-lucide="search"></i>
              <input id="cfg-q" type="search" placeholder="Search settings…" value="${esc(s.query)}" autocomplete="off">
            </label>
            <nav id="cfg-sections" aria-label="Config sections"></nav>
            <button class="cfg-adv-btn" id="cfg-raw" type="button"><i data-lucide="code-2"></i> Advanced: raw JSON</button>
          </aside>
          <section class="cfg-main" id="cfg-main"></section>
          <div class="cfg-savebar" id="cfg-savebar" hidden>
            <span id="cfg-count"></span>
            <button class="btn" id="cfg-discard" type="button">Discard</button>
            <button class="btn btn-primary" id="cfg-review" type="button">Review &amp; save</button>
          </div>
        </div>`;
      const q = this.contentEl.querySelector('#cfg-q');
      q.addEventListener('input', () => { s.query = q.value.trim(); this._cfgRenderNav(); this._cfgRenderMain(); });
      this.contentEl.querySelector('#cfg-discard').onclick = () => { s.work = clone(s.orig); s.dirty = false; this._cfgIndexValues(); this._cfgRenderMain(); this._cfgSync(); };
      this.contentEl.querySelector('#cfg-review').onclick = () => this._cfgReview();
      this.contentEl.querySelector('#cfg-raw').onclick = () => this._cfgRaw();
      this._cfgRenderNav();
      this._cfgRenderMain();
      this._cfgSync();
    },

    /** Brain ids + every value seen per key name (suggestions for free-text fields). */
    _cfgIndexValues() {
      const s = this._cfg;
      s.brains = Object.keys(s.work.orchestration?.brains || {});
      s.seen = new Map();
      const walk = (o, key) => {
        if (Array.isArray(o)) return o.forEach((x) => walk(x, key));
        if (isObj(o)) return Object.entries(o).forEach(([k, v]) => walk(v, k));
        if (typeof o === 'string' && key && o.length < 60 && !s.brains.includes(o)) {
          if (!s.seen.has(key)) s.seen.set(key, new Set());
          s.seen.get(key).add(o);
        }
      };
      walk(s.work, '');
    },

    _cfgRenderNav() {
      const s = this._cfg, nav = this.contentEl.querySelector('#cfg-sections');
      const changed = new Set(diff(s.orig, s.work).map((d) => d.path.split('.')[0]));
      nav.innerHTML = Object.keys(s.work).map((k) => {
        const [icon, label] = SECTION_META[k] || ['settings-2', humanize(k)];
        const hits = s.query ? this._cfgMatches([k]) : -1;
        if (s.query && !hits) return '';
        return `<button type="button" class="cfg-sec${k === s.section && !s.query ? ' active' : ''}" data-sec="${esc(k)}">
          <i data-lucide="${icon}"></i><span>${esc(label)}</span>
          ${s.query ? `<span class="cfg-hits">${hits}</span>` : changed.has(k) ? '<span class="cfg-dot" title="Unsaved changes"></span>' : ''}
        </button>`;
      }).join('') || '<div class="cfg-empty-nav">No matches</div>';
      nav.querySelectorAll('[data-sec]').forEach((b) => b.onclick = () => {
        s.section = b.dataset.sec; s.query = ''; this.contentEl.querySelector('#cfg-q').value = '';
        this._cfgRenderNav(); this._cfgRenderMain(); this.contentEl.querySelector('#cfg-main').scrollTop = 0;
      });
      if (window.lucide) window.lucide.createIcons();
    },

    /** Number of leaf settings under `parts` whose path/label/value matches the search. */
    _cfgMatches(parts) {
      const q = this._cfg.query.toLowerCase();
      let n = 0;
      for (const [p, v] of leaves(getAt(this._cfg.work, parts), parts)) {
        const hay = `${p} ${p.split('.').map(humanize).join(' ')} ${typeof v === 'string' ? v : ''}`.toLowerCase();
        if (hay.includes(q)) n++;
      }
      return n;
    },

    _cfgRenderMain() {
      const s = this._cfg, main = this.contentEl.querySelector('#cfg-main');
      const secs = s.query ? Object.keys(s.work).filter((k) => this._cfgMatches([k])) : [s.section];
      main.innerHTML = secs.map((k) => {
        const [icon, label, desc] = SECTION_META[k] || ['settings-2', humanize(k), ''];
        const v = s.work[k];
        return `<div class="cfg-section">
          <header class="cfg-head"><i data-lucide="${icon}"></i><div><h3>${esc(label)}</h3>${desc ? `<p>${esc(desc)}</p>` : ''}</div></header>
          ${isObj(v) ? this._cfgObject(v, [k], 0) : `<div class="cfg-group">${this._cfgField(k, v, [k])}</div>`}
        </div>`;
      }).join('') || '<div class="cfg-empty">No settings match “' + esc(s.query) + '”.</div>';
      if (window.lucide) window.lucide.createIcons();
      this._cfgBind(main);
    },

    /** Render an object: scalars first as a field grid, then nested objects as collapsible groups. */
    _cfgObject(obj, parts, depth) {
      const s = this._cfg, pk = pathKey(parts), isMap = MAP_PATHS.has(pk);
      const keys = Object.keys(obj).filter((k) => !s.query || k.startsWith('_') || this._cfgMatches([...parts, k]));
      const notes = keys.filter((k) => k.startsWith('_') && typeof obj[k] === 'string')
        .map((k) => `<p class="cfg-note"><i data-lucide="info"></i>${esc(obj[k])}</p>`).join('');
      const flat = keys.filter((k) => !k.startsWith('_') && !isObj(obj[k]));
      const nested = keys.filter((k) => !k.startsWith('_') && isObj(obj[k]));
      let html = notes;
      if (flat.length) html += `<div class="cfg-group">${flat.map((k) => this._cfgField(k, obj[k], [...parts, k])).join('')}</div>`;
      for (const k of nested) {
        const cp = [...parts, k], ck = pathKey(cp), v = obj[k];
        const open = s.query || s.open.has(ck) || (depth === 0 && !isMap && Object.keys(v).length <= 6);
        const summary = isMap ? this._cfgEntrySummary(v) : `${Object.keys(v).filter((x) => !x.startsWith('_')).length} settings`;
        const enabled = typeof v.enabled === 'boolean' ? `<span class="cfg-pill ${v.enabled ? 'on' : 'off'}">${v.enabled ? 'on' : 'off'}</span>` : '';
        html += `<details class="cfg-box${isMap ? ' cfg-entry' : ''}" data-open="${esc(ck)}" ${open ? 'open' : ''}>
          <summary><i data-lucide="chevron-right" class="cfg-caret"></i><span class="cfg-box-title">${esc(isMap ? k : humanize(k))}</span>${enabled}<span class="cfg-box-sum">${esc(summary)}</span>
            ${isMap ? `<button type="button" class="cfg-icon-btn" data-del="${esc(ck)}" title="Remove ${esc(k)}" aria-label="Remove ${esc(k)}"><i data-lucide="trash-2"></i></button>` : ''}
          </summary>
          <div class="cfg-box-body">${this._cfgObject(v, cp, depth + 1)}</div>
        </details>`;
      }
      if (isMap && !s.query) html += `<button type="button" class="cfg-add" data-addkey="${esc(pk)}"><i data-lucide="plus"></i> Add ${esc(humanize(parts[parts.length - 1]).toLowerCase().replace(/s$/, ''))}</button>`;
      if (!flat.length && !nested.length && !notes) html += `<div class="cfg-empty-inline">Empty${isMap ? ' — add one below' : ''}.</div>`;
      return html;
    },

    _cfgEntrySummary(v) {
      if (!isObj(v)) return '';
      return [v.exec, v.model, v.label, v.url, v.description].filter((x) => typeof x === 'string' && x).slice(0, 2).join(' · ');
    },

    _cfgField(key, v, parts) {
      const s = this._cfg, pk = pathKey(parts), label = humanize(key);
      const changed = JSON.stringify(getAt(s.orig, parts)) !== JSON.stringify(v);
      const id = 'cf-' + pk.replace(/[^a-zA-Z0-9]/g, '_');
      let control, hint = '';
      if (typeof v === 'boolean') {
        control = `<label class="cfg-switch"><input type="checkbox" id="${id}" data-path="${esc(pk)}" data-kind="bool" ${v ? 'checked' : ''}><span></span></label>`;
      } else if (typeof v === 'number') {
        if (/Ms$/.test(key)) hint = durationHint(v);
        control = `<input class="cfg-input cfg-num" type="number" id="${id}" data-path="${esc(pk)}" data-kind="num" value="${v}" step="any">`;
      } else if (Array.isArray(v)) {
        return `<div class="cfg-row cfg-row-wide${changed ? ' changed' : ''}"><label class="cfg-label">${esc(label)}</label>${this._cfgList(v, parts)}</div>`;
      } else if (key === 'apiKey') {
        control = `<input class="cfg-input" type="password" id="${id}" data-path="${esc(pk)}" data-kind="str" value="${esc(v ?? '')}" placeholder="not set" autocomplete="new-password">`;
        hint = v === '***' ? 'set — leave as is to keep' : '';
      } else if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) {
        control = `<span class="cfg-color"><input type="color" data-path="${esc(pk)}" data-kind="str" value="${esc(v)}"><input class="cfg-input" id="${id}" data-path="${esc(pk)}" data-kind="str" value="${esc(v)}"></span>`;
      } else if (typeof v === 'string' && s.brains.includes(v) || /(^brain$|Brain$)/.test(key) && typeof v === 'string') {
        control = this._cfgBrainSelect(v, `id="${id}" data-path="${esc(pk)}" data-kind="str"`);
      } else if (typeof v === 'string' && v.length > 90) {
        control = `<textarea class="cfg-input cfg-area" id="${id}" data-path="${esc(pk)}" data-kind="str" rows="3">${esc(v)}</textarea>`;
      } else {
        const sugg = [...(s.seen.get(key) || [])].filter((x) => x !== v);
        const list = sugg.length && sugg.length <= 12 ? `cfg-dl-${id}` : '';
        control = `<input class="cfg-input${/(Dir|File|Path|^paths\.)/.test(key) || pk.startsWith('paths.') ? ' mono' : ''}" id="${id}" data-path="${esc(pk)}" data-kind="${v === null ? 'nullable' : 'str'}" value="${esc(v ?? '')}" ${v === null ? 'placeholder="not set"' : ''} ${list ? `list="${list}"` : ''}>`
          + (list ? `<datalist id="${list}">${sugg.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : '');
      }
      return `<div class="cfg-row${changed ? ' changed' : ''}">
        <label class="cfg-label" for="${id}">${esc(label)}${changed ? '<span class="cfg-dot"></span>' : ''}</label>
        <div class="cfg-control">${control}${hint ? `<span class="cfg-hint">${esc(hint)}</span>` : ''}</div>
      </div>`;
    },

    _cfgBrainSelect(v, attrs) {
      const opts = this._cfg.brains.includes(v) || !v ? this._cfg.brains : [v, ...this._cfg.brains];
      return `<select class="cfg-input" ${attrs}>${v ? '' : '<option value="">— none —</option>'}${opts.map((b) => `<option ${b === v ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>`;
    },

    /** Lists: brain chains (ordered, drag to reorder), primitive chips, or object cards. */
    _cfgList(arr, parts) {
      const s = this._cfg, pk = pathKey(parts);
      if (arr.some(isObj)) {
        return `<div class="cfg-objlist">${arr.map((o, i) => `<details class="cfg-box cfg-entry"><summary><i data-lucide="chevron-right" class="cfg-caret"></i><span class="cfg-box-title">#${i + 1}</span><span class="cfg-box-sum">${esc(this._cfgEntrySummary(o))}</span>
          <button type="button" class="cfg-icon-btn" data-del="${esc(pk + '.' + i)}" title="Remove"><i data-lucide="trash-2"></i></button></summary>
          <div class="cfg-box-body">${isObj(o) ? this._cfgObject(o, [...parts, String(i)], 2) : ''}</div></details>`).join('')}
          <button type="button" class="cfg-add" data-addlist="${esc(pk)}"><i data-lucide="plus"></i> Add item</button></div>`;
      }
      const isChain = arr.length ? arr.every((x) => s.brains.includes(x)) : /(chain|brains|judges|^\d+$)/i.test(parts[parts.length - 1]) || MAP_PATHS.has(pathKey(parts.slice(0, -1))) && /chain|tiers|judges/i.test(pathKey(parts));
      const chips = arr.map((x, i) => `<span class="cfg-chip${isChain ? ' chain' : ''}" ${isChain ? 'draggable="true"' : ''} data-list="${esc(pk)}" data-idx="${i}">
          ${isChain ? `<span class="cfg-chip-n">${i + 1}</span>` : ''}${esc(typeof x === 'string' ? x : JSON.stringify(x))}
          <button type="button" data-chipdel="${esc(pk)}" data-idx="${i}" aria-label="Remove ${esc(String(x))}">×</button></span>`).join('');
      const adder = isChain
        ? `<select class="cfg-input cfg-chip-add" data-chipadd="${esc(pk)}"><option value="">＋ add brain…</option>${s.brains.filter((b) => !arr.includes(b)).map((b) => `<option>${esc(b)}</option>`).join('')}</select>`
        : `<input class="cfg-input cfg-chip-add" data-chipadd="${esc(pk)}" data-num="${arr.length && arr.every((x) => typeof x === 'number') ? 1 : ''}" placeholder="＋ add, press Enter">`;
      return `<div class="cfg-chips${isChain ? ' is-chain' : ''}" data-chips="${esc(pk)}">${chips || '<span class="cfg-empty-inline">empty</span>'}${adder}</div>${isChain && arr.length > 1 ? '<span class="cfg-hint">Tried in order — drag to reorder.</span>' : ''}`;
    },

    _cfgSet(parts, value, { rerender = false } = {}) {
      const s = this._cfg;
      setAt(s.work, parts, value);
      s.dirty = diff(s.orig, s.work).length > 0;
      if (rerender) this._cfgRenderMain();
      this._cfgSync();
    },

    _cfgSync() {
      const n = diff(this._cfg.orig, this._cfg.work).length;
      const bar = this.contentEl.querySelector('#cfg-savebar');
      if (!bar) return;
      bar.hidden = !n;
      this.contentEl.querySelector('#cfg-count').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
      this._cfgRenderNav();
    },

    _cfgBind(root) {
      const s = this._cfg, P = (el, attr = 'path') => el.dataset[attr].split('.');
      root.querySelectorAll('[data-kind]').forEach((el) => {
        const ev = el.dataset.kind === 'bool' || el.tagName === 'SELECT' || el.type === 'color' ? 'change' : 'input';
        el.addEventListener(ev, () => {
          const k = el.dataset.kind;
          let v = k === 'bool' ? el.checked : el.value;
          if (k === 'num') { if (el.value === '') return; v = Number(el.value); const h = el.parentElement.querySelector('.cfg-hint'); if (h) h.textContent = durationHint(v); }
          if (k === 'nullable' && v === '') v = null;
          // Colour picker and its text twin mirror each other.
          root.querySelectorAll(`[data-path="${CSS.escape(el.dataset.path)}"]`).forEach((o) => { if (o !== el && o.type !== 'checkbox') o.value = v ?? ''; });
          const row = el.closest('.cfg-row');
          this._cfgSet(P(el), v);
          if (row) row.classList.toggle('changed', JSON.stringify(getAt(s.orig, P(el))) !== JSON.stringify(v));
        });
      });
      root.querySelectorAll('details[data-open]').forEach((d) => d.addEventListener('toggle', () => {
        d.open ? s.open.add(d.dataset.open) : s.open.delete(d.dataset.open);
      }));
      root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const parts = P(b, 'del');
        if (!confirm(`Remove "${parts[parts.length - 1]}"? (Not saved until you press Save.)`)) return;
        deleteAt(s.work, parts); this._cfgIndexValues();
        s.dirty = diff(s.orig, s.work).length > 0; this._cfgRenderMain(); this._cfgSync();
      }));
      root.querySelectorAll('[data-addkey]').forEach((b) => b.addEventListener('click', () => {
        const parts = P(b, 'addkey'), map = getAt(s.work, parts);
        const name = (prompt('Name for the new entry (letters, digits, - . _):') || '').trim();
        if (!name) return;
        if (!/^[\w.-]+$/.test(name) || name.includes('.')) return this.toast('Invalid name', 'Use letters, digits, - and _ only.');
        if (Object.hasOwn(map, name)) return this.toast('Already exists', name);
        const proto = Object.values(map).find(isObj) ?? Object.values(map)[0];
        map[name] = this._cfgBlank(proto);
        s.open.add(pathKey([...parts, name]));
        this._cfgIndexValues(); this._cfgSet(parts, map, { rerender: true });
      }));
      root.querySelectorAll('[data-addlist]').forEach((b) => b.addEventListener('click', () => {
        const parts = P(b, 'addlist'), arr = getAt(s.work, parts);
        arr.push(this._cfgBlank(arr.find(isObj) || {}));
        this._cfgSet(parts, arr, { rerender: true });
      }));
      root.querySelectorAll('[data-chipdel]').forEach((b) => b.addEventListener('click', () => {
        const parts = P(b, 'chipdel'), arr = getAt(s.work, parts).slice();
        arr.splice(Number(b.dataset.idx), 1);
        this._cfgSet(parts, arr, { rerender: true });
      }));
      root.querySelectorAll('[data-chipadd]').forEach((el) => {
        const add = () => {
          const raw = el.value.trim(); if (!raw) return;
          const parts = P(el, 'chipadd');
          this._cfgSet(parts, [...getAt(s.work, parts), el.dataset.num ? Number(raw) : raw], { rerender: true });
          root.ownerDocument.querySelector(`[data-chipadd="${CSS.escape(el.dataset.chipadd)}"]`)?.focus();
        };
        if (el.tagName === 'SELECT') el.addEventListener('change', add);
        else el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      });
      // Drag-to-reorder for brain chains.
      let drag = null;
      root.querySelectorAll('.cfg-chip.chain').forEach((c) => {
        c.addEventListener('dragstart', (e) => { drag = c; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        c.addEventListener('dragend', () => { c.classList.remove('dragging'); drag = null; });
        c.addEventListener('dragover', (e) => { if (drag && drag.dataset.list === c.dataset.list) e.preventDefault(); });
        c.addEventListener('drop', (e) => {
          e.preventDefault();
          if (!drag || drag === c || drag.dataset.list !== c.dataset.list) return;
          const parts = c.dataset.list.split('.'), arr = getAt(s.work, parts).slice();
          const [m] = arr.splice(Number(drag.dataset.idx), 1);
          arr.splice(Number(c.dataset.idx), 0, m);
          this._cfgSet(parts, arr, { rerender: true });
        });
      });
    },

    /** Same shape as `proto`, values blanked (booleans false, numbers 0, lists empty). */
    _cfgBlank(proto) {
      if (Array.isArray(proto)) return [];
      if (isObj(proto)) return Object.fromEntries(Object.entries(proto).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, this._cfgBlank(v)]));
      if (typeof proto === 'boolean') return true;
      if (typeof proto === 'number') return 0;
      if (typeof proto === 'string') return '';
      return '';
    },

    _cfgModal(html) {
      const container = document.getElementById('modal-container'), content = document.getElementById('modal-content');
      content.innerHTML = html;
      container.classList.remove('hidden');
      const close = () => container.classList.add('hidden');
      container.querySelector('.modal-backdrop').onclick = close;
      if (window.lucide) window.lucide.createIcons();
      return { content, close };
    },

    _cfgReview() {
      const s = this._cfg, changes = diff(s.orig, s.work);
      const { content, close } = this._cfgModal(`
        <div class="cfg-modal">
          <h3>Review ${changes.length} change${changes.length === 1 ? '' : 's'}</h3>
          <p class="cfg-modal-sub">Saving writes the live config and restarts the Cowork server (a few seconds; running tasks are re-claimed).</p>
          <ul class="cfg-diff">${changes.map((c) => `<li><code>${esc(c.path)}</code>
            <div><span class="cfg-from">${esc(fmtVal(c.from))}</span><i data-lucide="arrow-right"></i><span class="cfg-to">${esc(fmtVal(c.to))}</span></div></li>`).join('')}</ul>
          <div class="cfg-modal-actions"><button class="btn" id="cfg-cancel">Keep editing</button><button class="btn btn-primary" id="cfg-save">Save &amp; restart</button></div>
        </div>`);
      content.querySelector('#cfg-cancel').onclick = close;
      content.querySelector('#cfg-save').onclick = async (e) => {
        e.target.disabled = true; e.target.textContent = 'Saving…';
        try { await this._cfgSave(s.work); close(); } catch (err) { e.target.disabled = false; e.target.textContent = 'Save & restart'; this.toast('Save failed', err.message); }
      };
    },

    async _cfgSave(next) {
      await this.api.put('/config', next);
      this.toast('Config saved', 'Server restarting…');
      this._cfg = null;
      // The server exits after writing; wait for it to come back, then reload the view.
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      while (Date.now() - t0 < 60000) {
        try { await this.api.get('/config'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
      }
      if (this.currentView === 'config') this.renderConfig();
    },

    _cfgRaw() {
      const s = this._cfg;
      const { content, close } = this._cfgModal(`
        <div class="cfg-modal cfg-modal-wide">
          <h3>Raw JSON (advanced)</h3>
          <p class="cfg-modal-sub">Escape hatch for structural edits the form can't express. Applying loads it into the form — you still review before saving.</p>
          <textarea id="cfg-raw-text" class="cfg-raw" spellcheck="false">${esc(JSON.stringify(s.work, null, 2))}</textarea>
          <div class="cfg-raw-err" id="cfg-raw-err"></div>
          <div class="cfg-modal-actions"><button class="btn" id="cfg-raw-cancel">Cancel</button><button class="btn btn-primary" id="cfg-raw-apply">Apply to form</button></div>
        </div>`);
      content.querySelector('#cfg-raw-cancel').onclick = close;
      content.querySelector('#cfg-raw-apply').onclick = () => {
        try {
          const v = JSON.parse(content.querySelector('#cfg-raw-text').value);
          if (!isObj(v)) throw new Error('top level must be an object');
          s.work = v; s.dirty = diff(s.orig, v).length > 0; this._cfgIndexValues();
          close(); this._cfgRenderMain(); this._cfgSync();
        } catch (err) { content.querySelector('#cfg-raw-err').textContent = 'Invalid JSON: ' + err.message; }
      };
    },
  });
})();
