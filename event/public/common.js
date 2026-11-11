/* 공통 유틸 · 실시간 스트림 · 사운드 엔진 (WebAudio 합성 — 별도 음원 라이선스 불필요) */
(function () {
  'use strict';
  const PM = {};

  PM.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  PM.$ = (sel, root) => (root || document).querySelector(sel);
  PM.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  PM.sec = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(2) + '초');
  PM.time = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-');
  PM.LETTERS = ['A', 'B', 'C', 'D'];

  PM.toast = function (msg, type) {
    let wrap = document.getElementById('toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 4200 : 2600);
  };

  PM.api = async function (path, body, opts) {
    const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      if (opts && opts.raw) { init.body = body; init.headers['Content-Type'] = opts.type; }
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    let res;
    try { res = await fetch(path, init); } catch (e) { throw new Error('서버에 연결할 수 없습니다. 네트워크를 확인하세요.'); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* noop */ }
    if (!res.ok) { const err = new Error(data.error || '요청 실패 (' + res.status + ')'); err.status = res.status; throw err; }
    return data;
  };

  /*
   * 실시간 상태 — 서버리스(Vercel) 환경용
   * 서버가 상태를 바꾸면 Supabase Realtime 으로 "변경 신호"만 오고(데이터 없음),
   * 각 화면은 신호를 받으면 /api/state 로 자기 화면 데이터를 다시 읽는다.
   * Realtime 이 끊겨도 주기적 폴링으로 동작한다. 서버 시계 오프셋도 여기서 계산.
   */
  PM.clockOffset = 0;
  PM.serverNow = () => Date.now() + PM.clockOffset;
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  const streams = new Set();
  let rt = null; let rtOk = false;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  function realtime() {
    if (rt) return rt;
    rt = (async () => {
      const cfg = await PM.api('/api/config');
      if (!window.supabase) await loadScript(SUPABASE_JS);
      const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
      client.channel('ev-signal')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ev_signal' }, (msg) => {
          const scope = (msg.new && msg.new.scope) || 'all';
          streams.forEach((s) => s.signal(scope));
        })
        .subscribe((status) => {
          const ok = status === 'SUBSCRIBED';
          if (ok && !rtOk) streams.forEach((s) => s.signal('all')); // (재)연결 시 놓친 변경 따라잡기
          rtOk = ok;
        });
      return client;
    })().catch((e) => { console.warn('[realtime] 폴링으로 동작합니다:', e.message); });
    return rt;
  }
  PM.refreshStreams = () => streams.forEach((s) => s.fetchNow());

  PM.stream = function (url, onData, onStatus) {
    const stateUrl = url.replace('/api/stream', '/api/state');
    const role = new URL(stateUrl, location.href).searchParams.get('role');
    let closed = false; let inflight = false; let again = false; let timer = null; let deadlineTimer = null;
    // 참가자는 Realtime 신호 위주(폴링은 안전망), 스크린·콘솔은 체크인 수 등 통계 때문에 짧게 폴링
    const pollMs = () => (role === 'player' ? (rtOk ? 15000 : 3000) : role === 'admin' ? 2500 : 3000);
    const schedule = (ms) => { clearTimeout(timer); if (!closed) timer = setTimeout(fetchNow, ms); };
    async function fetchNow() {
      if (closed) return;
      if (inflight) { again = true; return; }
      inflight = true; clearTimeout(timer);
      try {
        const t0 = Date.now();
        const res = await fetch(stateUrl, { credentials: 'same-origin', cache: 'no-store' });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(d.error || res.status), { status: res.status });
        if (d.serverNow) PM.clockOffset = d.serverNow - (t0 + Date.now()) / 2;
        onStatus && onStatus(true);
        onData(d);
        // 퀴즈 제한 시간이 끝나면 자동 마감 상태를 바로 받아 오도록
        const q = d.quiz;
        clearTimeout(deadlineTimer);
        if (q && q.state === 'RUNNING' && q.deadline) {
          const wait = q.deadline - PM.serverNow() + 1500 + Math.random() * 1500;
          if (wait > 0 && wait < 3600000) deadlineTimer = setTimeout(fetchNow, wait);
        }
      } catch (e) {
        onStatus && onStatus(false);
      }
      inflight = false;
      if (again) { again = false; return fetchNow(); }
      schedule(pollMs());
    }
    const s = {
      fetchNow,
      signal(scope) {
        if (role === 'player') {
          if (scope !== 'all') return;
          schedule(Math.random() * 400); // 수백 대가 동시에 요청하지 않도록 분산
        } else fetchNow();
      },
    };
    streams.add(s);
    fetchNow();
    realtime();
    return { close() { closed = true; clearTimeout(timer); clearTimeout(deadlineTimer); streams.delete(s); } };
  };

  PM.mascot = (size, cls) => `<img class="mascot ${cls || ''}" src="/assets/mascot" alt="두식이" width="${size}" height="${size}" draggable="false">`;
  PM.leaf = '<svg class="leaf" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 29c0-9 2-15 12-23-11 1-17 6-17 14 0 3 2 6 5 9z" fill="#8dc63f"/><path d="M15 29C13 22 9 18 3 16c2 7 6 11 12 13z" fill="#056130"/></svg>';

  /* ── 사운드 엔진 ── */
  class Sound {
    constructor() { this.ctx = null; this.master = null; this.volume = 0.6; this.sfxOn = true; this.bgmTimer = null; this.step = 0; this.nextT = 0; this.intensity = 0; }
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.setVolume(this.volume);
      }
      if (this.ctx.state !== 'running') this.ctx.resume();
      return true;
    }
    get ready() { return !!(this.ctx && this.ctx.state === 'running'); }
    setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
    tone(freq, dur, type, when, gain, slideTo) {
      if (!this.ready) return;
      const c = this.ctx; const t = when || c.currentTime;
      const o = c.createOscillator(); const g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
    }
    noise(dur, when, gain, hp) {
      if (!this.ready) return;
      const c = this.ctx; const t = when || c.currentTime;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate); const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const s = c.createBufferSource(); s.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 6000;
      const g = c.createGain(); g.gain.setValueAtTime(gain || 0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + dur + 0.02);
    }
    sfx(fn) { if (this.sfxOn && this.ready) fn(); }
    click() { this.sfx(() => this.tone(660, 0.06, 'triangle', 0, 0.2)); }
    tick() { this.sfx(() => this.tone(1500, 0.03, 'square', 0, 0.08)); }
    beep(hi) { this.sfx(() => this.tone(hi ? 1320 : 880, hi ? 0.5 : 0.15, 'square', 0, 0.18)); }
    success() { this.sfx(() => { const t = this.ctx.currentTime; [523, 659, 784].forEach((f, i) => this.tone(f, 0.18, 'triangle', t + i * 0.08, 0.25)); }); }
    wrong() { this.sfx(() => this.tone(300, 0.3, 'sawtooth', 0, 0.15, 150)); }
    drumroll(sec) {
      this.sfx(() => { const t = this.ctx.currentTime; const n = Math.floor(sec / 0.045);
        for (let i = 0; i < n; i++) this.noise(0.04, t + i * 0.045, 0.05 + 0.12 * (i / n), 1500); });
    }
    fanfare() {
      this.sfx(() => {
        const t = this.ctx.currentTime;
        [[523, 0], [523, 0.12], [523, 0.24], [659, 0.36], [784, 0.6], [659, 0.78], [784, 0.9]].forEach(([f, d]) => this.tone(f, 0.22, 'square', t + d, 0.16));
        [523, 659, 784, 1046].forEach((f) => this.tone(f, 1.4, 'triangle', t + 1.05, 0.14));
        this.noise(0.8, t + 1.05, 0.12, 4000);
      });
    }
    /* 긴장감 있는 게임쇼 스타일 BGM (오리지널 합성 패턴) */
    startBgm() {
      if (!this.ready || this.bgmTimer) return;
      const bpm = 128; const s16 = 60 / bpm / 4;
      const bass = [45, 0, 45, 0, 48, 0, 45, 0, 43, 0, 43, 0, 44, 0, 44, 0];
      const lead = [69, 0, 0, 72, 0, 0, 71, 0, 69, 0, 0, 68, 0, 0, 64, 0];
      const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
      this.step = 0; this.nextT = this.ctx.currentTime + 0.1;
      this.bgmTimer = setInterval(() => {
        while (this.nextT < this.ctx.currentTime + 0.15) {
          const i = this.step % 16; const bar = Math.floor(this.step / 16);
          if (bass[i]) this.tone(mtof(bass[i]), s16 * 1.8, 'sawtooth', this.nextT, 0.09);
          if (i % 4 === 0) this.tone(55, 0.18, 'sine', this.nextT, 0.35, 35); // kick
          if (i % 2 === 1) this.noise(0.03, this.nextT, 0.03 + this.intensity * 0.04, 8000); // hat
          if (i % 8 === 4) this.noise(0.12, this.nextT, 0.06, 2000); // snare
          if (bar % 2 === 1 && lead[i]) this.tone(mtof(lead[i] + (bar % 4 === 3 ? 2 : 0)), s16 * 2.5, 'square', this.nextT, 0.045 + this.intensity * 0.03);
          if (this.intensity > 0.6 && i % 4 === 2) this.tone(mtof(81), 0.05, 'square', this.nextT, 0.04);
          this.nextT += s16; this.step++;
        }
      }, 30);
    }
    stopBgm() { clearInterval(this.bgmTimer); this.bgmTimer = null; }
  }
  PM.sound = new Sound();

  PM.confetti = function (big) {
    if (typeof window.confetti !== 'function') return;
    const colors = ['#8dc63f', '#056130', '#a6ce39', '#ffffff', '#e8b21f'];
    window.confetti({ particleCount: big ? 180 : 90, spread: big ? 110 : 70, origin: { y: 0.6 }, colors });
    if (big) {
      const end = Date.now() + 1800;
      (function frame() {
        window.confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0 }, colors });
        window.confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1 }, colors });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    }
  };

  PM.qr = function (el, text, size) {
    el.innerHTML = '';
    if (typeof window.QRCode !== 'function') { el.textContent = text; return; }
    new window.QRCode(el, { text, width: size, height: size, colorDark: '#056130', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
  };

  window.PM = PM;
})();
