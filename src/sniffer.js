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

let currentTimeframeFilter = "all";
let globalAccumulatedWhaleVolume = {
  btc:  { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } },
  eth:  { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } },
  doge: { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } },
  all:  { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } }
};

export function setTimeframeFilter(tf) {
  // Hardcoded to "all", filter happens in frontend
  currentTimeframeFilter = "all";
  cacheTimestamp = 0; // Force refresh
}

export function getTimeframeFilter() {
  return currentTimeframeFilter;
}

export function getAccumulatedWhaleVolume() {
  return globalAccumulatedWhaleVolume;
}

// ================================================================
// FIX: WS lifecycle state at MODULE level (not inside function)
// This prevents all the race conditions and interval leaks
// ================================================================
let snifferWsPool = [];            // Active WS instance
let snifferPingInterval = null;  // Ping heartbeat interval
let snifferSubInterval = null;   // Short market re-subscription interval
let snifferIsConnecting = false; // Anti double-start guard
let snifferReconnectDelay = 2000;
const SNIFFER_MAX_RECONNECT_DELAY = 10000; // Max 10s — data gak boleh kosong kelamaan

// Market data fetched once, reused across reconnects
let cachedClobIds = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // Refresh market list every 10 minutes

function clearSnifferIntervals() {
  if (snifferPingInterval) { clearInterval(snifferPingInterval); snifferPingInterval = null; }
  if (snifferSubInterval) { clearInterval(snifferSubInterval); snifferSubInterval = null; }
}

async function fetchAndCacheMarkets(force = false) {
  const now = Date.now();
  if (!force && cachedClobIds.length > 0 && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return; // Cache still fresh, skip fetch
  }
  try {
    const [btc, eth, doge] = await Promise.all([
      getShortTermMarkets("btc"),
      getShortTermMarkets("eth"),
      getShortTermMarkets("doge")
    ]);
    
    // Interleave the arrays so we get an equal mix of btc, eth, and doge in the first N elements
    const allShorts = [];
    const maxLen = Math.max(btc.length, eth.length, doge.length);
    for (let i = 0; i < maxLen; i++) {
      if (btc[i]) allShorts.push(btc[i]);
      if (eth[i]) allShorts.push(eth[i]);
      if (doge[i]) allShorts.push(doge[i]);
    }
    let filteredShorts = currentTimeframeFilter === "all" 
      ? allShorts 
      : allShorts.filter(m => m.duration_type === currentTimeframeFilter);
      
    cachedClobIds = filteredShorts.flatMap(m => m.clobTokenIds || []).filter(Boolean);
    marketMap = {};
    for (const m of filteredShorts) {
      if (m.conditionId) {
        marketMap[m.conditionId] = { 
          id: m.id, 
          question: m.question, 
          slug: m.eventSlug || m.slug || "",
          duration_type: m.duration_type || "",
          asset: m.asset || "unknown",
          clobTokenIds: m.clobTokenIds || []
        };
      }
    }
    cacheTimestamp = now;
    console.log(`🕵️ [Sniffer] Market cache updated: ${allShorts.length} short-term crypto markets (${cachedClobIds.length} tokens).`);
  } catch (err) {
    console.error("❌ [Sniffer] Failed to fetch markets:", err.message);
    // Don't throw — use existing cache if available
  }
}

async function connectSnifferWs() {
  if (snifferIsConnecting) {
    console.log("[Sniffer] Already connected or connecting, skipping.");
    return;
  }
  snifferIsConnecting = true;

  await fetchAndCacheMarkets();

  if (cachedClobIds.length === 0) {
    console.warn("[Sniffer] No market IDs available — retry in 15s.");
    snifferIsConnecting = false;
    setTimeout(connectSnifferWs, 15000);
    return;
  }

  const SHARD_SIZE = 500;
  const numShards = Math.ceil(cachedClobIds.length / SHARD_SIZE);
  console.log(`🕵️ [Sniffer] Connecting ${numShards} WebSockets (Shards) to Polymarket CLOB...`);
  
  // Close any existing WS in pool
  for (const ws of snifferWsPool) {
    if (ws) {
      ws.onclose = null; // Prevent reconnect loop during cleanup
      ws.close(1000);
    }
  }
  snifferWsPool = [];
  clearSnifferIntervals();
  
  // Setup heartbeat for all WS in pool
  snifferPingInterval = setInterval(() => {
    for (const ws of snifferWsPool) {
      if (ws && ws.readyState === 1) ws.ping();
    }
  }, 20000);

  // Refresh market subscriptions periodically by reconnecting cleanly
  const updateShortMarketSubs = async () => {
    console.log("[Sniffer] Refreshing connections to fetch latest markets...");
    connectSnifferWs();
  };
  snifferSubInterval = setInterval(updateShortMarketSubs, 15 * 60 * 1000);

  for (let i = 0; i < cachedClobIds.length; i += SHARD_SIZE) {
    const chunk = cachedClobIds.slice(i, i + SHARD_SIZE);
    createSnifferShard(chunk, Math.floor(i / SHARD_SIZE) + 1);
    // Stagger connections sufficiently so their subscription phases do not overlap
    // (500 tokens / 50 per chunk = 10 messages * 700ms = 7 seconds)
    await new Promise(r => setTimeout(r, 8000)); 
  }
  
  snifferIsConnecting = false;
}

function createSnifferShard(ids, shardId) {
  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  snifferWsPool.push(ws);

  ws.on('open', async () => {
    console.log(`✅ [Sniffer Shard ${shardId}] Terhubung! Subscribing to ${ids.length} tokens...`);
    snifferReconnectDelay = 5000;

    const CHUNK_SIZE = 50;
    let sentCount = 0;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      if (ws.readyState !== 1) break;
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      ws.send(JSON.stringify({ assets_ids: chunk, type: "market" }));
      sentCount += chunk.length;
      await new Promise(r => setTimeout(r, 700)); // 700ms delay to safely stay under 2 msgs/sec
    }
    console.log(`[Sniffer Shard ${shardId}] Subscribed to ${sentCount} tokens.`);
  });

  ws.on('pong', () => { /* Heartbeat ACK */ });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      const messages = Array.isArray(parsed) ? parsed : [parsed];

      for (const m of messages) {
        if ((m.event_type === "price_change" || m.event_type === "book") && m.asset_id) {
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
        if (m.event_type === "last_trade_price" && m.asset_id && m.price && m.size && m.market) {
          const sizeUsdc = parseFloat(m.size) * parseFloat(m.price);
          const makerRaw = m.maker || m.makerAddress || "Hidden";
          const trackedNickname = trackedWallets.get(makerRaw.toLowerCase());
          const isTracked = trackedNickname !== undefined;

          if (sizeUsdc >= snifferMinUsd || isTracked) {
            const marketInfo = marketMap[m.market] || { id: "Unknown", question: "Unknown Market", slug: "", duration_type: "", asset: "unknown", clobTokenIds: [] };
            
            let outcome = "UNKNOWN";
            if (marketInfo.clobTokenIds && marketInfo.clobTokenIds.length >= 2) {
              if (m.asset_id === marketInfo.clobTokenIds[0]) outcome = "UP";
              else if (m.asset_id === marketInfo.clobTokenIds[1]) outcome = "DOWN";
            }

            const whaleObj = {
              market_id: marketInfo.id,
              market_question: marketInfo.question,
              market_slug: marketInfo.slug,
              duration_type: marketInfo.duration_type,
              asset: marketInfo.asset,
              outcome: outcome,
              sizeUsdc,
              price: parseFloat(m.price),
              side: m.side || "UNKNOWN",
              maker: makerRaw,
              timestamp: Date.now(),
              isTracked,
              wallet_nickname: trackedNickname || ""
            };

            if (sizeUsdc >= snifferMinUsd || isTracked) {
              if (marketInfo.duration_type && outcome !== "UNKNOWN") {
                const asset = marketInfo.asset;
                const dur = marketInfo.duration_type;
                if (globalAccumulatedWhaleVolume.all[dur]) {
                  globalAccumulatedWhaleVolume.all[dur][outcome] += sizeUsdc;
                }
                if (globalAccumulatedWhaleVolume[asset] && globalAccumulatedWhaleVolume[asset][dur]) {
                  globalAccumulatedWhaleVolume[asset][dur][outcome] += sizeUsdc;
                }
              }
              recentWhales.unshift(whaleObj);
              if (recentWhales.length > MAX_WHALES_STORED) {
                recentWhales = recentWhales.slice(0, MAX_WHALES_STORED);
              }
            }

            if (!marketTrades.has(m.market)) marketTrades.set(m.market, []);
            marketTrades.get(m.market).push(Date.now());

            const cutoff = Date.now() - 15 * 60 * 1000;
            const recentTradesForMarket = marketTrades.get(m.market).filter(ts => ts > cutoff);
            marketTrades.set(m.market, recentTradesForMarket);

            if (recentTradesForMarket.length >= 4 && !notifiedHotNiches.has(m.market)) {
              notifiedHotNiches.add(m.market);
              setTimeout(() => notifiedHotNiches.delete(m.market), 60 * 60 * 1000);
              if (notifyCallback) {
                notifyCallback({ type: "HOT_NICHE", marketInfo, recentTradesCount: recentTradesForMarket.length, triggerWhale: whaleObj }).catch(() => {});
              }
            }

            if ((sizeUsdc >= NOTIFY_MIN_SIZE || isTracked) && notifyCallback) {
              const icon = whaleObj.side === "BUY" ? "🟢" : (whaleObj.side === "SELL" ? "🔴" : "🔵");
              const sizeStr = "$" + whaleObj.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
              const walletShort = whaleObj.maker === "Hidden" ? "Anonymous" : `${whaleObj.maker.slice(0, 6)}...${whaleObj.maker.slice(-4)}`;
              let text = isTracked ? `🎯 *TRACKED WALLET ALERT* 🎯\n\n` : `🚨 *LIVE WHALE ALERT* 🚨\n\n`;
              text += `${icon} *${sizeStr}* (${whaleObj.side} @ ${whaleObj.price.toFixed(3)})\n`;
              text += `📊 Market: ${whaleObj.market_question}\n`;
              const walletLink = whaleObj.maker === "Hidden" ? "`Anonymous`" : `[${walletShort}](https://polymarket.com/profile/${whaleObj.maker})`;
              text += `👤 Wallet: ${walletLink}\n`;
              notifyCallback(text).catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      // Ignore parse errors silently
    }
  });

  ws.on('error', (err) => {
    console.error(`❌ [Sniffer Shard ${shardId}] WebSocket error:`, err.message);
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'unknown';
    console.log(`⚠️ [Sniffer Shard ${shardId}] Terputus (Code: ${code}, Reason: ${reasonStr}).`);
    
    // Only schedule a pool reconnect if we aren't already doing one
    if (!snifferIsConnecting) {
      const isClean = code === 1000 || code === 1001 || code === undefined;
      if (isClean) snifferReconnectDelay = 2000;
      
      console.log(`⚠️ [Sniffer] Reconnect seluruh pool dalam ${snifferReconnectDelay / 1000}s...`);
      setTimeout(connectSnifferWs, snifferReconnectDelay);
      snifferReconnectDelay = Math.min(snifferReconnectDelay * 2, SNIFFER_MAX_RECONNECT_DELAY);
    }
  });
}

export async function startSniffer() {
  console.log("🕵️ [Sniffer] Memulai inisialisasi...");
  // Pre-fetch market list once before connecting
  await fetchAndCacheMarkets();
  await connectSnifferWs();
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

export function getSnifferWsStatus() {
  if (!isSnifferActive) return "OFFLINE";
  if (snifferIsConnecting) return "CONNECTING";
  if (!snifferWs) return "RECONNECTING";
  if (snifferWs.readyState === 0) return "CONNECTING";
  if (snifferWs.readyState === 1) return "CONNECTED";
  return "DISCONNECTED";
}
