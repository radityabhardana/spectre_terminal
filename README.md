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
- `/search <keyword>` - cari market aktif.
- `/book <tokenId atau marketId>` - cek orderbook token CLOB dari hasil `/search`.
- `/analyze <keyword atau marketId>` - cari market paling relevan atau analisis market ID pilihan, hitung skor, lalu minta Qwen membuat reasoning.

Alur manual yang disarankan:

```text
/search Colombia Presidential Election
/analyze 569356
```

`/search` memakai Polymarket Gamma `/public-search`, jadi Qwen belum dipakai. Qwen baru dipakai saat `/analyze`.

Untuk tes search tanpa Telegram:

```powershell
npm.cmd run search -- "Colombia Presidential Election"
```

## Catatan Aman

- Bot ini bukan financial advice.
- Bot tidak melakukan order/trading.
- Jangan taruh seed phrase, private key wallet, atau API trading permission withdraw di project ini.
- Kalau API key pernah terkirim di chat publik, rotate/ganti key dari dashboard provider.
