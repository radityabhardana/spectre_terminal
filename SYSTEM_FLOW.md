# Alur Sistem Analisis Polymarket (System Flow)

Dokumen ini memetakan bagaimana sistem pintar ini memproses sebuah tautan Polymarket, dari pesan Telegram hingga menghasilkan analisis berbobot ala pelatih profesional.

---

## Tahap 1: Inisiasi (Telegram Bot)
**Modul Utama:** `src/index.js`
1. Pengguna mengirimkan perintah ke Telegram, contoh: `/analyze https://polymarket.com/event/bitcoin-100k`.
2. Bot mengenali perintah, mengirimkan balasan *"Sedang memproses..."*, lalu mengekstrak *slug* (ID) dari tautan tersebut.

---

## Tahap 2: Pengumpulan Data Inti (Polymarket Gamma API)
**Modul Utama:** `src/polymarket.js`
1. **Detail Market:** Mengambil data spesifik dari *event* (Judul, Aturan Resolusi, Deskripsi).
2. **Orderbook (Buku Pesanan):** Mengecek likuiditas, *spread* (selisih bid/ask), dan harga saat ini (probabilitas yang dipercayai pasar).
3. **Data Terkait:** Mengambil market lain dalam *event* yang sama jika market tersebut berbentuk grup (misal: "Siapa Presiden AS?" ada banyak nama).

---

## Tahap 3: Pembuatan Konteks & Scraping Latar Belakang (Research Hub)
**Modul Utama:** `src/research.js`, `src/ufc.js`
Sistem akan membaca teks judul market dan menentukan *jenis market* (Crypto/Makro/UFC), lalu membangun "Konteks Riset" di latar belakang:

- **Jalur UFC (Olahraga MMA):**
  - Bot mendeteksi nama atau nama belakang petarung.
  - Mengambil statistik kemenangan/fisik historis petarung dari *Kaggle Dataset* lokal yang termuat di RAM.
  - Melakukan *Scraping DuckDuckGo* ke situs tepercaya (MMAFighting, Sherdog, ESPN) untuk mencari berita `training camp`, `injury`, atau `mental`.

- **Jalur Crypto & Makro:**
  - Bot mendeteksi nama koin (BTC, ETH, dll).
  - Mengambil data harga, volume, dan *futures funding rate* dari Binance.
  - Mengambil sentimen global (*Fear & Greed Index*).
  - Mengambil data DefiLlama (TVL, Stablecoin Supply).
  - Melakukan **Premium News Scraping** mem-*bypass paywall* ke *NYTimes*, *Bloomberg*, *CoinDesk*, dsb., untuk mendapatkan ringkasan berita terhangat.

Seluruh data dari tahapan ini digabungkan, disaring, dan **dikompresi menjadi ringkasan** (agar hemat token) ke dalam satu blok JSON bernama `EXTERNAL RESEARCH CONTEXT`.

---

## Tahap 4: Filter Mekanis & Deteksi Underdog (Scoring)
**Modul Utama:** `src/scoring.js`
Sebelum dilempar ke AI Qwen, sistem menjalankan filter *robot* tradisional:
1. Memastikan likuiditas cukup (*Spread Risk*, volume).
2. Mengecek apakah probabilitas market terlalu murah (≤ 25%). Jika iya, dan kondisi likuiditas bagus, sistem mengaktifkan peringatan mekanis potensi **Underdog**.

---

## Tahap 5: Analisis Qwen (Multi-Role Pipeline)
**Modul Utama:** `src/qwen.js`
Inilah otak utama dari bot Anda. Konteks yang sudah dikompresi dikirim ke Qwen melalui 3 rantai pemikiran (Chain-of-Thought):

1. **Scout (Qwen Flash / Model Cepat):**
   - Bertugas sebagai pengintai. Menganalisis teks aturan resolusi (kapan market dianggap sah batal/selesai), serta mendeteksi jebakan bahasa.
2. **Analyst (Qwen Plus / Model Menengah):**
   - Bertugas membedah `EXTERNAL RESEARCH CONTEXT` yang kita siapkan di Tahap 3. 
   - Membaca berita Premium, statistik Binance, atau kondisi fisik petarung UFC, lalu membuat *Bull/Bear case* (skenario pro & kontra).
3. **Final Judge (Qwen Max / Model Terkuat):**
   - Membaca hasil *Scout* dan *Analyst*.
   - Mengambil keputusan final. Menentukan apakah market ini aman untuk dimasuki (*Entry*), harus dipantau (*Watchlist*), atau bahkan memiliki keunggulan tak terlihat yang diremehkan pasar sehingga layak dicap **`HIGH RISK UNDERDOG`**.

---

## Tahap 6: Eksekusi & Laporan (Telegram & Web UI)
1. Laporan akhir dari Qwen (yang berisi *Verdict*, Ringkasan Riset, Evaluasi Aturan, dan Evaluasi Fundamental) dikirim kembali ke Telegram sebagai pesan panjang yang mudah dibaca.
2. Seluruh hasil analisis ini dicatat (*log*) di dalam folder `data/` sehingga Anda bisa mengakses ulang rekam jejak risetnya melalui halaman **Web UI** Anda (tombol *History*).

---

## Tahap 7: Shadow Bet System (Simulasi Otomatis)
**Modul Utama:** `src/shadow.js`, `src/storage.js`, `public/app.js`
Shadow Bet adalah fitur *paper trading* otomatis yang terintegrasi di Web UI. Fitur ini memungkinkan pengguna untuk mensimulasikan taruhan secara otomatis menggunakan analisis AI tanpa modal sungguhan. 

Berikut adalah rincian fitur dan cara kerjanya:

1. **Panel Konfigurasi & Preset UI:**
   - Terletak di *topbar* antarmuka web, panel ini mengatur parameter bot.
   - Menyediakan **Strategy Preset** seperti:
     - **Safe 1%**: Risiko rendah, modal taruhan diatur sebesar 1% dari saldo per market. Target bet lebih sedikit dengan waktu lebih longgar.
     - **Aggro 5%**: Risiko lebih tinggi, bertaruh 5% dari saldo per market untuk mencapai target bet dengan sangat cepat.
     - **High Risk**: Risiko sangat tinggi (Degen), cocok untuk tes dengan modal sangat kecil (contoh: modal $13, taruhan 25% dari saldo per bet) dengan durasi super cepat.
     - **Custom**: Pengaturan bebas di mana pengguna bisa mengatur Modal (Capital), Target Taruhan, Durasi Maksimal, serta Manajemen Keuangan (Fixed $ atau Persentase).

2. **Auto-Pilot Scanner & Eksekusi:**
   - Ketika *Autopilot* dinyalakan, bot akan terus-menerus mencari *market* yang sebentar lagi berakhir (*ending soon*).
   - Bot melewati batasan anti-spam (rate-limiter) telegram sehingga bisa langsung menganalisis market secepat mungkin.
   - Jika putusan AI adalah **ENTRY** atau **HIGH RISK UNDERDOG**, bot otomatis membuka posisi (YES/NO) berdasarkan saldo *virtual* yang tersisa, asalkan harga *entry* valid.

3. **Background Resolver (PnL Tracker):**
   - Terdapat mekanisme di latar belakang yang aktif secara otomatis ketika ada *bet* yang terbuka (*pending*).
   - Loop ini secara teratur mengecek API Polymarket untuk melihat apakah sebuah ajang/pertanyaan sudah resmi ditutup dan memiliki token pemenang mutlak (harga token mencapai ~1c atau ~0c).
   - Resolver kemudian otomatis merekapitulasi Profit & Loss (PnL), menambahkannya ke saldo utama jika tebakan benar, atau memotong modal jika kalah. Jika sebuah taruhan tidak pernah terselesaikan lebih dari 7 hari, modal akan dikembalikan (*refund*).

4. **Stats Dashboard (Live Monitoring):**
   - Menampilkan angka secara real-time seperti:
     - **Win Rate**: Persentase tebakan AI yang benar.
     - **PnL**: Total keuntungan bersih atau kerugian.
     - **ROI**: Persentase kembalian atas investasi yang sudah ditaruhkan.
     - **W/L Ratio**: Angka absolut perbandingan menang dan kalah. 
   - **Tab Bets & Logs**: Menyediakan transparansi penuh atas posisi apa yang masih menahan saldo (Open Positions), hasil yang sudah di-*resolve*, beserta log tekstual interaksi bot langkah demi langkah.
   - Indikator **PnL Pill** secara konstan memonitor uang virtual Anda langsung di sebelah panel saldo tanpa perlu membuka menu.
