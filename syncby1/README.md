# SyncCast

Bir nechta qurilmada **bir vaqtda** (sinxron) musiqa yoki film chalish. Kahoot kabi: Transmitter xona yaratadi, Receiverlar 6 xonali kod (yoki QR) bilan kiradi.

- **Transmitter** — xona yaratadi, fayl yuklaydi (yoki havola qo'shadi), play / pauza / suradi. Hammada bir vaqtda ishlaydi.
- **Receiver** — kod bilan kiradi, o'z dinamigidan eshitadi / videoni ko'radi.

## 1. Lokal rejim (bitta Wi-Fi, internet shart emas)

```bash
npm install
npm start
```

Terminalda manzillar chiqadi:

```
Shu kompyuterda:   http://localhost:3000
Wi-Fi tarmog'ida:  http://192.168.1.23:3000
```

1. Serverni ishga tushirgan kompyuterda `http://localhost:3000` ni oching → **Transmitter**. (Transmitter telefondan ham bo'lishi mumkin: telefonda `http://192.168.1.23:3000` ni ochib, **Transmitter**ni tanlang.)
2. Ekranda kod va QR chiqadi. Telefonlar **bir xil Wi-Fi'da** QR'ni skanerlaydi yoki `http://192.168.1.23:3000` ni ochib kodni kiritadi → **Receiver**.
3. Fayl yuklang, ▶ bosing.

Lokal rejimda fayllar Wi-Fi orqali uzatiladi, shuning uchun juda tez va internet sarflanmaydi.

## 2. Global rejim (internet orqali, har qayerdan)

Server internetda ochiq turishi kerak. Ikki yo'l bor:

### A) Tez sinov: tunnel (o'z kompyuteringizdan)

```bash
npm start
# boshqa terminalda (cloudflared yoki ngrok o'rnatilgan bo'lsa):
cloudflared tunnel --url http://localhost:3000
# yoki
ngrok http 3000
```

Chiqqan `https://....` havolani Transmitter ochadi, Receiverlar ham shu havola + kod bilan kiradi.
**Eslatma:** bepul Cloudflare tunnelida bitta so'rov hajmi ~100 MB bilan cheklanadi, katta fayl yuklanmaydi. Katta fayllar uchun lokal rejim yoki "havola qo'shish" (pastga qarang).

### B) Doimiy hosting (Render, Railway, Fly.io, VPS)

1. Loyihani GitHub'ga yuklang.
2. Render/Railway'da "Web Service" yarating: Build `npm install`, Start `npm start`. `PORT` ni platforma o'zi beradi.
3. Berilgan `https://...` manzil — global manzilingiz. WebSocket va HTTPS avtomatik ishlaydi.

Bepul tariflarda server uxlab qolishi (birinchi ochilish sekin) va disk vaqtinchalik ekanligini unutmang — xonalar baribir vaqtinchalik.

## Qo'llab-quvvatlanadigan fayllar

| Tur | Formatlar | Receiverda qanday ko'rinadi |
|---|---|---|
| Audio | mp3, wav, ogg, m4a, aac, flac, opus | sinxron chaladi |
| Video | mp4, webm, mov, m4v, ogv | sinxron chaladi |
| Rasm | jpg, png, gif, webp, avif, bmp | ekranda ko'rsatiladi |
| PDF | pdf | ekranda ko'rsatiladi (+ "Ochish" / "Yuklab olish") |
| Matn | txt, csv, md | ekranda ko'rsatiladi |
| Hujjat | doc/docx, xls/xlsx, ppt/pptx, rtf, odt/ods/odp | fayl kartasi + "Yuklab olish" (brauzer Word/Excel'ni ochib ko'rsata olmaydi) |

Xavfsizlik uchun SVG, HTML, JS, EXE, ZIP kabi turlar qabul qilinmaydi.

## Barqaror chalish uchun maslahat

- Transmitter o'zi yuklagan faylni **o'z qurilmasidan** chaladi (serverdan qayta yuklamaydi), shuning uchun u qotmaydi.
- Katta `.mp4` fayl Receiverlarda tez boshlanishi uchun "faststart" bilan saqlangan bo'lsin: `ffmpeg -i kirish.mp4 -c copy -movflags +faststart chiqish.mp4`. Aks holda brauzer butun faylni yuklab olmaguncha boshlay olmaydi.
- Eng barqarori: hamma bitta Wi-Fi'da (lokal rejim).

## Fayl o'rniga havola

Transmitter "havola qo'shish" maydoniga to'g'ridan-to'g'ri `.mp3` / `.mp4` havolasini qo'ysa, fayl serverga yuklanmaydi, Receiverlar uni o'sha manbadan oladi. Global rejimda katta filmlar uchun eng qulay yo'l.
YouTube/Netflix havolalari ishlamaydi (ular to'g'ridan-to'g'ri fayl bermaydi). Sayt HTTPS bo'lsa, havola ham HTTPS bo'lishi kerak.

## Sozlamalar (muhit o'zgaruvchilari)

| O'zgaruvchi | Standart | Ma'no |
|---|---|---|
| `PORT` | 3000 | Server porti |
| `MAX_MB` | 7168 | Bitta fayl hajmi chegarasi (MB) — standart 7 GB |

## Qanday sinxronlaydi

1. Har bir qurilma server bilan soat farqini o'lchaydi (har 5 soniyada qayta, eng kichik kechikishli o'lchov olinadi).
2. Transmitter ▶ bosganda server "boshlanish vaqti"ni (hozir + 1,5 s) belgilaydi, hamma qurilma shu aniq lahzada chala boshlaydi.
3. Chalish paytida har 300 ms da farq tekshiriladi: kichik farq tezlikni ±8% gacha o'zgartirib, katta farq (0,5 s dan ortiq) surib to'g'rilanadi.
4. Xonaga keyin kirgan Receiver darhol hozirgi joydan davom etadi.

## Yangi imkoniyatlar (v3)

**Transmitter paneli:**
- 👁 Receiverlar fayllarni (rasm / PDF / hujjat) ko'ra olsin — yoqish/o'chirish (server ham rad etadi)
- ⬇ Yuklab olishga ruxsat — yoqish/o'chirish
- 🔇 **Hammaning dinamigini o'chirish** tugmasi + har bir receiver uchun alohida 🔊/🔇 va ✕ (chiqarib yuborish)
- Umumiy ovoz slayderi (hamma receiverda bir xil) va "receiver ovozini o'zgartira olmasin" qulfi
- ⏮ ⏭ ⏹ tugmalari, takrorlash (bitta / hammasi), hammaga xabar yuborish, xona qulfi (yangi receiver kira olmaydi)

**🎙 Jonli efir (WebRTC):**
- 🎤 Mikrofon — Transmitter gapiradi, hamma receiver eshitadi. Mikrofon paytida musiqa avtomatik pasayadi (ducking).
- 🖥 Ekranni ko'rsatish (cast) — receiverlarda ekran paydo bo'ladi, to'liq ekran tugmasi bor. Ixtiyoriy: brauzer/tizim ovozi bilan.
- Mikrofon va ekran uchun Transmitter sahifasini **http://localhost** yoki **HTTPS** orqali oching (brauzer talabi).
  Telefonda ekranni ulashish ko'p brauzerlarda yo'q — ekran uzatishni kompyuterdan qiling.
- Bir vaqtda ~20 receivergacha to'g'ridan-to'g'ri efir (undan ko'prog'i uchun SFU server kerak).
- Internet orqali (turli tarmoqlar) ishlashi uchun ba'zan TURN server kerak bo'ladi; bitta Wi-Fi'da muammo yo'q.

**Ovozni 1:1 tenglashtirish:** fayl balandligi LUFS (ITU-R BS.1770, K-vazn + gate) bo'yicha Transmitterda **bir marta** o'lchanadi
(yuklash paytida; katta fayllarda ijroning birinchi ~8 soniyasida) va hisoblangan tuzatma (dB) server orqali **hamma qurilmaga bir xil** yuboriladi.
Har qurilma aynan shu statik kuchaytirishni qo'llaydi, oxirida limiter turadi — shuning uchun fayllar orasida sakrash yo'q va Transmitter
bilan receiverlar bir xil balandlikda chaladi. Mikrofon ovozi Transmitterning o'zida tenglashtiriladi, receiverlarda qo'shimcha ishlov yo'q.
(Qurilmaning o'z dinamik/Bluetooth ovozini dastur o'zgartira olmaydi.)

**Mikrofon (aks-sado va chiyillashga qarshi):** brauzer echo-cancellation + shovqin kamaytirish, 100 Hz–7.5 kHz filtr, shovqin darvozasi
(jim paytda mikrofon yopiladi), chiyillashni (feedback) aniqlab, o'sha chastotani avtomatik kesuvchi filtrlar, avto-balandlik va limiter.
Mikrofon yoqilganda Transmitter dinamigi ham pasayadi (sozlanadi). Eng yaxshi natija uchun quloqchin taqing.

**Ekran uzatish sifati (Zoom kabi):** ekran asl o'lchamida (1080p–1440p) olinadi, "Matn" rejimida aniqlik afzal (`contentHint=detail`,
`maintain-resolution`), "Video" rejimida silliqlik. VP9/H264 kodek tanlanadi, bitreyt har receiver uchun tarmoq yo'qotishiga qarab
avtomatik oshadi/kamayadi (har 2 soniyada). Receiverda: to'liq ekran (iPhone uchun zaxira rejim bilan), sig'dirish/to'ldirish, ikki marta bosish.

**Eslatma:** "Yuklab olish"ni o'chirish tugmalarni yashiradi va serverda yuklab olish so'rovini rad etadi, lekin ko'rsatilayotgan
faylni brauzer baribir oladi — skrinshot/ekran yozishni to'liq to'sib bo'lmaydi.
Tashqi havola (add-url) orqali qo'shilgan fayllarda ovoz tenglashtirish ishlamaydi (brauzer CORS cheklovi), faqat umumiy ovoz/mute ishlaydi.

## v5: YouTube, barqaror sinxron, tarmoq holati

- **YouTube:** "Havola" maydoniga YouTube havolasini (watch, youtu.be, shorts, live) qo'ysangiz, video hamma qurilmada sinxron ijro etiladi
  (jonli efirlar ham). Internet va YouTube'ga kirish kerak; YouTube ovozida tenglashtirish ishlamaydi (faqat umumiy ovoz/mute).
  YouTube tezlikni o'zgartirishga imkon bermagani uchun sinxron bu yerda surish orqali to'g'rilanadi (fayllarga nisbatan ~0.3–0.6 s aniqlik).
- **Kattalashtirish:** video, YouTube, rasm va ekran efirida 🔍 (katta/kichik), ⤢ (sig'dirish/to'ldirish), ⛶ (to'liq ekran) tugmalari.
- **1:1 sinxron:** PI-boshqaruv (tezlik ±5%, ovoz balandligi o'zgarmaydi), Transmitter ham receiverlar bilan bir xil algoritmda serverdagi vaqtga tortiladi;
  qurilmaning ovoz chiqarish kechikishi (Bluetooth) avtomatik hisobga olinadi va qo'lda ham sozlanadi (±500 ms).
- **Yomon internet/Wi-Fi:** fayllar (≤64 MB) receiverlarga oldindan to'liq yuklab olinadi (ijro paytida uzilish yo'q), keyingi fayl fonda yuklanadi;
  "Play" hamma tayyor bo'lguncha (maks. 6 s) kutadi; boshlanish kechikishi receiverlarning pingiga qarab avtomatik moslanadi;
  uzilgan receiver hammani to'xtatmaydi — tezda o'zi yetib oladi; yarim uzilgan WebSocket aniqlanib, eksponensial kutish bilan qayta ulanadi.
- **Tarmoq holati:** yuqorida 📶 ko'rsatkich (ping, jitter, paket yo'qotish, sinxron farqi, bufer, efir sifati). Transmitter har bir receiverning
  ping va sinxron farqini "Receiverlar" bo'limida ko'radi.

## v6: 100+ qurilma, efir daraxti, Bluetooth, yangi funksiyalar

**Katta xonalar uchun optimizatsiya (500 tagacha, `MAX_CLIENTS` bilan o'zgaradi)**
- Server har bir xabarni bir marta JSON'ga aylantirib hammaga yuboradi; tiqilgan ulanishlarga yuborilmaydi.
- A'zolar holati yig'ilib 0.6 s da bir marta yuboriladi (avval har o'zgarishda hammaga ketardi — O(N²)).
- Ping/statistika yuborish xonadagi odam soniga qarab siyraklashadi va tasodifiy vaqtga surilgan.
- Play: 100+ odamda 10% sekin qurilma kutilmaydi, boshlanish kechikishi 90-persentil pingga qarab hisoblanadi (bitta yomon tarmoq hammani sekinlatmaydi).
- Fayllar 1.5 MB bo'laklab (Range) yuklanadi: uzilsa faqat o'sha bo'lak qayta olinadi. Server bir vaqtda `MAX_FILE_STREAMS` (48) ta so'rov beradi, qolganlari 503 + qayta urinish bilan navbatga turadi, boshlanish tasodifiy kechiktiriladi.

**Efir daraxti (ekran/mikrofon):** Transmitter 6 ta receiverga to'g'ridan-to'g'ri uzatadi; kuchli kompyuter-receiverlar relay bo'lib har biri 3 tadan
keyingilarga uzatadi (telefonlar faqat qabul qiladi). Relay uzilsa bolalari avtomatik yangi manba topadi. Natijada 100+ tinglovchi mumkin;
har bir bosqich ~100–200 ms kechikish qo'shadi va relay videoni qayta kodlaydi (shuning uchun relay sifati biroz pastroq, 2.5 Mbit gacha).

**Bluetooth / chiqish qurilmasi:** receiver va Transmitter "Qurilmani tanlash" bilan ovoz chiqadigan qurilmani tanlaydi (Chrome/Edge). Bluetooth'ni
brauzer ulay olmaydi — uni telefon/kompyuter sozlamalarida ulang. Bluetooth aniqlansa kechikish tuzatmasi (+140 ms) qo'yiladi va har qurilma
uchun alohida eslab qolinadi. **Sinxron test signali:** Transmitter yoqadi, hamma qurilmada "tik" bir vaqtda eshitilishi kerak; farq bo'lsa slayder bilan to'g'rilanadi.

**Yangi funksiyalar:** 😀 jonli reaksiyalar (ekranda suzuvchi emojilar, yig'ilib yuboriladi) va 🗳 jonli so'rovnoma (Funksiyalar menyusidan; natijalar real vaqtda).

## v7: 🎯 Viktorina (Kahoot kabi)

Transmitter sahifasida **"🎯 Viktorina"** bo'limi (Media yonida alohida tab) paydo bo'ldi.

- **Savol tuzish:** qo'lda (matn, 2–4 variant, to'g'ri javob, vaqt 10–120 s, oddiy/2x/ballsiz) va **rasm** biriktirish (rasm avtomatik kichraytiriladi).
- **Word (.docx) import:** savollar, variantlar va **rasmlar** o'qiladi (kutubxonasiz, brauzerning o'zida). Matn/JSON import ham bor.
  Format: `1. Savol` / `A) variant` (to'g'ri javob `*`, **qalin** shrift yoki `Javob: B` bilan) / `Vaqt: 30` / `Ball: x2`.
  Word'ning avtomatik raqamlangan ro'yxatlari ham tushuniladi. Natija editor'da tekshirilib, tahrirlanadi.
- **O'yin:** kutish zali → savol (3.5 s sanoq) → javoblar → to'g'ri javob + taqsimot diagrammasi + **reyting** → ... → **g'oliblar podiumi**.
  Hamma javob bersa, vaqt kutilmaydi. Receiverlar avtomatik o'yinchi bo'ladi (nik o'zgartirish mumkin), keyin kirganlar ham qo'shila oladi.
- **Ball (Kahoot formulasi):** to'g'ri javob uchun 1000 × (1 − javob_vaqti/vaqt/2), tezroq = ko'proq; ketma-ket to'g'ri javoblar uchun bonus (+100…+500); 2x savolda 2000.
  Ballar va to'g'ri javob **serverda** hisoblanadi va saqlanadi (to'g'ri javob faqat javoblar yopilgach yuboriladi) — aldab bo'lmaydi.
- Viktorina brauzerda saqlanadi (qoralama), JSON sifatida eksport/import qilinadi.

## Cheklovlar

- Telefon brauzerlari ovozga faqat foydalanuvchi bosgandan keyin ruxsat beradi, shuning uchun Receiver "Qo'shilish" tugmasini bosishi shart.
- Bluetooth dinamiklarning o'z kechikishi (50–300 ms) bor, dastur buni bilmaydi. Natijada ikki qurilma orasida biroz farq bo'lishi mumkin.
- Xona va yuklangan fayllar vaqtinchalik: xona yopilganda yoki server qayta yoqilganda o'chadi.
- Telefon ekrani o'chsa, ba'zi brauzerlar chalishni to'xtatadi. Dastur ekranni yoniq tutishga urinadi.

## v8: Kahoot uslubidagi katta ekran, a'zolar soni, 7 GB fayl

- **Viktorina (Transmitter):** o'yin to'liq ekranda (proyektor uchun ⛶ tugmasi): katta savol matni, ekranni to'ldiruvchi rangli javob plitalari, doira taymer, "javob berdi" hisoblagichi, kutish zalida katta kod + QR + o'yinchilar ismlari.
- **Natija ekrani:** har bir plitada javoblar soni, to'g'ri javob ✓, yonida reyting.
- **Receiver:** savol va javoblar telefon ekranini to'ldiradi.
- **A'zolar soni** tepada doim ko'rinadi (sarlavhada va o'yin ekranlarida).
- **Fayl limiti 7 GB:** so'rov taymauti o'chirilgan, diskda joy tekshiriladi, yuklash foizi va tezligi ko'rinadi. Bepul Cloudflare tunnel ~100 MB bilan cheklaydi — katta fayl uchun lokal rejim yoki VPS ishlating.
- **Optimizatsiya:** statik fayllar keshlanadi, taymer faqat savol paytida ishlaydi, og'ir blur olib tashlandi, `prefers-reduced-motion` qo'llab-quvvatlanadi.

## v9: toza va bir xil ovoz, viktorina ovozlari, "faqat savol" rejimi, himoya, tezlik

- **Ovoz:** 30 Hz filtr, yumshoq limiter, `latencyHint: 'playback'`, sinxron tezligi kichik farqda ±1.5% va pog'onama-pog'ona o'zgaradi,
  katta surishdan oldin 45 ms so'nish (click yo'q), tenglashtirish tuzatmasi kelganda balandlik sekin o'zgaradi. LUFS tahlili chegarasi 16 MB.
- **Viktorina ovozlari** (sintez, fayl yo'q): boshida jingle, 3-2-1 sanoq va "GO" (serverdagi vaqt bo'yicha bir vaqtda), to'g'ri/noto'g'ri signali,
  final: 1–3-o'rin uchun tantana (fanfara + olqish + konfetti), qolganlarga yengil quvonch. 🔔 bilan o'chiriladi.
- **"Faqat savol" rejimi:** Transmitterda 🙈 tugmasi (o'yin paytida ham). Yoqilganda variantlar matni receiverga serverdan yuborilmaydi; natija bosqichida ochiladi.
- **Himoya (receiver, viktorina paytida):** nusxa/kontekst menyu/tanlash/chop etish bloklanadi, PrintScreen va fokus yo'qolganda ekran yopiladi,
  nik bilan suv belgisi. Brauzer telefonning apparat skrinshotini to'sa olmaydi.
- **Tezlik:** html/js/css brotli/gzip (130 KB → 39 KB); receiverlar ro'yxati kalitli yangilanadi; zal QR/DOM qayta chizilmaydi.

## v10: bekor qilish, himoya tugmasi, avatarlar, medal marosimi, yaxshilangan import

- **Fayl qabul qilishni bekor qilish (receiver):** katta fayl yuklanayotganda (oldindan yuklash yoki 64 MB dan katta oqim) "✕ Bekor qilish" tugmasi chiqadi,
  yuklangan MB / jami MB ko'rinadi. Bekor qilinsa so'rovlar to'xtaydi, boshqa receiverlar kutmaydi, "↻ Qayta yuklash" bilan davom ettiriladi.
  Transmitterda yuklash qatorida ✕ — yuklashni bekor qiladi (server yarim faylni o'chiradi).
- **Himoya yoq/o'chir:** Ruxsatlar bo'limida va viktorina panelida "🛡 Himoya" (hamma receiverlarga, o'yin paytida ham).
- **Variant va savol matnini yashirish:** 🙈 tugmalari (variantlar / savol matni alohida), matn serverdan yuborilmaydi.
- **Avatarlar:** o'yinchi zalda 60 ta hayvon/meva/belgidan tanlaydi (qurilmada eslab qolinadi), zal, reyting va podiumda ko'rinadi.
- **G'oliblar marosimi:** top-5 uchun medallar (🥇🥈🥉🏅🎖️), 5-o'rindan 1-o'ringacha bosqichma-bosqich e'lon, baraban + fanfara + olqish + konfetti,
  g'oliblar receiverida to'liq ekranli tabrik. "🏆 Tabrik animatsiyasi" tugmasi bilan o'chiriladi (oddiy podium qoladi). `prefers-reduced-motion` hurmat qilinadi.
- **Import:** Word, Excel (.xlsx), CSV/TSV, JSON, TXT + Excel/Sheets'dan nusxa (Tab). Kahoot shablon ustunlari ham tushuniladi. Fayl tashlash (drag & drop),
  tayyor "⬇ Excel shablon", import oldindan ko'rsatiladi (qo'shish / almashtirish / savolni olib tashlash), muammolar (to'g'ri javob topilmadi) belgilanadi.

## v11: 🤝 Do'st bilan do'st (AI savollar), stikerlarni yoqish/o'chirish

- **🤝 Do'st bilan do'st:** Viktorina studiyasi tepasida yangi blok. **\"🎲 AI bilan boshlash\"** bosilganda AI avtomatik **yangi tasodifiy savollar (soni 3–30, qo'lda tanlanadi; standart 11)** tuzadi
  (mavzular har safar tasodifiy tanlanadi yoki o'zingiz mavzu yozasiz; qiyinlik: aralash/oson/o'rta/qiyin; har savolga 10–30 s). Savollarni hech kim yozmaydi.
  Do'stlar xona kodi / QR bilan kirib, bir xil savollarda poyga o'ynaydi: tezroq va to'g'ri javob = ko'proq ball, reyting va g'oliblar marosimi avvalgidek.
  To'g'ri javob o'rni (A–D) server tomonida ham aralashtiriladi.
- **⏭ Avtomatik rejim:** yoqilsa, javoblar ochilgach reyting 2,5 soniya ko'rinadi (`QUIZ_AUTO_MS`) va keyingi savol o'zi chiqadi; hamma javob bersa to'g'ri javob darhol (~0,15 s) ochiladi (Transmitter faqat bir marta \"Boshlash\" bosadi).
  O'yin paytida \"⏭ Avtomatik\" tugmasi bilan almashtiriladi; \"▶ Keyingi savol\" har doim qo'lda ishlaydi.
- **😀 Stikerlar (hayvon/meva belgilari) yoqish/o'chirish:** studiyada va o'yin paytida \"😀 Stikerlar\" tugmasi. O'chiq bo'lsa receiverlarda belgi tanlash yo'qoladi,
  zal, reyting, podium, medal marosimi va tabrikda faqat ismlar ko'rinadi (server ham belgilarni yubormaydi).
- **AI xizmati tanlovi:** Transmitter AI Quiz bo'limida **Gemini** yoki **Groq** dan bittasini tanlaydi. Groq uchun `GROQ_API_KEY` (https://console.groq.com/keys), ixtiyoriy `GROQ_MODEL` (standart `llama-3.3-70b-versatile`). Kaliti yo'q xizmat o'chirib qo'yiladi.
- **AI sozlamasi (server):** `GEMINI_API_KEY` muhit o'zgaruvchisi (yoki `.env` fayli) **majburiy** (kalitni https://aistudio.google.com/apikey dan oling). Ixtiyoriy: `AI_MODEL` (standart `gemini-2.5-flash`), `AI_TIMEOUT_MS`.
  Kalit bo'lmasa, tugma xabar beradi; oddiy viktorina avvalgidek ishlayveradi. Kalit faqat serverda turadi, brauzerga yuborilmaydi.

```bash
GEMINI_API_KEY=AIza... npm start
```

## Chat (pastki chap burchak)

- 💬 tugmasi **pastki chap burchakda**, Transmitterda ham, Receiverlarda ham, **viktorina paytida ham** ko'rinadi.
- Har bir xabar yuboruvchining **ismi** (va avatari) bilan chiqadi; Transmitter xabarlari alohida rangda ("· Transmitter").
- Keyin kirgan odam oxirgi ~60 ta xabarni ko'radi. Xabar uzunligi 300 belgigacha, tez-tez yuborish cheklangan (spam).
- **Ruxsat:** Transmitter chat panelining yuqorisidagi tugmalar yoki "🔐 Ruxsatlar" bo'limi orqali
  - 💬 *Receiverlar chatga yoza olsin* — butunlay yoqish/o'chirish (o'chiq bo'lsa receiverlar faqat o'qiydi);
  - 🎯 *Viktorina paytida ham yoza olsin* — viktorina savol/natija bosqichida yozishni alohida taqiqlash mumkin.
  Transmitter har doim yoza oladi. Server ham ruxsatsiz xabarni rad etadi.
- **Diskvalifikatsiya:** qoidabuzarlik chegarasi endi **2 martadan** boshlanadi (2 / 3 / 5 / 10 / o'chiq), standart qiymat — 2.

## v12: Kahoot rejimini yoqish/o'chirish, vaqt va son sozlamasi, Transmitter ham o'ynaydi

- **⚡ Kahoot rejimi (yoq/o'chir):** Viktorina va AI Quiz bo'limlarida (ikkalasida bir xil turadi, qurilmada eslab qolinadi) va o'yin zalida (faqat boshlashdan oldin).
  - *Yoniq* — avvalgidek: tezroq javob = ko'proq ball (1000 gacha), ketma-ket to'g'ri javob bonusi.
  - *O'chiq* — **to'g'ri javoblar soni bo'yicha**: har to'g'ri javob = 1 ball (2x savol = 2, ballsiz = 0), tezlik hisobga olinmaydi.
    Ball teng bo'lsa, to'g'ri javoblarga jami kam vaqt sarflagan yuqoriga chiqadi. Hisob serverda.
- **⏱ Vaqt va son o'zingiz belgilanadi:**
  - AI Quiz: savol vaqti endi 5–120 soniya (− / + tugmalari, qo'lda yozish yoki 10/15/20/30/45/60 s tugmalari); savollar soni 3–30.
  - Viktorina studiyasi: har savolda vaqt 5–120 s (qo'lda yoziladi), **"Hamma savolga bir xil vaqt"** + "Qo'llash", **"O'yinda nechta savol"** (bo'sh = hammasi)
    va **"aralashtirib tanlash"** (tasodifiy N ta yoki ro'yxatdagi birinchi N ta).
- **🙋 Transmitter ham o'ynasin (yoq/o'chir):** yoqilsa, Transmitterning katta ekranidagi rangli plitalar bosiladigan bo'ladi, javobi hisoblanadi,
  reytingda Transmitter ismi bilan qatnashadi, natija ekranida o'z natijasi (✅/❌, ball, o'rin) ko'rinadi.
  Hamma (Transmitter ham) javob bersa, savol vaqtidan oldin yopiladi. O'yin paytida ham ⚙ menyusidan "🙋 Transmitter o'ynaydi" bilan yoqiladi/o'chiriladi.

## v13: 🎰 Luck o'yini (Funksiyalar menyusida)

- **☰ Funksiyalar → 🎰 Luck o'yini → "Aylantirish":** hamma receiverlarning ismi (va belgisi) g'ildirakka joylashadi, g'ildirak aylanadi va kimga to'xtasa — o'sha yutadi.
  G'olibni **server** tasodifiy tanlaydi va hamma qurilmaga bir xil yuboradi; g'ildirak hamma ekranda (Transmitter va receiverlarda) bir vaqtda aylanadi va to'xtaydi.
- **Ovoz va animatsiya:** boshlanishda "vush", aylanayotganda g'ildirak "tik"lari (oxirida sekinlashadi) va guvillash, to'xtaganda fanfara + olqish + konfetti,
  g'olibda to'liq ekranli "🎉 Siz yutdingiz!" va (telefonda) vibratsiya. Ovoz 🔔 (viktorina ovozlari) tugmasi bilan o'chadi.
- **♻ Avval yutganlar qayta qatnashmasin** — yoqilsa, har aylantirishda yangi odam yutadi (hamma yutib bo'lsa, ro'yxat yangidan boshlanadi).
- G'ildirakda ko'pi bilan 24 ta ism ko'rsatiladi (g'olib doim ichida), lekin g'olib hamma ishtirokchilar orasidan tanlanadi. Kamida 2 ta receiver kerak.

## v14: ✅ Qabul qilish rejimi va receiver qurilmasi

- **Qabul qilish rejimi (yoq/o'chir):** ☰ Funksiyalar → Ruxsatlar → "✅ Qabul qilish rejimi". Yoqilsa, yangi receiver xonaga darhol kirmaydi:
  u "🚪 Qabul kutilmoqda…" ekranini ko'radi, Transmitterda esa yuqorida panel chiqadi — har bir so'rovda **✅ Qabul** / **✕ Rad** va **Hammasini** tugmalari bor.
  Rad etilgan receiverga "Transmitter sizni qabul qilmadi" xabari chiqadi. Qayta ulanayotgan (oldin qabul qilingan) receiverlar qayta so'ralmaydi.
  Rejim o'chirilsa, kutayotganlar avtomatik kiritiladi. Boshqa o'chiq/yoniq sozlamalar kabi xona ichida istalgan vaqt almashtiriladi.
- **Receiver qurilmasi ko'rinadi:** qabul so'rovida va "Receiverlar" ro'yxatida: tur (📱 Telefon / Planshet / 💻 Noutbuk-kompyuter / 📺 TV), **model** (masalan SM-S918B, iPhone, Mac),
  tizim (Android, iOS, Windows…) va brauzer. **Noutbuk/kompyuterdan kirganlar ⚠ sariq ogohlantirish belgisi bilan** ajralib turadi.
  Eslatma: model brauzer bergan ma'lumotga tayanadi — iPhone aniq modelini (masalan 15 Pro) brauzer yashiradi, ba'zi Android brauzerlari ham modelni bermaydi.

## v15: xonalar ro'yxati (dumaloq), xona nomi, 🎮 O'yinlar, tezroq tarmoq

- **Xona nomi (Transmitter):** "Transmitter" bosilganda avval xonaga **nom** beriladi (majburiy). Nomni keyin ham xona kartasidagi maydondan o'zgartirish mumkin — hamma receiverda darhol yangilanadi.
- **Xonani qidirish (Receiver):** "Receiver" bosilganda ochiq xonalar **dumaloq** shaklda chiqadi (nomi, a'zolar soni, 🔒 qulflangan / ✋ qabul qilish rejimi, efirdagi xonada yashil halqa). Qidiruv nom yoki kod bo'yicha ishlaydi; 6 xonali kod yozilsa to'g'ridan-to'g'ri tanlanadi. Dumaloqni bosing → ismingizni yozing → "Qo'shilish". Kod bilan kirish ham saqlangan.
  Ro'yxat 3 soniyada yangilanadi. Transmitter **☰ Funksiyalar → Ruxsatlar → 🌐 Ro'yxatda ko'rinsin** bilan xonani ro'yxatdan yashirishi mumkin (u holda faqat kod bilan kiriladi).
- **🎮 O'yinlar tabi:** Mikrofon yonida. **🎰 Luck o'yini** shu yerga ko'chirildi (☰ menyudan olib tashlandi).
- **Tarmoq / ping:** TCP_NODELAY, WebSocket siqishi o'chirildi, TCP keep-alive, ulanish navbati 1024; yangi qurilmada soat sinxroni 12 ta zich o'lchov bilan tezroq aniqlanadi. 300 ta bir vaqtdagi ulanishda ping: p50 ≈ 2 ms, p99 ≈ 23 ms (lokal test).

## v16: 🎮 O'yinlar — 3 ta yangi o'yin

**🎮 O'yinlar** tabida Luck bilan birga (hammasi serverda hisoblanadi, hamma qurilmada bir vaqtda ochiladi, 🔔 bilan ovoz o'chadi, o'yin paytida kirgan ham qo'shiladi):

- **⚡ Tez bos:** hammada ekran qizil; qachon yashil bo'lishi noma'lum (3.5–8 s). Yashil bo'lganda eng tez bosgan yutadi, **erta bosgan chiqib ketadi**. Vaqt serverda ms bilan o'lchanadi (ping'ning yarmi hisobga olinadi).
- **👆 Tap-poyga:** 3-2-1 sanoqdan keyin 10/15/20/30 soniya davomida eng ko'p bosgan yutadi. Yuqori 5 talik jonli reyting; avto-kliker himoyasi (soniyasiga ~16 bosishdan ortig'i hisoblanmaydi).
- **🔢 Raqamni top:** server 1–10 / 50 / 100 / 1000 oralig'ida yashirin son o'ylaydi; hamma taxmin yuboradi (vaqt tugamaguncha o'zgartirish mumkin). Aniq yoki eng yaqin topgan yutadi, teng bo'lsa tezroq yuborgan.

Har bir o'yin oxirida reyting (top 8), receiverga o'z o'rni, 1-o'rinda konfetti + ovoz. Transmitterda "🔄 Yana o'ynash" va "✖ Yopish" tugmalari bor.

## v17: 🙈 Yashirinmoqchoq va 🔼 Kichik · Katta (🎮 O'yinlar tabida)

Ikkalasida ham **Transmitter ishtirok eta oladi**. Hisob-kitob va yashirin son **serverda** turadi (qurilmaga faqat o'ziga tegishli holat yuboriladi).

**🙈 Yashirinmoqchoq** (odamlar haqiqiy joyda yashirinadi — ilova hakam va soat vazifasini bajaradi):
- **Qidiruvchi kim?** 🙋 Transmitter o'zi · 👆 Transmitter receiverlardan birini tanlaydi · 🎲 tasodifiy. «Transmitter ham ishtirok etsin» yoqilsa, tasodifiy tanlovda va yashirinuvchilar orasida Transmitter ham bo'ladi.
- **Zona (yashirinish vaqti):** 30 s – 3 daqiqa. Qidiruvchining ekrani qorong'i («Ko'zingizni yuming!»), qolganlar «Yashirining!» va teskari sanoqni ko'radi. Transmitter «⏭ Qidirishni hozir boshlash» bilan vaqtni qisqartira oladi.
- **Qidirish:** 2–15 daqiqa yoki cheksiz. Qidiruvchida yashirinuvchilar ro'yxati va har biriga **✅ Topdim** tugmasi (xato bosilsa ↩). Yashiringan odam o'zi ham **😅 Topildim** bosa oladi. Transmitter hakam sifatida istalganini belgilay oladi.
- **Tugash:** hamma topilsa yoki vaqt tugasa. Hamma topilsa qidiruvchi yutadi; aks holda topilmaganlar yutadi.

**🔼 Kichik · Katta:**
- **Son egasi kim?** Transmitter o'zi / tanlangan receiver / tasodifiy. Son egasi 1…10/50/100/1000 oralig'ida yashirin son yozadi (90 soniyada yozmasa — tasodifiy son).
- Qolganlar (va ixtiyoriy ravishda Transmitter) taxmin qiladi; har taxminga **⬆ Katta** (son bundan kattaroq) yoki **⬇ Kichik** javobi avtomatik beriladi. Hamma ko'radigan jonli lenta va torayib boruvchi oraliq bor.
- Sonni birinchi topgan yutadi; vaqt tugasa son egasi yutadi. Taxminlar orasida 0,6 s pauza bor. Yashirin sonni faqat son egasi ko'radi.

Bitta xonada bir vaqtda faqat bitta mini-o'yin ketadi. Kechroq kirgan yoki qayta ulangan qurilma o'yinni tomosha qiladi.

## v18: 📎 Fayldan AI quiz (JPG, PNG, HEIC, PDF · 60 MB gacha)

**🤖 AI Quiz** bo'limida «📎 Fayldan quiz» maydoni paydo bo'ldi. Transmitter rasm yoki PDF yuklaydi — AI savollarni **faqat shu fayl mazmunidan** tuzadi
(skanerlangan sahifa, kitob rasmi, konspekt, jadval, diagramma — hammasi o'qiladi), keyin o'yin oddiy AI viktorina kabi boshlanadi.

- **Formatlar:** JPG, PNG, HEIC/HEIF (iPhone rasmlari), PDF. Fayl turi nomiga emas, **haqiqiy mazmuniga** qarab tekshiriladi (boshqa fayl `.pdf` deb nomlansa ham rad etiladi).
- **Hajm:** 60 MB gacha (`AI_FILE_MB` bilan o'zgaradi). Yuklash foizi ko'rinadi; fayl tashlab (drag & drop) ham yuklanadi.
- **Sozlamalar umumiy:** savollar soni (3–30), har savolga vaqt, til, qiyinlik, Kahoot rejimi, avtomatik rejim, «Transmitter ham o'ynasin» — hammasi avvalgidek ishlaydi.
  «Mavzu» maydoniga izoh yozsangiz (masalan «faqat 2-bob» yoki «sanalar haqida»), AI shunga e'tibor beradi.
- **Faqat Gemini:** Groq PDF va HEIC o'qiy olmaydi, shuning uchun fayl rejimida avtomatik Gemini ishlatiladi (`GEMINI_API_KEY` kerak).
- **Qanday ishlaydi:** fayl ≤ 12 MB bo'lsa so'rov ichida yuboriladi, kattasi Gemini Files API orqali yuklanadi va ishlatilgach o'chiriladi.
  Quiz boshlangach fayl serverdan ham o'chadi (xona yopilganda ham). Fayl mazmunida savol uchun material kam bo'lsa, so'ralganidan kamroq savol chiqishi mumkin.
- **Xavfsizlik:** yuklash faqat Transmitter kaliti bilan; fayl `/files` orqali hech kimga berilmaydi.

| O'zgaruvchi | Standart | Ma'no |
|---|---|---|
| `AI_FILE_MB` | 60 | Quiz uchun fayl hajmi chegarasi (MB) |
| `AI_FILE_TIMEOUT_MS` | 100000 | Fayl bilan bitta AI urinishi uchun kutish |
| `AI_FILE_TOTAL_MS` | 170000 | Fayl bilan jami kutish chegarasi |
| `GEMINI_BASE_URL` | Google API | Sinov uchun Gemini manzilini almashtirish (ixtiyoriy) |

### v18.1: tezroq fayl o'qish, sifat, sinxron tuzatishlari

**Fayldan quiz — tezlik va sifat**
- Fayl yuklanishi bilan server uni AI ga tayyorlaydi (katta PDF Gemini'ga bir marta yuklanadi va qayta ishlatiladi) va savollarni **fonda oldindan tuzadi**.
  Sozlamalar (soni, til, qiyinlik, izoh) o'zgarsa, fonda qayta tayyorlanadi; «⚡ Savollar tayyor» chiqsa, «Boshlash» darhol ishlaydi.
- Katta rasmlar (>1,5 MB) brauzerda 2200 px gacha kichraytiriladi — yuklash va o'qish bir necha barobar tez, matn baribir aniq o'qiladi.
- 12 tadan ko'p savolda AI so'rovlari parallel ketadi (hujjatning turli qismlaridan), shuning uchun savollar xilma-xil va tez.
- Sifat: har savol uchun AI fayldagi **dalilni** (`source`) yozadi (dalil topolmasa savolni tashlaydi), ishonarli noto'g'ri variantlar fayldagi boshqa tushunchalardan olinadi, mayda tafsilotlar so'ralmaydi.

**Qurilmalar orasidagi sinxron (alohida/aks-sado ovoz)**
- Ijro boshlanishida `play()` kechikishi (50–400 ms) endi birinchi 4 soniyada darhol tuzatiladi (avval sekin tezlik o'zgarishi bilan tuzatilar, shu sabab farq uzoq qolardi).
- Qattiq tuzatish chegaralari kichraytirildi: audio 0,45 → 0,2 s, video 0,9 → 0,4 s. **Transmitter videosi** avval umuman tuzatilmas (2 s gacha farq mumkin edi) — endi u ham receiverlar bilan bir xil vaqtga tortiladi.
- Tuzatish (surish)dan keyin audio endi ~100 ms «oldinga ketib qolmaydi» (avval ~165 ms ortiqcha oldinda qolardi).
- iOS/Safari kabi `currentTime` qo'pol yangilanadigan brauzerlarda o'lchash interpolyatsiya bilan silliqlanadi.
- Bluetooth/dinamik kechikishi baribir qurilmaga bog'liq: farq qolsa, **Sinxron test signali** va ±500 ms tuzatma slayderidan foydalaning.

## Viktorina: rasmlar bilan ishlash

- **Rasmlarni ketma-ket yuklash** — Viktorina studiyasida `🖼 Rasmlarni ketma-ket yuklash` tugmasi: kompyuterdan bir nechta rasm tanlang, ular **1-rasm → 1-savol, 2-rasm → 2-savol …** tartibida biriktiriladi. Boshlanadigan savol raqamini, fayl nomi bo'yicha tartiblashni (1, 2, … 10) va mavjud rasmlarni almashtirishni sozlash mumkin; oldindan ko'rish oynasida rasmlarni ▲▼ bilan surish yoki ✕ bilan olib tashlash mumkin. Xuddi shu tugma Word/Excel/CSV import oynasida ham bor.
- **O'yin paytida rasmni kattalashtirish / kichraytirish** — rasm ustidagi `−` / `+` tugmalari rasm o'lchamini joyida o'zgartiradi. Rasmni bosish (yoki `⛶`) to'liq ekranli ko'rgichni ochadi: `−` / `+`, sichqoncha g'ildiragi, ikki barmoq bilan yaqinlashtirish, ikki marta bosish, surish; `Esc` yoki ✕ bilan yopiladi.
