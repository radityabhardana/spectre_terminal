# 🎯 RAZOR BOT — Arsitektur Sniper V2 (Short Market)
*Dokumentasi Resmi & Terkini (Juli 2026)*

> **Fokus Utama:** Market Crypto berdurasi pendek (5 menit, 15 menit, 1 jam, 4 jam) seperti "Bitcoin Up or Down".
> **Filosofi:** Mengandalkan kecepatan data (*low latency*), probabilitas kerumunan (*crowd wisdom*), dan kalkulasi matematika (*Expected Value*), tanpa membuang waktu membaca sentimen berita.

---

## ⚡ 1. Gambaran Umum Pipeline
Untuk pasar berdurasi pendek, bot otomatis mengabaikan mode *Hedge Fund* (analisis berita fundamental lambat) dan langsung beralih ke **Sniper V2 Pipeline**. 

Sniper V2 adalah sistem kuantitatif murni. Ia menggabungkan data aliran dana (*orderflow*) dari bursa berjangka (Binance Futures), pembacaan momentum harga instan, dan kebijaksanaan massa dari Polymarket itu sendiri. Data-data ini kemudian disuapkan ke AI (Qwen) yang di- *prompt* khusus untuk bertindak sebagai **Quant Trader / Risk Manager** berdarah dingin.

---

## 📊 2. Tiga Pilar Data (Sumber Inteligensi)

Sistem mengambil data secara paralel dari 3 sumber utama dalam hitungan milidetik:

### A. Polymarket & Pyth Oracle (Real-Time)
- **Target Price (Price to Beat):** Diekstrak otomatis dari judul market (misal: "Bitcoin $65,100").
- **Pyth Oracle:** Menarik harga aset detik ini juga dari jaringan blockchain Pyth (`hermes.pyth.network`) untuk menghitung seberapa jauh jarak harga saat ini dari *Target Price* (Distance).
- **Market Probability (Crowd Wisdom):** Membaca persentase keyakinan trader di Polymarket (contoh: 64% orang bertaruh DOWN). Angka ini sangat vital untuk sistem **Scout Override**.

### B. Binance Futures (REST API)
- **RSI, MACD & ATR-14 (Klines):** Seluruh data teknikal kini murni ditarik dari *candlestick* **Binance Futures** (`/fapi/v1`). Bot mengkalkulasi Average True Range (ATR) untuk memahami volatilitas normal koin saat ini. Jarak harga (*Distance*) ke target Polymarket tidak lagi dilihat sebagai angka absolut USD (misal $50), melainkan dikonversi menjadi **Jarak Relatif** (contoh: *1.5x ATR*) agar AI memahami tingkat kemustahilan penembusan harga.
- **Volume Momentum:** Mengukur lonjakan volume mendadak dalam 10 *candle* terakhir untuk mendeteksi *Liquidation Squeeze*.
- **Long/Short Account Ratio (Futures):** Membaca rasio posisi *trader* ritel di Binance Futures. 
  > 🛡️ **Symbol-Specific Cache:** Khusus untuk data Long/Short Ratio ini, bot menyimpannya di memori (*cache*) selama **30 detik** yang dikunci secara spesifik per koin (misal: `cache['BTCUSDT']`). Ini menjamin keamanan antrean massal dari *Rate Limit* Binance tanpa risiko percampuran data antar koin.

### C. WebSocket Stream (Jalur Cepat Tanpa Putus)
- **Orderbook Depth:** Membaca ketebalan tembok uang (Bid/Ask) di Binance hingga 20 tingkat kedalaman untuk melihat apakah ada *bandar* yang menahan harga.
- **Liquidations:** Merekam *trader* yang bangkrut/terlikuidasi dalam 15 menit terakhir. Rentetan likuidasi sering kali memicu pergerakan harga tajam ke satu arah.

---

## 🤖 3. Mesin Pengambil Keputusan (Decision Engine)

Setelah semua data di atas terkumpul, sistem melewatinya ke dua lapis filter pengambilan keputusan:

### Lapis 1: Mechanical Scout Override (Filter Crowd & Squeeze)
Sebelum data dikirim ke AI, sistem melakukan pemeriksaan mandiri terhadap sentimen massa Polymarket.
- **Threshold 62 / 38 & Anti-Squeeze:** Jika probabilitas Polymarket sangat condong (≥ 62% atau ≤ 38%) **DAN** tidak ada lonjakan volume ekstrem di Binance Futures (*Volume Momentum < 2.0x*), bot akan **MENGABAIKAN AI** dan langsung `PLAY` mengikuti kerumunan.
- **Pembatalan Override:** Jika terdeteksi *Squeeze* raksasa di Binance (*Volume Momentum > 2.0x*), bot tahu bahwa bandar sedang bergerak agresif. *Scout Override* dibatalkan demi keamanan dan keputusan sepenuhnya dikembalikan ke AI.

### Lapis 2: Hybrid Weighting & Backend EV Math (Anti-Probability Hallucination)
Untuk mencegah AI mengarang angka probabilitas acak secara sembrono (halusinasi numerik), sistem menerapkan **Hybrid Weighting**:
1. **JS Mechanical Base Probability:** Backend JS menghitung probabilitas dasar (*Base Probability*) secara mekanis (menggunakan normal CDF approximation pada Jarak Relatif `Distance/ATR`, ditambah bobot tren RSI/MACD, tembok orderbook, dan squeeze likuidasi).
2. **AI Heuristic Adjuster (Buff/Nerf):** Qwen disuapi angka *Base Probability* ini, dan ia hanya bertugas bertindak sebagai hakim heuristik untuk memberikan penyesuaian **BUFF (+1% s.d. +15%)** atau **NERF (-1% s.d. -15%)** berdasarkan anomali orderbook/likuidasi non-numerik yang ia amati. Ini membatasi kisaran output agar tetap logis dan terkalibrasi.
3. **Backend JS Calculator (EV Safety Buffer):** Setelah Qwen menetapkan *Fair Probability* hasil penyesuaian, backend menghitung `EV = (Fair Probability / 100) - Harga Polymarket`.
4. **Fail-Safe Buffer (+2 cents):** Jika nilai matematika EV yang dihasilkan kurang dari atau sama dengan **0.02 (2 sen)**, rekomendasi otomatis dibatalkan secara paksa menjadi **AVOID**. Hal ini memangkas eksekusi pada market dengan margin edge yang terlalu tipis.

---

## 🚀 4. Alur Eksekusi Antrean (Queue System)

1. User memasukkan market ke *Queue* (bisa satuan atau *Bulk Add*).
2. Bot memproses antrean satu per satu.
3. Bot mendeteksi format *Short Market*. Fitur *Scraping News* (Pencarian Berita Premium) **dimatikan secara otomatis** untuk menghemat waktu dan beban API.
4. Bot menarik data Pyth, Binance, dan Polymarket.
5. Evaluasi selesai dalam waktu rata-rata **~36 detik** per market.
6. Hasilnya dimunculkan dalam bentuk Kartu Ringkasan (Market Summary) yang kini dilengkapi label **"Waktu Analisis"**, sehingga Anda tahu persis kapan evaluasi itu dilakukan.
7. Bot melanjutkan ke antrean berikutnya.

---

## 🛠️ Ringkasan Optimasi Terbaru (Paska-Audit 17 Juli 2026)
Arsitektur Sniper V2 kini lebih stabil, presisi, dan kebal dari halusinasi data berkat penambalan 5 celah arsitektural fatal:
- ✅ **AI Math Offloading & Hybrid Weighting (Fail-Safe EV & Base Prob):** Qwen dibebastugaskan dari menghitung *Expected Value*, perhitungan dipindah ke JavaScript murni dengan *override* paksa `AVOID` jika EV <= 0.02 (2 sen). Base Probability dihitung mekanis oleh JS lalu disesuaikan (buff/nerf) heuristik oleh Qwen untuk mencegah halusinasi probabilitas acak.
- ✅ **Anti-Squeeze Scout Override:** *Scout Override* kini dikondisikan pada *Volume Momentum* (< 2.0x). Bot tidak lagi mati konyol akibat buta terhadap *Squeeze* mendadak di Binance.
- ✅ **Penyelarasan Spot ke Futures:** Seluruh indikator Klines (RSI/MACD) kini menggunakan data API Futures agar sinkron 100% dengan Oracle Pyth.
- ✅ **Symbol-Specific Cache:** *Cache Long/Short Ratio* 30 detik kini dikunci menggunakan *Symbol/Ticker*. Aman sepenuhnya untuk eksekusi antrean massal berbagai koin.
- ✅ **Relativitas Jarak (ATR-14):** Kalkulasi Jarak (*Distance*) ke target kini menggunakan rasio absolut deviasi *Average True Range* (*Distance/ATR*), memastikan AI paham mana tembok tipis dan mana tembok raksasa berdasarkan volatilitas terkini koin tersebut.
