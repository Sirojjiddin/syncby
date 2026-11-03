'use strict';
// 📋 Davomat moduli (o'quv markaz). Hammasi xotirada, xona yopilganda o'chadi.
// Tezlik: belgilash O(1) (Map), o'zgarishlar 300 ms da bir marta paketlab yuboriladi (delta), ro'yxat qidiruvi mijozda.
const MAXN = 5000, PHOTO_MAX = 120000, FRESH_MS = 120000, ACC_MAX = 10000;   // kompyuterda Wi-Fi/IP joylashuvi aniqligi past (±km) bo'lishi mumkin — rad etmaymiz, «xavf» sifatida belgilaymiz
let H = { send() {}, sendAll() {} };
const init = h => { H = h; };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cl = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
function hav(la1, lo1, la2, lo2) {                       // masofa (metr), Haversine
  const R = 6371000, r = Math.PI / 180, x = (la2 - la1) * r, y = (lo2 - lo1) * r;
  const s = Math.sin(x / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const okLL = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);

function newAtt() {
  return { title: '', names: [], groups: [], open: false, openedAt: 0,
    cfg: { show: true, photoReq: true, locReq: true, face: false, radius: 150, lateMin: 0, center: null },
    marks: new Map(), photos: new Map(), hashes: new Map(), byTok: new Map(),
    dirty: new Set(), tkAdd: new Set(), tkDel: new Set(), timer: null, cc: null, ver: 0, medVer: -1, med: null, all: false };
}
const pubCfg = A => ({ open: A.open, show: A.cfg.show !== false, photoReq: A.cfg.photoReq, locReq: A.cfg.locReq, face: A.cfg.face, lateMin: A.cfg.lateMin, radius: A.cfg.radius, center: A.cfg.center, openedAt: A.openedAt });

// Markaz: Transmitter GPS'i; bo'lmasa — belgilanganlar joylashuvining mediani (chetdagilar ta'sir qilmaydi)
function center(A) {
  if (A.cfg.center) return [A.cfg.center.lat, A.cfg.center.lng];
  if (A.medVer === A.ver) return A.med;
  const la = [], lo = [];
  for (const m of A.marks.values()) if (m.lat != null) { la.push(m.lat); lo.push(m.lng); }
  A.medVer = A.ver;
  if (la.length < 3) return (A.med = null);
  la.sort((a, b) => a - b); lo.sort((a, b) => a - b);
  return (A.med = [la[la.length >> 1], lo[lo.length >> 1]]);
}
// Xavf ("aqlli tekshiruv"): masofa, GPS yo'qligi/aniqligi, takror rasm, rasm yo'qligi
function evalMark(A, m) {
  const c = A.cc, R = A.cfg.radius; let risk = 0; const why = [];
  if (m.lat == null) { m.d = null; if (m.via === 'self') { m.cls = 'noloc'; why.push('noloc'); risk += 40; } else m.cls = 'na'; }
  else if (c) { m.d = Math.round(hav(c[0], c[1], m.lat, m.lng)); const eff = Math.max(0, m.d - Math.min(m.acc || 0, 50));   // GPS xatosi (≤50 m) hisobga olinadi — chegarada adolatsiz «uzoqda» bo'lmasin
    m.cls = eff <= R ? 'ok' : eff <= 3 * R ? 'warn' : 'far';
    if (m.cls === 'warn') { why.push('warn'); risk += 25; } else if (m.cls === 'far') { why.push('far'); risk += 50; } }
  else { m.d = null; m.cls = 'ok'; }
  if (m.acc != null && m.acc > 100) { why.push('lowacc'); risk += m.acc > 1000 ? 30 : 15; }
  if (m.dup) { why.push('dupphoto'); risk += 60; }
  if (A.cfg.photoReq && m.via === 'self' && !A.photos.has(m.sid)) { why.push('nophoto'); risk += 30; }
  m.risk = Math.min(100, risk); m.why = why.join(',');
}
const row = m => [m.sid, m.s, m.t, m.via, m.d, m.acc, m.risk, m.why, A_has(m), m.cls, m.lat, m.lng];
const A_has = m => (m.ph ? 1 : 0);
const stats = A => { let p = 0, l = 0, warn = 0, far = 0, noloc = 0, sus = 0;
  for (const m of A.marks.values()) { if (m.s === 'l') l++; else p++; if (m.cls === 'warn') warn++; else if (m.cls === 'far') far++; else if (m.cls === 'noloc') noloc++; if (m.risk >= 60) sus++; }
  return { total: A.names.length, p, l, warn, far, noloc, sus }; };

function touch(room, A, sid) {
  if (sid != null) A.dirty.add(sid);
  if (!A.timer) A.timer = setTimeout(() => flush(room), 300);
}
function flush(room) {
  const A = room.att; if (!A) return; A.timer = null;
  const c = center(A), changed = (c ? !A.cc || A.cc[0] !== c[0] || A.cc[1] !== c[1] : !!A.cc);
  A.cc = c;
  const ids = changed || A.all ? [...A.marks.keys(), ...A.dirty] : [...A.dirty];
  const seen = new Set(), rows = [];
  for (const sid of ids) { if (seen.has(sid)) continue; seen.add(sid); const m = A.marks.get(sid); if (m) { evalMark(A, m); rows.push(row(m)); } else rows.push([sid, '']); }
  A.dirty.clear(); A.all = false;
  if (room.host) H.send(room.host, { type: 'att-upd', rows, st: stats(A), c: c ? [c[0], c[1], A.cfg.center ? 1 : 0] : null });
  if (A.tkAdd.size || A.tkDel.size) { H.sendAll(room.clients, { type: 'att-taken', add: [...A.tkAdd], del: [...A.tkDel] }); A.tkAdd.clear(); A.tkDel.clear(); }
}
function setMark(room, A, sid, m) {
  const old = A.marks.get(sid); if (old) unsetMark(room, A, sid, true);
  m.sid = sid; A.marks.set(sid, m); A.ver++; A.tkDel.delete(sid); A.tkAdd.add(sid); touch(room, A, sid);
}
function unsetMark(room, A, sid, quiet) {
  const m = A.marks.get(sid); if (!m) return;
  A.marks.delete(sid); A.photos.delete(sid); A.ver++;
  if (m.h != null) { const s = A.hashes.get(m.h); if (s) { s.delete(sid); if (!s.size) A.hashes.delete(m.h); } }
  if (m.tok && A.byTok.get(m.tok) === sid) A.byTok.delete(m.tok);
  if (!quiet) { A.tkAdd.delete(sid); A.tkDel.add(sid); touch(room, A, sid); }
}

function listMsg(A, ctx) {
  const me = ctx.role === 'receiver' && A.byTok.has(ctx.tok) ? A.byTok.get(ctx.tok) : null;
  // Transmitter «Receiverlarda ko'rinsin»ni o'chirgan bo'lsa, receiverga ismlar umuman yuborilmaydi (o'zi belgilangan bo'lsa — faqat o'z ismi)
  if (ctx.role === 'receiver' && A.cfg.show === false) {
    return { type: 'att-list', title: '', n: me != null ? A.names.map((x, i) => (i === me ? x : '')) : [], g: me != null ? A.groups.map((x, i) => (i === me ? x : '')) : [], cfg: pubCfg(A), taken: [], me };
  }
  return { type: 'att-list', title: A.title, n: A.names, g: A.groups, cfg: pubCfg(A), taken: [...A.marks.keys()], me };
}
function fullMsg(A) { const c = center(A); A.cc = c; const rows = []; for (const m of A.marks.values()) { evalMark(A, m); rows.push(row(m)); }
  return { type: 'att-full', rows, st: stats(A), c: c ? [c[0], c[1], A.cfg.center ? 1 : 0] : null }; }
function onJoin(room, ws) {
  const A = room.att; if (!A || !A.names.length) return;
  H.send(ws, listMsg(A, ws.ctx));
  if (ws.ctx.role === 'host') H.send(ws, fullMsg(A));
}
const err = (ws, msg) => H.send(ws, { type: 'att-err', msg });

function readPhoto(p) {
  if (typeof p !== 'string' || p.length > PHOTO_MAX || !p.startsWith('data:image/jpeg;base64,')) return null;
  return p.slice(23);
}

function handle(room, ws, ctx, m) {
  const A = room.att;
  if (ctx.role === 'receiver') {
    if (m.type === 'att-sync') {                           // receiver qo'shilgach ro'yxatni qayta so'raydi (xabar yo'qolgan bo'lsa ham ko'rinadi)
      const t = Date.now(); if (t - (ctx.attS || 0) < 800) return; ctx.attS = t;
      if (A && A.names.length) H.send(ws, listMsg(A, ctx)); return;
    }
    if (m.type !== 'att-claim') return;
    const now = Date.now();
    if (now - (ctx.attT || 0) < 700) return err(ws, 'Biroz kuting…');
    ctx.attT = now;
    if (!A || !A.open) return err(ws, 'Davomat hozir yopiq');
    if (A.cfg.show === false) return err(ws, 'Davomat Transmitter tomonidan yashirilgan');
    const sid = Number(m.sid);
    if (!Number.isInteger(sid) || sid < 0 || sid >= A.names.length) return err(ws, 'Ism topilmadi');
    if (A.byTok.has(ctx.tok)) return err(ws, 'Siz allaqachon belgilangansiz');
    if (A.marks.has(sid)) return err(ws, 'Bu ism allaqachon belgilangan. Adashgan bo\'lsangiz, Transmitterga ayting');
    let lat = null, lng = null, acc = null;
    const L = m.loc;
    if (L && okLL(Number(L.lat), Number(L.lng)) && Number.isFinite(Number(L.ts)) && Math.abs(now - Number(L.ts)) <= FRESH_MS && Number(L.acc) <= ACC_MAX) {
      lat = +Number(L.lat).toFixed(6); lng = +Number(L.lng).toFixed(6); acc = Math.round(Number(L.acc) || 0);
    } else if (A.cfg.locReq) return err(ws, 'Joylashuv aniqlanmadi yoki eskirgan. GPS’ni yoqib qayta urining');
    const ph = readPhoto(m.photo);
    if (!ph && A.cfg.photoReq) return err(ws, 'Jonli rasm kerak');
    const mk = { s: A.cfg.lateMin > 0 && A.openedAt && now - A.openedAt > A.cfg.lateMin * 60000 ? 'l' : 'p', t: now, via: 'self', lat, lng, acc, tok: ctx.tok, ph: !!ph, dup: false, h: null };
    if (ph) {                                              // bir xil rasmni boshqa ism uchun qayta ishlatish — shubhali
      mk.h = fnv(ph); const set = A.hashes.get(mk.h);
      if (set && set.size) { mk.dup = true; for (const o of set) { const om = A.marks.get(o); if (om) { om.dup = true; A.dirty.add(o); } } }
    }
    setMark(room, A, sid, mk);
    if (ph) { A.photos.set(sid, ph); let s = A.hashes.get(mk.h); if (!s) A.hashes.set(mk.h, s = new Set()); s.add(sid); }
    A.byTok.set(ctx.tok, sid);
    H.send(ws, { type: 'att-ok', sid, s: mk.s, t: mk.t });
    return;
  }
  if (ctx.role !== 'host') return;
  switch (m.type) {
    case 'att-sync': if (A && A.names.length) { H.send(ws, listMsg(A, ctx)); H.send(ws, fullMsg(A)); } break;
    case 'att-cfg': {
      const a = A || (room.att = newAtt()), c = m.cfg || {};
      if (typeof c.title === 'string') a.title = cl(c.title, 80);
      const showChanged = typeof c.show === 'boolean' && c.show !== (a.cfg.show !== false);
      if (typeof c.show === 'boolean') a.cfg.show = c.show;
      if (typeof c.photoReq === 'boolean') a.cfg.photoReq = c.photoReq;
      if (typeof c.locReq === 'boolean') a.cfg.locReq = c.locReq;
      if (typeof c.face === 'boolean') a.cfg.face = c.face;
      if (Number.isFinite(Number(c.radius))) a.cfg.radius = clamp(Math.round(Number(c.radius)), 20, 50000);
      if (Number.isFinite(Number(c.lateMin))) a.cfg.lateMin = clamp(Math.round(Number(c.lateMin)), 0, 600);
      if (c.center === null) a.cfg.center = null;
      else if (c.center && okLL(Number(c.center.lat), Number(c.center.lng))) a.cfg.center = { lat: +Number(c.center.lat).toFixed(6), lng: +Number(c.center.lng).toFixed(6) };
      if (typeof c.open === 'boolean' && c.open !== a.open) { a.open = c.open; if (c.open && !a.openedAt) a.openedAt = Date.now(); }
      a.all = true; a.ver++;
      H.sendAll([room.host, ...room.clients].filter(Boolean), { type: 'att-cfg', cfg: pubCfg(a), title: a.title });
      if (showChanged && a.names.length) for (const w of room.clients) if (w && w.ctx) H.send(w, listMsg(a, w.ctx));   // ko'rinish o'zgardi: receiverlarga ro'yxat (yoki bo'sh) qayta yuboriladi
      touch(room, a, null);
      break;
    }
    case 'att-mark': {                                     // Transmitter qo'lda yoki "Yuz ID" orqali belgilaydi / bekor qiladi
      if (!A) return;
      const sid = Number(m.sid); if (!Number.isInteger(sid) || sid < 0 || sid >= A.names.length) return;
      if (m.on === false) { unsetMark(room, A, sid); break; }
      const ph = readPhoto(m.photo), via = m.via === 'face' ? 'face' : 'host';
      const mk = { s: m.late ? 'l' : 'p', t: Date.now(), via, lat: null, lng: null, acc: null, tok: null, ph: !!ph, dup: false, h: null };
      setMark(room, A, sid, mk); if (ph) A.photos.set(sid, ph);
      break;
    }
    case 'att-clear': if (A) { A.marks.clear(); A.photos.clear(); A.hashes.clear(); A.byTok.clear(); A.openedAt = A.open ? Date.now() : 0; A.ver++; A.cc = null;
      const all = [room.host, ...room.clients].filter(Boolean); all.forEach(w => H.send(w, listMsg(A, w.ctx))); H.send(room.host, fullMsg(A)); } break;
  }
}

function routes(app, express, rooms) {
  const gate = (req, res) => { const room = rooms.get(String(req.params.code)); if (!room || req.query.key !== room.hostKey) { res.status(403).json({ error: 'Ruxsat yo\'q' }); return null; } return room; };
  app.post('/api/rooms/:code/att/load', express.json({ limit: '2mb' }), (req, res) => {
    const room = gate(req, res); if (!room) return;
    const arr = req.body && Array.isArray(req.body.students) ? req.body.students.slice(0, MAXN) : null;
    if (!arr || !arr.length) return res.status(400).json({ error: 'Ro\'yxat bo\'sh' });
    const A = room.att || (room.att = newAtt());
    A.names = []; A.groups = [];
    for (const s of arr) { const n = cl(s && s.n, 60); if (n) { A.names.push(n); A.groups.push(cl(s.g, 30)); } }
    if (!A.names.length) return res.status(400).json({ error: 'Ismlar topilmadi' });
    A.title = cl(req.body.title, 80) || A.title;
    A.marks.clear(); A.photos.clear(); A.hashes.clear(); A.byTok.clear(); A.dirty.clear(); A.tkAdd.clear(); A.tkDel.clear(); A.cc = null; A.ver++;
    for (const w of [room.host, ...room.clients]) if (w && w.ctx) { H.send(w, listMsg(A, w.ctx)); if (w.ctx.role === 'host') H.send(w, fullMsg(A)); }
    res.json({ ok: true, count: A.names.length });
  });
  app.get('/api/rooms/:code/att/photo/:sid', (req, res) => {
    const room = gate(req, res); if (!room || !room.att) return;
    const p = room.att.photos.get(Number(req.params.sid)); if (!p) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' }).send(Buffer.from(p, 'base64'));
  });
}

module.exports = { init, handle, onJoin, routes, _t: { hav, center, evalMark, newAtt, fnv } };
