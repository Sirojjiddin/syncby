(() => {
'use strict';

const $ = s => document.querySelector(s);
const pMain = $('#player');          // WebAudio grafigiga ulangan asosiy pleyer
const pExt = $('#playerExt');        // tashqi havolalar uchun (CORS bo'lmasa grafikka ulab bo'lmaydi)
const castVideo = $('#castVideo');
const stage = $('#stage');
let player = pMain;
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }], iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
const MAX_PEERS = 40;                // Transmitter bir vaqtda nechta receiverga to'g'ridan-to'g'ri efir uzata oladi

const KINDS = {
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'],
  pdf: ['pdf'],
  text: ['txt', 'csv', 'md'],
  doc: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp'],
};
const ICON = { youtube: '▶️', audio: '🎵', video: '🎬', image: '🖼️', pdf: '📕', text: '📝', doc: '📄' };
const kindOfName = n => {
  const e = (n.split('.').pop() || '').toLowerCase();
  for (const k in KINDS) if (KINDS[k].includes(e)) return k;
  return null;
};
const isMedia = k => k === 'audio' || k === 'video' || k === 'youtube';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const defaultCfg = () => ({ approve: false, allowChat: true, allowChatQuiz: true, allowReact: true, waitAll: true, allowView: true, allowDownload: true, guard: true, muteAll: false, volume: 100, lockVolume: true, normalize: true, duck: true, locked: false, phoneOnly: false, pcApprove: false, loop: 'off', listed: true });

// ------------------------------------------------------------ holat
const S = {
  role: null, code: null, key: null, name: '', tok: null, myId: null, myMuted: false,
  items: [], st: null, joined: false, cfg: defaultCfg(), live: { mic: null, screen: null },
  members: { total: 0, ready: 0, list: [], hostOnline: true },
  drift: null, rtt: null, localVol: 1, waiting: 0, parentId: null, hops: 1, sink: null, poll: null, myVote: null, pollId: null, syncMs: Number(localStorage.getItem('sc_sync')) || 0,
};
let ws = null, wantOpen = false, reconnectT = null;
let offset = 0, firstOffset = true, samples = [];
let startTimer = null, driftTimer = null, lastHard = 0, startedAt = 0, earlySeeks = 0;
let loadedId = null, readySent = false, viewerId = null, lastSig = null;
let wakeLock = null, currentView = null, baseKind = 'none';
const blobs = new Map();

const isHost = () => S.role === 'host';
const sNow = () => Date.now() + offset;
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
// ---- Qurilma ma'lumoti (receiver qo'shilganda Transmitterga yuboriladi): tur, model, tizim, brauzer
function baseDevice() {
  const ua = navigator.userAgent || '', uad = navigator.userAgentData;
  let os = '';
  if (/Windows/i.test(ua)) os = 'Windows'; else if (/Android/i.test(ua)) os = 'Android'; else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = navigator.maxTouchPoints > 1 ? 'iPadOS' : 'macOS'; else if (/CrOS/.test(ua)) os = 'ChromeOS'; else if (/Linux/i.test(ua)) os = 'Linux';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Browser' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const mobile = uad && typeof uad.mobile === 'boolean' ? uad.mobile : /Mobi|iPhone|iPod/.test(ua);
  let k = 'pc', model = '';
  if (os === 'iPadOS' || /iPad/.test(ua)) { k = 'tablet'; model = 'iPad'; }
  else if (/iPhone|iPod/.test(ua)) { k = 'phone'; model = 'iPhone'; }
  else if (os === 'Android') {
    k = mobile || /Mobile/.test(ua) ? 'phone' : 'tablet';
    const mm = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|[;)])/.exec(ua);
    if (mm && mm[1] && !/^(K|Linux|Android)$/i.test(mm[1].trim())) model = mm[1].trim();
  } else if (/SmartTV|Tizen|Web0S|HbbTV|BRAVIA/i.test(ua)) k = 'tv';
  else if (os === 'macOS') model = 'Mac';
  return { k, os, br, model };
}
async function detectDevice() {
  const d = baseDevice();
  try { const uad = navigator.userAgentData; if (uad && uad.getHighEntropyValues) { const h = await uad.getHighEntropyValues(['model']); if (h && h.model) d.model = h.model; } } catch {}
  return d;
}
S.dev = baseDevice(); detectDevice().then(d => { S.dev = d; }).catch(() => {});
const DEVK = { phone: ['📱', 'Telefon'], tablet: ['📱', 'Planshet'], pc: ['💻', 'Noutbuk/kompyuter'], tv: ['📺', 'TV'], other: ['🖥', 'Qurilma'] };
function devLabel(d) {
  if (!d) return '';
  const [ic, nm] = DEVK[d.k] || DEVK.other;
  return (d.k === 'pc' ? '⚠ ' : '') + [ic + ' ' + nm, d.model, d.os, d.br].filter(Boolean).join(' · ');
}
const srcOf = (it, dl) => {
  if (it.cid && blobs.get(it.cid)) return blobs.get(it.cid);
  if (it.external) return it.url;
  return `${it.url}?t=${encodeURIComponent(S.tok || '')}${dl ? '&dl=1' : ''}`;
};
const canView = () => isHost() || S.cfg.allowView;
const canDl = () => isHost() || S.cfg.allowDownload;

// ------------------------------------------------------------ yordamchilar
const fmtTime = t => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};
const fmtSize = b => (b ? (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB') : 'havola');
const fmtLimit = mb => (mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB' : mb + ' MB');

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function showView(id) {
  document.body.classList.toggle('home-on', id === 'home');
  ['home', 'join', 'hostNew', 'host', 'recv'].forEach(v => { $('#' + v).hidden = v !== id; });
  const slot = id === 'host' ? $('#hSlot') : id === 'recv' ? $('#rSlot') : null;
  if (slot) { if (stage.parentNode !== slot) slot.appendChild(stage); stage.hidden = false; }
  else { if (stage.parentNode !== document.body) document.body.appendChild(stage); stage.hidden = true; }
  $('#fnBtn').hidden = id !== 'host';
  $('#memChip').hidden = id !== 'host' && id !== 'recv';
  if (id !== 'host') openDrawer(false);
  if (currentView !== id) window.scrollTo(0, 0);
  currentView = id;
  try { if (id === 'join') ROOMS.start(); else ROOMS.stop(); } catch {}
}

// ---- Tarmoq holati (yuqori panel): ping, jitter, paket yo'qotish, sinxron farqi, bufer, efir statistikasi
const NET = { conn: '', bad: false, rtt: null, jitter: 0, loss: 0, q: 0, cast: null };
const qLabel = q => ['Aloqa yo\'q', 'Yomon', 'O\'rtacha', 'Yaxshi', 'A\'lo'][q] || '—';
const qCls = q => (q >= 3 ? 'ok' : q === 2 ? 'warn' : 'bad');
const qBars = q => ['✖', '▂', '▂▄', '▂▄▆', '▂▄▆█'][q] || '';
function qualityOf(rtt, jit, loss) {
  if (rtt == null) return 0;
  if (rtt < 60 && jit < 15 && loss < 1) return 4;
  if (rtt < 120 && jit < 35 && loss < 3) return 3;
  if (rtt < 250 && jit < 80 && loss < 8) return 2;
  return 1;
}
function setNet(text, bad) { NET.conn = text || ''; NET.bad = !!bad; if (!text) { NET.rtt = null; NET.q = 0; NET.cast = null; } renderNet(); }
function renderNet() {
  const box = $('#netBox');
  box.hidden = !NET.conn;
  if (box.hidden) { $('#netPanel').hidden = true; return; }
  const q = NET.bad ? 0 : NET.q;
  box.dataset.q = q;
  $('#netTxt').textContent = NET.bad ? NET.conn : (NET.rtt == null ? '…' : Math.round(NET.rtt) + ' ms');
  if ($('#netPanel').hidden) return;
  const rows = [['Holat', NET.bad ? NET.conn : qLabel(q), qCls(q)]];
  if (NET.rtt != null) {
    rows.push(['Ping', Math.round(NET.rtt) + ' ms', NET.rtt < 120 ? 'ok' : NET.rtt < 250 ? 'warn' : 'bad']);
    rows.push(['Jitter', Math.round(NET.jitter) + ' ms', NET.jitter < 35 ? 'ok' : NET.jitter < 80 ? 'warn' : 'bad']);
    rows.push(['Paket yo\'qotish', Math.round(NET.loss) + ' %', NET.loss < 3 ? 'ok' : NET.loss < 8 ? 'warn' : 'bad']);
  }
  if (S.st && S.st.playing && S.drift != null) rows.push(['Sinxron farqi', Math.round(S.drift * 1000) + ' ms', Math.abs(S.drift) < 0.05 ? 'ok' : 'warn']);
  if (S.joined && currentItem() && isMedia(currentItem().kind) && !isYt()) rows.push(['Bufer', bufAhead().toFixed(1) + ' s', bufAhead() > 3 ? 'ok' : 'warn']);
  if (!isHost() && S.parentId && S.live && (S.live.mic || S.live.screen)) rows.push(['Efir yo\'li', S.parentId === 'host' ? 'Transmitter → siz' : `Transmitter → … → siz (${S.hops} bosqich)`]);
  if (NET.cast) rows.push(['Ekran efiri', `${NET.cast.w}×${NET.cast.h} · ${NET.cast.fps} fps · ${NET.cast.kbps} kbit/s`]);
  if (isHost() && peers.size) {
    let sum = 0; peers.forEach(p => { sum += p.cur; });
    rows.push(['Efir tinglovchilari', `${peers.size} · ~${Math.round(sum / peers.size / 1000)} kbit/s`]);
  }
  const p = $('#netPanel');
  p.textContent = '';
  const h = document.createElement('h4'); h.textContent = '📶 Tarmoq holati'; p.appendChild(h);
  rows.forEach(([k, v, c]) => {
    const r = document.createElement('div'); r.className = 'row';
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('span'); b.textContent = v; if (c) b.className = c;
    r.append(a, b); p.appendChild(r);
  });
}
$('#netBox').onclick = e => { e.stopPropagation(); $('#netPanel').hidden = !$('#netPanel').hidden; renderNet(); };
document.addEventListener('click', e => { if (!e.target.closest('.netwrap')) $('#netPanel').hidden = true; });
setInterval(() => { if (!$('#netPanel').hidden) renderNet(); }, 1000);

// ------------------------------------------------------------ AUDIO MOTORI: ovozni 1:1 tenglashtirish
// Musiqa balandligi FAYLNING o'zidan bir marta o'lchanadi (LUFS, ITU-R BS.1770: K-vaznli, gate'li) va hisoblangan
// tuzatma (gainDb) serverga yuboriladi, server uni hamma qurilmaga bir xil tarqatadi. Har qurilma aynan shu statik
// kuchaytirishni qo'llaydi => Transmitterda ham, receiverlarda ham signal balandligi bir xil.
// (Qurilmalarda alohida "avto-balandlik" ataylab yo'q: u qurilmalarni bir-biridan ajratib yuborar edi.)
const TARGET_LUFS = -16;
let actx = null, master = null, limiter = null, duckGain = null, itemGain = null, voiceGain = null, castGain = null, musicSrc = null, quizDuck = null;
const normByCid = new Map();
const clampGain = g => clamp(Math.round(g * 10) / 10, -18, 15);

// energiyalar (o'rtacha kvadrat) ro'yxatidan "gated" LUFS: 400 ms bloklar, -70 LUFS mutlaq va -10 LU nisbiy darvoza
function gatedLufs(energies, blockLen) {
  const blocks = [];
  for (let i = 0; i + blockLen <= energies.length; i++) {
    let s = 0; for (let j = 0; j < blockLen; j++) s += energies[i + j];
    blocks.push(s / blockLen);
  }
  const lu = e => -0.691 + 10 * Math.log10(e);
  const a = blocks.filter(e => e > 0 && lu(e) > -70);
  if (!a.length) return null;
  const thr = lu(a.reduce((x, y) => x + y, 0) / a.length) - 10;
  const b = a.filter(e => lu(e) > thr);
  if (!b.length) return null;
  return lu(b.reduce((x, y) => x + y, 0) / b.length);
}

// Yuklangan faylni oldindan tahlil qilish (Transmitterda, ijro boshlanishidan oldin)
async function analyzeLoudness(file) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC || file.size > 16 * 1024 * 1024 || !/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(file.name)) return null;    // video fayl: butun faylni dekodlash asosiy oqimni qotiradi — jonli o'lchash ishlaydi       // katta fayllar: jonli o'lchash ishlaydi
  const SR = 22050;
  const buf = await file.arrayBuffer();
  const ab = await new OAC(1, 1, SR).decodeAudioData(buf);
  let peak = 0;
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
  if (peak < 1e-4) return null;
  const ch = Math.min(2, ab.numberOfChannels);
  const off = new OAC(ch, ab.length, ab.sampleRate);
  const src = off.createBufferSource(); src.buffer = ab;
  const shelf = off.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1681; shelf.gain.value = 4;      // K-vazn (1-bosqich)
  const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;                       // K-vazn (2-bosqich)
  src.connect(shelf); shelf.connect(hp); hp.connect(off.destination); src.start();
  const out = await off.startRendering();
  const seg = Math.round(out.sampleRate * 0.1), energies = [];
  for (let st = 0; st + seg <= out.length; st += seg) {
    let e = 0;
    for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); let s = 0; for (let i = st; i < st + seg; i++) s += d[i] * d[i]; e += s / seg; }
    energies.push(e);
  }
  const lufs = gatedLufs(energies, 4);
  if (lufs == null) return null;
  const peakCap = -20 * Math.log10(peak) + 2;                    // limiterga haddan tashqari yuk tushmasin
  return clampGain(Math.min(TARGET_LUFS - lufs, peakCap));
}
let analyzeChain = Promise.resolve();
function analyzeLater(cid, file) {
  analyzeChain = analyzeChain.then(() => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 4000 }) : setTimeout(r, 300)))).then(() => analyzeLoudness(file)).then(db => {
    if (db == null) return;
    normByCid.set(cid, db); flushNorm();
  }).catch(() => {});
}
function flushNorm() {
  if (!isHost()) return;
  S.items.forEach(it => {
    if (it.cid && it.gainDb == null && normByCid.has(it.cid)) { send({ type: 'norm', id: it.id, gainDb: normByCid.get(it.cid) }); normByCid.delete(it.cid); }
  });
}

function ensureAudio() {
  if (actx) return actx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { actx = new AC({ latencyHint: 'playback' }); } catch { actx = null; return null; }
  master = actx.createGain();
  if (S.sink && actx.setSinkId) actx.setSinkId(S.sink.id).catch(() => {});
  limiter = actx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 3; limiter.ratio.value = 20;       // yumshoq limiter: zarba/"nasos" (pumping) va buzilish yo'q
  limiter.attack.value = 0.003; limiter.release.value = 0.25;
  master.connect(limiter); limiter.connect(actx.destination);
  duckGain = actx.createGain(); duckGain.connect(master);
  quizDuck = actx.createGain(); quizDuck.connect(duckGain);                              // viktorina ovozlari paytida musiqani pasaytirish
  itemGain = actx.createGain(); itemGain.connect(quizDuck);
  voiceGain = actx.createGain(); voiceGain.connect(master);
  castGain = actx.createGain(); castGain.connect(master);
  try { musicSrc = actx.createMediaElementSource(pMain); const hpf = actx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 30; hpf.Q.value = 0.707; musicSrc.connect(hpf); hpf.connect(itemGain); buildMeter(); } catch { musicSrc = null; }   // 30 Hz filtr: past chastotali gulduros/DC yo'q
  return actx;
}

// Zaxira: fayl oldindan tahlil qilinmagan bo'lsa (katta fayl), Transmitter ijro paytida ~8 soniya o'lchaydi
function buildMeter() {
  const shelf = actx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1681; shelf.gain.value = 4;
  const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
  const sp = actx.createChannelSplitter(2);
  const aL = actx.createAnalyser(), aR = actx.createAnalyser(); aL.fftSize = 2048; aR.fftSize = 2048;
  musicSrc.connect(shelf); shelf.connect(hp); hp.connect(sp); sp.connect(aL, 0); sp.connect(aR, 1);
  const bl = new Float32Array(2048), br = new Float32Array(2048);
  let id = null, samples = [];
  setInterval(() => {
    if (!isHost() || !S.joined || !S.st || actx.state !== 'running') return;
    const it = currentItem();
    if (!it || !isMedia(it.kind) || it.gainDb != null || !S.st.playing || player !== pMain || player.paused) { if (!it || it.id !== id) { id = it && it.id; samples = []; } return; }
    if (id !== it.id) { id = it.id; samples = []; }
    aL.getFloatTimeDomainData(bl); aR.getFloatTimeDomainData(br);
    let e = 0; for (let i = 0; i < bl.length; i++) e += bl[i] * bl[i] + br[i] * br[i];
    samples.push(e / bl.length);
    if (samples.length >= 80) {
      const lufs = gatedLufs(samples, 4);
      samples = [];
      if (lufs != null) send({ type: 'norm', id: it.id, gainDb: clampGain(TARGET_LUFS - lufs) });
    }
  }, 100);
}

function itemTargetGain() {
  const it = currentItem();
  return S.cfg.normalize && it && isMedia(it.kind) && it.gainDb != null ? Math.pow(10, it.gainDb / 20) : 1;
}
function applyItemGain(immediate) {
  const it = currentItem();
  const has = it && isMedia(it.kind) && it.gainDb != null;
  if (actx && itemGain) {
    const v = itemTargetGain();
    if (immediate) { itemGain.gain.cancelScheduledValues(actx.currentTime); itemGain.gain.setValueAtTime(v, actx.currentTime); }
    else itemGain.gain.setTargetAtTime(v, actx.currentTime, 0.35);          // sekin o'zgarish: balandlik "sakramaydi"
  }
  const g = $('#hGain');
  if (g) {
    g.hidden = !(isHost() && it && isMedia(it.kind) && it.kind !== 'youtube');
    g.textContent = has ? `🎚 ${it.gainDb > 0 ? '+' : ''}${it.gainDb.toFixed(1)} dB` : '🎚 o\'lchanmoqda…';
  }
}

function effGain() {
  const c = S.cfg;
  if (isHost()) return $('#localOn').checked ? c.volume / 100 : 0;
  if (c.muteAll || S.myMuted) return 0;
  return (c.volume / 100) * (c.lockVolume ? 1 : S.localVol);
}
function duckFactor() {
  if (isHost()) return local.mic && $('#localDuck').checked ? 0.2 : 1;
  return S.cfg.duck && S.live && S.live.mic ? 0.25 : 1;
}

function applyVolume() {
  const g = effGain(), d = duckFactor();
  if (actx && master) {
    master.gain.setTargetAtTime(g, actx.currentTime, 0.03);
    duckGain.gain.setTargetAtTime(d, actx.currentTime, 0.12);
  }
  // grafikka ulanmagan holatlar uchun zaxira (tashqi havola pleyeri, WebAudio yo'q brauzer)
  pExt.volume = clamp(g * d, 0, 1); pExt.muted = g === 0;
  if (!musicSrc) { pMain.volume = clamp(g * d, 0, 1); pMain.muted = g === 0; }
  if (Y.ok && Y.active) { try { Y.p.setVolume(Math.round(clamp(g * d, 0, 1) * 100)); if (g === 0) Y.p.mute(); else Y.p.unMute(); } catch {} }
  if (remote.mic && remote.mic.el && !remote.mic.src) { remote.mic.el.muted = g === 0; remote.mic.el.volume = clamp(g, 0, 1); }
}

function applyProcs() {
  applyItemGain();
  if (local.micChain) local.micChain.setAgc(S.cfg.normalize);
}

// ------------------------------------------------------------ audio qulfini ochish (foydalanuvchi bosganda)
async function unlockAudio() {
  const ac = ensureAudio();
  if (ac) {
    try { ac.resume(); const b = ac.createBuffer(1, 1, 22050), n = ac.createBufferSource(); n.buffer = b; n.connect(ac.destination); n.start(0); } catch {}
  }
  const ps = [];
  [pMain, pExt].forEach(p => { p.muted = true; p.src = SILENT; ps.push(p.play().catch(() => {})); });   // ikkalasi ham bir xil bosish ichida
  await Promise.all(ps);
  [pMain, pExt].forEach(p => { p.pause(); p.removeAttribute('src'); p.load(); p.muted = false; });
  loadedId = null;
  applyVolume();
}
document.addEventListener('click', () => { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); }, true);

async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

// ------------------------------------------------------------ ulanish
// Sahifa yangilanganda (F5) xonaga avtomatik qaytish: kod, kalit va shaxsiy token shu tabda saqlanadi (ball va javoblar ham tiklanadi)
function saveLive() {
  try { sessionStorage.setItem('sc_live', JSON.stringify({ role: S.role, code: S.code, key: S.key, name: S.name, tok: S.tok })); } catch {}
}
function clearLive() { try { sessionStorage.removeItem('sc_live'); sessionStorage.removeItem('sc_tab'); } catch {} }
function startSession(role, code, key, name, tok) {
  Object.assign(S, { role, code, key, name, tok: tok || null, myMuted: false, joined: false, items: [], st: null, cfg: defaultCfg(), live: { mic: null, screen: null } });
  wantOpen = true;
  firstOffset = true;
  lastSig = null;
  connect();
  keepAwake();
}

let retry = 0, lastPong = Date.now();
function connect() {
  clearTimeout(reconnectT);
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    retry = 0; lastPong = Date.now();
    setNet('ulandi');
    send({ type: 'join', code: S.code, role: S.role, key: S.key, name: S.name, tok: S.tok, av: S.av || undefined, relay: CAN_RELAY, dev: isHost() ? undefined : S.dev });
    burst();
  };
  sock.onmessage = ev => { if (ws === sock) { lastPong = Date.now(); handle(JSON.parse(ev.data)); } };
  sock.onclose = () => {
    if (ws !== sock || !wantOpen) return;
    NET.q = 0; setNet('qayta ulanmoqda…', true);
    reconnectT = setTimeout(connect, Math.min(8000, 800 * 2 ** retry++) + Math.random() * 300);     // eksponensial kutish: yomon tarmoqni zo'riqtirmaydi
  };
}
// Yarim uzilgan (Wi-Fi'da "ulangan ko'rinadi, lekin jim") ulanishni aniqlab, qayta ulanish
setInterval(() => {
  if (wantOpen && ws && ws.readyState === 1 && S.joined && Date.now() - lastPong > 12000) {
    try { ws.close(); } catch {}
    NET.q = 0; setNet('qayta ulanmoqda…', true);
    connect();
  }
}, 3000);
window.addEventListener('online', () => { if (wantOpen && (!ws || ws.readyState > 1)) { clearTimeout(reconnectT); connect(); } });

function revokeBlobs() { blobs.forEach(u => URL.revokeObjectURL(u)); blobs.clear(); }

function leave(msg, closed) {
  $('#waitOv').hidden = true; renderJoinReq([]);
  clearLive();
  wantOpen = false;
  clearTimeout(reconnectT);
  clearTimeout(startTimer); clearInterval(driftTimer);
  if (ws) { try { ws.close(); } catch {} ws = null; }
  stopMic(true); stopScreen(true); closeAllPeers();
  closeRpc(); remote.streams.clear(); attachRemote();
  unloadPlayer(); hideViewers(); viewerId = null;
  setKind('none');
  S.joined = false; S.st = null; S.items = []; lastSig = null;
  S.live = { mic: null, screen: null };
  if (closed) revokeBlobs();
  clearCache(); stopTest();
  S.quiz = null; S.qMe = null; S.qAns = null; S.qProg = null; renderQuiz();
  try { LUCK.stop(); } catch {}
  try { MG.stop(); } catch {}
  try { GM.stop(); } catch {}
  CHATAPI.reset();
  S.poll = null; S.pollId = null; S.myVote = null; S.parentId = null;
  setNet('');
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  showView('home');
  refreshResume();
  if (msg) toast(msg, 4000);
}

// ------------------------------------------------------------ soat sinxronlash + tarmoq o'lchash
let burstSent = 0, burstGot = 0, clockT = null;
const BN = () => (((S.members && S.members.total) || 0) > 40 ? 4 : 8);
function burst() {
  if (burstSent > 0) NET.loss = NET.loss * 0.6 + (1 - burstGot / burstSent) * 100 * 0.4;      // paket yo'qotish (siljuvchi o'rtacha)
  const first = firstOffset;                              // ulangandan keyingi birinchi o'lchov: ko'proq va zich namuna — soat tezroq aniq bo'ladi
  samples = []; burstSent = first ? 12 : BN(); burstGot = 0;
  for (let i = 0; i < burstSent; i++) setTimeout(() => send({ type: 'ping', t0: performance.now() }), i * (first ? 30 : 60));
  clearTimeout(clockT); clockT = setTimeout(finishBurst, first ? 700 : 1000);
}
(function burstLoop() {          // xonada odam ko'p bo'lsa, o'lchash siyrak va tasodifiy vaqtda (server yuklanmasin)
  const n = (S.members && S.members.total) || 0;
  setTimeout(() => { if (ws && ws.readyState === 1 && S.joined) burst(); burstLoop(); }, clamp(3000 + n * 30, 3000, 12000) + Math.random() * 1500);
})();

function onPong(m) {
  lastPong = Date.now(); burstGot++;
  const rtt = performance.now() - m.t0;
  samples.push({ rtt, off: m.serverNow + rtt / 2 - Date.now() });
  if (burstGot >= burstSent && burstSent > 0) { clearTimeout(clockT); finishBurst(); }      // hamma javob keldi — 1 soniya kutmaymiz
}
// Eng kichik ping'li 3 ta o'lchovning medianasi (tarmoq "shovqini" va asimmetriyani filtrlaydi) + ehtiyotkor silliqlash
function finishBurst() {
  if (!samples.length) return;
  const sorted = [...samples].sort((a, b) => a.rtt - b.rtt);
  const low = sorted.slice(0, 3);
  const off = low.map(x => x.off).sort((a, b) => a - b)[low.length >> 1];
  const rtts = samples.map(x => x.rtt).sort((a, b) => a - b), med = rtts[rtts.length >> 1];
  const jit = rtts.reduce((a, b) => a + Math.abs(b - med), 0) / rtts.length;
  if (firstOffset) offset = off; else { const d = off - offset; offset += Math.abs(d) > 40 ? d * 0.5 : d * 0.2; }
  firstOffset = false;
  S.rtt = sorted[0].rtt; NET.rtt = sorted[0].rtt; NET.jitter = NET.jitter * 0.5 + jit * 0.5;
  NET.q = qualityOf(NET.rtt, NET.jitter, NET.loss);
  renderNet();
}

// ------------------------------------------------------------ server xabarlari
function handle(m) {
  if (m.type.charCodeAt(0) === 97 && m.type.startsWith('att-')) { if (window.ATT) window.ATT.on(m); return; }   // davomat
  switch (m.type) {
    case 'pong': onPong(m); break;
    case 'joined':
      S.joined = true;
      S.items = m.items; S.st = m.state;
      S.cfg = Object.assign(defaultCfg(), m.cfg || {});
      S.live = m.live || { mic: null, screen: null };
      $('#waitOv').hidden = true;
      S.myId = m.myId; S.tok = m.tok; S.parentId = null; if (m.av) S.av = m.av;
      setRoomName(m.name || '');
      saveLive();
      S.poll = m.poll || null; S.pollId = S.poll ? S.poll.id : null; S.myVote = m.myVote == null ? null : m.myVote;
      offset = m.serverNow - Date.now();
      readySent = false;
      showView(isHost() ? 'host' : 'recv');
      if (isHost()) { initHostView(); if (S.newListed === false) { S.newListed = undefined; sendCfg({ listed: false }); } publishLive(); try { showTab(sessionStorage.getItem('sc_tab') || (centerMode() ? 'att' : undefined)); } catch {} } else { $('#rCode').textContent = S.code; setRoomName(m.name || ''); }
      setNet('ulandi');
      viewerId = null;
      renderAll();
      lastSig = null;
      applyState();
      applyVolume(); applyProcs(); renderPoll();
      if (!isHost()) onLive({ live: S.live, resync: true });
      CHATAPI.init(m.chat);
      if (window.ATT && window.ATT.joined) window.ATT.joined();      // davomat: receiver ro'yxatni qayta so'raydi
      break;
    case 'items':
      S.items = m.items; renderAll(); loadCurrent(); applyItemGain(); flushNorm(); break;
    case 'state':
      S.st = m.state; renderAll(); applyState(); break;
    case 'members':
      S.members = Object.assign({ list: [] }, m); renderMembers(); CHATAPI.paint(); break;
    case 'cfg': onCfg(m.cfg); break;
    case 'room-name': setRoomName(m.name || ''); break;
    case 'pending': $('#waitOv').hidden = false; break;                            // Transmitter qabul qilishini kutamiz
    case 'join-requests': if (isHost()) renderJoinReq(m.list); break;
    case 'waiting': S.waiting = m.n; if (isHost() && m.n > 0) toast(`⏳ ${m.n} ta qurilma tayyorlanmoqda…`, 1200); renderStatus(); break;
    case 'you': S.myMuted = !!m.muted; applyVolume(); renderStatus(); toast(S.myMuted ? '🔇 Transmitter dinamigingizni o\'chirdi' : '🔊 Dinamigingiz yoqildi'); break;
    case 'live': if (!isHost()) onLive(m); break;
    case 'rtc-want': serveWant(m.from); break;
    case 'rtc-signal': if (peers.has(m.from)) hostSignal(m.from, m.data); else recvSignal(m.data, m.from); break;
    case 'rtc-parent': S.parentId = m.id; S.hops = m.depth || 1; renderNet(); break;
    case 'rtc-reparent': S.parentId = null; setTimeout(() => { if (S.joined && S.live && (S.live.mic || S.live.screen)) recvWant(); }, Math.random() * 700); break;
    case 'rtc-wait': setTimeout(() => { if (S.joined && S.live && (S.live.mic || S.live.screen) && !rpc) recvWant(); }, 2500 + Math.random() * 1500); break;
    case 'chat': CHATAPI.add(m); break;
    case 'chat-denied': CHATAPI.denied(m.reason); break;
    case 'react': Object.entries(m.counts || {}).forEach(([e, n]) => floatEmoji(e, n)); break;
    case 'luck': LUCK.on(m); break;
    case 'mg': MG.on(m); break;
    case 'mg-me': MG.me(m); break;
    case 'gm': GM.on(m); break;
    case 'gm-r': GM.reply(m); break;
    case 'poll': if (!m.poll || (S.pollId && S.pollId !== m.poll.id)) S.myVote = null; S.poll = m.poll; S.pollId = m.poll ? m.poll.id : null; renderPoll(); break;
    case 'voted': S.myVote = m.i; renderPoll(); break;
    case 'test': if (m.on) startTest(m.t0); else stopTest(); break;
    case 'quiz': onQuiz(m.quiz); break;
    case 'quiz-state': if (m.av) S.av = m.av; S.quiz = m.quiz || null; S.qMe = m.me || null; S.qAns = m.myAnswer == null ? null : m.myAnswer; renderQuiz(); RULES.paint(); STRICT.paint(); break;
    case 'quiz-me': S.qMe = m.me; renderQuiz(); SFX.onMe(); STRICT.paint(); break;
    case 'quiz-progress': S.qProg = m; qProgUpdate(); break;
    case 'quiz-ack': break;
    case 'quiz-ai': aiUI.set(!!m.busy, m.error || '', !!m.noFile); break;
    case 'quiz-ai-warm': { const e = $('#aiReady'); if (e) { e.hidden = !m.ready; e.textContent = m.ready ? '⚡ Savollar tayyor — bosganingizda darhol boshlanadi' : ''; } break; }
    case 'rtc-gone': dropPeer(m.id); break;
    case 'notice': toast(m.message, 6000); break;
    case 'kicked': leave('Transmitter sizni xonadan chiqarib yubordi', true); break;
    case 'error':
      if (m.code === 'NO_ROOM' || m.code === 'BAD_KEY') localStorage.removeItem('sc_host');
      clearLive();
      leave(m.message, true); break;
    case 'closed': localStorage.removeItem('sc_host'); leave(m.reason || 'Xona yopildi', true); break;
  }
}

function onCfg(cfg) {
  const prev = S.cfg;
  S.cfg = Object.assign(defaultCfg(), cfg);
  applyVolume(); applyProcs();
  if (prev.allowView !== S.cfg.allowView || prev.allowDownload !== S.cfg.allowDownload) { viewerId = null; loadCurrent(); }
  renderCtl(); renderStatus();
}

// ------------------------------------------------------------ ko'rsatish (media va hujjatlar)
const expected = t => {
  const st = S.st;
  return st.playing ? st.position + Math.max(0, (t - st.playAt) / 1000) : st.position;
};

function seekTo(p) { try { if (Number.isFinite(p)) player.currentTime = Math.max(0, p); } catch {} }
const currentItem = () => S.st && S.items.find(i => i.id === S.st.currentId);

function setKind(k) { baseKind = k; updateKind(); }
function updateKind() {
  const cast = !isHost() && remote.cast && remote.cast.stream.getVideoTracks().length > 0;
  stage.dataset.kind = cast ? 'cast' : baseKind;
  document.body.classList.toggle('casting', !!cast);
  if (!cast && inFs()) exitFs();
}

function unloadPlayer() {
  if (Y.active) { try { if (Y.ok) Y.p.stopVideo(); } catch {} Y.active = false; Y.state = -1; }
  srcTok++; pendingId = null;
  if (!loadedId) return;
  player.pause(); player.removeAttribute('src'); player.load();
  loadedId = null;
}

function hideViewers() {
  $('#pic').removeAttribute('src');
  $('#docFrame').removeAttribute('src');
  $('#fileBar').hidden = true;
}

function showViewer(it) {
  const vkey = `${it.id}:${canView() ? 1 : 0}${canDl() ? 1 : 0}`;
  if (viewerId === vkey) return;
  viewerId = vkey;
  hideViewers(); $('#docReload').hidden = true;
  if (!canView()) {
    setKind('doc');
    $('#docIco').textContent = '🔒';
    $('#docName').textContent = 'Transmitter fayllarni ko\'rishni o\'chirgan';
    $('#docMeta').textContent = '';
    return;
  }
  const src = srcOf(it);
  setKind(it.kind);
  viewerLoading = it.kind === 'image' || it.kind === 'pdf' || it.kind === 'text';
  if (it.kind === 'image') $('#pic').src = src;
  else if (it.kind === 'pdf') $('#docFrame').src = canDl() ? src : src + '#toolbar=0';
  else if (it.kind === 'text') $('#docFrame').src = src;
  else {
    $('#docIco').textContent = ICON[it.kind] || '📄';
    $('#docName').textContent = it.name;
    $('#docMeta').textContent = fmtSize(it.size);
  }
  $('#openLink').href = src;
  $('#openLink').hidden = it.kind === 'doc' || !canDl();
  const dl = $('#dlLink');
  dl.href = srcOf(it, true); dl.setAttribute('download', it.name);
  dl.hidden = !canDl();
  $('#fileBar').hidden = $('#openLink').hidden && dl.hidden;
}

// ------------------------------------------------------------ media abstraksiya (fayl pleyer yoki YouTube)
const Y = { p: null, api: null, ok: false, state: -1, id: null, active: false, titled: null };
const isYt = () => { const it = currentItem(); return !!it && it.kind === 'youtube'; };
const mTime = () => (isYt() ? (Y.ok ? (Y.p.getCurrentTime() || 0) : 0) : player.currentTime);
const mDur = () => (isYt() ? (Y.ok ? (Y.p.getDuration() || 0) : 0) : player.duration);
function mSeek(p) {
  if (!Number.isFinite(p)) return;
  p = Math.max(0, p);
  if (isYt()) { if (Y.ok) { try { Y.p.seekTo(p, true); } catch {} } } else seekTo(p);
}
function mPlay() {
  if (isYt()) { if (Y.ok) { try { Y.p.playVideo(); } catch {} } }
  else player.play().catch(() => { $('#tap').hidden = false; });
}
function mPause() { if (isYt()) { if (Y.ok) { try { Y.p.pauseVideo(); } catch {} } } else player.pause(); }
function mRate(r) { if (!isYt() && Math.abs(player.playbackRate - r) > 0.0005) player.playbackRate = r; }
const mPaused = () => (isYt() ? Y.state !== 1 && Y.state !== 3 : player.paused);
const mReady = () => (isYt() ? Y.ok && Y.state === 1 : player.readyState >= 3);
function bufAhead() {
  try {
    if (isYt()) return Y.ok ? Math.max(0, Y.p.getVideoLoadedFraction() * mDur() - mTime()) : 0;
    const b = player.buffered, t = player.currentTime;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.1 && t <= b.end(i)) return b.end(i) - t;
  } catch {}
  return 0;
}
// Qurilma ovoz chiqarish kechikishi (Bluetooth va h.k.) + qo'lda sozlash: audio eshitiladigan lahza serverdagi vaqtga mos tushadi
const lat = () => (isYt() ? 0 : (actx && actx.state === 'running' ? (actx.outputLatency || 0) + (actx.baseLatency || 0) : 0)) + S.syncMs / 1000;

// YouTube (IFrame API): havola jonli video sifatida hamma qurilmada sinxron ijro etiladi
function ytApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (Y.api) return Y.api;
  Y.api = new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
    const sc = document.createElement('script');
    sc.src = 'https://www.youtube.com/iframe_api';
    sc.onerror = () => { Y.api = null; rej(new Error('yt')); };
    document.head.appendChild(sc);
  });
  return Y.api;
}
function onYtState(e) {
  Y.state = e.data;
  if ([5, 1, 2, 3].includes(e.data)) markReady();
  if (e.data === 1) { $('#tap').hidden = true; ytTitle(); }
  if (e.data === 0 && isHost() && loadedId) send({ type: 'ended', id: loadedId });
}
function ytTitle() {
  const it = currentItem();
  if (!isHost() || !it || it.kind !== 'youtube' || it.name !== 'YouTube video' || Y.titled === it.id || !Y.ok) return;
  try { const t = Y.p.getVideoData().title; if (t) { Y.titled = it.id; send({ type: 'rename', id: it.id, name: t }); } } catch {}
}
async function ytLoad(it) {
  try { await ytApi(); } catch { toast('YouTube yuklanmadi — internet kerak', 5000); return; }
  if (loadedId !== it.id) return;
  if (!Y.p) {
    Y.id = it.ytId;
    Y.p = new YT.Player('ytPlayer', {
      width: '100%', height: '100%', videoId: it.ytId,
      playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, origin: location.origin },
      events: {
        onReady: () => {
          Y.ok = true;
          const cur = currentItem();
          if (cur && cur.kind === 'youtube' && cur.ytId !== Y.id) { Y.id = cur.ytId; Y.p.cueVideoById(cur.ytId); }
          applyVolume(); onYtState({ data: Y.p.getPlayerState() }); ytTitle();
          if (S.st) applyState(true);
        },
        onStateChange: onYtState,
        onError: () => toast('YouTube videoni ochib bo\'lmadi (egasi cheklagan bo\'lishi mumkin)', 5000),
      },
    });
  } else if (Y.id !== it.ytId) {
    Y.id = it.ytId; Y.state = -1;
    if (Y.ok) Y.p.cueVideoById(it.ytId);
  } else if (Y.ok) onYtState({ data: Y.p.getPlayerState() });
}

// ------------------------------------------------------------ fayllarni oldindan yuklash (kesh): yomon internetda ham uzluksiz ijro
const PREFETCH_MAX = 64 * 1024 * 1024;
const cache = new Map();                 // itemId -> { state, pct, url, promise }
let srcTok = 0, pendingId = null, rdyT = null, stallAt = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Bo'laklab (Range) yuklash: uzilgan bo'lak qayta so'raladi (butun fayl emas), server band bo'lsa (503) kutiladi.
// Ko'p qurilma bir vaqtda kirganda "momaqaldiroq" bo'lmasligi uchun boshlanishi tasodifiy kechiktiriladi.
async function fetchChunked(it, rec) {
  const url = srcOf(it), total = it.size, CH = 1.5 * 1024 * 1024;
  const n = (S.members && S.members.total) || 0;
  if (n > 20 && !isHost()) await sleep(Math.random() * Math.min(5000, n * 30));
  let parts = [], got = 0, mime = '';
  while (got < total) {
    if (rec.canceled) throw new Error('canceled');
    const end = Math.min(total - 1, got + CH - 1);
    let ok = false;
    for (let attempt = 0; attempt < 9 && !ok; attempt++) {
      if (rec.canceled) throw new Error('canceled');
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${got}-${end}` }, signal: rec.ac ? rec.ac.signal : undefined });
        if (r.status === 503) { await sleep(700 + Math.random() * 1300); continue; }
        if (r.status !== 206 && r.status !== 200) throw new Error(String(r.status));
        mime = mime || r.headers.get('content-type') || '';
        const buf = new Uint8Array(await r.arrayBuffer());
        if (r.status === 200) { parts = [buf]; got = total; }           // server Range'ni e'tiborsiz qoldirdi: butun fayl keldi
        else { parts.push(buf); got += buf.length; }
        rec.pct = Math.min(1, got / total); ok = true;
      } catch { if (rec.canceled) throw new Error('canceled'); await sleep(Math.min(8000, 400 * 2 ** attempt)); }
    }
    if (!ok) throw new Error('fetch');
  }
  return new Blob(parts, { type: mime });
}
function prefetch(it) {
  let rec = cache.get(it.id);
  if (rec) return rec.promise;
  rec = { state: 'loading', pct: 0, url: null, ac: new AbortController(), canceled: false };
  cache.set(it.id, rec);
  rec.promise = (async () => {
    try {
      const blob = await fetchChunked(it, rec);
      rec.url = URL.createObjectURL(blob); rec.state = 'done'; rec.pct = 1;
    } catch { rec.state = 'error'; cache.delete(it.id); }
    evictCache();
  })();
  return rec.promise;
}
function evictCache() {
  const keep = new Set();
  const idx = S.items.findIndex(i => S.st && i.id === S.st.currentId);
  if (idx >= 0) { keep.add(S.items[idx].id); if (S.items[idx + 1]) keep.add(S.items[idx + 1].id); }
  cache.forEach((rec, id) => { if (!keep.has(id) && rec.state === 'done') { URL.revokeObjectURL(rec.url); cache.delete(id); } });
}
function clearCache() { cache.forEach(r => { if (r.url) URL.revokeObjectURL(r.url); }); cache.clear(); }
const prefetchable = it => it && isMedia(it.kind) && it.kind !== 'youtube' && !it.external && it.size <= PREFETCH_MAX && !(it.cid && blobs.get(it.cid));
function prefetchNext() {
  const idx = S.items.findIndex(i => S.st && i.id === S.st.currentId);
  const nx = idx >= 0 ? S.items[idx + 1] : null;
  if (prefetchable(nx)) prefetch(nx);
}
// ---- Receiver: fayl qabul qilishni bekor qilish (masalan 1 GB fayl) va qayta yuklash
const canceled = new Set();                // bekor qilingan fayllar (itemId)
let viewerLoading = false;
function canCancel(it) {
  if (S.role !== 'receiver' || !it || it.external || it.kind === 'youtube' || canceled.has(it.id) || (it.cid && blobs.get(it.cid))) return false;
  return pendingId === it.id || (isMedia(it.kind) && it.size > PREFETCH_MAX) || (!isMedia(it.kind) && viewerLoading && it.size > 4 * 1048576);
}
function showCanceled(it) {
  hideViewers(); setKind('doc');
  $('#docIco').textContent = '⛔'; $('#docName').textContent = 'Yuklash bekor qilindi';
  $('#docMeta').textContent = `${it.name} · ${fmtSize(it.size)}`;
  $('#docReload').hidden = false; $('#fileBar').hidden = true;
}
function cancelReceive() {
  const it = currentItem(); if (!it) return;
  canceled.add(it.id);
  const rec = cache.get(it.id);
  if (rec && rec.state === 'loading') { rec.canceled = true; try { rec.ac.abort(); } catch {} cache.delete(it.id); }
  srcTok++; pendingId = null; viewerLoading = false;
  clearTimeout(startTimer); clearInterval(driftTimer);
  if (isMedia(it.kind)) {
    try { player.pause(); } catch {}
    player.removeAttribute('src'); player.load();
    loadedId = null; readySent = true;
    send({ type: 'ready', id: it.id });                    // bekor qilgan receiver boshqalarni kutdirmaydi
  } else viewerId = null;
  viewerId = 'c:' + it.id;
  showCanceled(it);
  toast('⛔ Yuklash bekor qilindi');
  renderStatus();
}
function reloadCanceled() {
  const it = currentItem(); if (!it) return;
  canceled.delete(it.id); $('#docReload').hidden = true;
  viewerId = null; lastSig = ''; loadedId = null; readySent = false;
  loadCurrent(); applyState(true);
}
$('#rCancel').onclick = cancelReceive;
$('#docReload').onclick = reloadCanceled;
['load', 'error'].forEach(ev => { $('#pic').addEventListener(ev, () => { viewerLoading = false; }); $('#docFrame').addEventListener(ev, () => { viewerLoading = false; }); });

function markReady() {
  if (readySent || !loadedId) return;
  readySent = true; clearTimeout(rdyT);
  send({ type: 'ready', id: loadedId });
}
function setSrc(it) {
  const tok = ++srcTok;
  pendingId = null;
  if (!prefetchable(it)) { player.src = srcOf(it); player.load(); return; }     // lokal blob / tashqi / katta fayl: oqim bilan
  const rec = cache.get(it.id);
  if (rec && rec.state === 'done') { player.src = rec.url; player.load(); prefetchNext(); return; }
  player.removeAttribute('src'); player.load();
  pendingId = it.id;
  prefetch(it).then(() => {
    if (tok !== srcTok || loadedId !== it.id) return;
    const r = cache.get(it.id);
    pendingId = null;
    player.src = r && r.state === 'done' ? r.url : srcOf(it);
    player.load();
    applyState(true);
    prefetchNext();
  });
}

function loadCurrent() {
  const it = currentItem();
  if (!it) {
    unloadPlayer(); hideViewers(); viewerId = null;
    setKind('none');
    return;
  }
  if (canceled.has(it.id)) {                                  // foydalanuvchi bu faylni bekor qilgan: qayta yuklanmaydi
    if (viewerId !== 'c:' + it.id) { viewerId = 'c:' + it.id; unloadPlayer(); showCanceled(it); }
    return;
  }
  if (!isMedia(it.kind)) {
    unloadPlayer();
    showViewer(it);
    return;
  }
  if (viewerId) { hideViewers(); viewerId = null; }
  setKind(it.kind);
  if (it.kind === 'youtube') {
    if (loadedId === it.id) return;
    unloadPlayer();
    loadedId = it.id; readySent = false; Y.active = true;
    applyItemGain(true);
    ytLoad(it);
    return;
  }
  if (Y.active) { try { if (Y.ok) Y.p.stopVideo(); } catch {} Y.active = false; Y.state = -1; }
  const want = it.external ? pExt : pMain;
  if (want !== player) {
    unloadPlayer();
    player = want;
    pMain.hidden = player !== pMain; pExt.hidden = player !== pExt;
  }
  if (loadedId === it.id) return;
  loadedId = it.id; readySent = false; clearTimeout(rdyT);
  applyItemGain(true);
  setSrc(it);
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: it.name, artist: 'SyncBY' }); } catch {}
  }
}

// ------------------------------------------------------------ sinxron chalish
let integ = 0;
function applyState(force) {
  const st = S.st;
  if (!st) return;
  loadCurrent();
  const sig = [st.currentId, st.playing, st.playAt, st.position].join('|');
  if (!force && sig === lastSig) return;
  lastSig = sig;

  clearTimeout(startTimer); clearInterval(driftTimer);
  mRate(1); integ = 0;
  applyVolume();
  const it = currentItem();
  if (!it || !isMedia(it.kind) || canceled.has(it.id)) return;

  if (!st.playing) {
    mPause();
    if (Math.abs(mTime() - st.position) > 0.05) mSeek(st.position);
    return;
  }
  const go = () => {
    const p = expected(sNow()) + lat();
    if (Math.abs(mTime() - p) > 0.12) mSeek(p);
    mPlay();
    startedAt = performance.now(); earlySeeks = 0; lastHard = 0;          // play() ishga tushish kechikishi (50-400 ms) boshida aniq tuzatiladi
    driftTimer = setInterval(drift, 100);
    if (isYt()) setTimeout(() => { if (S.st && S.st.playing && Y.state !== 1 && Y.state !== 3) $('#tap').hidden = false; }, 2500);
  };
  const wait = st.playAt - sNow();
  if (wait > 0) {
    mPause();
    if (Math.abs(mTime() - (st.position + lat())) > 0.05) mSeek(st.position + lat());   // oldindan joyiga qo'yib turamiz
    startTimer = setTimeout(go, wait);
  } else go();
}

// PI-boshqaruv: kichik farqni tezlikni ±5% gacha o'zgartirib (ovoz balandligi o'zgarmaydi), katta farqni surib to'g'rilaydi.
// Transmitter ham xuddi shu algoritmdan foydalanadi — hamma qurilma bir xil serverdagi vaqtga tortiladi (1:1).
let tsRef = { t: -1, p: 0 };
function mTimeS() {                                                          // currentTime qadamlab yangilansa, orasini interpolyatsiya qiladi (o'lchash shovqini kamayadi)
  if (isYt()) return mTime();
  const ct = player.currentTime, now = performance.now();
  if (player.paused || ct !== tsRef.t) { tsRef.t = ct; tsRef.p = now; return ct; }
  const est = ct + (now - tsRef.p) / 1000 * (player.playbackRate || 1);
  return est - ct > 0.25 ? ct : est;
}
function drift() {
  const st = S.st;
  if (!st || !st.playing || mPaused() || !mReady()) { S.drift = null; return; }
  const d = mDur();
  if (isYt() ? !d : !Number.isFinite(d)) { S.drift = 0; return; }          // jonli efir: vaqtga bog'lanmaydi
  const diff = expected(sNow()) + lat() - mTimeS();                        // musbat = biz orqadamiz
  S.drift = diff;
  const now = performance.now(), ad = Math.abs(diff);
  const vid = !isYt() && stage.dataset.kind === 'video';
  if (vid && (player.seeking || player.readyState < 3)) return;                // video surilayotganda yana surmaymiz (qotish aylanasi)
  // Boshida (4 s) qat'iyroq: play() kechikishi darhol tuzatiladi. Keyin ham eski 0.45/0.9/2 s o'rniga kichik chegara — qurilmalar orasida "alohida" (aks-sado kabi) ovoz bo'lmasin.
  const early = !isYt() && now - startedAt < 4000 && earlySeeks < 3;
  const hard = isYt() ? 0.7 : early ? (vid ? 0.15 : 0.08) : vid ? 0.4 : 0.2;
  const gap = isYt() ? 4000 : early ? 700 : vid ? 5000 : 3000;
  if (ad > hard && now - lastHard > gap) {
    lastHard = now; integ = 0; if (early) earlySeeks++;
    fadeSeek(expected(sNow()) + lat() + (vid ? 0.12 : 0.02)); mRate(1);       // surish kechikishini oldindan hisobga olish (audio tez suriladi, video sekinroq)
    return;
  }
  if (isYt()) return;
  if (ad < 0.012) { integ *= 0.9; slewRate(1); return; }
  integ = clamp(integ + diff * 0.1, -0.5, 0.5);
  // Transmitter videosi ham receiverlar bilan bir xil vaqtga tortiladi (avval u umuman tuzatilmasdi va ularning orqasida qolardi); kichik tezlik o'zgarishi sezilmaydi
  if (vid && isHost()) { slewRate(1 + clamp(diff * 0.5 + integ * 0.1, -0.02, 0.02)); return; }
  // kichik farqda tezlik deyarli sezilmaydigan (±1.5%) o'zgaradi => ovoz "chayqalmaydi"; katta farqda tezroq yetib oladi
  const lim = ad > 0.25 ? 0.05 : ad > 0.08 ? 0.03 : 0.015;
  slewRate(1 + clamp(diff * 0.6 + integ * 0.15, -lim, lim));
}
// tezlik bosqichma-bosqich o'zgaradi (sakrash yo'q) — time-stretch artefakti (chayqalish) kamayadi
function slewRate(r) { if (isYt()) return; const cur = player.playbackRate; mRate(cur + clamp(r - cur, -0.003, 0.003)); }
// surishdan oldin ovoz 45 ms ichida o'chadi, surilgach qaytadi: "chiq" (click) va uzilish eshitilmaydi
let fadeT = 0;
function fadeSeek(p) {
  if (!actx || !itemGain || isYt() || actx.state !== 'running') { mSeek(p); return; }
  const g = itemGain.gain, t = actx.currentTime;
  g.cancelScheduledValues(t); g.setTargetAtTime(0, t, 0.01);
  clearTimeout(fadeT);
  fadeT = setTimeout(() => {
    mSeek(p + 0.045);
    fadeT = setTimeout(() => { const t2 = actx.currentTime; g.cancelScheduledValues(t2); g.setTargetAtTime(itemTargetGain(), t2, 0.04); }, 160);
  }, 45);
}

[pMain, pExt].forEach(p => {
  p.addEventListener('canplay', () => {
    if (p !== player || !loadedId || readySent) return;
    if ((p.currentSrc || '').startsWith('blob:')) markReady();                 // blob/lokal: darhol tayyor
    else { clearTimeout(rdyT); rdyT = setTimeout(markReady, 5000); }           // oqim: canplaythrough kutiladi (yoki 5 s)
  });
  p.addEventListener('canplaythrough', () => { if (p === player) markReady(); });
  p.addEventListener('waiting', () => {                                        // uzilish: hamma kutmaydi, bu qurilma tezda qaytib yetib oladi
    if (p !== player || !loadedId || !S.st || !S.st.playing || isHost()) return;      // Transmitter o'z kechikishi bilan hammani to'xtatmaydi
    stallAt = performance.now(); readySent = false;
    send({ type: 'ready', id: loadedId, ok: false });
  });
  p.addEventListener('playing', () => {
    $('#tap').hidden = true;
    if (p === player && stallAt) { stallAt = 0; lastHard = 0; markReady(); drift(); }
  });
  p.addEventListener('ended', () => {
    if (p === player && isHost() && loadedId) send({ type: 'ended', id: loadedId });
  });
});
$('#tap').onclick = () => {
  if (isYt()) { mPlay(); $('#tap').hidden = true; return; }
  player.play().then(() => { $('#tap').hidden = true; }).catch(() => {});
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.joined) {
    if (actx && actx.state !== 'running') actx.resume().catch(() => {});
    applyState(true); keepAwake();
  }
});

// ------------------------------------------------------------ JONLI EFIR: receiver tomoni (mikrofon + ekran)
// Efir daraxti: Transmitter -> (kuchli kompyuter-receiverlar relay sifatida) -> boshqa receiverlar.
// Server har bir receiverga "ota"ni tanlaydi; ota uzilsa, bola avtomatik yangisini topadi.
const remote = { streams: new Map(), mic: null, cast: null };
let rpc = null, rpcPend = [];
const CAN_RELAY = !!window.RTCPeerConnection && !/Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) && (navigator.hardwareConcurrency || 2) >= 4;

function onLive(m) {
  S.live = m.live || { mic: null, screen: null };
  const active = !!(S.live.mic || S.live.screen);
  if (m.resync || !active) { closeRpc(); remote.streams.clear(); S.parentId = null; if (!active) closeAllPeers(); }
  if (active && !rpc) recvWant();
  attachRemote(); applyVolume(); renderStatus();
}

function recvWant() {
  closeRpc(); remote.streams.clear();
  if (S.live && (S.live.mic || S.live.screen)) send({ type: 'rtc-want' });
}

function closeRpc() {
  if (rpc) { try { rpc.close(); } catch {} rpc = null; send({ type: 'rtc-ready', ok: false }); }
  rpcPend = [];
}

const RX_DELAY_MS = 120;                  // hamma tinglovchida bir xil bufer: ovoz bir vaqtda, uzilishsiz chiqadi
function createRpc() {
  const pc = new RTCPeerConnection(ICE);
  rpc = pc;
  pc.onicecandidate = e => { if (e.candidate && S.parentId) send({ type: 'rtc-signal', to: S.parentId, data: { ice: e.candidate.toJSON() } }); };
  pc.ontrack = e => {
    const st = e.streams[0] || new MediaStream([e.track]);
    remote.streams.set(st.id, st);
    try { const r = e.receiver; if (r) { if ('jitterBufferTarget' in r) r.jitterBufferTarget = e.track.kind === 'audio' ? RX_DELAY_MS : 100; if ('playoutDelayHint' in r && e.track.kind === 'audio') r.playoutDelayHint = RX_DELAY_MS / 1000; } } catch {}
    st.onaddtrack = attachRemote; st.onremovetrack = attachRemote;
    attachRemote();
  };
  pc.onconnectionstatechange = () => {
    if (rpc !== pc) return;
    if (pc.connectionState === 'connected') send({ type: 'rtc-ready', ok: true });        // endi men ham relay bo'la olaman
    if (pc.connectionState === 'failed') setTimeout(() => { if (rpc === pc && S.joined) recvWant(); }, 800 + Math.random() * 800);
    if (pc.connectionState === 'disconnected') setTimeout(() => { if (rpc === pc && S.joined && pc.connectionState !== 'connected') recvWant(); }, 2500 + Math.random() * 1000);   // tarmoq uzilsa tez qayta ulanamiz
  };
  return pc;
}

async function recvSignal(d, from) {
  if (!d) return;
  if (S.parentId && from && from !== S.parentId) return;       // eskirgan ota
  try {
    if (d.sdp) {
      const pc = rpc || createRpc();
      await pc.setRemoteDescription(d.sdp);
      rpcPend.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
      const ans = await pc.createAnswer(); ans.sdp = tuneOpus(ans.sdp);
      await pc.setLocalDescription(ans);
      send({ type: 'rtc-signal', to: from || S.parentId, data: { sdp: pc.localDescription } });
    } else if (d.ice) {
      if (rpc && rpc.remoteDescription) rpc.addIceCandidate(d.ice).catch(() => {});
      else rpcPend.push(d.ice);
    }
  } catch (e) { console.warn('rtc', e); }
}

function destroySlot(sl) {
  if (!sl) return;
  if (sl.src) { try { sl.src.disconnect(); } catch {} }
  if (sl.el) { try { sl.el.pause(); } catch {} sl.el.srcObject = null; }
}

function syncSlot(name, id) {
  const st = id ? remote.streams.get(id) : null;
  const cur = remote[name];
  const key = st ? `${st.id}:${st.getAudioTracks().length}:${st.getVideoTracks().length}` : null;
  if ((cur && cur.key === key) || (!cur && !key)) return;
  if (cur) { destroySlot(cur); remote[name] = null; }
  if (name === 'cast') castVideo.srcObject = st || null;
  if (!st) return;
  const slot = { key, stream: st };
  if (name === 'cast') castVideo.play().catch(() => {});
  if (st.getAudioTracks().length) {
    if (ensureAudio()) {
      if (name === 'mic') { slot.el = new Audio(); slot.el.srcObject = st; slot.el.muted = true; slot.el.play().catch(() => {}); }   // Chrome: WebRTC audio uchun element kerak
      slot.src = actx.createMediaStreamSource(st);
      slot.src.connect(name === 'mic' ? voiceGain : castGain);      // qat'iy 1:1 — receiverda qo'shimcha ishlov yo'q
    } else if (name === 'mic') {
      slot.el = new Audio(); slot.el.srcObject = st; slot.el.play().catch(() => {});
    }
  }
  remote[name] = slot;
}

function attachRemote() {
  const live = S.live || {};
  syncSlot('mic', live.mic);
  syncSlot('cast', live.screen);
  updateKind();
  applyVolume();
  const parts = [];
  if (live.mic) parts.push('🎤 Transmitter gapirmoqda');
  if (live.screen) parts.push('🖥 Ekran ko\'rsatilmoqda');
  if (!isHost() && peers.size) syncAllPeers();                 // relay: o'z bolalariga yangi treklarni uzatish
  const chip = $('#rLive');
  chip.hidden = !parts.length || isHost();
  chip.textContent = parts.join(' · ');
}

// To'liq ekran: Fullscreen API -> (iPhone) video'ning o'z to'liq ekrani -> zaxira: sahifa ichida to'liq ekran
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const inFs = () => fsEl() === stage || stage.classList.contains('pseudo-fs');
async function enterFs() {
  const f = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (f) {
    try {
      await f.call(stage);
      try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch {}
      return;
    } catch {}
  }
  if (castVideo.webkitEnterFullscreen) { try { castVideo.webkitEnterFullscreen(); return; } catch {} }
  stage.classList.add('pseudo-fs'); document.body.classList.add('noscroll');
}
function exitFs() {
  if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
  stage.classList.remove('pseudo-fs'); document.body.classList.remove('noscroll');
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch {}
}
const toggleFs = () => (inFs() ? exitFs() : enterFs());
$('#fsBtn').onclick = toggleFs;
$('#fsExit').onclick = exitFs;
$('#fitBtn').onclick = () => stage.classList.toggle('fill');
castVideo.addEventListener('dblclick', toggleFs);
document.addEventListener('fullscreenchange', () => { if (!fsEl()) document.body.classList.remove('noscroll'); });
document.addEventListener('webkitfullscreenchange', () => { if (!fsEl()) document.body.classList.remove('noscroll'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && stage.classList.contains('pseudo-fs')) exitFs(); });

// ------------------------------------------------------------ JONLI EFIR: transmitter tomoni
const local = { mic: null, micRaw: null, micChain: null, micTrim: null, screen: null, mode: 'detail' };
const peers = new Map();                         // receiverId -> { pc, pend, cur }
const secureMsg = () => (!window.isSecureContext
  ? 'Mikrofon va ekran uchun sahifa HTTPS yoki http://localhost orqali ochilishi kerak'
  : 'Bu qurilma/brauzer qo\'llab-quvvatlamaydi');
const maxPer = () => (isHost() ? clamp(40e6 / Math.max(1, peers.size), 1.5e6, 8e6) : clamp(8e6 / Math.max(1, peers.size), 0.6e6, 2.5e6));     // bitta receiver uchun yuqori chegara (bit/s)

function publishLive() {
  send({ type: 'live', mic: local.mic ? local.mic.id : null, screen: local.screen ? local.screen.id : null, mode: local.mode });
  if (!local.mic && !local.screen) closeAllPeers();
  applyVolume();
  renderLiveBtns();
}

// Zoom kabi: ekran matni uchun VP9/H264 afzal, tarmoq sifatiga qarab bitreyt avtomatik moslanadi
// Ovoz sifati: Opus 48 kHz, FEC (paket yo'qolsa tiklaydi), DTX o'chiq (uzilishsiz). Ekran ovozi bo'lsa stereo, aks holda mono 64 kbps.
const liveStereo = () => !!(local.screen || (S.live && S.live.screen));
function tuneOpus(sdp) {
  try {
    const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
    if (!m) return sdp;
    const pt = m[1], st = liveStereo();
    const want = `minptime=10;useinbandfec=1;usedtx=0;cbr=0;stereo=${st ? 1 : 0};sprop-stereo=${st ? 1 : 0};maxaveragebitrate=${st ? 96000 : 64000};maxplaybackrate=48000;sprop-maxcapturerate=48000`;
    const re = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`);
    if (re.test(sdp)) return sdp.replace(re, `a=fmtp:${pt} ${want}`);
    return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus\\/48000\\/2\\r?\\n)`), `$1a=fmtp:${pt} ${want}\r\n`);
  } catch { return sdp; }
}
function applyAudioSender(p) {
  const s = p.pc.getSenders().find(x => x.track && x.track.kind === 'audio');
  if (!s) return;
  try {
    const prm = s.getParameters();
    if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
    prm.encodings[0].maxBitrate = liveStereo() ? 96000 : 64000;
    prm.encodings[0].priority = 'high'; prm.encodings[0].networkPriority = 'high';     // ovoz videodan oldin: har doim uzluksiz
    s.setParameters(prm).catch(() => {});
  } catch {}
}
function preferCodecs(pc) {
  try {
    const tr = pc.getTransceivers().find(t => t.sender.track && t.sender.track.kind === 'video');
    if (!tr || !tr.setCodecPreferences || !window.RTCRtpSender) return;
    const order = peers.size <= 3 ? ['video/VP9', 'video/H264', 'video/VP8'] : ['video/H264', 'video/VP8', 'video/VP9'];
    const rank = c => { const i = order.indexOf(c.mimeType); return i < 0 ? 9 : i; };
    tr.setCodecPreferences([...RTCRtpSender.getCapabilities('video').codecs].sort((a, b) => rank(a) - rank(b)));
  } catch {}
}

function applySender(p, bps) {
  const s = p.pc.getSenders().find(x => x.track && x.track.kind === 'video');
  if (!s) return;
  try {
    const prm = s.getParameters();
    if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
    const e = prm.encodings[0];
    const detail = castMode() !== 'motion';
    e.maxBitrate = Math.round(bps);
    e.maxFramerate = detail ? 24 : 30;
    e.scaleResolutionDownBy = detail ? (bps < 0.8e6 ? 2 : bps < 1.5e6 ? 1.5 : 1) : (bps < 1.5e6 ? 2 : bps < 3e6 ? 1.5 : 1);
    e.priority = 'high'; e.networkPriority = 'high';
    prm.degradationPreference = detail ? 'maintain-resolution' : 'balanced';      // matn: aniqlik avval, kadrlar keyin
    s.setParameters(prm).catch(() => {});
  } catch {}
}

async function adaptPeer(p) {
  if (!hasVideoSource() || p.pc.connectionState !== 'connected') return;
  try {
    const stats = await p.pc.getStats();
    let loss = 0;
    stats.forEach(r => { if (r.type === 'remote-inbound-rtp' && r.kind === 'video') loss = r.fractionLost || 0; });
    let t = p.cur;
    if (loss > 0.08) t = p.cur * 0.75;            // yo'qotish: kamaytiramiz
    else if (loss < 0.02) t = p.cur * 1.15;       // yaxshi tarmoq: sifatni oshiramiz
    t = clamp(t, 300e3, maxPer());
    if (Math.abs(t - p.cur) / p.cur > 0.08) { p.cur = t; applySender(p, t); }
  } catch {}
}
setInterval(() => { if (hasVideoSource()) peers.forEach(adaptPeer); }, 2000);

// ---- Efirni tarqatish (Transmitter ham, relay-receiver ham): har bir "bola" uchun alohida PeerConnection
const RELAY_MAX = 4;
const hasVideoSource = () => (isHost() ? !!local.screen : !!(remote.cast && remote.cast.stream.getVideoTracks().length));
const castMode = () => (isHost() ? local.mode : (S.live && S.live.mode) || 'detail');
function sourceStreams() {
  if (isHost()) return [local.mic, local.screen].filter(Boolean);
  const out = [];
  if (remote.mic) out.push(remote.mic.stream);
  if (remote.cast) out.push(remote.cast.stream);
  return out;
}
function syncPeerTracks(p) {
  const want = [];
  sourceStreams().forEach(st => st.getTracks().forEach(t => { if (t.readyState === 'live') want.push([t, st]); }));
  p.pc.getSenders().forEach(s => { if (s.track && !want.some(([t]) => t === s.track)) { try { p.pc.removeTrack(s); } catch {} } });
  want.forEach(([t, st]) => { if (!p.pc.getSenders().some(s => s.track === t)) { try { p.pc.addTrack(t, st); } catch {} } });
  if (want.some(([t]) => t.kind === 'video')) preferCodecs(p.pc);
}
const syncAllPeers = () => peers.forEach(syncPeerTracks);

function dropPeer(id) {
  const p = peers.get(id);
  if (p) { try { p.pc.close(); } catch {} peers.delete(id); }
}
function closeAllPeers() { [...peers.keys()].forEach(dropPeer); }

function serveWant(id) {
  if (!id || !sourceStreams().length) return;
  dropPeer(id);
  if (peers.size >= (isHost() ? MAX_PEERS : RELAY_MAX)) return;
  const pc = new RTCPeerConnection(ICE);
  const p = { pc, pend: [], cur: Math.min(maxPer(), isHost() ? 4e6 : 2e6) };
  peers.set(id, p);
  pc.onicecandidate = e => { if (e.candidate) send({ type: 'rtc-signal', to: id, data: { ice: e.candidate.toJSON() } }); };
  pc.onnegotiationneeded = async () => {
    try {
      const off = await pc.createOffer(); off.sdp = tuneOpus(off.sdp);
      await pc.setLocalDescription(off);
      send({ type: 'rtc-signal', to: id, data: { sdp: pc.localDescription } });
    } catch (e) { console.warn('offer', e); }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { applySender(p, p.cur); applyAudioSender(p); }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { if (peers.get(id) === p) peers.delete(id); }
  };
  syncPeerTracks(p);
}

async function hostSignal(id, d) {
  const p = peers.get(id);
  if (!p || !d) return;
  try {
    if (d.sdp) {
      await p.pc.setRemoteDescription(d.sdp);
      p.pend.splice(0).forEach(c => p.pc.addIceCandidate(c).catch(() => {}));
    } else if (d.ice) {
      if (p.pc.remoteDescription) p.pc.addIceCandidate(d.ice).catch(() => {});
      else p.pend.push(d.ice);
    }
  } catch (e) { console.warn('answer', e); }
}

// ---- Mikrofon: filtrlar -> chiyillash (feedback) bostirgich -> shovqin darvozasi -> avto-balandlik -> limiter
function buildMicChain(raw) {
  const sr = actx.sampleRate;
  const biq = (type, f, q) => { const b = actx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const src = actx.createMediaStreamSource(raw);
  const hp = biq('highpass', 100, 0.7), lp = biq('lowpass', 7500, 0.7);
  src.connect(hp); hp.connect(lp);
  const notches = []; let prev = lp;
  for (let i = 0; i < 4; i++) {                       // chiyillash chastotasini kesuvchi zaxira filtrlar (dastlab shaffof)
    const n = biq('peaking', 1000, 12); n.gain.value = 0;
    prev.connect(n); prev = n; notches.push(n);
  }
  const an = actx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.4; prev.connect(an);
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -28; comp.knee.value = 20; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
  const agc = actx.createGain(), gate = actx.createGain(), trim = actx.createGain(), lim = actx.createDynamicsCompressor();
  lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
  trim.gain.value = $('#micGain').value / 100;
  const dest = actx.createMediaStreamDestination();
  prev.connect(comp); comp.connect(agc); agc.connect(gate); gate.connect(trim); trim.connect(lim); lim.connect(dest);
  const mAn = actx.createAnalyser(); mAn.fftSize = 1024; trim.connect(mAn);

  const td = new Float32Array(an.fftSize), fd = new Float32Array(an.frequencyBinCount), md = new Float32Array(mAn.fftSize);
  const binHz = sr / an.fftSize, lo = Math.floor(250 / binHz), hi = Math.min(an.frequencyBinCount - 12, Math.floor(6000 / binHz));
  let floor = 0.004, lvl = 0, hold = 0, tick = 0, agcOn = true, howl = { k: -1, n: 0 }, ni = 0, open = false;

  const timer = setInterval(() => {
    if (actx.state !== 'running') return;
    tick++;
    an.getFloatTimeDomainData(td);
    let s = 0; for (let i = 0; i < td.length; i++) s += td[i] * td[i];
    const rms = Math.sqrt(s / td.length);
    floor = rms < floor ? rms : floor * 1.004;                      // shovqin sathini kuzatish
    floor = clamp(floor, 0.0008, 0.03);
    const thr = Math.max(floor * 3.5, 0.006);
    if (rms > thr) hold = 6; else hold = Math.max(0, hold - 1);
    open = hold > 0;
    gate.gain.setTargetAtTime(open ? 1 : 0.03, actx.currentTime, open ? 0.01 : 0.12);   // jim paytda mikrofon "yopiladi": aks-sado/shovqin ketmaydi
    if (open && rms > 0.006 && agcOn) {
      lvl = lvl ? lvl * 0.9 + rms * 0.1 : rms;
      agc.gain.setTargetAtTime(clamp(0.14 / lvl, 0.5, 4), actx.currentTime, 0.3);
    }
    mAn.getFloatTimeDomainData(md);
    let pk = 0; for (let i = 0; i < md.length; i++) pk = Math.max(pk, Math.abs(md[i]));
    $('#micMeter').value = pk;
    $('#micState').textContent = open ? '🟢 Gapirmoqda' : '⚪ Jim';

    if (tick % 2 === 0) {                                           // chiyillash (feedback) detektori: ~0.6 s davom etgan tor cho'qqi
      an.getFloatFrequencyData(fd);
      let k = lo; for (let i = lo; i <= hi; i++) if (fd[i] > fd[k]) k = i;
      const peak = fd[k]; let sum = 0, c = 0;
      for (let j = -10; j <= 10; j++) { if (Math.abs(j) <= 2) continue; const v = fd[k + j]; if (Number.isFinite(v)) { sum += v; c++; } }
      const avg = c ? sum / c : -100;
      if (Number.isFinite(peak) && peak > -28 && peak - avg > 24 && open) {
        if (Math.abs(k - howl.k) <= 1) howl.n++; else howl = { k, n: 1 };
        if (howl.n >= 6) {
          const nf = notches[ni % 4]; ni++;
          nf.frequency.value = k * binHz; nf.Q.value = 14; nf.gain.value = -26;
          howl.n = 0;
          toast('🔧 Chiyillash aniqlandi va bostirildi — quloqchin taqish tavsiya etiladi', 4500);
        }
      } else howl.n = Math.max(0, howl.n - 1);
    }
  }, 50);

  return {
    dest, trim,
    setAgc(v) { agcOn = !!v; if (!agcOn) agc.gain.setTargetAtTime(1, actx.currentTime, 0.15); },
    destroy() { clearInterval(timer); [src, hp, lp, ...notches, an, comp, agc, gate, trim, lim, mAn].forEach(n => { try { n.disconnect(); } catch {} }); },
  };
}

async function startMic() {
  if (local.mic) return stopMic();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast(secureMsg(), 5000);
  try {
    const raw = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: false,
      channelCount: 1, sampleRate: { ideal: 48000 }, latency: { ideal: 0.02 }, voiceIsolation: true,
    } });
    if (!ensureAudio()) { raw.getTracks().forEach(t => t.stop()); return toast('Brauzer audio tizimini qo\'llab-quvvatlamaydi'); }
    await actx.resume();
    const chain = buildMicChain(raw);
    chain.setAgc(S.cfg.normalize);
    local.mic = chain.dest.stream; local.micRaw = raw; local.micChain = chain; local.micTrim = chain.trim;
    raw.getAudioTracks()[0].onended = () => stopMic();
    syncAllPeers();
    publishLive();
  } catch (e) {
    toast(e && e.name === 'NotAllowedError' ? 'Mikrofonga ruxsat berilmadi' : 'Mikrofonni yoqib bo\'lmadi', 4000);
  }
}

function stopMic(silent) {
  if (!local.mic) return;
  if (local.micChain) local.micChain.destroy();
  if (local.micRaw) local.micRaw.getTracks().forEach(t => t.stop());
  Object.assign(local, { mic: null, micRaw: null, micChain: null, micTrim: null });
  syncAllPeers();
  $('#micMeter').value = 0;
  if (!silent) publishLive(); else renderLiveBtns();
}

async function startScreen() {
  if (local.screen) return stopScreen();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast(secureMsg(), 5000);
  const mode = $('#castMode').value;
  local.mode = mode;
  const wantAudio = $('#castAudio').checked;
  const gdm = o => navigator.mediaDevices.getDisplayMedia(o);
  // Zoom kabi: ekranni asl o'lchamida (1080p+) va matn uchun aniqlikni afzal ko'rib olamiz
  const vid = { frameRate: { ideal: mode === 'motion' ? 30 : 15, max: 30 }, width: { ideal: 1920, max: 2560 }, height: { ideal: 1080, max: 1440 }, cursor: 'always' };
  try {
    let st;
    try {
      st = await gdm({
        video: vid,
        audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true } : false,
        systemAudio: wantAudio ? 'include' : 'exclude', surfaceSwitching: 'include', selfBrowserSurface: 'exclude',
      });
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw e;
      st = await gdm({ video: vid, audio: wantAudio });
    }
    const vt = st.getVideoTracks()[0];
    try { vt.contentHint = mode === 'motion' ? 'motion' : 'detail'; } catch {}
    vt.onended = () => stopScreen();
    local.screen = st;
    const prev = $('#castPrev'); prev.srcObject = st; prev.hidden = false; prev.play().catch(() => {});
    syncAllPeers();
    publishLive();
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') toast('Ekranni ulashib bo\'lmadi', 4000);
  }
}

function stopScreen(silent) {
  if (!local.screen) return;
  local.screen.getTracks().forEach(t => t.stop());
  local.screen = null;
  syncAllPeers();
  const prev = $('#castPrev'); prev.srcObject = null; prev.hidden = true;
  if (!silent) publishLive(); else renderLiveBtns();
}

function renderLiveBtns() {
  const mb = $('#micBtn'), sb = $('#screenBtn');
  mb.textContent = local.mic ? '⏹ Mikrofonni o\'chirish' : '🎤 Mikrofonni yoqish';
  mb.className = 'mic-big' + (local.mic ? ' live' : '');
  $('#micLive').hidden = !local.mic; $('#micStat').hidden = !local.mic;
  const qm = $('#qgMic'); if (qm) { qm.textContent = local.mic ? '⏹ Mikrofon: yoniq' : '🎤 Mikrofon'; qm.classList.toggle('act', !!local.mic); }
  sb.textContent = local.screen ? '⏹ Ekranni to\'xtatish' : '🖥 Ekranni ko\'rsatish';
  sb.className = 'sec' + (local.screen ? ' live' : '');
  $('#micBox').hidden = !local.mic;
  $('#liveChip').hidden = !(isHost() && S.joined && (local.mic || local.screen));
  $('#liveChip').textContent = '🔴 Efirda: ' + [local.mic ? '🎤' : '', local.screen ? '🖥' : ''].filter(Boolean).join(' ');
}

// ------------------------------------------------------------ ko'rinish
function renderAll() { renderMembers(); renderNow(); if (isHost()) { renderHostList(); renderCtl(); } renderCtl(); renderStatus(); }

function renderMembers() {
  const m = S.members;
  $('#hTotal').textContent = m.total || 0; $('#hReady').textContent = m.ready || 0;
  $('#rTotal').textContent = m.total || 0;
  $('#fnBadge').textContent = m.total || 0;
  setTxt($('#memN'), String(m.total || 0));
  if (S.quiz) { if (isHost()) { const q = $('#qgPlayers'); if (q) setTxt(q, String(qPlayersN(S.quiz))); if (S.quiz.phase === 'lobby') renderQuizHost(); } else setTxt($('#qpPlayers'), '👥 ' + qPlayersN(S.quiz)); }
  if (isHost()) renderRecvList();
  renderStatus();
}

// ---- Qabul qilish: kutayotgan receiverlar paneli (Transmitter)
function renderJoinReq(list) {
  const box = $('#joinReq'); if (!box) return;
  list = list || []; box.textContent = '';
  box.hidden = !isHost() || !list.length;
  if (box.hidden) return;
  const head = qel('div', 'jr-head'); head.appendChild(qel('b', '', `🚪 Qabul kutayotganlar: ${list.length}`));
  if (list.length > 1) {
    const a = qel('button', 'primary', '✅ Hammasini'); a.onclick = () => send({ type: 'join-allow-all' });
    const d = qel('button', 'sec', '✕ Hammasini'); d.onclick = () => send({ type: 'join-deny-all' });
    head.append(a, d);
  }
  box.appendChild(head);
  list.forEach(r => {
    const row = qel('div', 'jr-row'), top = qel('div', 'jr-top');
    const ok = qel('button', 'primary', '✅ Qabul'); ok.onclick = () => send({ type: 'join-allow', id: r.id });
    const no = qel('button', 'sec', '✕ Rad'); no.onclick = () => send({ type: 'join-deny', id: r.id });
    top.append(qel('span', 'jr-nm', r.name), ok, no); row.appendChild(top);
    if (r.dev) row.appendChild(qel('span', 'dev' + (r.dev.k === 'pc' ? ' warn' : ''), devLabel(r.dev)));
    box.appendChild(row);
  });
}
const rlRows = new Map();
function renderRecvList() {
  const ul = $('#recvList'), list = S.members.list || [];
  $('#recvEmpty').hidden = list.length > 0;
  const seen = new Set();
  list.forEach((r, idx) => {
    seen.add(r.id);
    let row = rlRows.get(r.id);
    if (!row) {
      row = { r };
      row.li = document.createElement('li');
      row.dot = document.createElement('span'); row.nm = document.createElement('span'); row.nm.className = 'nm';
      row.sts = document.createElement('span'); row.sts.className = 'sz'; row.dv = document.createElement('span');
      row.mu = document.createElement('button'); row.mu.onclick = () => send({ type: 'mute-one', id: row.r.id, muted: !row.r.muted });
      row.kk = document.createElement('button'); row.kk.textContent = '✕'; row.kk.title = 'Chiqarib yuborish';
      row.kk.onclick = () => { if (confirm(`"${row.r.name}" xonadan chiqarilsinmi?`)) send({ type: 'kick', id: row.r.id }); };
      row.li.append(row.dot, row.nm, row.sts, row.mu, row.kk, row.dv);
      rlRows.set(r.id, row);
    }
    row.r = r;
    const dc = 'dot' + (r.ready ? ' ok' : ''); if (row.dot.className !== dc) { row.dot.className = dc; row.dot.title = r.ready ? 'tayyor' : 'yuklanmoqda'; }
    setTxt(row.nm, (r.av || '') + ' ' + r.name);
    setTxt(row.dv, devLabel(r.dev)); row.dv.hidden = !r.dev; { const dc2 = 'dev' + (r.dev && r.dev.k === 'pc' ? ' warn' : ''); if (row.dv.className !== dc2) row.dv.className = dc2; }
    setTxt(row.sts, r.stat ? `${qBars(r.stat.q)} ${Math.round(r.stat.rtt)}ms · Δ${Math.round(r.stat.drift)}ms` : '');
    setTxt(row.mu, r.muted ? '🔇' : '🔊'); row.mu.className = r.muted ? 'on' : ''; row.mu.title = r.muted ? 'Dinamigini yoqish' : 'Dinamigini o\'chirish';
    if (ul.children[idx] !== row.li) ul.insertBefore(row.li, ul.children[idx] || null);
  });
  rlRows.forEach((row, id) => { if (!seen.has(id)) { row.li.remove(); rlRows.delete(id); } });
}

function renderCtl() {
  const c = S.cfg;
  if (isHost()) {
    $('#cfgView').checked = c.allowView; $('#cfgDl').checked = c.allowDownload; $('#cfgGuard').checked = c.guard !== false; updGuardBtn();
    $('#cfgNorm').checked = c.normalize; $('#cfgLockVol').checked = c.lockVolume;
    $('#cfgDuck').checked = c.duck; $('#cfgLocked').checked = c.locked; $('#cfgListed').checked = c.listed !== false;
    $('#cfgLoop').value = c.loop;
    $('#cfgWait').checked = c.waitAll; $('#cfgReact').checked = c.allowReact;
    $('#cfgApprove').checked = !!c.approve; $('#cfgPhoneOnly').checked = !!c.phoneOnly; $('#cfgPcApprove').checked = !!c.pcApprove;
    $('#cfgChat').checked = c.allowChat !== false; $('#cfgChatQuiz').checked = c.allowChatQuiz !== false;
    if (document.activeElement !== $('#cfgVol')) $('#cfgVol').value = c.volume;
    $('#volVal').textContent = c.volume + '%';
    const mb = $('#muteAllBtn');
    mb.textContent = c.muteAll ? '🔊 Hammaning dinamigini yoqish' : '🔇 Hammaning dinamigini o\'chirish';
    mb.className = 'sec' + (c.muteAll ? ' on' : '');
  } else {
    const v = $('#vol');
    v.disabled = c.lockVolume;
    v.value = c.lockVolume ? c.volume : Math.round(S.localVol * 100);
    $('#volNote').hidden = !c.lockVolume;
    $('#reactBar').hidden = !c.allowReact;
    GUARD.sync();
  }
  CHATAPI.paint();
}

function renderNow() {
  const it = currentItem();
  document.body.classList.toggle('playing', !!(S.st && S.st.playing && it && isMedia(it.kind)));
  applyItemGain();
  const text = it ? `${ICON[it.kind] || '📄'} ${it.name}` : null;
  $('#hNow').textContent = text || 'Fayl tanlanmagan';
  $('#rNow').textContent = text || 'Transmitter fayl tanlashini kuting…';
  if (isHost()) {
    $('#mediaCtl').hidden = !(it && isMedia(it.kind));
    $('#playPause').textContent = S.st && S.st.playing ? '⏸' : '▶';
    $('#autoNext').checked = !!(S.st && S.st.autoNext);
  }
}

function renderStatus() {
  if (S.role !== 'receiver') return;
  const it = currentItem();
  let text = '—', cls = '';
  if (!S.members.hostOnline) { text = '⚠ Transmitter uzilgan'; cls = 'warn'; }
  else if (!it) { text = '⌛ Kutilmoqda'; }
  else if (canceled.has(it.id)) { text = '⛔ Yuklash bekor qilingan'; }
  else if (!isMedia(it.kind)) { text = viewerLoading && it.size > 4 * 1048576 ? '⬇ Fayl yuklanmoqda…' : '👁 Transmitter ko\'rsatmoqda'; cls = viewerLoading ? 'warn' : 'ok'; }
  else if (pendingId === it.id) { const r = cache.get(it.id), pc = r ? r.pct : 0; text = `⬇ ${fmtSize(Math.round(pc * it.size))} / ${fmtSize(it.size)} · ${Math.round(pc * 100)}%`; cls = 'warn'; }
  else if (!S.st.playing) { text = S.waiting > 0 ? `⏳ ${S.waiting} ta qurilma tayyorlanmoqda…` : '⏸ Pauza'; }
  else if (!mReady()) { text = '⏳ Yuklanmoqda…'; cls = 'warn'; }
  else if (S.drift != null && Math.abs(S.drift) < 0.05) { text = `🟢 Sinxron ±${Math.round(Math.abs(S.drift) * 1000)} ms`; cls = 'ok'; }
  else { text = '🔄 Sinxronlanmoqda…'; cls = 'warn'; }
  const chip = $('#rChip');
  chip.textContent = text;
  chip.className = 'chip ' + cls;
  $('#rMute').hidden = !(S.cfg.muteAll || S.myMuted);
  const cb = $('#rCancel'), sc = canCancel(it); if (cb.hidden === sc) cb.hidden = !sc;
}

function renderHostList() {
  const ul = $('#list');
  ul.textContent = '';
  $('#emptyHint').hidden = S.items.length > 0;
  S.items.forEach(it => {
    const li = document.createElement('li');
    if (S.st && S.st.currentId === it.id) li.className = 'cur';
    const ic = document.createElement('span'); ic.textContent = ICON[it.kind] || '📄';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name;
    const sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = fmtSize(it.size);
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.title = 'O\'chirish';
    x.onclick = e => { e.stopPropagation(); send({ type: 'remove', id: it.id }); };
    li.onclick = () => send({ type: 'select', id: it.id, autoplay: true });
    li.append(ic, nm, sz, x);
    ul.appendChild(li);
  });
}

let seeking = false;
let castPrevBytes = 0, castPrevT = 0;
setInterval(() => {
  if (!S.joined || document.hidden) return;
  if (isHost()) {
    const d = mDur(), t = mTime(), fin = d && Number.isFinite(d);
    $('#hCur').textContent = fmtTime(t);
    $('#hDur').textContent = fin ? fmtTime(d) : (d ? 'LIVE' : '0:00');
    $('#hSeek').disabled = !fin;
    if (!seeking && fin) $('#hSeek').value = (t / d) * 1000;
  }
  renderStatus();
}, 250);
// Receiver o'z holatini hostga bildiradi (ro'yxatda ko'rinadi, boshlanish kechikishi shunga qarab moslanadi)
(function statLoop() {
  const n = (S.members && S.members.total) || 0;
  setTimeout(() => {
    if (S.joined && !isHost()) send({ type: 'stat', rtt: NET.rtt || 0, jitter: NET.jitter, q: NET.q, drift: (S.drift || 0) * 1000, buf: bufAhead(), loss: NET.loss });
    statLoop();
  }, clamp(3000 + n * 25, 3000, 10000) + Math.random() * 1000);
})();
// Ekran efiri statistikasi (receiver)
setInterval(async () => {
  if (!rpc || isHost()) { NET.cast = null; castPrevT = 0; return; }
  try {
    (await rpc.getStats()).forEach(r => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
      const now = performance.now();
      const kbps = castPrevT ? (r.bytesReceived - castPrevBytes) * 8 / (now - castPrevT) : 0;
      castPrevBytes = r.bytesReceived; castPrevT = now;
      NET.cast = { kbps: Math.round(kbps), fps: Math.round(r.framesPerSecond || 0), w: r.frameWidth || 0, h: r.frameHeight || 0 };
    });
  } catch {}
}, 2000);

// ------------------------------------------------------------ transmitter
async function initHostView() {
  $('#hCode').textContent = S.code;
  let base = location.origin;
  $('#lanHint').hidden = true;
  try {
    const info = await (await fetch('/api/info')).json();
    S.maxMb = info.maxMb;
    $('#maxHint').textContent = `musiqa, video, rasm, PDF, Word, Excel, PowerPoint, matn · bittasi ${fmtLimit(info.maxMb)} gacha`;
    if (/^(localhost|127\.|\[::1\])/.test(location.hostname) && info.lan.length) {
      base = `${location.protocol}//${info.lan[0]}:${location.port || 80}`;
      $('#lanHint').hidden = false;
      $('#lanHint').textContent = 'Eslatma: receiverlar bir xil Wi-Fi tarmog\'ida bo\'lishi kerak. Havola kompyuteringizning tarmoq manzilidan olindi.';
    }
  } catch {}
  const url = `${base}/?join=${S.code}`;
  $('#joinUrl').value = url; S.joinUrl = url;
  $('#qr').src = '/api/qr?text=' + encodeURIComponent(url);
  localStorage.setItem('sc_host', JSON.stringify({ code: S.code, key: S.key, name: S.roomName || '' }));
  const hasDisplay = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  $('#screenBtn').hidden = !hasDisplay;
  $('#castAudio').parentNode.hidden = !hasDisplay;
  const hint = $('#liveHint');
  hint.hidden = window.isSecureContext;
  if (!window.isSecureContext) hint.textContent = '⚠ Mikrofon va ekran uchun bu sahifani http://localhost (yoki HTTPS) orqali oching. Wi-Fi manzili (http://192.168…) orqali brauzer ruxsat bermaydi.';
  renderLiveBtns();
}

const sendCfg = patch => send({ type: 'cfg', patch });
$('#cfgView').onchange = e => sendCfg({ allowView: e.target.checked });
$('#cfgGuard').onchange = e => sendCfg({ guard: e.target.checked });
$('#cfgDl').onchange = e => sendCfg({ allowDownload: e.target.checked });
$('#cfgNorm').onchange = e => sendCfg({ normalize: e.target.checked });
$('#cfgLockVol').onchange = e => sendCfg({ lockVolume: e.target.checked });
$('#cfgDuck').onchange = e => sendCfg({ duck: e.target.checked });
$('#cfgLocked').onchange = e => sendCfg({ locked: e.target.checked });
$('#cfgListed').onchange = e => sendCfg({ listed: e.target.checked });
$('#cfgApprove').onchange = e => sendCfg({ approve: e.target.checked });
$('#cfgPhoneOnly').onchange = e => sendCfg({ phoneOnly: e.target.checked });
$('#cfgPcApprove').onchange = e => sendCfg({ pcApprove: e.target.checked });
$('#waitCancel').onclick = () => leave('Qabul so\'rovi bekor qilindi', true);
$('#cfgReact').onchange = e => sendCfg({ allowReact: e.target.checked });
$('#cfgChat').onchange = e => sendCfg({ allowChat: e.target.checked });
$('#cfgChatQuiz').onchange = e => sendCfg({ allowChatQuiz: e.target.checked });
$('#cfgWait').onchange = e => sendCfg({ waitAll: e.target.checked });
function setSync(v) {
  S.syncMs = clamp(Number(v) || 0, -500, 500);
  localStorage.setItem('sc_sync', String(S.syncMs));
  localStorage.setItem('sc_sync_' + (S.sink ? S.sink.id : 'default'), String(S.syncMs));
  ['#syncAdj', '#syncAdjH'].forEach(id => { $(id).value = S.syncMs; });
  $('#syncVal').textContent = $('#syncValH').textContent = (S.syncMs > 0 ? '+' : '') + S.syncMs + ' ms';
}
$('#syncAdj').oninput = e => setSync(e.target.value);
$('#syncAdjH').oninput = e => setSync(e.target.value);
$('#bigBtn').onclick = () => { const on = stage.classList.toggle('big'); document.body.classList.toggle('big', on); };
$('#cfgLoop').onchange = e => sendCfg({ loop: e.target.value });
$('#muteAllBtn').onclick = () => sendCfg({ muteAll: !S.cfg.muteAll });
let volT = 0;
$('#cfgVol').oninput = e => {
  $('#volVal').textContent = e.target.value + '%';
  const now = Date.now();
  if (now - volT > 120) { volT = now; sendCfg({ volume: Number(e.target.value) }); }
};
$('#cfgVol').onchange = e => sendCfg({ volume: Number(e.target.value) });
$('#annBtn').onclick = () => {
  const t = $('#annIn').value.trim();
  if (!t) return;
  send({ type: 'announce', text: t });
  $('#annIn').value = '';
  toast('Xabar yuborildi');
};
$('#annIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('#annBtn').click(); });
$('#micBtn').onclick = startMic;
$('#qgMic').onclick = startMic;
$('#localDuck').onchange = applyVolume;
$('#castMode').onchange = () => {
  local.mode = $('#castMode').value;
  if (!local.screen) return;
  const vt = local.screen.getVideoTracks()[0];
  try { vt.contentHint = local.mode === 'motion' ? 'motion' : 'detail'; } catch {}
  vt.applyConstraints({ frameRate: { ideal: local.mode === 'motion' ? 30 : 15, max: 30 } }).catch(() => {});
  peers.forEach(p => applySender(p, p.cur));
};
// Funksiyalar menyusi
function openDrawer(v) {
  $('#drawer').classList.toggle('open', v);
  $('#scrim').hidden = !v;
  $('#drawer').setAttribute('aria-hidden', String(!v));
}
$('#fnBtn').onclick = () => openDrawer(true);
$('#drawerClose').onclick = () => openDrawer(false);
$('#scrim').onclick = () => openDrawer(false);
document.addEventListener('keydown', e => { if (e.key === 'Escape') openDrawer(false); });
$('#screenBtn').onclick = startScreen;
$('#micGain').oninput = e => { if (local.micTrim) local.micTrim.gain.setTargetAtTime(e.target.value / 100, actx.currentTime, 0.03); };

$('#playPause').onclick = () => {
  if (!S.st || !S.st.currentId) return toast('Avval fayl tanlang yoki yuklang');
  send({ type: S.st.playing ? 'pause' : 'play' });
};
const hostPos = () => (S.st.playing ? expected(sNow()) : S.st.position);
$('#back10').onclick = () => send({ type: 'seek', position: Math.max(0, hostPos() - 10) });
$('#fwd10').onclick = () => send({ type: 'seek', position: hostPos() + 10 });
$('#prevBtn').onclick = () => send({ type: 'prev' });
$('#nextBtn').onclick = () => send({ type: 'next' });
$('#stopBtn').onclick = () => send({ type: 'stop' });
$('#hSeek').addEventListener('input', () => { seeking = true; if (mDur()) $('#hCur').textContent = fmtTime($('#hSeek').value / 1000 * mDur()); });
$('#hSeek').addEventListener('change', () => {
  seeking = false;
  if (mDur()) send({ type: 'seek', position: $('#hSeek').value / 1000 * mDur() });
});
$('#localOn').onchange = applyVolume;
$('#autoNext').onchange = () => send({ type: 'settings', autoNext: $('#autoNext').checked });
$('#copyUrl').onclick = async () => {
  try { await navigator.clipboard.writeText($('#joinUrl').value); toast('Havola nusxalandi'); }
  catch { $('#joinUrl').select(); document.execCommand('copy'); toast('Nusxalandi'); }
};

$('#shareCode').onclick = async () => {
  const text = `${S.roomName ? S.roomName + ' — ' : ''}xona kodi: ${S.code}`, url = S.joinUrl || $('#joinUrl').value;
  if (navigator.share) { try { await navigator.share({ title: S.roomName || 'Xona', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Kod va havola nusxalandi'); }
  catch { $('#joinUrl').select(); document.execCommand('copy'); toast('Nusxalandi'); }
};

// yuklash (navbat bilan)
const queue = []; let uploading = false, curUp = null;
function upAllBtn() {
  const b = $('#upAll'); if (!b) return;
  const n = queue.length + (uploading ? 1 : 0);
  b.hidden = n < 1; b.textContent = n > 1 ? `✕ Hammasini bekor qilish (${n})` : '✕ Yuklashni bekor qilish';
}
function enqueue(files) {
  for (const f of files) {
    if (!kindOfName(f.name)) { toast(`"${f.name}" — bu format qo'llab-quvvatlanmaydi`, 4000); continue; }
    if (S.maxMb && f.size > S.maxMb * 1048576) { toast(`"${f.name}" ${fmtLimit(S.maxMb)} dan katta (${fmtSize(f.size)})`, 5000); continue; }
    const row = document.createElement('div'); row.className = 'up';
    const nm = document.createElement('span'); nm.textContent = `${f.name} · ${fmtSize(f.size)}`;
    const pr = document.createElement('progress'); pr.max = 100; pr.value = 0;
    const pt = document.createElement('small'); pt.className = 'up-pct'; pt.textContent = '⏳ Navbatda';
    const cx = document.createElement('button'); cx.className = 'up-x'; cx.textContent = '✕'; cx.title = 'Yuklashni bekor qilish';
    row.append(nm, pr, pt, cx); $('#uploads').appendChild(row);
    const it = { file: f, row, nm, pr, pt, cx, xhr: null, dead: false };
    cx.onclick = () => cancelUp(it);
    queue.push(it);
  }
  upAllBtn(); pump();
}
function cancelUp(it) {
  if (it.dead) return;
  const qi = queue.indexOf(it);
  if (qi >= 0) { queue.splice(qi, 1); it.dead = true; it.row.remove(); toast(`⛔ "${it.file.name}" navbatdan olib tashlandi`); upAllBtn(); return; }
  if (it.xhr) it.xhr.abort();                                   // onabort qolganini tozalaydi
}
function cancelAllUps() {
  [...queue].forEach(it => { it.dead = true; it.row.remove(); }); queue.length = 0;
  if (curUp && curUp.xhr) curUp.xhr.abort();
  upAllBtn();
}
function pump() {
  if (uploading || !queue.length) { upAllBtn(); return; }
  uploading = true;
  const it = queue.shift(); curUp = it;
  const { file, row, pr, pt, cx } = it;
  const cid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  blobs.set(cid, URL.createObjectURL(file));
  if (isMedia(kindOfName(file.name))) analyzeLater(cid, file);
  pt.textContent = '0%';
  const t0 = performance.now();
  const done = () => { uploading = false; curUp = null; it.dead = true; upAllBtn(); pump(); };
  const fail = msg => {
    row.className = 'up bad'; cx.remove();
    pr.replaceWith(Object.assign(document.createElement('span'), { textContent: msg })); pt.remove();
    URL.revokeObjectURL(blobs.get(cid)); blobs.delete(cid);
    setTimeout(() => row.remove(), 6000);
  };
  const xhr = new XMLHttpRequest(); it.xhr = xhr;
  xhr.open('POST', `/api/rooms/${S.code}/upload?key=${encodeURIComponent(S.key)}&cid=${cid}&name=${encodeURIComponent(file.name)}`);
  let lastPaint = 0;
  xhr.upload.onprogress = e => {
    if (!e.lengthComputable) return;
    const now = performance.now(); if (now - lastPaint < 250 && e.loaded < e.total) return; lastPaint = now;
    pr.value = (e.loaded / e.total) * 100;
    const mbps = e.loaded / 1048576 / Math.max(0.5, (now - t0) / 1000);
    pt.textContent = `${Math.floor(pr.value)}% · ${mbps.toFixed(1)} MB/s`;
  };
  xhr.onload = () => {
    if (xhr.status === 200) row.remove();
    else { let msg = 'Xato'; try { msg = JSON.parse(xhr.responseText).error || msg; } catch {} fail(msg); }
    done();
  };
  xhr.onerror = () => { fail('Tarmoq xatosi'); done(); };
  xhr.onabort = () => {                                    // Transmitter yuklashni bekor qildi: server yarim faylni o'chiradi
    row.remove(); const u = blobs.get(cid); if (u) URL.revokeObjectURL(u); blobs.delete(cid); normByCid.delete(cid);
    toast(`⛔ "${file.name}" yuklash bekor qilindi`); done();
  };
  xhr.send(file);
}
$('#upAll').onclick = cancelAllUps;
$('#fileIn').onchange = e => { enqueue([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => enqueue([...e.dataTransfer.files]));

$('#urlBtn').onclick = () => {
  let url = $('#urlIn').value.trim();
  const mm = url.match(/https?:\/\/[^\s<>"']+/i);                       // "Ulashish" matnidan (sarlavha + havola) havolani ajratamiz
  if (mm) url = mm[0];
  else if (/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(url)) url = 'https://' + url;
  if (!url) return;
  send({ type: 'add-url', url });
  $('#urlIn').value = '';
};
$('#hostLeave').onclick = () => leave();
$('#hostClose').onclick = () => {
  if (confirm('Xona yopilsin? Barcha receiverlar chiqarib yuboriladi va yuklangan fayllar o\'chadi.')) {
    send({ type: 'close' });
    localStorage.removeItem('sc_host');
  }
};

// ------------------------------------------------------------ receiver
$('#vol').oninput = e => { S.localVol = e.target.value / 100; applyVolume(); };
$('#recvLeave').onclick = () => leave();

async function doJoin() {
  const code = $('#codeIn').value.replace(/\D/g, '');
  const err = $('#joinErr'); err.hidden = true;
  if (code.length !== 6) { err.textContent = '6 xonali kodni kiriting'; err.hidden = false; return; }
  unlockAudio();
  try {
    const r = await fetch('/api/rooms/' + code);
    if (!r.ok) throw new Error();
  } catch { err.textContent = 'Bunday kodli xona topilmadi'; err.hidden = false; return; }
  const name = $('#nameIn').value.trim().replace(/\s+/g, ' ');
  if (!name) { err.textContent = 'Ismingizni kiriting — ism majburiy'; err.hidden = false; $('#nameIn').classList.add('need'); $('#nameIn').focus(); return; }
  $('#nameIn').classList.remove('need');
  localStorage.setItem('sc_name', name);
  startSession('receiver', code, null, name);
}
$('#joinBtn').onclick = doJoin;
$('#codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('#nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('#nameIn').addEventListener('input', () => $('#nameIn').classList.remove('need'));

// ------------------------------------------------------------ bosh sahifa
$('#goRecv').onclick = () => { showView('join'); $('#codeIn').focus(); };
document.querySelectorAll('[data-back]').forEach(b => { b.onclick = () => showView('home'); });

$('#goHost').onclick = () => {
  unlockAudio();
  $('#homeErr').hidden = true; $('#newErr').hidden = true;
  if (CENTER.cur) { autoRoom(CENTER.cur); return; }          // markaz kodi kiritilgan: xona avtomatik
  showView('hostNew');
  $('#roomNameIn').focus();
};
// 🏫 Markaz kodi kiritilganda xona avtomatik yaratiladi (nomi: CENTER_n_ROOM, bo'lmasa markaz nomi) va kod ulashishga tayyor turadi.
// Shu nomli o'z xonangiz hali ochiq bo'lsa, yangisi yaratilmaydi — o'sha davom ettiriladi.
let autoBusy = false;
async function autoRoom(c) {
  if (autoBusy || !c) return; autoBusy = true;
  const name = (c.room || c.name || '').trim();
  try {
    unlockAudio();
    let saved = null; try { saved = JSON.parse(localStorage.getItem('sc_host')); } catch {}
    if (saved && saved.code) {
      try {
        const j = await (await fetch(`/api/rooms/${saved.code}?key=${encodeURIComponent(saved.key)}`)).json();
        if (j.exists && j.isHost && (j.name || saved.name || '') === name) { S.roomName = j.name || name; startSession('host', saved.code, saved.key, ''); return; }
      } catch {}
    }
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    S.roomName = j.name || name;
    startSession('host', j.code, j.hostKey, '');
    S.newListed = undefined;
  } catch (e) { toast('⚠ ' + (e.message || 'Xona yaratib bo\'lmadi'), 4000); }
  finally { autoBusy = false; }
}
async function createRoom() {
  const err = $('#newErr'); err.hidden = true;
  const name = $('#roomNameIn').value.trim().replace(/\s+/g, ' ');
  if (!name) { err.textContent = 'Xonaga nom bering — nom majburiy'; err.hidden = false; $('#roomNameIn').classList.add('need'); $('#roomNameIn').focus(); return; }
  $('#roomNameIn').classList.remove('need');
  const btn = $('#createRoom'); btn.disabled = true;
  try {
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    try { localStorage.setItem('sc_roomname', name); } catch {}
    S.roomName = j.name || name;
    startSession('host', j.code, j.hostKey, '');
    S.newListed = $('#newListed').checked ? undefined : false;
  } catch (e) { err.textContent = e.message || 'Xona yaratib bo\'lmadi'; err.hidden = false; }
  btn.disabled = false;
}
$('#createRoom').onclick = createRoom;
$('#roomNameIn').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
$('#roomNameIn').addEventListener('input', () => $('#roomNameIn').classList.remove('need'));

// ------------------------------------------------------------ 🏫 O'quv markaz kodi (bosh sahifa pastida)
// Admin bergan kod serverda tekshiriladi (kodlar .env da; 3 ta noto'g'ri urinishdan keyin server bloklaydi). To'g'ri bo'lsa markazning nomi,
// logotipi va rangi qo'llanadi va shu qurilmada eslab qolinadi (kodning o'zi saqlanmaydi). "Chiqish" standart ko'rinishga qaytaradi.
const CENTER = (() => {
  const box = $('#centerBox'), form = $('#centerForm'), inp = $('#centerCode'), go = $('#centerGo'), msg = $('#centerMsg'), on = $('#centerOn');
  const KEY = 'sc_center', css = document.documentElement.style, VARS = ['--pri', '--pri2', '--pri-rgb', '--pri2-rgb', '--tx1', '--tx2'];
  let cur = null, enabled = false, lockTimer = 0;
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const shade = (h, f) => '#' + hexRgb(h).map(v => Math.round(v * f).toString(16).padStart(2, '0')).join('');
  function shiftHue(hex, deg) {                             // 2-rang berilmasa, asosiy rangdan yaqin rang olinadi
    const [r, g, b] = hexRgb(hex).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    let h = d ? (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) : 0;
    h = (h * 60 + deg + 360) % 360;
    const f = n => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
  }
  const clean = c => {                                      // eslab qolingan ma'lumot qayta tekshiriladi
    if (!c || typeof c.name !== 'string' || !c.name) return null;
    const str = v => (typeof v === 'string' ? v : '');
    return { id: Number(c.id) || 0, name: c.name.slice(0, 60), room: (str(c.room) || c.name).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40),
      logo: /^(https:\/\/|\/(?!\/))[^\s"'<>()\\]+$/i.test(str(c.logo)) ? c.logo : '',
      link: /^https?:\/\/[^\s"'<>]+$/i.test(str(c.link)) ? c.link : '',
      color: /^#[0-9a-f]{6}$/i.test(str(c.color)) ? c.color : '', color2: /^#[0-9a-f]{6}$/i.test(str(c.color2)) ? c.color2 : '' };
  };
  const say = (t, cls) => { msg.textContent = t || ''; msg.className = 'cb-msg' + (cls ? ' ' + cls : ''); msg.hidden = !t; };

  function apply(c) {
    cur = c;
    if (cur && cur.color) {
      const p = cur.color, p2 = cur.color2 || shade(shiftHue(p, -22), .85);   // 2-rang yo'q bo'lsa: biroz to'qroq, yaqin rang (oq matn o'qilishi uchun)
      css.setProperty('--pri', p); css.setProperty('--pri2', p2);
      css.setProperty('--pri-rgb', hexRgb(p).join(', ')); css.setProperty('--pri2-rgb', hexRgb(p2).join(', '));
      css.setProperty('--tx1', shade(p, .62)); css.setProperty('--tx2', shade(p2, .8));
    } else VARS.forEach(k => css.removeProperty(k));
    const logo = cur && cur.logo ? cur.logo : '';
    const bi = $('#brandImg'), ci = $('#cbLogo');
    [bi, ci].forEach(im => { if (logo) { im.src = logo; im.hidden = false; } else { im.hidden = true; im.removeAttribute('src'); } });
    $('#brandMark').hidden = !!logo;
    $('#brandName').textContent = cur ? cur.name : 'SyncBY';
    $('#brandSub').hidden = !cur;
    const bd = $('#centerBadge'); bd.hidden = !cur;
    if (cur) { $('#cbLabel').textContent = cur.name; if (cur.link) bd.href = cur.link; else bd.removeAttribute('href'); }
    const hostEl = $('#host'); if (hostEl) hostEl.classList.toggle('center-mode', !!cur);
    form.hidden = !!cur; on.hidden = !cur; $('#centerOnName').textContent = cur ? cur.name : '';
    box.hidden = !(enabled || cur);
    document.title = S.roomName ? S.roomName + ' · ' + title() : title();
  }
  const title = () => (cur ? cur.name : 'SyncBy');
  [$('#brandImg'), $('#cbLogo')].forEach(im => { im.onerror = () => { im.hidden = true; if (im.id === 'brandImg') $('#brandMark').hidden = false; }; });

  function setLocked(sec) {                                 // blok: input o'chadi, qolgan vaqt sanaladi
    clearInterval(lockTimer);
    if (!(sec > 0)) { inp.disabled = go.disabled = false; return; }
    inp.disabled = go.disabled = true;
    const end = Date.now() + sec * 1000;
    const tick = () => {
      const left = Math.ceil((end - Date.now()) / 1000);
      if (left <= 0) { clearInterval(lockTimer); inp.disabled = go.disabled = false; say('Endi qayta urinib ko\'rishingiz mumkin', ''); return; }
      say(`🔒 Juda ko'p noto'g'ri urinish. Qayta urinish: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, 'bad');
    };
    tick(); lockTimer = setInterval(tick, 1000);
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const code = inp.value.trim();
    if (!code) { say('Kodni kiriting', 'bad'); inp.focus(); return; }
    go.disabled = true; let locked = false;
    try {
      const r = await fetch('/api/center/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        const c = clean(j.center);
        if (c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {} inp.value = ''; say('', ''); apply(c); toast('✔ ' + c.name + ' — sayt moslashtirildi'); autoRoom(c); return; }
      }
      if (j.locked) { locked = true; inp.value = ''; setLocked(j.retryAfter || 1800); return; }
      inp.classList.remove('bad'); void inp.offsetWidth; inp.classList.add('bad');
      say('❌ ' + (j.error || 'Kod noto\'g\'ri') + (j.left != null ? '. Qolgan urinishlar: ' + j.left : ''), 'bad');
      inp.select();
    } catch { say('Server bilan aloqa yo\'q. Qayta urinib ko\'ring', 'bad'); }
    finally { if (!locked) go.disabled = inp.disabled; }
  });
  inp.addEventListener('input', () => { inp.classList.remove('bad'); });
  $('#centerOut').onclick = () => { try { localStorage.removeItem(KEY); } catch {} apply(null); say('', ''); toast('Standart ko\'rinishga qaytildi'); };

  try { apply(clean(JSON.parse(localStorage.getItem(KEY)))); } catch { apply(null); }
  fetch('/api/center/status', { cache: 'no-store' }).then(r => r.json()).then(j => {
    enabled = !!j.enabled; box.hidden = !(enabled || cur);
    if (j.retryAfter > 0 && !cur) setLocked(j.retryAfter);   // sahifa yangilansa ham blok saqlanadi
  }).catch(() => {});
  return { title, get cur() { return cur; } };
})();

// ---- Xona nomi (Transmitter beradi, receiverlar nom bilan ko'radi)
function setRoomName(n) {
  S.roomName = n;
  const rn = $('#rName'); if (rn) { rn.textContent = n; rn.hidden = !n; }
  const h = $('#hRoomName'); if (h && document.activeElement !== h) h.value = n;
  try { if (isHost() && S.code) localStorage.setItem('sc_host', JSON.stringify({ code: S.code, key: S.key, name: n })); } catch {}
  document.title = n ? n + ' · ' + CENTER.title() : CENTER.title();
}
function saveRoomName() {
  const v = $('#hRoomName').value.trim().replace(/\s+/g, ' ');
  if (!v) { $('#hRoomName').value = S.roomName || ''; return toast('Xona nomi bo\'sh bo\'lmasin'); }
  if (v !== S.roomName) { send({ type: 'room-name', name: v }); toast('✔ Xona nomi saqlandi'); }
}
$('#hRoomNameSave').onclick = saveRoomName;
$('#hRoomName').addEventListener('keydown', e => { if (e.key === 'Enter') { saveRoomName(); e.target.blur(); } });

// ---- Xonalar ro'yxati (receiver): dumaloq xonalar + qidiruv. Ro'yxat 3 soniyada bir yangilanadi (sahifa ochiq va ko'rinib turganda)
const ROOMS = (() => {
  const orbs = $('#roomOrbs'), qIn = $('#roomQ'), empty = $('#roomEmpty'), pick = $('#roomPick'), cnt = $('#roomCount');
  let list = [], loaded = false, timer = 0, sel = null, selName = '', els = new Map();
  const hue = s => { let h = 7; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };
  const first = n => { const g = [...String(n).trim()][0] || '◉'; return g.toUpperCase(); };
  async function load() {
    if (document.hidden) return;
    try {
      const r = await fetch('/api/rooms', { cache: 'no-store' });
      if (!r.ok) throw 0;
      list = await r.json(); loaded = true;
    } catch { if (!loaded) { empty.textContent = 'Xonalar ro\'yxatini olib bo\'lmadi. Kod bilan kiring.'; empty.hidden = false; } return; }
    render();    showPick();
  }
  function match(r, t, digits) { return !t || r.name.toLowerCase().includes(t) || (digits && r.code.includes(digits)); }
  function render() {
    const t = qIn.value.trim().toLowerCase(), digits = /^\d+$/.test(t) ? t : '';          // kod bo'yicha faqat toza raqam yozilganda qidiriladi
    const rows = list.filter(r => match(r, t, digits));
    cnt.textContent = rows.length;
    const seen = new Set();
    rows.forEach((r, i) => {
      seen.add(r.code);
      let el = els.get(r.code);
      if (!el) {
        el = document.createElement('button'); el.type = 'button'; el.className = 'orb'; el.setAttribute('role', 'option');
        el.innerHTML = '<span class="orb-c"><span class="orb-l"></span><i class="orb-n"></i><i class="orb-k"></i></span><span class="orb-t"></span>';
        el.onclick = () => choose(el._r);
        els.set(r.code, el);
      }
      el._r = r;
      el.style.setProperty('--h', hue(r.name + r.code.slice(-2)));
      el.classList.toggle('sel', r.code === sel);
      el.classList.toggle('live', !!(r.live || r.quiz));
      el.setAttribute('aria-selected', String(r.code === sel));
      el.querySelector('.orb-l').textContent = first(r.name);
      el.querySelector('.orb-n').textContent = '👥 ' + r.n;
      const k = el.querySelector('.orb-k'); k.textContent = r.locked ? '🔒' : r.approve ? '✋' : r.phoneOnly ? '📱' : ''; k.hidden = !(r.locked || r.approve || r.phoneOnly);
      el.querySelector('.orb-t').textContent = r.name;
      el.title = r.name + ' · ' + r.code + (r.locked ? ' · qulflangan' : r.approve ? ' · Transmitter qabul qiladi' : r.phoneOnly ? ' · faqat telefon' : '');
      if (orbs.children[i] !== el) orbs.insertBefore(el, orbs.children[i] || null);
    });
    els.forEach((el, code) => { if (!seen.has(code)) { el.remove(); els.delete(code); } });
    if (!rows.length) {
      empty.textContent = !loaded ? 'Xonalar yuklanmoqda…' : t ? `«${qIn.value.trim()}» bo'yicha xona topilmadi. ${/^\d{6}$/.test(digits) ? 'Kod bilan kirish uchun «Qo\'shilish» ni bosing.' : ''}` : 'Hozircha ochiq xona yo\'q. Transmitter xona yaratgach shu yerda dumaloq bo\'lib chiqadi — yoki kod bilan kiring.';
      empty.hidden = false;
    } else empty.hidden = true;
  }
  function showPick() {
    if (!sel) { pick.hidden = true; return; }
    pick.hidden = false;
    pick.textContent = selName ? `✔ Tanlandi: ${selName} · ${sel}` : `✔ Kod: ${sel}`;
    const rr = list.find(x => x.code === sel);
    if (rr && rr.quiz) pick.appendChild(Object.assign(document.createElement('small'), { className: 'pick-warn', textContent: '🎯 Bu xonada viktorina ketmoqda. Kirishdan oldin: AI ishlatish va skrinshot olish qoidabuzarlik hisoblanadi.' }));
  }
  function choose(r) {
    sel = r.code; selName = r.name;
    $('#codeIn').value = r.code;
    els.forEach((el, code) => { el.classList.toggle('sel', code === sel); el.setAttribute('aria-selected', String(code === sel)); });
    showPick();
    $('#joinErr').hidden = true;
    if (!$('#nameIn').value.trim()) { $('#nameIn').classList.add('need'); $('#nameIn').focus(); } else $('#joinBtn').focus();
  }
  function onType() {
    render();
    const d = qIn.value.replace(/\D/g, '');
    if (/^\d{6}$/.test(d) && qIn.value.trim() === d) { sel = d; const r = list.find(x => x.code === d); selName = r ? r.name : ''; $('#codeIn').value = d; showPick(); }   // 6 xonali kod yozilsa — to'g'ridan-to'g'ri tanlanadi
  }
  qIn.addEventListener('input', onType);
  qIn.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  $('#codeIn').addEventListener('input', () => { const d = $('#codeIn').value.replace(/\D/g, ''); sel = d.length === 6 ? d : null; const r = sel && list.find(x => x.code === sel); selName = r ? r.name : ''; showPick(); render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) load(); });
  return {
    start() {
      if (timer) return;
      sel = null; selName = ''; pick.hidden = true;
      const c = $('#codeIn').value.replace(/\D/g, '');
      if (c.length === 6) { sel = c; const r = list.find(x => x.code === c); selName = r ? r.name : ''; $('#codeBox').open = true; showPick(); }
      render(); load();
      timer = setInterval(load, 3000);
    },
    stop() { clearInterval(timer); timer = 0; },
  };
})();

function refreshResume() {
  const btn = $('#resume');
  btn.hidden = true;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('sc_host')); } catch {}
  if (!saved) return;
  fetch(`/api/rooms/${saved.code}?key=${encodeURIComponent(saved.key)}`).then(r => r.json()).then(j => {
    if (j.exists && j.isHost) {
      btn.textContent = `↩ Oxirgi xonani davom ettirish (${j.name || saved.name || saved.code})`;
      btn.onclick = () => { unlockAudio(); startSession('host', saved.code, saved.key, ''); };
      btn.hidden = false;
    } else localStorage.removeItem('sc_host');
  }).catch(() => {});
}

// ------------------------------------------------------------ chiqish qurilmasi (Bluetooth), sinxron test, reaksiyalar, so'rovnoma
const BT_RE = /bluetooth|airpods|buds|hands-?free|headset|jbl|beats|bose|wh-1000|wf-1000/i;
const outSels = ['#outSel', '#outSelH'];
async function listOutputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const ds = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    outSels.forEach(id => {
      const el = $(id); el.textContent = '';
      el.add(new Option('Standart (tizim tanlovi)', ''));
      ds.forEach((d, i) => el.add(new Option(d.label || ('Qurilma ' + (i + 1)), d.deviceId)));
      el.value = S.sink ? S.sink.id : '';
    });
    if (S.sink && !ds.some(d => d.deviceId === S.sink.id)) { await setSink('', ''); toast('🎧 Qurilma uzildi — standart dinamikka qaytildi', 4000); }
  } catch {}
}
async function setSink(id, label) {
  ensureAudio();
  let ok = false;
  try { if (actx && actx.setSinkId) { await actx.setSinkId(id || ''); ok = true; } } catch {}
  try { if (pExt.setSinkId) { await pExt.setSinkId(id || ''); ok = true; } } catch {}
  S.sink = id ? { id, label: label || '' } : null;
  localStorage.setItem('sc_sink', JSON.stringify(S.sink));
  outSels.forEach(x => { $(x).value = id || ''; });
  if (!ok && id) toast('Bu brauzer qurilma almashtirishni qo\'llamaydi. Bluetooth\'ni telefon/kompyuter sozlamalarida ulang — ovoz o\'sha yerdan chiqadi.', 6000);
  const saved = localStorage.getItem('sc_sync_' + (id || 'default'));
  if (saved !== null) setSync(saved);
  else if (id && BT_RE.test(label || '')) { setSync(Math.max(S.syncMs, 140)); toast('🎧 Bluetooth aniqlandi: kechikish tuzatmasi +140 ms qo\'yildi. "Sinxron test"da aniqlashtiring.', 6000); }
}
async function pickOutput() {
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput) {
      const d = await navigator.mediaDevices.selectAudioOutput();
      await listOutputs(); await setSink(d.deviceId, d.label); return;
    }
  } catch (e) { if (e && e.name === 'NotAllowedError') return; }
  await listOutputs();
  if (!(actx && actx.setSinkId)) toast('Bu brauzerda qurilma tanlash yo\'q. Bluetooth\'ni tizim sozlamalaridan ulang.', 5000);
}
['#outPick', '#outPickH'].forEach(id => { $(id).onclick = pickOutput; });
outSels.forEach(id => { $(id).onchange = e => setSink(e.target.value, e.target.selectedOptions[0] ? e.target.selectedOptions[0].text : ''); });
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listOutputs);

// Sinxron test: server vaqtiga bog'langan "tik" signali — hamma qurilmada bir vaqtda eshitilishi kerak. Farq bo'lsa, slayder bilan to'g'rilanadi.
let testT = null, testBuf = null; const beatsDone = new Set();
function startTest(t0) {
  stopTest();
  if (!ensureAudio()) return;
  actx.resume().catch(() => {});
  if (!testBuf) {
    const n = Math.round(actx.sampleRate * 0.04);
    testBuf = actx.createBuffer(1, n, actx.sampleRate);
    const d = testBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 1800 * i / actx.sampleRate) * Math.exp(-i / (n / 5)) * 0.8;
  }
  const tick = () => {
    const nowS = sNow();
    for (let n = Math.max(0, Math.floor((nowS - t0) / 1000)); n < Math.max(0, Math.floor((nowS - t0) / 1000)) + 3; n++) {
      if (beatsDone.has(n)) continue;
      const when = actx.currentTime + (t0 + n * 1000 - nowS) / 1000 - lat();
      if (when < actx.currentTime) { beatsDone.add(n); continue; }
      beatsDone.add(n);
      const s = actx.createBufferSource(); s.buffer = testBuf; s.connect(master); s.start(when);
    }
  };
  testT = setInterval(tick, 250); tick();
  toast('🔔 Sinxron test: signal hamma qurilmada bir vaqtda eshitilishi kerak', 4500);
}
function stopTest() { clearInterval(testT); testT = null; beatsDone.clear(); }
$('#testBtn').onclick = () => { const on = $('#testBtn').dataset.on !== '1'; $('#testBtn').dataset.on = on ? '1' : '0'; $('#testBtn').textContent = on ? '⏹ Testni to\'xtatish' : '🔔 Sinxron test signalini yoqish'; send({ type: 'test', on }); };

// Reaksiyalar
const REACTS = ['👏', '🔥', '❤️', '😂', '😮', '👍', '🎉'];
REACTS.forEach(e => {
  const b = document.createElement('button'); b.textContent = e; b.className = 'sec';
  b.onclick = () => send({ type: 'react', e });
  $('#reactBar').appendChild(b);
});
function floatEmoji(e, n) {
  const box = $('#floaty');
  for (let i = 0; i < Math.min(n, 5); i++) {
    if (box.childElementCount > 36) break;
    const el = document.createElement('span');
    el.className = 'fe'; el.textContent = e;
    el.style.left = (8 + Math.random() * 84) + '%';
    el.style.animationDuration = (2.4 + Math.random() * 1.6) + 's';
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
}

// So'rovnoma
function fillPoll(box, p, showRes, canVote) {
  box.textContent = '';
  if (!p) return;
  const total = p.votes.reduce((a, b) => a + b, 0);
  p.opts.forEach((o, i) => {
    const row = document.createElement('button');
    row.className = 'popt' + (S.myVote === i ? ' mine' : '');
    const bar = document.createElement('i'); bar.style.width = (showRes && total ? Math.round(p.votes[i] / total * 100) : 0) + '%';
    const t = document.createElement('span'); t.textContent = o;
    const c = document.createElement('b'); c.textContent = showRes ? `${p.votes[i]}${total ? ' · ' + Math.round(p.votes[i] / total * 100) + '%' : ''}` : '';
    row.append(bar, t, c);
    if (canVote && p.open && S.myVote == null) row.onclick = () => { S.myVote = i; send({ type: 'vote', i }); renderPoll(); };
    box.appendChild(row);
  });
}
function renderPoll() {
  const p = S.poll;
  if (isHost()) {
    fillPoll($('#pollRes'), p, true, false);
    $('#pollState').textContent = p ? (p.open ? '🟢 Ochiq · ' : '🔴 Yopilgan · ') + p.votes.reduce((a, b) => a + b, 0) + ' ovoz' : '';
    return;
  }
  $('#pollCard').hidden = !p;
  if (!p) return;
  $('#pollQShow').textContent = '🗳 ' + p.q;
  const done = S.myVote != null || !p.open;
  fillPoll($('#pollOpts'), p, done, true);
  $('#pollNote').textContent = p.open ? (S.myVote != null ? 'Ovozingiz qabul qilindi' : 'Variantni tanlang') : 'So\'rovnoma yopilgan';
}
$('#pollOpen').onclick = () => send({ type: 'poll-open', q: $('#pollQ').value, opts: [...document.querySelectorAll('.pollOpt')].map(i => i.value) });
$('#pollClose').onclick = () => send({ type: 'poll-close' });
$('#pollClear').onclick = () => send({ type: 'poll-clear' });

// ------------------------------------------------------------ VIKTORINA (Kahoot kabi): savollar tuzish, Word import, o'yin, reyting
const QCOL = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];
const stkOn = () => !(S.quiz && S.quiz.stickers === false);           // viktorinada stikerlar (avatarlar) yoqilganmi
const stk = a => (stkOn() ? (a || '') : '');
const AVATARS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🦆','🦉','🦄','🐝','🦋','🐢','🐙','🦀','🐬','🐳','🦈','🐊','🦒','🦓','🐘','🦔','🐿️','🦜','🦩',
  '🍎','🍌','🍇','🍓','🍉','🍊','🍋','🍍','🥝','🍒','🍑','🥭','🍐','🥥','🍅','🥕','🌽','🍄','🌵','🌻','⭐','🚀','🎈','⚽','🎸','🍕','🍩','🍦'];
try { S.av = localStorage.getItem('sc_av') || null; if (S.av && !AVATARS.includes(S.av)) S.av = null; } catch {}
const QSHAPE = ['▲', '◆', '●', '■'];
const ptU = () => (S.quiz && S.quiz.kahoot === false ? 'ta to\'g\'ri' : 'ball');          // Kahoot rejimi o'chiq: ball = to'g'ri javoblar soni
const QZ = { title: '', qs: [] };
Object.assign(S, { quiz: null, qMe: null, qAns: null, qProg: null });
const newQ = () => ({ text: '', img: null, opts: ['', '', '', ''], correct: 0, time: 20, pts: 'std', open: true, check: false });
const qel = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const QSKIP = ['imgSrc', 'imgUrl', 'imgRoom', 'open', 'check'];

// Muharrir (savollar studiyasi) ikki rejimda ishlaydi: 'quiz' (🎯 Viktorina) va 'hw' (📝 Uyga vazifa) — savollari alohida saqlanadi
let QMODE = 'quiz';
const QKEY = { quiz: 'sc_quiz', hw: 'sc_hw' };
let qzSaveT = null;
function qzSaveNow() {
  clearTimeout(qzSaveT);
  const key = QKEY[QMODE];
  try { localStorage.setItem(key, JSON.stringify({ title: QZ.title, qs: QZ.qs }, (k, v) => (QSKIP.includes(k) ? undefined : v))); }
  catch { try { localStorage.setItem(key, JSON.stringify({ title: QZ.title, qs: QZ.qs.map(q => ({ ...q, img: null })) }, (k, v) => (QSKIP.includes(k) ? undefined : v))); } catch {} }
}
function qzSave() { clearTimeout(qzSaveT); qzSaveT = setTimeout(qzSaveNow, 500); }
function qzLoad() {
  QZ.title = ''; QZ.qs = [];
  try {
    const d = JSON.parse(localStorage.getItem(QKEY[QMODE]) || 'null');
    if (d && Array.isArray(d.qs)) { QZ.title = d.title || ''; QZ.qs = d.qs.map(q => Object.assign(newQ(), q, { open: false, check: false })); }
  } catch {}
}
function qzSetMode(m) {                                      // tab almashganda: joriy ro'yxat saqlanadi, boshqasi yuklanadi, muharrir mos panelga ko'chadi
  const ed = $('#qzEditor'), hostEl = m === 'hw' ? $('#hwEditorHost') : $('#tabQuiz');
  if (m !== QMODE) { qzSaveNow(); QMODE = m; qzLoad(); }
  if (ed.parentNode !== hostEl) hostEl.appendChild(ed);
  const hw = m === 'hw';
  if (ed.classList.contains('hw-mode') === hw && ed.dataset.m === m) return;
  ed.dataset.m = m; ed.classList.toggle('hw-mode', hw);
  $('#qzH2').textContent = hw ? '📝 Uyga vazifa savollari' : '🎯 Viktorina studiyasi';
  $('#qzTitle').placeholder = hw ? 'Vazifa nomi (masalan: 5-mavzu uyga vazifasi)' : 'Viktorina nomi (masalan: Tarix bilimdonlari)';
  $('#qzStart').textContent = qzStartText();
  qzRender(); hwPassUI();
}
const qzStartText = () => (QMODE === 'hw' ? '▶ Vazifani boshlash' : '▶ O\'yinni boshlash');

// ---- rasm: kichraytirib JPEG'ga o'tkazish (tez yuklanishi uchun)
async function imgToDataUrl(blob) {
  const bmp = await createImageBitmap(blob);
  const sc = Math.min(1, 960 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.78);
}
async function uploadQImg(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const r = await fetch(`/api/rooms/${S.code}/qimg?key=${encodeURIComponent(S.key)}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'upload');
  return j.url;
}

// ---- rasmlarni savollarga ketma-ket biriktirish: 1-rasm → 1-savol, 2-rasm → 2-savol …
async function qzBulkImages(fileList, qs, onDone) {
  let files = [...fileList].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif)$/i.test(f.name));
  if (!files.length) { toast('Rasm fayllari tanlanmadi'); return; }
  if (!qs.length) { toast('Avval savollarni qo\'shing yoki import qiling', 4500); return; }
  if (files.length > 200) { files = files.slice(0, 200); toast('Bir yo\'la 200 tagacha rasm olinadi', 4000); }
  const nat = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const picked = files.slice(), byName = files.slice().sort(nat);
  const conv = new Map(); let bad = 0;
  for (let i = 0; i < files.length; i++) {
    toast(`⏳ Rasmlar tayyorlanmoqda ${i + 1}/${files.length}`, 1500);
    try { conv.set(files[i], { name: files[i].name, url: await imgToDataUrl(files[i]) }); } catch { bad++; }
  }
  if (bad) toast(`⚠ ${bad} ta rasmni o'qib bo'lmadi (masalan HEIC) — JPG/PNG qiling`, 5500);
  const mkItems = sorted => (sorted ? byName : picked).filter(f => conv.has(f)).map(f => conv.get(f));
  if (!conv.size) return;

  const o = { start: 1, sort: true, over: true };
  let items = mkItems(o.sort);
  const ov = qel('div', 'qz-prev qbi'), card = qel('div', 'qz-prev-card');
  const close = () => ov.remove();
  const ctl = qel('div', 'qbi-ctl');
  const sIn = document.createElement('input'); sIn.type = 'number'; sIn.min = 1; sIn.max = qs.length; sIn.value = '1'; sIn.inputMode = 'numeric'; sIn.className = 'qbi-n-in';
  const lab = (txt, el) => { const l = qel('label', 'qbi-lab'); l.append(qel('span', '', txt), el); return l; };
  const chk = (txt, key, fn) => { const c = document.createElement('input'); c.type = 'checkbox'; c.checked = o[key]; c.onchange = () => { o[key] = c.checked; fn && fn(); paint(); }; const l = qel('label', 'qbi-lab'); l.append(c, qel('span', '', txt)); return l; };
  sIn.oninput = () => { o.start = Math.min(qs.length, Math.max(1, Math.round(Number(sIn.value)) || 1)); paint(); };
  ctl.append(lab('Boshlanadigan savol №', sIn), chk('Fayl nomi bo\'yicha tartiblash (1, 2, … 10)', 'sort', () => { items = mkItems(o.sort); }), chk('Savolda rasm bo\'lsa — almashtirish', 'over'));
  const info = qel('div', 'qz-prev-info'), list = qel('div', 'qz-prev-list'), bar = qel('div', 'btn-row');
  const targets = () => qs.map((q, i) => i).filter(i => i >= o.start - 1 && (o.over || !qs[i].img));
  function paint() {
    const tg = targets(), n = Math.min(items.length, tg.length);
    info.textContent = '';
    info.appendChild(qel('div', '', `🖼 ${items.length} ta rasm → ${n} ta savol (${n ? '#' + (tg[0] + 1) + ' dan #' + (tg[n - 1] + 1) + ' gacha' : '—'})`));
    if (items.length > tg.length) info.appendChild(qel('div', 'qz-prev-w', `⚠ ${items.length - tg.length} ta rasm ortiqcha (savol yetmaydi) — ular qo'yilmaydi.`));
    else if (items.length < tg.length) info.appendChild(qel('div', 'muted', `ℹ Oxirgi ${tg.length - items.length} ta savol rasmsiz qoladi.`));
    list.textContent = '';
    items.forEach((it, k) => {
      const used = k < n, row = qel('div', 'qbi-row' + (used ? '' : ' off'));
      const q = used ? qs[tg[k]] : null;
      const th = document.createElement('img'); th.src = it.url; th.alt = ''; th.className = 'qbi-th';
      const txt = qel('div', 'qbi-t');
      txt.append(qel('b', '', used ? `#${tg[k] + 1}  ` : '✕  '), document.createTextNode(used ? (q.text || '(savol matni yo\'q)') : 'Savol yetmaydi — qo\'yilmaydi'), qel('small', '', it.name));
      const mv = (t, title, fn) => { const b = qel('button', 'qbi-mv', t); b.type = 'button'; b.title = title; b.onclick = fn; return b; };
      row.append(qel('span', 'qbi-no', String(k + 1)), th, txt,
        mv('▲', 'Yuqoriga', () => { if (k > 0) { [items[k - 1], items[k]] = [items[k], items[k - 1]]; paint(); } }),
        mv('▼', 'Pastga', () => { if (k < items.length - 1) { [items[k + 1], items[k]] = [items[k], items[k + 1]]; paint(); } }),
        mv('✕', 'Bu rasmni olib tashlash', () => { items.splice(k, 1); paint(); }));
      list.appendChild(row);
    });
    ok.disabled = !n;
  }
  const ok = qel('button', 'primary', '✅ Biriktirish'), no = qel('button', 'sec', 'Bekor');
  ok.onclick = () => {
    const tg = targets(), n = Math.min(items.length, tg.length);
    for (let k = 0; k < n; k++) qs[tg[k]].img = items[k].url;
    if (typeof qzSave === 'function') qzSave();
    close(); if (onDone) onDone();
    toast(`✅ ${n} ta savolga rasm qo'yildi`);
  };
  no.onclick = close;
  bar.append(ok, no);
  card.append(qel('h3', '', '🖼 Rasmlarni savollarga joylash'), ctl, info, list, bar); ov.appendChild(card);
  ov.onclick = e => { if (e.target === ov) close(); };
  document.body.appendChild(ov); paint();
}

// ---- editor
function qzRender() {
  $('#qzTitle').value = QZ.title;
  const box = $('#qzList'); box.textContent = '';
  QZ.qs.forEach((q, qi) => {
    const card = qel('div', 'card qcard' + (q.check ? ' warn' : ''));
    const head = qel('div', 'qc-head');
    const sum = qel('span', 'qc-sum', q.text || '(savol matni yo\'q)');
    const bt = (t, title, fn) => { const b = qel('button', '', t); b.title = title; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
    head.append(qel('b', '', '#' + (qi + 1)), sum,
      bt('▲', 'Yuqoriga', () => { if (qi > 0) { [QZ.qs[qi - 1], QZ.qs[qi]] = [QZ.qs[qi], QZ.qs[qi - 1]]; qzSave(); qzRender(); } }),
      bt('▼', 'Pastga', () => { if (qi < QZ.qs.length - 1) { [QZ.qs[qi + 1], QZ.qs[qi]] = [QZ.qs[qi], QZ.qs[qi + 1]]; qzSave(); qzRender(); } }),
      bt('⧉', 'Nusxa', () => { QZ.qs.splice(qi + 1, 0, JSON.parse(JSON.stringify(q))); qzSave(); qzRender(); }),
      bt('🗑', 'O\'chirish', () => { QZ.qs.splice(qi, 1); qzSave(); qzRender(); }));
    head.onclick = () => { q.open = !q.open; qzRender(); };
    card.appendChild(head);
    if (q.open) {
      const body = qel('div', 'qc-body');
      const ta = document.createElement('textarea'); ta.rows = 2; ta.maxLength = 240; ta.placeholder = 'Savol matni'; ta.value = q.text;
      ta.oninput = () => { q.text = ta.value; sum.textContent = q.text || '(savol matni yo\'q)'; qzSave(); };
      body.appendChild(ta);
      const imgRow = qel('div', 'btn-row');
      const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.hidden = true;
      fi.onchange = async () => {
        if (!fi.files[0]) return;
        try { q.img = await imgToDataUrl(fi.files[0]); qzSave(); qzRender(); } catch { toast('Rasmni o\'qib bo\'lmadi'); }
      };
      const addI = qel('button', 'sec', q.img ? '🖼 Rasmni almashtirish' : '🖼 Rasm qo\'shish'); addI.onclick = () => fi.click();
      imgRow.append(addI, fi);
      if (q.img) { const rm = qel('button', 'sec', '✕ Rasmni olib tashlash'); rm.onclick = () => { q.img = null; qzSave(); qzRender(); }; imgRow.appendChild(rm); }
      body.appendChild(imgRow);
      if (q.img) { const im = qel('img', 'qc-img'); im.src = q.img; body.appendChild(im); }
      q.opts.forEach((o, oi) => {
        const row = qel('div', 'qopt-row');
        const rd = document.createElement('input'); rd.type = 'radio'; rd.name = 'qc' + qi; rd.checked = q.correct === oi; rd.title = 'To\'g\'ri javob';
        rd.onchange = () => { q.correct = oi; q.check = false; card.classList.remove('warn'); qzSave(); };
        const inp = document.createElement('input'); inp.maxLength = 120; inp.placeholder = `${oi + 1}-variant${oi > 1 ? ' (ixtiyoriy)' : ''}`; inp.value = o;
        inp.oninput = () => { q.opts[oi] = inp.value; qzSave(); };
        const tile = qel('span', 'tile', QSHAPE[oi]); tile.style.background = QCOL[oi];
        row.append(rd, tile, inp); body.appendChild(row);
      });
      const set = qel('div', 'qc-set');
      const st = qel('label', 'qc-time'); st.append(qel('span', '', '⏱ Vaqt:'));
      const ti = document.createElement('input'); ti.type = 'number'; ti.min = 5; ti.max = 120; ti.step = 1; ti.inputMode = 'numeric'; ti.value = String(q.time); ti.setAttribute('aria-label', 'Savol vaqti (soniya)');
      ti.oninput = () => { const v = Math.round(Number(ti.value)); if (v >= 5 && v <= 120) { q.time = v; qzSave(); qzSummaryUpd(); } };
      ti.onchange = () => { q.time = Math.min(120, Math.max(5, Math.round(Number(ti.value)) || 20)); ti.value = String(q.time); qzSave(); qzSummaryUpd(); };
      st.append(ti, qel('span', '', 'soniya'));
      const sp = document.createElement('select');
      [['std', '⭐ Oddiy ball (1000 / 1 ta)'], ['double', '✨ Ikki baravar (2000 / 2 ta)'], ['none', '🚫 Ballsiz']].forEach(([v, t]) => sp.add(new Option(t, v))); sp.value = q.pts;
      sp.onchange = () => { q.pts = sp.value; qzSave(); };
      set.append(st, sp); body.appendChild(set);
      if (q.check) body.appendChild(qel('p', 'muted warn-t', '⚠ To\'g\'ri javobni belgilang (yashil doira).'));
      card.appendChild(body);
    }
    box.appendChild(card);
  });
  qzSummaryUpd();
}
// O'ynaladigan savollar: "O'yinda nechta savol" (bo'sh = hammasi) va "aralashtirish" bo'yicha tanlanadi
function qzPlayN() { const v = Math.round(Number($('#qzPlayN').value)); return v >= 1 ? Math.min(v, QZ.qs.length) : QZ.qs.length; }
function qzPlayList() {
  const n = qzPlayN();
  if (n >= QZ.qs.length) return $('#qzShuffle').checked ? shuffled(QZ.qs) : QZ.qs.slice();
  if (!$('#qzShuffle').checked) return QZ.qs.slice(0, n);
  const idx = shuffled(QZ.qs.map((_, i) => i)).slice(0, n).sort((a, b) => a - b);        // tasodifiy N ta (asl tartibda)
  return idx.map(i => QZ.qs[i]);
}
function shuffled(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }
function qzSummaryUpd() {
  hwNeedUpd();
  const el = $('#qzSummary'); if (!el) return;
  if (!QZ.qs.length) { el.textContent = 'Hali savol yo\'q. "＋ Savol qo\'shish" yoki Word/matndan import qiling.'; return; }
  const n = qzPlayN(), pl = n < QZ.qs.length ? ($('#qzShuffle').checked ? shuffled(QZ.qs).slice(0, n) : QZ.qs.slice(0, n)) : QZ.qs;
  const mins = Math.max(1, Math.round(pl.reduce((a, q) => a + q.time + 8, 0) / 60));
  el.textContent = `${QZ.qs.length} ta savol` + (n < QZ.qs.length ? ` · o'ynaladi: ${n} ta` : '') + ` · taxminan ${mins} daqiqa` + (QMODE === 'hw' ? ` · o'tish: kamida ${hwNeedN(n)} ta (${hwPass()}%)` : '');
}
$('#qzAllTime').value = (() => { try { return localStorage.getItem('sc_qalltime') || '20'; } catch { return '20'; } })();
$('#qzAllTimeGo').onclick = () => {
  const v = Math.min(120, Math.max(5, Math.round(Number($('#qzAllTime').value) || 20)));
  $('#qzAllTime').value = v; try { localStorage.setItem('sc_qalltime', String(v)); } catch {}
  if (!QZ.qs.length) { toast('Avval savol qo\'shing'); return; }
  QZ.qs.forEach(q => { q.time = v; }); qzSave(); qzRender(); toast(`⏱ Hamma savolga ${v} soniya qo'yildi`);
};
try { const n = localStorage.getItem('sc_qplayn'); if (n) $('#qzPlayN').value = n; $('#qzShuffle').checked = localStorage.getItem('sc_qshuffle') === '1'; } catch {}
$('#qzPlayN').oninput = () => { try { localStorage.setItem('sc_qplayn', $('#qzPlayN').value); } catch {} qzSummaryUpd(); };
$('#qzPlayAll').onclick = () => { $('#qzPlayN').value = ''; try { localStorage.removeItem('sc_qplayn'); } catch {} qzSummaryUpd(); };
$('#qzShuffle').onchange = () => { try { localStorage.setItem('sc_qshuffle', $('#qzShuffle').checked ? '1' : '0'); } catch {} qzSummaryUpd(); };
function qzValidate() {
  if (!QZ.qs.length) return 'Kamida bitta savol qo\'shing';
  for (let i = 0; i < QZ.qs.length; i++) {
    const q = QZ.qs[i];
    let err = null;
    if (!q.text.trim()) err = `${i + 1}-savol matni bo'sh`;
    else if (q.opts.filter(o => o.trim()).length < 2) err = `${i + 1}-savolda kamida 2 ta variant kerak`;
    else if (!q.opts[q.correct] || !q.opts[q.correct].trim()) { err = `${i + 1}-savolda to'g'ri javobni belgilang`; q.check = true; }
    if (err) { q.open = true; qzRender(); return err; }
  }
  return null;
}

// ---- import: matn va Word
function parseQuizLines(lines) {
  const reQ = /^\s*(?:(?:savol|question|вопрос|q)\s*)?(\d{1,3})\s*[.)\-:]\s*(.*)$/i;
  const reO = /^\s*\(?([A-Fa-f])\s*[.)\-:]\s*(.*)$/;
  const reBul = /^\s*[-•▪●○]\s+(.+)$/;
  const reAns = /^\s*(?:javob|to['’`]?g['’`]?ri\s*javob|to['’`]?g['’`]?ri|answer|correct(?:\s*answer)?|ответ)\s*[:=\-–]\s*\(?([A-Fa-f1-6])\)?/i;
  const reTime = /^\s*(?:vaqt|time|время)\s*[:=]\s*(\d{1,3})/i;
  const rePts = /^\s*(?:ball|points?|очки)\s*[:=]\s*(.+)$/i;
  const reMark = /\s*(\*+|✓|✔|\(\s*\+\s*\)|\[\s*\+\s*\]|\((?:to['’`]?g['’`]?ri|correct|right)\))\s*$/i;
  const txOf = l => String((l && l.text) || '').replace(/\u00a0/g, ' ').trim();
  const out = []; let cur = null, pend = [], warn = 0;
  const fin = () => {
    if (!cur) return;
    const o = cur.o;
    if (cur.correct < 0) { const bs = o.map((x, i) => (x.b ? i : -1)).filter(i => i >= 0); if (bs.length === 1 && bs.length < o.length) cur.correct = bs[0]; }
    const bad = cur.correct < 0 || cur.correct >= 4 || o.length < 2;
    out.push(Object.assign(newQ(), { text: cur.text.slice(0, 240), img: cur.img, opts: [0, 1, 2, 3].map(i => (o[i] ? o[i].t : '')), correct: bad ? 0 : cur.correct, time: cur.time, pts: cur.pts, open: false, check: bad }));
    if (bad) warn++;
    cur = null;
  };
  const startQ = (text, ln, imgs) => {
    fin();
    cur = { text: text.trim(), img: null, o: [], correct: -1, time: 20, pts: 'std', qNum: ln.lvl >= 0 ? ln.numId : null };
    if (pend.length) { cur.img = pend[0]; pend = []; }
    if (imgs.length && !cur.img) cur.img = imgs[0];
  };
  const addOpt = (text, ln, imgs) => {
    let mark = false;
    text = text.replace(reMark, () => { mark = true; return ''; }).trim();
    if (text) { cur.o.push({ t: text.slice(0, 120), b: !!ln.bold }); if (mark) cur.correct = cur.o.length - 1; }
    if (imgs.length && !cur.img) cur.img = imgs[0];
  };
  const optLike = l => { const t = txOf(l); return !!t && (reO.test(t) || reBul.test(t) || l.lvl >= 0); };
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li], tx = txOf(ln), imgs = ln.imgs || [];
    if (!tx) { if (imgs.length) { if (cur) { if (!cur.img) cur.img = imgs[0]; } else pend.push(...imgs); } continue; }
    let m;
    if (cur && (m = reAns.exec(tx))) { const ch = m[1]; cur.correct = /\d/.test(ch) ? Number(ch) - 1 : ch.toUpperCase().charCodeAt(0) - 65; continue; }
    if (cur && (m = reTime.exec(tx))) { cur.time = clamp(Number(m[1]), 5, 120); continue; }
    if (cur && (m = rePts.exec(tx))) { const v = m[1].toLowerCase(); cur.pts = /x\s*2|2\s*x|double|ikki|\b2\b|2000/.test(v) ? 'double' : /\b0\b|yo['’`]?q|none|\bno\b|ballsiz/.test(v) ? 'none' : 'std'; continue; }
    const mq = reQ.exec(tx), mo = reO.exec(tx), mb = reBul.exec(tx);
    if (mq && (!cur || cur.o.length >= 2)) { startQ(mq[2], ln, imgs); continue; }          // "1. Savol..."
    if (mo && cur) { addOpt(mo[2], ln, imgs); continue; }                                  // "A) variant"
    if (mq && cur && cur.o.length < 2) { addOpt(mq[2], ln, imgs); continue; }              // "1) variant"
    if (mb && cur) { addOpt(mb[1], ln, imgs); continue; }                                  // "- variant"
    if (ln.lvl >= 0) {                                                                      // Word'ning avto-ro'yxati (belgisiz)
      if (!cur || (cur.o.length >= 2 && ln.numId === cur.qNum)) startQ(tx, ln, imgs); else addOpt(tx, ln, imgs);
      continue;
    }
    if (!cur) { if (optLike(lines.slice(li + 1).find(l => txOf(l)))) startQ(tx, ln, imgs); continue; }   // belgisiz savol matni, ostida variantlar
    if (cur.o.length === 0) { cur.text += ' ' + tx; if (imgs.length && !cur.img) cur.img = imgs[0]; continue; }
    if (cur.o.length >= 2) { startQ(tx, ln, imgs); continue; }
    if (imgs.length && !cur.img) cur.img = imgs[0];
  }
  fin();
  return { qs: out, warn };
}
function qzImportQs(res, src) {
  if (!res.qs.length) { toast(`${src}da savol topilmadi. Format qo'llanmani ko'ring.`, 5000); return; }
  QZ.qs.push(...res.qs); qzSave(); qzRender();
  toast(`✅ ${res.qs.length} ta savol import qilindi${res.warn ? ` · ${res.warn} tasida to'g'ri javobni belgilang` : ''}`, 6000);
}

// .docx = zip: kutubxonasiz o'qiymiz (DecompressionStream)
async function unzipDocx(buf, want) {
  want = want || (name => name === 'word/document.xml' || name === 'word/_rels/document.xml.rels' || name.startsWith('word/media/'));
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip');
  const n = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
  const out = new Map(), dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nlen));
    off += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.subarray(start, start + csize);
    out.set(name, method === 0 ? raw.slice() : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  }
  return out;
}
async function docxToLines(file) {
  if (typeof DecompressionStream === 'undefined') throw new Error('nodecomp');
  const files = await unzipDocx(await file.arrayBuffer());
  const dx = files.get('word/document.xml');
  if (!dx) throw new Error('nodoc');
  const dec = new TextDecoder(), P = s => new DOMParser().parseFromString(dec.decode(s), 'application/xml');
  const doc = P(dx), rels = new Map(), rx = files.get('word/_rels/document.xml.rels');
  if (rx) P(rx).querySelectorAll('Relationship').forEach(r => rels.set(r.getAttribute('Id'), r.getAttribute('Target')));
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', A = 'http://schemas.openxmlformats.org/drawingml/2006/main', RN = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const lines = [];
  for (const p of doc.getElementsByTagNameNS(W, 'p')) {
    let text = '', boldLen = 0, totLen = 0;
    for (const r of p.getElementsByTagNameNS(W, 'r')) {
      let t = '';
      for (const ch of r.childNodes) { if (ch.localName === 't') t += ch.textContent; else if (ch.localName === 'tab') t += ' '; else if (ch.localName === 'br') t += '\n'; }
      if (!t) continue;
      const rpr = r.getElementsByTagNameNS(W, 'rPr')[0];
      const b = !!rpr && [...rpr.children].some(c => ['b', 'u', 'highlight'].includes(c.localName) && !['0', 'false', 'none'].includes(c.getAttributeNS(W, 'val')));
      const len = t.replace(/\s/g, '').length; totLen += len; if (b) boldLen += len;
      text += t;
    }
    const refs = [];
    for (const bl of p.getElementsByTagNameNS(A, 'blip')) refs.push(rels.get(bl.getAttributeNS(RN, 'embed')));
    for (const im of p.getElementsByTagName('v:imagedata')) refs.push(rels.get(im.getAttributeNS(RN, 'id')));
    const imgs = [];
    for (const tg of refs) {
      if (!tg) continue;
      const bytes = files.get(tg.startsWith('/') ? tg.slice(1) : 'word/' + tg);
      const mime = MIME[(tg.split('.').pop() || '').toLowerCase()];
      if (!bytes || !mime) continue;                                  // emf/wmf kabi formatlar o'tkazib yuboriladi
      try { imgs.push(await imgToDataUrl(new Blob([bytes], { type: mime }))); } catch {}
    }
    const bold = totLen > 0 && boldLen / totLen >= 0.6;
    const np = p.getElementsByTagNameNS(W, 'numPr')[0];
    let lvl = -1, numId = null;
    if (np) {
      const il = np.getElementsByTagNameNS(W, 'ilvl')[0], ni = np.getElementsByTagNameNS(W, 'numId')[0];
      lvl = il ? Number(il.getAttributeNS(W, 'val') || 0) : 0; numId = ni ? ni.getAttributeNS(W, 'val') : null;
      if (numId === '0') lvl = -1;
    }
    text.split('\n').forEach((t, i) => lines.push({ text: t, bold, imgs: i === 0 ? imgs : [], lvl: i === 0 ? lvl : -1, numId }));
    if (!text && imgs.length) lines.push({ text: '', bold: false, imgs, lvl: -1 });
  }
  return lines;
}

$('#qzAdd').onclick = () => { QZ.qs.forEach(q => { q.open = false; }); QZ.qs.push(newQ()); qzSave(); qzRender(); };
$('#qzBulkImg').onclick = () => $('#qzBulkIn').click();
$('#qzBulkIn').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) qzBulkImages(fs, QZ.qs, qzRender); };
$('#qzTitle').oninput = e => { QZ.title = e.target.value; qzSave(); };
$('#qzDocx').onclick = () => $('#qzDocxIn').click();
$('#qzDocxIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
$('#qzTxtGo').onclick = () => { const t = $('#qzTxt').value; if (!t.trim()) return; qzPreview(smartText(t), 'Matnda'); $('#qzTxt').value = ''; };

// ---- yaxshilangan import: Word / Excel (.xlsx) / CSV / JSON / matn  +  oldindan ko'rish  +  tayyor shablon
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  const cnt = ch => first.split(ch).length - 1, tb = cnt('\t'), sc = cnt(';'), cm = cnt(',');
  const delim = tb >= 1 && tb >= sc && tb >= cm ? '\t' : sc > cm ? ';' : ',';       // Excel (;), Google Sheets (,), jadval nusxasi (Tab)
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && cur === '') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// Excel ichiga qo'yilgan rasmlar (Insert → Picture): qaysi qatorga joylashtirilgan bo'lsa, o'sha qatordagi savolga biriktiriladi
async function xlsxImages(files, sheetName, xml) {
  const out = new Map();
  try {
    const NS = { XDR: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', A: 'http://schemas.openxmlformats.org/drawingml/2006/main', R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' };
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    const base = sheetName.split('/').pop();
    const sheet = xml(sheetName), srels = xml(`xl/worksheets/_rels/${base}.rels`);
    const dr = sheet && sheet.getElementsByTagName('drawing')[0];
    if (!dr || !srels) return out;
    const rid = dr.getAttributeNS(NS.R, 'id') || dr.getAttribute('r:id');
    let dpath = ''; srels.querySelectorAll('Relationship').forEach(r => { if (r.getAttribute('Id') === rid) dpath = r.getAttribute('Target'); });
    if (!dpath) return out;
    dpath = dpath.startsWith('/') ? dpath.slice(1) : 'xl/' + dpath.replace(/^\.\.\//, '');
    const dd = xml(dpath), dbase = dpath.split('/').pop(), drels = xml(`xl/drawings/_rels/${dbase}.rels`), map = new Map();
    if (!dd) return out;
    if (drels) drels.querySelectorAll('Relationship').forEach(r => map.set(r.getAttribute('Id'), r.getAttribute('Target')));
    for (const an of [...dd.documentElement.children]) {
      if (!['twoCellAnchor', 'oneCellAnchor'].includes(an.localName)) continue;
      const from = an.getElementsByTagNameNS(NS.XDR, 'from')[0], rowEl = from && from.getElementsByTagNameNS(NS.XDR, 'row')[0];
      const bl = an.getElementsByTagNameNS(NS.A, 'blip')[0];
      if (!rowEl || !bl) continue;
      const tg = map.get(bl.getAttributeNS(NS.R, 'embed') || bl.getAttribute('r:embed')); if (!tg) continue;
      const bytes = files.get(tg.startsWith('/') ? tg.slice(1) : 'xl/' + tg.replace(/^\.\.\//, ''));
      const mime = MIME[(tg.split('.').pop() || '').toLowerCase()];
      if (!bytes || !mime) continue;
      let url = null; try { url = await imgToDataUrl(new Blob([bytes], { type: mime })); } catch {}
      if (!url) continue;
      const rn = Number(rowEl.textContent) + 1;
      if (!out.has(rn)) out.set(rn, []); out.get(rn).push(url);
    }
  } catch {}
  return out;
}
async function xlsxToRows(file) {
  if (typeof DecompressionStream === 'undefined') throw new Error('nodecomp');
  const files = await unzipDocx(await file.arrayBuffer(), n => /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml|worksheets\/_rels\/sheet\d+\.xml\.rels|drawings\/drawing\d+\.xml|drawings\/_rels\/drawing\d+\.xml\.rels|media\/[^/]+)$/.test(n));
  const dec = new TextDecoder(), xml = n => { const u = files.get(n); return u ? new DOMParser().parseFromString(dec.decode(u), 'application/xml') : null; };
  const ss = [], sx = xml('xl/sharedStrings.xml');
  if (sx) sx.querySelectorAll('si').forEach(si => ss.push([...si.querySelectorAll('t')].map(t => t.textContent).join('')));
  const names = [...files.keys()].filter(n => /worksheets\/sheet\d+\.xml$/.test(n)).sort((x, y) => parseInt(x.match(/(\d+)\.xml/)[1], 10) - parseInt(y.match(/(\d+)\.xml/)[1], 10));
  if (!names.length) throw new Error('sheet');
  const rows = [];
  rows.imgs = await xlsxImages(files, names[0], xml);
  xml(names[0]).querySelectorAll('row').forEach(r => {
    const arr = [];
    r.querySelectorAll('c').forEach(c => {
      const ref = c.getAttribute('r') || '', col = ref.replace(/\d+/g, '').split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1, t = c.getAttribute('t'), vEl = c.querySelector('v');
      let v = '';
      if (t === 's') v = ss[Number(vEl && vEl.textContent)] || '';
      else if (t === 'inlineStr') v = [...c.querySelectorAll('t')].map(x => x.textContent).join('');
      else v = vEl ? vEl.textContent : '';
      arr[col >= 0 ? col : arr.length] = v;
    });
    const ra = Array.from(arr, x => (x == null ? '' : x)); ra.rn = Number(r.getAttribute('r')) || rows.length + 1; rows.push(ra);
  });
  return rows;
}
// Jadval: sarlavhali (Savol | Variant A..D | To'g'ri javob | Vaqt | Ball; Kahoot shabloni ham tushuniladi) yoki sarlavhasiz (ustunlar shu tartibda)
function parseQuizTable(rows) {
  const imgMap = rows.imgs || null;
  rows = rows.map(r => { const a = r.map(c => String(c == null ? '' : c).replace(/\u00a0/g, ' ').trim()); a.rn = r.rn; return a; }).filter(r => r.some(Boolean));
  const notes = []; const out = []; const qRn = []; let warn = 0;
  if (!rows.length) return { qs: [], warn: 0, notes };
  const head = rows[0].map(h => h.toLowerCase());
  const reOpt = /^(?:(?:variant|answer|javob|option|вариант|ответ)\s*[-:_]?\s*)?([1-4a-d])(?:\s|$|[-:(])/;
  const reQH = /^(savol|question|вопрос)\b(?!\s*\d)/;                      // "Savol", "Question - max 120 characters" (lekin "Savol 1" / "Savol1" — ma'lumot)
  const hasHead = head.some(h => reQH.test(h));
  let col = { q: 0, o: [1, 2, 3, 4], c: 5, t: 6, p: 7 }, data = rows;
  if (hasHead) {
    data = rows.slice(1);
    col = { q: head.findIndex(h => reQH.test(h)), o: [-1, -1, -1, -1], c: -1, t: -1, p: -1 };
    head.forEach((h, i) => { const m = reOpt.exec(h); if (m) { const k = /\d/.test(m[1]) ? Number(m[1]) - 1 : m[1].charCodeAt(0) - 97; if (col.o[k] < 0) col.o[k] = i; } });
    const used = new Set(col.o);
    head.forEach((h, i) => {
      if (used.has(i) || i === col.q) return;
      if (col.c < 0 && /to['’`]?g['’`]?ri|correct|правильн|kalit|\bkey\b/.test(h)) col.c = i;
      else if (col.t < 0 && /vaqt|time|limit|время/.test(h)) col.t = i;
      else if (col.p < 0 && /ball|point|score|очки/.test(h)) col.p = i;
    });
    if (col.o.filter(i => i >= 0).length < 2) { notes.push('Variant ustunlari topilmadi — ustunlar tartibi (Savol, A, B, C, D, To\'g\'ri, Vaqt, Ball) deb olindi.'); col = { q: col.q < 0 ? 0 : col.q, o: [1, 2, 3, 4], c: 5, t: 6, p: 7 }; }
  }
  const reMark = /\s*(\*+|✓|✔|\(\s*\+\s*\)|\[\s*\+\s*\])\s*$/;
  data.forEach((r, ri) => {
    const rowNo = ri + (hasHead ? 2 : 1), text = (r[col.q] || '').trim();
    if (!text) return;
    let mark = -1;
    const opts = col.o.map((ci, k) => { let t = ci >= 0 ? (r[ci] || '') : ''; t = t.replace(reMark, () => { mark = k; return ''; }).trim(); return t.slice(0, 120); });
    if (opts.filter(Boolean).length < 2) { notes.push(`${rowNo}-qator: kamida 2 ta variant kerak — o'tkazib yuborildi`); return; }
    let correct = mark;
    const cv = col.c >= 0 ? (r[col.c] || '') : '';
    if (correct < 0 && cv) {
      const m = /^\s*([1-4a-d])\b/i.exec(cv);
      if (m) correct = /\d/.test(m[1]) ? Number(m[1]) - 1 : m[1].toLowerCase().charCodeAt(0) - 97;
      else { const k = opts.findIndex(o => o && o.toLowerCase() === cv.trim().toLowerCase()); if (k >= 0) correct = k; }          // to'g'ri javob matn bilan yozilgan
    }
    const bad = correct < 0 || !opts[correct];
    if (bad) { warn++; notes.push(`${rowNo}-qator: to'g'ri javob aniqlanmadi — editorda belgilang`); }
    const tv = col.t >= 0 ? parseInt(r[col.t] || '', 10) : NaN, pv = ((col.p >= 0 ? r[col.p] : '') || '').toLowerCase();   // qisqa qatorlarda ustun bo'lmasligi mumkin
    qRn.push(r.rn); out.push(Object.assign(newQ(), { text: text.slice(0, 240), opts, correct: bad ? Math.max(0, opts.findIndex(Boolean)) : correct, time: Number.isFinite(tv) ? clamp(tv, 5, 120) : 20,
      pts: /x\s*2|2\s*x|double|ikki|^2$|2000/.test(pv) ? 'double' : /^0$|yo['’`]?q|none|^no$|ballsiz/.test(pv) ? 'none' : 'std', open: false, check: bad }));
  });
  if (imgMap && imgMap.size && out.length) {                                  // rasmlarni savollarga biriktirish
    let n = 0;
    [...imgMap.entries()].sort((a, b) => a[0] - b[0]).forEach(([pr, urls]) => {
      let k = -1; qRn.forEach((rn, i) => { if (rn != null && rn <= pr) k = i; });       // rasm turgan qator yoki undan oldingi eng yaqin savol
      if (k < 0) k = 0;
      if (!out[k].img) { out[k].img = urls[0]; n++; }
    });
    if (n) notes.push(`🖼 ${n} ta rasm savollarga biriktirildi`);
  }
  return { qs: out, warn, notes };
}
function smartText(t) {                                                    // Excel/Sheets'dan nusxa olingan jadval (Tab) yoki oddiy matn
  const lines = t.split(/\r?\n/).filter(l => l.trim()), tabs = lines.filter(l => l.includes('\t')).length;
  if (lines.length > 1 && tabs >= lines.length * 0.6) return parseQuizTable(parseCSV(t));
  return parseQuizLines(t.split('\n').map(x => ({ text: x, bold: false, imgs: [] })));
}
async function importFile(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  toast('📥 Fayl o\'qilmoqda…', 2000);
  try {
    if (ext === 'docx') return qzPreview(parseQuizLines(await docxToLines(f)), 'Word faylda');
    if (ext === 'xlsx') return qzPreview(parseQuizTable(await xlsxToRows(f)), 'Excel faylda');
    if (ext === 'csv' || ext === 'tsv') return qzPreview(parseQuizTable(parseCSV(await f.text())), 'Jadvalda');
    if (ext === 'txt' || ext === 'md') return qzPreview(smartText(await f.text()), 'Matnda');
    if (ext === 'json') {
      const d = JSON.parse(await f.text());
      const qs = (d.qs || d.questions || []).map(q => Object.assign(newQ(), q, { open: false, check: false }));
      if (d.title && !QZ.title) QZ.title = d.title;
      return qzPreview({ qs, warn: 0, notes: [] }, 'JSON faylda');
    }
    toast('Bu format qo\'llab-quvvatlanmaydi. Mumkin: .docx, .xlsx, .csv, .json, .txt', 5000);
  } catch (err) {
    toast(err.message === 'nodecomp' ? 'Bu brauzer .docx/.xlsx ni o\'qiy olmaydi — CSV yoki matndan import qiling' : 'Faylni o\'qib bo\'lmadi. Shablondan foydalaning (⬇ tugma).', 5500);
  }
}
function qzPreview(res, srcName) {
  if (!res.qs.length) { toast(`${srcName} savol topilmadi. ⬇ Shablonni ko'ring.`, 5500); return; }
  document.querySelectorAll('.qz-prev').forEach(x => x.remove());
  const ov = qel('div', 'qz-prev'), card = qel('div', 'qz-prev-card');
  const head = qel('h3'), info = qel('div', 'qz-prev-info'), list = qel('div', 'qz-prev-list'), bar = qel('div', 'btn-row');
  const close = () => ov.remove();
  const paint = () => {
    const warnN = res.qs.filter(q => q.check).length;
    head.textContent = `📥 ${res.qs.length} ta savol topildi`;
    info.textContent = '';
    { const ni = res.qs.filter(q => q.img).length; info.appendChild(qel('div', 'muted', `🖼 Rasmli savollar: ${ni} / ${res.qs.length}`)); }
    if (warnN) info.appendChild(qel('div', 'qz-prev-w', `⚠ ${warnN} tasida to'g'ri javob aniqlanmadi — qo'shgach editorda belgilang.`));
    (res.notes || []).slice(0, 6).forEach(n => info.appendChild(qel('div', 'muted', '• ' + n)));
    if ((res.notes || []).length > 6) info.appendChild(qel('div', 'muted', `… yana ${res.notes.length - 6} ta izoh`));
    list.textContent = '';
    res.qs.forEach((q, i) => {
      const row = qel('div', 'qz-prev-row' + (q.check ? ' warn' : ''));
      row.appendChild(qel('b', '', `${i + 1}. ${q.text.length > 110 ? q.text.slice(0, 110) + '…' : q.text}`));
      const os = qel('div', 'qz-prev-o');
      q.opts.forEach((o, k) => { if (o) os.appendChild(qel('span', 'o' + (k === q.correct && !q.check ? ' ok' : ''), `${'ABCD'[k]} ${o.length > 40 ? o.slice(0, 40) + '…' : o}`)); });
      row.appendChild(os);
      const ib = qel('div', 'qz-prev-im'), fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.hidden = true;
      fi.onchange = async () => { const f = fi.files[0]; if (!f) return; try { q.img = await imgToDataUrl(f); paint(); } catch { toast('Rasmni o\'qib bo\'lmadi'); } };
      if (q.img) { const th = document.createElement('img'); th.src = q.img; th.className = 'qz-prev-th'; th.alt = ''; ib.appendChild(th); }
      const ab = qel('button', 'qz-prev-ib', q.img ? '🖼 Almashtirish' : '🖼 Rasm qo\'shish'); ab.onclick = () => fi.click(); ib.append(ab, fi);
      if (q.img) { const rm = qel('button', 'qz-prev-ib', '✕ Rasm'); rm.onclick = () => { q.img = null; paint(); }; ib.appendChild(rm); }
      row.appendChild(ib);
      const x = qel('button', 'qz-prev-x', '✕'); x.title = 'Bu savolni olib tashlash';
      x.onclick = () => { res.qs.splice(i, 1); if (!res.qs.length) close(); else paint(); };
      row.appendChild(x); list.appendChild(row);
    });
  };
  const add = qel('button', 'primary', '➕ Qo\'shish'), rpl = qel('button', 'sec', '♻ Eskilarini almashtirish'), no = qel('button', 'sec', 'Bekor');
  add.onclick = () => { QZ.qs.push(...res.qs); qzSave(); qzRender(); close(); toast(`✅ ${res.qs.length} ta savol qo'shildi`); };
  rpl.onclick = () => { if (QZ.qs.length && !confirm('Mavjud savollar o\'chirilib, yangilari qo\'yilsinmi?')) return; QZ.qs = res.qs.slice(); qzSave(); qzRender(); close(); toast(`✅ ${res.qs.length} ta savol qo'yildi`); };
  no.onclick = close;
  const bf = document.createElement('input'); bf.type = 'file'; bf.multiple = true; bf.accept = 'image/*'; bf.hidden = true;
  bf.onchange = () => { const fs = [...bf.files]; bf.value = ''; if (fs.length) qzBulkImages(fs, res.qs, paint); };
  const bulk = qel('button', 'sec', '🖼 Rasmlarni ketma-ket'); bulk.title = '1-rasm → 1-savol, 2-rasm → 2-savol …'; bulk.onclick = () => bf.click();
  bar.append(add, rpl, bulk, no, bf); card.append(head, info, list, bar); ov.appendChild(card);
  ov.onclick = e => { if (e.target === ov) close(); };
  document.body.appendChild(ov); paint();
}
// tayyor Excel shablon (.xlsx) — kutubxonasiz yoziladi
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files, type) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  files.forEach(([name, str]) => {
    const nb = enc.encode(name), data = enc.encode(str), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    cen.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + data.length;
  });
  const cs = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type });
}
$('#qzTpl').onclick = () => {
  const X = t => String(t).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const rows = [['Savol', 'Variant A', 'Variant B', 'Variant C', 'Variant D', 'To\'g\'ri javob (A-D)', 'Vaqt (soniya)', 'Ball (1x / 2x / 0)'],
    ['O\'zbekiston poytaxti qaysi shahar?', 'Samarqand', 'Toshkent', 'Buxoro', 'Xiva', 'B', '20', '1x'],
    ['Yer Quyosh atrofida aylanadi.', 'To\'g\'ri', 'Noto\'g\'ri', '', '', 'A', '15', '1x'],
    ['2 + 2 × 2 = ?', '8', '6', '4', '10', 'B', '30', '2x']];
  const colL = i => String.fromCharCode(65 + i);
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="44" customWidth="1"/><col min="2" max="5" width="18" customWidth="1"/><col min="6" max="8" width="20" customWidth="1"/></cols><sheetData>' +
    rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => `<c r="${colL(ci)}${ri + 1}" t="inlineStr"><is><t>${X(v)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const blob = makeZip([
    ['[Content_Types].xml', H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', H + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', H + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets><sheet name="Savollar" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', H + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', sheet],
  ], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'viktorina-shablon.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
};
$('#qzTplCsv').onclick = () => {
  const rows = [['Savol', 'Variant A', 'Variant B', 'Variant C', 'Variant D', 'To\'g\'ri javob (A-D)', 'Vaqt (soniya)', 'Ball (1x / 2x / 0)'],
    ['O\'zbekiston poytaxti qaysi shahar?', 'Samarqand', 'Toshkent', 'Buxoro', 'Xiva', 'B', '20', '1x'],
    ['Yer Quyosh atrofida aylanadi.', 'To\'g\'ri', 'Noto\'g\'ri', '', '', 'A', '15', '1x'],
    ['2 + 2 × 2 = ?', '8', '6', '4', '10', 'B', '30', '1x']];
  const csv = '\ufeff' + rows.map(r => r.map(c => (/[",;\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'viktorina-shablon.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
};
// fayl tashlash (drag & drop) — butun viktorina studiyasiga
const qzDz = $('#qzEditor');
['dragenter', 'dragover'].forEach(ev => qzDz.addEventListener(ev, e => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); qzDz.classList.add('dz'); } }));
['dragleave', 'drop'].forEach(ev => qzDz.addEventListener(ev, e => { qzDz.classList.remove('dz'); }));
qzDz.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) { e.preventDefault(); importFile(f); } });
$('#qzExport').onclick = () => {
  const data = JSON.stringify({ title: QZ.title, qs: QZ.qs }, (k, v) => (QSKIP.includes(k) ? undefined : v));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = (QZ.title || 'viktorina').replace(/[^\w\-]+/g, '_') + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('#qzImportJson').onclick = () => $('#qzJsonIn').click();
$('#qzJsonIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
$('#qzClear').onclick = () => { if (!QZ.qs.length || confirm('Barcha savollar o\'chirilsinmi?')) { QZ.qs = []; QZ.title = ''; qzSave(); qzRender(); } };
$('#qzStart').onclick = async () => {
  const eb = $('#qzErr'), btn = $('#qzStart');
  const err = qzValidate();
  eb.hidden = !err; if (err) { eb.textContent = err; return; }
  btn.disabled = true;
  try {
    const list = qzPlayList();
    const total = list.filter(q => q.img).length; let done = 0; const out = [];
    for (const q of list) {
      let url = null;
      if (q.img) {
        if (q.imgUrl && q.imgRoom === S.code && q.imgSrc === q.img) url = q.imgUrl;
        else { btn.textContent = `⏳ Rasmlar yuklanmoqda ${++done}/${total}`; url = await uploadQImg(q.img); q.imgUrl = url; q.imgRoom = S.code; q.imgSrc = q.img; }
      }
      out.push({ text: q.text, img: url, opts: q.opts, correct: q.correct, time: q.time, pts: q.pts });
    }
    const hw = QMODE === 'hw';
    send({ type: 'quiz-start', kind: hw ? 'hw' : 'quiz', hideOpts: $('#qzHide').checked, hideQ: $('#qzHideQ').checked, strict: $('#qzStrict').checked, strikes: Number($('#qzStrikes').value),
      ...(hw ? { pass: hwPass(), auto: $('#hwAuto').checked, kahoot: false, hostPlay: false, celebrate: false, stickers: false }
             : { celebrate: $('#qzCel').checked, stickers: $('#qzStk').checked, kahoot: qKahoot(), hostPlay: qHostPlay() }),
      quiz: { title: QZ.title || (hw ? 'Uyga vazifa' : 'Viktorina'), questions: out } });
  } catch { eb.textContent = 'Rasm yuklashda xato. Qayta urinib ko\'ring.'; eb.hidden = false; }
  btn.disabled = false; btn.textContent = qzStartText();
};

// ---- 🤝 Do'st bilan do'st: AI tanlangan miqdorda tasodifiy savol tuzadi
const aiCount = () => Math.min(30, Math.max(3, Math.round(Number($('#aiCount').value) || 11)));
const aiSecs = () => Math.min(120, Math.max(5, Math.round(Number($('#aiTime').value) || 15)));
function aiCountUI(save) {
  const n = aiCount();
  if (document.activeElement !== $('#aiCount')) $('#aiCount').value = n;
  document.querySelectorAll('#aiChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === n));
  const sec = n * (aiSecs() + 8);                                        // taxminan: savol vaqti + natija ko'rsatish
  $('#aiTotal').textContent = `≈ ${Math.max(1, Math.round(sec / 60))} daqiqalik o'yin`;
  if (!aiUI.busy) $('#aiStart').textContent = aiBtnText();
  if (save) { try { localStorage.setItem('sc_aiCount', String(n)); } catch {} }
}
let aiF = null;                                                          // 📎 yuklangan fayl: { name, size } (server xonada saqlaydi)
const aiBtnText = () => aiF ? '📎 Fayldan quiz boshlash (' + aiCount() + ' savol)' : '🎲 AI bilan boshlash (' + aiCount() + ' savol)';
const aiUI = {
  busy: false, t: 0,
  set(busy, err, noFile) {
    this.busy = busy; const b = $('#aiStart'), e = $('#aiErr');
    b.disabled = busy; clearTimeout(this.t);
    b.textContent = busy ? (aiF ? '⏳ AI faylni o\'qib, savol tuzmoqda…' : '⏳ AI savollar tuzmoqda…') : aiBtnText();
    e.hidden = !err; e.textContent = err || '';
    if (noFile && aiF) aiFileSet(null, true);                              // server faylni topolmadi: qayta yuklash kerak
    if (busy) this.t = setTimeout(() => this.set(false, 'AI javob bermadi. Qayta urinib ko\'ring.'), aiF ? 185000 : 125000);
  },
};
const aiProvider = () => { const r = document.querySelector('input[name="aiProv"]:checked'); return r ? r.value : 'gemini'; };
try { const v = localStorage.getItem('sc_aiProv'); const r = v && document.querySelector('input[name="aiProv"][value="' + v + '"]'); if (r) r.checked = true; } catch {}
document.querySelectorAll('input[name="aiProv"]').forEach(r => r.addEventListener('change', () => { try { localStorage.setItem('sc_aiProv', aiProvider()); } catch {} aiWarmSoon(); }));
fetch('/api/info').then(r => r.json()).then(d => {                    // kaliti yo'q xizmat o'chirib qo'yiladi
  const av = d && d.ai; if (!av) return;
  document.querySelectorAll('input[name="aiProv"]').forEach(r => { const ok = av[r.value] !== false; r.disabled = !ok; r.closest('.ai-pv').classList.toggle('na', !ok); });
  const cur = document.querySelector('input[name="aiProv"]:checked');
  if (cur && cur.disabled) { const alt = [...document.querySelectorAll('input[name="aiProv"]')].find(r => !r.disabled); if (alt) alt.checked = true; }
}).catch(() => {});
['aiTopic', 'aiLang', 'aiLevel', 'aiTime', 'aiCount'].forEach(id => { const el = $('#' + id), k = 'sc_' + id; try { const v = localStorage.getItem(k); if (v != null) el.value = v; } catch {} el.onchange = () => { try { localStorage.setItem(k, el.value); } catch {} }; });
$('#aiCount').value = aiCount();
$('#aiCount').oninput = () => aiCountUI(false);
$('#aiCount').onchange = () => { $('#aiCount').value = aiCount(); aiCountUI(true); };
$('#aiCount').onfocus = () => $('#aiCount').select();
$('#aiMinus').onclick = () => { $('#aiCount').value = aiCount() - 1; aiCountUI(true); };
$('#aiPlus').onclick = () => { $('#aiCount').value = aiCount() + 1; aiCountUI(true); };
document.querySelectorAll('#aiChips button').forEach(b => { b.onclick = () => { $('#aiCount').value = b.dataset.n; aiCountUI(true); }; });
function aiTimeUI(save) {
  const t = aiSecs();
  if (document.activeElement !== $('#aiTime')) $('#aiTime').value = t;
  document.querySelectorAll('#aiTChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.s) === t));
  if (save) { try { localStorage.setItem('sc_aiTime', String(t)); } catch {} }
  aiCountUI(false);
}
$('#aiTime').oninput = () => aiTimeUI(false);
$('#aiTime').onchange = () => { $('#aiTime').value = aiSecs(); aiTimeUI(true); };
$('#aiTime').onfocus = () => $('#aiTime').select();
$('#aiTMinus').onclick = () => { $('#aiTime').value = Math.max(5, aiSecs() - 5); aiTimeUI(true); };
$('#aiTPlus').onclick = () => { $('#aiTime').value = Math.min(120, aiSecs() + 5); aiTimeUI(true); };
document.querySelectorAll('#aiTChips button').forEach(b => { b.onclick = () => { $('#aiTime').value = b.dataset.s; aiTimeUI(true); }; });
$('#aiTime').value = aiSecs();
aiTimeUI(false);
aiCountUI(false);
$('#aiAuto').checked = localStorage.getItem('sc_aiauto') !== '0';
$('#aiAuto').onchange = e => localStorage.setItem('sc_aiauto', e.target.checked ? '1' : '0');
// ---- ball tizimi (Kahoot rejimi) va "Transmitter ham o'ynasin": Viktorina va AI bo'limlarida bir xil (sinxron) turadi, qurilmada eslab qolinadi
const QOPT = { kahoot: { ids: ['#qzKahoot', '#aiKahoot'], key: 'sc_qkahoot', def: true }, host: { ids: ['#qzHost', '#aiHost'], key: 'sc_qhost', def: false } };
Object.values(QOPT).forEach(o => {
  let v = o.def; try { const x = localStorage.getItem(o.key); if (x != null) v = x === '1'; } catch {}
  o.ids.forEach(id => { const el = $(id); el.checked = v; el.onchange = () => { o.ids.forEach(j => { $(j).checked = el.checked; }); try { localStorage.setItem(o.key, el.checked ? '1' : '0'); } catch {} }; });
});
const qKahoot = () => $('#qzKahoot').checked, qHostPlay = () => $('#qzHost').checked;
$('#aiStart').onclick = () => {
  if (aiUI.busy) return;
  aiUI.set(true);
  send({ type: 'quiz-ai', fromFile: !!aiF, topic: $('#aiTopic').value.trim(), level: $('#aiLevel').value, time: aiSecs(), count: aiCount(), lang: $('#aiLang').value, provider: aiF ? 'gemini' : aiProvider(), auto: $('#aiAuto').checked, kahoot: qKahoot(), hostPlay: qHostPlay(),
    hideOpts: $('#qzHide').checked, hideQ: $('#qzHideQ').checked, celebrate: $('#qzCel').checked, stickers: $('#qzStk').checked, strict: $('#qzStrict').checked, strikes: Number($('#qzStrikes').value) });
};

// ---- 📎 Fayldan quiz: JPG / PNG / HEIC / PDF yuklanadi, AI savollarni shu fayldan tuzadi
let aiFileMax = 60;                                                      // MB (server /api/info dan yangilaydi)
const AI_FILE_EXT = /\.(jpe?g|png|heic|heif|pdf)$/i;
const fmtMb = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
function aiFileErr(t) { const e = $('#aiFileErr'); e.hidden = !t; e.textContent = t || ''; }
function aiFileSet(f, keepErr) {
  aiF = f;
  $('#aiFileInfo').hidden = !f; $('#aiDrop').hidden = !!f;
  if (f) $('#aiFileName').textContent = '✅ ' + f.name + ' · ' + fmtMb(f.size);
  $('#aiProg').hidden = true; $('#aiFileIn').value = '';
  $('#aiReady').hidden = true;
  if (!keepErr) aiFileErr('');
  if (!aiUI.busy) $('#aiStart').textContent = aiBtnText();
}
let aiXhr = null;
// Katta rasm (telefon suratlari 5–15 MB) 2200 px gacha kichraytiriladi: yuklash va AI o'qishi bir necha barobar tezlashadi, matn baribir aniq o'qiladi
async function aiShrinkImage(file) {
  if (!/^image\//i.test(file.type) && !/\.(jpe?g|png|heic|heif)$/i.test(file.name)) return file;
  if (file.size < 1.5 * 1048576) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    if (k >= 1 && file.size < 4 * 1048576) { if (bmp.close) bmp.close(); return file; }
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {}                                                               // brauzer HEIC ni ochmasa — asl fayl yuboriladi (server o'zi o'qiydi)
  return file;
}
async function aiFileUpload(file) {
  aiFileErr('');
  if (!file) return;
  if (!isHost() || !S.code || !S.key) return aiFileErr('Avval xonaga ulaning');
  if (!AI_FILE_EXT.test(file.name) && !/^(image\/(jpeg|png|heic|heif)|application\/pdf)$/i.test(file.type)) return aiFileErr('Faqat JPG, PNG, HEIC yoki PDF fayl yuklang');
  if (file.size > aiFileMax * 1048576) return aiFileErr('Fayl ' + aiFileMax + ' MB dan katta (' + fmtMb(file.size) + ')');
  if (!file.size) return aiFileErr('Fayl bo\'sh');
  const bar = $('#aiProgBar'), box = $('#aiProg'), txt = $('#aiDropTxt');
  box.hidden = false; bar.style.width = '0'; $('#aiStart').disabled = true;
  txt.textContent = '⏳ Rasm tayyorlanmoqda…';
  file = await aiShrinkImage(file);
  const pr = `&count=${aiCount()}&level=${encodeURIComponent($('#aiLevel').value)}&lang=${encodeURIComponent($('#aiLang').value)}&topic=${encodeURIComponent($('#aiTopic').value.trim())}`;   // server savollarni oldindan tuzishi uchun
  const xhr = aiXhr = new XMLHttpRequest();
  xhr.open('POST', `/api/rooms/${S.code}/ai-file?key=${encodeURIComponent(S.key)}&name=${encodeURIComponent(file.name)}${pr}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = e => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); bar.style.width = p + '%'; txt.textContent = '⏳ Yuklanmoqda… ' + p + '% (' + fmtMb(e.loaded) + ' / ' + fmtMb(e.total) + ')'; } };
  const done = () => { aiXhr = null; $('#aiStart').disabled = aiUI.busy; txt.textContent = '📂 Fayl tanlang yoki shu yerga tashlang'; box.hidden = true; };
  xhr.onload = () => {
    done();
    let j = {}; try { j = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 200 && j.ok) aiFileSet({ name: j.name || file.name, size: j.size || file.size });
    else { $('#aiFileIn').value = ''; aiFileErr(j.error || 'Yuklashda xato (' + xhr.status + ')'); }
  };
  xhr.onerror = () => { done(); $('#aiFileIn').value = ''; aiFileErr('Tarmoq xatosi. Qayta urinib ko\'ring.'); };
  xhr.onabort = () => { done(); $('#aiFileIn').value = ''; };
  txt.textContent = '⏳ Yuklanmoqda…';
  xhr.send(file);
}
$('#aiFileIn').onchange = e => aiFileUpload(e.target.files && e.target.files[0]);
$('#aiFileX').onclick = () => {
  if (aiUI.busy) return;
  aiFileSet(null);
  if (S.code && S.key) fetch(`/api/rooms/${S.code}/ai-file?key=${encodeURIComponent(S.key)}`, { method: 'DELETE' }).catch(() => {});
  aiWarmSoon();
};
(() => {
  const d = $('#aiDrop');
  ['dragenter', 'dragover'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.remove('over'); }));
  d.addEventListener('drop', e => aiFileUpload(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
  d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#aiFileIn').click(); } });
})();
fetch('/api/info').then(r => r.json()).then(d => {
  if (d && d.aiFileMb) { aiFileMax = d.aiFileMb; $('#aiFileLim').textContent = 'JPG · PNG · HEIC · PDF · ' + aiFileMax + ' MB gacha'; }
  if (d && d.ai && d.ai.gemini === false) { $('#aiFile').classList.add('na'); $('#aiFileNote').textContent = 'Fayldan quiz tuzish uchun serverda GEMINI_API_KEY kerak.'; }
}).catch(() => {});

// ---- AI savollarni oldindan tayyorlash: bo'lim ochilganda va sozlamalar o'zgarganda fonda
let aiWarmT = 0;
function aiWarmSoon() {
  if (!isHost() || !S.joined || S.quiz) return;
  clearTimeout(aiWarmT);
  const e = $('#aiReady'); if (e) e.hidden = true;
  aiWarmT = setTimeout(() => send({ type: 'quiz-ai-warm', fromFile: !!aiF, topic: $('#aiTopic').value.trim(), level: $('#aiLevel').value, time: aiSecs(), count: aiCount(), lang: $('#aiLang').value, provider: aiProvider() }), 3000);
}
['aiTopic', 'aiLang', 'aiLevel', 'aiCount'].forEach(id => $('#' + id).addEventListener('change', aiWarmSoon));
document.querySelectorAll('#aiChips button, #aiMinus, #aiPlus').forEach(b => b.addEventListener('click', aiWarmSoon));

// ---- tablar
let curTab = 'media', fnSub = 'media', qzSub = 'quiz';
const centerMode = () => { try { return !!CENTER.cur; } catch { return false; } };
function showTab(name) {
  const cm = centerMode();
  if (name) {
    if (name === 'ai') { qzSub = 'ai'; name = 'quiz'; }                   // 🤖 AI Quiz endi Viktorina ichidagi bo'lim
    else if (name === 'quiz') qzSub = 'quiz';
    curTab = name; try { sessionStorage.setItem('sc_tab', name === 'quiz' && qzSub === 'ai' ? 'ai' : name); } catch {}
  }
  // Markaz rejimi: Davomat → Uyga vazifa → Viktorina (ichida AI Quiz) → Funksiyalar; Media, Mikrofon, O'yinlar — «Funksiyalar» ichida
  if (cm && ['media', 'mic', 'games'].includes(curTab)) { fnSub = curTab; curTab = 'fn'; }
  if (!cm && curTab === 'fn') curTab = fnSub;
  if (!cm && curTab === 'hw') curTab = 'quiz';                           // Uyga vazifa faqat markaz kodi bilan kirilganda
  const eff = curTab === 'fn' ? fnSub : curTab === 'quiz' && qzSub === 'ai' ? 'ai' : curTab;   // haqiqatda ko'rsatiladigan panel
  const game = !!S.quiz && isHost();                          // o'yin ketayotganda tab panellari yashiriladi, o'yin paneli ko'rinadi
  $('#tabMedia').hidden = eff !== 'media' || game;
  $('#tabQuiz').hidden = eff !== 'quiz' || game;
  $('#tabHw').hidden = eff !== 'hw' || game;
  $('#tabAi').hidden = eff !== 'ai' || game;
  $('#tabMic').hidden = eff !== 'mic' || game;
  $('#tabGames').hidden = eff !== 'games' || game;
  if ($('#tabAtt')) $('#tabAtt').hidden = eff !== 'att' || game;
  $('#fnSub').hidden = !(cm && curTab === 'fn') || game;
  $('#qzSub').hidden = curTab !== 'quiz' || game;
  document.querySelectorAll('#fnSub .chipbtn').forEach(b => b.classList.toggle('on', b.dataset.sub === fnSub));
  document.querySelectorAll('#qzSub .chipbtn').forEach(b => b.classList.toggle('on', b.dataset.sub === qzSub));
  if (eff === 'hw' || eff === 'quiz') qzSetMode(eff);
  if (eff === 'hw') hwLastRender();
  if (eff === 'ai' && !game) aiWarmSoon();
  $('#gameWrap').hidden = !game;
  document.querySelectorAll('#hostTabs .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === curTab));
}
document.querySelectorAll('#hostTabs .tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
document.querySelectorAll('#fnSub .chipbtn').forEach(b => { b.onclick = () => { fnSub = b.dataset.sub; showTab('fn'); }; });
document.querySelectorAll('#qzSub .chipbtn').forEach(b => { b.onclick = () => showTab(b.dataset.sub === 'ai' ? 'ai' : 'quiz'); });

// ---- o'yin: umumiy qismlar
// ---- o'yin paytida rasmni kattalashtirish / kichraytirish
// 1) rasm ustidagi − / + tugmalari rasm o'lchamini joyida o'zgartiradi (savol almashguncha eslab qoladi)
// 2) rasmni bosish yoki ⛶ — to'liq ekranli ko'rgich: − / + tugmalari, g'ildirak, ikki barmoq (pinch), ikki marta bosish, surish
const IMZ = { k: '', z: 1 };
const IMGV = (() => {
  const ZMIN = 0.4, ZMAX = 6;
  let ov = null, img = null, lab = null, st = null, cur = null, poll = null, drag = null, pinch = null, moved = false, lastTap = 0;
  const pts = new Map();
  const mount = () => document.fullscreenElement || document.webkitFullscreenElement || document.body;
  function clampPan() {
    const vw = ov.clientWidth, vh = ov.clientHeight, w = img.clientWidth * st.z, h = img.clientHeight * st.z;
    const mx = Math.max(0, (w - vw) / 2), my = Math.max(0, (h - vh) / 2);
    st.x = Math.min(mx, Math.max(-mx, st.x)); st.y = Math.min(my, Math.max(-my, st.y));
  }
  function paint(anim) {
    clampPan();
    img.style.transition = anim ? 'transform .18s ease' : 'none';
    img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.z})`;
    lab.textContent = Math.round(st.z * 100) + '%';
  }
  function zoomAt(nz, cx, cy, anim) {                  // cx, cy — ekran markaziga nisbatan
    nz = Math.min(ZMAX, Math.max(ZMIN, nz));
    const r = nz / st.z;
    st.x = cx - (cx - st.x) * r; st.y = cy - (cy - st.y) * r; st.z = nz;
    if (nz <= 1) { st.x = 0; st.y = 0; }
    paint(anim);
  }
  const rel = e => { const b = ov.getBoundingClientRect(); return { x: e.clientX - b.left - b.width / 2, y: e.clientY - b.top - b.height / 2 }; };
  function close() {
    if (!ov) return;
    clearInterval(poll); poll = null;
    document.removeEventListener('keydown', onKey, true);
    ov.remove(); ov = img = lab = st = cur = drag = pinch = null; pts.clear();
  }
  function onKey(e) {
    if (!ov) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(st.z * 1.25, 0, 0, true); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(st.z / 1.25, 0, 0, true); }
    else if (e.key === '0') { e.preventDefault(); zoomAt(1, 0, 0, true); }
  }
  function open(src) {
    if (!src) return;
    close();
    cur = { src, phase: S.quiz && S.quiz.phase };
    st = { z: 1, x: 0, y: 0 };
    ov = qel('div', 'imgv');
    img = document.createElement('img'); img.src = src; img.alt = ''; img.draggable = false;
    const bar = qel('div', 'imgv-bar');
    lab = qel('span', '', '100%');
    const mk = (t, title, fn) => { const b = qel('button', '', t); b.type = 'button'; b.title = title; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
    bar.append(mk('−', 'Kichraytirish', () => zoomAt(st.z / 1.25, 0, 0, true)), lab, mk('+', 'Kattalashtirish', () => zoomAt(st.z * 1.25, 0, 0, true)), mk('⟲', 'Asl o\'lcham', () => zoomAt(1, 0, 0, true)));
    const x = mk('✕', 'Yopish (Esc)', close); x.className = 'imgv-x';
    [bar, x].forEach(el => el.addEventListener('pointerdown', e => e.stopPropagation()));
    ov.append(img, bar, x);
    ov.addEventListener('wheel', e => { e.preventDefault(); const c = rel(e); zoomAt(st.z * Math.exp(-e.deltaY * 0.0015), c.x, c.y, false); }, { passive: false });
    ov.addEventListener('pointerdown', e => {
      try { ov.setPointerCapture(e.pointerId); } catch {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { moved = false; drag = { x: e.clientX, y: e.clientY, ox: st.x, oy: st.y }; pinch = null; }
      else if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: st.z }; drag = null; moved = true; }
    });
    ov.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2 && pinch) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const c = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        zoomAt(pinch.z * d / pinch.d, c.x, c.y, false);
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
        if (moved) { st.x = drag.ox + dx; st.y = drag.oy + dy; paint(false); }
      }
    });
    const up = e => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size === 1) { const p = [...pts.values()][0]; drag = { x: p.x, y: p.y, ox: st.x, oy: st.y }; pinch = null; return; }
      if (pts.size > 0) return;
      drag = null; pinch = null;
      if (moved || e.type === 'pointercancel') return;
      if (e.target === ov) { close(); return; }                                   // qora fonni bosish — yopish
      if (e.target === img) {                                                      // ikki marta bosish — yaqinlashtirish / qaytarish
        const now = Date.now();
        if (now - lastTap < 320) { lastTap = 0; const c = rel(e); if (st.z > 1.05) zoomAt(1, 0, 0, true); else zoomAt(2.5, c.x, c.y, true); }
        else lastTap = now;
      }
    };
    ov.addEventListener('pointerup', up); ov.addEventListener('pointercancel', up);
    document.addEventListener('keydown', onKey, true);
    mount().appendChild(ov);
    // savol / bosqich almashsa ko'rgich o'zi yopiladi
    poll = setInterval(() => {
      const qz = S.quiz;
      if (!ov || !qz || !qz.q || qz.q.img !== cur.src || qz.phase !== cur.phase) close();
    }, 400);
  }
  return { open, close };
})();
function qImg(q) {
  if (!q.img) return null;
  const w = qel('div', 'qz-imgw');
  const im = qel('img', 'qz-img'); im.src = q.img; im.alt = ''; im.decoding = 'async'; im.title = 'Kattalashtirish uchun bosing';
  const k = q.img.length + ':' + q.img.slice(-32);
  if (IMZ.k !== k) { IMZ.k = k; IMZ.z = 1; }                                       // yangi savol — o'lcham asliga qaytadi
  const set = z => { IMZ.z = Math.min(2.2, Math.max(0.4, Math.round(z * 100) / 100)); w.style.setProperty('--iz', String(IMZ.z)); };
  set(IMZ.z);
  im.onclick = () => IMGV.open(q.img);
  const tl = qel('div', 'qz-imgtl');
  const mk = (t, title, fn) => { const b = qel('button', '', t); b.type = 'button'; b.title = title; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
  tl.append(mk('−', 'Rasmni kichraytirish', () => set(IMZ.z / 1.25)), mk('+', 'Rasmni kattalashtirish', () => set(IMZ.z * 1.25)), mk('⛶', 'To\'liq ekranda ko\'rish', () => IMGV.open(q.img)));
  w.append(im, tl);
  return w;
}
const lenCls = t => (t.length > 140 ? 'xl' : t.length > 80 ? 'l' : t.length > 40 ? 'm' : 's');
// Savol + javob plitalari. o: { gridId, onPick, picked, locked, reveal, mid (host uchun taymer/rasm/javoblar qatori), fill }
function qBlock(parent, qz, o) {
  const q = qz.q;
  if (!q) return;
  const wrap = qel('div', 'qb' + (o.fill ? ' fill' : '') + (o.reveal ? ' rev' : ''));
  const hq = !isHost() && !!qz.hideQ && qz.phase === 'question';             // savol matni kelmagan: katta ekrandan o'qiladi
  const qshow = hq ? '👀 Savolni katta ekrandan o\'qing' : q.text;
  const qt = qel('div', 'qz-q' + (hq ? ' hidq' : ''), qshow); qt.dataset.len = lenCls(qshow);
  wrap.appendChild(qt);
  const main = qel('div', 'qb-main');
  if (o.mid) main.appendChild(o.mid);
  else { const im = qImg(q); if (im) wrap.appendChild(im); }
  const blind = !isHost() && !!qz.hideOpts && qz.phase === 'question';       // variantlar matni umuman kelmagan: faqat rangli plitalar
  const g = qel('div', 'qz-grid n' + q.opts.length + (o.locked ? ' locked' : '') + (blind ? ' blind' : '')); g.id = o.gridId || '';
  q.opts.forEach((txt, i) => {
    const b = qel(o.onPick ? 'button' : 'div', 'qopt'); b.style.background = QCOL[i];
    if (blind) b.setAttribute('aria-label', 'Variant ' + 'ABCD'[i]);
    const t = qel('span', 'tx', txt); t.dataset.len = lenCls(txt);
    b.append(qel('span', 'sh', QSHAPE[i]), t);
    if (o.reveal) {
      const good = i === qz.correct;
      b.classList.add(good ? 'good' : 'dim');
      if (qz.counts) b.appendChild(qel('span', 'cnt', String(qz.counts[i])));
      b.appendChild(qel('span', 'mk', good ? '✓' : '✗'));
    } else if (o.picked === i) b.classList.add('mine');
    if (o.onPick) b.onclick = () => o.onPick(i);
    g.appendChild(b);
  });
  main.appendChild(g);
  if (blind) wrap.classList.add('blindq');
  const cnt = qel('div', 'qz-count'); cnt.id = o.countId || ''; cnt.hidden = true; main.appendChild(cnt);
  wrap.appendChild(main);
  parent.appendChild(wrap);
}
function lbList(parent, top, medals, start = 0) {
  const ul = qel('ul', 'lb');
  top.forEach((t, i0) => {
    const i = i0 + start, li = qel('li', '');
    li.append(qel('span', 'rk', medals && i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1)), ...(stkOn() ? [qel('span', 'av', t.av || '')] : []), qel('span', 'nm', t.name), qel('span', 'pt', String(t.score)));
    if (t.delta > 0) li.appendChild(qel('span', 'dl', '+' + t.delta));
    ul.appendChild(li);
  });
  parent.appendChild(ul);
}
function restPlaces(parent, list, from = 3) {                       // 4-o'rindan boshlab "qolgan o'rinlar"
  const rest = (list || []).slice(from);
  if (!rest.length) return;
  parent.appendChild(qel('h3', 'rest-h', 'Qolgan o\'rinlar'));
  const box = qel('div', 'rest-box'); lbList(box, rest, false, from); parent.appendChild(box);
}
function podium(parent, top) {
  if (!top.length) return;
  const pd = qel('div', 'podium');
  [[1, 'p2'], [0, 'p1'], [2, 'p3']].forEach(([i, cls]) => {
    if (!top[i]) return;
    const d = qel('div', cls); d.append(qel('span', '', ['🥇', '🥈', '🥉'][i]), qel('small', '', (stk(top[i].av) + ' ' + top[i].name).trim()), qel('small', '', String(top[i].score))); pd.appendChild(d);
  });
  parent.appendChild(pd);
}
// ------------------------------------------------------------ VIKTORINA OVOZLARI (WebAudio'da sintez qilinadi — fayl kerak emas)
// Hamma ovoz umumiy master/limiter orqali chiqadi (xonadagi umumiy ovoz va "hammani o'chirish" ularga ham ta'sir qiladi),
// sanoq ovozlari serverdagi vaqtga bog'lanadi => hamma qurilmada bir vaqtda eshitiladi. Musiqa ketayotgan bo'lsa, ovoz paytida pasayadi.
const SFX = (() => {
  let on = localStorage.getItem('sc_qsfx') !== '0', bus = null, noise = null;
  const done = new Set();
  const once = k => { if (done.has(k)) return false; done.add(k); if (done.size > 400) done.delete(done.values().next().value); return true; };
  function ac() {
    if (!on) return null;
    const c = ensureAudio(); if (!c || !master) return null;
    if (c.state !== 'running') c.resume().catch(() => {});
    if (!bus) { bus = c.createGain(); bus.gain.value = 0.5; bus.connect(master); }
    return c;
  }
  function duck(c, sec) {
    if (!quizDuck) return;
    const t = c.currentTime; quizDuck.gain.cancelScheduledValues(t);
    quizDuck.gain.setTargetAtTime(0.3, t, 0.05); quizDuck.gain.setTargetAtTime(1, t + sec, 0.4);
  }
  function tone(c, t, f, d, o = {}) {
    const osc = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter(), v = o.v == null ? 0.25 : o.v;
    osc.type = o.type || 'triangle'; osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + d);
    lp.type = 'lowpass'; lp.frequency.value = o.lp || 3800;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.012);                          // yumshoq boshlanish: "chiq" (click) yo'q
    g.gain.setValueAtTime(v, t + Math.min(d * 0.8, Math.max(0.012, d * (o.hold || 0.4))));
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(lp); lp.connect(g); g.connect(bus);
    osc.start(t); osc.stop(t + d + 0.05);
  }
  function noiseBuf(c) { if (!noise) { noise = c.createBuffer(1, c.sampleRate, c.sampleRate); const a = noise.getChannelData(0); for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1; } return noise; }
  function roll(c, sec, hits) {                                          // baraban: g'oliblar e'lon qilinishidan oldin kuchayib boruvchi "dr-r-r"
    const src = c.createBufferSource(); src.buffer = noiseBuf(c); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.9;
    const g = c.createGain(), t = c.currentTime + 0.05, step = 0.045; g.gain.setValueAtTime(0.0001, t);
    for (let k = 0; k * step < sec; k++) { const tt = t + k * step, env = 0.04 + 0.2 * (k * step / sec); g.gain.linearRampToValueAtTime(env, tt + 0.008); g.gain.linearRampToValueAtTime(env * 0.25, tt + step * 0.9); }
    g.gain.linearRampToValueAtTime(0.0001, t + sec + 0.05);
    src.connect(bp); bp.connect(g); g.connect(bus); src.start(t); src.stop(t + sec + 0.1);
    hits.forEach(ms => tone(c, c.currentTime + ms / 1000, 98, 0.5, { type: 'sine', v: 0.3, to: 55 }));   // har bir o'rin e'lon qilinganda "dum"
    duck(c, sec);
  }
  function applause(c, t, d, v) {                                         // olqish: tasodifiy "paqqa"lar
    const src = c.createBufferSource(); src.buffer = noiseBuf(c); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.7;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    const n = Math.round(d * 12);
    for (let i = 0; i < n; i++) {
      const tt = t + 0.1 + (i / n) * (d - 0.4) + Math.random() * 0.01, amp = v * (0.35 + Math.random() * 0.65) * Math.sqrt(Math.sin(Math.PI * (i + 0.5) / n));
      g.gain.linearRampToValueAtTime(amp, tt + 0.01); g.gain.linearRampToValueAtTime(amp * 0.2, tt + 0.05);
    }
    g.gain.linearRampToValueAtTime(0.0001, t + d);
    src.connect(bp); bp.connect(g); g.connect(bus); src.start(t); src.stop(t + d + 0.1);
  }
  const P = { startJingle(c, t) {
      [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, t + i * 0.1, f, 0.24, { type: 'square', v: 0.1, lp: 2600 }));
      [523.25, 659.25, 783.99].forEach(f => tone(c, t + 0.5, f, 0.9, { type: 'sawtooth', v: 0.07, lp: 2200, hold: 0.6 }));
      tone(c, t, 130.8, 0.7, { type: 'sine', v: 0.3 }); tone(c, t + 0.5, 261.6, 0.8, { type: 'sine', v: 0.2 });
    },
    tick(c, t) { tone(c, t, 880, 0.09, { type: 'sine', v: 0.22 }); },
    go(c, t) { tone(c, t, 1318.5, 0.38, { v: 0.24 }); tone(c, t, 1760, 0.38, { v: 0.12 }); tone(c, t, 659.25, 0.38, { type: 'sine', v: 0.18 }); },
    good(c, t) { tone(c, t, 659.25, 0.16, { v: 0.24 }); tone(c, t + 0.11, 987.77, 0.45, { v: 0.26 }); },
    bad(c, t) { tone(c, t, 196, 0.5, { type: 'sawtooth', v: 0.16, lp: 900, to: 130 }); },
    win(c, t) {                                                           // g'oliblar uchun tantana (fanfara + olqish + yaltirash)
      [[0, 523.25, 0.14], [0.16, 523.25, 0.14], [0.32, 523.25, 0.14], [0.48, 659.25, 0.5], [1.02, 587.33, 0.16], [1.2, 659.25, 0.16], [1.38, 783.99, 1.1]]
        .forEach(([dt, f, d]) => tone(c, t + dt, f, d, { type: 'sawtooth', v: 0.13, lp: 2400, hold: 0.7 }));
      [523.25, 659.25, 1046.5].forEach(f => tone(c, t + 1.38, f, 1.3, { type: 'triangle', v: 0.1, hold: 0.7 }));
      tone(c, t + 0.48, 130.8, 0.6, { type: 'sine', v: 0.3 }); tone(c, t + 1.38, 130.8, 1.1, { type: 'sine', v: 0.32 });
      [1568, 1976, 2349, 3136].forEach((f, i) => tone(c, t + 1.45 + i * 0.09, f, 0.35, { type: 'sine', v: 0.05 }));
      applause(c, t + 0.6, 3.4, 0.2);
    },
    nice(c, t) {                                                          // qolganlar uchun yengil quvonch
      [659.25, 783.99, 1046.5].forEach((f, i) => tone(c, t + i * 0.15, f, i === 2 ? 0.7 : 0.22, { v: 0.2 }));
      applause(c, t + 0.3, 1.8, 0.1);
    } };
  const out = c => (c.outputLatency || 0);
  function countdown(pub) {
    const c = ac(); if (!c) return;
    const first = pub.idx === 0, toStart = (pub.startAt - sNow()) / 1000;
    const at = sec => c.currentTime + sec - out(c);                      // sec — hozirdan keyingi vaqt
    if (first && toStart > 2) { P.startJingle(c, c.currentTime); duck(c, 1.6); }
    (first ? [2, 1] : [3, 2, 1]).forEach(k => { if (toStart > k + 0.05) P.tick(c, at(toStart - k)); });
    if (toStart > 0.05) { P.go(c, at(toStart)); duck(c, toStart + 0.5); }
  }
  let finalAt = 0;
  const winN = top => Math.min(3, (top || []).length);
  function finalFx(rank, pub) {                                          // bitta qurilmada final effektlari (ovoz + animatsiya)
    const cel = pub.celebrate !== false, n = winN(pub.top), c = ac();
    if (c) { const win = rank >= 1 && rank <= 3; (win ? P.win : P.nice)(c, c.currentTime + 0.05); duck(c, win ? 4.5 : 2.2); }
    if (!cel) return;
    if (isHost()) confetti();
    else if (rank >= 1 && rank <= n) { winOverlay(rank); confetti(); }
  }
  function schedFinal(pub, rank) {                                       // o'z o'rni e'lon qilinadigan paytda (ceremoniya tartibi bo'yicha)
    const cel = pub.celebrate !== false, n = winN(pub.top), plan = revealPlan(n);
    const base = !cel ? 0 : (rank >= 1 && rank <= n ? plan[rank] : plan.end);
    setTimeout(() => finalFx(rank, pub), Math.max(0, base - (performance.now() - finalAt)));
  }
  return {
    get on() { return on; },
    toggle() { on = !on; localStorage.setItem('sc_qsfx', on ? '1' : '0'); if (on) { const c = ac(); if (c) P.tick(c, c.currentTime); } return on; },
    onQuiz(pub) {
      if (!pub) return;
      if (pub.phase === 'question' && pub.startAt > sNow() && once(pub.id + ':' + pub.idx + ':q')) countdown(pub);
      else if (pub.phase === 'final' && once(pub.id + ':f:' + (isHost() ? 'h' : 'r'))) {
        finalAt = performance.now();
        if (isHost()) {                                                   // proyektor: baraban -> 1-o'rin e'loni -> tantana
          const cel = pub.celebrate !== false, n = winN(pub.top), plan = revealPlan(n);
          if (cel && n) { const c = ac(); if (c) roll(c, plan[1] / 1000, Object.keys(plan).filter(k => k !== 'end').map(k => plan[k])); setTimeout(() => finalFx(1, pub), plan[1]); }
          else finalFx(1, pub);
        } else setTimeout(() => { if (once(pub.id + ':ff')) schedFinal(pub, S.qMe && S.qMe.rank ? S.qMe.rank : 99); }, 900);   // o'rin (quiz-me) kelmasa ham ovoz chiqadi
      }
    },
    onMe() {                                                              // receiver: o'z natijasi kelganda
      const qz = S.quiz, me = S.qMe; if (!qz || !me || me.stale || isHost()) return;
      if (qz.phase === 'reveal' && me.answered && once(qz.id + ':' + qz.idx + ':r')) { const c = ac(); if (c) (me.ok ? P.good : P.bad)(c, c.currentTime + 0.02); }
      else if (qz.phase === 'final' && me.rank && once(qz.id + ':ff')) schedFinal(qz, me.rank);
    },
  };
})();

// ---- final marosimi: medallar, bosqichma-bosqich e'lon (5-o'rindan 1-o'ringacha), g'oliblarga tabrik
const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const MEDAL = [['🥇', 'Oltin medal', 'gold'], ['🥈', 'Kumush medal', 'silver'], ['🥉', 'Bronza medal', 'bronze'], ['🏅', '4-o\'rin', 'm4'], ['🎖️', '5-o\'rin', 'm5']];
function revealPlan(n) {                                                  // rank(1..n) -> kechikish (ms); 1-o'rin eng oxirida va alohida pauza bilan
  const d = {};
  for (let r = n; r >= 1; r--) d[r] = REDUCED ? 0 : 400 + (n - r) * 1300 + (r === 1 && n > 1 ? 800 : 0);
  d.end = REDUCED ? 0 : (d[1] || 0) + 2200;
  return d;
}
function ceremony(parent, top) {
  const n = Math.min(3, top.length); if (!n) return;
  const plan = revealPlan(n), box = qel('div', 'cer');
  const card = (i, mini) => {
    const t = top[i], md = MEDAL[i], d = qel('div', 'cer-card ' + md[2] + (mini ? ' mini' : ' pod h' + (i + 1)));
    d.style.setProperty('--d', (plan[i + 1] / 1000).toFixed(2) + 's');
    d.append(qel('div', 'cer-crown', i === 0 ? '👑' : ''), ...(stkOn() ? [qel('div', 'cer-av', t.av || '🙂')] : []), qel('div', 'cer-medal', md[0]), qel('div', 'cer-nm', t.name), qel('div', 'cer-pt', t.score + ' ' + ptU()));
    if (!mini) d.appendChild(qel('div', 'cer-blk', String(i + 1)));
    return d;
  };
  const row = qel('div', 'cer-row');
  [1, 0, 2].forEach(i => { if (i < n && top[i]) row.appendChild(card(i, false)); });
  box.appendChild(row);
  const rest = qel('div', 'cer-rest');
  if (rest.children.length) box.appendChild(rest);
  parent.appendChild(box);
}
function winOverlay(rank) {                                               // receiver: top-5 ga to'liq ekranli tabrik
  if (document.getElementById('qwin') || rank < 1 || rank > 5) return;
  const md = MEDAL[rank - 1], me = S.qMe || {}, o = qel('div', 'qwin'); o.id = 'qwin';
  const c = qel('div', 'qwin-card ' + md[2]), btn = qel('button', 'primary', 'Davom etish');
  c.append(qel('div', 'qwin-rays'), qel('div', 'qwin-medal', md[0]), qel('h2', '', 'Tabriklaymiz!'), ...(stkOn() ? [qel('div', 'qwin-av', S.av || '🙂')] : []), qel('div', 'qwin-nm', S.name || 'Siz'),
    qel('p', '', `${rank}-o'rin${me.score != null ? ' · ' + me.score + ' ' + ptU() : ''}`), qel('small', '', md[1]), btn);
  o.appendChild(c);
  const close = () => o.remove();
  btn.onclick = close; o.onclick = e => { if (e.target === o) close(); };
  document.body.appendChild(o); setTimeout(close, 20000);
}
function confetti() {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = qel('div', 'confetti'); const cols = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#ff9ecd', '#fff'];
  for (let i = 0; i < 44; i++) {
    const e = qel('i'); e.style.cssText = `left:${Math.random() * 100}%;background:${cols[i % cols.length]};animation-delay:${(Math.random() * 1.2).toFixed(2)}s;animation-duration:${(2.6 + Math.random() * 2).toFixed(2)}s;--dx:${(Math.random() * 160 - 80).toFixed(0)}px`;
    box.appendChild(e);
  }
  document.body.appendChild(box); setTimeout(() => box.remove(), 6000);
}

// ------------------------------------------------------------ HIMOYA (receiver, viktorina paytida): nusxa olish, kontekst menyu, chop etish, skrinshot urinishlari
// ESLATMA: brauzer qurilmaning apparat skrinshotini (telefon tugmalari, tashqi kamera) tamomila to'sa olmaydi. Shu sababli:
// savol ekrani nik bilan suv belgisi (watermark) bilan chiqadi va "faqat savol" rejimida variantlar serverdan umuman yuborilmaydi.
const GUARD = (() => {
  let shield = null, hideT = 0;
  const active = () => !isHost() && S.cfg.guard !== false && !!S.quiz && (S.quiz.phase === 'question' || S.quiz.phase === 'reveal');
  function cover(ms) {
    if (!active()) return;
    if (!shield) { shield = qel('div', 'qshield'); shield.append(qel('div', 'em', '🔒'), qel('p', '', 'Viktorina ekrani himoyalangan. Oynaga qayting.')); document.body.appendChild(shield); }
    shield.hidden = false; clearTimeout(hideT);
    if (ms) hideT = setTimeout(uncover, ms);
  }
  function uncover() { if (shield && document.hasFocus() && !document.hidden) shield.hidden = true; }
  function wipeClipboard() { try { navigator.clipboard.writeText(' ').catch(() => {}); } catch {} }
  const block = e => { if (active()) { e.preventDefault(); e.stopPropagation(); } };
  ['copy', 'cut', 'paste', 'contextmenu', 'dragstart', 'selectstart'].forEach(ev => document.addEventListener(ev, e => { if (!(e.target && e.target.closest && e.target.closest('input,textarea'))) block(e); }, true));
  document.addEventListener('keydown', e => {
    if (!active()) return;
    const k = (e.key || '').toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (k === 'printscreen') { wipeClipboard(); cover(2500); e.preventDefault(); }
    else if (e.metaKey && e.shiftKey) cover(3000);                                           // Win+Shift+S, Cmd+Shift+3/4/5
    else if (k === 'f12' || (ctrl && e.shiftKey && ['i', 'j', 'c'].includes(k)) || (ctrl && ['c', 'x', 's', 'p', 'u', 'a'].includes(k) && !(e.target && e.target.closest && e.target.closest('input,textarea')))) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keyup', e => { if (active() && (e.key || '').toLowerCase() === 'printscreen') { wipeClipboard(); cover(2500); } }, true);
  window.addEventListener('blur', () => cover(0));
  window.addEventListener('focus', () => { if (shield) hideT = setTimeout(uncover, 150); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cover(0); else uncover(); });
  window.addEventListener('beforeprint', () => cover(0));
  setInterval(() => {                                                                          // DevTools ochilgan (docked) bo'lsa ekran yopiladi
    if (!active() || window.matchMedia('(pointer: coarse)').matches) return;
    if (window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 260) cover(1200);
  }, 1500);
  return {
    watermark() {                                                                              // nik bilan takrorlanuvchi suv belgisi: oqib chiqsa kim ekanini bildiradi
      const nm = String(S.name || 'receiver').replace(/[<>&"']/g, '').slice(0, 20);
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='150'><text x='20' y='90' transform='rotate(-24 120 75)' font-family='sans-serif' font-size='20' font-weight='700' fill='white' fill-opacity='0.13'>${nm} · ${S.code || ''}</text></svg>`;
      $('#quizPlay').style.setProperty('--wm', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    },
    refresh() { if (!active() && shield) shield.hidden = true; },
    sync() { const ov = $('#quizPlay'); if (ov) ov.classList.toggle('guard', active()); this.refresh(); },
  };
})();

// ------------------------------------------------------------ QOIDALAR OGOHLANTIRISHI (receiver): viktorinaga kirishdan oldin bir marta ko'rsatiladi
// AI vositalari va skrinshot — qoidabuzarlik ekani oldindan aytiladi. "Roziman" bosilganda (bu foydalanuvchi harakati) to'liq ekran ham yoqiladi.
const RULES = (() => {
  const KEY = 'sc_rules_ok';
  let el = null, ack = '';
  try { ack = sessionStorage.getItem(KEY) || ''; } catch {}
  const need = () => !isHost() && !!S.joined && !!S.quiz && S.quiz.phase !== 'final' && ack !== S.quiz.id;
  function build() {
    el = qel('div', 'rules'); el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'rulesH');
    const box = qel('div', 'rules-box');
    const h = qel('h2', '', 'Viktorina qoidalari'); h.id = 'rulesH';
    const list = qel('ul', 'rules-list');
    [['🤖', 'AI ishlatish — taqiqlanadi', 'ChatGPT, Gemini, Copilot, Google Lens va boshqa yordamchilar'],
     ['📸', 'Skrinshot va suratga olish — taqiqlanadi', 'Ekran yozuvi, boshqa telefon bilan surat ham shunga kiradi'],
     ['🪟', 'Boshqa oyna yoki ilovaga o\'tmang', 'To\'liq ekrandan chiqish, nusxa olish ham qoidabuzarlik']].forEach(([i, t, d]) => {
      const li = qel('li'); li.append(qel('span', 'ic', i), (() => { const w = qel('div'); w.append(qel('b', '', t), qel('small', '', d)); return w; })()); list.appendChild(li);
    });
    const pen = qel('p', 'rules-pen', ''); pen.id = 'rulesPen';
    const lab = qel('label', 'rules-ok'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'rulesCb';
    lab.append(cb, qel('span', '', 'Qoidalarni o\'qidim va roziman'));
    const btn = qel('button', 'primary wide', 'Kirish'); btn.type = 'button'; btn.disabled = true; btn.id = 'rulesGo';
    cb.onchange = () => { btn.disabled = !cb.checked; };
    btn.onclick = accept;
    box.append(qel('div', 'rules-em', '⚠️'), h, qel('p', 'rules-sub', 'O\'yin halol bo\'lishi uchun, kirishdan oldin o\'qing:'), list, pen, lab, btn);
    el.appendChild(box); document.body.appendChild(el);
  }
  async function accept() {
    if (!S.quiz) return;
    ack = S.quiz.id; try { sessionStorage.setItem(KEY, ack); } catch {}
    if (el) el.hidden = true;
    try { await STRICT.enter(); } catch {}
    STRICT.paint(); renderQuiz();
  }
  function paint() {
    const n = need();
    if (!n) { if (el) el.hidden = true; return; }
    if (!el) build();
    const lim = Number(S.quiz.strikeLimit) || 0, strict = S.quiz.strict !== false;
    const pen = el.querySelector('#rulesPen');
    pen.textContent = strict
      ? (lim ? `Qoidabuzarlik Transmitterga ko'rinadi. ${lim} marta takrorlansa — diskvalifikatsiya, javoblaringiz hisoblanmaydi.` : 'Qoidabuzarlik Transmitterga ko\'rinadi va sizning ismingiz bilan ro\'yxatga tushadi.')
      : 'Transmitter qoidabuzarlarni ro\'yxatdan chiqarishi mumkin.';
    const btn = el.querySelector('#rulesGo'); btn.textContent = strict ? '🔒 Roziman — to\'liq ekranda kirish' : '✅ Roziman — kirish';
    if (el.hidden) { const cb = el.querySelector('#rulesCb'); cb.checked = false; btn.disabled = true; }
    el.hidden = false;
  }
  return { paint, pending: need };
})();

// ------------------------------------------------------------ QAT'IY REJIM (receiver, viktorina): to'liq ekran qulfi + qoidabuzarlik hisobi
// Brauzer cheklovi: to'liq ekranni faqat foydalanuvchi bosgandan keyin yoqish mumkin (avtomatik emas), Esc ni butunlay o'chirib bo'lmaydi
// (Chrome'da Esc 2 soniya bosib turilsa chiqadi) va telefon/tashqi kamera skrinshotini to'sib bo'lmaydi. Shuning uchun chiqish urinishlari
// aniqlanadi: ekran darhol yopiladi, Transmitterga xabar ketadi va belgilangan sondan keyin o'yinchi diskvalifikatsiya qilinadi.
const STRICT = (() => {
  const de = document.documentElement;
  const reqFs = de.requestFullscreen || de.webkitRequestFullscreen;
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const on = () => !isHost() && !!S.joined && !!S.quiz && S.quiz.strict !== false && S.quiz.phase !== 'final';
  const counting = () => on() && !RULES.pending() && (S.quiz.phase === 'question' || S.quiz.phase === 'reveal');
  const dq = () => !!(S.qMe && S.qMe.dq);
  let gate = null, wake = null, was = false, hid = false, lastBlur = 0, trap = false;
  function build() {
    gate = qel('div', 'sgate'); gate.hidden = true;
    const box = qel('div', 'sgate-box');
    box.append(qel('div', 'em', '🔒'), qel('h2', '', ''), qel('p', 'sg-t', ''), qel('p', 'sg-w', ''), qel('button', 'primary wide', ''));
    gate.appendChild(box); document.body.appendChild(gate);
    box.querySelector('button').onclick = enter;
  }
  async function enter() {
    try { if (reqFs && !isFs()) await reqFs.call(de, { navigationUI: 'hide' }); } catch {}
    try { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape', 'F11']); } catch {}   // Esc tez bosilganda chiqmaydi
    try { if (navigator.wakeLock && !wake) wake = await navigator.wakeLock.request('screen'); } catch {}
    paint();
  }
  function release() {
    try { if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {}
    try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch {}
    try { if (wake) wake.release(); } catch {} wake = null;
  }
  function paint() {
    const o = on() && !RULES.pending();
    if (o && !trap) { trap = true; try { history.pushState({ sc: 1 }, '', location.href); } catch {} }
    if (!o) { if (was) release(); was = false; trap = false; if (gate) gate.hidden = true; document.body.classList.remove('sg-lock', 'sg-dq'); return; }
    was = true;
    const dqd = dq(), need = dqd || (!!reqFs && !isFs());
    if (!need) { if (gate) gate.hidden = true; document.body.classList.remove('sg-lock', 'sg-dq'); return; }
    if (!gate) build();
    const h = gate.querySelector('h2'), t = gate.querySelector('.sg-t'), w = gate.querySelector('.sg-w'), b = gate.querySelector('button');
    const lim = (S.qMe && S.qMe.limit) || 0, st = (S.qMe && S.qMe.strikes) || 0;
    if (dqd) { h.textContent = '⛔ Diskvalifikatsiya'; t.textContent = 'Qoidalar bir necha marta buzildi. Bu o\'yinda javoblaringiz hisoblanmaydi.'; w.textContent = ''; b.hidden = true; }
    else {
      h.textContent = 'Viktorina — to\'liq ekran rejimi';
      t.textContent = 'Davom etish uchun to\'liq ekranga o\'ting. O\'yin davomida boshqa oynaga o\'tish, to\'liq ekrandan chiqish, skrinshot va nusxa olish taqiqlanadi.';
      w.textContent = st ? `⚠ Qoidabuzarlik: ${st}${lim ? ' / ' + lim : ''}${lim ? ' — ' + lim + ' tadan keyin diskvalifikatsiya' : ''}` : '';
      b.hidden = false; b.textContent = '🔒 To\'liq ekranga o\'tish va davom etish';
    }
    gate.hidden = false; document.body.classList.add('sg-lock'); document.body.classList.toggle('sg-dq', dqd);
  }
  function strike(why) { if (counting() && !dq()) send({ type: 'quiz-strike', why }); }
  document.addEventListener('fullscreenchange', () => { if (on() && !isFs()) strike('fs-exit'); paint(); });
  document.addEventListener('webkitfullscreenchange', () => { if (on() && !isFs()) strike('fs-exit'); paint(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hid = counting(); return; }
    if (hid) { hid = false; strike('tab-hidden'); }
    paint();
  });
  window.addEventListener('blur', () => {
    const now = Date.now(); if (!counting() || now - lastBlur < 5000) return; lastBlur = now;
    setTimeout(() => { if (!document.hasFocus() && !document.hidden) strike('blur'); }, 700);
  });
  document.addEventListener('keydown', e => {
    if (!counting()) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'printscreen' || (e.metaKey && e.shiftKey && ['s', '3', '4', '5'].includes(k))) strike('screenshot');
  }, true);
  document.addEventListener('keyup', e => { if (counting() && (e.key || '').toLowerCase() === 'printscreen') strike('screenshot'); }, true);
  window.addEventListener('beforeprint', () => strike('print'));
  window.addEventListener('beforeunload', e => { if (on()) { e.preventDefault(); e.returnValue = ''; } });     // yangilash/yopishda tasdiq so'raladi
  window.addEventListener('popstate', () => { if (on()) { try { history.pushState({ sc: 1 }, '', location.href); } catch {} } });   // "Orqaga" tugmasi viktorinadan chiqarmaydi
  setInterval(() => {
    if (!counting() || window.matchMedia('(pointer: coarse)').matches) return;
    if (window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 260) strike('devtools');
  }, 2000);
  return { paint, enter, blocked: () => !!(gate && !gate.hidden) };
})();

function onQuiz(pub) {
  const prev = S.quiz;
  S.quiz = pub;
  if (!pub) { S.qMe = null; S.qAns = null; S.qProg = null; }
  else {
    const newGame = !prev || prev.id !== pub.id;
    if (newGame || prev.idx !== pub.idx) { S.qAns = null; if (S.qProg) S.qProg = Object.assign({}, S.qProg, { answered: 0 }); }
    if (newGame) S.qMe = null;
    if (prev && !newGame && !!prev.hostPlay !== !!pub.hostPlay) { S.qAns = null; S.qMe = null; }          // Transmitter o'yinchilikni yoqdi/o'chirdi
    if (prev && !newGame && prev.phase !== pub.phase && (pub.phase === 'reveal' || pub.phase === 'final') && S.qMe) S.qMe = Object.assign({}, S.qMe, { stale: true });   // yangi natija kelguncha eski natija ko'rsatilmasin
    if (isHost() && newGame) showTab(pub.kind === 'hw' ? 'hw' : pub.mode === 'friend' ? 'ai' : 'quiz');
  }
  renderQuiz();
  SFX.onQuiz(pub); GUARD.refresh(); RULES.paint(); STRICT.paint(); if (isHost()) paintCheat(pub);
}
const renderQuiz = () => { if (isHost()) renderQuizHost(); else renderQuizPlay(); CHATAPI.paint(); };

// ---- Transmitter: o'yin paneli (to'liq ekran, proyektor uchun)
const qPlayersN = qz => (S.members && S.members.total) || (S.qProg && S.qProg.players) || (qz && qz.players) || 0;
function paintCheat(pub) {
  const box = $('#qgCheat'); if (!box) return;
  const list = (pub && pub.cheat) || [];
  box.hidden = !list.length; box.textContent = '';
  if (!list.length) return;
  box.appendChild(qel('b', '', '⚠ Qoidabuzarlar:'));
  list.slice(0, 8).forEach(c => box.appendChild(qel('span', 'cheat' + (c.dq ? ' dq' : ''), `${c.name} · ${c.strikes}${pub.strikeLimit ? '/' + pub.strikeLimit : ''}${c.dq ? ' ⛔' : ''} — ${c.why}`)));
}
function renderQuizHost() {
  const qz = S.quiz;
  $('#qzEditor').hidden = !!qz; $('#qzGame').hidden = !qz; showTab();
  document.body.classList.toggle('noscroll', !!qz && isHost());
  if (!qz) { qgMenuSet(false); try { if (document.fullscreenElement) document.exitFullscreen(); } catch {} qSchedule(); return; }
  $('#qgTitle').textContent = qz.title;
  $('#qgStep').textContent = (qz.idx >= 0 ? `Savol ${qz.idx + 1} / ${qz.total}` : `${qz.total} savol`) + (qz.hostPlay && S.qMe ? ` · 🏆 ${S.qMe.score}` : '');
  $('#qgPlayers').textContent = qPlayersN(qz);
  const last = qz.idx === qz.total - 1;
  $('#qgNext').hidden = !(qz.phase === 'lobby' || qz.phase === 'reveal');
  $('#qgNext').textContent = qz.phase === 'lobby' ? '▶ Boshlash' : (last ? '🏁 Natijalar' : '▶ Keyingi savol');
  $('#qgSkip').hidden = qz.phase !== 'question';
  $('#qgEnd').hidden = qz.phase === 'lobby' || qz.phase === 'final';
  $('#qgClose').textContent = qz.phase === 'final' ? '✔ Tugatish' : '✖ Yopish';
  $('#qgHide').textContent = qz.hideOpts ? '🙈 Receiverda variantlar yashirin' : '👁 Receiverda variantlar ko\'rinadi';
  $('#qgHide').classList.toggle('act', !!qz.hideOpts);
  $('#qgHideQ').textContent = qz.hideQ ? '🙈 Savol matni receiverda yashirin' : '👁 Savol matni receiverda ko\'rinadi';
  $('#qgHideQ').classList.toggle('act', !!qz.hideQ);
  $('#qgCel').textContent = qz.celebrate !== false ? '🏆 Tabrik animatsiyasi: yoniq' : '🏆 Tabrik animatsiyasi: o\'chiq';
  $('#qgCel').classList.toggle('act', qz.celebrate !== false);
  $('#qgStk').textContent = qz.stickers !== false ? '😀 Stikerlar: yoniq' : '😶 Stikerlar: o\'chiq';
  $('#qgStk').classList.toggle('act', qz.stickers !== false);
  $('#qgAuto').textContent = qz.auto ? '⏭ Avtomatik: yoniq' : '⏭ Avtomatik: o\'chiq';
  $('#qgAuto').classList.toggle('act', !!qz.auto);
  $('#qgHostPlay').textContent = qz.hostPlay ? '🙋 Transmitter o\'ynaydi: yoniq' : '🙋 Transmitter o\'ynaydi: o\'chiq';
  $('#qgHostPlay').classList.toggle('act', !!qz.hostPlay);
  $('#qgKahoot').textContent = qz.kahoot !== false ? '⚡ Kahoot rejimi: yoniq (tezlik + seriya)' : '🔢 Kahoot rejimi: o\'chiq (to\'g\'ri javoblar soni)';
  $('#qgKahoot').classList.toggle('act', qz.kahoot !== false);
  $('#qgKahoot').disabled = qz.phase !== 'lobby'; $('#qgKahoot').title = qz.phase === 'lobby' ? '' : 'Ball tizimi faqat o\'yin boshlanishidan oldin almashtiriladi';
  ['qgHostPlay', 'qgKahoot', 'qgCel', 'qgStk'].forEach(id => { $('#' + id).hidden = qz.kind === 'hw'; });   // uyga vazifada kerak emas
  updGuardBtn();
  $('#qgSfx').textContent = SFX.on ? '🔔' : '🔕';
  let body = $('#qgBody');
  if (qz.phase === 'lobby' && body.dataset.qid === qz.id && body.classList.contains('ph-lobby')) {   // zalda faqat o'zgargan qismi yangilanadi (QR/DOM qayta qurilmaydi)
    const n = qPlayersN(qz), list = (S.members.list || []).slice(0, 120), sig = list.map(m => stk(m.av) + m.name).join('\u0001');
    setTxt(body.querySelector('.qg-bigcount'), String(n));
    const chips = body.querySelector('.qg-chips');
    if (chips && chips.dataset.sig !== sig) {
      chips.dataset.sig = sig; chips.textContent = '';
      list.forEach(m => chips.appendChild(qel('span', 'qg-chip', (stk(m.av) + ' ' + m.name).trim())));
      if (!n) chips.appendChild(qel('span', 'muted', 'O\'yinchilar kutilmoqda…'));
    }
    return;
  }
  body.textContent = ''; body.dataset.qid = qz.id;
  body.className = 'qg-body ph-' + qz.phase;
  if (qz.phase === 'lobby') {
    const d = qel('div', 'qg-lobby');
    const l = qel('div', 'qg-join');
    l.append(qel('small', '', 'Qo\'shilish uchun'), qel('div', 'qg-url', (S.joinUrl || location.origin).replace(/^https?:\/\//, '').replace(/\?join=.*/, '')), qel('small', '', 'xona kodi'), qel('div', 'qg-code', S.code || ''));
    if (S.joinUrl) { const im = qel('img', 'qg-qr'); im.src = '/api/qr?text=' + encodeURIComponent(S.joinUrl); im.alt = 'QR kod'; im.width = 180; im.height = 180; l.appendChild(im); }
    const r = qel('div', 'qg-who');
    const n = qPlayersN(qz);
    r.appendChild(qel('div', 'qg-bigcount', String(n)));
    r.appendChild(qel('small', '', n === 1 ? 'o\'yinchi qo\'shildi' : 'o\'yinchi qo\'shildi'));
    const chips = qel('div', 'qg-chips');
    chips.dataset.sig = (S.members.list || []).slice(0, 120).map(m => stk(m.av) + m.name).join('\u0001');
    (S.members.list || []).slice(0, 120).forEach(m => chips.appendChild(qel('span', 'qg-chip', (stk(m.av) + ' ' + m.name).trim())));
    if (!n) chips.appendChild(qel('span', 'muted', 'O\'yinchilar kutilmoqda…'));
    r.appendChild(chips);
    d.append(l, r); body.appendChild(d);
  } else if (qz.phase === 'question') {
    const mid = qel('div', 'qg-midrow');
    const clock = qel('div', 'qz-clock'); const tt = qel('b'); tt.id = 'qgTime'; clock.appendChild(tt);
    const box = qel('div', 'qg-imgbox'); const im = qImg(qz.q); if (im) box.appendChild(im);
    const ans = qel('div', 'qg-ans'); const an = qel('b', '', String((S.qProg && S.qProg.answered) || 0)); an.id = 'qgAnsN'; ans.append(an, qel('small', '', 'javob'));
    mid.append(clock, box, ans);
    const tm = qel('div', 'qz-timer'); const bar = qel('i'); bar.id = 'qgBar'; tm.appendChild(bar); body.appendChild(tm);
    qBlock(body, qz, Object.assign({ gridId: 'qgGrid', countId: 'qgCount', mid, fill: true }, qz.hostPlay ? { onPick: qAnswer, picked: S.qAns, locked: S.qAns != null || sNow() < qz.startAt } : {}));   // Transmitter ham o'ynasa — plitalar bosiladigan bo'ladi
  } else if (qz.phase === 'reveal') {
    qBlock(body, qz, { reveal: true, fill: true });
    const side = qel('div', 'qg-side');
    if (qz.hostPlay) {                                                      // Transmitterning o'z natijasi
      const me = S.qMe, fresh = me && !me.stale, answered = S.qAns != null || (fresh && me.answered), ok = !!(fresh && me.ok);
      const bn = qel('div', 'qp-banner qg-me ' + (!fresh || !answered ? 'none' : ok ? 'ok' : 'no'), !fresh ? '⏳ Natija hisoblanmoqda…' : !answered ? '⌛ Javob bermadingiz' : ok ? '✅ To\'g\'ri!' : '❌ Noto\'g\'ri');
      if (fresh) bn.appendChild(qel('small', '', (ok ? `+${me.delta} ${ptU()} · ` : '') + (me.rank ? `O'rningiz: #${me.rank} / ${me.n} · ` : '') + `${me.score} ${ptU()}`));
      side.appendChild(bn);
    }
    side.appendChild(qel('h2', '', '🏆 Reyting'));
    lbList(side, qz.all || qz.top || [], true); body.appendChild(side);
  } else if (qz.phase === 'final' && qz.kind === 'hw') {
    body.appendChild(qel('h2', 'qg-final', '📝 Vazifa tekshirildi'));
    if (qz.hw) { hwSaveLast(qz); hwResults(body, qz.hw); } else body.appendChild(qel('p', 'muted', '⏳ Natijalar hisoblanmoqda…'));
  } else if (qz.phase === 'final') {
    body.appendChild(qel('h2', 'qg-final', '🏁 O\'yin yakunlandi'));
    const all = qz.all || qz.top || [];
    if (qz.celebrate !== false) ceremony(body, all); else podium(body, all);
    restPlaces(body, all, 3);
  }
  qSchedule(); qUpdate();
}
function qProgUpdate() {
  const a = document.getElementById('qgAnsN');
  if (a && S.qProg) a.textContent = String(S.qProg.answered);
  if (S.quiz && S.quiz.phase === 'lobby' && isHost()) renderQuizHost();
  else { const p = document.getElementById('qgPlayers'); if (p && S.quiz) p.textContent = qPlayersN(S.quiz); }
}
$('#qgFs').onclick = () => {
  const el = $('#qzGame');
  try { if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); } catch {}
};
$('#qgNext').onclick = () => send({ type: 'quiz-next' });
$('#qgHide').onclick = () => { if (S.quiz) send({ type: 'quiz-flag', k: 'hideOpts', v: !S.quiz.hideOpts }); };
$('#qgHideQ').onclick = () => { if (S.quiz) send({ type: 'quiz-flag', k: 'hideQ', v: !S.quiz.hideQ }); };
$('#qgCel').onclick = () => { if (S.quiz) send({ type: 'quiz-flag', k: 'celebrate', v: S.quiz.celebrate === false }); };
$('#qgStk').onclick = () => { if (S.quiz) send({ type: 'quiz-flag', k: 'stickers', v: S.quiz.stickers === false }); };
$('#qgHostPlay').onclick = () => { if (S.quiz) send({ type: 'quiz-flag', k: 'hostPlay', v: !S.quiz.hostPlay }); };
$('#qgKahoot').onclick = () => { if (S.quiz && S.quiz.phase === 'lobby') send({ type: 'quiz-flag', k: 'kahoot', v: S.quiz.kahoot === false }); };
$('#qgAuto').onclick = () => { if (S.quiz) send({ type: 'quiz-flag', k: 'auto', v: !S.quiz.auto }); };
$('#qgGuard').onclick = () => sendCfg({ guard: S.cfg.guard === false });
function updGuardBtn() { const b = $('#qgGuard'); if (!b) return; const on = S.cfg.guard !== false; b.textContent = on ? '🛡 Himoya: yoniq' : '🛡 Himoya: o\'chiq'; b.classList.toggle('act', on); }
$('#qgSfx').onclick = () => { SFX.toggle(); $('#qgSfx').textContent = SFX.on ? '🔔' : '🔕'; };
$('#qpSfx').onclick = () => { SFX.toggle(); $('#qpSfx').textContent = SFX.on ? '🔔' : '🔕'; };
$('#qzStrict').checked = localStorage.getItem('sc_qstrict') !== '0';
$('#qzStrict').onchange = e => localStorage.setItem('sc_qstrict', e.target.checked ? '1' : '0');
$('#qzStrikes').value = localStorage.getItem('sc_qstrikes') || '2';
$('#qzStrikes').onchange = e => localStorage.setItem('sc_qstrikes', e.target.value);
$('#qzHideQ').checked = localStorage.getItem('sc_qhideq') === '1';
$('#qzHideQ').onchange = e => localStorage.setItem('sc_qhideq', e.target.checked ? '1' : '0');
$('#qzStk').checked = localStorage.getItem('sc_qstk') !== '0';
$('#qzStk').onchange = e => localStorage.setItem('sc_qstk', e.target.checked ? '1' : '0');
$('#qzCel').checked = localStorage.getItem('sc_qcel') !== '0';
$('#qzCel').onchange = e => localStorage.setItem('sc_qcel', e.target.checked ? '1' : '0');
$('#qzHide').checked = localStorage.getItem('sc_qhide') === '1';
$('#qzHide').onchange = e => localStorage.setItem('sc_qhide', e.target.checked ? '1' : '0');
$('#qgSkip').onclick = () => send({ type: 'quiz-skip' });
$('#qgEnd').onclick = () => { if (confirm('O\'yin hozir yakunlansinmi?')) send({ type: 'quiz-end' }); };
$('#qgClose').onclick = () => { if (!S.quiz || S.quiz.phase === 'final' || confirm('O\'yin yopilsinmi? Natijalar yo\'qoladi.')) send({ type: 'quiz-close' }); };

// ---- Receiver: o'yinchi ekrani
function qAnswer(i) {
  const qz = S.quiz;
  if (!qz || qz.phase !== 'question' || S.qAns != null || sNow() < qz.startAt - 100) return;
  if (isHost() && !qz.hostPlay) return;                     // Transmitter faqat "o'ynaydi" yoqilganda javob bera oladi
  if (STRICT.blocked()) return;
  S.qAns = i; send({ type: 'quiz-answer', i });
  renderQuiz();
  try { navigator.vibrate && navigator.vibrate(30); } catch {}
}
function renderQuizPlay() {
  const qz = S.quiz, ov = $('#quizPlay');
  ov.hidden = !qz || isHost();
  document.body.classList.toggle('noscroll', !ov.hidden);
  if (!qz || isHost()) { qSchedule(); return; }
  $('#qpTitle').textContent = qz.title;
  $('#qpStep').textContent = qz.idx >= 0 ? `${qz.idx + 1}/${qz.total}` : '';
  $('#qpStep').hidden = qz.idx < 0;
  $('#qpPlayers').textContent = '👥 ' + qPlayersN(qz);
  $('#qpScore').textContent = '🏆 ' + (S.qMe ? S.qMe.score : 0);
  $('#qpSfx').textContent = SFX.on ? '🔔' : '🔕';
  $('#qpAv').textContent = stk(S.av); $('#qpAv').hidden = !stkOn();
  GUARD.watermark(); GUARD.sync();
  const body = $('#qpBody'); body.textContent = '';
  body.className = 'qp-body ph-' + qz.phase;
  ov.scrollTop = 0;
  const me = S.qMe;
  if (qz.phase === 'lobby') {
    const hwq = qz.kind === 'hw';
    const d = qel('div', 'qp-big card'); d.append(qel('div', 'em', hwq ? '📝' : '🎯'), qel('h2', '', hwq ? 'Uyga vazifa' : 'Tayyor bo\'ling!'), qel('p', 'muted', hwq ? `Transmitter boshlashini kuting. O'tish uchun kamida ${qz.pass}% to'g'ri javob kerak.` : 'Transmitter o\'yinni boshlashini kuting.'));
    const inp = document.createElement('input'); inp.maxLength = 24; inp.placeholder = 'Nikingiz'; inp.value = S.name || '';
    inp.onchange = () => { const v = inp.value.trim(); if (!v) { inp.value = S.name || ''; toast('Ism bo\'sh bo\'lishi mumkin emas'); return; } S.name = v; localStorage.setItem('sc_name', S.name); send({ type: 'quiz-nick', name: S.name }); };
    d.appendChild(inp);
    const grid = qel('div', 'av-grid');
    if (stkOn()) d.appendChild(qel('div', 'qp-avt', 'Belgingizni tanlang'));
    (stkOn() ? AVATARS : []).forEach(a => {
      const b = qel('button', 'av' + (a === S.av ? ' on' : ''), a); b.type = 'button'; b.setAttribute('aria-label', a);
      b.onclick = () => {
        S.av = a; try { localStorage.setItem('sc_av', a); } catch {}
        send({ type: 'quiz-avatar', av: a }); setTxt($('#qpAv'), a);
        grid.querySelectorAll('.av').forEach(x => x.classList.toggle('on', x.textContent === a));
      };
      grid.appendChild(b);
    });
    if (stkOn()) d.appendChild(grid);
    d.appendChild(qel('div', 'qp-n', `👥 ${qPlayersN(qz)} ta o'yinchi`));
    body.appendChild(d);
  } else if (qz.phase === 'question') {
    const tm = qel('div', 'qz-timer'); const bar = qel('i'); bar.id = 'qpBar'; tm.appendChild(bar); body.appendChild(tm);
    const t = qel('div', 'qz-time'); t.id = 'qpTime'; body.appendChild(t);
    qBlock(body, qz, { gridId: 'qpGrid', countId: 'qpCount', onPick: qAnswer, picked: S.qAns, locked: S.qAns != null || sNow() < qz.startAt, fill: true });
    if (qz.hideOpts && S.qAns == null) body.appendChild(qel('p', 'qp-hint', '👀 Variantlar katta ekranda. Rangli tugmani tanlang.'));
    if (S.qAns != null) body.appendChild(qel('p', 'qp-wait', '✔ Javob qabul qilindi. Boshqalarni kuting…'));
  } else if (qz.phase === 'reveal') {
    const fresh = me && !me.stale;
    const answered = S.qAns != null || (fresh && me.answered);
    const ok = !!(fresh && me.ok);
    const bn = qel('div', 'qp-banner ' + (!fresh ? 'none' : !answered ? 'none' : ok ? 'ok' : 'no'), !fresh ? '⏳ Natija hisoblanmoqda…' : !answered ? '⌛ Javob bermadingiz' : ok ? '✅ To\'g\'ri!' : '❌ Noto\'g\'ri');
    if (fresh) {
      bn.appendChild(qel('small', '', ok ? `+${me.delta} ${me.delta === 1 && S.quiz.kahoot === false ? 'to\'g\'ri javob' : ptU()}${me.streak >= 2 ? ' · 🔥 ' + me.streak + ' ta ketma-ket' : ''}` : 'Keyingi safar omad!'));
      if (me.rank) bn.appendChild(qel('small', '', `O'rningiz: #${me.rank} / ${me.n} · ${me.score} ${ptU()}`));
    }
    body.appendChild(bn);
    qBlock(body, qz, { reveal: true });
    if (qz.kind === 'hw') { if (fresh && me.right != null) body.appendChild(qel('p', 'muted center', `To'g'ri javoblaringiz: ${me.right} / ${qz.total}`)); }
    else { body.appendChild(qel('h2', '', '🏆 Reyting')); lbList(body, qz.top || [], true); }
  } else if (qz.phase === 'final' && qz.kind === 'hw') {
    body.appendChild(qel('h2', 'center', '📝 Vazifa yakunlandi'));
    hwPlayFinal(body, me, qz);
  } else if (qz.phase === 'final') {
    body.appendChild(qel('h2', 'center', '🏁 O\'yin yakunlandi'));
    const cel = qz.celebrate !== false;
    if (cel) ceremony(body, qz.top || []); else podium(body, qz.top || []);
    if (me && me.rank) body.appendChild(qel('div', 'qp-banner none', `Sizning o'rningiz: #${me.rank} / ${me.n}`)).appendChild(qel('small', '', `${me.score} ${ptU()}`));
    restPlaces(body, qz.top || [], 3);
  }
  qSchedule(); qUpdate();
}
// Taymer faqat "savol" bosqichida ishlaydi (boshqa paytda protsessor bekor yuklanmaydi); DOM faqat qiymat o'zgarganda yangilanadi
let qTick = 0;
function qSchedule() {
  const on = !!S.quiz && S.quiz.phase === 'question';
  if (on && !qTick) qTick = setInterval(qUpdate, 100);
  else if (!on && qTick) { clearInterval(qTick); qTick = 0; }
}
const setTxt = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
function qUpdate() {
  const qz = S.quiz;
  if (!qz || qz.phase !== 'question') return;
  const now = sNow(), toStart = (qz.startAt - now) / 1000, left = (qz.endAt - now) / 1000;
  ['qp', 'qg'].forEach(p => {
    const cnt = document.getElementById(p + 'Count'), bar = document.getElementById(p + 'Bar'), tm = document.getElementById(p + 'Time'), grid = document.getElementById(p + 'Grid');
    const bodyEl = document.getElementById(p + 'Body');
    if (cnt) { const h = toStart <= 0; if (cnt.hidden !== h) cnt.hidden = h; setTxt(cnt, String(Math.max(1, Math.ceil(toStart)))); }
    if (bodyEl) bodyEl.classList.toggle('pre', toStart > 0);
    if (bar) { const w = (toStart > 0 ? 100 : clamp(left / qz.q.time * 100, 0, 100)).toFixed(1) + '%'; if (bar.style.width !== w) bar.style.width = w; }
    if (tm) {
      const sec = Math.max(0, Math.ceil(left));
      setTxt(tm, toStart > 0 ? '' : String(sec));
      tm.classList.toggle('low', toStart <= 0 && sec <= 5);
    }
    if (grid && (p === 'qp' || qz.hostPlay)) grid.classList.toggle('locked', toStart > 0 || S.qAns != null);
  });
}

// ------------------------------------------------------------ 📝 UYGA VAZIFA: o'tish limiti, natija jadvali (o'tdi / o'tmadi), Excel/CSV
const hwPass = () => Math.min(100, Math.max(1, Math.round(Number($('#hwPass').value) || 60)));
const hwNeed = (n, pass) => (n > 0 ? Math.max(1, Math.ceil(n * (pass == null ? hwPass() : pass) / 100)) : 0);
const hwNeedN = n => hwNeed(n);
function hwNeedUpd() {
  const el = $('#hwNeed'); if (!el) return;
  const n = QZ.qs.length ? qzPlayN() : 0;
  el.textContent = n ? `${n} ta savoldan kamida ${hwNeed(n)} tasiga to'g'ri javob bersa — o'tadi` : 'Savollar qo\'shilgach necha ta to\'g\'ri javob kerakligi shu yerda ko\'rinadi';
}
function hwPassUI(save) {
  const v = hwPass();
  if (document.activeElement !== $('#hwPass')) $('#hwPass').value = v;
  document.querySelectorAll('#hwPassChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.p) === v));
  if (save) { try { localStorage.setItem('sc_hwpass', String(v)); } catch {} }
  hwNeedUpd(); if (typeof qzSummaryUpd === 'function' && QMODE === 'hw') qzSummaryUpd();
}
try { const v = localStorage.getItem('sc_hwpass'); if (v) $('#hwPass').value = v; $('#hwAuto').checked = localStorage.getItem('sc_hwauto') !== '0'; } catch {}
$('#hwAuto').onchange = e => { try { localStorage.setItem('sc_hwauto', e.target.checked ? '1' : '0'); } catch {} };
$('#hwPass').oninput = () => hwPassUI(false);
$('#hwPass').onchange = () => { $('#hwPass').value = hwPass(); hwPassUI(true); };
$('#hwPass').onfocus = () => $('#hwPass').select();
$('#hwPassMinus').onclick = () => { $('#hwPass').value = Math.max(1, hwPass() - 5); hwPassUI(true); };
$('#hwPassPlus').onclick = () => { $('#hwPass').value = Math.min(100, hwPass() + 5); hwPassUI(true); };
document.querySelectorAll('#hwPassChips button').forEach(b => { b.onclick = () => { $('#hwPass').value = b.dataset.p; hwPassUI(true); }; });

const hwStamp = () => { const d = new Date(), p2 = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const hwFile = (hw, ext) => `uyga-vazifa-${String(hw.title || 'natija').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)}-${hwStamp()}.${ext}`;
const hwStatus = r => (r.dq ? 'Chetlatildi' : r.passed ? 'O\'tdi' : 'O\'tmadi');
function hwSaveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function hwExport(hw, kind) {
  if (!hw || !hw.rows || !hw.rows.length) { toast('Natija yo\'q'); return; }
  const head = ['№', 'Ism (F.I.Sh)', 'To\'g\'ri javoblar', 'Jami savol', 'Foiz (%)', 'Natija', 'Sarflangan vaqt (s)'];
  const okN = hw.rows.filter(r => r.passed).length, tot = hw.rows.length;
  if (kind === 'csv' || !(window.SC && window.SC.xlsxBlob)) {
    const rows = [head, ...hw.rows.map((r, i) => [i + 1, r.name, r.right, r.total, r.pct, hwStatus(r), r.sec])];
    const csv = '\ufeff' + rows.map(r => r.map(c => { c = c == null ? '' : String(c); return /[",;\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',')).join('\r\n');
    return hwSaveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), hwFile(hw, 'csv'));
  }
  const res = { name: 'Natijalar', rows: [head, ...hw.rows.map((r, i) => [i + 1, r.name, r.right, r.total, r.pct, { v: hwStatus(r), s: r.passed ? 2 : 3 }, r.sec])], widths: [6, 34, 16, 12, 11, 14, 18], filter: true };
  const sum = { name: 'Umumiy', rows: [['Ko\'rsatkich', 'Qiymat'], [{ v: 'Vazifa', s: 5 }, hw.title || '—'], [{ v: 'Sana', s: 5 }, hwStamp()], ['Savollar soni', hw.total], ['O\'tish limiti', hw.pass + '% (kamida ' + hwNeed(hw.total, hw.pass) + ' ta to\'g\'ri)'],
    ['Qatnashdi', tot], ['O\'tdi', okN], ['O\'tmadi', tot - okN], ['O\'tganlar foizi', tot ? Math.round(okN / tot * 1000) / 10 + '%' : '0%']], widths: [26, 40] };
  hwSaveBlob(window.SC.xlsxBlob([res, sum]), hwFile(hw, 'xlsx'));
}
function hwButtons(hw, extra) {
  const bar = qel('div', 'btn-row');
  const b1 = qel('button', 'primary', '⬇ Excel (.xlsx)'), b2 = qel('button', 'sec', '⬇ CSV'); b1.type = b2.type = 'button';
  b1.onclick = () => hwExport(hw, 'xlsx'); b2.onclick = () => hwExport(hw, 'csv');
  bar.append(b1, b2);
  if (extra) extra.forEach(x => bar.appendChild(x));
  return bar;
}
function hwTable(hw, filter) {
  const wrap = qel('div', 'hw-wrap'), t = qel('table', 'hw-tbl'), thead = qel('thead'), tr = qel('tr');
  ['№', 'Ism', 'To\'g\'ri', 'Foiz', 'Natija'].forEach(h => tr.appendChild(qel('th', '', h)));
  thead.appendChild(tr); t.appendChild(thead);
  const tb = qel('tbody');
  hw.rows.forEach((r, i) => {
    if (filter === 'ok' && !r.passed) return; if (filter === 'no' && r.passed) return;
    const row = qel('tr', r.passed ? 'ok' : 'no');
    row.append(qel('td', '', String(i + 1)), qel('td', '', r.name), qel('td', '', `${r.right} / ${r.total}`), qel('td', '', r.pct + '%'), qel('td', '', (r.passed ? '✅ ' : '❌ ') + hwStatus(r)));
    tb.appendChild(row);
  });
  if (!tb.children.length) { const row = qel('tr'), td = qel('td', 'muted', 'Bu bo\'limda hech kim yo\'q'); td.colSpan = 5; row.appendChild(td); tb.appendChild(row); }
  t.appendChild(tb); wrap.appendChild(t); return wrap;
}
function hwSummary(hw) {
  const tot = hw.rows.length, okN = hw.rows.filter(r => r.passed).length, d = qel('div', 'hw-sum');
  const cell = (cls, n, l) => { const c = qel('div', cls); c.append(qel('b', '', String(n)), qel('small', '', l)); return c; };
  d.append(cell('', tot, 'qatnashdi'), cell('ok', okN, 'o\'tdi'), cell('no', tot - okN, 'o\'tmadi'), cell('', hw.pass + '%', `limit (≥ ${hwNeed(hw.total, hw.pass)} / ${hw.total})`));
  return d;
}
function hwResults(body, hw) {
  const box = qel('div', 'card hw-res');
  box.append(qel('h3', '', hw.title || 'Uyga vazifa'), hwSummary(hw));
  let f = 'all'; const tblBox = qel('div'), bar = qel('div', 'hw-bar');
  const paint = () => { tblBox.textContent = ''; tblBox.appendChild(hwTable(hw, f)); bar.querySelectorAll('.chipbtn').forEach(b => b.classList.toggle('on', b.dataset.f === f)); };
  [['all', 'Hammasi'], ['ok', '✅ O\'tdi'], ['no', '❌ O\'tmadi']].forEach(([k, t]) => { const b = qel('button', 'chipbtn', t); b.type = 'button'; b.dataset.f = k; b.onclick = () => { f = k; paint(); }; bar.appendChild(b); });
  const cp = qel('button', 'sec', '📋 O\'tmaganlarni nusxalash'); cp.type = 'button';
  cp.onclick = async () => {
    const t = hw.rows.filter(r => !r.passed).map(r => r.name).join('\n');
    if (!t) return toast('O\'tmagan o\'quvchi yo\'q 🎉');
    try { await navigator.clipboard.writeText(t); toast('✅ Nusxalandi'); } catch { toast('Nusxalab bo\'lmadi'); }
  };
  box.append(bar, tblBox, hwButtons(hw, [cp])); body.appendChild(box); paint();
}
function hwPlayFinal(body, me, qz) {
  if (!me || me.passed === undefined) { body.appendChild(qel('div', 'qp-banner none', '⏳ Natija hisoblanmoqda…')); return; }
  const dq = !!me.dq, ok = !!me.passed && !dq, box = qel('div', 'hw-me ' + (ok ? 'ok' : 'no'));
  box.append(qel('div', 'em', dq ? '🚫' : ok ? '🎉' : '😕'), qel('h2', '', dq ? 'Chetlatildingiz' : ok ? 'Tabriklaymiz, o\'tdingiz!' : 'Afsus, o\'tmadingiz'),
    qel('div', 'big', `${me.right} / ${me.total}`), qel('p', 'muted', `${me.pct}% · o'tish limiti ${qz.pass}% (kamida ${hwNeed(me.total, qz.pass)} ta)`));
  body.appendChild(box);
}
// oxirgi natijalar brauzerda saqlanadi — o'yin yopilgandan keyin ham Excel'ga yuklab olish mumkin
function hwSaveLast(qz) {
  if (S._hwSaved === qz.id) return; S._hwSaved = qz.id;
  try { localStorage.setItem('sc_hw_last', JSON.stringify(Object.assign({ at: Date.now() }, qz.hw))); } catch {}
}
function hwLastRender() {
  const box = $('#hwLast'); if (!box) return;
  let d = null; try { d = JSON.parse(localStorage.getItem('sc_hw_last') || 'null'); } catch {}
  box.textContent = '';
  if (!d || !Array.isArray(d.rows) || !d.rows.length) { box.hidden = true; return; }
  box.hidden = false;
  const okN = d.rows.filter(r => r.passed).length, when = new Date(d.at || Date.now()).toLocaleString('uz-UZ');
  box.append(qel('h3', '', '📊 Oxirgi natijalar'), qel('p', 'muted', `${d.title || 'Uyga vazifa'} · ${when} · ${d.rows.length} kishi · ✅ ${okN} · ❌ ${d.rows.length - okN} (limit ${d.pass}%)`));
  const rm = qel('button', 'sec', '🗑 Tozalash'); rm.type = 'button';
  rm.onclick = () => { try { localStorage.removeItem('sc_hw_last'); } catch {} hwLastRender(); };
  box.appendChild(hwButtons(d, [rm]));
}

qzLoad(); qzRender(); hwPassUI(false);

// ------------------------------------------------------------ 🎰 LUCK: g'ildirak aylanadi, kimga to'xtasa o'sha yutadi
// G'olibni server tanlaydi va hamma qurilmaga bir xil yuboradi; g'ildirak serverdagi vaqt (startAt) bo'yicha hamma ekranda bir vaqtda aylanadi va to'xtaydi.
// Ovoz (WebAudio sintezi, fayl yo'q): boshlanishda "vush", aylanayotganda g'ildirak "tik"lari va guvillash, to'xtaganda fanfara + olqish. Ovoz 🔔 (viktorina ovozlari) bilan o'chiriladi.
const LUCK = (() => {
  const el = $('#luck'), cv = $('#luckCv'), ptr = $('#luckPtr'), res = $('#luckRes'), info = $('#luckInfo'), btns = $('#luckBtns'), wrap = $('#luckWrap');
  const COL = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#8e24aa', '#00897b', '#f4511e', '#3949ab'];
  const SPINS = 7, ease = p => 1 - Math.pow(1 - p, 4);
  let cur = null, T = 0, raf = 0, lastIdx = -1, lastTick = 0, done = false, bus = null, drone = null, noise = null;
  const target = L => { const seg = 360 / L.segs.length; return SPINS * 360 + ((-(L.win + 0.5 + L.jit) * seg) % 360 + 360) % 360; };
  const idxAt = (th, n) => Math.floor((((-th) % 360 + 360) % 360) / (360 / n)) % n;
  // ---- ovoz
  function ac() {
    if (!SFX.on) return null;
    const c = ensureAudio(); if (!c || !master) return null;
    if (c.state !== 'running') c.resume().catch(() => {});
    if (!bus) { bus = c.createGain(); bus.gain.value = 0.55; bus.connect(master); }
    return c;
  }
  const nbuf = c => { if (!noise) { noise = c.createBuffer(1, c.sampleRate, c.sampleRate); const a = noise.getChannelData(0); for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1; } return noise; };
  function tone(c, t, f, d, o = {}) {
    const osc = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter(), v = o.v == null ? 0.25 : o.v;
    osc.type = o.type || 'triangle'; osc.frequency.setValueAtTime(f, t); if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + d);
    lp.type = 'lowpass'; lp.frequency.value = o.lp || 4200;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(lp); lp.connect(g); g.connect(bus); osc.start(t); osc.stop(t + d + 0.05);
  }
  function whoosh(c, t, d) {                                           // boshlanish: "vush" (filtr chastotasi ko'tariladi)
    const src = c.createBufferSource(); src.buffer = nbuf(c); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2; bp.frequency.setValueAtTime(250, t); bp.frequency.exponentialRampToValueAtTime(3000, t + d);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.35, t + d * 0.9); g.gain.linearRampToValueAtTime(0.0001, t + d + 0.1);
    src.connect(bp); bp.connect(g); g.connect(bus); src.start(t); src.stop(t + d + 0.2);
    tone(c, t, 220, d, { type: 'sawtooth', to: 880, v: 0.08, lp: 1800 });
  }
  function startDrone(c, t, d) {                                       // aylanish davomida pasayib boruvchi guvillash
    const osc = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(260, t); osc.frequency.exponentialRampToValueAtTime(70, t + d);
    lp.type = 'lowpass'; lp.frequency.value = 700;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.07, t + 0.4); g.gain.linearRampToValueAtTime(0.0001, t + d);
    osc.connect(lp); lp.connect(g); g.connect(bus); osc.start(t); osc.stop(t + d + 0.1); drone = osc;
  }
  function tick(p) {                                                   // g'ildirak "tik": oxirida pastroq va uzoqroq
    const c = ac(); if (!c) return;
    const f = 1500 - 700 * p;
    tone(c, c.currentTime, f, 0.05 + 0.04 * p, { type: 'square', v: 0.11, lp: 2600 });
  }
  function fanfare(me) {                                               // to'xtaganda: fanfara + olqish
    const c = ac(); if (!c) return;
    const t = c.currentTime + 0.05;
    [523, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.14, f, 0.4, { v: 0.28 }));
    [523, 659, 784, 1047, 1319].forEach(f => tone(c, t + 0.62, f, 1.3, { v: 0.14, type: 'sine' }));
    tone(c, t, 131, 0.9, { type: 'sine', v: 0.3, to: 98 });
    for (let k = 0; k < (me ? 70 : 42); k++) {                         // olqish: tasodifiy "paqqa"lar
      const s = c.createBufferSource(); s.buffer = nbuf(c); const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800 + Math.random() * 2600; bp.Q.value = 0.8;
      const g = c.createGain(), tt = t + 0.5 + Math.random() * 2.4; g.gain.setValueAtTime(0.0001, tt); g.gain.linearRampToValueAtTime(0.12, tt + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.07 + Math.random() * 0.05);
      s.connect(bp); bp.connect(g); g.connect(bus); s.start(tt, Math.random() * 0.5, 0.2);
    }
  }
  // ---- chizish
  function size() {
    const sz = Math.floor(Math.min(innerWidth * 0.9, innerHeight * 0.64, 620) - 28), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = cv.style.height = sz + 'px'; cv.width = cv.height = Math.round(sz * dpr);
  }
  function draw(th) {
    if (!cur) return;
    const n = cur.segs.length, R = cv.width / 2, g = cv.getContext('2d'), seg = Math.PI * 2 / n, fs = Math.max(11, Math.min(R * 0.11, R * 1.9 / n + 6));
    g.clearRect(0, 0, cv.width, cv.height); g.save(); g.translate(R, R); g.rotate((th - 90) * Math.PI / 180);
    for (let i = 0; i < n; i++) {
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, i * seg, (i + 1) * seg); g.closePath();
      g.fillStyle = COL[i % COL.length]; if (n % COL.length === 1 && i === n - 1) g.fillStyle = '#555'; g.fill();
      if (done && i !== cur.win) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fill(); }
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = Math.max(1, R * 0.006); g.stroke();
      g.save(); g.rotate((i + 0.5) * seg); g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.font = `800 ${fs}px system-ui, "Segoe UI Emoji", sans-serif`;
      g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 3;
      const s = cur.segs[i], nm = (s.a ? s.a + ' ' : '') + (s.n.length > 13 ? s.n.slice(0, 12) + '…' : s.n);
      g.fillText(nm, R * 0.93, 0); g.restore();
    }
    g.restore();
  }
  function frame() {
    raf = 0; if (!cur) return;
    const e = sNow() - cur.startAt, p = clamp(e / cur.dur, 0, 1), th = T * ease(p), idx = idxAt(th, cur.segs.length);
    draw(th);
    if (e > 0 && p < 1 && idx !== lastIdx && performance.now() - lastTick > 28) { lastTick = performance.now(); tick(p); ptr.classList.add('hit'); setTimeout(() => ptr.classList.remove('hit'), 60); }
    lastIdx = idx;
    if (p < 1) raf = requestAnimationFrame(frame); else finish(e - cur.dur > 6000);
  }
  function finish(late) {
    if (done) return; done = true;
    draw(T);
    const w = cur.winner, me = !!S.myId && w.id === S.myId;
    wrap.classList.add('done'); res.hidden = false; res.className = 'luck-res' + (me ? ' me' : ''); res.textContent = '';
    res.append(qel('div', 'lw-av', w.av || '🏆'), qel('div', 'lw-nm', me ? '🎉 Siz yutdingiz!' : w.name), qel('div', 'lw-sub', me ? w.name : '🏆 G\'olib!'));
    btns.hidden = !isHost();
    if (isHost()) { const l = $('#luckLast'); if (l) l.textContent = `Oxirgi g'olib: ${(w.av ? w.av + ' ' : '') + w.name}`; }
    if (!late) { fanfare(me); confetti(); if (me) { try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([200, 100, 200, 100, 400]); } catch {} } }
  }
  function stop() {
    cancelAnimationFrame(raf); raf = 0; cur = null; el.hidden = true; wrap.classList.remove('done');
    try { if (drone) drone.stop(); } catch {} drone = null;
  }
  function on(m) {
    if (m.close) return stop();
    if (!m.segs || !m.segs.length || sNow() > m.startAt + m.dur + 8000) return;            // eski xabar (qayta ulanish)
    stop();
    cur = m; T = target(m); done = false; lastIdx = idxAt(0, m.segs.length);
    res.hidden = true; btns.hidden = true; wrap.classList.remove('done');
    info.textContent = '👥 ' + m.total + (m.total > m.segs.length ? ` · g'ildirakda ${m.segs.length} ta` : '');
    el.hidden = false; size(); draw(0);
    const c = ac(), wait = Math.max(0, (m.startAt - sNow()) / 1000);
    if (c) { const t0 = c.currentTime + wait; whoosh(c, c.currentTime + Math.max(0, wait - 1.3), Math.min(1.3, Math.max(0.4, wait))); startDrone(c, t0, m.dur / 1000); }
    raf = requestAnimationFrame(frame);
  }
  addEventListener('resize', () => { if (cur) { size(); draw(done ? T : T * ease(clamp((sNow() - cur.startAt) / cur.dur, 0, 1))); } });
  $('#luckX').onclick = () => { if (isHost()) send({ type: 'luck-close' }); else stop(); };
  $('#luckClose').onclick = () => send({ type: 'luck-close' });
  const go = () => send({ type: 'luck-start', noRepeat: $('#luckNoRep').checked });
  $('#luckAgain').onclick = go;
  $('#luckGo').onclick = go;
  try { $('#luckNoRep').checked = localStorage.getItem('sc_luckNR') === '1'; } catch {}
  $('#luckNoRep').onchange = e => { try { localStorage.setItem('sc_luckNR', e.target.checked ? '1' : '0'); } catch {} };
  return { on, stop };
})();

// ------------------------------------------------------------ Mini o'yinlar: ⚡ Tez bos · 👆 Tap-poyga · 🔢 Raqamni top
// Server vaqt va natijani boshqaradi; bu yerda faqat ko'rsatish va tugma/son yuborish. Hamma qurilmada bir xil overlay ochiladi.
const MG = (() => {
  const el = $('#mg'), body = $('#mgBody'), title = $('#mgTitle'), info = $('#mgInfo'), btns = $('#mgBtns'), again = $('#mgAgain');
  const NAMES = { rx: '⚡ Tez bos', tap: '👆 Tap-poyga', gs: '🔢 Raqamni top' }, MEDAL = ['🥇', '🥈', '🥉'];
  let cur = null, my = null, key = '', raf = 0, flushT = 0, tapN = 0, pend = 0, acted = '', picked = null, won = '', last = null, bus = null, lastN = -1;
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const vib = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  function beep(f, d = 0.12, type = 'sine', v = 0.22, delay = 0) {                       // WebAudio sintezi (fayl yo'q); 🔔 bilan o'chiriladi
    if (!SFX.on) return;
    const c = ensureAudio(); if (!c || !master) return;
    if (c.state !== 'running') c.resume().catch(() => {});
    if (!bus) { bus = c.createGain(); bus.gain.value = 0.6; bus.connect(master); }
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + d + 0.03);
  }
  const win = () => { [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.35, 'triangle', 0.26, i * 0.13)); beep(1319, 0.9, 'sine', 0.14, 0.55); };
  const mine = () => !!(my && cur && my.id === cur.id);
  const fmt = { rx: r => r.v + ' ms', tap: r => r.v + ' 👆', gs: r => r.v + (r.d === 0 ? ' · 🎯 aniq' : ' · ±' + r.d) };

  function board(top, game, big) {
    const ol = mk('ol', 'mg-board' + (big ? ' big' : ''));
    if (!top || !top.length) { ol.appendChild(mk('li', 'empty', 'Hali hech kim yo\'q…')); return ol; }
    top.forEach((r, i) => {
      const li = mk('li', r.i === S.myId ? 'me' : '');
      li.append(mk('span', 'mg-rk', MEDAL[i] || (i + 1) + '.'), mk('span', 'mg-nm', (r.a ? r.a + ' ' : '') + r.n), mk('b', 'mg-val', fmt[game](r)));
      ol.appendChild(li);
    });
    return ol;
  }
  function meLine() {                                                                   // receiverning o'z natijasi
    if (isHost() || !mine() || !my.final) return null;
    let t, cls = 'mg-me';
    if (my.foul) t = '❌ Erta bosdingiz — bu raundda chiqdingiz';
    else if (my.none || !my.rank) t = 'Siz bu o\'yinda qatnashmadingiz';
    else { t = `Siz: ${my.rank}-o'rin / ${my.played}` + (cur.game === 'rx' ? ` · ${my.v} ms` : cur.game === 'tap' ? ` · ${my.v} ta bosish` : ` · taxmin ${my.v}` + (my.d === 0 ? ' 🎯' : ` (±${my.d})`)); if (my.rank === 1) cls += ' first'; }
    return mk('div', cls, t);
  }
  function tickTime(timeEl, barEl, fn) {                                                // vaqt sanog'i + progress (serverdagi vaqt bo'yicha)
    const f = () => {
      if (!cur) return;
      const now = sNow(), left = Math.max(0, cur.endAt - now);
      timeEl.textContent = Math.ceil(left / 1000) + ' s';
      barEl.style.width = (100 * clamp(left / (cur.dur * 1000), 0, 1)) + '%';
      if (fn) fn(now);
      if (left > 0 || now < cur.endAt + 600) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
  }

  // ---- ⚡ Tez bos
  function viewRx(ph, host) {
    if (ph === 'result') return;
    const pad = mk('button', 'mg-pad'); pad.type = 'button';
    const done = !host && ((mine() && !my.final) || acted === cur.id);
    if (done) {
      const foul = mine() && my.foul;
      pad.classList.add(foul ? 'gray' : 'blue');
      pad.append(mk('b', '', foul ? 'Erta bosdingiz ✖' : mine() && my.v != null ? my.v + ' ms' : '✔ Bosildi…'), mk('small', '', foul ? 'Bu raundda chiqib ketdingiz' : 'Boshqalarni kuting…'));
    } else if (ph === 'wait') {
      pad.classList.add('red');
      pad.append(mk('b', '', host ? 'Kuting…' : 'Tayyor bo\'ling…'), mk('small', '', host ? 'Receiverlar yashil rangni kutmoqda' : 'Ekran YASHIL bo\'lganda bosing. Erta bossangiz — chiqib ketasiz!'));
    } else {
      pad.classList.add('green');
      pad.append(mk('b', '', 'BOS!!!'));
    }
    if (!host && !done && (ph === 'wait' || ph === 'go')) {
      pad.onpointerdown = e => { e.preventDefault(); if (acted === cur.id) return; acted = cur.id; send({ type: 'mg-act' }); vib(25); render(); };
    }
    body.appendChild(pad);
  }

  // ---- 👆 Tap-poyga
  function flush() { if (pend > 0) { const n = Math.min(pend, 8); pend -= n; send({ type: 'mg-act', n }); } }
  function viewTap(ph, host) {
    if (ph === 'ready') {
      const c = mk('div', 'mg-count', '3'); body.append(mk('p', 'mg-hint', host ? 'Hamma tayyorlanmoqda…' : 'Tayyor bo\'ling! Tugmani eng tez bosing!'), c); lastN = -1;
      const f = () => {
        if (!cur) return;
        const left = cur.startAt - sNow();
        if (left <= 0) { cur.phase = 'play'; render(); return; }
        const n = Math.ceil(left / 1000);
        if (n !== lastN) { lastN = n; c.textContent = n; c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); beep(660, 0.12, 'square', 0.16); }
        raf = requestAnimationFrame(f);
      };
      raf = requestAnimationFrame(f);
      return;
    }
    if (ph === 'play') {
      beep(990, 0.4, 'square', 0.2);
      const head = mk('div', 'mg-timer'), tm = mk('b', '', ''), bar = mk('i', 'bar'), barw = mk('div', 'barw'); barw.appendChild(bar); head.append(tm); body.append(head, barw);
      const top = mk('div', 'mg-topbox'); top.id = 'mgTop'; top.appendChild(board(cur.top, 'tap', host));
      if (!host) {
        const b = mk('button', 'mg-tap'); b.type = 'button'; b.id = 'mgTapBtn';
        const cnt = mk('b', 'cnt', String(tapN)); b.append(mk('span', 'ico', '👆'), cnt, mk('small', '', 'bosing!'));
        b.onpointerdown = e => {
          e.preventDefault();
          const now = sNow(); if (now < cur.startAt || now > cur.endAt) return;
          tapN++; pend++; cnt.textContent = tapN; vib(8); beep(520 + (tapN % 6) * 40, 0.04, 'square', 0.07);
          b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
        };
        body.appendChild(b);
        flushT = setInterval(flush, 120);
      } else body.appendChild(mk('div', 'mg-hint', '👥 ' + (cur.total || 0) + ' o\'yinchi bosmoqda!'));
      body.appendChild(top);
      tickTime(tm, bar, now => { const b = $('#mgTapBtn'); if (b && now > cur.endAt) { b.disabled = true; b.classList.add('off'); } });
      return;
    }
    body.append(mk('h3', 'mg-h', '🏆 Natijalar'), board(cur.top, 'tap', true));
  }

  // ---- 🔢 Raqamni top
  function viewGs(ph, host) {
    if (ph === 'result') {
      body.append(mk('div', 'mg-secret', 'Yashirin son'), mk('div', 'mg-big', String(cur.secret)), mk('h3', 'mg-h', '🏆 Eng yaqinlar'), board(cur.top, 'gs', true));
      return;
    }
    const head = mk('div', 'mg-timer'), tm = mk('b', '', ''), bar = mk('i', 'bar'), barw = mk('div', 'barw'); barw.appendChild(bar); head.append(tm); body.append(head, barw);
    body.append(mk('div', 'mg-secret', 'Men 1 dan ' + cur.max + ' gacha son o\'yladim…'), mk('div', 'mg-big', '❓'));
    const ans = mk('p', 'mg-hint', ''); ans.id = 'mgAns'; ans.textContent = `✍ Javob berganlar: ${cur.answered || 0}/${cur.total || 0}`;
    let inp = null, send1 = null;
    if (!host) {
      const row = mk('div', 'mg-gs'); inp = mk('input'); inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = 1; inp.max = cur.max; inp.placeholder = '1 – ' + cur.max; inp.setAttribute('aria-label', 'Taxmin');
      if (picked != null) inp.value = picked;
      send1 = mk('button', 'primary', 'Yuborish'); send1.type = 'button';
      const st = mk('p', 'mg-hint', picked != null ? `✔ Javobingiz: ${picked} (o'zgartirish mumkin)` : ''); st.id = 'mgGsSt';
      const go = () => {
        const v = Math.round(+inp.value);
        if (!Number.isFinite(v) || v < 1 || v > cur.max) { st.textContent = `1 dan ${cur.max} gacha son yozing`; return; }
        if (sNow() < cur.startAt || sNow() > cur.endAt) return;
        picked = v; send({ type: 'mg-act', v }); st.textContent = `✔ Javobingiz: ${v} (o'zgartirish mumkin)`; vib(20); beep(740, 0.1, 'triangle', 0.2);
      };
      send1.onclick = go; inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      row.append(inp, send1); body.append(row, st);
    }
    body.appendChild(ans);
    tickTime(tm, bar, now => { if (inp) { const off = now < cur.startAt || now > cur.endAt; inp.disabled = off; send1.disabled = off; } });
  }

  // ---- umumiy chizish
  function render() {
    if (!cur) return;
    const host = isHost(), g = cur.game, ph = cur.phase;
    title.textContent = NAMES[g] || 'O\'yin'; info.textContent = '👥 ' + (cur.total || 0);
    btns.hidden = !host; again.hidden = ph !== 'result';
    const k = cur.id + ph, fresh = k !== key; key = k;
    if (!fresh && ph === 'play') {                                                       // jonli yangilanish: sahifani qayta qurmasdan
      if (g === 'tap') { const t = $('#mgTop'); if (t) t.replaceChildren(board(cur.top, 'tap', host)); }
      if (g === 'gs') { const a = $('#mgAns'); if (a) a.textContent = `✍ Javob berganlar: ${cur.answered || 0}/${cur.total || 0}`; }
      return;
    }
    cancelAnimationFrame(raf); clearInterval(flushT); body.textContent = '';
    if (fresh && ph === 'go' && !host) { beep(880, 0.25, 'square', 0.2); vib(40); }
    if (g === 'rx') viewRx(ph, host); else if (g === 'tap') viewTap(ph, host); else if (g === 'gs') viewGs(ph, host);
    if (ph === 'result') {
      if (g === 'rx') {
        body.append(mk('h3', 'mg-h', '🏆 Eng tezlar'), board(cur.top, 'rx', true));
        if (cur.fouls) body.append(mk('p', 'mg-hint', `❌ Erta bosganlar: ${cur.fouls}`));
        if (!cur.top.length) body.append(mk('p', 'mg-hint', 'Hech kim to\'g\'ri bosa olmadi 😅'));
      }
      const me = meLine(); if (me) body.prepend(me);
      if (fresh && host) win();
    }
  }
  function celebrate() {
    if (!my || !my.final || won === cur.id) return; won = cur.id;
    if (my.rank === 1) { win(); confetti(); vib([80, 40, 80, 40, 160]); } else if (my.rank) beep(660, 0.2, 'triangle', 0.18);
  }

  function on(m) {
    if (m.close) return stop();
    if (!cur || cur.id !== m.id) {                                                       // yangi o'yin
      cancelAnimationFrame(raf); clearInterval(flushT);
      my = null; tapN = 0; pend = 0; picked = null; acted = ''; key = '';
      el.hidden = false; try { document.body.classList.add('noscroll'); } catch {}
      cur = Object.assign({}, m); beep(440, 0.1, 'triangle', 0.18); beep(660, 0.14, 'triangle', 0.18, 0.1);
    } else cur = Object.assign(cur, m);
    render();
  }
  function meMsg(m) { if (!cur || m.id !== cur.id) return; my = m; render(); celebrate(); }
  function stop() {
    cancelAnimationFrame(raf); clearInterval(flushT); cur = null; my = null; key = ''; el.hidden = true; body.textContent = '';
    try { document.body.classList.remove('noscroll'); } catch {}
  }
  function start(game, opts) { last = Object.assign({ type: 'mg-start', game }, opts || {}); send(last); }
  $('#mgX').onclick = () => { if (isHost()) send({ type: 'mg-close' }); else stop(); };
  $('#mgClose').onclick = () => send({ type: 'mg-close' });
  again.onclick = () => { if (last) send(last); };
  $('#mgRx').onclick = () => start('rx');
  $('#mgTap').onclick = () => start('tap', { dur: +$('#mgTapDur').value });
  $('#mgGs').onclick = () => start('gs', { max: +$('#mgGsMax').value, dur: +$('#mgGsDur').value });
  return { on, me: meMsg, stop };
})();

// ------------------------------------------------------------ 🙈 Yashirinmoqchoq · 🔼 Kichik-katta
// Server hamma narsani hisoblaydi; har qurilmaga o'ziga mos holat keladi (cur.me: keeper = qidiruvchi / son egasi, player, watch).
const GM = (() => {
  const el = $('#gm'), body = $('#gmBody'), title = $('#gmTitle'), info = $('#gmInfo'), btns = $('#gmBtns'), again = $('#gmAgain');
  const NAMES = { hs: '🙈 Yashirinmoqchoq', hl: '🔼 Kichik · Katta' };
  let cur = null, tmr = 0, key = '', last = null, bus = null, lastN = -1, done = '', reply = null, cool = 0;
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const vib = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  function beep(f, d = 0.12, type = 'sine', v = 0.22, delay = 0) {                       // WebAudio sintezi; 🔔 bilan o'chiriladi
    if (!SFX.on) return;
    const c = ensureAudio(); if (!c || !master) return;
    if (c.state !== 'running') c.resume().catch(() => {});
    if (!bus) { bus = c.createGain(); bus.gain.value = 0.6; bus.connect(master); }
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + d + 0.03);
  }
  const win = () => { [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.35, 'triangle', 0.26, i * 0.13)); beep(1319, 0.9, 'sine', 0.14, 0.55); };
  const nm = x => (x ? (x.a ? x.a + ' ' : '') + x.n : '?');
  const fmtT = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const role = () => (cur && cur.me && cur.me.role) || 'watch';
  const act = o => send(Object.assign({ type: 'gm-act' }, o));
  const every = fn => { clearInterval(tmr); fn(); tmr = setInterval(fn, 200); };
  const meLine = txt => mk('div', 'mg-me', txt);

  function board(rows, val, mark) {
    const ol = mk('ol', 'mg-board big');
    rows.forEach((r, i) => { const li = mk('li'); li.append(mk('span', 'mg-rk', mark || (i + 1) + '.'), mk('span', 'mg-nm', nm(r)), mk('b', 'mg-val', val ? val(r) : '')); ol.appendChild(li); });
    return ol;
  }

  // ---------------- 🙈 Yashirinmoqchoq
  function hsHide(host) {
    const r = role(), c = cur, cd = mk('div', 'mg-count', ''); cd.style.fontSize = 'clamp(64px, 22vw, 150px)';
    if (r === 'keeper') body.append(mk('div', 'gm-emo', '🙈'), mk('h2', 'gm-h', 'Ko\'zingizni yuming!'), mk('p', 'mg-hint', `Ekranga qaramang — ${c.total} kishi yashirinmoqda…`), cd);
    else if (r === 'player') body.append(mk('div', 'gm-emo', '🏃'), mk('h2', 'gm-h', 'Yashirining!'), mk('p', 'mg-hint', `Qidiruvchi: ${nm(c.chosen)}. Qidirish boshlanishiga:`), cd);
    else body.append(mk('div', 'gm-emo', '🙈'), mk('h2', 'gm-h', 'Yashirinish vaqti'), mk('p', 'mg-hint', `Qidiruvchi: ${nm(c.chosen)} · yashirinuvchilar: ${c.total}`), cd);
    if (host) { const sk = mk('button', 'sec', '⏭ Qidirishni hozir boshlash'); sk.type = 'button'; sk.onclick = () => act({ a: 'skip' }); body.appendChild(sk); }
    lastN = -1;
    every(() => {
      if (!cur) return;
      const left = Math.max(0, cur.hideEnd - sNow()), n = Math.ceil(left / 1000);
      cd.textContent = left > 60000 ? fmtT(left) : n;
      if (n <= 5 && n > 0 && n !== lastN) { lastN = n; beep(660, 0.1, 'square', 0.16); }
    });
  }
  function hsSeek(host) {
    const r = role(), c = cur, me = c.me, tm = mk('div', 'mg-timer', '');
    body.appendChild(tm);
    const left = (c.total || 0) - (c.foundN || 0);
    if (r === 'keeper') body.appendChild(mk('div', 'gm-banner', '🔎 Qidiring! Topganingizni «Topdim» bilan belgilang.'));
    else if (r === 'player') body.appendChild(mk('div', 'gm-banner', `🤫 Jim yashirining! Qidiruvchi: ${nm(c.chosen)}`));
    else body.appendChild(mk('div', 'gm-banner', `🔎 Qidiruvchi: ${nm(c.chosen)}` + (host ? ' · Siz hakamsiz: topilganlarni belgilashingiz mumkin' : '')));
    body.appendChild(mk('p', 'mg-hint', `Topildi: ${c.foundN || 0} / ${c.total}  ·  Qoldi: ${left}`));
    if (r === 'player') {
      if (me.found) body.append(mk('div', 'gm-emo', '😅'), mk('h2', 'gm-h', 'Siz topildingiz ✔'), mk('p', 'mg-hint', `Topilgan vaqt: ${fmtT(me.t)}`));
      else {
        const b = mk('button', 'gm-big-btn', '😅 Topildim'); b.type = 'button';
        b.onclick = () => { act({ a: 'found' }); b.disabled = true; vib(40); beep(440, 0.2, 'triangle', 0.2); };
        body.appendChild(b);
      }
    }
    if (c.list && (r === 'keeper' || host)) {
      const ul = mk('ul', 'gm-list');
      [...c.list].sort((a, b) => (a.f - b.f) || (a.f ? a.t - b.t : String(a.n).localeCompare(b.n))).forEach(p => {
        const li = mk('li', p.f ? 'found' : ''), b = mk('button', p.f ? 'undo' : '', p.f ? '↩' : '✅ Topdim'); b.type = 'button';
        b.title = p.f ? 'Belgini bekor qilish' : 'Topdim';
        b.onclick = () => { act({ a: p.f ? 'unmark' : 'mark', id: p.id }); if (!p.f) { vib(30); beep(660, 0.14, 'triangle', 0.2); } };
        li.append(mk('span', 'nm', nm(p)), mk('span', 'st', p.f ? '✔ ' + fmtT(p.t) : '🤫 yashirin'), b); ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    every(() => {
      if (!cur) return;
      const now = sNow();
      tm.textContent = cur.seekEnd ? '⏱ ' + fmtT(Math.max(0, cur.seekEnd - now)) : '⏱ ' + fmtT(now - cur.seekStart);
    });
  }
  function hsResult(host) {
    const c = cur, res = c.res, r = role(), me = c.me;
    body.append(mk('div', 'gm-emo', res.all ? '🎉' : '🏆'),
      mk('h2', 'gm-h', res.all ? `${nm(c.chosen)} hammani topdi!` : 'Yashiringanlar yutdi!'),
      mk('p', 'mg-hint', res.all ? `Jami vaqt: ${fmtT(c.elapsed)}` : `${nm(c.chosen)} ${res.foundN} / ${res.total} ni topdi · vaqt tugadi`));
    if (r === 'keeper') body.appendChild(meLine(res.all ? '🏆 Siz hammani topdingiz!' : `Siz ${res.foundN} / ${res.total} ni topdingiz`));
    else if (r === 'player') body.appendChild(meLine(me.found ? `Sizni ${fmtT(me.t)} da topishdi` : '🏆 Siz topilmadingiz — g\'olib!'));
    if (res.order.length) body.append(mk('h3', 'mg-h', '🔎 Topilganlar'), board(res.order, x => fmtT(x.t)));
    if (res.leftN) { body.append(mk('h3', 'mg-h', '🫥 Topilmaganlar'), board(res.left, null, '🏆')); if (res.leftN > res.left.length) body.appendChild(mk('p', 'mg-hint', `…va yana ${res.leftN - res.left.length} kishi`)); }
  }

  // ---------------- 🔼 Kichik · Katta
  const RTXT = { up: ['⬆ KATTA', 'son bundan kattaroq'], down: ['⬇ KICHIK', 'son bundan kichikroq'], hit: ['🎯 TOPDINGIZ!', ''] };
  let mine = { id: '', list: [] };                                                         // shu o'yindagi mening taxminlarim
  const myList = () => (cur && mine.id === cur.id ? mine.list : []);
  function paintReply(box) {
    if (!box) return;
    const l = myList(), rp = l.length ? l[l.length - 1] : null;
    box.className = 'gm-reply' + (rp ? ' ' + rp.d : ''); box.textContent = '';
    if (!rp) { box.append(mk('small', '', 'Birinchi taxminingizni yozing'), mk('span', '', '🤔')); return; }
    box.append(mk('small', '', rp.v + ' ga javob'), mk('span', '', RTXT[rp.d][0]), mk('small', '', RTXT[rp.d][1]));
  }
  function numRow(max, onGo, midFn) {
    const wrap = mk('div', 'gm-in'), row = mk('div', 'gm-step'), inp = mk('input'), go = mk('button', 'gm-go', 'Yuborish'),
      minus = mk('button', 'gm-pm', '−'), plus = mk('button', 'gm-pm', '+'), tip = mk('button', 'gm-mid', ''), msg = mk('p', 'gm-msg', '');
    inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = 1; inp.max = max; inp.placeholder = '?'; inp.setAttribute('aria-label', 'Taxmin');
    [go, minus, plus, tip].forEach(b => { b.type = 'button'; });
    minus.setAttribute('aria-label', 'Kamaytirish'); plus.setAttribute('aria-label', 'Ko\'paytirish');
    const val = () => { const v = Math.round(+inp.value); return inp.value !== '' && Number.isFinite(v) ? v : NaN; };
    const step = d => { const c = val(), m = midFn(); inp.value = String(clamp((Number.isFinite(c) ? c : m) + d, 1, max)); inp.focus(); };
    minus.onclick = () => step(-1); plus.onclick = () => step(1);
    tip.onclick = () => { inp.value = String(midFn()); inp.focus(); };
    const submit = () => {
      const v = val();
      if (!Number.isFinite(v) || v < 1 || v > max) { inp.classList.add('bad'); msg.textContent = `1 dan ${max} gacha son yozing`; return; }
      inp.classList.remove('bad'); msg.textContent = '';
      if (onGo(v) !== false) { inp.value = ''; if (!matchMedia('(pointer: coarse)').matches) inp.focus(); }
    };
    go.onclick = submit; inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    inp.addEventListener('input', () => { inp.classList.remove('bad'); msg.textContent = ''; });
    row.append(minus, inp, plus); wrap.append(row, go, tip, msg);
    return { wrap, inp, go, minus, plus, tip, msg };
  }
  function hlPick(host) {
    const c = cur, r = role(), cd = mk('p', 'mg-hint', '');
    if (r === 'keeper') {
      body.append(mk('div', 'gm-emo', '🤔'), mk('h2', 'gm-h', 'Son o\'ylang'), mk('p', 'mg-hint', `1 dan ${c.max} gacha son yozing. Uni faqat siz ko'rasiz.`));
      const nr = numRow(c.max, v => { act({ a: 'secret', v }); vib(30); }, () => Math.ceil(c.max / 2));
      nr.go.textContent = '✔ Tayyor'; nr.tip.hidden = true;
      body.append(nr.wrap, cd); setTimeout(() => { try { nr.inp.focus(); } catch {} }, 100);
    } else body.append(mk('div', 'gm-emo', '🤔'), mk('h2', 'gm-h', `${nm(c.chosen)} son o'ylamoqda…`), mk('p', 'mg-hint', `1 dan ${c.max} gacha. Tayyor bo'lishi bilan taxmin qilasiz!`), cd);
    every(() => { if (cur) cd.textContent = r === 'keeper' ? `Yozmasangiz ${Math.max(0, Math.ceil((cur.pickEnd - sNow()) / 1000))} s dan keyin tasodifiy son tanlanadi` : ''; });
  }
  function feedList(feed) {
    const ul = mk('ul', 'gm-feed'); ul.id = 'gmFeed';
    if (!feed.length) ul.appendChild(mk('li', 'empty', 'Hali taxmin yo\'q — birinchi bo\'ling!'));
    feed.forEach(f => { const li = mk('li'); li.append(mk('span', 'nm', nm(f)), mk('b', '', String(f.v)), mk('span', 'dir ' + f.d, f.d === 'up' ? '⬆ katta' : f.d === 'down' ? '⬇ kichik' : '🎯')); ul.appendChild(li); });
    return ul;
  }
  const triesTxt = c => `👥 ${c.total} taxminchi · ${c.tries || 0} ta taxmin`;
  const pct = (c, v) => ((v - 1) / Math.max(1, c.max - 1) * 100).toFixed(2) + '%';
  const midOf = c => Math.floor((c.lo + c.hi) / 2);
  function rangeBox(c) {                                                                   // qolgan oraliq: chiziq + ikki chetda eng kichik / eng katta mumkin son
    const box = mk('div', 'gm-range'); box.id = 'gmRange';
    const ends = mk('div', 'gm-ends'), l = mk('div', 'gm-end'), h = mk('div', 'gm-end r');
    l.append(mk('small', '', 'eng kichik'), mk('b', '', '')); h.append(mk('small', '', 'eng katta'), mk('b', '', ''));
    ends.append(l, mk('div', 'gm-left', ''), h);
    const tr = mk('div', 'gm-track'), fill = mk('i', 'gm-fill'); tr.appendChild(fill);
    box.append(ends, tr); paintRange(box, c); return box;
  }
  function paintRange(box, c) {
    if (!box) return;
    const bs = box.querySelectorAll('.gm-end b'); bs[0].textContent = c.lo; bs[1].textContent = c.hi;
    const left = Math.max(0, c.hi - c.lo + 1);
    box.querySelector('.gm-left').textContent = left <= 1 ? 'Qoldi: 1 ta son!' : `${left} ta son qoldi`;
    const f = box.querySelector('.gm-fill'); f.style.left = pct(c, c.lo); f.style.width = (((c.hi - c.lo) / Math.max(1, c.max - 1)) * 100 + 100 / Math.max(1, c.max)).toFixed(2) + '%';
    box.querySelectorAll('.gm-dot').forEach(d => d.remove());
    const tr = box.querySelector('.gm-track');
    myList().forEach(g => { const d = mk('em', 'gm-dot ' + g.d); d.style.left = pct(c, g.v); d.title = String(g.v); tr.appendChild(d); });
  }
  function paintMine() {
    const box = $('#gmMine'); if (!box) return;
    box.textContent = ''; const l = myList();
    box.hidden = !l.length; if (!l.length) return;
    box.append(mk('small', '', 'Mening taxminlarim:'));
    l.slice(-8).forEach(g => box.appendChild(mk('span', 'gm-chip ' + g.d, g.v + (g.d === 'up' ? ' ⬆' : g.d === 'down' ? ' ⬇' : ' 🎯'))));
  }
  let ui = null;
  function hlPlay() {
    const c = cur, r = role(), tm = mk('div', 'mg-timer', '');
    const rg = rangeBox(c); body.append(tm, rg);
    ui = null;
    if (r === 'keeper') body.append(mk('div', 'mg-secret', 'Siz o\'ylagan son'), mk('div', 'gm-secret', String(c.me.secret || '?')), mk('p', 'mg-hint', 'Taxminlarga avtomatik «katta / kichik» javob beriladi.'));
    else if (r === 'player') {
      const box = mk('div', ''); box.id = 'gmReply'; paintReply(box);
      const nr = numRow(c.max, v => {
        if (sNow() < cur.startAt || (cur.endAt && sNow() > cur.endAt)) return false;
        if (v < cur.lo || v > cur.hi) { nr.msg.textContent = `Javob ${cur.lo} – ${cur.hi} oralig'ida. Shu oraliqdan tanlang.`; nr.inp.classList.add('bad'); vib(60); return false; }
        act({ a: 'guess', v }); vib(15); coolUntil = Date.now() + 650; syncUi();
      }, () => midOf(cur));
      ui = nr; body.append(box);
      const mc = mk('div', 'gm-mine'); mc.id = 'gmMine'; mc.hidden = true; body.append(nr.wrap, mc); paintMine();
      syncUi();
    }
    const tr = mk('p', 'mg-hint', triesTxt(c)); tr.id = 'gmTries'; body.append(tr, feedList(c.feed || []));
    every(() => {
      if (!cur) return;
      const now = sNow(), before = now < cur.startAt;
      tm.textContent = before ? 'Tayyor…' : cur.endAt ? '⏱ ' + fmtT(Math.max(0, cur.endAt - now)) : '⏱ cheksiz';
      syncUi();
    });
  }
  let coolUntil = 0;
  function syncUi() {                                                                       // tugma holati: vaqt kelmagan / tugagan / yuborilgandan keyingi qisqa pauza
    if (!ui || !cur) return;
    const now = sNow(), off = now < cur.startAt || !!(cur.endAt && now > cur.endAt), cool = Date.now() < coolUntil;
    ui.inp.disabled = off; ui.minus.disabled = off; ui.plus.disabled = off; ui.tip.disabled = off; ui.go.disabled = off || cool;
    ui.go.textContent = off ? '⏳ Kuting…' : cool ? '…' : 'Yuborish';
    ui.tip.textContent = `💡 O'rtasi: ${midOf(cur)}`;
  }
  function hlUpdate() {                                                                    // jonli yangilanish: kiritish maydoni qayta qurilmaydi
    const c = cur, t = $('#gmTries'), f = $('#gmFeed');
    paintRange($('#gmRange'), c); syncUi();
    if (t) t.textContent = triesTxt(c); if (f) f.replaceWith(feedList(c.feed || []));
  }
  function hlResult() {
    const c = cur, w = c.winner, r = role(), me = c.me;
    body.append(mk('div', 'gm-emo', w ? '🎯' : '⏱'), mk('h2', 'gm-h', w ? `${nm(w)} topdi!` : 'Vaqt tugadi — hech kim topa olmadi'),
      mk('p', 'mg-hint', w ? `${w.tries} ta taxminda · ${fmtT(c.elapsed)}` : `${nm(c.chosen)} yutdi 🏆`),
      mk('div', 'mg-secret', 'Yashirin son'), mk('div', 'gm-secret', String(c.secret)));
    if (r === 'player' && w && me.pid === w.id) body.appendChild(meLine('🎉 Siz topdingiz!'));
    else if (r === 'keeper') body.appendChild(meLine(w ? 'Sonni topishdi' : '🏆 Siz yutdingiz — hech kim topa olmadi!'));
    if (c.feed && c.feed.length) body.append(mk('h3', 'mg-h', 'Oxirgi taxminlar'), feedList(c.feed));
  }

  // ---------------- umumiy
  function celebrate() {
    if (!cur || cur.phase !== 'result' || done === cur.id) return; done = cur.id;
    const r = role(), me = cur.me; let ok = false;
    if (cur.game === 'hs') ok = r === 'keeper' ? cur.res.all : r === 'player' && !me.found;
    else ok = r === 'keeper' ? !cur.winner : !!(cur.winner && me.pid === cur.winner.id);
    if (ok) { win(); confetti(); vib([80, 40, 80, 40, 160]); } else if (isHost() || r === 'watch') win(); else beep(660, 0.2, 'triangle', 0.18);
  }
  function render() {
    if (!cur) return;
    const host = isHost(), c = cur, ph = c.phase, r = role(), k = c.id + ph + r;
    title.textContent = NAMES[c.game] || 'O\'yin'; info.textContent = '👥 ' + (c.total || 0);
    btns.hidden = !host; again.hidden = ph !== 'result';
    const same = k === key; key = k;
    if (same && c.game === 'hl' && ph === 'play') return hlUpdate();
    clearInterval(tmr); body.textContent = '';
    el.classList.toggle('dark', c.game === 'hs' && ph === 'hide' && r === 'keeper');
    if (!same && c.game === 'hs' && ph === 'seek') { beep(880, 0.25, 'square', 0.2); vib(40); }
    if (!same && c.game === 'hl' && ph === 'play' && r !== 'watch') { beep(990, 0.3, 'square', 0.18); }
    if (c.game === 'hs') { if (ph === 'hide') hsHide(host); else if (ph === 'seek') hsSeek(host); else hsResult(host); }
    else { if (ph === 'pick') hlPick(host); else if (ph === 'play') hlPlay(); else hlResult(); }
    if (ph === 'result') celebrate();
  }
  function on(m) {
    if (m.close) return stop();
    if (!cur || cur.id !== m.id) {                                                       // yangi o'yin
      clearInterval(tmr); key = ''; reply = null; done = ''; mine = { id: '', list: [] }; coolUntil = 0; ui = null;
      el.hidden = false; try { document.body.classList.add('noscroll'); } catch {}
      beep(440, 0.1, 'triangle', 0.18); beep(660, 0.14, 'triangle', 0.18, 0.1);
    }
    cur = m; render();
  }
  function onReply(m) {
    if (!cur || m.id !== cur.id) return;
    if (mine.id !== cur.id) mine = { id: cur.id, list: [] };
    mine.list.push({ v: m.v, d: m.d }); coolUntil = 0;
    paintReply($('#gmReply')); paintMine(); paintRange($('#gmRange'), cur); syncUi();
    if (m.d === 'hit') { win(); vib([60, 30, 60]); } else { beep(m.d === 'up' ? 560 : 380, 0.18, 'triangle', 0.2); vib(20); }
  }
  function stop() {
    clearInterval(tmr); clearTimeout(cool); ui = null; cur = null; key = ''; el.hidden = true; el.classList.remove('dark'); body.textContent = '';
    try { document.body.classList.remove('noscroll'); } catch {}
  }

  // ---- Transmitter: boshlash tugmalari
  function fillPick(sel) {
    const keep = sel.value, list = (S.members && S.members.list) || [];
    sel.textContent = '';
    list.forEach(x => { const o = document.createElement('option'); o.value = x.id; o.textContent = (x.av ? x.av + ' ' : '') + x.name; sel.appendChild(o); });
    if (!list.length) { const o = document.createElement('option'); o.textContent = 'Receiver yo\'q'; o.disabled = true; sel.appendChild(o); }
    else if (keep && list.some(x => x.id === keep)) sel.value = keep;
  }
  ['Hs', 'Hl'].forEach(k => {
    const who = $('#gm' + k + 'Who'), wrap = $('#gm' + k + 'PickWrap'), pk = $('#gm' + k + 'Pick');
    if (!who) return;
    const upd = () => { wrap.hidden = who.value !== 'pick'; if (!wrap.hidden) fillPick(pk); };
    who.onchange = upd; upd();
    setInterval(() => { if (!wrap.hidden && document.activeElement !== pk) fillPick(pk); }, 3000);
  });
  const start = (game, o) => { last = Object.assign({ type: 'gm-start', game }, o); send(last); };
  $('#gmHs').onclick = () => start('hs', { who: $('#gmHsWho').value, pick: $('#gmHsPick').value, hide: +$('#gmHsHide').value, seek: +$('#gmHsSeek').value, hostIn: $('#gmHsIn').checked });
  $('#gmHl').onclick = () => start('hl', { who: $('#gmHlWho').value, pick: $('#gmHlPick').value, max: +$('#gmHlMax').value, dur: +$('#gmHlDur').value, hostIn: $('#gmHlIn').checked });
  $('#gmX').onclick = () => { if (isHost()) send({ type: 'gm-close' }); else stop(); };
  $('#gmClose').onclick = () => send({ type: 'gm-close' });
  again.onclick = () => { if (last) send(last); };
  return { on, reply: onReply, stop };
})();

// ------------------------------------------------------------ boshlash
(function init() {
  $('#nameIn').value = localStorage.getItem('sc_name') || '';
  try { S.sink = JSON.parse(localStorage.getItem('sc_sink') || 'null'); } catch {}
  { const sv = localStorage.getItem('sc_sync_' + (S.sink ? S.sink.id : 'default')); if (sv !== null) S.syncMs = Number(sv) || 0; }
  setSync(S.syncMs);
  listOutputs();
  const q = new URLSearchParams(location.search).get('join');
  showView(q ? 'join' : 'home');
  let live = null; try { live = JSON.parse(sessionStorage.getItem('sc_live') || 'null'); } catch {}
  if (live && live.code && (live.role === 'host' ? live.key : live.name)) {          // yangilashdan keyin avtomatik qaytamiz
    unlockAudio();
    startSession(live.role, live.code, live.key || null, live.name || '', live.tok || null);
    toast('↩ Xonaga qayta ulanmoqda…', 2500);
    return;
  }
  if (q) $('#codeIn').value = q.replace(/\D/g, '').slice(0, 6);
  refreshResume();
})();
// ---- Mikrofon: efir holati (nechta qurilma eshitmoqda va tarmoq sifati)
setInterval(async () => {
  if (!isHost() || !local.mic) return;
  const n = (S.members && S.members.total) || 0;
  $('#micHear').textContent = n;
  let rtt = 0, k = 0, lost = 0;
  try {
    for (const p of peers.values()) {
      if (p.pc.connectionState !== 'connected') continue;
      const st = await p.pc.getStats();
      st.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime != null) { rtt += r.currentRoundTripTime * 1000; k++; }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio' && r.fractionLost) lost = Math.max(lost, r.fractionLost);
      });
    }
  } catch {}
  const avg = k ? rtt / k : 0;
  $('#micNet').textContent = !k ? '—' : (lost > 0.08 || avg > 300) ? '🔴 Past' : (lost > 0.02 || avg > 120) ? '🟡 O\'rtacha' : '🟢 A\'lo';
}, 2500);
// ============================================================ SAVOLLAR TO'PLAMI (Google Drive) — brauzerda (localStorage) saqlanadi
const BANK_KEY = 'sc_bank';
let BANK = []; const bankSel = new Set();
const cleanQ = q => ({ text: String(q.text || '').slice(0, 240), opts: (Array.isArray(q.opts) ? q.opts : []).slice(0, 4).map(o => String(o || '').slice(0, 120)), correct: Number(q.correct) || 0, time: Number(q.time) || 20, pts: q.pts || 'std', img: q.img || null });
const bankQ = q => Object.assign(newQ(), cleanQ(q), { open: false, check: false });
function bankLoad() { try { const d = JSON.parse(localStorage.getItem(BANK_KEY) || '[]'); if (Array.isArray(d)) BANK = d.filter(x => x && Array.isArray(x.qs)); } catch {} }
function bankSave() {
  try { localStorage.setItem(BANK_KEY, JSON.stringify(BANK)); return; } catch {}
  try { localStorage.setItem(BANK_KEY, JSON.stringify(BANK.map(b => ({ ...b, qs: b.qs.map(q => ({ ...q, img: null })) })))); toast('⚠ Xotira to\'ldi: rasmlar saqlanmadi (savollar saqlandi)', 5000); }
  catch { toast('Xotira to\'ldi — to\'plam saqlanmadi', 5000); }
}
function bankMsg(t, bad) { const e = $('#bankMsg'); e.hidden = !t; e.textContent = t || ''; e.style.color = bad ? '#ff8a80' : ''; }
async function parseAny(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (ext === 'docx') return parseQuizLines(await docxToLines(f));
  if (ext === 'xlsx') return parseQuizTable(await xlsxToRows(f));
  if (ext === 'csv' || ext === 'tsv') return parseQuizTable(parseCSV(await f.text()));
  if (ext === 'json') { const d = JSON.parse(await f.text()); return { qs: (d.qs || d.questions || []).map(q => bankQ(q)), warn: 0, notes: [] }; }
  return smartText(await f.text());
}
async function driveReq(path, url) {
  const r = await fetch(`/api/rooms/${S.code}/${path}?key=${encodeURIComponent(S.key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (!r.ok) { let m = 'Drive xatosi (' + r.status + ')'; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
  return r;
}
async function driveGet(url) {
  const r = await driveReq('drive', url);
  const kind = r.headers.get('X-Kind') || 'txt'; let name = 'Drive fayl'; try { name = decodeURIComponent(r.headers.get('X-Name') || name); } catch {}
  return new File([await r.blob()], name.replace(/\.[^.]+$/, '') + '.' + kind);
}
async function bankAddUrls() {
  const urls = [...new Set($('#bankUrls').value.split(/\s+/).filter(x => /^https?:\/\//i.test(x)))];
  if (!urls.length) { bankMsg('Google Drive havolasini joylang (https://…)', true); return; }
  if (!S.code || !S.key) { bankMsg('Avval xonaga ulaning', true); return; }
  const btn = $('#bankAdd'); btn.disabled = true;
  let ok = 0; const fail = [], jobs = [];
  try {
    for (const u of urls) {
      if (/\/folders\//.test(u)) { try { bankMsg('📁 Papka o\'qilmoqda…'); (await (await driveReq('drive-list', u)).json()).files.forEach(f => jobs.push(f)); } catch (e) { fail.push(e.message); } }
      else jobs.push({ url: u });
    }
    for (let i = 0; i < jobs.length; i++) {
      bankMsg(`⏳ ${i + 1} / ${jobs.length} yuklanmoqda…`);
      try {
        const f = await driveGet(jobs[i].url), res = await parseAny(f);
        if (!res.qs.length) throw new Error(`"${jobs[i].name || f.name}" faylda savol topilmadi`);
        const entry = { id: Math.random().toString(36).slice(2, 10), title: (jobs[i].name || f.name).replace(/\.[^.]+$/, '').slice(0, 60), src: jobs[i].url, t: Date.now(), qs: res.qs.map(cleanQ) };
        const ex = BANK.findIndex(b => b.src === entry.src);
        if (ex >= 0) { entry.id = BANK[ex].id; BANK[ex] = entry; } else BANK.unshift(entry);
        ok++;
      } catch (e) { fail.push(e.message || 'xato'); }
    }
  } finally { btn.disabled = false; }
  bankSave(); bankRender();
  bankMsg((ok ? `✅ ${ok} ta to'plam qo'shildi` : '') + (fail.length ? (ok ? ' · ' : '') + '❌ ' + fail.slice(0, 3).join(' | ') : ''), !ok);
  if (ok) $('#bankUrls').value = '';
}
function bankToEditor(b, replace) {
  if (replace && QZ.qs.length && !confirm('Editordagi savollar shu to\'plam bilan almashtiriladi. Davom etilsinmi?')) return false;
  if (replace) { QZ.title = b.title; QZ.qs = b.qs.map(bankQ); } else { QZ.qs.push(...b.qs.map(bankQ)); if (!QZ.title) QZ.title = b.title; }
  qzSave(); qzRender(); toast(`✅ ${b.qs.length} ta savol ${replace ? 'editorga qo\'yildi' : 'qo\'shildi'}`);
  return true;
}
async function bankRefresh(b) {
  bankMsg(`⏳ "${b.title}" yangilanmoqda…`);
  try {
    const res = await parseAny(await driveGet(b.src));
    if (!res.qs.length) throw new Error('Faylda savol topilmadi');
    b.qs = res.qs.map(cleanQ); b.t = Date.now(); bankSave(); bankRender(); bankMsg(`✅ "${b.title}" yangilandi (${b.qs.length} savol)`);
  } catch (e) { bankMsg('❌ ' + (e.message || 'xato'), true); }
}
function bankRender() {
  const list = $('#bankList'), q = $('#bankQ').value.trim().toLowerCase();
  $('#bankCount').textContent = BANK.length; list.textContent = '';
  const items = BANK.filter(b => !q || b.title.toLowerCase().includes(q) || b.qs.some(x => String(x.text || '').toLowerCase().includes(q)));
  if (!items.length) { list.appendChild(qel('p', 'muted', BANK.length ? 'Hech narsa topilmadi' : 'Hali to\'plam yo\'q. Yuqoriga Drive havolasini joylang yoki editordagi savollarni saqlang.')); return; }
  items.forEach(b => {
    const row = qel('div', 'bank-item'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = bankSel.has(b.id); cb.title = 'Aralash viktorina uchun tanlash';
    cb.onchange = () => { if (cb.checked) bankSel.add(b.id); else bankSel.delete(b.id); };
    const info = qel('div', 'bank-info'); info.append(qel('b', '', b.title), qel('small', '', `${b.qs.length} savol${b.qs.some(x => x.img) ? ' · 🖼' : ''}${b.src ? ' · Drive' : ' · Editor'}`));
    const acts = qel('div', 'bank-acts'), mk = (t, title, fn) => { const x = qel('button', 'sec', t); x.type = 'button'; x.title = title; x.onclick = fn; return x; };
    acts.append(mk('▶', 'Darhol o\'ynash', () => { if (bankToEditor(b, true)) $('#qzStart').click(); }), mk('➕', 'Editorga qo\'shish', () => bankToEditor(b, false)), mk('♻', 'Editorni shu bilan almashtirish', () => bankToEditor(b, true)));
    if (b.src) acts.appendChild(mk('🔄', 'Drive\'dan yangilash', () => bankRefresh(b)));
    acts.appendChild(mk('✕', 'O\'chirish', () => { if (confirm(`"${b.title}" to'plami o'chirilsinmi?`)) { BANK = BANK.filter(x => x.id !== b.id); bankSel.delete(b.id); bankSave(); bankRender(); } }));
    row.append(cb, info, acts); list.appendChild(row);
  });
}
$('#bankAdd').onclick = bankAddUrls;
$('#bankQ').oninput = bankRender;
$('#bankSaveCur').onclick = () => {
  if (!QZ.qs.length) { toast('Editorda savol yo\'q'); return; }
  const name = (prompt('To\'plam nomi:', QZ.title || 'Mening savollarim') || '').trim().slice(0, 60); if (!name) return;
  BANK.unshift({ id: Math.random().toString(36).slice(2, 10), title: name, src: '', t: Date.now(), qs: QZ.qs.map(cleanQ) }); bankSave(); bankRender(); toast('✅ To\'plamga saqlandi');
};
$('#bankMix').onclick = () => {
  const src = BANK.filter(b => bankSel.has(b.id)), pool = (src.length ? src : BANK).flatMap(b => b.qs);
  if (!pool.length) { toast('To\'plamlar bo\'sh'); return; }
  const n = Math.min(200, Math.max(1, Math.round(Number($('#bankN').value) || 20)));
  for (let i = pool.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [pool[i], pool[k]] = [pool[k], pool[i]]; }
  if (QZ.qs.length && !confirm('Editordagi savollar aralash savollar bilan almashtiriladi. Davom etilsinmi?')) return;
  QZ.title = 'Aralash viktorina'; QZ.qs = pool.slice(0, n).map(bankQ); qzSave(); qzRender(); toast(`🎲 ${QZ.qs.length} ta aralash savol editorga qo'yildi`);
};
$('#bankExp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(BANK)], { type: 'application/json' })); a.download = 'savollar-toplami.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };
$('#bankImp').onclick = () => $('#bankFile').click();
$('#bankFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text()), arr = Array.isArray(d) ? d : (d.bank || []);
    let n = 0;
    arr.forEach(x => {
      if (!x || !Array.isArray(x.qs)) return;
      const qs = x.qs.map(cleanQ).filter(q => q.text && q.opts.filter(Boolean).length >= 2); if (!qs.length) return;
      const src = typeof x.src === 'string' && /^https:\/\/(docs|drive)\.google\.com\//.test(x.src) ? x.src : '';
      const id = String(x.id || Math.random().toString(36).slice(2, 10)).replace(/[^\w-]/g, '').slice(0, 16), entry = { id, title: String(x.title || 'To\'plam').slice(0, 60), src, t: Date.now(), qs };
      const ex = BANK.findIndex(b => b.id === id); if (ex >= 0) BANK[ex] = entry; else BANK.push(entry); n++;
    });
    bankSave(); bankRender(); toast(n ? `✅ ${n} ta to'plam tiklandi` : 'Faylda to\'plam topilmadi');
  } catch { toast('Zaxira faylini o\'qib bo\'lmadi'); }
};
bankLoad(); bankRender();

// ============================================================ O'yin paneli: yon sozlamalar menyusi (onlayn yordam "chat" tugmasi kabi)
function qgMenuSet(open) {
  const m = $('#qgMenu'), f = $('#qgFab'); if (!m || !f) return;
  m.classList.toggle('open', open); m.setAttribute('aria-hidden', String(!open)); f.setAttribute('aria-expanded', String(open)); f.classList.toggle('on', open);
}
$('#qgFab').onclick = e => { e.stopPropagation(); qgMenuSet(!$('#qgMenu').classList.contains('open')); };
$('#qgMenuX').onclick = () => qgMenuSet(false);
document.addEventListener('click', e => { const m = $('#qgMenu'); if (m && m.classList.contains('open') && !m.contains(e.target) && !$('#qgFab').contains(e.target)) qgMenuSet(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') qgMenuSet(false); });

// ------------------------------------------------------------ CHAT (pastki chap burchak): hamma ko'radi, har bir xabar ism bilan.
// Transmitter chatni umuman yoki faqat viktorina paytida o'chira oladi (cfg.allowChat / cfg.allowChatQuiz). Matn faqat textContent orqali qo'yiladi (XSS yo'q).
const CHATAPI = (() => {
  const root = $('#chat'), fab = $('#chatFab'), panel = $('#chatPanel'), list = $('#chatList'), inp = $('#chatInput');
  const sendB = $('#chatSend'), badge = $('#chatBadge'), note = $('#chatNote'), cfgBox = $('#chatCfg');
  const bAll = $('#chatCfgAll'), bQuiz = $('#chatCfgQuiz'), online = $('#chatOnline');
  const MAX = 120;
  const POS_KEY = 'sc_chatPos';
  let pos = null;                                          // fab'ning chap-yuqori burchagi (px)
  try { const v = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); if (v && isFinite(v.x) && isFinite(v.y)) pos = v; } catch {}
  const vw = () => document.documentElement.clientWidth, vh = () => window.innerHeight;
  const clampPos = () => { if (!pos) return; pos.x = Math.min(Math.max(6, pos.x), Math.max(6, vw() - 58)); pos.y = Math.min(Math.max(6, pos.y), Math.max(6, vh() - 58)); };
  function applyPos() {
    if (pos) { clampPos(); root.style.left = pos.x + 'px'; root.style.top = pos.y + 'px'; }
    const r = root.getBoundingClientRect();
    const pw = Math.min(vw() * 0.92, 340), ph = Math.min(vh() * (innerWidth <= 480 ? 0.58 : 0.62), innerWidth <= 480 ? 420 : 440);
    root.classList.toggle('up', r.top < ph + 70 && vh() - r.bottom > r.top);       // tepada joy kam bo'lsa panel pastga ochiladi
    root.classList.toggle('right', r.left + pw > vw() - 4 && r.right - pw >= 4);   // o'ngda joy kam bo'lsa panel chapga ochiladi
    if (open) {                                                                      // panel ekrandan chiqib ketsa, butun chat siljiydi
      const pr = panel.getBoundingClientRect();
      let dx = 0, dy = 0;
      if (pr.left < 4) dx = 4 - pr.left; else if (pr.right > vw() - 4) dx = vw() - 4 - pr.right;
      if (pr.top < 4) dy = 4 - pr.top; else if (pr.bottom > vh() - 4) dy = vh() - 4 - pr.bottom;
      if (dx || dy) { pos = { x: r.left + dx, y: r.top + dy }; clampPos(); root.style.left = pos.x + 'px'; root.style.top = pos.y + 'px'; }
    }
  }
  const savePos = () => { try { if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {} };
  let drag = null, justDragged = false;
  function dragStart(e) {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.chat-x')) return;
    const r = root.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, el: e.currentTarget };
    try { drag.el.setPointerCapture(e.pointerId); } catch {}
  }
  function dragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; root.classList.add('dragging'); }
    pos = { x: drag.ox + dx, y: drag.oy + dy }; clampPos();
    root.style.left = pos.x + 'px'; root.style.top = pos.y + 'px';
    e.preventDefault();
  }
  function dragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved; drag = null;
    root.classList.remove('dragging');
    if (moved) { justDragged = true; setTimeout(() => { justDragged = false; }, 60); applyPos(); savePos(); }
  }
  [fab, panel.querySelector('.chat-head')].forEach(el => {
    el.addEventListener('pointerdown', dragStart);
    el.addEventListener('pointermove', dragMove);
    el.addEventListener('pointerup', dragEnd);
    el.addEventListener('pointercancel', dragEnd);
  });
  window.addEventListener('resize', () => { applyPos(); });
  let open = false, unread = 0, ids = new Set(), lastDay = '';
  const quizOn = () => !!S.quiz && (S.quiz.phase === 'question' || S.quiz.phase === 'reveal');
  const reason = () => {                                  // null = yozish mumkin
    if (isHost()) return null;
    if (S.cfg.allowChat === false) return 'Transmitter chatni o\'chirgan — faqat o\'qiy olasiz';
    if (quizOn() && S.cfg.allowChatQuiz === false) return 'Viktorina paytida yozish taqiqlangan — faqat o\'qiy olasiz';
    return null;
  };
  const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const toBottom = () => { list.scrollTop = list.scrollHeight; };
  function empty() { if (!list.children.length) list.appendChild(qel('div', 'chat-empty', 'Hozircha xabar yo\'q. Birinchi bo\'lib yozing 👋')); }
  function node(m) {
    const mine = m.from === S.myId;
    const el = qel('div', 'chat-msg' + (mine ? ' me' : '') + (m.host ? ' host' : ''));
    const who = qel('div', 'chat-who');
    who.append(qel('span', '', (m.av ? m.av + ' ' : '') + (mine ? (m.name || 'Siz') + ' (siz)' : (m.name || '?')) + (m.host ? ' · Transmitter' : '')), qel('span', 'chat-time', hhmm(m.t || Date.now())));
    el.append(who, qel('div', 'chat-txt', String(m.text || '')));
    return el;
  }
  function add(m, silent) {
    if (!m || !m.id || ids.has(m.id)) return;
    ids.add(m.id);
    const e = list.querySelector('.chat-empty'); if (e) e.remove();
    const stick = nearBottom() || m.from === S.myId;
    list.appendChild(node(m));
    while (list.children.length > MAX) { list.firstChild.remove(); }
    if (ids.size > MAX * 3) ids = new Set([...ids].slice(-MAX));
    if (stick) toBottom();
    if (!silent && m.from !== S.myId && !open) {
      unread++; paintBadge();
      root.classList.remove('has-new'); void root.offsetWidth; root.classList.add('has-new');
    }
  }
  function paintBadge() { badge.hidden = unread <= 0; badge.textContent = unread > 99 ? '99+' : String(unread); }
  function setOpen(v) {
    open = !!v; panel.hidden = !open;
    applyPos();
    if (open) { unread = 0; paintBadge(); root.classList.remove('has-new'); toBottom(); paint(); }
  }
  function paint() {
    const on = !!S.joined;
    root.hidden = !on; document.body.classList.toggle('chat-on', on);
    if (!on) return;
    applyPos();
    const why = reason();
    inp.disabled = !!why; sendB.disabled = !!why;
    inp.placeholder = why ? 'Yozish o\'chirilgan' : 'Xabar yozing…';
    note.hidden = !why; note.textContent = why || '';
    online.textContent = S.members && S.members.total ? '👥 ' + S.members.total : '';
    cfgBox.hidden = !isHost();
    if (isHost()) {
      const a = S.cfg.allowChat !== false, q = S.cfg.allowChatQuiz !== false;
      bAll.textContent = a ? '✅ Receiverlar yoza oladi' : '⛔ Receiverlar yoza olmaydi';
      bAll.className = 'chat-chip ' + (a ? 'on' : 'off');
      bQuiz.textContent = q ? '✅ Viktorinada yozish: ruxsat' : '⛔ Viktorinada yozish: taqiq';
      bQuiz.className = 'chat-chip ' + (q ? 'on' : 'off');
      bQuiz.disabled = !a; bQuiz.style.opacity = a ? '' : '.5';
    }
  }
  function submit() {
    const text = inp.value.replace(/\s+/g, ' ').trim();
    if (!text || reason()) return;
    send({ type: 'chat', text });
    inp.value = ''; inp.focus();
  }
  fab.onclick = () => { if (justDragged) return; setOpen(!open); if (open && !reason()) setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch {} }, 50); };
  $('#chatClose').onclick = () => setOpen(false);
  sendB.onclick = submit;
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
  inp.addEventListener('keyup', e => e.stopPropagation());
  bAll.onclick = () => sendCfg({ allowChat: S.cfg.allowChat === false });
  bQuiz.onclick = () => sendCfg({ allowChatQuiz: S.cfg.allowChatQuiz === false });
  return {
    init(hist) {                                             // xonaga (qayta) ulanganda tarix tiklanadi
      list.textContent = ''; ids = new Set();
      (Array.isArray(hist) ? hist : []).forEach(m => add(m, true));
      empty(); toBottom(); paint();
    },
    add(m) { add(m, false); paint(); },
    denied(r) { toast(r === 'quiz' ? '🎯 Viktorina paytida chatga yozish taqiqlangan' : '💬 Transmitter chatni o\'chirgan', 2500); paint(); },
    paint,
    reset() { list.textContent = ''; ids = new Set(); unread = 0; paintBadge(); setOpen(false); root.hidden = true; document.body.classList.remove('chat-on'); },
  };
})();

window.SC = { S, send, toast, isHost, $, makeZip, xlsxToRows, unzipDocx, sNow };   // attendance.js uchun ko'prik
})();
