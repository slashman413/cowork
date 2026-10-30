/**
 * Recipes page (#recipes) — reusable tasks saved from runs that went well.
 *
 * Data: /api/recipes (server core/recipes.ts). A recipe is a brief with {{fields}}
 * plus what made the run work (agent, brain, tier, acceptance, timebox, inputs).
 * Running one fills the fields and creates an ordinary task.
 *
 *   Library   grid of cards — score ("9/10 good"), last 10 runs as dots, Run
 *   Run sheet only the recipe's fields, brain (Auto / last good brain), schedule
 *   Editor    capture from a task card ("★ Save as recipe") or edit: select a
 *             phrase in the brief → "Make field" turns every occurrence into {{key}}
 *   Detail    Runs / Brief / Origin / History tabs (#recipes/<id>)
 *
 * Task cards: "★ Save as recipe" on good finished tasks; recipe-made tasks get a
 * "from recipe" chip and 👍/👎 (a 👎 note becomes a "Known pitfall" next run).
 *
 * Loaded after app.js; extends App.prototype.
 */
(function () {
  const ICONS = ['chef-hat', 'file-text', 'search', 'bar-chart-3', 'megaphone', 'code', 'image', 'video', 'music',
    'mail', 'shopping-cart', 'calendar-check', 'globe', 'sparkles', 'wrench', 'book-open'];
  const TYPES = [['text', 'Short text'], ['longtext', 'Long text'], ['number', 'Number'], ['date', 'Date'], ['choice', 'Choice']];
  const SORTS = [['used', 'Most used'], ['rated', 'Best rated'], ['new', 'Newest']];

  const scoreOf = (s) => (s.good + s.bad ? s.good / (s.good + s.bad) : null);
  const fmtDur = (ms) => {
    if (!ms) return '—';
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const keyFrom = (s, taken) => {
    let k = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 24) || 'field';
    if (!/^[a-z]/.test(k)) k = 'f_' + k;
    let out = k;
    for (let n = 2; taken.includes(out); n++) out = `${k}_${n}`;
    return out;
  };
  const labelFrom = (k) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const scoreBadge = (s) => {
    const n = s.good + s.bad;
    if (!n) return `<span class="rcp-score rcp-score-none" title="No rated runs yet">new</span>`;
    const p = scoreOf(s);
    const cls = p >= 0.8 ? 'good' : p >= 0.5 ? 'mixed' : 'bad';
    return `<span class="rcp-score rcp-score-${cls}" title="${s.good} good · ${s.bad} bad of ${n} rated runs">${s.good}/${n} good</span>`;
  };
  const dots = (recent) => `<span class="rcp-dots" aria-label="Last runs, newest first">${
    (recent || []).map((v) => `<i class="rcp-dot rcp-dot-${v === 1 ? 'good' : v === 0 ? 'bad' : 'none'}"></i>`).join('')}</span>`;

  Object.assign(App.prototype, {
    _rcpModal(html, wide) {
      const container = document.getElementById('modal-container'), content = document.getElementById('modal-content');
      content.innerHTML = `<div class="rcp-modal${wide ? ' rcp-modal-wide' : ''}">${html}</div>`;
      container.classList.remove('hidden');
      const close = () => container.classList.add('hidden');
      container.querySelector('.modal-backdrop').onclick = close;
      content.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
      createIcons();
      return { content, close };
    },

    // ── Library ─────────────────────────────────────────────────────────
    async renderRecipes() {
      const list = await this.api.get('/recipes');
      const st = (this._rcp ||= { q: '', sort: 'used', fav: false });
      const focus = decodeURIComponent(location.hash.split('/')[1] || '');
      this.contentEl.innerHTML = `
        <div class="rcp-page">
          <div class="rcp-top">
            <div>
              <h2 class="rcp-h">Recipes</h2>
              <p class="rcp-sub">Tasks that went well, saved to run again with one click. Make one from any finished task: <b>★ Save as recipe</b>.</p>
            </div>
            <div class="rcp-tools">
              <label class="rcp-search"><i data-lucide="search"></i><input id="rcp-q" type="search" placeholder="Search recipes" value="${esc(st.q)}"></label>
              <select id="rcp-sort" class="rcp-select" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}"${v === st.sort ? ' selected' : ''}>${l}</option>`).join('')}</select>
              <button class="btn rcp-fav-filter${st.fav ? ' on' : ''}" id="rcp-fav" title="Favourites only" aria-pressed="${st.fav}"><i data-lucide="star"></i></button>
            </div>
          </div>
          <div id="rcp-grid" class="rcp-grid"></div>
        </div>`;
      const draw = () => {
        const q = st.q.toLowerCase();
        let rows = list.filter((r) => (!st.fav || r.favourite)
          && (!q || [r.name, r.purpose, r.brief].some((s) => String(s || '').toLowerCase().includes(q))));
        rows.sort(st.sort === 'new' ? (a, b) => b.createdAt.localeCompare(a.createdAt)
          : st.sort === 'rated' ? (a, b) => (scoreOf(b.stats) ?? -1) - (scoreOf(a.stats) ?? -1) || b.stats.runs - a.stats.runs
          : (a, b) => b.stats.runs - a.stats.runs || String(b.stats.lastRunAt || '').localeCompare(String(a.stats.lastRunAt || '')));
        const grid = this.contentEl.querySelector('#rcp-grid');
        if (!list.length) {
          grid.innerHTML = `<div class="rcp-empty"><i data-lucide="chef-hat"></i><h3>No recipes yet</h3>
            <p>Recipes are made from tasks that went well. Open a finished task and press <b>★ Save as recipe</b>: you pick which words change each time, and Cowork keeps the brain, agent and checks that worked.</p>
            <a class="btn btn-primary" href="#tasks">Go to Tasks</a></div>`;
        } else if (!rows.length) {
          grid.innerHTML = `<div class="rcp-empty"><p>No recipe matches.</p></div>`;
        } else {
          grid.innerHTML = rows.map((r) => `
            <article class="rcp-card" data-rcp="${esc(r.id)}" tabindex="0">
              <div class="rcp-card-head">
                <span class="rcp-icon"><i data-lucide="${esc(r.icon)}"></i></span>
                <div class="rcp-card-title"><h3>${esc(r.name)}</h3><span class="rcp-ver">v${r.version}</span></div>
                <button class="rcp-star${r.favourite ? ' on' : ''}" data-rcp-fav="${esc(r.id)}" title="${r.favourite ? 'Unfavourite' : 'Favourite'}" aria-pressed="${!!r.favourite}"><i data-lucide="star"></i></button>
              </div>
              <p class="rcp-purpose">${esc(r.purpose || r.brief.slice(0, 140))}</p>
              <div class="rcp-meta">${scoreBadge(r.stats)} ${dots(r.stats.recent)}</div>
              <div class="rcp-facts">
                <span title="Runs"><i data-lucide="repeat"></i>${r.stats.runs} run${r.stats.runs === 1 ? '' : 's'}</span>
                <span title="Median duration"><i data-lucide="timer"></i>${fmtDur(r.stats.medianMs)}</span>
                <span title="Last run"><i data-lucide="clock"></i>${r.stats.lastRunAt ? timeAgo(r.stats.lastRunAt) : 'never'}</span>
              </div>
              <div class="rcp-card-actions">
                <button class="btn btn-primary" data-rcp-run="${esc(r.id)}"><i data-lucide="play"></i>Run</button>
                <span class="rcp-fieldcount">${r.fields.length ? `${r.fields.length} field${r.fields.length === 1 ? '' : 's'} to fill` : 'no fields: runs as is'}</span>
              </div>
            </article>`).join('');
        }
        createIcons();
      };
      draw();
      const byId = (id) => list.find((r) => r.id === id);
      const page = this.contentEl.querySelector('.rcp-page');
      page.querySelector('#rcp-q').oninput = (e) => { st.q = e.target.value; draw(); };
      page.querySelector('#rcp-sort').onchange = (e) => { st.sort = e.target.value; draw(); };
      page.querySelector('#rcp-fav').onclick = () => { st.fav = !st.fav; this.renderRecipes(); };
      page.onclick = async (e) => {
        const fav = e.target.closest('[data-rcp-fav]'), run = e.target.closest('[data-rcp-run]'), card = e.target.closest('[data-rcp]');
        if (fav) {
          e.stopPropagation();
          const r = byId(fav.dataset.rcpFav);
          await this.api.put(`/recipes/${encodeURIComponent(r.id)}`, { favourite: !r.favourite });
          return this.renderRecipes();
        }
        if (run) { e.stopPropagation(); return this.recipeRunSheet(byId(run.dataset.rcpRun)); }
        if (card) location.hash = `#recipes/${card.dataset.rcp}`;
      };
      page.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('[data-rcp]')) location.hash = `#recipes/${e.target.dataset.rcp}`; };
      if (focus && byId(focus)) this.recipeDetail(focus);
    },

    // ── Run sheet ───────────────────────────────────────────────────────
    async recipeRunSheet(r) {
      let brains = {};
      try { brains = await this.api.get('/brains'); } catch { /* Auto only */ }
      const ids = selectableBrainIds(brains);
      const last = (this._rcpLast ||= JSON.parse(localStorage.getItem('rcp-last') || '{}'))[r.id] || {};
      const fs = 'padding:7px 9px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:inherit;font:inherit;font-size:0.85rem;width:100%;box-sizing:border-box';
      const ls = 'font-size:0.74rem;color:var(--text-muted);font-weight:600;display:block;margin-bottom:3px';
      const fieldInput = (f) => {
        const v = esc(last[f.key] ?? f.default ?? '');
        const id = `rcp-v-${f.key}`;
        if (f.type === 'longtext') return `<textarea id="${id}" class="rcp-in" rows="4">${v}</textarea>`;
        if (f.type === 'choice') return `<select id="${id}" class="rcp-in">${f.options.map((o) => `<option${o === (last[f.key] ?? f.default) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        return `<input id="${id}" class="rcp-in" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" value="${v}">`;
      };
      const brainDefault = r.carry.brainMode === 'lock' ? (r.carry.brain || '') : '';
      const brainOpts = [['', 'Auto (router picks)'], ...(r.carry.brain && !ids.includes(r.carry.brain) ? [[r.carry.brain, r.carry.brain]] : []), ...ids.map((b) => [b, b])]
        .map(([v, l]) => `<option value="${esc(v)}"${v === brainDefault ? ' selected' : ''}>${esc(l)}${v && v === r.carry.brain ? ' · made the good run' : ''}</option>`).join('');
      const { content, close } = this._rcpModal(`
        <div class="rcp-modal-head"><span class="rcp-icon"><i data-lucide="${esc(r.icon)}"></i></span>
          <div><h3>${esc(r.name)}</h3><p class="rcp-modal-sub">${esc(r.purpose || 'Fill in the fields and run.')}</p></div></div>
        <form id="rcp-run-form" class="rcp-form">
          ${r.fields.length ? r.fields.map((f) => `<label class="rcp-field"><span>${esc(f.label)}${f.required ? '' : ' <em>(optional)</em>'}</span>${fieldInput(f)}</label>`).join('')
            : '<p class="rcp-note">This recipe has no fields: it runs exactly as saved.</p>'}
          <label class="rcp-field"><span>Brain</span><select id="rcp-brain" class="rcp-in">${brainOpts}</select></label>
          <details class="rcp-adv"><summary>More options</summary>
            <label class="rcp-field"><span>Extra instructions <em>(optional, this run only)</em></span><textarea id="rcp-extra" class="rcp-in" rows="3"></textarea></label>
            <label class="rcp-field"><span>Start at <em>(blank = now)</em></span><input id="rcp-at" class="rcp-in" type="datetime-local"></label>
            <div class="rcp-field"><span>Repeat</span>${recurrenceEditorHTML('rcp-rec', fs, ls, null)}</div>
          </details>
          <div class="rcp-err" id="rcp-err"></div>
          <div class="rcp-modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary" id="rcp-go"><i data-lucide="play"></i>Run</button></div>
        </form>`);
      recurrenceEditorBind(content, 'rcp-rec');
      content.querySelector('#rcp-run-form').onsubmit = async (e) => {
        e.preventDefault();
        const values = {};
        for (const f of r.fields) values[f.key] = content.querySelector(`#rcp-v-${f.key}`).value;
        const body = { values, brain: content.querySelector('#rcp-brain').value };
        const extra = content.querySelector('#rcp-extra').value.trim();
        if (extra) body.extra = extra;
        const at = content.querySelector('#rcp-at').value;
        if (at) body.scheduledAt = new Date(at).toISOString();
        const rec = readRecurrence(content, 'rcp-rec');
        if (rec) body.recurrence = rec;
        const go = content.querySelector('#rcp-go');
        go.disabled = true;
        try {
          const t = await this.api.post(`/recipes/${encodeURIComponent(r.id)}/run`, body);
          this._rcpLast[r.id] = values;
          localStorage.setItem('rcp-last', JSON.stringify(this._rcpLast));
          close();
          this.toast('recipe started', `${t.title} — ${t.status === 'scheduled' ? 'scheduled' : 'queued'}.`);
          location.hash = `#tasks/${t.id}`;
        } catch (err) { content.querySelector('#rcp-err').textContent = err.message; go.disabled = false; }
      };
    },

    // ── Detail ──────────────────────────────────────────────────────────
    async recipeDetail(id) {
      const r = await this.api.get(`/recipes/${encodeURIComponent(id)}`);
      const s = r.stats;
      const runs = r.runs.length ? `<table class="rcp-table"><thead><tr><th>Run</th><th>Ver</th><th>Brain</th><th>Rating</th><th>When</th></tr></thead><tbody>${
        r.runs.map((t) => `<tr><td><a href="#tasks/${esc(t.id)}">${esc(t.title)}</a></td><td>v${esc(String(t.version ?? '?'))}</td><td>${esc(t.brain || 'auto')}</td>
          <td>${t.rating ? (t.rating.good ? '👍' : '👎') + (t.rating.note ? ` <span class="rcp-muted">${esc(t.rating.note)}</span>` : '') : t.failed ? '<span class="rcp-bad">failed</span>' : t.status === 'done' ? '<span class="rcp-muted">unrated</span>' : esc(t.status)}</td>
          <td title="${esc(t.createdAt)}">${timeAgo(t.createdAt)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="rcp-note">No runs yet. Press Run to make the first one.</p>';
      const carry = r.carry;
      const facts = [
        ['Agent', carry.agent || 'router picks'], ['Brain', carry.brain ? `${carry.brain} (${carry.brainMode === 'lock' ? 'always' : 'suggested'})` : 'router picks'],
        ['Tier', carry.tier], ['Timebox', carry.timeboxMin ? `${carry.timeboxMin} min` : null],
        ['Input files', carry.inputs.length ? carry.inputs.join(', ') : null],
      ].filter(([, v]) => v);
      const { content, close } = this._rcpModal(`
        <div class="rcp-modal-head"><span class="rcp-icon"><i data-lucide="${esc(r.icon)}"></i></span>
          <div><h3>${esc(r.name)} <span class="rcp-ver">v${r.version}</span></h3><p class="rcp-modal-sub">${esc(r.purpose)}</p>
          <div class="rcp-meta">${scoreBadge(s)} ${dots(s.recent)} <span class="rcp-muted">${s.runs} run${s.runs === 1 ? "" : "s"} · median ${fmtDur(s.medianMs)}${s.versionGood + s.versionBad ? ` · this version ${s.versionGood}/${s.versionGood + s.versionBad} good` : ''}</span></div></div></div>
        <div class="rcp-tabs" role="tablist">${['Runs', 'Brief', 'Origin', 'History'].map((t, i) => `<button role="tab" class="rcp-tab${i ? '' : ' on'}" data-tab="${t}">${t}</button>`).join('')}</div>
        <section class="rcp-pane" data-pane="Runs">${runs}</section>
        <section class="rcp-pane" data-pane="Brief" hidden>
          <div class="rcp-k">Title</div><pre class="rcp-pre">${esc(r.title)}</pre>
          <div class="rcp-k">Brief</div><pre class="rcp-pre">${esc(r.brief).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '<mark>{{$1}}</mark>')}</pre>
          ${carry.acceptance?.length ? `<div class="rcp-k">Done when</div><ul class="rcp-ul">${carry.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
          <dl class="rcp-dl">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        </section>
        <section class="rcp-pane" data-pane="Origin" hidden>${r.origin ? `
          <p class="rcp-note">This is what good looked like: the run this recipe was saved from (<a href="#tasks/${esc(r.origin.taskId)}">open task</a>).</p>
          <pre class="rcp-pre">${esc(r.origin.resultExcerpt || '(no result text)')}</pre>` : '<p class="rcp-note">Written by hand.</p>'}</section>
        <section class="rcp-pane" data-pane="History" hidden>${r.versions.length ? r.versions.map((v) => `
          <details class="rcp-adv"><summary>v${v.version} · ${timeAgo(v.updatedAt)}</summary><pre class="rcp-pre">${esc(v.brief)}</pre></details>`).join('')
          : '<p class="rcp-note">No earlier versions. Editing the brief, fields or settings saves a new version and starts a fresh score.</p>'}</section>
        <div class="rcp-modal-actions">
          <button class="btn rcp-danger" id="rcp-archive"><i data-lucide="archive"></i>Archive</button>
          <span style="flex:1"></span>
          <button class="btn" id="rcp-edit"><i data-lucide="pencil"></i>Edit</button>
          <button class="btn btn-primary" id="rcp-run"><i data-lucide="play"></i>Run</button>
        </div>`, true);
      const unfocus = () => { if (location.hash.startsWith('#recipes/')) history.replaceState(null, '', '#recipes'); };
      document.querySelector('#modal-container .modal-backdrop').addEventListener('click', unfocus, { once: true });
      content.querySelectorAll('.rcp-tab').forEach((b) => (b.onclick = () => {
        content.querySelectorAll('.rcp-tab').forEach((x) => x.classList.toggle('on', x === b));
        content.querySelectorAll('.rcp-pane').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
      }));
      content.querySelector('#rcp-run').onclick = () => { unfocus(); this.recipeRunSheet(r); };
      content.querySelector('#rcp-edit').onclick = () => { unfocus(); this.recipeEditor(r, { edit: true }); };
      content.querySelector('#rcp-archive').onclick = async () => {
        if (!confirm(`Archive "${r.name}"? Its past runs stay; it leaves the library.`)) return;
        await this.api.del(`/recipes/${encodeURIComponent(r.id)}`);
        close(); unfocus(); this.toast('archived', r.name);
        if (this.currentView === 'recipes') this.renderRecipes();
      };
      content.querySelectorAll('a[href^="#tasks/"]').forEach((a) => a.addEventListener('click', close));
    },

    // ── Editor (capture from a task, or edit) ───────────────────────────
    async saveTaskAsRecipe(taskId) {
      try { this.recipeEditor(await this.api.post(`/recipes/draft-from-task/${encodeURIComponent(taskId)}`, {}), { edit: false }); }
      catch (err) { this.toast('error', err.message); }
    },

    recipeEditor(draft, { edit }) {
      const d = JSON.parse(JSON.stringify(draft));
      d.carry ||= { brainMode: 'suggest', inputs: [] };
      const keep = { agent: !!d.carry.agent, brain: !!d.carry.brain, tier: !!d.carry.tier, acceptance: !!d.carry.acceptance?.length,
        timeboxMin: !!d.carry.timeboxMin, inputs: !!d.carry.inputs?.length };
      const carryRows = [
        ['agent', 'Agent', d.carry.agent], ['brain', 'Brain', d.carry.brain], ['tier', 'Tier', d.carry.tier],
        ['acceptance', 'Acceptance checks', d.carry.acceptance?.length ? `${d.carry.acceptance.length} check${d.carry.acceptance.length === 1 ? '' : 's'}` : ''],
        ['timeboxMin', 'Timebox', d.carry.timeboxMin ? `${d.carry.timeboxMin} min` : ''],
        ['inputs', 'Input files', (d.carry.inputs || []).join(', ')],
      ].filter(([, , v]) => v);
      const { content, close } = this._rcpModal(`
        <h3>${edit ? `Edit recipe <span class="rcp-ver">v${d.version}</span>` : '★ Save as recipe'}</h3>
        <p class="rcp-modal-sub">${edit ? 'Changing the brief, fields or settings saves a new version with a fresh score.' : 'Keep what worked, and choose the words that change from run to run.'}</p>
        <div class="rcp-form">
          <div class="rcp-step"><span class="rcp-num">1</span><b>Name it</b></div>
          <div class="rcp-row">
            <label class="rcp-field rcp-grow"><span>Name</span><input id="rcp-name" class="rcp-in" maxlength="80" value="${esc(d.name)}"></label>
          </div>
          <div class="rcp-icons" role="radiogroup" aria-label="Icon">${ICONS.map((i) => `<button type="button" role="radio" aria-checked="${i === d.icon}" class="rcp-icon-pick${i === d.icon ? ' on' : ''}" data-icon="${i}" title="${i}"><i data-lucide="${i}"></i></button>`).join('')}</div>
          <label class="rcp-field"><span>What it's for <em>(one line)</em></span><input id="rcp-purpose" class="rcp-in" maxlength="160" placeholder="e.g. Monthly audit of the Gumroad catalog" value="${esc(d.purpose)}"></label>

          <div class="rcp-step"><span class="rcp-num">2</span><b>Pick what changes each run</b></div>
          <p class="rcp-note">Select a word or phrase in the brief and press <b>Make field</b>. Every copy of it becomes a blank you fill in when you run the recipe.</p>
          <label class="rcp-field"><span>Task title</span><input id="rcp-title" class="rcp-in" value="${esc(d.title)}"></label>
          <label class="rcp-field"><span>Brief</span><textarea id="rcp-brief" class="rcp-in rcp-brief" rows="9" spellcheck="false">${esc(d.brief)}</textarea></label>
          <div class="rcp-makefield"><button type="button" class="btn" id="rcp-mk" disabled><i data-lucide="text-cursor-input"></i>Make field</button><span class="rcp-muted" id="rcp-sel">Select text in the title or brief first.</span></div>
          <div id="rcp-fields" class="rcp-fields"></div>

          <div class="rcp-step"><span class="rcp-num">3</span><b>Keep what worked</b></div>
          ${carryRows.length ? `<div class="rcp-carry">${carryRows.map(([k, l, v]) => `
            <label class="rcp-check"><input type="checkbox" data-keep="${k}"${keep[k] ? ' checked' : ''}><span><b>${l}</b> <span class="rcp-muted">${esc(v)}</span></span></label>`).join('')}</div>` : '<p class="rcp-note">Nothing to carry over: the router picks agent and brain.</p>'}
          ${d.carry.brain ? `<label class="rcp-switch"><input type="checkbox" id="rcp-lock"${d.carry.brainMode === 'lock' ? ' checked' : ''}><span>Always use <b>${esc(d.carry.brain)}</b><br><em>Off: Cowork's router picks a brain each run (can be cheaper), and ${esc(d.carry.brain)} is one tap away.</em></span></label>` : ''}
          <div class="rcp-err" id="rcp-err"></div>
          <div class="rcp-modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-primary" id="rcp-save">${edit ? 'Save changes' : '★ Save recipe'}</button></div>
        </div>`, true);
      const $ = (s) => content.querySelector(s);
      let lastFocus = $('#rcp-brief');
      const drawFields = () => {
        $('#rcp-fields').innerHTML = d.fields.length ? d.fields.map((f, i) => `
          <div class="rcp-fieldrow" data-i="${i}">
            <code class="rcp-key">{{${esc(f.key)}}}</code>
            <input class="rcp-in" data-f="label" value="${esc(f.label)}" aria-label="Label">
            <select class="rcp-in" data-f="type" aria-label="Type">${TYPES.map(([v, l]) => `<option value="${v}"${v === f.type ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <input class="rcp-in" data-f="default" value="${esc(f.default || '')}" placeholder="Default" aria-label="Default">
            ${f.type === 'choice' ? `<input class="rcp-in rcp-opts" data-f="options" value="${esc((f.options || []).join(', '))}" placeholder="Options, comma separated" aria-label="Options">` : ''}
            <label class="rcp-req"><input type="checkbox" data-f="required"${f.required !== false ? ' checked' : ''}>Required</label>
            <button type="button" class="btn-icon rcp-rm" data-rm="${i}" title="Remove field (puts the default text back)"><i data-lucide="x"></i></button>
          </div>`).join('') : '';
        createIcons();
      };
      drawFields();
      content.querySelectorAll('.rcp-icon-pick').forEach((b) => (b.onclick = () => {
        d.icon = b.dataset.icon;
        content.querySelectorAll('.rcp-icon-pick').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      }));
      const selText = () => {
        const el = lastFocus;
        return el ? el.value.slice(el.selectionStart, el.selectionEnd).trim() : '';
      };
      const onSel = () => {
        const s = selText();
        $('#rcp-mk').disabled = !s || /[{}]/.test(s);
        $('#rcp-sel').textContent = s ? `“${s.length > 40 ? s.slice(0, 40) + '…' : s}”` : 'Select text in the title or brief first.';
      };
      for (const el of [$('#rcp-brief'), $('#rcp-title')]) {
        el.addEventListener('focus', () => (lastFocus = el));
        ['select', 'keyup', 'mouseup'].forEach((ev) => el.addEventListener(ev, onSel));
      }
      $('#rcp-mk').onmousedown = (e) => e.preventDefault();  // keep the textarea selection
      $('#rcp-mk').onclick = () => {
        const s = selText();
        if (!s) return;
        const key = keyFrom(s.split(/\s+/).slice(0, 3).join(' '), d.fields.map((f) => f.key));
        const ph = `{{${key}}}`;
        $('#rcp-brief').value = $('#rcp-brief').value.split(s).join(ph);
        $('#rcp-title').value = $('#rcp-title').value.split(s).join(ph);
        d.fields.push({ key, label: labelFrom(key), type: s.length > 80 ? 'longtext' : /^\d+(\.\d+)?$/.test(s) ? 'number' : 'text', default: s, required: true });
        drawFields(); onSel();
      };
      $('#rcp-fields').addEventListener('input', (e) => {
        const row = e.target.closest('[data-i]'), f = d.fields[row?.dataset.i], k = e.target.dataset.f;
        if (!f || !k) return;
        if (k === 'required') f.required = e.target.checked;
        else if (k === 'options') f.options = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
        else f[k] = e.target.value;
        if (k === 'type') { if (f.type === 'choice' && !f.options?.length) f.options = f.default ? [f.default] : []; drawFields(); }
      });
      $('#rcp-fields').addEventListener('click', (e) => {
        const rm = e.target.closest('[data-rm]');
        if (!rm) return;
        const [f] = d.fields.splice(Number(rm.dataset.rm), 1);
        const re = new RegExp(`\\{\\{\\s*${f.key}\\s*\\}\\}`, 'g');
        $('#rcp-brief').value = $('#rcp-brief').value.replace(re, f.default || f.label);
        $('#rcp-title').value = $('#rcp-title').value.replace(re, f.default || f.label);
        drawFields();
      });
      $('#rcp-save').onclick = async () => {
        const kept = (k) => content.querySelector(`[data-keep="${k}"]`)?.checked;
        const c = d.carry;
        const body = {
          ...d, name: $('#rcp-name').value.trim(), purpose: $('#rcp-purpose').value.trim(),
          title: $('#rcp-title').value.trim(), brief: $('#rcp-brief').value,
          carry: {
            agent: kept('agent') ? c.agent : undefined, division: kept('agent') ? c.division : undefined,
            brain: kept('brain') ? c.brain : undefined, brainMode: kept('brain') && $('#rcp-lock')?.checked ? 'lock' : 'suggest',
            tier: kept('tier') ? c.tier : undefined, acceptance: kept('acceptance') ? c.acceptance : undefined,
            timeboxMin: kept('timeboxMin') ? c.timeboxMin : undefined, priority: c.priority, tags: c.tags,
            inputs: kept('inputs') ? c.inputs : [],
          },
        };
        const btn = $('#rcp-save');
        btn.disabled = true;
        try {
          const saved = edit ? await this.api.put(`/recipes/${encodeURIComponent(d.id)}`, body) : await this.api.post('/recipes', body);
          close();
          this.toast(edit ? 'recipe saved' : 'recipe created', edit ? `${saved.name} is now v${saved.version}.` : `${saved.name} is in Recipes, ready to run.`);
          if (this.currentView === 'recipes') this.renderRecipes();
          else if (this.currentView === 'tasks') this.renderInbox();
        } catch (err) { $('#rcp-err').textContent = err.message; btn.disabled = false; }
      };
    },

    // ── Task-card hooks (rendered by app.js renderInbox) ─────────────────
    recipeTaskCardHTML(t, failed) {
      const rc = t.context?.recipe;
      const finished = t.status === 'done' || t.status === 'rejected';
      const parts = [];
      if (rc?.id) {
        parts.push(`<a class="rcp-chip" href="#recipes/${esc(rc.id)}" title="Made from a recipe"><i data-lucide="chef-hat"></i>${esc(rc.name || 'recipe')} v${esc(String(rc.version || 1))}</a>`);
        if (finished) {
          const g = t.context?.rating?.good;
          parts.push(`<span class="rcp-rate" role="group" aria-label="Rate this run">
            <button class="rcp-thumb${g === true ? ' on' : ''}" data-rate-task="${esc(t.id)}" data-good="1" title="Good result" aria-pressed="${g === true}">👍</button>
            <button class="rcp-thumb${g === false ? ' on bad' : ''}" data-rate-task="${esc(t.id)}" data-good="0" title="Bad result — say what went wrong; it is passed on as a pitfall next run" aria-pressed="${g === false}">👎</button></span>`);
        }
      }
      if (t.status === 'done' && !failed) {
        parts.push(`<button class="btn rcp-save-btn" data-save-recipe="${esc(t.id)}" title="Save this run as a reusable recipe">★ Save as recipe</button>`);
      }
      return parts.length ? `<div class="rcp-cardbar">${parts.join('')}</div>` : '';
    },

    bindRecipeTaskCards(root) {
      root.querySelectorAll('[data-save-recipe]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation(); this.saveTaskAsRecipe(b.dataset.saveRecipe);
      }));
      root.querySelectorAll('[data-rate-task]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const good = b.dataset.good === '1';
        const body = b.getAttribute('aria-pressed') === 'true' ? { good: null } : { good };
        if (body.good === false) {
          const note = prompt('What went wrong? (optional — it is shown to the next run as a known pitfall)');
          if (note === null) return;
          if (note.trim()) body.note = note.trim();
        }
        try { await this.api.post(`/inbox/${encodeURIComponent(b.dataset.rateTask)}/rating`, body); this.renderInbox(); }
        catch (err) { this.toast('error', err.message); }
      }));
    },
  });
})();
