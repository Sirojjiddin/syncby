(() => {
'use strict';

const $ = s => document.querySelector(s);
const pMain = $('#player');          // WebAudio grafigiga ulangan asosiy pleyer
const pExt = $('#playerExt');        // tashqi havolalar uchun (CORS bo'lmasa grafikka ulab bo'lmaydi)
const castVideo = $('#castVideo');
const stage = $('#stage');
let player = pMain;
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const MAX_PEERS = 20;                // Transmitter bir vaqtda nechta receiverga to'g'ridan-to'g'ri efir uzata oladi

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
const defaultCfg = () => ({ allowReact: true, waitAll: true, allowView: true, allowDownload: true, muteAll: false, volume: 100, lockVolume: true, normalize: true, duck: true, locked: false, loop: 'off' });

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
let actx = null, master = null, limiter = null, duckGain = null, itemGain = null, voiceGain = null, castGain = null, musicSrc = null;
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
  if (!OAC || file.size > 24 * 1024 * 1024) return null;       // katta fayllar: jonli o'lchash ishlaydi
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
  analyzeChain = analyzeChain.then(() => analyzeLoudness(file)).then(db => {
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
  try { actx = new AC({ latencyHint: 'interactive' }); } catch { actx = null; return null; }
  master = actx.createGain();
  if (S.sink && actx.setSinkId) actx.setSinkId(S.sink.id).catch(() => {});
  limiter = actx.createDynamicsCompressor();
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.1;
  master.connect(limiter); limiter.connect(actx.destination);
  duckGain = actx.createGain(); duckGain.connect(master);
  itemGain = actx.createGain(); itemGain.connect(duckGain);
  voiceGain = actx.createGain(); voiceGain.connect(master);
  castGain = actx.createGain(); castGain.connect(master);
  try { musicSrc = actx.createMediaElementSource(pMain); musicSrc.connect(itemGain); buildMeter(); } catch { musicSrc = null; }
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

function applyItemGain(immediate) {
  const it = currentItem();
  const has = it && isMedia(it.kind) && it.gainDb != null;
  if (actx && itemGain) {
    const v = S.cfg.normalize && has ? Math.pow(10, it.gainDb / 20) : 1;
    if (immediate) { itemGain.gain.cancelScheduledValues(actx.currentTime); itemGain.gain.setValueAtTime(v, actx.currentTime); }
    else itemGain.gain.setTargetAtTime(v, actx.currentTime, 0.1);
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
function startSession(role, code, key, name) {
  Object.assign(S, { role, code, key, name, tok: null, myMuted: false, joined: false, items: [], st: null, cfg: defaultCfg(), live: { mic: null, screen: null } });
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
    send({ type: 'join', code: S.code, role: S.role, key: S.key, name: S.name, tok: S.tok, relay: CAN_RELAY });
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
      S.myId = m.myId; S.tok = m.tok; S.parentId = null;
      S.poll = m.poll || null; S.pollId = S.poll ? S.poll.id : null; S.myVote = m.myVote == null ? null : m.myVote;
      offset = m.serverNow - Date.now();
      readySent = false;
      showView(isHost() ? 'host' : 'recv');
      if (isHost()) { initHostView(); publishLive(); } else $('#rCode').textContent = S.code;
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
    case 'quiz-state': S.quiz = m.quiz || null; S.qMe = m.me || null; S.qAns = m.myAnswer == null ? null : m.myAnswer; renderQuiz(); break;
    case 'quiz-me': S.qMe = m.me; renderQuiz(); break;
    case 'quiz-progress': S.qProg = m; qProgUpdate(); break;
    case 'quiz-ack': break;
    case 'rtc-gone': dropPeer(m.id); break;
    case 'notice': toast(m.message, 6000); break;
    case 'kicked': leave('Transmitter sizni xonadan chiqarib yubordi', true); break;
    case 'error':
      if (m.code === 'NO_ROOM' || m.code === 'BAD_KEY') localStorage.removeItem('sc_host');
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
  hideViewers();
  if (!canView()) {
    setKind('doc');
    $('#docIco').textContent = '🔒';
    $('#docName').textContent = 'Transmitter fayllarni ko\'rishni o\'chirgan';
    $('#docMeta').textContent = '';
    return;
  }
  const src = srcOf(it);
  setKind(it.kind);
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
    const end = Math.min(total - 1, got + CH - 1);
    let ok = false;
    for (let attempt = 0; attempt < 9 && !ok; attempt++) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${got}-${end}` } });
        if (r.status === 503) { await sleep(700 + Math.random() * 1300); continue; }
        if (r.status !== 206 && r.status !== 200) throw new Error(String(r.status));
        mime = mime || r.headers.get('content-type') || '';
        const buf = new Uint8Array(await r.arrayBuffer());
        if (r.status === 200) { parts = [buf]; got = total; }           // server Range'ni e'tiborsiz qoldirdi: butun fayl keldi
        else { parts.push(buf); got += buf.length; }
        rec.pct = Math.min(1, got / total); ok = true;
      } catch { await sleep(Math.min(8000, 400 * 2 ** attempt)); }
    }
    if (!ok) throw new Error('fetch');
  }
  return new Blob(parts, { type: mime });
}
function prefetch(it) {
  let rec = cache.get(it.id);
  if (rec) return rec.promise;
  rec = { state: 'loading', pct: 0, url: null };
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
  if (!it || !isMedia(it.kind)) return;

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
  const hard = isYt() ? 0.7 : 0.45;
  if (ad > hard && now - lastHard > (isYt() ? 4000 : 2500)) {
    lastHard = now; integ = 0;
    mSeek(expected(sNow()) + lat() + 0.12); mRate(1);                       // +0.12: surish kechikishini oldindan hisobga olish
    return;
  }
  if (isYt()) return;
  if (ad < 0.012) { integ *= 0.9; mRate(1); return; }
  integ = clamp(integ + diff * 0.1, -0.5, 0.5);
  mRate(1 + clamp(diff * 0.6 + integ * 0.15, -0.05, 0.05));
}

[pMain, pExt].forEach(p => {
  p.addEventListener('canplay', () => {
    if (p !== player || !loadedId || readySent) return;
    if ((p.currentSrc || '').startsWith('blob:')) markReady();                 // blob/lokal: darhol tayyor
    else { clearTimeout(rdyT); rdyT = setTimeout(markReady, 5000); }           // oqim: canplaythrough kutiladi (yoki 5 s)
  });
  p.addEventListener('canplaythrough', () => { if (p === player) markReady(); });
  p.addEventListener('waiting', () => {                                        // uzilish: hamma kutmaydi, bu qurilma tezda qaytib yetib oladi
    if (p !== player || !loadedId || !S.st || !S.st.playing) return;
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

function createRpc() {
  const pc = new RTCPeerConnection(ICE);
  rpc = pc;
  pc.onicecandidate = e => { if (e.candidate && S.parentId) send({ type: 'rtc-signal', to: S.parentId, data: { ice: e.candidate.toJSON() } }); };
  pc.ontrack = e => {
    const st = e.streams[0] || new MediaStream([e.track]);
    remote.streams.set(st.id, st);
    try { const r = e.receiver; if (r && 'jitterBufferTarget' in r) r.jitterBufferTarget = e.track.kind === 'audio' ? 60 : 100; } catch {}
    st.onaddtrack = attachRemote; st.onremovetrack = attachRemote;
    attachRemote();
  };
  pc.onconnectionstatechange = () => {
    if (rpc !== pc) return;
    if (pc.connectionState === 'connected') send({ type: 'rtc-ready', ok: true });        // endi men ham relay bo'la olaman
    if (pc.connectionState === 'failed') setTimeout(() => { if (rpc === pc && S.joined) recvWant(); }, 800 + Math.random() * 800);
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
      const ans = await pc.createAnswer();
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
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: 'rtc-signal', to: id, data: { sdp: pc.localDescription } });
    } catch (e) { console.warn('offer', e); }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') applySender(p, p.cur);
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
  mb.className = 'sec' + (local.mic ? ' live' : '');
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

function renderRecvList() {
  const ul = $('#recvList');
  ul.textContent = '';
  const list = S.members.list || [];
  $('#recvEmpty').hidden = list.length > 0;
  list.forEach(r => {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot' + (r.ready ? ' ok' : ''); dot.title = r.ready ? 'tayyor' : 'yuklanmoqda';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name;
    const sts = document.createElement('span'); sts.className = 'sz';
    sts.textContent = r.stat ? `${qBars(r.stat.q)} ${Math.round(r.stat.rtt)}ms · Δ${Math.round(r.stat.drift)}ms` : '';
    const mu = document.createElement('button'); mu.textContent = r.muted ? '🔇' : '🔊'; mu.className = r.muted ? 'on' : ''; mu.title = r.muted ? 'Dinamigini yoqish' : 'Dinamigini o\'chirish';
    mu.onclick = () => send({ type: 'mute-one', id: r.id, muted: !r.muted });
    const kk = document.createElement('button'); kk.textContent = '✕'; kk.title = 'Chiqarib yuborish';
    kk.onclick = () => { if (confirm(`"${r.name}" xonadan chiqarilsinmi?`)) send({ type: 'kick', id: r.id }); };
    li.append(dot, nm, sts, mu, kk);
    ul.appendChild(li);
  });
}

function renderCtl() {
  const c = S.cfg;
  if (isHost()) {
    $('#cfgView').checked = c.allowView; $('#cfgDl').checked = c.allowDownload;
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
  else if (!isMedia(it.kind)) { text = '👁 Transmitter ko\'rsatmoqda'; cls = 'ok'; }
  else if (pendingId === it.id) { const r = cache.get(it.id); text = `⬇ Yuklanmoqda ${Math.round((r ? r.pct : 0) * 100)}%`; cls = 'warn'; }
  else if (!S.st.playing) { text = S.waiting > 0 ? `⏳ ${S.waiting} ta qurilma tayyorlanmoqda…` : '⏸ Pauza'; }
  else if (!mReady()) { text = '⏳ Yuklanmoqda…'; cls = 'warn'; }
  else if (S.drift != null && Math.abs(S.drift) < 0.05) { text = `🟢 Sinxron ±${Math.round(Math.abs(S.drift) * 1000)} ms`; cls = 'ok'; }
  else { text = '🔄 Sinxronlanmoqda…'; cls = 'warn'; }
  const chip = $('#rChip');
  chip.textContent = text;
  chip.className = 'chip ' + cls;
  $('#rMute').hidden = !(S.cfg.muteAll || S.myMuted);
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
const queue = []; let uploading = false;
function enqueue(files) {
  for (const f of files) {
    if (!kindOfName(f.name)) { toast(`"${f.name}" — bu format qo'llab-quvvatlanmaydi`, 4000); continue; }
    if (S.maxMb && f.size > S.maxMb * 1048576) { toast(`"${f.name}" ${fmtLimit(S.maxMb)} dan katta (${fmtSize(f.size)})`, 5000); continue; }
    queue.push(f);
  }
  pump();
}
function pump() {
  if (uploading || !queue.length) return;
  uploading = true;
  const file = queue.shift();
  const cid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  blobs.set(cid, URL.createObjectURL(file));
  if (isMedia(kindOfName(file.name))) analyzeLater(cid, file);
  const row = document.createElement('div'); row.className = 'up';
  const nm = document.createElement('span'); nm.textContent = `${file.name} · ${fmtSize(file.size)}`;
  const pr = document.createElement('progress'); pr.max = 100; pr.value = 0;
  const pt = document.createElement('small'); pt.className = 'up-pct'; pt.textContent = '0%';
  row.append(nm, pr, pt); $('#uploads').appendChild(row);
  const t0 = performance.now();
  const fail = msg => {
    row.className = 'up bad';
    pr.replaceWith(Object.assign(document.createElement('span'), { textContent: msg })); pt.remove();
    URL.revokeObjectURL(blobs.get(cid)); blobs.delete(cid);
    setTimeout(() => row.remove(), 6000);
  };
  const xhr = new XMLHttpRequest();
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
    uploading = false; pump();
  };
  xhr.onerror = () => { fail('Tarmoq xatosi'); uploading = false; pump(); };
  xhr.send(file);
}
$('#fileIn').onchange = e => { enqueue([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => enqueue([...e.dataTransfer.files]));

$('#urlBtn').onclick = () => {
  const url = $('#urlIn').value.trim();
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
  const name = $('#nameIn').value.trim();
  localStorage.setItem('sc_name', name);
  startSession('receiver', code, null, name);
}
$('#joinBtn').onclick = doJoin;
$('#codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

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
async function unzipDocx(buf) {
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
    if (!(name === 'word/document.xml' || name === 'word/_rels/document.xml.rels' || name.startsWith('word/media/'))) continue;
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
$('#qzDocxIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  toast('📄 Word fayl o\'qilmoqda…', 2500);
  try { qzImportQs(parseQuizLines(await docxToLines(f)), 'Word faylda'); }
  catch (err) { toast(err.message === 'nodecomp' ? 'Bu brauzer .docx ni o\'qiy olmaydi — matndan import qiling' : 'Word faylni o\'qib bo\'lmadi (.docx bo\'lishi kerak)', 5000); }
};
$('#qzTxtGo').onclick = () => { qzImportQs(parseQuizLines($('#qzTxt').value.split('\n').map(t => ({ text: t, bold: false, imgs: [] }))), 'Matnda'); $('#qzTxt').value = ''; };
$('#qzExport').onclick = () => {
  const data = JSON.stringify({ title: QZ.title, qs: QZ.qs }, (k, v) => (QSKIP.includes(k) ? undefined : v));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = (QZ.title || 'viktorina').replace(/[^\w\-]+/g, '_') + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('#qzImportJson').onclick = () => $('#qzJsonIn').click();
$('#qzJsonIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const qs = (d.qs || d.questions || []).map(q => Object.assign(newQ(), q, { open: false, check: false }));
    if (!qs.length) throw new Error('empty');
    if (d.title && !QZ.title) QZ.title = d.title;
    QZ.qs.push(...qs); qzSave(); qzRender(); toast(`✅ ${qs.length} ta savol ochildi`);
  } catch { toast('JSON fayl noto\'g\'ri'); }
};
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
    send({ type: 'quiz-start', quiz: { title: QZ.title || 'Viktorina', questions: out } });
  } catch { eb.textContent = 'Rasm yuklashda xato. Qayta urinib ko\'ring.'; eb.hidden = false; }
  btn.disabled = false; btn.textContent = '▶ O\'yinni boshlash';
};

// ---- tablar
function showTab(name) {
  $('#tabMedia').hidden = name !== 'media'; $('#tabQuiz').hidden = name !== 'quiz';
  document.querySelectorAll('#hostTabs .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
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
  const qt = qel('div', 'qz-q', q.text); qt.dataset.len = lenCls(q.text);
  wrap.appendChild(qt);
  const main = qel('div', 'qb-main');
  if (o.mid) main.appendChild(o.mid);
  else { const im = qImg(q); if (im) wrap.appendChild(im); }
  const g = qel('div', 'qz-grid n' + q.opts.length + (o.locked ? ' locked' : '')); g.id = o.gridId || '';
  q.opts.forEach((txt, i) => {
    const b = qel(o.onPick ? 'button' : 'div', 'qopt'); b.style.background = QCOL[i];
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
  const cnt = qel('div', 'qz-count'); cnt.id = o.countId || ''; cnt.hidden = true; main.appendChild(cnt);
  wrap.appendChild(main);
  parent.appendChild(wrap);
}
function lbList(parent, top, medals) {
  const ul = qel('ul', 'lb');
  top.forEach((t, i) => {
    const li = qel('li', '');
    li.append(qel('span', 'rk', medals && i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1)), qel('span', 'nm', t.name), qel('span', 'pt', String(t.score)));
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
    const d = qel('div', cls); d.append(qel('span', '', ['🥇', '🥈', '🥉'][i]), qel('small', '', top[i].name), qel('small', '', String(top[i].score))); pd.appendChild(d);
  });
  parent.appendChild(pd);
}
function onQuiz(pub) {
  const prev = S.quiz;
  S.quiz = pub;
  if (!pub) { S.qMe = null; S.qAns = null; S.qProg = null; }
  else {
    const newGame = !prev || prev.id !== pub.id;
    if (newGame || prev.idx !== pub.idx) { S.qAns = null; if (S.qProg) S.qProg = Object.assign({}, S.qProg, { answered: 0 }); }
    if (newGame) S.qMe = null;
    if (prev && !newGame && prev.phase !== pub.phase && (pub.phase === 'reveal' || pub.phase === 'final') && S.qMe) S.qMe = Object.assign({}, S.qMe, { stale: true });   // yangi natija kelguncha eski natija ko'rsatilmasin
    if (isHost() && newGame) showTab('quiz');
  }
  renderQuiz();
}
const renderQuiz = () => (isHost() ? renderQuizHost() : renderQuizPlay());

// ---- Transmitter: o'yin paneli (to'liq ekran, proyektor uchun)
const qPlayersN = qz => (S.members && S.members.total) || (S.qProg && S.qProg.players) || (qz && qz.players) || 0;
function renderQuizHost() {
  const qz = S.quiz;
  $('#qzEditor').hidden = !!qz; $('#qzGame').hidden = !qz;
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
  const body = $('#qgBody'); body.textContent = '';
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
    (S.members.list || []).slice(0, 120).forEach(m => chips.appendChild(qel('span', 'qg-chip', m.name)));
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
    podium(body, qz.top || []);
    lbList(body, qz.top || [], true);
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
  const body = $('#qpBody'); body.textContent = '';
  body.className = 'qp-body ph-' + qz.phase;
  ov.scrollTop = 0;
  const me = S.qMe;
  if (qz.phase === 'lobby') {
    const d = qel('div', 'qp-big card'); d.append(qel('div', 'em', '🎯'), qel('h2', '', 'Tayyor bo\'ling!'), qel('p', 'muted', 'Transmitter o\'yinni boshlashini kuting.'));
    const inp = document.createElement('input'); inp.maxLength = 24; inp.placeholder = 'Nikingiz'; inp.value = S.name || '';
    inp.onchange = () => { S.name = inp.value.trim(); localStorage.setItem('sc_name', S.name); if (S.name) send({ type: 'quiz-nick', name: S.name }); };
    d.appendChild(inp); d.appendChild(qel('div', 'qp-n', `👥 ${qPlayersN(qz)} ta o'yinchi`));
    body.appendChild(d);
  } else if (qz.phase === 'question') {
    const tm = qel('div', 'qz-timer'); const bar = qel('i'); bar.id = 'qpBar'; tm.appendChild(bar); body.appendChild(tm);
    const t = qel('div', 'qz-time'); t.id = 'qpTime'; body.appendChild(t);
    qBlock(body, qz, { gridId: 'qpGrid', countId: 'qpCount', onPick: qAnswer, picked: S.qAns, locked: S.qAns != null || sNow() < qz.startAt, fill: true });
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
    podium(body, qz.top || []);
    if (me && me.rank) body.appendChild(qel('div', 'qp-banner none', `Sizning o'rningiz: #${me.rank} / ${me.n}`)).appendChild(qel('small', '', `${me.score} ball`));
    lbList(body, qz.top || [], true);
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
  if (q) $('#codeIn').value = q.replace(/\D/g, '').slice(0, 6);
  refreshResume();
})();
})();
