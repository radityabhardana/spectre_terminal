# 🎯 RAZOR BOT — Alur Sistem Analisis Lengkap

> **Project:** `c:\Users\USER\OneDrive\Dokumen\razor-polymarket-bot\`  
> **Versi ini TIDAK memiliki:** short_condition.js, binance_ws.js, sniffer.js  
> **File Utama:** `src/index.js`, `src/qwen.js`, `src/scoring.js`, `src/research.js`

---

## ⚡ Gambaran Arsitektur

Bot ini adalah **Telegram + Web bot** untuk menganalisis market Polymarket.  
Alur analisis utamanya menggunakan pipeline AI **3 tahap (Fast Scout → Analyst → Final Judge)**.

**Catatan penting:** Versi ini TIDAK punya sistem khusus short market (Up/Down 5m).  
Semua market — termasuk market crypto Up/Down — diproses lewat pipeline yang **sama**: 3-stage Qwen multi-role pipeline.

---

## 📁 Struktur File Aktif

| File | Peran |
|---|---|
| `src/index.js` | Entry point, router command Telegram, orchestrator utama |
| `src/qwen.js` | Engine AI multi-role: `askQwen()` + `askQwenEvent()` |
| `src/scoring.js` | Mechanical scoring dari CLOB orderbook |
| `src/research.js` | Fetch data eksternal: crypto klines, long/short ratio, DeFiLlama, dan Fear&Greed |
| `src/polymarket.js` | API client Polymarket (Gamma + CLOB) |
| `src/format.js` | Formatter output Telegram/web |
| `src/config.js` | Config dari .env |
| `src/storage.js` | Simpan log analisis, cache, data |
| `src/rate-limit.js` | Anti-spam cooldown |
| `src/telegram.js` | Telegram Bot wrapper |
| `src/web.js` | Web UI (port 8788) |

---

## 🔄 Alur Lengkap Per-Detik: `/analyze <market>`

```
User kirim /analyze <url/id/keyword>
     │
     ▼
[1] parseCommand() — Parsing input
     │  Jika URL/link → /analyze langsung
     │  Jika angka (1234) → dianggap Market ID
     │  Jika teks → keyword search
     ▼
[2] Anti-spam guard (rate-limit.js)
     │  Command cooldown: 3000ms
     │  Qwen command cooldown: 45000ms
     │  Duplicate cooldown: 15000ms
     │  ❌ Blocked → "Tunggu X detik"
     │  ✅ Allowed → lanjut
     ▼
[3] resolveAnalyzeInput() — Cari market
     │  URL → parsePolymarketLink() → getMarketsFromPolymarketLink()
     │  Market ID → getMarketById()
     │  Keyword → searchMarkets(keyword, 1)
     │
     │  Jika URL event dengan >1 market:
     │    → createEventSession() (simpan di RAM, TTL 30 menit)
     │    → Tampilkan Event Hub Keyboard (Quick Scan, AI Best, Top 3, Analyze All)
     │    ← STOP, tunggu user klik pilihan
     ▼
[4] deepAnalyzeMarket() — Pipeline analisis single market
     │
     ├─── [4a] scoreOneMarket() — Mechanical scoring
     │         pickYesNoTokens(market) → ambil token YES/NO
     │         getOrderBook(yesTokenId) → fetch CLOB orderbook
     │         scoreMarket({ market, yesBook }) → hitung:
     │           - bestBid, bestAsk, spread, spreadPercent
     │           - marketProbability (midpoint CLOB × 100)
     │           - orderbookImbalance = bidVol / (bidVol + askVol) × 100
     │           - liquidityScore, spreadScore, confidenceScore
     │           - blockers (market closed, spread tinggi, dll)
     │           - verdict mekanis: SKIP/WATCHLIST/VALUE CANDIDATE/HIGH RISK UNDERDOG
     │
     ├─── [4b] buildResearchContext() — Riset eksternal
     │         Deteksi tipe market dari question teks:
     │         → Crypto? → fetch klines, RSI, long/short ratio, Fear&Greed, DeFiLlama
     │         → Lainnya (politik, makro, olahraga)? → search snippets saja
     │         (semua pakai cache: crypto 10s, fundamental 900s, news 900s)
     │
     └─── [4c] askQwen() — 3-Stage AI Pipeline
               (detail di bawah)
     │
     ▼
[5] Simpan log ke storage
     appendAnalysisLog(query, marketId, score, qwenResult)
     addAnalyzedEvent(marketId, prediction, analysis)
     ▼
[6] directionSignal(score) → finalPrediction
     │  score.edgeScore > 0 → UP / DOWN (tergantung arah)
     │  Tidak ada edge → NETRAL → "="
     ▼
[7] formatAnalysis() → Format markdown Telegram
     ▼
[8] Return ke user + waktu proses (detik)
```

---

## 🧠 3-Stage Qwen AI Pipeline (Detail `askQwen()`)

Setiap analisis single market melewati **3 stage AI** secara berurutan:

### Stage 1: Fast Scout (`QWEN_FAST_MODEL` = qwen3.6-flash)
```
Tugas: Klasifikasi market cepat sebelum analisis dalam
Input: market data + orderbook + SCORING AWAL + research context
Output JSON:
  - task_type: "single_market_analysis"
  - complexity: "simple/medium/complex"
  - main_question: inti pertanyaan market
  - market_type: "politik/makro/crypto/sports/lainnya"
  - risk_focus: [maks 4 risiko utama yang perlu dicek]
  - missing_data: [maks 4 data yang masih kurang]
  - recommended_depth: "fast/standard/deep"

Config: temperature=0, max_tokens=10% dari QWEN_MAX_TOKENS
```

### Stage 2: Analyst Review (`QWEN_ANALYST_MODEL` = qwen3.7-plus)
```
Tugas: Review risiko secara konservatif, bukan final judge
Input: sharedContext + Scout result
Output JSON:
  - rules_summary: aturan resolusi market
  - data_quality: kualitas data tersedia
  - bullish_case: [maks 3 poin mendukung YES]
  - bearish_case: [maks 3 poin mendukung NO]
  - risks: { liquidity, spread, resolution, catalyst }
  - technical_momentum: arah tren chart + long/short ratio
  - missing_data: [maks 4]
  - preliminary_verdict: SKIP/WATCHLIST/VALUE CANDIDATE/HIGH RISK UNDERDOG
  - confidence: 1-100

Config: temperature=0.1, max_tokens=30% dari QWEN_MAX_TOKENS

Aturan Khusus Crypto 5m/15m:
  - Fokus HANYA pada klines momentum, RSI, long/short ratio, orderbookImbalance
  - orderbookImbalance > 65% = tekanan whale BUY/UP
  - orderbookImbalance < 35% = tekanan kuat SELL/DOWN
  - Klines berlawanan dengan imbalance = JEBAKAN likuiditas (catat sebagai HIGH RISK)
```

### Stage 3: Final Judge (`QWEN_FINAL_MODEL` = qwen3.7-plus)
```
Tugas: Keputusan akhir sebagai analis hedge fund kuantitatif
Input: sharedContext + Scout result + Analyst review
Output JSON:
  - verdict: SKIP/WATCHLIST/VALUE CANDIDATE/HIGH RISK UNDERDOG
  - confidence: 1-100
  - estimated_fair_probability: 0-100
  - expected_value_cents: EV = (estimated_fair_probability/100) - (marketProbability/100)
  - summary: ringkasan eksekutif
  - data_quality
  - bullish_case, bearish_case (maks 3 poin)
  - risks: { liquidity, spread, resolution, catalyst }
  - missing_data
  - checklist: { liquidity, spread, rules, edge, catalyst }
  - final_reason: justifikasi dengan angka EV, imbalance, RSI

Config: temperature=0.1, max_tokens=60% dari QWEN_MAX_TOKENS
```

**Aturan Mutlak di Prompt Stage 3:**
1. `EV ≤ 0` → verdict WAJIB "SKIP"
2. Klines berlawanan tajam dengan imbalance → WAJIB "SKIP"
3. Jangan mengarang data eksternal yang tidak ada di context

---

## 📊 Data yang Dianalisis (Context ke AI)

### A. Data Market (selalu ada)
| Data | Sumber | Cara Fetch |
|---|---|---|
| Question, description, endDate | Polymarket Gamma API | REST per request |
| bestBid, bestAsk, spread | Polymarket CLOB API | REST per request |
| orderbookImbalance | Dihitung dari CLOB orderbook | bidVol/(bidVol+askVol)×100 |
| marketProbability | (bestBid+bestAsk)/2 × 100 | Dihitung lokal |
| liquidity, volume | Polymarket Gamma API | REST per request |

### B. Data Crypto (jika market ada kata "Bitcoin/BTC/ETH/DOGE dll.")

**Dari `qwen.js` (inline di dalam `askQwen()`):**
| Data | Sumber | Cache |
|---|---|---|
| Current price live (Pyth Oracle) | hermes.pyth.network | Per request |
| Price to Beat / candle open (Pyth Oracle) | hermes.pyth.network | Per request |

**Dari `research.js` via `buildResearchContext()`:**
| Data | Sumber | Interval/Limit | Cache |
|---|---|---|---|
| Spot 24h ticker (lastPrice, high, low, volume, priceChange) | Binance `/api/v3/ticker/24hr` | Snapshot 24h | 10 detik |
| Spot Klines OHLCV → RSI(14), SMA(7), SMA(30), S/R, trend | Binance `/api/v3/klines` | **15m × 96 bar = 24 jam** | 10 detik |
| Futures Klines 5m (chart pendek) | Binance Futures `/fapi/v1/klines` | **5m × 6 bar = 30 menit** | 10 detik |
| Futures: Funding Rate, Open Interest | Binance Futures `/fapi/v1/premiumIndex` + `/openInterest` | Snapshot terkini | 10 detik |
| Long/Short Ratio 5m | Binance Futures `/fapi/v1/globalLongShortAccountRatio` | **5m × 1 (terkini)** | 10 detik |
| Fear & Greed Index (7 hari) | alternative.me | Harian | 900 detik |
| DeFiLlama TVL chains + protocols | api.llama.fi | Snapshot | 900 detik |
| **Premium News (NYTimes/Bloomberg/CoinDesk/CoinTelegraph)** | **DuckDuckGo HTML scraper** | 3 snippets | 900 detik |

**Khusus market crypto bertipe Up/Down**, `qwen.js` secara otomatis mendeteksi interval (`5m`, `15m`, `30m`, `1h`) dari judul market dan fetch harga pembuka candle dari **Pyth Oracle** sebagai "Price to Beat".

### C. Data Market Non-Crypto (politik, makro, olahraga, dll.)
| Data | Sumber | Cache |
|---|---|---|
| **Premium News (NYTimes/WSJ/Bloomberg/CoinDesk)** | **DuckDuckGo HTML scraper** | 900 detik |

---

## 🎛️ Output & Final Verdict

```json
{
  "verdict": "WATCHLIST",
  "confidence": 72,
  "estimated_fair_probability": 58,
  "expected_value_cents": 8,
  "summary": "...",
  "bullish_case": ["..."],
  "bearish_case": ["..."],
  "risks": { "liquidity": "Low", "spread": "Low", "resolution": "Medium", "catalyst": "Ada" },
  "checklist": { "liquidity": true, "spread": true, "rules": true, "edge": false, "catalyst": true },
  "final_reason": "..."
}
```

### Mapping ke finalPrediction (di index.js + format.js)
```
directionSignal(score) — berdasarkan marketProbability CLOB:
  yesConfidence = marketProbability         (= CLOB midpoint × 100, misalnya 65)
  noConfidence  = 100 - marketProbability   (= 35)

  Jika yesConfidence >= noConfidence + 2 → side = primaryOutcomeLabel (mis. "YES")
  Jika noConfidence >= yesConfidence + 2 → side = secondaryOutcomeLabel (mis. "NO")
  Jika selisih < 2                        → side = "NETRAL"

finalPrediction:
  "NETRAL" → "=" (tidak bet)
  primaryLabel (mis. "YES") → prediksi primary
  secondaryLabel (mis. "NO") → prediksi secondary

⚠️ Tidak ada Aggressive Mode override di versi ini.
⚠️ finalPrediction tidak sama dengan UP/DOWN — bergantung pada label outcome market (bisa "YES"/"NO", "ABOVE"/"BELOW", nama kandidat, dll.)
```

---

## 🗂️ Alur Mode-Mode Lain

### `/quickscan <event>` — Scan cepat tanpa Qwen
```
resolveEventInput(arg) → getMarketsFromPolymarketLink()
→ scoreEventMarkets() [batch 5, CLOB per market]
→ formatEventQuickScan() [tampilkan skor mekanis tanpa AI]
```

### `/analyzebest <event>` — Pilih market terbaik dari event
```
resolveEventInput(arg)
→ scoreEventMarkets() [batch 5]
→ askQwenEvent() [3-stage AI untuk bandingkan semua market]
   → Scout: klasifikasikan event
   → Analyst: bandingkan kandidat
   → Final: ranking + best_market_id
→ pickBestEventCandidate(analyzedMarkets, eventQwen)
→ deepAnalyzeMarket(best) [analisis mendalam market terpilih]
```

### `/analyzeall <event>` — Kirim bubble untuk semua market
```
resolveEventInput(arg)
→ scoreEventMarkets()
→ sortMarketsForAllMode() [urutkan berdasarkan blocker, spread, liquidity]
→ Kirim market bubble satu per satu ke Telegram
→ formatAnalyzeAllSummary()
```

### `/analyze <link event multi-market>` — Event Hub
```
Jika link event punya > 1 market aktif:
→ createEventSession(event, markets) [simpan di RAM, TTL 30 menit]
→ Tampilkan inline keyboard:
   [Quick Scan] [AI Best]
   [Top 3]      [Analyze All]
   [1] [2] [3] [4] (market individual)
→ Setiap tombol trigger command berbeda
```

---

## ⚙️ Konfigurasi Model (.env)

```env
QWEN_FAST_MODEL=qwen3.6-flash       # Stage 1: Scout (cepat, murah)
QWEN_ANALYST_MODEL=qwen3.7-plus     # Stage 2: Analyst (medium)
QWEN_FINAL_MODEL=qwen3.7-plus       # Stage 3: Final Judge (terbaik)

# Token budget dibagi: 10% Fast, 30% Analyst, 60% Final
QWEN_MAX_TOKENS=10000
```

---

## 🔒 Rate Limiting

| Jenis | Default | Env Key |
|---|---|---|
| Command cooldown | 3 detik | `COMMAND_COOLDOWN_MS` |
| Duplicate command | 15 detik | `DUPLICATE_COMMAND_COOLDOWN_MS` |
| Qwen command | 45 detik | `QWEN_COMMAND_COOLDOWN_MS` |

---

## 💾 Cache System

| Data | TTL Default | Env Key |
|---|---|---|
| Market data Gamma/CLOB | 60 detik | `CACHE_TTL_SECONDS` |
| Crypto prices/klines | 10 detik | `CRYPTO_CACHE_TTL_SECONDS` |
| DeFiLlama/fundamental | 900 detik (15 menit) | `FUNDAMENTAL_CACHE_TTL_SECONDS` |

---

## 🌐 Web UI & API Endpoints (`src/web.js`)

Web server berjalan di port **8788** (host `0.0.0.0`), bisa diakses di browser.

| Endpoint | Method | Fungsi |
|---|---|---|
| `GET /` | GET | Serve `public/index.html` (Web UI) |
| `POST /api/command` | POST | Kirim command (sama seperti Telegram), return messages JSON |
| `GET /api/health` | GET | Status Qwen key, engine version, cooldown |
| `GET /api/history` | GET | 50 log analisis terakhir dari SQLite |
| `GET /api/history/events` | GET | 100 analyzed events terakhir (prediksi + result) |
| `POST /api/history/events/check` | POST | Cek status resolve market dari Polymarket API |
| `GET /api/short-term?asset=btc` | GET | List short-term market aktif (BTC/ETH/DOGE) |

**Auth:** Jika `WEB_PASSWORD` diset di `.env`, endpoint dilindungi HTTP Basic Auth.

### Alur Web UI Request
```
Browser → POST /api/command { text: "/analyze ...", mode: "analyze" }
     │
     ▼
web.js → commandFromPayload() → handleCommand() [sama persis seperti Telegram]
     │
     ▼
Return: { ok: true, messages: [...], qwenConfigured, rateLimit, ... }
```

---

## 🗄️ Database & Storage (`src/storage.js`)

Bot menggunakan **SQLite** (`data/database.db`) via `better-sqlite3`.

### Tabel yang Ada

**`cache`** — Cache semua HTTP response
```sql
key TEXT PRIMARY KEY, value TEXT, saved_at INTEGER
```

**`analysis_log`** — Log setiap analisis yang dijalankan
```sql
id, created_at TEXT, data TEXT (JSON lengkap: market, score, qwenResult)
```

**`analyzed_events`** — Rekam jejak prediksi bot
```sql
id, market_id, question, url, prediction, status,
result, analysis_conclusion, actual_outcome,
qwen_confidence, data_confidence, created_at, resolved_at
```

### Flow Outcome Checking (Web UI)
```
User klik "Check Result" di Web UI
→ POST /api/history/events/check { id, market_id, prediction }
→ getMarketById(market_id) → cek outcomePrices
   Jika ada outcome yang >= 0.90 → market resolved
   → Compare prediction vs winningOutcome
   → Update status: 'selesai' / 'resolving' / 'belum selesai'
   → result: 'menang' / 'kalah' / 'menunggu hasil'
```

---

## 🕐 Short-Term Markets API (`src/polymarket.js`)

Bot bisa fetch list short-term market aktif via:
```
GET /api/short-term?asset=btc   → list BTC Up/Down market aktif
GET /api/short-term?asset=eth   → list ETH Up/Down market aktif
GET /api/short-term?asset=doge  → list DOGE Up/Down market aktif
```

---

## ⚠️ Klarifikasi vs SYSTEM_FLOW.md

`SYSTEM_FLOW.md` di root project ini mendokumentasikan fitur **Shadow Bet** (paper trading otomatis, autopilot scanner, PnL tracker). **Fitur ini sudah TIDAK ADA di codebase versi ini.** File `src/shadow.js` tidak exist. Tidak ada sistem auto-bet, autopilot, atau position tracker di kode aktual.

Yang ada hanya:
- Outcome check manual via Web UI (`/api/history/events/check`)
- Rekam jejak prediksi di tabel `analyzed_events` (tanpa eksekusi bet nyata)

---
