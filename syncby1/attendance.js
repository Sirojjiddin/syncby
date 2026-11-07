'use strict';
// 📋 Davomat moduli (o'quv markaz). Hammasi xotirada, xona yopilganda o'chadi.
// Tezlik: belgilash O(1) (Map), o'zgarishlar 300 ms da bir marta paketlab yuboriladi (delta), ro'yxat qidiruvi mijozda.
const MAXN = 5000, MAXD = 800, PHOTO_MAX = 120000, FRESH_MS = 120000, ACC_MAX = 10000;   // kompyuterda Wi-Fi/IP joylashuvi aniqligi past (±km) bo'lishi mumkin — rad etmaymiz, «xavf» sifatida belgilaymiz
const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;   // davomat sanasi ustuni (dd.mm.yyyy); MAXD — fayldagi sana ustunlarining eng ko'pi
// 🙂 Face ID: brauzer 128 o'lchamli yuz vektorini (face-api.js, ResNet) hisoblaydi, server vektorlarni Evklid masofasi bilan solishtiradi.
// Vektor Int16 (x10000) → base64 (344 belgi) ko'rinishida saqlanadi: Excel katagiga sig'adi, fayldan qayta yuklanadi.
const FD = 128, TPL_MAX = 8, TPL_CHARS = 344, QS = 10000, DUP_TH = 0.40, MARGIN = 0.05;
const MIN_PCT = 81;                                       // yuz moslik foizi shundan yuqori bo'lmasa — qabul qilinmaydi, qayta skanerlanadi
const FTH = { strict: 0.42, normal: 0.5, soft: 0.56 };
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

function decTpl(s) {                                     // base64 (Int16) → Float32Array(128); noto'g'ri bo'lsa null
  if (typeof s !== 'string' || s.length !== TPL_CHARS) return null;
  const b = Buffer.from(s, 'base64'); if (b.length !== FD * 2) return null;
  const f = new Float32Array(FD); let n = 0;
  for (let i = 0; i < FD; i++) { f[i] = b.readInt16LE(i * 2) / QS; n += f[i] * f[i]; }
  return n > 0.05 && n < 25 ? f : null;                  // bo'sh / yaroqsiz vektor rad etiladi
}
const encTpl = f => { const b = Buffer.alloc(FD * 2); for (let i = 0; i < FD; i++) b.writeInt16LE(clamp(Math.round(f[i] * QS), -32768, 32767), i * 2); return b.toString('base64'); };
const dist = (a, b) => { let s = 0; for (let i = 0; i < FD; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };
const minDist = (q, tpls) => { let m = 9; for (const t of tpls) { const d = dist(q, t); if (d < m) m = d; } return m; };
const pctOf = (d, th) => Math.round(clamp(d <= th ? 70 + 29 * (1 - d / th) : 70 * (1 - (d - th) / 0.3), 0, 99));
const faceCount = A => { let n = 0; for (const f of A.faces) if (f) n++; return n; };
const nextFid = A => { let mx = 0; for (const f of A.fid) { const m = /^F(\d+)$/.exec(f || ''); if (m) mx = Math.max(mx, +m[1]); } return 'F' + String(mx + 1).padStart(4, '0'); };
// Yuzni bazadan qidirish: guruh bo'yicha eng yaqin o'quvchi + chegaradan (th) va ikkinchi eng yaqin o'quvchidan (MARGIN) ishonchli ajralishi shart
function matchFace(A, q, group) {
  const th = FTH[A.cfg.faceLvl] || FTH.normal; let b1 = 9, i1 = -1, b2 = 9, g1 = 9, gi = -1;
  for (let i = 0; i < A.faces.length; i++) {
    const t = A.faces[i]; if (!t) continue;
    const d = minDist(q, t);
    if (d < b1) { b2 = b1; b1 = d; i1 = i; } else if (d < b2) b2 = d;
    if ((!group || A.groups[i] === group) && d < g1) { g1 = d; gi = i; }
  }
  if (i1 < 0) return { ok: false, why: 'nodb' };
  if (gi >= 0 && g1 <= th) {
    const other = gi === i1 ? b2 : b1;                    // guruhdagi eng yaqin odamdan boshqa eng yaqin o'quvchi
    if (other - g1 >= MARGIN) return { ok: true, sid: gi, d: g1, pct: pctOf(g1, th) };
    return { ok: false, why: 'ambiguous' };
  }
  if (group && b1 <= th && A.groups[i1] !== group) return { ok: false, why: 'othergroup', sid: i1 };
  return { ok: false, why: 'unknown', d: b1 };
}

function newAtt() {
  return { title: '', names: [], groups: [], ph: [], pv: [], dates: [], fid: [], faces: [], fs: [], rg: [], regTok: new Map(), lt: null, def: null, defOn: false, open: false, openedAt: 0,
    cfg: { show: true, photoReq: false, locReq: true, selfReg: false, face: true, faceOnly: true, faceLive: true, faceLvl: 'normal', radius: 150, lateMin: 0, center: null, codeGive: false },
    marks: new Map(), photos: new Map(), hashes: new Map(), byTok: new Map(),
    dirty: new Set(), tkAdd: new Set(), tkDel: new Set(), timer: null, cc: null, ver: 0, medVer: -1, med: null, all: false };
}
const pubCfg = A => ({ open: A.open, show: A.cfg.show !== false, photoReq: A.cfg.photoReq, locReq: A.cfg.locReq, face: A.cfg.face, selfReg: !!A.cfg.selfReg, faceOnly: !!A.cfg.faceOnly, faceLive: A.cfg.faceLive !== false, faceLvl: A.cfg.faceLvl, faceN: faceCount(A), codeGive: !!A.cfg.codeGive, lateMin: A.cfg.lateMin, radius: A.cfg.radius, center: A.cfg.center, def: !!A.def, openedAt: A.openedAt });

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
  if (m.lat == null) { m.d = null; if (m.via === 'self' || m.via === 'fid') { m.cls = 'noloc'; why.push('noloc'); risk += 40; } else m.cls = 'na'; }
  else if (c) { m.d = Math.round(hav(c[0], c[1], m.lat, m.lng)); const eff = Math.max(0, m.d - Math.min(m.acc || 0, 50));   // GPS xatosi (≤50 m) hisobga olinadi — chegarada adolatsiz «uzoqda» bo'lmasin
    m.cls = eff <= R ? 'ok' : eff <= 3 * R ? 'warn' : 'far';
    if (m.cls === 'warn') { why.push('warn'); risk += 25; } else if (m.cls === 'far') { why.push('far'); risk += 50; } }
  else { m.d = null; m.cls = 'ok'; }
  if (m.acc != null && m.acc > 100) { why.push('lowacc'); risk += m.acc > 1000 ? 30 : 15; }
  if (m.dup) { why.push('dupphoto'); risk += 60; }
  if (A.cfg.photoReq && (m.via === 'self' || m.via === 'fid') && !A.photos.has(m.sid)) { why.push('nophoto'); risk += 30; }
  if (m.via === 'fid' && A.cfg.faceLive !== false && m.live === false) { why.push('nolive'); risk += 30; }
  m.risk = Math.min(100, risk); m.why = why.join(',');
}
const row = m => [m.sid, m.s, m.t, m.via, m.d, m.acc, m.risk, m.why, A_has(m), m.cls, m.lat, m.lng, m.fp == null ? null : m.fp];
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
  const A = room.att; if (!A || (ws.ctx.role !== 'host' && !(A.names.length || A.cfg.selfReg || A.cfg.codeGive))) return;
  H.send(ws, listMsg(A, ws.ctx));
  if (ws.ctx.role === 'host') { H.send(ws, fullMsg(A)); H.send(ws, metaMsg(A)); }
}
const err = (ws, msg) => H.send(ws, { type: 'att-err', msg });
// Yuz orqali topilgan ism receiver kiritgan ismdan farq qilsa — receiver nomi yuz bo'yicha topilgan (ro'yxatdagi) ismga almashtiriladi
const shortName = n => { n = cl(n, 60); if (n.length <= 24) return n; const two = n.split(' ').slice(0, 2).join(' '); return (two.length <= 24 ? two : n.slice(0, 24)).trim(); };
function adoptName(room, ws, ctx, full) {
  const nm = shortName(full); if (!nm || ctx.name === nm || ctx.role !== 'receiver') return;
  ctx.name = nm; if (H.rename) H.rename(room, ws, nm);
}
// pv[i] — o'quvchining davomat tarixi: dates[k] sanasi uchun bitta belgi ('+' keldi, '-' kelmadi, '.' ma'lumot yo'q)
const metaMsg = A => ({ type: 'att-fmeta', full: true, fid: A.fid, fc: A.faces.map(f => (f ? f.length : 0)), ph: A.ph, pv: A.pv, dates: A.dates, rg: A.rg });
const metaUpd = (A, sids) => ({ type: 'att-fmeta', upd: sids.map(i => [i, A.fid[i] || '', A.faces[i] ? A.faces[i].length : 0]), n: faceCount(A) });
const pushCfg = (room, A) => H.sendAll([room.host, ...room.clients].filter(Boolean), { type: 'att-cfg', cfg: pubCfg(A), title: A.title });

function readPhoto(p) {
  if (typeof p !== 'string' || p.length > PHOTO_MAX || !p.startsWith('data:image/jpeg;base64,')) return null;
  return p.slice(23);
}

function handle(room, ws, ctx, m) {
  const A = room.att;
  if (ctx.role === 'receiver') {
    if (m.type === 'att-sync') {                           // receiver qo'shilgach ro'yxatni qayta so'raydi (xabar yo'qolgan bo'lsa ham ko'rinadi)
      const t = Date.now(); if (t - (ctx.attS || 0) < 800) return; ctx.attS = t;
      if (A && (A.names.length || A.cfg.selfReg || A.cfg.codeGive)) H.send(ws, listMsg(A, ctx)); return;
    }
    if (m.type === 'att-codechk') {                        // 🔑 Face ID kod berish: faqat Transmitter yoqqan bo'lsa (kod brauzerning o'zida hosil bo'ladi, serverda saqlanmaydi)
      const t = Date.now(); if (t - (ctx.codeT || 0) < 1200) return; ctx.codeT = t;
      return H.send(ws, A && A.cfg.codeGive ? { type: 'att-codeok' } : { type: 'att-codeerr', msg: 'Face ID kod berish hozir o‘chiq. Transmitterga murojaat qiling' });
    }
    if (m.type === 'att-fmatch') return faceMatch(room, ws, ctx, m, A);
    if (m.type === 'att-reg') return register(room, ws, ctx, m, A);   // receiver o'zi ro'yxatdan o'tadi (ism, guruh, telefon, yuz)
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
    const viaFace = !!m.fc && A.cfg.face, fc = ctx.fc;
    if (A.cfg.face && A.cfg.faceOnly && faceCount(A) > 0 && !viaFace) return err(ws, 'Bu davomat faqat Yuz ID orqali belgilanadi');
    if (viaFace && (!fc || fc.sid !== sid || now - fc.t > 120000 || A.faces[sid] == null)) return err(ws, 'Yuz tasdig‘i eskirgan. Yuzingizni qayta skanerlang');
    let lat = null, lng = null, acc = null;
    const L = m.loc;
    if (L && okLL(Number(L.lat), Number(L.lng)) && Number.isFinite(Number(L.ts)) && Math.abs(now - Number(L.ts)) <= FRESH_MS && Number(L.acc) <= ACC_MAX) {
      lat = +Number(L.lat).toFixed(6); lng = +Number(L.lng).toFixed(6); acc = Math.round(Number(L.acc) || 0);
    } else if (A.cfg.locReq) return err(ws, 'Joylashuv aniqlanmadi yoki eskirgan. GPS’ni yoqib qayta urining');
    const ph = readPhoto(m.photo);
    if (!ph && A.cfg.photoReq) return err(ws, 'Jonli rasm kerak');
    const mk = { s: A.cfg.lateMin > 0 && A.openedAt && now - A.openedAt > A.cfg.lateMin * 60000 ? 'l' : 'p', t: now, via: viaFace ? 'fid' : 'self', lat, lng, acc, tok: ctx.tok, ph: !!ph, dup: false, h: null };
    if (viaFace) { mk.fp = fc.pct; mk.live = fc.live; ctx.fc = null; }
    if (ph) {                                              // bir xil rasmni boshqa ism uchun qayta ishlatish — shubhali
      mk.h = fnv(ph); const set = A.hashes.get(mk.h);
      if (set && set.size) { mk.dup = true; for (const o of set) { const om = A.marks.get(o); if (om) { om.dup = true; A.dirty.add(o); } } }
    }
    setMark(room, A, sid, mk);
    if (ph) { A.photos.set(sid, ph); let s = A.hashes.get(mk.h); if (!s) A.hashes.set(mk.h, s = new Set()); s.add(sid); }
    A.byTok.set(ctx.tok, sid);
    H.send(ws, { type: 'att-ok', sid, s: mk.s, t: mk.t });
    if (viaFace) adoptName(room, ws, ctx, A.names[sid]);   // yuz bo'yicha topilgan ism — asosiy ism
    return;
  }
  if (ctx.role !== 'host') return;
  switch (m.type) {
    case 'att-sync': if (A) { H.send(ws, listMsg(A, ctx)); H.send(ws, fullMsg(A)); } break;
    case 'att-cfg': {
      const a = A || (room.att = newAtt()), c = m.cfg || {};
      if (typeof c.title === 'string') a.title = cl(c.title, 80);
      const showChanged = typeof c.show === 'boolean' && c.show !== (a.cfg.show !== false);
      if (typeof c.show === 'boolean') a.cfg.show = c.show;
      if (typeof c.photoReq === 'boolean') a.cfg.photoReq = c.photoReq;
      if (typeof c.locReq === 'boolean') a.cfg.locReq = c.locReq;
      if (typeof c.selfReg === 'boolean') a.cfg.selfReg = c.selfReg;
      if (typeof c.codeGive === 'boolean') a.cfg.codeGive = c.codeGive;   // 🔑 receiverlar o'z Face ID kodini ola oladimi (standart: o'chiq)
      if (typeof c.face === 'boolean') a.cfg.face = c.face;
      if (typeof c.faceOnly === 'boolean') a.cfg.faceOnly = c.faceOnly;
      if (typeof c.faceLive === 'boolean') a.cfg.faceLive = c.faceLive;
      if (c.faceLvl === 'strict' || c.faceLvl === 'normal' || c.faceLvl === 'soft') a.cfg.faceLvl = c.faceLvl;
      if (Number.isFinite(Number(c.radius))) a.cfg.radius = clamp(Math.round(Number(c.radius)), 20, 50000);
      if (Number.isFinite(Number(c.lateMin))) a.cfg.lateMin = clamp(Math.round(Number(c.lateMin)), 0, 600);
      if (c.center === 'default') a.cfg.center = a.def ? { lat: a.def.lat, lng: a.def.lng } : null;   // markazning standart (.env) joylashuviga qaytarish
      else if (c.center === null) a.cfg.center = null;
      else if (c.center && okLL(Number(c.center.lat), Number(c.center.lng))) a.cfg.center = { lat: +Number(c.center.lat).toFixed(6), lng: +Number(c.center.lng).toFixed(6) };
      if (typeof c.open === 'boolean' && c.open !== a.open) { a.open = c.open; if (c.open && !a.openedAt) a.openedAt = Date.now(); }
      a.all = true; a.ver++;
      H.sendAll([room.host, ...room.clients].filter(Boolean), { type: 'att-cfg', cfg: pubCfg(a), title: a.title });
      if (showChanged && a.names.length) for (const w of room.clients) if (w && w.ctx) H.send(w, listMsg(a, w.ctx));   // ko'rinish o'zgardi: receiverlarga ro'yxat (yoki bo'sh) qayta yuboriladi
      touch(room, a, null);
      break;
    }
    case 'att-defloc': {                                   // markazning standart joylashuvi (.env). GPS shart emas; faqat markaz hali belgilanmagan bo'lsa qo'llanadi
      const a = A || (room.att = newAtt()), la = Number(m.lat), lo = Number(m.lng);
      if (!okLL(la, lo)) break;
      a.def = { lat: +la.toFixed(6), lng: +lo.toFixed(6) };
      if (Number.isFinite(Number(m.radius)) && !a.defOn) a.cfg.radius = clamp(Math.round(Number(m.radius)), 20, 50000);
      if (!a.cfg.center && !a.defOn) a.cfg.center = { lat: a.def.lat, lng: a.def.lng };
      a.defOn = true; a.all = true; a.ver++;
      H.sendAll([room.host, ...room.clients].filter(Boolean), { type: 'att-cfg', cfg: pubCfg(a), title: a.title });
      touch(room, a, null);
      break;
    }
    case 'att-mark': {                                     // Transmitter qo'lda yoki "Yuz ID" orqali belgilaydi / bekor qiladi
      if (!A) return;
      const sid = Number(m.sid); if (!Number.isInteger(sid) || sid < 0 || sid >= A.names.length) return;
      if (m.on === false) { unsetMark(room, A, sid); break; }
      const ph = readPhoto(m.photo), via = m.via === 'face' ? 'face' : m.via === 'fid' ? 'fid' : 'host';
      const mk = { s: m.late ? 'l' : 'p', t: Date.now(), via, lat: null, lng: null, acc: null, tok: null, ph: !!ph, dup: false, h: null };
      if (via === 'fid') { mk.fp = clamp(Math.round(Number(m.fp) || 0), 0, 99); mk.live = m.live !== false; if (A.marks.has(sid)) break; }   // kiosk: allaqachon belgilangan bo'lsa qayta yozilmaydi
      setMark(room, A, sid, mk); if (ph) A.photos.set(sid, ph);
      break;
    }
    case 'att-fmatch': return faceMatch(room, ws, ctx, m, A);                // kiosk: Transmitter kamerasi
    case 'att-add': {                                      // Transmitter ro'yxatga yangi o'quvchi qo'shadi (keyin yuzi kiritiladi)
      const a = A || (room.att = newAtt()), n = cl(m.n, 60);
      if (nameWords(n) < 2) return H.send(ws, { type: 'att-ferr', msg: 'Familiya va ismni to‘liq yozing' });
      if (a.names.length >= MAXN) return H.send(ws, { type: 'att-ferr', msg: 'Ro‘yxat to‘lgan' });
      let sid = findByName(a, n, cl(m.g, 30)), isNew = false;
      if (sid < 0) { sid = addStudent(a, n, cl(m.g, 30), cl(m.p, 24)); isNew = true; }
      else { if (!a.ph[sid] && m.p) a.ph[sid] = cl(m.p, 24); if (!a.groups[sid] && m.g) a.groups[sid] = cl(m.g, 30); }
      H.send(ws, { type: 'att-added', sid, isNew, name: a.names[sid] }); queueSync(room, a); break;
    }
    case 'att-fenroll': {                                  // yuzni ro'yxatga olish: 2–8 ta vektor
      if (!A) return; const sid = Number(m.sid); if (!Number.isInteger(sid) || sid < 0 || sid >= A.names.length) return;
      const list = Array.isArray(m.d) ? m.d.slice(0, TPL_MAX) : [], keep = [], tpls = [];
      for (const x of list) { const t = decTpl(x); if (t) { tpls.push(t); keep.push(x); } }
      if (tpls.length < 2) return H.send(ws, { type: 'att-ferr', msg: 'Kamida 2 ta sifatli kadr kerak' });
      if (!m.force) for (let j = 0; j < A.faces.length; j++) {          // shu yuz boshqa ism ostida allaqachon kiritilganmi?
        if (j === sid || !A.faces[j]) continue;
        for (const q of tpls) if (minDist(q, A.faces[j]) < DUP_TH) return H.send(ws, { type: 'att-fdup', sid, other: j, name: A.names[j] });
      }
      A.faces[sid] = tpls; A.fs[sid] = keep; if (!A.fid[sid]) A.fid[sid] = nextFid(A);
      H.send(room.host, metaUpd(A, [sid])); H.send(ws, { type: 'att-fok', sid, fid: A.fid[sid] }); pushCfg(room, A); break;
    }
    case 'att-fdel': {
      if (!A) return; const sid = Number(m.sid); if (!Number.isInteger(sid) || !A.faces[sid]) return;
      A.faces[sid] = null; A.fs[sid] = null; H.send(room.host, metaUpd(A, [sid])); pushCfg(room, A); break;
    }
    case 'att-reset': {                                    // 🗑 Davomatni qaytadan boshlash: o'quvchilar, Face ID kodlari, tarix va belgilar — hammasi tizimdan o'chadi (sozlamalar qoladi)
      const a = A; if (!a) break;
      clearTimeout(a.timer); clearTimeout(a.lt); a.timer = null; a.lt = null;
      a.title = ''; a.names = []; a.groups = []; a.ph = []; a.pv = []; a.dates = []; a.fid = []; a.faces = []; a.fs = []; a.rg = [];
      a.regTok.clear(); a.marks.clear(); a.photos.clear(); a.hashes.clear(); a.byTok.clear(); a.dirty.clear(); a.tkAdd.clear(); a.tkDel.clear();
      a.cc = null; a.med = null; a.medVer = -1; a.all = false; a.ver++; a.openedAt = a.open ? Date.now() : 0;
      if (room.faceNames) room.faceNames.clear();           // yuz orqali olingan ismlar ham unutiladi
      for (const w of [room.host, ...room.clients]) if (w && w.ctx) { w.ctx.fc = null; H.send(w, { type: 'att-reset' }); H.send(w, listMsg(a, w.ctx)); }
      H.send(room.host, fullMsg(a)); H.send(room.host, metaMsg(a));
      break;
    }
    case 'att-del': {                                      // ✕ o'quvchini ro'yxatdan chiqarish: ism, yuz, belgi va tarixi o'chadi; qolganlarning raqami (indeksi) qayta hisoblanadi
      if (!A) return; const sid = Number(m.sid); if (!Number.isInteger(sid) || sid < 0 || sid >= A.names.length) return;
      const name = A.names[sid];
      for (const k of ['names', 'groups', 'ph', 'pv', 'fid', 'faces', 'fs', 'rg']) A[k].splice(sid, 1);
      const sh = x => (x > sid ? x - 1 : x), remap = mp => { const o = new Map(); for (const [k, v] of mp) if (k !== sid) o.set(sh(k), v); return o; };
      const mm = new Map(); for (const [k, v] of A.marks) if (k !== sid) { v.sid = sh(k); mm.set(sh(k), v); } A.marks = mm;
      A.photos = remap(A.photos);
      const hs = new Map(); for (const [h, set] of A.hashes) { const ns = new Set(); for (const x of set) if (x !== sid) ns.add(sh(x)); if (ns.size) hs.set(h, ns); } A.hashes = hs;
      for (const mp of [A.byTok, A.regTok]) for (const [t, x] of [...mp]) { if (x === sid) mp.delete(t); else mp.set(t, sh(x)); }
      A.dirty.clear(); A.tkAdd.clear(); A.tkDel.clear(); A.all = true; A.ver++; A.cc = null;
      for (const w of room.clients) if (w.ctx) w.ctx.fc = null;     // yuz tasdig'i eski raqamga bog'langan edi — bekor
      resync(room, A); H.send(ws, { type: 'att-deleted', name });
      break;
    }
    case 'att-edit': {                                     // ✏ o'quvchi ma'lumotlarini tahrirlash: F.I.Sh, guruh, telefon, Face ID, Face kod
      if (!A) return; const sid = Number(m.sid); if (!Number.isInteger(sid) || sid < 0 || sid >= A.names.length) return;
      const bad = msg => H.send(ws, { type: 'att-ferr', msg });
      const n = cl(m.n, 60), g = cl(m.g, 30), p = cl(m.p, 24), f = cl(m.f, 16);
      if (nameWords(n) < 2) return bad('Familiya va ismni to‘liq yozing');
      if (p && p.replace(/\D/g, '').length < 7) return bad('Telefon raqami noto‘g‘ri');
      const dupN = findByName(A, n, g); if (dupN >= 0 && dupN !== sid) return bad(`«${A.names[dupN]}» shu guruhda allaqachon bor`);
      if (f) for (let j = 0; j < A.fid.length; j++) if (j !== sid && A.fid[j] === f) return bad(`Face ID ${f} «${A.names[j]}» da band`);
      let faces, keep, clearFace = false;
      if (typeof m.c === 'string') {
        const raw = m.c.split(/[|\s;,]+/).filter(Boolean).slice(0, TPL_MAX);
        if (!raw.length) clearFace = true;
        else {
          faces = []; keep = [];
          for (const x of raw) { const t = decTpl(x); if (!t) return bad('Face kod noto‘g‘ri yoki buzilgan (har bir qism 344 belgi, qismlar | bilan ajratiladi)'); faces.push(t); keep.push(x); }
          if (faces.length < 2) return bad('Face kod kamida 2 qismdan iborat bo‘lishi kerak');
          for (let j = 0; j < A.faces.length; j++) { if (j === sid || !A.faces[j]) continue; for (const q of faces) if (minDist(q, A.faces[j]) < DUP_TH) return bad(`Bu yuz «${A.names[j]}» ga tegishli`); }
        }
      }
      A.names[sid] = n; A.groups[sid] = g; A.ph[sid] = p; A.fid[sid] = f;
      if (clearFace) { A.faces[sid] = null; A.fs[sid] = null; } else if (faces) { A.faces[sid] = faces; A.fs[sid] = keep; }
      if (A.faces[sid] && !A.fid[sid]) A.fid[sid] = nextFid(A);
      A.ver++; A.all = true; H.send(ws, { type: 'att-edited', sid, name: n }); resync(room, A);
      break;
    }
    case 'att-clear': if (A) { A.marks.clear(); A.photos.clear(); A.hashes.clear(); A.byTok.clear(); A.openedAt = A.open ? Date.now() : 0; A.ver++; A.cc = null;
      const all = [room.host, ...room.clients].filter(Boolean); all.forEach(w => H.send(w, listMsg(A, w.ctx))); H.send(room.host, fullMsg(A)); } break;
  }
}


// ---------------- Ro'yxatdan o'tish (receiver o'zi yoki Transmitter qo'shadi) ----------------
const nk = s => String(s == null ? '' : s).toLowerCase().replace(/[ʻʼ’'`‘´]/g, '').replace(/[^a-z0-9\u0400-\u04ff ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const nameWords = n => String(n || '').split(' ').filter(w => w.replace(/[^A-Za-z\u0400-\u04ff]/g, '').length >= 2).length;
function findByName(A, n, g) {                           // shu ism ro'yxatda bormi (so'z tartibi va apostrof farq qilmaydi; guruh ikkala tomonda bo'lsa mos kelishi shart)
  const k = nk(n), gk = nk(g); if (!k) return -1;
  for (let i = 0; i < A.names.length; i++) if (nk(A.names[i]) === k && (!gk || !A.groups[i] || nk(A.groups[i]) === gk)) return i;
  return -1;
}
function addStudent(A, n, g, p) {
  A.names.push(n); A.groups.push(g || ''); A.ph.push(p || ''); A.pv.push(''); A.fid.push(''); A.faces.push(null); A.fs.push(null); A.rg.push(0);
  A.ver++; return A.names.length - 1;
}
function queueSync(room, A) {                            // ro'yxat o'zgardi: 400 ms da bir marta hammaga (receiver + Transmitter) yangilanadi
  if (A.lt) return;
  A.lt = setTimeout(() => {
    A.lt = null; if (room.att !== A) return;
    for (const w of [room.host, ...room.clients]) if (w && w.ctx) { H.send(w, listMsg(A, w.ctx)); if (w.ctx.role === 'host') { H.send(w, fullMsg(A)); H.send(w, metaMsg(A)); } }
  }, 400);
}
function resync(room, A) {                             // ro'yxat o'zgardi (o'chirish / tahrirlash): hamma qurilmaga darhol qayta yuboriladi
  for (const w of [room.host, ...room.clients]) if (w && w.ctx) { H.send(w, listMsg(A, w.ctx)); if (w.ctx.role === 'host') { H.send(w, fullMsg(A)); H.send(w, metaMsg(A)); } }
}
function register(room, ws, ctx, m, A) {
  const now = Date.now(), bad = (why, msg) => H.send(ws, { type: 'att-regerr', why, msg });
  if (now - (ctx.regT || 0) < 2500) return bad('wait', 'Biroz kuting…'); ctx.regT = now;
  if (!A || !A.cfg.selfReg) return bad('off', 'Ro‘yxatdan o‘tish hozir yopiq. Transmitterga murojaat qiling');
  const n = cl(m.n, 60), g = cl(m.g, 30), ph = cl(m.p, 24);
  if (nameWords(n) < 2) return bad('name', 'Familiya va ismingizni to‘liq yozing');
  if (ph && ph.replace(/\D/g, '').length < 7) return bad('phone', 'Telefon raqami noto‘g‘ri');
  const tpls = [], keep = []; for (const x of (Array.isArray(m.d) ? m.d.slice(0, TPL_MAX) : [])) { const t = decTpl(x); if (t) { tpls.push(t); keep.push(x); } }
  if (tpls.length < 2) return bad('face', 'Yuz yetarli aniq o‘qilmadi. Yorug‘ joyda qayta urining');
  let sid = A.regTok.has(ctx.tok) ? A.regTok.get(ctx.tok) : -1, isNew = false;     // shu qurilmadan oldin o'tgan bo'lsa — o'z yozuvi yangilanadi (xatoni to'g'rilash)
  if (sid < 0) {
    sid = findByName(A, n, g);
    if (sid >= 0 && A.faces[sid]) return bad('exists', 'Bu ism ro‘yxatda allaqachon yuz bilan kiritilgan. Boshqa odam bo‘lsangiz Transmitterga ayting');
    if (sid < 0) { if (A.names.length >= MAXN) return bad('full', 'Ro‘yxat to‘lgan'); isNew = true; }
  }
  for (let j = 0; j < A.faces.length; j++) {            // shu yuz boshqa ism ostida bormi?
    if (j === sid || !A.faces[j]) continue;
    for (const q of tpls) if (minDist(q, A.faces[j]) < DUP_TH) return bad('dupface', 'Bu yuz ro‘yxatda allaqachon bor. Agar siz ro‘yxatdan o‘tgan bo‘lsangiz, «Yuz ID bilan belgilash» tugmasini bosing');
  }
  if (isNew) sid = addStudent(A, n, g, ph);
  else { if (A.regTok.get(ctx.tok) === sid) A.names[sid] = n;   // o'z yozuvini tuzatsa — ism yangilanadi; Excel'dagi ism bilan bog'lansa — Excel yozuvi o'zgarmaydi
    if (g && (!A.groups[sid] || A.regTok.get(ctx.tok) === sid)) A.groups[sid] = g; if (ph) A.ph[sid] = ph; }
  A.faces[sid] = tpls; A.fs[sid] = keep; if (!A.fid[sid]) A.fid[sid] = nextFid(A); A.rg[sid] = now; A.regTok.set(ctx.tok, sid);
  H.send(ws, { type: 'att-regok', sid, fid: A.fid[sid], name: A.names[sid], g: A.groups[sid], isNew });
  adoptName(room, ws, ctx, A.names[sid]);
  queueSync(room, A);
}

// Yuz vektorini bazadagi o'quvchilar bilan solishtiradi, natijani qaytaradi va (ok bo'lsa) tasdiqlash uchun eslab qoladi
function faceMatch(room, ws, ctx, m, A) {
  const now = Date.now(), host = ctx.role === 'host';
  const out = o => H.send(ws, Object.assign({ type: 'att-fcand', k: m.k }, o));
  if (now - (ctx.fmT || 0) < (host ? 250 : 600)) return out({ ok: false, why: 'wait' }); ctx.fmT = now;
  if (!A || !A.names.length) return out({ ok: false, why: 'nodb' });
  if (!host && (!A.open || A.cfg.show === false)) return out({ ok: false, why: 'closed' });
  if (!A.cfg.face) return out({ ok: false, why: 'off' });
  if (!host && A.cfg.faceLive !== false && m.live !== true) return out({ ok: false, why: 'nolive' });   // jonlilik tasdig'isiz receiver belgilay olmaydi
  const q = decTpl(m.d); if (!q) return out({ ok: false, why: 'bad' });
  const r = matchFace(A, q, cl(m.g, 30));
  if (!r.ok) return out({ ok: false, why: r.why, g: r.sid != null ? A.groups[r.sid] : undefined });
  if (r.pct <= MIN_PCT) return out({ ok: false, why: 'lowconf', pct: r.pct });
  const done = A.marks.has(r.sid);
  if (!host) {
    if (A.byTok.has(ctx.tok)) return out({ ok: false, why: 'me' });
    if (done) return out({ ok: false, why: 'taken', sid: r.sid, name: A.names[r.sid] });
    ctx.fc = { sid: r.sid, t: now, d: r.d, pct: r.pct, live: m.live !== false };
  }
  out({ ok: true, sid: r.sid, name: A.names[r.sid], g: A.groups[r.sid], pct: r.pct, taken: done });
}

function routes(app, express, rooms) {
  const gate = (req, res) => { const room = rooms.get(String(req.params.code)); if (!room || req.query.key !== room.hostKey) { res.status(403).json({ error: 'Ruxsat yo\'q' }); return null; } return room; };
  app.post('/api/rooms/:code/att/load', express.json({ limit: '40mb' }), (req, res) => {
    const room = gate(req, res); if (!room) return;
    const arr = req.body && Array.isArray(req.body.students) ? req.body.students.slice(0, MAXN) : null;
    if (!arr || !arr.length) return res.status(400).json({ error: 'Ro\'yxat bo\'sh' });
    const A = room.att || (room.att = newAtt());
    A.names = []; A.groups = []; A.ph = []; A.pv = []; A.dates = []; A.fid = []; A.faces = []; A.fs = []; A.rg = []; A.regTok.clear();
    // Davomat sanalari (ustunlar): 'dd.mm.yyyy', takrorlanmaydi; har o'quvchining v qatori shu tartibda ('+' / '-' / '.')
    const srcCols = [];
    (Array.isArray(req.body.dates) ? req.body.dates.slice(0, MAXD) : []).forEach((d, k) => { const t = cl(d, 10); if (DATE_RE.test(t) && !A.dates.includes(t)) { A.dates.push(t); srcCols.push(k); } });
    const usedF = new Set(); let bad = 0;
    for (const s of arr) {
      const n = cl(s && s.n, 60); if (!n) continue;
      A.names.push(n); A.groups.push(cl(s.g, 30)); A.ph.push(cl(s.p, 24));
      { const v = typeof s.v === 'string' ? s.v : ''; A.pv.push(srcCols.map(k => (v[k] === '+' || v[k] === '-' ? v[k] : '.')).join('')); }
      let f = cl(s.f, 16); if (f && usedF.has(f)) f = ''; if (f) usedF.add(f); A.fid.push(f);
      const raw = Array.isArray(s.c) ? s.c : typeof s.c === 'string' ? s.c.split(/[|\s;]+/) : [], tp = [], ks = [];
      for (const x of raw.slice(0, TPL_MAX)) { const t = decTpl(x); if (t) { tp.push(t); ks.push(x); } else if (x) bad++; }
      A.faces.push(tp.length ? tp : null); A.fs.push(tp.length ? ks : null);
    }
    for (let i = 0; i < A.names.length; i++) if (A.faces[i] && !A.fid[i]) A.fid[i] = nextFid(A);
    if (!A.names.length) return res.status(400).json({ error: 'Ismlar topilmadi' });
    A.title = cl(req.body.title, 80) || A.title;
    A.marks.clear(); A.photos.clear(); A.hashes.clear(); A.byTok.clear(); A.dirty.clear(); A.tkAdd.clear(); A.tkDel.clear(); A.cc = null; A.ver++;
    for (const w of [room.host, ...room.clients]) if (w && w.ctx) { H.send(w, listMsg(A, w.ctx)); if (w.ctx.role === 'host') { H.send(w, fullMsg(A)); H.send(w, metaMsg(A)); } }
    res.json({ ok: true, count: A.names.length, faces: faceCount(A), badFaces: bad, dates: A.dates.length });
  });
  app.get('/api/rooms/:code/att/faces', (req, res) => {          // faqat Transmitter: Face ID bazasini faylga saqlash uchun
    const room = gate(req, res); if (!room || !room.att) return res.json({ faces: [] });
    res.set('Cache-Control', 'no-store').json({ faces: room.att.fs.map(x => x || null) });
  });
  app.get('/api/rooms/:code/att/photo/:sid', (req, res) => {
    const room = gate(req, res); if (!room || !room.att) return;
    const p = room.att.photos.get(Number(req.params.sid)); if (!p) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' }).send(Buffer.from(p, 'base64'));
  });
}

module.exports = { init, handle, onJoin, routes, newAtt, _t: { hav, center, evalMark, newAtt, fnv, decTpl, encTpl, dist, matchFace, FTH, MARGIN, faceCount } };
