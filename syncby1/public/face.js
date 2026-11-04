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
const full = (v, size) => window.faceapi.detectSingleFace(v, detOpt(size)).withFaceLandmarks(true).withFaceDescriptor();

// ---- Skanerlash: barqaror yuz vektori + jonlilik ----
// o: { need=3, live=true, size=224, timeout=25000, minFace=0.2, stop(), onStatus(text, kind) }
async function scan(video, o = {}) {
  await load();
  const need = o.need || 3, st = (t, k) => { try { o.onStatus && o.onStatus(t, k); } catch {} };
  const t0 = Date.now(), got = []; let yMin = 9, yMax = -9, hi = 0, closed = false, blink = false, lastCap = 0, seen = 0;
  for (;;) {
    if (o.stop && o.stop()) throw fail('abort', 'To‘xtatildi');
    if (Date.now() - t0 > (o.timeout || 25000)) throw fail('timeout', seen < 3 ? 'Yuz ko‘rinmadi. Kameraga to‘g‘ri qarang va yorug‘ joyga chiqing' : 'Yuz aniq o‘qilmadi. Yorug‘likni yaxshilang va qayta urining');
    if (!video.videoWidth) { await sleep(60); continue; }
    const r = await lm(video, o.size);
    if (!r) { st('Yuz ko‘rinmayapti — kameraga qarang', 'warn'); await frame(); continue; }
    seen++;
    const w = r.detection.box.width / video.videoWidth, { yaw, ear: e } = pose(r.landmarks);
    yMin = Math.min(yMin, yaw); yMax = Math.max(yMax, yaw);
    if (e > 0.26) { hi++; if (closed) blink = true; } else if (e < 0.2 && hi > 2) closed = true;
    const live = o.live === false || blink || yMax - yMin >= 0.09;
    let hint = '';
    if (r.detection.score < 0.6) hint = 'Yuz aniq emas — yorug‘roq joyga o‘ting';
    else if (w < (o.minFace || 0.2)) hint = 'Kameraga yaqinroq keling';
    else if (w > 0.8) hint = 'Kameradan biroz uzoqlashing';
    else if (Math.abs(yaw - 0.5) > 0.16) hint = 'Kameraga to‘g‘ri qarang';
    if (hint) { st(hint, 'warn'); await frame(); continue; }
    if (got.length < need) {
      if (Date.now() - lastCap >= 260) {
        const d = await full(video, o.size); lastCap = Date.now();
        if (d && d.descriptor) {
          if (got.length && dist(got[0], d.descriptor) > 0.45) got.length = 0;   // kadrda boshqa yuz — qaytadan
          got.push(d.descriptor);
        }
      }
      st(`Yuz o‘qilmoqda ${got.length}/${need}`, 'ok');
    }
    if (got.length >= need) {
      if (live) return { desc: mean(got), live: true, n: got.length };
      st('Ko‘zingizni qisib oching yoki boshingizni biroz buring', 'warn');
    }
    await frame();
  }
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
    if (r.detection.score < 0.6) { st('Yuz aniq emas — yorug‘roq joy kerak', 'warn'); okRun = 0; await frame(); continue; }
    if (w < 0.22) { st('Kameraga yaqinroq keling', 'warn'); okRun = 0; await frame(); continue; }
    if (w > 0.8) { st('Kameradan biroz uzoqlashing', 'warn'); okRun = 0; await frame(); continue; }
    if (!STAGES[stage][1](dy, side)) { st(STAGES[stage][0], 'warn'); okRun = 0; await frame(); continue; }
    okRun++;
    if (okRun >= 2 && Date.now() - lastCap > 500) {
      const d = await full(video, o.size || 320); lastCap = Date.now();
      if (d && d.descriptor) {
        if (out.length && dist(out[0], d.descriptor) > 0.55) { st('Kadrda boshqa odam — bitta odam bo‘lsin', 'warn'); okRun = 0; await frame(); continue; }
        out.push(d.descriptor); if (stage === 1) side = dy > 0 ? 1 : -1; stage++; okRun = 0;
        if (stage < STAGES.length) step();
      }
    }
    await frame();
  }
  return out;
}

window.FACE = { load, scan, enroll, enc, dec, dist, mean, supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };
})();
