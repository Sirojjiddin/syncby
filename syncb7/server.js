'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline, Transform } = require('stream');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const MAX_MB = Number(process.env.MAX_MB) || 1024;       // bitta fayl uchun limit
const MAX_BYTES = MAX_MB * 1024 * 1024;
const MAX_ROOMS = 300;
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 500;   // xonadagi receiverlar
const MAX_FILE_STREAMS = Number(process.env.MAX_FILE_STREAMS) || 48;   // bir vaqtda beriladigan fayl so'rovlari (qolganlari 1 s kutadi)
const HOST_FANOUT = 6;                                   // Transmitterdan to'g'ridan-to'g'ri efir oladigan receiverlar
const HOST_MAX = 14;                                     // relay topilmasa, Transmitter yana nechtagacha qabul qiladi
const RELAY_FANOUT = 3;                                  // har bir relay-receiver nechta receiverga efir uzatadi
const REACTS = ['👏', '🔥', '❤️', '😂', '😮', '👍', '🎉'];
const LEAD = 1500;                                       // "Play" bosilgandan keyin boshlanish kechikishi (ms)
const SEEK_LEAD = 700;
const AUTOPLAY_LEAD = 2500;                              // keyingi trekka o'tishda yuklashga vaqt
const IDLE_ROOM_MS = 10 * 60 * 1000;                     // hech kim yo'q xona 10 daqiqadan keyin o'chadi
const MAX_HOSTLESS_MS = 60 * 60 * 1000;

// Qo'llab-quvvatlanadigan fayl turlari (SVG/HTML ataylab yo'q: xavfsizlik uchun)
const KINDS = {
  audio: ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus'],
  video: ['.mp4', '.webm', '.mov', '.m4v', '.ogv'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'],
  pdf: ['.pdf'],
  text: ['.txt', '.csv', '.md'],
  doc: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp'],
};
const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(KINDS)) list.forEach(e => EXT_KIND.set(e, kind));
const kindOf = ext => EXT_KIND.get(ext) || null;
const isMedia = kind => kind === 'audio' || kind === 'video' || kind === 'youtube';
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });  // serverni qayta yoqqanda eski fayllar tozalanadi
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** @type {Map<string, any>} */
const rooms = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

let activeFiles = 0;
// Fayllar faqat xona tokeni bilan beriladi. Transmitter sozlamalari (ko'rish / yuklab olish) shu yerda tekshiriladi.
app.get('/files/:code/:file', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).end();
  const role = room.tokens.get(String(req.query.t || ''));
  if (!role) return res.status(403).end();
  const file = path.basename(req.params.file);
  const item = room.items.find(i => !i.external && path.basename(i.url) === file);
  if (!item) return res.status(404).end();
  if (role !== 'host') {
    if (!isMedia(item.kind) && !room.cfg.allowView) return res.status(403).send('Transmitter fayllarni ko\'rishni o\'chirgan');
    if (req.query.dl === '1' && !room.cfg.allowDownload) return res.status(403).send('Transmitter yuklab olishni o\'chirgan');
  }
  if (role !== 'host') {                                   // ko'p odam bir vaqtda yuklasa, server bo'g'ilmasligi uchun navbat
    if (activeFiles >= MAX_FILE_STREAMS) { res.setHeader('Retry-After', '1'); return res.status(503).end(); }
    activeFiles++;
    let freed = false;
    const free = () => { if (!freed) { freed = true; activeFiles--; } };
    res.on('close', free); res.on('finish', free);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (req.query.dl === '1') res.attachment(item.name);
  res.sendFile(path.join(UPLOAD_DIR, room.code, file), { acceptRanges: true, dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) res.status(err.status || 404).end();
  });
});

function ytIdOf(u) {
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?]+)/); if (m) id = m[1]; }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

const safeName = n => String(n || 'fayl').replace(/[\u0000-\u001f<>:"\\|?*]/g, '').slice(0, 120) || 'fayl';

function genCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

function defaultCfg() {
  return {
    allowView: true,        // receiver rasm / PDF / matn / hujjatni ko'ra oladimi
    allowDownload: true,    // receiver yuklab ola oladimi
    muteAll: false,         // hamma receiver dinamigi o'chiq
    volume: 100,            // hamma receiver uchun umumiy ovoz (0-100)
    lockVolume: true,       // receiver o'z ovozini o'zgartira olmaydi (hamma bir xil)
    normalize: true,        // ovozni avtomatik tenglashtirish
    duck: true,             // mikrofon gapirganda musiqa pasayadi
    locked: false,          // yangi receiverlar kira olmaydi
    loop: 'off',            // 'off' | 'one' | 'all'
    allowReact: true,       // receiverlar emoji reaksiya yubora oladimi
    waitAll: true,          // Play bosilganda hamma qurilma tayyor bo'lguncha (maks. 6 s) kutish
  };
}

function applyCfg(room, p) {
  if (!p || typeof p !== 'object') return;
  const c = room.cfg;
  for (const k of ['allowView', 'allowDownload', 'muteAll', 'lockVolume', 'normalize', 'duck', 'locked', 'waitAll', 'allowReact']) {
    if (typeof p[k] === 'boolean') c[k] = p[k];
  }
  if (typeof p.volume === 'number' && Number.isFinite(p.volume)) c.volume = Math.max(0, Math.min(100, Math.round(p.volume)));
  if (['off', 'one', 'all'].includes(p.loop)) c.loop = p.loop;
}

function issueToken(room, role, want) {
  if (want && room.tokens.get(want) === role) return want;
  const t = crypto.randomBytes(9).toString('hex');
  room.tokens.set(t, role);
  if (room.tokens.size > 3000) room.tokens.delete(room.tokens.keys().next().value);
  return t;
}

function newRoom() {
  const code = genCode();
  if (!code) return null;
  const room = {
    code,
    hostKey: crypto.randomBytes(12).toString('hex'),
    items: [],
    state: { currentId: null, playing: false, playAt: 0, position: 0, autoNext: true },
    cfg: defaultCfg(),
    live: { mic: null, screen: null },
    tokens: new Map(),                                  // fayl tokenlari: token -> 'host' | 'receiver'
    host: null,
    clients: new Set(),
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const everyone = room => [room.host, ...room.clients].filter(Boolean);
// Ko'p qabul qiluvchiga: xabar BIR marta JSON'ga aylantiriladi; "tiqilib qolgan" soketga yuborilmaydi (server xotirasi shishmasin)
const sendAll = (list, msg) => {
  const data = JSON.stringify(msg);
  for (const w of list) if (w && w.readyState === 1 && w.bufferedAmount < 2 * 1024 * 1024) w.send(data);
};
const broadcast = (room, msg) => sendAll(everyone(room), msg);
const clientById = (room, id) => { for (const c of room.clients) if (c.ctx && c.ctx.id === id) return c; return null; };
const stateMsg = room => ({ type: 'state', state: room.state, serverNow: Date.now() });

function expectedPos(room, t = Date.now()) {
  const s = room.state;
  return s.playing ? s.position + Math.max(0, (t - s.playAt) / 1000) : s.position;
}

// Receiverlar o'lchagan eng katta ping'ga qarab "Play"dan keyingi boshlanish kechikishi (tez tarmoqda qisqa, yomon tarmoqda uzunroq)
function leadMs(room) {
  const r = [];
  room.clients.forEach(c => { if (c.ctx && c.ctx.stat && c.ctx.stat.rtt > 0) r.push(c.ctx.stat.rtt); });
  if (!r.length) return LEAD;
  r.sort((x, y) => x - y);
  const p90 = r[Math.min(r.length - 1, Math.floor(r.length * 0.9))];      // bitta juda sekin qurilma hammani kechiktirmasin
  return clampN(Math.round(p90 * 2 + 700), 900, 3000);
}
function cancelWait(room) {
  if (room.waitT) { clearInterval(room.waitT); room.waitT = null; broadcast(room, { type: 'waiting', n: 0 }); }
}

// O(N²) xabar bo'roniga yo'l qo'ymaslik: a'zolar holati yig'ilib, 0.6 s da bir marta yuboriladi
// ================================================================ VIKTORINA (Kahoot kabi)
// To'g'ri javob serverda saqlanadi va faqat "reveal" bosqichida yuboriladi. Ballar serverda hisoblanadi (aldab bo'lmaydi).
function sanitizeQuiz(room, raw) {
  if (!raw || !Array.isArray(raw.questions)) return { error: 'Savollar yo\'q' };
  const qs = [];
  for (const q of raw.questions.slice(0, 50)) {
    const text = String(q.text || '').trim().slice(0, 240);
    const corr = Number(q.correct), kept = []; let nc = -1;
    (Array.isArray(q.opts) ? q.opts : []).slice(0, 4).forEach((o, i) => {
      const t = String(o || '').trim().slice(0, 120);
      if (t) { if (i === corr) nc = kept.length; kept.push(t); }
    });
    if (!text || kept.length < 2 || nc < 0) return { error: `${qs.length + 1}-savol to'liq emas` };
    const img = typeof q.img === 'string' && q.img.startsWith(`/qimg/${room.code}/`) && QIMG_RE.test(q.img.split('/').pop()) ? q.img : null;
    qs.push({ text, opts: kept, correct: nc, time: clampN(Math.round(Number(q.time) || 20), 5, 120), pts: ['std', 'double', 'none'].includes(q.pts) ? q.pts : 'std', img });
  }
  if (!qs.length) return { error: 'Kamida bitta savol kerak' };
  return { title: String(raw.title || 'Viktorina').trim().slice(0, 80) || 'Viktorina', questions: qs };
}
function quizRanking(qz) {
  return [...qz.players.entries()].map(([tok, p]) => ({ tok, name: p.name, score: p.score, delta: p.last ? p.last.delta : 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
function quizPub(room) {
  const qz = room.quiz;
  if (!qz) return null;
  const q = qz.questions[qz.idx];
  const pub = { id: qz.id, title: qz.title, phase: qz.phase, idx: qz.idx, total: qz.questions.length, players: qz.players.size, startAt: qz.startAt, endAt: qz.endAt };
  if (q && (qz.phase === 'question' || qz.phase === 'reveal')) pub.q = { text: q.text, img: q.img, opts: q.opts, time: q.time, pts: q.pts };
  if (qz.phase === 'reveal') { pub.correct = q.correct; pub.counts = qz.counts; pub.top = qz.top; }
  if (qz.phase === 'final') pub.top = qz.top;
  return pub;
}
function quizMe(room, tok) {
  const qz = room.quiz, p = qz && qz.players.get(tok);
  if (!p) return null;
  const me = { score: p.score, streak: p.streak, answered: !!(p.last && p.last.answered), ok: !!(p.last && p.last.ok), delta: p.last ? p.last.delta : 0, n: qz.players.size };
  if (qz.phase === 'reveal' || qz.phase === 'final') me.rank = quizRanking(qz).findIndex(r => r.tok === tok) + 1;
  return me;
}
function quizPlayer(room, ws) {
  const qz = room.quiz, tok = ws.ctx.tok;
  let p = qz.players.get(tok);
  if (!p) { p = { name: ws.ctx.name, score: 0, streak: 0, last: null }; qz.players.set(tok, p); room.quizDirty = true; }
  return p;
}
function quizSendMe(room) {
  const qz = room.quiz;
  const pos = new Map(quizRanking(qz).map((r, i) => [r.tok, i + 1]));
  room.clients.forEach(c => {
    const p = qz.players.get(c.ctx.tok);
    if (!p) return;
    send(c, { type: 'quiz-me', me: { score: p.score, streak: p.streak, answered: !!(p.last && p.last.answered), ok: !!(p.last && p.last.ok), delta: p.last ? p.last.delta : 0, rank: pos.get(c.ctx.tok), n: qz.players.size } });
  });
}
function quizNext(room) {
  const qz = room.quiz;
  clearTimeout(qz.timer);
  if (qz.idx + 1 >= qz.questions.length) return quizFinal(room);
  qz.idx++; qz.phase = 'question'; qz.answers = new Map(); qz.counts = null; qz.early = false;
  qz.players.forEach(p => { p.last = null; });
  const q = qz.questions[qz.idx];
  qz.startAt = Date.now() + 3500;                      // "Tayyor bo'ling" sanog'i, rasm yuklanishi uchun
  qz.endAt = qz.startAt + q.time * 1000;
  broadcast(room, { type: 'quiz', quiz: quizPub(room) });
  qz.timer = setTimeout(() => quizReveal(room), qz.endAt - Date.now() + 1200);
  room.quizDirty = true;
}
function quizReveal(room) {
  const qz = room.quiz;
  if (!qz || qz.phase !== 'question') return;
  clearTimeout(qz.timer);
  qz.phase = 'reveal';
  const q = qz.questions[qz.idx];
  qz.counts = q.opts.map(() => 0);
  qz.answers.forEach(a => { qz.counts[a.i]++; });
  qz.players.forEach((p, tok) => { if (!qz.answers.has(tok)) { p.streak = 0; p.last = { ok: false, delta: 0, answered: false }; } });
  qz.top = quizRanking(qz).slice(0, 5).map(r => ({ name: r.name, score: r.score, delta: r.delta }));
  broadcast(room, { type: 'quiz', quiz: quizPub(room) });
  quizSendMe(room);
}
function quizFinal(room) {
  const qz = room.quiz;
  clearTimeout(qz.timer);
  qz.phase = 'final';
  qz.top = quizRanking(qz).slice(0, 10).map(r => ({ name: r.name, score: r.score, delta: 0 }));
  broadcast(room, { type: 'quiz', quiz: quizPub(room) });
  quizSendMe(room);
}
function quizCheckEarly(room) {                         // hamma javob bergan bo'lsa, vaqtni kutmasdan ochamiz
  const qz = room.quiz;
  if (!qz || qz.phase !== 'question' || qz.early || !room.clients.size || Date.now() < qz.startAt) return;
  if (qz.answers.size >= room.clients.size) { qz.early = true; clearTimeout(qz.timer); qz.timer = setTimeout(() => quizReveal(room), 700); }
}

const pollPub = p => p && { id: p.id, q: p.q, opts: p.opts, votes: p.votes, open: p.open };

function sendMembers(room) {
  if (room.memT) return;
  room.memT = setTimeout(() => { room.memT = null; if (rooms.has(room.code)) flushMembers(room); }, room.clients.size > 20 ? 600 : 120);
}
function flushMembers(room) {
  const clients = [...room.clients];
  let ready = 0;
  for (const c of clients) if (c.ctx && c.ctx.ready) ready++;
  const base = { type: 'members', total: clients.length, ready, hostOnline: !!room.host };
  sendAll(clients, base);
  send(room.host, {
    ...base,
    list: clients.slice(0, 300).map(c => ({ id: c.ctx.id, name: c.ctx.name, ready: !!c.ctx.ready, muted: !!c.ctx.muted, stat: c.ctx.stat || null, via: c.ctx.parent || null })),
  });
}

// ---- Efir daraxti: Transmitter -> (relay receiverlar) -> boshqa receiverlar. Transmitter yukini cheklaydi, 100+ tinglovchi uchun
function depthOf(room, c) {
  let d = 1, p = c.ctx.parent;
  while (p && p !== 'host' && d < 12) { const pc = clientById(room, p); if (!pc) break; d++; p = pc.ctx.parent; }
  return d;
}
function isDescendant(room, x, anc) {                  // x, anc ning avlodimi?
  let p = x.ctx.parent, n = 0;
  while (p && p !== 'host' && n++ < 12) { if (p === anc.ctx.id) return true; const pc = clientById(room, p); if (!pc) return false; p = pc.ctx.parent; }
  return false;
}
function detach(room, c) {
  const p = c.ctx.parent;
  c.ctx.parent = null;
  if (!p) return;
  if (p === 'host') send(room.host, { type: 'rtc-gone', id: c.ctx.id });
  else { const pc = clientById(room, p); if (pc) { pc.ctx.children.delete(c.ctx.id); send(pc, { type: 'rtc-gone', id: c.ctx.id }); } }
}
function pickParent(room, c) {
  let hostKids = 0;
  room.clients.forEach(x => { if (x.ctx.parent === 'host') hostKids++; });
  if (hostKids < HOST_FANOUT) return 'host';
  let best = null, bs = 1e9;
  room.clients.forEach(x => {
    if (x === c || !x.ctx.canRelay || !x.ctx.streamReady || x.ctx.children.size >= RELAY_FANOUT || isDescendant(room, x, c)) return;
    const score = depthOf(room, x) * 10 + x.ctx.children.size - (x.ctx.stat ? x.ctx.stat.q : 0);   // sayoz, bo'sh va tarmog'i yaxshi relay afzal
    if (score < bs) { bs = score; best = x; }
  });
  if (best) return best.ctx.id;
  return hostKids < HOST_MAX ? 'host' : null;
}
function resetTree(room) {
  room.clients.forEach(c => { c.ctx.parent = null; c.ctx.streamReady = false; c.ctx.children.clear(); });
}

function removeRoom(room, reason) {
  if (room.quiz) clearTimeout(room.quiz.timer);
  clearTimeout(room.memT); clearTimeout(room.reactT);
  if (room.waitT) clearInterval(room.waitT);
  broadcast(room, { type: 'closed', reason });
  everyone(room).forEach(w => { try { w.close(); } catch {} });
  rooms.delete(room.code);
  fs.rm(path.join(UPLOAD_DIR, room.code), { recursive: true, force: true }, () => {});
}

function dropItemFile(room, item) {
  if (item.external) return;
  fs.unlink(path.join(UPLOAD_DIR, room.code, path.basename(item.url)), () => {});
}

function selectItem(room, id, autoplay) {
  cancelWait(room);
  if (!room.items.some(i => i.id === id)) return;
  const s = room.state;
  const item = room.items.find(i => i.id === id);
  const play = !!autoplay && isMedia(item.kind);          // rasm/hujjatlar "chalinmaydi"
  s.currentId = id;
  s.position = 0;
  s.playing = play;
  s.playAt = play ? Date.now() + AUTOPLAY_LEAD : 0;
  room.clients.forEach(c => { if (c.ctx) c.ctx.ready = false; });
  broadcast(room, stateMsg(room));
  sendMembers(room);
}

// ---------------------------------------------------------------- REST

app.post('/api/rooms', (req, res) => {
  if (rooms.size >= MAX_ROOMS) return res.status(503).json({ error: 'Server band, keyinroq urinib ko\'ring' });
  const room = newRoom();
  if (!room) return res.status(503).json({ error: 'Kod yaratib bo\'lmadi' });
  res.json({ code: room.code, hostKey: room.hostKey });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ exists: false });
  const key = req.query.key;
  res.json({ exists: true, isHost: !!key && key === room.hostKey });
});

app.get('/api/info', (req, res) => {
  res.json({ lan: lanAddresses(), port: Number(PORT), maxMb: MAX_MB });
});

app.get('/api/qr', async (req, res) => {
  try {
    const text = String(req.query.text || '').slice(0, 500);
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#111111', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch { res.status(400).end(); }
});

// Viktorina rasmlari (savolga biriktirilgan): kichik, kesh qilinadigan, faqat rasm turlari
const QIMG_RE = /^q_[a-f0-9]{12}\.(jpg|png|webp)$/;
app.post('/api/rooms/:code/qimg', express.raw({ type: () => true, limit: '1.5mb' }), (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room || req.query.key !== room.hostKey) return res.status(403).json({ error: 'Ruxsat yo\'q' });
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim();
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[ct];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(415).json({ error: 'Faqat JPG/PNG/WebP rasm' });
  const dir = path.join(UPLOAD_DIR, room.code);
  fs.mkdirSync(dir, { recursive: true });
  const name = `q_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFile(path.join(dir, name), req.body, err => {
    if (err) return res.status(500).json({ error: 'Saqlashda xato' });
    res.json({ url: `/qimg/${room.code}/${name}` });
  });
});
app.get('/qimg/:code/:file', (req, res) => {
  if (!rooms.has(req.params.code) || !QIMG_RE.test(req.params.file)) return res.status(404).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(UPLOAD_DIR, req.params.code, req.params.file), { dotfiles: 'deny' }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// Fayl yuklash: xom oqim (multipart emas) — tez va xotirani to'ldirmaydi
app.post('/api/rooms/:code/upload', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room || req.query.key !== room.hostKey) return res.status(403).json({ error: 'Ruxsat yo\'q' });

  const name = safeName(req.query.name);
  const ext = path.extname(name).toLowerCase();
  const kind = kindOf(ext);
  if (!kind) return res.status(415).json({ error: 'Bu format qo\'llab-quvvatlanmaydi' });
  const cid = String(req.query.cid || '').replace(/[^a-z0-9]/gi, '').slice(0, 20);

  const len = Number(req.headers['content-length']) || 0;
  if (len > MAX_BYTES) return res.status(413).json({ error: `Fayl ${MAX_MB} MB dan katta` });

  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(UPLOAD_DIR, room.code);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + ext);

  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) return cb(new Error('LIMIT'));
      cb(null, chunk);
    },
  });

  pipeline(req, limiter, fs.createWriteStream(file), err => {
    if (err) {
      fs.unlink(file, () => {});
      if (!res.headersSent) res.status(err.message === 'LIMIT' ? 413 : 500).json({ error: err.message === 'LIMIT' ? `Fayl ${MAX_MB} MB dan katta` : 'Yuklashda xato' });
      return;
    }
    if (!rooms.has(room.code)) { fs.unlink(file, () => {}); return res.status(410).end(); }
    const item = { id, cid, name, kind, url: `/files/${room.code}/${id}${ext}`, size, external: false, gainDb: null };
    room.items.push(item);
    let first = false;
    if (!room.state.currentId) { room.state.currentId = id; first = true; }
    broadcast(room, { type: 'items', items: room.items });
    if (first) broadcast(room, stateMsg(room));        // keraksiz state yuborilmaydi: pleyerga tegmaslik uchun
    res.json(item);
  });
});

// ---------------------------------------------------------------- WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });

wss.on('connection', ws => {
  ws.ctx = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'ping') return send(ws, { type: 'pong', t0: m.t0, serverNow: Date.now() });

    if (m.type === 'join') return onJoin(ws, m);

    const ctx = ws.ctx;
    if (!ctx) return;
    const room = ctx.room;
    room.lastSeen = Date.now();

    if (m.type === 'ready') {
      if (ctx.role === 'receiver' && m.id === room.state.currentId) { ctx.ready = m.ok !== false; sendMembers(room); }
      return;
    }

    if (m.type === 'stat' && ctx.role === 'receiver') {            // receiver tarmoq/sinxron holati (host ro'yxati va adaptiv kechikish uchun)
      const n = v => (Number.isFinite(+v) ? +v : 0);
      ctx.stat = { rtt: clampN(n(m.rtt), 0, 5000), jitter: clampN(n(m.jitter), 0, 5000), q: clampN(Math.round(n(m.q)), 0, 4), drift: clampN(n(m.drift), -60000, 60000), buf: clampN(n(m.buf), 0, 3600), loss: clampN(n(m.loss), 0, 100) };
      room.dirty = true;
      return;
    }

    // Jonli efir (WebRTC): server faqat daraxtni quradi va signallarni uzatadi
    if (m.type === 'rtc-want' && ctx.role === 'receiver') {
      detach(room, ws);
      const pid = pickParent(room, ws);
      const parentWs = pid === 'host' ? room.host : pid ? clientById(room, pid) : null;
      if (!parentWs) return send(ws, { type: 'rtc-wait' });
      ctx.parent = pid;
      if (pid !== 'host') parentWs.ctx.children.add(ctx.id);
      send(ws, { type: 'rtc-parent', id: pid, depth: depthOf(room, ws) });
      send(parentWs, { type: 'rtc-want', from: ctx.id });
      return;
    }
    if (m.type === 'rtc-ready' && ctx.role === 'receiver') { ctx.streamReady = !!m.ok; return; }
    if (m.type === 'rtc-signal') {
      const from = ctx.role === 'host' ? 'host' : ctx.id;
      const target = m.to === 'host' ? room.host : clientById(room, String(m.to));
      if (target) send(target, { type: 'rtc-signal', from, data: m.data });
      return;
    }
    if (m.type === 'react' && ctx.role === 'receiver') {          // reaksiyalar yig'ilib, 0.6 s da bir marta yuboriladi
      const now = Date.now();
      if (!room.cfg.allowReact || !REACTS.includes(m.e) || now - (ctx.lastReact || 0) < 250) return;
      ctx.lastReact = now;
      room.reacts = room.reacts || {};
      room.reacts[m.e] = (room.reacts[m.e] || 0) + 1;
      if (!room.reactT) room.reactT = setTimeout(() => { const counts = room.reacts; room.reacts = {}; room.reactT = null; broadcast(room, { type: 'react', counts }); }, 600);
      return;
    }
    if (m.type === 'quiz-answer' && ctx.role === 'receiver') {
      const qz = room.quiz;
      if (!qz || qz.phase !== 'question') return;
      const now = Date.now(), q = qz.questions[qz.idx], i = Number(m.i);
      if (now < qz.startAt - 250 || now > qz.endAt + 1500 || qz.answers.has(ctx.tok) || !Number.isInteger(i) || i < 0 || i >= q.opts.length) return;
      const p = quizPlayer(room, ws);
      const el = clampN(now - qz.startAt, 0, q.time * 1000);
      const ok = i === q.correct;
      let delta = 0;
      if (ok) {
        const base = q.pts === 'double' ? 2000 : q.pts === 'none' ? 0 : 1000;
        p.streak++;
        delta = Math.round(base * (1 - (el / (q.time * 1000)) / 2));          // tezroq javob = ko'proq ball (Kahoot formulasi)
        if (base > 0 && p.streak >= 2) delta += Math.min(5, p.streak - 1) * 100;   // ketma-ket to'g'ri javob bonusi
      } else p.streak = 0;
      p.score += delta; p.last = { ok, delta, i, answered: true };
      qz.answers.set(ctx.tok, { i, el });
      send(ws, { type: 'quiz-ack', i });
      room.quizDirty = true;
      quizCheckEarly(room);
      return;
    }
    if (m.type === 'quiz-nick' && ctx.role === 'receiver') {
      const nm = String(m.name || '').trim().slice(0, 24);
      if (!nm) return;
      ctx.name = nm;
      if (room.quiz) { const p = room.quiz.players.get(ctx.tok); if (p) p.name = nm; }
      sendMembers(room);
      return;
    }
    if (m.type === 'vote' && ctx.role === 'receiver') {
      const p = room.poll, i = Number(m.i);
      if (!p || !p.open || p.voted.has(ctx.tok) || !Number.isInteger(i) || i < 0 || i >= p.opts.length) return;
      p.voted.set(ctx.tok, i); p.votes[i]++; room.pollDirty = true;
      send(ws, { type: 'voted', id: p.id, i });
      return;
    }

    if (ctx.role !== 'host') return;                     // pastdagilar faqat Transmitter uchun
    const s = room.state;

    switch (m.type) {
      case 'select':
        selectItem(room, String(m.id), !!m.autoplay);
        break;
      case 'play': {
        const cur = room.items.find(i => i.id === s.currentId);
        if (!cur || !isMedia(cur.kind) || room.waitT) break;
        const notReady = () => { let n = 0; room.clients.forEach(c => { if (c.ctx && !c.ctx.ready) n++; }); return n; };
        const allowed = room.clients.size < 10 ? 0 : Math.floor(room.clients.size * 0.1);   // 100+ odamda 10% sekinlari kutilmaydi
        const go = () => {
          cancelWait(room);
          s.position = s.playing ? expectedPos(room) : s.position;
          s.playing = true;
          s.playAt = Date.now() + leadMs(room);
          broadcast(room, stateMsg(room));
        };
        if (s.playing || !room.cfg.waitAll || notReady() <= allowed) return go();
        const t0 = Date.now();
        broadcast(room, { type: 'waiting', n: notReady() });
        room.waitT = setInterval(() => {
          const n = notReady();
          if ((n <= allowed && Date.now() - t0 > 700) || Date.now() - t0 > 5000) go();
          else broadcast(room, { type: 'waiting', n });
        }, 250);
        break;
      }
      case 'pause':
        cancelWait(room);
        if (s.playing) s.position = expectedPos(room);
        s.playing = false;
        broadcast(room, stateMsg(room));
        break;
      case 'seek': {
        const p = Math.max(0, Number(m.position) || 0);
        s.position = p;
        if (s.playing) s.playAt = Date.now() + Math.round(leadMs(room) / 2);
        broadcast(room, stateMsg(room));
        break;
      }
      case 'settings':
        s.autoNext = !!m.autoNext;
        broadcast(room, stateMsg(room));
        break;
      case 'cfg':
        applyCfg(room, m.patch);
        broadcast(room, { type: 'cfg', cfg: room.cfg });
        break;
      case 'norm': {                                  // Transmitter o'lchagan balandlik tuzatmasi: hamma qurilmaga bir xil
        const it = room.items.find(i => i.id === m.id);
        const g = Number(m.gainDb);
        if (!it || !Number.isFinite(g)) break;
        it.gainDb = Math.max(-24, Math.min(24, Math.round(g * 10) / 10));
        broadcast(room, { type: 'items', items: room.items });
        break;
      }
      case 'stop':
        cancelWait(room);
        s.playing = false; s.position = 0; s.playAt = 0;
        broadcast(room, stateMsg(room));
        break;
      case 'next':
      case 'prev': {
        const idx = room.items.findIndex(i => i.id === s.currentId);
        let target = null;
        if (m.type === 'next') target = room.items[idx + 1] || (room.cfg.loop === 'all' ? room.items[0] : null);
        else target = idx > 0 ? room.items[idx - 1] : room.items[idx];
        if (target) selectItem(room, target.id, true);
        break;
      }
      case 'ended': {
        if (m.id !== s.currentId) break;
        const idx = room.items.findIndex(i => i.id === s.currentId);
        const next = room.items[idx + 1];
        if (room.cfg.loop === 'one') selectItem(room, s.currentId, true);
        else if (next && (s.autoNext || room.cfg.loop === 'all')) selectItem(room, next.id, true);
        else if (room.cfg.loop === 'all' && room.items.length) selectItem(room, room.items[0].id, true);
        else { s.playing = false; s.position = 0; broadcast(room, stateMsg(room)); }
        break;
      }
      case 'mute-one': {
        const c = [...room.clients].find(x => x.ctx && x.ctx.id === m.id);
        if (!c) break;
        c.ctx.muted = !!m.muted;
        send(c, { type: 'you', muted: c.ctx.muted });
        sendMembers(room);
        break;
      }
      case 'kick': {
        const c = [...room.clients].find(x => x.ctx && x.ctx.id === m.id);
        if (!c) break;
        if (c.ctx.tok) room.tokens.delete(c.ctx.tok);
        send(c, { type: 'kicked' });
        try { c.close(); } catch {}
        break;
      }
      case 'quiz-start': {
        const r = sanitizeQuiz(room, m.quiz);
        if (r.error) { send(ws, { type: 'notice', message: '🎯 ' + r.error }); break; }
        if (room.quiz) clearTimeout(room.quiz.timer);
        room.quiz = { id: crypto.randomBytes(4).toString('hex'), title: r.title, questions: r.questions, idx: -1, phase: 'lobby', players: new Map(), answers: new Map(), startAt: 0, endAt: 0, timer: null };
        room.clients.forEach(c => quizPlayer(room, c));
        broadcast(room, { type: 'quiz', quiz: quizPub(room) });
        room.quizDirty = true;
        break;
      }
      case 'quiz-next': if (room.quiz && ['lobby', 'reveal'].includes(room.quiz.phase)) quizNext(room); break;
      case 'quiz-skip': quizReveal(room); break;
      case 'quiz-end': if (room.quiz && room.quiz.phase !== 'final') quizFinal(room); break;
      case 'quiz-close':
        if (room.quiz) clearTimeout(room.quiz.timer);
        room.quiz = null;
        broadcast(room, { type: 'quiz', quiz: null });
        break;
      case 'poll-open': {
        const opts = (Array.isArray(m.opts) ? m.opts : []).map(o => String(o || '').trim().slice(0, 60)).filter(Boolean).slice(0, 4);
        const q = String(m.q || '').trim().slice(0, 120);
        if (!q || opts.length < 2) { send(ws, { type: 'notice', message: 'Savol va kamida 2 ta variant kiriting' }); break; }
        room.poll = { id: crypto.randomBytes(4).toString('hex'), q, opts, votes: opts.map(() => 0), voted: new Map(), open: true };
        broadcast(room, { type: 'poll', poll: pollPub(room.poll) });
        break;
      }
      case 'poll-close':
        if (room.poll) { room.poll.open = false; broadcast(room, { type: 'poll', poll: pollPub(room.poll) }); }
        break;
      case 'poll-clear':
        room.poll = null; broadcast(room, { type: 'poll', poll: null });
        break;
      case 'test':                                      // Sinxron test signali (Bluetooth kechikishini quloq bilan tuzatish uchun)
        broadcast(room, { type: 'test', on: !!m.on, t0: Date.now() + 1500 });
        break;
      case 'rename': {                                  // YouTube sarlavhasi
        const it = room.items.find(i => i.id === m.id);
        const nm = safeName(m.name);
        if (it && it.kind === 'youtube' && nm) { it.name = nm; broadcast(room, { type: 'items', items: room.items }); }
        break;
      }
      case 'announce': {
        const text = String(m.text || '').trim().slice(0, 200);
        if (text) sendAll(room.clients, { type: 'notice', message: '📢 ' + text });
        break;
      }
      case 'live': {
        const id = v => (typeof v === 'string' && v ? v.slice(0, 80) : null);
        room.live = { mic: id(m.mic), screen: id(m.screen), mode: m.mode === 'motion' ? 'motion' : 'detail' };
        if (!room.live.mic && !room.live.screen) resetTree(room);
        sendAll(room.clients, { type: 'live', live: room.live });
        break;
      }
      case 'add-url': {
        let u;
        try { u = new URL(String(m.url)); } catch { return send(ws, { type: 'notice', message: 'Havola noto\'g\'ri' }); }
        if (!/^https?:$/.test(u.protocol)) return send(ws, { type: 'notice', message: 'Faqat http/https havola' });
        const ext = path.extname(u.pathname).toLowerCase();
        const yid = ytIdOf(u);
        const item = yid ? {
          id: crypto.randomBytes(6).toString('hex'), name: safeName(m.name || 'YouTube video'), cid: '',
          kind: 'youtube', ytId: yid, url: `https://www.youtube.com/watch?v=${yid}`, size: 0, external: true, gainDb: null,
        } : {
          id: crypto.randomBytes(6).toString('hex'),
          name: safeName(m.name || decodeURIComponent(path.basename(u.pathname)) || u.hostname),
          cid: '',
          kind: kindOf(ext) || 'video',
          url: u.href, size: 0, external: true, gainDb: null,
        };
        room.items.push(item);
        let first = false;
        if (!s.currentId) { s.currentId = item.id; first = true; }
        broadcast(room, { type: 'items', items: room.items });
        if (first) broadcast(room, stateMsg(room));
        break;
      }
      case 'remove': {
        const idx = room.items.findIndex(i => i.id === m.id);
        if (idx < 0) break;
        const [item] = room.items.splice(idx, 1);
        dropItemFile(room, item);
        if (s.currentId === item.id) {
          s.currentId = null; s.playing = false; s.position = 0;
          room.clients.forEach(c => { if (c.ctx) c.ctx.ready = false; });
        }
        broadcast(room, { type: 'items', items: room.items });
        broadcast(room, stateMsg(room));
        sendMembers(room);
        break;
      }
      case 'close':
        removeRoom(room, 'Transmitter xonani yopdi');
        break;
    }
  });

  ws.on('close', () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    const room = ctx.room;
    if (ctx.role === 'host') {
      if (room.host === ws) {
        room.host = null;
        room.live = { mic: null, screen: null };      // Transmitter uzildi: jonli efir to'xtaydi
        resetTree(room);
        sendAll(room.clients, { type: 'live', live: room.live });
      }
    }
    else {
      const kids = [...ctx.children];
      detach(room, ws);
      room.clients.delete(ws);
      kids.forEach(id => { const k = clientById(room, id); if (k) { k.ctx.parent = null; send(k, { type: 'rtc-reparent' }); } });   // bolalari yangi manba topadi
    }
    room.lastSeen = Date.now();
    if (room.quiz) { room.quizDirty = true; quizCheckEarly(room); }
    if (rooms.has(room.code)) sendMembers(room);
  });
});

function onJoin(ws, m) {
  const room = rooms.get(String(m.code));
  if (!room) {
    send(ws, { type: 'error', code: 'NO_ROOM', message: 'Bunday kodli xona topilmadi' });
    return ws.close();
  }
  const isHost = m.role === 'host';
  if (isHost && m.key !== room.hostKey) {
    send(ws, { type: 'error', code: 'BAD_KEY', message: 'Transmitter kaliti noto\'g\'ri' });
    return ws.close();
  }
  const known = !isHost && m.tok && room.tokens.get(String(m.tok)) === 'receiver';   // qayta ulanayotgan receiver
  if (!isHost && room.cfg.locked && !known) {
    send(ws, { type: 'error', code: 'LOCKED', message: 'Transmitter xonani qulflagan' });
    return ws.close();
  }
  if (!isHost && room.clients.size >= MAX_CLIENTS) {
    send(ws, { type: 'error', code: 'FULL', message: 'Xona to\'lgan' });
    return ws.close();
  }

  ws.ctx = {
    room, role: isHost ? 'host' : 'receiver',
    id: crypto.randomBytes(3).toString('hex'),
    name: String(m.name || '').slice(0, 24).trim() || 'Receiver',
    ready: false, muted: false,
    canRelay: !isHost && !!m.relay, parent: null, children: new Set(), streamReady: false,
  };
  ws.ctx.tok = issueToken(room, ws.ctx.role, m.tok && String(m.tok));
  if (isHost) {
    if (room.host && room.host !== ws) { try { room.host.close(); } catch {} }
    room.host = ws;
  } else {
    room.clients.add(ws);
  }
  room.lastSeen = Date.now();
  send(ws, {
    type: 'joined', role: ws.ctx.role, code: room.code, items: room.items, state: room.state,
    cfg: room.cfg, live: room.live, poll: pollPub(room.poll), myVote: room.poll ? room.poll.voted.get(ws.ctx.tok) : undefined, myId: ws.ctx.id, tok: ws.ctx.tok, serverNow: Date.now(),
  });
  if (isHost) sendAll(room.clients, { type: 'live', live: room.live, resync: true });
  if (room.quiz) {
    if (!isHost) quizPlayer(room, ws);
    const a = room.quiz.answers.get(ws.ctx.tok);
    send(ws, { type: 'quiz-state', quiz: quizPub(room), me: quizMe(room, ws.ctx.tok), myAnswer: a ? a.i : null });
    room.quizDirty = true;
  }   // host qayta ulandi: efirni tiklash
  sendMembers(room);
}

// Proksi/hosting uzilib qolmasligi uchun yurak urishi
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000);

// Receiver statistikasini hostga siyraklashtirib yuborish
setInterval(() => { for (const room of rooms.values()) if (room.dirty) { room.dirty = false; sendMembers(room); } }, 2000);

// So'rovnoma natijalari: 1 s da bir marta (har bir ovozda emas)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.pollDirty) { room.pollDirty = false; broadcast(room, { type: 'poll', poll: pollPub(room.poll) }); }
    if (room.quizDirty && room.quiz) { room.quizDirty = false; send(room.host, { type: 'quiz-progress', answered: room.quiz.answers.size, total: room.clients.size, players: room.quiz.players.size }); }
  }
}, 1000);

// Bo'sh xonalarni tozalash
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const empty = !room.host && room.clients.size === 0;
    if ((empty && now - room.lastSeen > IDLE_ROOM_MS) || (!room.host && now - room.lastSeen > MAX_HOSTLESS_MS)) {
      removeRoom(room, 'Xona vaqti tugadi');
    }
  }
}, 60 * 1000);

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  SyncCast ishga tushdi\n');
  console.log(`  Shu kompyuterda:   http://localhost:${PORT}`);
  lanAddresses().forEach(ip => console.log(`  Wi-Fi tarmog'ida:  http://${ip}:${PORT}`));
  console.log('\n  Transmitter xona yaratadi, Receiverlar kod bilan kiradi.\n');
});

process.on('SIGINT', () => { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); process.exit(0); });
