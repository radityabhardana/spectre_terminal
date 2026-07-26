# Polymarket Analyzer

Aplikasi lokal untuk analisis market Polymarket dengan pipeline DeepSeek multi-role melalui 9Router. Live trading nonaktif secara default dan hanya dapat aktif jika autentikasi, wallet, serta batas risiko dikonfigurasi secara eksplisit.

## Cara Ambil Telegram Bot Token

1. Buka Telegram.
2. Cari akun resmi `@BotFather`.
3. Kirim `/newbot`.
4. Ikuti instruksi nama bot dan username bot.
5. BotFather akan memberi token seperti `123456789:ABCDEF...`.
6. Simpan token itu di file `.env`.

## Setup

```bash
cp .env.example .env
```

Edit `.env`, lalu isi:

```text
TELEGRAM_BOT_TOKEN=token_dari_botfather
NINEROUTER_API_KEY=api_key_9router_kamu
NINEROUTER_BASE_URL=http://127.0.0.1:20128/v1
QWEN_BULL_MODEL=alims-intl/deepseek-v4-flash
QWEN_BEAR_MODEL=alims-intl/deepseek-v4-flash
QWEN_RISK_MANAGER_MODEL=alims-intl/deepseek-v4-pro
QWEN_EVALUATOR_MODEL=alims-intl/deepseek-v3.2
QWEN_MAX_TOKENS=10000
BINANCE_BASE_URL=https://data-api.binance.vision
BINANCE_FUTURES_BASE_URL=https://fapi.binance.com
DEFILLAMA_BASE_URL=https://api.llama.fi
DEFILLAMA_STABLECOINS_URL=https://stablecoins.llama.fi
FEAR_GREED_URL=https://api.alternative.me/fng/
GDELT_DOC_URL=https://api.gdeltproject.org/api/v2/doc/doc
CRYPTO_CACHE_TTL_SECONDS=10
FUNDAMENTAL_CACHE_TTL_SECONDS=900
NEWS_CACHE_TTL_SECONDS=900
RESEARCH_FETCH_TIMEOUT_MS=8000
WEB_PASSWORD=rahasia
```

Install dependency dan library (termasuk SQLite engine):

```bash
npm install
```

Jalankan Telegram bot dan website sekaligus:

```bash
npm start
```

Jika PowerShell memblokir `npm`, pakai:

```powershell
npm.cmd start
```

Untuk menjalankan salah satu saja:

```powershell
npm.cmd run web
npm.cmd run telegram
```

Buka:

```text
http://localhost:8787
```

Kalau port 8787 sudah dipakai, ubah `WEB_PORT` di `.env`.
Default host adalah `127.0.0.1` supaya UI hanya lokal di komputer sendiri.
Untuk mengamankan Web UI dengan Basic Auth, isi variabel `WEB_PASSWORD` di `.env`.

## UFC Ultra-Fast Lookup
Sistem ini menggunakan parser CSV kustom super cepat untuk memuat `data/ufc_dataset.csv` langsung ke RAM dalam hitungan milidetik.
Jika input dari Polymarket menyebutkan nama petarung yang cocok dengan data di CSV (contoh: "Jon Jones"), bot otomatis mendeteksinya (O(1) lookup) dan meneruskan riwayat statistik tersebut ke Qwen. Tidak diperlukan perintah khusus, pencarian berjalan otomatis di latar belakang untuk market kategori MMA/UFC.

## Command Telegram

- `/start` atau `/help` - tampilkan bantuan.
- `/version` - cek versi search engine yang sedang aktif.
- `/example` - tampilkan contoh alur pakai bot.
- `/top [volume|liquidity|new|ending]` - lihat market aktif yang lagi top tanpa perlu keyword/link.
- `/search <keyword>` - cari market aktif.
- `/book <tokenId, marketId, atau link Polymarket>` - cek orderbook token CLOB dari hasil `/search`.
- `/analyze <keyword, marketId, atau link Polymarket>` - cari market paling relevan, analisis market ID pilihan, atau analisis langsung dari link Polymarket.
- `/quickscan <link/slug event>` - scan cepat event multi-pilihan tanpa Qwen.
- `/top3 <link/slug event>` - tampilkan 3 pilihan teratas tanpa Qwen.
- `/analyzebest <link/slug event>` - pilih kandidat paling worth it dari event multi-pilihan.
- `/analyzeall <link event Polymarket>` - jelaskan semua pilihan aktif di event (1 pilihan = 1 bubble chat).

Saat `/start`, Telegram akan menampilkan keyboard menu dengan tombol:

```text
Top Markets | Analyze Link / ID
Search Market | Quick Scan Event
Orderbook Check | Example Flow
Bot Version | Help
```

Saat `/analyze`, bot mengirim pesan progress dengan estimasi sisa waktu, lalu mengirim hasil final setelah Qwen selesai.
Kamu juga bisa mengirim link Polymarket atau Market ID langsung tanpa `/analyze`; bot akan otomatis menganalisisnya.
Link Polymarket tidak harus selalu `/event/...` atau `/market/...`; route kategori seperti `/sports/wta-doubles/wta-doubles-barnmur-presswa-2026-06-02` juga akan dicoba dari slug terakhir.

## Website Lokal

Website memakai engine analisis yang sama dengan Telegram, tapi tampilannya lebih enak untuk output panjang.
Command Deck `Discovery` adalah tombol sekali klik tanpa input:

- `Volume` - market aktif dengan volume terbesar.
- `Liquidity` - market aktif dengan likuiditas terbesar.
- `New` - market aktif terbaru.
- `Ending` - market aktif yang paling dekat deadline.

Mode input manual:

- `Auto` - tempel command, link, keyword, atau Market ID langsung.
- `Search` - setara `/search`.
- `Deep Analyze` - setara `/analyze`.
- `Quick Scan Event` - setara `/quickscan`.
- `Analyze All` - setara `/analyzeall`.
- `Orderbook` - setara `/book`.

`Top 3` dan `AI Best` tidak tampil sebagai tombol permanen di sidebar. Keduanya muncul sebagai tombol konteks di Event Hub setelah kamu mengirim link event multi-pilihan, atau bisa dipanggil manual lewat `/top3 <event>` dan `/analyzebest <event>`.
Kalau hasil menampilkan tombol Event Hub, tombol itu bisa diklik langsung dari website.
Tombol bulan di dalam textarea berfungsi sebagai `Run`; saat analisis berjalan tombol berubah menjadi `Cancel`. Setelah proses selesai atau dibatalkan, tombol masuk animasi cooldown mengikuti `COMMAND_COOLDOWN_MS` supaya anti-spam guard terasa jelas.
Endpoint `/api/health` memeriksa koneksi read-only ke `/models` dan melaporkan apakah seluruh model 9Router yang dikonfigurasi tersedia.
Panel `Polymarket Live` otomatis menampilkan embed Polymarket ketika URL market/event terdeteksi. Embed resmi Polymarket paling aman untuk single market; untuk event multi-pilihan, pilih salah satu market dulu agar widget-nya tepat.

Anti-spam guard aktif untuk Telegram dan Website:

```text
COMMAND_COOLDOWN_MS -> jeda umum antar command.
DUPLICATE_COMMAND_COOLDOWN_MS -> jeda untuk command yang sama persis.
QWEN_COMMAND_COOLDOWN_MS -> jeda khusus command AI/Qwen seperti /analyze, /analyzebest, /analyzeall.
```

Default-nya command umum 3 detik, command sama 15 detik, dan Qwen 45 detik. Kalau terlalu ketat atau terlalu longgar, ubah nilainya di `.env`.

### Fitur Web UI Tambahan

**1. Riwayat Analisis & Pengecekan Status**
Setiap market yang dianalisis secara mendalam (`/analyze` atau `/analyzebest`) akan otomatis tersimpan ke dalam database lokal (SQLite).
Kamu bisa melihat daftar riwayat ini dengan menekan tombol **History Logs** bergambar jam yang ada di pojok kanan bawah *Status Bar* Web UI.
- Modal riwayat menampilkan daftar market, tebakan AI (prediksi dominan), serta statistik Win Rate.
- Terdapat tombol **Periksa** untuk mengecek langsung ke Polymarket API apakah event sudah selesai (berdasarkan harga outcome yang menyentuh >= 0.95 atau status market yang sudah tutup).
- Jika sudah selesai, sistem akan otomatis mencocokkan prediksi dengan hasil nyata dan menandainya sebagai **Menang** atau **Kalah**. Pengecekan ini 100% gratis dan tidak memakan token API Qwen.

**2. Shadow Bot (Simulasi Trading / Paper Trading)**
Tersedia mode simulasi trading otomatis (Shadow Bot) yang bisa diakses lewat tombol di kanan atas Web UI.
- Bot akan berjalan di *background* untuk mengecek market secara berkala (misal mencari market yang hampir *closing*).
- Jika Qwen memberikan sinyal *verdict* yang kuat, bot akan melakukan simulasi *bet* (paper trade) dengan data harga saat itu.
- Dilengkapi pengaturan *Modal Awal (Capital)*, *Target Jumlah Bet*, *Durasi*, dan *Ukuran Bet (Bet Size)* per entry.
- Fitur ini sangat berguna untuk melakukan *forward testing* dan melihat metrik Win Rate serta PnL secara real-time tanpa resiko finansial.

## Arsitektur & Cache

```text
QWEN_BULL_MODEL         -> fast scout DeepSeek
QWEN_BEAR_MODEL         -> analyst/reviewer DeepSeek
QWEN_RISK_MANAGER_MODEL -> final judge DeepSeek
QWEN_EVALUATOR_MODEL    -> post-mortem/fallback DeepSeek
QWEN_MAX_TOKENS    -> budget output dibagi per role: 10% fast, 30% analyst, 60% final
```

Crypto research layer:

```text
BINANCE_BASE_URL -> Binance spot public market-data API untuk last price, 24h change, volume, high/low, best bid/ask, dan candle harian 7/30 hari.
BINANCE_FUTURES_BASE_URL -> Binance USD-M Futures public API untuk funding rate dan open interest.
DEFILLAMA_BASE_URL -> DeFiLlama API untuk chain/protocol TVL.
DEFILLAMA_STABLECOINS_URL -> DeFiLlama stablecoin supply/peg context.
FEAR_GREED_URL -> Alternative.me Crypto Fear & Greed sentiment.
GDELT_DOC_URL -> GDELT news/catalyst headline search.
CRYPTO_CACHE_TTL_SECONDS -> cache pendek khusus data crypto agar hasil lebih dekat realtime.
FUNDAMENTAL_CACHE_TTL_SECONDS -> cache DeFi/sentiment agar tidak spam provider.
NEWS_CACHE_TTL_SECONDS -> cache news/catalyst agar hemat request dan token.
RESEARCH_FETCH_TIMEOUT_MS -> batas tunggu request research supaya bot tidak menggantung kalau provider lambat.
```

Kalau market/event menyebut coin seperti BTC, ETH, SOL, XRP, DOGE, ADA, BNB, AVAX, dan beberapa major coins lain, bot akan otomatis mengambil market data Binance lalu memasukkannya ke Qwen sebagai `EXTERNAL RESEARCH CONTEXT`.
Untuk stablecoin seperti USDC/USDT, bot memakai proxy `USDCUSDT` dan menandainya sebagai data relatif antar stablecoin, bukan harga USD resmi.
Endpoint research ini tidak butuh API key untuk market data dasar, tapi tetap punya fair-use/rate limit berbasis provider/IP.
Kalau satu pair error, pair lain tetap dipakai sebagai konteks agar analisis tidak gagal total.

Alur manual yang disarankan:

```text
/search Colombia Presidential Election
/top
/top liquidity
/analyze 569356
/analyze https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025
/quickscan colombia-presidential-election
/top3 colombia-presidential-election
/analyzebest colombia-presidential-election
/analyzeall https://polymarket.com/event/colombia-presidential-election
```

`/search` memakai Polymarket Gamma `/public-search`, jadi Qwen belum dipakai. Qwen dipakai saat `/analyze` dan `/analyzebest`.
`/top` memakai Polymarket Gamma `/events` aktif, default sort `volume_24hr`, jadi cocok buat discovery market yang sedang rame.
Output analisis menampilkan model pipeline dan token usage jika 9Router mengembalikan data penggunaan.
Untuk market crypto, output juga menampilkan `RESEARCH CONTEXT` dari Binance, DeFiLlama, Alternative.me, dan GDELT jika coin berhasil terdeteksi.
Untuk market live cepat seperti `Up/Down`, bot memakai CLOB/orderbook sebagai acuan utama arah live, lalu memberi warning jika harga/volume Gamma terlihat lag atau terlalu kecil.

Kalau link event berisi banyak market aktif:

- `/analyze <link event>` masuk **Event Hub**: bot menampilkan ringkasan pilihan + tombol inline.
- `Quick Scan` memberi ranking cepat tanpa Qwen, cocok buat scouting hemat token.
- `Top 3` hanya menampilkan 3 pilihan terbaik versi data market.
- Tombol angka `1`, `2`, `3`, dst langsung deep analyze market itu saja.
- `AI Best` menjalankan Qwen untuk pilih satu kandidat lalu deep analyze.
- `/analyzebest <link/slug event>` pilih satu kandidat paling worth it dari semua pilihan aktif lalu deep dive hasil lengkapnya.
- `/analyzeall <link event>` masuk mode **jelaskan semua**: bot kirim 1 bubble per pilihan berisi arah outcome utama/lawan, confidence, underdog, risk, dan entry status mekanis.
- Untuk deep dive Qwen per pilihan, pakai `/analyze <Market ID>`.

Untuk tes search tanpa Telegram:

```powershell
npm.cmd run search -- "Colombia Presidential Election"
```

## Catatan Aman

- Bot ini bukan financial advice.
- `ENABLE_LIVE_TRADING=false` adalah default. Jangan mengaktifkannya sebelum `WEB_PASSWORD`, limit nominal, TTL sinyal, dan batas harga ditinjau.
- Jangan commit seed phrase, private key wallet, atau kredensial CLOB. Gunakan `.env` lokal dan rotasi segera jika pernah masuk Git.
- Kalau API key pernah terkirim di chat publik, rotate/ganti key dari dashboard provider.
