'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline, Transform } = require('stream');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
// .env faylini (agar bo'lsa) o'qiydi — qo'shimcha paketsiz
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (e) { /* .env yo'q — muammo emas */ }

const PORT = process.env.PORT || 3000;
const MAX_MB = Number(process.env.MAX_MB) || 7168;       // bitta fayl uchun limit (standart 7 GB)
const MAX_BYTES = MAX_MB * 1024 * 1024;
const fmtLimit = mb => (mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB' : mb + ' MB');
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
// Matnli statik fayllar (html/js/css) bir marta siqilib xotirada saqlanadi (brotli/gzip): 115 KB app.js ~ 28 KB bo'ladi.
// Sekin Wi-Fi'da yuzlab qurilma bir vaqtda kirganda sahifa tez ochiladi va server protsessori ortiqcha yuklanmaydi.
const PUB_DIR = path.join(__dirname, 'public');
const zCache = new Map();                                      // fayl -> { mtime, raw, br, gz, type }
const Z_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const rel = req.path === '/' ? '/index.html' : req.path;
  const ext = path.extname(rel);
  if (!Z_TYPES[ext]) return next();
  const file = path.join(PUB_DIR, path.normalize(rel));
  if (!file.startsWith(PUB_DIR + path.sep)) return next();
  let st; try { st = fs.statSync(file); } catch { return next(); }
  let e = zCache.get(file);
  if (!e || e.mtime !== st.mtimeMs) {
    const raw = fs.readFileSync(file);
    e = { mtime: st.mtimeMs, raw, type: Z_TYPES[ext], etag: `"${st.size}-${Math.round(st.mtimeMs)}"`,
      br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), gz: zlib.gzipSync(raw, { level: 9 }) };
    zCache.set(file, e);
  }
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache' : 'public, max-age=3600');
  res.setHeader('ETag', e.etag);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
  const ae = String(req.headers['accept-encoding'] || '');
  let body = e.raw;
  if (/\bbr\b/.test(ae)) { body = e.br; res.setHeader('Content-Encoding', 'br'); }
  else if (/\bgzip\b/.test(ae)) { body = e.gz; res.setHeader('Content-Encoding', 'gzip'); }
  res.type(e.type).setHeader('Content-Length', body.length);
  res.end(body);
});
app.use(express.static(PUB_DIR, { maxAge: '1h', etag: true, setHeaders: (res, f) => { if (/\.(html|js|css)$/i.test(f)) res.setHeader('Cache-Control', 'no-cache'); } }));

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
    guard: true,            // viktorina paytida receiverda nusxa/skrinshot himoyasi
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
  for (const k of ['allowView', 'allowDownload', 'guard', 'muteAll', 'lockVolume', 'normalize', 'duck', 'locked', 'waitAll', 'allowReact']) {
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
const AVATARS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🦆','🦉','🦄','🐝','🦋','🐢','🐙','🦀','🐬','🐳','🦈','🐊','🦒','🦓','🐘','🦔','🐿️','🦜','🦩',
  '🍎','🍌','🍇','🍓','🍉','🍊','🍋','🍍','🥝','🍒','🍑','🥭','🍐','🥥','🍅','🥕','🌽','🍄','🌵','🌻','⭐','🚀','🎈','⚽','🎸','🍕','🍩','🍦'];
const pickAvatar = () => AVATARS[Math.floor(Math.random() * AVATARS.length)];
// ---------------------------------------------------------------- AI savollar ("Do'st bilan do'st" rejimi)
// Savollarni hech kim tuzmaydi: har safar tasodifiy mavzular tanlanadi va AI (Google Gemini API) 11 ta yangi savol yozadi.
// Sozlash: GEMINI_API_KEY (majburiy), AI_MODEL (ixtiyoriy, standart gemini-2.5-flash).
const AI_KEY = process.env.GEMINI_API_KEY || '';
const AI_MODELS = [process.env.AI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-2.0-flash'].filter((x, i, a) => x && a.indexOf(x) === i);
let aiGoodModel = '';                                      // ishlagan model eslab qolinadi
const AI_COUNT = 11;                                       // standart; Transmitter 3–30 oralig'ida o'zi tanlaydi
const AI_MIN = 3, AI_MAX = 30;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 45000;     // bitta urinish uchun
const AI_TOTAL_MS = Number(process.env.AI_TOTAL_MS) || 100000;        // jami kutish chegarasi (foydalanuvchi cheksiz kutmasin)
const AI_MAX_PARALLEL = 4;                                // serverda bir vaqtda ketayotgan AI so'rovlar
let aiActive = 0;
const AI_TOPICS = ['O\'zbekiston tarixi', 'O\'zbekiston geografiyasi', 'jahon geografiyasi', 'jahon tarixi', 'kosmos va astronomiya', 'hayvonot dunyosi',
  'o\'simliklar va tabiat', 'inson tanasi', 'fizika', 'kimyo', 'matematika va mantiq', 'texnologiya va internet', 'kompyuter va dasturlash',
  'sport', 'futbol', 'kino va multfilmlar', 'musiqa', 'adabiyot va shoirlar', 'o\'zbek madaniyati va an\'analar', 'milliy taomlar va oshxona',
  'dunyo taomlari', 'mashhur kashfiyotlar va ixtirochilar', 'iqtisod va pul', 'transport va mashinalar', 'san\'at va rassomlar', 'mifologiya va afsonalar',
  'ajoyib rekordlar va faktlar', 'tillar va so\'zlar', 'okeanlar, tog\'lar va daryolar', 'ob-havo va tabiat hodisalari', 'mashhur shaxslar', 'o\'yinlar va video o\'yinlar'];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const AI_LEVELS = { easy: 'oson (maktab o\'quvchisi ham biladi)', mid: 'o\'rta (oddiy bilimdon odam biladi)', hard: 'qiyin (chuqur bilim talab qiladi)', mix: 'aralash: taxminan teng miqdorda oson, o\'rta va qiyin savollar' };
const AI_LANGS = { uz: "o'zbek tili (lotin yozuvi)", en: 'English', ru: 'русский язык', tr: 'Türkçe', ar: 'العربية', de: 'Deutsch', fr: 'français', es: 'español', ko: '한국어', zh: '中文' };
function aiPrompt(topic, level, n, lang, part) {
  const nonce = crypto.randomBytes(4).toString('hex');
  part = part || { i: 0, k: 1, topics: shuffle(AI_TOPICS).slice(0, n) };
  const topics = topic ? `Mavzu: "${topic}". ${n} ta savolning har biri shu mavzuning BOSHQA-BOSHQA tomoniga oid bo'lsin.` +
      (part.k > 1 ? ` (Bu ${part.k} qismdan ${part.i + 1}-qism: boshqa qismlar bilan savollar takrorlanmasligi uchun mavzuning ${part.i + 1}-chi yo'nalishlariga e'tibor ber.)` : '')
    : `Har bir savol uchun mavzu (shu tartibda): ${part.topics.map((t, i) => `${i + 1}) ${t}`).join('; ')}.`;
  return `Sen do'stlar uchun viktorina (quiz) savollarini tuzuvchisan. Aniq ${n} ta test savoli tuz.\n` +
    `Til: ${lang && AI_LANGS[lang] ? 'FAQAT ' + AI_LANGS[lang] + ' (savollar va barcha variantlar shu tilda)' : "foydalanuvchi mavzusida til aytilgan bo'lsa (masalan 'ingliz tilida', 'in Russian') - o'sha tilda; aytilmagan bo'lsa, mavzu qaysi tilda yozilgan bo'lsa - shu tilda; mavzu bo'sh bo'lsa - o'zbek tili (lotin yozuvi). Savollar va barcha variantlar bitta tilda bo'lsin"}. Qiyinlik: ${AI_LEVELS[level] || AI_LEVELS.mix}.\n${topics}\n` +
    `Qoidalar:\n- Har savolda aynan 4 ta variant, faqat bittasi to'g'ri; noto'g'ri variantlar ishonarli bo'lsin.\n` +
    `- Faqat aniq, tekshirilgan, bahssiz faktlar. Noaniq, sana-tafsilotga bog'liq yoki o'zgarib turadigan savol berma.\n` +
    `- Savol matni 200 belgidan, variant 80 belgidan oshmasin. Savollar bir-biriga o'xshamasin, banal/eng mashhur savollardan qoching.\n` +
    `- To'g'ri javob o'rni (0-3) tasodifiy bo'lsin.\n- Tasodifiylik kaliti: ${nonce}.\n` +
    `Javobni FAQAT quyidagi JSON ko'rinishida qaytar, boshqa matn yoki markdown yozma:\n` +
    `{"questions":[{"text":"...","opts":["A","B","C","D"],"correct":0}]}`;
}
function aiParse(text, n) {
  text = String(text).replace(/```(?:json)?/gi, '');
  const a = text.indexOf('{');
  if (a < 0) throw new Error('AI javobi tushunarsiz');
  let j = null;
  const b = text.lastIndexOf('}');
  try { j = JSON.parse(text.slice(a, b + 1)); }
  catch {                                                                   // javob uzilib qolgan bo'lsa: to'liq savollarni qutqaramiz
    let cut = b;
    for (let i = 0; i < 40 && cut > a && !j; i++) {
      try { j = JSON.parse(text.slice(a, cut + 1) + ']}'); } catch { cut = text.lastIndexOf('}', cut - 1); }
    }
    if (!j) throw new Error('AI javobi tushunarsiz (JSON)');
  }
  const out = [], seen = new Set();
  for (const q of Array.isArray(j.questions) ? j.questions : []) {
    const t = String(q && q.text || '').trim().slice(0, 240);
    const opts = (Array.isArray(q && q.opts) ? q.opts : []).map(o => String(o || '').trim().slice(0, 120));
    const c = Number(q && q.correct);
    if (!t || opts.length !== 4 || opts.some(o => !o) || new Set(opts.map(o => o.toLowerCase())).size !== 4 || !(c >= 0 && c <= 3) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    const order = shuffle([0, 1, 2, 3]);                  // to'g'ri javob o'rnini server ham aralashtiradi
    out.push({ text: t, opts: order.map(i => opts[i]), correct: order.indexOf(c) });
  }
  return out.slice(0, n);
}
const AI_SCHEMA = { type: 'OBJECT', properties: { questions: { type: 'ARRAY', items: { type: 'OBJECT',
  properties: { text: { type: 'STRING' }, opts: { type: 'ARRAY', items: { type: 'STRING' } }, correct: { type: 'INTEGER' } }, required: ['text', 'opts', 'correct'] } } }, required: ['questions'] };
// level 0: sxema + thinking o'chiq (eng tez va ishonchli) · 1: faqat sxema · 2: oddiy JSON (eski modellar uchun)
function aiCfg(level, n) {
  const cfg = { responseMimeType: 'application/json', maxOutputTokens: Math.min(30000, 2000 + n * 450), temperature: 1 };
  if (level <= 1) cfg.responseSchema = AI_SCHEMA;
  if (level === 0) cfg.thinkingConfig = { thinkingBudget: 0 };
  return cfg;
}
const aiErrText = (status, msg) => {
  msg = String(msg || '');
  if (/api key|API_KEY|credential/i.test(msg) || status === 401) return 'Gemini API kaliti noto\'g\'ri yoki o\'chirilgan. .env faylidagi GEMINI_API_KEY ni tekshiring.';
  if (status === 403) return 'Gemini bu kalit uchun ruxsat bermadi (403). Kalit yoqilganini / hudud cheklovini tekshiring.';
  if (status === 429) return 'Gemini bepul limiti tugadi (429). Bir oz kutib qayta urinib ko\'ring.';
  if (status === 503 || status === 500) return 'Gemini hozir band (' + status + '). Birozdan keyin qayta urinib ko\'ring.';
  return 'AI xizmati xato qaytardi (' + status + ')' + (msg ? ': ' + msg.slice(0, 140) : '');
};
async function aiCall(model, prompt, signal, level, n) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': AI_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: aiCfg(level, n) }),
  });
  if (!r.ok) {
    let msg = ''; try { msg = ((await r.json()).error || {}).message || ''; } catch {}
    console.error(`[AI] ${model} level=${level} -> ${r.status}: ${msg.slice(0, 200)}`);
    const e = new Error(aiErrText(r.status, msg)); e.status = r.status;
    e.badKey = r.status === 401 || r.status === 403 || (r.status === 400 && /api key|API_KEY/i.test(msg));
    throw e;
  }
  const d = await r.json();
  const cand = (d.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
  if (!text) { const e = new Error('AI bo\'sh javob berdi' + (d.promptFeedback && d.promptFeedback.blockReason ? ' (' + d.promptFeedback.blockReason + ')' : '')); e.status = 0; throw e; }
  return text;
}
// Kalit uchun mavjud modellar ro'yxatidan mos "flash" modelni topadi (model nomi eskirgan bo'lsa)
async function aiDiscoverModels(signal) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { signal, headers: { 'x-goog-api-key': AI_KEY } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini-[\d.]+-flash(?!.*(image|tts|live|audio|thinking|lite))/i.test(m.name))
    .map(m => m.name.replace(/^models\//, '')).sort().reverse();
}
async function aiMakeChunk(topic, level, n, lang, part) {
  let last = null, best = [], discovered = false;
  const t0 = Date.now();
  const queue = [...new Set([aiGoodModel, ...AI_MODELS].filter(Boolean))];
  const lvl = new Map();                                                   // model -> hozirgi "soddalashtirish" darajasi
  for (let attempt = 0; attempt < 8 && queue.length; attempt++) {
    const left = AI_TOTAL_MS - (Date.now() - t0);
    if (left < 4000) break;
    const model = queue.shift(), L = lvl.get(model) || 0;
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), Math.min(AI_TIMEOUT_MS, left, 12000 + n * 1500));   // osilib qolgan so'rov tez almashtiriladi
    try {
      const text = await aiCall(model, aiPrompt(topic, level, n, lang, part), ctl.signal, L, n);
      const qs = aiParse(text, n);
      if (qs.length >= n) { aiGoodModel = model; return qs; }
      if (qs.length > best.length) best = qs;
      last = new Error(`AI faqat ${qs.length} ta yaroqli savol berdi`);
      if (attempt < 2) queue.unshift(model);                                // bir marta qayta urinamiz
      else break;
    } catch (e) {
      last = e.name === 'AbortError' ? new Error('AI javob bermadi (vaqt tugadi)') : e;
      if (e.badKey) break;                                                  // kalit xato: qayta urinish befoyda
      if (e.status === 400 && L < 2) { lvl.set(model, L + 1); queue.unshift(model); }   // model sxema/thinking'ni qabul qilmadi: soddaroq so'rov
      else if (e.status === 404 || e.status === 400) {
        if (aiGoodModel === model) aiGoodModel = '';
        if (e.status === 404) console.error('[AI] model topilmadi:', model);
        if (!queue.length && !discovered) {                                 // nomlar eskirgan bo'lishi mumkin: mavjudlarini so'raymiz
          discovered = true;
          try { queue.push(...(await aiDiscoverModels(ctl.signal)).slice(0, 4)); } catch {}
        }
      } else if (e.status === 429 || e.status === 503 || e.status === 500) {
        if (aiGoodModel === model) aiGoodModel = '';                        // keyingi modelga o'tamiz (har birining limiti alohida)
      }
    } finally { clearTimeout(to); }
  }
  if (best.length >= 3) return best;
  throw last || new Error('AI savol tuza olmadi');
}
// Tezlik: savollar bir nechta kichik bo'lakka bo'linib, Gemini'ga PARALLEL so'raladi (kam savol = tez javob).
const AI_CHUNK = 12;                                       // bitta so'rovdagi savollar (taxminan)
const AI_MAX_CHUNKS = 3;                                   // limitni tejash: 12 tagacha savol = 1 so'rov, 30 tagacha = 3 so'rov
const AI_WARM = process.env.AI_WARM !== '0';              // AI_WARM=0 — oldindan tayyorlashni butunlay o'chiradi
async function aiMakeQuestions(topic, level, n, lang) {
  const k = Math.min(AI_MAX_CHUNKS, Math.max(1, Math.ceil(n / AI_CHUNK)));
  if (k === 1) return aiMakeChunk(topic, level, n, lang, null);
  const sizes = Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
  const pool = shuffle(AI_TOPICS); let at = 0;
  const jobs = sizes.map((sz, i) => {
    const tp = []; for (let j = 0; j < sz; j++) tp.push(pool[(at++) % pool.length]);
    return aiMakeChunk(topic, level, sz + 1, lang, { i, k, topics: tp }).catch(e => { console.error('[AI] bo\'lak xatosi:', e && e.message); return { err: e }; });
  });
  const res = await Promise.all(jobs);
  const out = [], seen = new Set();
  const add = list => { for (const q of list) { const key = q.text.toLowerCase(); if (!seen.has(key)) { seen.add(key); out.push(q); } } };
  const errs = res.filter(r => r && r.err).map(r => r.err);
  res.forEach(r => { if (Array.isArray(r)) add(r); });
  if (out.length < n && errs.length < res.length) {                       // yetishmaganini bitta qo'shimcha so'rov bilan to'ldiramiz
    try { add(await aiMakeChunk(topic, level, Math.min(n - out.length + 2, 10), lang, null)); } catch (e) { errs.push(e); }
  }
  if (out.length >= 3) return shuffle(out).slice(0, n);
  throw errs[0] || new Error('AI savol tuza olmadi');
}
// ---- Oldindan tayyorlash: Transmitter AI Quiz bo'limini ochgach savollar fonda tayyorlanadi, "Boshlash" bosilganda darhol chiqadi
const aiPool = new Map();                                  // kalit -> { qs: [], t, filling }
const AI_POOL_TTL = 30 * 60 * 1000;
const aiKeyOf = (topic, level, lang) => `${lang}|${level}|${topic.toLowerCase()}`;
function aiPoolTake(key, n) {
  const e = aiPool.get(key);
  if (!e || Date.now() - e.t > AI_POOL_TTL || e.qs.length < n) return null;
  return e.qs.splice(0, n);
}
async function aiPoolFill(key, topic, level, lang, n) {
  if (!AI_KEY) return 0;
  let e = aiPool.get(key);
  if (!e) { e = { qs: [], t: 0, filling: false }; aiPool.set(key, e); }
  if (Date.now() - e.t > AI_POOL_TTL) e.qs = [];
  if (e.filling || e.qs.length >= n || aiActive >= AI_MAX_PARALLEL) return e.qs.length;
  e.filling = true; aiActive++;
  try {
    const qs = await aiMakeQuestions(topic, level, n - e.qs.length, lang);
    const seen = new Set(e.qs.map(q => q.text.toLowerCase()));
    qs.forEach(q => { if (!seen.has(q.text.toLowerCase())) e.qs.push(q); });
    e.t = Date.now();
  } catch (err) { console.error('[AI] oldindan tayyorlash xatosi:', err && err.message); }
  finally { e.filling = false; aiActive--; }
  while (aiPool.size > 12) aiPool.delete(aiPool.keys().next().value);      // xotira cheklovi
  return e.qs.length;
}
function aiParams(m) {
  const topic = String(m.topic || '').replace(/[\r\n"]+/g, ' ').trim().slice(0, 120);
  const lang = Object.prototype.hasOwnProperty.call(AI_LANGS, m.lang) ? m.lang : '';
  const level = Object.prototype.hasOwnProperty.call(AI_LEVELS, m.level) ? m.level : 'mix';
  const time = clampN(Math.round(Number(m.time) || 15), 8, 60);
  const count = clampN(Math.round(Number(m.count) || AI_COUNT), AI_MIN, AI_MAX);
  return { topic, lang, level, time, count };
}
async function quizAiWarm(room, ws, m) {
  const reply = o => send(ws, Object.assign({ type: 'quiz-ai-warm' }, o));
  if (!AI_KEY || room.quiz || room.aiBusy) return;
  if (!AI_WARM || (room.warmNext || 0) > Date.now()) return;
  room.warmNext = Date.now() + 30000;
  const { topic, lang, level, count } = aiParams(m);
  const key = aiKeyOf(topic, level, lang);
  const have = await aiPoolFill(key, topic, level, lang, count);
  reply({ ready: have >= count, n: have });
}
async function quizAiStart(room, ws, m) {
  const reply = o => send(ws, Object.assign({ type: 'quiz-ai' }, o));
  if (!AI_KEY) return reply({ busy: false, error: 'AI sozlanmagan: serverda GEMINI_API_KEY o\'rnatilmagan.' });
  if (room.aiBusy) return reply({ busy: true });
  const wait = (room.aiNext || 0) - Date.now();
  if (wait > 0) return reply({ busy: false, error: `Biroz kuting (${Math.ceil(wait / 1000)} s) va qayta bosing.` });
  if (aiActive >= AI_MAX_PARALLEL) return reply({ busy: false, error: 'AI hozir band. Bir necha soniyadan keyin urinib ko\'ring.' });
  const { topic, lang, level, time, count } = aiParams(m);
  const key = aiKeyOf(topic, level, lang);
  room.aiBusy = true; aiActive++; room.aiNext = Date.now() + 5000;
  reply({ busy: true });
  try {
    let qs = aiPoolTake(key, count), cached = !!qs;                          // tayyor bo'lsa — darhol
    if (!qs) {
      const e = aiPool.get(key);
      if (e && e.filling) { const t0 = Date.now(); while (e.filling && Date.now() - t0 < AI_TOTAL_MS) await new Promise(r => setTimeout(r, 150)); qs = aiPoolTake(key, count); cached = !!qs; }   // fonda tayyorlanmoqda: shuni kutamiz
      if (!qs) qs = await aiMakeQuestions(topic, level, count, lang);
    }
    if (rooms.get(room.code) !== room || !room.host) return;
    const r = sanitizeQuiz(room, { title: topic ? `🤝 Do'stlar poygasi: ${topic}` : '🤝 Do\'stlar poygasi', questions: qs.map(q => ({ ...q, time, pts: 'std' })) });
    if (r.error) throw new Error(r.error);
    startQuiz(room, r, { hideOpts: !!m.hideOpts, hideQ: !!m.hideQ, celebrate: m.celebrate !== false, stickers: m.stickers !== false, auto: m.auto !== false, mode: 'friend' });
    reply({ busy: false, ok: true });
  } catch (e) {
    console.error('AI viktorina xatosi:', e && e.message);
    reply({ busy: false, error: (e && e.message) || 'AI savol tuza olmadi' });
  } finally { room.aiBusy = false; aiActive--; }
}
function startQuiz(room, r, o) {
  if (room.quiz) clearTimeout(room.quiz.timer);
  room.quiz = { id: crypto.randomBytes(4).toString('hex'), title: r.title, questions: r.questions, hideOpts: !!o.hideOpts, hideQ: !!o.hideQ, celebrate: o.celebrate !== false,
    stickers: o.stickers !== false, auto: !!o.auto, mode: o.mode || 'std', idx: -1, phase: 'lobby', players: new Map(), answers: new Map(), startAt: 0, endAt: 0, timer: null };
  room.clients.forEach(c => quizPlayer(room, c));
  broadcastQuiz(room);
  room.quizDirty = true;
}
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
  return [...qz.players.entries()].map(([tok, p]) => ({ tok, name: p.name, av: p.av, score: p.score, delta: p.last ? p.last.delta : 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
// forHost=false: receiverga yuboriladigan nusxa. "Faqat savol" rejimida (hideOpts) variantlar matni savol paytida
// receiverga UMUMAN yuborilmaydi (brauzer/DevTools/nusxa orqali ham ko'rib bo'lmaydi) — faqat variantlar soni va rangi.
function quizPub(room, forHost = true) {
  const qz = room.quiz;
  if (!qz) return null;
  const q = qz.questions[qz.idx];
  const pub = { id: qz.id, title: qz.title, phase: qz.phase, idx: qz.idx, total: qz.questions.length, players: qz.players.size, startAt: qz.startAt, endAt: qz.endAt, hideOpts: !!qz.hideOpts, hideQ: !!qz.hideQ, celebrate: qz.celebrate !== false, stickers: qz.stickers !== false, auto: !!qz.auto, mode: qz.mode || 'std' };
  if (q && (qz.phase === 'question' || qz.phase === 'reveal')) {
    const hide = !forHost && qz.hideOpts && qz.phase === 'question';
    const hideQ = !forHost && qz.hideQ && qz.phase === 'question';       // savol matni (va rasmi) ham receiverga yuborilmaydi
    pub.q = { text: hideQ ? '' : q.text, img: hideQ ? null : q.img, opts: hide ? q.opts.map(() => '') : q.opts, time: q.time, pts: q.pts };
  }
  const noAv = t => (qz.stickers === false && t ? t.map(x => ({ ...x, av: '' })) : t);
  if (qz.phase === 'reveal') { pub.correct = q.correct; pub.counts = qz.counts; pub.top = noAv(qz.top); }
  if (qz.phase === 'final') pub.top = noAv(qz.top);
  return pub;
}
// host va receiverlarga alohida (har biri BIR marta JSON'ga aylantiriladi)
function broadcastQuiz(room) {
  if (!room.quiz) return broadcast(room, { type: 'quiz', quiz: null });
  send(room.host, { type: 'quiz', quiz: quizPub(room, true) });
  sendAll(room.clients, { type: 'quiz', quiz: quizPub(room, false) });
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
  if (!p) { p = { name: ws.ctx.name, av: ws.ctx.av, score: 0, streak: 0, last: null }; qz.players.set(tok, p); room.quizDirty = true; }
  else if (p.av && ws.ctx.av !== p.av) ws.ctx.av = p.av;       // qayta ulanganda tanlangan hayvonchasi saqlanadi
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
  broadcastQuiz(room);
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
  qz.top = quizRanking(qz).slice(0, 5).map(r => ({ name: r.name, av: r.av, score: r.score, delta: r.delta }));
  broadcastQuiz(room);
  quizSendMe(room);
  quizAutoNext(room);
}
const QUIZ_AUTO_MS = 8000;                                  // avtomatik rejimda reyting ko'rsatilish vaqti
function quizAutoNext(room) {
  const qz = room.quiz;
  if (!qz || !qz.auto || qz.phase !== 'reveal') return;
  clearTimeout(qz.timer);
  qz.timer = setTimeout(() => { if (room.quiz === qz && qz.phase === 'reveal' && qz.auto) quizNext(room); }, QUIZ_AUTO_MS);
}
function quizFinal(room) {
  const qz = room.quiz;
  clearTimeout(qz.timer);
  qz.phase = 'final';
  qz.top = quizRanking(qz).slice(0, 10).map(r => ({ name: r.name, av: r.av, score: r.score, delta: 0 }));
  broadcastQuiz(room);
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
    list: clients.slice(0, 300).map(c => ({ id: c.ctx.id, name: c.ctx.name, av: c.ctx.av, ready: !!c.ctx.ready, muted: !!c.ctx.muted, stat: c.ctx.stat || null, via: c.ctx.parent || null })),
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
  const audioOnly = !(room.live && room.live.screen);              // faqat ovoz (64 kbps): Transmitter ko'proq qurilmaga o'zi uzata oladi
  if (hostKids < (audioOnly ? 24 : HOST_FANOUT)) return 'host';
  let best = null, bs = 1e9;
  room.clients.forEach(x => {
    if (x === c || !x.ctx.canRelay || !x.ctx.streamReady || x.ctx.children.size >= RELAY_FANOUT || isDescendant(room, x, c)) return;
    const score = depthOf(room, x) * 10 + x.ctx.children.size - (x.ctx.stat ? x.ctx.stat.q : 0);   // sayoz, bo'sh va tarmog'i yaxshi relay afzal
    if (score < bs) { bs = score; best = x; }
  });
  if (best) return best.ctx.id;
  return hostKids < (audioOnly ? 36 : HOST_MAX) ? 'host' : null;
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
  if (len > MAX_BYTES) return res.status(413).json({ error: `Fayl ${fmtLimit(MAX_MB)} dan katta` });
  try {                                                    // diskda joy yetarlimi (katta fayllar uchun)
    const st = fs.statfsSync(UPLOAD_DIR);
    const free = Number(st.bavail) * Number(st.bsize);
    if (len && free < len + 256 * 1024 * 1024) return res.status(507).json({ error: 'Serverda diskda joy yetarli emas' });
  } catch {}

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
      if (!res.headersSent) res.status(err.message === 'LIMIT' ? 413 : err.code === 'ENOSPC' ? 507 : 500).json({ error: err.message === 'LIMIT' ? `Fayl ${fmtLimit(MAX_MB)} dan katta` : err.code === 'ENOSPC' ? 'Serverda diskda joy qolmadi' : 'Yuklashda xato' });
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
// Katta (GB) fayllar sekin tarmoqda bir necha daqiqa yuklanadi: standart 5 daqiqalik so'rov taymauti o'chiriladi
server.requestTimeout = 0;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 75 * 1000;
server.timeout = 0;
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
    if (m.type === 'quiz-avatar' && ctx.role === 'receiver') {
      if (!AVATARS.includes(m.av)) return;
      ctx.av = m.av;
      if (room.quiz) { const p = room.quiz.players.get(ctx.tok); if (p) p.av = m.av; }
      sendMembers(room);
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
        startQuiz(room, r, { hideOpts: m.hideOpts, hideQ: m.hideQ, celebrate: m.celebrate !== false, stickers: m.stickers !== false, auto: !!m.auto });
        break;
      }
      case 'quiz-ai': quizAiStart(room, ws, m); break;
      case 'quiz-ai-warm': quizAiWarm(room, ws, m); break;           // "Do'st bilan do'st": AI tanlangan miqdorda tasodifiy savol tuzadi
      case 'quiz-flag':                                    // Transmitter: o'yin paytida ham almashtiriladi
        if (room.quiz && ['hideOpts', 'hideQ', 'celebrate', 'stickers', 'auto'].includes(m.k) && typeof m.v === 'boolean' && room.quiz[m.k] !== m.v) {
          room.quiz[m.k] = m.v;
          if (m.k === 'auto' && room.quiz.phase === 'reveal') { if (m.v) quizAutoNext(room); else clearTimeout(room.quiz.timer); }
          broadcastQuiz(room);
        }
        break;
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
  if (!isHost && !String(m.name || '').trim()) {
    send(ws, { type: 'error', code: 'NO_NAME', message: 'Ismingizni kiriting — ism majburiy' });
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
    name: String(m.name || '').replace(/\s+/g, ' ').slice(0, 24).trim() || (isHost ? 'Transmitter' : 'Receiver'),
    ready: false, muted: false,
    canRelay: !isHost && !!m.relay, parent: null, children: new Set(), streamReady: false,
  };
  ws.ctx.tok = issueToken(room, ws.ctx.role, m.tok && String(m.tok));
  ws.ctx.av = AVATARS.includes(m.av) ? m.av : pickAvatar();
  if (isHost) {
    if (room.host && room.host !== ws) { try { room.host.close(); } catch {} }
    room.host = ws;
  } else {
    room.clients.add(ws);
  }
  room.lastSeen = Date.now();
  send(ws, {
    type: 'joined', role: ws.ctx.role, av: ws.ctx.av, code: room.code, items: room.items, state: room.state,
    cfg: room.cfg, live: room.live, poll: pollPub(room.poll), myVote: room.poll ? room.poll.voted.get(ws.ctx.tok) : undefined, myId: ws.ctx.id, tok: ws.ctx.tok, serverNow: Date.now(),
  });
  if (isHost) sendAll(room.clients, { type: 'live', live: room.live, resync: true });
  if (room.quiz) {
    if (!isHost) quizPlayer(room, ws);
    const a = room.quiz.answers.get(ws.ctx.tok);
    send(ws, { type: 'quiz-state', av: ws.ctx.av, quiz: quizPub(room, isHost), me: quizMe(room, ws.ctx.tok), myAnswer: a ? a.i : null });
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
