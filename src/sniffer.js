import WebSocket from 'ws';
import { listTopMarkets, getShortTermMarkets } from "./polymarket.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "..", "tracker_config.json");

// Simpan data paus di memori (RAM)
let recentWhales = [];
const MAX_WHALES_STORED = 200;

// Tracker for trending markets
const marketTrades = new Map(); // market_id -> [timestamp1, timestamp2, ...]
let marketMap = {}; // Hoisted to module level
const notifiedHotNiches = new Set();

// State untuk ON/OFF Sniffer
let isSnifferActive = true;
let notifyCallback = null;
let snifferStartTime = Date.now(); // Kapan sniffer dinyalakan (timestamp)

export let snifferMinUsd = 1000; // Default minimum whale size
export let trackedWallets = new Map([
  ["0x55be7aa03ecfbe37aa5460db791205f7ac9ddca3".toLowerCase(), "Coinman2"]
]);

// Load config dari file (jika ada)
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (typeof data.minUsd === "number") snifferMinUsd = data.minUsd;
    if (Array.isArray(data.wallets)) {
      trackedWallets.clear();
      for (const w of data.wallets) {
        if (w && w.address) trackedWallets.set(w.address.toLowerCase(), w.nickname || "");
      }
    }
    console.log(`[Sniffer] Loaded config from file: minUsd=$${snifferMinUsd}, trackedWallets=${trackedWallets.size}`);
  } else {
    console.log(`[Sniffer] No tracker_config.json found. Using defaults.`);
  }
} catch (e) {
  console.error("[Sniffer] Error loading config:", e.message);
}

function saveConfigToFile() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      minUsd: snifferMinUsd,
      wallets: Array.from(trackedWallets.entries()).map(([address, nickname]) => ({ address, nickname }))
    }, null, 2));
  } catch (e) {
    console.error("[Sniffer] Error saving config:", e.message);
  }
}

export function getTrackerConfig() {
  return {
    minUsd: snifferMinUsd,
    wallets: Array.from(trackedWallets.entries()).map(([address, nickname]) => ({ address, nickname }))
  };
}

export function setTrackerConfig(minUsd, walletsArray) {
  if (typeof minUsd === 'number') snifferMinUsd = minUsd;
  if (Array.isArray(walletsArray)) {
    trackedWallets.clear();
    for (const w of walletsArray) {
      if (w && w.address) {
        trackedWallets.set(w.address.toLowerCase(), w.nickname || "");
      }
    }
  }
  saveConfigToFile();
}

// Ambang batas notifikasi push (misal: di atas $1000 baru di-push biar gak spam)
const NOTIFY_MIN_SIZE = 500; 

export function setSnifferState(state) {
  isSnifferActive = !!state;
  if (isSnifferActive && snifferStartTime === 0) {
    snifferStartTime = Date.now();
  } else if (!isSnifferActive) {
    snifferStartTime = 0;
  }
  return isSnifferActive;
}

export function getSnifferState() {
  return isSnifferActive;
}

export function getSnifferStartTime() {
  return snifferStartTime;
}

// Aggressive Mode (No NETRAL) — forces UP or DOWN, never =
let aggressiveModeEnabled = false;

export function setAggressiveMode(enabled) {
  aggressiveModeEnabled = !!enabled;
}

export function getAggressiveMode() {
  return aggressiveModeEnabled;
}

export function setNotificationCallback(fn) {
  notifyCallback = fn;
}

export async function startSniffer() {
  console.log("🕵️‍♂️ [Sniffer] Memulai inisialisasi WebSocket...");
  try {
    const { markets } = await listTopMarkets({ mode: "volume", limit: 50 });
    // CLOB WebSocket requires actual token IDs for trade events
    const clobIds = markets.flatMap(m => m.clobTokenIds || []).filter(Boolean);
    
    marketMap = {};
    for (const m of markets) {
      if (m.conditionId) marketMap[m.conditionId] = { id: m.id, question: m.question, slug: m.eventSlug || m.slug || "" };
    }

    console.log(`🕵️‍♂️ [Sniffer] Menyadap ${markets.length} market (${clobIds.length} token)...`);

    const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    
    ws.on('open', async () => {
      console.log('✅ [Sniffer] Terhubung ke Polymarket Live Feed!');
      
      // Kirim satu payload langsung untuk top markets
      ws.send(JSON.stringify({
        assets_ids: clobIds,
        type: "market"
      }));

      // Fungsi untuk subscribe ke live prices untuk short markets
      const updateShortMarketSubs = async () => {
        try {
          const btc = await getShortTermMarkets("btc");
          const eth = await getShortTermMarkets("eth");
          const doge = await getShortTermMarkets("doge");
          const allShorts = [...btc, ...eth, ...doge];
          const shortIds = allShorts.flatMap(m => m.clobTokenIds || []).filter(Boolean);
          
          if (shortIds.length > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              assets_ids: shortIds,
              type: "market"
            }));
            console.log(`[Sniffer] Subscribed to ${shortIds.length} short market tokens for Live Prices`);
          }
        } catch (e) {
          console.error("[Sniffer] Failed to update short market subscriptions:", e.message);
        }
      };

      await updateShortMarketSubs();
      setInterval(updateShortMarketSubs, 5 * 60 * 1000);
    });

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        
        for (const m of messages) {
          if ((m.event_type === "price_change" || m.event_type === "book") && m.asset_id) {
            // Update live price cache
            if (m.price !== undefined) {
              global.livePrices[m.asset_id] = parseFloat(m.price);
            } else if (m.bids && m.bids.length > 0) {
              global.livePrices[m.asset_id] = parseFloat(m.bids[0].price);
            } else if (m.asks && m.asks.length > 0) {
              global.livePrices[m.asset_id] = parseFloat(m.asks[0].price);
            }
          }
        }

        if (!isSnifferActive) return;
        
        for (const m of messages) {
            // Polymarket last_trade_price event
            if (m.event_type === "last_trade_price" && m.asset_id && m.price && m.size && m.market) {
               const sizeUsdc = parseFloat(m.size) * parseFloat(m.price);
               const makerRaw = m.maker || m.makerAddress || "Hidden";
               const trackedNickname = trackedWallets.get(makerRaw.toLowerCase());
               const isTracked = trackedNickname !== undefined;

               if (sizeUsdc >= snifferMinUsd || isTracked) { // Simpan ke list sesuai filter minUsd atau wallet tracked
                 // Update trending trades ONLY for whales/tracked
                 if (!marketTrades.has(m.market)) marketTrades.set(m.market, []);
                 marketTrades.get(m.market).push(Date.now());

                 const marketInfo = marketMap[m.market] || { id: "Unknown", question: "Unknown Market", slug: "" };
                 
                 const whaleObj = {
                   market_id: marketInfo.id,
                   market_question: marketInfo.question,
                   market_slug: marketInfo.slug,
                   sizeUsdc: sizeUsdc,
                   price: parseFloat(m.price),
                   side: m.side || "UNKNOWN",
                   maker: makerRaw,
                   timestamp: Date.now(),
                   isTracked: isTracked,
                   wallet_nickname: trackedNickname || ""
                 };
  
                 recentWhales.unshift(whaleObj);
  
                 if (recentWhales.length > MAX_WHALES_STORED) {
                   recentWhales = recentWhales.slice(0, MAX_WHALES_STORED);
                 }

                 const cutoff = Date.now() - 15 * 60 * 1000;
                 const recentTradesForMarket = marketTrades.get(m.market).filter(ts => ts > cutoff);
                 marketTrades.set(m.market, recentTradesForMarket);
                 
                 // Trigger HOT NICHE jika ada 4 whale trades dalam 15 menit
                 if (recentTradesForMarket.length >= 4 && !notifiedHotNiches.has(m.market)) {
                   notifiedHotNiches.add(m.market);
                   setTimeout(() => notifiedHotNiches.delete(m.market), 60 * 60 * 1000); // Reset after 1 hour
                   
                   if (notifyCallback) {
                     notifyCallback({
                       type: "HOT_NICHE",
                       marketInfo,
                       recentTradesCount: recentTradesForMarket.length,
                       triggerWhale: whaleObj
                     }).catch(() => {});
                   }
                 }
  
                 // Push notification kalau ukurannya jumbo ATAU walletnya lagi ditrack
                 if ((sizeUsdc >= NOTIFY_MIN_SIZE || isTracked) && notifyCallback) {
                   const icon = whaleObj.side === "BUY" ? "🟢" : (whaleObj.side === "SELL" ? "🔴" : "🔵");
                   const sizeStr = "$" + whaleObj.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                   const walletShort = whaleObj.maker === "Hidden" ? "Anonymous" : `${whaleObj.maker.slice(0, 6)}...${whaleObj.maker.slice(-4)}`;
                   
                   let text = isTracked ? `🎯 *TRACKED WALLET ALERT* 🎯\n\n` : `🚨 *LIVE WHALE ALERT* 🚨\n\n`;
                   text += `${icon} *${sizeStr}* (${whaleObj.side} @ $${whaleObj.price.toFixed(3)})\n`;
                   text += `📊 Market: ${whaleObj.market_question}\n`;
                   let walletLink = whaleObj.maker === "Hidden" ? "`Anonymous`" : `[${walletShort}](https://polymarket.com/profile/${whaleObj.maker})`;
                   text += `👤 Wallet: ${walletLink}\n`;
                   
                   // Fire and forget
                   notifyCallback(text).catch(() => {});
                 }
               }
            }
        }
      } catch (err) {
        // Abaikan parse error
      }
    });

    ws.on('error', (err) => console.error("❌ [Sniffer] Error WebSocket:", err.message));
    ws.on('close', (code, reason) => {
      console.log(`⚠️ [Sniffer] Koneksi terputus (Code: ${code}, Reason: ${reason.toString()}). Mencoba reconnect dalam 5 detik...`);
      setTimeout(startSniffer, 5000);
    });

  } catch (error) {
    console.error("❌ [Sniffer] Gagal inisialisasi:", error.message);
    setTimeout(startSniffer, 10000);
  }
}

export function getRecentWhales(minSizeUsdc = 0) {
  // Return recentWhales without overriding the stored min limit, 
  // since we already filter them during capture. 
  // However, we still allow filtering them down further if requested.
  return recentWhales.filter(w => w.sizeUsdc >= minSizeUsdc || w.isTracked);
}

export function getTrendingMarkets(limit = 5, windowMinutes = 15) {
  const cutoff = Date.now() - (windowMinutes * 60 * 1000);
  const trending = [];
  
  for (const [marketId, timestamps] of marketTrades.entries()) {
    // Clean old timestamps to prevent memory leak and keep data fresh
    const recent = timestamps.filter(ts => ts > cutoff);
    if (recent.length > 0) {
      marketTrades.set(marketId, recent);
      const marketInfo = marketMap[marketId] || { question: "Unknown Market", slug: "" };
      trending.push({
        market_id: marketId,
        question: marketInfo.question,
        slug: marketInfo.slug,
        count: recent.length
      });
    } else {
      marketTrades.delete(marketId);
    }
  }
  
  return trending.sort((a, b) => b.count - a.count).slice(0, limit);
}

export function formatSnifferWhales(whales, minSizeUsdc) {
  if (!isSnifferActive) {
    return `⏸️ *SNIFFER SEDANG NONAKTIF*\n\n_Ketik /sniffer on untuk mengaktifkan pemantauan paus secara real-time._`;
  }

  if (!whales || whales.length === 0) {
    return `🐋 *[LIVE SNIFFER AKTIF]*\nTidak ada paus ≥ $${minSizeUsdc.toLocaleString()} tertangkap sejak fitur dinyalakan.\n\n_Bot terus memantau 50 market teratas secara real-time._`;
  }

  let text = `🐋 *LIVE WHALE TRACKER* (≥ $${minSizeUsdc.toLocaleString()})\n`;
  text += `_Disadap langsung dari Polymarket WebSocket_\n\n`;

  for (const w of whales.slice(0, 15)) {
    const size = "$" + w.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const walletShort = w.maker === "Hidden" ? "Anonymous" : `${w.maker.slice(0, 6)}...${w.maker.slice(-4)}`;
    const timeAgo = Math.round((Date.now() - w.timestamp) / 1000);
    const timeFmt = timeAgo < 60 ? `${timeAgo} detik lalu` : `${Math.floor(timeAgo/60)} menit lalu`;
    
    const icon = w.side === "BUY" ? "🟢" : (w.side === "SELL" ? "🔴" : "🔵");
    
    text += `${icon} *${size}* (${w.side} @ $${w.price.toFixed(3)})\n`;
    text += `  📊 Market: ${w.market_question.slice(0, 45)}...\n`;
    text += `  👤 Wallet: \`${walletShort}\` (${timeFmt})\n\n`;
  }

  return text.trim();
}
