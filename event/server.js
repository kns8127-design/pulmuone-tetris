'use strict';
/*
 * 로컬 개발/리허설용 서버 — 운영은 Vercel(api/handler.js)에서 동작합니다.
 * 같은 Supabase DB를 쓰므로 환경변수(SUPABASE_URL, SUPABASE_KEY, EV_SECRET 등)가 필요합니다.
 *   node --env-file=.env server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle, usingDefaultPasswords } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json' };
const ROUTES = { '/': 'index.html', '/admin': 'admin.html', '/screen': 'screen.html', '/checkin': 'checkin.html', '/quiz': 'quiz.html', '/assets/mascot': 'assets/dusik.svg' };

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (ROUTES[p]) p = '/' + ROUTES[p];
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return handle(req, res);
  serveStatic(req, res, url);
}).listen(PORT, () => {
  console.log(`\n🌱 풀무원 이벤트 로컬 서버 — http://localhost:${PORT}`);
  console.log('   관리자: /admin   체크인: /checkin   퀴즈: /quiz   (스크린 주소는 콘솔의 "행사장 스크린 열기")');
  if (usingDefaultPasswords) console.log('   ⚠ 기본 비밀번호 사용 중 — ADMIN_PASSWORD / OPERATOR_PASSWORD 환경변수를 설정하세요.');
});
