'use strict';
// Vercel 서버리스 함수 — /api/* 와 /uploads/* 요청을 vercel.json rewrites 로 받는다 (req.url 은 원래 경로 유지)
const { handle } = require('../lib/app');

module.exports = (req, res) => handle(req, res);
