'use strict';
/*
 * 풀무원 컨퍼런스 럭키드로우 & 실시간 퀴즈 서버
 * - 외부 의존성 없음 (Node.js 18+ 내장 모듈만 사용)
 * - 실시간 전달: Server-Sent Events (SSE)
 * - 저장소: data/db.json (원자적 쓰기)
 * - 추첨/채점/시간 측정은 모두 서버에서 수행
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pulmuone-admin';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || 'pulmuone-op';
const GRACE_MS = 2000; // 문항별 네트워크 지연 허용치
const MAX_UPLOAD = 6 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ───────────────────────── 유틸 ───────────────────────── */
const now = () => Date.now();
const newId = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const token = () => crypto.randomBytes(24).toString('base64url');

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

/* ───────────────────────── 데이터 ───────────────────────── */
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
function defaultDb() {
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
    participants: [],
    reviews: [],
    prizes: { 1: samplePrize(1), 2: samplePrize(2), 3: samplePrize(3) },
    draws: [],
    quiz: {
      quiz_id: newId('quiz'), title: '풀무원 상식 퀴즈', winnerCount: 3, state: 'IDLE',
      started_at: null, closed_at: null, revealed_at: null, questions: sampleQuestions(),
    },
    entries: {},
    screen: { view: 'home', draw: null, seq: 0 },
    audit: [],
  };
}

let db;
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const d = defaultDb();
  db = { ...d, ...loaded, settings: { ...d.settings, ...(loaded.settings || {}), sound: { ...d.settings.sound, ...((loaded.settings || {}).sound || {}) } } };
} catch (e) {
  if (fs.existsSync(DB_FILE)) {
    const bak = DB_FILE + '.broken-' + now();
    fs.copyFileSync(DB_FILE, bak);
    console.error('[db] db.json 파싱 실패, 백업 후 새로 시작:', bak);
  }
  db = defaultDb();
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  const json = JSON.stringify(db);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    try { fs.writeFileSync(DB_FILE, json); } catch (e2) { console.error('[db] 저장 실패', e2); }
  }
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 150); }
saveNow();

function audit(actor, action, detail) {
  db.audit.push({ at: now(), actor, action, detail });
  if (db.audit.length > 5000) db.audit.splice(0, db.audit.length - 5000);
}
function review(type, detail, row) {
  db.reviews.push({ id: newId('rv'), at: now(), type, detail, row: row || null, resolved: false });
}
const pById = (id) => db.participants.find((p) => p.participant_id === id);
const pByToken = (t) => (t ? db.participants.find((p) => p.token === t && p.checkin_status === 'CHECKED_IN') : null);

/* ───────────────────────── CSV ───────────────────────── */
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
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

function importRows(rows, actor, source) {
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
    if (!name || !contact) { res.errors++; review('missing_field', '이름 또는 연락처 누락', rowObj); continue; }
    if (m.consent >= 0) {
      const c = String(r[m.consent] || '');
      if (!c.includes('동의') || /미동의|비동의|동의하지|않/.test(c)) { res.errors++; review('no_consent', '개인정보 수집 미동의', rowObj); continue; }
    }
    if (seen.has(contact)) { res.duplicates++; review('duplicate', '같은 연락처로 중복 응답', rowObj); continue; }
    seen.add(contact);
    const ex = db.participants.find((p) => p.contact_identifier === contact);
    if (ex) {
      if (normName(ex.name) !== normName(name)) {
        res.duplicates++; review('conflict', `기존 참석자(${ex.name})와 연락처가 같지만 이름이 다름`, rowObj); continue;
      }
      if (organization && ex.organization !== organization) { ex.organization = organization; res.updated++; } else res.unchanged++;
      continue;
    }
    db.participants.push({
      participant_id: newId('p'), name, organization, contact_identifier: contact,
      checkin_status: 'REGISTERED', checked_in_at: null, created_at: now(), source, token: null,
    });
    res.added++;
  }
  audit(actor, 'participants.import', `${source}: 추가 ${res.added}, 갱신 ${res.updated}, 중복 ${res.duplicates}, 오류 ${res.errors}`);
  save();
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
function excludedSet() {
  return new Set(db.draws.filter((d) => d.status === 'VALID' || d.exclude_after_void).map((d) => d.participant_id));
}
function eligible() {
  const ex = excludedSet();
  return db.participants.filter((p) => p.checkin_status === 'CHECKED_IN' && !ex.has(p.participant_id));
}
function pickRandom(arr, k) {
  const a = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + crypto.randomInt(a.length - i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}
let lastDrawAt = 0;
function runDraw(rank, actor) {
  const prize = db.prizes[rank];
  if (!prize) throw fail('등수를 선택하세요.');
  if (now() - lastDrawAt < 1500) throw fail('추첨이 진행 중입니다. 잠시 후 다시 시도하세요.');
  const validCount = db.draws.filter((d) => d.rank === rank && d.status === 'VALID').length;
  const remaining = prize.winner_count - validCount;
  if (remaining <= 0) throw fail(`${rank}등은 이미 ${prize.winner_count}명 추첨이 완료되었습니다.`);
  const pool = eligible();
  if (!pool.length) throw fail('추첨 가능한 참석자가 없습니다. (체크인 완료 & 미당첨자 0명)');
  const k = prize.mode === 'batch' ? Math.min(remaining, pool.length) : 1;
  const winners = pickRandom(pool, k);
  // 서버 확정 단계 이중 검증
  const ex = excludedSet();
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
  lastDrawAt = at;
  db.screen.seq++;
  db.screen.view = 'draw';
  db.screen.draw = {
    seq: db.screen.seq, batch_id: batch, rank, prize_name: prize.prize_name, prize_image_url: prize.prize_image_url,
    winners: winners.map((w) => ({ name: w.name, organization: w.organization })),
    pool: pickRandom(pool, Math.min(pool.length, 40)).map((p) => p.name),
    at, open: true,
  };
  audit(actor, 'draw.run', `${rank}등 (${prize.prize_name}) → ${winners.map((w) => w.name).join(', ')}`);
  save();
  return db.screen.draw;
}

/* ───────────────────────── 퀴즈 ───────────────────────── */
let quizMono = null; // { hr: bigint, wall: number } — 서버 단조 시계 기준점
const qs = () => db.quiz.questions;
function quizDeadline() {
  const q = db.quiz;
  if (!q.started_at) return null;
  return q.started_at + qs().reduce((s, x) => s + x.time_limit * 1000, 0) + GRACE_MS * 2;
}
function elapsedAt(wall, useMono) {
  if (useMono && quizMono && quizMono.wall === db.quiz.started_at) {
    return Math.round(Number(process.hrtime.bigint() - quizMono.hr) / 1e6);
  }
  return wall - db.quiz.started_at;
}
function finishEntry(e, wall, useMono) {
  e.finished = true; e.finished_at = wall; e.elapsed_ms = Math.max(0, elapsedAt(wall, useMono));
}
function advance(e) {
  if (db.quiz.state !== 'RUNNING' || e.finished || e.shown_at == null) return false;
  let changed = false;
  const n = qs().length;
  while (!e.finished && e.current < n) {
    const dl = e.shown_at + qs()[e.current].time_limit * 1000;
    if (now() <= dl + GRACE_MS) break;
    e.answers.push({ option: null, at: null, timed_out: true });
    e.current++; e.shown_at = dl; changed = true;
    if (e.current >= n) finishEntry(e, dl, false);
  }
  if (changed) save();
  return changed;
}
function scoreEntry(e) {
  let correct = 0;
  qs().forEach((q, i) => { if (e.answers[i] && e.answers[i].option === q.correct_option) correct++; });
  const total = qs().length;
  const elapsed = e.finished ? e.elapsed_ms : ((db.quiz.closed_at || now()) - (db.quiz.started_at || now()));
  return { correct, total, all_correct: e.finished && correct === total && total > 0, elapsed_ms: elapsed, finished: !!e.finished };
}
function ranking() {
  const list = [];
  for (const [pid, e] of Object.entries(db.entries)) {
    const p = pById(pid);
    if (!p) continue;
    list.push({ participant_id: pid, name: p.name, organization: p.organization, answered: e.answers.length, ...scoreEntry(e) });
  }
  if (!db.quiz.started_at) return { list, winners: [], tieAtCutoff: false };
  list.sort((a, b) => b.correct - a.correct || a.elapsed_ms - b.elapsed_ms);
  list.forEach((r, i) => {
    const prev = list[i - 1];
    r.rank = prev && prev.correct === r.correct && prev.elapsed_ms === r.elapsed_ms ? prev.rank : i + 1;
  });
  const perfect = list.filter((r) => r.all_correct).sort((a, b) => a.elapsed_ms - b.elapsed_ms);
  const N = db.quiz.winnerCount;
  const winners = perfect.slice(0, N).map((r, i) => ({ ...r, award_rank: i + 1 }));
  const tieAtCutoff = perfect.length > N && perfect[N].elapsed_ms === perfect[N - 1].elapsed_ms;
  return { list, winners, tieAtCutoff, perfectCount: perfect.length };
}
function closeQuiz(actor, reason) {
  const q = db.quiz;
  if (q.state !== 'RUNNING') return;
  for (const e of Object.values(db.entries)) advance(e);
  q.state = 'CLOSED'; q.closed_at = now();
  audit(actor, 'quiz.close', reason);
  save();
}
setInterval(() => {
  if (db.quiz.state === 'RUNNING') {
    const dl = quizDeadline();
    if (dl && now() > dl) { closeQuiz('system', '제한 시간 종료로 자동 마감'); broadcast(); }
  }
}, 1000);

function playerView(p) {
  const q = db.quiz;
  const e = db.entries[p.participant_id];
  const out = {
    serverNow: now(),
    eventName: db.settings.eventName,
    quiz: { state: q.state, title: q.title, count: qs().length, deadline: quizDeadline() },
    me: { name: p.name, organization: p.organization, joined: !!e },
  };
  if (!e) return out;
  advance(e);
  Object.assign(out.me, { current: e.current, finished: !!e.finished, answered: e.answers.length });
  if (q.state === 'RUNNING' && !e.finished && e.shown_at != null) {
    const qq = qs()[e.current];
    out.me.question = { index: e.current, text: qq.question_text, options: qq.options, time_limit: qq.time_limit, shown_at: e.shown_at };
  }
  if (q.state === 'CLOSED' || q.state === 'REVEALED') {
    const s = scoreEntry(e);
    out.me.result = { correct: s.correct, total: s.total, all_correct: s.all_correct, elapsed_ms: s.elapsed_ms, finished: s.finished };
    if (q.state === 'REVEALED') {
      const r = ranking();
      const mine = r.list.find((x) => x.participant_id === p.participant_id);
      const w = r.winners.find((x) => x.participant_id === p.participant_id);
      out.me.result.rank = mine ? mine.rank : null;
      out.me.result.of = r.list.length;
      out.me.result.award_rank = w ? w.award_rank : null;
      out.me.result.review = qs().map((qq, i) => ({
        text: qq.question_text, options: qq.options, correct: qq.correct_option,
        mine: e.answers[i] ? e.answers[i].option : null, explanation: qq.explanation || '',
      }));
    }
  }
  return out;
}

/* ───────────────────────── 상태 뷰 ───────────────────────── */
function stats() {
  const total = db.participants.length;
  const checkedIn = db.participants.filter((p) => p.checkin_status === 'CHECKED_IN').length;
  const entries = Object.values(db.entries);
  return {
    total, checkedIn, notCheckedIn: total - checkedIn, eligible: eligible().length,
    quizJoined: entries.length, quizFinished: entries.filter((e) => e.finished).length,
    reviewsOpen: db.reviews.filter((r) => !r.resolved).length,
  };
}
function publicView(withKey) {
  const q = db.quiz;
  const st = stats();
  const out = {
    serverNow: now(),
    eventName: db.settings.eventName,
    publicUrl: db.settings.publicUrl,
    sound: db.settings.sound,
    view: db.screen.view,
    stats: { checkedIn: st.checkedIn, quizJoined: st.quizJoined, quizFinished: st.quizFinished },
    checkin: { codeRequired: !!db.settings.checkinCode, code: withKey ? db.settings.checkinCode : null },
    prizes: [1, 2, 3].map((r) => ({ rank: r, prize_name: db.prizes[r].prize_name, prize_image_url: db.prizes[r].prize_image_url, winner_count: db.prizes[r].winner_count })),
    draw: db.screen.draw,
    quiz: { state: q.state, title: q.title, count: qs().length, started_at: q.started_at, deadline: quizDeadline(), winnerCount: q.winnerCount },
    reveal: null,
  };
  if (q.state === 'REVEALED') {
    const r = ranking();
    const strip = (x) => ({ name: x.name, organization: x.organization, correct: x.correct, total: x.total, elapsed_ms: x.elapsed_ms, rank: x.rank, award_rank: x.award_rank });
    out.reveal = { at: q.revealed_at, winners: r.winners.map(strip), top: r.list.slice(0, 10).map(strip), perfectCount: r.perfectCount, participants: r.list.length };
  }
  return out;
}
function adminView(role) {
  const r = ranking();
  const list = r.list;
  const avg = list.length ? list.reduce((s, x) => s + x.correct, 0) / list.length : 0;
  const finishedList = list.filter((x) => x.finished);
  return {
    role, serverNow: now(),
    settings: db.settings,
    stats: stats(),
    participants: db.participants.map((p) => ({
      participant_id: p.participant_id, name: p.name, organization: p.organization, contact: maskContact(p.contact_identifier),
      checkin_status: p.checkin_status, checked_in_at: p.checked_in_at, created_at: p.created_at, source: p.source,
    })),
    reviews: db.reviews.filter((x) => !x.resolved).slice(-300),
    prizes: db.prizes,
    draws: db.draws.map((d) => { const p = pById(d.participant_id); return { ...d, name: p ? p.name : '(삭제됨)', organization: p ? p.organization : '' }; }),
    quiz: { ...db.quiz, deadline: quizDeadline() },
    quizLive: {
      ranking: list, winners: r.winners, tieAtCutoff: r.tieAtCutoff, perfectCount: r.perfectCount || 0,
      joined: list.length, finished: finishedList.length, avg,
      best: list.length ? Math.max(...list.map((x) => x.correct)) : 0,
      fastest: finishedList.length ? Math.min(...finishedList.map((x) => x.elapsed_ms)) : null,
    },
    screen: db.screen,
    audit: db.audit.slice(-150).reverse(),
  };
}

/* ───────────────────────── SSE ───────────────────────── */
const clients = new Set();
let bTimer = null; let lastAdminPush = 0; let adminTimer = null;
function sse(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function pushAdmins() {
  lastAdminPush = now(); adminTimer = null;
  for (const c of clients) if (c.role === 'admin') sse(c.res, adminView(c.adminRole));
}
function broadcast() {
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    const pubKey = publicView(true); const pub = publicView(false);
    for (const c of clients) {
      if (c.role === 'screen') sse(c.res, c.key ? pubKey : pub);
      else if (c.role === 'player') { const p = pByToken(c.token); if (p) sse(c.res, playerView(p)); }
    }
    const wait = 700 - (now() - lastAdminPush);
    if (wait <= 0) pushAdmins(); else if (!adminTimer) adminTimer = setTimeout(pushAdmins, wait);
  }, 60);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000);

/* ───────────────────────── HTTP 공통 ───────────────────────── */
const sessions = new Map();
function parseCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); });
  return o;
}
function getRole(req) {
  const sid = parseCookies(req).sid;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.exp < now()) { sessions.delete(sid); return null; }
  return s.role;
}
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('요청 크기가 너무 큽니다.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON 요청만 허용됩니다.'), { status: 415 });
  const b = await readBody(req, 1024 * 1024);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw Object.assign(new Error('잘못된 JSON'), { status: 400 }); }
}
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

const rate = new Map();
/* 실패한 시도만 센다 — 행사장 와이파이처럼 수백 명이 같은 공인 IP를 쓰는 환경에서도 정상 사용자는 막지 않음 */
function failGuard(key, max) {
  const r = rate.get(key);
  if (r && r.reset > now() && r.n >= max) throw fail('실패한 시도가 너무 많습니다. 1분 후 다시 시도하세요.', 429);
}
function failHit(key, windowMs) {
  const t = now(); const r = rate.get(key);
  if (!r || r.reset < t) rate.set(key, { n: 1, reset: t + windowMs }); else r.n++;
}
async function guarded(key, max, fn) {
  failGuard(key, max);
  try { return await fn(); } catch (e) { if (e.status && e.status !== 429 && e.status < 500) failHit(key, 60000); throw e; }
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

/* ───────────────────────── API ───────────────────────── */
async function api(req, res, url) {
  const p = url.pathname;
  const M = req.method;
  const role = getRole(req);
  const actor = role || 'public';
  const need = (r) => {
    if (!role) throw fail('관리자 로그인이 필요합니다.', 401);
    if (r === 'super' && role !== 'super') throw fail('최고 관리자 권한이 필요합니다.', 403);
  };

  /* ── 실시간 스트림 ── */
  if (p === '/api/stream' && M === 'GET') {
    const kind = url.searchParams.get('role');
    const c = { res, role: kind };
    if (kind === 'admin') { need('operator'); c.adminRole = role; }
    else if (kind === 'player') { c.token = url.searchParams.get('token'); if (!pByToken(c.token)) throw fail('체크인 정보가 없습니다.', 401); }
    else if (kind === 'screen') { c.key = url.searchParams.get('key') === db.settings.screenKey; }
    else throw fail('알 수 없는 스트림');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    if (kind === 'admin') sse(res, adminView(role));
    else if (kind === 'player') sse(res, playerView(pByToken(c.token)));
    else sse(res, publicView(c.key));
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return;
  }

  /* ── 공개 ── */
  if (p === '/api/public/info' && M === 'GET') {
    return send(res, 200, { eventName: db.settings.eventName, codeRequired: !!db.settings.checkinCode, allowWalkIn: db.settings.allowWalkIn, quizState: db.quiz.state, quizTitle: db.quiz.title });
  }
  if (p === '/api/checkin' && M === 'POST') {
    return guarded('ci:' + clientIp(req), 60, async () => {
    const b = await readJson(req);
    const name = clampStr(b.name, 50); const contact = normContact(b.contact);
    if (!name || !contact) throw fail('이름과 연락처(휴대전화 또는 이메일)를 입력하세요.');
    if (db.settings.checkinCode && String(b.code || '').trim().toUpperCase() !== db.settings.checkinCode.toUpperCase()) {
      throw fail('현장 인증 코드가 올바르지 않습니다. 행사장 스크린의 코드를 확인하세요.');
    }
    let pp = db.participants.find((x) => x.contact_identifier === contact);
    if (!pp) {
      if (!db.settings.allowWalkIn) throw fail('등록된 참석자 정보를 찾을 수 없습니다. 사전 등록한 연락처를 입력하거나 안내 데스크에 문의하세요.', 404);
      pp = { participant_id: newId('p'), name, organization: clampStr(b.organization, 80), contact_identifier: contact, checkin_status: 'REGISTERED', checked_in_at: null, created_at: now(), source: 'walk-in', token: null };
      db.participants.push(pp);
      audit('public', 'participants.walkin', name);
    } else if (normName(pp.name) !== normName(name)) {
      review('name_mismatch', `체크인 이름 불일치: 입력 "${name}" / 등록 "${pp.name}"`, { contact: maskContact(contact) });
      save(); broadcast();
      throw fail('등록된 이름과 일치하지 않습니다. 사전 등록한 이름을 입력하세요.');
    }
    const already = pp.checkin_status === 'CHECKED_IN';
    if (!already) { pp.checkin_status = 'CHECKED_IN'; pp.checked_in_at = now(); audit('public', 'checkin', pp.name); }
    if (!pp.token) pp.token = token();
    save(); broadcast();
    return send(res, 200, { token: pp.token, alreadyCheckedIn: already, participant: { name: pp.name, organization: pp.organization } });
    });
  }
  if (p === '/api/me' && M === 'GET') {
    const pp = pByToken(url.searchParams.get('token'));
    if (!pp) throw fail('체크인 정보가 없습니다.', 401);
    return send(res, 200, { participant: { name: pp.name, organization: pp.organization, checked_in_at: pp.checked_in_at } });
  }
  if (p === '/api/quiz/join' && M === 'POST') {
    const b = await readJson(req);
    const pp = pByToken(b.token);
    if (!pp) throw fail('체크인 후 참여할 수 있습니다.', 401);
    const q = db.quiz;
    if (!['OPEN', 'RUNNING'].includes(q.state)) throw fail(q.state === 'IDLE' ? '퀴즈 대기실이 아직 열리지 않았습니다.' : '퀴즈가 이미 마감되었습니다.', 409);
    if (!db.entries[pp.participant_id]) {
      db.entries[pp.participant_id] = { joined_at: now(), answers: [], current: 0, shown_at: q.state === 'RUNNING' ? now() : null, finished: false, finished_at: null, elapsed_ms: null };
      save(); broadcast();
    }
    return send(res, 200, playerView(pp));
  }
  if (p === '/api/quiz/answer' && M === 'POST') {
    const b = await readJson(req);
    const pp = pByToken(b.token);
    if (!pp) throw fail('체크인 정보가 없습니다.', 401);
    const e = db.entries[pp.participant_id];
    if (!e) throw fail('퀴즈에 참여하지 않았습니다.', 409);
    if (db.quiz.state !== 'RUNNING') return send(res, 200, playerView(pp));
    advance(e);
    const idx = Number(b.index);
    if (e.finished || idx < e.current) return send(res, 200, playerView(pp)); // 재전송/중복 제출 → 무시
    if (idx !== e.current) throw fail('잘못된 문항 번호입니다.', 409);
    const opt = b.option === null || b.option === undefined ? null : Number(b.option);
    if (opt !== null && !(Number.isInteger(opt) && opt >= 0 && opt <= 3)) throw fail('보기는 A~D 중 하나여야 합니다.');
    const t = now();
    e.answers.push({ option: opt, at: t, timed_out: opt === null });
    e.current++;
    if (e.current >= qs().length) finishEntry(e, t, true); else e.shown_at = t;
    save(); broadcast();
    return send(res, 200, playerView(pp));
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
    const sid = token();
    sessions.set(sid, { role: r, exp: now() + 12 * 3600 * 1000 });
    audit(r, 'login', clientIp(req));
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { role: r }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
  }
  if (p === '/api/logout' && M === 'POST') {
    const sid = parseCookies(req).sid; if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }
  if (p === '/api/admin/whoami' && M === 'GET') { need('operator'); return send(res, 200, { role }); }

  /* ── 관리자 ── */
  if (p.startsWith('/api/admin/export/') && M === 'GET') {
    need('operator');
    const name = p.split('/').pop();
    const fmt = (t) => (t ? new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '');
    let csv;
    if (name === 'participants.csv') {
      csv = toCsv(['participant_id', '이름', '소속', '연락처', '상태', '체크인 시각', '등록 시각', '출처'],
        db.participants.map((x) => [x.participant_id, x.name, x.organization, x.contact_identifier, x.checkin_status, fmt(x.checked_in_at), fmt(x.created_at), x.source]));
    } else if (name === 'draws.csv') {
      csv = toCsv(['draw_id', '등수', '상품', '이름', '소속', '추첨 시각', '상태', '사유'],
        db.draws.map((d) => { const pp = pById(d.participant_id) || {}; return [d.draw_id, d.rank, d.prize_name, pp.name, pp.organization, fmt(d.drawn_at), d.status, d.audit_reason]; }));
    } else if (name === 'quiz.csv') {
      const r = ranking();
      csv = toCsv(['순위', '이름', '소속', '정답 수', '문항 수', '만점', '완료', '풀이 시간(ms)', '수상 순위', '답안'],
        r.list.map((x) => { const w = r.winners.find((y) => y.participant_id === x.participant_id); const e = db.entries[x.participant_id];
          return [x.rank, x.name, x.organization, x.correct, x.total, x.all_correct ? 'Y' : 'N', x.finished ? 'Y' : 'N', x.elapsed_ms, w ? w.award_rank : '', e.answers.map((a) => (a.option == null ? '-' : 'ABCD'[a.option])).join('')]; }));
    } else if (name === 'audit.csv') {
      csv = toCsv(['시각', '작업자', '동작', '내용'], db.audit.map((a) => [fmt(a.at), a.actor, a.action, a.detail]));
    } else throw fail('알 수 없는 파일', 404);
    audit(role, 'export', name);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return res.end(csv);
  }
  if (p === '/api/admin/upload' && M === 'POST') {
    need('operator');
    const ct = req.headers['content-type'] || '';
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[ct.split(';')[0]];
    if (!ext) throw fail('PNG, JPG, WEBP, GIF 이미지만 업로드할 수 있습니다.');
    const buf = await readBody(req, MAX_UPLOAD);
    const fname = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
    return send(res, 200, { url: `/uploads/${fname}` });
  }

  if (!p.startsWith('/api/admin/') || M !== 'POST') throw fail('Not found', 404);
  need('operator');
  const b = await readJson(req);
  let result = { ok: true };
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
      audit(role, 'settings', JSON.stringify({ ...b, checkinCode: b.checkinCode !== undefined ? '(변경)' : undefined }));
      break;
    }
    case '/api/admin/sound': {
      const s = db.settings.sound;
      if (b.bgm !== undefined) s.bgm = !!b.bgm;
      if (b.sfx !== undefined) s.sfx = !!b.sfx;
      if (b.volume !== undefined) s.volume = Math.max(0, Math.min(1, Number(b.volume) || 0));
      break;
    }
    case '/api/admin/participants/sync': {
      const u = sheetCsvUrl(b.url || db.settings.sheetCsvUrl);
      if (!/^https:\/\//.test(u)) throw fail('Google Sheets 주소(https)를 설정하세요.');
      if (b.url) db.settings.sheetCsvUrl = clampStr(b.url, 500);
      let text;
      try {
        const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        text = await r.text();
        if (!r.ok || /^\s*<(!doctype|html)/i.test(text)) throw fail(`HTTP ${r.status}`);
      } catch (e) {
        throw fail(`시트를 불러오지 못했습니다 (${e.message}). 시트 공유를 "링크가 있는 모든 사용자: 뷰어"로 하거나 [파일 > 공유 > 웹에 게시 > CSV] 주소를 사용하세요.`);
      }
      result = importRows(parseCsv(text), role, 'google-sheets');
      break;
    }
    case '/api/admin/participants/import': {
      result = importRows(parseCsv(String(b.csv || '')), role, 'csv');
      break;
    }
    case '/api/admin/participants/add': {
      const name = clampStr(b.name, 50); const contact = normContact(b.contact);
      if (!name || !contact) throw fail('이름과 연락처를 입력하세요.');
      if (db.participants.some((x) => x.contact_identifier === contact)) throw fail('이미 같은 연락처로 등록된 참석자가 있습니다.');
      const pp = { participant_id: newId('p'), name, organization: clampStr(b.organization, 80), contact_identifier: contact, checkin_status: b.checkin ? 'CHECKED_IN' : 'REGISTERED', checked_in_at: b.checkin ? now() : null, created_at: now(), source: 'manual', token: null };
      db.participants.push(pp);
      audit(role, 'participants.add', name);
      break;
    }
    case '/api/admin/participants/checkin': {
      const pp = pById(b.participant_id); if (!pp) throw fail('참석자를 찾을 수 없습니다.', 404);
      if (b.checked) { if (pp.checkin_status !== 'CHECKED_IN') { pp.checkin_status = 'CHECKED_IN'; pp.checked_in_at = now(); } }
      else {
        if (db.draws.some((d) => d.participant_id === pp.participant_id && d.status === 'VALID')) throw fail('당첨 이력이 있는 참석자는 체크인을 취소할 수 없습니다. 먼저 당첨을 무효 처리하세요.');
        pp.checkin_status = 'REGISTERED'; pp.checked_in_at = null;
      }
      audit(role, 'participants.checkin', `${pp.name} → ${pp.checkin_status}`);
      break;
    }
    case '/api/admin/participants/delete': {
      need('super');
      const pp = pById(b.participant_id); if (!pp) throw fail('참석자를 찾을 수 없습니다.', 404);
      if (db.draws.some((d) => d.participant_id === pp.participant_id) || db.entries[pp.participant_id]) throw fail('추첨/퀴즈 기록이 있는 참석자는 삭제할 수 없습니다.');
      db.participants = db.participants.filter((x) => x !== pp);
      audit(role, 'participants.delete', pp.name);
      break;
    }
    case '/api/admin/reviews/resolve': {
      const r = db.reviews.find((x) => x.id === b.id); if (r) r.resolved = true;
      if (b.all) db.reviews.forEach((x) => { x.resolved = true; });
      break;
    }
    case '/api/admin/prizes': {
      const rank = Number(b.rank); const pz = db.prizes[rank];
      if (!pz) throw fail('등수 오류');
      if (b.prize_name !== undefined) pz.prize_name = clampStr(b.prize_name, 80) || pz.prize_name;
      if (b.prize_image_url !== undefined) pz.prize_image_url = /^\/uploads\/[a-f0-9]+\.\w+$|^https:\/\//.test(b.prize_image_url) || b.prize_image_url === '' ? b.prize_image_url : pz.prize_image_url;
      if (b.winner_count !== undefined) pz.winner_count = Math.max(1, Math.min(100, Math.floor(Number(b.winner_count) || 1)));
      if (b.mode !== undefined) pz.mode = b.mode === 'batch' ? 'batch' : 'one';
      audit(role, 'prize.update', `${rank}등: ${pz.prize_name} × ${pz.winner_count} (${pz.mode})`);
      break;
    }
    case '/api/admin/draw': {
      result = { draw: runDraw(Number(b.rank), role) };
      break;
    }
    case '/api/admin/draw/void': {
      need('super');
      const d = db.draws.find((x) => x.draw_id === b.draw_id);
      if (!d || d.status !== 'VALID') throw fail('유효한 추첨 기록이 아닙니다.');
      const reason = clampStr(b.reason, 200);
      if (!reason) throw fail('무효 사유를 입력하세요.');
      d.status = 'VOID'; d.audit_reason = reason; d.voided_at = now(); d.exclude_after_void = !b.reinclude;
      const pp = pById(d.participant_id);
      audit(role, 'draw.void', `${d.rank}등 ${pp ? pp.name : ''} 무효 (사유: ${reason}, 재추첨 대상 ${b.reinclude ? '포함' : '제외'})`);
      break;
    }
    case '/api/admin/screen': {
      if (b.view && ['home', 'draw', 'quiz', 'results'].includes(b.view)) db.screen.view = b.view;
      if (b.closeDraw && db.screen.draw) db.screen.draw.open = false;
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
      audit(role, 'quiz.update', `${q.title}, 문제 ${q.questions.length}개, 수상 ${q.winnerCount}명`);
      break;
    }
    case '/api/admin/quiz/state': {
      const q = db.quiz; const a = b.action;
      if (a === 'open') {
        if (q.state !== 'IDLE') throw fail('대기 상태에서만 열 수 있습니다.');
        q.state = 'OPEN'; db.screen.view = 'quiz';
      } else if (a === 'start') {
        if (q.state !== 'OPEN') throw fail('대기실이 열린 상태에서만 시작할 수 있습니다.');
        const t = now();
        q.state = 'RUNNING'; q.started_at = t; quizMono = { hr: process.hrtime.bigint(), wall: t };
        for (const e of Object.values(db.entries)) { e.current = 0; e.answers = []; e.shown_at = t; e.finished = false; }
        db.screen.view = 'quiz';
      } else if (a === 'close') {
        if (q.state !== 'RUNNING') throw fail('진행 중인 퀴즈가 없습니다.');
        closeQuiz(role, '운영자 수동 마감'); break;
      } else if (a === 'reveal') {
        if (q.state !== 'CLOSED') throw fail('마감 후 결과를 발표할 수 있습니다.');
        q.state = 'REVEALED'; q.revealed_at = now(); db.screen.view = 'results';
      } else if (a === 'reset') {
        need('super');
        Object.assign(q, { quiz_id: newId('quiz'), state: 'IDLE', started_at: null, closed_at: null, revealed_at: null });
        db.entries = {}; quizMono = null;
      } else throw fail('알 수 없는 동작');
      audit(role, 'quiz.' + a, q.title);
      break;
    }
    case '/api/admin/reset': {
      need('super');
      const t = b.target;
      if (t === 'draws' || t === 'all') { db.draws = []; db.screen.draw = null; }
      if (t === 'quiz' || t === 'all') { db.entries = {}; Object.assign(db.quiz, { quiz_id: newId('quiz'), state: 'IDLE', started_at: null, closed_at: null, revealed_at: null }); }
      if (t === 'participants' || t === 'all') { db.participants = []; db.reviews = []; db.draws = []; db.entries = {}; db.screen.draw = null; }
      if (!['draws', 'quiz', 'participants', 'all'].includes(t)) throw fail('초기화 대상 오류');
      if (t === 'all') db.screen.view = 'home';
      audit(role, 'reset', t);
      break;
    }
    default: throw fail('Not found', 404);
  }
  save(); broadcast();
  return send(res, 200, result);
}

/* ───────────────────────── 정적 파일 ───────────────────────── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const ROUTES = { '/': 'index.html', '/admin': 'admin.html', '/screen': 'screen.html', '/checkin': 'checkin.html', '/quiz': 'quiz.html' };
function serveFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache || 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/assets/mascot') {
    for (const f of ['dusik.png', 'dusik.webp', 'dusik.svg']) {
      const fp = path.join(PUBLIC_DIR, 'assets', f);
      if (fs.existsSync(fp)) return serveFile(res, fp);
    }
  }
  if (p.startsWith('/uploads/')) {
    const fp = path.join(UPLOAD_DIR, path.basename(p));
    return serveFile(res, fp, 'public, max-age=86400');
  }
  if (ROUTES[p]) p = '/' + ROUTES[p];
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  serveFile(res, fp);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : e.message });
    else res.end();
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n🌱 풀무원 이벤트 서버 실행 중 — http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`   같은 네트워크 접속: http://${ip}:${PORT}`));
  console.log(`   관리자: /admin   스크린: /screen?key=${db.settings.screenKey}   체크인: /checkin   퀴즈: /quiz`);
  if (!process.env.ADMIN_PASSWORD || !process.env.OPERATOR_PASSWORD) {
    console.log('   ⚠ 기본 비밀번호 사용 중 — 행사 전 ADMIN_PASSWORD / OPERATOR_PASSWORD 환경변수를 반드시 설정하세요.');
  }
});
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
