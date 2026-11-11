'use strict';
/*
 * 풀무원 컨퍼런스 럭키드로우 & 실시간 퀴즈 — 서버 로직 (Vercel 서버리스 함수 / 로컬 공용)
 * - 저장소: Supabase Postgres (ev 스키마, 보안 RPC ev_read / ev_write 경유)
 * - 동시성: 행별 버전(ver) 낙관적 잠금 + 충돌 시 재시도
 *   참석자·퀴즈 답안은 사람별 행이라 동시 체크인/답안 제출이 서로 막지 않음
 * - 실시간: 상태가 바뀌면 public.ev_signal 을 갱신 → Supabase Realtime 으로 클라이언트에 "다시 읽기" 신호
 * - 추첨/채점/시간 측정은 모두 서버에서 수행. 정답은 결과 발표 전까지 참가자에게 보내지 않음
 */
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const EV_SECRET = process.env.EV_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || EV_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pulmuone-admin';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || 'pulmuone-op';
const GRACE_MS = 2000; // 문항별 네트워크 지연 허용치
const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel 함수 요청 본문 한도(4.5MB) 이내
const SESSION_MS = 12 * 3600 * 1000;

/* ───────────────────────── 유틸 ───────────────────────── */
const now = () => Date.now();
const newId = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const token = () => crypto.randomBytes(24).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function normContact(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s.toLowerCase();
  let d = s.replace(/\D/g, '');
  if (d.startsWith('82') && d.length >= 11) d = '0' + d.slice(2);
  return d;
}
const normName = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
const clampStr = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);

function maskContact(c) {
  if (!c) return '';
  if (c.includes('@')) {
    const [u, d] = c.split('@');
    return (u.slice(0, 2) + '***@' + d);
  }
  return c.length > 7 ? c.slice(0, 3) + '-****-' + c.slice(-4) : '****';
}

/* ───────────────────────── 기본 데이터 ───────────────────────── */
function samplePrize(rank) {
  const names = { 1: '1등 상품 (설정 필요)', 2: '2등 상품 (설정 필요)', 3: '3등 상품 (설정 필요)' };
  return { prize_id: newId('prize'), rank, prize_name: names[rank], prize_image_url: '', winner_count: 1, mode: 'one' };
}
function sampleQuestions() {
  const q = (text, options, correct, explanation = '') => ({
    question_id: newId('q'), question_text: text, options, correct_option: correct, time_limit: 15, explanation,
  });
  return [
    q('두부의 주원료는 무엇일까요?', ['쌀', '콩', '밀', '옥수수'], 1, '두부는 콩물을 응고시켜 만듭니다.'),
    q('다음 중 콩으로 만들지 않는 식품은?', ['된장', '두유', '김치', '청국장'], 2),
    q('김치 발효에 주로 관여하는 미생물은?', ['유산균(젖산균)', '효모', '곰팡이', '대장균'], 0),
    q('식물성 단백질이 특히 풍부한 식품은?', ['사과', '두부', '오이', '감자'], 1),
    q('콩을 발아시켜 기른 채소는?', ['숙주나물·콩나물', '시금치', '상추', '깻잎'], 0),
  ];
}
/* main 행: 참석자·답안·검토·감사 로그를 제외한 나머지 상태 */
function defaultMain() {
  return {
    settings: {
      eventName: '풀무원 컨퍼런스 2026',
      checkinCode: '',
      allowWalkIn: false,
      sheetCsvUrl: '',
      publicUrl: '',
      screenKey: crypto.randomBytes(5).toString('hex'),
      sound: { bgm: true, sfx: true, volume: 0.6 },
    },
    prizes: { 1: samplePrize(1), 2: samplePrize(2), 3: samplePrize(3) },
    draws: [],
    lastDrawAt: 0,
    quiz: {
      quiz_id: newId('quiz'), title: '풀무원 상식 퀴즈', winnerCount: 3, state: 'IDLE',
      started_at: null, closed_at: null, revealed_at: null, questions: sampleQuestions(), final: null,
    },
    screen: { view: 'home', draw: null, seq: 0 },
  };
}

/* ───────────────────────── Supabase 저장소 ───────────────────────── */
function assertConfigured() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !EV_SECRET) throw fail('서버 환경변수(SUPABASE_URL, SUPABASE_KEY, EV_SECRET)가 설정되지 않았습니다.', 500);
}
async function rpc(fn, args) {
  assertConfigured();
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw Object.assign(new Error('DB 연결 실패: ' + e.message), { status: 503 });
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch (e) { /* noop */ }
    if (/EV_CONFLICT/.test(msg)) throw Object.assign(new Error('conflict'), { conflict: true, status: 409 });
    console.error('[db]', fn, r.status, msg);
    throw Object.assign(new Error('DB 오류'), { status: 500 });
  }
  return text ? JSON.parse(text) : null;
}
const dbRead = (req) => rpc('ev_read', { p_secret: EV_SECRET, p_req: req });
const dbWrite = (ops) => rpc('ev_write', { p_secret: EV_SECRET, p_ops: ops });

async function load(req) {
  let s = await dbRead({ ...req, main: true });
  if (!s.main) {
    await dbWrite([{ t: 'main_init', data: defaultMain() }]);
    s = await dbRead({ ...req, main: true });
  }
  return s;
}

/* 요청 하나 동안의 상태와 쓰기 목록 */
class Ctx {
  constructor(s) {
    const d = defaultMain();
    const m = s.main.data;
    this.m = { ...d, ...m, settings: { ...d.settings, ...(m.settings || {}), sound: { ...d.settings.sound, ...((m.settings || {}).sound || {}) } } };
    this.mainVer = s.main.ver;
    this.mainDirty = false;
    this.signalScope = null;
    this.ops = [];
    this.pver = new Map();
    this.parts = s.participants ? s.participants.map((x) => { this.pver.set(x.data.participant_id, x.ver); return x.data; }) : null;
    this.me = null; this.entry = null; this.entryVer = 0;
    if (s.participant) { this.me = s.participant.data; this.pver.set(this.me.participant_id, s.participant.ver); }
    if (s.entry) { this.entry = s.entry.data; this.entryVer = s.entry.ver; }
    this.entries = s.entries || null;
    this.reviews = s.reviews || null;
    this.reviewsOpen = s.reviewsOpen || 0;
    this.audits = s.audit || null;
    this.stats = s.stats || null;
  }
  /* scope: 'all' = 참가자 휴대폰까지 다시 읽기, 'screen' = 스크린·운영자 콘솔만 */
  touch(scope) { this.mainDirty = true; this.signal(scope || 'screen'); }
  signal(scope) { if (scope === 'all' || !this.signalScope) this.signalScope = scope; }
  audit(actor, action, detail) { this.ops.push({ t: 'audit', at: now(), actor, action, detail: String(detail == null ? '' : detail) }); }
  review(type, detail, row) { this.ops.push({ t: 'review', id: newId('rv'), at: now(), data: { type, detail, row: row || null } }); }
  savePart(p) { this.ops.push({ t: 'part', id: p.participant_id, contact: p.contact_identifier, data: p, ver: this.pver.get(p.participant_id) || 0 }); }
  saveEntry(pid, e, ver) { this.ops.push({ t: 'entry', id: pid, data: e, ver }); }
  op(o) { this.ops.push(o); }
  flush() {
    const ops = this.ops.slice();
    if (this.mainDirty) ops.unshift({ t: 'main', data: this.m, ver: this.mainVer });
    if (this.signalScope) ops.push({ t: 'signal', scope: this.signalScope });
    return ops;
  }
}

/* 읽기 → 계산 → 버전 확인 쓰기. 충돌하면 처음부터 다시 */
async function tx(readReq, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = new Ctx(await load(readReq));
    const result = await fn(c);
    const ops = c.flush();
    if (ops.length) {
      try { await dbWrite(ops); } catch (e) {
        if (!e.conflict) throw e;
        await sleep(15 + Math.random() * 60 * (attempt + 1));
        continue;
      }
    }
    if (result instanceof Error) throw result; // 기록은 남기되 요청은 실패로 응답
    return result;
  }
  throw fail('요청이 몰려 처리하지 못했습니다. 잠시 후 다시 시도하세요.', 503);
}

/* ───────────────────────── CSV ───────────────────────── */
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 수식 주입 방지
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = (header, rows) => '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

function mapHeaders(h) {
  const H = h.map((x) => String(x).trim());
  const find = (fn) => H.findIndex(fn);
  const org = find((x) => /소속|회사|기관|부서|organization|company/i.test(x));
  let name = find((x) => /^(이름|성명|성함|name)$/i.test(x));
  if (name < 0) name = find((x, i) => i !== org && /이름|성명|성함|name/i.test(x) && !/회사|소속|기관/.test(x));
  const email = find((x) => /이메일|e-?mail|메일/i.test(x));
  const phone = find((x) => /휴대|전화|연락처|핸드폰|phone|mobile/i.test(x));
  const consent = find((x) => /동의|consent/i.test(x));
  return { name, org, email, phone, consent };
}

function importRows(c, rows, actor, source) {
  if (!rows.length) throw fail('CSV에 데이터가 없습니다.');
  const m = mapHeaders(rows[0]);
  if (m.name < 0) throw fail('"이름" 열을 찾을 수 없습니다.');
  if (m.email < 0 && m.phone < 0) throw fail('"이메일" 또는 "휴대전화" 열을 찾을 수 없습니다.');
  const res = { added: 0, updated: 0, unchanged: 0, duplicates: 0, errors: 0 };
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const name = clampStr(r[m.name], 50);
    const organization = m.org >= 0 ? clampStr(r[m.org], 80) : '';
    const raw = (m.phone >= 0 && clampStr(r[m.phone])) || (m.email >= 0 && clampStr(r[m.email])) || '';
    const contact = normContact(raw);
    const rowObj = { name, organization, contact: maskContact(contact) };
    if (!name || !contact) { res.errors++; c.review('missing_field', '이름 또는 연락처 누락', rowObj); continue; }
    if (m.consent >= 0) {
      const cs = String(r[m.consent] || '');
      if (!cs.includes('동의') || /미동의|비동의|동의하지|않/.test(cs)) { res.errors++; c.review('no_consent', '개인정보 수집 미동의', rowObj); continue; }
    }
    if (seen.has(contact)) { res.duplicates++; c.review('duplicate', '같은 연락처로 중복 응답', rowObj); continue; }
    seen.add(contact);
    const ex = c.parts.find((p) => p.contact_identifier === contact);
    if (ex) {
      if (normName(ex.name) !== normName(name)) {
        res.duplicates++; c.review('conflict', `기존 참석자(${ex.name})와 연락처가 같지만 이름이 다름`, rowObj); continue;
      }
      if (organization && ex.organization !== organization) { ex.organization = organization; c.savePart(ex); res.updated++; } else res.unchanged++;
      continue;
    }
    const p = {
      participant_id: newId('p'), name, organization, contact_identifier: contact,
      checkin_status: 'REGISTERED', checked_in_at: null, created_at: now(), source, token: null,
    };
    c.parts.push(p); c.savePart(p);
    res.added++;
  }
  c.audit(actor, 'participants.import', `${source}: 추가 ${res.added}, 갱신 ${res.updated}, 중복 ${res.duplicates}, 오류 ${res.errors}`);
  return res;
}

function sheetCsvUrl(u) {
  const s = String(u || '').trim();
  const m = s.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m && !/\/pub|output=csv|format=csv/.test(s)) {
    const gid = (s.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }
  return s;
}

/* ───────────────────────── 럭키드로우 ───────────────────────── */
function excludedSet(c) {
  return new Set(c.m.draws.filter((d) => d.status === 'VALID' || d.exclude_after_void).map((d) => d.participant_id));
}
function eligible(c) {
  const ex = excludedSet(c);
  return c.parts.filter((p) => p.checkin_status === 'CHECKED_IN' && !ex.has(p.participant_id));
}
function pickRandom(arr, k) {
  const a = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + crypto.randomInt(a.length - i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}
function runDraw(c, rank, actor) {
  const db = c.m;
  const prize = db.prizes[rank];
  if (!prize) throw fail('등수를 선택하세요.');
  if (now() - (db.lastDrawAt || 0) < 1500) throw fail('추첨이 진행 중입니다. 잠시 후 다시 시도하세요.');
  const validCount = db.draws.filter((d) => d.rank === rank && d.status === 'VALID').length;
  const remaining = prize.winner_count - validCount;
  if (remaining <= 0) throw fail(`${rank}등은 이미 ${prize.winner_count}명 추첨이 완료되었습니다.`);
  const pool = eligible(c);
  if (!pool.length) throw fail('추첨 가능한 참석자가 없습니다. (체크인 완료 & 미당첨자 0명)');
  const k = prize.mode === 'batch' ? Math.min(remaining, pool.length) : 1;
  const winners = pickRandom(pool, k);
  const ex = excludedSet(c);
  if (winners.some((w) => ex.has(w.participant_id)) || new Set(winners.map((w) => w.participant_id)).size !== winners.length) {
    throw fail('중복 당첨 검증 실패. 다시 시도하세요.');
  }
  const batch = newId('batch');
  const at = now();
  for (const w of winners) {
    db.draws.push({
      draw_id: newId('draw'), batch_id: batch, participant_id: w.participant_id, prize_id: prize.prize_id,
      prize_name: prize.prize_name, rank, drawn_at: at, status: 'VALID', audit_reason: '', exclude_after_void: false,
    });
  }
  db.lastDrawAt = at;
  db.screen.seq++;
  db.screen.view = 'draw';
  db.screen.draw = {
    seq: db.screen.seq, batch_id: batch, rank, prize_name: prize.prize_name, prize_image_url: prize.prize_image_url,
    winners: winners.map((w) => ({ name: w.name, organization: w.organization })),
    pool: pickRandom(pool, Math.min(pool.length, 40)).map((p) => p.name),
    at, open: true,
  };
  c.audit(actor, 'draw.run', `${rank}등 (${prize.prize_name}) → ${winners.map((w) => w.name).join(', ')}`);
  return db.screen.draw;
}

/* ───────────────────────── 퀴즈 ───────────────────────── */
function quizDeadline(m) {
  const q = m.quiz;
  if (!q.started_at) return null;
  return q.started_at + q.questions.reduce((s, x) => s + x.time_limit * 1000, 0) + GRACE_MS * 2;
}
/* 제한 시간이 지난 문항을 미응답 처리 (읽을 때마다 같은 결과가 나오는 순수 계산) */
function advance(m, e, at) {
  const q = m.quiz;
  if (!q.started_at || !['RUNNING', 'CLOSED', 'REVEALED'].includes(q.state) || e.finished) return false;
  if (e.shown_at == null) e.shown_at = q.started_at; // 대기실에서 입장한 사람은 시작 시각부터
  const limit = q.state === 'RUNNING' ? (at || now()) : q.closed_at;
  const list = q.questions; const n = list.length;
  let changed = false;
  while (!e.finished && e.current < n) {
    const dl = e.shown_at + list[e.current].time_limit * 1000;
    if (limit <= dl + GRACE_MS) break;
    e.answers.push({ option: null, at: null, timed_out: true });
    e.current++; e.shown_at = dl; changed = true;
    if (e.current >= n) finishEntry(m, e, dl);
  }
  return changed;
}
function finishEntry(m, e, wall) {
  e.finished = true; e.finished_at = wall; e.elapsed_ms = Math.max(0, wall - m.quiz.started_at);
}
function scoreEntry(m, e) {
  const list = m.quiz.questions;
  let correct = 0;
  list.forEach((q, i) => { if (e.answers[i] && e.answers[i].option === q.correct_option) correct++; });
  const total = list.length;
  const elapsed = e.finished ? e.elapsed_ms : ((m.quiz.closed_at || now()) - (m.quiz.started_at || now()));
  return { correct, total, all_correct: e.finished && correct === total && total > 0, elapsed_ms: elapsed, finished: !!e.finished };
}
function ranking(c) {
  const m = c.m;
  const byId = new Map(c.parts.map((p) => [p.participant_id, p]));
  const list = [];
  for (const [pid, e] of Object.entries(c.entries)) {
    const p = byId.get(pid);
    if (!p) continue;
    advance(m, e);
    list.push({ participant_id: pid, name: p.name, organization: p.organization, answered: e.answers.length, ...scoreEntry(m, e) });
  }
  if (!m.quiz.started_at) return { list, winners: [], tieAtCutoff: false, perfectCount: 0 };
  list.sort((a, b) => b.correct - a.correct || a.elapsed_ms - b.elapsed_ms);
  list.forEach((r, i) => {
    const prev = list[i - 1];
    r.rank = prev && prev.correct === r.correct && prev.elapsed_ms === r.elapsed_ms ? prev.rank : i + 1;
  });
  const perfect = list.filter((r) => r.all_correct).sort((a, b) => a.elapsed_ms - b.elapsed_ms);
  const N = m.quiz.winnerCount;
  const winners = perfect.slice(0, N).map((r, i) => ({ ...r, award_rank: i + 1 }));
  const tieAtCutoff = perfect.length > N && perfect[N].elapsed_ms === perfect[N - 1].elapsed_ms;
  return { list, winners, tieAtCutoff, perfectCount: perfect.length };
}
/* 결과 발표 시점의 순위를 main 에 고정 → 참가자·스크린은 전체 답안을 다시 읽지 않음 */
function freezeFinal(c) {
  const r = ranking(c);
  const strip = (x) => ({ name: x.name, organization: x.organization, correct: x.correct, total: x.total, elapsed_ms: x.elapsed_ms, rank: x.rank, award_rank: x.award_rank });
  const ranks = {};
  const award = new Map(r.winners.map((w) => [w.participant_id, w.award_rank]));
  r.list.forEach((x) => { ranks[x.participant_id] = [x.rank, award.get(x.participant_id) || 0]; });
  c.m.quiz.final = { winners: r.winners.map(strip), top: r.list.slice(0, 10).map(strip), perfectCount: r.perfectCount, participants: r.list.length, ranks };
}
function closeQuiz(c, actor, reason) {
  const q = c.m.quiz;
  if (q.state !== 'RUNNING') return;
  q.state = 'CLOSED'; q.closed_at = now();
  c.audit(actor, 'quiz.close', reason);
  c.touch('all');
}
/* 서버 타이머 대신, 아무 요청이든 마감 시각이 지났으면 자동 마감 */
function maybeClose(c) {
  if (c.m.quiz.state !== 'RUNNING') return;
  const dl = quizDeadline(c.m);
  if (dl && now() > dl) closeQuiz(c, 'system', '제한 시간 종료로 자동 마감');
}

function playerView(c, p, e) {
  const m = c.m; const q = m.quiz;
  const out = {
    serverNow: now(),
    eventName: m.settings.eventName,
    quiz: { state: q.state, title: q.title, count: q.questions.length, deadline: quizDeadline(m) },
    me: { name: p.name, organization: p.organization, joined: !!e },
  };
  if (!e) return out;
  advance(m, e);
  Object.assign(out.me, { current: e.current, finished: !!e.finished, answered: e.answers.length });
  if (q.state === 'RUNNING' && !e.finished && e.shown_at != null) {
    const qq = q.questions[e.current];
    out.me.question = { index: e.current, text: qq.question_text, options: qq.options, time_limit: qq.time_limit, shown_at: e.shown_at };
  }
  if (q.state === 'CLOSED' || q.state === 'REVEALED') {
    const s = scoreEntry(m, e);
    out.me.result = { correct: s.correct, total: s.total, all_correct: s.all_correct, elapsed_ms: s.elapsed_ms, finished: s.finished };
    if (q.state === 'REVEALED' && q.final) {
      const mine = q.final.ranks[p.participant_id];
      out.me.result.rank = mine ? mine[0] : null;
      out.me.result.of = q.final.participants;
      out.me.result.award_rank = mine && mine[1] ? mine[1] : null;
      out.me.result.review = q.questions.map((qq, i) => ({
        text: qq.question_text, options: qq.options, correct: qq.correct_option,
        mine: e.answers[i] ? e.answers[i].option : null, explanation: qq.explanation || '',
      }));
    }
  }
  return out;
}

/* ───────────────────────── 상태 뷰 ───────────────────────── */
function publicView(c, withKey) {
  const m = c.m; const q = m.quiz; const st = c.stats || {};
  const out = {
    serverNow: now(),
    eventName: m.settings.eventName,
    publicUrl: m.settings.publicUrl,
    sound: m.settings.sound,
    view: m.screen.view,
    stats: { checkedIn: st.checkedIn || 0, quizJoined: st.quizJoined || 0, quizFinished: st.quizFinished || 0 },
    checkin: { codeRequired: !!m.settings.checkinCode, code: withKey ? m.settings.checkinCode : null },
    prizes: [1, 2, 3].map((r) => ({ rank: r, prize_name: m.prizes[r].prize_name, prize_image_url: m.prizes[r].prize_image_url, winner_count: m.prizes[r].winner_count })),
    draw: m.screen.draw,
    quiz: { state: q.state, title: q.title, count: q.questions.length, started_at: q.started_at, deadline: quizDeadline(m), winnerCount: q.winnerCount },
    reveal: null,
  };
  if (q.state === 'REVEALED' && q.final) {
    const f = q.final;
    out.reveal = { at: q.revealed_at, winners: f.winners, top: f.top, perfectCount: f.perfectCount, participants: f.participants };
  }
  return out;
}
function adminStats(c) {
  const total = c.parts.length;
  const checkedIn = c.parts.filter((p) => p.checkin_status === 'CHECKED_IN').length;
  const entries = Object.values(c.entries);
  return {
    total, checkedIn, notCheckedIn: total - checkedIn, eligible: eligible(c).length,
    quizJoined: entries.length, quizFinished: entries.filter((e) => e.finished).length,
    reviewsOpen: c.reviewsOpen,
  };
}
function adminView(c, role) {
  const m = c.m;
  const r = ranking(c);
  const list = r.list;
  const avg = list.length ? list.reduce((s, x) => s + x.correct, 0) / list.length : 0;
  const finishedList = list.filter((x) => x.finished);
  const byId = new Map(c.parts.map((p) => [p.participant_id, p]));
  const { final, ...quiz } = m.quiz;
  return {
    role, serverNow: now(),
    settings: m.settings,
    stats: adminStats(c),
    participants: c.parts.map((p) => ({
      participant_id: p.participant_id, name: p.name, organization: p.organization, contact: maskContact(p.contact_identifier),
      checkin_status: p.checkin_status, checked_in_at: p.checked_in_at, created_at: p.created_at, source: p.source,
    })),
    reviews: c.reviews || [],
    prizes: m.prizes,
    draws: m.draws.map((d) => { const p = byId.get(d.participant_id); return { ...d, name: p ? p.name : '(삭제됨)', organization: p ? p.organization : '' }; }),
    quiz: { ...quiz, deadline: quizDeadline(m) },
    quizLive: {
      ranking: list, winners: r.winners, tieAtCutoff: r.tieAtCutoff, perfectCount: r.perfectCount || 0,
      joined: list.length, finished: finishedList.length, avg,
      best: list.length ? Math.max(...list.map((x) => x.correct)) : 0,
      fastest: finishedList.length ? Math.min(...finishedList.map((x) => x.elapsed_ms)) : null,
    },
    screen: m.screen,
    audit: c.audits || [],
  };
}

/* ───────────────────────── HTTP 공통 ───────────────────────── */
function parseCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); });
  return o;
}
/* 서버리스라 메모리 세션 대신 서명된 쿠키 사용: role.만료시각.HMAC */
const sign = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function makeSession(role) { const body = `${role}.${now() + SESSION_MS}`; return `${body}.${sign(body)}`; }
function getRole(req) {
  const sid = parseCookies(req).sid;
  if (!sid || !SESSION_SECRET) return null;
  const i = sid.lastIndexOf('.');
  if (i < 0) return null;
  const body = sid.slice(0, i); const sig = Buffer.from(sid.slice(i + 1)); const want = Buffer.from(sign(body));
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  const [role, exp] = body.split('.');
  if (!['super', 'operator'].includes(role) || !(Number(exp) > now())) return null;
  return role;
}
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
async function readBody(req, limit) {
  // Vercel 헬퍼가 본문을 미리 읽은 경우 대비
  let pre;
  try { pre = req.body; } catch (e) { throw fail('잘못된 요청 본문', 400); }
  if (pre !== undefined && pre !== null) {
    const b = Buffer.isBuffer(pre) ? pre : Buffer.from(typeof pre === 'string' ? pre : JSON.stringify(pre));
    if (b.length > limit) throw fail('요청 크기가 너무 큽니다.', 413);
    return b;
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (ch) => { size += ch.length; if (size > limit) { reject(fail('요청 크기가 너무 큽니다.', 413)); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) throw fail('JSON 요청만 허용됩니다.', 415);
  const b = await readBody(req, 1024 * 1024);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch (e) { throw fail('잘못된 JSON', 400); }
}

/* 실패한 시도만 센다 (인스턴스별 최선 노력 — 서버리스 인스턴스끼리는 공유되지 않음) */
const rate = new Map();
function failGuard(key, max) {
  const r = rate.get(key);
  if (r && r.reset > now() && r.n >= max) throw fail('실패한 시도가 너무 많습니다. 1분 후 다시 시도하세요.', 429);
}
function failHit(key, windowMs) {
  const t = now(); const r = rate.get(key);
  if (!r || r.reset < t) rate.set(key, { n: 1, reset: t + windowMs }); else r.n++;
  if (rate.size > 5000) for (const [k, v] of rate) if (v.reset < t) rate.delete(k);
}
async function guarded(key, max, fn) {
  failGuard(key, max);
  try { return await fn(); } catch (e) { if (e.status && e.status !== 429 && e.status < 500) failHit(key, 60000); throw e; }
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';

const ADMIN_READ = { participants: true, entries: true };
const isChecked = (p) => p && p.checkin_status === 'CHECKED_IN';

/* ───────────────────────── API ───────────────────────── */
async function api(req, res, url) {
  const t0 = now(); // 요청 도착 시각 (답안 시간 측정 기준)
  const p = url.pathname;
  const M = req.method;
  const role = getRole(req);
  const need = (r) => {
    if (!role) throw fail('관리자 로그인이 필요합니다.', 401);
    if (r === 'super' && role !== 'super') throw fail('최고 관리자 권한이 필요합니다.', 403);
  };

  /* ── 실시간 연결 정보 (공개 키만) ── */
  if (p === '/api/config' && M === 'GET') {
    assertConfigured();
    return send(res, 200, { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY }, { 'Cache-Control': 'public, max-age=300' });
  }

  /* ── 화면별 현재 상태 (기존 SSE 스트림 대체) ── */
  if (p === '/api/state' && M === 'GET') {
    const kind = url.searchParams.get('role');
    if (kind === 'admin') {
      need('operator');
      return send(res, 200, await tx({ ...ADMIN_READ, reviews: true, audit: 150 }, (c) => { maybeClose(c); return adminView(c, role); }));
    }
    if (kind === 'player') {
      const tk = url.searchParams.get('token') || '';
      return send(res, 200, await tx({ token: tk }, (c) => {
        if (!tk || !isChecked(c.me)) throw fail('체크인 정보가 없습니다.', 401);
        maybeClose(c);
        return playerView(c, c.me, c.entry);
      }));
    }
    if (kind === 'screen') {
      const key = url.searchParams.get('key');
      return send(res, 200, await tx({ stats: true }, (c) => { maybeClose(c); return publicView(c, !!key && key === c.m.settings.screenKey); }));
    }
    throw fail('알 수 없는 화면');
  }

  /* ── 공개 ── */
  if (p === '/api/public/info' && M === 'GET') {
    const c = new Ctx(await load({}));
    return send(res, 200, { eventName: c.m.settings.eventName, codeRequired: !!c.m.settings.checkinCode, allowWalkIn: c.m.settings.allowWalkIn, quizState: c.m.quiz.state, quizTitle: c.m.quiz.title });
  }
  if (p === '/api/checkin' && M === 'POST') {
    return guarded('ci:' + clientIp(req), 60, async () => {
      const b = await readJson(req);
      const name = clampStr(b.name, 50); const contact = normContact(b.contact);
      if (!name || !contact) throw fail('이름과 연락처(휴대전화 또는 이메일)를 입력하세요.');
      const out = await tx({ contact }, (c) => {
        const s = c.m.settings;
        if (s.checkinCode && String(b.code || '').trim().toUpperCase() !== s.checkinCode.toUpperCase()) {
          throw fail('현장 인증 코드가 올바르지 않습니다. 행사장 스크린의 코드를 확인하세요.');
        }
        let pp = c.me;
        if (!pp) {
          if (!s.allowWalkIn) throw fail('등록된 참석자 정보를 찾을 수 없습니다. 사전 등록한 연락처를 입력하거나 안내 데스크에 문의하세요.', 404);
          pp = { participant_id: newId('p'), name, organization: clampStr(b.organization, 80), contact_identifier: contact, checkin_status: 'REGISTERED', checked_in_at: null, created_at: now(), source: 'walk-in', token: null };
          c.audit('public', 'participants.walkin', name);
        } else if (normName(pp.name) !== normName(name)) {
          c.review('name_mismatch', `체크인 이름 불일치: 입력 "${name}" / 등록 "${pp.name}"`, { contact: maskContact(contact) });
          c.signal('screen');
          return fail('등록된 이름과 일치하지 않습니다. 사전 등록한 이름을 입력하세요.');
        }
        const already = pp.checkin_status === 'CHECKED_IN';
        let dirty = !c.me; // 현장 등록(새 행)
        if (!already) { pp.checkin_status = 'CHECKED_IN'; pp.checked_in_at = now(); c.audit('public', 'checkin', pp.name); dirty = true; }
        if (!pp.token) { pp.token = token(); dirty = true; }
        if (dirty) c.savePart(pp);
        return { token: pp.token, alreadyCheckedIn: already, participant: { name: pp.name, organization: pp.organization } };
      });
      return send(res, 200, out);
    });
  }
  if (p === '/api/me' && M === 'GET') {
    const tk = url.searchParams.get('token') || '';
    const c = new Ctx(await load({ token: tk }));
    if (!tk || !isChecked(c.me)) throw fail('체크인 정보가 없습니다.', 401);
    return send(res, 200, { participant: { name: c.me.name, organization: c.me.organization, checked_in_at: c.me.checked_in_at } });
  }
  if (p === '/api/quiz/join' && M === 'POST') {
    const b = await readJson(req);
    const tk = String(b.token || '');
    return send(res, 200, await tx({ token: tk }, (c) => {
      if (!tk || !isChecked(c.me)) throw fail('체크인 후 참여할 수 있습니다.', 401);
      maybeClose(c);
      const q = c.m.quiz;
      if (!['OPEN', 'RUNNING'].includes(q.state)) {
        if (c.mainDirty) return playerView(c, c.me, c.entry); // 방금 자동 마감됨
        throw fail(q.state === 'IDLE' ? '퀴즈 대기실이 아직 열리지 않았습니다.' : '퀴즈가 이미 마감되었습니다.', 409);
      }
      let e = c.entry;
      if (!e) {
        e = { joined_at: now(), answers: [], current: 0, shown_at: q.state === 'RUNNING' ? now() : null, finished: false, finished_at: null, elapsed_ms: null };
        c.saveEntry(c.me.participant_id, e, 0);
      }
      return playerView(c, c.me, e);
    }));
  }
  if (p === '/api/quiz/answer' && M === 'POST') {
    const b = await readJson(req);
    const tk = String(b.token || '');
    return send(res, 200, await tx({ token: tk }, (c) => {
      if (!tk || !isChecked(c.me)) throw fail('체크인 정보가 없습니다.', 401);
      const e = c.entry;
      if (!e) throw fail('퀴즈에 참여하지 않았습니다.', 409);
      const m = c.m;
      if (m.quiz.state !== 'RUNNING') return playerView(c, c.me, e);
      const changed = advance(m, e, t0);
      const idx = Number(b.index);
      if (e.finished || idx < e.current) { // 재전송/중복 제출 → 무시
        if (changed) c.saveEntry(c.me.participant_id, e, c.entryVer);
        return playerView(c, c.me, e);
      }
      if (idx !== e.current) throw fail('잘못된 문항 번호입니다.', 409);
      const opt = b.option === null || b.option === undefined ? null : Number(b.option);
      if (opt !== null && !(Number.isInteger(opt) && opt >= 0 && opt <= 3)) throw fail('보기는 A~D 중 하나여야 합니다.');
      e.answers.push({ option: opt, at: t0, timed_out: opt === null });
      e.current++;
      if (e.current >= m.quiz.questions.length) finishEntry(m, e, t0); else e.shown_at = t0;
      c.saveEntry(c.me.participant_id, e, c.entryVer);
      return playerView(c, c.me, e);
    }));
  }

  /* ── 인증 ── */
  if (p === '/api/login' && M === 'POST') {
    const b = await readJson(req);
    const pw = String(b.password || '');
    const eq = (a, bb) => { const x = Buffer.from(a); const y = Buffer.from(bb); return x.length === y.length && crypto.timingSafeEqual(x, y); };
    const r = await guarded('login:' + clientIp(req), 10, async () => {
      const rr = eq(pw, ADMIN_PASSWORD) ? 'super' : eq(pw, OPERATOR_PASSWORD) ? 'operator' : null;
      if (!rr) throw fail('비밀번호가 올바르지 않습니다.', 401);
      return rr;
    });
    await dbWrite([{ t: 'audit', at: now(), actor: r, action: 'login', detail: clientIp(req) }]);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { role: r }, { 'Set-Cookie': `sid=${makeSession(r)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
  }
  if (p === '/api/logout' && M === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }
  if (p === '/api/admin/whoami' && M === 'GET') { need('operator'); return send(res, 200, { role }); }

  /* ── 관리자 ── */
  if (p.startsWith('/api/admin/export/') && M === 'GET') {
    need('operator');
    const name = p.split('/').pop();
    const fmt = (t) => (t ? new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '');
    const c = new Ctx(await load({ ...ADMIN_READ, audit: 1000000 }));
    const byId = new Map(c.parts.map((x) => [x.participant_id, x]));
    let csv;
    if (name === 'participants.csv') {
      csv = toCsv(['participant_id', '이름', '소속', '연락처', '상태', '체크인 시각', '등록 시각', '출처'],
        c.parts.map((x) => [x.participant_id, x.name, x.organization, x.contact_identifier, x.checkin_status, fmt(x.checked_in_at), fmt(x.created_at), x.source]));
    } else if (name === 'draws.csv') {
      csv = toCsv(['draw_id', '등수', '상품', '이름', '소속', '추첨 시각', '상태', '사유'],
        c.m.draws.map((d) => { const pp = byId.get(d.participant_id) || {}; return [d.draw_id, d.rank, d.prize_name, pp.name, pp.organization, fmt(d.drawn_at), d.status, d.audit_reason]; }));
    } else if (name === 'quiz.csv') {
      const r = ranking(c);
      csv = toCsv(['순위', '이름', '소속', '정답 수', '문항 수', '만점', '완료', '풀이 시간(ms)', '수상 순위', '답안'],
        r.list.map((x) => {
          const w = r.winners.find((y) => y.participant_id === x.participant_id); const e = c.entries[x.participant_id];
          return [x.rank, x.name, x.organization, x.correct, x.total, x.all_correct ? 'Y' : 'N', x.finished ? 'Y' : 'N', x.elapsed_ms, w ? w.award_rank : '', e.answers.map((a) => (a.option == null ? '-' : 'ABCD'[a.option])).join('')];
        }));
    } else if (name === 'audit.csv') {
      csv = toCsv(['시각', '작업자', '동작', '내용'], c.audits.slice().reverse().map((a) => [fmt(a.at), a.actor, a.action, a.detail]));
    } else throw fail('알 수 없는 파일', 404);
    await dbWrite([{ t: 'audit', at: now(), actor: role, action: 'export', detail: name }]);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return res.end(csv);
  }
  if (p === '/api/admin/upload' && M === 'POST') {
    need('operator');
    const ct = req.headers['content-type'] || '';
    const mime = ct.split(';')[0].trim();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
    if (!ext) throw fail('PNG, JPG, WEBP, GIF 이미지만 업로드할 수 있습니다.');
    const buf = await readBody(req, MAX_UPLOAD);
    if (!buf.length) throw fail('빈 파일입니다.');
    const id = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
    await dbWrite([{ t: 'upload', id, mime, b64: buf.toString('base64') }]);
    return send(res, 200, { url: `/uploads/${id}` });
  }

  if (!p.startsWith('/api/admin/') || M !== 'POST') throw fail('Not found', 404);
  need('operator');
  const b = await readJson(req);

  // 시트 내려받기는 트랜잭션(재시도) 밖에서 한 번만
  let sheetText = null;
  if (p === '/api/admin/participants/sync') {
    const cur = new Ctx(await load({}));
    const u = sheetCsvUrl(b.url || cur.m.settings.sheetCsvUrl);
    if (!/^https:\/\//.test(u)) throw fail('Google Sheets 주소(https)를 설정하세요.');
    try {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      sheetText = await r.text();
      if (!r.ok || /^\s*<(!doctype|html)/i.test(sheetText)) throw fail(`HTTP ${r.status}`);
    } catch (e) {
      throw fail(`시트를 불러오지 못했습니다 (${e.message}). 시트 공유를 "링크가 있는 모든 사용자: 뷰어"로 하거나 [파일 > 공유 > 웹에 게시 > CSV] 주소를 사용하세요.`);
    }
  }

  const result = await tx(ADMIN_READ, (c) => {
    const db = c.m;
    let out = { ok: true };
    switch (p) {
      case '/api/admin/settings': {
        need('super');
        const s = db.settings;
        if (b.eventName !== undefined) s.eventName = clampStr(b.eventName, 80) || s.eventName;
        if (b.checkinCode !== undefined) s.checkinCode = clampStr(b.checkinCode, 20).toUpperCase();
        if (b.allowWalkIn !== undefined) s.allowWalkIn = !!b.allowWalkIn;
        if (b.sheetCsvUrl !== undefined) s.sheetCsvUrl = clampStr(b.sheetCsvUrl, 500);
        if (b.publicUrl !== undefined) s.publicUrl = clampStr(b.publicUrl, 200).replace(/\/+$/, '');
        if (b.regenScreenKey) s.screenKey = crypto.randomBytes(5).toString('hex');
        c.audit(role, 'settings', JSON.stringify({ ...b, checkinCode: b.checkinCode !== undefined ? '(변경)' : undefined }));
        c.touch('all');
        break;
      }
      case '/api/admin/sound': {
        const s = db.settings.sound;
        if (b.bgm !== undefined) s.bgm = !!b.bgm;
        if (b.sfx !== undefined) s.sfx = !!b.sfx;
        if (b.volume !== undefined) s.volume = Math.max(0, Math.min(1, Number(b.volume) || 0));
        c.touch('screen');
        break;
      }
      case '/api/admin/participants/sync': {
        if (b.url) { db.settings.sheetCsvUrl = clampStr(b.url, 500); c.touch('screen'); }
        out = importRows(c, parseCsv(sheetText), role, 'google-sheets');
        c.signal('screen');
        break;
      }
      case '/api/admin/participants/import': {
        out = importRows(c, parseCsv(String(b.csv || '')), role, 'csv');
        c.signal('screen');
        break;
      }
      case '/api/admin/participants/add': {
        const name = clampStr(b.name, 50); const contact = normContact(b.contact);
        if (!name || !contact) throw fail('이름과 연락처를 입력하세요.');
        if (c.parts.some((x) => x.contact_identifier === contact)) throw fail('이미 같은 연락처로 등록된 참석자가 있습니다.');
        const pp = { participant_id: newId('p'), name, organization: clampStr(b.organization, 80), contact_identifier: contact, checkin_status: b.checkin ? 'CHECKED_IN' : 'REGISTERED', checked_in_at: b.checkin ? now() : null, created_at: now(), source: 'manual', token: null };
        c.parts.push(pp); c.savePart(pp);
        c.audit(role, 'participants.add', name);
        c.signal('screen');
        break;
      }
      case '/api/admin/participants/checkin': {
        const pp = c.parts.find((x) => x.participant_id === b.participant_id); if (!pp) throw fail('참석자를 찾을 수 없습니다.', 404);
        if (b.checked) { if (pp.checkin_status !== 'CHECKED_IN') { pp.checkin_status = 'CHECKED_IN'; pp.checked_in_at = now(); } }
        else {
          if (db.draws.some((d) => d.participant_id === pp.participant_id && d.status === 'VALID')) throw fail('당첨 이력이 있는 참석자는 체크인을 취소할 수 없습니다. 먼저 당첨을 무효 처리하세요.');
          pp.checkin_status = 'REGISTERED'; pp.checked_in_at = null;
        }
        c.savePart(pp);
        c.audit(role, 'participants.checkin', `${pp.name} → ${pp.checkin_status}`);
        c.signal('screen');
        break;
      }
      case '/api/admin/participants/delete': {
        need('super');
        const pp = c.parts.find((x) => x.participant_id === b.participant_id); if (!pp) throw fail('참석자를 찾을 수 없습니다.', 404);
        if (db.draws.some((d) => d.participant_id === pp.participant_id) || c.entries[pp.participant_id]) throw fail('추첨/퀴즈 기록이 있는 참석자는 삭제할 수 없습니다.');
        c.op({ t: 'part_del', id: pp.participant_id });
        c.audit(role, 'participants.delete', pp.name);
        c.signal('screen');
        break;
      }
      case '/api/admin/reviews/resolve': {
        c.op({ t: 'review_resolve', id: b.id || '', all: !!b.all });
        c.signal('screen');
        break;
      }
      case '/api/admin/prizes': {
        const rank = Number(b.rank); const pz = db.prizes[rank];
        if (!pz) throw fail('등수 오류');
        if (b.prize_name !== undefined) pz.prize_name = clampStr(b.prize_name, 80) || pz.prize_name;
        if (b.prize_image_url !== undefined) pz.prize_image_url = /^\/uploads\/[a-f0-9]+\.\w+$|^https:\/\//.test(b.prize_image_url) || b.prize_image_url === '' ? b.prize_image_url : pz.prize_image_url;
        if (b.winner_count !== undefined) pz.winner_count = Math.max(1, Math.min(100, Math.floor(Number(b.winner_count) || 1)));
        if (b.mode !== undefined) pz.mode = b.mode === 'batch' ? 'batch' : 'one';
        c.audit(role, 'prize.update', `${rank}등: ${pz.prize_name} × ${pz.winner_count} (${pz.mode})`);
        c.touch('screen');
        break;
      }
      case '/api/admin/draw': {
        out = { draw: runDraw(c, Number(b.rank), role) };
        c.touch('screen');
        break;
      }
      case '/api/admin/draw/void': {
        need('super');
        const d = db.draws.find((x) => x.draw_id === b.draw_id);
        if (!d || d.status !== 'VALID') throw fail('유효한 추첨 기록이 아닙니다.');
        const reason = clampStr(b.reason, 200);
        if (!reason) throw fail('무효 사유를 입력하세요.');
        d.status = 'VOID'; d.audit_reason = reason; d.voided_at = now(); d.exclude_after_void = !b.reinclude;
        const pp = c.parts.find((x) => x.participant_id === d.participant_id);
        c.audit(role, 'draw.void', `${d.rank}등 ${pp ? pp.name : ''} 무효 (사유: ${reason}, 재추첨 대상 ${b.reinclude ? '포함' : '제외'})`);
        c.touch('screen');
        break;
      }
      case '/api/admin/screen': {
        if (b.view && ['home', 'draw', 'quiz', 'results'].includes(b.view)) db.screen.view = b.view;
        if (b.closeDraw && db.screen.draw) db.screen.draw.open = false;
        c.touch('screen');
        break;
      }
      case '/api/admin/quiz': {
        const q = db.quiz;
        if (!['IDLE', 'OPEN'].includes(q.state)) throw fail('진행 중이거나 종료된 퀴즈는 수정할 수 없습니다. (초기화 후 수정)');
        if (b.title !== undefined) q.title = clampStr(b.title, 80) || q.title;
        if (b.winnerCount !== undefined) q.winnerCount = Math.max(1, Math.min(100, Math.floor(Number(b.winnerCount) || 1)));
        if (Array.isArray(b.questions)) {
          if (!b.questions.length) throw fail('문제를 1개 이상 등록하세요.');
          if (b.questions.length > 50) throw fail('문제는 최대 50개입니다.');
          q.questions = b.questions.map((x, i) => {
            const options = (Array.isArray(x.options) ? x.options : []).slice(0, 4).map((o) => clampStr(o, 120));
            const text = clampStr(x.question_text, 300);
            if (!text) throw fail(`${i + 1}번 문제 문구를 입력하세요.`);
            if (options.length !== 4 || options.some((o) => !o)) throw fail(`${i + 1}번 문제의 보기 4개를 모두 입력하세요.`);
            const co = Number(x.correct_option);
            if (!(Number.isInteger(co) && co >= 0 && co <= 3)) throw fail(`${i + 1}번 문제의 정답을 선택하세요.`);
            return { question_id: x.question_id || newId('q'), question_text: text, options, correct_option: co,
              time_limit: Math.max(5, Math.min(300, Math.floor(Number(x.time_limit) || 15))), explanation: clampStr(x.explanation, 300) };
          });
        }
        c.audit(role, 'quiz.update', `${q.title}, 문제 ${q.questions.length}개, 수상 ${q.winnerCount}명`);
        c.touch('all');
        break;
      }
      case '/api/admin/quiz/state': {
        const q = db.quiz; const a = b.action;
        if (a === 'open') {
          if (q.state !== 'IDLE') throw fail('대기 상태에서만 열 수 있습니다.');
          q.state = 'OPEN'; db.screen.view = 'quiz';
        } else if (a === 'start') {
          if (q.state !== 'OPEN') throw fail('대기실이 열린 상태에서만 시작할 수 있습니다.');
          // 대기실 입장자(shown_at 없음)는 시작 시각부터 1번 문항이 표시된 것으로 계산
          q.state = 'RUNNING'; q.started_at = now(); q.closed_at = null; q.revealed_at = null; q.final = null;
          db.screen.view = 'quiz';
        } else if (a === 'close') {
          if (q.state !== 'RUNNING') throw fail('진행 중인 퀴즈가 없습니다.');
          closeQuiz(c, role, '운영자 수동 마감');
          return out;
        } else if (a === 'reveal') {
          if (q.state !== 'CLOSED') throw fail('마감 후 결과를 발표할 수 있습니다.');
          q.state = 'REVEALED'; q.revealed_at = now(); db.screen.view = 'results';
          freezeFinal(c);
        } else if (a === 'reset') {
          need('super');
          Object.assign(q, { quiz_id: newId('quiz'), state: 'IDLE', started_at: null, closed_at: null, revealed_at: null, final: null });
          c.op({ t: 'entries_clear' });
        } else throw fail('알 수 없는 동작');
        c.audit(role, 'quiz.' + a, q.title);
        c.touch('all');
        break;
      }
      case '/api/admin/reset': {
        need('super');
        const t = b.target;
        if (!['draws', 'quiz', 'participants', 'all'].includes(t)) throw fail('초기화 대상 오류');
        const resetQuiz = () => { c.op({ t: 'entries_clear' }); Object.assign(db.quiz, { quiz_id: newId('quiz'), state: 'IDLE', started_at: null, closed_at: null, revealed_at: null, final: null }); };
        if (t === 'draws' || t === 'all') { db.draws = []; db.screen.draw = null; }
        if (t === 'quiz' || t === 'all') resetQuiz();
        if (t === 'participants' || t === 'all') {
          c.op({ t: 'parts_clear' }); c.op({ t: 'reviews_clear' }); db.draws = []; db.screen.draw = null;
          resetQuiz();
        }
        if (t === 'all') db.screen.view = 'home';
        c.audit(role, 'reset', t);
        c.touch('all');
        break;
      }
      default: throw fail('Not found', 404);
    }
    return out;
  });
  return send(res, 200, result);
}

/* 업로드한 상품 이미지 */
async function serveUpload(res, file) {
  if (!/^[a-f0-9]{16}\.(png|jpg|webp|gif)$/.test(file)) { res.writeHead(404); return res.end(); }
  const r = await rpc('ev_upload', { p_id: file });
  if (!r) { res.writeHead(404); return res.end(); }
  const buf = Buffer.from(r.b64, 'base64');
  res.writeHead(200, { 'Content-Type': r.mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(buf);
}

/* (req, res) 핸들러 — Vercel 함수와 로컬 서버가 공유 */
async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/uploads/')) return await serveUpload(res, url.pathname.slice('/uploads/'.length));
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    throw fail('Not found', 404);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : e.message });
    else res.end();
  }
}

module.exports = { handle, usingDefaultPasswords: !process.env.ADMIN_PASSWORD || !process.env.OPERATOR_PASSWORD };
