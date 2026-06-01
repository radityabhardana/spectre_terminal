# Polymarket Telegram Analyzer

Bot Telegram lokal untuk analisis manual market Polymarket. Versi ini tidak melakukan auto-entry, tidak menyimpan private key wallet, dan hanya memanggil Qwen saat command `/analyze`.

## Cara Ambil Telegram Bot Token

1. Buka Telegram.
2. Cari akun resmi `@BotFather`.
3. Kirim `/newbot`.
4. Ikuti instruksi nama bot dan username bot.
5. BotFather akan memberi token seperti `123456789:ABCDEF...`.
6. Simpan token itu di file `.env`.

## Setup

```bash
copy .env.example .env
```

Edit `.env`, lalu isi:

```text
TELEGRAM_BOT_TOKEN=token_dari_botfather
QWEN_API_KEY=api_key_qwen_kamu
```

Jalankan:

```bash
npm start
```

Jika PowerShell memblokir `npm`, pakai:

```powershell
npm.cmd start
```

## Command Telegram

- `/start` atau `/help` - tampilkan bantuan.
- `/version` - cek versi search engine yang sedang aktif.
- `/example` - tampilkan contoh alur pakai bot.
- `/search <keyword>` - cari market aktif.
- `/book <tokenId, marketId, atau link Polymarket>` - cek orderbook token CLOB dari hasil `/search`.
- `/analyze <keyword, marketId, atau link Polymarket>` - cari market paling relevan, analisis market ID pilihan, atau analisis langsung dari link Polymarket.
- `/analyzebest <link/slug event>` - pilih kandidat paling worth it dari event multi-pilihan.
- `/analyzeall <link event Polymarket>` - jelaskan semua pilihan aktif di event (1 pilihan = 1 bubble chat).

Saat `/start`, Telegram akan menampilkan keyboard menu dengan tombol:

```text
Search Market | Analyze Link / ID
Orderbook Check | Example Flow
Bot Version | Help
```

Saat `/analyze`, bot mengirim pesan progress dengan estimasi sisa waktu, lalu mengirim hasil final setelah Qwen selesai.
Kamu juga bisa mengirim link Polymarket atau Market ID langsung tanpa `/analyze`; bot akan otomatis menganalisisnya.

Alur manual yang disarankan:

```text
/search Colombia Presidential Election
/analyze 569356
/analyze https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025
/analyzebest colombia-presidential-election
/analyzeall https://polymarket.com/event/colombia-presidential-election
```

`/search` memakai Polymarket Gamma `/public-search`, jadi Qwen belum dipakai. Qwen baru dipakai saat `/analyze`.
Output `/analyze` akan menampilkan `Qwen model` dan `Qwen usage` jika API mengembalikan data token usage.

Kalau link event berisi banyak market aktif:

- `/analyze <link event>` masuk mode **pilih**: bot menampilkan daftar pilihan + keyboard button untuk `analyze`, `analyzebest`, atau `analyzeall`.
- `/analyzebest <link/slug event>` pilih satu kandidat paling worth it dari semua pilihan aktif lalu deep dive hasil lengkapnya.
- `/analyzeall <link event>` masuk mode **jelaskan semua**: bot kirim 1 bubble per pilihan berisi arah YES/NO, confidence, underdog, risk, dan verdict mekanis.
- Untuk deep dive Qwen per pilihan, pakai `/analyze <Market ID>`.

Untuk tes search tanpa Telegram:

```powershell
npm.cmd run search -- "Colombia Presidential Election"
```

## Catatan Aman

- Bot ini bukan financial advice.
- Bot tidak melakukan order/trading.
- Jangan taruh seed phrase, private key wallet, atau API trading permission withdraw di project ini.
- Kalau API key pernah terkirim di chat publik, rotate/ganti key dari dashboard provider.
