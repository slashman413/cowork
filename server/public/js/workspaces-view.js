/**
 * Workspaces & Continuous Working Sessions (#workspaces) — DSH Web UX.
 *
 * Mirrors dsh-web's workspace tree + continuous working session stream, layered
 * directly on top of Cowork tasks with automatic vendored pstack skill injection.
 *
 * Routes:
 *   #workspaces                                — workspace navigator + active session
 *   #workspaces/new                            — inline New Workspace form
 *   #workspaces/<wsId>                         — active workspace (last/first session or tasks)
 *   #workspaces/<wsId>/tasks                   — workspace-scoped task management
 *   #workspaces/<wsId>/settings                — workspace settings & pstack skill config
 *   #workspaces/<wsId>/sessions/<sessionId>    — continuous working session view
 *
 * Loaded after app.js; extends App.prototype.
 */
(() => {
  const enc = encodeURIComponent;
  const PREFS_KEY = 'cowork-ws-prefs';

  const SESSION_STATE_MAP = {
    working: { label: 'Working', dot: 'in-progress' },
    idle: { label: 'Ready', dot: 'done' },
    'wait-input': { label: 'Needs input', dot: 'wait-input' },
    paused: { label: 'Paused', dot: 'paused' },
    error: { label: 'Needs attention', dot: 'failed' },
    archived: { label: 'Archived', dot: 'scheduled' },
  };

  function sessionStateDot(st) {
    return (SESSION_STATE_MAP[st] || SESSION_STATE_MAP.idle).dot;
  }
  function sessionStateLabel(st) {
    return (SESSION_STATE_MAP[st] || SESSION_STATE_MAP.idle).label;
  }

  function renderMarkdownSafe(text) {
    const raw = String(text || '');
    if (window.marked && window.DOMPurify) {
      try {
        return window.DOMPurify.sanitize(window.marked.parse(raw));
      } catch { /* fall through */ }
    }
    return `<pre style="white-space:pre-wrap">${esc(raw)}</pre>`;
  }

  Object.assign(App.prototype, {
    _wsPrefs() {
      return this._dshLoadPrefs(PREFS_KEY, {
        lastWorkspaceId: null,
        lastSessionId: null,
        collapsed: {},
      });
    },

    _saveWsPrefs(patch) {
      this._dshSavePrefs(PREFS_KEY, patch);
    },

    _parseWorkspacesHash() {
      const raw = (window.location.hash || '').replace(/^#/, '');
      const parts = raw.split('/').map(p => decodeURIComponent(p));
      if (parts[0] !== 'workspaces') return { mode: 'root' };
      if (parts[1] === 'new') return { mode: 'new-workspace' };
      if (!parts[1]) return { mode: 'root' };
      const workspaceId = parts[1];
      if (parts[2] === 'tasks') return { mode: 'tasks', workspaceId };
      if (parts[2] === 'settings') return { mode: 'settings', workspaceId };
      if (parts[2] === 'sessions' && parts[3]) return { mode: 'session', workspaceId, sessionId: parts[3] };
      return { mode: 'workspace', workspaceId };
    },

    _wsScheduleRefresh() {
      clearTimeout(this._wsRefreshTimer);
      this._wsRefreshTimer = setTimeout(() => {
        if (this.currentPage?.type !== 'workspaces') return;
        const el = document.activeElement;
        const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
        if (typing) {
          // Only patch live progress / sidebar tree status without clobbering composer
          this._wsRefreshLiveOnly().catch(() => {});
        } else {
          this.renderWorkspaces({ soft: true }).catch(() => {});
        }
      }, 700);
    },

    async _wsRefreshLiveOnly() {
      const workspaces = await this.api.get('/workspaces').catch(() => null);
      if (!Array.isArray(workspaces)) return;
      this._wsCache = workspaces;
      const treeEl = this.contentEl?.querySelector('#ws-tree-root');
      if (treeEl) {
        treeEl.innerHTML = this._wsTreeHTML(workspaces);
        this._wsBindTree(treeEl);
        createIcons(treeEl);
      }
      if (this._wsActiveSessionId) {
        const sess = await this.api.get(`/sessions/${enc(this._wsActiveSessionId)}`).catch(() => null);
        if (sess) {
          this._wsCurrentSession = sess;
          const turnsEl = this.contentEl?.querySelector('#ws-turns-inner');
          if (turnsEl) {
            turnsEl.innerHTML = this._wsTurnsHTML(sess, this._wsFind(sess.workspaceId));
            this._wsBindTurnActions(turnsEl);
            createIcons(turnsEl);
            this._wsPollActiveProgress();
          }
        }
      }
    },

    _wsFind(id) {
      return (this._wsCache || []).find(w => w.id === id) || null;
    },

    async renderWorkspaces({ soft = false } = {}) {
      const route = this._parseWorkspacesHash();
      const prefs = this._wsPrefs();

      const [workspaces, agents, pstack] = await Promise.all([
        this.api.get('/workspaces').catch(() => []),
        this._wsAgents ? Promise.resolve(this._wsAgents) : this.api.get('/agents').catch(() => ({})),
        this._wsPstack ? Promise.resolve(this._wsPstack) : this.api.get('/pstack').catch(() => ({ skills: [], playbooks: [] })),
      ]);
      this._wsCache = Array.isArray(workspaces) ? workspaces : [];
      this._wsAgents = agents || {};
      this._wsPstack = pstack || { skills: [], playbooks: [] };

      let activeWsId = route.workspaceId || this._wsActiveId || prefs.lastWorkspaceId || this._wsCache[0]?.id || null;
      if (activeWsId && !this._wsCache.some(w => w.id === activeWsId)) {
        activeWsId = this._wsCache[0]?.id || null;
      }

      let activeMode = route.mode;
      let activeSessionId = route.sessionId || null;

      if (activeMode === 'root' || activeMode === 'workspace') {
        const ws = this._wsFind(activeWsId);
        if (!ws) {
          activeMode = 'empty';
        } else if (ws.sessions?.length) {
          const preferred = (prefs.lastSessionId && ws.sessions.some(s => s.id === prefs.lastSessionId))
            ? prefs.lastSessionId
            : ws.sessions[0].id;
          activeSessionId = preferred;
          activeMode = 'session';
        } else {
          activeMode = 'tasks';
        }
      }

      this._wsActiveId = activeWsId;
      this._wsActiveSessionId = activeSessionId;
      this._wsMode = activeMode;
      if (activeWsId) this._saveWsPrefs({ lastWorkspaceId: activeWsId, ...(activeSessionId ? { lastSessionId: activeSessionId } : {}) });

      // Mobile master-detail mode: show navigator list on bare #workspaces when narrow,
      // and show detail pane when a specific workspace/session/new-workspace route is opened.
      const isNarrow = window.innerWidth <= 960;
      const mobilePane = (route.mode === 'root' && isNarrow && this._wsCache.length > 0 && !this._wsForceDetail)
        ? 'list'
        : ((route.mode !== 'root' || !isNarrow || this._wsCache.length === 0 || this._wsForceDetail) ? 'detail' : 'list');
      this._wsForceDetail = false;

      let sessionDetail = null;
      let workspaceTasks = [];
      if (activeMode === 'session' && activeSessionId) {
        sessionDetail = await this.api.get(`/sessions/${enc(activeSessionId)}`).catch(() => null);
        this._wsCurrentSession = sessionDetail;
      } else {
        this._wsCurrentSession = null;
      }
      if (activeMode === 'tasks' && activeWsId) {
        const q = this._wsTaskFilter ? `?status=${enc(this._wsTaskFilter)}` : '';
        const res = await this.api.get(`/workspaces/${enc(activeWsId)}/tasks${q}`).catch(() => ({ tasks: [] }));
        workspaceTasks = Array.isArray(res?.tasks) ? res.tasks : [];
      }

      const activeWs = this._wsFind(activeWsId);
      const pageEl = this.contentEl.querySelector('#workspaces-page');
      if (!pageEl || !soft) {
        this.contentEl.innerHTML = `
          <div class="dsh-page ws-page" id="workspaces-page" data-mode="${mobilePane}">
            <aside class="ws-nav-pane" aria-label="Workspaces and sessions">
              <div class="ws-nav-head">
                <div class="ws-nav-switch-row">
                  ${this._dshWorkspaceSwitcherHTML('workspaces')}
                </div>
                <div class="ws-nav-head-row">
                  <label class="dsh-search-wrap" aria-label="Filter workspaces and sessions">
                    <i data-lucide="search"></i>
                    <input id="ws-search-input" class="dsh-search-input" type="search" placeholder="Filter workspaces & sessions…" value="${esc(this._wsSearch || '')}">
                  </label>
                  <button type="button" class="dsh-btn-primary" id="ws-new-btn" title="Create workspace">
                    <i data-lucide="plus"></i><span>New</span>
                  </button>
                </div>
              </div>
              <div class="ws-nav-scroll">
                <div class="ws-tree" id="ws-tree-root"></div>
              </div>
            </aside>
            <div class="dsh-split-handle" role="separator" aria-orientation="vertical" aria-label="Resize workspaces sidebar"></div>
            <section class="ws-main-pane" id="ws-main-pane" aria-label="Active workspace"></section>
          </div>`;

        this._dshAttachSplitHandle(this.contentEl.querySelector('#workspaces-page'), 'cowork-ws-nav-w');

        this.contentEl.querySelector('#ws-new-btn')?.addEventListener('click', () => {
          this._wsForceDetail = true;
          location.hash = '#workspaces/new';
        });

        this.contentEl.querySelector('#ws-search-input')?.addEventListener('input', (ev) => {
          this._wsSearch = ev.target.value;
          const tEl = this.contentEl.querySelector('#ws-tree-root');
          if (tEl) {
            tEl.innerHTML = this._wsTreeHTML(this._wsCache || []);
            this._wsBindTree(tEl);
            createIcons(tEl);
          }
        });
      } else {
        pageEl.dataset.mode = mobilePane;
      }

      const treeEl = this.contentEl.querySelector('#ws-tree-root');
      if (treeEl) {
        treeEl.innerHTML = this._wsTreeHTML(this._wsCache);
        this._wsBindTree(treeEl);
      }

      const mainEl = this.contentEl.querySelector('#ws-main-pane');
      if (mainEl) {
        if (activeMode === 'new-workspace') {
          this._wsRenderNewWorkspace(mainEl);
        } else if (!activeWs) {
          this._wsRenderEmpty(mainEl);
        } else if (activeMode === 'settings') {
          this._wsRenderSettings(mainEl, activeWs);
        } else if (activeMode === 'tasks') {
          this._wsRenderTasksPane(mainEl, activeWs, workspaceTasks);
        } else if (activeMode === 'session' && sessionDetail) {
          this._wsRenderSessionPane(mainEl, activeWs, sessionDetail);
        } else {
          this._wsRenderTasksPane(mainEl, activeWs, workspaceTasks);
        }
      }

      createIcons(this.contentEl);

      // Live progress polling for active session turn
      this.clearViewTimers();
      if (activeMode === 'session' && sessionDetail?.activeTaskId) {
        this._wsPollActiveProgress();
        this.addViewTimer(() => this._wsPollActiveProgress(), 2500);
      }
    },

    _wsTreeHTML(workspaces) {
      const q = (this._wsSearch || '').trim().toLowerCase();
      const collapsed = this._wsPrefs().collapsed || {};
      if (!workspaces.length) {
        return `<div class="dsh-empty-detail" style="padding:28px 14px">
          <i data-lucide="folder-kanban"></i>
          <p>No workspaces yet. Create one to organize continuous agent sessions and scoped tasks.</p>
          <button type="button" class="dsh-btn-primary" data-ws-open-new><i data-lucide="plus"></i><span>New workspace</span></button>
        </div>`;
      }

      const blocks = [];
      for (const ws of workspaces) {
        const wsMatch = !q || ws.name.toLowerCase().includes(q) || (ws.path || '').toLowerCase().includes(q);
        const sessions = (ws.sessions || []).filter(s => wsMatch || s.title.toLowerCase().includes(q));
        if (!wsMatch && !sessions.length) continue;

        const isCollapsed = !!collapsed[ws.id] && !q;
        const isWsActive = this._wsActiveId === ws.id;
        blocks.push(`
          <div class="ws-tree-group" data-ws-id="${esc(ws.id)}">
            <div class="ws-tree-head${isWsActive ? ' is-active' : ''}" data-ws-select="${esc(ws.id)}">
              <button type="button" class="ws-tree-toggle" data-ws-collapse="${esc(ws.id)}" aria-label="${isCollapsed ? 'Expand' : 'Collapse'} workspace" aria-expanded="${!isCollapsed}">
                <i data-lucide="${isCollapsed ? 'chevron-right' : 'chevron-down'}"></i>
              </button>
              <div class="ws-tree-info">
                <div class="ws-tree-name-row">
                  <i data-lucide="folder"></i>
                  <span class="ws-tree-name" title="${esc(ws.name)}">${esc(ws.name)}</span>
                </div>
                ${ws.path ? `<div class="ws-tree-path" title="${esc(ws.path)}">${esc(ws.path)}</div>` : ''}
              </div>
              <div class="ws-tree-actions">
                <button type="button" class="ws-mini-btn" data-ws-new-session="${esc(ws.id)}" title="New session in ${esc(ws.name)}" aria-label="New session">
                  <i data-lucide="plus"></i>
                </button>
                <button type="button" class="ws-mini-btn" data-ws-settings="${esc(ws.id)}" title="Workspace settings" aria-label="Workspace settings">
                  <i data-lucide="settings"></i>
                </button>
              </div>
            </div>
            ${isCollapsed ? '' : `
              <div class="ws-tree-children">
                ${sessions.map(s => {
                  const sel = this._wsMode === 'session' && this._wsActiveSessionId === s.id;
                  return `<div class="ws-tree-item${sel ? ' is-selected' : ''}" data-ws-open-session="${esc(ws.id)}:${esc(s.id)}">
                    <span class="dsh-dot" data-state="${esc(sessionStateDot(s.status))}" title="${esc(sessionStateLabel(s.status))}"></span>
                    <div class="ws-tree-item-body">
                      <div class="ws-tree-item-title">${s.pinned ? '📌 ' : ''}${esc(s.title)}</div>
                      <div class="ws-tree-item-meta">
                        <span>${s.turnCount || 0} turn${s.turnCount === 1 ? '' : 's'}</span>
                        <span>·</span>
                        <span>${esc(timeAgo(s.updatedAt))}</span>
                      </div>
                    </div>
                    <div class="ws-tree-item-actions">
                      <button type="button" class="ws-mini-btn${s.pinned ? ' is-pinned' : ''}" data-ws-pin-session="${esc(s.id)}:${s.pinned ? '0' : '1'}" title="${s.pinned ? 'Unpin' : 'Pin session'}" aria-label="Pin session"><i data-lucide="pin"></i></button>
                      <button type="button" class="ws-mini-btn" data-ws-fork-session="${esc(s.id)}" title="Fork session" aria-label="Fork session"><i data-lucide="git-branch"></i></button>
                      <button type="button" class="ws-mini-btn is-danger" data-ws-del-session="${esc(s.id)}" title="Delete session" aria-label="Delete session"><i data-lucide="trash-2"></i></button>
                    </div>
                  </div>`;
                }).join('')}
                ${!sessions.length ? `<button type="button" class="ws-tree-tasks-link" data-ws-new-session="${esc(ws.id)}" style="border:0;background:transparent;width:100%;text-align:left">
                  <span class="ws-tree-tasks-link-left"><i data-lucide="message-square"></i><span>Start first session…</span></span>
                </button>` : ''}
                <a class="ws-tree-tasks-link${isWsActive && this._wsMode === 'tasks' ? ' is-selected' : ''}" href="#workspaces/${enc(ws.id)}/tasks" data-ws-open-tasks="${esc(ws.id)}">
                  <span class="ws-tree-tasks-link-left"><i data-lucide="inbox"></i><span>Tasks</span></span>
                  <span class="ws-count-pill">${ws.taskCount || 0}</span>
                </a>
              </div>
            `}
          </div>`);
      }
      return blocks.join('') || `<div class="dsh-empty-detail" style="padding:20px 12px"><p>No workspaces match "${esc(this._wsSearch)}".</p></div>`;
    },

    _wsBindTree(treeEl) {
      treeEl.querySelectorAll('[data-ws-open-new]').forEach(btn =>
        btn.addEventListener('click', () => { this._wsForceDetail = true; location.hash = '#workspaces/new'; }));

      treeEl.querySelectorAll('[data-ws-collapse]').forEach(btn =>
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const id = btn.dataset.wsCollapse;
          const prefs = this._wsPrefs();
          const collapsed = { ...(prefs.collapsed || {}), [id]: !prefs.collapsed?.[id] };
          this._saveWsPrefs({ collapsed });
          treeEl.innerHTML = this._wsTreeHTML(this._wsCache || []);
          this._wsBindTree(treeEl);
          createIcons(treeEl);
        }));

      treeEl.querySelectorAll('[data-ws-select]').forEach(el =>
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('button')) return;
          const id = el.dataset.wsSelect;
          const ws = this._wsFind(id);
          this._wsForceDetail = true;
          if (ws?.sessions?.length) {
            location.hash = `#workspaces/${enc(id)}/sessions/${enc(ws.sessions[0].id)}`;
          } else {
            location.hash = `#workspaces/${enc(id)}/tasks`;
          }
        }));

      treeEl.querySelectorAll('[data-ws-new-session]').forEach(btn =>
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const wsId = btn.dataset.wsNewSession;
          btn.disabled = true;
          try {
            const out = await this.api.post(`/workspaces/${enc(wsId)}/sessions`, { title: 'New session' });
            this._wsForceDetail = true;
            location.hash = `#workspaces/${enc(wsId)}/sessions/${enc(out.session.id)}`;
            await this.renderWorkspaces();
          } catch (err) {
            btn.disabled = false;
            this.toast('error', err.message);
          }
        }));

      treeEl.querySelectorAll('[data-ws-settings]').forEach(btn =>
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._wsForceDetail = true;
          location.hash = `#workspaces/${enc(btn.dataset.wsSettings)}/settings`;
        }));

      treeEl.querySelectorAll('[data-ws-open-session]').forEach(el =>
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('button')) return;
          const [wsId, sessId] = el.dataset.wsOpenSession.split(':');
          this._wsForceDetail = true;
          location.hash = `#workspaces/${enc(wsId)}/sessions/${enc(sessId)}`;
        }));

      treeEl.querySelectorAll('[data-ws-open-tasks]').forEach(el =>
        el.addEventListener('click', () => { this._wsForceDetail = true; }));

      treeEl.querySelectorAll('[data-ws-pin-session]').forEach(btn =>
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const [sessId, pinVal] = btn.dataset.wsPinSession.split(':');
          try {
            await this.api.patch(`/sessions/${enc(sessId)}`, { pinned: pinVal === '1' });
            await this.renderWorkspaces({ soft: true });
          } catch (err) { this.toast('error', err.message); }
        }));

      treeEl.querySelectorAll('[data-ws-fork-session]').forEach(btn =>
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const sessId = btn.dataset.wsForkSession;
          try {
            const forked = await this.api.post(`/sessions/${enc(sessId)}/fork`, {});
            this.toast('session forked', forked.title);
            this._wsForceDetail = true;
            location.hash = `#workspaces/${enc(forked.workspaceId)}/sessions/${enc(forked.id)}`;
            await this.renderWorkspaces();
          } catch (err) { this.toast('error', err.message); }
        }));

      treeEl.querySelectorAll('[data-ws-del-session]').forEach(btn =>
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const sessId = btn.dataset.wsDelSession;
          if (!confirm('Delete this session? Its linked cowork tasks stay in the workspace history.')) return;
          try {
            await this.api.del(`/sessions/${enc(sessId)}`);
            this.toast('session deleted', 'Removed session');
            if (this._wsActiveSessionId === sessId) {
              location.hash = `#workspaces/${enc(this._wsActiveId || '')}/tasks`;
            } else {
              await this.renderWorkspaces({ soft: true });
            }
          } catch (err) { this.toast('error', err.message); }
        }));
    },

    _wsHeaderHTML(ws, mode, extraRight = '', subtitle = '') {
      const wsOpts = (this._wsCache || []).map(w =>
        `<option value="${esc(w.id)}"${w.id === ws.id ? ' selected' : ''}>${esc(w.name)}</option>`).join('');
      const hasSession = ws.sessions?.length > 0;
      return `
        <header class="ws-header-bar">
          <div class="ws-header-left">
            <button type="button" class="dsh-back-btn ws-back-btn" id="ws-mobile-back" aria-label="Back to workspaces">
              <i data-lucide="arrow-left"></i><span>Workspaces</span>
            </button>
            <select id="ws-header-switch" class="ws-ws-select" aria-label="Switch workspace">${wsOpts}</select>
            ${subtitle ? `<span class="ws-session-heading" title="${esc(subtitle)}">${esc(subtitle)}</span>` : ''}
          </div>
          <div class="ws-header-right">
            <div class="ws-mode-tabs" role="tablist" aria-label="Workspace view">
              <button type="button" class="ws-mode-tab${mode === 'session' ? ' is-active' : ''}" data-ws-mode="session" role="tab" aria-selected="${mode === 'session'}">
                <i data-lucide="message-square"></i><span>Session${hasSession ? '' : ' +'}</span>
              </button>
              <button type="button" class="ws-mode-tab${mode === 'tasks' ? ' is-active' : ''}" data-ws-mode="tasks" role="tab" aria-selected="${mode === 'tasks'}">
                <i data-lucide="inbox"></i><span>Tasks (${ws.taskCount || 0})</span>
              </button>
              <button type="button" class="ws-mode-tab${mode === 'settings' ? ' is-active' : ''}" data-ws-mode="settings" role="tab" aria-selected="${mode === 'settings'}">
                <i data-lucide="settings"></i><span>Settings</span>
              </button>
            </div>
            ${extraRight}
          </div>
        </header>`;
    },

    _wsBindHeader(container, ws) {
      container.querySelector('#ws-mobile-back')?.addEventListener('click', () => {
        const page = this.contentEl.querySelector('#workspaces-page');
        if (page) page.dataset.mode = 'list';
        history.replaceState(null, '', '#workspaces');
      });

      container.querySelector('#ws-header-switch')?.addEventListener('change', (ev) => {
        const nextWsId = ev.target.value;
        const nextWs = this._wsFind(nextWsId);
        this._wsForceDetail = true;
        if (nextWs?.sessions?.length) {
          location.hash = `#workspaces/${enc(nextWsId)}/sessions/${enc(nextWs.sessions[0].id)}`;
        } else {
          location.hash = `#workspaces/${enc(nextWsId)}/tasks`;
        }
      });

      container.querySelectorAll('[data-ws-mode]').forEach(btn =>
        btn.addEventListener('click', async () => {
          const m = btn.dataset.wsMode;
          this._wsForceDetail = true;
          if (m === 'tasks') {
            location.hash = `#workspaces/${enc(ws.id)}/tasks`;
          } else if (m === 'settings') {
            location.hash = `#workspaces/${enc(ws.id)}/settings`;
          } else if (m === 'session') {
            if (ws.sessions?.length) {
              const sid = this._wsActiveSessionId && ws.sessions.some(s => s.id === this._wsActiveSessionId)
                ? this._wsActiveSessionId : ws.sessions[0].id;
              location.hash = `#workspaces/${enc(ws.id)}/sessions/${enc(sid)}`;
            } else {
              try {
                const out = await this.api.post(`/workspaces/${enc(ws.id)}/sessions`, { title: 'New session' });
                location.hash = `#workspaces/${enc(ws.id)}/sessions/${enc(out.session.id)}`;
                await this.renderWorkspaces();
              } catch (err) { this.toast('error', err.message); }
            }
          }
        }));
    },

    _wsRenderEmpty(mainEl) {
      mainEl.innerHTML = `
        <div class="dsh-empty-detail" style="margin:auto;max-width:460px">
          <i data-lucide="folder-kanban"></i>
          <h3 style="color:var(--dsw-label-primary);font-size:16px">Workspaces</h3>
          <p>Organize continuous, resumable agentic sessions and scoped tasks in workspaces — with automatic vendored pstack skills guiding every turn.</p>
          <button type="button" class="dsh-btn-primary" id="ws-empty-create"><i data-lucide="plus"></i><span>Create your first workspace</span></button>
        </div>`;
      mainEl.querySelector('#ws-empty-create')?.addEventListener('click', () => {
        this._wsForceDetail = true;
        location.hash = '#workspaces/new';
      });
    },

    _wsRenderNewWorkspace(mainEl) {
      const agentOpts = [`<option value="">Auto — route via agent chain</option>`]
        .concat(selectableAgentIds(this._wsAgents || {}).map(id => `<option value="${esc(id)}">${esc(id)}</option>`)).join('');

      mainEl.innerHTML = `
        <header class="ws-header-bar">
          <div class="ws-header-left">
            <button type="button" class="dsh-back-btn ws-back-btn" id="ws-new-back"><i data-lucide="arrow-left"></i><span>Workspaces</span></button>
            <span class="ws-session-heading">New Workspace</span>
          </div>
          <div class="ws-header-right">
            <button type="button" class="dsh-btn-ghost" id="ws-new-cancel">Cancel</button>
            <button type="button" class="dsh-btn-primary" id="ws-new-submit"><i data-lucide="plus"></i><span>Create workspace</span></button>
          </div>
        </header>
        <div class="ws-panel-scroll">
          <div class="ws-panel-inner">
            <form class="ws-card" id="ws-new-form" novalidate>
              <div class="dsh-inline-field">
                <label for="ws-f-name">Workspace name *</label>
                <input id="ws-f-name" placeholder="e.g. cowork-core, mobile-redesign, research" autocomplete="off" required>
              </div>
              <div class="dsh-inline-field">
                <label for="ws-f-path">Project directory path (optional)</label>
                <input id="ws-f-path" placeholder="/home/wayne/workspace/..." autocomplete="off">
              </div>
              <div class="dsh-inline-field">
                <label for="ws-f-desc">Workspace brief / conventions (optional)</label>
                <textarea id="ws-f-desc" rows="3" placeholder="Shared context injected into every session and task in this workspace…"></textarea>
              </div>
              <div class="dsh-inline-drawer-grid">
                <div class="dsh-inline-field">
                  <label for="ws-f-agent">Default agent</label>
                  <select id="ws-f-agent">${agentOpts}</select>
                </div>
                <div class="dsh-inline-field">
                  <label for="ws-f-thinking">Default thinking</label>
                  <select id="ws-f-thinking">${thinkingOptions()}</select>
                </div>
              </div>
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-label-primary);cursor:pointer">
                <input type="checkbox" id="ws-f-pstack" checked>
                <span><strong>Auto-inject vendored pstack skills</strong> into workspace session turns</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-label-secondary);cursor:pointer">
                <input type="checkbox" id="ws-f-start-session" checked>
                <span>Open an initial continuous session immediately</span>
              </label>
              <div class="dsh-inline-err" id="ws-new-err" role="alert"></div>
            </form>
          </div>
        </div>`;

      const goBack = () => {
        if (this._wsActiveId) location.hash = `#workspaces/${enc(this._wsActiveId)}`;
        else location.hash = '#workspaces';
      };
      mainEl.querySelector('#ws-new-back')?.addEventListener('click', goBack);
      mainEl.querySelector('#ws-new-cancel')?.addEventListener('click', goBack);

      const submit = async () => {
        const nameEl = mainEl.querySelector('#ws-f-name');
        const errEl = mainEl.querySelector('#ws-new-err');
        const btn = mainEl.querySelector('#ws-new-submit');
        const name = nameEl.value.trim();
        const dirPath = mainEl.querySelector('#ws-f-path').value.trim();
        if (!name && !dirPath) {
          errEl.textContent = 'Workspace name (or directory path) is required.';
          nameEl.focus();
          return;
        }
        btn.disabled = true;
        errEl.textContent = '';
        try {
          const ws = await this.api.post('/workspaces', {
            name: name || undefined,
            path: dirPath || undefined,
            description: mainEl.querySelector('#ws-f-desc').value.trim() || undefined,
            defaultAgent: mainEl.querySelector('#ws-f-agent').value || undefined,
            defaultThinking: mainEl.querySelector('#ws-f-thinking').value || undefined,
            pstackAutoSkills: mainEl.querySelector('#ws-f-pstack').checked,
          });
          this._wsForceDetail = true;
          if (mainEl.querySelector('#ws-f-start-session').checked) {
            const out = await this.api.post(`/workspaces/${enc(ws.id)}/sessions`, { title: 'New session' });
            this.toast('workspace created', ws.name);
            location.hash = `#workspaces/${enc(ws.id)}/sessions/${enc(out.session.id)}`;
          } else {
            this.toast('workspace created', ws.name);
            location.hash = `#workspaces/${enc(ws.id)}/tasks`;
          }
          await this.renderWorkspaces();
        } catch (err) {
          btn.disabled = false;
          errEl.textContent = err.message;
        }
      };

      mainEl.querySelector('#ws-new-submit')?.addEventListener('click', submit);
      mainEl.querySelector('#ws-new-form')?.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });
      mainEl.querySelector('#ws-f-name')?.focus();
    },

    _wsTurnsHTML(session, ws) {
      const turns = session.turns || [];
      if (!turns.length) {
        const starters = [
          'Architect the next feature and outline types & verification steps',
          'Audit recent changes for blast radius and potential regressions',
          'Debug a failing test from root causes and verify the fix end-to-end',
        ];
        return `
          <div class="ws-welcome">
            <h3><i data-lucide="sparkles"></i><span>${esc(session.title)}</span></h3>
            <p>Continuous working session in <strong>${esc(ws?.name || 'Workspace')}</strong>${ws?.path ? ` · <code>${esc(ws.path)}</code>` : ''}.</p>
            <p>Every message runs as a tracked Cowork turn with carried-over transcript context and <strong>${session.autoPstackSkills !== false ? 'automatic vendored pstack skill injection' : 'manual pstack skills'}</strong> — no manual <code>context.skill</code> flag required.</p>
            <div class="ws-starter-chips">
              ${starters.map(s => `<button type="button" class="ws-starter-chip" data-ws-starter="${esc(s)}">${esc(s)}</button>`).join('')}
            </div>
          </div>`;
      }

      return turns.map((turn, i) => {
        const isLast = i === turns.length - 1;
        const isActive = turn.status === 'pending' || turn.status === 'running';
        const skills = Array.isArray(turn.pstackSkills) ? turn.pstackSkills : [];
        const reasons = turn.pstackReasons || {};
        const statusDot = turn.status === 'done' ? 'done'
          : turn.status === 'failed' ? 'failed'
          : turn.status === 'wait-input' ? 'wait-input'
          : turn.status === 'paused' ? 'paused'
          : 'in-progress';
        const statusLabel = turn.status === 'done' ? 'Completed'
          : turn.status === 'failed' ? 'Failed'
          : turn.status === 'wait-input' ? 'Waiting for your input'
          : turn.status === 'paused' ? 'Paused'
          : turn.status === 'running' ? 'Working…'
          : 'Queued…';

        return `
          <article class="ws-turn" data-turn-id="${esc(turn.id)}">
            <div class="ws-turn-user">
              <div class="ws-turn-user-meta">
                <span>Turn #${turn.index}</span>
                <span>${esc(timeAgo(turn.createdAt))}</span>
              </div>
              <div class="ws-turn-user-text">${esc(turn.prompt)}</div>
            </div>
            <div class="ws-turn-agent">
              <div class="ws-turn-agent-head">
                <div class="ws-turn-agent-head-left">
                  <span class="dsh-dot" data-state="${esc(statusDot)}"></span>
                  <strong style="color:var(--dsw-label-primary)">${esc(statusLabel)}</strong>
                  ${turn.agent ? `<span class="dsh-tag">${esc(shortAgent(turn.agent))}</span>` : ''}
                  ${turn.completedAt ? `<span>· ${esc(timeAgo(turn.completedAt))}</span>` : ''}
                </div>
                ${turn.taskId ? `<a class="dsh-btn-ghost" href="#tasks/${enc(turn.taskId)}" style="height:24px;padding:0 8px;font-size:11.5px">Task ${esc(turn.taskId.slice(0, 8))}</a>` : ''}
              </div>
              ${skills.length ? `
                <div class="ws-pstack-strip" aria-label="Auto-injected pstack skills">
                  ${skills.map(sk => `<span class="ws-pstack-pill" title="${esc(reasons[sk] || 'Auto-resolved vendored pstack skill')}"><i data-lucide="sparkles"></i><span>${esc(sk)}</span></span>`).join('')}
                </div>` : ''}
              ${isActive && isLast && turn.taskId ? `
                <div class="dsh-terminal" data-ws-progress="${esc(turn.taskId)}">
                  <div class="dsh-terminal-head">
                    <span class="dsh-dot" data-state="in-progress"></span>
                    <span>Live session execution</span>
                  </div>
                  <pre class="dsh-terminal-body" id="ws-live-log">Waiting for agent output…</pre>
                </div>` : ''}
              ${turn.status === 'wait-input' ? `
                <div class="dsh-callout is-warn">
                  <strong>Agent asked for input.</strong> Reply in the session composer below to answer and resume automatically.
                </div>` : ''}
              ${turn.response ? `<div class="ws-turn-markdown">${renderMarkdownSafe(turn.response)}</div>` : ''}
              ${(turn.outputs?.length || turn.artifacts?.length) ? `
                <div class="dsh-chips">
                  ${(turn.outputs || []).map(f => `<a class="dsh-tag is-success" href="/api/inbox/${enc(turn.taskId)}/artifacts/outputs/${enc(f)}" target="_blank" rel="noopener">📦 ${esc(f)}</a>`).join('')}
                  ${(turn.artifacts || []).slice(0, 6).map(f => `<a class="dsh-tag" href="/api/inbox/${enc(turn.taskId)}/artifacts/${enc(f)}" target="_blank" rel="noopener">📄 ${esc(f)}</a>`).join('')}
                </div>` : ''}
            </div>
          </article>`;
      }).join('');
    },

    _wsBindTurnActions(turnsEl) {
      turnsEl.querySelectorAll('[data-ws-starter]').forEach(btn =>
        btn.addEventListener('click', () => {
          const input = this.contentEl.querySelector('#ws-composer-input');
          if (input) {
            input.value = btn.dataset.wsStarter;
            input.focus();
          }
        }));
    },

    _wsRenderSessionPane(mainEl, ws, session) {
      const canPause = session.status === 'working';
      const canResume = session.status === 'paused' || session.status === 'error';
      const extraRight = `
        ${canPause ? `<button type="button" class="dsh-btn-ghost" id="ws-sess-pause" title="Pause active turn"><i data-lucide="pause"></i><span>Pause</span></button>` : ''}
        ${canResume ? `<button type="button" class="dsh-btn-primary" id="ws-sess-resume" title="Resume session"><i data-lucide="play"></i><span>Resume</span></button>` : ''}
        <button type="button" class="dsh-icon-btn" id="ws-sess-fork" title="Fork session" aria-label="Fork session"><i data-lucide="git-branch"></i></button>
        <button type="button" class="dsh-icon-btn" id="ws-sess-new" title="New session" aria-label="New session"><i data-lucide="plus"></i></button>`;

      const agentOpts = [`<option value="">Auto agent</option>`]
        .concat(selectableAgentIds(this._wsAgents || {}).map(id =>
          `<option value="${esc(id)}"${id === (session.agent || ws.defaultAgent || '') ? ' selected' : ''}>${esc(shortAgent(id))}</option>`)).join('');

      const autoOn = session.autoPstackSkills !== false && ws.pstackAutoSkills !== false;

      mainEl.innerHTML = `
        ${this._wsHeaderHTML(ws, 'session', extraRight, session.title)}
        <div class="ws-session-body">
          <div class="ws-turns-scroll" id="ws-turns-scroll">
            <div class="ws-turns-inner" id="ws-turns-inner">
              ${this._wsTurnsHTML(session, ws)}
            </div>
          </div>
          <div class="ws-composer-wrap">
            <form class="ws-composer" id="ws-composer-form">
              <textarea id="ws-composer-input" class="ws-composer-input" rows="2" placeholder="${session.status === 'wait-input' ? 'Reply to answer the agent and resume…' : 'Message this continuous session… (vendored pstack skills apply automatically)'}"></textarea>
              <div class="ws-composer-bar">
                <div class="ws-composer-controls">
                  <select id="ws-comp-agent" class="ws-composer-select" aria-label="Session agent">${agentOpts}</select>
                  <select id="ws-comp-thinking" class="ws-composer-select" aria-label="Thinking level">${thinkingOptions(session.thinking || ws.defaultThinking || '')}</select>
                  <button type="button" class="ws-pstack-toggle${autoOn ? ' is-on' : ''}" id="ws-comp-pstack" aria-pressed="${autoOn}" title="Automatically resolve & inject vendored pstack skills for each turn">
                    <i data-lucide="sparkles"></i><span>pstack: ${autoOn ? 'auto' : 'manual'}</span>
                  </button>
                </div>
                <button type="submit" class="dsh-btn-primary" id="ws-comp-send">
                  <i data-lucide="send"></i><span>Send</span>
                </button>
              </div>
            </form>
          </div>
        </div>`;

      this._wsBindHeader(mainEl, ws);
      const turnsEl = mainEl.querySelector('#ws-turns-inner');
      if (turnsEl) this._wsBindTurnActions(turnsEl);

      // Scroll to latest turn
      const scrollEl = mainEl.querySelector('#ws-turns-scroll');
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;

      mainEl.querySelector('#ws-sess-pause')?.addEventListener('click', async () => {
        try {
          await this.api.post(`/sessions/${enc(session.id)}/pause`, {});
          this.toast('session paused', session.title);
          await this.renderWorkspaces({ soft: true });
        } catch (err) { this.toast('error', err.message); }
      });

      mainEl.querySelector('#ws-sess-resume')?.addEventListener('click', async () => {
        try {
          await this.api.post(`/sessions/${enc(session.id)}/resume`, {});
          this.toast('session resumed', session.title);
          await this.renderWorkspaces({ soft: true });
        } catch (err) { this.toast('error', err.message); }
      });

      mainEl.querySelector('#ws-sess-fork')?.addEventListener('click', async () => {
        try {
          const forked = await this.api.post(`/sessions/${enc(session.id)}/fork`, {});
          this.toast('session forked', forked.title);
          this._wsForceDetail = true;
          location.hash = `#workspaces/${enc(ws.id)}/sessions/${enc(forked.id)}`;
          await this.renderWorkspaces();
        } catch (err) { this.toast('error', err.message); }
      });

      mainEl.querySelector('#ws-sess-new')?.addEventListener('click', async () => {
        try {
          const out = await this.api.post(`/workspaces/${enc(ws.id)}/sessions`, { title: 'New session' });
          this._wsForceDetail = true;
          location.hash = `#workspaces/${enc(ws.id)}/sessions/${enc(out.session.id)}`;
          await this.renderWorkspaces();
        } catch (err) { this.toast('error', err.message); }
      });

      mainEl.querySelector('#ws-comp-pstack')?.addEventListener('click', async () => {
        try {
          const next = !(session.autoPstackSkills !== false);
          await this.api.patch(`/sessions/${enc(session.id)}`, { autoPstackSkills: next });
          this.toast('pstack auto-skills', next ? 'Enabled automatic pstack skills' : 'Switched to manual pstack skills');
          await this.renderWorkspaces({ soft: true });
        } catch (err) { this.toast('error', err.message); }
      });

      const inputEl = mainEl.querySelector('#ws-composer-input');
      const sendBtn = mainEl.querySelector('#ws-comp-send');
      const sendPrompt = async () => {
        const prompt = (inputEl?.value || '').trim();
        if (!prompt) return;
        sendBtn.disabled = true;
        try {
          const agent = mainEl.querySelector('#ws-comp-agent')?.value || undefined;
          const thinking = mainEl.querySelector('#ws-comp-thinking')?.value || undefined;
          const out = await this.api.post(`/sessions/${enc(session.id)}/messages`, { prompt, agent, thinking });
          inputEl.value = '';
          const skills = out?.turn?.pstackSkills || [];
          this.toast('turn queued', skills.length ? `Auto pstack skills: ${skills.join(', ')}` : 'Sent to agent');
          await this.renderWorkspaces({ soft: true });
        } catch (err) {
          sendBtn.disabled = false;
          this.toast('error', err.message);
        }
      };

      mainEl.querySelector('#ws-composer-form')?.addEventListener('submit', (ev) => {
        ev.preventDefault();
        sendPrompt();
      });
      inputEl?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendPrompt();
        }
      });
    },

    async _wsPollActiveProgress() {
      const box = this.contentEl?.querySelector('[data-ws-progress]');
      if (!box) return;
      const taskId = box.dataset.wsProgress;
      if (!taskId) return;
      try {
        const data = await this.api.get(`/inbox/${enc(taskId)}/progress`);
        const pre = box.querySelector('#ws-live-log');
        if (pre) {
          pre.textContent = data?.log || (data?.running ? 'Agent is working…' : `Status: ${data?.status || 'pending'}`);
          pre.scrollTop = pre.scrollHeight;
        }
        if (data && !data.running && data.status && data.status !== 'pending') {
          this._wsScheduleRefresh();
        }
      } catch { /* best-effort poll */ }
    },

    _wsRenderTasksPane(mainEl, ws, tasks) {
      const filter = this._wsTaskFilter || '';
      const filterDefs = [
        ['', 'All'], ['in-progress', 'Working'], ['pending', 'Pending'],
        ['wait-input', 'Waiting'], ['done', 'Done'], ['failed', 'Failed'],
      ];
      const agentOpts = [`<option value="">Auto agent</option>`]
        .concat(selectableAgentIds(this._wsAgents || {}).map(id =>
          `<option value="${esc(id)}"${id === (ws.defaultAgent || '') ? ' selected' : ''}>${esc(shortAgent(id))}</option>`)).join('');

      mainEl.innerHTML = `
        ${this._wsHeaderHTML(ws, 'tasks', `<button type="button" class="dsh-btn-primary" id="ws-toggle-new-task"><i data-lucide="plus"></i><span>New task</span></button>`, 'Workspace Tasks')}
        <div class="ws-panel-scroll">
          <div class="ws-panel-inner">
            <form class="ws-card" id="ws-quick-task-form" style="display:${this._wsTaskFormOpen ? 'flex' : 'none'}">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <strong style="font-size:14px">New task in ${esc(ws.name)}</strong>
                <button type="button" class="dsh-icon-btn" id="ws-close-task-form" aria-label="Close"><i data-lucide="x"></i></button>
              </div>
              <div class="dsh-inline-field">
                <label for="ws-qt-title">Title *</label>
                <input id="ws-qt-title" placeholder="Short imperative task title…" autocomplete="off">
              </div>
              <div class="dsh-inline-field">
                <label for="ws-qt-desc">Brief *</label>
                <textarea id="ws-qt-desc" rows="3" placeholder="What should the agent do? Vendored pstack skills resolve automatically."></textarea>
              </div>
              <div class="dsh-inline-drawer-grid">
                <div class="dsh-inline-field">
                  <label for="ws-qt-priority">Priority</label>
                  <select id="ws-qt-priority">
                    <option value="normal" selected>normal</option><option value="low">low</option>
                    <option value="high">high</option><option value="urgent">urgent</option>
                  </select>
                </div>
                <div class="dsh-inline-field">
                  <label for="ws-qt-agent">Agent</label>
                  <select id="ws-qt-agent">${agentOpts}</select>
                </div>
              </div>
              <div class="dsh-inline-drawer-foot">
                <span class="dsh-inline-err" id="ws-qt-err"></span>
                <button type="submit" class="dsh-btn-primary" id="ws-qt-submit"><i data-lucide="plus"></i><span>Create task</span></button>
              </div>
            </form>

            <div class="dsh-filters" role="group" aria-label="Filter workspace tasks">
              ${filterDefs.map(([k, label]) => `<button type="button" class="dsh-filter-tab${filter === k ? ' is-active' : ''}" data-ws-tf="${esc(k)}" aria-pressed="${filter === k}">${esc(label)}</button>`).join('')}
            </div>

            ${tasks.length ? `
              <div class="dsh-rows">
                ${tasks.map(t => {
                  const st = isTaskFailed(t) ? 'failed' : t.status;
                  const skills = Array.isArray(t.context?.pstackSkills) ? t.context.pstackSkills : [];
                  return `<a class="dsh-row" href="#tasks/${enc(t.id)}">
                    <span class="dsh-row-dot-wrap"><span class="dsh-dot" data-state="${esc(st)}"></span></span>
                    <span class="dsh-row-body">
                      <span class="dsh-row-top">
                        <span class="dsh-row-title">${esc(t.title)}</span>
                        <span class="dsh-row-time">${esc(timeAgo(t.createdAt))}</span>
                      </span>
                      <span class="dsh-row-meta">
                        <span>${esc(st)}</span>
                        ${t.context?.agent ? `<span class="dsh-meta-sep">·</span><span>${esc(shortAgent(t.context.agent))}</span>` : ''}
                        ${t.sessionId ? `<span class="dsh-tag is-business">session</span>` : ''}
                        ${skills.slice(0, 2).map(sk => `<span class="dsh-tag">⚡ ${esc(sk)}</span>`).join('')}
                      </span>
                    </span>
                  </a>`;
                }).join('')}
              </div>` : `
              <div class="dsh-empty-detail">
                <i data-lucide="inbox"></i>
                <p>No tasks in <strong>${esc(ws.name)}</strong>${filter ? ` matching "${esc(filter)}"` : ''}.</p>
                <button type="button" class="dsh-btn-primary" id="ws-empty-new-task"><i data-lucide="plus"></i><span>Create workspace task</span></button>
              </div>`}
          </div>
        </div>`;

      this._wsBindHeader(mainEl, ws);

      const toggleForm = (open) => {
        this._wsTaskFormOpen = open;
        const f = mainEl.querySelector('#ws-quick-task-form');
        if (f) f.style.display = open ? 'flex' : 'none';
        if (open) mainEl.querySelector('#ws-qt-title')?.focus();
      };
      mainEl.querySelector('#ws-toggle-new-task')?.addEventListener('click', () => toggleForm(!this._wsTaskFormOpen));
      mainEl.querySelector('#ws-empty-new-task')?.addEventListener('click', () => toggleForm(true));
      mainEl.querySelector('#ws-close-task-form')?.addEventListener('click', () => toggleForm(false));

      mainEl.querySelectorAll('[data-ws-tf]').forEach(btn =>
        btn.addEventListener('click', () => {
          this._wsTaskFilter = btn.dataset.wsTf;
          this.renderWorkspaces({ soft: true });
        }));

      mainEl.querySelector('#ws-quick-task-form')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const title = mainEl.querySelector('#ws-qt-title').value.trim();
        const description = mainEl.querySelector('#ws-qt-desc').value.trim();
        const errEl = mainEl.querySelector('#ws-qt-err');
        const submitBtn = mainEl.querySelector('#ws-qt-submit');
        if (!title || !description) {
          errEl.textContent = 'Title and brief are required.';
          return;
        }
        submitBtn.disabled = true;
        errEl.textContent = '';
        try {
          const agent = mainEl.querySelector('#ws-qt-agent').value || undefined;
          await this.api.post(`/workspaces/${enc(ws.id)}/tasks`, {
            title,
            description,
            priority: mainEl.querySelector('#ws-qt-priority').value,
            context: agent ? { agent } : {},
          });
          this._wsTaskFormOpen = false;
          this.toast('task created', `Scoped to ${ws.name}`);
          await this.renderWorkspaces({ soft: true });
        } catch (err) {
          submitBtn.disabled = false;
          errEl.textContent = err.message;
        }
      });
    },

    _wsRenderSettings(mainEl, ws) {
      const agentOpts = [`<option value="">Auto — route via agent chain</option>`]
        .concat(selectableAgentIds(this._wsAgents || {}).map(id =>
          `<option value="${esc(id)}"${id === (ws.defaultAgent || '') ? ' selected' : ''}>${esc(id)}</option>`)).join('');
      const selectedSkills = new Set(ws.pinnedSkills || []);
      const allSkills = this._wsPstack?.skills || [];

      mainEl.innerHTML = `
        ${this._wsHeaderHTML(ws, 'settings', `<button type="button" class="dsh-btn-primary" id="ws-set-save"><i data-lucide="check"></i><span>Save</span></button>`, 'Workspace Settings')}
        <div class="ws-panel-scroll">
          <div class="ws-panel-inner">
            <form class="ws-card" id="ws-set-form">
              <div class="dsh-inline-field">
                <label for="ws-s-name">Workspace name</label>
                <input id="ws-s-name" value="${esc(ws.name)}">
              </div>
              <div class="dsh-inline-field">
                <label for="ws-s-path">Directory path</label>
                <input id="ws-s-path" value="${esc(ws.path || '')}" placeholder="/path/to/project">
              </div>
              <div class="dsh-inline-field">
                <label for="ws-s-desc">Workspace brief</label>
                <textarea id="ws-s-desc" rows="3">${esc(ws.description || '')}</textarea>
              </div>
              <div class="dsh-inline-drawer-grid">
                <div class="dsh-inline-field">
                  <label for="ws-s-agent">Default agent</label>
                  <select id="ws-s-agent">${agentOpts}</select>
                </div>
                <div class="dsh-inline-field">
                  <label for="ws-s-thinking">Default thinking</label>
                  <select id="ws-s-thinking">${thinkingOptions(ws.defaultThinking || '')}</select>
                </div>
              </div>
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
                <input type="checkbox" id="ws-s-pstack"${ws.pstackAutoSkills !== false ? ' checked' : ''}>
                <span><strong>Automatically resolve & inject vendored pstack skills</strong> into workspace sessions</span>
              </label>
              <div class="dsh-inline-field">
                <label>Pinned vendored pstack skills (always active in this workspace)</label>
                <div class="ws-skill-grid" id="ws-s-skills">
                  ${allSkills.map(sk => `<button type="button" class="ws-skill-chip${selectedSkills.has(sk) ? ' is-selected' : ''}" data-ws-skill="${esc(sk)}" aria-pressed="${selectedSkills.has(sk)}">${esc(sk)}</button>`).join('') || '<span style="font-size:12px;color:var(--dsw-label-caption)">No vendored pstack skills found.</span>'}
                </div>
              </div>
              <div class="dsh-inline-err" id="ws-set-err"></div>
            </form>

            <div class="ws-card" style="border-color:color-mix(in srgb, var(--dsw-error) 35%, transparent)">
              <strong style="color:var(--dsw-error);font-size:13.5px">Danger Zone</strong>
              <p style="font-size:13px;color:var(--dsw-label-secondary)">Deleting this workspace removes its sessions and detaches its tasks (tasks remain in the Inbox).</p>
              <div>
                <button type="button" class="dsh-btn-ghost is-danger" id="ws-set-delete"><i data-lucide="trash-2"></i><span>Delete workspace</span></button>
              </div>
            </div>
          </div>
        </div>`;

      this._wsBindHeader(mainEl, ws);

      mainEl.querySelectorAll('[data-ws-skill]').forEach(chip =>
        chip.addEventListener('click', () => {
          const sk = chip.dataset.wsSkill;
          if (selectedSkills.has(sk)) selectedSkills.delete(sk);
          else selectedSkills.add(sk);
          chip.classList.toggle('is-selected', selectedSkills.has(sk));
          chip.setAttribute('aria-pressed', String(selectedSkills.has(sk)));
        }));

      mainEl.querySelector('#ws-set-save')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const errEl = mainEl.querySelector('#ws-set-err');
        btn.disabled = true;
        errEl.textContent = '';
        try {
          await this.api.patch(`/workspaces/${enc(ws.id)}`, {
            name: mainEl.querySelector('#ws-s-name').value.trim(),
            path: mainEl.querySelector('#ws-s-path').value.trim() || null,
            description: mainEl.querySelector('#ws-s-desc').value.trim() || null,
            defaultAgent: mainEl.querySelector('#ws-s-agent').value || null,
            defaultThinking: mainEl.querySelector('#ws-s-thinking').value || null,
            pstackAutoSkills: mainEl.querySelector('#ws-s-pstack').checked,
            pinnedSkills: [...selectedSkills],
          });
          this.toast('workspace saved', 'Updated workspace settings');
          await this.renderWorkspaces({ soft: true });
        } catch (err) {
          btn.disabled = false;
          errEl.textContent = err.message;
        }
      });

      mainEl.querySelector('#ws-set-delete')?.addEventListener('click', async () => {
        if (!confirm(`Delete workspace "${ws.name}" and its sessions? Existing tasks will be detached and kept.`)) return;
        try {
          await this.api.del(`/workspaces/${enc(ws.id)}`);
          this.toast('workspace deleted', ws.name);
          this._wsActiveId = null;
          this._wsActiveSessionId = null;
          location.hash = '#workspaces';
          await this.renderWorkspaces();
        } catch (err) { this.toast('error', err.message); }
      });
    },
  });
})();
