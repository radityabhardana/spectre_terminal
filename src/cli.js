import { handleCommand } from "./index.js";

const commandLine = process.argv.slice(2).join(" ").trim();

if (!commandLine || commandLine === "/" || commandLine === "help" || commandLine === "/help") {
  console.log("===================================================================");
  console.log("🤖 POLYMARKET CLI TOOL — DAFTAR COMMAND");
  console.log("===================================================================");
  console.log("Cara pakai: npm run cli -- /<command> [args]\n");
  console.log("🔍 PENCARIAN & ANALISIS (QWEN AI)");
  console.log("  /top [limit]          Lihat market aktif yang lagi top");
  console.log("  /search <keyword>     Cari market Polymarket");
  console.log("  /analyze <id/url>     Analisis mendalam market, ID, atau link");
  console.log("  /quickscan <url>      Scan cepat event tanpa AI Qwen");
  console.log("  /top3 <url>           Tampilkan top 3 pilihan dari event");
  console.log("  /analyzebest <url>    Pilih kandidat paling worth it dari event");
  console.log("  /analyzeall <url>     Jelaskan semua pilihan di event");
  console.log("  /book <id>            Cek orderbook market\n");
  console.log("🔄 PELUANG & ARBITRASE (GRATIS, TANPA AI)");
  console.log("  /arb                  Scan arbitrase (internal + cross-platform)");
  console.log("  /internalarb          Scan internal arb (YES+NO < 100¢)");
  console.log("  /whales [min$]        Whale trades terbaru di top markets");
  console.log("  /toptraders [limit]   Top Polymarket traders\n");
  console.log("🔔 ALERTS & NOTIFIKASI");
  console.log("  /alerts               Lihat daftar price alerts aktif");
  console.log("  /alert <id> <cond>    Set price alert (cth: /alert abc123 above 0.70)");
  console.log("  /delalert <id>        Hapus alert berdasarkan ID\n");
  console.log("📊 STATISTIK & MANAJEMEN RISIKO");
  console.log("  /analytics [days]     Performance analytics Shadow Bot lu");
  console.log("  /bycat                Performa per kategori market");
  console.log("  /timing               Analisis jam & hari terbaik trading lu");
  console.log("  /backtest [strategy]  Backtest strategi (flat/kelly/conservative)");
  console.log("  /kelly <edge> <conf>  Hitung Kelly position sizing");
  console.log("===================================================================");
  process.exit(0);
}

// Pastikan selalu dimulai dengan "/"
const cmd = commandLine.startsWith("/") ? commandLine : `/${commandLine}`;

// Mock Telegram context untuk dirender di terminal
const ctx = {
  chatId: "cli",
  sendMessage: async (text) => {
    // Untuk text progress, print ke stderr biar gak kecampur hasil
    if (text.includes("ANALISIS SEDANG BERJALAN") || text.includes("Scoring")) {
      process.stderr.write(`\r⏳ ${text.replace(/\n/g, " | ")}`.slice(0, process.stdout.columns || 80));
    } else {
      console.log(`\n${text}\n`);
    }
    return { message_id: Math.random() };
  },
  editMessageText: async (id, text) => {
    // Update progress di satu baris
    process.stderr.write(`\r\x1b[K⏳ ${text.replace(/\n/g, " | ")}`.slice(0, process.stdout.columns || 80));
  },
  deleteMessage: async (id) => {
    process.stderr.write("\r\x1b[K"); // Clear baris progress saat selesai
  },
  sendChatAction: async (action) => {},
  signal: null,
};

console.log(`\n🚀 Menjalankan: ${cmd} ...\n`);

try {
  const result = await handleCommand(cmd, {}, ctx);
  
  if (result) {
    if (result.text) {
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log(result.text);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    } else {
      console.log(result);
    }
  }
} catch (error) {
  console.error("\n❌ ERROR:", error.message);
}

process.exit(0);
