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
  const mode = o.live === false ? 'off' : o.live === 'passive' ? 'passive' : 'active', need = o.need || 3, st = (t, k) => { try { o.onStatus && o.onStatus(t, k); } catch {} };
  const t0 = Date.now(), tmax = o.timeout || (mode === 'active' ? 60000 : 25000);
  const got = [], eA = [], mA = [], yA = []; let yMin = 9, yMax = -9, eMax = 0, closed = false, blink = false, lastCap = 0, seen = 0;
  const guard = () => {
    if (o.stop && o.stop()) throw fail('abort', 'To‘xtatildi');
    if (Date.now() - t0 > tmax) throw fail('timeout', seen < 3 ? 'Yuz ko‘rinmadi. Kameraga to‘g‘ri qarang va yorug‘ joyga chiqing' : 'Yuz aniq o‘qilmadi yoki jonlilik tasdiqlanmadi. Qayta urining');
  };
  // frontal va sifatli kadr kutadi; vektor kerak bo'lsa — uni ham oladi
  const frontal = async (list, n) => {
    while (list.length < n) {
      guard(); if (!video.videoWidth) { await sleep(60); continue; }
      const r = await lm(video, o.size);
      if (!r) { st('Yuz ko‘rinmayapti — kameraga qarang', 'warn'); await frame(); continue; }
      const w = r.detection.box.width / video.videoWidth, { yaw } = pose(r.landmarks);
      let hint = '';
      if (r.detection.score < 0.7) hint = 'Yuz aniq emas — yorug‘roq joyga o‘ting';
      else if (w < (o.minFace || 0.2)) hint = 'Kameraga yaqinroq keling';
      else if (w > 0.8) hint = 'Kameradan biroz uzoqlashing';
      else if (Math.abs(yaw - 0.5) > 0.16) hint = 'Kameraga to‘g‘ri qarang';
      if (hint) { st(hint, 'warn'); await frame(); continue; }
      if (Date.now() - lastCap >= 120) {
        const d = await desc(video, r, o.size); lastCap = Date.now();
        if (d) { if (list.length && dist(list[0], d) > 0.45) list.length = 0; list.push(d); const p = r.landmarks.positions; eA.push((ear(p, 36) + ear(p, 42)) / 2); mA.push(mar(p)); yA.push(yaw); }
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
  // 2) faol topshiriqlar: tasodifiy 2 tasi (ko'z/og'iz albatta bor — rasm uni bajara olmaydi)
  const base = { e: med(eA), m: med(mA), y: med(yA) || 0.5 };
  const pool = ['blink', 'mouth', 'turn'].sort(() => Math.random() - 0.5), picks = pool.slice(0, 2);
  for (let k = 0; k < picks.length; k++) {
    const c = picks[k], tc = Date.now(); let streak = 0, shut = 0, open0 = 0, done = false;
    while (!done) {
      guard(); if (Date.now() - tc > 14000) throw fail('timeout', 'Topshiriq bajarilmadi. Ko‘rsatmaga amal qilib qayta urining');
      const r = await lm(video, o.size); if (!r) { st('Yuz ko‘rinmayapti — kameraga qarang', 'warn'); await frame(); continue; }
      const p = r.landmarks.positions, e = (ear(p, 36) + ear(p, 42)) / 2, mm = mar(p), yaw = (p[30].x - p[0].x) / ((p[16].x - p[0].x) || 1), dy = Math.abs(yaw - base.y);
      st(`${k + 1}/${picks.length} · ${PROMPT[c]}`, 'ok');
      if (c === 'blink') { if (dy < 0.15) { if (e < base.e * 0.62) shut++; else if (e > base.e * 0.85) { if (shut) done = true; else open0++; } } }
      else if (c === 'mouth') { streak = dy < 0.15 && mm > Math.max(0.38, base.m + 0.2) ? streak + 1 : 0; done = streak >= 2; }
      else { streak = dy >= 0.12 ? streak + 1 : 0; done = streak >= 2; }
      await frame();
    }
    st('✓ Yaxshi', 'ok');
    for (let tt = Date.now(); Date.now() - tt < 5000;) {         // keyingi qadamdan oldin yana to'g'ri qarashini kutamiz
      guard(); const r = await lm(video, o.size); if (r) { const p = r.landmarks.positions; if (Math.abs((p[30].x - p[0].x) / ((p[16].x - p[0].x) || 1) - base.y) < 0.07 && mar(p) < base.m + 0.12) break; }
      st('Kameraga to‘g‘ri qarang', 'warn'); await frame();
    }
  }
  // 3) topshiriqlardan keyingi vektorlar: oldingisiga o'xshash bo'lishi shart (boshqa yoki rasm almashtirib bo'lmaydi)
  const after = []; await frontal(after, need);
  if (dist(mean(got), mean(after)) > 0.5) throw fail('swap', 'Kadrda yuz o‘zgardi. Bitta odam, qayta urining');
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

window.FACE = { load, scan, enroll, enc, dec, dist, mean, supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };
})();
