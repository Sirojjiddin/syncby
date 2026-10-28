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
const defaultCfg = () => ({ allowReact: true, waitAll: true, allowView: true, allowDownload: true, guard: true, muteAll: false, volume: 100, lockVolume: true, normalize: true, duck: true, locked: false, loop: 'off' });

// ------------------------------------------------------------ holat
const S = {
  role: null, code: null, key: null, name: '', tok: null, myId: null, myMuted: false,
  items: [], st: null, joined: false, cfg: defaultCfg(), live: { mic: null, screen: null },
  members: { total: 0, ready: 0, list: [], hostOnline: true },
  drift: null, rtt: null, localVol: 1, waiting: 0, parentId: null, hops: 1, sink: null, poll: null, myVote: null, pollId: null, syncMs: Number(localStorage.getItem('sc_sync')) || 0,
};
let ws = null, wantOpen = false, reconnectT = null;
let offset = 0, firstOffset = true, samples = [];
let startTimer = null, driftTimer = null, lastHard = 0;
let loadedId = null, readySent = false, viewerId = null, lastSig = null;
let wakeLock = null, currentView = null, baseKind = 'none';
const blobs = new Map();

const isHost = () => S.role === 'host';
const sNow = () => Date.now() + offset;
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
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
  ['home', 'join', 'host', 'recv'].forEach(v => { $('#' + v).hidden = v !== id; });
  const slot = id === 'host' ? $('#hSlot') : id === 'recv' ? $('#rSlot') : null;
  if (slot) { if (stage.parentNode !== slot) slot.appendChild(stage); stage.hidden = false; }
  else { if (stage.parentNode !== document.body) document.body.appendChild(stage); stage.hidden = true; }
  $('#fnBtn').hidden = id !== 'host';
  $('#memChip').hidden = id !== 'host' && id !== 'recv';
  if (id !== 'host') openDrawer(false);
  if (currentView !== id) window.scrollTo(0, 0);
  currentView = id;
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
    send({ type: 'join', code: S.code, role: S.role, key: S.key, name: S.name, tok: S.tok, av: S.av || undefined, relay: CAN_RELAY });
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
  samples = []; burstSent = BN(); burstGot = 0;
  for (let i = 0; i < burstSent; i++) setTimeout(() => send({ type: 'ping', t0: performance.now() }), i * 60);
  clearTimeout(clockT); clockT = setTimeout(finishBurst, 1000);
}
(function burstLoop() {          // xonada odam ko'p bo'lsa, o'lchash siyrak va tasodifiy vaqtda (server yuklanmasin)
  const n = (S.members && S.members.total) || 0;
  setTimeout(() => { if (ws && ws.readyState === 1 && S.joined) burst(); burstLoop(); }, clamp(3000 + n * 30, 3000, 12000) + Math.random() * 1500);
})();

function onPong(m) {
  lastPong = Date.now(); burstGot++;
  const rtt = performance.now() - m.t0;
  samples.push({ rtt, off: m.serverNow + rtt / 2 - Date.now() });
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
  switch (m.type) {
    case 'pong': onPong(m); break;
    case 'joined':
      S.joined = true;
      S.items = m.items; S.st = m.state;
      S.cfg = Object.assign(defaultCfg(), m.cfg || {});
      S.live = m.live || { mic: null, screen: null };
      S.myId = m.myId; S.tok = m.tok; S.parentId = null; if (m.av) S.av = m.av;
      saveLive();
      S.poll = m.poll || null; S.pollId = S.poll ? S.poll.id : null; S.myVote = m.myVote == null ? null : m.myVote;
      offset = m.serverNow - Date.now();
      readySent = false;
      showView(isHost() ? 'host' : 'recv');
      if (isHost()) { initHostView(); publishLive(); try { showTab(sessionStorage.getItem('sc_tab') || undefined); } catch {} } else $('#rCode').textContent = S.code;
      setNet('ulandi');
      viewerId = null;
      renderAll();
      lastSig = null;
      applyState();
      applyVolume(); applyProcs(); renderPoll();
      if (!isHost()) onLive({ live: S.live, resync: true });
      break;
    case 'items':
      S.items = m.items; renderAll(); loadCurrent(); applyItemGain(); flushNorm(); break;
    case 'state':
      S.st = m.state; renderAll(); applyState(); break;
    case 'members':
      S.members = Object.assign({ list: [] }, m); renderMembers(); break;
    case 'cfg': onCfg(m.cfg); break;
    case 'waiting': S.waiting = m.n; if (isHost() && m.n > 0) toast(`⏳ ${m.n} ta qurilma tayyorlanmoqda…`, 1200); renderStatus(); break;
    case 'you': S.myMuted = !!m.muted; applyVolume(); renderStatus(); toast(S.myMuted ? '🔇 Transmitter dinamigingizni o\'chirdi' : '🔊 Dinamigingiz yoqildi'); break;
    case 'live': if (!isHost()) onLive(m); break;
    case 'rtc-want': serveWant(m.from); break;
    case 'rtc-signal': if (peers.has(m.from)) hostSignal(m.from, m.data); else recvSignal(m.data, m.from); break;
    case 'rtc-parent': S.parentId = m.id; S.hops = m.depth || 1; renderNet(); break;
    case 'rtc-reparent': S.parentId = null; setTimeout(() => { if (S.joined && S.live && (S.live.mic || S.live.screen)) recvWant(); }, Math.random() * 700); break;
    case 'rtc-wait': setTimeout(() => { if (S.joined && S.live && (S.live.mic || S.live.screen) && !rpc) recvWant(); }, 2500 + Math.random() * 1500); break;
    case 'react': Object.entries(m.counts || {}).forEach(([e, n]) => floatEmoji(e, n)); break;
    case 'poll': if (!m.poll || (S.pollId && S.pollId !== m.poll.id)) S.myVote = null; S.poll = m.poll; S.pollId = m.poll ? m.poll.id : null; renderPoll(); break;
    case 'voted': S.myVote = m.i; renderPoll(); break;
    case 'test': if (m.on) startTest(m.t0); else stopTest(); break;
    case 'quiz': onQuiz(m.quiz); break;
    case 'quiz-state': if (m.av) S.av = m.av; S.quiz = m.quiz || null; S.qMe = m.me || null; S.qAns = m.myAnswer == null ? null : m.myAnswer; renderQuiz(); break;
    case 'quiz-me': S.qMe = m.me; renderQuiz(); SFX.onMe(); break;
    case 'quiz-progress': S.qProg = m; qProgUpdate(); break;
    case 'quiz-ack': break;
    case 'quiz-ai': aiUI.set(!!m.busy, m.error || ''); break;
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
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: it.name, artist: 'SyncCast' }); } catch {}
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
function drift() {
  const st = S.st;
  if (!st || !st.playing || mPaused() || !mReady()) { S.drift = null; return; }
  const d = mDur();
  if (isYt() ? !d : !Number.isFinite(d)) { S.drift = 0; return; }          // jonli efir: vaqtga bog'lanmaydi
  const diff = expected(sNow()) + lat() - mTime();                         // musbat = biz orqadamiz
  S.drift = diff;
  const now = performance.now(), ad = Math.abs(diff);
  const vid = !isYt() && stage.dataset.kind === 'video';
  if (vid && (player.seeking || player.readyState < 3)) return;                // video surilayotganda yana surmaymiz (qotish aylanasi)
  const hard = isYt() ? 0.7 : vid ? (isHost() ? 2 : 0.9) : 0.45;
  if (ad > hard && now - lastHard > (isYt() ? 4000 : vid ? 7000 : 2500)) {
    lastHard = now; integ = 0;
    fadeSeek(expected(sNow()) + lat() + 0.12); mRate(1);                    // +0.12: surish kechikishini oldindan hisobga olish
    return;
  }
  if (isYt()) return;
  if (vid && isHost()) { slewRate(1); return; }                                  // Transmitter videoda tezlikni o'zgartirmaydi: tekis ijro
  if (ad < 0.012) { integ *= 0.9; slewRate(1); return; }
  integ = clamp(integ + diff * 0.1, -0.5, 0.5);
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
      row.sts = document.createElement('span'); row.sts.className = 'sz';
      row.mu = document.createElement('button'); row.mu.onclick = () => send({ type: 'mute-one', id: row.r.id, muted: !row.r.muted });
      row.kk = document.createElement('button'); row.kk.textContent = '✕'; row.kk.title = 'Chiqarib yuborish';
      row.kk.onclick = () => { if (confirm(`"${row.r.name}" xonadan chiqarilsinmi?`)) send({ type: 'kick', id: row.r.id }); };
      row.li.append(row.dot, row.nm, row.sts, row.mu, row.kk);
      rlRows.set(r.id, row);
    }
    row.r = r;
    const dc = 'dot' + (r.ready ? ' ok' : ''); if (row.dot.className !== dc) { row.dot.className = dc; row.dot.title = r.ready ? 'tayyor' : 'yuklanmoqda'; }
    setTxt(row.nm, (r.av || '') + ' ' + r.name);
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
    $('#cfgDuck').checked = c.duck; $('#cfgLocked').checked = c.locked;
    $('#cfgLoop').value = c.loop;
    $('#cfgWait').checked = c.waitAll; $('#cfgReact').checked = c.allowReact;
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
  localStorage.setItem('sc_host', JSON.stringify({ code: S.code, key: S.key }));
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
$('#cfgReact').onchange = e => sendCfg({ allowReact: e.target.checked });
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

$('#goHost').onclick = async () => {
  unlockAudio();
  const err = $('#homeErr'); err.hidden = true;
  try {
    const r = await fetch('/api/rooms', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    startSession('host', j.code, j.hostKey, '');
  } catch (e) { err.textContent = e.message || 'Xona yaratib bo\'lmadi'; err.hidden = false; }
};

function refreshResume() {
  const btn = $('#resume');
  btn.hidden = true;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('sc_host')); } catch {}
  if (!saved) return;
  fetch(`/api/rooms/${saved.code}?key=${encodeURIComponent(saved.key)}`).then(r => r.json()).then(j => {
    if (j.exists && j.isHost) {
      btn.textContent = `↩ Oxirgi xonani davom ettirish (${saved.code})`;
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
const QZ = { title: '', qs: [] };
Object.assign(S, { quiz: null, qMe: null, qAns: null, qProg: null });
const newQ = () => ({ text: '', img: null, opts: ['', '', '', ''], correct: 0, time: 20, pts: 'std', open: true, check: false });
const qel = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const QSKIP = ['imgSrc', 'imgUrl', 'imgRoom', 'open', 'check'];

let qzSaveT = null;
function qzSave() {
  clearTimeout(qzSaveT);
  qzSaveT = setTimeout(() => {
    try { localStorage.setItem('sc_quiz', JSON.stringify(QZ, (k, v) => (QSKIP.includes(k) ? undefined : v))); }
    catch { try { localStorage.setItem('sc_quiz', JSON.stringify({ title: QZ.title, qs: QZ.qs.map(q => ({ ...q, img: null })) }, (k, v) => (QSKIP.includes(k) ? undefined : v))); } catch {} }
  }, 500);
}
function qzLoad() {
  try {
    const d = JSON.parse(localStorage.getItem('sc_quiz') || 'null');
    if (d && Array.isArray(d.qs)) { QZ.title = d.title || ''; QZ.qs = d.qs.map(q => Object.assign(newQ(), q, { open: false, check: false })); }
  } catch {}
}

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
      const st = document.createElement('select');
      [10, 20, 30, 45, 60, 90, 120].forEach(t => st.add(new Option(`⏱ ${t} soniya`, t))); st.value = String(q.time);
      st.onchange = () => { q.time = Number(st.value); qzSave(); };
      const sp = document.createElement('select');
      [['std', '⭐ Oddiy ball (1000)'], ['double', '✨ Ikki baravar (2000)'], ['none', '🚫 Ballsiz']].forEach(([v, t]) => sp.add(new Option(t, v))); sp.value = q.pts;
      sp.onchange = () => { q.pts = sp.value; qzSave(); };
      set.append(st, sp); body.appendChild(set);
      if (q.check) body.appendChild(qel('p', 'muted warn-t', '⚠ To\'g\'ri javobni belgilang (yashil doira).'));
      card.appendChild(body);
    }
    box.appendChild(card);
  });
  const mins = Math.round(QZ.qs.reduce((a, q) => a + q.time + 8, 0) / 60);
  $('#qzSummary').textContent = QZ.qs.length ? `${QZ.qs.length} ta savol · taxminan ${mins} daqiqa` : 'Hali savol yo\'q. "＋ Savol qo\'shish" yoki Word/matndan import qiling.';
}
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
async function xlsxToRows(file) {
  if (typeof DecompressionStream === 'undefined') throw new Error('nodecomp');
  const files = await unzipDocx(await file.arrayBuffer(), n => /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(n));
  const dec = new TextDecoder(), xml = n => { const u = files.get(n); return u ? new DOMParser().parseFromString(dec.decode(u), 'application/xml') : null; };
  const ss = [], sx = xml('xl/sharedStrings.xml');
  if (sx) sx.querySelectorAll('si').forEach(si => ss.push([...si.querySelectorAll('t')].map(t => t.textContent).join('')));
  const names = [...files.keys()].filter(n => /worksheets\/sheet\d+\.xml$/.test(n)).sort((x, y) => parseInt(x.match(/(\d+)\.xml/)[1], 10) - parseInt(y.match(/(\d+)\.xml/)[1], 10));
  if (!names.length) throw new Error('sheet');
  const rows = [];
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
    rows.push(Array.from(arr, x => (x == null ? '' : x)));
  });
  return rows;
}
// Jadval: sarlavhali (Savol | Variant A..D | To'g'ri javob | Vaqt | Ball; Kahoot shabloni ham tushuniladi) yoki sarlavhasiz (ustunlar shu tartibda)
function parseQuizTable(rows) {
  rows = rows.map(r => r.map(c => String(c == null ? '' : c).replace(/\u00a0/g, ' ').trim())).filter(r => r.some(Boolean));
  const notes = []; const out = []; let warn = 0;
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
    out.push(Object.assign(newQ(), { text: text.slice(0, 240), opts, correct: bad ? Math.max(0, opts.findIndex(Boolean)) : correct, time: Number.isFinite(tv) ? clamp(tv, 5, 120) : 20,
      pts: /x\s*2|2\s*x|double|ikki|^2$|2000/.test(pv) ? 'double' : /^0$|yo['’`]?q|none|^no$|ballsiz/.test(pv) ? 'none' : 'std', open: false, check: bad }));
  });
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
      const x = qel('button', 'qz-prev-x', '✕'); x.title = 'Bu savolni olib tashlash';
      x.onclick = () => { res.qs.splice(i, 1); if (!res.qs.length) close(); else paint(); };
      row.appendChild(x); list.appendChild(row);
    });
  };
  const add = qel('button', 'primary', '➕ Qo\'shish'), rpl = qel('button', 'sec', '♻ Eskilarini almashtirish'), no = qel('button', 'sec', 'Bekor');
  add.onclick = () => { QZ.qs.push(...res.qs); qzSave(); qzRender(); close(); toast(`✅ ${res.qs.length} ta savol qo'shildi`); };
  rpl.onclick = () => { if (QZ.qs.length && !confirm('Mavjud savollar o\'chirilib, yangilari qo\'yilsinmi?')) return; QZ.qs = res.qs.slice(); qzSave(); qzRender(); close(); toast(`✅ ${res.qs.length} ta savol qo'yildi`); };
  no.onclick = close;
  bar.append(add, rpl, no); card.append(head, info, list, bar); ov.appendChild(card);
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
    const total = QZ.qs.filter(q => q.img).length; let done = 0; const out = [];
    for (const q of QZ.qs) {
      let url = null;
      if (q.img) {
        if (q.imgUrl && q.imgRoom === S.code && q.imgSrc === q.img) url = q.imgUrl;
        else { btn.textContent = `⏳ Rasmlar yuklanmoqda ${++done}/${total}`; url = await uploadQImg(q.img); q.imgUrl = url; q.imgRoom = S.code; q.imgSrc = q.img; }
      }
      out.push({ text: q.text, img: url, opts: q.opts, correct: q.correct, time: q.time, pts: q.pts });
    }
    send({ type: 'quiz-start', hideOpts: $('#qzHide').checked, hideQ: $('#qzHideQ').checked, celebrate: $('#qzCel').checked, stickers: $('#qzStk').checked, quiz: { title: QZ.title || 'Viktorina', questions: out } });
  } catch { eb.textContent = 'Rasm yuklashda xato. Qayta urinib ko\'ring.'; eb.hidden = false; }
  btn.disabled = false; btn.textContent = '▶ O\'yinni boshlash';
};

// ---- 🤝 Do'st bilan do'st: AI tanlangan miqdorda tasodifiy savol tuzadi
const aiCount = () => Math.min(30, Math.max(3, Math.round(Number($('#aiCount').value) || 11)));
const aiSecs = () => Number($('#aiTime').value) || 15;
function aiCountUI(save) {
  const n = aiCount();
  if (document.activeElement !== $('#aiCount')) $('#aiCount').value = n;
  document.querySelectorAll('#aiChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === n));
  const sec = n * (aiSecs() + 8);                                        // taxminan: savol vaqti + natija ko'rsatish
  $('#aiTotal').textContent = `≈ ${Math.max(1, Math.round(sec / 60))} daqiqalik o'yin`;
  if (!aiUI.busy) $('#aiStart').textContent = '🎲 AI bilan boshlash (' + n + ' savol)';
  if (save) { try { localStorage.setItem('sc_aiCount', String(n)); } catch {} }
}
const aiUI = {
  busy: false, t: 0,
  set(busy, err) {
    this.busy = busy; const b = $('#aiStart'), e = $('#aiErr');
    b.disabled = busy; clearTimeout(this.t);
    b.textContent = busy ? '⏳ AI savollar tuzmoqda…' : '🎲 AI bilan boshlash (' + aiCount() + ' savol)';
    e.hidden = !err; e.textContent = err || '';
    if (busy) this.t = setTimeout(() => this.set(false, 'AI javob bermadi. Qayta urinib ko\'ring.'), 125000);
  },
};
['aiTopic', 'aiLang', 'aiLevel', 'aiTime', 'aiCount'].forEach(id => { const el = $('#' + id), k = 'sc_' + id; try { const v = localStorage.getItem(k); if (v != null) el.value = v; } catch {} el.onchange = () => { try { localStorage.setItem(k, el.value); } catch {} }; });
$('#aiCount').value = aiCount();
$('#aiCount').oninput = () => aiCountUI(false);
$('#aiCount').onchange = () => { $('#aiCount').value = aiCount(); aiCountUI(true); };
$('#aiCount').onfocus = () => $('#aiCount').select();
$('#aiMinus').onclick = () => { $('#aiCount').value = aiCount() - 1; aiCountUI(true); };
$('#aiPlus').onclick = () => { $('#aiCount').value = aiCount() + 1; aiCountUI(true); };
document.querySelectorAll('#aiChips button').forEach(b => { b.onclick = () => { $('#aiCount').value = b.dataset.n; aiCountUI(true); }; });
$('#aiTime').addEventListener('change', () => aiCountUI(false));
aiCountUI(false);
$('#aiAuto').checked = localStorage.getItem('sc_aiauto') !== '0';
$('#aiAuto').onchange = e => localStorage.setItem('sc_aiauto', e.target.checked ? '1' : '0');
$('#aiStart').onclick = () => {
  if (aiUI.busy) return;
  aiUI.set(true);
  send({ type: 'quiz-ai', topic: $('#aiTopic').value.trim(), level: $('#aiLevel').value, time: Number($('#aiTime').value) || 15, count: aiCount(), lang: $('#aiLang').value, auto: $('#aiAuto').checked,
    hideOpts: $('#qzHide').checked, hideQ: $('#qzHideQ').checked, celebrate: $('#qzCel').checked, stickers: $('#qzStk').checked });
};

// ---- AI savollarni oldindan tayyorlash: bo'lim ochilganda va sozlamalar o'zgarganda fonda
let aiWarmT = 0;
function aiWarmSoon() {
  if (!isHost() || !S.joined || S.quiz) return;
  clearTimeout(aiWarmT);
  const e = $('#aiReady'); if (e) e.hidden = true;
  aiWarmT = setTimeout(() => send({ type: 'quiz-ai-warm', topic: $('#aiTopic').value.trim(), level: $('#aiLevel').value, time: aiSecs(), count: aiCount(), lang: $('#aiLang').value }), 3000);
}
['aiTopic', 'aiLang', 'aiLevel', 'aiCount'].forEach(id => $('#' + id).addEventListener('change', aiWarmSoon));
document.querySelectorAll('#aiChips button, #aiMinus, #aiPlus').forEach(b => b.addEventListener('click', aiWarmSoon));

// ---- tablar
let curTab = 'media';
function showTab(name) {
  if (name) { curTab = name; try { sessionStorage.setItem('sc_tab', name); } catch {} }
  const game = !!S.quiz && isHost();                          // o'yin ketayotganda tab panellari yashiriladi, o'yin paneli ko'rinadi
  $('#tabMedia').hidden = curTab !== 'media' || game;
  $('#tabQuiz').hidden = curTab !== 'quiz' || game;
  $('#tabAi').hidden = curTab !== 'ai' || game;
  $('#tabMic').hidden = curTab !== 'mic' || game;
  if (curTab === 'ai' && !game) aiWarmSoon();
  $('#gameWrap').hidden = !game;
  document.querySelectorAll('#hostTabs .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === curTab));
}
document.querySelectorAll('#hostTabs .tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });

// ---- o'yin: umumiy qismlar
function qImg(q) { if (!q.img) return null; const im = qel('img', 'qz-img'); im.src = q.img; im.alt = ''; im.decoding = 'async'; return im; }
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
  const winN = top => Math.min(5, (top || []).length);
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
  const n = Math.min(5, top.length); if (!n) return;
  const plan = revealPlan(n), box = qel('div', 'cer');
  const card = (i, mini) => {
    const t = top[i], md = MEDAL[i], d = qel('div', 'cer-card ' + md[2] + (mini ? ' mini' : ' pod h' + (i + 1)));
    d.style.setProperty('--d', (plan[i + 1] / 1000).toFixed(2) + 's');
    d.append(qel('div', 'cer-crown', i === 0 ? '👑' : ''), ...(stkOn() ? [qel('div', 'cer-av', t.av || '🙂')] : []), qel('div', 'cer-medal', md[0]), qel('div', 'cer-nm', t.name), qel('div', 'cer-pt', t.score + ' ball'));
    if (!mini) d.appendChild(qel('div', 'cer-blk', String(i + 1)));
    return d;
  };
  const row = qel('div', 'cer-row');
  [1, 0, 2].forEach(i => { if (i < n && top[i]) row.appendChild(card(i, false)); });
  box.appendChild(row);
  const rest = qel('div', 'cer-rest');
  [3, 4].forEach(i => { if (i < n && top[i]) rest.appendChild(card(i, true)); });
  if (rest.children.length) box.appendChild(rest);
  parent.appendChild(box);
}
function winOverlay(rank) {                                               // receiver: top-5 ga to'liq ekranli tabrik
  if (document.getElementById('qwin') || rank < 1 || rank > 5) return;
  const md = MEDAL[rank - 1], me = S.qMe || {}, o = qel('div', 'qwin'); o.id = 'qwin';
  const c = qel('div', 'qwin-card ' + md[2]), btn = qel('button', 'primary', 'Davom etish');
  c.append(qel('div', 'qwin-rays'), qel('div', 'qwin-medal', md[0]), qel('h2', '', 'Tabriklaymiz!'), ...(stkOn() ? [qel('div', 'qwin-av', S.av || '🙂')] : []), qel('div', 'qwin-nm', S.name || 'Siz'),
    qel('p', '', `${rank}-o'rin${me.score != null ? ' · ' + me.score + ' ball' : ''}`), qel('small', '', md[1]), btn);
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

function onQuiz(pub) {
  const prev = S.quiz;
  S.quiz = pub;
  if (!pub) { S.qMe = null; S.qAns = null; S.qProg = null; }
  else {
    const newGame = !prev || prev.id !== pub.id;
    if (newGame || prev.idx !== pub.idx) { S.qAns = null; if (S.qProg) S.qProg = Object.assign({}, S.qProg, { answered: 0 }); }
    if (newGame) S.qMe = null;
    if (prev && !newGame && prev.phase !== pub.phase && (pub.phase === 'reveal' || pub.phase === 'final') && S.qMe) S.qMe = Object.assign({}, S.qMe, { stale: true });   // yangi natija kelguncha eski natija ko'rsatilmasin
    if (isHost() && newGame) showTab(pub.mode === 'friend' ? 'ai' : 'quiz');
  }
  renderQuiz();
  SFX.onQuiz(pub); GUARD.refresh();
}
const renderQuiz = () => (isHost() ? renderQuizHost() : renderQuizPlay());

// ---- Transmitter: o'yin paneli (to'liq ekran, proyektor uchun)
const qPlayersN = qz => (S.members && S.members.total) || (S.qProg && S.qProg.players) || (qz && qz.players) || 0;
function renderQuizHost() {
  const qz = S.quiz;
  $('#qzEditor').hidden = !!qz; $('#qzGame').hidden = !qz; showTab();
  document.body.classList.toggle('noscroll', !!qz && isHost());
  if (!qz) { try { if (document.fullscreenElement) document.exitFullscreen(); } catch {} qSchedule(); return; }
  $('#qgTitle').textContent = qz.title;
  $('#qgStep').textContent = qz.idx >= 0 ? `Savol ${qz.idx + 1} / ${qz.total}` : `${qz.total} savol`;
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
    qBlock(body, qz, { gridId: 'qgGrid', countId: 'qgCount', mid, fill: true });
  } else if (qz.phase === 'reveal') {
    qBlock(body, qz, { reveal: true, fill: true });
    const side = qel('div', 'qg-side'); side.appendChild(qel('h2', '', '🏆 Reyting'));
    lbList(side, qz.top || [], true); body.appendChild(side);
  } else if (qz.phase === 'final') {
    body.appendChild(qel('h2', 'qg-final', '🏁 O\'yin yakunlandi'));
    if (qz.celebrate !== false) { ceremony(body, qz.top || []); if ((qz.top || []).length > 5) lbList(body, qz.top.slice(5), false, 5); }
    else { podium(body, qz.top || []); lbList(body, qz.top || [], true); }
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
$('#qgAuto').onclick = () => { if (S.quiz) send({ type: 'quiz-flag', k: 'auto', v: !S.quiz.auto }); };
$('#qgGuard').onclick = () => sendCfg({ guard: S.cfg.guard === false });
function updGuardBtn() { const b = $('#qgGuard'); if (!b) return; const on = S.cfg.guard !== false; b.textContent = on ? '🛡 Himoya: yoniq' : '🛡 Himoya: o\'chiq'; b.classList.toggle('act', on); }
$('#qgSfx').onclick = () => { SFX.toggle(); $('#qgSfx').textContent = SFX.on ? '🔔' : '🔕'; };
$('#qpSfx').onclick = () => { SFX.toggle(); $('#qpSfx').textContent = SFX.on ? '🔔' : '🔕'; };
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
  S.qAns = i; send({ type: 'quiz-answer', i });
  renderQuizPlay();
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
    const d = qel('div', 'qp-big card'); d.append(qel('div', 'em', '🎯'), qel('h2', '', 'Tayyor bo\'ling!'), qel('p', 'muted', 'Transmitter o\'yinni boshlashini kuting.'));
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
      bn.appendChild(qel('small', '', ok ? `+${me.delta} ball${me.streak >= 2 ? ' · 🔥 ' + me.streak + ' ta ketma-ket' : ''}` : 'Keyingi safar omad!'));
      if (me.rank) bn.appendChild(qel('small', '', `O'rningiz: #${me.rank} / ${me.n} · ${me.score} ball`));
    }
    body.appendChild(bn);
    qBlock(body, qz, { reveal: true });
    body.appendChild(qel('h2', '', '🏆 Reyting'));
    lbList(body, qz.top || [], true);
  } else if (qz.phase === 'final') {
    body.appendChild(qel('h2', 'center', '🏁 O\'yin yakunlandi'));
    const cel = qz.celebrate !== false;
    if (cel) ceremony(body, qz.top || []); else podium(body, qz.top || []);
    if (me && me.rank) body.appendChild(qel('div', 'qp-banner none', `Sizning o'rningiz: #${me.rank} / ${me.n}`)).appendChild(qel('small', '', `${me.score} ball`));
    if (cel) { if ((qz.top || []).length > 5) lbList(body, qz.top.slice(5), false, 5); } else lbList(body, qz.top || [], true);
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
    if (grid && p === 'qp') grid.classList.toggle('locked', toStart > 0 || S.qAns != null);
  });
}

qzLoad(); qzRender();

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
})();
