# Alur Analisis Razor Bot Saat Ini

Dokumen ini adalah panduan operator untuk memahami jalur analisis yang benar-benar berjalan di kode saat ini.

> Razor Bot tidak memiliki satu alur analisis tunggal. Ada tiga jalur utama dengan keputusan, penggunaan AI, dan persistence yang berbeda.

## Ringkasan Satu Menit

| Jalur | Cara masuk | Pembuat keputusan | AI | History analisis | Trading |
|---|---|---|---|---|---|
| **A. Dynamic EV 5m** | Tambahkan market 5m ke Dynamic EV Queue | Model terminal Chainlink + CLOB + scanner browser | Tidak | Tidak | Manual only; API trade menolak 5m |
| **B. Manual short analysis** | `/analyze` market crypto Up/Down | Model terminal Chainlink + CLOB | Opsional, hanya menjelaskan | Ya | Hanya non-5m yang dapat melewati trade gate lain |
| **C. Standard analysis** | `/analyze` market non-short | Mechanical score + research + AI multi-role | Ya | Ya | Belum trade-eligible karena tidak menyimpan `signal_data_at` |

Jalur event seperti Quick Scan, Top 3, Analyze All, dan AI Best dijelaskan terpisah karena behavior AI dan history-nya tidak sama.

## Peta Keputusan

```text
Input dari Web UI
  |
  +-- /search atau /top
  |     -> discovery saja, tanpa AI dan tanpa analysis history
  |
  +-- market 5m dimasukkan ke Dynamic EV Queue
  |     -> Jalur A: deterministic scanner, manual entry only
  |
  +-- /analyze crypto Up/Down
  |     -> Jalur B: deterministic short analysis + AI explanation opsional
  |
  +-- /analyze market lain
  |     -> Jalur C: scoring + research + AI multi-role
  |
  +-- link event berisi banyak market
        -> Event Hub: pilih Quick Scan, Top 3, Analyze All, AI Best,
           atau satu market individual
```

## 1. Discovery: `/search`, `/top`, dan Short Market List

### `/search <keyword>`

1. Backend memanggil Gamma `/public-search`.
2. Direct market dan child market dari event digabungkan.
3. Market yang inactive, closed, tidak punya token CLOB, tidak relevan, atau diblokir policy dihapus.
4. Hasil diurutkan berdasarkan relevance, event rank, status open, lalu liquidity dan volume.
5. Maksimal lima hasil dikembalikan ke pengguna.

`/search` tidak memanggil AI dan tidak membuat analysis history. Response Gamma tetap dapat masuk ke cache SQLite.

### `/top [volume|liquidity|new|ending]`

1. Backend mengambil event aktif dari Gamma.
2. Semua child market dibuka dan difilter.
3. Jika tidak ada child market yang valid, backend memakai endpoint `/markets` sebagai fallback.
4. Sepuluh hasil teratas dikembalikan.

`/top` juga tidak memanggil AI dan tidak membuat analysis history.

### Short Market List

Sidebar mengambil seri BTC, ETH, dan DOGE untuk durasi 5m, 15m, 1h, 4h, dan 1d melalui `/api/short-term`.

Hanya item dengan `durationType === "5m"` yang memakai Dynamic EV Scanner. Durasi lain yang dimasukkan ke queue memakai jalur analisis biasa.

## 2. Jalur A: Dynamic EV Scanner 5m

### Tujuan

Dynamic EV bukan full AI analysis. Fungsinya mencari titik entry manual yang masih memiliki edge terukur menjelang market 5 menit berakhir.

### Waktu aktual

| Parameter | Nilai default |
|---|---:|
| Mulai scan | Sisa waktu `05:00` atau 300 detik |
| Stop scan | Sisa waktu `02:30` atau 150 detik |
| Tick scheduler | 1 detik |
| Poll snapshot sebelum entry | 5 detik |
| Revalidasi setelah entry | 2 detik |
| TTL sinyal entry | 10 detik |
| Maksimal request paralel | 3 |

Window scan berarti snapshot dinilai saat remaining time `<= 300` dan `> 150` detik.

### Backend snapshot

Browser memanggil:

```text
POST /api/short-entry-snapshot
  -> getFastShortEntrySnapshot
  -> getMarketById(forceRefresh)
  -> scoreOneMarket
  -> evaluateShortMarketCondition
```

Backend hanya menerima market yang:

- Berdurasi tepat 5 menit.
- Berupa crypto Up/Down yang didukung: BTC, ETH, atau DOGE.
- Active, belum closed, accepting orders, dan belum melewati `endDate`.
- Tidak diblokir market policy.

### Data keputusan

Model terminal memakai:

- Official Chainlink resolution source.
- Opening Price to Beat.
- Fresh Chainlink live price.
- Closed Chainlink candles dan interval volatility; Binance Futures dipakai sebagai technical fallback jika candle Chainlink tidak tersedia.
- Executable UP dan DOWN asks dari CLOB.
- Fee buffer.

Probabilitas arah berasal dari jarak live price terhadap Price to Beat, volatility, dan sisa waktu. CLOB tidak menentukan arah; CLOB menentukan apakah harga entry executable dan masih memiliki EV.

### Dua lapis gate

Backend lebih longgar dan bertindak sebagai authority awal:

| Backend gate | Default |
|---|---:|
| Directional probability | `>= 55%` |
| Net EV | `>= 5c` |
| Maximum ask | `<= $0.70` |
| Minimum time to close | `30 detik` |
| Chainlink age | `<= 15 detik` |

Browser scanner kemudian menerapkan gate yang lebih ketat:

| Scanner gate | Default |
|---|---:|
| Fair probability | `>= 60%` |
| Net EV setelah fee | `>= 8c` |
| Ask | `> 0` dan `<= $0.65` |
| Konfirmasi | 2 snapshot berurutan dengan arah sama |
| Oracle age | `0-15 detik` |

Effective entry harus lolos kedua lapis gate. Metadata authority backend, market status, oracle, metrics, ask, EV, dan confirmations semuanya fail-closed.

### State machine

```text
WAITING
  -> WATCHING       gate belum lolos
  -> CANDIDATE      satu snapshot lolos
  -> ENTRY          konfirmasi arah yang sama terpenuhi
  -> NO CHASE       entry kedaluwarsa atau edge hilang
  -> NO ENTRY       window berakhir tanpa entry valid
```

Makna hasil:

- **ENTRY**: titik entry manual valid saat itu. Bukan auto-buy.
- **NO CHASE**: sinyal sempat ada, tetapi sudah expired, ask melewati cap, data gagal direvalidasi, atau own-side kehilangan edge.
- **NO ENTRY**: window berakhir tanpa ENTRY yang terkonfirmasi penuh. Candidate 1/2 dapat sempat muncul tetapi tetap berakhir NO ENTRY jika konfirmasi kedua tidak pernah valid.
- **Diagnostic Lean**: arah forecast untuk informasi. Lean bukan sinyal executable.
- **Best Observed**: snapshot terbaik selama session, walaupun belum cukup untuk entry.

Summary menampilkan exact failed gates, contohnya fair di bawah 60%, ask di atas $0.65, net EV di bawah 8c, stale oracle, backend blocker, atau confirmations 1/2.

### Batas keamanan Dynamic EV

- Tidak memanggil AI explanation.
- Tidak menulis `analysis_log` atau `analyzed_events`.
- Queue dan result hanya hidup di memory browser dan hilang saat reload.
- Raw API response masih dapat masuk ke tabel cache SQLite.
- Tidak pernah mengeksekusi trade otomatis.
- `/api/execute-trade` menolak semua market 5m secara terpisah.

## 3. Jalur B: Manual Short Analysis

Jalur ini aktif ketika pengguna menjalankan `/analyze` pada market crypto Up/Down, termasuk market yang bukan 5m.

Perbedaannya dari Dynamic EV:

| Hal | Dynamic EV 5m | Manual short `/analyze` |
|---|---|---|
| Trigger | Queue dan scan window | Command manual |
| Keputusan | Deterministic Chainlink + CLOB | Deterministic Chainlink + CLOB |
| AI | Tidak | Opsional, hanya menjelaskan keputusan immutable |
| History | Tidak | Ya |
| Result lifetime | Memory browser | Tersimpan |
| Trade | 5m selalu ditolak | Non-5m tetap harus lolos seluruh trade gate |

AI short explanation tidak boleh mengubah direction, probability, recommendation, ask, atau EV. Jika final Chainlink/CLOB refresh mengubah keputusan secara material, explanation lama dibuang.

## 4. Jalur C: Standard `/analyze`

### Input resolution

`POST /api/command` mengirim command ke `handleCommand()`.

- Numeric ID 1-10 digit -> direct market lookup.
- Polymarket link -> link resolver.
- Keyword -> search dan pilih hasil paling relevan.
- Event link dengan banyak market -> buka Event Hub, belum melakukan deep analysis.

Runtime saat ini dimulai oleh Web UI. Bootstrap `start-all.js` tidak menyalakan Telegram listener.

### Mechanical scoring

Sebelum research atau AI:

1. Market policy diperiksa.
2. Token outcome dipetakan.
3. CLOB orderbook diambil.
4. `scoreMarket()` menghitung spread, confidence, liquidity risk, resolution risk, blockers, dan verdict mekanis.

Untuk market umum, baseline mechanical fair probability berasal dari market midpoint. Karena itu mechanical score sendiri biasanya tidak membuktikan positive edge; external fair estimate datang dari tahap AI.

### Research context

Crypto context dapat mencakup Binance spot/futures, candles, funding, open interest, long/short ratio, Fear & Greed, DeFiLlama, dan search snippets.

General context menggunakan Forex Factory dan DuckDuckGo snippets. Sistem tidak membaca artikel berbayar atau bypass paywall.

### AI multi-role

Nama model tidak hard-coded ke Qwen. Runtime menggunakan OmniRoute melalui `OMNI_API_KEY` dan `OMNIROUTE_BASE_URL` dengan API yang kompatibel dengan OpenAI. Environment variables `QWEN_*_MODEL` dapat mengganti setiap model role.

Tiga role standard:

1. **Fast scout**: klasifikasi kompleksitas, missing data, dan initial assessment.
2. **Analyst/reviewer**: menilai bull/bear case dan external context.
3. **Final risk manager**: menghasilkan verdict terstruktur dan fair estimate.

### Validation dan actionability

Verdict AI yang valid:

- `SKIP`
- `WATCHLIST`
- `VALUE CANDIDATE`
- `HIGH RISK UNDERDOG`

`ENTRY` bukan verdict AI standard. Final directional prediction hanya actionable jika seluruh kondisi ini terpenuhi:

- Verdict adalah `VALUE CANDIDATE`.
- Tidak ada hard blocker.
- Confidence minimal default 80.
- Fair probability minimal 5 poin di atas market probability.
- Native EV calculation tetap positif.

`HIGH RISK UNDERDOG` tidak otomatis menjadi actionable prediction.

Actionable di bagian ini berarti valid sebagai prediction analitis. Standard non-short analysis saat ini tidak mengisi `signal_data_at`, sedangkan trade endpoint mewajibkan timestamp tersebut. Jadi standard AI prediction belum dapat melewati real-trade freshness gate. Manual short non-5m dapat menyediakan Chainlink publish time sebagai signal timestamp.

Aggressive Mode saat ini hanya tersimpan sebagai UI/settings state dan belum dipakai oleh scoring, prediction, atau trade decision.

### Output dan history

Deep analysis menulis:

- SQLite `cache` untuk response eksternal.
- SQLite `analysis_log` untuk laporan analisis.
- SQLite `analyzed_events` untuk history yang tampil di Web UI.
- `data/token_usage.json` untuk penggunaan token AI.
- Short analysis juga dapat menulis `data/short_condition_history.json`.

## 5. Event Hub

Event session berada di memory selama sekitar 30 menit dan hilang saat server restart.

| Action | AI | Writes |
|---|---|---|
| Quick Scan | Tidak | `cache`, `analysis_log` |
| Top 3 | Tidak | `cache`, `analysis_log` |
| Analyze All, event >1 market | Tidak | `cache`, `analysis_log` |
| Analyze All, event tinggal 1 market | Mengikuti deep analysis Jalur B/C | `cache`, `analysis_log`, dan dapat menulis `analyzed_events`/token usage |
| AI Best | Ya, event selection lalu deep analysis | `cache`, `analysis_log`, `analyzed_events`, token usage |
| Pilih satu market | Mengikuti Jalur B atau C | Mengikuti jalur yang dipilih |

Analyze All diklasifikasikan sebagai AI command untuk cooldown. Untuk event multi-market implementasinya tidak memanggil AI, tetapi event yang hanya memiliki satu market didelegasikan ke deep analysis dan mengikuti Jalur B atau C.

## 6. Market Policy

Market dengan bukti UFC eksplisit diblokir secara terpusat.

- Discovery (`/search`, `/top`, short list) menghapus item blocked tanpa menggagalkan sibling market yang valid.
- Direct ID, slug, atau event blocked menghasilkan `UNSUPPORTED_UFC`.
- `scoreOneMarket()` memeriksa policy sebelum CLOB, research, dan AI.
- Short final refresh meneruskan policy error dan tidak memakai stale token fallback.
- Trade refresh juga melewati direct market policy.

MMA generik, boxing, dan generic combat language tidak otomatis diblokir tanpa bukti UFC yang eksplisit.

Catatan: Gamma response diambil sebelum normalized market diperiksa. Karena cache berada di fetch layer, raw response blocked dapat tersimpan sementara di tabel `cache`, tetapi tidak boleh mencapai scoring, AI, history, atau trading.

## 7. Real Trade Flow

Razor Bot memiliki real trade endpoint, tetapi disabled secara default.

```text
POST /api/execute-trade
  -> auth dan same-origin check
  -> live trading enabled check
  -> batch, size, dan idempotency validation
  -> force-refresh setiap market
  -> reject UFC / closed / inactive / non-accepting / 5m
  -> validasi stored signal, strategy version, freshness, prediction
  -> validasi stored max entry cap
  -> reserve idempotency key, analyzed signal, execution, dan daily cap
  -> fetch executable FOK price
  -> reject jika executable price melewati cap
  -> submit BUY-only FOK order jika harga masih valid
```

Default safety limits:

| Gate | Default |
|---|---:|
| Live trading | Disabled |
| Per trade | 10 USDC |
| Per batch | 25 USDC |
| Daily rolling cap | 50 USDC |
| Trades per request | 3 |
| Stored signal TTL | 60 detik |
| Price cap | $0.70 |
| Minimum time to close | 30 detik |

Tidak ada Shadow Bet atau paper-trading autopilot aktif. Real order hanya mungkin setelah operator mengaktifkan live trading dan seluruh backend gate lolos.

Reservation terjadi sebelum executable FOK price diperiksa. Attempt yang kemudian gagal atau ditolak harga tetap memakai analyzed signal dan tetap masuk perhitungan rolling daily cap saat ini. Karena itu operator tidak boleh memperlakukan retry sebagai operasi bebas biaya kuota.

## 8. Resolution dan Evaluation

Resolution check berjalan ketika operator memanggil `/evaluate`, melakukan per-row check, atau memilih Periksa Semua. Tidak ada automatic background resolver untuk pending bets.

Market dianggap resolved jika:

- `market.closed === true`.
- Tepat satu outcome memiliki harga `>= $0.99`.
- Semua outcome lain memiliki harga `<= $0.01`.

Hasil yang disimpan adalah win/loss/neutral prediction, bukan realized trading PnL.

Khusus command `/evaluate`, newly resolved actionable loss dapat langsung memicu post-mortem AI dan menulis `prediction_reflections` serta token usage. Per-row check dan tombol Periksa Semua hanya memperbarui resolution status tanpa jalur post-mortem tersebut.

## 9. Persistence Matrix

Database utama adalah `data/database.db`, kecuali `RAZOR_DATABASE_PATH` diatur.

| Flow | Persistence utama |
|---|---|
| Dynamic EV snapshot | SQLite `cache` saja |
| `/search`, `/top`, `/book` | SQLite `cache` saja |
| Standard deep analysis | `cache`, `analysis_log`, `analyzed_events`, token usage |
| Manual short analysis | `cache`, `analysis_log`, `analyzed_events`, short condition history; token usage hanya jika AI explanation dijalankan |
| Quick Scan / Top 3 | `cache`, `analysis_log` |
| Analyze All | Multi-market: `cache`, `analysis_log`; single-market fallback mengikuti Jalur B/C |
| AI Best | `cache`, `analysis_log`, `analyzed_events`, token usage |
| Real trade | `trade_requests`, `trade_executions` |
| Resolution check | Update `analyzed_events`; dapat patch short history |
| `/evaluate` pada actionable loss | Resolution writes + `prediction_reflections`, token usage, cache |

Legacy files `analysis_log.jsonl`, `bot.db`, `polymarket.db`, dan `database.sqlite` tidak digunakan oleh runtime utama saat ini.

## 10. Istilah yang Sering Tertukar

| Istilah | Artinya |
|---|---|
| Diagnostic Lean | Arah forecast informasional, bukan izin entry |
| Fair Probability | Estimasi peluang outcome, bukan harga CLOB |
| Gross EV | Fair probability dikurangi ask, sebelum fee buffer |
| Net EV | Gross EV setelah fee buffer |
| Backend Actionable | Snapshot lolos guardrail deterministic backend |
| Candidate | Satu snapshot lolos scanner, belum cukup confirmations |
| Entry | Sinyal manual Dynamic EV yang masih hidup |
| No Chase | Sinyal lama tidak aman dikejar lagi |
| No Entry | Window selesai tanpa sinyal yang memenuhi semua gate |
| VALUE CANDIDATE | Satu-satunya verdict AI standard yang dapat menjadi prediction actionable setelah native validation |

## 11. Source Map

| Area | Source utama |
|---|---|
| Dynamic scanner rules/state | `public/entry-scanner.js` |
| Dynamic scanner UI/queue | `public/app.js` |
| Web API dan trade gate | `src/web.js` |
| Command routing/orchestration | `src/index.js` |
| Polymarket discovery/CLOB | `src/polymarket.js` |
| Short deterministic model | `src/short_condition.js` |
| Standard mechanical scoring | `src/scoring.js` |
| External research | `src/research.js` |
| AI provider dan role pipeline | `src/qwen.js` |
| Market policy | `src/market-policy.js` |
| Persistence | `src/storage.js`, `src/database-path.js` |
| Real order submission | `src/trade.js` |

Jika dokumentasi lain bertentangan dengan file ini, periksa source map di atas. Kode tetap menjadi sumber kebenaran terakhir.
