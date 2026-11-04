(() => {
'use strict';
// 🙂 Face ID dvigateli. Yuz brauzerning o'zida aniqlanadi va 128 sonli vektorga aylantiriladi (face-api.js: TinyFaceDetector + 68 nuqta + ResNet-34).
// Serverga rasm emas, faqat 128 sonli vektor (344 belgi) ketadi. Solishtirish serverda (attendance.js).
// Kutubxona va modellar avval lokal (/vendor, /models — `npm install` qo'yadi), bo'lmasa CDN'dan olinadi va brauzerda keshlanadi.
const VER = '1.7.13', CDN = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${VER}`;
const SRC = ['/vendor/face-api.js', CDN + '/dist/face-api.js'], MODELS = ['/models', CDN + '/model'];
const FD = 128, QS = 10000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const script = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => { s.remove(); rej(new Error('script')); }; document.head.appendChild(s); });
const fail = (code, msg) => { const e = new Error(msg); e.code = code; return e; };

// ---- vektor <-> base64 (Int16 LE x10000). Server bilan bir xil format ----
function enc(f) {
  const dv = new DataView(new ArrayBuffer(FD * 2));
  for (let i = 0; i < FD; i++) dv.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(f[i] * QS))), true);
  let s = ''; for (let i = 0; i < FD * 2; i++) s += String.fromCharCode(dv.getUint8(i));
  return btoa(s);
}
function dec(b64) {
  try { const s = atob(b64); if (s.length !== FD * 2) return null; const dv = new DataView(new ArrayBuffer(FD * 2)); for (let i = 0; i < s.length; i++) dv.setUint8(i, s.charCodeAt(i));
    const f = new Float32Array(FD); for (let i = 0; i < FD; i++) f[i] = dv.getInt16(i * 2, true) / QS; return f; } catch { return null; }
}
const dist = (a, b) => { let s = 0; for (let i = 0; i < FD; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };
const mean = list => { const m = new Float32Array(FD); for (const d of list) for (let i = 0; i < FD; i++) m[i] += d[i] / list.length; return m; };

// ---- yuklash (bir marta) ----
let P = null, OPT = {};
function load(cb) {
  if (P) return P;
  const say = t => { try { cb && cb(t); } catch {} };
  P = (async () => {
    say('Yuz tanish moduli yuklanmoqda…');
    if (!window.faceapi) { for (const s of SRC) { try { await script(s); if (window.faceapi) break; } catch {} } }
    const fa = window.faceapi; if (!fa) throw fail('lib', 'Yuz tanish moduli yuklanmadi. Internetni tekshiring yoki serverda «npm install» ni ishga tushiring');
    try { await fa.tf.setBackend('webgl'); } catch {}
    try { await fa.tf.ready(); } catch {}
    say('Yuz modellari yuklanmoqda (birinchi marta ~7 MB)…');
    let ok = false;
    for (const base of MODELS) {
      try { await Promise.all([fa.nets.tinyFaceDetector.loadFromUri(base), fa.nets.faceLandmark68TinyNet.loadFromUri(base), fa.nets.faceRecognitionNet.loadFromUri(base)]); ok = true; break; } catch {}
    }
    if (!ok) throw fail('model', 'Yuz modellari yuklanmadi. Internetni tekshiring yoki serverda «npm install» ni ishga tushiring');
    say('Tayyorlanmoqda…');
    try { const c = document.createElement('canvas'); c.width = c.height = 160; await fa.detectSingleFace(c, new fa.TinyFaceDetectorOptions({ inputSize: 160 })).withFaceLandmarks(true).withFaceDescriptor(); } catch {}   // «isitish»: birinchi haqiqiy kadr sekin bo'lmasin
    return fa;
  })();
  P.catch(() => { P = null; });
  return P;
}

// ---- yuz holati: burilish (yaw) va ko'z ochiqligi (EAR) ----
const ear = (p, o) => { const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y); return (d(o + 1, o + 5) + d(o + 2, o + 4)) / (2 * d(o, o + 3) || 1); };
function pose(lm) {
  const p = lm.positions, w = p[16].x - p[0].x || 1;
  return { yaw: (p[30].x - p[0].x) / w, ear: (ear(p, 36) + ear(p, 42)) / 2 };
}
const detOpt = size => new window.faceapi.TinyFaceDetectorOptions({ inputSize: size || 224, scoreThreshold: 0.5 });
const lm = (v, size) => window.faceapi.detectSingleFace(v, detOpt(size)).withFaceLandmarks(true);
// Yuz allaqachon topilgan (r) — vektor shu natijadan olinadi, detektor ikkinchi marta ishlamaydi (≈2 baravar tez). Xato bo'lsa — eski yo'l.
async function desc(v, r, size) {
  try { const fa = window.faceapi, cv = await fa.extractFaces(v, [r.alignedRect]), d = await fa.nets.faceRecognitionNet.computeFaceDescriptor(cv[0]); if (d && d.length === FD) return d; } catch {}
  const d = await full(v, size); return d && d.descriptor;
}
const full = (v, size) => window.faceapi.detectSingleFace(v, detOpt(size)).withFaceLandmarks(true).withFaceDescriptor();

// ---- 🍎 Face ID halqasi (iPhone uslubida): video atrofida 48 ta chiziqcha, bosh burilgan tomonga qarab yonadi ----
// Chiziqchalar 4 sektorga bo'lingan (tepa / o'ng / past / chap). Bosh burilgan sari sektor to'lib boradi, nuqta bosh yo'nalishini ko'rsatadi.
// Holatlar: scan (qidiruv) → wait (tekshirilmoqda) → ok (yashil ✓) yoki bad (qizil, silkinish).
const NS = 'http://www.w3.org/2000/svg', TK = 48, SEC = { u: 42, r: 6, d: 18, l: 30 };   // sektor boshlanish chiziqchasi (soat mili bo'yicha, tepadan)
function ring(video) {
  if (!video || !video.parentNode) return null;
  if (video._fid) return video._fid;
  const el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const wrap = document.createElement('div'); wrap.className = 'fid-wrap';
  const svg = el('svg', { viewBox: '0 0 200 200', class: 'fid-svg', 'aria-hidden': 'true' }), ticks = [];
  for (let i = 0; i < TK; i++) {
    const a = i / TK * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
    const t = el('line', { x1: (100 + 88 * s).toFixed(2), y1: (100 - 88 * c).toFixed(2), x2: (100 + 97 * s).toFixed(2), y2: (100 - 97 * c).toFixed(2), class: 'fid-t' });
    svg.appendChild(t); ticks.push(t);
  }
  const dot = el('circle', { r: 3.6, cx: 100, cy: 12, class: 'fid-dot' }); svg.appendChild(dot);
  const inner = document.createElement('div'); inner.className = 'fid-in';
  video.parentNode.insertBefore(wrap, video); wrap.appendChild(svg); wrap.appendChild(inner); inner.appendChild(video);
  const line = document.createElement('div'); line.className = 'fid-line'; inner.appendChild(line);
  const ar = {}; [['u', '↑'], ['d', '↓'], ['l', '←'], ['r', '→']].forEach(([k, g]) => { const a = document.createElement('span'); a.className = 'fid-ar fid-ar-' + k; a.textContent = g; inner.appendChild(a); ar[k] = a; });
  const ck = document.createElement('div'); ck.className = 'fid-ck'; ck.innerHTML = '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="27"/><path d="M19 33l9 9 17-19"/></svg>'; inner.appendChild(ck);
  let tm = 0, last = { u: 0, r: 0, d: 0, l: 0 };
  const set = c => { wrap.className = 'fid-wrap ' + c; };
  const R = {
    wrap,
    reset() { clearTimeout(tm); set('s-scan'); last = { u: 0, r: 0, d: 0, l: 0 }; ticks.forEach(t => t.classList.remove('on')); dot.style.opacity = 0; for (const k in ar) ar[k].classList.remove('show', 'done'); },
    sweep(on) { if (on) wrap.classList.add('sweeping'); else wrap.classList.remove('sweeping'); },
    prog(p, dir) {                                          // p: {u,r,d,l} 0..1 (eng yuqori erishilgan), dir: {x,y} -1..1 — bosh hozirgi yo'nalishi
      for (const k in SEC) {
        const n = Math.round(Math.min(1, p[k]) * 12), was = Math.round(Math.min(1, last[k]) * 12);
        if (n !== was) for (let j = 0; j < 12; j++) ticks[(SEC[k] + j) % TK].classList.toggle('on', j < n);
        ar[k].classList.toggle('show', p[k] < 1); ar[k].classList.toggle('done', p[k] >= 1);
      }
      last = Object.assign({}, p);
      if (dir) { const m = Math.hypot(dir.x, dir.y) || 1, k = m > 1 ? 1 / m : 1; dot.style.opacity = 1; dot.setAttribute('cx', (100 + 92.5 * dir.x * k).toFixed(1)); dot.setAttribute('cy', (100 - 92.5 * dir.y * k).toFixed(1)); }
    },
    hold() { set('s-wait'); ticks.forEach(t => t.classList.add('on')); dot.style.opacity = 0; for (const k in ar) ar[k].classList.remove('show'); },
    ok() { set('s-ok'); ticks.forEach(t => t.classList.add('on')); dot.style.opacity = 0; try { navigator.vibrate && navigator.vibrate([18, 40, 28]); } catch {} },
    bad() { set('s-bad'); ticks.forEach(t => t.classList.add('on')); dot.style.opacity = 0; clearTimeout(tm); tm = setTimeout(() => R.reset(), 1100); },
  };
  R.reset(); video._fid = R; return R;
}
// Bosh ko'tarilishi/pastga tushishi: burun uchining ko'z chizig'i va iyak oralig'idagi nisbiy o'rni (tepaga qarasa kamayadi, pastga qarasa oshadi)
const pitchOf = p => { let ey = 0; for (let i = 36; i < 48; i++) ey += p[i].y; ey /= 12; return (p[30].y - ey) / ((p[8].y - ey) || 1); };

// ---- Skanerlash: barqaror yuz vektori + JONLILIK ----
// Jonlilik (o.live): true — FAOL (tasodifiy 2 ta topshiriq: ko'z qisish / og'iz ochish / bosh burish; rasm va ekrandagi surat o'tolmaydi),
// 'passive' — kiosk uchun (tabiiy ko'z qisish yoki bosh burilishi), false — o'chiq.
// Faol rejimda identifikatsiya vektori topshiriqlardan KEYIN olinadi va topshiriqdan oldingi vektor bilan solishtiriladi (odam almashtirib bo'lmaydi).
// o: { need=3, live=true, size=224, timeout, minFace=0.2, stop(), onStatus(text, kind) }
const mar = p => { const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y); return (d(61, 67) + d(62, 66) + d(63, 65)) / (3 * (d(60, 64) || 1)); };
const med = a => { const x = [...a].sort((u, v) => u - v); return x.length ? x[x.length >> 1] : 0; };
const PROMPT = { blink: '👁 Ko‘zingizni bir marta qisib oching', mouth: '😮 Og‘zingizni keng oching («aaa»)', turn: '↔ Boshingizni sekin yon tomonga buring' };
async function scan(video, o = {}) {
  await load();
  const mode = o.live === false ? 'off' : o.live === 'passive' ? 'passive' : 'active', need = o.need || (o.live === false || o.live === 'passive' ? 3 : 2), st = (t, k) => { try { o.onStatus && o.onStatus(t, k); } catch {} };
  const t0 = Date.now(), tmax = o.timeout || (mode === 'active' ? 60000 : 25000);
  const got = [], eA = [], mA = [], yA = [], pA = []; let yMin = 9, yMax = -9, eMax = 0, closed = false, blink = false, lastCap = 0, seen = 0;
  const RG = mode === 'active' && o.ring !== false ? ring(video) : null; if (RG) RG.reset();   // iPhone uslubidagi Face ID halqasi (faqat faol rejimda)
  const tsz = mode === 'active' ? Math.min(o.size || 192, 192) : o.size;                         // kichikroq kirish — tezroq aniqlash
  const guard = () => {
    if (o.stop && o.stop()) throw fail('abort', 'To‘xtatildi');
    if (Date.now() - t0 > tmax) throw fail('timeout', seen < 3 ? 'Yuz ko‘rinmadi. Kameraga to‘g‘ri qarang va yorug‘ joyga chiqing' : 'Yuz aniq o‘qilmadi yoki jonlilik tasdiqlanmadi. Qayta urining');
  };
  // frontal va sifatli kadr kutadi; vektor kerak bo'lsa — uni ham oladi
  const frontal = async (list, n) => {
    while (list.length < n) {
      guard(); if (!video.videoWidth) { await sleep(60); continue; }
      const r = await lm(video, tsz);
      if (!r) { st('Yuz ko‘rinmayapti — kameraga qarang', 'warn'); await frame(); continue; }
      const w = r.detection.box.width / video.videoWidth, { yaw } = pose(r.landmarks);
      let hint = '';
      if (r.detection.score < 0.7) hint = 'Yuz aniq emas — yorug‘roq joyga o‘ting';
      else if (w < (o.minFace || 0.2)) hint = 'Kameraga yaqinroq keling';
      else if (w > 0.8) hint = 'Kameradan biroz uzoqlashing';
      else if (Math.abs(yaw - 0.5) > 0.2) hint = 'Kameraga to‘g‘ri qarang';
      if (hint) { st(hint, 'warn'); await frame(); continue; }
      if (Date.now() - lastCap >= 120) {
        const d = await desc(video, r, tsz); lastCap = Date.now();
        if (d) { if (list.length && dist(list[0], d) > 0.45) list.length = 0; list.push(d); const p = r.landmarks.positions; eA.push((ear(p, 36) + ear(p, 42)) / 2); mA.push(mar(p)); yA.push(yaw); pA.push(pitchOf(p)); }
      }
      st(`Yuz o‘qilmoqda ${list.length}/${n}`, 'ok'); await frame();
    }
  };
  // 1) birinchi vektorlar (+ jonsiz kuzatuv: passiv rejim uchun)
  for (;;) {
    await frontal(got, need);
    if (mode !== 'passive') break;
    // passiv: kuzatuv davom etadi — tabiiy ko'z qisish yoki bosh burilishi kerak
    guard(); const r = await lm(video, o.size); if (!r) { await frame(); continue; }
    const { yaw, ear: e } = pose(r.landmarks); seen++; yMin = Math.min(yMin, yaw); yMax = Math.max(yMax, yaw); eMax = Math.max(eMax * 0.995, e);
    if (e < eMax * 0.62) closed = true; else if (closed && e > eMax * 0.85) blink = true;
    if (blink || yMax - yMin >= 0.12) return { desc: mean(got), live: true, n: got.length };
    st('Kameraga qarab turing…', 'ok'); await frame();
  }
  if (mode === 'off') return { desc: mean(got), live: true, n: got.length };
  // 2) Face ID aylantirish: yuzni o'ngga, chapga, tepaga va pastga burish (tartib farqi yo'q). Rasm/ekrandagi surat buni bajara olmaydi:
  //    haqiqiy boshda burun yonoqlarga va ko'z–iyak oralig'iga nisbatan siljiydi, tekis rasmda esa deyarli o'zgarmaydi.
  const base = { y: med(yA) || 0.5, p: med(pA) }, TX = 0.1, TP = 0.065, hit = { u: 0, r: 0, d: 0, l: 0 }, NM = { r: 'o‘ngga', l: 'chapga', u: 'tepaga', d: 'pastga' }, ts = Date.now();
  const cl1 = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  if (RG) { RG.sweep(true); RG.prog(hit, { x: 0, y: 0 }); }
  st('Yuzingizni sekin buring: o‘ngga, chapga, tepaga, pastga', 'ok');
  while (hit.u < 1 || hit.r < 1 || hit.d < 1 || hit.l < 1) {
    guard(); if (Date.now() - ts > 25000) throw fail('timeout', 'Yuz aylantirilmadi. Boshingizni o‘ngga, chapga, tepaga va pastga sekin buring, so‘ng qayta urining');
    const r = await lm(video, 160);
    if (!r) { st('Yuz ko‘rinmayapti — kameraga qarang', 'warn'); await frame(); continue; }
    const p = r.landmarks.positions, dx = (p[30].x - p[0].x) / ((p[16].x - p[0].x) || 1) - base.y, dp = pitchOf(p) - base.p;
    // video ko'zgudek ko'rsatiladi: ekrandagi o'ng = kadrda chap (dx < 0)
    hit.r = Math.max(hit.r, cl1(-dx / TX)); hit.l = Math.max(hit.l, cl1(dx / TX)); hit.u = Math.max(hit.u, cl1(-dp / TP)); hit.d = Math.max(hit.d, cl1(dp / TP));
    if (RG) RG.prog(hit, { x: cl1(-dx / TX, -1, 1), y: cl1(-dp / TP, -1, 1) });
    const left = ['r', 'l', 'u', 'd'].filter(k => hit[k] < 1).map(k => NM[k]);
    if (left.length) st('Yuzingizni sekin buring: ' + left.join(', '), 'ok');
    await frame();
  }
  if (RG) RG.sweep(false);
  // 3) to'g'ri qaragandan keyingi vektor: oldingisiga o'xshash bo'lishi shart (boshqa odam yoki rasm almashtirib bo'lmaydi)
  st('Endi to‘g‘ri qarang…', 'ok');
  const after = []; await frontal(after, 1);
  if (dist(mean(got), mean(after)) > 0.5) { if (RG) RG.bad(); throw fail('swap', 'Kadrda yuz o‘zgardi. Bitta odam, qayta urining'); }
  if (RG) RG.hold();
  return { desc: mean([...got, ...after]), live: true, n: got.length + after.length };
}

// ---- Ro'yxatga olish: 5 ta kadr, har xil holatda (to'g'ri / bir tomon / qarama-qarshi tomon / to'g'ri / to'g'ri) ----
const STAGES = [
  ['To‘g‘ri qarang', (dy) => Math.abs(dy) < 0.06],
  ['Boshingizni biroz BIR tomonga buring', (dy, s) => Math.abs(dy) >= 0.06 && Math.abs(dy) <= 0.22],
  ['Endi QARAMA-QARSHI tomonga buring', (dy, s) => s !== 0 && dy * s <= -0.06 && Math.abs(dy) <= 0.22],
  ['To‘g‘ri qarang', (dy) => Math.abs(dy) < 0.06],
  ['To‘g‘ri qarang va ozgina tabassum qiling', (dy) => Math.abs(dy) < 0.06],
];
// o: { size=320, timeout=60000, stop(), onStep(i, total, text), onStatus(text, kind) }
async function enroll(video, o = {}) {
  await load();
  const st = (t, k) => { try { o.onStatus && o.onStatus(t, k); } catch {} }, out = [], t0 = Date.now(); let side = 0, stage = 0, lastCap = 0, okRun = 0;
  const step = () => { try { o.onStep && o.onStep(stage, STAGES.length, STAGES[stage][0]); } catch {} }; step();
  while (stage < STAGES.length) {
    if (o.stop && o.stop()) throw fail('abort', 'To‘xtatildi');
    if (Date.now() - t0 > (o.timeout || 60000)) throw fail('timeout', 'Vaqt tugadi. Yorug‘ joyda, kameraga qarab qayta urining');
    if (!video.videoWidth) { await sleep(60); continue; }
    const r = await lm(video, o.size || 320);
    if (!r) { st('Yuz ko‘rinmayapti', 'warn'); okRun = 0; await frame(); continue; }
    const w = r.detection.box.width / video.videoWidth, { yaw } = pose(r.landmarks), dy = yaw - 0.5;
    if (r.detection.score < 0.7) { st('Yuz aniq emas — yorug‘roq joy kerak', 'warn'); okRun = 0; await frame(); continue; }
    if (w < 0.25) { st('Kameraga yaqinroq keling', 'warn'); okRun = 0; await frame(); continue; }
    if (w > 0.8) { st('Kameradan biroz uzoqlashing', 'warn'); okRun = 0; await frame(); continue; }
    if (!STAGES[stage][1](dy, side)) { st(STAGES[stage][0], 'warn'); okRun = 0; await frame(); continue; }
    okRun++;
    if (okRun >= 2 && Date.now() - lastCap > 350) {
      const d = await desc(video, r, o.size || 320); lastCap = Date.now();
      if (d) {
        if (out.length && dist(out[0], d) > 0.55) { st('Kadrda boshqa odam — bitta odam bo‘lsin', 'warn'); okRun = 0; await frame(); continue; }
        out.push(d); if (stage === 1) side = dy > 0 ? 1 : -1; stage++; okRun = 0;
        if (stage < STAGES.length) step();
      }
    }
    await frame();
  }
  return out;
}

window.FACE = { load, scan, enroll, ring, enc, dec, dist, mean, supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };
})();
