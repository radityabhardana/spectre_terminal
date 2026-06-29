# 🎯 RAZOR BOT — Alur Short Market (Sniper V2)
*Last Updated: 29 Juni 2026*

> **Project:** `c:\ALL\Razor Bot\`  
> **Fokus Utama:** Market jangka pendek Crypto (BTC/ETH/DOGE Up/Down 5m, 15m, 1h)

---

## ⚡ Gambaran Arsitektur (Sniper V2)

Berbeda dengan market reguler yang menggunakan 3-Stage AI Pipeline, **Short Market** menggunakan sistem **Sniper V2** yang berfokus pada kecepatan dan data kuantitatif real-time.

Pipeline Sniper V2 mengeliminasi analisis berita atau fundamental yang lambat, dan sepenuhnya bergantung pada aliran dana (orderflow), likuiditas, dan perhitungan *Expected Value* (EV).

---

## 📁 File Inti Short Market

| File | Peran |
|---|---|
| `src/short_condition.js` | Otak utama evaluasi. Menggabungkan data Pyth, Binance, dan memanggil Qwen. |
| `src/binance_ws.js` | Mengelola WebSocket real-time ke Binance untuk data *Orderbook Depth* (20-level) & *Liquidations* (15m). |
| `src/sniffer.js` | *Live Tracker*. Terkoneksi ke WebSocket Polymarket untuk mendeteksi perubahan probabilitas dan market baru secepat kilat. |
| `src/qwen.js` | Fungsi `askQwenShortCondition()`. Menggunakan model tertinggi (Risk Manager) untuk hitung EV matematis. |
| `public/app.js` | Web UI khusus. Termasuk fitur *Live Tracker UI*, *Queue System* (maks 50), dan *Bulk Add Manager*. |
| `src/polymarket.js` | Fetcher market aktif dengan *History Filter* (membuang market yang sudah tutup > 15 menit). |

---

## 🔄 Alur Eksekusi (Sniper V2 Pipeline)

Ketika sebuah Short Market dianalisis (baik otomatis dari *Queue* maupun manual via `/shortcondition`):

### 1. Data Fetching (Real-Time)
Bot tidak lagi mengandalkan REST API yang lambat untuk orderflow. Data diambil instan dari memory yang di-update oleh WebSocket:
- **Oracle Price:** Harga detik ini dari Pyth Network (`hermes.pyth.network`).
- **Target Price:** Diekstrak dari teks pertanyaan (contoh: "Bitcoin Up or Down $60,000" → Target = 60000).
- **Distance:** Jarak antara Harga Oracle dengan Target Price.
- **Binance Depth:** Rasio Tembok Bid/Ask dari *20-level Orderbook* (`src/binance_ws.js`).
- **Binance Liquidations:** Total likuidasi Long vs Short dalam 15 menit terakhir.
- **Futures Positioning:** Long/Short ratio dari Binance Futures.

### 2. Expected Value (EV) Math & Qwen Evaluation (`askQwenShortCondition`)
Prompt khusus dikirim ke AI (Role: Quant Trader) dengan paksaan berhitung kuantitatif:
1. **Distance Check:** Seberapa dekat harga saat ini dengan target?
2. **Orderbook Flow:** Apakah ada tembok penahan di Binance?
3. **Crowd Wisdom:** Berapa harga token Polymarket saat ini?
4. **Momentum:** Arah tren likuidasi (Squeeze Up/Down).
5. **EV Math:** 
   `EV = (Estimated Fair Probability / 100) - Harga Token Polymarket`

**Aturan Mutlak AI:**
- JANGAN menebak *reversal* (pembalikan arah). Follow the trend!
- Jika EV Negatif (≤ 0), WAJIB `AVOID` atau `SKIP`.
- Output berupa JSON dengan `verdict` (PLAY/AVOID), `direction`, `confidence`, dan `key_signals`.

### 3. Eksekusi Web UI & Queue System (`app.js`)
- UI Web memiliki sistem Antrean (Queue) yang bisa menampung hingga 50 market.
- Terdapat **Bulk Add Manager** yang memungkinkan user menyuntikkan puluhan market ke antrean mulai dari jam tayang tertentu (Skip/Offset).
- Setiap selesai 1 analisis, UI memainkan notifikasi synthesizer dinamis dan melanjutkan ke market berikutnya dalam antrean (delay antar market).
- Hasil akhir dirender ke log history UI (menampilkan *Value Candidate* atau *Skip* beserta alasan Orderbook/Flow Momentum).

---

## 💾 Short Condition Memory (AI Learning)

AI memiliki kemampuan "mengingat" kondisi masa lalu. 
- Hasil evaluasi (Condition, Direction, Confidence, Reason) disimpan ke `short_condition_history.json`.
- Setiap kali AI dipanggil, 3 riwayat terbaru disisipkan ke dalam konteks (*AI LEARNING MEMORY*).
- Tujuannya agar AI bisa merefleksikan apakah pola *choppy* atau *trending* sebelumnya berhasil atau gagal.

---

## 🔒 Proteksi Timeout & Relevansi Waktu

Sistem dirancang untuk sangat sensitif terhadap waktu:
- Market yang sisa waktunya kurang dari 1.5 menit (90 detik) saat akan dieksekusi di antrean bakal otomatis **DIBATALKAN** (terlalu berisiko/telat).
- Market yang sudah ditutup di atas 15 menit tidak akan ditarik lagi dari API Polymarket untuk menjaga UI tetap bersih dan relevan.

---
*Dokumentasi ini akurat berdasarkan arsitektur "Razor Bot" per 29 Juni 2026, menggantikan flow lama dari 16 Juni.*
