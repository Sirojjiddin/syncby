(() => {
'use strict';
// 📋 Davomat (o'quv markaz): Transmitter paneli + Receiver belgilash oynasi. app.js bilan window.SC ko'prigi orqali ishlaydi.
const { S, send, toast, isHost, $, makeZip, xlsxToRows, unzipDocx, sNow } = window.SC;
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const D = { title: '', n: [], g: [], T: [], cfg: { open: false, show: true, photoReq: true, locReq: true, face: false, faceOnly: false, faceLive: true, faceLvl: 'normal', faceN: 0, lateMin: 0, radius: 150, center: null }, taken: new Set(), me: null,
  fm: { fid: [], fc: [], ph: [], pv: [] },
  rows: new Map(), st: null, c: null, filter: 'all', q: '', shown: 120 };
const WHY = { far: 'Juda uzoqda', warn: 'Radiusdan tashqarida', noloc: 'Joylashuv yo\'q', lowacc: 'GPS aniqligi past', dupphoto: 'Bir xil rasm', nophoto: 'Rasm yo\'q', nolive: 'Jonlilik tasdiqlanmadi' };
const pad = n => String(n).padStart(2, '0'), hms = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtD = d => d == null ? '—' : d < 1000 ? d + ' m' : (d / 1000).toFixed(1) + ' km';

// ---------------- Ism qidiruvi: kirill/lotin, apostrof, qo'sh harf, tartib va 1–2 harf xatoga chidamli ----------------
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h' };
const norm = s => String(s).toLowerCase().replace(/[\u0400-\u04ff]/g, c => (c in TR ? TR[c] : c)).replace(/[ʻʼ’'`‘´]/g, '').replace(/w/g, 'v').replace(/[^a-z0-9 ]+/g, ' ').replace(/(.)\1+/g, '$1').trim().split(/\s+/).filter(Boolean);
function lev(a, b, max) {                                  // chegaralangan Levenshtein
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; let mn = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < mn) mn = cur[j]; }
    if (mn > max) return max + 1; prev = cur; }
  return prev[b.length];
}
function search(q, limit = 20) {
  const qt = norm(q); if (!qt.length) return [];
  const out = [];
  for (let i = 0; i < D.T.length; i++) {
    const T = D.T[i]; let tot = 0;
    for (const w of qt) {
      let best = 0;
      for (const t of T) { if (t === w) { best = 4; break; } if (t.startsWith(w)) best = Math.max(best, 3); else if (w.length >= 4) { const e = lev(w, t.slice(0, w.length + 1), w.length >= 7 ? 2 : 1); if (e <= (w.length >= 7 ? 2 : 1)) best = Math.max(best, 1.5); } }
      if (!best) { tot = 0; break; } tot += best;
    }
    if (tot) out.push([tot - T.length * 0.01, i]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}

// ---------------- Kamera / GPS ----------------
const LOC_ERR = e => (e && e.code === 1 ? 'Joylashuvga ruxsat berilmagan. Brauzer manzil satridagi 🔒 belgisi yoki telefon sozlamalaridan ruxsat bering' : 'Joylashuv aniqlanmadi. GPS’ni yoqing, ochiq joyga chiqing va qayta urining');
// Joylashuv: avval yuqori aniqlik (GPS) bilan eng yaxshi o'lchov olinadi; 6 soniyada kelmasa — Wi-Fi/tarmoq bo'yicha (past aniqlik) zaxira
const getLoc = () => new Promise((res, rej) => {
  if (!navigator.geolocation) return rej(new Error('Bu qurilma joylashuvni bermaydi'));
  if (window.isSecureContext === false) return rej(new Error('Joylashuv uchun sahifa HTTPS (yoki localhost) orqali ochilishi kerak. http://192.168… manzilda brauzer GPS’ni bermaydi'));
  let best = null, fin = false, wid = null, t1 = 0, t2 = 0;
  const pack = p => ({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: sNow() });
  const done = (ok, v) => { if (fin) return; fin = true; clearTimeout(t1); clearTimeout(t2); if (wid != null) try { navigator.geolocation.clearWatch(wid); } catch {} ok ? res(v) : rej(v); };
  const low = () => navigator.geolocation.getCurrentPosition(p => done(true, pack(p)), e => done(false, new Error(LOC_ERR(e))), { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 });
  wid = navigator.geolocation.watchPosition(p => { if (!best || p.coords.accuracy < best.coords.accuracy) best = p; if (p.coords.accuracy <= 30) done(true, pack(p)); },
    e => { if (e.code === 1) done(false, new Error(LOC_ERR(e))); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  t1 = setTimeout(() => { if (fin) return; if (best) done(true, pack(best)); else low(); }, 6000);
  t2 = setTimeout(() => done(false, new Error(LOC_ERR())), 24000);
});
async function camStart(video, facing) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(window.isSecureContext === false ? 'Kamera uchun sahifa HTTPS (yoki localhost) orqali ochilishi kerak' : 'Bu brauzer kamerani qo‘llamaydi');
  video.hidden = false;                                    // display:none video ba'zi brauzerlarda kadr bermaydi (qora rasm)
  let st;
  try { st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing || 'user' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); }
  catch (e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') throw new Error('Kameraga ruxsat berilmagan. Brauzer sozlamasidan ruxsat bering');
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') throw new Error('Kamera topilmadi');
    if (n === 'NotReadableError' || n === 'TrackStartError') throw new Error('Kamera boshqa dastur tomonidan band. Uni yoping va qayta urining');
    st = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });   // cheklovlarsiz oxirgi urinish
  }
  video.srcObject = st; video.muted = true; video.playsInline = true; video.setAttribute('playsinline', ''); await video.play();
  for (let i = 0; i < 25 && !video.videoWidth; i++) await new Promise(r => setTimeout(r, 80));   // birinchi kadr kelguncha kutamiz
  return st;
}
const camStop = st => { if (st) st.getTracks().forEach(t => t.stop()); };
function snap(video) {                                      // jonli kadr → kichik JPEG; qora kadr rad etiladi
  const w = 360, h = Math.round(w * (video.videoHeight || 480) / (video.videoWidth || 640)), c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(video, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data; let s = 0, n = 0; for (let i = 0; i < d.length; i += 388) { s += d[i] + d[i + 1] + d[i + 2]; n += 3; }
  return s / n < 10 ? null : c.toDataURL('image/jpeg', 0.6);
}

// ---------------- RECEIVER ----------------
const R = {};
function buildRecv() {
  const box = document.createElement('div'); box.className = 'card att-recv'; box.hidden = true;
  box.innerHTML = `<h2>📋 Davomat</h2><p class="muted" id="arHint"></p><div id="arFace" hidden><select id="arG"></select><button class="primary wide" id="arFB">🙂 Yuz ID bilan belgilash</button><p class="muted center" id="arOr">yoki ismingizni qidiring</p></div><input id="arQ" placeholder="Ismingiz yoki familiyangiz…" autocomplete="off" autocapitalize="off"><div id="arRes" class="att-res"></div><div id="arDone" class="att-done" hidden></div>`;
  const rv = $('#recv'); rv.insertBefore(box, rv.firstChild);
  R.box = box; R.q = box.querySelector('#arQ'); R.res = box.querySelector('#arRes'); R.done = box.querySelector('#arDone'); R.hint = box.querySelector('#arHint'); R.fb = box.querySelector('#arFace'); R.g = box.querySelector('#arG'); R.or = box.querySelector('#arOr');
  R.g.onchange = () => { R.gv = R.g.value; };
  box.querySelector('#arFB').onclick = () => openFace();
  let t; R.q.oninput = () => { clearTimeout(t); t = setTimeout(recvList, 80); };
  R.res.onclick = e => { const b = e.target.closest('button[data-i]'); if (b && !b.disabled) openClaim(Number(b.dataset.i)); };
}
function recvList() {
  const ids = search(R.q.value, 12);
  R.res.innerHTML = ids.length ? ids.map(i => `<button class="att-pick" data-i="${i}" ${D.taken.has(i) ? 'disabled' : ''}><b>${esc(D.n[i])}</b><small>${esc(D.g[i])}${D.taken.has(i) ? ' · ✓ belgilangan' : ''}</small></button>`).join('')
    : (R.q.value.trim() ? '<p class="muted">Bunday ism topilmadi. Yozilishini tekshiring.</p>' : '');
}
function paintRecv() {
  if (!R.box) return;
  const done = D.me != null;
  const show = !isHost() && D.n.length && D.cfg.show !== false;      // Transmitter «Receiverlarda ko'rinsin»ni o'chirgan bo'lsa — yashirin (belgilanib bo'lgan receiver o'z natijasini ko'radi)
  R.box.hidden = !(show || (!isHost() && done)); if (R.box.hidden) return;
  const closed = !done && !D.cfg.open;
  const fOn = !done && !closed && D.cfg.face && D.cfg.faceN > 0 && window.FACE && window.FACE.supported(), nameOk = !(fOn && D.cfg.faceOnly);
  R.fb.hidden = !fOn; R.or.hidden = !(fOn && nameOk); if (fOn) fillGroups(R.g, true);
  R.done.hidden = !done; R.q.hidden = R.res.hidden = done || closed || !nameOk; R.hint.hidden = done;
  if (done) R.done.innerHTML = `✅ <b>${esc(D.n[D.me])}</b><br><small>Davomat belgilandi${D.meT ? ' · ' + hms(D.meT) : ''}</small>`;
  else if (closed) R.hint.textContent = '🔒 Davomat hozircha yopiq. Transmitter ochishi bilan shu yerda ismingizni belgilay olasiz.';
  else if (fOn && !nameOk) R.hint.textContent = 'Guruhingizni tanlang va yuzingizni skanerlang' + (D.cfg.locReq ? ' · joylashuv avtomatik olinadi' : '');
  else { R.hint.textContent = (fOn ? 'Yuz ID bilan yoki ismingizni toping: ' : 'Ismingizni toping va bosing') + (D.cfg.locReq ? ' · joylashuv' : '') + (D.cfg.photoReq ? ' va jonli rasm kerak bo‘ladi' : ''); recvList(); }
}
let modal = null;
async function openClaim(i) {
  if (modal) return;
  const el = document.createElement('div'); el.className = 'att-modal';
  el.innerHTML = `<div class="att-sheet"><h2>${esc(D.n[i])}</h2><small class="muted">${esc(D.g[i])}</small>
    <div class="att-steps"><div id="amLoc">📍 Joylashuv: aniqlanmoqda…</div>${D.cfg.photoReq ? '<div id="amCam">📸 Kamera: ishga tushmoqda…</div>' : ''}</div>
    ${D.cfg.photoReq ? '<video id="amVid" playsinline muted></video>' : ''}<p class="err" id="amErr" hidden></p>
    <div class="att-btns"><button class="primary" id="amGo" disabled>✅ Belgilash</button><button class="sec" id="amX">Bekor qilish</button></div></div>`;
  document.body.appendChild(el); modal = el;
  const q = s => el.querySelector(s); let stream = null, loc = null, locErr = '';
  const close = () => { camStop(stream); el.remove(); modal = null; };
  q('#amX').onclick = close;
  const setErr = t => { q('#amErr').hidden = !t; q('#amErr').textContent = t || ''; };
  const readyChk = () => { q('#amGo').disabled = (D.cfg.photoReq && !stream) || (D.cfg.locReq && !loc); };
  const doLoc = () => getLoc().then(l => { loc = l; locErr = ''; q('#amLoc').textContent = `📍 Joylashuv: aniqlandi (±${Math.round(l.acc)} m) ✓`; setErr(''); readyChk(); })
    .catch(e => { locErr = e.message; q('#amLoc').innerHTML = '📍 Joylashuv: xato · <a href="#" id="amRe">qayta urinish</a>'; setErr(e.message); const a = q('#amRe'); if (a) a.onclick = ev => { ev.preventDefault(); q('#amLoc').textContent = '📍 Joylashuv: aniqlanmoqda…'; doLoc(); }; if (!D.cfg.locReq) readyChk(); });
  doLoc();
  if (D.cfg.photoReq) camStart(q('#amVid'), 'user').then(s => { stream = s; q('#amCam').textContent = '📸 Kamera: tayyor ✓'; readyChk(); }).catch(e => { q('#amCam').textContent = '📸 Kamera: xato'; setErr(e.message || 'Kameraga ruxsat bering'); });
  q('#amGo').onclick = () => {
    let photo; if (D.cfg.photoReq) { photo = snap(q('#amVid')); if (!photo) return setErr('Kadr qorong‘i. Yoritilgan joyda yuzingizni ko‘rsating'); }
    q('#amGo').disabled = true; q('#amGo').textContent = 'Yuborilmoqda…';
    send({ type: 'att-claim', sid: i, loc: loc || undefined, photo });
    modal.onResult = ok => { if (ok) close(); else { q('#amGo').textContent = '✅ Belgilash'; readyChk(); } };
  };
}

// ---------------- Excel (.xlsx) yozish: ko'p varaqli, rangli, qotirilgan sarlavha ----------------
const X = t => String(t).replace(/[<>&"\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || ''));
const colL = i => { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - 1 - r) / 26; } return s; };
const H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', NSR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', NSP = 'http://schemas.openxmlformats.org/package/2006/relationships';
const STYLES = H + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' + ['FF2A49B8', 'FFC6EFCE', 'FFFFC7CE', 'FFFFEB9C', 'FFEEF1FB'].map(c => `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('') + '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7">' +
  [[0, 0], [1, 2], [0, 3], [0, 4], [0, 5], [2, 0], [2, 6]].map(([f, l]) => `<xf numFmtId="0" fontId="${f}" fillId="${l}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`).join('') + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
// stil: 1 sarlavha · 2 yashil · 3 qizil · 4 sariq · 5 qalin · 6 qalin+kulrang
function xlsxBlob(sheets) {
  const sh = sheets.map((s, k) => {
    const w = s.widths || [];
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((c, ci) => {
      const o = c && typeof c === 'object' ? c : { v: c }, ref = colL(ci) + (ri + 1), st = ri === 0 && s.head !== false ? 1 : (o.s || 0), a = st ? ` s="${st}"` : '';
      if (o.v === '' || o.v == null) return st ? `<c r="${ref}"${a}/>` : '';
      return typeof o.v === 'number' ? `<c r="${ref}"${a}><v>${o.v}</v></c>` : `<c r="${ref}"${a} t="inlineStr"><is><t xml:space="preserve">${X(o.v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const last = colL(Math.max(0, (s.rows[0] || ['']).length - 1)) + s.rows.length;
    return H + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"' + (k === 0 ? ' tabSelected="1"' : '') + '>' + (s.head !== false ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '') + '</sheetView></sheetViews>' +
      (w.length ? '<cols>' + w.map((x, i) => `<col min="${i + 1}" max="${i + 1}" width="${x}" customWidth="1"/>`).join('') + '</cols>' : '') + `<sheetData>${rows}</sheetData>` + (s.filter ? `<autoFilter ref="A1:${last}"/>` : '') + '</worksheet>';
  });
  const files = [
    ['[Content_Types].xml', H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', H + `<Relationships xmlns="${NSP}"><Relationship Id="rId1" Type="${NSR}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', H + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NSR}"><sheets>` + sheets.map((s, k) => `<sheet name="${X(s.name).slice(0, 31)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', H + `<Relationships xmlns="${NSP}">` + sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="${NSR}/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="${NSR}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES], ...sh.map((x, k) => [`xl/worksheets/sheet${k + 1}.xml`, x]),
  ];
  return makeZip(files, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const csvBlob = rows => new Blob(['\ufeff' + rows.map(r => r.map(c => { c = c == null ? '' : String(c); return /[",;\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
window.SC.xlsxBlob = xlsxBlob; window.SC.csvBlob = csvBlob; window.SC.saveBlob = save;   // 📝 Uyga vazifa natijalarini Excel'ga yozish uchun

// ---------------- Hisobot ma'lumotlari ----------------
const stName = r => !r ? 'Kelmadi' : r[1] === 'l' ? 'Kech keldi' : 'Keldi';
const via = r => r ? (r[3] === 'self' ? 'O‘zi belgiladi' : r[3] === 'face' ? 'Yuz ID (qo‘lda)' : r[3] === 'fid' ? 'Yuz ID (avto)' : 'Transmitter') : '';
const clsT = r => !r ? '' : ({ ok: 'Radius ichida', warn: 'Ogohlantirish', far: 'Uzoqda', noloc: 'Joylashuv yo‘q', na: '—' }[r[9]] || '');
const whyT = r => r && r[7] ? r[7].split(',').map(k => WHY[k] || k).join('; ') : '';
const title = () => (D.title || 'Davomat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function sheetAll() {
  const rows = [['№', 'F.I.Sh', 'Guruh', 'Holat', 'Vaqt', 'Usul', 'Masofa (m)', 'Joylashuv', 'Xavf (ball)', 'Izoh']];
  D.n.forEach((n, i) => { const r = D.rows.get(i); rows.push([i + 1, n, D.g[i], { v: stName(r), s: !r ? 3 : r[1] === 'l' ? 4 : 2 }, r ? hms(r[2]) : '', via(r), r && r[4] != null ? r[4] : '', { v: clsT(r), s: r && r[9] === 'warn' ? 4 : r && (r[9] === 'far' || r[9] === 'noloc') ? 3 : 0 }, r ? r[6] : '', whyT(r)]); });
  return { name: 'Davomat', rows, widths: [6, 34, 14, 14, 11, 16, 12, 16, 11, 40], filter: true };
}
function groupStats() { const m = new Map(); D.n.forEach((_, i) => { const g = D.g[i] || '—', o = m.get(g) || { t: 0, p: 0, l: 0 }, r = D.rows.get(i); o.t++; if (r) r[1] === 'l' ? o.l++ : o.p++; m.set(g, o); }); return m; }
function sheetStat() {
  const st = D.st || {}, tot = D.n.length, came = (st.p || 0) + (st.l || 0);
  const rows = [['Ko‘rsatkich', 'Qiymat'], [{ v: 'Dars', s: 5 }, D.title || '—'], [{ v: 'Sana', s: 5 }, stamp()], ['Jami o‘quvchi', tot], ['Keldi (vaqtida)', st.p || 0], ['Kech keldi', st.l || 0], ['Kelmadi', tot - came], ['Davomat foizi', tot ? Math.round(came / tot * 1000) / 10 + '%' : '0%'],
    ['Ogohlantirish (radiusdan tashqari)', st.warn || 0], ['Uzoqda', st.far || 0], ['Joylashuvsiz', st.noloc || 0], ['Shubhali (xavf ≥ 60)', st.sus || 0], [], [{ v: 'Guruh', s: 6 }, { v: 'Jami', s: 6 }, { v: 'Keldi', s: 6 }, { v: 'Kech', s: 6 }, { v: 'Kelmadi', s: 6 }, { v: 'Foiz', s: 6 }]];
  groupStats().forEach((o, g) => rows.push([g, o.t, o.p, o.l, o.t - o.p - o.l, o.t ? Math.round((o.p + o.l) / o.t * 1000) / 10 + '%' : '0%']));
  return { name: 'Statistika', rows, widths: [38, 18, 10, 10, 10, 10] };
}
function sheetWarn() {
  const rows = [['F.I.Sh', 'Guruh', 'Holat', 'Masofa (m)', 'GPS aniqligi (m)', 'Sabab', 'Xavf (ball)', 'Kenglik', 'Uzunlik', 'Vaqt']];
  const list = [...D.rows.entries()].filter(([, r]) => r[9] === 'warn' || r[9] === 'far' || r[9] === 'noloc' || r[6] >= 30).sort((a, b) => (b[1][4] || 1e9) - (a[1][4] || 1e9));
  list.forEach(([i, r]) => rows.push([D.n[i], D.g[i], { v: r[9] === 'far' ? 'UZOQDA' : r[9] === 'warn' ? 'Ogohlantirish' : r[9] === 'noloc' ? 'Joylashuv yo‘q' : 'Shubhali', s: r[9] === 'warn' ? 4 : 3 }, r[4] == null ? '' : r[4], r[5] == null ? '' : r[5], whyT(r), r[6], r[10] == null ? '' : r[10], r[11] == null ? '' : r[11], hms(r[2])]));
  return { name: 'Uzoqdagilar', rows, widths: [34, 14, 16, 12, 16, 40, 11, 12, 12, 11] };
}
function sheetFace() {
  const rows = [['F.I.Sh', 'Guruh', 'Face ID', 'Vaqt', 'Holat', 'Usul', 'Ishonch (%)', 'Yuz rasmi']];
  [...D.rows.entries()].filter(([, r]) => r[3] === 'face' || r[3] === 'fid').sort((a, b) => a[1][2] - b[1][2]).forEach(([i, r]) => rows.push([D.n[i], D.g[i], D.fm.fid[i] || '', hms(r[2]), { v: stName(r), s: r[1] === 'l' ? 4 : 2 }, via(r), r[12] != null ? r[12] : '', r[8] ? 'Saqlangan' : '—']));
  return { name: 'Yuz ID', rows, widths: [34, 14, 10, 11, 14, 16, 12, 14] };
}
const need = () => { if (!D.n.length) { toast('Avval o‘quvchilar ro‘yxatini yuklang'); return false; } return true; };
const dl = {
  full: () => need() && save(xlsxBlob([sheetAll(), sheetStat(), sheetWarn(), sheetFace()]), `davomat-${title()}-${stamp()}.xlsx`),
  absent: () => { if (!need()) return; const rows = [['№', 'F.I.Sh', 'Guruh']]; D.n.forEach((n, i) => { if (!D.rows.has(i)) rows.push([rows.length, n, D.g[i]]); }); save(csvBlob(rows), `kelmaganlar-${title()}-${stamp()}.csv`); },
  warn: () => need() && save(xlsxBlob([sheetWarn()]), `uzoqdagilar-${title()}-${stamp()}.xlsx`),
  face: () => need() && save(xlsxBlob([sheetFace()]), `yuz-id-${title()}-${stamp()}.xlsx`),
  roster: async () => {                                  // Ism, telefon, guruh, davomat tarixi, Face ID va yuz kodlari — keyingi safar shu faylni yuklash kifoya
    if (!need()) return;
    try {
      const r = await fetch(`/api/rooms/${S.code}/att/faces?key=${encodeURIComponent(S.key)}`), j = await r.json(), d = new Date(), dd = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
      const rows = [['№', 'F.I.Sh', 'Telefon', 'Guruh', 'Davomat', 'Face ID', 'Face kod']];
      D.n.forEach((n, i) => {
        const r0 = D.rows.get(i); let h = (D.fm.pv[i] || '').split(' ').filter(x => x && !x.startsWith(dd + ':')).join(' ');
        if (D.rows.size) h = (h ? h + ' ' : '') + dd + ':' + (!r0 ? '-' : r0[1] === 'l' ? 'kech' : '+');
        rows.push([i + 1, n, D.fm.ph[i] || '', D.g[i], h, D.fm.fid[i] || '', ((j.faces || [])[i] || []).join('|')]);
      });
      save(xlsxBlob([{ name: 'O\'quvchilar', rows, widths: [6, 34, 18, 14, 44, 10, 28], filter: true }]), `oquvchilar-face-id-${title()}-${stamp()}.xlsx`);
      toast('💾 Saqlandi. Keyingi safar shu faylni yuklasangiz, yuzlarni qayta kiritish shart emas', 6000);
    } catch { toast('Saqlab bo‘lmadi', 4000); }
  },
  csv: () => { if (!need()) return; const a = sheetAll().rows.map(r => r.map(c => (c && typeof c === 'object' ? c.v : c))); save(csvBlob(a), `davomat-${title()}-${stamp()}.csv`); },
};
function templates(kind) {
  const ex = [['1', 'Valiyev Ali', '9-A', '+998901234567', '', '', ''], ['2', 'Karimova Gulnora', '9-A', '', '', '', ''], ['3', 'Tursunov Sardor', '9-B', '', '', '', '']], hd = ['№', 'F.I.Sh', 'Guruh', 'Telefon', 'Davomat', 'Face ID', 'Face kod'];
  if (kind === 'csv') return save(csvBlob([hd, ...ex]), 'oquvchilar-shablon.csv');
  save(xlsxBlob([{ name: 'O\'quvchilar', rows: [hd, ...ex.map(r => [Number(r[0]), r[1], r[2], r[3], r[4], r[5], r[6]])], widths: [6, 34, 14, 20, 30, 10, 28] }]), 'oquvchilar-shablon.xlsx');
}

// ---------------- Ro'yxatni o'qish: Excel / CSV / Word ----------------
function csvRows(text) {
  const first = text.split(/\r?\n/, 1)[0], delim = [';', '\t', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); } return rows;
}
async function docxRows(f) {
  const files = await unzipDocx(await f.arrayBuffer()), u = files.get('word/document.xml'); if (!u) throw new Error('docx');
  const d = new DOMParser().parseFromString(new TextDecoder().decode(u), 'application/xml'), W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const txt = el => [...el.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join(''), trs = d.getElementsByTagNameNS(W, 'tr'), rows = [];
  if (trs.length) { for (const tr of trs) rows.push([...tr.getElementsByTagNameNS(W, 'tc')].map(txt)); return rows; }
  for (const p of d.getElementsByTagNameNS(W, 'p')) { const t = txt(p).trim(); if (t) rows.push([t]); } return rows;
}
function toStudents(rows) {
  rows = rows.filter(r => r && r.some(c => String(c || '').trim()));
  if (!rows.length) return [];
  const lc = rows[0].map(x => String(x || '').toLowerCase());
  let ni = lc.findIndex(c => /f\.?\s?i\.?\s?o?\.?\s?sh|^ism|familiya|name|o.quvchi|talaba|fio|фио|имя/.test(c)), gi = lc.findIndex(c => /guruh|group|sinf|kurs|груп/.test(c)), start = 0,
    col = re => (rows[0] ? lc.findIndex(c => re.test(c)) : -1), pi = col(/telefon|tel\b|raqam|phone|тел/), vi = col(/davomat|attendance|посещ/), fi = col(/face\s*id|yuz\s*id|^fid$/), ci = col(/face\s*(kod|code)|yuz\s*kod/);
  if (ni >= 0) start = 1;
  else { const smp = rows.slice(0, 6); const w = Math.max(...rows.slice(0, 6).map(r => r.length)); let best = -1, sc = -1;
    for (let c = 0; c < w; c++) { const s = smp.filter(r => /[A-Za-z\u0400-\u04ff]{3,}/.test(String(r[c] || '')) && !/^\d/.test(String(r[c] || '').trim()) || /^\d+[.)]\s*[A-Za-z\u0400-\u04ff]/.test(String(r[c] || ''))).length; if (s > sc) { sc = s; best = c; } } ni = Math.max(0, best); }
  const out = [];
  for (let k = start; k < rows.length; k++) {
    const r = rows[k], n = String(r[ni] || '').replace(/^\s*\d+\s*[.)\-]\s*/, '').replace(/\s+/g, ' ').trim();
    if (n.length < 3 || /^[\d\s.,+\-]+$/.test(n)) continue;
    const cell = c => (c >= 0 && r[c] != null ? String(r[c]).trim() : '');
    out.push({ n: n.slice(0, 60), g: cell(gi).slice(0, 30), p: cell(pi).slice(0, 24), v: cell(vi), f: cell(fi).slice(0, 16), c: cell(ci) });
  }
  return out;
}
async function loadFile(f) {
  const err = $('#atErr'); err.hidden = true;
  try {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const rows = ext === 'xlsx' ? (await xlsxToRows(f)).map(r => Array.from(r)) : ext === 'docx' ? await docxRows(f) : csvRows(await f.text());
    const students = toStudents(rows);
    if (!students.length) throw new Error('empty');
    $('#atInfo').textContent = `Yuklanmoqda: ${students.length} ta…`;
    const r = await fetch(`/api/rooms/${S.code}/att/load?key=${encodeURIComponent(S.key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('#atTitle').value, students }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'server');
    D.tpl = f; paintTpl();
    toast(`✅ ${j.count} ta o‘quvchi yuklandi` + (j.faces ? ` · 🙂 ${j.faces} tasining Face ID si bor` : '') + (j.badFaces ? ` · ⚠ ${j.badFaces} ta yuz kodi buzilgan` : ''), 5000);
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message === 'nodecomp' ? 'Bu brauzer .xlsx/.docx ni o‘qiy olmaydi. CSV yuklang.' : e.message === 'empty' ? 'F.I.Sh ustuni topilmadi. Shablondan foydalaning (⬇ tugma).' : 'Faylni o‘qib bo‘lmadi. Shablondan foydalaning (⬇ tugma).';
    $('#atInfo').textContent = D.n.length ? `${D.n.length} ta o‘quvchi` : 'Ro‘yxat yuklanmagan';
  }
}


// ---------------- Shablon fayl bo'yicha hisobot: kelganlarga «+», kelmaganlarga «-» ----------------
// Foydalanuvchining o'z fayli (Excel / CSV / Word) asl ko'rinishi saqlangan holda to'ldiriladi: ismlar yonida +/- paydo bo'ladi.
const keyOf = t => norm(t).sort().join(' ');
const todayStr = () => { const d = new Date(); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const looksName = t => { t = String(t || '').trim(); return t.length >= 5 && t.length <= 70 && /[A-Za-z\u0400-\u04ff]{2}/.test(t) && norm(t).length >= 2; };
let fz = 0;
function findStudent(txt, km) {
  const clean = String(txt == null ? '' : txt).replace(/^\s*\d+\s*[.)\-]\s*/, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 3 || clean.length > 70 || !/[A-Za-z\u0400-\u04ff]/.test(clean)) return -1;
  const qt = norm(clean); if (!qt.length) return -1;
  const k = qt.slice().sort().join(' ');
  if (km.has(k)) return km.get(k);                          // aynan shu ism (so'zlar tartibi farq qilmaydi)
  if (qt.length < 2 || fz <= 0) return -1;
  fz--;
  const c = search(clean, 3);                               // 1–2 harf xato / qisqartirilgan yozuv
  if (c.length === 1) return c[0];
  const rev = [];                                           // faylda ortiqcha so'z bor (otasining ismi): ro'yxatdagi ismning hamma so'zi fayl nomida topiladi
  for (let i = 0; i < D.T.length && rev.length < 3; i++) { const T = D.T[i]; if (T.length >= 2 && T.every(t => qt.some(w => w === t || (w.length >= 4 && lev(w, t, 1) <= 1)))) rev.push(i); }
  return rev.length === 1 ? rev[0] : -1;
}
const DATE_H = /^\s*\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?\s*$/, KEY_H = /davomat|sana|\bkun\b|dars|date|attend|посещ|дата/i;
function planFill(grid) {                                   // grid[qator][ustun] = matn; qaysi ustunda ismlar, qaysi ustunga yozish — aniqlanadi
  const km = new Map(); D.n.forEach((n, i) => { const k = keyOf(n); if (k && !km.has(k)) km.set(k, i); });
  fz = 900;
  const hit = new Map(), cnt = new Map();
  for (let r = 0; r < grid.length; r++) { const row = grid[r]; for (let c = 0; c < row.length; c++) { const t = row[c]; if (!t) continue; const i = findStudent(t, km); if (i >= 0) { hit.set(r * 1000 + c, i); cnt.set(c, (cnt.get(c) || 0) + 1); } } }
  let nameCol = -1, best = 0; cnt.forEach((v, c) => { if (v > best) { best = v; nameCol = c; } });
  if (nameCol < 0) throw new Error('noname');
  const marks = []; let first = -1, unk = 0, plus = 0, minus = 0;
  for (let r = 0; r < grid.length; r++) {
    const i = hit.get(r * 1000 + nameCol);
    if (i == null) { if (first >= 0 && looksName(grid[r][nameCol])) unk++; continue; }
    if (first < 0) first = r;
    const ok = D.rows.has(i); marks.push([r, ok ? '+' : '-']); ok ? plus++ : minus++;
  }
  const hdr = first > 0 && grid[first - 1] ? first - 1 : -1;
  let maxC = 0; grid.forEach(row => { if (row.length - 1 > maxC) maxC = row.length - 1; });
  let col = -1;                                             // tayyor bo'sh ustun (sarlavhasi bo'sh yoki sana/«davomat») bo'lsa — shuni ishlatamiz, bo'lmasa o'ngga yangi ustun
  for (let c = nameCol + 1; c <= maxC && col < 0; c++) {
    const h = hdr >= 0 ? String(grid[hdr][c] || '').trim() : '';
    if ((!h || DATE_H.test(h) || KEY_H.test(h)) && marks.every(([r]) => !String(grid[r][c] || '').trim())) col = c;
  }
  const newCol = col < 0; if (newCol) col = maxC + 1;
  const hh = hdr >= 0 && !String(grid[hdr][col] || '').trim() ? todayStr() : null;
  return { nameCol, col, newCol, hdr, hh, marks, plus, minus, unk };
}
// ZIP: faqat o'zgargan yozuvlar almashtiriladi, qolganlari (rasm, uslub, formulalar…) asl holida ko'chiriladi
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
async function deflateRaw(u8) { try { if (typeof CompressionStream === 'undefined') return null; return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); } catch { return null; } }
async function patchZip(buf, repl, type) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder(), enc = new TextEncoder();
  let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip');
  const n = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
  const parts = [], cen = []; let pos = 0;
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('zip');
    const flags = dv.getUint16(off + 8, true) & 0x0800, time = dv.getUint16(off + 12, true), date = dv.getUint16(off + 14, true);
    let method = dv.getUint16(off + 10, true), crc = dv.getUint32(off + 16, true), cs = dv.getUint32(off + 20, true), us = dv.getUint32(off + 24, true);
    const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true), ext = dv.getUint32(off + 38, true), lho = dv.getUint32(off + 42, true);
    const nb = u8.slice(off + 46, off + 46 + nlen), name = dec.decode(nb);
    off += 46 + nlen + elen + clen;
    if (cs === 0xFFFFFFFF || us === 0xFFFFFFFF || lho === 0xFFFFFFFF) throw new Error('zip64');
    let data;
    if (repl.has(name)) { const raw = repl.get(name), z = await deflateRaw(raw); crc = crc32(raw); us = raw.length; if (z && z.length < raw.length) { data = z; method = 8; } else { data = raw; method = 0; } cs = data.length; }
    else { const st = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true); data = u8.subarray(st, st + cs); }
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, flags, true); lh.setUint16(8, method, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, cs, true); lh.setUint32(22, us, true); lh.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, flags, true); ch.setUint16(10, method, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, cs, true); ch.setUint32(24, us, true); ch.setUint16(28, nb.length, true); ch.setUint32(38, ext, true); ch.setUint32(42, pos, true);
    cen.push(new Uint8Array(ch.buffer), nb);
    pos += 30 + nb.length + data.length;
  }
  const csz = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true); e.setUint16(10, n, true); e.setUint32(12, csz, true); e.setUint32(16, pos, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type });
}
const XML_H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const serial = doc => { const x = new XMLSerializer().serializeToString(doc); return new TextEncoder().encode(/^<\?xml/.test(x) ? x : XML_H + '\r\n' + x); };
const colOf = ref => String(ref || '').replace(/\d+/g, '').split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const MIME_X = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', MIME_D = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function fillXlsx(f) {
  if (typeof DecompressionStream === 'undefined') throw new Error('nodecomp');
  const buf = await f.arrayBuffer();
  const files = await unzipDocx(buf, n => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const dec = new TextDecoder(), P = n => { const u = files.get(n); return u ? new DOMParser().parseFromString(dec.decode(u), 'application/xml') : null; };
  const ss = [], sx = P('xl/sharedStrings.xml');
  if (sx) for (const si of sx.getElementsByTagName('si')) ss.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  const rid = new Map(), wb = P('xl/workbook.xml'), rl = P('xl/_rels/workbook.xml.rels');
  if (rl) for (const r of rl.getElementsByTagName('Relationship')) rid.set(r.getAttribute('Id'), r.getAttribute('Target'));
  let paths = [];
  if (wb) for (const sh of wb.getElementsByTagName('sheet')) { let t = rid.get(sh.getAttribute('r:id')); if (t) { t = t.replace(/^\//, ''); paths.push(t.startsWith('xl/') ? t : 'xl/' + t); } }
  paths = paths.filter(x => files.has(x));
  if (!paths.length) paths = [...files.keys()].filter(n => /^xl\/worksheets\//.test(n)).sort();
  if (!paths.length) throw new Error('sheet');
  const text = c => { const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]; if (t === 's') return ss[Number(v && v.textContent)] || ''; if (t === 'inlineStr') return [...c.getElementsByTagName('t')].map(x => x.textContent).join(''); return v ? v.textContent : ''; };
  let pick = null;
  for (const path of paths) {                              // eng ko'p ism topilgan varaq tanlanadi
    const doc = P(path), sd = doc && doc.getElementsByTagName('sheetData')[0]; if (!sd) continue;
    const rowEls = [...sd.childNodes].filter(n => n.localName === 'row');
    const grid = rowEls.map(re => { const a = []; for (const c of re.getElementsByTagName('c')) { const ci = colOf(c.getAttribute('r')); a[ci >= 0 ? ci : a.length] = text(c); } return a; });
    let pl; try { pl = planFill(grid); } catch { continue; }
    if (!pick || pl.marks.length > pick.pl.marks.length) pick = { path, doc, rowEls, pl };
  }
  if (!pick) throw new Error('noname');
  const { path, doc, rowEls, pl } = pick, ns = doc.documentElement.namespaceURI;
  const setCell = (re, ci, txt) => {
    const rn = re.getAttribute('r') || String(rowEls.indexOf(re) + 1);
    let cell = null, before = null, from = null;
    for (const c of re.getElementsByTagName('c')) { const k = colOf(c.getAttribute('r')); if (k === ci) { cell = c; break; } if (k < ci) from = c; else if (!before) before = c; }
    if (!cell) { cell = doc.createElementNS(ns, 'c'); cell.setAttribute('r', colL(ci) + rn); const sm = from && from.getAttribute('s'); if (sm) cell.setAttribute('s', sm); re.insertBefore(cell, before); }
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.setAttribute('t', 'inlineStr'); cell.removeAttribute('cm'); cell.removeAttribute('vm');
    const is = doc.createElementNS(ns, 'is'), t = doc.createElementNS(ns, 't'); t.textContent = txt; is.appendChild(t); cell.appendChild(is);
    re.removeAttribute('spans');
  };
  pl.marks.forEach(([r, t]) => setCell(rowEls[r], pl.col, t));
  if (pl.hh && pl.hdr >= 0) setCell(rowEls[pl.hdr], pl.col, pl.hh);
  const dim = doc.getElementsByTagName('dimension')[0];
  if (dim) { const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(dim.getAttribute('ref') || ''); if (m) { const c2 = Math.max(colOf(m[3] || m[1]), pl.col); dim.setAttribute('ref', `${m[1]}${m[2]}:${colL(c2)}${m[4] || m[2]}`); } }
  const blob = await patchZip(buf, new Map([[path, serial(doc)]]), MIME_X);
  return { blob, info: pl };
}
async function fillDocx(f) {
  if (typeof DecompressionStream === 'undefined') throw new Error('nodecomp');
  const buf = await f.arrayBuffer(), files = await unzipDocx(buf, n => n === 'word/document.xml'), dx = files.get('word/document.xml');
  if (!dx) throw new Error('docx');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', doc = new DOMParser().parseFromString(new TextDecoder().decode(dx), 'application/xml');
  const kids = (el, nm) => [...el.childNodes].filter(n => n.localName === nm && n.namespaceURI === W);
  const txt = el => [...el.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('');
  const mkRun = (rpr, t) => { const r = doc.createElementNS(W, 'w:r'); if (rpr) r.appendChild(rpr.cloneNode(true)); const e = doc.createElementNS(W, 'w:t'); e.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); e.textContent = t; r.appendChild(e); return r; };
  const setTc = (tc, t) => {
    let p = kids(tc, 'p')[0]; if (!p) { p = doc.createElementNS(W, 'w:p'); tc.appendChild(p); }
    const r0 = kids(p, 'r')[0], rpr = r0 && kids(r0, 'rPr')[0];
    [...p.childNodes].forEach(n => { if (n.localName !== 'pPr') p.removeChild(n); });
    kids(tc, 'p').forEach(n => { if (n !== p) tc.removeChild(n); });
    p.appendChild(mkRun(rpr, t));
  };
  let pick = null;
  for (const tb of doc.getElementsByTagNameNS(W, 'tbl')) {
    const trs = kids(tb, 'tr'), tcs = trs.map(tr => kids(tr, 'tc')), grid = tcs.map(cells => cells.map(txt));
    let pl; try { pl = planFill(grid); } catch { continue; }
    if (!pick || pl.marks.length > pick.pl.marks.length) pick = { tb, trs, tcs, pl };
  }
  let info;
  if (pick) {
    const { tb, trs, tcs, pl } = pick; info = pl;
    const put = (r, t) => {
      const cells = tcs[r];
      if (cells[pl.col]) setTc(cells[pl.col], t);
      else if (cells.length === pl.col && cells.length) { const nc = cells[cells.length - 1].cloneNode(true); trs[r].appendChild(nc); cells.push(nc); setTc(nc, t); }
    };
    pl.marks.forEach(([r, t]) => put(r, t)); if (pl.hh && pl.hdr >= 0) put(pl.hdr, pl.hh);
    if (pl.newCol) { const g = kids(tb, 'tblGrid')[0], gc = g && kids(g, 'gridCol'); if (gc && gc.length) g.appendChild(gc[gc.length - 1].cloneNode(true)); }
  } else {                                                  // jadval yo'q: har bir ism yozilgan abzas oxiga «+» / «-»
    const ps = [...doc.getElementsByTagNameNS(W, 'p')], grid = ps.map(p => [txt(p)]), pl = planFill(grid); info = pl;
    pl.marks.forEach(([r, t]) => { const p = ps[r], r0 = kids(p, 'r')[0]; p.appendChild(mkRun(r0 && kids(r0, 'rPr')[0], '   ' + t)); });
  }
  const blob = await patchZip(buf, new Map([['word/document.xml', serial(doc)]]), MIME_D);
  return { blob, info };
}
async function fillCsvT(f) {
  let text = await f.text(); if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0], delim = [';', '\t', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = csvRows(text).map(r => r.slice()), pl = planFill(rows);
  rows.forEach(r => { if (r.some(c => String(c || '').trim())) while (r.length <= pl.col) r.push(''); });
  pl.marks.forEach(([r, t]) => { rows[r][pl.col] = t; }); if (pl.hh && pl.hdr >= 0) rows[pl.hdr][pl.col] = pl.hh;
  const q = c => { c = c == null ? '' : String(c); return c.includes(delim) || /["\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; };
  return { blob: new Blob(['\ufeff' + rows.map(r => r.map(q).join(delim)).join('\r\n')], { type: 'text/csv;charset=utf-8' }), info: pl };
}
async function fillTemplate(f) {
  const err = $('#tplErr'); if (err) err.hidden = true;
  if (!need()) return;
  try {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xls' || ext === 'doc' || ext === 'ods') throw new Error('old');
    const r = ext === 'xlsx' ? await fillXlsx(f) : ext === 'docx' ? await fillDocx(f) : await fillCsvT(f), info = r.info;
    D.tpl = f; paintTpl();
    save(r.blob, `${f.name.replace(/\.[^.]+$/, '')}-davomat-${stamp()}.${ext === 'txt' || ext === 'tsv' ? 'csv' : ext}`);
    toast(`✅ Tayyor: ${info.plus} ta «+», ${info.minus} ta «-»` + (info.unk ? ` · ${info.unk} ta ism ro‘yxatda topilmadi (bo‘sh qoldi)` : ''), 7000);
  } catch (e) {
    if (!err) return toast(e.message, 5000);
    err.hidden = false;
    err.textContent = e.message === 'noname' ? 'Faylda yuklangan ro‘yxatdagi ismlar topilmadi. Fayldagi F.I.Sh ustuni bilan ro‘yxat bir xil odamlardan iborat bo‘lsin.'
      : e.message === 'old' ? 'Eski format (.xls / .doc). Faylni Excel/Word’da «Saqlash → .xlsx / .docx» qilib qayta yuklang.'
      : e.message === 'nodecomp' ? 'Bu brauzer .xlsx/.docx ni o‘qiy olmaydi. CSV yuklang yoki Chrome/Edge ishlating.'
      : 'Faylni to‘ldirib bo‘lmadi. Fayl shikastlanmaganini tekshiring (parol bilan himoyalangan bo‘lmasin).';
  }
}
function paintTpl() { const b = $('#tplRe'); if (!b) return; b.hidden = !D.tpl; if (D.tpl) b.textContent = '↻ «' + D.tpl.name.slice(0, 28) + '» fayliga yozish'; }

// ---------------- TRANSMITTER paneli ----------------
const P = {};
const sw = (id, t, s) => `<label class="sw"><span><b>${t}</b><small>${s}</small></span><input type="checkbox" class="tg" id="${id}"></label>`;
function buildHost() {
  const root = $('#tabAtt'); if (!root) return;
  root.innerHTML = `
  <div class="card att-card"><h2>📋 Davomat</h2>
    <label>Dars / guruh nomi</label><input id="atTitle" maxlength="80" placeholder="Masalan: Matematika · 9-sinf">
    <div class="att-row"><button class="sec" id="atTx">⬇ Shablon (Excel)</button><button class="sec" id="atTc">⬇ Shablon (CSV)</button>
      <label class="att-up" id="atDrop"><input type="file" id="atFile" accept=".xlsx,.csv,.tsv,.txt,.docx" hidden>📂 Ro‘yxat yuklash (Excel · CSV · Word)</label></div>
    <p class="muted" id="atInfo">Ro‘yxat yuklanmagan. Shablonni yuklab oling, F.I.Sh va guruhni to‘ldiring.</p><p class="err" id="atErr" hidden></p></div>
  <div class="card" id="atSet" hidden><h2>⚙ Sozlamalar</h2>
    ${sw('atOpen', '🟢 Davomat ochiq', 'Receiverlar o‘z ismini belgilay oladi')}${sw('atShow', '👁 Receiverlarda ko‘rinsin', 'Yoniq: receiverlar davomat oynasini ko‘radi. O‘chiq: oyna yashiriladi va ismlar ularga yuborilmaydi')}${sw('atPh', '📸 Jonli rasm majburiy', 'Faqat kameradan olingan kadr (galereya yo‘q)')}
    ${sw('atLoc', '📍 Joylashuv majburiy', 'GPS qurilmadan olinadi, qo‘lda o‘zgartirib bo‘lmaydi')}${sw('atFaceOn', '🙂 Yuz ID rejimi', 'Receiver yuzini skanerlaydi — tizim ism-familiyani o‘zi topadi, o‘quvchi tasdiqlaydi')}${sw('atFaceOnly', '🔒 Faqat Yuz ID orqali', 'Ismni qo‘lda tanlash o‘chadi: birovning o‘rniga belgilab bo‘lmaydi')}${sw('atFaceLive', '👁 Jonlilik tekshiruvi', 'Ko‘z qisish yoki bosh burish talab qilinadi (rasm ko‘rsatib aldashni qiyinlashtiradi)')}
    <label>Yuz tanish aniqligi</label><select id="atFaceLvl"><option value="strict">Qat’iy — xato deyarli yo‘q, ba’zan qayta urinadi</option><option value="normal">Me’yoriy (tavsiya)</option><option value="soft">Yumshoq — tez, lekin o‘xshash yuzlarda xavfliroq</option></select>
    <div class="att-row"><div><label>Radius (m)</label><input id="atRad" type="number" min="20" max="50000" value="150"></div><div><label>Kechikish (daq, 0 = o‘chiq)</label><input id="atLate" type="number" min="0" max="600" value="0"></div></div>
    <div class="att-row"><button class="sec" id="atCen">📍 Markazni GPS bilan belgilash</button><button class="sec" id="atCenX" hidden>✕ Markazni olib tashlash</button><button class="link danger" id="atClear">🔄 Yangi davomat (tozalash)</button></div>
    <p class="muted" id="atCenInfo"></p></div>
  <div class="card" id="atFace" hidden><h2>🙂 Yuz ID</h2><p class="muted" id="afStat"></p>
    <p class="muted"><b>1.</b> Har bir o‘quvchining yuzini bir marta kiriting (5 kadr, 10 soniya). <b>2.</b> Davomat paytida receiver yuzini skanerlaydi — ism va joylashuv avtomatik chiqadi. <b>3.</b> Yuz kodlarini Excelga saqlang — keyingi safar qayta kiritish shart emas.</p>
    <video id="afVid" playsinline muted hidden></video><div class="att-row"><button class="sec" id="afCam">📷 Kamerani yoqish</button><button class="sec" id="afFlip" hidden>🔄 Old / orqa kamera</button></div><p class="fst" id="afInfo"></p>
    <h3>1. Yuzni ro‘yxatga olish</h3>
    <input id="afQ" placeholder="O‘quvchi ismini qidiring…" autocomplete="off"><div id="afRes" class="att-res"></div><span id="afSel" class="muted">Ism tanlanmagan</span>
    <button class="primary wide" id="afGo" disabled>📸 Yuzni kiritish (5 kadr)</button>
    <h3>2. Avtomatik tanish (kiosk)</h3><p class="muted">Kamera oldida turgan o‘quvchilarni Transmitterning o‘zi taniydi va davomatga yozadi.</p>
    <select id="afG"></select><button class="sec wide" id="afKiosk">▶ Avtomatik tanishni boshlash</button><div id="afLog" class="att-res"></div></div>
  <div class="card" id="atStat" hidden><h2>📊 Statistika</h2><div class="att-k" id="atK"></div><div class="att-bar"><i id="atBar"></i></div><p class="muted center" id="atPct"></p>
    <div id="atGroups" class="att-groups"></div><div id="atTl" class="att-tl"></div><div id="atWarn"></div>
    <div class="att-row att-dl"><button class="primary" id="dlFull">⬇ To‘liq hisobot (Excel)</button><button class="sec" id="dlAbs">⬇ Kelmaganlar (CSV)</button><button class="sec" id="dlWarn">⚠ Uzoqdagilar (Excel)</button><button class="sec" id="dlFace">🙂 Yuz ID (Excel)</button><button class="sec" id="dlRoster">💾 Face ID bilan ro‘yxat (Excel)</button><button class="sec" id="dlCsv">⬇ Hammasi (CSV)</button></div>
    <div class="att-tpl"><h3>📄 O‘z shablon faylingiz bo‘yicha</h3><p class="muted">Excel / CSV / Word faylingizni tanlang — undagi ismlar yonida kelganlarga <b>+</b>, kelmaganlarga <b>-</b> yoziladi. Fayl asl ko‘rinishida (jadval, ranglar) yuklab olinadi.</p>
      <div class="att-row"><button class="primary" id="tplGo">📄 Shablonni tanlash va + / − yozish</button><button class="sec" id="tplRe" hidden></button></div><input type="file" id="tplFile" accept=".xlsx,.docx,.csv,.tsv,.txt" hidden><p class="err" id="tplErr" hidden></p></div></div>
  <div class="card" id="atList" hidden><div class="att-chips" id="atChips"></div><input id="atQ" placeholder="Qidirish…" autocomplete="off"><div id="atRows" class="att-rows"></div><button class="sec wide" id="atMore" hidden>Yana ko‘rsatish</button></div>`;
  P.root = root;
  const on = (id, ev, fn) => $('#' + id).addEventListener(ev, fn);
  on('atTx', 'click', () => templates('xlsx')); on('atTc', 'click', () => templates('csv'));
  on('atFile', 'change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });
  const dz = $('#atDrop'); dz.addEventListener('dragover', e => e.preventDefault()); dz.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  let tt; on('atTitle', 'input', () => { clearTimeout(tt); tt = setTimeout(() => send({ type: 'att-cfg', cfg: { title: $('#atTitle').value } }), 500); });
  [['atShow', 'show'], ['atPh', 'photoReq'], ['atLoc', 'locReq'], ['atFaceOn', 'face'], ['atFaceOnly', 'faceOnly'], ['atFaceLive', 'faceLive']].forEach(([id, k]) => on(id, 'change', e => send({ type: 'att-cfg', cfg: { [k]: e.target.checked } })));
  on('atFaceLvl', 'change', e => send({ type: 'att-cfg', cfg: { faceLvl: e.target.value } }));
  on('atOpen', 'change', e => { send({ type: 'att-cfg', cfg: { open: e.target.checked } }); if (e.target.checked) autoCenter(); });
  on('tplGo', 'click', () => $('#tplFile').click()); on('tplRe', 'click', () => D.tpl && fillTemplate(D.tpl));
  on('tplFile', 'change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) fillTemplate(f); });
  on('atRad', 'change', e => send({ type: 'att-cfg', cfg: { radius: Number(e.target.value) } })); on('atLate', 'change', e => send({ type: 'att-cfg', cfg: { lateMin: Number(e.target.value) } }));
  on('atCen', 'click', async () => { try { toast('📍 Joylashuv aniqlanmoqda…', 2500); const l = await getLoc(); send({ type: 'att-cfg', cfg: { center: { lat: l.lat, lng: l.lng } } }); toast(l.acc > 300 ? `📍 Markaz belgilandi, lekin aniqlik past (±${Math.round(l.acc)} m). Kompyuterda joylashuv noaniq bo‘ladi — telefondan belgilash tavsiya etiladi` : `📍 Markaz belgilandi (±${Math.round(l.acc)} m)`, l.acc > 300 ? 7000 : 3500); } catch (e) { toast(e.message, 6000); } });
  on('atCenX', 'click', () => send({ type: 'att-cfg', cfg: { center: null } }));
  on('atClear', 'click', () => { if (confirm('Barcha belgilar o‘chiriladi (ro‘yxat qoladi). Davom etasizmi?')) send({ type: 'att-clear' }); });
  on('dlFull', 'click', dl.full); on('dlAbs', 'click', dl.absent); on('dlWarn', 'click', dl.warn); on('dlFace', 'click', dl.face); on('dlRoster', 'click', dl.roster); on('dlCsv', 'click', dl.csv);
  on('atQ', 'input', () => { D.q = $('#atQ').value; D.shown = 120; paintList(); });
  on('atMore', 'click', () => { D.shown += 200; paintList(); });
  $('#atChips').onclick = e => { const b = e.target.closest('button[data-f]'); if (b) { D.filter = b.dataset.f; D.shown = 120; paintList(); } };
  $('#atRows').onclick = e => {
    const b = e.target.closest('button[data-a]'); if (b) { const i = Number(b.dataset.i); send({ type: 'att-mark', sid: i, on: b.dataset.a === 'on', via: 'host' }); return; }
    const im = e.target.closest('img[data-i]'); if (im) lightbox(im.dataset.i);
  };
  buildFace();
}
// Davomat ochilganda markaz belgilanmagan bo'lsa — Transmitter qurilmasining GPS'i bilan avtomatik belgilanadi (aniqligi yetarli bo'lsa)
async function autoCenter() {
  if (D.cfg.center || !D.cfg.locReq) return;
  try {
    const l = await getLoc();
    if (l.acc <= 300) { send({ type: 'att-cfg', cfg: { center: { lat: l.lat, lng: l.lng } } }); toast(`📍 Markaz avtomatik belgilandi (±${Math.round(l.acc)} m)`); }
    else toast(`📍 Bu qurilma joylashuvi noaniq (±${Math.round(l.acc)} m), markaz belgilanmadi. Telefondan «Markazni GPS bilan belgilash»ni bosing`, 7000);
  } catch (e) { toast('📍 Markaz belgilanmadi: ' + e.message, 6500); }
}
const photoUrl = i => `/api/rooms/${S.code}/att/photo/${i}?key=${encodeURIComponent(S.key)}`;
function lightbox(i) { const el = document.createElement('div'); el.className = 'att-modal'; el.innerHTML = `<div class="att-sheet center"><h2>${esc(D.n[i])}</h2><img src="${photoUrl(i)}" class="att-big" alt=""><button class="sec" style="margin-top:10px">Yopish</button></div>`; el.onclick = () => el.remove(); document.body.appendChild(el); }
// ---------------- Yuz ID: yuzni ro'yxatga olish (Transmitter), kiosk va receiver skaneri ----------------
let fStream = null, fSel = null, fFace = 'user', fBusy = false, fLast = null, kOn = false, fWait = null, fSeq = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitCand = (k, ms) => new Promise((res, rej) => { fWait = { k, res }; setTimeout(() => { if (fWait && fWait.k === k) { fWait = null; rej(new Error('Server javob bermadi. Qayta urining')); } }, ms); });
function fillGroups(sel, recv) {                           // guruhlar ro'yxati (receiver: majburiy tanlash, Transmitter: «barcha guruhlar»)
  if (!sel) return;
  const gs = [...new Set(D.g.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uz', { numeric: true })), key = gs.join('\u0001') + (recv ? '1' : '0');
  sel.hidden = !gs.length; if (sel._k === key) return; sel._k = key;
  const cur = sel.value || (recv ? R.gv : '');
  sel.innerHTML = `<option value="">${recv ? 'Guruhingizni tanlang…' : 'Barcha guruhlar'}</option>` + gs.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  if (cur && gs.includes(cur)) sel.value = cur;
}
const setInfo = (t, k) => { const e = $('#afInfo'); if (e) { e.textContent = t || ''; e.className = 'fst ' + (k || ''); } };
function faceOff() {
  kOn = false; camStop(fStream); fStream = null; fBusy = false;
  const v = $('#afVid'); if (v) { v.srcObject = null; v.hidden = true; } const b = $('#afCam'); if (b) b.textContent = '📷 Kamerani yoqish'; const fl = $('#afFlip'); if (fl) fl.hidden = true;
  setInfo(''); faceBtn();
}
async function faceOn() {
  if (!window.FACE) return toast('face.js yuklanmadi. Sahifani yangilang', 4000);
  try {
    setInfo('Kamera ishga tushmoqda…'); fStream = await camStart($('#afVid'), fFace); $('#afVid').classList.toggle('mir', fFace === 'user');
    $('#afCam').textContent = '⏹ Kamerani o‘chirish'; $('#afFlip').hidden = false; setInfo('Yuz modeli yuklanmoqda…');
    window.FACE.load(t => setInfo(t)).then(() => setInfo('Tayyor ✓', 'ok')).catch(e => setInfo(e.message, 'bad'));
  } catch (e) { faceOff(); setInfo('⚠ ' + (e.message || 'Kamera ochilmadi'), 'bad'); toast(e.message || 'Kamera ochilmadi', 5500); }
  faceBtn();
}
function buildFace() {
  const q = $('#afQ'); let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { const ids = search(q.value, 8); $('#afRes').innerHTML = ids.map(i => `<button class="att-pick" data-i="${i}"><b>${esc(D.n[i])}</b><small>${esc(D.g[i])}${D.fm.fc[i] ? ' · 🙂 ' + esc(D.fm.fid[i] || '') + ' (kiritilgan)' : ' · yuz kiritilmagan'}</small></button>`).join(''); }, 80); };
  $('#afRes').onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; fSel = Number(b.dataset.i); $('#afSel').textContent = '👤 ' + D.n[fSel] + (D.fm.fc[fSel] ? ' (qayta kiritiladi)' : ''); faceBtn(); };
  $('#afCam').onclick = () => { if (fStream) faceOff(); else faceOn(); };
  $('#afFlip').onclick = () => { fFace = fFace === 'user' ? 'environment' : 'user'; faceOff(); faceOn(); };
  $('#afGo').onclick = async () => {
    if (fBusy || fSel == null || !fStream) return; fBusy = true; faceBtn(); const sid = fSel; let pre = '';
    try {
      await window.FACE.load(setInfo);
      const list = await window.FACE.enroll($('#afVid'), { stop: () => !fStream, onStep: (i, n, tx) => { pre = `${i + 1}/${n} · `; setInfo(pre + tx, 'ok'); }, onStatus: (tx, k) => setInfo(pre + tx, k) });
      fLast = { sid, d: list.map(window.FACE.enc) }; setInfo('Saqlanmoqda…', 'ok'); send({ type: 'att-fenroll', sid, d: fLast.d });
    } catch (e) { if (e.code !== 'abort') { setInfo(e.message, 'bad'); toast(e.message, 5000); } }
    finally { fBusy = false; faceBtn(); }
  };
  $('#afKiosk').onclick = () => { if (kOn) { kOn = false; kioskBtn(); setInfo(''); } else kiosk(); };
}
const faceBtn = () => { const v = $('#afVid'); if (v) v.hidden = !fStream; const g = $('#afGo'); if (g) { g.disabled = !(fStream && fSel != null && !fBusy && !kOn); g.textContent = fBusy ? '⏳ Kadrlar olinmoqda…' : '📸 Yuzni kiritish (5 kadr)'; } kioskBtn(); };
const kioskBtn = () => { const b = $('#afKiosk'); if (b) { b.textContent = kOn ? '⏹ Avtomatik tanishni to‘xtatish' : '▶ Avtomatik tanishni boshlash'; b.disabled = fBusy; } };
// Kiosk: kamera oldidagi har bir yuz taniladi → davomatga yoziladi (allaqachon belgilangan bo'lsa qayta yozilmaydi)
async function kiosk() {
  if (!D.cfg.face) return toast('Avval «🙂 Yuz ID rejimi»ni yoqing', 4000);
  if (!D.cfg.faceN) return toast('Hali birorta yuz kiritilmagan', 4000);
  if (!D.cfg.open) toast('Eslatma: davomat yopiq — belgilar baribir yoziladi', 3500);
  if (!fStream) await faceOn(); if (!fStream) return;
  kOn = true; faceBtn(); const log = t => { const l = $('#afLog'); if (l) l.innerHTML = `<div class="att-pick"><b>${t}</b></div>` + [...l.children].slice(0, 5).map(x => x.outerHTML).join(''); };
  try { await window.FACE.load(setInfo); } catch (e) { kOn = false; faceBtn(); return setInfo(e.message, 'bad'); }
  while (kOn && fStream) {
    try {
      const r = await window.FACE.scan($('#afVid'), { need: 2, live: false, size: 320, timeout: 3600000, stop: () => !kOn || !fStream, onStatus: (t, k) => setInfo('🔎 ' + t, k) });
      let m = null; const k = ++fSeq; send({ type: 'att-fmatch', g: $('#afG').value, d: window.FACE.enc(r.desc), live: true, k });
      try { m = await waitCand(k, 6000); } catch {}
      if (!m || m.why === 'wait') { await sleep(300); continue; }
      if (m.ok) {
        if (m.taken || D.rows.has(m.sid)) log(`✓ ${esc(m.name)} — oldin belgilangan`);
        else { send({ type: 'att-mark', sid: m.sid, on: true, via: 'fid', fp: m.pct, live: true, photo: snap($('#afVid')) || undefined }); log(`✅ ${esc(m.name)} <small>${esc(m.g)} · ${m.pct}%</small>`); toast('✅ ' + m.name, 1800); }
        await sleep(2200);
      } else { log(m.why === 'ambiguous' ? '❓ Yuz aniq ajralmadi — qayta' : m.why === 'othergroup' ? '⚠ Boshqa guruh o‘quvchisi' : '❌ Yuz bazada topilmadi'); await sleep(1500); }
    } catch (e) { if (e.code === 'abort') break; await sleep(600); }
  }
  kOn = false; faceBtn(); setInfo('');
}

// Receiver: yuzni skanerlash → server ism topadi → o'quvchi tasdiqlaydi (joylashuv parallel avtomatik olinadi)
const FW = { nodb: 'Yuz bazasi bo‘sh. Transmitterga murojaat qiling', off: 'Yuz ID rejimi o‘chirilgan', closed: 'Davomat hozir yopiq', bad: 'Yuz ma’lumoti noto‘g‘ri. Qayta urining',
  unknown: 'Yuzingiz bazada topilmadi. Yorug‘likni yaxshilab qayta urining. Topilmasa — yuzingiz ro‘yxatga olinmagan bo‘lishi mumkin, Transmitterga ayting',
  ambiguous: 'Yuz aniq ajratilmadi (o‘xshash yuz bor). Kameraga yaqinroq va to‘g‘ri qarab qayta urining', me: 'Siz allaqachon belgilangansiz' };
async function openFace() {
  if (modal) return;
  if (!window.FACE) return toast('face.js yuklanmadi. Sahifani yangilang', 4000);
  if (!R.g.hidden && !R.g.value) return toast('Avval guruhingizni tanlang', 3500);
  const grp = R.g.hidden ? '' : R.g.value;
  const el = document.createElement('div'); el.className = 'att-modal';
  el.innerHTML = `<div class="att-sheet"><h2>🙂 Yuz ID</h2><small class="muted">${esc(grp || 'Barcha guruhlar')}</small>
    <div class="att-steps"><div id="fmLoc">📍 Joylashuv: aniqlanmoqda…</div></div><video id="fmVid" playsinline muted></video><p class="fst" id="fmSt">Yuklanmoqda…</p>
    <div id="fmRes" hidden></div><p class="err" id="fmErr" hidden></p>
    <div class="att-btns"><button class="primary" id="fmGo" hidden disabled>✅ Tasdiqlash</button><button class="sec" id="fmRe" hidden>↻ Qayta skanerlash</button><button class="sec" id="fmX">Bekor qilish</button></div></div>`;
  document.body.appendChild(el); modal = el;
  const q = s => el.querySelector(s); let stream = null, loc = null, stop = false, cand = null;
  const close = () => { stop = true; camStop(stream); el.remove(); modal = null; };
  const setSt = (t, k) => { const e = q('#fmSt'); if (e) { e.textContent = t; e.className = 'fst ' + (k || ''); } };
  const setErr = t => { const e = q('#fmErr'); if (e) { e.hidden = !t; e.textContent = t || ''; } };
  const ready = () => { const g = q('#fmGo'); if (g) g.disabled = !cand || (D.cfg.locReq && !loc); };
  q('#fmX').onclick = close;
  if (D.cfg.locReq) {
    const doLoc = () => getLoc().then(l => { if (stop) return; loc = l; q('#fmLoc').textContent = `📍 Joylashuv: aniqlandi (±${Math.round(l.acc)} m) ✓`; ready(); })
      .catch(e => { if (stop) return; q('#fmLoc').innerHTML = '📍 Joylashuv: xato · <a href="#" id="fmRl">qayta urinish</a>'; setErr(e.message); const a = q('#fmRl'); if (a) a.onclick = ev => { ev.preventDefault(); q('#fmLoc').textContent = '📍 Joylashuv: aniqlanmoqda…'; setErr(''); doLoc(); }; });
    doLoc();
  } else q('#fmLoc').hidden = true;
  const run = async () => {
    cand = null; q('#fmRes').hidden = true; q('#fmGo').hidden = q('#fmRe').hidden = true; q('#fmGo').disabled = true; q('#fmGo').textContent = '✅ Tasdiqlash';
    if (!D.cfg.locReq || loc) setErr('');
    try {
      await window.FACE.load(t => setSt(t)); if (stop) return;
      if (!stream) { setSt('Kamera ishga tushmoqda…'); stream = await camStart(q('#fmVid'), 'user'); if (stop) { camStop(stream); return; } }
      const r = await window.FACE.scan(q('#fmVid'), { live: D.cfg.faceLive !== false, size: 224, stop: () => stop, onStatus: setSt });
      setSt('Tekshirilmoqda…', 'ok'); let m = null;
      for (let t = 0; t < 4 && !stop; t++) { const k = ++fSeq; send({ type: 'att-fmatch', g: grp, d: window.FACE.enc(r.desc), live: r.live, k }); m = await waitCand(k, 8000); if (m.why !== 'wait') break; await sleep(700); }
      if (stop) return;
      if (m && m.ok) {
        cand = m; setSt('Yuz tanildi ✓', 'ok'); q('#fmRes').hidden = false;
        q('#fmRes').innerHTML = `<div class="fcand"><small>Siz:</small><b>${esc(m.name)}</b><small>${esc(m.g || '')} · moslik ${m.pct}%</small></div>`;
        q('#fmGo').hidden = false; q('#fmRe').hidden = false; q('#fmRe').textContent = '✕ Bu men emas — qayta'; ready();
      } else {
        setSt(''); const w = m && m.why;
        setErr(w === 'taken' ? `«${m.name}» allaqachon belgilangan. Adashgan bo‘lsangiz, Transmitterga ayting` : w === 'othergroup' ? `Siz tanlangan guruhda emassiz${m.g ? ' (yuz «' + m.g + '» guruhiga mos)' : ''}. Guruhni tekshiring` : FW[w] || 'Yuz tanilmadi');
        q('#fmRe').hidden = false; q('#fmRe').textContent = '↻ Qayta skanerlash';
      }
    } catch (e) { if (stop) return; setSt(''); setErr(e.message || 'Xatolik'); q('#fmRe').hidden = false; q('#fmRe').textContent = '↻ Qayta skanerlash'; }
  };
  q('#fmRe').onclick = run;
  q('#fmGo').onclick = () => {
    if (!cand) return; const photo = snap(q('#fmVid')); q('#fmGo').disabled = true; q('#fmGo').textContent = 'Yuborilmoqda…';
    send({ type: 'att-claim', sid: cand.sid, fc: 1, loc: loc || undefined, photo: photo || undefined });
    modal.onResult = ok => { if (ok) close(); else { const g = q('#fmGo'); if (g) { g.textContent = '✅ Tasdiqlash'; ready(); } } };
  };
  run();
}

// Chizish (rAF bilan paketlanadi)
let raf = 0; const paintHostSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintHost(); }); };
const CH = [['all', 'Hammasi'], ['in', 'Keldi'], ['out', 'Kelmadi'], ['far', '⚠ Uzoqda'], ['sus', '🚩 Shubhali'], ['face', '🙂 Yuz ID']];
function match(i) {
  const r = D.rows.get(i), f = D.filter;
  if (f === 'in' && !r) return false; if (f === 'out' && r) return false;
  if (f === 'far' && !(r && (r[9] === 'warn' || r[9] === 'far' || r[9] === 'noloc'))) return false;
  if (f === 'sus' && !(r && r[6] >= 60)) return false; if (f === 'face' && !(r && (r[3] === 'face' || r[3] === 'fid'))) return false;
  return true;
}
function paintList() {
  const box = $('#atRows'); if (!box) return;
  const qn = D.q.trim() ? new Set(search(D.q, 400)) : null, idx = [];
  for (let i = 0; i < D.n.length; i++) if (match(i) && (!qn || qn.has(i))) idx.push(i);
  const cnt = { all: D.n.length, in: D.rows.size, out: D.n.length - D.rows.size, far: 0, sus: 0, face: 0 };
  D.rows.forEach(r => { if (r[9] === 'warn' || r[9] === 'far' || r[9] === 'noloc') cnt.far++; if (r[6] >= 60) cnt.sus++; if (r[3] === 'face' || r[3] === 'fid') cnt.face++; });
  $('#atChips').innerHTML = CH.map(([k, t]) => `<button class="chip-b ${D.filter === k ? 'on' : ''}" data-f="${k}">${t} <b>${cnt[k]}</b></button>`).join('');
  const shown = idx.slice(0, D.shown);
  box.innerHTML = shown.map(i => {
    const r = D.rows.get(i), cls = !r ? 'out' : r[1] === 'l' ? 'late' : 'in';
    const dist = !r ? '' : r[9] === 'far' ? `<span class="b bad">⛔ ${fmtD(r[4])}</span>` : r[9] === 'warn' ? `<span class="b warn">⚠ ${fmtD(r[4])}</span>` : r[9] === 'noloc' ? '<span class="b bad">📍 yo‘q</span>' : r[4] != null ? `<span class="b ok">${fmtD(r[4])}</span>` : '';
    const risk = r && r[6] >= 60 ? `<span class="b bad" title="${esc(whyT(r))}">🚩 ${r[6]}</span>` : r && r[6] >= 30 ? `<span class="b warn" title="${esc(whyT(r))}">❓ ${r[6]}</span>` : '';
    return `<div class="att-r ${cls}"><i class="dot"></i><div class="nm"><b>${esc(D.n[i])}</b><small>${esc(D.g[i])}${r ? ' · ' + hms(r[2]) + ' · ' + via(r) : ''}</small></div>${dist}${risk}${r && r[8] ? `<img loading="lazy" data-i="${i}" src="${photoUrl(i)}" alt="">` : ''}<button class="sec sm" data-i="${i}" data-a="${r ? 'off' : 'on'}" title="${r ? 'Belgini bekor qilish' : 'Keldi deb belgilash'}">${r ? '✕' : '✓'}</button></div>`;
  }).join('') || '<p class="muted center">Hech narsa topilmadi</p>';
  $('#atMore').hidden = idx.length <= D.shown;
}
function paintHost() {
  if (!P.root || !isHost()) return;
  const has = D.n.length > 0, c = D.cfg, st = D.st || { p: 0, l: 0, warn: 0, far: 0, noloc: 0, sus: 0 }, tot = D.n.length, came = st.p + st.l;
  ['atSet', 'atStat', 'atList'].forEach(id => { $('#' + id).hidden = !has; }); $('#atFace').hidden = !has;
  if (!has && fStream) faceOff();
  $('#atInfo').textContent = has ? `✅ ${tot} ta o‘quvchi yuklangan${D.title ? ' · ' + D.title : ''}` : $('#atInfo').textContent;
  if (document.activeElement !== $('#atTitle') && D.title !== undefined) $('#atTitle').value = D.title;
  const set = (id, v) => { const e = $('#' + id); if (e && e.checked !== v) e.checked = v; };
  set('atOpen', c.open); set('atShow', c.show !== false); set('atPh', c.photoReq); set('atLoc', c.locReq); set('atFaceOn', c.face); set('atFaceOnly', !!c.faceOnly); set('atFaceLive', c.faceLive !== false); if ($('#atFaceLvl').value !== (c.faceLvl || 'normal')) $('#atFaceLvl').value = c.faceLvl || 'normal';
  $('#afStat').textContent = `🙂 Face ID kiritilgan: ${c.faceN || 0} / ${tot}` + (c.face ? '' : ' · Yuz ID rejimi o‘chiq (yuqoridagi sozlamalardan yoqing)'); fillGroups($('#afG'));
  if (document.activeElement !== $('#atRad')) $('#atRad').value = c.radius; if (document.activeElement !== $('#atLate')) $('#atLate').value = c.lateMin;
  $('#atCenX').hidden = !c.center;
  $('#atCenInfo').textContent = c.center ? `📍 Markaz: Transmitter belgilagan (${c.center.lat}, ${c.center.lng}). Radius ${c.radius} m, ${c.radius * 3} m dan uzoq — «Uzoqda».`
    : D.c ? `📍 Markaz belgilanmagan: masofa belgilanganlarning o‘rtasiga nisbatan hisoblanmoqda. Aniqroq natija uchun GPS bilan belgilang.` : '⚠ Markaz belgilanmagan — masofa hozircha TEKSHIRILMAYDI (kamida 3 kishi belgilanguncha). «Markazni GPS bilan belgilash»ni bosing.';
  $('#atK').innerHTML = [['in', 'Keldi', st.p], ['late', 'Kech', st.l], ['out', 'Kelmadi', tot - came], ['warn', '⚠ Ogohlantirish', st.warn], ['bad', '⛔ Uzoqda', st.far], ['bad', '🚩 Shubhali', st.sus]].map(([k, t, v]) => `<div class="k ${k}"><b>${v}</b><small>${t}</small></div>`).join('');
  const pct = tot ? came / tot * 100 : 0; $('#atBar').style.width = pct + '%'; $('#atPct').textContent = `Davomat: ${pct.toFixed(1)}% (${came} / ${tot})`;
  const gs = groupStats(); $('#atGroups').innerHTML = gs.size > 1 || (gs.size === 1 && !gs.has('—')) ? [...gs.entries()].slice(0, 10).map(([g, o]) => `<div class="gb"><span>${esc(g)}</span><div><i style="width:${o.t ? (o.p + o.l) / o.t * 100 : 0}%"></i></div><em>${o.p + o.l}/${o.t}</em></div>`).join('') : '';
  const times = [...D.rows.values()].map(r => r[2]).sort((a, b) => a - b);
  if (times.length > 1) { const t0 = times[0], bins = Math.min(30, Math.max(1, Math.ceil((times[times.length - 1] - t0) / 60000) + 1)), arr = new Array(bins).fill(0); times.forEach(t => { arr[Math.min(bins - 1, Math.floor((t - t0) / 60000))]++; }); const mx = Math.max(...arr);
    $('#atTl').innerHTML = `<small class="muted">Kelish dinamikasi (daqiqalar bo‘yicha)</small><div>${arr.map(v => `<i style="height:${Math.max(6, v / mx * 100)}%" title="${v}"></i>`).join('')}</div>`; } else $('#atTl').innerHTML = '';
  const warns = [...D.rows.entries()].filter(([, r]) => r[9] === 'warn' || r[9] === 'far' || r[9] === 'noloc').sort((a, b) => (b[1][4] || 1e9) - (a[1][4] || 1e9)).slice(0, 8);
  $('#atWarn').innerHTML = warns.length ? `<div class="att-warn"><b>⚠ Uzoqda bo‘lgan o‘quvchilar (${st.warn + st.far + st.noloc})</b>${warns.map(([i, r]) => `<div><span>${esc(D.n[i])}</span><em>${r[9] === 'noloc' ? 'joylashuv yo‘q' : fmtD(r[4])}</em></div>`).join('')}</div>` : '';
  paintList();
}

// ---------------- Server xabarlari ----------------
const idx = () => { D.T = D.n.map(norm); };
function on(m) {
  switch (m.type) {
    case 'att-list': D.title = m.title || ''; D.n = m.n || []; D.g = m.g || []; D.cfg = Object.assign(D.cfg, m.cfg); D.taken = new Set(m.taken || []); D.me = m.me; D.rows = new Map(); D.st = null; idx(); paintHost(); paintRecv(); break;
    case 'att-full': D.rows = new Map(m.rows.map(r => [r[0], r])); D.st = m.st; D.c = m.c; paintHost(); break;
    case 'att-upd': m.rows.forEach(r => { if (r[1] === '') D.rows.delete(r[0]); else D.rows.set(r[0], r); }); D.st = m.st; D.c = m.c; paintHostSoon(); break;
    case 'att-taken': (m.add || []).forEach(i => D.taken.add(i)); (m.del || []).forEach(i => D.taken.delete(i)); if (!isHost() && R.box && !R.box.hidden && D.me == null) recvList(); break;
    case 'att-cfg': D.cfg = Object.assign(D.cfg, m.cfg); if (m.title != null) D.title = m.title; paintHost(); paintRecv(); break;
    case 'att-fmeta':
      if (m.full) D.fm = { fid: m.fid || [], fc: m.fc || [], ph: m.ph || [], pv: m.pv || [] };
      else { (m.upd || []).forEach(([i, f, c]) => { D.fm.fid[i] = f; D.fm.fc[i] = c; }); }
      paintHostSoon(); break;
    case 'att-fcand': if (fWait && m.k === fWait.k) { const w = fWait; fWait = null; w.res(m); } break;
    case 'att-fok': toast(`✅ ${D.n[m.sid]} — Face ID: ${m.fid}`, 4500); fSel = null; fLast = null; { const e = $('#afSel'); if (e) e.textContent = 'Ism tanlanmagan'; const q = $('#afQ'); if (q) q.value = ''; const rs = $('#afRes'); if (rs) rs.innerHTML = ''; } faceBtn(); break;
    case 'att-fdup': if (fLast && confirm(`Bu yuz allaqachon «${m.name}» ga kiritilgan. Baribir «${D.n[m.sid]}» ga ham saqlansinmi?\n(Bir xil yuz ikki ism ostida bo‘lsa, tizim ikkalasini ham aniqlay olmaydi.)`)) send({ type: 'att-fenroll', sid: fLast.sid, d: fLast.d, force: true }); else toast('Bekor qilindi', 2500); break;
    case 'att-ferr': toast(m.msg || 'Yuz saqlanmadi', 5000); break;
    case 'att-ok': D.me = m.sid; D.meT = m.t; toast('✅ Davomat belgilandi'); if (modal && modal.onResult) modal.onResult(true); paintRecv(); break;
    case 'att-err': toast(m.msg || 'Xatolik', 4500); if (modal && modal.onResult) modal.onResult(false); break;
  }
}
// receiver xonaga qo'shilgach ro'yxatni qayta so'raydi: xabar yo'qolgan/kechikkan bo'lsa ham davomat oynasi ko'rinadi
const joined = () => { if (!isHost()) { send({ type: 'att-sync' }); setTimeout(() => { if (!D.n.length && S.joined) send({ type: 'att-sync' }); }, 2500); } };
window.ATT = { on, joined, _t: { toStudents, D, getLoc, paintRecv, planFill, fillXlsx, fillDocx, fillCsvT, patchZip, findStudent, norm, idx: () => idx() } };
buildHost(); buildRecv();
})();
