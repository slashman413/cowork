/**
 * Calendar page (#calendar) — tasks on a time axis, built for SCHEDULED work.
 *
 * Data: GET /api/calendar?from&to (server/src/core/calendar.ts) returns
 *   events — `planned` fires of scheduled tasks (recurring ones expanded with the
 *            dispatcher's own nextRunAt) + `run` entries for everything that ran
 *   series — one row per scheduled task: next fire, cadence, last run outcome
 *
 * Visual grammar (see docs/calendar-ux.md — "calm by default, loud on exceptions"):
 *   dashed outline = projected (hasn't happened)   dot + text = a finished run
 *   tinted fill    = needs eyes (running / waiting / failed / overdue)
 *   colour = status (STATUS_COLORS in app.js + overdue / failed / skipped)
 *   repeat icon (agenda / rail / sheet) = recurring series   ⚠ = overdue
 *   The Show toggles double as the legend (their swatches draw the grammar).
 *
 * Views: month · week (time grid) · agenda (list; default on narrow screens).
 * Phone (<720px): month shows status dots per day and a tap opens that day in
 * agenda; week scrolls sideways with a sticky hour gutter.
 * Interactions: click an entry → detail sheet (run now / reschedule / edit /
 * open in Tasks); click an empty day/slot → New task pre-filled with that time;
 * drag a movable entry (a scheduled task's NEXT fire) to reschedule it.
 * Keys: ←/→ prev/next · T today · M/W/A view.
 *
 * Loaded after app.js; extends App.prototype so it shares api/toast/modals.
 */
(function () {
  const DAY = 86400000;
  const HOUR_PX = 48;               // week grid: one hour row (CSS reads it as --cal-hour)
  const DENSE_PER_DAY = 6;          // more fires of one series in a day → one summary chip
  const CAL_COLORS = {
    scheduled: '#6366F1', overdue: '#F59E0B', queued: '#EAB308', running: '#0EA5E9',
    'wait-input': '#A855F7', done: '#22C55E', failed: '#EF4444', skipped: '#94A3B8', cancelled: '#94A3B8',
  };
  const STATUS_LABEL = {
    scheduled: 'scheduled', overdue: 'overdue', queued: 'queued', running: 'running',
    'wait-input': 'waiting for input', done: 'done', failed: 'failed', skipped: 'closed without running', cancelled: 'cancelled',
  };
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const NARROW = 720;               // px — phone layout breakpoint (matches calendar.css)
  const isNarrow = () => window.innerWidth < NARROW;
  // Statuses that deserve a filled chip; everything else past is a quiet dot row.
  const LOUD = new Set(['overdue', 'running', 'wait-input', 'failed', 'queued']);
  const PREFS_KEY = 'cowork-calendar';

  const p2 = (n) => String(n).padStart(2, '0');
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const dayKey = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const hhmm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const sameDay = (a, b) => dayKey(a) === dayKey(b);

  function relTime(ms) {
    const diff = ms - Date.now(), abs = Math.abs(diff);
    const unit = abs < 3600000 ? [Math.round(abs / 60000), 'min'] : abs < DAY ? [Math.round(abs / 3600000), 'h'] : [Math.round(abs / DAY), 'd'];
    if (abs < 60000) return 'now';
    return diff > 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
  }

  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { /* defaults */ }
    return {
      view: p.view || (isNarrow() ? 'agenda' : 'week'),
      showPlanned: p.showPlanned !== false,
      showSeriesRuns: p.showSeriesRuns !== false,
      showAdhoc: !!p.showAdhoc,          // one-off ad-hoc tasks are noise on a schedule view: off by default
    };
  }

  Object.assign(App.prototype, {
    _calState() {
      if (!this.cal) this.cal = { ...loadPrefs(), anchor: startOfDay(new Date()), data: null, scrolled: false };
      return this.cal;
    },

    _calSavePrefs() {
      const { view, showPlanned, showSeriesRuns, showAdhoc } = this.cal;
      localStorage.setItem(PREFS_KEY, JSON.stringify({ view, showPlanned, showSeriesRuns, showAdhoc }));
    },

    /** [from, to) for the current view. */
    _calRange() {
      const { view, anchor } = this.cal;
      if (view === 'month') {
        const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        const from = addDays(first, -first.getDay());
        return { from, to: addDays(from, 42) };
      }
      if (view === 'week') {
        const from = addDays(anchor, -anchor.getDay());
        return { from, to: addDays(from, 7) };
      }
      return { from: anchor, to: addDays(anchor, 30) };   // agenda
    },

    /** "October 2026" · "Oct 25 – 31, 2026" · "Oct 25 – Nov 1, 2026" · "Dec 28, 2026 – Jan 3, 2027". */
    _calTitle() {
      const { view, anchor } = this.cal;
      const { from, to } = this._calRange();
      if (view === 'month') return anchor.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
      const last = addDays(to, -1);
      const md = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      if (from.getFullYear() !== last.getFullYear()) return `${md(from)}, ${from.getFullYear()} – ${md(last)}, ${last.getFullYear()}`;
      const tail = from.getMonth() === last.getMonth() ? last.getDate() : md(last);
      return `${md(from)} – ${tail}, ${last.getFullYear()}`;
    },

    _calShift(dir) {
      const c = this.cal;
      if (c.view === 'month') c.anchor = new Date(c.anchor.getFullYear(), c.anchor.getMonth() + dir, 1);
      else c.anchor = addDays(c.anchor, dir * (c.view === 'week' ? 7 : 30));
      c.scrolled = false;
      this.renderCalendar();
    },

    /** Events after the Show filters. A run that belongs to a series is "series";
     *  one with no scheduler is "ad-hoc". */
    _calVisible() {
      const c = this.cal;
      return (c.data?.events || []).filter((e) => {
        if (e.kind === 'planned') return c.showPlanned;
        return e.seriesId ? c.showSeriesRuns : c.showAdhoc;
      });
    },

    async renderCalendar() {
      const c = this._calState();
      const { from, to } = this._calRange();
      // Keep the old frame on screen while fetching; just signal it is stale.
      this.contentEl.querySelector('.cal-main')?.classList.add('is-loading');
      const data = await this.api.get(`/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      c.data = data;
      const prevScroll = this._calVScroller()?.scrollTop;
      const prevScrollX = this.contentEl.querySelector('.cal-week')?.scrollLeft;
      // Animate only when the period or view changed — not on the 60 s refresh.
      const frameKey = `${c.view}|${dayKey(from)}`;
      const enter = c.frameKey !== frameKey;
      c.frameKey = frameKey;

      const overdue = data.series.filter((s) => s.overdue);
      const seg = ['month', 'week', 'agenda'].map((v) =>
        `<button class="cal-seg-btn${c.view === v ? ' active' : ''}" data-view="${v}" aria-pressed="${c.view === v}" title="${v[0].toUpperCase() + v.slice(1)} (${v[0].toUpperCase()})">${v[0].toUpperCase() + v.slice(1)}</button>`).join('');
      // Show toggles are also the legend: each swatch draws what it filters.
      const toggle = (key, label, hint, swatch) =>
        `<button class="cal-toggle${c[key] ? ' on' : ''}" data-toggle="${key}" aria-pressed="${!!c[key]}" title="${esc(hint)}">
          <span class="cal-swatch ${swatch}" aria-hidden="true"></span>${esc(label)}</button>`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const visible = this._calVisible().length;
      const title = this._calTitle();
      const period = c.view === 'month' ? 'month' : c.view === 'week' ? 'week' : '30 days';

      this.contentEl.innerHTML = `
        ${overdue.length ? `<div class="cal-alert" role="alert"><i data-lucide="triangle-alert"></i>
          <div><strong>${overdue.length} scheduled task${overdue.length > 1 ? 's are' : ' is'} past ${overdue.length > 1 ? 'their' : 'its'} launch time.</strong>
          <span class="cal-alert-sub">The dispatcher releases due tasks every tick — if this persists, check that it is running.</span>
          <span class="cal-alert-links">${overdue.map((s) => `<button class="cal-link" data-open="${esc(s.taskId)}">${esc(s.title)}</button>`).join('')}</span></div></div>` : ''}
        <div class="cal-toolbar">
          <div class="cal-nav">
            <button class="btn cal-today" data-nav="0" title="Today (T)">Today</button>
            <div class="cal-arrows">
              <button class="icon-btn cal-arrow" data-nav="-1" aria-label="Previous ${period}" title="Previous (←)"><i data-lucide="chevron-left"></i></button>
              <button class="icon-btn cal-arrow" data-nav="1" aria-label="Next ${period}" title="Next (→)"><i data-lucide="chevron-right"></i></button>
            </div>
            <h2 class="cal-title" aria-live="polite">${esc(title)}</h2>
          </div>
          <div class="cal-actions">
            <div class="cal-seg" role="group" aria-label="Calendar view">${seg}</div>
            <button class="btn btn-primary cal-new" data-new aria-label="Schedule task"><i data-lucide="plus"></i><span>Schedule task</span></button>
          </div>
        </div>
        <div class="cal-subbar">
          <div class="cal-filters" role="group" aria-label="Show">
            ${toggle('showPlanned', 'Upcoming', 'Projected fires of scheduled tasks (dashed outline)', 'sw-planned')}
            ${toggle('showSeriesRuns', 'Scheduled runs', 'Past runs spawned by a schedule (dot)', 'sw-runs')}
            ${toggle('showAdhoc', 'Ad-hoc', 'Ad-hoc tasks: one-off tasks with no schedule', 'sw-adhoc')}
          </div>
          <span class="cal-tz" title="All times are shown in this time zone"><i data-lucide="globe" class="cal-ico"></i>${esc(tz)}</span>
        </div>
        <div class="cal-layout">
          <section class="card cal-main" aria-label="${esc(title)}">
            ${!visible && c.view !== 'agenda' ? `<div class="cal-empty-note"><i data-lucide="calendar-check" class="cal-ico"></i>
              Nothing to show this ${period}. ${c.showAdhoc ? '' : 'Ad-hoc tasks are hidden — '}click ${c.view === 'month' ? 'a day' : 'a slot'} to schedule a task.</div>` : ''}
            <div class="cal-view${enter ? ' cal-enter' : ''}">${
            c.view === 'month' ? this._calMonthHTML() : c.view === 'week' ? this._calWeekHTML() : this._calAgendaHTML()}</div>
          </section>
          <aside class="card cal-rail" aria-label="Schedules">${this._calRailHTML()}</aside>
        </div>
        <p class="cal-foot">${isNarrow() ? 'Tap an entry for details and actions.' : `Drag the <b>next</b> upcoming run of a schedule to move it · click an empty ${c.view === 'month' ? 'day' : 'slot'} to schedule a task ·
          <span class="cal-keys"><kbd>←</kbd><kbd>→</kbd> period <kbd>T</kbd> today <kbd>M</kbd><kbd>W</kbd><kbd>A</kbd> view</span>`}</p>`;

      this._calBind();
      const body = this._calVScroller();
      if (body) {
        if (c.scrolled && prevScroll != null) body.scrollTop = prevScroll;
        else { body.scrollTop = Math.max(0, (new Date().getHours() - 2) * HOUR_PX); c.scrolled = true; }
        const wk = this.contentEl.querySelector('.cal-week');
        if (wk && !enter && prevScrollX != null) wk.scrollLeft = prevScrollX;
        else if (wk && wk.scrollWidth > wk.clientWidth) {           // phone: bring today's column into view
          const col = wk.querySelector('.cal-wk-col.today');
          if (col) wk.scrollLeft = Math.max(0, col.offsetLeft - 44);
        }
      }
      // Keep the now-line and relative times honest without waiting for SSE.
      this.addViewTimer(() => {
        const el = document.activeElement;
        if (!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) && document.getElementById('modal-container')?.classList.contains('hidden')) {
          this.renderCalendar().catch(() => {});
        }
      }, 60000);
    },

    /** The element that scrolls the week grid vertically: the body on desktop,
     *  the whole .cal-week on a phone (it scrolls both ways so the hour gutter
     *  and day header can both stay sticky). */
    _calVScroller() {
      const wk = this.contentEl.querySelector('.cal-week');
      if (!wk) return null;
      return getComputedStyle(wk).overflowY === 'auto' ? wk : wk.querySelector('.cal-week-body');
    },

    // ── chips ──────────────────────────────────────────────────────────────

    /** One entry. Quiet by default (finished runs = dot + text, projected = dashed
     *  outline); LOUD statuses get a tinted fill so exceptions are what you see. */
    _calChip(e, opts = {}) {
      const color = CAL_COLORS[e.status] || '#94A3B8';
      const start = new Date(e.start);
      const movable = e.kind === 'planned' && e.head;
      const loud = LOUD.has(e.status);
      const label = `${hhmm(start)} ${e.title}${opts.count > 1 ? ` (${opts.count} runs)` : ''} — ${STATUS_LABEL[e.status] || e.status}${e.cadence ? `, ${e.cadence}` : ''}${movable ? ' · drag to reschedule' : ''}`;
      const cls = ['cal-chip', e.kind, loud ? 'loud' : 'quiet', movable ? 'head' : '',
        opts.block ? 'block' : '', opts.short ? 'short' : '', opts.narrow ? 'narrow' : ''].filter(Boolean).join(' ');
      const mark = e.status === 'overdue' ? '<span class="cal-mark" aria-hidden="true">⚠</span>' : '';
      const dot = e.kind === 'run' && !loud && !opts.block ? '<span class="cal-dot" aria-hidden="true"></span>' : '';
      const count = opts.count > 1 ? `<span class="cal-count">×${opts.count}</span>` : '';
      const inner = opts.block && !opts.short
        ? `<span class="cal-name">${mark}${esc(e.title)}</span><span class="cal-time">${hhmm(start)}${e.end && sameDay(start, new Date(e.end)) ? `–${hhmm(new Date(e.end))}` : ''}</span>${count}`
        : `${dot}${mark}<span class="cal-time">${hhmm(start)}</span><span class="cal-name">${esc(e.title)}</span>${count}`;
      return `<button class="${cls}" style="--c:${color};${opts.style || ''}"
          data-ev="${esc(e.id)}"${movable ? ` draggable="true" data-move="${esc(e.taskId)}"` : ''} title="${esc(label)}" aria-label="${esc(label)}">${inner}</button>`;
    },

    /** Group one day's events: a series firing more than DENSE_PER_DAY times
     *  that day collapses into one chip with a count. */
    _calCollapse(events) {
      const groups = new Map(), out = [];
      for (const e of events) {
        const k = e.kind === 'planned' ? `p:${e.seriesId}` : (e.seriesId ? `r:${e.seriesId}:${e.status}` : null);
        if (!k) { out.push({ e, count: 1 }); continue; }
        if (!groups.has(k)) { const g = { e, count: 0, all: [] }; groups.set(k, g); out.push(g); }
        const g = groups.get(k); g.count++; g.all.push(e);
      }
      return out.flatMap((g) => (g.all && g.count <= DENSE_PER_DAY) ? g.all.map((e) => ({ e, count: 1 })) : [g])
        .sort((a, b) => a.e.start.localeCompare(b.e.start));
    },

    _calByDay() {
      const map = new Map();
      for (const e of this._calVisible()) {
        const k = dayKey(new Date(e.start));
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
      }
      return map;
    },

    // ── month ──────────────────────────────────────────────────────────────

    _calMonthHTML() {
      const { from } = this._calRange();
      const month = this.cal.anchor.getMonth();
      const today = new Date();
      const byDay = this._calByDay();
      const MAX = 4, MAX_DOTS = 4;
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const d = addDays(from, i);
        const items = this._calCollapse(byDay.get(dayKey(d)) || []);
        const shown = items.slice(0, MAX);
        const more = items.length - shown.length;
        const isToday = sameDay(d, today);
        // Phone: one dot per entry (loud statuses first so failures are never hidden).
        const dotItems = [...items].sort((a, b) => LOUD.has(b.e.status) - LOUD.has(a.e.status)).slice(0, MAX_DOTS);
        const dots = items.length ? `<div class="cal-dots" aria-hidden="true">${dotItems.map((g) =>
          `<span class="cal-dot${g.e.kind === 'planned' ? ' planned' : ''}" style="--c:${CAL_COLORS[g.e.status] || '#94A3B8'}"></span>`).join('')}${items.length > MAX_DOTS ? `<span class="cal-dots-more">+${items.length - MAX_DOTS}</span>` : ''}</div>` : '';
        cells += `<div class="cal-day${d.getMonth() !== month ? ' out' : ''}${isToday ? ' today' : ''}${d < startOfDay(today) ? ' past' : ''}${d.getDay() % 6 === 0 ? ' weekend' : ''}"
            data-day="${dayKey(d)}" role="gridcell" aria-label="${esc(d.toDateString())}${isToday ? ', today' : ''}${items.length ? `, ${items.length} entries` : ''}">
          <button class="cal-date" data-goday="${dayKey(d)}" aria-label="Open ${esc(d.toDateString())}"${isToday ? ' aria-current="date"' : ''}>${d.getDate() === 1 ? `<span class="cal-date-mon">${esc(d.toLocaleDateString(undefined, { month: 'short' }))}</span>` : ''}${d.getDate()}</button>
          <div class="cal-chips">${shown.map((g) => this._calChip(g.e, { count: g.count })).join('')}
          ${more > 0 ? `<button class="cal-more" data-goday="${dayKey(d)}">${more} more</button>` : ''}</div>
          ${dots}
        </div>`;
      }
      return `<div class="cal-month" role="grid">
        <div class="cal-dow" role="row">${WD.map((w, i) => `<div role="columnheader"${i % 6 === 0 ? ' class="weekend"' : ''}>${w}</div>`).join('')}</div>
        <div class="cal-grid">${cells}</div></div>`;
    },

    // ── week ───────────────────────────────────────────────────────────────

    _calWeekHTML() {
      const { from } = this._calRange();
      const now = new Date();
      const byDay = this._calByDay();
      const days = [...Array(7)].map((_, i) => addDays(from, i));
      const nowTop = (now.getHours() + now.getMinutes() / 60) * HOUR_PX;
      let head = '', allDay = '', cols = '', weekHasToday = false;
      for (const d of days) {
        const isToday = sameDay(d, now);
        weekHasToday ||= isToday;
        head += `<div class="cal-wk-head${isToday ? ' today' : ''}${d < startOfDay(now) ? ' past' : ''}"><span>${WD[d.getDay()]}</span><b${isToday ? ' aria-current="date"' : ''}>${d.getDate()}</b></div>`;
        const groups = this._calCollapse(byDay.get(dayKey(d)) || []);
        const dense = groups.filter((g) => g.count > 1);
        const timed = groups.filter((g) => g.count === 1).map((g) => g.e);
        allDay += `<div class="cal-wk-allday${isToday ? ' today' : ''}">${dense.map((g) => this._calChip(g.e, { count: g.count })).join('')}</div>`;
        cols += `<div class="cal-wk-col${isToday ? ' today' : ''}${d < startOfDay(now) ? ' past' : ''}" data-day="${dayKey(d)}">
          ${this._calLaneLayout(timed, d)}
          ${isToday ? `<div class="cal-now" style="top:${nowTop}px" aria-hidden="true"></div>` : ''}
        </div>`;
      }
      const nearHour = Math.abs(nowTop - Math.round(nowTop / HOUR_PX) * HOUR_PX) < 12 ? Math.round(nowTop / HOUR_PX) : -1;
      const hours = [...Array(24)].map((_, h) => `<div class="cal-hour" style="height:${HOUR_PX}px"><span${weekHasToday && h === nearHour ? ' class="under-now"' : ''}>${p2(h)}:00</span></div>`).join('');
      const hasDense = allDay.includes('cal-chip');
      return `<div class="cal-week" style="--cal-hour:${HOUR_PX}px">
        <div class="cal-wk-row cal-wk-heads"><div class="cal-gutter"></div>${head}</div>
        ${hasDense ? `<div class="cal-wk-row cal-wk-dense"><div class="cal-gutter cal-gutter-label" title="Schedules firing more than ${DENSE_PER_DAY}× that day, collapsed to one chip">Frequent</div>${allDay}</div>` : ''}
        <div class="cal-week-body"><div class="cal-wk-row" style="height:${24 * HOUR_PX}px">
          <div class="cal-gutter">${hours}${weekHasToday ? `<span class="cal-now-pill" style="top:${nowTop}px">${hhmm(now)}</span>` : ''}</div>${cols}</div></div>
      </div>`;
    },

    /** Absolutely-positioned blocks; overlapping entries share the column in lanes. */
    _calLaneLayout(events, day) {
      const dayStart = startOfDay(day).getTime();
      const MIN_MS = 30 * 60000;
      const items = events.map((e) => {
        const s = Math.max(Date.parse(e.start), dayStart);
        const rawEnd = e.end ? Date.parse(e.end) : s;
        const end = Math.min(Math.max(rawEnd, s + MIN_MS), dayStart + DAY);
        return { e, s, end };
      }).sort((a, b) => a.s - b.s || b.end - a.end);
      // Clusters of transitively-overlapping items; greedy lanes within each.
      let html = '', cluster = [], clusterEnd = -1;
      const flush = () => {
        const lanes = [];
        for (const it of cluster) {
          let l = lanes.findIndex((end) => end <= it.s);
          if (l < 0) { l = lanes.length; lanes.push(0); }
          lanes[l] = it.end; it.lane = l;
        }
        const n = lanes.length;
        for (const it of cluster) {
          const height = Math.max(22, ((it.end - it.s) / 3600000) * HOUR_PX - 2);
          const top = Math.min(((it.s - dayStart) / 3600000) * HOUR_PX, 24 * HOUR_PX - height - 1);   // keep 23:45 inside the day
          // short = one line (time + title); narrow = 3+ lanes, title only, never wraps per character.
          html += this._calChip(it.e, { block: true, short: height < 40, narrow: n >= 3,
            style: `top:${top}px;height:${height}px;left:calc(${(it.lane / n) * 100}% + 1px);width:calc(${100 / n}% - 3px)` });
        }
        cluster = []; clusterEnd = -1;
      };
      for (const it of items) {
        if (cluster.length && it.s >= clusterEnd) flush();
        cluster.push(it); clusterEnd = Math.max(clusterEnd, it.end);
      }
      if (cluster.length) flush();
      return html;
    },

    // ── agenda ─────────────────────────────────────────────────────────────

    _calAgendaHTML() {
      const byDay = this._calByDay();
      const keys = [...byDay.keys()].sort();
      if (!keys.length) {
        const c = this.cal;
        return `<div class="empty-state cal-empty"><div class="empty-state-icon"><i data-lucide="calendar-check"></i></div>
          <h3>A clear 30 days</h3>
          <p>${!c.showPlanned || !c.showAdhoc ? 'Some entry types are hidden by the Show filters above. ' : ''}Schedule a task to see it here.</p>
          <button class="btn btn-primary" data-new><i data-lucide="plus"></i> Schedule task</button></div>`;
      }
      const today = dayKey(new Date());
      return `<div class="cal-agenda">${keys.map((k) => {
        const d = new Date(`${k}T00:00:00`);
        const rows = this._calCollapse(byDay.get(k)).map((g) => {
          const e = g.e, color = CAL_COLORS[e.status] || '#94A3B8';
          const meta = [
            `<span class="cal-agenda-status">${esc(STATUS_LABEL[e.status] || e.status)}</span>`,
            e.cadence ? `<span><i data-lucide="repeat" class="cal-ico" aria-hidden="true"></i> ${esc(e.cadence)}</span>` : '',
            e.end ? `<span>${Math.max(1, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000))} min</span>` : '',
          ].filter(Boolean).join('<span class="cal-sep" aria-hidden="true">·</span>');
          return `<button class="cal-agenda-row ${e.kind}${LOUD.has(e.status) ? ' loud' : ''}${e.kind === 'planned' && e.head ? ' head' : ''}" style="--c:${color}" data-ev="${esc(e.id)}">
            <span class="cal-agenda-time">${hhmm(new Date(e.start))}</span>
            <span class="cal-agenda-bar" aria-hidden="true"></span>
            <span class="cal-agenda-body">
              <span class="cal-agenda-title">${e.status === 'overdue' ? '<span class="cal-mark" aria-hidden="true">⚠</span> ' : ''}${esc(e.title)}${g.count > 1 ? ` <span class="cal-count">×${g.count}</span>` : ''}</span>
              <span class="cal-agenda-meta">${meta}</span>
            </span>
          </button>`;
        }).join('');
        const isToday = k === today;
        return `<section class="cal-agenda-day${isToday ? ' today' : ''}" aria-label="${esc(d.toDateString())}">
          <h4 class="cal-agenda-date"${isToday ? ' aria-current="date"' : ''}><span class="cal-agenda-wd">${esc(WD[d.getDay()])}</span><span class="cal-agenda-num">${d.getDate()}</span>
            <span class="cal-agenda-mon">${isToday ? 'Today' : esc(d.toLocaleDateString(undefined, { month: 'short' }))}</span></h4>
          <div class="cal-agenda-rows">${rows}</div></section>`;
      }).join('')}</div>`;
    },

    // ── schedules rail ─────────────────────────────────────────────────────

    _calRailHTML() {
      const series = this.cal.data?.series || [];
      if (!series.length) {
        return `<h3 class="cal-rail-title">Schedules</h3>
          <div class="cal-rail-empty"><i data-lucide="calendar-clock"></i><p>No scheduled tasks yet.</p>
          <button class="btn" data-new><i data-lucide="plus"></i> Schedule task</button></div>`;
      }
      const overdueN = series.filter((s) => s.overdue).length;
      return `<h3 class="cal-rail-title">Schedules <span class="cal-rail-count">${series.length}</span>${overdueN ? `<span class="cal-rail-warn">${overdueN} overdue</span>` : ''}</h3>
        <ul class="cal-series">${series.map((s) => {
          const next = s.next ? new Date(s.next) : null;
          const last = s.lastRun;
          const nextTxt = next ? `${next.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}` : '—';
          return `<li class="cal-series-item${s.overdue ? ' overdue' : ''}">
            <button class="cal-series-main" data-open="${esc(s.taskId)}" title="${esc(`${s.title}${s.brain ? ` — ${s.brain}` : ''}`)}">
              <span class="cal-series-when${s.overdue ? ' warn' : ''}">${s.overdue ? '⚠ overdue' : next ? esc(relTime(next.getTime())) : '—'}<span class="cal-series-abs">${esc(nextTxt)}</span></span>
              <span class="cal-series-title">${esc(s.title)}</span>
              <span class="cal-series-meta">${s.recurring ? '<i data-lucide="repeat" class="cal-ico" aria-hidden="true"></i>' : ''}${esc(s.cadence)}${last ? `<span class="cal-sep" aria-hidden="true">·</span><span class="cal-series-last" style="--c:${CAL_COLORS[last.status] || '#94A3B8'}" title="Last run ${esc(STATUS_LABEL[last.status] || last.status)}"><span class="cal-dot"></span>${esc(relTime(Date.parse(last.at)))}</span>` : ''}</span>
            </button>
            <div class="cal-series-actions">
              <button class="cal-icon-btn" data-runnow="${esc(s.taskId)}" title="Run now — release this fire" aria-label="Run ${esc(s.title)} now"><i data-lucide="play"></i></button>
              <button class="cal-icon-btn" data-edit="${esc(s.taskId)}" title="Edit title, brief, time and cadence" aria-label="Edit ${esc(s.title)}"><i data-lucide="pencil"></i></button>
            </div>
          </li>`;
        }).join('')}</ul>`;
    },

    // ── detail sheet ───────────────────────────────────────────────────────

    async _calOpenDetail(evId) {
      const e = (this.cal.data?.events || []).find((x) => x.id === evId);
      if (!e) return;
      const container = document.getElementById('modal-container');
      const content = document.getElementById('modal-content');
      const series = e.seriesId ? (this.cal.data.series || []).find((s) => s.taskId === e.seriesId) : null;
      const sib = (this.cal.data.events || []).filter((x) => e.seriesId && x.seriesId === e.seriesId);
      const upcoming = sib.filter((x) => x.kind === 'planned').slice(0, 5);
      const history = sib.filter((x) => x.kind === 'run').slice(-5).reverse();
      const color = CAL_COLORS[e.status] || '#94A3B8';
      const start = new Date(e.start);
      const isHead = e.kind === 'planned' && e.head;
      const fmt = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const listRow = (x) => `<li><button class="cal-link" data-ev="${esc(x.id)}" style="--c:${CAL_COLORS[x.status]}"><span class="cal-dot"></span>${esc(fmt(x.start))}</button>
          <span class="cal-muted">${esc(STATUS_LABEL[x.status])}${x.end ? ` · ${Math.max(1, Math.round((Date.parse(x.end) - Date.parse(x.start)) / 60000))} min` : ''}</span></li>`;

      content.innerHTML = `
        <div class="cal-detail" style="--c:${color}">
          <button class="cal-icon-btn cal-detail-x" id="cal-close-x" aria-label="Close"><i data-lucide="x"></i></button>
          <div class="cal-detail-head" style="--c:${color}">
            ${badge(STATUS_LABEL[e.status] || e.status, color)}
            ${e.kind === 'planned' && !e.head ? badge('projected', '#94A3B8') : ''}
            ${e.priority && e.priority !== 'normal' ? badge(e.priority, e.priority === 'urgent' ? '#EF4444' : '#F59E0B') : ''}
          </div>
          <h3>${esc(e.title)}</h3>
          <dl class="cal-dl">
            <dt>${e.kind === 'planned' ? 'Fires' : 'Started'}</dt><dd>${esc(fmt(e.start))} <span class="cal-muted">(${relTime(start.getTime())})</span></dd>
            ${e.end ? `<dt>Finished</dt><dd>${esc(fmt(e.end))}</dd>` : ''}
            ${e.cadence || series ? `<dt>Repeats</dt><dd><i data-lucide="repeat" class="cal-ico"></i> ${esc(e.cadence || series?.cadence || '')}</dd>` : ''}
            ${e.brain ? `<dt>Brain</dt><dd><code>${esc(e.brain)}</code></dd>` : ''}
          </dl>
          ${e.kind === 'planned' && !e.head ? `<p class="cal-note">A future fire of a recurring task — it becomes a real run when its time comes. To change it, edit the schedule's cadence.</p>` : ''}
          ${isHead ? `<div class="cal-resched">
              <label for="cal-when">Move ${e.cadence ? 'the next run' : 'to'}</label>
              <input id="cal-when" type="datetime-local" value="${esc(isoToLocalInput(e.start))}">
              <button class="btn" id="cal-resched-ok"><i data-lucide="calendar-clock"></i> Reschedule</button>
            </div>${e.cadence ? `<p class="cal-note">Later runs keep the cadence's own phase — a fixed-time cadence (e.g. "every day at 08:00") snaps back after this run.</p>` : ''}` : ''}
          ${upcoming.length || history.length ? `<div class="cal-detail-lists">
            ${upcoming.length ? `<div><h5>Next runs</h5><ul>${upcoming.map(listRow).join('')}</ul></div>` : ''}
            ${history.length ? `<div><h5>Recent runs <span class="cal-muted">(this view)</span></h5><ul>${history.map(listRow).join('')}</ul></div>` : ''}
          </div>` : ''}
          <div class="cal-detail-actions">
            <a class="btn" href="#tasks/${encodeURIComponent(e.taskId)}"><i data-lucide="inbox"></i> Open in Tasks</a>
            ${e.seriesId && e.seriesId !== e.taskId ? `<a class="btn" href="#tasks/${encodeURIComponent(e.seriesId)}"><i data-lucide="repeat"></i> Open schedule</a>` : ''}
            ${e.kind === 'planned' ? `<button class="btn" data-edit="${esc(e.taskId)}"><i data-lucide="pencil"></i> Edit schedule</button>
              <button class="btn btn-primary" data-runnow="${esc(e.taskId)}"><i data-lucide="play"></i> Run now</button>` : `<button class="btn" id="cal-close">Close</button>`}
          </div>
        </div>`;
      container.classList.remove('hidden');
      createIcons();
      const close = () => container.classList.add('hidden');
      content.querySelectorAll('#cal-close, #cal-close-x').forEach((b) => { b.onclick = close; });
      container.querySelector('.modal-backdrop').onclick = close;
      content.querySelectorAll('a.btn').forEach((a) => a.addEventListener('click', close));
      content.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => this._calOpenDetail(b.dataset.ev)));
      content.querySelectorAll('[data-runnow]').forEach((b) => b.addEventListener('click', async () => { close(); await this._calRunNow(b.dataset.runnow); }));
      content.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { close(); this.editTaskModal(b.dataset.edit); }));
      content.querySelector('#cal-resched-ok')?.addEventListener('click', async () => {
        const v = content.querySelector('#cal-when').value;
        if (!v) return;
        close();
        await this._calReschedule(e.taskId, new Date(v), { confirmed: true });
      });
    },

    // ── actions ────────────────────────────────────────────────────────────

    async _calRunNow(taskId) {
      const s = (this.cal.data?.series || []).find((x) => x.taskId === taskId);
      const what = s?.recurring ? 'Run this cycle now? The schedule then re-arms to its next slot.' : 'Run this scheduled task now instead of at its set time?';
      if (!window.confirm(`${s ? s.title + '\n\n' : ''}${what}`)) return;
      try {
        await this.api.post(`/inbox/${encodeURIComponent(taskId)}/run-now`, {});
        this.toast('released', s ? s.title : 'Task released to run now.');
      } catch (err) { this.toast('error', err.message); }
      this.renderCalendar();
    },

    async _calReschedule(taskId, when, { confirmed = false } = {}) {
      if (when.getTime() <= Date.now()) { this.toast('error', 'Pick a time in the future — use Run now to run immediately.'); return; }
      const s = (this.cal.data?.series || []).find((x) => x.taskId === taskId);
      if (!confirmed) {
        const note = s?.recurring ? '\n\nThis moves the NEXT run only; later runs keep the cadence.' : '';
        if (!window.confirm(`Reschedule "${s?.title || taskId}" to ${when.toLocaleString()}?${note}`)) { this.renderCalendar(); return; }
      }
      try {
        await this.api.post(`/inbox/${encodeURIComponent(taskId)}/edit`, { scheduledAt: when.toISOString() });
        this.toast('rescheduled', `${s?.title || 'Task'} → ${when.toLocaleString()}`);
      } catch (err) { this.toast('error', err.message); }
      this.renderCalendar();
    },

    // ── wiring ─────────────────────────────────────────────────────────────

    /** Open one day: week view on desktop, agenda from that day on a phone. */
    _calGoDay(key) {
      const c = this.cal;
      c.anchor = new Date(`${key}T00:00:00`);
      c.view = isNarrow() ? 'agenda' : 'week';
      c.scrolled = false; this._calSavePrefs(); this.renderCalendar();
    },

    _calBind() {
      const root = this.contentEl, c = this.cal;
      root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
        const n = Number(b.dataset.nav);
        if (n === 0) { c.anchor = startOfDay(new Date()); c.scrolled = false; this.renderCalendar(); } else this._calShift(n);
      }));
      root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
        c.view = b.dataset.view; c.scrolled = false; this._calSavePrefs(); this.renderCalendar();
      }));
      root.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
        c[b.dataset.toggle] = !c[b.dataset.toggle]; this._calSavePrefs(); this.renderCalendar();
      }));
      root.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => this.createTaskModal()));
      root.querySelectorAll('[data-goday]').forEach((b) => b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._calGoDay(b.dataset.goday);
      }));
      root.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); this._calOpenDetail(b.dataset.ev); }));
      root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
        const head = (c.data?.events || []).find((e) => e.taskId === b.dataset.open && e.head);
        if (head) this._calOpenDetail(head.id); else window.location.hash = `#tasks/${encodeURIComponent(b.dataset.open)}`;
      }));
      root.querySelectorAll('[data-runnow]').forEach((b) => b.addEventListener('click', () => this._calRunNow(b.dataset.runnow)));
      root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => this.editTaskModal(b.dataset.edit)));

      // Click empty space → New task pre-filled with that time.
      root.querySelectorAll('.cal-day').forEach((cell) => cell.addEventListener('click', (ev) => {
        if (ev.target.closest('.cal-chip, .cal-more, .cal-date')) return;
        if (isNarrow()) { this._calGoDay(cell.dataset.day); return; }   // phone: chips are dots — tap opens the day
        const d = new Date(`${cell.dataset.day}T09:00:00`);
        if (d.getTime() <= Date.now()) d.setTime(Date.now() + 3600000 - (Date.now() % 900000));
        this.createTaskModal({ scheduledAt: d.toISOString() });
      }));
      const slotTime = (col, clientY) => {
        const y = clientY - col.getBoundingClientRect().top;
        const mins = Math.max(0, Math.min(24 * 60 - 15, Math.round((y / HOUR_PX) * 4) * 15));
        const d = new Date(`${col.dataset.day}T00:00:00`);
        d.setMinutes(mins);
        return d;
      };
      root.querySelectorAll('.cal-wk-col').forEach((col) => col.addEventListener('click', (ev) => {
        if (ev.target.closest('.cal-chip')) return;
        const d = slotTime(col, ev.clientY);
        if (d.getTime() <= Date.now()) { this.toast('past', 'Pick a future slot to schedule a task.'); return; }
        this.createTaskModal({ scheduledAt: d.toISOString() });
      }));

      // Drag a scheduled task's next fire to a new day (month: keeps time of day) or slot (week).
      root.querySelectorAll('[data-move]').forEach((chip) => chip.addEventListener('dragstart', (ev) => {
        const e = c.data.events.find((x) => x.id === chip.dataset.ev);
        ev.dataTransfer.setData('text/plain', JSON.stringify({ taskId: chip.dataset.move, start: e?.start }));
        ev.dataTransfer.effectAllowed = 'move';
        root.classList.add('cal-dragging');
      }));
      root.addEventListener('dragend', () => root.classList.remove('cal-dragging'));
      const dropTarget = (el, toDate) => {
        el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.classList.add('drop'); });
        el.addEventListener('dragleave', () => el.classList.remove('drop'));
        el.addEventListener('drop', (ev) => {
          ev.preventDefault(); el.classList.remove('drop');
          let p; try { p = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
          if (!p?.taskId) return;
          this._calReschedule(p.taskId, toDate(ev, p));
        });
      };
      root.querySelectorAll('.cal-day').forEach((cell) => dropTarget(cell, (ev, p) => {
        const old = new Date(p.start), d = new Date(`${cell.dataset.day}T00:00:00`);
        d.setHours(old.getHours(), old.getMinutes());
        return d;
      }));
      root.querySelectorAll('.cal-wk-col').forEach((col) => dropTarget(col, (ev) => slotTime(col, ev.clientY)));

      // Keyboard shortcuts (one listener for the app's lifetime; inert off-page).
      if (!this._calKeys) {
        this._calKeys = true;
        document.addEventListener('keydown', (ev) => {
          if (this.currentView !== 'calendar' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
          const t = ev.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
          if (!document.getElementById('modal-container')?.classList.contains('hidden')) return;
          const k = ev.key.toLowerCase();
          if (ev.key === 'ArrowLeft') this._calShift(-1);
          else if (ev.key === 'ArrowRight') this._calShift(1);
          else if (k === 't') { this.cal.anchor = startOfDay(new Date()); this.cal.scrolled = false; this.renderCalendar(); }
          else if (k === 'm' || k === 'w' || k === 'a') {
            this.cal.view = { m: 'month', w: 'week', a: 'agenda' }[k]; this.cal.scrolled = false; this._calSavePrefs(); this.renderCalendar();
          }
        });
      }
    },
  });
})();
