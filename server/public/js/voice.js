/**
 * Voice assistant mode of the Chat page (#chat → 🎙 Voice).
 *
 * Talk an idea through with the best available (non-rate-limited) brain:
 *   Grill  — it runs the grill-me skill, one question at a time, until no ambiguity is left
 *   Plan   — it proposes a plan (success criterion + phases) and asks permission
 *   Execute— ONLY on your go-ahead (Approve button, or saying "go ahead" while a plan
 *            is on the table) the plan becomes an active Goal the company drives to done
 *
 * Server: /api/voice/* (server/src/core/voice-assistant.ts). Speech is all in the
 * browser: SpeechRecognition (Chrome/Edge/Safari; needs HTTPS or localhost) for
 * speech-to-text and speechSynthesis for text-to-speech. Typing always works too.
 *
 * Loaded after app.js; extends App.prototype so it shares api/toast/helpers.
 */
(function () {
  const LS = {
    mode: 'cowork.voiceMode', session: 'cowork.voiceSession', tts: 'cowork.voiceTts',
    lang: 'cowork.voiceLang', hands: 'cowork.voiceHandsFree',
  };
  const ls = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage optional */ } },
  };
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const PHASES = [['grilling', 'Grill', 'help-circle'], ['plan-ready', 'Plan', 'list-checks'], ['executing', 'Execute', 'rocket'], ['done', 'Done', 'circle-check']];
  const LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['zh-TW', '中文 (台灣)'], ['zh-CN', '中文 (简体)'], ['ja-JP', '日本語']];
  const GOAL_COLORS = { planned: '#94A3B8', active: '#0EA5E9', completing: '#A855F7', done: '#22C55E', audited: '#22C55E',
    achieved: '#22C55E', blocked: '#EF4444', paused: '#F59E0B', draft: '#94A3B8' };

  const P = App.prototype;

  P.isVoiceMode = function () { return ls.get(LS.mode, '0') === '1'; };

  P.setVoiceMode = function (on) {
    ls.set(LS.mode, on ? '1' : '0');
    if (!on) this.voiceStop();
    this.renderCurrentView();
  };

  /** Called by renderChat() when voice mode is on. */
  P.renderVoice = async function () {
    const v = (this.voice ||= {
      session: null, brains: null, listening: false, speaking: false, spokenUpTo: -1,
      tts: ls.get(LS.tts, '1') === '1', handsFree: ls.get(LS.hands, '0') === '1', lang: ls.get(LS.lang, navigator.language || 'en-US'),
    });
    const [brains, sessions] = await Promise.all([
      this.api.get('/voice/brains').catch(() => ({ available: [], cooling: [] })),
      this.api.get('/voice/sessions').catch(() => []),
    ]);
    v.brains = brains;
    v.sessions = sessions;
    const wanted = ls.get(LS.session, '');
    if (!wanted) v.session = null;
    else {
      const switched = !v.session || v.session.id !== wanted;
      v.session = await this.api.get(`/voice/sessions/${encodeURIComponent(wanted)}`).catch(() => null);
      if (!v.session) ls.set(LS.session, '');
      // Don't re-read history aloud when (re)opening a session.
      if (switched) v.spokenUpTo = v.session ? v.session.messages.length - 1 : -1;
    }

    const langOpts = LANGS.concat(LANGS.some(([c]) => c === v.lang) ? [] : [[v.lang, v.lang]])
      .map(([c, l]) => `<option value="${esc(c)}" ${c === v.lang ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const sessOpts = ['<option value="">＋ New idea</option>'].concat(sessions.map(s =>
      `<option value="${esc(s.id)}" ${v.session?.id === s.id ? 'selected' : ''}>${esc((s.title || 'idea').slice(0, 48))} · ${esc(s.phase)}</option>`)).join('');
    const sel = 'padding:6px 10px;background:transparent;border:none;border-radius:12px;color:var(--text-secondary);font-size:0.8rem;cursor:pointer;outline:none;font-weight:500';
    const sttNote = !Recognition
      ? 'Speech recognition isn\'t supported in this browser — type instead (Chrome, Edge and Safari support it).'
      : (!window.isSecureContext ? 'The microphone needs HTTPS (or localhost) — open the dashboard over https:// to talk; typing works here.' : '');

    this.contentEl.innerHTML = `
      <div class="voice-wrap">
        <div class="voice-top">
          <span class="voice-title"><i data-lucide="audio-lines"></i> Voice assistant</span>
          <select id="voice-session" style="${sel}" title="Your idea sessions">${sessOpts}</select>
          <span id="voice-brain" class="voice-chip"></span>
          <div style="flex:1"></div>
          <button id="voice-exit" class="voice-ghost" title="Back to text chat"><i data-lucide="message-square"></i> Text chat</button>
        </div>
        <div id="voice-steps" class="voice-steps"></div>
        <div id="voice-msgs" class="chat-messages-area"></div>
        <div id="voice-side"></div>
        <div class="chat-input-container voice-composer">
          ${sttNote ? `<div class="voice-note">${esc(sttNote)}</div>` : ''}
          <div class="voice-row">
            <button id="voice-mic" class="voice-mic" ${Recognition ? '' : 'disabled'} title="Tap to talk"><i data-lucide="mic"></i></button>
            <textarea id="voice-input" rows="1" class="chat-input-textarea" placeholder="Tap the mic and talk about your idea — or type here…"></textarea>
            <button id="voice-send" class="icon-btn-primary" aria-label="Send"><i data-lucide="send"></i></button>
          </div>
          <div class="chat-input-toolbar-bottom voice-opts">
            <label title="Read replies aloud"><input type="checkbox" id="voice-tts" ${v.tts ? 'checked' : ''}> <i data-lucide="volume-2"></i> Speak replies</label>
            <label title="After a reply is spoken, start listening again automatically"><input type="checkbox" id="voice-hands" ${v.handsFree ? 'checked' : ''} ${Recognition ? '' : 'disabled'}> <i data-lucide="repeat"></i> Hands-free</label>
            <select id="voice-lang" style="${sel}" title="Speech language">${langOpts}</select>
            <div style="flex:1"></div>
            <span id="voice-status" class="voice-status"></span>
          </div>
        </div>
      </div>`;

    const $ = (id) => this.contentEl.querySelector(id);
    $('#voice-exit').addEventListener('click', () => this.setVoiceMode(false));
    $('#voice-session').addEventListener('change', async (e) => {
      this.voiceStop();
      ls.set(LS.session, e.target.value);
      v.session = null;
      this.renderCurrentView();
    });
    $('#voice-tts').addEventListener('change', (e) => { v.tts = e.target.checked; ls.set(LS.tts, v.tts ? '1' : '0'); if (!v.tts) speechSynthesis?.cancel(); });
    $('#voice-hands').addEventListener('change', (e) => { v.handsFree = e.target.checked; ls.set(LS.hands, v.handsFree ? '1' : '0'); });
    $('#voice-lang').addEventListener('change', (e) => { v.lang = e.target.value; ls.set(LS.lang, v.lang); });
    $('#voice-mic').addEventListener('click', () => (v.listening ? this.voiceStopListening() : this.voiceListen()));
    const input = $('#voice-input');
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
    const send = () => { const t = input.value.trim(); if (t) { input.value = ''; input.style.height = 'auto'; this.voiceSend(t); } };
    $('#voice-send').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    // Delegated: approve plan, replay a reply.
    this.contentEl.querySelector('.voice-wrap').addEventListener('click', (e) => {
      if (e.target.closest('#voice-approve')) this.voiceApprove();
      const rp = e.target.closest('[data-voice-replay]');
      if (rp) this.voiceSpeak(v.session?.messages?.[Number(rp.dataset.voiceReplay)]?.content || '', { force: true });
    });

    this.voicePaint();
    // Poll while a turn is in flight (fast) or the plan is executing (slow).
    let tick = 0;
    this.addViewTimer(async () => {
      tick++;
      const s = v.session;
      if (!s || this.currentView !== 'chat' || !this.isVoiceMode()) return;
      const busy = !!s.pending;
      if (!busy && !(s.phase === 'executing' && tick % 4 === 0)) return;
      try { v.session = await this.api.get(`/voice/sessions/${encodeURIComponent(s.id)}`); } catch { return; }
      this.voicePaint();
    }, 2500);
    input.focus();
  };

  /** Re-render the dynamic parts (steps, brain chip, transcript, plan/goal panel). */
  P.voicePaint = function () {
    const v = this.voice;
    const s = v.session;
    const root = this.contentEl;
    if (!root.querySelector('#voice-msgs')) return;
    const phase = s?.phase || 'grilling';
    const idx = PHASES.findIndex(([k]) => k === phase);
    root.querySelector('#voice-steps').innerHTML = PHASES.map(([k, label, icon], i) =>
      `<span class="voice-step ${i < idx ? 'past' : i === idx ? 'now' : ''}"><i data-lucide="${icon}"></i>${label}</span>`).join('<span class="voice-step-sep">›</span>');

    const av = v.brains?.available || [];
    const cool = v.brains?.cooling || [];
    const brainNow = s?.pending?.brain || av[0]?.id;
    root.querySelector('#voice-brain').innerHTML = brainNow
      ? `🧠 ${esc(brainNow)}${cool.length ? ` <span title="${esc(cool.map(c => `${c.id} until ${new Date(c.until).toLocaleTimeString()}`).join('\n'))}">· ⏳ ${cool.length} cooling</span>` : ''}`
      : '<span style="color:#EF4444">no brain available</span>';

    // Transcript.
    const box = root.querySelector('#voice-msgs');
    const msgs = s?.messages || [];
    box.innerHTML = msgs.length ? msgs.map((m, i) => this.voiceBubble(m, i)).join('') + (s.pending
      ? `<div class="voice-pending"><span class="voice-dots"><i></i><i></i><i></i></span> thinking on ${esc(s.pending.brain)}… <a href="#tasks/${encodeURIComponent(s.pending.taskId)}" target="_blank" rel="noopener">task ↗</a></div>` : '')
      : `<div class="voice-empty">
          <i data-lucide="lightbulb"></i>
          <div><b>Tell me about a new idea.</b></div>
          <div>I'll grill you with one question at a time until nothing is ambiguous, then propose a plan.
          Nothing is executed until you approve it — then I orchestrate the company's tasks and goals until the product is done.</div>
        </div>`;
    box.scrollTop = box.scrollHeight;

    // Plan / open questions / goal progress.
    root.querySelector('#voice-side').innerHTML = this.voiceSidePanel(s);

    // Composer state.
    const sendBtn = root.querySelector('#voice-send');
    if (sendBtn) sendBtn.disabled = !!s?.pending;
    this.voiceStatus();
    createIcons();

    // Speak any assistant/system message we haven't spoken yet.
    if (s && msgs.length - 1 > v.spokenUpTo) {
      const fresh = msgs.slice(v.spokenUpTo + 1).filter(m => m.role !== 'user').map(m => m.content).join(' ');
      v.spokenUpTo = msgs.length - 1;
      if (fresh) this.voiceSpeak(fresh);
    }
  };

  P.voiceBubble = function (m, i) {
    if (m.role === 'system') return `<div class="voice-sys">${esc(m.content)}</div>`;
    const user = m.role === 'user';
    const foot = !user ? `<div class="voice-foot">
        <button class="voice-link" data-voice-replay="${i}" title="Read aloud again"><i data-lucide="volume-2"></i></button>
        ${m.brain ? `<span>${esc(m.brain)}</span>` : ''}
        ${m.taskId ? `<a href="#tasks/${encodeURIComponent(m.taskId)}" target="_blank" rel="noopener">task ↗</a>` : ''}
      </div>` : '';
    return `<div style="display:flex;justify-content:${user ? 'flex-end' : 'flex-start'};margin:8px 0">
      <div class="md-block voice-bubble ${user ? 'me' : ''}">${user ? esc(m.content).replace(/\n/g, '<br>') : md(m.content)}${foot}</div>
    </div>`;
  };

  P.voiceSidePanel = function (s) {
    if (!s) return '';
    const parts = [];
    if (s.phase === 'grilling' && s.ambiguities?.length) {
      parts.push(`<details class="voice-card"><summary><i data-lucide="help-circle"></i> ${s.ambiguities.length} open question${s.ambiguities.length === 1 ? '' : 's'} left</summary>
        <ul>${s.ambiguities.map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>`);
    }
    if (s.plan && !s.goal) {
      const p = s.plan;
      const ready = s.phase === 'plan-ready';
      parts.push(`<div class="voice-card plan">
        <div class="voice-card-h"><i data-lucide="list-checks"></i> <b>${esc(p.title)}</b>${ready ? '' : ' <span class="voice-muted">(previous draft — being revised)</span>'}</div>
        ${p.summary ? `<div>${esc(p.summary)}</div>` : ''}
        ${p.deliverable ? `<div><span class="voice-muted">Deliverable:</span> ${esc(p.deliverable)}</div>` : ''}
        <div><span class="voice-muted">Done when:</span> ${esc(p.successCriteria)}</div>
        <ol>${p.phases.map(ph => `<li><b>${esc(ph.title)}</b>${ph.detail ? ` — <span class="voice-muted">${esc(ph.detail)}</span>` : ''}</li>`).join('')}</ol>
        ${ready ? `<button id="voice-approve" class="voice-approve" ${s.pending ? 'disabled' : ''}><i data-lucide="rocket"></i> Approve &amp; execute</button>
          <span class="voice-muted">…or just say “go ahead”. Ask for changes any time.</span>` : ''}
      </div>`);
    }
    if (s.goal) {
      const g = s.goal;
      const c = GOAL_COLORS[g.status] || '#94A3B8';
      parts.push(`<div class="voice-card">
        <div class="voice-card-h"><i data-lucide="target"></i> <b>${esc(g.title)}</b>
          <span class="voice-pill" style="background:${c}22;color:${c}">${esc(g.status)}</span>
          <a href="#goals" style="margin-left:auto">Goals ↗</a></div>
        <div class="voice-muted">Done when: ${esc(g.successCriteria)}</div>
        ${g.blockReason && g.status === 'blocked' ? `<div style="color:#EF4444">Blocked: ${esc(g.blockReason)}</div>` : ''}
        ${g.closedReason ? `<div>${esc(g.closedReason)}</div>` : ''}
        <div class="voice-goal-phases">${g.phases.map(ph => {
          const pc = GOAL_COLORS[ph.status] || '#94A3B8';
          return `<span class="voice-pill" style="background:${pc}22;color:${pc}" title="${esc(ph.status)} · ${ph.tasks} task(s)">${esc(ph.title)} · ${esc(ph.status)}</span>`;
        }).join('')}</div>
      </div>`);
    }
    return parts.join('');
  };

  P.voiceStatus = function (text) {
    const el = this.contentEl.querySelector('#voice-status');
    const v = this.voice;
    const mic = this.contentEl.querySelector('#voice-mic');
    if (mic) {
      mic.classList.toggle('on', !!v.listening);
      mic.innerHTML = `<i data-lucide="${v.listening ? 'square' : 'mic'}"></i>`;
      mic.title = v.listening ? 'Stop listening' : 'Tap to talk';
    }
    if (!el) return;
    el.textContent = text || (v.listening ? '🎙 listening…' : v.speaking ? '🔊 speaking…' : v.session?.pending ? '💭 thinking…' : '');
    createIcons();
  };

  // ── Speech-to-text ────────────────────────────────────────────────────────────

  P.voiceListen = function () {
    const v = this.voice;
    if (!Recognition || v.listening) return;
    if (v.session?.pending) { this.toast('still thinking', 'Wait for the reply before talking again.'); return; }
    speechSynthesis?.cancel();
    const rec = new Recognition();
    rec.lang = v.lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const input = this.contentEl.querySelector('#voice-input');
    const before = input ? input.value.trim() : '';
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      if (input) input.value = [before, finalText, interim].filter(Boolean).join(' ');
    };
    rec.onerror = (e) => {
      const msg = { 'not-allowed': 'Microphone permission denied (or the page is not HTTPS).', 'no-speech': 'Didn\'t hear anything.', 'audio-capture': 'No microphone found.', network: 'Speech service unreachable.' }[e.error] || e.error;
      if (e.error !== 'aborted') this.toast('voice', msg);
    };
    rec.onend = () => {
      v.listening = false;
      v.rec = null;
      this.voiceStatus();
      const text = [before, finalText].filter(Boolean).join(' ').trim();
      if (finalText.trim() && input) { input.value = ''; this.voiceSend(text); }
    };
    try { rec.start(); } catch (err) { this.toast('voice', err.message); return; }
    v.rec = rec;
    v.listening = true;
    this.voiceStatus();
  };

  P.voiceStopListening = function () {
    const v = this.voice;
    if (v?.rec) { try { v.rec.stop(); } catch { /* already stopped */ } }
  };

  P.voiceStop = function () {
    const v = this.voice;
    if (!v) return;
    if (v.rec) { try { v.rec.abort(); } catch { /* ignore */ } v.rec = null; }
    v.listening = false;
    try { speechSynthesis?.cancel(); } catch { /* ignore */ }
    v.speaking = false;
  };

  // ── Text-to-speech ────────────────────────────────────────────────────────────

  P.voiceSpeak = function (text, { force = false } = {}) {
    const v = this.voice;
    const plain = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/[*_#>`]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
    const relisten = () => { if (v.handsFree && !v.session?.pending && v.session?.phase !== 'done' && this.currentView === 'chat' && this.isVoiceMode()) this.voiceListen(); };
    if (!plain || !('speechSynthesis' in window) || (!v.tts && !force)) { relisten(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain);
    u.lang = v.lang;
    const voice = speechSynthesis.getVoices().find(x => x.lang === v.lang) || speechSynthesis.getVoices().find(x => x.lang?.startsWith(v.lang.slice(0, 2)));
    if (voice) u.voice = voice;
    u.onstart = () => { v.speaking = true; this.voiceStatus(); };
    u.onend = u.onerror = () => { v.speaking = false; this.voiceStatus(); relisten(); };
    speechSynthesis.speak(u);
  };

  // ── Server calls ──────────────────────────────────────────────────────────────

  P.voiceEnsureSession = async function () {
    const v = this.voice;
    if (v.session) return v.session;
    v.session = await this.api.post('/voice/sessions', {});
    v.spokenUpTo = -1;
    ls.set(LS.session, v.session.id);
    return v.session;
  };

  P.voiceSend = async function (text) {
    const v = this.voice;
    try {
      const s = await this.voiceEnsureSession();
      v.session = await this.api.post(`/voice/sessions/${encodeURIComponent(s.id)}/turn`, { text });
      v.spokenUpTo = Math.max(v.spokenUpTo, v.session.messages.length - 1);   // never read the user's own words back
      this.voicePaint();
      this.voiceRefreshSessions();
    } catch (e) {
      this.toast('voice', e.message);
    }
  };

  P.voiceApprove = async function () {
    const v = this.voice;
    if (!v.session) return;
    if (!confirm(`Execute "${v.session.plan?.title}" now? The company will start working on it as a goal.`)) return;
    try {
      v.session = await this.api.post(`/voice/sessions/${encodeURIComponent(v.session.id)}/execute`, {});
      this.voicePaint();
      this.voiceRefreshSessions();
    } catch (e) {
      this.toast('execute failed', e.message);
    }
  };

  P.voiceRefreshSessions = async function () {
    const v = this.voice;
    const el = this.contentEl.querySelector('#voice-session');
    if (!el) return;
    v.sessions = await this.api.get('/voice/sessions').catch(() => v.sessions || []);
    el.innerHTML = ['<option value="">＋ New idea</option>'].concat(v.sessions.map(s =>
      `<option value="${esc(s.id)}" ${v.session?.id === s.id ? 'selected' : ''}>${esc((s.title || 'idea').slice(0, 48))} · ${esc(s.phase)}</option>`)).join('');
  };
})();
